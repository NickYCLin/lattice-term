//! Explicit encrypted text-editor check against an isolated, real headless
//! agent. Build the agent first, then run this test with `-- --ignored`.
#![cfg(all(feature = "agent", unix))]

use lattice_remote::{
    RemoteFileRequest, RemoteFileResponse, RemoteMessage, SecureConnection, Transport,
    FILE_CHUNK_SIZE,
};
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::time::Duration;
use tokio::time::{sleep, timeout};

struct AgentGuard(Child);

impl Drop for AgentGuard {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

async fn next_response(connection: &mut SecureConnection<Transport>) -> RemoteFileResponse {
    timeout(Duration::from_secs(10), async {
        loop {
            match connection
                .receive()
                .await
                .expect("receive encrypted response")
            {
                RemoteMessage::FileResponse(response) => return response,
                RemoteMessage::TerminalData { .. } | RemoteMessage::KeepAlive => {}
                other => panic!("unexpected message: {other:?}"),
            }
        }
    })
    .await
    .expect("file response timeout")
}

async fn read_text(
    connection: &mut SecureConnection<Transport>,
    request_id: u64,
) -> (Vec<u8>, [u8; 32]) {
    connection
        .send(&RemoteMessage::FileRequest(RemoteFileRequest::ReadText {
            request_id,
            path: "/note.txt".into(),
        }))
        .await
        .unwrap();
    let (size, revision) = match next_response(connection).await {
        RemoteFileResponse::TextStart {
            request_id: id,
            size,
            revision,
        } if id == request_id => (size, revision),
        other => panic!("unexpected text start: {other:?}"),
    };
    let mut bytes = Vec::new();
    loop {
        match next_response(connection).await {
            RemoteFileResponse::DownloadChunk {
                transfer_id,
                bytes: chunk,
            } if transfer_id == request_id => bytes.extend(chunk),
            RemoteFileResponse::Complete { transfer_id } if transfer_id == request_id => break,
            other => panic!("unexpected text chunk: {other:?}"),
        }
    }
    assert_eq!(bytes.len() as u64, size);
    (bytes, revision)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "spawns a real headless agent and shell; run explicitly"]
async fn encrypted_editor_saves_multichunk_utf8_and_rejects_external_conflicts() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("shared");
    std::fs::create_dir(&root).unwrap();
    let original = "initial\r\n".repeat(9000).into_bytes();
    std::fs::write(root.join("note.txt"), &original).unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let binary =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/debug/lattice-agent");
    let mut agent = AgentGuard(
        Command::new(binary)
            .args([
                "--json",
                "--terminal",
                "--bind",
                &format!("127.0.0.1:{port}"),
                "--pair-code",
                "text-editor-fixture",
                "--identity",
            ])
            .arg(temporary.path().join("identity.json"))
            .arg("--file-root")
            .arg(&root)
            .env("SHELL", "/bin/sh")
            .env_remove("ENV")
            .env_remove("BASH_ENV")
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    let stdout = agent.0.stdout.take().unwrap();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let _ = reader.read_line(&mut line);
        let _ = ready_tx.send(line);
        // Keep the pipe open until the host exits; normal JSON status events
        // should not get a broken pipe merely because readiness was read.
        for _ in reader.lines() {}
    });
    let ready = ready_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    assert!(
        ready.contains("\"fileTransfer\":true"),
        "unexpected readiness: {ready}"
    );
    let mut connection = timeout(
        Duration::from_secs(10),
        SecureConnection::connect("127.0.0.1", port, "text-editor-fixture"),
    )
    .await
    .unwrap()
    .unwrap();
    match timeout(Duration::from_secs(10), connection.receive())
        .await
        .unwrap()
        .unwrap()
    {
        RemoteMessage::Hello(hello) => {
            assert!(hello.terminal && hello.file_transfer && hello.file_edit);
            assert!(
                hello.view_only,
                "text permission is independent from input permission"
            );
        }
        other => panic!("expected hello: {other:?}"),
    }
    let (loaded, revision) = read_text(&mut connection, 1).await;
    assert_eq!(loaded, original);
    let edited = "\u{feff}繁體中文\r\n".repeat(9000).into_bytes();
    connection
        .send(&RemoteMessage::FileRequest(
            RemoteFileRequest::SaveTextStart {
                transfer_id: 2,
                path: "/note.txt".into(),
                size: edited.len() as u64,
                expected_revision: revision,
            },
        ))
        .await
        .unwrap();
    assert_eq!(
        next_response(&mut connection).await,
        RemoteFileResponse::UploadReady { transfer_id: 2 }
    );
    for chunk in edited.chunks(FILE_CHUNK_SIZE) {
        connection
            .send(&RemoteMessage::FileRequest(
                RemoteFileRequest::UploadChunk {
                    transfer_id: 2,
                    bytes: chunk.to_vec(),
                },
            ))
            .await
            .unwrap();
    }
    connection
        .send(&RemoteMessage::FileRequest(
            RemoteFileRequest::UploadFinish { transfer_id: 2 },
        ))
        .await
        .unwrap();
    let saved_revision = match next_response(&mut connection).await {
        RemoteFileResponse::TextSaved {
            transfer_id: 2,
            revision,
            backup_path,
        } => {
            assert_eq!(
                std::fs::read(root.join(&backup_path[1..])).unwrap(),
                original
            );
            revision
        }
        other => panic!("unexpected text save: {other:?}"),
    };
    assert_eq!(std::fs::read(root.join("note.txt")).unwrap(), edited);
    let (loaded, revision) = read_text(&mut connection, 3).await;
    assert_eq!(loaded, edited);
    assert_eq!(revision, saved_revision);
    std::fs::write(root.join("note.txt"), b"external revision").unwrap();
    connection
        .send(&RemoteMessage::FileRequest(
            RemoteFileRequest::SaveTextStart {
                transfer_id: 4,
                path: "/note.txt".into(),
                size: 0,
                expected_revision: saved_revision,
            },
        ))
        .await
        .unwrap();
    assert!(matches!(next_response(&mut connection).await,
        RemoteFileResponse::Error { operation_id: 4, detail } if detail.contains("changed outside")));
    assert_eq!(
        std::fs::read(root.join("note.txt")).unwrap(),
        b"external revision"
    );
    connection
        .send(&RemoteMessage::Close("text editor test completed".into()))
        .await
        .unwrap();
    drop(connection);
    let status = timeout(Duration::from_secs(10), async {
        loop {
            if let Some(status) = agent.0.try_wait().unwrap() {
                break status;
            }
            sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("headless agent should exit after Close");
    assert!(status.success());
}
