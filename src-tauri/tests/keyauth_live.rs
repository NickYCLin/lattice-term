//! Live private-key authentication test against a throwaway SSH server.
//!
//! `#[ignore]`d so ordinary `cargo test` and CI stay green. Run deliberately:
//!
//! ```text
//! docker run -d --name latticeterm-sshtest -p 2222:2222 \
//!   -e PASSWORD_ACCESS=true -e USER_NAME=tester -e USER_PASSWORD=testpass123 \
//!   linuxserver/openssh-server
//! cargo test --test keyauth_live -- --ignored --test-threads=1
//! ```
//!
//! The test generates its own throwaway ed25519 key pair, installs the public
//! half into the container over `docker exec`, and signs in with the private
//! half — the same path a user's `~/.ssh/id_ed25519` takes.

use latticeterm_lib::hostkeys::HostTrustStore;
use latticeterm_lib::ssh::{
    connect, AuthMethod, ConnectOutcome, ConnectRequest, SessionSink, SshRegistry,
};
use russh::keys::ssh_key;
use std::process::Command;
use std::sync::Arc;

const HOST: &str = "127.0.0.1";
const PORT: u16 = 2222;
const USER: &str = "tester";

struct DiscardSink;

impl SessionSink for DiscardSink {
    fn data(&self, _session_id: &str, _bytes: &[u8]) {}
    fn closed(&self, _session_id: &str, _reason: &str) {}
}

fn temp_dir(label: &str) -> std::path::PathBuf {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("latticeterm-keyauth-{label}-{unique}"));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn request(auth: AuthMethod) -> ConnectRequest {
    ConnectRequest {
        jump: None,
        profile_id: "keyauth-live".into(),
        use_saved_password: false,
        remember_password: false,
        hostname: HOST.into(),
        port: PORT,
        username: USER.into(),
        auth,
        cols: 80,
        rows: 24,
    }
}

/// Learns and trusts the container's host key the way the app does.
async fn trusted_record() -> latticeterm_lib::hostkeys::HostKeyRecord {
    let mut store = HostTrustStore::open(&temp_dir("trust")).unwrap();
    let outcome = connect(
        Arc::new(DiscardSink),
        Arc::new(SshRegistry::new()),
        None,
        request(AuthMethod::Password {
            password: "unused".into(),
        }),
    )
    .await;
    let ConnectOutcome::HostUnknown {
        host,
        port,
        algorithm,
        fingerprint,
    } = outcome
    else {
        panic!("expected the untrusted host to be refused, got {outcome:?}");
    };
    store
        .trust(&host, port, &algorithm, &fingerprint, 1)
        .unwrap()
}

/// A throwaway ed25519 key from OS randomness, never reused across runs.
fn generate_key() -> ssh_key::PrivateKey {
    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed).expect("OS randomness is available");
    ssh_key::PrivateKey::new(
        ssh_key::private::KeypairData::Ed25519(ssh_key::private::Ed25519Keypair::from_seed(&seed)),
        "latticeterm-live-test",
    )
    .unwrap()
}

/// Appends a public key to the container user's authorized_keys.
fn install_public_key(public_openssh: &str) {
    let script = format!(
        "mkdir -p /config/.ssh && echo '{public_openssh}' >> /config/.ssh/authorized_keys \
         && chmod 700 /config/.ssh && chmod 600 /config/.ssh/authorized_keys \
         && chown -R {USER}:{USER} /config/.ssh"
    );
    let status = Command::new("docker")
        .args(["exec", "latticeterm-sshtest", "sh", "-c", &script])
        .status()
        .expect("docker exec runs");
    assert!(
        status.success(),
        "the public key installs into the container"
    );
}

#[tokio::test]
#[ignore = "needs the throwaway SSH container"]
async fn a_generated_key_signs_in_without_a_password() {
    // A throwaway key pair, generated for this run and never reused.
    let key = generate_key();

    let key_path = temp_dir("key").join("id_ed25519");
    std::fs::write(
        &key_path,
        key.to_openssh(ssh_key::LineEnding::LF).unwrap().as_bytes(),
    )
    .unwrap();

    install_public_key(&key.public_key().to_openssh().unwrap());

    let record = trusted_record().await;
    let outcome = connect(
        Arc::new(DiscardSink),
        Arc::new(SshRegistry::new()),
        Some(record),
        request(AuthMethod::PrivateKey {
            path: key_path.display().to_string(),
            passphrase: None,
        }),
    )
    .await;

    assert!(
        matches!(outcome, ConnectOutcome::Connected { .. }),
        "expected a session via key auth, got {outcome:?}"
    );
}

#[tokio::test]
#[ignore = "needs the throwaway SSH container"]
async fn a_missing_key_file_is_reported_as_a_credential_problem() {
    let record = trusted_record().await;
    let bogus = temp_dir("missing").join("no-such-key");

    let outcome = connect(
        Arc::new(DiscardSink),
        Arc::new(SshRegistry::new()),
        Some(record),
        request(AuthMethod::PrivateKey {
            path: bogus.display().to_string(),
            passphrase: None,
        }),
    )
    .await;

    match outcome {
        ConnectOutcome::Failed { stage, detail } => {
            assert_eq!(stage, "credential");
            assert!(
                detail.contains("private key"),
                "explains the key problem: {detail}"
            );
        }
        other => panic!("expected a credential failure, got {other:?}"),
    }
}

#[tokio::test]
#[ignore = "needs the throwaway SSH container"]
async fn a_key_the_host_does_not_know_is_a_rejection_not_an_error() {
    // A fresh key that was never installed: the host must simply say no.
    let key = generate_key();
    let key_path = temp_dir("stranger").join("id_ed25519");
    std::fs::write(
        &key_path,
        key.to_openssh(ssh_key::LineEnding::LF).unwrap().as_bytes(),
    )
    .unwrap();

    let record = trusted_record().await;
    let outcome = connect(
        Arc::new(DiscardSink),
        Arc::new(SshRegistry::new()),
        Some(record),
        request(AuthMethod::PrivateKey {
            path: key_path.display().to_string(),
            passphrase: None,
        }),
    )
    .await;

    assert!(
        matches!(outcome, ConnectOutcome::AuthFailed),
        "expected a clean rejection, got {outcome:?}"
    );
}
