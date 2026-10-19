use super::*;
use std::process::Stdio;

struct QuietSink;
impl TransferSink for QuietSink {
    fn update(&self, _: &TransferState) {}
}

struct WindowsServer {
    child: tokio::process::Child,
    directory: tempfile::TempDir,
    session: Arc<SftpSession>,
}

impl WindowsServer {
    async fn start() -> Self {
        let executable = std::env::var_os("LATTICETERM_TEST_WINDOWS_SFTP_SERVER").expect(
            "Set LATTICETERM_TEST_WINDOWS_SFTP_SERVER to a verified Microsoft sftp-server.exe",
        );
        let directory = tempfile::Builder::new()
            .prefix("latticeterm-sftp-test-")
            .tempdir()
            .unwrap();
        let mut child = tokio::process::Command::new(executable)
            .current_dir(directory.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let stream = tokio::io::join(child.stdout.take().unwrap(), child.stdin.take().unwrap());
        let session = Arc::new(
            SftpSession::new(crate::sftp_limits::BoundedSftpStream::new(stream))
                .await
                .unwrap(),
        );
        session.set_timeout(5);
        Self {
            child,
            directory,
            session,
        }
    }

    fn path(&self, name: &str) -> String {
        self.directory
            .path()
            .join(name)
            .to_str()
            .unwrap()
            .replace('\\', "/")
    }

    async fn prepare(
        &self,
        name: &str,
        bytes: &[u8],
        overwrite: bool,
    ) -> (TransferRegistry, Arc<TransferEntry>) {
        let target = self.path(name);
        let target_snapshot = upload_target_snapshot(&self.session, &target, overwrite)
            .await
            .unwrap();
        let staging = temporary_remote_path(
            &self.directory.path().to_str().unwrap().replace('\\', "/"),
            "upload",
        )
        .unwrap();
        let file = create_upload_staging(&self.session, &staging, true)
            .await
            .unwrap();
        let entry = Arc::new(TransferEntry {
            windows_permissions: true,
            target_snapshot,
            state: Mutex::new(TransferState {
                transfer_id: "windows-upload".into(),
                session_id: "test".into(),
                kind: "upload",
                name: name.into(),
                remote_path: target,
                local_path: None,
                bytes_done: 0,
                total_bytes: Some(bytes.len() as u64),
                state: "running",
                detail: None,
            }),
            cancel: AtomicBool::new(false),
            upload: AsyncMutex::new(Some(file)),
            upload_session: Some(Arc::clone(&self.session)),
            staging_path: Some(staging),
            overwrite,
            target_gate: Arc::default(),
        });
        let transfers = TransferRegistry::new();
        transfers.insert(Arc::clone(&entry)).unwrap();
        for chunk in bytes.chunks(REMOTE_CHUNK) {
            let encoded = base64::engine::general_purpose::STANDARD.encode(chunk);
            upload_chunk(&transfers, &QuietSink, "windows-upload", &encoded)
                .await
                .unwrap();
        }
        (transfers, entry)
    }

    fn assert_no_staging(&self) {
        for entry in std::fs::read_dir(self.directory.path()).unwrap() {
            assert!(!entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".latticeterm-"));
        }
    }

    async fn stop(mut self) {
        self.session.close().await.unwrap();
        self.child.kill().await.unwrap();
        self.child.wait().await.unwrap();
    }
}

async fn bounded(test: impl std::future::Future<Output = ()>) {
    tokio::time::timeout(std::time::Duration::from_secs(30), test)
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "Requires a verified Windows OpenSSH sftp-server.exe in the opt-in environment variable"]
async fn windows_openssh_concurrent_chunks_keep_complete_byte_count() {
    bounded(async {
        let server = WindowsServer::start().await;
        let (transfers, entry) = server.prepare("concurrent.bin", b"", false).await;
        let transfers = Arc::new(transfers);
        let chunk = vec![0x5a; REMOTE_CHUNK];
        let chunks = 16;
        let total = chunk.len() * chunks;
        entry.state.lock().unwrap().total_bytes = Some(total as u64);
        let encoded = base64::engine::general_purpose::STANDARD.encode(&chunk);
        let mut tasks = tokio::task::JoinSet::new();
        for _ in 0..chunks {
            let transfers = Arc::clone(&transfers);
            let encoded = encoded.clone();
            tasks.spawn(async move {
                upload_chunk(&transfers, &QuietSink, "windows-upload", &encoded).await
            });
        }
        while let Some(result) = tasks.join_next().await {
            result.unwrap().unwrap();
        }
        assert_eq!(entry.state.lock().unwrap().bytes_done, total as u64);
        finish_upload(&transfers, &QuietSink, "windows-upload")
            .await
            .unwrap();
        assert_eq!(
            std::fs::read(server.path("concurrent.bin")).unwrap(),
            vec![0x5a; total]
        );
        server.assert_no_staging();
        server.stop().await;
    })
    .await;
}

