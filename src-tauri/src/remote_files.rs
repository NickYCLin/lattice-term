//! Client-side Lattice Remote file operations.
//!
//! The wire stays streaming and bounded. Downloads are written directly to a
//! private temporary file in the OS download folder; uploads accept one small
//! IPC chunk at a time and only advance local progress after it enters the
//! encrypted writer queue.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use lattice_remote::{
    RemoteFileEntry, RemoteFileKind, RemoteFileRequest, RemoteFileResponse, RemoteMessage,
    FILE_CHUNK_SIZE, MAX_DIRECTORY_ENTRIES, MAX_FILE_ROOT_LABEL_BYTES, MAX_REMOTE_PATH_BYTES,
};
use serde::Serialize;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;

mod text;
pub use text::RemoteTextDocument;

static NEXT_OPERATION: AtomicU64 = AtomicU64::new(1);
const TRANSFER_PREFIX: &str = "remote-file-";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileEntrySummary {
    pub name: String,
    pub path: String,
    pub kind: &'static str,
    pub size: u64,
    pub modified_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDirectory {
    pub path: String,
    pub entries: Vec<RemoteFileEntrySummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileTransfer {
    pub transfer_id: String,
    pub session_id: String,
    pub kind: &'static str,
    pub name: String,
    pub remote_path: String,
    pub local_path: Option<String>,
    pub bytes_done: u64,
    pub total_bytes: Option<u64>,
    pub state: &'static str,
    pub detail: Option<String>,
}

struct PendingList {
    path: Option<String>,
    entries: Vec<RemoteFileEntrySummary>,
    responder: Option<oneshot::Sender<Result<RemoteDirectory, String>>>,
}

struct PendingDownload {
    temporary: Option<tempfile::NamedTempFile>,
    final_path: Option<PathBuf>,
    expected: Option<u64>,
    written: u64,
}

struct PendingUpload {
    expected: u64,
    sent: u64,
    ready: Option<oneshot::Sender<Result<(), String>>>,
    finished: Option<oneshot::Sender<Result<(), String>>>,
}

#[derive(Default)]
struct RemoteFileState {
    lists: HashMap<u64, PendingList>,
    downloads: HashMap<u64, PendingDownload>,
    uploads: HashMap<u64, PendingUpload>,
    transfers: HashMap<u64, RemoteFileTransfer>,
}

pub struct RemoteFilesClient {
    session_id: String,
    app: AppHandle,
    outbound: mpsc::Sender<RemoteMessage>,
    state: Mutex<RemoteFileState>,
    editor: text::TextClient,
}

impl RemoteFilesClient {
    pub fn new(session_id: String, app: AppHandle, outbound: mpsc::Sender<RemoteMessage>) -> Self {
        Self {
            session_id,
            app,
            editor: text::TextClient::new(outbound.clone()),
            outbound,
            state: Mutex::new(RemoteFileState::default()),
        }
    }

    pub async fn read_text(&self, path: String) -> Result<RemoteTextDocument, String> {
        self.editor.read(path).await
    }

    pub async fn save_text(
        &self,
        path: String,
        content: String,
        revision: String,
    ) -> Result<RemoteTextDocument, String> {
        self.editor.save(path, content, revision).await
    }

    pub async fn list(
        &self,
        outgoing: &mpsc::Sender<RemoteMessage>,
        path: String,
    ) -> Result<RemoteDirectory, String> {
        let path = normalize_remote_path(&path)?;
        let request_id = next_operation_id();
        let (sender, receiver) = oneshot::channel();
        self.state
            .lock()
            .map_err(|error| error.to_string())?
            .lists
            .insert(
                request_id,
                PendingList {
                    path: None,
                    entries: Vec::new(),
                    responder: Some(sender),
                },
            );
        if outgoing
            .send(RemoteMessage::FileRequest(RemoteFileRequest::List {
                request_id,
                path,
            }))
            .await
            .is_err()
        {
            self.remove_list(request_id);
            return Err("The remote session is no longer connected.".to_string());
        }
        match timeout(Duration::from_secs(30), receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("The remote folder request was interrupted.".to_string()),
            Err(_) => {
                self.remove_list(request_id);
                Err("The remote folder did not answer within 30 seconds.".to_string())
            }
        }
    }

    pub async fn download_start(
        &self,
        outgoing: &mpsc::Sender<RemoteMessage>,
        remote_path: String,
    ) -> Result<RemoteFileTransfer, String> {
        let remote_path = normalize_remote_path(&remote_path)?;
        let transfer_id = next_operation_id();
        let name = path_name(&remote_path);
        let transfer = RemoteFileTransfer {
            transfer_id: transfer_label(transfer_id),
            session_id: self.session_id.clone(),
            kind: "download",
            name,
            remote_path: remote_path.clone(),
            local_path: None,
            bytes_done: 0,
            total_bytes: None,
            state: "running",
            detail: None,
        };
        {
            let mut state = self.state.lock().map_err(|error| error.to_string())?;
            state.downloads.insert(
                transfer_id,
                PendingDownload {
                    temporary: None,
                    final_path: None,
                    expected: None,
                    written: 0,
                },
            );
            state.transfers.insert(transfer_id, transfer.clone());
        }
        if outgoing
            .send(RemoteMessage::FileRequest(RemoteFileRequest::Download {
                transfer_id,
                path: remote_path,
            }))
            .await
            .is_err()
        {
            self.fail_transfer(transfer_id, "The remote session is no longer connected.");
            return Err("The remote session is no longer connected.".to_string());
        }
        self.emit_transfer(&transfer);
        Ok(transfer)
    }

    pub async fn upload_begin(
        &self,
        outgoing: &mpsc::Sender<RemoteMessage>,
        parent: String,
        name: String,
        size: u64,
        overwrite: bool,
    ) -> Result<RemoteFileTransfer, String> {
        let remote_path = join_remote_path(&parent, &name)?;
        let transfer_id = next_operation_id();
        let transfer = RemoteFileTransfer {
            transfer_id: transfer_label(transfer_id),
            session_id: self.session_id.clone(),
            kind: "upload",
            name,
            remote_path: remote_path.clone(),
            local_path: None,
            bytes_done: 0,
            total_bytes: Some(size),
            state: "running",
            detail: None,
        };
        let (sender, receiver) = oneshot::channel();
        {
            let mut state = self.state.lock().map_err(|error| error.to_string())?;
            state.uploads.insert(
                transfer_id,
                PendingUpload {
                    expected: size,
                    sent: 0,
                    ready: Some(sender),
                    finished: None,
                },
            );
            state.transfers.insert(transfer_id, transfer.clone());
        }
        if outgoing
            .send(RemoteMessage::FileRequest(RemoteFileRequest::UploadStart {
                transfer_id,
                path: remote_path,
                size,
                overwrite,
            }))
            .await
            .is_err()
        {
            self.fail_transfer(transfer_id, "The remote session is no longer connected.");
            return Err("The remote session is no longer connected.".to_string());
        }
        self.emit_transfer(&transfer);
        match timeout(Duration::from_secs(30), receiver).await {
            Ok(Ok(Ok(()))) => Ok(transfer),
            Ok(Ok(Err(error))) => Err(error),
            Ok(Err(_)) => Err("The remote upload request was interrupted.".to_string()),
            Err(_) => {
                self.fail_transfer(transfer_id, "The remote upload did not start in time.");
                let _ = outgoing
                    .send(RemoteMessage::FileRequest(RemoteFileRequest::Cancel {
                        transfer_id,
                    }))
                    .await;
                Err("The remote upload did not start in time.".to_string())
            }
        }
    }

    pub async fn upload_chunk(
        &self,
        outgoing: &mpsc::Sender<RemoteMessage>,
        transfer_id: &str,
        data: &str,
    ) -> Result<(), String> {
        let transfer_id = parse_transfer_id(transfer_id)?;
        let bytes = BASE64
            .decode(data)
            .map_err(|_| "The upload chunk is not valid base64.".to_string())?;
        if bytes.is_empty() || bytes.len() > FILE_CHUNK_SIZE {
            return Err(format!(
                "Upload chunks must contain between 1 and {FILE_CHUNK_SIZE} bytes."
            ));
        }
        let next = {
            let state = self.state.lock().map_err(|error| error.to_string())?;
            let upload = state
                .uploads
                .get(&transfer_id)
                .ok_or_else(|| "The remote upload is not active.".to_string())?;
            let next = upload
                .sent
                .checked_add(bytes.len() as u64)
                .ok_or_else(|| "The upload byte count overflowed.".to_string())?;
            if next > upload.expected {
                return Err("The upload contains more bytes than announced.".to_string());
            }
            next
        };
        if outgoing
            .send(RemoteMessage::FileRequest(RemoteFileRequest::UploadChunk {
                transfer_id,
                bytes,
            }))
            .await
            .is_err()
        {
            self.fail_transfer(transfer_id, "The remote session is no longer connected.");
            return Err("The remote session is no longer connected.".to_string());
        }
        let transfer = {
            let mut state = self.state.lock().map_err(|error| error.to_string())?;
            let upload = state
                .uploads
                .get_mut(&transfer_id)
                .ok_or_else(|| "The remote upload is no longer active.".to_string())?;
            upload.sent = next;
            let transfer = state
                .transfers
                .get_mut(&transfer_id)
                .ok_or_else(|| "The remote transfer is unavailable.".to_string())?;
            transfer.bytes_done = next;
            transfer.clone()
        };
        self.emit_transfer(&transfer);
        Ok(())
    }

    pub async fn upload_finish(
        &self,
        outgoing: &mpsc::Sender<RemoteMessage>,
        transfer_id: &str,
    ) -> Result<(), String> {
        let transfer_id = parse_transfer_id(transfer_id)?;
        let (sender, receiver) = oneshot::channel();
        {
            let mut state = self.state.lock().map_err(|error| error.to_string())?;
            let upload = state
                .uploads
                .get_mut(&transfer_id)
                .ok_or_else(|| "The remote upload is not active.".to_string())?;
            if upload.sent != upload.expected {
                return Err(format!(
                    "The upload has sent {} of {} bytes.",
                    upload.sent, upload.expected
                ));
            }
            if upload.finished.is_some() {
                return Err("The remote upload is already finishing.".to_string());
            }
            upload.finished = Some(sender);
        }
        if outgoing
            .send(RemoteMessage::FileRequest(
                RemoteFileRequest::UploadFinish { transfer_id },
            ))
            .await
            .is_err()
        {
            self.fail_transfer(transfer_id, "The remote session is no longer connected.");
            return Err("The remote session is no longer connected.".to_string());
        }
        match timeout(Duration::from_secs(60), receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("The remote upload completion was interrupted.".to_string()),
            Err(_) => {
                self.fail_transfer(transfer_id, "The remote upload did not finish in time.");
                Err("The remote upload did not finish in time.".to_string())
            }
        }
    }

    pub async fn cancel(
        &self,
        outgoing: &mpsc::Sender<RemoteMessage>,
        transfer_id: &str,
    ) -> Result<(), String> {
        let transfer_id = parse_transfer_id(transfer_id)?;
        let transfer = {
            let mut state = self.state.lock().map_err(|error| error.to_string())?;
            state.downloads.remove(&transfer_id);
            if let Some(mut upload) = state.uploads.remove(&transfer_id) {
                if let Some(sender) = upload.ready.take() {
                    let _ = sender.send(Err("Cancelled".to_string()));
                }
                if let Some(sender) = upload.finished.take() {
                    let _ = sender.send(Err("Cancelled".to_string()));
                }
            }
            let transfer = state
                .transfers
                .get_mut(&transfer_id)
                .ok_or_else(|| "The remote transfer is unavailable.".to_string())?;
            if transfer.state != "running" {
                return Ok(());
            }
            transfer.state = "cancelled";
            transfer.detail = Some("Cancelled".to_string());
            transfer.clone()
        };
        let _ = outgoing
            .send(RemoteMessage::FileRequest(RemoteFileRequest::Cancel {
                transfer_id,
            }))
            .await;
        self.emit_transfer(&transfer);
        Ok(())
    }

    pub fn dismiss(&self, transfer_id: &str) -> Result<(), String> {
        let transfer_id = parse_transfer_id(transfer_id)?;
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        let transfer = state
            .transfers
            .get(&transfer_id)
            .ok_or_else(|| "The remote transfer is unavailable.".to_string())?;
        if transfer.state == "running" {
            return Err("Cancel the running transfer before clearing it.".to_string());
        }
        state.transfers.remove(&transfer_id);
        Ok(())
    }

    pub fn transfers(&self) -> Vec<RemoteFileTransfer> {
        let Ok(state) = self.state.lock() else {
            return Vec::new();
        };
        let mut transfers: Vec<_> = state.transfers.values().cloned().collect();
        transfers.sort_by(|left, right| left.transfer_id.cmp(&right.transfer_id));
        transfers
    }

    pub fn handle_response(&self, response: RemoteFileResponse) {
        if self.editor.handle(&response) {
            return;
        }
        match response {
            RemoteFileResponse::TextStart { .. } | RemoteFileResponse::TextSaved { .. } => {}
            RemoteFileResponse::ListStart { request_id, path } => {
                if let Ok(mut state) = self.state.lock() {
                    if let Some(pending) = state.lists.get_mut(&request_id) {
                        pending.path = Some(path);
                        pending.entries.clear();
                    }
                }
            }
            RemoteFileResponse::ListEntry { request_id, entry } => {
                if let Ok(mut state) = self.state.lock() {
                    if let Some(pending) = state.lists.get_mut(&request_id) {
                        if pending.path.is_some() && pending.entries.len() < MAX_DIRECTORY_ENTRIES {
                            pending.entries.push(entry_summary(entry));
                        }
                    }
                }
            }
            RemoteFileResponse::ListDone { request_id } => {
                let pending = self
                    .state
                    .lock()
                    .ok()
                    .and_then(|mut state| state.lists.remove(&request_id));
                if let Some(mut pending) = pending {
                    if let Some(sender) = pending.responder.take() {
                        let result = pending
                            .path
                            .ok_or_else(|| "The remote folder response was incomplete.".to_string())
                            .map(|path| RemoteDirectory {
                                path,
                                entries: pending.entries,
                            });
                        let _ = sender.send(result);
                    }
                }
            }
            RemoteFileResponse::DownloadStart {
                transfer_id,
                name,
                size,
            } => self.download_started(transfer_id, name, size),
            RemoteFileResponse::DownloadChunk { transfer_id, bytes } => {
                self.download_chunk(transfer_id, &bytes)
            }
            RemoteFileResponse::UploadReady { transfer_id } => {
                let sender = self
                    .state
                    .lock()
                    .ok()
                    .and_then(|mut state| state.uploads.get_mut(&transfer_id)?.ready.take());
                if let Some(sender) = sender {
                    let _ = sender.send(Ok(()));
                }
            }
            RemoteFileResponse::Complete { transfer_id } => self.complete_transfer(transfer_id),
            RemoteFileResponse::Error {
                operation_id,
                detail,
            } => self.fail_operation(operation_id, detail),
        }
    }

    pub fn close(&self, reason: &str) {
        self.editor.close(reason);
        let mut events = Vec::new();
        if let Ok(mut state) = self.state.lock() {
            for (_, mut pending) in state.lists.drain() {
                if let Some(sender) = pending.responder.take() {
                    let _ = sender.send(Err(reason.to_string()));
                }
            }
            state.downloads.clear();
            for (_, mut upload) in state.uploads.drain() {
                if let Some(sender) = upload.ready.take() {
                    let _ = sender.send(Err(reason.to_string()));
                }
                if let Some(sender) = upload.finished.take() {
                    let _ = sender.send(Err(reason.to_string()));
                }
            }
            for transfer in state.transfers.values_mut() {
                if transfer.state == "running" {
                    transfer.state = "error";
                    transfer.detail = Some(reason.to_string());
                    events.push(transfer.clone());
                }
            }
        }
        for transfer in events {
            self.emit_transfer(&transfer);
        }
    }

    fn remove_list(&self, request_id: u64) {
        if let Ok(mut state) = self.state.lock() {
            state.lists.remove(&request_id);
        }
    }

    fn download_started(&self, transfer_id: u64, name: String, size: u64) {
        let result = (|| -> Result<RemoteFileTransfer, String> {
            let mut state = self.state.lock().map_err(|error| error.to_string())?;
            let download = state
                .downloads
                .get_mut(&transfer_id)
                .ok_or_else(|| "The remote download is no longer active.".to_string())?;
            if download.temporary.is_some() {
                return Err("The remote sent a second download start.".to_string());
            }
            let download_dir = crate::user_download_directory(&self.app)?;
            std::fs::create_dir_all(&download_dir)
                .map_err(|error| format!("Cannot create the download folder: {error}"))?;
            let final_path = unique_download_path(&download_dir, &name);
            let temporary = tempfile::Builder::new()
                .prefix(".latticeterm-remote-")
                .suffix(".part")
                .tempfile_in(&download_dir)
                .map_err(|error| format!("Cannot create the download staging file: {error}"))?;
            download.temporary = Some(temporary);
            download.final_path = Some(final_path.clone());
            download.expected = Some(size);
            let transfer = state
                .transfers
                .get_mut(&transfer_id)
                .ok_or_else(|| "The remote transfer is unavailable.".to_string())?;
            transfer.name = name;
            transfer.total_bytes = Some(size);
            transfer.local_path = Some(final_path.display().to_string());
            Ok(transfer.clone())
        })();
        match result {
            Ok(transfer) => self.emit_transfer(&transfer),
            Err(error) => {
                self.cancel_remote(transfer_id);
                self.fail_transfer(transfer_id, &error);
            }
        }
    }

    fn download_chunk(&self, transfer_id: u64, bytes: &[u8]) {
        let result = (|| -> Result<RemoteFileTransfer, String> {
            let mut state = self.state.lock().map_err(|error| error.to_string())?;
            let download = state
                .downloads
                .get_mut(&transfer_id)
                .ok_or_else(|| "The remote download is not active.".to_string())?;
            let expected = download
                .expected
                .ok_or_else(|| "The remote sent file data before download metadata.".to_string())?;
            let next = download
                .written
                .checked_add(bytes.len() as u64)
                .ok_or_else(|| "The download byte count overflowed.".to_string())?;
            if next > expected {
                return Err("The remote sent more file data than announced.".to_string());
            }
            download
                .temporary
                .as_mut()
                .ok_or_else(|| "The download staging file is unavailable.".to_string())?
                .write_all(bytes)
                .map_err(|error| format!("Cannot write the downloaded file: {error}"))?;
            download.written = next;
            let transfer = state
                .transfers
                .get_mut(&transfer_id)
                .ok_or_else(|| "The remote transfer is unavailable.".to_string())?;
            transfer.bytes_done = next;
            Ok(transfer.clone())
        })();
        match result {
            Ok(transfer) => self.emit_transfer(&transfer),
            Err(error) => {
                self.cancel_remote(transfer_id);
                self.fail_transfer(transfer_id, &error);
            }
        }
    }

    fn complete_transfer(&self, transfer_id: u64) {
        let download = self
            .state
            .lock()
            .ok()
            .and_then(|mut state| state.downloads.remove(&transfer_id));
        if let Some(mut download) = download {
            let result = (|| -> Result<(), String> {
                let expected = download
                    .expected
                    .ok_or_else(|| "The download metadata never arrived.".to_string())?;
                if download.written != expected {
                    return Err(format!(
                        "The download ended after {} of {} bytes.",
                        download.written, expected
                    ));
                }
                let mut temporary = download
                    .temporary
                    .take()
                    .ok_or_else(|| "The download staging file is unavailable.".to_string())?;
                temporary
                    .as_file_mut()
                    .flush()
                    .and_then(|()| temporary.as_file().sync_all())
                    .map_err(|error| format!("Cannot finish the download safely: {error}"))?;
                let final_path = download
                    .final_path
                    .take()
                    .ok_or_else(|| "The final download path is unavailable.".to_string())?;
                temporary.persist_noclobber(&final_path).map_err(|error| {
                    format!("Cannot publish the downloaded file: {}", error.error)
                })?;
                Ok(())
            })();
            match result {
                Ok(()) => self.finish_transfer(transfer_id),
                Err(error) => self.fail_transfer(transfer_id, &error),
            }
            return;
        }

        let sender = self
            .state
            .lock()
            .ok()
            .and_then(|mut state| state.uploads.remove(&transfer_id))
            .and_then(|mut upload| upload.finished.take());
        if let Some(sender) = sender {
            let _ = sender.send(Ok(()));
            self.finish_transfer(transfer_id);
        }
    }

    fn finish_transfer(&self, transfer_id: u64) {
        let transfer = self.state.lock().ok().and_then(|mut state| {
            let transfer = state.transfers.get_mut(&transfer_id)?;
            transfer.state = "done";
            transfer.detail = Some("Completed".to_string());
            Some(transfer.clone())
        });
        if let Some(transfer) = transfer {
            self.emit_transfer(&transfer);
        }
    }

    fn fail_operation(&self, operation_id: u64, detail: String) {
        let list = self
            .state
            .lock()
            .ok()
            .and_then(|mut state| state.lists.remove(&operation_id));
        if let Some(mut list) = list {
            if let Some(sender) = list.responder.take() {
                let _ = sender.send(Err(detail));
            }
            return;
        }
        self.fail_transfer(operation_id, &detail);
    }

    fn fail_transfer(&self, transfer_id: u64, detail: &str) {
        let mut ready = None;
        let mut finished = None;
        let transfer = self.state.lock().ok().and_then(|mut state| {
            state.downloads.remove(&transfer_id);
            if let Some(mut upload) = state.uploads.remove(&transfer_id) {
                ready = upload.ready.take();
                finished = upload.finished.take();
            }
            let transfer = state.transfers.get_mut(&transfer_id)?;
            // Cancellation and completion are terminal. A response already in
            // flight must not turn a user-cancelled transfer back into an
            // error after its local staging file has been discarded.
            if transfer.state != "running" {
                return None;
            }
            transfer.state = "error";
            transfer.detail = Some(detail.to_string());
            Some(transfer.clone())
        });
        if let Some(sender) = ready {
            let _ = sender.send(Err(detail.to_string()));
        }
        if let Some(sender) = finished {
            let _ = sender.send(Err(detail.to_string()));
        }
        if let Some(transfer) = transfer {
            self.emit_transfer(&transfer);
        }
    }

    fn emit_transfer(&self, transfer: &RemoteFileTransfer) {
        let _ = self.app.emit("remote://file-transfer", transfer.clone());
    }

    fn cancel_remote(&self, transfer_id: u64) {
        let _ = self
            .outbound
            .try_send(RemoteMessage::FileRequest(RemoteFileRequest::Cancel {
                transfer_id,
            }));
    }
}

fn next_operation_id() -> u64 {
    NEXT_OPERATION.fetch_add(1, Ordering::Relaxed)
}

fn transfer_label(id: u64) -> String {
    format!("{TRANSFER_PREFIX}{id}")
}

fn parse_transfer_id(value: &str) -> Result<u64, String> {
    value
        .strip_prefix(TRANSFER_PREFIX)
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| "The remote transfer identifier is invalid.".to_string())
}

fn path_name(path: &str) -> String {
    path.rsplit('/')
        .find(|component| !component.is_empty())
        .unwrap_or("download")
        .to_string()
}

fn join_remote_path(parent: &str, name: &str) -> Result<String, String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.len() > MAX_FILE_ROOT_LABEL_BYTES
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
        || name.chars().any(char::is_control)
    {
        return Err("The upload file name is invalid.".to_string());
    }
    let parent = normalize_remote_path(parent)?;
    let path = if parent == "/" {
        format!("/{name}")
    } else {
        format!("{parent}/{name}")
    };
    validate_remote_path(&path)?;
    Ok(path)
}

