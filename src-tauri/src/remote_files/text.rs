//! Bounded editor RPCs. Drafts stay in memory and are never downloaded to disk.

use super::next_operation_id;
use lattice_remote::{
    RemoteFileRequest, RemoteFileResponse, RemoteMessage, FILE_CHUNK_SIZE, MAX_TEXT_FILE_BYTES,
};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTextDocument {
    pub path: String,
    pub content: String,
    pub revision: String,
    pub backup_path: Option<String>,
}

struct Pending {
    path: String,
    bytes: Vec<u8>,
    snapshot: Option<(u64, [u8; 32])>,
    saving: bool,
    finishing: bool,
    ready: Option<oneshot::Sender<Result<(), String>>>,
    reply: oneshot::Sender<Result<RemoteTextDocument, String>>,
}

#[derive(Clone)]
pub(super) struct TextClient {
    pending: Arc<Mutex<HashMap<u64, Pending>>>,
    outgoing: mpsc::Sender<RemoteMessage>,
}

struct RequestGuard {
    id: u64,
    client: TextClient,
}

impl Drop for RequestGuard {
    fn drop(&mut self) {
        if self
            .client
            .pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(&self.id))
            .is_some()
        {
            let _ = self.client.outgoing.try_send(RemoteMessage::FileRequest(
                RemoteFileRequest::Cancel {
                    transfer_id: self.id,
                },
            ));
        }
    }
}

pub(super) fn validate_text(content: &str) -> Result<(), String> {
    if content.len() > MAX_TEXT_FILE_BYTES {
        return Err("The editor supports text files up to 1 MiB.".into());
    }
    if content
        .chars()
        .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t'))
    {
        return Err("The file contains binary data or unsupported control characters.".into());
    }
    Ok(())
}

fn revision_string(revision: &[u8; 32]) -> String {
    revision.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn parse_revision(revision: &str) -> Result<[u8; 32], String> {
    if revision.len() != 64 || !revision.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("The remote text revision is invalid; reload the file.".into());
    }
    let mut bytes = [0; 32];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&revision[index * 2..index * 2 + 2], 16)
            .map_err(|_| "The remote text revision is invalid.".to_string())?;
    }
    Ok(bytes)
}

impl TextClient {
    pub(super) fn new(outgoing: mpsc::Sender<RemoteMessage>) -> Self {
        Self {
            pending: Arc::default(),
            outgoing,
        }
    }

    fn insert(&self, id: u64, pending: Pending) -> Result<RequestGuard, String> {
        let mut requests = self.pending.lock().map_err(|error| error.to_string())?;
        if requests.len() >= 2 {
            return Err("Another remote editor operation is still running.".into());
        }
        requests.insert(id, pending);
        Ok(RequestGuard {
            id,
            client: self.clone(),
        })
    }

    async fn send(&self, request: RemoteFileRequest) -> Result<(), String> {
        self.outgoing
            .send(RemoteMessage::FileRequest(request))
            .await
            .map_err(|_| "The remote session is no longer connected.".to_string())
    }

    async fn feed_save(
        &self,
        id: u64,
        request: RemoteFileRequest,
        reply: &mut oneshot::Receiver<Result<RemoteTextDocument, String>>,
    ) -> Result<Option<RemoteTextDocument>, String> {
        // Wait for capacity without starving a host error/disconnect. Once a
        // slot is available, reauthorize and enqueue synchronously under the
        // same state lock used by the reply handler.
        let permit = tokio::select! {
            result = &mut *reply => return result.map_err(|_| "The remote text save was interrupted.".to_string())?.map(Some),
            result = self.outgoing.reserve() => result.map_err(|_| "The remote session is no longer connected.".to_string())?,
        };
        let queued = {
            let mut requests = self.pending.lock().map_err(|error| error.to_string())?;
            if let Some(pending) = requests.get_mut(&id) {
                if matches!(request, RemoteFileRequest::UploadFinish { .. }) {
                    pending.finishing = true;
                }
                permit.send(RemoteMessage::FileRequest(request));
                true
            } else {
                false
            }
        };
        if queued {
            Ok(None)
        } else {
            reply
                .await
                .map_err(|_| "The remote text save was interrupted.".to_string())?
                .map(Some)
        }
    }