#[tokio::test]
#[ignore = "Requires a verified Windows OpenSSH sftp-server.exe in the opt-in environment variable"]
async fn windows_openssh_path_uploads_empty_large_and_changed_files() {
    bounded(async {
        let server = WindowsServer::start().await;
        let source = tempfile::tempdir().unwrap();
        let local_path = source.path().join("source.bin");
        for (size, changed) in [(0, false), (REMOTE_CHUNK * 3 + 17, false), (4, true)] {
            let payload = vec![0x5a; size];
            std::fs::write(&local_path, &payload).unwrap();
            let name = format!("path-{size}-{changed}.bin");
            let (_transfers, entry) = server.prepare(&name, b"", false).await;
            let declared = size as u64 + u64::from(changed);
            entry.state.lock().unwrap().total_bytes = Some(declared);
            let local = tokio::fs::File::open(&local_path).await.unwrap();
            let result = stream_path_upload(&entry, &QuietSink, local, declared).await;
            if changed {
                let detail = result.unwrap_err();
                assert!(detail.contains("changed size"));
                abort_upload(&entry, &QuietSink, "error", &detail).await;
                assert!(!Path::new(&server.path(&name)).exists());
                assert_eq!(entry.state.lock().unwrap().state, "error");
            } else {
                result.unwrap();
                assert_eq!(std::fs::read(server.path(&name)).unwrap(), payload);
                assert_eq!(entry.state.lock().unwrap().state, "done");
                assert_eq!(entry.state.lock().unwrap().bytes_done, declared);
            }
            server.assert_no_staging();
        }
        server.stop().await;
    })
    .await;
}

#[tokio::test]
#[ignore = "Requires a verified Windows OpenSSH sftp-server.exe in the opt-in environment variable"]
async fn windows_openssh_uploads_new_and_replacement_files() {
    bounded(async {
        let server = WindowsServer::start().await;
        let payload = vec![0x5a; REMOTE_CHUNK * 3 + 17];
        for overwrite in [false, true] {
            let (transfers, entry) = server.prepare("report.txt", &payload, overwrite).await;
            finish_upload(&transfers, &QuietSink, "windows-upload")
                .await
                .unwrap();
            assert_eq!(std::fs::read(server.path("report.txt")).unwrap(), payload);
            let state = entry.state.lock().unwrap();
            assert_eq!(state.state, "done");
            assert!(state.detail.as_ref().unwrap().contains("ACL"));
            drop(state);
            server.assert_no_staging();
        }
        server.stop().await;
    })
    .await;
}

#[tokio::test]
#[ignore = "Requires a verified Windows OpenSSH sftp-server.exe in the opt-in environment variable"]
async fn windows_openssh_keeps_strict_uploads_fail_closed_and_collisions_intact() {
    bounded(async {
        let server = WindowsServer::start().await;
        let strict_path = server.path("strict.part");
        assert!(create_upload_staging(&server.session, &strict_path, false)
            .await
            .is_err());
        assert!(!Path::new(&strict_path).exists());
        let collision = server.path("collision.part");
        std::fs::write(&collision, b"original").unwrap();
        assert!(create_upload_staging(&server.session, &collision, true)
            .await
            .is_err());
        assert_eq!(std::fs::read(collision).unwrap(), b"original");
        server.stop().await;
    })
    .await;
}

#[tokio::test]
#[ignore = "Requires a verified Windows OpenSSH sftp-server.exe in the opt-in environment variable"]
async fn windows_openssh_cancellation_keeps_the_original_file() {
    bounded(async {
        let server = WindowsServer::start().await;
        std::fs::write(server.path("report.txt"), b"original").unwrap();
        let (transfers, entry) = server.prepare("report.txt", b"replacement", true).await;
        cancel(&transfers, &QuietSink, "windows-upload")
            .await
            .unwrap();
        assert_eq!(entry.state.lock().unwrap().state, "cancelled");
        assert_eq!(
            std::fs::read(server.path("report.txt")).unwrap(),
            b"original"
        );
        server.assert_no_staging();
        server.stop().await;
    })
    .await;
}

#[tokio::test]
#[ignore = "Requires a verified Windows OpenSSH sftp-server.exe in the opt-in environment variable"]
async fn windows_openssh_refuses_changed_targets_and_staging_files() {
    bounded(async {
        let server = WindowsServer::start().await;
        for change_target in [false, true] {
            std::fs::write(server.path("report.txt"), b"original").unwrap();
            let (transfers, entry) = server.prepare("report.txt", b"replacement", true).await;
            if change_target {
                std::fs::write(server.path("report.txt"), b"external update").unwrap();
            } else {
                entry
                    .upload
                    .lock()
                    .await
                    .take()
                    .unwrap()
                    .shutdown()
                    .await
                    .unwrap();
                std::fs::write(entry.staging_path.as_ref().unwrap(), b"changed").unwrap();
            }
            let result = if change_target {
                finish_upload(&transfers, &QuietSink, "windows-upload").await
            } else {
                let detail = promote_upload(&entry).await.unwrap_err();
                Err(abort_upload(&entry, &QuietSink, "error", &detail).await)
            };
            assert!(result.unwrap_err().contains("changed"));
            let expected = if change_target {
                b"external update".as_slice()
            } else {
                b"original"
            };
            assert_eq!(std::fs::read(server.path("report.txt")).unwrap(), expected);
            server.assert_no_staging();
        }
        server.stop().await;
    })
    .await;
}

#[tokio::test]
#[ignore = "Requires a verified Windows OpenSSH sftp-server.exe in the opt-in environment variable"]
async fn windows_openssh_refuses_read_only_replacements() {
    bounded(async {
        let server = WindowsServer::start().await;
        let target = server.path("report.txt");
        std::fs::write(&target, b"original").unwrap();
        let original_permissions = std::fs::metadata(&target).unwrap().permissions();
        let mut permissions = original_permissions.clone();
        permissions.set_readonly(true);
        std::fs::set_permissions(&target, permissions).unwrap();
        let (transfers, _) = server.prepare("report.txt", b"replacement", true).await;
        let result = finish_upload(&transfers, &QuietSink, "windows-upload").await;
        std::fs::set_permissions(&target, original_permissions).unwrap();
        assert!(result.is_err());
        assert_eq!(std::fs::read(target).unwrap(), b"original");
        server.assert_no_staging();
        server.stop().await;
    })
    .await;
}
