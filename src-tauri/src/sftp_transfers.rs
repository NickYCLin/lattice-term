//! Large SFTP transfers: a queue that streams, not a payload that fits.
//!
//! The editor-style read/write commands in `sftp` cap files at 32 MiB because
//! their whole payload crosses IPC in one message. Transfers here have no such
//! cap: a download streams from the remote file straight to local disk, and an
//! upload arrives in bounded chunks that are written out as they come. At no
//! point does a whole file sit in memory or cross IPC at once.
//!
//! Every transfer reports progress through one event stream, and a transfer
//! that ends early — cancelled or failed — removes its own partial file, so
//! nothing half-written masquerades as a finished copy.

use crate::sftp::{join_path, validate_name, validate_path, SftpRegistry};
use base64::Engine;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex as AsyncMutex;

/// Emitted on every meaningful progress change of any transfer.
pub const EVENT_TRANSFER: &str = "sftp://transfer";

/// Remote read/write unit. SFTP round-trips per request, so this leans large.
const REMOTE_CHUNK: usize = 256 * 1024;
/// One upload chunk decoded may not exceed this; the frontend sends 4 MiB.
const MAX_UPLOAD_CHUNK: usize = 8 * 1024 * 1024;
/// Progress events fire at most once per this many new bytes.
const EMIT_EVERY_BYTES: u64 = 1024 * 1024;

/// Where transfer progress goes. The app emits Tauri events; tests collect.
pub trait TransferSink: Send + Sync + 'static {
    fn update(&self, state: &TransferState);
}

pub struct EventSink(pub AppHandle);

impl TransferSink for EventSink {
    fn update(&self, state: &TransferState) {
        let _ = self.0.emit(EVENT_TRANSFER, state);
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferState {
    pub transfer_id: String,
    pub session_id: String,
    pub kind: &'static str,
    /// The file name, for display.
    pub name: String,
    pub remote_path: String,
    /// Local source for path uploads, or the final published download path.
    pub local_path: Option<String>,
    pub bytes_done: u64,
    pub total_bytes: Option<u64>,
    pub state: &'static str,
    pub detail: Option<String>,
}

struct TransferEntry {
    state: Mutex<TransferState>,
    cancel: AtomicBool,
    /// The open remote file of an in-progress upload, fed chunk by chunk.
    upload: AsyncMutex<Option<russh_sftp::client::fs::File>>,
    /// Uploads retain their session so an error can clean up even if the UI
    /// starts closing the visible SFTP session at the same time.
    upload_session: Option<Arc<SftpSession>>,
    /// Upload bytes go here first. The user-visible target is only replaced
    /// after the expected byte count has arrived and the handle is closed.
    staging_path: Option<String>,
    overwrite: bool,
    /// Serializes only publication with other uploads and text saves. Streaming
    /// into private staging files does not hold this target-specific lock.
    target_gate: Arc<AsyncMutex<()>>,
}

#[derive(Default)]
pub struct TransferRegistry {
    transfers: Mutex<HashMap<String, Arc<TransferEntry>>>,
    counter: AtomicU64,
}

impl TransferRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn next_id(&self) -> String {
        let n = self.counter.fetch_add(1, Ordering::Relaxed) + 1;
        format!("transfer-{n}")
    }

    fn insert(&self, entry: Arc<TransferEntry>) -> Result<(), String> {
        let id = entry
            .state
            .lock()
            .map_err(|e| e.to_string())?
            .transfer_id
            .clone();
        self.transfers
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id, entry);
        Ok(())
    }

    fn entry(&self, transfer_id: &str) -> Result<Arc<TransferEntry>, String> {
        self.transfers
            .lock()
            .map_err(|e| e.to_string())?
            .get(transfer_id)
            .cloned()
            .ok_or_else(|| format!("no transfer called '{transfer_id}'"))
    }

    pub fn list(&self) -> Vec<TransferState> {
        self.transfers
            .lock()
            .map(|guard| {
                guard
                    .values()
                    .filter_map(|entry| entry.state.lock().ok().map(|state| state.clone()))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Flags a transfer to stop. The task or the next chunk call notices.
    pub fn request_cancel(&self, transfer_id: &str) -> Result<(), String> {
        self.entry(transfer_id)?
            .cancel
            .store(true, Ordering::Relaxed);
        Ok(())
    }

    /// Drops finished entries the interface has dismissed.
    pub fn dismiss(&self, transfer_id: &str) -> Result<(), String> {
        let entry = self.entry(transfer_id)?;
        let ended = entry
            .state
            .lock()
            .map(|state| state.state != "running")
            .unwrap_or(true);
        if !ended {
            return Err("the transfer is still running — cancel it first".to_string());
        }
        self.transfers
            .lock()
            .map_err(|e| e.to_string())?
            .remove(transfer_id);
        Ok(())
    }
}

impl TransferEntry {
    /// Applies a change and hands the fresh snapshot to the sink.
    fn update(&self, sink: &dyn TransferSink, apply: impl FnOnce(&mut TransferState)) {
        if let Ok(mut state) = self.state.lock() {
            apply(&mut state);
            sink.update(&state);
        }
    }
}

/// Strips what a local filesystem cannot take, keeping the name recognisable.
pub(crate) fn safe_local_name(remote_name: &str) -> String {
    let cleaned: String = remote_name
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                '_'
            } else {
                character
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches(|c: char| c == ' ' || c == '.');
    let stem = trimmed
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|number| {
                matches!(number, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            })
        });
    if trimmed.is_empty() {
        "download".to_string()
    } else if reserved {
        format!("_{trimmed}")
    } else {
        trimmed.to_string()
    }
}

/// `report.csv` → `report (2).csv` and so on. The caller still has to claim
/// the returned candidate atomically; checking whether it exists is racy.
fn numbered_download_path(directory: &Path, name: &str, attempt: u64) -> PathBuf {
    if attempt <= 1 {
        return directory.join(name);
    }
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem, Some(extension)),
        _ => (name, None),
    };
    match extension {
        Some(extension) => directory.join(format!("{stem} ({attempt}).{extension}")),
        None => directory.join(format!("{stem} ({attempt})")),
    }
}

#[derive(Debug)]
struct DownloadPublishError {
    detail: String,
    staging: tempfile::NamedTempFile,
}

