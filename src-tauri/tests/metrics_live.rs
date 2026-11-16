//! Live metrics test against a throwaway SSH server.
//!
//! `#[ignore]`d so ordinary `cargo test` and CI stay green. Run deliberately:
//!
//! ```text
//! docker run -d --name latticeterm-sshtest -p 2222:2222 \
//!   -e PASSWORD_ACCESS=true -e USER_NAME=tester -e USER_PASSWORD=testpass123 \
//!   linuxserver/openssh-server
//! cargo test --test metrics_live -- --ignored --test-threads=1
//! ```
//!
//! The unit tests prove the parser; only a real host can prove that the probe
//! actually runs over a live session's second channel and that the terminal
//! sharing that session never sees it.

use latticeterm_lib::hostkeys::HostTrustStore;
use latticeterm_lib::metrics::collect_for_session;
use latticeterm_lib::ssh::{
    connect, AuthMethod, ConnectOutcome, ConnectRequest, SessionSink, SshRegistry,
};
use std::sync::{Arc, Mutex};

const HOST: &str = "127.0.0.1";
const PORT: u16 = 2222;
const USER: &str = "tester";
const PASSWORD: &str = "testpass123";

#[derive(Default)]
struct Collector {
    output: Mutex<Vec<u8>>,
}

struct Sink(Arc<Collector>);

impl SessionSink for Sink {
    fn data(&self, _session_id: &str, bytes: &[u8]) {
        self.0.output.lock().unwrap().extend_from_slice(bytes);
    }
    fn closed(&self, _session_id: &str, _reason: &str) {}
}

fn temp_dir(label: &str) -> std::path::PathBuf {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("latticeterm-metrics-live-{label}-{unique}"));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn request() -> ConnectRequest {
    ConnectRequest {
        jump: None,
        profile_id: "metrics-live".into(),
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

#[tokio::test]
#[ignore = "needs the throwaway SSH container"]
async fn a_live_session_reports_real_resource_readings() {
    // Learn and trust the container's key the way the app does.
    let mut store = HostTrustStore::open(&temp_dir("trust")).unwrap();
    let registry = Arc::new(SshRegistry::new());
    let collector = Arc::new(Collector::default());

    let refused = connect(
        Arc::new(Sink(Arc::clone(&collector))),
        Arc::clone(&registry),
        None,
        request(),
    )
    .await;
    let ConnectOutcome::HostUnknown {
        host,
        port,
        algorithm,
        fingerprint,
    } = refused
    else {
        panic!("expected the untrusted host to be refused, got {refused:?}");
    };
    let record = store
        .trust(&host, port, &algorithm, &fingerprint, 1)
        .unwrap();

    let outcome = connect(
        Arc::new(Sink(Arc::clone(&collector))),
        Arc::clone(&registry),
        Some(record),
        request(),
    )
    .await;
    let ConnectOutcome::Connected { session_id } = outcome else {
        panic!("expected a session, got {outcome:?}");
    };

    // Give the shell a moment to print its banner, then remember how much
    // terminal output existed before the probe.
    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
    let before = collector.output.lock().unwrap().len();

    let metrics = collect_for_session(&registry, &session_id)
        .await
        .expect("the probe answers on a live session");

    assert!(metrics.uptime_seconds > 0, "uptime was read");
    assert!(metrics.memory.total_bytes > 0, "memory total was read");
    assert!(
        metrics.memory.used_bytes <= metrics.memory.total_bytes,
        "memory usage is coherent"
    );
    assert!(metrics.cpu.cores >= 1, "core count was read");
    assert!(!metrics.disks.is_empty(), "at least one disk was read");

    // The probe ran on its own channel: the interactive terminal must not
    // have received a byte of it.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let after = collector.output.lock().unwrap().len();
    assert_eq!(before, after, "the terminal never sees the probe");

    // A second reading works on the same session — the panel refreshes.
    let again = collect_for_session(&registry, &session_id)
        .await
        .expect("a second probe answers too");
    assert!(again.collected_at >= metrics.collected_at);
}

#[tokio::test]
#[ignore = "needs the throwaway SSH container"]
async fn a_dead_session_is_an_error_not_a_hang() {
    let registry = SshRegistry::new();
    let error = collect_for_session(&registry, "session-404")
        .await
        .unwrap_err();
    assert!(error.contains("session-404"));
}