fn normalize_remote_path(path: &str) -> Result<String, String> {
    let normalized = if path == "/" {
        "/".to_string()
    } else {
        path.trim_end_matches('/').to_string()
    };
    validate_remote_path(&normalized)?;
    Ok(normalized)
}

fn validate_remote_path(path: &str) -> Result<(), String> {
    let structure = path == "/"
        || (!path.ends_with('/')
            && path
                .split('/')
                .skip(1)
                .all(|component| !component.is_empty() && component != "." && component != ".."));
    if !structure
        || path.is_empty()
        || path.len() > MAX_REMOTE_PATH_BYTES
        || !path.starts_with('/')
        || path.contains('\0')
        || path.contains('\\')
        || path.chars().any(char::is_control)
    {
        return Err("The remote path is invalid.".to_string());
    }
    Ok(())
}

fn entry_summary(entry: RemoteFileEntry) -> RemoteFileEntrySummary {
    RemoteFileEntrySummary {
        name: entry.name,
        path: entry.path,
        kind: match entry.kind {
            RemoteFileKind::Directory => "directory",
            RemoteFileKind::File => "file",
            RemoteFileKind::Symlink => "symlink",
            RemoteFileKind::Other => "other",
        },
        size: entry.size,
        modified_at: entry.modified_at,
    }
}

