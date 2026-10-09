//! Reading a CLI's own conversation history off disk.
//!
//! Different agent CLIs can't share memory, but each writes its conversation to
//! a structured file. Reading the source CLI's transcript and handing it to a
//! new CLI as an opening brief is the closest thing to "carrying the memory
//! over": the target sees the actual exchange and can continue from it.
//!
//! Every supported source hands context to the new CLI through a one-time
//! brief owned by LatticeTerm. We never write another CLI's memory or session
//! store: those directory trees can be changed by a running sandboxed CLI.
//!
//! Only CLIs whose on-disk format is verified are supported; everything else
//! returns `None` so the caller can stop an opt-in transfer safely.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::Write as _;
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt;

const MAX_CODEX_SESSION_META_BYTES: usize = 256 * 1024;
const MAX_CLAUDE_SESSION_META_BYTES: u64 = 512 * 1024;
const MAX_CLAUDE_SESSION_META_LINES: usize = 64;
const MAX_TRANSCRIPT_FILE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_TRANSCRIPT_TAIL_BYTES: u64 = 16 * 1024 * 1024;
const MAX_TRANSCRIPT_LINE_BYTES: usize = 2 * 1024 * 1024;
const MAX_TRANSCRIPT_SEARCH_DEPTH: usize = 32;
const MAX_TRANSCRIPT_SEARCH_ENTRIES: usize = 50_000;
const MAX_GEMINI_PROJECT_ROOT_BYTES: usize = 8 * 1024;
const MAX_GEMINI_MESSAGE_ID_BYTES: usize = 256;
const MAX_GEMINI_MESSAGE_RECORDS: usize = 50_000;
const MAX_GEMINI_TRANSCRIPT_TEXT_BYTES: usize = 16 * 1024 * 1024;

/// CLIs whose transcript layout we know how to read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranscriptKind {
    /// `~/.gemini/antigravity-cli/brain/<conversation>/.system_generated/logs/transcript.jsonl`
    Antigravity,
    /// `~/.claude/projects/<cwd-slug>/<session>.jsonl`
    Claude,
    /// `~/.codex/sessions/YYYY/MM/DD/rollout-*-<session>.jsonl`
    Codex,
    /// `~/.cursor/projects/<workspace-slug>/agent-transcripts/<id>/<id>.jsonl`
    Cursor,
    /// `~/.gemini/tmp/<project-hash>/chats/session-*.jsonl`
    Gemini,
}

impl TranscriptKind {
    pub fn from_definition(definition_id: &str) -> Option<Self> {
        match definition_id {
            "antigravity" => Some(Self::Antigravity),
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            "cursor" => Some(Self::Cursor),
            "gemini" => Some(Self::Gemini),
            _ => None,
        }
    }
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Largest handoff brief written to disk. The exporter already caps what it
/// produces; this only bounds what a caller can hand in.
const MAX_HANDOFF_FILE_BYTES: usize = 256 * 1024;
/// A brief is for the CLI that starts next, not an archive; anything older
/// than this is swept on the next write.
const HANDOFF_FILE_TTL: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

/// Writes a handoff brief where the next CLI can read it, and returns the
/// path to point that CLI at.
///
/// Pasting tens of kilobytes into a terminal UI is slow (the interface
/// ingests it a keystroke at a time) and the model then has to digest all
/// of it before the person can say anything. A file plus a one-line pointer
/// makes the new CLI interactive at once; it reads the brief with its own
/// file tool, which is what those tools are fast at. The file lives under
/// LatticeTerm's data directory, owner-only, and is swept after a day.
pub fn write_handoff_file(
    data_dir: &Path,
    source_label: &str,
    transcript: &str,
) -> Result<PathBuf, String> {
    if transcript.trim().is_empty() {
        return Err("There is no conversation to hand off.".to_string());
    }
    if transcript.len() > MAX_HANDOFF_FILE_BYTES {
        return Err("The handoff is too large to write.".to_string());
    }
    let label: String = source_label
        .chars()
        .filter(|c| !c.is_control())
        .take(64)
        .collect();
    let dir = data_dir.join("handoffs");
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Cannot create the handoff directory: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }
    prune_handoff_files(&dir, std::time::SystemTime::now());

    let body = format!(
        "# 交接自 {}\n\n{}\n",
        if label.is_empty() {
            "另一個 AI 助理"
        } else {
            &label
        },
        transcript.trim()
    );
    // A random name that cannot collide, created owner-only (0600) and
    // kept rather than deleted on drop.
    let mut file = tempfile::Builder::new()
        .prefix("handoff-")
        .suffix(".md")
        .tempfile_in(&dir)
        .map_err(|error| format!("Cannot write the handoff file: {error}"))?;
    file.write_all(body.as_bytes())
        .map_err(|error| format!("Cannot write the handoff file: {error}"))?;
    file.as_file().sync_all().ok();
    let path = file
        .keep()
        .map_err(|error| format!("Cannot keep the handoff file: {error}"))?
        .1;
    Ok(path.canonicalize().unwrap_or(path))
}

/// Removes briefs past their day; a failure here is not a failure to hand
/// off, so nothing is reported.
fn prune_handoff_files(dir: &Path, now: std::time::SystemTime) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_brief = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("handoff-") && name.ends_with(".md"));
        if !is_brief {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let expired = metadata
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > HANDOFF_FILE_TTL);
        if expired {
            let _ = fs::remove_file(&path);
        }
    }
}

/// Compatibility for an older WebView. Returning false makes it use the
/// one-time handoff path without touching CLI-controlled directories.
pub fn import_handoff_into_memory(
    _target_definition_id: &str,
    _working_directory: &str,
    _source_label: &str,
    _transcript: &str,
) -> Result<bool, String> {
    Ok(false)
}

/// The most recently modified file in `dir` for which `keep` holds.
fn newest_matching(dir: &Path, keep: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    newest_matching_with_limits(
        dir,
        MAX_TRANSCRIPT_SEARCH_ENTRIES,
        MAX_TRANSCRIPT_SEARCH_DEPTH,
        keep,
    )
}

fn newest_matching_with_limits(
    dir: &Path,
    max_entries: usize,
    max_depth: usize,
    keep: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    let mut stack = vec![(dir.to_path_buf(), 0usize)];
    let mut visited = 0usize;
    while let Some((current, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            visited = visited.saturating_add(1);
            if visited > max_entries {
                return None;
            }
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            // Transcript roots are user-writable. Never let a nested symlink
            // turn a bounded history search into a scan outside that root.
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                if depth < max_depth {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            if !keep(&path) {
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            let modified = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
            if best
                .as_ref()
                .is_none_or(|(best_time, _)| modified > *best_time)
            {
                best = Some((modified, path));
            }
        }
    }
    best.map(|(_, path)| path)
}

/// Opens a regular transcript without following a final symlink, then checks
/// the opened handle rather than trusting path metadata that can race.
fn open_regular_transcript(path: &Path) -> Option<fs::File> {
    let file = open_regular_transcript_handle(path)?;
    (file.metadata().ok()?.len() <= MAX_TRANSCRIPT_FILE_BYTES).then_some(file)
}

fn open_regular_transcript_handle(path: &Path) -> Option<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW);
    #[cfg(windows)]
    options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    let file = options.open(path).ok()?;
    let metadata = file.metadata().ok()?;
    metadata.is_file().then_some(file)
}

/// Keeps only the last `max_chars` characters without allowing the assembled
/// transcript to grow with the full on-disk history.
fn trim_tail(text: &mut String, max_chars: usize) -> bool {
    let count = text.chars().count();
    if count <= max_chars {
        return false;
    }
    let skip = count - max_chars;
    *text = text.chars().skip(skip).collect();
    true
}

/// Flattens a Claude/Codex content value (string, or an array of typed blocks)
/// into the plain text a human wrote or read, dropping tool calls and images.
fn content_text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.trim().to_string();
    }
    let Some(items) = content.as_array() else {
        return String::new();
    };
    let mut parts = Vec::new();
    for item in items {
        let kind = item.get("type").and_then(Value::as_str).unwrap_or("");
        if matches!(kind, "text" | "input_text" | "output_text") {
            if let Some(text) = item.get("text").and_then(Value::as_str) {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    parts.push(trimmed.to_string());
                }
            }
        }
    }
    parts.join("\n")
}

fn push_turn(out: &mut String, role: &str, text: &str) {
    if text.is_empty() {
        return;
    }
    let label = match role {
        "user" => "【使用者】",
        "assistant" => "【助理】",
        _ => return,
    };
    out.push_str(label);
    out.push('\n');
    out.push_str(text);
    out.push_str("\n\n");
}

/// Reads one JSONL row while discarding an oversized row in fixed-size reader
/// buffers. `Some(false)` means a row was present but exceeded the cap.
fn read_bounded_line<R: BufRead>(
    reader: &mut R,
    line: &mut Vec<u8>,
    max_bytes: usize,
) -> io::Result<Option<bool>> {
    line.clear();
    let mut saw_data = false;
    let mut oversized = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            if !saw_data {
                return Ok(None);
            }
            break;
        }
        saw_data = true;
        let newline = available.iter().position(|byte| *byte == b'\n');
        let data_len = newline.unwrap_or(available.len());
        if !oversized {
            if data_len <= max_bytes.saturating_sub(line.len()) {
                line.extend_from_slice(&available[..data_len]);
            } else {
                line.clear();
                oversized = true;
            }
        }
        reader.consume(data_len + usize::from(newline.is_some()));
        if newline.is_some() {
            break;
        }
    }
    if !oversized && line.last() == Some(&b'\r') {
        line.pop();
    }
    Ok(Some(!oversized))
}

/// Streams a bounded JSONL transcript. The file and each individual row have
/// independent caps; malformed rows are ignored as before, while oversized
/// rows are reported so the handoff can disclose that earlier content was cut.
fn visit_transcript_rows(path: &Path, mut visit: impl FnMut(&Value)) -> Option<bool> {
    let mut file = open_regular_transcript_handle(path)?;
    let bytes = file.metadata().ok()?.len();
    let tail_offset = if bytes > MAX_TRANSCRIPT_FILE_BYTES {
        bytes.saturating_sub(MAX_TRANSCRIPT_TAIL_BYTES)
    } else {
        0
    };
    let mut partial_row = false;
    if tail_offset > 0 {
        file.seek(SeekFrom::Start(tail_offset - 1)).ok()?;
        let mut previous = [0];
        file.read_exact(&mut previous).ok()?;
        partial_row = previous[0] != b'\n';
    }
    file.seek(SeekFrom::Start(tail_offset)).ok()?;
    let budget = if tail_offset > 0 {
        MAX_TRANSCRIPT_TAIL_BYTES
    } else {
        MAX_TRANSCRIPT_FILE_BYTES
    };
    // The handle may grow after metadata was checked. A `Take` cap keeps the
    // actual read bounded; one sentinel byte lets us detect and reject growth.
    let mut reader = BufReader::new(file).take(budget + 1);
    let mut line = Vec::new();
    let mut skipped_oversized = tail_offset > 0;
    if partial_row {
        read_bounded_line(&mut reader, &mut line, 0).ok()?;
    }
    loop {
        match read_bounded_line(&mut reader, &mut line, MAX_TRANSCRIPT_LINE_BYTES).ok()? {
            None => break,
            Some(false) => skipped_oversized = true,
            Some(true) => {
                if let Ok(value) = serde_json::from_slice::<Value>(&line) {
                    visit(&value);
                }
            }
        }
    }
    if reader.limit() == 0 {
        return None;
    }
    Some(skipped_oversized)
}

fn finish_transcript(out: String, truncated: bool) -> Option<String> {
    let trimmed = out.trim();
    if trimmed.is_empty() {
        return None;
    }
    if truncated {
        Some(format!("…（更早的對話已略過）…\n\n{trimmed}"))
    } else {
        Some(trimmed.to_string())
    }
}

fn parse_claude(path: &Path, max_chars: usize) -> Option<String> {
    if max_chars == 0 {
        return None;
    }
    let mut out = String::new();
    let mut truncated = false;
    let skipped_oversized = visit_transcript_rows(path, |value| {
        let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
        if kind != "user" && kind != "assistant" {
            return;
        }
        let message = value.get("message");
        let role = message
            .and_then(|m| m.get("role"))
            .and_then(Value::as_str)
            .unwrap_or(kind);
        let text = message
            .and_then(|m| m.get("content"))
            .map(content_text)
            .unwrap_or_default();
        push_turn(&mut out, role, &text);
        truncated |= trim_tail(&mut out, max_chars);
    })?;
    finish_transcript(out, truncated || skipped_oversized)
}

fn parse_codex(path: &Path, max_chars: usize) -> Option<String> {
    if max_chars == 0 {
        return None;
    }
    let mut out = String::new();
    let mut truncated = false;
    let skipped_oversized = visit_transcript_rows(path, |value| {
        // Conversation turns live in the payload; skip meta, tool and world rows.
        let Some(payload) = value.get("payload") else {
            return;
        };
        if payload.get("type").and_then(Value::as_str) != Some("message") {
            return;
        }
        let role = payload.get("role").and_then(Value::as_str).unwrap_or("");
        if role != "user" && role != "assistant" {
            return;
        }
        let text = payload.get("content").map(content_text).unwrap_or_default();
        push_turn(&mut out, role, &text);
        truncated |= trim_tail(&mut out, max_chars);
    })?;
    finish_transcript(out, truncated || skipped_oversized)
}

/// Gemini stores text blocks without the Claude/Codex `type` discriminator.
/// Only read plain text blocks; tool payloads and any unknown block stay out
/// of a cross-CLI handoff.
fn gemini_content_text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.trim().to_string();
    }
    let Some(items) = content.as_array() else {
        return String::new();
    };
    items
        .iter()
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn gemini_role(message: &Value) -> Option<&'static str> {
    match message
        .get("role")
        .or_else(|| message.get("type"))
        .and_then(Value::as_str)
    {
        Some("user") => Some("user"),
        Some("assistant") | Some("gemini") | Some("model") => Some("assistant"),
        _ => None,
    }
}

struct GeminiMessageRecord {
    id: String,
    role: Option<&'static str>,
    text: String,
}

fn gemini_message_record(message: &Value) -> Option<GeminiMessageRecord> {
    let id = message.get("id").and_then(Value::as_str)?;
    if id.is_empty() || id.len() > MAX_GEMINI_MESSAGE_ID_BYTES {
        return None;
    }
    let role = gemini_role(message);
    let mut text = role
        .and_then(|_| message.get("content"))
        .map(gemini_content_text)
        .unwrap_or_default();
    let trimmed = text.trim_start();
    if role == Some("user")
        && (trimmed.starts_with("<session_context>")
            || trimmed.starts_with("<hook_context>")
            || trimmed.starts_with('/'))
    {
        text.clear();
    }
    Some(GeminiMessageRecord {
        id: id.to_string(),
        role,
        text,
    })
}

fn upsert_gemini_message(
    records: &mut Vec<GeminiMessageRecord>,
    positions: &mut HashMap<String, usize>,
    text_bytes: &mut usize,
    message: &Value,
) -> bool {
    let Some(record) = gemini_message_record(message) else {
        return false;
    };
    if let Some(index) = positions.get(&record.id).copied() {
        *text_bytes = text_bytes
            .saturating_sub(records[index].text.len())
            .saturating_add(record.text.len());
        records[index] = record;
    } else {
        if records.len() >= MAX_GEMINI_MESSAGE_RECORDS {
            return false;
        }
        *text_bytes = text_bytes.saturating_add(record.text.len());
        positions.insert(record.id.clone(), records.len());
        records.push(record);
    }
    *text_bytes <= MAX_GEMINI_TRANSCRIPT_TEXT_BYTES
}

fn reset_gemini_messages(
    records: &mut Vec<GeminiMessageRecord>,
    positions: &mut HashMap<String, usize>,
    text_bytes: &mut usize,
    messages: &[Value],
) -> bool {
    records.clear();
    positions.clear();
    *text_bytes = 0;
    messages
        .iter()
        .all(|message| upsert_gemini_message(records, positions, text_bytes, message))
}

fn rewind_gemini_messages(
    records: &mut Vec<GeminiMessageRecord>,
    positions: &mut HashMap<String, usize>,
    text_bytes: &mut usize,
    rewind_to: &str,
) {
    let Some(index) = positions.get(rewind_to).copied() else {
        records.clear();
        positions.clear();
        *text_bytes = 0;
        return;
    };
    records.truncate(index);
    positions.clear();
    *text_bytes = 0;
    for (index, record) in records.iter().enumerate() {
        positions.insert(record.id.clone(), index);
        *text_bytes = text_bytes.saturating_add(record.text.len());
    }
}

