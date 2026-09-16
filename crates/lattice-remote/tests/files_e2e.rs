//! End-to-end encrypted file workspace check against the real built agent.
//!
//! Ignored by default because the agent also starts real screen capture. Run:
//!   cargo test --features agent --test files_e2e -- --ignored --nocapture
#![cfg(feature = "agent")]

use lattice_remote::{
    RemoteFileRequest, RemoteFileResponse, RemoteMessage, SecureConnection, Transport,
    PROTOCOL_VERSION,
};
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Command, Stdio};

fn agent_binary() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("target");
    path.push("debug");
    path.push(if cfg!(windows) {
        "lattice-agent.exe"
    } else {
        "lattice-agent"
    });
    path
}

async fn next_file_response(connection: &mut SecureConnection<Transport>) -> RemoteFileResponse {
    loop {
        match connection.receive().await.expect("encrypted message") {
            RemoteMessage::FileResponse(response) => return response,
            RemoteMessage::FrameStart(_) | RemoteMessage::FrameChunk { .. } => {}
            other => panic!("unexpected message while waiting for file data: {other:?}"),
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "spawns the real screen-sharing agent; run manually"]
async fn paired_viewer_lists_uploads_and_downloads_within_shared_root() {
    let token = std::process::id();
    let root = std::env::temp_dir().join(format!("lattice-remote-e2e-{token}"));
    std::fs::create_dir_all(root.join("folder")).unwrap();
    std::fs::write(root.join("original.txt"), b"host-data").unwrap();

    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let address = format!("127.0.0.1:{port}");
    let mut agent = Command::new(agent_binary())
        .args([
            "--json",
            "--bind",
            &address,
            "--pair-code",
            "24681357",
            "--fps",
            "1",
            "--file-root",
        ])
        .arg(&root)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn agent");
    let mut ready = String::new();
    let mut agent_events = BufReader::new(agent.stdout.take().unwrap());
    agent_events.read_line(&mut ready).unwrap();
    assert!(
        ready.contains("\"fileTransfer\":true"),
        "unexpected: {ready}"
    );

    let mut connection = SecureConnection::connect("127.0.0.1", port, "24681357")
        .await
        .expect("connect");
    let hello = match connection.receive().await {
        Ok(hello) => hello,
        Err(error) => {
            let _ = agent.kill();
            let _ = agent.wait();
            let mut events = String::new();
            let _ = agent_events.take(16 * 1024).read_to_string(&mut events);
            let _ = std::fs::remove_dir_all(&root);
            panic!("hello: {error}; agent events: {events}");
        }
    };
    match hello {
        RemoteMessage::Hello(hello) => {
            assert_eq!(hello.protocol_version, PROTOCOL_VERSION);
            assert!(hello.file_transfer);
        }
        other => panic!("expected hello, got {other:?}"),
    }

    connection
        .send(&RemoteMessage::FileRequest(RemoteFileRequest::List {
            request_id: 1,
            path: "/".into(),
        }))
        .await
        .unwrap();
    let mut listed = Vec::new();
    loop {
        match next_file_response(&mut connection).await {
            RemoteFileResponse::ListStart { request_id: 1, .. } => {}
            RemoteFileResponse::ListEntry {
                request_id: 1,
                entry,
            } => listed.push(entry.name),
            RemoteFileResponse::ListDone { request_id: 1 } => break,
            other => panic!("unexpected list response: {other:?}"),
        }
    }
    assert!(listed.contains(&"folder".to_string()));
    assert!(listed.contains(&"original.txt".to_string()));

    let upload = b"viewer-data";
    connection
        .send(&RemoteMessage::FileRequest(
            RemoteFileRequest::UploadStart {
                transfer_id: 2,
                path: "/uploaded.txt".into(),
                size: upload.len() as u64,
                overwrite: false,
            },
        ))
        .await
        .unwrap();
    assert_eq!(
        next_file_response(&mut connection).await,
        RemoteFileResponse::UploadReady { transfer_id: 2 }
    );
    connection
        .send(&RemoteMessage::FileRequest(
            RemoteFileRequest::UploadChunk {
                transfer_id: 2,
                bytes: upload.to_vec(),
            },
        ))
        .await
        .unwrap();
    connection
        .send(&RemoteMessage::FileRequest(
            RemoteFileRequest::UploadFinish { transfer_id: 2 },
        ))
        .await
        .unwrap();
    assert_eq!(
        next_file_response(&mut connection).await,
        RemoteFileResponse::Complete { transfer_id: 2 }
    );
    assert_eq!(std::fs::read(root.join("uploaded.txt")).unwrap(), upload);

    connection
        .send(&RemoteMessage::FileRequest(RemoteFileRequest::Download {
            transfer_id: 3,
            path: "/uploaded.txt".into(),
        }))
        .await
        .unwrap();
    let mut downloaded = Vec::new();
    loop {
        match next_file_response(&mut connection).await {
            RemoteFileResponse::DownloadStart {
                transfer_id: 3,
                size,
                ..
            } => assert_eq!(size, upload.len() as u64),
            RemoteFileResponse::DownloadChunk {
                transfer_id: 3,
                bytes,
            } => downloaded.extend(bytes),
            RemoteFileResponse::Complete { transfer_id: 3 } => break,
            other => panic!("unexpected download response: {other:?}"),
        }
    }
    assert_eq!(downloaded, upload);

    let _ = connection.send(&RemoteMessage::Close("done".into())).await;
    drop(connection);
    let exit = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if let Some(status) = agent.try_wait().expect("poll agent exit") {
                break status;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    })
    .await;
    let status = match exit {
        Ok(status) => status,
        Err(_) => {
            // Failure-only cleanup: a passing test must prove Close makes the
            // real Agent tear itself down without an external kill.
            let _ = agent.kill();
            let _ = agent.wait();
            panic!("agent did not exit after the viewer sent Close");
        }
    };
    assert!(status.success(), "agent exited unsuccessfully: {status}");
    std::fs::remove_dir_all(root).unwrap();
}