/// Publishes a fully written staging file without replacing any directory
/// entry. A name that appeared during the transfer simply advances the suffix;
/// PersistError hands the same private staging file back for the next attempt.
fn publish_download(
    mut staging: tempfile::NamedTempFile,
    directory: &Path,
    name: &str,
) -> Result<PathBuf, DownloadPublishError> {
    let mut attempt = 1u64;
    loop {
        let candidate = numbered_download_path(directory, name, attempt);
        match staging.persist_noclobber(&candidate) {
            Ok(file) => {
                drop(file);
                return Ok(candidate);
            }
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                staging = error.file;
                let Some(next) = attempt.checked_add(1) else {
                    return Err(DownloadPublishError {
                        detail: "download name counter overflowed".to_string(),
                        staging,
                    });
                };
                attempt = next;
            }
            Err(error) => {
                return Err(DownloadPublishError {
                    detail: format!("could not publish the completed download: {}", error.error),
                    staging: error.file,
                });
            }
        }
    }
}

fn close_download_staging(staging: tempfile::NamedTempFile) -> Option<String> {
    match staging.close() {
        Ok(()) => None,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => Some(format!(
            "could not remove the incomplete download staging file: {error}"
        )),
    }
}

fn temporary_remote_path(parent: &str, purpose: &str) -> Result<String, String> {
    let mut random = [0u8; 16];
    getrandom::fill(&mut random)
        .map_err(|error| format!("could not create a private upload name: {error}"))?;
    let token = random
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(join_path(
        parent,
        &format!(".latticeterm-{purpose}-{token}.part"),
    ))
}

fn next_upload_size(current: u64, total: u64, chunk: usize) -> Result<u64, String> {
    let next = current
        .checked_add(chunk as u64)
        .ok_or_else(|| "the upload byte count overflowed".to_string())?;
    if next > total {
        return Err(format!(
            "the upload received more data than expected ({next} of {total} bytes)"
        ));
    }
    Ok(next)
}

fn require_complete_upload(done: u64, total: u64) -> Result<(), String> {
    if done != total {
        return Err(format!(
            "the upload ended before every byte arrived ({done} of {total} bytes)"
        ));
    }
    Ok(())
}

fn next_download_size(current: u64, total: Option<u64>, chunk: usize) -> Result<u64, String> {
    let next = current
        .checked_add(chunk as u64)
        .ok_or_else(|| "the download byte count overflowed".to_string())?;
    if let Some(expected) = total {
        if next > expected {
            return Err(format!(
                "the remote file grew during the download ({next} bytes received, {expected} expected)"
            ));
        }
    }
    Ok(next)
}

fn require_complete_download(done: u64, total: Option<u64>) -> Result<(), String> {
    if let Some(expected) = total {
        if done != expected {
            return Err(format!(
                "the remote file changed during the download ({done} bytes received, {expected} expected)"
            ));
        }
    }
    Ok(())
}

fn running_state(entry: &TransferEntry) -> Result<TransferState, String> {
    let state = entry.state.lock().map_err(|error| error.to_string())?;
    if state.state != "running" {
        return Err(match state.state {
            "cancelled" => "cancelled".to_string(),
            _ => format!(
                "the transfer has already ended with state '{}'",
                state.state
            ),
        });
    }
    Ok(state.clone())
}

async fn remove_staging_file(entry: &TransferEntry) -> Result<(), String> {
    let Some(session) = entry.upload_session.as_ref() else {
        return Ok(());
    };
    let Some(staging_path) = entry.staging_path.as_ref() else {
        return Ok(());
    };
    session
        .remove_file(staging_path.clone())
        .await
        .map_err(|error| {
            format!("could not remove the incomplete remote upload at '{staging_path}': {error}")
        })
}

async fn abort_upload(
    entry: &TransferEntry,
    sink: &dyn TransferSink,
    state: &'static str,
    detail: &str,
) -> String {
    entry.cancel.store(true, Ordering::Relaxed);
    let mut upload = entry.upload.lock().await;
    {
        let mut transfer = match entry.state.lock() {
            Ok(transfer) => transfer,
            Err(error) => return error.to_string(),
        };
        if transfer.state != "running" {
            return transfer
                .detail
                .clone()
                .unwrap_or_else(|| match transfer.state {
                    "cancelled" => "cancelled".to_string(),
                    _ => format!(
                        "the transfer has already ended with state '{}'",
                        transfer.state
                    ),
                });
        }
        // Claim the terminal transition before awaiting cleanup. A concurrent
        // cancel/error path will now observe an ended transfer and leave the
        // staging file to this owner instead of deleting it twice.
        transfer.state = state;
    }
    upload.take();
    drop(upload);
    let cleanup_error = remove_staging_file(entry).await.err();
    let combined = cleanup_error
        .as_ref()
        .map(|cleanup| format!("{detail}; {cleanup}"))
        .unwrap_or_else(|| detail.to_string());
    entry.update(sink, |transfer| {
        transfer.detail = if state == "cancelled" && cleanup_error.is_none() {
            None
        } else {
            Some(combined.clone())
        };
    });
    combined
}

