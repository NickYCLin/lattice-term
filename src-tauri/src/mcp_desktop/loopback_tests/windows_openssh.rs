use super::*;
use crate::sftp::{SftpConnectOutcome, SftpConnectRequest};

#[tokio::test]
#[ignore = "Requires a verified LATTICETERM_TEST_WINDOWS_SFTP_SERVER executable"]
async fn windows_openssh_mcp_upload_download_conflict_and_revocation() {
    crate::mcp_desktop::loopback_tests::bounded(async {
        let remote = tempfile::tempdir().unwrap();
        let local = tempfile::tempdir().unwrap();
        let peer = Peer::start_with_sftp(SftpMode::WindowsOpenSsh {
            directory: Arc::new(remote.path().into()),
        })
        .await;
        let registry = Arc::new(SftpRegistry::new());
        let outcome = crate::sftp::connect(
            registry.clone(),
            Some(peer.known.clone()),
            SftpConnectRequest {
                profile_id: "isolated-windows".into(),
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
            panic!("isolated connection failed")
        };
        assert!(registry.windows_server(&session.session_id).unwrap());
        let service = Arc::new(DesktopService::new(
            Arc::new(SshRegistry::new()),
            registry.clone(),
        ));
        let target = service
            .grant(GrantRequest {
                fleet: None,
                session_id: session.session_id.clone(),
                backend: Backend::Sftp,
                label: "Isolated Windows".into(),
                scopes: Scopes {
                    list: true,
                    upload: true,
                    download: true,
                    ..Default::default()
                },
                exec_plans: vec![],
                roots: vec![RootRequest {
                    id: "files".into(),
                    label: "Isolated root".into(),
                    remote_path: session.current_path.clone(),
                    local_path: Some(local.path().to_string_lossy().into_owned()),
                }],
            })
            .await
            .unwrap();
        let payload = "部署測試🙂".repeat(50000).into_bytes();
        std::fs::write(local.path().join("source.bin"), &payload).unwrap();
        for (name, bytes) in [
            ("upload.bin", payload.as_slice()),
            ("empty.bin", b"".as_slice()),
        ] {
            std::fs::write(local.path().join(name), bytes).unwrap();
            let root = paths::prepare_root(
                &registry.session(&session.session_id).unwrap(),
                &RootRequest {
                    id: "files".into(),
                    label: "Isolated root".into(),
                    remote_path: session.current_path.clone(),
                    local_path: Some(local.path().to_string_lossy().into_owned()),
                },
            )
            .await
            .unwrap();
            let started = service
                .execute(
                    "client",
                    DesktopOperation::Transfer {
                        target_id: target.id.clone(),
                        root_id: "files".into(),
                        direction: TransferDirection::Upload,
                        local_path: name.into(),
                        remote_path: name.into(),
                        request_id: format!("upload-{name}"),
                    },
                )
                .await
                .unwrap();
            let result = loop {
                let result = service
                    .execute(
                        "client",
                        DesktopOperation::OperationStatus {
                            target_id: target.id.clone(),
                            operation_id: started["operationId"].as_str().unwrap().into(),
                        },
                    )
                    .await
                    .unwrap();
                if result["state"] != "running" {
                    break result;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            };
            assert_eq!(result["state"], "completed", "{result:?}");
            assert_eq!(result["bytes"], bytes.len());
            assert!(result["permissionNotice"].as_str().unwrap().contains("ACL"));
            assert_eq!(std::fs::read(remote.path().join(name)).unwrap(), bytes);
            let (_, revoked) = watch::channel(false);
            let (_, cancel) = watch::channel(false);
            assert!(paths::transfer(
                &registry,
                &session.session_id,
                &root,
                TransferDirection::Upload,
                name,
                name,
                revoked,
                cancel
            )
            .await
            .is_err());
            assert_eq!(std::fs::read(remote.path().join(name)).unwrap(), bytes);
            let (_, revoked) = watch::channel(false);
            let (_, cancel) = watch::channel(false);
            paths::transfer(
                &registry,
                &session.session_id,
                &root,
                TransferDirection::Download,
                "download.bin",
                name,
                revoked,
                cancel,
            )
            .await
            .unwrap();
            assert_eq!(
                std::fs::read(local.path().join("download.bin")).unwrap(),
                bytes
            );
            std::fs::remove_file(local.path().join("download.bin")).unwrap();
            for (remote_path, cancelled) in [
                ("../escape.bin", false),
                ("file:stream", false),
                ("cancelled.bin", true),
            ] {
                let (_, revoked) = watch::channel(false);
                let (_, cancel) = watch::channel(cancelled);
                assert!(paths::transfer(
                    &registry,
                    &session.session_id,
                    &root,
                    TransferDirection::Upload,
                    name,
                    remote_path,
                    revoked,
                    cancel
                )
                .await
                .is_err());
            }
        }
        service.revoke(&target.id).unwrap();
        assert!(service
            .execute(
                "client",
                DesktopOperation::Transfer {
                    target_id: target.id,
                    root_id: "files".into(),
                    direction: TransferDirection::Upload,
                    local_path: "source.bin".into(),
                    remote_path: "revoked.bin".into(),
                    request_id: "revoked".into()
                }
            )
            .await
            .is_err());
        assert!(!remote.path().join("revoked.bin").exists());
        assert_eq!(std::fs::read_dir(remote.path()).unwrap().count(), 2);
        crate::sftp::disconnect(&registry, &session.session_id)
            .await
            .unwrap();
    })
    .await;
}