    pub(super) async fn read(&self, path: String) -> Result<RemoteTextDocument, String> {
        super::validate_remote_path(&path)?;
        let id = next_operation_id();
        let (reply, receiver) = oneshot::channel();
        let _guard = self.insert(
            id,
            Pending {
                path: path.clone(),
                bytes: Vec::new(),
                snapshot: None,
                saving: false,
                finishing: false,
                ready: None,
                reply,
            },
        )?;
        tokio::time::timeout(Duration::from_secs(30), async {
            self.send(RemoteFileRequest::ReadText {
                request_id: id,
                path,
            })
            .await?;
            receiver
                .await
                .map_err(|_| "The remote text read was interrupted.".to_string())?
        })
        .await
        .map_err(|_| {
            "The remote text read exceeded 30 seconds. You can retry reading.".to_string()
        })?
    }

    pub(super) async fn save(
        &self,
        path: String,
        content: String,
        revision: String,
    ) -> Result<RemoteTextDocument, String> {
        super::validate_remote_path(&path)?;
        validate_text(&content)?;
        let expected_revision = parse_revision(&revision)?;
        let id = next_operation_id();
        let (ready, ready_receiver) = oneshot::channel();
        let (reply, mut receiver) = oneshot::channel();
        let _guard = self.insert(
            id,
            Pending {
                path: path.clone(),
                bytes: content.as_bytes().to_vec(),
                snapshot: None,
                saving: true,
                finishing: false,
                ready: Some(ready),
                reply,
            },
        )?;
        tokio::time::timeout(Duration::from_secs(60), async {
            if let Some(result) = self.feed_save(id, RemoteFileRequest::SaveTextStart { transfer_id: id, path, size: content.len() as u64, expected_revision }, &mut receiver).await? {
                return Ok(result);
            }
            ready_receiver.await.map_err(|_| "The remote text save was interrupted.".to_string())??;
            for bytes in content.as_bytes().chunks(FILE_CHUNK_SIZE) {
                if let Some(result) = self.feed_save(id, RemoteFileRequest::UploadChunk { transfer_id: id, bytes: bytes.to_vec() }, &mut receiver).await? {
                    return Ok(result);
                }
            }
            if let Some(result) = self.feed_save(id, RemoteFileRequest::UploadFinish { transfer_id: id }, &mut receiver).await? {
                return Ok(result);
            }
            receiver.await.map_err(|_| "The remote text save was interrupted; reload to verify its outcome.".to_string())?
        }).await.map_err(|_| "The save was not confirmed within 60 seconds. Keep your draft and reload to verify the remote file before retrying.".to_string())?
    }

