//! Real Agent and encrypted viewer, with an isolated desktop bridge fixture.
#![cfg(feature = "agent")]
use lattice_remote::{
    chat_protocol::{ChatOperation, ChatRequest, ChatResponse},
    RemoteMessage, SecureConnection,
};
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    process::Command,
};
#[tokio::test]
async fn encrypted_chat_capability_routes_only_to_the_granted_desktop() {
    for allowed in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let token = "a".repeat(64); // Test-owned loopback bearer, never a real credential.
        let bridge = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let n = stream.read_u32().await.unwrap() as usize;
            assert!(n < 24 * 1024);
            let mut bytes = vec![0; n];
            stream.read_exact(&mut bytes).await.unwrap();
            let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(value["token"].as_str().map(str::len), Some(64));
            let request: ChatRequest = serde_json::from_value(value["request"].clone()).unwrap();
            assert_eq!(request.operation, ChatOperation::List);
            let bytes = serde_json::to_vec(&ChatResponse {
                id: request.id,
                value: serde_json::json!([{"id":"existing-thread","title":"接續原本對話"}]),
                error: None,
            })
            .unwrap();
            stream.write_u32(bytes.len() as u32).await.unwrap();
            stream.write_all(&bytes).await.unwrap();
        });
        let code = lattice_remote::generate_pairing_code().unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_lattice-agent"));
        command
            .args([
                "--terminal",
                "--allow-input",
                "--json",
                "--bind",
                "127.0.0.1:0",
                "--pair-code-stdin",
                "--identity",
            ])
            .arg(temp.path().canonicalize().unwrap().join("identity.json"))
            .env_remove("LATTICE_CHAT_BRIDGE")
            .env_remove("LATTICE_CHAT_TOKEN")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        if allowed {
            command
                .env("LATTICE_CHAT_BRIDGE", address.to_string())
                .env("LATTICE_CHAT_TOKEN", token);
        }
        let mut child = command.spawn().unwrap();
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
        let address: std::net::SocketAddr = ready["address"].as_str().unwrap().parse().unwrap();
        let drain = tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
        let mut connection = SecureConnection::connect("127.0.0.1", address.port(), &code)
            .await
            .unwrap();
        let RemoteMessage::Hello(hello) = connection.receive().await.unwrap() else {
            panic!("missing hello")
        };
        assert_eq!(hello.chat, allowed);
        connection
            .send(&RemoteMessage::ChatRequest(ChatRequest {
                id: "list-1".into(),
                operation: ChatOperation::List,
            }))
            .await
            .unwrap();
        let response = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                match connection.receive().await.unwrap() {
                    RemoteMessage::ChatResponse(response) => break response,
                    RemoteMessage::TerminalData { bytes }
                        if bytes.windows(4).any(|b| b == b"\x1b[6n") =>
                    {
                        connection
                            .send(&RemoteMessage::TerminalInput {
                                bytes: b"\x1b[1;1R".to_vec(),
                            })
                            .await
                            .unwrap();
                    }
                    RemoteMessage::TerminalData { .. } | RemoteMessage::KeepAlive => {}
                    _ => panic!("unexpected chat response"),
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(response.id, "list-1");
        assert_eq!(response.error.is_none(), allowed);
        if allowed {
            assert_eq!(response.value[0]["id"], "existing-thread");
            bridge.await.unwrap();
        } else {
            bridge.abort();
        }
        let _ = connection
            .send(&RemoteMessage::Close("test complete".into()))
            .await;
        // The fixture owns the exact Agent child, never a process-name kill.
        let _ = child.kill().await;
        let _ = child.wait().await;
        drain.abort();
    }
}
