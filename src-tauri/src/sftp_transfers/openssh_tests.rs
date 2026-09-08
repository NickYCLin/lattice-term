use super::*;
use crate::sftp_test_server::{bounded, OpenSshServer};
use std::os::unix::fs::{symlink, PermissionsExt};

struct QuietSink;
impl TransferSink for QuietSink {
    fn update(&self, _: &TransferState) {}
}

// Enter at the production staging/write/finish/cancel boundary. The registry's
// SSH handle is intentionally outside this subsystem-only interoperability test.
async fn prepare_upload(
    server: &OpenSshServer,
    session: Arc<SftpSession>,
    name: &str,
    size: u64,
    overwrite: bool,
) -> (TransferRegistry, Arc<TransferEntry>) {
    let staging =
        temporary_remote_path(server.directory.path().to_str().unwrap(), "upload").unwrap();
    let file = create_private_upload(&session, &staging).await.unwrap();
    let entry = Arc::new(TransferEntry {
        state: Mutex::new(TransferState {
            transfer_id: "test-upload".into(),
            session_id: "openssh".into(),
            kind: "upload",
            name: name.into(),
            remote_path: server.path(name),
            local_path: None,
            bytes_done: 0,
            total_bytes: Some(size),
            state: "running",
            detail: None,
        }),
        cancel: AtomicBool::new(false),
        upload: AsyncMutex::new(Some(file)),
        upload_session: Some(session),
        staging_path: Some(staging),
        overwrite,
        target_gate: Arc::default(),
    });
    let registry = TransferRegistry::new();
    registry.insert(Arc::clone(&entry)).unwrap();
    (registry, entry)
}

async fn send(registry: &TransferRegistry, bytes: &[u8]) {
    upload_chunk(
        registry,
        &QuietSink,
        "test-upload",
        &base64::engine::general_purpose::STANDARD.encode(bytes),
    )
    .await
    .unwrap();
}

fn mode(path: impl AsRef<Path>) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn assert_no_staging(server: &OpenSshServer) {
    for entry in std::fs::read_dir(server.directory.path()).unwrap() {
        assert!(!entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".latticeterm-"));
    }
}

#[tokio::test]
#[ignore = "Requires the local OpenSSH sftp-server; CI runs these explicitly"]
async fn openssh_upload_cannot_publish_while_text_editor_holds_target_gate() {
    bounded(async {
        let (server, stream) = OpenSshServer::start(None);
        let session = Arc::new(SftpSession::new(stream).await.unwrap());
        std::fs::write(server.path("notes"), b"original").unwrap();
        let (registry, entry) = prepare_upload(&server, session, "notes", 3, true).await;
        send(&registry, b"new").await;
        let _editor = entry.target_gate.lock().await;
        let error = finish_upload(&registry, &QuietSink, "test-upload")
            .await
            .unwrap_err();
        assert!(error.contains("another file operation"), "{error}");
        assert_eq!(std::fs::read(server.path("notes")).unwrap(), b"original");
        assert_eq!(entry.state.lock().unwrap().state, "error");
        assert_no_staging(&server);
        server.stop().await;
    })
    .await;
}

#[tokio::test]
#[ignore = "Requires the local OpenSSH sftp-server; CI runs these explicitly"]
async fn openssh_private_upload_roundtrips_large_payload() {
    bounded(async {
        let (server, stream) = OpenSshServer::start(None);
        let session = Arc::new(SftpSession::new(stream).await.unwrap());
        // Cross both the packet limit and normal remote read chunk boundary.
        let bytes: Vec<u8> = (0..2 * 1024 * 1024 + 17).map(|n| (n % 251) as u8).collect();
        let (registry, entry) = prepare_upload(
            &server,
            Arc::clone(&session),
            "data.bin",
            bytes.len() as u64,
            false,
        )
        .await;
        assert_eq!(mode(entry.staging_path.as_ref().unwrap()), 0o600);
        send(&registry, &bytes).await;
        assert!(!Path::new(&server.path("data.bin")).exists());
        finish_upload(&registry, &QuietSink, "test-upload")
            .await
            .unwrap();
        assert_eq!(entry.state.lock().unwrap().state, "done");
        assert_eq!(mode(server.path("data.bin")), 0o600);
        assert_eq!(std::fs::read(server.path("data.bin")).unwrap(), bytes);
        let mut remote = session.open(server.path("data.bin")).await.unwrap();
        let mut actual = Vec::new();
        let mut buffer = vec![0; REMOTE_CHUNK];
        loop {
            let count = remote.read(&mut buffer).await.unwrap();
            if count == 0 {
                break;
            }
            actual.extend_from_slice(&buffer[..count]);
        }
        assert_eq!(actual, bytes);
        remote.shutdown().await.unwrap();
        assert_no_staging(&server);
        server.stop().await;
    })
    .await;
}

#[tokio::test]
#[ignore = "Requires the local OpenSSH sftp-server; CI runs these explicitly"]
async fn openssh_overwrite_restricts_access_and_preserves_owner_modes() {
    bounded(async {
        let (server, stream) = OpenSshServer::start(None);
        let session = Arc::new(SftpSession::new(stream).await.unwrap());
        for original_mode in [0o640, 0o755, 0o700] {
            let target = server.path("report.txt");
            std::fs::write(&target, b"original").unwrap();
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(original_mode))
                .unwrap();
            let (registry, entry) =
                prepare_upload(&server, Arc::clone(&session), "report.txt", 3, true).await;
            send(&registry, b"new").await;
            assert_eq!(std::fs::read(&target).unwrap(), b"original");
            finish_upload(&registry, &QuietSink, "test-upload")
                .await
                .unwrap();
            assert_eq!(std::fs::read(&target).unwrap(), b"new");
            assert_eq!(mode(&target), original_mode & 0o700);
            assert_eq!(
                entry.state.lock().unwrap().detail.is_some(),
                original_mode & 0o077 != 0
            );
            assert_no_staging(&server);
        }
        server.stop().await;
    })
    .await;
}