/// Replays Gemini's append-only chat log into the visible turns. Returns
/// `None` when an oversized or invalid row could have rewritten the history.
fn gemini_turns(path: &Path) -> Option<Vec<(&'static str, String)>> {
    let mut records = Vec::new();
    let mut positions = HashMap::new();
    let mut text_bytes = 0usize;
    let mut valid = true;
    let skipped_oversized = visit_transcript_rows(path, |value| {
        if !valid {
            return;
        }
        if let Some(rewind_to) = value.get("$rewindTo").and_then(Value::as_str) {
            rewind_gemini_messages(&mut records, &mut positions, &mut text_bytes, rewind_to);
        } else if value.get("id").and_then(Value::as_str).is_some() {
            valid = upsert_gemini_message(&mut records, &mut positions, &mut text_bytes, value);
        } else if let Some(messages) = value
            .get("$set")
            .and_then(|set| set.get("messages"))
            .and_then(Value::as_array)
        {
            valid = reset_gemini_messages(&mut records, &mut positions, &mut text_bytes, messages);
        } else if let Some(messages) = value.get("messages").and_then(Value::as_array) {
            valid = messages.iter().all(|message| {
                upsert_gemini_message(&mut records, &mut positions, &mut text_bytes, message)
            });
        }
    })?;
    // An oversized row could be a rewind or replacement operation. Returning
    // partial state would hand the wrong conversation to another CLI.
    if !valid || skipped_oversized {
        return None;
    }
    Some(
        records
            .into_iter()
            .filter_map(|record| Some((record.role?, record.text)))
            .filter(|(_, text)| !text.trim().is_empty())
            .collect(),
    )
}

fn parse_gemini(path: &Path, max_chars: usize) -> Option<String> {
    if max_chars == 0 {
        return None;
    }
    let mut out = String::new();
    let mut truncated = false;
    for (role, text) in gemini_turns(path)? {
        push_turn(&mut out, role, &text);
        truncated |= trim_tail(&mut out, max_chars);
    }
    finish_transcript(out, truncated)
}

/// Antigravity logs every planner step; only completed user prompts and final
/// planner answers are part of the conversation a person would read.
fn antigravity_turn(value: &Value) -> Option<(&'static str, &str)> {
    if value.get("status").and_then(Value::as_str) != Some("DONE") {
        return None;
    }
    let role = match (
        value.get("source").and_then(Value::as_str),
        value.get("type").and_then(Value::as_str),
    ) {
        (Some("USER_EXPLICIT"), Some("USER_INPUT")) => "user",
        (Some("MODEL"), Some("PLANNER_RESPONSE")) => "assistant",
        _ => return None,
    };
    Some((role, value.get("content").and_then(Value::as_str)?))
}

fn parse_antigravity(path: &Path, max_chars: usize) -> Option<String> {
    if max_chars == 0 {
        return None;
    }
    let mut out = String::new();
    let mut truncated = false;
    let skipped_oversized = visit_transcript_rows(path, |value| {
        if let Some((role, text)) = antigravity_turn(value) {
            push_turn(&mut out, role, text);
            truncated |= trim_tail(&mut out, max_chars);
        }
    })?;
    finish_transcript(out, truncated || skipped_oversized)
}

struct ClaudeSessionMeta {
    id: String,
    cwd: String,
    is_main: bool,
}

/// Claude's first rows contain the session ID, while `cwd` and sidechain state
/// normally appear on the first user message a few rows later. Scan a bounded
/// prefix rather than trusting the lossy project-directory slug, which can
/// collide for distinct paths.
fn read_claude_session_meta(path: &Path) -> Option<ClaudeSessionMeta> {
    let file = open_regular_transcript_handle(path)?;
    let mut reader = BufReader::new(file).take(MAX_CLAUDE_SESSION_META_BYTES + 1);
    let mut line = Vec::new();
    let mut session_id = None;
    let mut candidate_cwd: Option<String> = None;
    let mut explicit_main_seen = false;
    let mut sidechain_seen = false;
    let mut agent_seen = false;

    for _ in 0..MAX_CLAUDE_SESSION_META_LINES {
        line.clear();
        let read = reader.read_until(b'\n', &mut line).ok()?;
        if read == 0 {
            break;
        }
        if line.len() as u64 > MAX_CLAUDE_SESSION_META_BYTES {
            return None;
        }
        while matches!(line.last(), Some(b'\n' | b'\r')) {
            line.pop();
        }
        let Ok(value) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        if let Some(id) = value.get("sessionId").and_then(Value::as_str) {
            match session_id.as_deref() {
                Some(existing) if existing != id => return None,
                None => session_id = Some(id.to_string()),
                _ => {}
            }
        }
        sidechain_seen |= value.get("isSidechain").and_then(Value::as_bool) == Some(true);
        agent_seen |= value
            .get("agentId")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty());
        let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
        if !matches!(kind, "user" | "assistant") {
            continue;
        }
        let Some(cwd) = value
            .get("cwd")
            .and_then(Value::as_str)
            .filter(|cwd| !cwd.is_empty())
        else {
            continue;
        };
        let Some(is_sidechain) = value.get("isSidechain").and_then(Value::as_bool) else {
            // A missing sidechain marker is ambiguous. Keep scanning for a
            // verified conversation row instead of rejecting too early.
            continue;
        };
        if candidate_cwd.as_deref().is_some_and(|known| known != cwd) {
            return None;
        }
        candidate_cwd.get_or_insert_with(|| cwd.to_string());
        explicit_main_seen |= !is_sidechain;
    }
    Some(ClaudeSessionMeta {
        id: session_id?,
        cwd: candidate_cwd?,
        is_main: explicit_main_seen && !sidechain_seen && !agent_seen,
    })
}

fn is_jsonl(path: &Path) -> bool {
    path.extension().is_some_and(|ext| ext == "jsonl")
}

fn locate_claude_in(
    projects_root: &Path,
    working_directory: &str,
    captured: Option<&str>,
) -> Option<PathBuf> {
    let projects_root = fs::canonicalize(projects_root).ok()?;
    if let Some(id) = captured {
        return newest_matching(&projects_root, |path| {
            is_jsonl(path)
                && read_claude_session_meta(path).is_some_and(|meta| meta.is_main && meta.id == id)
        });
    }

    let expected_cwd = fs::canonicalize(working_directory).ok()?;
    newest_matching(&projects_root, |path| {
        if !is_jsonl(path) {
            return false;
        }
        let Some(meta) = read_claude_session_meta(path) else {
            return false;
        };
        meta.is_main
            && fs::canonicalize(meta.cwd)
                .ok()
                .is_some_and(|cwd| cwd == expected_cwd)
    })
}

fn locate_claude(working_directory: &str, captured: Option<&str>) -> Option<PathBuf> {
    let projects_root = home()?.join(".claude").join("projects");
    locate_claude_in(&projects_root, working_directory, captured)
}

struct CodexSessionMeta {
    id: Option<String>,
    cwd: Option<String>,
    source_is_string: bool,
    source_is_known_main_cli: bool,
    source_is_interactive: bool,
    model_provider: Option<String>,
}

/// Codex keeps the session identity in the first JSONL row. Read only a
/// bounded prefix so a malformed history cannot allocate an unbounded buffer
/// merely while LatticeTerm is deciding which transcript belongs to a pane.
fn read_codex_session_meta(path: &Path) -> Option<CodexSessionMeta> {
    let file = open_regular_transcript_handle(path)?;
    let mut reader = BufReader::new(file).take((MAX_CODEX_SESSION_META_BYTES + 2) as u64);
    let mut line = Vec::with_capacity(MAX_CODEX_SESSION_META_BYTES.min(8 * 1024));
    reader.read_until(b'\n', &mut line).ok()?;
    if line.last() == Some(&b'\n') {
        line.pop();
    }
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    if line.len() > MAX_CODEX_SESSION_META_BYTES {
        return None;
    }
    let value = serde_json::from_slice::<Value>(&line).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("session_meta") {
        return None;
    }
    let payload = value.get("payload")?;
    let source = payload.get("source").and_then(Value::as_str);
    let originator = payload.get("originator").and_then(Value::as_str);
    Some(CodexSessionMeta {
        model_provider: payload
            .get("model_provider")
            .and_then(Value::as_str)
            .map(str::to_string),
        id: payload
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string),
        cwd: payload
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::to_string),
        source_is_string: source.is_some(),
        source_is_known_main_cli: source == Some("cli")
            || matches!(
                (source, originator),
                (Some("unknown"), Some("codex_cli_rs"))
            ),
        source_is_interactive: matches!(source, Some("cli" | "vscode" | "appServer"))
            || matches!(
                (source, originator),
                (Some("unknown"), Some("codex_cli_rs"))
            ),
    })
}

fn is_codex_rollout(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("rollout-"))
        && path.extension().is_some_and(|ext| ext == "jsonl")
}

fn locate_codex_in(
    sessions_root: &Path,
    working_directory: &str,
    captured: Option<&str>,
) -> Option<PathBuf> {
    let root = fs::canonicalize(sessions_root).ok()?;
    if let Some(id) = captured {
        // Normal Codex filenames include the native ID. Avoid reopening every
        // unrelated transcript on each two-second conversation refresh.
        if let Some(path) = newest_matching(&root, |path| {
            is_codex_rollout(path)
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.contains(id))
                && read_codex_session_meta(path)
                    .is_some_and(|meta| meta.source_is_string && meta.id.as_deref() == Some(id))
        }) {
            return Some(path);
        }
        // Older/imported files may use another name; metadata remains the
        // authority, so keep exact-ID lookup for them as well.
        return newest_matching(&root, |path| {
            is_codex_rollout(path)
                && read_codex_session_meta(path)
                    .is_some_and(|meta| meta.source_is_string && meta.id.as_deref() == Some(id))
        });
    }

    let expected_cwd = fs::canonicalize(working_directory).ok()?;
    newest_matching(&root, |path| {
        if !is_codex_rollout(path) {
            return false;
        }
        let Some(meta) = read_codex_session_meta(path) else {
            return false;
        };
        meta.source_is_known_main_cli
            && meta
                .cwd
                .and_then(|cwd| fs::canonicalize(cwd).ok())
                .is_some_and(|cwd| cwd == expected_cwd)
    })
}

fn locate_codex(working_directory: &str, captured: Option<&str>) -> Option<PathBuf> {
    let root = home()?.join(".codex").join("sessions");
    locate_codex_in(&root, working_directory, captured)
}

/// A local CLI account explicitly configured in LatticeTerm. Never read its
/// authentication files: only the known sessions/projects subtree is visited.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryProfile {
    pub definition_id: String,
    pub profile_id: String,
    pub config_directory: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalConversation {
    pub definition_id: String,
    pub profile_id: Option<String>,
    pub native_session_id: String,
    pub working_directory: String,
    pub resumable: bool,
    pub title: String,
    pub updated_at: u64,
    pub model_provider: Option<String>,
    pub archived: bool,
    pub title_source: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalConversationMessage {
    pub role: &'static str,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<ConversationTool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationTool {
    pub call_id: String,
    pub name: Option<String>,
    pub kind: &'static str,
}

const HISTORY_MAX_PROFILES: usize = 24;
const HISTORY_MAX_ENTRIES: usize = 50_000;
const HISTORY_MAX_RESULTS: usize = 100;
const HISTORY_MAX_MESSAGES: usize = 300;
const HISTORY_MAX_TEXT_BYTES: usize = 256 * 1024;

#[cfg(test)]
#[path = "transcript/sync_tests.rs"]
mod sync_tests;

// A unit test runs on a machine that already has `~/.codex` and `~/.claude`.
// Scanning those pushes the test's own fixtures past the result cap, so the
// assertions would depend on how much history that machine happens to hold.
#[cfg(test)]
thread_local! {
    static ONLY_PROFILE_HISTORY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
fn scan_default_history_roots() -> bool {
    !ONLY_PROFILE_HISTORY.with(std::cell::Cell::get)
}

#[cfg(not(test))]
fn scan_default_history_roots() -> bool {
    true
}

fn history_root(kind: TranscriptKind, profile: Option<&Path>) -> Option<PathBuf> {
    history_root_with_archive(kind, profile, false)
}

fn history_root_with_archive(
    kind: TranscriptKind,
    profile: Option<&Path>,
    archived: bool,
) -> Option<PathBuf> {
    if kind == TranscriptKind::Cursor {
        // Cursor has no account profiles and no archive folder.
        if profile.is_some() || archived {
            return None;
        }
        return cursor_root();
    }
    let name = match kind {
        TranscriptKind::Codex if archived => "archived_sessions",
        TranscriptKind::Codex => "sessions",
        TranscriptKind::Claude => "projects",
        TranscriptKind::Gemini if !archived => "tmp",
        TranscriptKind::Antigravity if !archived => "antigravity-cli",
        _ => return None,
    };
    let shared_gemini_home = matches!(kind, TranscriptKind::Gemini | TranscriptKind::Antigravity);
    let parent = match profile {
        // Account profiles exist only for Codex and Claude; never fall back to
        // the default Gemini home for a profile-scoped request.
        Some(_) if shared_gemini_home => return None,
        Some(path) => path.to_path_buf(),
        None if shared_gemini_home => home()?.join(".gemini"),
        None => match kind {
            TranscriptKind::Codex => std::env::var_os("CODEX_HOME").map(PathBuf::from),
            TranscriptKind::Claude => std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from),
            _ => None,
        }
        .unwrap_or_else(|| {
            home().unwrap_or_default().join(format!(
                ".{}",
                if kind == TranscriptKind::Codex {
                    "codex"
                } else {
                    "claude"
                }
            ))
        }),
    };
    fs::canonicalize(parent.join(name)).ok()
}

fn history_preview(path: &Path, kind: TranscriptKind) -> Option<String> {
    if kind == TranscriptKind::Cursor {
        return first_line_preview(visible_user_text(&cursor_first_user_text(path)?));
    }
    if kind == TranscriptKind::Gemini {
        return gemini_turns(path)?
            .iter()
            .filter(|(role, _)| *role == "user")
            .find_map(|(_, text)| first_line_preview(visible_user_text(text)));
    }
    let file = open_regular_transcript(path)?;
    let mut reader = BufReader::new(file).take(256 * 1024);
    let mut line = Vec::new();
    for _ in 0..64 {
        if !read_bounded_line(&mut reader, &mut line, 32 * 1024)
            .ok()?
            .unwrap_or(false)
        {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        let (role, content) = match kind {
            TranscriptKind::Codex => {
                let Some(payload) = value.get("payload") else {
                    continue;
                };
                if payload.get("type").and_then(Value::as_str) != Some("message") {
                    continue;
                }
                (
                    payload.get("role").and_then(Value::as_str),
                    payload.get("content"),
                )
            }
            TranscriptKind::Claude => {
                let msg = value.get("message");
                (
                    value.get("type").and_then(Value::as_str),
                    msg.and_then(|m| m.get("content")),
                )
            }
            TranscriptKind::Antigravity => (
                antigravity_turn(&value).map(|(role, _)| role),
                value.get("content"),
            ),
            _ => return None,
        };
        if role != Some("user") {
            continue;
        }
        let text = content.map(content_text).unwrap_or_default();
        if let Some(first) = first_line_preview(visible_user_text(&text)) {
            return Some(first);
        }
    }
    None
}

fn first_line_preview(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(80).collect())
}

/// Hide metadata-only Codex shells, but keep uncertain/large records rather
/// than mistaking a bounded read or a temporary file error for lost history.
fn codex_history_may_have_user_input(path: &Path) -> bool {
    let Some(file) = open_regular_transcript(path) else {
        return true;
    };
    if file.metadata().map_or(true, |meta| meta.len() > 256 * 1024) {
        return true;
    }
    let mut reader = BufReader::new(file).take(256 * 1024);
    let mut line = Vec::new();
    for _ in 0..64 {
        match read_bounded_line(&mut reader, &mut line, MAX_CODEX_SESSION_META_BYTES) {
            Ok(None) => return false,
            Ok(Some(true)) => {}
            _ => return true,
        }
        let Ok(value) = serde_json::from_slice::<Value>(&line) else {
            return true;
        };
        let Some(payload) = value.get("payload") else {
            continue;
        };
        if payload.get("type").and_then(Value::as_str) == Some("user_message") {
            return true;
        }
        if payload.get("role").and_then(Value::as_str) == Some("user") {
            let content = &payload["content"];
            let text = content_text(content);
            if !visible_user_text(&text).is_empty()
                || content.as_array().is_some_and(|items| {
                    items
                        .iter()
                        .any(|item| matches!(item["type"].as_str(), Some("input_image" | "image")))
                })
            {
                return true;
            }
        }
    }
    true
}

/// Runtime context arrives in user-role records too. It is not a conversation
/// title or a message typed by the person. Keep actual text after a context block.
fn visible_user_text(mut text: &str) -> &str {
    loop {
        text = text.trim();
        let closing = if text.starts_with("# AGENTS.md instructions for ") {
            Some("</INSTRUCTIONS>")
        } else if text.starts_with("<environment_context>") {
            Some("</environment_context>")
        } else if text.starts_with("<recommended_plugins>") {
            Some("</recommended_plugins>")
        } else {
            None
        };
        let Some(closing) = closing else { return text };
        let Some((_, rest)) = text.split_once(closing) else {
            return "";
        };
        text = rest;
    }
}

struct HistoryScanOptions {
    all: bool,
    archived: bool,
    retained: usize,
}

fn scan_local_conversations(
    kind: TranscriptKind,
    root: &Path,
    profile_id: Option<&str>,
    result: &mut Vec<(LocalConversation, PathBuf)>,
    options: HistoryScanOptions,
    incomplete: &mut bool,
) -> Result<(), String> {
    let all = options.all;
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut visited = 0;
    while let Some((dir, depth)) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(error) => {
                if error.kind() != io::ErrorKind::NotFound {
                    *incomplete = true;
                }
                continue;
            }
        };
        for entry in entries {
            let Ok(entry) = entry else {
                *incomplete = true;
                continue;
            };
            visited += 1;
            if visited > HISTORY_MAX_ENTRIES {
                *incomplete = true;
                return if all {
                    Err(
                        "Local history exceeds the scan limit; no conversations were opened."
                            .into(),
                    )
                } else {
                    Ok(())
                };
            }
            let Ok(file_type) = entry.file_type() else {
                *incomplete = true;
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                if depth < 5 {
                    stack.push((entry.path(), depth + 1));
                } else {
                    *incomplete = true;
                }
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let path = entry.path();
            let candidate = match kind {
                TranscriptKind::Codex if is_codex_rollout(&path) => read_codex_session_meta(&path)
                    .and_then(|meta| meta.source_is_interactive.then_some((meta.id?, meta.cwd?))),
                TranscriptKind::Claude if is_jsonl(&path) => read_claude_session_meta(&path)
                    .and_then(|meta| meta.is_main.then_some((meta.id, meta.cwd))),
                TranscriptKind::Gemini if is_gemini_session(&path) => {
                    read_gemini_session_meta(&path)
                }
                _ => None,
            };
            let Some((id, cwd)) = candidate else { continue };
            if kind == TranscriptKind::Codex && !codex_history_may_have_user_input(&path) {
                continue;
            }
            push_history_entry(
                kind,
                HistoryCandidate { path, id, cwd },
                profile_id,
                &options,
                result,
            )?;
        }
    }
    Ok(())
}

