use super::*;
use russh_sftp::protocol::{Attrs, Handle, Status, StatusCode};
use std::future::Future;
use std::task::Poll;
use tokio::sync::Notify;

#[derive(Clone, Copy)]
enum PauseAt {
    Close,
    Rename,
}

struct LifecycleServer {
    files: Arc<Mutex<HashMap<String, FileAttributes>>>,
    pause_at: PauseAt,
    entered: Arc<Notify>,
    resume: Arc<Notify>,
    fail_close: bool,
}

fn ok_status(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: String::new(),
        language_tag: String::new(),
    }
}

impl russh_sftp::server::Handler for LifecycleServer {
    type Error = StatusCode;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    async fn open(
        &mut self,
        id: u32,
        filename: String,
        flags: OpenFlags,
        attrs: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        assert!(flags.contains(OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE));
        self.files.lock().unwrap().insert(
            filename.clone(),
            FileAttributes {
                permissions: Some(0o100000 | attrs.permissions.unwrap()),
                size: Some(0),
                ..FileAttributes::empty()
            },
        );
        Ok(Handle {
            id,
            handle: filename,
        })
    }

    async fn fstat(&mut self, id: u32, handle: String) -> Result<Attrs, Self::Error> {
        self.stat(id, handle).await
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        let attrs = self
            .files
            .lock()
            .unwrap()
            .get(&path)
            .cloned()
            .ok_or(StatusCode::NoSuchFile)?;
        Ok(Attrs { id, attrs })
    }

    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        self.files.lock().unwrap().get_mut(&handle).unwrap().size =
            Some(offset + data.len() as u64);
        Ok(ok_status(id))
    }

    async fn close(&mut self, id: u32, _handle: String) -> Result<Status, Self::Error> {
        if self.fail_close {
            return Err(StatusCode::Failure);
        }
        if matches!(self.pause_at, PauseAt::Close) {
            self.entered.notify_one();
            self.resume.notified().await;
        }
        Ok(ok_status(id))
    }

    async fn rename(&mut self, id: u32, old: String, new: String) -> Result<Status, Self::Error> {
        if matches!(self.pause_at, PauseAt::Rename) {
            self.entered.notify_one();
            self.resume.notified().await;
        }
        let mut files = self.files.lock().unwrap();
        let attrs = files.remove(&old).ok_or(StatusCode::NoSuchFile)?;
        files.insert(new, attrs);
        Ok(ok_status(id))
    }

    async fn remove(&mut self, id: u32, path: String) -> Result<Status, Self::Error> {
        self.files
            .lock()
            .unwrap()
            .remove(&path)
            .ok_or(StatusCode::NoSuchFile)?;
        Ok(ok_status(id))
    }
}

