use super::*;
use crate::sftp_test_server::{bounded, OpenSshServer};
use std::os::unix::fs::{symlink, PermissionsExt};

fn write(server: &OpenSshServer, name: &str, bytes: &[u8], mode: u32) {
    std::fs::write(server.path(name), bytes).unwrap();
    std::fs::set_permissions(server.path(name), std::fs::Permissions::from_mode(mode)).unwrap();
}

fn assert_no_staging(server: &OpenSshServer) {
    for entry in std::fs::read_dir(server.directory.path()).unwrap() {
        assert!(!entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".latticeterm-edit-staging-"));
    }
}

#[tokio::test]
#[ignore = "Requires the local OpenSSH sftp-server; CI runs these explicitly"]
async fn openssh_text_shared_access_requires_explicit_confirmation_each_save() {
    bounded(async {
        let (server, stream) = OpenSshServer::start(None);
        let session = SftpSession::new(stream).await.unwrap();
        write(&server, "shared", b"original", 0o640);
        let path = server.path("shared");
        let document = read_snapshot(&session, &path)
            .await
            .unwrap()
            .into_file(&path);
        assert!(document.requires_access_confirmation);
        assert!(document
            .warning
            .as_deref()
            .unwrap()
            .contains("additional users"));
        let error = save_on_session(&session, &path, "edit", &document.revision, false)
            .await
            .unwrap_err();
        assert!(error.contains("Explicit confirmation"), "{error}");
        assert_eq!(std::fs::read(&path).unwrap(), b"original");
        assert_eq!(
            std::fs::read_dir(server.directory.path()).unwrap().count(),
            1
        );
        let saved = save_on_session(&session, &path, "edit", &document.revision, true)
            .await
            .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"edit");
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640
        );
        assert!(saved.requires_access_confirmation);
        assert!(
            save_on_session(&session, &path, "second", &saved.revision, false)
                .await
                .unwrap_err()
                .contains("Explicit confirmation")
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"edit");
        assert_eq!(
            std::fs::read_dir(server.directory.path()).unwrap().count(),
            2
        );
        assert_no_staging(&server);
        server.stop().await;
    })
    .await;
}

#[tokio::test]
#[ignore = "Requires the local OpenSSH sftp-server; CI runs these explicitly"]
async fn openssh_text_owner_only_save_needs_no_access_confirmation() {
    bounded(async {
        let (server, stream) = OpenSshServer::start(None);
        let session = SftpSession::new(stream).await.unwrap();
        write(&server, "private", b"original", 0o600);
        let path = server.path("private");
        let document = read_snapshot(&session, &path)
            .await
            .unwrap()
            .into_file(&path);
        assert!(!document.requires_access_confirmation);
        assert!(document.warning.is_some());
        let saved = save_on_session(&session, &path, "edit", &document.revision, false)
            .await
            .unwrap();
        assert!(!saved.requires_access_confirmation);
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"edit");
        assert_no_staging(&server);
        server.stop().await;
    })
    .await;
}

#[tokio::test]
#[ignore = "Requires the local OpenSSH sftp-server; CI runs these explicitly"]
async fn openssh_text_save_preserves_text_permissions_and_recovery_copy() {
    bounded(async {
        let (server, stream) = OpenSshServer::start(None);
        let session = SftpSession::new(stream).await.unwrap();
        let path = server.path(" 報表.txt ");
        write(
            &server,
            " 報表.txt ",
            "\u{feff}原始\r\n\t內容\r\n".as_bytes(),
            0o640,
        );
        let original = read_snapshot(&session, &path).await.unwrap();
        let content = "\u{feff}新內容\r\n\t中文\r\n";
        let saved = save_on_session(&session, &path, content, &original.revision(&path), true)
            .await
            .unwrap();
        assert_eq!(saved.content, content);
        assert_eq!(std::fs::read(&path).unwrap(), content.as_bytes());
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640
        );
        assert_eq!(
            std::fs::read(saved.backup_path.as_ref().unwrap()).unwrap(),
            original.content.as_bytes()
        );
        let reread = read_snapshot(&session, &path).await.unwrap();
        assert_eq!(saved.revision, reread.revision(&path));
        assert_eq!(reread.attributes.uid, original.attributes.uid);
        assert_eq!(reread.attributes.gid, original.attributes.gid);
        assert!(saved.warning.as_deref().unwrap().contains("not an atomic"));
        let second = save_on_session(&session, &path, "第二次", &saved.revision, true)
            .await
            .unwrap();
        assert_ne!(saved.backup_path, second.backup_path);
        assert_eq!(
            std::fs::read(second.backup_path.unwrap()).unwrap(),
            content.as_bytes()
        );
        assert_eq!(
            std::fs::read(saved.backup_path.unwrap()).unwrap(),
            original.content.as_bytes()
        );
        assert_no_staging(&server);
        server.stop().await;
    })
    .await;
}