fn unique_download_path(directory: &Path, name: &str) -> PathBuf {
    let safe_name = crate::sftp_transfers::safe_local_name(name);
    let name = safe_name.as_str();
    let direct = directory.join(name);
    if !direct.exists() {
        return direct;
    }
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("download");
    let extension = path.extension().and_then(|value| value.to_str());
    for index in 2..=10_000 {
        let candidate = match extension {
            Some(extension) => directory.join(format!("{stem} ({index}).{extension}")),
            None => directory.join(format!("{stem} ({index})")),
        };
        if !candidate.exists() {
            return candidate;
        }
    }
    directory.join(format!("{stem}-{}", next_operation_id()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_download_names_cannot_supply_a_windows_prefix_or_device_name() {
        let directory = tempfile::tempdir().unwrap();
        for (remote, local) in [
            ("C:payload.txt", "C_payload.txt"),
            ("CON.txt", "_CON.txt"),
            ("LPT1", "_LPT1"),
            ("../outside", "_outside"),
        ] {
            let result = unique_download_path(directory.path(), remote);
            assert_eq!(result, directory.path().join(local));
            assert_eq!(result.parent(), Some(directory.path()));
        }
    }

    #[test]
    fn joins_only_safe_virtual_upload_names() {
        assert_eq!(
            join_remote_path("/docs", "note.txt").unwrap(),
            "/docs/note.txt"
        );
        assert_eq!(join_remote_path("/", "note.txt").unwrap(), "/note.txt");
        assert!(join_remote_path("/docs", "../secret").is_err());
        assert!(join_remote_path("/docs", "folder/file").is_err());
        assert!(join_remote_path("/docs", &"x".repeat(MAX_FILE_ROOT_LABEL_BYTES + 1)).is_err());
        assert!(join_remote_path("/docs/../secret", "note.txt").is_err());
    }

    #[test]
    fn normalizes_only_safe_remote_folder_paths() {
        assert_eq!(normalize_remote_path("/docs/").unwrap(), "/docs");
        assert_eq!(normalize_remote_path("/").unwrap(), "/");
        assert!(normalize_remote_path("docs").is_err());
        assert!(normalize_remote_path("/docs//private").is_err());
        assert!(normalize_remote_path("/docs/../private").is_err());
        assert!(normalize_remote_path(&format!("/{}", "x".repeat(MAX_REMOTE_PATH_BYTES))).is_err());
    }

    #[test]
    fn transfer_labels_round_trip_without_javascript_number_loss() {
        let label = transfer_label(u64::MAX);
        assert_eq!(parse_transfer_id(&label).unwrap(), u64::MAX);
    }

    #[test]
    fn download_names_do_not_overwrite_existing_files() {
        let token = next_operation_id();
        let directory = std::env::temp_dir().join(format!("remote-download-{token}"));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("note.txt"), b"old").unwrap();
        assert_eq!(
            unique_download_path(&directory, "note.txt"),
            directory.join("note (2).txt")
        );
        std::fs::remove_dir_all(directory).unwrap();
    }
}