    /// Returns false for ordinary file-transfer messages, which retain their
    /// existing streaming-to-disk path. Late editor replies are harmless.
    pub(super) fn handle(&self, response: &RemoteFileResponse) -> bool {
        let (id, editor_only) = match response {
            RemoteFileResponse::TextStart { request_id, .. } => (*request_id, true),
            RemoteFileResponse::TextSaved { transfer_id, .. } => (*transfer_id, true),
            RemoteFileResponse::DownloadStart { transfer_id, .. }
            | RemoteFileResponse::DownloadChunk { transfer_id, .. }
            | RemoteFileResponse::UploadReady { transfer_id }
            | RemoteFileResponse::Complete { transfer_id } => (*transfer_id, false),
            RemoteFileResponse::Error { operation_id, .. } => (*operation_id, false),
            RemoteFileResponse::ListStart { request_id, .. }
            | RemoteFileResponse::ListEntry { request_id, .. }
            | RemoteFileResponse::ListDone { request_id } => (*request_id, false),
        };
        let Ok(mut requests) = self.pending.lock() else {
            return editor_only;
        };
        let Some(pending) = requests.get_mut(&id) else {
            return editor_only;
        };
        let result = match response {
            RemoteFileResponse::TextStart { size, revision, .. } => {
                if pending.saving
                    || pending.snapshot.is_some()
                    || *size > MAX_TEXT_FILE_BYTES as u64
                {
                    Some(Err(
                        "The remote text metadata is invalid or exceeds 1 MiB.".into()
                    ))
                } else {
                    pending.snapshot = Some((*size, *revision));
                    None
                }
            }
            RemoteFileResponse::DownloadChunk { bytes, .. } => {
                if pending.saving
                    || pending.snapshot.is_none_or(|(size, _)| {
                        pending.bytes.len().saturating_add(bytes.len()) as u64 > size
                    })
                {
                    Some(Err(
                        "The remote sent unexpected or excessive text data.".into()
                    ))
                } else {
                    pending.bytes.extend_from_slice(bytes);
                    None
                }
            }
            RemoteFileResponse::UploadReady { .. } if pending.saving => {
                if let Some(ready) = pending.ready.take() {
                    let _ = ready.send(Ok(()));
                }
                None
            }
            RemoteFileResponse::Complete { .. } if !pending.saving => {
                Some(match pending.snapshot {
                    Some((size, revision)) if size == pending.bytes.len() as u64 => {
                        String::from_utf8(std::mem::take(&mut pending.bytes))
                            .map_err(|_| "Only UTF-8 text files can be edited.".to_string())
                            .and_then(|content| {
                                validate_text(&content)?;
                                Ok(RemoteTextDocument {
                                    path: pending.path.clone(),
                                    content,
                                    revision: revision_string(&revision),
                                    backup_path: None,
                                })
                            })
                    }
                    _ => Err("The remote text response was incomplete.".into()),
                })
            }
            RemoteFileResponse::TextSaved {
                revision,
                backup_path,
                ..
            } if pending.saving && pending.finishing => {
                Some(super::validate_remote_path(backup_path).and_then(|()| {
                    if backup_path == &pending.path {
                        return Err("The remote returned an invalid recovery path.".into());
                    }
                    let content = String::from_utf8(std::mem::take(&mut pending.bytes))
                        .map_err(|_| "The saved text response is invalid.".to_string())?;
                    Ok(RemoteTextDocument {
                        path: pending.path.clone(),
                        content,
                        revision: revision_string(revision),
                        backup_path: Some(backup_path.clone()),
                    })
                }))
            }
            RemoteFileResponse::Error { detail, .. } => Some(Err(detail.clone())),
            _ => Some(Err(
                "The remote editor response was unexpected; reload to verify the file.".into(),
            )),
        };
        if let Some(result) = result {
            if result.is_err() {
                let _ =
                    self.outgoing
                        .try_send(RemoteMessage::FileRequest(RemoteFileRequest::Cancel {
                            transfer_id: id,
                        }));
            }
            if let Some(pending) = requests.remove(&id) {
                if let Some(ready) = pending.ready {
                    let detail = result.as_ref().err().cloned().unwrap_or_else(|| {
                        "The remote editor did not acknowledge the upload.".into()
                    });
                    let _ = ready.send(Err(detail));
                }
                let _ = pending.reply.send(result);
            }
        }
        true
    }

