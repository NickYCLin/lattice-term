//! Live SFTP test against the same throwaway OpenSSH server as ssh_live.
//!
//! Start the container documented in ssh_live.rs, then run:
//!
//! cargo test --test sftp_live -- --ignored --test-threads=1

use base64::Engine;
use latticeterm_lib::hostkeys::HostTrustStore;
use latticeterm_lib::sftp::{
    connect, create_directory, disconnect, list_directory, read_file, remove, rename, write_file,
    SftpConnectOutcome, SftpConnectRequest, SftpRegistry,
};
use latticeterm_lib::ssh::AuthMethod;
use std::sync::Arc;

const HOST: &str = "127.0.0.1";
const PORT: u16 = 2222;
const USER: &str = "tester";
const PASSWORD: &str = "testpass123";

fn request() -> SftpConnectRequest {
    SftpConnectRequest {
        jump: None,
        profile_id: "sftp-live-test".into(),
        hostname: HOST.into(),
        port: PORT,
        username: USER.into(),
        auth: AuthMethod::Password {
            password: PASSWORD.into(),
        },
        use_saved_password: false,
        remember_password: false,
    }
}

fn temp_dir() -> std::path::PathBuf {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("latticeterm-sftp-live-{unique}"));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[tokio::test]
#[ignore = "needs the throwaway SSH container"]
async fn trusted_session_completes_a_remote_file_lifecycle() {
    let registry = Arc::new(SftpRegistry::new());
    let first = connect(Arc::clone(&registry), None, request()).await;
    let (algorithm, fingerprint) = match first {
        SftpConnectOutcome::HostUnknown {
            algorithm,
            fingerprint,
            ..
        } => (algorithm, fingerprint),
        other => panic!("expected HostUnknown, got {other:?}"),
    };

    let mut trust = HostTrustStore::open(&temp_dir()).unwrap();
    let record = trust
        .trust(HOST, PORT, &algorithm, &fingerprint, 1_700_000_000)
        .unwrap();
    let second = connect(Arc::clone(&registry), Some(record), request()).await;
    let session = match second {
        SftpConnectOutcome::Connected { session } => session,
        other => panic!("expected a connected SFTP session, got {other:?}"),
    };

    let folder = format!("latticeterm-sftp-{}", std::process::id());
    create_directory(
        &registry,
        &session.session_id,
        &session.current_path,
        &folder,
    )
    .await
    .unwrap();
    let folder_path = format!("{}/{}", session.current_path.trim_end_matches('/'), folder);
    let payload = b"latticeterm-sftp-live-ok";
    write_file(
        &registry,
        &session.session_id,
        &folder_path,
        "original.txt",
        &base64::engine::general_purpose::STANDARD.encode(payload),
        false,
    )
    .await
    .unwrap();

    let listing = list_directory(&registry, &session.session_id, &folder_path)
        .await
        .unwrap();
    assert_eq!(listing.entries.len(), 1);
    assert_eq!(listing.entries[0].name, "original.txt");

    let original = format!("{folder_path}/original.txt");
    let refused = write_file(
        &registry,
        &session.session_id,
        &folder_path,
        "original.txt",
        &base64::engine::general_purpose::STANDARD.encode(b"unexpected"),
        false,
    )
    .await;
    assert!(refused.is_err(), "an unconfirmed overwrite must be refused");

    rename(&registry, &session.session_id, &original, "renamed.txt")
        .await
        .unwrap();
    let renamed = format!("{folder_path}/renamed.txt");
    let downloaded = read_file(&registry, &session.session_id, &renamed)
        .await
        .unwrap();
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(downloaded)
            .unwrap(),
        payload
    );

    remove(&registry, &session.session_id, &renamed, false)
        .await
        .unwrap();
    remove(&registry, &session.session_id, &folder_path, true)
        .await
        .unwrap();
    disconnect(&registry, &session.session_id).await.unwrap();
    assert!(registry.list().is_empty());
}