async fn promote_upload(entry: &TransferEntry) -> Result<Option<String>, String> {
    let _target = entry.target_gate.try_lock().map_err(|_| {
        "another file operation is running for this target; the upload was not published".to_owned()
    })?;
    let session = entry
        .upload_session
        .as_ref()
        .ok_or_else(|| "the upload session is no longer available".to_string())?;
    let staging_path = entry
        .staging_path
        .as_ref()
        .ok_or_else(|| "the upload staging path is no longer available".to_string())?;
    let state = entry
        .state
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
    let target_path = state.remote_path;
    let target_exists = session
        .try_exists(target_path.clone())
        .await
        .map_err(|error| error.to_string())?;

    if target_exists && !entry.overwrite {
        return Err(
            "the remote file appeared during the upload; confirm overwrite and try again"
                .to_string(),
        );
    }

    if !target_exists {
        session
            .rename(staging_path.clone(), target_path)
            .await
            .map_err(|error| format!("could not publish the completed upload: {error}"))?;
        return Ok(None);
    }

    let original = session
        .symlink_metadata(target_path.clone())
        .await
        .map_err(|error| format!("could not inspect the existing remote file: {error}"))?;
    if !original.file_type().is_file() {
        return Err("only an existing regular file can be replaced safely".to_string());
    }
    let original_mode = original
        .permissions
        .ok_or_else(|| "the server did not report the original file permissions".to_string())?;
    // SFTP v3 cannot carry arbitrary ACLs or safely transfer their ownership.
    // Preserve the owner's access, but never inherit new group/other readers.
    let private_mode = original_mode & 0o700;
    session
        .set_metadata(
            staging_path.clone(),
            FileAttributes {
                permissions: Some(private_mode),
                ..FileAttributes::empty()
            },
        )
        .await
        .map_err(|error| format!("could not restrict the replacement file: {error}"))?;
    let confirmed = session
        .symlink_metadata(staging_path.clone())
        .await
        .map_err(|error| format!("could not verify replacement permissions: {error}"))?;
    require_upload_permissions(&confirmed, private_mode)?;
    let permission_notice = (original_mode & 0o077 != 0).then(||
        "The replacement retains owner permissions; group and other access was removed for privacy. Reapply shared access explicitly if needed.".to_string()
    );

    let parent = target_path
        .rsplit_once('/')
        .map(|(parent, _)| if parent.is_empty() { "/" } else { parent })
        .unwrap_or(".");
    let backup_path = temporary_remote_path(parent, "backup")?;
    session
        .rename(target_path.clone(), backup_path.clone())
        .await
        .map_err(|error| format!("could not protect the existing remote file: {error}"))?;

    if let Err(error) = session
        .rename(staging_path.clone(), target_path.clone())
        .await
    {
        return match session.rename(backup_path.clone(), target_path).await {
            Ok(()) => Err(format!(
                "could not publish the completed upload; the original file was restored: {error}"
            )),
            Err(restore_error) => Err(format!(
                "could not publish the completed upload ({error}) or restore the original file ({restore_error}); the original remains at '{backup_path}'"
            )),
        };
    }

    match session.remove_file(backup_path.clone()).await {
        Ok(()) => Ok(permission_notice),
        Err(error) => Ok(Some(format!(
            "{}upload completed, but the protected previous copy could not be removed from '{backup_path}': {error}",
            permission_notice.map(|notice| format!("{notice} ")).unwrap_or_default()
        ))),
    }
}

fn require_upload_permissions(attributes: &FileAttributes, expected: u32) -> Result<(), String> {
    match attributes.permissions {
        Some(mode) if mode & 0o777 == expected => Ok(()),
        _ => Err(
            "the server could not establish the required owner-only upload permissions".to_string(),
        ),
    }
}

async fn create_private_upload(
    session: &SftpSession,
    path: &str,
) -> Result<russh_sftp::client::fs::File, String> {
    // EXCLUDE refuses an existing entry, including a pre-existing symlink.
    let mut file = session
        .open_with_flags_and_attributes(
            path,
            OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
            FileAttributes {
                permissions: Some(0o600),
                ..FileAttributes::empty()
            },
        )
        .await
        .map_err(|error| error.to_string())?;
    let checked = match file.metadata().await {
        Ok(attributes) => require_upload_permissions(&attributes, 0o600),
        Err(error) => Err(format!("could not verify upload permissions: {error}")),
    };
    if let Err(error) = checked {
        let _ = file.shutdown().await;
        return match session.remove_file(path).await {
            Ok(()) => Err(error),
            Err(cleanup) => Err(format!(
                "{error}; could not remove empty staging file '{path}': {cleanup}"
            )),
        };
    }
    Ok(file)
}

/// Starts a download that streams the remote file into `target_dir`.
pub async fn start_download(
    transfers: Arc<TransferRegistry>,
    sessions: &SftpRegistry,
    sink: Arc<dyn TransferSink>,
    session_id: &str,
    remote_path: &str,
    target_dir: PathBuf,
) -> Result<TransferState, String> {
    let remote_path = validate_path(remote_path)?;
    let session = sessions.session(session_id)?;
    // Open first and inspect that exact handle. A path can be replaced between
    // a STAT and OPEN; FSTAT keeps the expected size tied to the bytes read.
    let mut remote = session
        .open(remote_path.clone())
        .await
        .map_err(|error| error.to_string())?;
    let total = remote
        .metadata()
        .await
        .map_err(|error| error.to_string())?
        .size;

    let name = remote_path
        .rsplit('/')
        .next()
        .filter(|part| !part.is_empty())
        .unwrap_or("download");
    let local_name = safe_local_name(name);
    std::fs::create_dir_all(&target_dir).map_err(|error| error.to_string())?;
    let staging = tempfile::Builder::new()
        .prefix(".latticeterm-sftp-")
        .suffix(".part")
        .tempfile_in(&target_dir)
        .map_err(|error| format!("could not create the local download staging file: {error}"))?;

    let entry = Arc::new(TransferEntry {
        state: Mutex::new(TransferState {
            transfer_id: transfers.next_id(),
            session_id: session_id.to_string(),
            kind: "download",
            name: local_name.clone(),
            remote_path: remote_path.clone(),
            local_path: None,
            bytes_done: 0,
            total_bytes: total,
            state: "running",
            detail: None,
        }),
        cancel: AtomicBool::new(false),
        upload: AsyncMutex::new(None),
        upload_session: None,
        staging_path: None,
        overwrite: false,
        target_gate: Arc::default(),
    });
    if let Err(error) = transfers.insert(Arc::clone(&entry)) {
        let cleanup = close_download_staging(staging);
        return Err(cleanup
            .map(|cleanup| format!("{error}; {cleanup}"))
            .unwrap_or(error));
    }
    let snapshot = match entry.state.lock() {
        Ok(state) => state.clone(),
        Err(error) => {
            let cleanup = close_download_staging(staging);
            return Err(cleanup
                .map(|cleanup| format!("{error}; {cleanup}"))
                .unwrap_or_else(|| error.to_string()));
        }
    };
    sink.update(&snapshot);

    let task_entry = Arc::clone(&entry);
    tokio::spawn(async move {
        let mut staging = Some(staging);
        let stream_result: Result<u64, String> = async {
            let local_file = staging
                .as_ref()
                .ok_or_else(|| "the download staging file is unavailable".to_string())?
                .reopen()
                .map_err(|error| format!("could not open the download staging file: {error}"))?;
            let mut local = tokio::fs::File::from_std(local_file);

            let mut buffer = vec![0u8; REMOTE_CHUNK];
            let mut done: u64 = 0;
            let mut last_emitted: u64 = 0;
            loop {
                if task_entry.cancel.load(Ordering::Relaxed) {
                    return Err("cancelled".to_string());
                }
                let read = remote
                    .read(&mut buffer)
                    .await
                    .map_err(|error| error.to_string())?;
                if read == 0 {
                    break;
                }
                let next = next_download_size(done, total, read)?;
                local
                    .write_all(&buffer[..read])
                    .await
                    .map_err(|error| error.to_string())?;
                done = next;
                if done - last_emitted >= EMIT_EVERY_BYTES {
                    last_emitted = done;
                    task_entry.update(sink.as_ref(), |state| state.bytes_done = done);
                }
            }
            if task_entry.cancel.load(Ordering::Relaxed) {
                return Err("cancelled".to_string());
            }
            require_complete_download(done, total)?;
            local.flush().await.map_err(|error| error.to_string())?;
            local
                .sync_all()
                .await
                .map_err(|error| format!("could not sync the completed download: {error}"))?;
            Ok(done)
        }
        .await;

        let result = match stream_result {
            Ok(_) if task_entry.cancel.load(Ordering::Relaxed) => Err("cancelled".to_string()),
            Ok(done) => {
                let private_file = staging.take().expect("staging checked while streaming");
                match publish_download(private_file, &target_dir, &local_name) {
                    Ok(local_path) => Ok((done, local_path)),
                    Err(error) => {
                        staging = Some(error.staging);
                        Err(error.detail)
                    }
                }
            }
            Err(detail) => Err(detail),
        };

        match result {
            Ok((done, local_path)) => task_entry.update(sink.as_ref(), |state| {
                state.bytes_done = done;
                state.local_path = Some(local_path.display().to_string());
                state.state = "done";
            }),
            Err(detail) => {
                let cleanup_error = staging.take().and_then(close_download_staging);
                let cancelled = detail == "cancelled";
                task_entry.update(sink.as_ref(), |state| {
                    state.state = if cancelled { "cancelled" } else { "error" };
                    state.detail = match cleanup_error {
                        Some(cleanup) => Some(format!("{detail}; {cleanup}")),
                        None if cancelled => None,
                        None => Some(detail),
                    };
                });
            }
        }
    });

    Ok(snapshot)
}

