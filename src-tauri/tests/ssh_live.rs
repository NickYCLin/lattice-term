//! Live SSH tests against a throwaway server.
//!
//! These are `#[ignore]`d so an ordinary `cargo test` — and CI, which has no
//! server — stays green. Run them deliberately after starting a container:
//!
//! ```text
//! docker run -d --name latticeterm-sshtest -p 127.0.0.1:2222:2222 \
//!   -e PASSWORD_ACCESS=true -e USER_NAME=tester -e USER_PASSWORD=testpass123 \
//!   linuxserver/openssh-server
//! cargo test --test ssh_live -- --ignored --test-threads=1
//! ```
//!
//! The example credentials are public and only for this disposable loopback
//! fixture. Never expose it to a network or use it as an App Review server.
//!
//! What makes them worth having: they cover the parts that unit tests cannot
//! reach — that an unknown host is actually refused, that trusting it actually
//! lets the next attempt through, and that a shell really produces output.

use latticeterm_lib::hostkeys::HostTrustStore;
use latticeterm_lib::ssh::{
    connect, disconnect, send, AuthMethod, ConnectOutcome, ConnectRequest, SessionSink, SshRegistry,
};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const HOST: &str = "127.0.0.1";
const PORT: u16 = 2222;
const USER: &str = "tester";
const PASSWORD: &str = "testpass123";

/// Collects session output so a test can wait for what the shell printed.
#[derive(Default)]
struct Collector {
    output: Mutex<Vec<u8>>,
    closed: Mutex<Option<String>>,
}

impl Collector {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.output.lock().unwrap()).to_string()
    }
}

/// A local wrapper, because the sink trait cannot be implemented on `Arc`
/// directly from this crate.
struct Sink(Arc<Collector>);

impl SessionSink for Sink {
    fn data(&self, _session_id: &str, bytes: &[u8]) {
        self.0.output.lock().unwrap().extend_from_slice(bytes);
    }

    fn closed(&self, _session_id: &str, reason: &str) {
        *self.0.closed.lock().unwrap() = Some(reason.to_string());
    }
}

fn sink(collector: &Arc<Collector>) -> Arc<dyn SessionSink> {
    Arc::new(Sink(Arc::clone(collector)))
}

fn temp_dir(label: &str) -> std::path::PathBuf {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("latticeterm-live-{label}-{unique}"));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn request() -> ConnectRequest {
    ConnectRequest {
        jump: None,
        profile_id: "live-test".into(),
        use_saved_password: false,
        remember_password: false,
        hostname: HOST.into(),
        port: PORT,
        username: USER.into(),
        auth: AuthMethod::Password {
            password: PASSWORD.into(),
        },
        cols: 80,
        rows: 24,
    }
}