#[tokio::test]
async fn path_upload_serializes_cancellation_with_close_and_publication() {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        for pause_at in [PauseAt::Close, PauseAt::Rename] {
            let files = Arc::new(Mutex::new(HashMap::new()));
            let entered = Arc::new(Notify::new());
            let resume = Arc::new(Notify::new());
            let (client, server) = tokio::io::duplex(8192);
            let peer = tokio::spawn(russh_sftp::server::run(
                server,
                LifecycleServer {
                    files: Arc::clone(&files),
                    pause_at,
                    entered: Arc::clone(&entered),
                    resume: Arc::clone(&resume),
                    fail_close: false,
                },
            ));
            let session = Arc::new(SftpSession::new(client).await.unwrap());
            let file = create_upload_staging(&session, "/srv/.upload", false)
                .await
                .unwrap();
            let entry = Arc::new(TransferEntry {
                state: Mutex::new(TransferState {
                    transfer_id: "path-race".into(),
                    session_id: "test".into(),
                    kind: "upload",
                    name: "report.bin".into(),
                    remote_path: "/srv/report.bin".into(),
                    local_path: None,
                    bytes_done: 0,
                    total_bytes: Some(4),
                    state: "running",
                    detail: None,
                }),
                cancel: AtomicBool::new(false),
                upload: AsyncMutex::new(Some(file)),
                upload_session: Some(session),
                windows_permissions: false,
                target_snapshot: None,
                staging_path: Some("/srv/.upload".into()),
                overwrite: false,
                target_gate: Arc::default(),
            });
            let transfers = TransferRegistry::new();
            transfers.insert(Arc::clone(&entry)).unwrap();
            let directory = tempfile::tempdir().unwrap();
            let local_path = directory.path().join("report.bin");
            std::fs::write(&local_path, b"data").unwrap();
            let local = tokio::fs::File::open(local_path).await.unwrap();
            let task_entry = Arc::clone(&entry);
            let upload =
                tokio::spawn(
                    async move { stream_path_upload(&task_entry, &QuietSink, local, 4).await },
                );
            entered.notified().await;
            let mut cancellation = Box::pin(cancel(&transfers, &QuietSink, "path-race"));
            std::future::poll_fn(|context| {
                assert!(cancellation.as_mut().poll(context).is_pending());
                Poll::Ready(())
            })
            .await;
            assert!(entry.cancel.load(Ordering::Relaxed));
            assert_eq!(entry.state.lock().unwrap().state, "running");
            resume.notify_one();
            let (result, cancelled) = tokio::join!(upload, cancellation);
            let result = result.unwrap();
            cancelled.unwrap();
            let expected = match pause_at {
                PauseAt::Close => {
                    assert_eq!(result.unwrap_err(), "cancelled");
                    "cancelled"
                }
                PauseAt::Rename => {
                    result.unwrap();
                    "done"
                }
            };
            assert_eq!(entry.state.lock().unwrap().state, expected);
            assert!(!files.lock().unwrap().contains_key("/srv/.upload"));
            assert_eq!(
                files.lock().unwrap().contains_key("/srv/report.bin"),
                expected == "done"
            );
            drop(transfers);
            drop(entry);
            peer.abort();
            let _ = peer.await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn upload_cleanup_reports_close_failure_and_removes_staging() {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let files = Arc::new(Mutex::new(HashMap::new()));
        let (client, server) = tokio::io::duplex(8192);
        let peer = tokio::spawn(russh_sftp::server::run(
            server,
            LifecycleServer {
                files: Arc::clone(&files),
                pause_at: PauseAt::Rename,
                entered: Arc::default(),
                resume: Arc::default(),
                fail_close: true,
            },
        ));
        let session = Arc::new(SftpSession::new(client).await.unwrap());
        let file = create_upload_staging(&session, "/srv/.upload", false)
            .await
            .unwrap();
        let entry = TransferEntry {
            state: Mutex::new(TransferState {
                transfer_id: "cleanup".into(),
                session_id: "test".into(),
                kind: "upload",
                name: "report.bin".into(),
                remote_path: "/srv/report.bin".into(),
                local_path: None,
                bytes_done: 0,
                total_bytes: Some(4),
                state: "running",
                detail: None,
            }),
            cancel: AtomicBool::new(false),
            upload: AsyncMutex::new(Some(file)),
            upload_session: Some(session),
            windows_permissions: false,
            target_snapshot: None,
            staging_path: Some("/srv/.upload".into()),
            overwrite: false,
            target_gate: Arc::default(),
        };
        let result = abort_upload(&entry, &QuietSink, "cancelled", "cancelled").await;
        assert!(!files.lock().unwrap().contains_key("/srv/.upload"));
        assert!(result.contains("could not close the incomplete remote upload"));
        assert!(entry.state.lock().unwrap().detail.is_some());
        peer.abort();
        let _ = peer.await;
    })
    .await
    .unwrap();
}

struct QuietSink;
impl TransferSink for QuietSink {
    fn update(&self, _: &TransferState) {}
}