/// Streams a local file straight from disk into `parent` on the remote.
///
/// This is the drag-and-drop path: the OS hands us a local file path, so the
/// whole read happens on the Rust side (no base64 chunks over IPC). It reuses
/// the same staging-then-promote safety as the chunked upload, so a failure or
/// cancel never leaves a half-written file at the visible target.
pub async fn start_upload_from_path(
    transfers: Arc<TransferRegistry>,
    sessions: &SftpRegistry,
    sink: Arc<dyn TransferSink>,
    session_id: &str,
    parent: &str,
    local_path: PathBuf,
    overwrite: bool,
) -> Result<TransferState, String> {
    let parent = validate_path(parent)?;
    // Open first, then read metadata from that exact handle. The path may be
    // replaced between the drop event and this command; keeping one handle
    // ensures the advertised size and streamed bytes refer to the same file.
    let mut local = tokio::fs::File::open(&local_path)
        .await
        .map_err(|error| format!("cannot open the dropped file: {error}"))?;
    let metadata = local
        .metadata()
        .await
        .map_err(|error| format!("cannot read the dropped file: {error}"))?;
    if metadata.is_dir() {
        return Err("folders cannot be uploaded yet — drop individual files".to_string());
    }
    if !metadata.is_file() {
        return Err("only regular files can be uploaded".to_string());
    }
    let total = metadata.len();
    let file_name = local_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "the dropped file has no usable name".to_string())?;
    let name = validate_name(file_name)?;
    let session = sessions.session(session_id)?;
    let remote_path = join_path(&parent, &name);

    let target_gate = sessions.mutation_gate(session_id, &remote_path).await?;

    if !overwrite
        && session
            .try_exists(remote_path.clone())
            .await
            .map_err(|error| error.to_string())?
    {
        return Err(format!(
            "'{name}' already exists here; confirm overwrite first."
        ));
    }

    let staging_path = temporary_remote_path(&parent, "upload")?;
    let remote_file = create_private_upload(&session, &staging_path).await?;

    let entry = Arc::new(TransferEntry {
        state: Mutex::new(TransferState {
            transfer_id: transfers.next_id(),
            session_id: session_id.to_string(),
            kind: "upload",
            name,
            remote_path,
            local_path: Some(local_path.display().to_string()),
            bytes_done: 0,
            total_bytes: Some(total),
            state: "running",
            detail: None,
        }),
        cancel: AtomicBool::new(false),
        upload: AsyncMutex::new(Some(remote_file)),
        upload_session: Some(session),
        staging_path: Some(staging_path),
        overwrite,
        target_gate,
    });
    if let Err(error) = transfers.insert(Arc::clone(&entry)) {
        entry.upload.lock().await.take();
        let cleanup = remove_staging_file(&entry).await.err();
        return Err(cleanup
            .map(|cleanup| format!("{error}; {cleanup}"))
            .unwrap_or(error));
    }
    let snapshot = entry.state.lock().map_err(|e| e.to_string())?.clone();
    sink.update(&snapshot);

    let task_entry = Arc::clone(&entry);
    tokio::spawn(async move {
        let result: Result<(), String> = async {
            let mut buffer = vec![0u8; REMOTE_CHUNK];
            let mut done: u64 = 0;
            let mut last_emitted: u64 = 0;
            loop {
                if task_entry.cancel.load(Ordering::Relaxed) {
                    return Err("cancelled".to_string());
                }
                let read = local
                    .read(&mut buffer)
                    .await
                    .map_err(|error| error.to_string())?;
                if read == 0 {
                    break;
                }
                let next = next_upload_size(done, total, read)
                    .map_err(|_| "the dropped file changed size while it was being uploaded")?;
                {
                    let mut slot = task_entry.upload.lock().await;
                    let file = slot
                        .as_mut()
                        .ok_or_else(|| "the upload lost its remote file handle".to_string())?;
                    file.write_all(&buffer[..read])
                        .await
                        .map_err(|error| error.to_string())?;
                }
                done = next;
                if done - last_emitted >= EMIT_EVERY_BYTES {
                    last_emitted = done;
                    task_entry.update(sink.as_ref(), |state| state.bytes_done = done);
                }
            }
            require_complete_upload(done, total)
                .map_err(|_| "the dropped file changed size while it was being uploaded")?;
            {
                let mut slot = task_entry.upload.lock().await;
                if let Some(mut file) = slot.take() {
                    file.flush().await.map_err(|error| error.to_string())?;
                    file.shutdown().await.map_err(|error| error.to_string())?;
                }
            }
            task_entry.update(sink.as_ref(), |state| state.bytes_done = done);
            Ok(())
        }
        .await;

        match result {
            Ok(()) => match promote_upload(&task_entry).await {
                Ok(warning) => task_entry.update(sink.as_ref(), |state| {
                    if state.state == "running" {
                        state.state = "done";
                        state.detail = warning;
                    }
                }),
                Err(detail) => {
                    let _ = abort_upload(&task_entry, sink.as_ref(), "error", &detail).await;
                }
            },
            Err(detail) => {
                let state = if detail == "cancelled" {
                    "cancelled"
                } else {
                    "error"
                };
                let _ = abort_upload(&task_entry, sink.as_ref(), state, &detail).await;
            }
        }
    });

    Ok(snapshot)
}

