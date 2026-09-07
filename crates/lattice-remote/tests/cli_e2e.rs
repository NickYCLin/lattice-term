//! End-to-end checks for the packaged-style `lattice-remote` client.
//!
//! The test starts the real terminal Agent for each direct session, transfers
//! bytes through Noise, and verifies both publication directions. It is ignored
//! by default because it spawns a real shell in a PTY. Run explicitly with:
//!   cargo test --features "agent client-cli" --test cli_e2e -- --ignored --nocapture
#![cfg(all(feature = "agent", feature = "client-cli"))]

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Output, Stdio};
use std::time::{Duration, Instant};

fn agent_binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_lattice-agent"))
}

fn client_binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_lattice-remote"))
}

fn private_pairing_code_file(directory: &Path) -> PathBuf {
    let path = directory.join("pair-code");
    std::fs::write(&path, "aB3!\"'$`\\-xy\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    path
}

struct AgentGuard(Child);
impl std::ops::Deref for AgentGuard {
    type Target = Child;
    fn deref(&self) -> &Child {
        &self.0
    }
}
impl std::ops::DerefMut for AgentGuard {
    fn deref_mut(&mut self) -> &mut Child {
        &mut self.0
    }
}
impl Drop for AgentGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn start_agent(root: &Path, pairing_file: &Path) -> (AgentGuard, BufReader<ChildStdout>, String) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let address = format!("127.0.0.1:{port}");
    let mut agent = AgentGuard(
        Command::new(agent_binary())
            .args([
                "--json",
                "--terminal",
                "--allow-input",
                "--bind",
                &address,
                "--pair-code-file",
            ])
            .arg(pairing_file)
            .arg("--file-root")
            .arg(root)
            .arg("--identity")
            .arg(
                pairing_file
                    .parent()
                    .unwrap()
                    .canonicalize()
                    .unwrap()
                    .join("identity.json"),
            )
            .current_dir(root)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn Agent"),
    );
    let mut events = BufReader::new(agent.stdout.take().expect("Agent event stream"));
    let mut ready = String::new();
    events.read_line(&mut ready).expect("read Agent readiness");
    assert!(ready.contains("\"kind\":\"ready\""), "unexpected: {ready}");
    (agent, events, address)
}

fn run_client(address: &str, pairing_file: &Path, arguments: &[&str]) -> Output {
    Command::new(client_binary())
        .args(["--direct", address, "--pair-code-file"])
        .arg(pairing_file)
        .args(arguments)
        .output()
        .expect("run client")
}

fn assert_client_success(output: &Output) {
    assert!(
        output.status.success(),
        "client failed: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn wait_for_agent(mut agent: AgentGuard, _events: BufReader<ChildStdout>) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = agent.try_wait().expect("poll Agent") {
            assert!(status.success(), "Agent failed: {status}");
            return;
        }
        if Instant::now() >= deadline {
            let _ = agent.kill();
            let _ = agent.wait();
            panic!("Agent did not exit after the client closed the session");
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[test]
#[ignore = "spawns the real Agent; run manually"]
fn password_attempt_budget_survives_agent_restarts() {
    let directory = tempfile::tempdir().unwrap();
    let shared = directory.path().join("shared");
    std::fs::create_dir(&shared).unwrap();
    let pairing_file = private_pairing_code_file(directory.path());
    let wrong_file = directory.path().join("wrong-code");
    std::fs::copy(&pairing_file, &wrong_file).unwrap();
    std::fs::write(&wrong_file, "Ab3!wrong").unwrap();
    for _ in 0..5 {
        let (agent, _events, address) = start_agent(&shared, &pairing_file);
        assert!(!run_client(&address, &wrong_file, &["list", "/"])
            .status
            .success());
        drop(agent);
    }
    let (agent, events, address) = start_agent(&shared, &pairing_file);
    // Even the correct password cannot bypass the persisted budget on restart.
    assert!(!run_client(&address, &pairing_file, &["list", "/"])
        .status
        .success());
    wait_for_agent(agent, events);
    let state = std::fs::read_to_string(directory.path().join("pairing-attempts.json")).unwrap();
    assert!(!state.contains("wrong") && !state.contains("xy"));
}

#[test]
#[ignore = "spawns the real terminal Agent and shell; run manually"]
fn client_lists_uploads_and_downloads_over_noise() {
    let directory = tempfile::tempdir().unwrap();
    let shared = directory.path().join("shared");
    std::fs::create_dir(&shared).unwrap();
    let pairing_file = private_pairing_code_file(directory.path());
    let source = directory.path().join("release.tar.gz");
    let payload = b"lattice remote cli encrypted deployment artifact\n";
    std::fs::write(&source, payload).unwrap();

    let (agent, events, address) = start_agent(&shared, &pairing_file);
    let output = Command::new(client_binary())
        .args(["--direct", &address, "--pair-code-file"])
        .arg(&pairing_file)
        .arg("--json")
        .arg("upload")
        .arg(&source)
        .arg("/release.tar.gz")
        .output()
        .expect("upload through client");
    assert_client_success(&output);
    assert!(String::from_utf8_lossy(&output.stdout).contains("\"operation\":\"upload\""));
    wait_for_agent(agent, events);
    assert_eq!(
        std::fs::read(shared.join("release.tar.gz")).unwrap(),
        payload
    );

    let (agent, events, address) = start_agent(&shared, &pairing_file);
    let output = run_client(&address, &pairing_file, &["--json", "list", "/"]);
    assert_client_success(&output);
    assert!(String::from_utf8_lossy(&output.stdout).contains("release.tar.gz"));
    wait_for_agent(agent, events);

    let downloaded = directory.path().join("downloaded.tar.gz");
    let (agent, events, address) = start_agent(&shared, &pairing_file);
    let output = Command::new(client_binary())
        .args(["--direct", &address, "--pair-code-file"])
        .arg(&pairing_file)
        .arg("--json")
        .arg("download")
        .arg("/release.tar.gz")
        .arg(&downloaded)
        .output()
        .expect("download through client");
    assert_client_success(&output);
    assert!(String::from_utf8_lossy(&output.stdout).contains("\"operation\":\"download\""));
    wait_for_agent(agent, events);
    assert_eq!(std::fs::read(&downloaded).unwrap(), payload);

    std::fs::write(&downloaded, b"older local artifact").unwrap();
    let (agent, events, address) = start_agent(&shared, &pairing_file);
    let output = Command::new(client_binary())
        .args(["--direct", &address, "--pair-code-file"])
        .arg(&pairing_file)
        .arg("download")
        .arg("/release.tar.gz")
        .arg(&downloaded)
        .arg("--overwrite")
        .output()
        .expect("overwrite download through client");
    assert_client_success(&output);
    wait_for_agent(agent, events);
    assert_eq!(std::fs::read(&downloaded).unwrap(), payload);
}