    pub(super) fn close(&self, reason: &str) {
        if let Ok(mut requests) = self.pending.lock() {
            for (_, pending) in requests.drain() {
                if let Some(ready) = pending.ready {
                    let _ = ready.send(Err(reason.into()));
                }
                let _ = pending.reply.send(Err(format!(
                    "{reason} Keep your draft; a save may need verification after reconnecting."
                )));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn backpressured_save_stops_on_error_close_or_premature_ack() {
        for response in ["error", "close", "premature-ack"] {
            let (outgoing, mut received) = mpsc::channel(1);
            let client = TextClient::new(outgoing);
            let worker = tokio::spawn({
                let client = client.clone();
                async move {
                    client
                        .save(
                            "/notes.txt".into(),
                            "draft".into(),
                            revision_string(&[1; 32]),
                        )
                        .await
                }
            });
            let Some(RemoteMessage::FileRequest(RemoteFileRequest::SaveTextStart {
                transfer_id,
                ..
            })) = received.recv().await
            else {
                panic!("missing save request")
            };
            client.handle(&RemoteFileResponse::UploadReady { transfer_id });
            tokio::time::timeout(Duration::from_secs(1), async {
                while client.outgoing.capacity() != 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            // UploadChunk occupies the only slot. UploadFinish has not entered
            // the queue, so an acknowledgement cannot be accepted yet.
            assert!(
                !client
                    .pending
                    .lock()
                    .unwrap()
                    .get(&transfer_id)
                    .unwrap()
                    .finishing
            );
            match response {
                "error" => {
                    client.handle(&RemoteFileResponse::Error {
                        operation_id: transfer_id,
                        detail: "rejected".into(),
                    });
                }
                "close" => client.close("Disconnected"),
                _ => {
                    client.handle(&RemoteFileResponse::TextSaved {
                        transfer_id,
                        revision: [2; 32],
                        backup_path: "/.backup".into(),
                    });
                }
            }
            // Do not drain the outgoing queue until the worker responds: an
            // error must interrupt reserve(), not wait for network capacity.
            assert!(tokio::time::timeout(Duration::from_secs(1), worker)
                .await
                .unwrap()
                .unwrap()
                .is_err());
            assert!(client.pending.lock().unwrap().is_empty());
            assert!(
                matches!(received.try_recv(), Ok(RemoteMessage::FileRequest(RemoteFileRequest::UploadChunk { transfer_id: id, .. })) if id == transfer_id)
            );
            while let Ok(message) = received.try_recv() {
                assert!(!matches!(
                    message,
                    RemoteMessage::FileRequest(
                        RemoteFileRequest::UploadFinish { .. }
                            | RemoteFileRequest::UploadChunk { .. }
                    )
                ));
            }
        }
    }

    #[tokio::test]
    async fn malformed_download_start_is_consumed_by_the_editor() {
        let (outgoing, mut received) = mpsc::channel(4);
        let client = TextClient::new(outgoing);
        let worker = tokio::spawn({
            let client = client.clone();
            async move { client.read("/notes.txt".into()).await }
        });
        let Some(RemoteMessage::FileRequest(RemoteFileRequest::ReadText { request_id, .. })) =
            received.recv().await
        else {
            panic!("missing read request")
        };
        // This must never enter the ordinary download handler, even though a
        // hostile peer used a valid wire variant with the editor operation ID.
        assert!(client.handle(&RemoteFileResponse::DownloadStart {
            transfer_id: request_id,
            name: "must-not-create-a-local-file.txt".into(),
            size: 1,
        }));
        let error = tokio::time::timeout(Duration::from_secs(1), worker)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(error.contains("unexpected"), "{error}");
        assert!(client.pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn malformed_save_reply_cancels_the_host_staging_operation() {
        let (outgoing, mut received) = mpsc::channel(4);
        let client = TextClient::new(outgoing);
        let worker = tokio::spawn({
            let client = client.clone();
            async move {
                client
                    .save(
                        "/notes.txt".into(),
                        "draft".into(),
                        revision_string(&[1; 32]),
                    )
                    .await
            }
        });
        let Some(RemoteMessage::FileRequest(RemoteFileRequest::SaveTextStart {
            transfer_id, ..
        })) = received.recv().await
        else {
            panic!("missing save request")
        };
        client.handle(&RemoteFileResponse::TextSaved {
            transfer_id,
            revision: [2; 32],
            backup_path: "/.notes.backup".into(),
        });
        assert!(worker.await.unwrap().unwrap_err().contains("unexpected"));
        assert!(client.pending.lock().unwrap().is_empty());
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(1), received.recv()).await,
            Ok(Some(RemoteMessage::FileRequest(RemoteFileRequest::Cancel { transfer_id: id }))) if id == transfer_id
        ));
    }

    #[tokio::test]
    async fn empty_save_does_not_send_finish_after_ready_then_error() {
        let (outgoing, mut received) = mpsc::channel(4);
        let client = TextClient::new(outgoing);
        let worker = tokio::spawn({
            let client = client.clone();
            async move {
                client
                    .save(
                        "/notes.txt".into(),
                        String::new(),
                        revision_string(&[1; 32]),
                    )
                    .await
            }
        });
        let Some(RemoteMessage::FileRequest(RemoteFileRequest::SaveTextStart {
            transfer_id, ..
        })) = received.recv().await
        else {
            panic!("missing save request")
        };
        // The worker cannot run between these two synchronous notifications.
        client.handle(&RemoteFileResponse::UploadReady { transfer_id });
        client.handle(&RemoteFileResponse::Error {
            operation_id: transfer_id,
            detail: "conflict".into(),
        });
        assert!(worker.await.unwrap().unwrap_err().contains("conflict"));
        while let Ok(message) = received.try_recv() {
            assert!(!matches!(
                message,
                RemoteMessage::FileRequest(
                    RemoteFileRequest::UploadFinish { .. } | RemoteFileRequest::UploadChunk { .. }
                )
            ));
        }
        assert!(client.pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn dropping_a_read_releases_memory_and_sends_cancel() {
        let (outgoing, mut received) = mpsc::channel(4);
        let client = TextClient::new(outgoing);
        let worker = tokio::spawn({
            let client = client.clone();
            async move { client.read("/notes.txt".into()).await }
        });
        let Some(RemoteMessage::FileRequest(RemoteFileRequest::ReadText { request_id, .. })) =
            received.recv().await
        else {
            panic!("missing read request")
        };
        client.handle(&RemoteFileResponse::TextStart {
            request_id,
            size: 8,
            revision: [1; 32],
        });
        client.handle(&RemoteFileResponse::DownloadChunk {
            transfer_id: request_id,
            bytes: b"partial".to_vec(),
        });
        worker.abort();
        assert!(worker.await.unwrap_err().is_cancelled());
        assert!(client.pending.lock().unwrap().is_empty());
        assert!(
            matches!(received.recv().await, Some(RemoteMessage::FileRequest(RemoteFileRequest::Cancel { transfer_id })) if transfer_id == request_id)
        );
        assert!(client.handle(&RemoteFileResponse::TextStart {
            request_id,
            size: 0,
            revision: [1; 32]
        }));
        assert!(client.handle(&RemoteFileResponse::TextSaved {
            transfer_id: request_id,
            revision: [1; 32],
            backup_path: "/.backup".into()
        }));
    }

    #[tokio::test]
    async fn editor_admission_is_bounded_and_close_frees_every_request() {
        let (outgoing, mut received) = mpsc::channel(4);
        let client = TextClient::new(outgoing);
        let mut workers = Vec::new();
        for path in ["/first", "/second"] {
            workers.push(tokio::spawn({
                let client = client.clone();
                async move { client.read(path.into()).await }
            }));
            received.recv().await.unwrap();
        }
        assert!(client
            .read("/third".into())
            .await
            .unwrap_err()
            .contains("Another"));
        assert_eq!(client.pending.lock().unwrap().len(), 2);
        client.close("Disconnected");
        for worker in workers {
            assert!(worker.await.unwrap().unwrap_err().contains("Disconnected"));
        }
        assert!(client.pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn editor_rejects_chunks_before_metadata_and_truncated_completion() {
        for start in [false, true] {
            let (outgoing, mut received) = mpsc::channel(4);
            let client = TextClient::new(outgoing);
            let worker = tokio::spawn({
                let client = client.clone();
                async move { client.read("/notes.txt".into()).await }
            });
            let Some(RemoteMessage::FileRequest(RemoteFileRequest::ReadText {
                request_id, ..
            })) = received.recv().await
            else {
                panic!("missing read request")
            };
            if start {
                client.handle(&RemoteFileResponse::TextStart {
                    request_id,
                    size: 4,
                    revision: [1; 32],
                });
                client.handle(&RemoteFileResponse::DownloadChunk {
                    transfer_id: request_id,
                    bytes: b"ab".to_vec(),
                });
                client.handle(&RemoteFileResponse::Complete {
                    transfer_id: request_id,
                });
            } else {
                client.handle(&RemoteFileResponse::DownloadChunk {
                    transfer_id: request_id,
                    bytes: b"ab".to_vec(),
                });
            }
            assert!(worker.await.unwrap().is_err());
            assert!(client.pending.lock().unwrap().is_empty());
        }
    }

    #[test]
    fn revision_and_text_are_bounded_and_lossless() {
        let revision = [0xab; 32];
        assert_eq!(
            parse_revision(&revision_string(&revision)).unwrap(),
            revision
        );
        assert!(parse_revision(&"é".repeat(32)).is_err());
        assert!(validate_text("\u{feff}正體\r\n\t文字\n").is_ok());
        assert!(validate_text("a\0b").is_err());
        assert!(validate_text(&"a".repeat(MAX_TEXT_FILE_BYTES)).is_ok());
        assert!(validate_text(&"a".repeat(MAX_TEXT_FILE_BYTES + 1)).is_err());
    }

    #[tokio::test]
    async fn read_is_bounded_and_disconnect_releases_requests() {
        let (outgoing, mut received) = mpsc::channel(4);
        let client = TextClient::new(outgoing);
        let worker = tokio::spawn({
            let client = client.clone();
            async move { client.read("/notes.txt".into()).await }
        });
        let Some(RemoteMessage::FileRequest(RemoteFileRequest::ReadText { request_id, .. })) =
            received.recv().await
        else {
            panic!("missing read request")
        };
        client.handle(&RemoteFileResponse::TextStart {
            request_id,
            size: MAX_TEXT_FILE_BYTES as u64 + 1,
            revision: [1; 32],
        });
        assert!(worker.await.unwrap().unwrap_err().contains("1 MiB"));
        assert!(client.pending.lock().unwrap().is_empty());
        assert!(
            matches!(received.recv().await, Some(RemoteMessage::FileRequest(RemoteFileRequest::Cancel { transfer_id })) if transfer_id == request_id)
        );
        let worker = tokio::spawn({
            let client = client.clone();
            async move { client.read("/notes.txt".into()).await }
        });
        assert!(matches!(
            received.recv().await,
            Some(RemoteMessage::FileRequest(
                RemoteFileRequest::ReadText { .. }
            ))
        ));
        client.close("Disconnected");
        assert!(worker.await.unwrap().unwrap_err().contains("Disconnected"));
        assert!(client.pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn utf8_chunks_and_save_acknowledgement_keep_revision() {
        let (outgoing, mut received) = mpsc::channel(8);
        let client = TextClient::new(outgoing);
        let worker = tokio::spawn({
            let client = client.clone();
            async move { client.read("/notes.txt".into()).await }
        });
        let Some(RemoteMessage::FileRequest(RemoteFileRequest::ReadText { request_id, .. })) =
            received.recv().await
        else {
            panic!("missing read request")
        };
        let bytes = "\u{feff}正體\r\n".as_bytes();
        client.handle(&RemoteFileResponse::TextStart {
            request_id,
            size: bytes.len() as u64,
            revision: [1; 32],
        });
        for bytes in bytes.chunks(2) {
            client.handle(&RemoteFileResponse::DownloadChunk {
                transfer_id: request_id,
                bytes: bytes.to_vec(),
            });
        }
        client.handle(&RemoteFileResponse::Complete {
            transfer_id: request_id,
        });
        let document = worker.await.unwrap().unwrap();
        assert_eq!(document.content.as_bytes(), bytes);
        let worker = tokio::spawn({
            let client = client.clone();
            async move {
                client
                    .save(document.path, document.content, document.revision)
                    .await
            }
        });
        let Some(RemoteMessage::FileRequest(RemoteFileRequest::SaveTextStart {
            transfer_id,
            expected_revision,
            ..
        })) = received.recv().await
        else {
            panic!("missing save request")
        };
        assert_eq!(expected_revision, [1; 32]);
        client.handle(&RemoteFileResponse::UploadReady { transfer_id });
        assert!(matches!(
            received.recv().await,
            Some(RemoteMessage::FileRequest(
                RemoteFileRequest::UploadChunk { .. }
            ))
        ));
        assert!(matches!(
            received.recv().await,
            Some(RemoteMessage::FileRequest(
                RemoteFileRequest::UploadFinish { .. }
            ))
        ));
        client.handle(&RemoteFileResponse::TextSaved {
            transfer_id,
            revision: [2; 32],
            backup_path: "/.notes.backup".into(),
        });
        let saved = worker.await.unwrap().unwrap();
        assert_eq!(saved.revision, revision_string(&[2; 32]));
        assert_eq!(saved.content.as_bytes(), bytes);
        assert_eq!(saved.backup_path.as_deref(), Some("/.notes.backup"));
    }
}