/// What an upload needs before its first byte arrives.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadPlan {
    pub session_id: String,
    pub parent: String,
    pub name: String,
    pub total_bytes: u64,
    pub overwrite: bool,
}

/// Legacy small-file IPC uses the same private staging and promotion path
/// as streaming uploads, including no-clobber and symlink checks.
pub(crate) async fn write_small_upload(
    sessions: &SftpRegistry,
    plan: UploadPlan,
    bytes: &[u8],
) -> Result<(), String> {
    struct QuietSink;
    impl TransferSink for QuietSink {
        fn update(&self, _: &TransferState) {}
    }
    let transfers = Arc::new(TransferRegistry::new());
    let state = begin_upload(Arc::clone(&transfers), sessions, &QuietSink, plan).await?;
    for chunk in bytes.chunks(MAX_UPLOAD_CHUNK) {
        let encoded = base64::engine::general_purpose::STANDARD.encode(chunk);
        upload_chunk(&transfers, &QuietSink, &state.transfer_id, &encoded).await?;
    }
    finish_upload(&transfers, &QuietSink, &state.transfer_id).await
}

/// Opens the remote file an upload will stream into.
pub async fn begin_upload(
    transfers: Arc<TransferRegistry>,
    sessions: &SftpRegistry,
    sink: &dyn TransferSink,
    plan: UploadPlan,
) -> Result<TransferState, String> {
    let session_id = plan.session_id.as_str();
    let total_bytes = plan.total_bytes;
    let overwrite = plan.overwrite;
    let parent = validate_path(&plan.parent)?;
    let name = validate_name(&plan.name)?;
    let session = sessions.session(session_id)?;
    let remote_path = join_path(&parent, &name);
    let target_gate = sessions.mutation_gate(session_id, &remote_path).await?;

    if !overwrite
        && session
            .try_exists(remote_path.clone())
            .await
            .map_err(|error| error.to_string())?
    {
        return Err("The remote file already exists; confirm overwrite first.".to_string());
    }

    let staging_path = temporary_remote_path(&parent, "upload")?;
    let file = create_private_upload(&session, &staging_path).await?;

    let entry = Arc::new(TransferEntry {
        state: Mutex::new(TransferState {
            transfer_id: transfers.next_id(),
            session_id: session_id.to_string(),
            kind: "upload",
            name,
            remote_path,
            local_path: None,
            bytes_done: 0,
            total_bytes: Some(total_bytes),
            state: "running",
            detail: None,
        }),
        cancel: AtomicBool::new(false),
        upload: AsyncMutex::new(Some(file)),
        upload_session: Some(session),
        staging_path: Some(staging_path),
        overwrite,
        target_gate,
    });
    if let Err(error) = transfers.insert(Arc::clone(&entry)) {
        entry.upload.lock().await.take();
        let cleanup = remove_staging_file(&entry).await.err();
        return Err(cleanup
            .map(|cleanup| format!("{error}; {cleanup}"))
            .unwrap_or(error));
    }
    let snapshot = entry.state.lock().map_err(|e| e.to_string())?.clone();
    sink.update(&snapshot);
    Ok(snapshot)
}

/// Writes one chunk of an upload. Chunks arrive in order from a single reader.
pub async fn upload_chunk(
    transfers: &TransferRegistry,
    sink: &dyn TransferSink,
    transfer_id: &str,
    data_base64: &str,
) -> Result<(), String> {
    let entry = transfers.entry(transfer_id)?;

    let bytes = match base64::engine::general_purpose::STANDARD.decode(data_base64) {
        Ok(bytes) => bytes,
        Err(error) => {
            let detail = format!("the chunk was not valid base64: {error}");
            return Err(abort_upload(&entry, sink, "error", &detail).await);
        }
    };
    if bytes.len() > MAX_UPLOAD_CHUNK {
        let detail = "the chunk exceeds the upload chunk limit";
        return Err(abort_upload(&entry, sink, "error", detail).await);
    }

    let mut slot = entry.upload.lock().await;
    let state = running_state(&entry)?;
    let total = state.total_bytes.unwrap_or(0);
    let next = match next_upload_size(state.bytes_done, total, bytes.len()) {
        Ok(next) => next,
        Err(detail) => {
            drop(slot);
            return Err(abort_upload(&entry, sink, "error", &detail).await);
        }
    };
    let Some(file) = slot.as_mut() else {
        drop(slot);
        let detail = "the upload lost its remote file handle";
        return Err(abort_upload(&entry, sink, "error", detail).await);
    };

    let write = async {
        file.write_all(&bytes)
            .await
            .map_err(|error| error.to_string())
    }
    .await;

    if let Err(detail) = write {
        *slot = None;
        drop(slot);
        return Err(abort_upload(&entry, sink, "error", &detail).await);
    }

    drop(slot);
    {
        let mut state = entry.state.lock().map_err(|e| e.to_string())?;
        state.bytes_done = next;
    }
    // Chunks arrive megabytes at a time, so per-chunk reporting is already
    // coarse enough not to flood the event stream.
    if let Ok(state) = entry.state.lock() {
        sink.update(&state);
    }
    Ok(())
}

/// Closes an upload's remote file and marks the transfer finished.
pub async fn finish_upload(
    transfers: &TransferRegistry,
    sink: &dyn TransferSink,
    transfer_id: &str,
) -> Result<(), String> {
    let entry = transfers.entry(transfer_id)?;
    let mut slot = entry.upload.lock().await;
    let state = running_state(&entry)?;
    let total = state.total_bytes.unwrap_or(0);
    if let Err(detail) = require_complete_upload(state.bytes_done, total) {
        drop(slot);
        return Err(abort_upload(&entry, sink, "error", &detail).await);
    }

    let Some(mut file) = slot.take() else {
        drop(slot);
        let detail = "the upload lost its remote file handle";
        return Err(abort_upload(&entry, sink, "error", detail).await);
    };

    let close_result = async {
        file.flush().await.map_err(|error| error.to_string())?;
        file.shutdown().await.map_err(|error| error.to_string())
    }
    .await;
    drop(file);
    if let Err(detail) = close_result {
        drop(slot);
        return Err(abort_upload(&entry, sink, "error", &detail).await);
    }
    if entry.cancel.load(Ordering::Relaxed) {
        drop(slot);
        return Err(abort_upload(&entry, sink, "cancelled", "cancelled").await);
    }

    let warning = match promote_upload(&entry).await {
        Ok(warning) => warning,
        Err(detail) => {
            drop(slot);
            return Err(abort_upload(&entry, sink, "error", &detail).await);
        }
    };
    entry.update(sink, |state| {
        if state.state == "running" {
            state.state = "done";
            state.detail = warning;
        }
    });
    drop(slot);
    Ok(())
}

