//! Bounded streaming Codex reader. Only masked normalized records are spooled;
//! scratch files are encrypted with a per-reader key held only in memory.
use super::*;
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    Key, XChaCha20Poly1305, XNonce,
};
use std::{
    fs::File,
    io::{BufReader, Read, Seek, SeekFrom, Write},
    sync::{Arc, Mutex, OnceLock},
};
use zeroize::Zeroizing;
const CACHE_SLOTS: usize = 8;
const DISK_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub(super) struct Writer {
    data: File,
    index: File,
    key: Zeroizing<[u8; 32]>,
    pub count: u64,
    pub diagnostics: ReadDiagnostics,
    error: Option<String>,
    length: u64,
    decoded_bytes: u64,
}
impl Writer {
    fn new() -> Result<Self, String> {
        let mut key = Zeroizing::new([0; 32]);
        getrandom::fill(key.as_mut()).map_err(|_| "Cannot create history cache key.")?;
        Ok(Self {
            data: tempfile::tempfile().map_err(|_| "Cannot create private history cache.")?,
            index: tempfile::tempfile().map_err(|_| "Cannot create private history index.")?,
            key,
            count: 0,
            diagnostics: ReadDiagnostics::default(),
            error: None,
            length: 0,
            decoded_bytes: 0,
        })
    }
    pub(super) fn push(&mut self, item: &NormalizedItem) {
        if self.error.is_some() {
            return;
        }
        if let Err(error) = self.write(item) {
            self.error = Some(error);
        }
    }
    fn write(&mut self, item: &NormalizedItem) -> Result<(), String> {
        let bytes = serde_json::to_vec(item).map_err(|_| "Cannot encode history page.")?;
        if bytes.len() > PAGE_BYTES {
            return Err("History record exceeds the page budget.".into());
        }
        let cipher = XChaCha20Poly1305::new(
            <&Key>::try_from(self.key.as_ref())
                .map_err(|_| "Invalid private history cache key.")?,
        );
        let mut nonce = [0u8; 24];
        getrandom::fill(&mut nonce).map_err(|_| "Cannot create history cache nonce.")?;
        let encrypted = cipher
            .encrypt(&XNonce::from(nonce), bytes.as_slice())
            .map_err(|_| "Cannot encrypt history cache.")?;
        if self.length + encrypted.len() as u64 + 28 > DISK_BYTES {
            return Err("The private history cache capacity is exhausted.".into());
        }
        let offset = self
            .data
            .stream_position()
            .map_err(|_| "Cannot locate history cache.")?;
        self.index
            .write_all(&offset.to_le_bytes())
            .map_err(|_| "Cannot write private history index.")?;
        self.data
            .write_all(&(encrypted.len() as u32).to_le_bytes())
            .and_then(|_| self.data.write_all(&nonce))
            .and_then(|_| self.data.write_all(&encrypted))
            .map_err(|_| "Cannot write private history cache.")?;
        self.length += encrypted.len() as u64 + 28;
        self.count += 1;
        Ok(())
    }
    fn item(&mut self, index: u64) -> Result<NormalizedItem, String> {
        let mut read = || -> Result<NormalizedItem, std::io::Error> {
            self.index.seek(SeekFrom::Start(index * 8))?;
            let mut offset = [0; 8];
            self.index.read_exact(&mut offset)?;
            self.data
                .seek(SeekFrom::Start(u64::from_le_bytes(offset)))?;
            let mut size = [0; 4];
            self.data.read_exact(&mut size)?;
            let size = u32::from_le_bytes(size) as usize;
            if size > PAGE_BYTES + 16 {
                return Err(std::io::ErrorKind::InvalidData.into());
            }
            let mut nonce = [0; 24];
            self.data.read_exact(&mut nonce)?;
            let mut data = vec![0; size];
            self.data.read_exact(&mut data)?;
            let cipher = XChaCha20Poly1305::new(
                <&Key>::try_from(self.key.as_ref()).map_err(|_| std::io::ErrorKind::InvalidData)?,
            );
            let plain = cipher
                .decrypt(&XNonce::from(nonce), data.as_slice())
                .map_err(|_| std::io::ErrorKind::InvalidData)?;
            serde_json::from_slice(&plain).map_err(|_| std::io::ErrorKind::InvalidData.into())
        };
        read().map_err(|_| "Cannot read private history cache; reload.".into())
    }
}
type Ready = Arc<OnceLock<Result<Mutex<Writer>, String>>>;
struct Slot {
    path: PathBuf,
    fingerprint: (u64, String),
    ready: Ready,
}
fn cache() -> &'static Mutex<VecDeque<Slot>> {
    static CACHE: OnceLock<Mutex<VecDeque<Slot>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(VecDeque::new()))
}
pub(super) fn needed(path: &Path) -> Result<bool, String> {
    let fp = fingerprint(path)?;
    if fp.0 > super::super::MAX_TRANSCRIPT_FILE_BYTES
        || path.extension().is_some_and(|s| s == "zst")
    {
        return Ok(true);
    }
    Ok(cache()
        .lock()
        .map_err(|_| "History cache unavailable.")?
        .iter()
        .any(|s| s.path == path && s.fingerprint == fp))
}
fn build(path: &Path, fp: &(u64, String)) -> Result<Mutex<Writer>, String> {
    let reader =
        decoded_reader(path).ok_or("Invalid compressed transcript or unavailable history.")?;
    let mut input = bounded_json::Reader::new(BufReader::with_capacity(64 * 1024, reader));
    let mut parser = parser(path, None, u64::MAX, false);
    parser.sink = Some(Writer::new()?);
    let mut diagnostics = ReadDiagnostics::default();
    while let Some((offset, row, clipped)) = input
        .row()
        .map_err(|_| "Cannot decode JSON streaming history.")?
    {
        match row {
            Ok(row) if row.is_object() => {
                let before = parser.count;
                parser.source_truncated = clipped;
                parser.row(&row, TranscriptKind::Codex, offset);
                if clipped {
                    diagnostics.truncated_rows += 1;
                    diagnostics.partial = true;
                    if parser.count == before {
                        let mut item = parser.item(
                            format!("record-{offset}:truncated"),
                            ItemKind::System,
                            "[content truncated]".into(),
                        );
                        item.truncated = true;
                        parser.emit(item);
                    }
                }
            }
            Ok(_) => diagnostics.skip("invalid_record"),
            Err(reason) => diagnostics.skip(reason),
        }
        if parser
            .sink
            .as_ref()
            .is_some_and(|sink| sink.error.is_some())
        {
            return Err(parser.sink.take().unwrap().error.unwrap());
        }
    }
    if fingerprint(path)? != *fp {
        return Err("The native history changed while reading; retry.".into());
    }
    let mut writer = parser.sink.take().unwrap();
    writer.diagnostics = diagnostics;
    writer.decoded_bytes = input.offset;
    if writer.count == 0 {
        return Err("no_readable_records".into());
    }
    Ok(Mutex::new(writer))
}
pub(super) fn page(path: &Path, cursor: Option<&HistoryCursor>) -> Result<NormalizedPage, String> {
    let fp = fingerprint(path)?;
    if cursor.is_some_and(|c| c.length != fp.0 || c.modified != fp.1) {
        return Err("The native history changed; reload.".into());
    }
    let ready = {
        let mut slots = cache().lock().map_err(|_| "History cache unavailable.")?;
        if let Some(index) = slots
            .iter()
            .position(|s| s.path == path && s.fingerprint == fp)
        {
            let slot = slots.remove(index).unwrap();
            let ready = slot.ready.clone();
            slots.push_back(slot);
            ready
        } else {
            if slots.len() >= CACHE_SLOTS {
                if let Some(index) = slots.iter().position(|s| Arc::strong_count(&s.ready) == 1) {
                    slots.remove(index);
                } else {
                    return Err("History readers are busy; retry.".into());
                }
            }
            let ready = Arc::new(OnceLock::new());
            slots.push_back(Slot {
                path: path.into(),
                fingerprint: fp.clone(),
                ready: ready.clone(),
            });
            ready
        }
    };
    let result = ready.get_or_init(|| build(path, &fp));
    let writer = match result {
        Ok(writer) => writer,
        Err(error) => {
            cache()
                .lock()
                .map_err(|_| "History cache unavailable.")?
                .retain(|s| !Arc::ptr_eq(&s.ready, &ready));
            return Err(error.clone());
        }
    };
    let mut writer = writer.lock().map_err(|_| "History cache unavailable.")?;
    let forward = cursor.and_then(|c| c.after);
    let mut begin =
        forward.unwrap_or_else(|| cursor.map_or(writer.count, |c| c.before).min(writer.count));
    if begin > writer.count {
        return Err("Invalid history cursor.".into());
    }
    let mut end = begin;
    let mut items = VecDeque::new();
    let mut bytes = 0;
    loop {
        let index = if forward.is_some() {
            if end >= writer.count {
                break;
            }
            end
        } else {
            if begin == 0 {
                break;
            }
            begin - 1
        };
        let item = match writer.item(index) {
            Ok(item) => item,
            Err(error) => {
                drop(writer);
                cache()
                    .lock()
                    .map_err(|_| "History cache unavailable.")?
                    .retain(|slot| !Arc::ptr_eq(&slot.ready, &ready));
                return Err(error);
            }
        };
        let size = serde_json::to_vec(&item)
            .map_err(|_| "Cannot encode history.")?
            .len();
        if !items.is_empty() && (items.len() >= PAGE_ITEMS || bytes + size > PAGE_BYTES - 4096) {
            break;
        }
        bytes += size;
        if forward.is_some() {
            items.push_back(item);
            end += 1;
        } else {
            items.push_front(item);
            begin -= 1;
        }
    }
    let cursor = |before, after| HistoryCursor {
        before,
        after,
        length: fp.0,
        modified: fp.1.clone(),
    };
    let turns = vec![NormalizedTurn {
        id: "stream".into(),
        items: coalesce(items.into_iter().collect()),
    }];
    Ok(NormalizedPage {
        decoded_bytes: Some(writer.decoded_bytes),
        previous_cursor: (begin > 0).then(|| cursor(begin, None)),
        next_cursor: (end < writer.count).then(|| cursor(writer.count, Some(end))),
        truncated: begin > 0 || writer.diagnostics.partial,
        diagnostics: writer.diagnostics.clone(),
        warnings: if writer.diagnostics.partial {
            vec!["native.partial".into()]
        } else {
            Vec::new()
        },
        turns,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    fn event(out: &mut impl Write, label: &str) {
        writeln!(out,"{}",serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":label}]}})).unwrap();
    }
    fn long_start(out: &mut impl Write, label: &str) {
        write!(out,"{{\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"user\",\"content\":[{{\"type\":\"input_text\",\"text\":\"{label} ").unwrap();
    }
    fn long_end(out: &mut impl Write) {
        writeln!(out, "\"}}]}}}}").unwrap();
    }
    fn walk(path: &Path) -> usize {
        let mut cursor = None;
        let mut ids = HashSet::new();
        let mut pages = 0;
        loop {
            let page = super::super::page(path, TranscriptKind::Codex, cursor.as_ref(), None)
                .unwrap()
                .0;
            assert!(serde_json::to_vec(&page).unwrap().len() <= PAGE_BYTES);
            for item in page.turns.iter().flat_map(|t| &t.items) {
                assert!(ids.insert(item.id.clone()));
            }
            pages += 1;
            assert!(pages < 10_000);
            if let Some(next) = page.previous_cursor {
                if let Some(old) = cursor {
                    assert!(next.before < old.before);
                }
                cursor = Some(next);
            } else {
                break;
            }
        }
        ids.len()
    }
    #[test]
    fn jsonl_above_128_mib_walks_to_the_start_with_bounded_pages() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout-synthetic.jsonl");
        let mut file = File::create(&path).unwrap();
        long_start(&mut file, "huge synthetic record");
        let block = vec![b'x'; 64 * 1024];
        for _ in 0..2050 {
            file.write_all(&block).unwrap();
        }
        long_end(&mut file);
        for i in 0..400 {
            event(&mut file, &format!("synthetic-{i}"));
        }
        drop(file);
        let metadata = std::fs::metadata(&path).unwrap();
        assert!(metadata.len() > super::super::super::MAX_TRANSCRIPT_FILE_BYTES);
        assert_eq!(walk(&path), 401);
        assert_eq!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            metadata.modified().unwrap()
        );
    }
    #[test]
    fn oversized_row_is_clipped_not_skipped_and_neighbors_and_masking_survive() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout-synthetic.jsonl");
        let mut file = File::create(&path).unwrap();
        event(&mut file, "before");
        long_start(&mut file, "password=synthetic-value");
        let block = vec![b'x'; 64 * 1024];
        for _ in 0..520 {
            file.write_all(&block).unwrap();
        }
        long_end(&mut file);
        event(&mut file, "after");
        drop(file);
        let page = super::super::page(&path, TranscriptKind::Codex, None, None)
            .unwrap()
            .0;
        let items: Vec<_> = page.turns.iter().flat_map(|t| &t.items).collect();
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].text, "before");
        assert_eq!(items[2].text, "after");
        assert!(items[1].truncated);
        assert!(items[1].text.len() < bounded_json::STRING_BYTES + 100);
        assert!(!items[1].text.contains("synthetic-value"));
        assert_eq!(page.diagnostics.skipped_rows, 0);
        assert_eq!(page.diagnostics.truncated_rows, 1);
        assert_eq!(walk(&path), 3);
    }
    #[test]
    fn valid_zstd_above_old_compressed_limit_is_streamed_and_fully_pageable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout-synthetic.jsonl.zst");
        let mut encoder =
            zstd::stream::write::Encoder::new(File::create(&path).unwrap(), 0).unwrap();
        let mut block = vec![0u8; 256 * 1024];
        let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        for i in 0..400 {
            long_start(&mut encoder, &format!("synthetic-{i}"));
            for _ in 0..2 {
                getrandom::fill(&mut block).unwrap();
                for b in &mut block {
                    *b = alphabet[usize::from(*b & 63)];
                }
                encoder.write_all(&block).unwrap();
            }
            long_end(&mut encoder);
        }
        encoder.finish().unwrap();
        assert!(
            std::fs::metadata(&path).unwrap().len()
                > super::super::super::MAX_TRANSCRIPT_FILE_BYTES
        );
        assert_eq!(walk(&path), 400);
    }
    #[test]
    fn cache_records_are_encrypted_and_a_changed_source_invalidates_cursors() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout-synthetic.jsonl");
        let mut file = File::create(&path).unwrap();
        for i in 0..350 {
            event(&mut file, &format!("synthetic-{i}"));
        }
        drop(file);
        let first = page(&path, None).unwrap();
        let cursor = first.previous_cursor.unwrap();
        let mut changed = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        event(&mut changed, "changed");
        drop(changed);
        assert!(page(&path, Some(&cursor)).unwrap_err().contains("changed"));
        let mut writer = Writer::new().unwrap();
        let parser = parser(&path, None, u64::MAX, false);
        writer.push(&parser.item(
            "synthetic".into(),
            ItemKind::User,
            "PUBLIC_SYNTHETIC_CANARY".into(),
        ));
        writer.data.seek(SeekFrom::Start(0)).unwrap();
        let mut ciphertext = Vec::new();
        writer.data.read_to_end(&mut ciphertext).unwrap();
        assert!(!ciphertext
            .windows(23)
            .any(|bytes| bytes == b"PUBLIC_SYNTHETIC_CANARY"));
        assert_eq!(writer.item(0).unwrap().text, "PUBLIC_SYNTHETIC_CANARY");
    }
}