/// Polls until the shell has written something matching, or gives up.
async fn wait_for(collector: &Arc<Collector>, needle: &str, seconds: u64) -> bool {
    for _ in 0..(seconds * 10) {
        if collector.text().contains(needle) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

#[tokio::test]
#[ignore = "needs the throwaway SSH container"]
async fn an_untrusted_host_is_refused_then_accepted_once_trusted() {
    let dir = temp_dir("trust-flow");
    let registry = Arc::new(SshRegistry::new());
    let collector = Arc::new(Collector::default());

    // First contact: nothing is trusted, so no session may exist yet.
    let first = connect(sink(&collector), Arc::clone(&registry), None, request()).await;

    let (algorithm, fingerprint) = match first {
        ConnectOutcome::HostUnknown {
            algorithm,
            fingerprint,
            ..
        } => (algorithm, fingerprint),
        other => panic!("expected the first attempt to be refused, got {other:?}"),
    };

    assert!(
        fingerprint.starts_with("SHA256:"),
        "fingerprint should be shown the way OpenSSH prints it: {fingerprint}"
    );
    assert!(
        registry.list().is_empty(),
        "a refused connection must not leave a session behind"
    );

    // The user compares the fingerprint and accepts it.
    let mut store = HostTrustStore::open(&dir).unwrap();
    let record = store
        .trust(HOST, PORT, &algorithm, &fingerprint, 1_700_000_000)
        .unwrap();

    // Second attempt, now with the key on record.
    let second = connect(
        sink(&collector),
        Arc::clone(&registry),
        Some(record),
        request(),
    )
    .await;

    let session_id = match second {
        ConnectOutcome::Connected { session_id } => session_id,
        other => panic!("expected the trusted attempt to connect, got {other:?}"),
    };

    assert_eq!(registry.list().len(), 1);

    // A real shell greets us and answers a command.
    send(
        &registry,
        &session_id,
        &base64_encode("echo latticeterm-live-ok\n"),
    )
    .await
    .unwrap();

    assert!(
        wait_for(&collector, "latticeterm-live-ok", 15).await,
        "the shell never echoed the command; output so far: {}",
        collector.text()
    );

    disconnect(&registry, &session_id).await.unwrap();
}

#[tokio::test]
#[ignore = "needs the throwaway SSH container"]
async fn a_wrong_password_is_reported_as_a_failed_sign_in() {
    let dir = temp_dir("bad-password");
    let registry = Arc::new(SshRegistry::new());
    let collector = Arc::new(Collector::default());

    // Trust the host first, so the only thing left to fail is the password.
    let probe = connect(sink(&collector), Arc::clone(&registry), None, request()).await;
    let (algorithm, fingerprint) = match probe {
        ConnectOutcome::HostUnknown {
            algorithm,
            fingerprint,
            ..
        } => (algorithm, fingerprint),
        other => panic!("expected HostUnknown, got {other:?}"),
    };
    let mut store = HostTrustStore::open(&dir).unwrap();
    let record = store
        .trust(HOST, PORT, &algorithm, &fingerprint, 1)
        .unwrap();

    let mut wrong = request();
    wrong.auth = AuthMethod::Password {
        password: "definitely-not-the-password".into(),
    };

    let outcome = connect(sink(&collector), Arc::clone(&registry), Some(record), wrong).await;

    assert!(
        matches!(outcome, ConnectOutcome::AuthFailed),
        "expected AuthFailed, got {outcome:?}"
    );
    assert!(registry.list().is_empty());
}

#[tokio::test]
#[ignore = "needs the throwaway SSH container"]
async fn a_changed_key_blocks_the_connection() {
    let dir = temp_dir("changed-key");
    let registry = Arc::new(SshRegistry::new());
    let collector = Arc::new(Collector::default());

    // Record a key the server will not present.
    let mut store = HostTrustStore::open(&dir).unwrap();
    let stale = store
        .trust(
            HOST,
            PORT,
            "ssh-ed25519",
            "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            1,
        )
        .unwrap();

    let outcome = connect(
        sink(&collector),
        Arc::clone(&registry),
        Some(stale),
        request(),
    )
    .await;

    match outcome {
        ConnectOutcome::HostChanged {
            received_fingerprint,
            expected,
            ..
        } => {
            assert_ne!(received_fingerprint, expected.fingerprint);
        }
        other => panic!("expected HostChanged, got {other:?}"),
    }

    assert!(
        registry.list().is_empty(),
        "a changed key must never leave a usable session"
    );
}

#[tokio::test]
#[ignore = "needs the throwaway SSH container"]
async fn an_unreachable_port_reports_the_transport_failure() {
    let registry = Arc::new(SshRegistry::new());
    let collector = Arc::new(Collector::default());

    let mut unreachable = request();
    // Chosen because nothing listens there; the point is that the failure is
    // reported as a transport problem rather than a trust question.
    unreachable.port = 1;

    let outcome = connect(sink(&collector), Arc::clone(&registry), None, unreachable).await;

    match outcome {
        ConnectOutcome::Failed { stage, .. } => assert_eq!(stage, "connect"),
        other => panic!("expected Failed, got {other:?}"),
    }
}

fn base64_encode(text: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(text.as_bytes())
}