#[tokio::test]
#[ignore = "Requires the local OpenSSH sftp-server; CI runs these explicitly"]
async fn openssh_text_conflicts_include_same_size_content_and_permissions() {
    bounded(async {
        let (server, stream) = OpenSshServer::start(None);
        let session = SftpSession::new(stream).await.unwrap();
        let path = server.path("notes.txt");
        write(&server, "notes.txt", b"one", 0o600);
        let original = read_snapshot(&session, &path).await.unwrap();
        write(&server, "notes.txt", b"two", 0o600);
        session
            .set_metadata(
                &path,
                FileAttributes {
                    atime: Some(original.attributes.modified),
                    mtime: Some(original.attributes.modified),
                    ..FileAttributes::empty()
                },
            )
            .await
            .unwrap();
        let error = save_on_session(&session, &path, "mine", &original.revision(&path), true)
            .await
            .unwrap_err();
        assert!(error.contains("changed"), "{error}");
        assert_eq!(std::fs::read(&path).unwrap(), b"two");
        let current = read_snapshot(&session, &path).await.unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();
        assert!(
            save_on_session(&session, &path, "mine", &current.revision(&path), true)
                .await
                .unwrap_err()
                .contains("changed")
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"two");
        assert_no_staging(&server);
        server.stop().await;
    })
    .await;
}

#[tokio::test]
#[ignore = "Requires the local OpenSSH sftp-server; CI runs these explicitly"]
async fn openssh_text_refuses_binary_symlinks_large_and_read_only_files() {
    bounded(async {
        let (server, stream) = OpenSshServer::start(None);
        let session = SftpSession::new(stream).await.unwrap();
        write(&server, "binary", b"a\0b", 0o600);
        write(&server, "invalid-utf8", &[0xff, 0xfe], 0o600);
        write(&server, "read-only", b"original", 0o400);
        symlink(server.path("read-only"), server.path("link")).unwrap();
        std::fs::create_dir(server.path("folder")).unwrap();
        symlink(server.path("folder"), server.path("linked-folder")).unwrap();
        std::fs::write(server.path("folder/nested"), b"nested").unwrap();
        std::fs::File::create(server.path("large"))
            .unwrap()
            .set_len(MAX_TEXT_BYTES as u64 + 1)
            .unwrap();
        for name in [
            "binary",
            "invalid-utf8",
            "link",
            "folder",
            "linked-folder/nested",
            "large",
        ] {
            assert!(
                read_snapshot(&session, &server.path(name)).await.is_err(),
                "{name}"
            );
        }
        let path = server.path("read-only");
        let original = read_snapshot(&session, &path).await.unwrap();
        let error = save_on_session(&session, &path, "new", &original.revision(&path), false)
            .await
            .unwrap_err();
        assert!(error.contains("read-only"), "{error}");
        assert_eq!(std::fs::read(&path).unwrap(), b"original");
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o400
        );
        assert_no_staging(&server);
        server.stop().await;
    })
    .await;
}

#[tokio::test]
#[ignore = "Requires the local OpenSSH sftp-server; CI runs these explicitly"]
async fn openssh_text_failed_save_does_not_truncate_original() {
    bounded(async {
        for denied in ["rename", "fsetstat", "write"] {
            let (server, stream) = OpenSshServer::start(Some(denied));
            let session = SftpSession::new(stream).await.unwrap();
            write(&server, "notes", b"original bytes", 0o640);
            let path = server.path("notes");
            let original = read_snapshot(&session, &path).await.unwrap();
            assert!(
                save_on_session(
                    &session,
                    &path,
                    "new bytes",
                    &original.revision(&path),
                    true
                )
                .await
                .is_err(),
                "{denied}"
            );
            assert_eq!(std::fs::read(&path).unwrap(), b"original bytes", "{denied}");
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o640
            );
            assert_no_staging(&server);
            server.stop().await;
        }
    })
    .await;
}

#[tokio::test]
#[ignore = "Requires the local OpenSSH sftp-server; CI runs these explicitly"]
async fn openssh_text_rollback_never_overwrites_a_concurrent_destination() {
    bounded(async {
        let (server, stream) = OpenSshServer::start(None);
        let session = SftpSession::new(stream).await.unwrap();
        write(&server, "backup", b"original", 0o600);
        write(&server, "notes", b"concurrent writer", 0o600);
        let detail = restore_original(
            &session,
            &server.path("notes"),
            &server.path("backup"),
            "conflict".into(),
        )
        .await;
        assert!(detail.contains("recovery copy"), "{detail}");
        assert_eq!(
            std::fs::read(server.path("notes")).unwrap(),
            b"concurrent writer"
        );
        assert_eq!(std::fs::read(server.path("backup")).unwrap(), b"original");
        session.remove_file(server.path("notes")).await.unwrap();
        let restored = restore_original(
            &session,
            &server.path("notes"),
            &server.path("backup"),
            "conflict".into(),
        )
        .await;
        assert!(restored.contains("was restored"), "{restored}");
        assert_eq!(std::fs::read(server.path("notes")).unwrap(), b"original");
        server.stop().await;
    })
    .await;
}

#[tokio::test]
#[ignore = "Requires the local OpenSSH sftp-server; CI runs these explicitly"]
async fn openssh_text_accepts_exact_limit_and_does_not_create_backup_for_noop() {
    bounded(async {
        let (server, stream) = OpenSshServer::start(None);
        let session = SftpSession::new(stream).await.unwrap();
        let bytes = vec![b'a'; MAX_TEXT_BYTES];
        write(&server, "limit", &bytes, 0o600);
        let path = server.path("limit");
        let original = read_snapshot(&session, &path).await.unwrap();
        let saved = save_on_session(
            &session,
            &path,
            &original.content,
            &original.revision(&path),
            false,
        )
        .await
        .unwrap();
        assert!(saved.backup_path.is_none());
        assert_eq!(saved.revision, original.revision(&path));
        assert_no_staging(&server);
        server.stop().await;
    })
    .await;
}