struct HistoryCandidate {
    path: PathBuf,
    id: String,
    cwd: String,
}

fn push_history_entry(
    kind: TranscriptKind,
    candidate: HistoryCandidate,
    profile_id: Option<&str>,
    options: &HistoryScanOptions,
    result: &mut Vec<(LocalConversation, PathBuf)>,
) -> Result<(), String> {
    let HistoryCandidate { path, id, cwd } = candidate;
    if id.len() > 128 || id.is_empty() || id.starts_with('-') || id.chars().any(char::is_control) {
        return Ok(());
    }
    // Keep readable history even when its project has since moved;
    // only the resume actions need a still-existing directory.
    let canonical = fs::canonicalize(&cwd).ok().filter(|path| path.is_dir());
    // Cursor's agent transcripts are written by the editor; its CLI keeps
    // separate chats, so these can be read here but not resumed.
    let resumable = canonical.is_some() && !options.archived && kind != TranscriptKind::Cursor;
    let cwd = canonical.unwrap_or_else(|| PathBuf::from(cwd.trim_start_matches(r"\\?\")));
    let Ok(metadata) = fs::symlink_metadata(&path) else {
        return Ok(());
    };
    let updated_at = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |time| time.as_secs());
    let definition_id = match kind {
        TranscriptKind::Antigravity => "antigravity",
        TranscriptKind::Claude => "claude",
        TranscriptKind::Codex => "codex",
        TranscriptKind::Cursor => "cursor",
        TranscriptKind::Gemini => "gemini",
    };
    result.push((
        LocalConversation {
            definition_id: definition_id.into(),
            profile_id: profile_id.map(str::to_string),
            native_session_id: id,
            working_directory: cwd.to_string_lossy().into_owned(),
            resumable,
            title: String::new(),
            updated_at,
            model_provider: if kind == TranscriptKind::Codex {
                read_codex_session_meta(&path).and_then(|meta| meta.model_provider)
            } else {
                None
            },
            archived: options.archived,
            title_source: "firstMessage".into(),
        },
        path,
    ));
    // Keep a bounded newest-first working set even when several
    // accounts have very large histories.
    if options.all && result.len() > 1024 {
        return Err(
            "More than 1024 local conversations were found; use individual selection.".into(),
        );
    }
    if !options.all && result.len() >= options.retained.saturating_mul(2).max(2) {
        sort_history(result);
        result.truncate(options.retained);
    }
    Ok(())
}

/// Gemini writes a metadata row first and the project root beside the chat
/// directory. Subagent records and chats without any visible user turn stay
/// out of the list, matching what Gemini itself offers to resume.
fn read_gemini_session_meta(path: &Path) -> Option<(String, String)> {
    if path.parent()?.file_name()? != "chats" {
        return None;
    }
    let file = open_regular_transcript(path)?;
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    if !read_bounded_line(&mut reader, &mut line, MAX_TRANSCRIPT_LINE_BYTES)
        .ok()?
        .unwrap_or(false)
    {
        return None;
    }
    let meta = serde_json::from_slice::<Value>(&line).ok()?;
    if meta
        .get("kind")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind != "main")
    {
        return None;
    }
    let id = meta.get("sessionId").and_then(Value::as_str)?.to_string();
    let root_file = open_regular_transcript(&path.parent()?.parent()?.join(".project_root"))?;
    let mut cwd = String::new();
    root_file
        .take((MAX_GEMINI_PROJECT_ROOT_BYTES + 1) as u64)
        .read_to_string(&mut cwd)
        .ok()?;
    let cwd = cwd.trim();
    if cwd.is_empty() || cwd.len() > MAX_GEMINI_PROJECT_ROOT_BYTES || cwd.contains('\0') {
        return None;
    }
    gemini_turns(path)?
        .iter()
        .any(|(role, text)| *role == "user" && !visible_user_text(text).is_empty())
        .then(|| (id, cwd.to_string()))
}

const MAX_ANTIGRAVITY_HISTORY_LINE_BYTES: usize = 64 * 1024;

/// Antigravity's prompt history is the only record that ties a conversation
/// to its workspace. Brain folders missing from it are subagents or detached
/// work, so they are not listed as resumable top-level conversations.
fn scan_antigravity_conversations(
    root: &Path,
    result: &mut Vec<(LocalConversation, PathBuf)>,
    options: HistoryScanOptions,
    incomplete: &mut bool,
) -> Result<(), String> {
    let Some(file) = open_regular_transcript(&root.join("history.jsonl")) else {
        return Ok(());
    };
    let mut reader = BufReader::new(file).take(MAX_TRANSCRIPT_FILE_BYTES + 1);
    let mut line = Vec::new();
    let mut workspaces = HashMap::new();
    loop {
        match read_bounded_line(&mut reader, &mut line, MAX_ANTIGRAVITY_HISTORY_LINE_BYTES) {
            Ok(None) => break,
            Ok(Some(true)) => {}
            Ok(Some(false)) => {
                *incomplete = true;
                continue;
            }
            Err(_) => {
                *incomplete = true;
                break;
            }
        }
        let Ok(row) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        let (Some(id), Some(workspace)) = (
            row.get("conversationId")
                .or_else(|| row.get("conversation_id"))
                .and_then(Value::as_str),
            row.get("workspace").and_then(Value::as_str),
        ) else {
            continue;
        };
        if antigravity_conversation_id(id) && !workspace.trim().is_empty() {
            workspaces.insert(id.to_string(), workspace.to_string());
        }
    }
    if reader.limit() == 0 {
        *incomplete = true;
    }
    for (id, cwd) in workspaces {
        let Some(path) = antigravity_transcript(root, &id) else {
            continue;
        };
        push_history_entry(
            TranscriptKind::Antigravity,
            HistoryCandidate { path, id, cwd },
            None,
            &options,
            result,
        )?;
    }
    Ok(())
}

pub fn list_local_conversations(
    profiles: &[HistoryProfile],
) -> Result<Vec<LocalConversation>, String> {
    list_local_conversations_with_limit(profiles, false)
}

pub fn list_local_conversations_with_limit(
    profiles: &[HistoryProfile],
    all: bool,
) -> Result<Vec<LocalConversation>, String> {
    list_local_conversations_with_options(profiles, all, false)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalConversationPage {
    pub entries: Vec<LocalConversation>,
    pub has_more: bool,
    pub incomplete: bool,
}

fn sort_history(entries: &mut [(LocalConversation, PathBuf)]) {
    entries.sort_by(|a, b| {
        b.0.updated_at
            .cmp(&a.0.updated_at)
            .then_with(|| a.0.definition_id.cmp(&b.0.definition_id))
            .then_with(|| a.0.profile_id.cmp(&b.0.profile_id))
            .then_with(|| a.0.native_session_id.cmp(&b.0.native_session_id))
    });
}

// The append-only native name index has id/thread_name rows. Last valid row wins.
// It is optional: an unavailable or unfamiliar index must not hide conversations.
fn codex_names(home: &Path) -> HashMap<String, String> {
    use std::io::{Seek, SeekFrom};
    let mut names = HashMap::new();
    let Some(mut file) = open_regular_transcript(&home.join("session_index.jsonl")) else {
        return names;
    };
    let bytes = file.metadata().map(|m| m.len()).unwrap_or(0);
    const LIMIT: u64 = 8 * 1024 * 1024;
    if bytes > LIMIT && file.seek(SeekFrom::Start(bytes - LIMIT)).is_err() {
        return names;
    }
    let mut reader = BufReader::new(file.take(LIMIT));
    let mut line = Vec::new();
    if bytes > LIMIT {
        let _ = read_bounded_line(&mut reader, &mut line, 16 * 1024);
    }
    while let Ok(Some(valid)) = read_bounded_line(&mut reader, &mut line, 16 * 1024) {
        if !valid {
            continue;
        }
        let Ok(row) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        if let (Some(id), Some(name)) = (
            row.get("id").and_then(Value::as_str),
            row.get("thread_name").and_then(Value::as_str),
        ) {
            if id.len() <= 128 && !name.trim().is_empty() && !name.chars().any(char::is_control) {
                names.insert(id.to_owned(), name.chars().take(200).collect());
            }
        }
    }
    names
}

pub fn list_local_conversations_with_options(
    profiles: &[HistoryProfile],
    all: bool,
    include_archived: bool,
) -> Result<Vec<LocalConversation>, String> {
    collect_local_conversations(profiles, all, include_archived, HISTORY_MAX_RESULTS)
        .map(|page| page.0)
}

/// Refresh a growing, bounded prefix atomically instead of appending unstable offsets.
pub fn local_conversation_page(
    profiles: &[HistoryProfile],
    limit: usize,
    include_archived: bool,
) -> Result<LocalConversationPage, String> {
    let limit = limit.clamp(1, HISTORY_MAX_ENTRIES);
    let (mut entries, incomplete) =
        collect_local_conversations(profiles, false, include_archived, limit + 1)?;
    let has_more = entries.len() > limit;
    entries.truncate(limit);
    Ok(LocalConversationPage {
        entries,
        has_more,
        incomplete: incomplete || (has_more && limit == HISTORY_MAX_ENTRIES),
    })
}

fn collect_local_conversations(
    profiles: &[HistoryProfile],
    all: bool,
    include_archived: bool,
    retained: usize,
) -> Result<(Vec<LocalConversation>, bool), String> {
    if profiles.len() > HISTORY_MAX_PROFILES {
        return Err("Too many account profiles.".into());
    }
    let mut entries = Vec::new();
    let mut incomplete = false;
    if scan_default_history_roots() {
        for kind in [
            TranscriptKind::Codex,
            TranscriptKind::Claude,
            TranscriptKind::Gemini,
            TranscriptKind::Antigravity,
            TranscriptKind::Cursor,
        ] {
            if kind == TranscriptKind::Cursor {
                if let Some(root) = history_root(kind, None) {
                    scan_cursor_conversations(
                        &root,
                        &cursor_workspace_folders(),
                        &mut entries,
                        HistoryScanOptions {
                            all,
                            archived: false,
                            retained,
                        },
                        &mut incomplete,
                    )?;
                }
                continue;
            }
            if kind == TranscriptKind::Antigravity {
                if let Some(root) = history_root(kind, None) {
                    scan_antigravity_conversations(
                        &root,
                        &mut entries,
                        HistoryScanOptions {
                            all,
                            archived: false,
                            retained,
                        },
                        &mut incomplete,
                    )?;
                }
                continue;
            }
            if let Some(root) = history_root(kind, None) {
                scan_local_conversations(
                    kind,
                    &root,
                    None,
                    &mut entries,
                    HistoryScanOptions {
                        all,
                        archived: false,
                        retained,
                    },
                    &mut incomplete,
                )?;
            }
            if include_archived && kind == TranscriptKind::Codex {
                if let Some(root) = history_root_with_archive(kind, None, true) {
                    scan_local_conversations(
                        kind,
                        &root,
                        None,
                        &mut entries,
                        HistoryScanOptions {
                            all,
                            archived: true,
                            retained,
                        },
                        &mut incomplete,
                    )?;
                }
            }
        }
    }
    for profile in profiles {
        let kind = TranscriptKind::from_definition(&profile.definition_id)
            .filter(|kind| matches!(kind, TranscriptKind::Codex | TranscriptKind::Claude))
            .ok_or("Unknown account profile type.")?;
        if profile.profile_id.is_empty() || profile.profile_id.len() > 64 {
            return Err("Invalid account profile ID.".into());
        }
        let path = Path::new(&profile.config_directory);
        if !path.is_absolute() {
            return Err("Account profile directory must be absolute.".into());
        }
        if let Some(root) = history_root(kind, Some(path)) {
            scan_local_conversations(
                kind,
                &root,
                Some(&profile.profile_id),
                &mut entries,
                HistoryScanOptions {
                    all,
                    archived: false,
                    retained,
                },
                &mut incomplete,
            )?;
        }
        if include_archived && kind == TranscriptKind::Codex {
            if let Some(root) = history_root_with_archive(kind, Some(path), true) {
                scan_local_conversations(
                    kind,
                    &root,
                    Some(&profile.profile_id),
                    &mut entries,
                    HistoryScanOptions {
                        all,
                        archived: true,
                        retained,
                    },
                    &mut incomplete,
                )?;
            }
        }
    }
    sort_history(&mut entries);
    let mut names: HashMap<PathBuf, HashMap<String, String>> = HashMap::new();
    let mut seen = std::collections::HashSet::new();
    let mut selected = Vec::new();
    for (mut conversation, path) in entries {
        if !seen.insert((
            conversation.definition_id.clone(),
            conversation.profile_id.clone(),
            conversation.native_session_id.clone(),
        )) {
            continue;
        }
        let kind =
            TranscriptKind::from_definition(&conversation.definition_id).expect("validated above");
        conversation.title =
            history_preview(&path, kind).unwrap_or_else(|| conversation.native_session_id.clone());
        if kind == TranscriptKind::Codex {
            // Account-scoped native name index; never borrow a name from another account.
            let profile = conversation.profile_id.as_deref().and_then(|id| {
                profiles
                    .iter()
                    .find(|profile| profile.definition_id == "codex" && profile.profile_id == id)
            });
            if let Some(root) = history_root_with_archive(
                kind,
                profile.map(|p| Path::new(&p.config_directory)),
                conversation.archived,
            ) {
                if let Some(parent) = root.parent() {
                    let index = names
                        .entry(parent.to_path_buf())
                        .or_insert_with(|| codex_names(parent));
                    if let Some(name) = index.get(&conversation.native_session_id) {
                        conversation.title = name.clone();
                        conversation.title_source = "nativeIndex".into();
                    }
                }
            }
        }
        selected.push(conversation);
        if !all && selected.len() == retained {
            break;
        }
    }
    Ok((selected, incomplete))
}

pub fn read_local_conversation(
    definition_id: &str,
    session_id: &str,
    profile_id: Option<&str>,
    profiles: &[HistoryProfile],
) -> Result<Vec<LocalConversationMessage>, String> {
    read_local_conversation_snapshot(definition_id, session_id, profile_id, profiles)
        .map(|snapshot| snapshot.messages)
}

pub fn read_local_conversation_snapshot(
    definition_id: &str,
    session_id: &str,
    profile_id: Option<&str>,
    profiles: &[HistoryProfile],
) -> Result<LocalConversationSnapshot, String> {
    // Resolve the exact identity inside the selected account. The latest-100
    // preview is not an authorization list and must not hide older records.
    if profiles.len() > HISTORY_MAX_PROFILES
        || session_id.is_empty()
        || session_id.len() > 128
        || session_id.starts_with('-')
        || session_id.chars().any(char::is_control)
    {
        return Err("Invalid conversation identity.".into());
    }
    let kind = TranscriptKind::from_definition(definition_id).ok_or("Unknown assistant.")?;
    let profile = match profile_id {
        Some(id) => Some(Path::new(
            &profiles
                .iter()
                .find(|p| p.profile_id == id && p.definition_id == definition_id)
                .ok_or("The account profile is no longer available.")?
                .config_directory,
        )),
        None => None,
    };
    if profile.is_some_and(|path| !path.is_absolute() || !path.is_dir()) {
        return Err("The account directory is unavailable.".into());
    }
    let root = history_root(kind, profile)
        .or_else(|| {
            (kind == TranscriptKind::Codex)
                .then(|| history_root_with_archive(kind, profile, true))
                .flatten()
        })
        .ok_or("The local conversation is no longer available.")?;
    let path = match kind {
        TranscriptKind::Codex => locate_codex_in(&root, "", Some(session_id))
            .or_else(|| {
                history_root_with_archive(kind, profile, true)
                    .and_then(|archive| locate_codex_in(&archive, "", Some(session_id)))
            })
            .filter(|path| {
                read_codex_session_meta(path).is_some_and(|meta| meta.source_is_interactive)
            }),
        TranscriptKind::Claude => locate_claude_in(&root, "", Some(session_id)),
        TranscriptKind::Gemini => newest_matching(&root, |path| {
            is_gemini_session(path) && read_gemini_session_id(path).as_deref() == Some(session_id)
        }),
        TranscriptKind::Antigravity => antigravity_transcript(&root, session_id),
        TranscriptKind::Cursor => cursor_transcript(&root, session_id),
    }
    .ok_or("The local conversation is no longer available.")?;
    let mut snapshot = read_conversation_snapshot(&path, kind)?;
    snapshot.archived = Some(
        kind == TranscriptKind::Codex
            && history_root_with_archive(kind, profile, true)
                .is_some_and(|archive| path.starts_with(archive)),
    );
    Ok(snapshot)
}

/// Reads only the exact native conversation owned by this running session.
/// Never substitute another conversation from the same working directory.
pub fn read_session_conversation(
    definition_id: &str,
    working_directory: &str,
    session_id: Option<&str>,
    profile_directory: Option<&Path>,
) -> Result<Vec<LocalConversationMessage>, String> {
    let snapshot = read_session_conversation_snapshot(
        definition_id,
        working_directory,
        session_id,
        profile_directory,
    )?;
    if snapshot.availability == SessionConversationAvailability::WaitingForTranscript {
        return Err("The session conversation is not available yet.".into());
    }
    Ok(snapshot.messages)
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SessionConversationAvailability {
    WaitingForIdentity,
    WaitingForTranscript,
    Ready,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionConversationSnapshot {
    pub availability: SessionConversationAvailability,
    pub messages: Vec<LocalConversationMessage>,
    pub truncated: bool,
}

pub fn read_session_conversation_snapshot(
    definition_id: &str,
    working_directory: &str,
    session_id: Option<&str>,
    profile_directory: Option<&Path>,
) -> Result<SessionConversationSnapshot, String> {
    let waiting = |availability| SessionConversationSnapshot {
        availability,
        messages: Vec::new(),
        truncated: false,
    };
    let Some(session_id) = session_id.filter(|id| !id.is_empty()) else {
        return Ok(waiting(SessionConversationAvailability::WaitingForIdentity));
    };
    let kind = TranscriptKind::from_definition(definition_id)
        .ok_or("This CLI does not support conversation view.")?;
    if profile_directory.is_some_and(|path| !path.is_absolute() || !path.is_dir()) {
        return Err("The account directory is unavailable.".into());
    }
    let Some(root) = history_root(kind, profile_directory)
        .or_else(|| history_root_with_archive(kind, profile_directory, true))
    else {
        return Ok(waiting(
            SessionConversationAvailability::WaitingForTranscript,
        ));
    };
    let path = match kind {
        TranscriptKind::Codex => locate_codex_in(&root, working_directory, Some(session_id))
            .or_else(|| {
                history_root_with_archive(kind, profile_directory, true).and_then(|archive| {
                    locate_codex_in(&archive, working_directory, Some(session_id))
                })
            }),
        TranscriptKind::Claude => locate_claude_in(&root, working_directory, Some(session_id)),
        TranscriptKind::Gemini => locate_gemini_in(&root, working_directory, Some(session_id)),
        TranscriptKind::Antigravity => antigravity_transcript(&root, session_id),
        TranscriptKind::Cursor => cursor_transcript(&root, session_id),
    };
    let Some(path) = path else {
        return Ok(waiting(
            SessionConversationAvailability::WaitingForTranscript,
        ));
    };
    let snapshot = read_conversation_snapshot_with_tools(&path, kind, true)?;
    Ok(SessionConversationSnapshot {
        availability: SessionConversationAvailability::Ready,
        messages: snapshot.messages,
        truncated: snapshot.truncated,
    })
}

/// The provider comes only from the exact native record in this account,
/// never from terminal output or a renderer-supplied file path.
pub(crate) fn codex_session_provider(
    session_id: &str,
    profile_directory: Option<&Path>,
) -> Result<Option<String>, String> {
    let Some(root) = history_root(TranscriptKind::Codex, profile_directory) else {
        return Ok(None);
    };
    let Some(path) = locate_codex_in(&root, "", Some(session_id)) else {
        return Ok(None);
    };
    Ok(read_codex_session_meta(&path).and_then(|meta| meta.model_provider))
}

/// Whether a thread Codex just reported is a conversation a person holds,
/// from a terminal, the chat page or Codex Desktop, rather than a subagent. `None` when its record cannot
/// be found yet; the reporter runs with the Codex process's own
/// environment, so `CODEX_HOME` already names the right account.
pub(crate) fn codex_thread_is_conversation(thread_id: &str) -> Option<bool> {
    let root = history_root(TranscriptKind::Codex, None)?;
    let path = locate_codex_in(&root, "", Some(thread_id))?;
    read_codex_session_meta(&path).map(|meta| meta.source_is_interactive)
}

/// The newest Codex conversation of this project and account, whether it
/// was held in a terminal, on the chat page or in Codex Desktop, that went
/// through the same kind of provider, for a saved tab whose id was never
/// reported. Codex's own `resume --last` cannot find a proxy thread, because
/// each proxied process registers its provider under a fresh name.
pub(crate) fn latest_codex_thread(
    working_directory: &str,
    profile_directory: Option<&Path>,
    through_proxy: bool,
    taken: &[String],
) -> Option<String> {
    let root = history_root(TranscriptKind::Codex, profile_directory)?;
    latest_codex_thread_in(&root, working_directory, through_proxy, taken)
}

fn latest_codex_thread_in(
    sessions_root: &Path,
    working_directory: &str,
    through_proxy: bool,
    taken: &[String],
) -> Option<String> {
    let expected_cwd = fs::canonicalize(working_directory).ok()?;
    let path = newest_matching(sessions_root, |path| {
        if !is_codex_rollout(path) {
            return false;
        }
        let Some(meta) = read_codex_session_meta(path) else {
            return false;
        };
        let proxied = meta
            .model_provider
            .as_deref()
            .is_some_and(crate::cliproxy::launch::is_managed_provider);
        meta.source_is_interactive
            && proxied == through_proxy
            && meta.id.as_ref().is_some_and(|id| {
                !id.is_empty() && !id.starts_with('-') && !taken.iter().any(|seen| seen == id)
            })
            && meta
                .cwd
                .and_then(|cwd| fs::canonicalize(cwd).ok())
                .is_some_and(|cwd| cwd == expected_cwd)
    })?;
    read_codex_session_meta(&path).and_then(|meta| meta.id)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalConversationSnapshot {
    pub messages: Vec<LocalConversationMessage>,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
}

fn read_conversation_snapshot(
    path: &Path,
    kind: TranscriptKind,
) -> Result<LocalConversationSnapshot, String> {
    read_conversation_snapshot_with_tools(path, kind, false)
}

fn read_conversation_snapshot_with_tools(
    path: &Path,
    kind: TranscriptKind,
    include_tools: bool,
) -> Result<LocalConversationSnapshot, String> {
    let mut messages = Vec::new();
    let mut bytes = 0;
    let mut truncated = false;
    let mut push = |role: &'static str, text: String, tool: Option<ConversationTool>| {
        let text = if role == "user" {
            visible_user_text(&text).to_string()
        } else {
            text
        };
        if text.is_empty() && tool.is_none() {
            return;
        }
        let tool_bytes = tool.as_ref().map_or(0, |tool| {
            tool.call_id.len() + tool.name.as_ref().map_or(0, String::len)
        });
        bytes += text.len() + tool_bytes;
        messages.push(LocalConversationMessage { role, text, tool });
        while messages.len() > HISTORY_MAX_MESSAGES || bytes > HISTORY_MAX_TEXT_BYTES {
            truncated = true;
            let removed: LocalConversationMessage = messages.remove(0);
            bytes -= removed.text.len();
            bytes -= removed.tool.as_ref().map_or(0, |tool| {
                tool.call_id.len() + tool.name.as_ref().map_or(0, String::len)
            });
        }
    };
    if kind == TranscriptKind::Gemini {
        for (role, text) in
            gemini_turns(path).ok_or("The local conversation could not be read safely.")?
        {
            push(role, text, None);
        }
        return Ok(LocalConversationSnapshot {
            messages,
            truncated,
            archived: None,
        });
    }
    let incomplete = visit_transcript_rows(path, |value| {
        let (role, content) = match kind {
            TranscriptKind::Codex => {
                if include_tools {
                    if let Some((text, tool)) = codex_conversation_tool(value) {
                        push("assistant", text, Some(tool));
                        return;
                    }
                }
                let Some(payload) = value.get("payload") else {
                    return;
                };
                if payload.get("type").and_then(Value::as_str) != Some("message") {
                    return;
                }
                (
                    payload.get("role").and_then(Value::as_str),
                    payload.get("content"),
                )
            }
            TranscriptKind::Claude => {
                let role = value.get("type").and_then(Value::as_str);
                (role, value.get("message").and_then(|m| m.get("content")))
            }
            TranscriptKind::Antigravity => {
                if let Some((role, text)) = antigravity_turn(value) {
                    push(role, text.trim().to_string(), None);
                }
                return;
            }
            TranscriptKind::Cursor => {
                if let Some((role, text)) = cursor_turn(value) {
                    push(role, text, None);
                }
                return;
            }
            TranscriptKind::Gemini => return,
        };
        let role = match role {
            Some("user") => "user",
            Some("assistant") => "assistant",
            _ => return,
        };
        push(role, content.map(content_text).unwrap_or_default(), None);
    })
    .ok_or("The local conversation could not be read safely.")?;
    Ok(LocalConversationSnapshot {
        messages,
        truncated: truncated || incomplete,
        archived: None,
    })
}

fn codex_conversation_tool(value: &Value) -> Option<(String, ConversationTool)> {
    if value.get("type")?.as_str()? != "response_item" {
        return None;
    }
    let payload = value.get("payload")?;
    let (kind, field) = match payload.get("type")?.as_str()? {
        "function_call" => ("call", "arguments"),
        "custom_tool_call" => ("call", "input"),
        "function_call_output" | "custom_tool_call_output" => ("result", "output"),
        _ => return None,
    };
    let call_id = payload.get("call_id")?.as_str()?;
    if call_id.is_empty() || call_id.len() > 256 || call_id.chars().any(char::is_control) {
        return None;
    }
    let name = if let Some(name) = payload.get("name").and_then(Value::as_str) {
        if name.is_empty() || name.len() > 256 || name.chars().any(char::is_control) {
            return None;
        }
        Some(name.to_string())
    } else {
        if kind == "call" {
            return None;
        }
        None
    };
    let content = payload.get(field)?;
    let text = if let Some(text) = content.as_str() {
        text.to_string()
    } else if kind == "result" && content.is_array() {
        content_text(content)
    } else {
        return None;
    };
    Some((
        text,
        ConversationTool {
            call_id: call_id.to_string(),
            name,
            kind,
        },
    ))
}

fn is_gemini_session(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("session-"))
        && path
            .extension()
            .is_some_and(|extension| extension == "jsonl")
}

/// Gemini records the project root beside each hashed chat directory. Read a
/// small, regular file only, then canonicalize it before matching a session.
fn read_gemini_project_root(path: &Path) -> Option<PathBuf> {
    let file = open_regular_transcript(path)?;
    let mut contents = String::new();
    file.take((MAX_GEMINI_PROJECT_ROOT_BYTES + 1) as u64)
        .read_to_string(&mut contents)
        .ok()?;
    if contents.len() > MAX_GEMINI_PROJECT_ROOT_BYTES || contents.contains('\0') {
        return None;
    }
    fs::canonicalize(contents.trim()).ok()
}

fn read_gemini_session_id(path: &Path) -> Option<String> {
    let file = open_regular_transcript(path)?;
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    if !read_bounded_line(&mut reader, &mut line, MAX_TRANSCRIPT_LINE_BYTES)
        .ok()?
        .unwrap_or(false)
    {
        return None;
    }
    serde_json::from_slice::<Value>(&line)
        .ok()?
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn gemini_project_root(working_directory: &str) -> Option<PathBuf> {
    // Gemini's Storage project root is the exact target directory passed at
    // launch, unlike Claude auto-memory which deliberately scopes to the Git
    // repository. Matching a parent repository here would select the wrong
    // chat when Gemini was launched from a subdirectory.
    fs::canonicalize(working_directory).ok()
}

fn gemini_session_matches(path: &Path, expected_root: &Path, captured: Option<&str>) -> bool {
    if captured.is_some_and(|id| read_gemini_session_id(path).as_deref() != Some(id)) {
        return false;
    }
    let Some(project_root_file) = path
        .parent()
        .and_then(Path::parent)
        .map(|directory| directory.join(".project_root"))
    else {
        return false;
    };
    read_gemini_project_root(&project_root_file).is_some_and(|root| root == expected_root)
}

fn locate_gemini_in(
    sessions_root: &Path,
    working_directory: &str,
    captured: Option<&str>,
) -> Option<PathBuf> {
    let root = fs::canonicalize(sessions_root).ok()?;
    let expected_root = gemini_project_root(working_directory)?;
    newest_matching(&root, |path| {
        is_gemini_session(path) && gemini_session_matches(path, &expected_root, captured)
    })
}

fn antigravity_conversation_id(value: &str) -> bool {
    value.len() == 36
        && value.chars().enumerate().all(|(index, character)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                character == '-'
            } else {
                character.is_ascii_hexdigit()
            }
        })
}

#[cfg(test)]
fn path_matches_workspace(candidate: &str, expected_cwd: &Path) -> bool {
    let candidate_raw = candidate.trim_start_matches(r"\\?\");
    let candidate_path = PathBuf::from(candidate_raw);
    if let Ok(canon_candidate) = fs::canonicalize(&candidate_path) {
        if canon_candidate == expected_cwd {
            return true;
        }
    }
    let norm_candidate = candidate_raw
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase();
    let norm_expected = expected_cwd
        .to_string_lossy()
        .trim_start_matches(r"\\?\")
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase();
    norm_candidate == norm_expected
}

/// Resolves only the exact brain transcript for a conversation ID and keeps
/// the canonical result inside the Antigravity data root.
fn antigravity_transcript(root: &Path, id: &str) -> Option<PathBuf> {
    if !antigravity_conversation_id(id) {
        return None;
    }
    let root = fs::canonicalize(root).ok()?;
    let transcript = root
        .join("brain")
        .join(id)
        .join(".system_generated")
        .join("logs")
        .join("transcript.jsonl");
    fs::canonicalize(transcript)
        .ok()
        .filter(|path| path.starts_with(&root) && path.is_file())
}

#[cfg(test)]
fn locate_antigravity_in(
    root: &Path,
    working_directory: &str,
    captured: Option<&str>,
) -> Option<PathBuf> {
    let root = fs::canonicalize(root).ok()?;
    if let Some(transcript) = captured.and_then(|id| antigravity_transcript(&root, id)) {
        return Some(transcript);
    }

    let expected_cwd = fs::canonicalize(working_directory).ok()?;

    // Fast path: history.jsonl records workspace paths alongside conversation IDs.
    // Read from the newest line backwards to match the most recent conversation.
    let history_file = root.join("history.jsonl");
    if let Some(file) = open_regular_transcript(&history_file) {
        let reader = BufReader::new(file);
        let mut lines = Vec::new();
        for line in reader.lines().map_while(Result::ok) {
            if !line.trim().is_empty() {
                lines.push(line);
            }
        }
        for line in lines.into_iter().rev() {
            let Ok(val) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let Some(workspace) = val.get("workspace").and_then(Value::as_str) else {
                continue;
            };
            if !path_matches_workspace(workspace, &expected_cwd) {
                continue;
            }
            let Some(cid) = val
                .get("conversationId")
                .or_else(|| val.get("conversation_id"))
                .and_then(Value::as_str)
            else {
                continue;
            };
            if !antigravity_conversation_id(cid) {
                continue;
            }
            let candidate = root
                .join("brain")
                .join(cid)
                .join(".system_generated")
                .join("logs")
                .join("transcript.jsonl");
            if let Ok(canon) = fs::canonicalize(&candidate) {
                if canon.starts_with(&root) && canon.is_file() {
                    return Some(canon);
                }
            }
        }
    }

    // Safety fallback: walk the brain directory for the most recently modified transcript.
    let brain_dir = root.join("brain");
    newest_matching(&brain_dir, |path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name == "transcript.jsonl")
            && path
                .parent()
                .and_then(|logs| logs.file_name())
                .and_then(|name| name.to_str())
                .is_some_and(|name| name == "logs")
    })
}

/// Cursor wraps what the person typed in `<user_query>` and sends rules,
/// git status, and skills as separate user rows. Only the typed query and
/// the assistant's text are conversation content.
fn cursor_turn(value: &Value) -> Option<(&'static str, String)> {
    let role = match value.get("role").and_then(Value::as_str)? {
        "user" => "user",
        "assistant" => "assistant",
        _ => return None,
    };
    let text = content_text(value.get("message")?.get("content")?);
    let text = if role == "user" {
        cursor_user_query(&text)?
    } else {
        text
    };
    let text = text.trim();
    (!text.is_empty()).then(|| (role, text.to_string()))
}

fn cursor_user_query(text: &str) -> Option<String> {
    const OPEN: &str = "<user_query>";
    const CLOSE: &str = "</user_query>";
    let mut queries = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find(OPEN) {
        let body = &rest[start + OPEN.len()..];
        let end = body.find(CLOSE).unwrap_or(body.len());
        queries.push(body[..end].trim());
        rest = &body[(end + CLOSE.len()).min(body.len())..];
    }
    if !queries.is_empty() {
        return Some(queries.join("\n"));
    }
    // Rows that start with a tag and carry no query are injected context.
    let text = text.trim();
    (!text.starts_with('<')).then(|| text.to_string())
}

fn cursor_first_user_text(path: &Path) -> Option<String> {
    let file = open_regular_transcript(path)?;
    let mut reader = BufReader::new(file).take(MAX_TRANSCRIPT_FILE_BYTES + 1);
    let mut line = Vec::new();
    for _ in 0..64 {
        if !read_bounded_line(&mut reader, &mut line, MAX_TRANSCRIPT_LINE_BYTES).ok()?? {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        if let Some(("user", text)) = cursor_turn(&value) {
            if !visible_user_text(&text).is_empty() {
                return Some(text);
            }
        }
    }
    None
}

fn parse_cursor(path: &Path, max_chars: usize) -> Option<String> {
    if max_chars == 0 {
        return None;
    }
    let mut out = String::new();
    let mut truncated = false;
    let skipped_oversized = visit_transcript_rows(path, |value| {
        if let Some((role, text)) = cursor_turn(value) {
            push_turn(&mut out, role, &text);
            truncated |= trim_tail(&mut out, max_chars);
        }
    })?;
    finish_transcript(out, truncated || skipped_oversized)
}

const MAX_CURSOR_PROJECTS: usize = 4096;
const MAX_CURSOR_WORKSPACE_FILE_BYTES: u64 = 64 * 1024;

fn cursor_root() -> Option<PathBuf> {
    fs::canonicalize(home()?.join(".cursor").join("projects")).ok()
}

#[cfg(test)]
fn is_cursor_transcript(path: &Path) -> bool {
    let Some(id) = path
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_suffix(".jsonl"))
    else {
        return false;
    };
    let parent = path.parent();
    antigravity_conversation_id(id)
        && parent
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            == Some(id)
        && parent
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            == Some("agent-transcripts")
}

/// Resolves `<root>/<project>/agent-transcripts/<id>/<id>.jsonl` for one
/// exact conversation ID and keeps the canonical result inside the root.
fn cursor_transcript(root: &Path, id: &str) -> Option<PathBuf> {
    if !antigravity_conversation_id(id) {
        return None;
    }
    let root = fs::canonicalize(root).ok()?;
    for project in fs::read_dir(&root)
        .ok()?
        .flatten()
        .take(MAX_CURSOR_PROJECTS)
    {
        if !project.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let candidate = project
            .path()
            .join("agent-transcripts")
            .join(id)
            .join(format!("{id}.jsonl"));
        if let Some(path) = fs::canonicalize(candidate)
            .ok()
            .filter(|path| path.starts_with(&root) && path.is_file())
        {
            return Some(path);
        }
    }
    None
}

/// Cursor names a project folder after its workspace path: the drive letter
/// is lower-cased and every run of other non-alphanumeric characters,
/// including CJK text, becomes one hyphen.
fn cursor_slug(path: &str) -> String {
    let path = path.trim_start_matches(r"\\?\");
    let mut slug = String::new();
    for (index, character) in path.chars().enumerate() {
        if character.is_ascii_alphanumeric() {
            let drive = index == 0 && path[1..].starts_with(':');
            slug.push(if drive {
                character.to_ascii_lowercase()
            } else {
                character
            });
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    slug.trim_matches('-').to_string()
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = text.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Converts a local `file://` workspace URI from Cursor's workspace storage
/// to a filesystem path. Remote and WSL workspaces are skipped.
fn cursor_folder_path(uri: &str) -> Option<String> {
    let path = percent_decode(uri.strip_prefix("file:///")?)?;
    if path.contains('\0') {
        return None;
    }
    let bytes = path.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return Some(path.replace('/', "\\"));
    }
    Some(format!("/{path}"))
}

fn cursor_workspace_folders() -> HashMap<String, String> {
    let mut folders = HashMap::new();
    let Some(storage) =
        dirs::config_dir().map(|dir| dir.join("Cursor").join("User").join("workspaceStorage"))
    else {
        return folders;
    };
    let Ok(entries) = fs::read_dir(storage) else {
        return folders;
    };
    for entry in entries.flatten().take(MAX_CURSOR_PROJECTS) {
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let Some(file) = open_regular_transcript(&entry.path().join("workspace.json")) else {
            continue;
        };
        let mut raw = String::new();
        if file
            .take(MAX_CURSOR_WORKSPACE_FILE_BYTES + 1)
            .read_to_string(&mut raw)
            .is_err()
            || raw.len() as u64 > MAX_CURSOR_WORKSPACE_FILE_BYTES
        {
            continue;
        }
        let Some(path) = serde_json::from_str::<Value>(&raw)
            .ok()
            .and_then(|value| value.get("folder")?.as_str().and_then(cursor_folder_path))
        else {
            continue;
        };
        // Distinct paths can share a lossy slug; keep the first rather than
        // guessing, since the path is only shown beside read-only history.
        folders.entry(cursor_slug(&path)).or_insert(path);
    }
    folders
}

/// Lists Cursor agent transcripts that hold at least one typed message.
/// The transcript rows carry no workspace path, so it comes from the
/// editor's workspace storage when a folder maps to the project slug.
fn scan_cursor_conversations(
    root: &Path,
    folders: &HashMap<String, String>,
    result: &mut Vec<(LocalConversation, PathBuf)>,
    options: HistoryScanOptions,
    incomplete: &mut bool,
) -> Result<(), String> {
    let projects = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) => {
            if error.kind() != io::ErrorKind::NotFound {
                *incomplete = true;
            }
            return Ok(());
        }
    };
    let mut visited = 0usize;
    for project in projects {
        let Ok(project) = project else {
            *incomplete = true;
            continue;
        };
        if !project.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let slug = project.file_name().to_string_lossy().into_owned();
        let Ok(chats) = fs::read_dir(project.path().join("agent-transcripts")) else {
            continue;
        };
        for chat in chats {
            let Ok(chat) = chat else {
                *incomplete = true;
                continue;
            };
            visited += 1;
            if visited > HISTORY_MAX_ENTRIES {
                *incomplete = true;
                return if options.all {
                    Err(
                        "Local history exceeds the scan limit; no conversations were opened."
                            .into(),
                    )
                } else {
                    Ok(())
                };
            }
            if !chat.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            let id = chat.file_name().to_string_lossy().into_owned();
            if !antigravity_conversation_id(&id) {
                continue;
            }
            let path = chat.path().join(format!("{id}.jsonl"));
            if !fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_file())
                || cursor_first_user_text(&path).is_none()
            {
                continue;
            }
            let cwd = folders.get(&slug).cloned().unwrap_or_default();
            push_history_entry(
                TranscriptKind::Cursor,
                HistoryCandidate { path, id, cwd },
                None,
                &options,
                result,
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
fn locate_cursor_in(
    root: &Path,
    working_directory: &str,
    captured: Option<&str>,
) -> Option<PathBuf> {
    let root = fs::canonicalize(root).ok()?;
    if let Some(transcript) = captured.and_then(|id| cursor_transcript(&root, id)) {
        return Some(transcript);
    }
    let cwd = fs::canonicalize(working_directory).ok()?;
    let project = fs::canonicalize(
        root.join(cursor_slug(&cwd.to_string_lossy()))
            .join("agent-transcripts"),
    )
    .ok()
    .filter(|dir| dir.starts_with(&root))?;
    newest_matching_with_limits(&project, MAX_TRANSCRIPT_SEARCH_ENTRIES, 1, |path| {
        is_cursor_transcript(path) && cursor_first_user_text(path).is_some()
    })
}

/// Reads only the source session's exact conversation from its account history.
/// Returns role-labelled text capped at `max_chars` or a specific refusal code.
pub fn export(
    kind: TranscriptKind,
    working_directory: &str,
    captured_session_id: Option<&str>,
    profile_directory: Option<&Path>,
    max_chars: usize,
) -> Result<String, &'static str> {
    if profile_directory.is_some_and(|profile| !profile.is_absolute() || !profile.is_dir()) {
        return Err("handoff.accountUnavailable");
    }
    if profile_directory.is_some()
        && !matches!(kind, TranscriptKind::Codex | TranscriptKind::Claude)
    {
        return Err("handoff.accountUnavailable");
    }
    let session_id = captured_session_id
        .filter(|id| !id.trim().is_empty())
        .ok_or("handoff.waitingForIdentity")?;
    let root = history_root(kind, profile_directory)
        .or_else(|| history_root_with_archive(kind, profile_directory, true))
        .ok_or("handoff.waitingForTranscript")?;
    let path = match kind {
        TranscriptKind::Codex => locate_codex_in(&root, working_directory, Some(session_id))
            .or_else(|| {
                history_root_with_archive(kind, profile_directory, true).and_then(|archive| {
                    locate_codex_in(&archive, working_directory, Some(session_id))
                })
            }),
        TranscriptKind::Claude => locate_claude_in(&root, working_directory, Some(session_id)),
        TranscriptKind::Gemini => locate_gemini_in(&root, working_directory, Some(session_id)),
        TranscriptKind::Antigravity => antigravity_transcript(&root, session_id),
        TranscriptKind::Cursor => cursor_transcript(&root, session_id),
    }
    .ok_or("handoff.waitingForTranscript")?;
    let text = match kind {
        TranscriptKind::Codex => parse_codex(&path, max_chars),
        TranscriptKind::Claude => parse_claude(&path, max_chars),
        TranscriptKind::Gemini => parse_gemini(&path, max_chars),
        TranscriptKind::Antigravity => parse_antigravity(&path, max_chars),
        TranscriptKind::Cursor => parse_cursor(&path, max_chars),
    };
    text.ok_or("handoff.noReadableMessages")
}

#[cfg(test)]
mod tests {
    // Claude's fixture directory layout; production lookup verifies the
    // transcript metadata instead of trusting a project slug alone.
    fn claude_slug(working_directory: &str) -> String {
        working_directory
            .chars()
            .map(|ch| match ch {
                '/' | '\\' | ':' => '-',
                other => other,
            })
            .collect()
    }

    use super::*;

    #[test]
    fn handoff_files_are_private_named_and_swept_after_a_day() {
        let data = tempfile::tempdir().unwrap();
        let path =
            write_handoff_file(data.path(), "OpenAI Codex", "user: hi\nassistant: hello").unwrap();
        assert!(path.starts_with(fs::canonicalize(data.path().join("handoffs")).unwrap()));
        assert!(path
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("handoff-"));
        let body = fs::read_to_string(&path).unwrap();
        assert!(body.starts_with("# 交接自 OpenAI Codex\n"));
        assert!(body.contains("assistant: hello"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }

        // A day-old brief goes on the next write; a fresh one stays.
        set_modified(&path, 1);
        let second = write_handoff_file(data.path(), "x", "later").unwrap();
        assert!(!path.exists(), "expired brief was kept");
        assert!(second.exists());

        assert!(write_handoff_file(data.path(), "x", "   ").is_err());
        assert!(
            write_handoff_file(data.path(), "x", &"a".repeat(MAX_HANDOFF_FILE_BYTES + 1)).is_err()
        );
    }

    /// Times a real export against this machine's own histories. Ignored:
    /// it depends on what the user has on disk. `cargo test time_real_export -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn time_real_export() {
        let cwd = std::env::var("LATTICETERM_TIMING_CWD")
            .unwrap_or_else(|_| std::env::current_dir().unwrap().display().to_string());
        for (label, path) in [
            (
                "claude-big",
                std::env::var("LATTICETERM_TIMING_CLAUDE").ok(),
            ),
            ("codex-big", std::env::var("LATTICETERM_TIMING_CODEX").ok()),
        ] {
            if let Some(path) = path {
                let path = PathBuf::from(path);
                let started = std::time::Instant::now();
                let out = if label.starts_with("claude") {
                    parse_claude(&path, 64 * 1024)
                } else {
                    parse_codex(&path, 64 * 1024)
                };
                eprintln!(
                    "{label}: parse {:?} bytes={} chars={}",
                    started.elapsed(),
                    fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
                    out.map(|t| t.chars().count()).unwrap_or(0)
                );
            }
        }
        for kind in [TranscriptKind::Codex, TranscriptKind::Claude] {
            let started = std::time::Instant::now();
            let path = match kind {
                TranscriptKind::Codex => locate_codex(&cwd, None),
                TranscriptKind::Claude => locate_claude(&cwd, None),
                _ => None,
            };
            let located = started.elapsed();
            let parsed = path.as_ref().map(|path| {
                let started = std::time::Instant::now();
                let out = match kind {
                    TranscriptKind::Codex => parse_codex(path, 64 * 1024),
                    _ => parse_claude(path, 64 * 1024),
                };
                (
                    started.elapsed(),
                    out.map(|text| text.len()).unwrap_or(0),
                    fs::metadata(path).map(|m| m.len()).unwrap_or(0),
                )
            });
            eprintln!("{kind:?}: locate {located:?} path={path:?} parse={parsed:?}");
        }
    }

    fn set_modified(path: &Path, seconds: u64) {
        let times = fs::FileTimes::new()
            .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(seconds));
        fs::OpenOptions::new()
            .write(true)
            .open(path)
            .unwrap()
            .set_times(times)
            .unwrap();
    }

    pub(super) fn write_codex_rollout(
        path: &Path,
        id: &str,
        cwd: &Path,
        source: Value,
        originator: &str,
        modified: u64,
    ) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let rows = [
            serde_json::json!({
                "type": "session_meta",
                "payload": {
                    "id": id,
                    "cwd": cwd.to_string_lossy(),
                    "source": source,
                    "originator": originator,
                }
            })
            .to_string(),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": id}],
                }
            })
            .to_string(),
        ];
        fs::write(path, rows.join("\n")).unwrap();
        set_modified(path, modified);
    }

    #[test]
    fn latest_codex_thread_matches_project_provider_kind_and_skips_open_threads() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("sessions");
        let cwd = directory.path().join("workspace");
        let other = directory.path().join("other");
        fs::create_dir_all(&cwd).unwrap();
        fs::create_dir_all(&other).unwrap();
        let write_from =
            |name: &str, id: &str, cwd: &Path, provider: &str, source: Value, modified: u64| {
                let path = root.join(format!("2026/10/05/rollout-{name}.jsonl"));
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                let meta = serde_json::json!({
                    "type": "session_meta",
                    "payload": {
                        "id": id,
                        "cwd": cwd.to_string_lossy(),
                        "source": source,
                        "originator": "codex-tui",
                        "model_provider": provider,
                    }
                });
                fs::write(&path, format!("{meta}\n")).unwrap();
                set_modified(&path, modified);
            };
        let write = |name: &str, id: &str, cwd: &Path, provider: &str, modified: u64| {
            write_from(
                name,
                id,
                cwd,
                provider,
                Value::String("cli".into()),
                modified,
            )
        };
        write("native", "native-thread", &cwd, "openai", 10);
        write(
            "proxy-old",
            "proxy-old",
            &cwd,
            "latticeterm_cliproxyapi_v2_default_aa",
            20,
        );
        write(
            "proxy-new",
            "proxy-new",
            &cwd,
            "latticeterm_cliproxyapi_v2_default_bb",
            30,
        );
        write(
            "elsewhere",
            "elsewhere",
            &other,
            "latticeterm_cliproxyapi_v2_default_cc",
            40,
        );
        // A subagent's own record is never the conversation to resume.
        write_from(
            "guardian",
            "guardian",
            &cwd,
            "latticeterm_cliproxyapi_v2_default_dd",
            serde_json::json!({"subagent": {"other": "guardian"}}),
            50,
        );
        let cwd_path = cwd.clone();
        let cwd = cwd.to_str().unwrap();

        assert_eq!(
            latest_codex_thread_in(&root, cwd, true, &[]).as_deref(),
            Some("proxy-new")
        );
        // A conversation held on the chat page or in Codex Desktop counts too.
        write_from(
            "desktop",
            "desktop-thread",
            &cwd_path,
            "openai",
            Value::String("appServer".into()),
            60,
        );
        assert_eq!(
            latest_codex_thread_in(&root, cwd, false, &[]).as_deref(),
            Some("desktop-thread")
        );
        assert_eq!(
            latest_codex_thread_in(&root, cwd, true, &["proxy-new".to_string()]).as_deref(),
            Some("proxy-old")
        );
        assert_eq!(
            latest_codex_thread_in(&root, cwd, false, &["desktop-thread".to_string()]).as_deref(),
            Some("native-thread")
        );
    }

    #[test]
    fn archived_codex_history_is_readable_but_never_automatically_resumed() {
        ONLY_PROFILE_HISTORY.with(|flag| flag.set(true));
        let directory = tempfile::tempdir().unwrap();
        let profile = directory.path().join("account");
        let archived = profile.join("archived_sessions/rollout-archived.jsonl");
        write_codex_rollout(
            &archived,
            "archived",
            directory.path(),
            serde_json::json!("cli"),
            "codex_cli_rs",
            100,
        );
        let profiles = vec![HistoryProfile {
            definition_id: "codex".into(),
            profile_id: "account".into(),
            config_directory: profile.to_string_lossy().into_owned(),
        }];
        assert!(list_local_conversations(&profiles).unwrap().is_empty());
        let found = list_local_conversations_with_options(&profiles, false, true).unwrap();
        assert_eq!(found.len(), 1);
        assert!(found[0].archived);
        assert!(!found[0].resumable);
        let messages =
            read_local_conversation("codex", "archived", Some("account"), &profiles).unwrap();
        assert!(!messages.is_empty());
        assert!(archived.is_file());
        assert!(!profile.join("sessions").exists());
        assert!(read_local_conversation("codex", "archived", Some("other"), &profiles).is_err());
    }

    #[test]
    fn local_history_lists_app_server_and_claude_and_reads_only_text() {
        ONLY_PROFILE_HISTORY.with(|flag| flag.set(true));
        let directory = tempfile::tempdir().unwrap();
        let codex = directory.path().join("codex-account");
        let claude = directory.path().join("claude-account");
        let cwd = directory.path();
        let codex_file = codex.join("sessions/2026/01/01/rollout-desktop.jsonl");
        write_codex_rollout(
            &codex_file,
            "desktop",
            cwd,
            serde_json::json!("appServer"),
            "Codex Desktop",
            100,
        );
        let mut rows = fs::read_to_string(&codex_file).unwrap();
        rows.push('\n');
        rows.push_str(&serde_json::json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello"},{"type":"image","url":"private"}]}}).to_string());
        fs::write(&codex_file, rows).unwrap();
        let claude_file = claude.join("projects/project/claude.jsonl");
        write_claude_session(&claude_file, "claude", cwd, false, 90);
        write_codex_rollout(
            &codex.join("sessions/2026/01/01/rollout-moved.jsonl"),
            "moved",
            &directory.path().join("removed-project"),
            serde_json::json!("cli"),
            "codex_cli_rs",
            80,
        );
        let profiles = vec![
            HistoryProfile {
                definition_id: "codex".into(),
                profile_id: "codex-account".into(),
                config_directory: codex.to_string_lossy().into_owned(),
            },
            HistoryProfile {
                definition_id: "claude".into(),
                profile_id: "claude-account".into(),
                config_directory: claude.to_string_lossy().into_owned(),
            },
        ];
        let found = list_local_conversations(&profiles).unwrap();
        assert!(found
            .iter()
            .any(|item| item.native_session_id == "desktop" && item.title == "desktop"));
        assert!(found.iter().any(|item| item.native_session_id == "claude"));
        assert!(found
            .iter()
            .any(|item| item.native_session_id == "moved" && !item.resumable));
        let messages =
            read_local_conversation("codex", "desktop", Some("codex-account"), &profiles).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1].text, "Hello");
        assert!(
            read_local_conversation("codex", "desktop", Some("claude-account"), &profiles).is_err()
        );
    }

    #[test]
    fn session_conversation_uses_exact_account_and_skips_runtime_context() {
        let directory = tempfile::tempdir().unwrap();
        let account = directory.path().join("account");
        let path = account.join("sessions/rollout-exact.jsonl");
        write_codex_rollout(
            &path,
            "exact",
            directory.path(),
            serde_json::json!("cli"),
            "codex_cli_rs",
            10,
        );
        let metadata = fs::read_to_string(&path)
            .unwrap()
            .lines()
            .next()
            .unwrap()
            .to_string();
        let mut rows = vec![metadata];
        for text in [
            "# AGENTS.md instructions for /work\n<INSTRUCTIONS>rules</INSTRUCTIONS>",
            "<environment_context>machine</environment_context>",
            "<recommended_plugins>plugins</recommended_plugins>",
            "<environment_context>machine</environment_context>\n修正重開機遺失的工作區",
        ] {
            rows.push(
                serde_json::json!({"type":"response_item","payload":{
                    "type":"message","role":"user","content":[{"type":"input_text","text":text}]
                }})
                .to_string(),
            );
        }
        fs::write(&path, rows.join("\n")).unwrap();
        assert_eq!(
            history_preview(&path, TranscriptKind::Codex).as_deref(),
            Some("修正重開機遺失的工作區")
        );
        let messages =
            read_session_conversation("codex", "/work", Some("exact"), Some(&account)).unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].text, "修正重開機遺失的工作區");
        assert!(
            read_session_conversation("codex", "/work", Some("missing"), Some(&account)).is_err()
        );
        assert!(
            read_session_conversation("codex", "/work", None, Some(&account))
                .unwrap()
                .is_empty()
        );
        assert!(read_session_conversation(
            "codex",
            "/work",
            Some("exact"),
            Some(&directory.path().join("other-account"))
        )
        .is_err());
    }

    #[test]
    fn bulk_history_does_not_silently_stop_at_the_preview_limit() {
        ONLY_PROFILE_HISTORY.with(|flag| flag.set(true));
        let directory = tempfile::tempdir().unwrap();
        for index in 0..105 {
            let id = format!("session-{index}");
            write_codex_rollout(
                &directory
                    .path()
                    .join(format!("sessions/rollout-{id}.jsonl")),
                &id,
                directory.path(),
                serde_json::json!("cli"),
                "codex_cli_rs",
                index,
            );
        }
        let profiles = [HistoryProfile {
            definition_id: "codex".into(),
            profile_id: "account".into(),
            config_directory: directory.path().to_string_lossy().into_owned(),
        }];
        assert_eq!(list_local_conversations(&profiles).unwrap().len(), 100);
        assert_eq!(
            list_local_conversations_with_limit(&profiles, true)
                .unwrap()
                .len(),
            105
        );
        // Every listed identity remains readable, including those excluded
        // by the newest-100 preview, without falling back to another account.
        for index in 0..105 {
            assert!(read_local_conversation(
                "codex",
                &format!("session-{index}"),
                Some("account"),
                &profiles
            )
            .is_ok());
        }
        assert!(read_local_conversation("codex", "session-0", Some("removed"), &profiles).is_err());
    }

    #[test]
    fn handoff_requires_identity_and_never_guesses_another_project_conversation() {
        let home = tempfile::tempdir().unwrap();
        for kind in [TranscriptKind::Codex, TranscriptKind::Claude] {
            assert_eq!(
                export(kind, "", None, Some(home.path()), 5000),
                Err("handoff.waitingForIdentity")
            );
            assert_eq!(
                export(kind, "", Some(""), Some(home.path()), 5000),
                Err("handoff.waitingForIdentity")
            );
        }
        write_codex_rollout(
            &home.path().join("sessions/rollout-other.jsonl"),
            "other",
            home.path(),
            serde_json::json!("cli"),
            "codex_cli_rs",
            1,
        );
        assert_eq!(
            export(
                TranscriptKind::Codex,
                home.path().to_str().unwrap(),
                Some("missing"),
                Some(home.path()),
                5000
            ),
            Err("handoff.waitingForTranscript")
        );
    }

    #[test]
    fn handoff_reads_the_exact_archived_codex_thread_without_active_history() {
        let home = tempfile::tempdir().unwrap();
        write_codex_rollout(
            &home.path().join("archived_sessions/rollout-archived.jsonl"),
            "archived",
            home.path(),
            serde_json::json!("appServer"),
            "desktop",
            1,
        );
        assert!(export(
            TranscriptKind::Codex,
            "changed-workspace",
            Some("archived"),
            Some(home.path()),
            5000
        )
        .unwrap()
        .contains("archived"));
        fs::create_dir(home.path().join("sessions")).unwrap();
        assert!(export(
            TranscriptKind::Codex,
            "changed-workspace",
            Some("archived"),
            Some(home.path()),
            5000
        )
        .is_ok());
    }

    #[test]
    fn handoff_distinguishes_unwritten_records_from_records_without_messages() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(
            export(
                TranscriptKind::Codex,
                "",
                Some("empty"),
                Some(home.path()),
                5000
            ),
            Err("handoff.waitingForTranscript")
        );
        let path = home.path().join("sessions/rollout-empty.jsonl");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, serde_json::json!({"type":"session_meta","payload":{"id":"empty","source":"cli","cwd":home.path()}}).to_string()).unwrap();
        assert_eq!(
            export(
                TranscriptKind::Codex,
                "",
                Some("empty"),
                Some(home.path()),
                5000
            ),
            Err("handoff.noReadableMessages")
        );
    }

    #[test]
    fn handoff_rejects_unsupported_account_roots_for_other_clis() {
        let home = tempfile::tempdir().unwrap();
        for kind in [
            TranscriptKind::Gemini,
            TranscriptKind::Antigravity,
            TranscriptKind::Cursor,
        ] {
            assert_eq!(
                export(kind, "", Some("known"), Some(home.path()), 5000),
                Err("handoff.accountUnavailable")
            );
        }
        assert_eq!(
            export(
                TranscriptKind::Codex,
                "",
                Some("known"),
                Some(Path::new("relative")),
                5000
            ),
            Err("handoff.accountUnavailable")
        );
    }

    #[test]
    fn account_profile_exports_never_cross_into_another_accounts_history() {
        let directory = tempfile::tempdir().unwrap();
        let cwd = directory.path();
        let a = directory.path().join("account-a");
        let b = directory.path().join("account-b");
        for (root, id, modified) in [(&a, "session-a", 20), (&b, "session-b", 10)] {
            write_codex_rollout(
                &root.join("sessions").join(format!("rollout-{id}.jsonl")),
                id,
                cwd,
                serde_json::json!("cli"),
                "codex_cli_rs",
                modified,
            );
            write_claude_session(
                &root.join("projects").join(format!("{id}.jsonl")),
                id,
                cwd,
                false,
                modified,
            );
        }
        for kind in [TranscriptKind::Codex, TranscriptKind::Claude] {
            let text = export(
                kind,
                cwd.to_str().unwrap(),
                Some("session-b"),
                Some(&b),
                5000,
            )
            .unwrap();
            assert!(text.contains("session-b"));
            assert!(!text.contains("session-a"));
            assert!(export(
                kind,
                cwd.to_str().unwrap(),
                Some("session-a"),
                Some(&b),
                5000
            )
            .is_err());
            assert!(export(
                kind,
                cwd.to_str().unwrap(),
                None,
                Some(&directory.path().join("missing")),
                5000
            )
            .is_err());
        }
    }

    fn write_claude_session(path: &Path, id: &str, cwd: &Path, is_sidechain: bool, modified: u64) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let rows = [
            serde_json::json!({"type": "mode", "sessionId": id}).to_string(),
            serde_json::json!({"type": "permission-mode", "sessionId": id}).to_string(),
            serde_json::json!({
                "type": "user",
                "sessionId": id,
                "cwd": cwd.to_string_lossy(),
                "isSidechain": is_sidechain,
                "message": {"role": "user", "content": id},
            })
            .to_string(),
        ];
        fs::write(path, rows.join("\n")).unwrap();
        set_modified(path, modified);
    }

    #[cfg(unix)]
    #[test]
    fn handoff_does_not_write_through_cli_controlled_memory_directories() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let outside = directory.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("MEMORY.md"), "keep original").unwrap();
        let config = directory.path().join(".claude");
        fs::create_dir(&config).unwrap();
        symlink(&outside, config.join("projects")).unwrap();
        assert!(!import_handoff_into_memory(
            "claude",
            directory.path().to_str().unwrap(),
            "Codex",
            "new context"
        )
        .unwrap());
        let handoff = write_handoff_file(directory.path(), "Codex", "new context").unwrap();
        assert!(fs::read_to_string(handoff).unwrap().contains("new context"));
        assert_eq!(
            fs::read_to_string(outside.join("MEMORY.md")).unwrap(),
            "keep original"
        );
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 1);
    }

    #[test]
    fn content_text_reads_strings_and_text_blocks() {
        assert_eq!(content_text(&Value::String("hi".into())), "hi");
        let blocks = serde_json::json!([
            {"type": "text", "text": "keep me"},
            {"type": "tool_use", "name": "bash"},
            {"type": "output_text", "text": "and me"},
        ]);
        assert_eq!(content_text(&blocks), "keep me\nand me");
    }

    #[test]
    fn recursive_search_fails_closed_when_its_entry_budget_is_exhausted() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("first.jsonl"), b"one").unwrap();
        fs::write(directory.path().join("second.jsonl"), b"two").unwrap();

        assert_eq!(
            newest_matching_with_limits(directory.path(), 1, 1, |_| true),
            None
        );
    }

    #[test]
    fn tail_marks_a_truncation() {
        let mut short = "abcdef".to_string();
        assert!(!trim_tail(&mut short, 10));
        assert_eq!(short, "abcdef");

        let mut long = "abcdef".to_string();
        assert!(trim_tail(&mut long, 3));
        assert_eq!(long, "def");
        assert!(finish_transcript(long, true).unwrap().contains("略過"));
    }

    #[test]
    fn claude_transcript_extracts_user_and_assistant_turns() {
        let dir = tempfile::tempdir().unwrap();
        let slug = claude_slug(dir.path().to_str().unwrap());
        let projects = dir.path().join(".claude").join("projects").join(&slug);
        fs::create_dir_all(&projects).unwrap();
        let jsonl = [
            r#"{"type":"mode","sessionId":"s"}"#,
            r#"{"type":"user","message":{"role":"user","content":"重構 payments"}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"好的"},{"type":"tool_use","name":"bash"}]}}"#,
        ]
        .join("\n");
        fs::write(projects.join("abc.jsonl"), jsonl).unwrap();

        let text = parse_claude(&projects.join("abc.jsonl"), 5000).unwrap();
        assert!(text.contains("【使用者】"));
        assert!(text.contains("重構 payments"));
        assert!(text.contains("【助理】"));
        assert!(text.contains("好的"));
        assert!(!text.contains("bash"));
    }

    #[test]
    fn codex_transcript_reads_payload_messages_only() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("rollout-x.jsonl");
        let jsonl = [
            r#"{"type":"session_meta","payload":{"cwd":"/x"}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"問題一"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"答案一"}]}}"#,
            r#"{"type":"event_msg","payload":{"type":"reasoning"}}"#,
        ]
        .join("\n");
        fs::write(&file, jsonl).unwrap();

        let text = parse_codex(&file, 5000).unwrap();
        assert!(text.contains("問題一"));
        assert!(text.contains("答案一"));
        assert!(!text.contains("reasoning"));
    }

    #[test]
    fn gemini_transcript_exports_the_matching_project_session() {
        let directory = tempfile::tempdir().unwrap();
        let repository = directory.path().join("repository");
        let project = repository.join("packages").join("desktop");
        let gemini_root = directory.path().join(".gemini").join("tmp");
        let session = gemini_root
            .join("project-hash")
            .join("chats")
            .join("session-2026-09-01.jsonl");
        fs::create_dir_all(session.parent().unwrap()).unwrap();
        fs::create_dir_all(&project).unwrap();
        fs::write(repository.join(".git"), "gitdir: nowhere").unwrap();
        fs::write(
            session
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join(".project_root"),
            project.to_string_lossy().as_bytes(),
        )
        .unwrap();
        let rows = [
            serde_json::json!({"sessionId": "gemini-session", "projectHash": "project-hash"})
                .to_string(),
            serde_json::json!({
                "id": "outdated",
                "type": "user",
                "content": [{"text": "discard this old branch"}]
            })
            .to_string(),
            serde_json::json!({
                "$set": {
                    "messages": [
                        {"id": "context", "type": "user", "content": [{"text": "<session_context>ignore</session_context>"}]},
                        {"id": "user-1", "type": "user", "content": [{"text": "remember red panda"}]},
                        {"id": "model-1", "type": "gemini", "content": [{"text": "outdated answer"}]},
                        {"id": "tool-1", "type": "tool", "content": [{"text": "must not transfer"}]}
                    ]
                }
            })
            .to_string(),
            serde_json::json!({"$rewindTo": "model-1"}).to_string(),
            serde_json::json!({
                "id": "model-2",
                "type": "gemini",
                "content": [{"text": "I will remember it"}]
            })
            .to_string(),
        ];
        fs::write(&session, rows.join("\n")).unwrap();

        let located = locate_gemini_in(
            &gemini_root,
            &project.to_string_lossy(),
            Some("gemini-session"),
        )
        .unwrap();
        assert_eq!(located, fs::canonicalize(session).unwrap());

        let text = parse_gemini(&located, 5000).unwrap();
        assert!(text.contains("remember red panda"));
        assert!(text.contains("I will remember it"));
        assert!(!text.contains("discard this old branch"));
        assert!(!text.contains("outdated answer"));
        assert!(!text.contains("session_context"));
        assert!(!text.contains("must not transfer"));
    }

    #[test]
    fn antigravity_transcript_uses_only_user_prompts_and_final_answers() {
        let directory = tempfile::tempdir().unwrap();
        let conversation_id = "0199aa11-bb22-4c33-8d44-ee55ff667788";
        let transcript = directory
            .path()
            .join("brain")
            .join(conversation_id)
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl");
        fs::create_dir_all(transcript.parent().unwrap()).unwrap();
        let rows = [
            serde_json::json!({
                "step_index": 0,
                "source": "USER_EXPLICIT",
                "type": "USER_INPUT",
                "status": "DONE",
                "content": "remember the blue folder"
            }),
            serde_json::json!({
                "step_index": 1,
                "source": "MODEL",
                "type": "GENERIC",
                "status": "DONE",
                "content": "private tool planning"
            }),
            serde_json::json!({
                "step_index": 2,
                "source": "SYSTEM",
                "type": "SYSTEM_MESSAGE",
                "status": "DONE",
                "content": "tool output"
            }),
            serde_json::json!({
                "step_index": 3,
                "source": "MODEL",
                "type": "PLANNER_RESPONSE",
                "status": "RUNNING",
                "content": "unfinished answer"
            }),
            serde_json::json!({
                "step_index": 4,
                "source": "MODEL",
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "content": "I will remember the blue folder"
            }),
        ];
        fs::write(
            &transcript,
            rows.iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();

        let located = locate_antigravity_in(
            directory.path(),
            directory.path().to_str().unwrap(),
            Some(conversation_id),
        )
        .unwrap();
        assert_eq!(located, fs::canonicalize(&transcript).unwrap());
        let text = parse_antigravity(&located, 5000).unwrap();
        assert!(text.contains("remember the blue folder"));
        assert!(text.contains("I will remember the blue folder"));
        assert!(!text.contains("private tool planning"));
        assert!(!text.contains("tool output"));
        assert!(!text.contains("unfinished answer"));
        // A captured id that is not a conversation id is never joined into a
        // path; the lookup ignores it and falls back to the newest transcript.
        assert_eq!(
            locate_antigravity_in(
                directory.path(),
                directory.path().to_str().unwrap(),
                Some("../outside")
            )
            .unwrap(),
            fs::canonicalize(&transcript).unwrap()
        );
    }

    #[test]
    fn antigravity_locate_falls_back_to_history_jsonl_and_brain_directory() {
        let directory = tempfile::tempdir().unwrap();
        let project_dir = tempfile::tempdir().unwrap();
        let project_path = project_dir.path().to_str().unwrap();

        let conv1_id = "11111111-2222-3333-4444-555555555555";
        let conv2_id = "66666666-7777-8888-9999-000000000000";

        let log_dir1 = directory
            .path()
            .join("brain")
            .join(conv1_id)
            .join(".system_generated")
            .join("logs");
        fs::create_dir_all(&log_dir1).unwrap();
        let transcript1 = log_dir1.join("transcript.jsonl");
        fs::write(&transcript1, "{\"status\":\"DONE\",\"source\":\"USER_EXPLICIT\",\"type\":\"USER_INPUT\",\"content\":\"task 1\"}\n").unwrap();

        let log_dir2 = directory
            .path()
            .join("brain")
            .join(conv2_id)
            .join(".system_generated")
            .join("logs");
        fs::create_dir_all(&log_dir2).unwrap();
        let transcript2 = log_dir2.join("transcript.jsonl");
        fs::write(&transcript2, "{\"status\":\"DONE\",\"source\":\"USER_EXPLICIT\",\"type\":\"USER_INPUT\",\"content\":\"task 2\"}\n").unwrap();

        // 1. Without captured_session_id and without history.jsonl: falls back to brain newest.
        let located_brain = locate_antigravity_in(directory.path(), project_path, None).unwrap();
        assert!(
            located_brain == fs::canonicalize(&transcript1).unwrap()
                || located_brain == fs::canonicalize(&transcript2).unwrap()
        );

        // 2. With history.jsonl pointing project_path to conv2_id:
        let history_file = directory.path().join("history.jsonl");
        let history_lines = [
            serde_json::json!({
                "workspace": "D:\\unrelated\\path",
                "conversationId": conv1_id,
            }),
            serde_json::json!({
                "workspace": project_path,
                "conversationId": conv2_id,
            }),
        ];
        fs::write(
            &history_file,
            history_lines
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();

        let located_history = locate_antigravity_in(directory.path(), project_path, None).unwrap();
        assert_eq!(located_history, fs::canonicalize(&transcript2).unwrap());
    }

    fn cursor_row(role: &str, text: &str) -> String {
        serde_json::json!({
            "role": role,
            "message": { "content": [{ "type": "text", "text": text }] }
        })
        .to_string()
    }

    #[test]
    fn cursor_turn_keeps_typed_queries_and_drops_injected_context() {
        let query = serde_json::json!({
            "role": "user",
            "message": { "content": [{
                "type": "text",
                "text": "<attached_files>a.rs</attached_files>\n<user_query>\n修好登入\n</user_query>"
            }]}
        });
        assert_eq!(cursor_turn(&query), Some(("user", "修好登入".to_string())));
        let context = serde_json::json!({
            "role": "user",
            "message": { "content": [{ "type": "text", "text": "<git_status>\nclean\n</git_status>" }] }
        });
        assert_eq!(cursor_turn(&context), None);
        let plain = serde_json::json!({
            "role": "user",
            "message": { "content": "plain question" }
        });
        assert_eq!(
            cursor_turn(&plain),
            Some(("user", "plain question".to_string()))
        );
        let answer = serde_json::json!({
            "role": "assistant",
            "message": { "content": [
                { "type": "text", "text": "first" },
                { "type": "tool_use", "name": "Read" },
                { "type": "text", "text": "second" }
            ]}
        });
        assert_eq!(
            cursor_turn(&answer),
            Some(("assistant", "first\nsecond".to_string()))
        );
        assert_eq!(
            cursor_turn(&serde_json::json!({ "role": "system", "message": { "content": "x" } })),
            None
        );
    }

    #[test]
    fn cursor_slug_matches_cursor_project_folders() {
        assert_eq!(
            cursor_slug(r"D:\project\112-114桃園出流管制\regflow"),
            "d-project-112-114-regflow"
        );
        assert_eq!(
            cursor_slug(r"\\?\D:\project\NetZeroFastTrack"),
            "d-project-NetZeroFastTrack"
        );
        assert_eq!(cursor_slug("/home/me/my app"), "home-me-my-app");
        assert_eq!(
            cursor_folder_path("file:///d%3A/project/112-114%E6%A1%83%E5%9C%92/regflow").as_deref(),
            Some(r"d:\project\112-114桃園\regflow")
        );
        assert_eq!(
            cursor_folder_path("file:///home/me/app").as_deref(),
            Some("/home/me/app")
        );
        assert_eq!(cursor_folder_path("vscode-remote://wsl+Ubuntu/home"), None);
        assert_eq!(cursor_folder_path("file:///d%3/bad"), None);
    }

    #[test]
    fn cursor_transcripts_are_listed_read_only_and_resolved_exactly() {
        let root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace_path = fs::canonicalize(workspace.path()).unwrap();
        let slug = cursor_slug(&workspace_path.to_string_lossy());
        let id = "0199aa11-bb22-4c33-8d44-ee55ff667788";
        let chat = root.path().join(&slug).join("agent-transcripts").join(id);
        fs::create_dir_all(&chat).unwrap();
        let transcript = chat.join(format!("{id}.jsonl"));
        fs::write(
            &transcript,
            [
                cursor_row("user", "<agent_skills>skills</agent_skills>"),
                cursor_row("user", "<user_query>看一下 README</user_query>"),
                cursor_row("assistant", "README 已更新"),
            ]
            .join("\n"),
        )
        .unwrap();
        let context_id = "11111111-2222-3333-4444-555555555555";
        let context_chat = root
            .path()
            .join(&slug)
            .join("agent-transcripts")
            .join(context_id);
        fs::create_dir_all(&context_chat).unwrap();
        fs::write(
            context_chat.join(format!("{context_id}.jsonl")),
            cursor_row("user", "<git_status>clean</git_status>"),
        )
        .unwrap();
        let mismatched = root
            .path()
            .join(&slug)
            .join("agent-transcripts")
            .join("22222222-3333-4444-5555-666666666666");
        fs::create_dir_all(&mismatched).unwrap();
        fs::write(
            mismatched.join(format!("{id}.jsonl")),
            cursor_row("user", "wrong folder"),
        )
        .unwrap();

        let folders =
            HashMap::from([(slug.clone(), workspace_path.to_string_lossy().into_owned())]);
        let mut entries = Vec::new();
        let mut incomplete = false;
        scan_cursor_conversations(
            root.path(),
            &folders,
            &mut entries,
            HistoryScanOptions {
                all: true,
                archived: false,
                retained: 10,
            },
            &mut incomplete,
        )
        .unwrap();
        assert!(!incomplete);
        assert_eq!(entries.len(), 1);
        let (entry, path) = &entries[0];
        assert_eq!(entry.definition_id, "cursor");
        assert_eq!(entry.native_session_id, id);
        assert!(!entry.resumable);
        assert_eq!(entry.working_directory, workspace_path.to_string_lossy());
        assert_eq!(
            history_preview(path, TranscriptKind::Cursor).as_deref(),
            Some("看一下 README")
        );

        let canonical = fs::canonicalize(&transcript).unwrap();
        assert_eq!(cursor_transcript(root.path(), id), Some(canonical.clone()));
        assert_eq!(cursor_transcript(root.path(), "../outside"), None);
        assert_eq!(
            cursor_transcript(root.path(), "22222222-3333-4444-5555-666666666666"),
            None
        );
        assert_eq!(
            locate_cursor_in(root.path(), workspace_path.to_str().unwrap(), None),
            Some(canonical.clone())
        );
        let text = parse_cursor(&canonical, 5000).unwrap();
        assert!(text.contains("【使用者】\n看一下 README"));
        assert!(text.contains("【助理】\nREADME 已更新"));
        assert!(!text.contains("skills"));
    }

    #[test]
    fn codex_transcript_skips_oversized_rows_and_empty_large_files() {
        let directory = tempfile::tempdir().unwrap();
        let transcript = directory.path().join("rollout-streamed.jsonl");
        let valid = serde_json::json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "仍能讀到後續訊息"}],
            }
        })
        .to_string();
        let mut rows = Vec::with_capacity(MAX_TRANSCRIPT_LINE_BYTES + valid.len() + 2);
        rows.extend(std::iter::repeat_n(b'x', MAX_TRANSCRIPT_LINE_BYTES + 1));
        rows.push(b'\n');
        rows.extend_from_slice(valid.as_bytes());
        fs::write(&transcript, rows).unwrap();

        let text = parse_codex(&transcript, 5_000).unwrap();
        assert!(text.contains("仍能讀到後續訊息"));
        assert!(text.contains("略過"));

        let too_large = directory.path().join("rollout-too-large.jsonl");
        let file = fs::File::create(&too_large).unwrap();
        file.set_len(MAX_TRANSCRIPT_FILE_BYTES + 1).unwrap();
        assert_eq!(parse_codex(&too_large, 5_000), None);
    }

    #[test]
    fn handoff_reads_the_recent_tail_of_large_codex_and_claude_records() {
        use std::io::{Seek, SeekFrom};

        let home = tempfile::tempdir().unwrap();
        let records = [
            (
                TranscriptKind::Codex,
                home.path().join("sessions/rollout-large.jsonl"),
                serde_json::json!({"type":"session_meta","payload":{"id":"large","source":"cli","cwd":home.path()}}),
                serde_json::json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"最近的 Codex 回覆"}]}}),
                "最近的 Codex 回覆",
            ),
            (
                TranscriptKind::Claude,
                home.path().join("projects/project/large.jsonl"),
                serde_json::json!({"type":"user","sessionId":"large","cwd":home.path(),"isSidechain":false,"message":{"role":"user","content":"早期的 Claude 訊息"}}),
                serde_json::json!({"type":"assistant","sessionId":"large","cwd":home.path(),"isSidechain":false,"message":{"role":"assistant","content":"最近的 Claude 回覆"}}),
                "最近的 Claude 回覆",
            ),
        ];
        for (kind, path, metadata, latest, expected) in records {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let mut file = fs::File::create(&path).unwrap();
            writeln!(file, "{metadata}").unwrap();
            file.set_len(MAX_TRANSCRIPT_FILE_BYTES + 1).unwrap();
            file.seek(SeekFrom::End(0)).unwrap();
            writeln!(file, "\n{latest}").unwrap();
            drop(file);

            let text = export(kind, "", Some("large"), Some(home.path()), 5000).unwrap();
            assert!(text.contains(expected));
            assert!(text.contains("更早的對話已略過"));
            assert!(!text.contains("早期的 Claude 訊息"));
            let definition_id = match kind {
                TranscriptKind::Codex => "codex",
                TranscriptKind::Claude => "claude",
                _ => unreachable!(),
            };
            let snapshot = read_session_conversation_snapshot(
                definition_id,
                "",
                Some("large"),
                Some(home.path()),
            )
            .unwrap();
            assert!(matches!(
                snapshot.availability,
                SessionConversationAvailability::Ready
            ));
            assert!(snapshot.truncated);
            assert!(snapshot
                .messages
                .iter()
                .any(|message| message.text == expected));
            assert_eq!(
                export(kind, "", Some("missing"), Some(home.path()), 5000),
                Err("handoff.waitingForTranscript")
            );
        }
    }

    #[test]
    fn large_transcript_tail_preserves_rows_at_the_byte_boundary() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("rollout-boundary.jsonl");
        let bytes = MAX_TRANSCRIPT_FILE_BYTES + 1024;
        let offset = bytes - MAX_TRANSCRIPT_TAIL_BYTES;
        let mut file = fs::File::create(&path).unwrap();
        file.set_len(bytes).unwrap();
        file.seek(SeekFrom::Start(offset - 1)).unwrap();
        writeln!(file).unwrap();
        writeln!(file, "{}", serde_json::json!({"boundary":"完整的中文訊息"})).unwrap();
        drop(file);

        let mut rows = Vec::new();
        assert_eq!(
            visit_transcript_rows(&path, |row| rows.push(row.clone())),
            Some(true)
        );
        assert_eq!(rows, vec![serde_json::json!({"boundary":"完整的中文訊息"})]);
    }

    #[test]
    fn large_transcript_tail_does_not_parse_a_fragment_as_a_new_row() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("rollout-fragment.jsonl");
        let bytes = MAX_TRANSCRIPT_FILE_BYTES + 1024;
        let offset = bytes - MAX_TRANSCRIPT_TAIL_BYTES;
        let mut file = fs::File::create(&path).unwrap();
        file.set_len(bytes).unwrap();
        file.seek(SeekFrom::Start(offset - 1)).unwrap();
        write!(file, "x").unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({"fragment":"不能當成完整訊息"})
        )
        .unwrap();
        writeln!(file, "{}", serde_json::json!({"complete":"最新訊息"})).unwrap();
        drop(file);

        let mut rows = Vec::new();
        assert_eq!(
            visit_transcript_rows(&path, |row| rows.push(row.clone())),
            Some(true)
        );
        assert_eq!(rows, vec![serde_json::json!({"complete":"最新訊息"})]);
    }

    #[test]
    fn codex_fallback_stays_in_the_same_cwd_and_ignores_subagents() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("sessions");
        let target_cwd = directory.path().join("target");
        let other_cwd = directory.path().join("other");
        fs::create_dir_all(&target_cwd).unwrap();
        fs::create_dir_all(&other_cwd).unwrap();

        let target = root.join("2026/08/30/rollout-target.jsonl");
        write_codex_rollout(
            &target,
            "target-main",
            &target_cwd,
            Value::String("cli".to_string()),
            "codex-tui",
            10,
        );
        write_codex_rollout(
            &root.join("2026/08/30/rollout-other.jsonl"),
            "other-main",
            &other_cwd,
            Value::String("cli".to_string()),
            "codex-tui",
            20,
        );
        write_codex_rollout(
            &root.join("2026/08/30/rollout-subagent.jsonl"),
            "target-subagent",
            &target_cwd,
            serde_json::json!({"subagent": "review"}),
            "codex-tui",
            30,
        );

        assert_eq!(
            locate_codex_in(&root, target_cwd.to_str().unwrap(), None),
            Some(fs::canonicalize(target).unwrap())
        );
    }

    #[test]
    fn codex_captured_id_is_exact_and_survives_a_moved_working_directory() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("sessions");
        let old_cwd = directory.path().join("old-location");
        let current_cwd = directory.path().join("current-location");
        fs::create_dir_all(&current_cwd).unwrap();
        let rollout = root.join("2026/08/30/rollout-session-42.jsonl");
        write_codex_rollout(
            &rollout,
            "session-42",
            &old_cwd,
            Value::String("exec".to_string()),
            "codex_exec",
            10,
        );
        write_codex_rollout(
            &root.join("2026/08/30/rollout-unrelated-fallback.jsonl"),
            "newer-session",
            &current_cwd,
            Value::String("cli".to_string()),
            "codex-tui",
            20,
        );

        assert_eq!(
            locate_codex_in(&root, current_cwd.to_str().unwrap(), Some("session-42"),),
            Some(fs::canonicalize(rollout).unwrap())
        );
        assert_eq!(
            locate_codex_in(&root, current_cwd.to_str().unwrap(), Some("session"),),
            None
        );
        assert_eq!(
            locate_codex_in(
                &root,
                current_cwd.to_str().unwrap(),
                Some("../../session-42"),
            ),
            None
        );
    }

    #[test]
    fn codex_captured_id_rejects_subagent_metadata() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("sessions");
        let cwd = directory.path().join("workspace");
        fs::create_dir_all(&cwd).unwrap();
        write_codex_rollout(
            &root.join("2026/08/30/rollout-subagent.jsonl"),
            "subagent-session",
            &cwd,
            serde_json::json!({"subagent": "review"}),
            "codex-tui",
            10,
        );

        assert_eq!(
            locate_codex_in(&root, cwd.to_str().unwrap(), Some("subagent-session")),
            None
        );
    }

    #[test]
    fn codex_fallback_accepts_the_legacy_main_cli_source() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("sessions");
        let cwd = directory.path().join("workspace");
        fs::create_dir_all(&cwd).unwrap();
        let legacy = root.join("2025/01/01/rollout-legacy.jsonl");
        write_codex_rollout(
            &legacy,
            "legacy-main",
            &cwd,
            Value::String("unknown".to_string()),
            "codex_cli_rs",
            10,
        );

        assert_eq!(
            locate_codex_in(&root, cwd.to_str().unwrap(), None),
            Some(fs::canonicalize(legacy).unwrap())
        );

        let future_cli = root.join("2026/08/30/rollout-future-cli.jsonl");
        write_codex_rollout(
            &future_cli,
            "future-main",
            &cwd,
            Value::String("cli".to_string()),
            "future-codex-tui",
            20,
        );
        assert_eq!(
            locate_codex_in(&root, cwd.to_str().unwrap(), None),
            Some(fs::canonicalize(future_cli).unwrap())
        );
    }

    #[test]
    fn codex_locator_rejects_oversized_or_malformed_metadata() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("sessions");
        let cwd = directory.path().join("workspace");
        fs::create_dir_all(root.join("2026/08/30")).unwrap();
        fs::create_dir_all(&cwd).unwrap();
        fs::write(
            root.join("2026/08/30/rollout-oversized.jsonl"),
            vec![b'x'; MAX_CODEX_SESSION_META_BYTES + 1],
        )
        .unwrap();
        fs::write(
            root.join("2026/08/30/rollout-malformed.jsonl"),
            b"not-json\n",
        )
        .unwrap();

        assert_eq!(locate_codex_in(&root, cwd.to_str().unwrap(), None), None);
    }

    #[cfg(unix)]
    #[test]
    fn codex_locator_does_not_follow_nested_symlinks() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("sessions");
        let outside = directory.path().join("outside");
        let cwd = directory.path().join("workspace");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::create_dir_all(&cwd).unwrap();
        let escaped = outside.join("rollout-escaped.jsonl");
        write_codex_rollout(
            &escaped,
            "escaped",
            &cwd,
            Value::String("cli".to_string()),
            "codex-tui",
            10,
        );
        std::os::unix::fs::symlink(&outside, root.join("linked-outside")).unwrap();
        std::os::unix::fs::symlink(&escaped, root.join("rollout-linked-file.jsonl")).unwrap();

        assert_eq!(locate_codex_in(&root, cwd.to_str().unwrap(), None), None);
        assert_eq!(
            parse_codex(&root.join("rollout-linked-file.jsonl"), 5_000),
            None
        );
    }

    #[test]
    fn claude_captured_id_cannot_escape_its_project_directory() {
        let directory = tempfile::tempdir().unwrap();
        let projects_root = directory.path().join(".claude/projects");
        let working_directory = directory.path().join("workspace");
        let project = projects_root.join(claude_slug(working_directory.to_str().unwrap()));
        fs::create_dir_all(&project).unwrap();
        fs::write(directory.path().join(".claude/escape.jsonl"), b"outside").unwrap();

        assert_eq!(
            locate_claude_in(
                &projects_root,
                working_directory.to_str().unwrap(),
                Some("../../escape"),
            ),
            None
        );

        let valid = project.join("session-42.jsonl");
        write_claude_session(&valid, "session-42", &working_directory, false, 10);
        assert_eq!(
            locate_claude_in(
                &projects_root,
                working_directory.to_str().unwrap(),
                Some("session-42"),
            ),
            Some(fs::canonicalize(valid).unwrap())
        );
    }

    #[test]
    fn claude_fallback_uses_metadata_to_disambiguate_slug_collisions() {
        let directory = tempfile::tempdir().unwrap();
        let projects_root = directory.path().join(".claude/projects");
        let target_cwd = directory.path().join("a-b/c");
        let other_cwd = directory.path().join("a/b-c");
        fs::create_dir_all(&target_cwd).unwrap();
        fs::create_dir_all(&other_cwd).unwrap();
        assert_eq!(
            claude_slug(target_cwd.to_str().unwrap()),
            claude_slug(other_cwd.to_str().unwrap())
        );
        let project = projects_root.join(claude_slug(target_cwd.to_str().unwrap()));
        let target = project.join("target.jsonl");
        write_claude_session(&target, "target", &target_cwd, false, 10);
        write_claude_session(&project.join("other.jsonl"), "other", &other_cwd, false, 20);

        assert_eq!(
            locate_claude_in(&projects_root, target_cwd.to_str().unwrap(), None),
            Some(fs::canonicalize(target).unwrap())
        );
    }

    #[test]
    fn claude_captured_id_survives_a_moved_cwd_but_rejects_sidechains() {
        let directory = tempfile::tempdir().unwrap();
        let projects_root = directory.path().join(".claude/projects");
        let old_cwd = directory.path().join("old-location");
        let current_cwd = directory.path().join("current-location");
        fs::create_dir_all(&old_cwd).unwrap();
        fs::create_dir_all(&current_cwd).unwrap();
        let old_project = projects_root.join(claude_slug(old_cwd.to_str().unwrap()));
        let main = old_project.join("main-session.jsonl");
        write_claude_session(&main, "main-session", &old_cwd, false, 10);
        write_claude_session(
            &old_project.join("sidechain-session.jsonl"),
            "sidechain-session",
            &old_cwd,
            true,
            20,
        );
        write_claude_session(
            &projects_root
                .join(claude_slug(current_cwd.to_str().unwrap()))
                .join("newer-session.jsonl"),
            "newer-session",
            &current_cwd,
            false,
            30,
        );

        assert_eq!(
            locate_claude_in(
                &projects_root,
                current_cwd.to_str().unwrap(),
                Some("main-session"),
            ),
            Some(fs::canonicalize(main).unwrap())
        );
        assert_eq!(
            locate_claude_in(
                &projects_root,
                current_cwd.to_str().unwrap(),
                Some("sidechain-session"),
            ),
            None
        );

        let ambiguous = old_project.join("ambiguous-session.jsonl");
        fs::write(
            &ambiguous,
            [
                serde_json::json!({"type": "mode", "sessionId": "ambiguous-session"}).to_string(),
                serde_json::json!({
                    "type": "user",
                    "sessionId": "ambiguous-session",
                    "cwd": old_cwd.to_string_lossy(),
                    "message": {"role": "user", "content": "ambiguous"},
                })
                .to_string(),
            ]
            .join("\n"),
        )
        .unwrap();
        assert_eq!(
            locate_claude_in(
                &projects_root,
                current_cwd.to_str().unwrap(),
                Some("ambiguous-session"),
            ),
            None
        );
    }

    #[test]
    fn claude_handoff_accepts_large_attachments_before_or_after_main_metadata() {
        for attachment_first in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let profile = directory.path().join("profile");
            let cwd = directory.path().join("workspace");
            let project = profile.join("projects/project");
            fs::create_dir_all(&project).unwrap();
            fs::create_dir_all(&cwd).unwrap();
            let path = project.join("main-session.jsonl");
            let user = serde_json::json!({
                "type": "user", "sessionId": "main-session",
                "cwd": cwd.to_string_lossy(), "isSidechain": false,
                "message": {"role": "user", "content": "keep this context"},
            });
            let attachment = serde_json::json!({
                "type": "attachment", "sessionId": "main-session",
                "attachment": {"content": "x".repeat(MAX_CODEX_SESSION_META_BYTES + 4096)},
            });
            let rows = if attachment_first {
                [attachment, user]
            } else {
                [user, attachment]
            };
            fs::write(&path, rows.map(|row| row.to_string()).join("\n")).unwrap();
            let transcript = export(
                TranscriptKind::Claude,
                cwd.to_str().unwrap(),
                Some("main-session"),
                Some(&profile),
                60_000,
            )
            .expect("large attachments must not hide the main conversation");
            assert!(transcript.contains("keep this context"));
            assert!(!transcript.contains(&"x".repeat(4096)));
        }
    }

    #[test]
    fn claude_metadata_rejects_a_line_exceeding_its_own_budget() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("oversized.jsonl");
        fs::write(
            &path,
            "x".repeat(MAX_CLAUDE_SESSION_META_BYTES as usize + 1),
        )
        .unwrap();
        assert!(read_claude_session_meta(&path).is_none());
    }

    #[test]
    fn claude_metadata_checks_identity_and_sidechains_on_large_attachments() {
        for (attachment_id, is_sidechain) in [("different-session", false), ("main-session", true)]
        {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("main-session.jsonl");
            write_claude_session(&path, "main-session", directory.path(), false, 10);
            let attachment = serde_json::json!({
                "type": "attachment", "sessionId": attachment_id,
                "isSidechain": is_sidechain,
                "attachment": {"content": "x".repeat(MAX_CODEX_SESSION_META_BYTES + 4096)},
            });
            let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
            writeln!(file, "\n{attachment}").unwrap();
            assert!(read_claude_session_meta(&path).is_none_or(|meta| !meta.is_main));
        }
    }

    #[test]
    fn claude_metadata_requires_consistent_ids_and_an_explicit_main_row() {
        let directory = tempfile::tempdir().unwrap();
        let projects_root = directory.path().join(".claude/projects");
        let cwd = directory.path().join("workspace");
        fs::create_dir_all(&cwd).unwrap();
        let project = projects_root.join("project");
        fs::create_dir_all(&project).unwrap();

        let verified = project.join("verified.jsonl");
        fs::write(
            &verified,
            [
                serde_json::json!({"type": "mode", "sessionId": "verified"}).to_string(),
                serde_json::json!({
                    "type": "user",
                    "sessionId": "verified",
                    "cwd": cwd.to_string_lossy(),
                    "message": {"role": "user", "content": "ambiguous prefix"},
                })
                .to_string(),
                serde_json::json!({
                    "type": "assistant",
                    "sessionId": "verified",
                    "cwd": cwd.to_string_lossy(),
                    "isSidechain": false,
                    "message": {"role": "assistant", "content": "verified row"},
                })
                .to_string(),
            ]
            .join("\n"),
        )
        .unwrap();
        assert_eq!(
            locate_claude_in(&projects_root, cwd.to_str().unwrap(), Some("verified")),
            Some(fs::canonicalize(verified).unwrap())
        );

        let conflicting = project.join("conflicting.jsonl");
        fs::write(
            &conflicting,
            [
                serde_json::json!({"type": "mode", "sessionId": "expected"}).to_string(),
                serde_json::json!({
                    "type": "user",
                    "sessionId": "different",
                    "cwd": cwd.to_string_lossy(),
                    "isSidechain": false,
                    "message": {"role": "user", "content": "wrong session"},
                })
                .to_string(),
            ]
            .join("\n"),
        )
        .unwrap();
        assert_eq!(
            locate_claude_in(&projects_root, cwd.to_str().unwrap(), Some("expected")),
            None
        );
        assert_eq!(
            locate_claude_in(&projects_root, cwd.to_str().unwrap(), Some("different")),
            None
        );
    }
}