#[tokio::test]
#[ignore = "Requires the local OpenSSH sftp-server; CI runs these explicitly"]
async fn openssh_cancelled_and_incomplete_uploads_preserve_original() {
    bounded(async {
        let (server, stream) = OpenSshServer::start(None);
        let session = Arc::new(SftpSession::new(stream).await.unwrap());
        for cancelled in [true, false] {
            let target = server.path("report.txt");
            std::fs::write(&target, b"original").unwrap();
            let (registry, entry) =
                prepare_upload(&server, Arc::clone(&session), "report.txt", 100, true).await;
            send(&registry, b"partial").await;
            if cancelled {
                cancel(&registry, &QuietSink, "test-upload").await.unwrap();
            } else {
                assert!(finish_upload(&registry, &QuietSink, "test-upload")
                    .await
                    .is_err());
            }
            assert_eq!(
                entry.state.lock().unwrap().state,
                if cancelled { "cancelled" } else { "error" }
            );
            assert_eq!(std::fs::read(&target).unwrap(), b"original");
            assert_no_staging(&server);
        }
        server.stop().await;
    })
    .await;
}

#[tokio::test]
#[ignore = "Requires the local OpenSSH sftp-server; CI runs these explicitly"]
async fn openssh_conflicting_files_symlinks_and_directories_are_preserved() {
    bounded(async {
        let (server, stream) = OpenSshServer::start(None);
        let session = Arc::new(SftpSession::new(stream).await.unwrap());
        for target_type in ["file", "symlink", "dangling", "directory"] {
            let target = server.path(target_type);
            let (registry, entry) = prepare_upload(
                &server,
                Arc::clone(&session),
                target_type,
                3,
                target_type != "file",
            )
            .await;
            send(&registry, b"new").await;
            match target_type {
                "file" => std::fs::write(&target, b"appeared during upload").unwrap(),
                "directory" => std::fs::create_dir(&target).unwrap(),
                "symlink" => {
                    std::fs::write(server.path("original"), b"keep me").unwrap();
                    symlink(server.path("original"), &target).unwrap();
                }
                _ => symlink(server.path("missing"), &target).unwrap(),
            }
            assert!(
                finish_upload(&registry, &QuietSink, "test-upload")
                    .await
                    .is_err(),
                "must reject {target_type}"
            );
            assert_eq!(entry.state.lock().unwrap().state, "error");
            let metadata = std::fs::symlink_metadata(&target).unwrap();
            match target_type {
                "file" => assert_eq!(std::fs::read(&target).unwrap(), b"appeared during upload"),
                "directory" => assert!(metadata.is_dir()),
                _ => assert!(metadata.file_type().is_symlink()),
            }
            assert!(!Path::new(&server.path("missing")).exists());
            assert_no_staging(&server);
        }
        assert_eq!(std::fs::read(server.path("original")).unwrap(), b"keep me");
        server.stop().await;
    })
    .await;
}

#[tokio::test]
#[ignore = "Requires the local OpenSSH sftp-server; CI runs these explicitly"]
async fn openssh_exclusive_staging_never_truncates_existing_paths() {
    bounded(async {
        let (server, stream) = OpenSshServer::start(None);
        let session = SftpSession::new(stream).await.unwrap();
        std::fs::write(server.path("original"), b"keep me").unwrap();
        symlink(server.path("original"), server.path("link")).unwrap();
        symlink(server.path("missing"), server.path("dangling")).unwrap();
        for name in ["original", "link", "dangling"] {
            assert!(create_private_upload(&session, &server.path(name))
                .await
                .is_err());
        }
        assert_eq!(std::fs::read(server.path("original")).unwrap(), b"keep me");
        assert!(std::fs::symlink_metadata(server.path("link"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(std::fs::symlink_metadata(server.path("dangling"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(!Path::new(&server.path("missing")).exists());
        server.stop().await;
    })
    .await;
}

#[tokio::test]
#[ignore = "Requires the local OpenSSH sftp-server; CI runs these explicitly"]
async fn openssh_permission_refusal_preserves_original_and_removes_staging() {
    bounded(async {
        let (server, stream) = OpenSshServer::start(Some("setstat"));
        let session = Arc::new(SftpSession::new(stream).await.unwrap());
        std::fs::write(server.path("report.txt"), b"original").unwrap();
        let (registry, entry) = prepare_upload(&server, session, "report.txt", 3, true).await;
        send(&registry, b"new").await;
        let error = finish_upload(&registry, &QuietSink, "test-upload")
            .await
            .unwrap_err();
        assert!(error.contains("could not restrict"), "{error}");
        assert_eq!(entry.state.lock().unwrap().state, "error");
        assert_eq!(
            std::fs::read(server.path("report.txt")).unwrap(),
            b"original"
        );
        assert_no_staging(&server);
        server.stop().await;
    })
    .await;
}