/// Cancels a transfer. A download's task notices the flag; an upload is ended
/// here and its partial remote file removed.
pub async fn cancel(
    transfers: &TransferRegistry,
    sink: &dyn TransferSink,
    transfer_id: &str,
) -> Result<(), String> {
    let entry = transfers.entry(transfer_id)?;
    if running_state(&entry).is_err() {
        return Ok(());
    }
    entry.cancel.store(true, Ordering::Relaxed);

    if entry.upload_session.is_some() {
        let detail = abort_upload(&entry, sink, "cancelled", "cancelled").await;
        let state = entry.state.lock().map_err(|error| error.to_string())?;
        if state.state == "cancelled" && state.detail.is_some() {
            return Err(detail);
        }
    }
    Ok(())
}

/// Cancels every active transfer for a session before its SFTP transport is
/// closed. This keeps uploads from becoming invisible orphaned partials.
pub async fn cancel_session(
    transfers: &TransferRegistry,
    sink: &dyn TransferSink,
    session_id: &str,
) -> Result<(), String> {
    let transfer_ids = transfers
        .list()
        .into_iter()
        .filter(|state| state.session_id == session_id && state.state == "running")
        .map(|state| state.transfer_id)
        .collect::<Vec<_>>();
    let mut errors = Vec::new();
    for transfer_id in transfer_ids {
        if let Err(error) = cancel(transfers, sink, &transfer_id).await {
            errors.push(format!("{transfer_id}: {error}"));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
#[path = "sftp_transfers/openssh_tests.rs"]
mod openssh_tests;

#[cfg(test)]
mod tests {
    use super::*;

    struct UploadPermissionServer {
        mode: Option<u32>,
        collision: bool,
        operations: Arc<Mutex<Vec<&'static str>>>,
    }

    impl russh_sftp::server::Handler for UploadPermissionServer {
        type Error = russh_sftp::protocol::StatusCode;
        fn unimplemented(&self) -> Self::Error {
            Self::Error::OpUnsupported
        }
        async fn open(
            &mut self,
            id: u32,
            _filename: String,
            flags: OpenFlags,
            attrs: FileAttributes,
        ) -> Result<russh_sftp::protocol::Handle, Self::Error> {
            assert!(flags.contains(OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE));
            assert!(!flags.contains(OpenFlags::TRUNCATE));
            assert_eq!(attrs.permissions, Some(0o600));
            self.operations.lock().unwrap().push("open");
            if self.collision {
                return Err(Self::Error::Failure);
            }
            Ok(russh_sftp::protocol::Handle {
                id,
                handle: "upload".to_string(),
            })
        }
        async fn fstat(
            &mut self,
            id: u32,
            _handle: String,
        ) -> Result<russh_sftp::protocol::Attrs, Self::Error> {
            self.operations.lock().unwrap().push("fstat");
            Ok(russh_sftp::protocol::Attrs {
                id,
                attrs: FileAttributes {
                    permissions: self.mode,
                    ..FileAttributes::empty()
                },
            })
        }
        async fn close(
            &mut self,
            id: u32,
            _handle: String,
        ) -> Result<russh_sftp::protocol::Status, Self::Error> {
            self.operations.lock().unwrap().push("close");
            Ok(russh_sftp::protocol::Status {
                id,
                status_code: Self::Error::Ok,
                error_message: String::new(),
                language_tag: String::new(),
            })
        }
        async fn remove(
            &mut self,
            id: u32,
            _filename: String,
        ) -> Result<russh_sftp::protocol::Status, Self::Error> {
            self.operations.lock().unwrap().push("remove");
            Ok(russh_sftp::protocol::Status {
                id,
                status_code: Self::Error::Ok,
                error_message: String::new(),
                language_tag: String::new(),
            })
        }
    }

    #[tokio::test]
    async fn uploads_require_private_creation_and_preserve_colliding_paths() {
        for (mode, collision) in [
            (Some(0o100600), false),
            (Some(0o100644), false),
            (Some(0o100400), false),
            (Some(0o100700), false),
            (None, false),
            (Some(0o100600), true),
        ] {
            let operations = Arc::new(Mutex::new(Vec::new()));
            let (client, server) = tokio::io::duplex(8192);
            let peer = tokio::spawn(russh_sftp::server::run(
                server,
                UploadPermissionServer {
                    mode,
                    collision,
                    operations: Arc::clone(&operations),
                },
            ));
            let session = SftpSession::new(crate::sftp_limits::BoundedSftpStream::new(client))
                .await
                .unwrap();
            let result = create_private_upload(&session, "/srv/.upload.part").await;
            if mode == Some(0o100600) && !collision {
                result.unwrap().shutdown().await.unwrap();
                assert_eq!(*operations.lock().unwrap(), ["open", "fstat", "close"]);
            } else {
                assert!(result.is_err());
                let observed = operations.lock().unwrap();
                if collision {
                    assert_eq!(*observed, ["open"]);
                } else {
                    assert_eq!(*observed, ["open", "fstat", "close", "remove"]);
                }
            }
            drop(session);
            tokio::time::timeout(std::time::Duration::from_secs(1), peer)
                .await
                .unwrap()
                .unwrap();
        }
    }

    struct PromotionServer(Arc<Mutex<HashMap<String, FileAttributes>>>);

    impl russh_sftp::server::Handler for PromotionServer {
        type Error = russh_sftp::protocol::StatusCode;
        fn unimplemented(&self) -> Self::Error {
            Self::Error::OpUnsupported
        }
        async fn stat(
            &mut self,
            id: u32,
            path: String,
        ) -> Result<russh_sftp::protocol::Attrs, Self::Error> {
            let attrs = self
                .0
                .lock()
                .unwrap()
                .get(&path)
                .cloned()
                .ok_or(Self::Error::NoSuchFile)?;
            Ok(russh_sftp::protocol::Attrs { id, attrs })
        }
        async fn lstat(
            &mut self,
            id: u32,
            path: String,
        ) -> Result<russh_sftp::protocol::Attrs, Self::Error> {
            self.stat(id, path).await
        }
        async fn setstat(
            &mut self,
            id: u32,
            path: String,
            attrs: FileAttributes,
        ) -> Result<russh_sftp::protocol::Status, Self::Error> {
            let mut files = self.0.lock().unwrap();
            let file = files.get_mut(&path).ok_or(Self::Error::NoSuchFile)?;
            file.permissions = attrs.permissions.map(|mode| 0o100000 | mode);
            Ok(sftp_ok(id))
        }
        async fn rename(
            &mut self,
            id: u32,
            old: String,
            new: String,
        ) -> Result<russh_sftp::protocol::Status, Self::Error> {
            let mut files = self.0.lock().unwrap();
            if files.contains_key(&new) {
                return Err(Self::Error::Failure);
            }
            let attrs = files.remove(&old).ok_or(Self::Error::NoSuchFile)?;
            files.insert(new, attrs);
            Ok(sftp_ok(id))
        }
        async fn remove(
            &mut self,
            id: u32,
            path: String,
        ) -> Result<russh_sftp::protocol::Status, Self::Error> {
            self.0
                .lock()
                .unwrap()
                .remove(&path)
                .ok_or(Self::Error::NoSuchFile)?;
            Ok(sftp_ok(id))
        }
    }

    fn sftp_ok(id: u32) -> russh_sftp::protocol::Status {
        russh_sftp::protocol::Status {
            id,
            status_code: russh_sftp::protocol::StatusCode::Ok,
            error_message: String::new(),
            language_tag: String::new(),
        }
    }

    #[tokio::test]
    async fn replacements_keep_owner_access_without_widening_permissions() {
        for (mode, overwrite) in [
            (0o100600, true),
            (0o100644, true),
            (0o100755, true),
            (0o120777, true),
            (0o100600, false),
        ] {
            let original = FileAttributes {
                permissions: Some(mode),
                size: Some(123),
                ..FileAttributes::empty()
            };
            let staged = FileAttributes {
                permissions: Some(0o100600),
                size: Some(456),
                ..FileAttributes::empty()
            };
            let files = Arc::new(Mutex::new(HashMap::from([
                ("/srv/report".to_string(), original),
                ("/srv/.upload".to_string(), staged),
            ])));
            let (client, server) = tokio::io::duplex(8192);
            let peer = tokio::spawn(russh_sftp::server::run(
                server,
                PromotionServer(Arc::clone(&files)),
            ));
            let session = Arc::new(
                SftpSession::new(crate::sftp_limits::BoundedSftpStream::new(client))
                    .await
                    .unwrap(),
            );
            let entry = TransferEntry {
                state: Mutex::new(TransferState {
                    transfer_id: "test".into(),
                    session_id: "test".into(),
                    kind: "upload",
                    name: "report".into(),
                    remote_path: "/srv/report".into(),
                    local_path: None,
                    bytes_done: 456,
                    total_bytes: Some(456),
                    state: "running",
                    detail: None,
                }),
                cancel: AtomicBool::new(false),
                upload: AsyncMutex::new(None),
                upload_session: Some(Arc::clone(&session)),
                staging_path: Some("/srv/.upload".into()),
                overwrite,
                target_gate: Arc::default(),
            };
            let result = promote_upload(&entry).await;
            let success = mode != 0o120777 && overwrite;
            assert_eq!(result.is_ok(), success);
            {
                let snapshot = files.lock().unwrap();
                let target = &snapshot["/srv/report"];
                assert_eq!(target.size, Some(if success { 456 } else { 123 }));
                assert_eq!(
                    target.permissions,
                    Some(if success {
                        0o100000 | (mode & 0o700)
                    } else {
                        mode
                    })
                );
                assert_eq!(snapshot.len(), if success { 1 } else { 2 });
            }
            if success {
                assert_eq!(result.unwrap().is_some(), mode & 0o077 != 0);
            }
            drop(entry);
            drop(session);
            tokio::time::timeout(std::time::Duration::from_secs(1), peer)
                .await
                .unwrap()
                .unwrap();
        }
    }

    #[derive(Default)]
    struct RecordingSink(Mutex<Vec<TransferState>>);

    impl TransferSink for RecordingSink {
        fn update(&self, state: &TransferState) {
            self.0.lock().unwrap().push(state.clone());
        }
    }

    #[test]
    fn local_names_lose_what_windows_cannot_store() {
        assert_eq!(safe_local_name("report.csv"), "report.csv");
        assert_eq!(safe_local_name("a<b>c:d.txt"), "a_b_c_d.txt");
        assert_eq!(safe_local_name("...   "), "download");
        assert_eq!(safe_local_name("logs|2026?.log"), "logs_2026_.log");
    }

    #[test]
    fn numbered_download_names_preserve_extensions() {
        let dir = Path::new("/downloads");
        assert_eq!(
            numbered_download_path(dir, "report.csv", 3),
            PathBuf::from("/downloads/report (3).csv")
        );
        assert_eq!(
            numbered_download_path(dir, "notes.md", 1),
            PathBuf::from("/downloads/notes.md")
        );
        assert_eq!(
            numbered_download_path(dir, "backup", 2),
            PathBuf::from("/downloads/backup (2)")
        );
    }

    #[test]
    fn concurrent_downloads_atomically_publish_to_different_paths() {
        use std::io::Write;

        let directory = tempfile::tempdir().unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(32));
        let threads = (0..32)
            .map(|index| {
                let path = directory.path().to_path_buf();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    let mut staging = tempfile::NamedTempFile::new_in(&path).unwrap();
                    let content = format!("download-{index}");
                    staging.write_all(content.as_bytes()).unwrap();
                    staging.flush().unwrap();
                    barrier.wait();
                    let claimed = publish_download(staging, &path, "report.csv").unwrap();
                    (claimed, content)
                })
            })
            .collect::<Vec<_>>();
        let claims = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect::<Vec<_>>();

        let mut paths = claims
            .iter()
            .map(|(path, _content)| path.clone())
            .collect::<Vec<_>>();
        paths.sort();
        paths.dedup();
        assert_eq!(paths.len(), 32);
        assert!(paths.iter().all(|path| path.exists()));
        for (path, content) in claims {
            assert_eq!(std::fs::read_to_string(path).unwrap(), content);
        }
    }

    #[test]
    fn an_existing_download_is_preserved_when_the_next_name_is_claimed() {
        let directory = tempfile::tempdir().unwrap();
        let original = directory.path().join("report.csv");
        std::fs::write(&original, b"keep me").unwrap();
        let staging = tempfile::NamedTempFile::new_in(directory.path()).unwrap();

        let claimed = publish_download(staging, directory.path(), "report.csv").unwrap();

        assert_eq!(claimed, directory.path().join("report (2).csv"));
        assert_eq!(std::fs::read(&original).unwrap(), b"keep me");
    }

    #[cfg(unix)]
    #[test]
    fn a_dangling_symlink_is_never_followed_as_a_download_target() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let directory = tempfile::tempdir().unwrap();
        let first = directory.path().join("report.csv");
        symlink(directory.path().join("missing-target"), &first).unwrap();
        let staging = tempfile::NamedTempFile::new_in(directory.path()).unwrap();

        let claimed = publish_download(staging, directory.path(), "report.csv").unwrap();
        assert_eq!(claimed, directory.path().join("report (2).csv"));
        assert!(first.symlink_metadata().unwrap().file_type().is_symlink());
        assert!(!directory.path().join("missing-target").exists());
        assert_eq!(
            claimed.metadata().unwrap().permissions().mode() & 0o077,
            0,
            "new downloads must not be readable by other local users"
        );
    }

    #[test]
    fn failed_staging_cleanup_never_removes_a_replacement_final_file() {
        let directory = tempfile::tempdir().unwrap();
        let staging = tempfile::NamedTempFile::new_in(directory.path()).unwrap();
        let staging_path = staging.path().to_path_buf();
        let replacement = directory.path().join("report.csv");
        std::fs::write(&replacement, b"new owner").unwrap();

        assert!(close_download_staging(staging).is_none());

        assert!(!staging_path.exists());
        assert_eq!(std::fs::read(replacement).unwrap(), b"new owner");
    }

    #[test]
    fn transfer_states_use_the_field_names_the_interface_reads() {
        let state = TransferState {
            transfer_id: "transfer-1".into(),
            session_id: "sftp-1".into(),
            kind: "download",
            name: "report.csv".into(),
            remote_path: "/srv/report.csv".into(),
            local_path: Some("C:/Users/me/Downloads/report.csv".into()),
            bytes_done: 512,
            total_bytes: Some(1024),
            state: "running",
            detail: None,
        };
        let encoded = serde_json::to_value(&state).unwrap();
        assert_eq!(encoded["transferId"], "transfer-1");
        assert_eq!(encoded["sessionId"], "sftp-1");
        assert_eq!(encoded["bytesDone"], 512);
        assert_eq!(encoded["totalBytes"], 1024);
        assert_eq!(encoded["remotePath"], "/srv/report.csv");
        assert!(encoded.get("transfer_id").is_none());
    }

    #[test]
    fn a_running_transfer_cannot_be_dismissed() {
        let registry = TransferRegistry::new();
        let entry = Arc::new(TransferEntry {
            state: Mutex::new(TransferState {
                transfer_id: "transfer-1".into(),
                session_id: "sftp-1".into(),
                kind: "upload",
                name: "big.bin".into(),
                remote_path: "/srv/big.bin".into(),
                local_path: None,
                bytes_done: 0,
                total_bytes: None,
                state: "running",
                detail: None,
            }),
            cancel: AtomicBool::new(false),
            upload: AsyncMutex::new(None),
            upload_session: None,
            staging_path: None,
            overwrite: false,
            target_gate: Arc::default(),
        });
        registry.insert(entry).unwrap();

        assert!(registry.dismiss("transfer-1").is_err());
        assert_eq!(registry.list().len(), 1);

        registry
            .entry("transfer-1")
            .unwrap()
            .state
            .lock()
            .unwrap()
            .state = "done";
        registry.dismiss("transfer-1").unwrap();
        assert!(registry.list().is_empty());
    }

    #[test]
    fn upload_sizes_must_match_the_declared_file() {
        assert_eq!(next_upload_size(4, 10, 6).unwrap(), 10);
        assert!(next_upload_size(4, 10, 7).is_err());
        assert!(next_upload_size(u64::MAX, u64::MAX, 1).is_err());
        assert!(require_complete_upload(10, 10).is_ok());
        assert!(require_complete_upload(9, 10).is_err());
    }

    #[test]
    fn download_sizes_must_match_the_remote_metadata() {
        assert_eq!(next_download_size(4, Some(10), 6).unwrap(), 10);
        assert!(next_download_size(4, Some(10), 7).is_err());
        assert!(next_download_size(u64::MAX, None, 1).is_err());
        assert!(require_complete_download(10, Some(10)).is_ok());
        assert!(require_complete_download(9, Some(10)).is_err());
        assert_eq!(next_download_size(4, None, 7).unwrap(), 11);
        assert!(require_complete_download(11, None).is_ok());
    }

    #[test]
    fn remote_staging_names_are_private_and_unique() {
        let first = temporary_remote_path("/srv/files", "upload").unwrap();
        let second = temporary_remote_path("/srv/files", "upload").unwrap();
        assert!(first.starts_with("/srv/files/.latticeterm-upload-"));
        assert!(first.ends_with(".part"));
        assert_ne!(first, second);
    }

    #[tokio::test]
    async fn concurrent_terminal_paths_claim_the_transfer_once() {
        let entry = TransferEntry {
            state: Mutex::new(TransferState {
                transfer_id: "transfer-race".into(),
                session_id: "sftp-1".into(),
                kind: "upload",
                name: "report.bin".into(),
                remote_path: "/srv/report.bin".into(),
                local_path: None,
                bytes_done: 4,
                total_bytes: Some(8),
                state: "running",
                detail: None,
            }),
            cancel: AtomicBool::new(false),
            upload: AsyncMutex::new(None),
            upload_session: None,
            staging_path: None,
            overwrite: false,
            target_gate: Arc::default(),
        };
        let sink = RecordingSink::default();

        let (cancelled, failed) = tokio::join!(
            abort_upload(&entry, &sink, "cancelled", "cancelled"),
            abort_upload(&entry, &sink, "error", "connection lost"),
        );

        let final_state = entry.state.lock().unwrap().clone();
        assert!(matches!(final_state.state, "cancelled" | "error"));
        assert_eq!(sink.0.lock().unwrap().len(), 1);
        assert!(!cancelled.is_empty());
        assert!(!failed.is_empty());
        assert!(cancelled == "cancelled" || failed == "connection lost");
    }
}
