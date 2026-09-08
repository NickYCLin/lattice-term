//! The SSH server is the isolated russh peer above; file protocol requests go
//! through the encrypted channel to the real OpenSSH sftp-server executable.
//! This is not an OpenSSH sshd or a production-host/GUI acceptance test.

use super::*;
use crate::sftp::{SftpConnectOutcome, SftpConnectRequest, SftpSessionSummary};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

struct Fixture {
    _peer: Peer,
    sftp: Arc<SftpRegistry>,
    session: SftpSessionSummary,
    service: Arc<DesktopService>,
    local: tempfile::TempDir,
    remote: PathBuf,
    target: TargetView,
}

impl Fixture {
    async fn start(denied_requests: Option<&'static str>) -> Self {
        let peer = Peer::start_with_sftp(SftpMode::OpenSsh { denied_requests }).await;
        let sftp = Arc::new(SftpRegistry::new());
        let outcome = crate::sftp::connect(
            Arc::clone(&sftp),
            Some(peer.known.clone()),
            SftpConnectRequest {
                profile_id: "isolated-sftp".into(),
                hostname: "127.0.0.1".into(),
                port: peer.port,
                username: "isolated-test".into(),
                auth: AuthMethod::Password {
                    password: peer.password.clone(),
                },
                use_saved_password: false,
                remember_password: false,
            },
        )
        .await;
        let SftpConnectOutcome::Connected { session } = outcome else {
            panic!("isolated SSH/SFTP connection did not start")
        };
        let remote = PathBuf::from(&session.current_path).join("approved");
        std::fs::create_dir(&remote).unwrap();
        let local = tempfile::tempdir().unwrap();
        let service = Arc::new(DesktopService::new(
            Arc::new(SshRegistry::new()),
            Arc::clone(&sftp),
        ));
        let target = service
            .grant(GrantRequest {
                session_id: session.session_id.clone(),
                backend: Backend::Sftp,
                label: "Isolated transfer workspace".into(),
                scopes: Scopes {
                    list: true,
                    upload: true,
                    download: true,
                    ..Default::default()
                },
                exec_plans: vec![],
                roots: vec![RootRequest {
                    id: "workspace".into(),
                    label: "Approved workspace".into(),
                    remote_path: remote.to_str().unwrap().into(),
                    local_path: Some(
                        local
                            .path()
                            .canonicalize()
                            .unwrap()
                            .to_str()
                            .unwrap()
                            .into(),
                    ),
                }],
            })
            .await
            .unwrap();
        Self {
            _peer: peer,
            sftp,
            session,
            service,
            local,
            remote,
            target,
        }
    }

    fn transfer(
        &self,
        direction: TransferDirection,
        local: &str,
        remote: &str,
        request_id: &str,
    ) -> DesktopOperation {
        DesktopOperation::Transfer {
            target_id: self.target.id.clone(),
            root_id: "workspace".into(),
            direction,
            local_path: local.into(),
            remote_path: remote.into(),
            request_id: request_id.into(),
        }
    }