/// Cumulative token usage a CLI recorded in its own transcript. Only read
/// for a session whose id was captured, so it never counts another
/// conversation that shares the folder.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TranscriptUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub reasoning_tokens: u64,
    pub api_calls: u64,
}

fn u64_at(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

/// Claude writes one row per content block of a reply, each repeating that
/// reply's usage; the message id keeps each reply counted once.
fn claude_usage(path: &Path) -> Option<TranscriptUsage> {
    let mut replies: std::collections::HashMap<String, TranscriptUsage> = Default::default();
    visit_transcript_rows(path, |row| {
        if row.get("type").and_then(Value::as_str) != Some("assistant") {
            return;
        }
        let Some(message) = row.get("message") else {
            return;
        };
        let (Some(id), Some(usage)) = (
            message.get("id").and_then(Value::as_str),
            message.get("usage"),
        ) else {
            return;
        };
        replies.insert(
            id.to_string(),
            TranscriptUsage {
                input_tokens: u64_at(usage, "input_tokens"),
                output_tokens: u64_at(usage, "output_tokens"),
                cache_read_tokens: u64_at(usage, "cache_read_input_tokens"),
                cache_write_tokens: u64_at(usage, "cache_creation_input_tokens"),
                reasoning_tokens: usage
                    .get("output_tokens_details")
                    .map(|details| u64_at(details, "thinking_tokens"))
                    .unwrap_or(0),
                api_calls: 1,
            },
        );
    })?;
    if replies.is_empty() {
        return None;
    }
    Some(
        replies
            .values()
            .fold(TranscriptUsage::default(), |sum, reply| TranscriptUsage {
                input_tokens: sum.input_tokens.saturating_add(reply.input_tokens),
                output_tokens: sum.output_tokens.saturating_add(reply.output_tokens),
                cache_read_tokens: sum
                    .cache_read_tokens
                    .saturating_add(reply.cache_read_tokens),
                cache_write_tokens: sum
                    .cache_write_tokens
                    .saturating_add(reply.cache_write_tokens),
                reasoning_tokens: sum.reasoning_tokens.saturating_add(reply.reasoning_tokens),
                api_calls: sum.api_calls.saturating_add(1),
            }),
    )
}

/// Codex keeps a running total in its `token_count` events; the last one is
/// the session so far. Its input count includes the cached part.
fn codex_usage(path: &Path) -> Option<TranscriptUsage> {
    let mut last = None;
    let mut calls = 0u64;
    visit_transcript_rows(path, |row| {
        let payload = row.get("payload").unwrap_or(row);
        if payload.get("type").and_then(Value::as_str) != Some("token_count") {
            return;
        }
        let Some(total) = payload
            .get("info")
            .and_then(|info| info.get("total_token_usage"))
        else {
            return;
        };
        calls = calls.saturating_add(1);
        let input = u64_at(total, "input_tokens");
        let cached = u64_at(total, "cached_input_tokens");
        last = Some(TranscriptUsage {
            input_tokens: input.saturating_sub(cached),
            output_tokens: u64_at(total, "output_tokens"),
            cache_read_tokens: cached,
            cache_write_tokens: u64_at(total, "cache_write_input_tokens"),
            reasoning_tokens: u64_at(total, "reasoning_output_tokens"),
            api_calls: calls,
        });
    })?;
    last
}

pub fn session_usage(
    kind: TranscriptKind,
    working_directory: &str,
    captured_session_id: &str,
) -> Option<TranscriptUsage> {
    if captured_session_id.is_empty() {
        return None;
    }
    match kind {
        TranscriptKind::Claude => claude_usage(&locate_claude(
            working_directory,
            Some(captured_session_id),
        )?),
        TranscriptKind::Codex => {
            codex_usage(&locate_codex(working_directory, Some(captured_session_id))?)
        }
        TranscriptKind::Gemini | TranscriptKind::Antigravity | TranscriptKind::Cursor => None,
    }
}

#[cfg(test)]
mod usage_tests {
    use super::*;

    /// Reads a real transcript: `LATTICETERM_USAGE_DIR=<cwd>
    /// LATTICETERM_USAGE_SESSION=<id> cargo test --lib real_claude_usage -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_claude_usage() {
        let directory = std::env::var("LATTICETERM_USAGE_DIR").unwrap();
        let session = std::env::var("LATTICETERM_USAGE_SESSION").unwrap();
        let usage = session_usage(TranscriptKind::Claude, &directory, &session).expect("usage");
        println!("{usage:?}");
        assert!(usage.api_calls > 0 && usage.output_tokens > 0);
    }

    /// Lists what this machine's own history yields per CLI; depends on local
    /// data. `cargo test --lib real_history_counts -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_history_counts() {
        let entries = list_local_conversations_with_options(&[], true, false).unwrap();
        let mut counts = std::collections::BTreeMap::new();
        for entry in &entries {
            let count: &mut (usize, usize) = counts.entry(entry.definition_id.clone()).or_default();
            count.0 += 1;
            count.1 += usize::from(entry.resumable);
        }
        println!("definition -> (listed, resumable): {counts:?}");
        let cursor_with_cwd = entries
            .iter()
            .filter(|entry| entry.definition_id == "cursor" && !entry.working_directory.is_empty())
            .count();
        println!("cursor entries with a mapped workspace: {cursor_with_cwd}");
        for entry in entries
            .iter()
            .filter(|entry| entry.definition_id == "cursor")
            .take(3)
        {
            let messages =
                read_local_conversation(&entry.definition_id, &entry.native_session_id, None, &[])
                    .unwrap();
            println!(
                "cursor {} messages={} titled={}",
                entry.native_session_id,
                messages.len(),
                !entry.title.is_empty()
            );
        }
    }

    #[test]
    fn claude_counts_each_reply_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let reply = |id: &str, input: u64| {
            serde_json::json!({"type": "assistant", "message": {"id": id, "usage": {
                "input_tokens": input, "output_tokens": 10, "cache_read_input_tokens": 100,
                "cache_creation_input_tokens": 50, "output_tokens_details": {"thinking_tokens": 4}}}})
            .to_string()
        };
        let rows = [
            serde_json::json!({"type": "user", "message": {"content": "hi"}}).to_string(),
            reply("a", 2),
            reply("a", 2),
            reply("b", 3),
        ];
        std::fs::write(&path, rows.join("\n")).unwrap();
        assert_eq!(
            claude_usage(&path),
            Some(TranscriptUsage {
                input_tokens: 5,
                output_tokens: 20,
                cache_read_tokens: 200,
                cache_write_tokens: 100,
                reasoning_tokens: 8,
                api_calls: 2,
            })
        );
    }

    #[test]
    fn codex_takes_the_last_running_total_and_splits_cached_input() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout.jsonl");
        let count = |input: u64, cached: u64| {
            serde_json::json!({"type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": {
                "input_tokens": input, "cached_input_tokens": cached, "output_tokens": 7,
                "reasoning_output_tokens": 3, "total_tokens": input + 7}}}})
            .to_string()
        };
        let rows = [
            count(100, 40),
            serde_json::json!({"type": "event_msg", "payload": {"type": "token_count", "info": null}}).to_string(),
            count(300, 200),
        ];
        std::fs::write(&path, rows.join("\n")).unwrap();
        let usage = codex_usage(&path).unwrap();
        assert_eq!(usage.input_tokens, 100);
        assert_eq!(usage.cache_read_tokens, 200);
        assert_eq!(usage.reasoning_tokens, 3);
        assert_eq!(usage.api_calls, 2);
        assert_eq!(session_usage(TranscriptKind::Codex, "/work", ""), None);
    }
}
