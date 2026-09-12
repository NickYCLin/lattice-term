//! Real compiled Windows Agent, TCP pairing and encrypted command channel.
#![cfg(all(feature = "agent", windows))]
use lattice_remote::command_protocol::{CommandEnd, CommandEvent, CommandRequest, CommandShell};
use lattice_remote::{RemoteMessage, SecureConnection, Transport};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};

async fn agent() -> (Child, SecureConnection<Transport>) {
    let code = lattice_remote::generate_pairing_code().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_lattice-agent"))
        .args([
            "--terminal",
            "--allow-input",
            "--allow-commands",
            "--json",
            "--bind",
            "127.0.0.1:0",
            "--pair-code-stdin",
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    input
        .write_all(format!("{code}\n").as_bytes())
        .await
        .unwrap();
    drop(input);
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let line = tokio::time::timeout(Duration::from_secs(15), lines.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let ready: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(ready["kind"], "ready");
    assert_eq!(ready["commands"], true);
    let address = ready["address"]
        .as_str()
        .unwrap()
        .parse::<std::net::SocketAddr>()
        .unwrap();
    let mut connection = SecureConnection::connect("127.0.0.1", address.port(), &code)
        .await
        .unwrap();
    let RemoteMessage::Hello(hello) = connection.receive().await.unwrap() else {
        panic!("missing hello")
    };
    assert_eq!(hello.command_shells, 3);
    // Keep status stdout drained without retaining pairing/readiness payloads.
    tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
    (child, connection)
}
async fn event(connection: &mut SecureConnection<Transport>) -> CommandEvent {
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            match connection.receive().await.unwrap() {
                RemoteMessage::CommandEvent(event) => return event,
                RemoteMessage::TerminalData { bytes } => {
                    if bytes.windows(4).any(|b| b == b"\x1b[6n") {
                        connection
                            .send(&RemoteMessage::TerminalInput {
                                bytes: b"\x1b[1;1R".to_vec(),
                            })
                            .await
                            .unwrap();
                    }
                }
                RemoteMessage::KeepAlive => {}
                _ => panic!("unexpected encrypted agent response"),
            }
        }
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn windows_encrypted_agent_executes_both_shells_without_screen_automation() {
    let temp = tempfile::Builder::new()
        .prefix("remote 指令 &'")
        .tempdir()
        .unwrap();
    let (mut child, mut connection) = agent().await;
    for (id, shell, command) in [
        (
            1,
            CommandShell::Cmd,
            "echo 中文測試\r\necho stderr-marker 1>&2\r\nexit /b 9",
        ),
        (
            2,
            CommandShell::PowerShell,
            "Write-Output '中文測試';[Console]::Error.WriteLine('stderr-marker');exit 9",
        ),
    ] {
        connection
            .send(&RemoteMessage::CommandRequest(CommandRequest::Run {
                id,
                shell,
                command: command.into(),
                directory: temp.path().to_string_lossy().into_owned(),
                timeout_seconds: 15,
            }))
            .await
            .unwrap();
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        loop {
            let event = event(&mut connection).await;
            assert_eq!(event.id(), id);
            match event {
                CommandEvent::Output {
                    stderr: error,
                    bytes,
                    ..
                } => {
                    if error {
                        stderr.extend(bytes);
                    } else {
                        stdout.extend(bytes);
                    }
                }
                CommandEvent::Finished {
                    reason,
                    exit_code,
                    detail,
                    ..
                } => {
                    assert_eq!(reason, CommandEnd::Exited, "{detail}");
                    assert_eq!(exit_code, Some(9));
                    break;
                }
                _ => {}
            }
        }
        assert!(String::from_utf8(stdout).unwrap().contains("中文測試"));
        assert!(String::from_utf8(stderr).unwrap().contains("stderr-marker"));
    }
    connection
        .send(&RemoteMessage::Close("owned test completed".into()))
        .await
        .unwrap();
    drop(connection);
    tokio::time::timeout(Duration::from_secs(10), child.wait())
        .await
        .unwrap()
        .unwrap();
}