    async fn wait(&self, operation_id: &str) -> Result<Value, ServiceError> {
        loop {
            let result = self
                .service
                .execute(
                    "client",
                    DesktopOperation::OperationStatus {
                        target_id: self.target.id.clone(),
                        operation_id: operation_id.into(),
                    },
                )
                .await?;
            if result["state"] != "running" {
                return Ok(result);
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    async fn run(&self, operation: DesktopOperation) -> Result<Value, ServiceError> {
        let accepted = self.service.execute("client", operation).await?;
        self.wait(
            accepted["operationId"]
                .as_str()
                .expect("write response has an operation ID"),
        )
        .await
    }

    async fn close(&self) {
        self.service.revoke_all();
        crate::sftp::disconnect(&self.sftp, &self.session.session_id)
            .await
            .unwrap();
    }
}

fn filenames(directory: &Path) -> BTreeSet<String> {
    std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect()
}

#[tokio::test]
#[ignore = "Requires local OpenSSH sftp-server; CI runs openssh_ tests explicitly"]
async fn openssh_mcp_retained_sftp_entry_is_not_live_after_transport_disconnect() {
    crate::sftp_test_server::bounded(async {
        let fixture = Fixture::start(None).await;
        assert!(fixture
            .sftp
            .connected_session(&fixture.session.session_id)
            .is_some());
        fixture._peer.shutdown.send_replace(true);
        tokio::time::timeout(Duration::from_secs(3), async {
            while fixture
                .sftp
                .connected_session(&fixture.session.session_id)
                .is_some()
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("SFTP transport did not close");
        assert!(fixture.sftp.session(&fixture.session.session_id).is_ok());
        assert!(!fixture.service.targets()[0].connected);
        let error = fixture
            .service
            .execute(
                "client",
                DesktopOperation::ListDirectory {
                    target_id: fixture.target.id.clone(),
                    root_id: "workspace".into(),
                    path: String::new(),
                },
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "not_authorized");
        fixture.service.revoke_all();
    })
    .await;
}

#[tokio::test]
#[ignore = "Requires local OpenSSH sftp-server; CI runs openssh_ tests explicitly"]
async fn openssh_mcp_registry_transfers_are_scoped_hashed_deduplicated_and_revocable() {
    crate::sftp_test_server::bounded(async {
        let fixture = Fixture::start(None).await;
        std::fs::write(fixture.remote.join("existing.txt"), b"keep remote original").unwrap();
        let bytes = "傳檔驗收\n".repeat(40_000).into_bytes();
        std::fs::write(fixture.local.path().join("source.txt"), &bytes).unwrap();
        let connections = fixture
            .service
            .execute("client", DesktopOperation::ListConnections)
            .await
            .unwrap();
        assert_eq!(connections["connections"].as_array().unwrap().len(), 1);
        let public = connections.to_string();
        assert!(!public.contains(&fixture.session.current_path));
        assert!(!public.contains("127.0.0.1"));
        assert!(!public.contains(&fixture.session.session_id));

        let listing = fixture
            .service
            .execute(
                "client",
                DesktopOperation::ListDirectory {
                    target_id: fixture.target.id.clone(),
                    root_id: "workspace".into(),
                    path: "".into(),
                },
            )
            .await
            .unwrap();
        assert_eq!(listing["entries"][0]["path"], "existing.txt");
        assert!(!listing.to_string().contains(&fixture.session.current_path));
        assert!(fixture
            .service
            .execute(
                "client",
                DesktopOperation::ListDirectory {
                    target_id: fixture.target.id.clone(),
                    root_id: "workspace".into(),
                    path: "../".into()
                }
            )
            .await
            .is_err());

        // Invalid path IDs/shapes never take a write-ledger slot.
        let before = fixture.service.state.lock().unwrap().operations.len();
        assert!(fixture
            .service
            .execute(
                "client",
                fixture.transfer(
                    TransferDirection::Upload,
                    "../private",
                    "escape",
                    "invalid-shape"
                )
            )
            .await
            .is_err());
        assert_eq!(
            fixture.service.state.lock().unwrap().operations.len(),
            before
        );

        let operation = fixture.transfer(
            TransferDirection::Upload,
            "source.txt",
            "uploaded.txt",
            "upload-1",
        );
        let started = fixture
            .service
            .execute("client", operation.clone())
            .await
            .unwrap();
        let duplicate = fixture
            .service
            .execute("client", operation.clone())
            .await
            .unwrap();
        assert_eq!(started["operationId"], duplicate["operationId"]);
        let uploaded = fixture
            .wait(started["operationId"].as_str().unwrap())
            .await
            .unwrap();
        assert_eq!(uploaded["state"], "completed");
        assert_eq!(uploaded["bytes"], bytes.len());
        assert_eq!(uploaded["sha256"], sha256(&bytes));
        assert_eq!(
            std::fs::read(fixture.remote.join("uploaded.txt")).unwrap(),
            bytes
        );
        let replay = fixture.service.execute("client", operation).await.unwrap();
        assert_eq!(replay["operationId"], started["operationId"]);
        assert_eq!(replay["duplicate"], true);
        assert_eq!(
            filenames(&fixture.remote),
            BTreeSet::from(["existing.txt".into(), "uploaded.txt".into()])
        );

        let downloaded = fixture
            .run(fixture.transfer(
                TransferDirection::Download,
                "download.txt",
                "uploaded.txt",
                "download-1",
            ))
            .await
            .unwrap();
        assert_eq!(downloaded["sha256"], uploaded["sha256"]);
        assert_eq!(
            std::fs::read(fixture.local.path().join("download.txt")).unwrap(),
            bytes
        );

        let collision = fixture
            .run(fixture.transfer(
                TransferDirection::Upload,
                "source.txt",
                "existing.txt",
                "upload-conflict",
            ))
            .await
            .unwrap_err();
        assert_eq!(collision.code, "file_conflict");
        assert_eq!(
            std::fs::read(fixture.remote.join("existing.txt")).unwrap(),
            b"keep remote original"
        );
        let collision = fixture
            .run(fixture.transfer(
                TransferDirection::Download,
                "source.txt",
                "existing.txt",
                "download-conflict",
            ))
            .await
            .unwrap_err();
        assert_eq!(collision.code, "file_conflict");
        assert_eq!(
            std::fs::read(fixture.local.path().join("source.txt")).unwrap(),
            bytes
        );

        fixture.service.revoke(&fixture.target.id).unwrap();
        assert!(fixture
            .service
            .execute(
                "client",
                fixture.transfer(
                    TransferDirection::Upload,
                    "source.txt",
                    "after-revoke.txt",
                    "revoked"
                )
            )
            .await
            .is_err());
        assert!(fixture
            .service
            .execute(
                "client",
                DesktopOperation::OperationStatus {
                    target_id: fixture.target.id.clone(),
                    operation_id: started["operationId"].as_str().unwrap().into()
                }
            )
            .await
            .is_err());
        assert!(!fixture.remote.join("after-revoke.txt").exists());
        assert_eq!(
            fixture.sftp.list().len(),
            1,
            "revocation does not disconnect the user's SFTP session"
        );
        let ui_listing = crate::sftp::list_directory(
            &fixture.sftp,
            &fixture.session.session_id,
            fixture.remote.to_str().unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(ui_listing.entries.len(), 2);
        fixture.close().await;
    })
    .await;
}

#[tokio::test]
#[ignore = "Requires local OpenSSH sftp-server; CI runs openssh_ tests explicitly"]
async fn openssh_mcp_publish_refusal_keeps_the_original_and_cleans_partial_uploads() {
    crate::sftp_test_server::bounded(async {
        // Real OpenSSH handles every upload write, then refuses publication.
        // This exercises a partial operation, not a preflight-only rejection.
        let fixture = Fixture::start(Some("rename")).await;
        std::fs::write(fixture.remote.join("original.txt"), b"untouched").unwrap();
        std::fs::write(
            fixture.local.path().join("source.bin"),
            vec![42; 1024 * 1024],
        )
        .unwrap();
        let operation = fixture.transfer(
            TransferDirection::Upload,
            "source.bin",
            "not-published.bin",
            "refused-publish",
        );
        let accepted = fixture
            .service
            .execute("client", operation.clone())
            .await
            .unwrap();
        let error = fixture
            .wait(accepted["operationId"].as_str().unwrap())
            .await
            .unwrap_err();
        assert_eq!(error.code, "unknown_outcome");
        let replay = fixture
            .service
            .execute("client", operation)
            .await
            .unwrap_err();
        assert_eq!(replay, error, "an uncertain upload is not attempted again");
        tokio::time::timeout(Duration::from_secs(6), async {
            while filenames(&fixture.remote) != BTreeSet::from(["original.txt".into()]) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("failed publication left a staging file or final destination behind");
        assert_eq!(
            std::fs::read(fixture.remote.join("original.txt")).unwrap(),
            b"untouched"
        );
        assert!(!fixture.remote.join("not-published.bin").exists());
        fixture.close().await;
    })
    .await;
}
