use super::*;

#[test]
fn attachment_diagnostics_only_expose_stage_kind_and_numeric_errno() {
    for stage in [
        "socket_connect",
        "peer_identity",
        "credential_access",
        "observer_handshake",
        "attach_timeout",
    ] {
        let secret_error = std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "token=private-token\n{\"handshake\":\"private-payload\"} /private/account",
        );
        let value = serde_json::to_value(AttachFailure::io(stage, &secret_error)).unwrap();
        assert_eq!(
            value,
            json!({"stage": stage, "errorKind": "PermissionDenied"})
        );
    }
    let value = serde_json::to_value(AttachFailure::io(
        "socket_connect",
        &std::io::Error::from_raw_os_error(13),
    ))
    .unwrap();
    assert_eq!(value["errno"], 13);
}

#[tokio::test]
async fn attachment_diagnostics_reach_capabilities_listings_and_tool_errors() {
    let directory = tempfile::tempdir().unwrap();
    let server = McpServer::new(DaemonPaths::new(&directory.path().join("uncreated")));
    for name in [
        "get_capabilities",
        "list_agent_sessions",
        "list_launch_plans",
        "list_authorized_connections",
    ] {
        let reply = server
            .handle(json!({"jsonrpc":"2.0","id":1,"method":"tools/call",
            "params":{"name":name,"arguments":{}}}))
            .await
            .unwrap();
        let content = &reply["result"]["structuredContent"];
        assert_eq!(
            content["attachmentError"]["stage"], "socket_connect",
            "{name}"
        );
        assert_eq!(content["attachmentError"]["errorKind"], "NotFound");
        if name == "list_authorized_connections" {
            assert_eq!(reply["result"]["isError"], true);
            assert_eq!(content["code"], "daemon_unavailable");
        } else {
            assert_eq!(reply["result"]["isError"], false);
            assert_eq!(content["daemonRunning"], false);
        }
    }
    assert!(!server.start_attempted.load(Ordering::Relaxed));
}

#[cfg(unix)]
fn listener() -> (tempfile::TempDir, DaemonPaths, tokio::net::UnixListener) {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let mut paths = DaemonPaths::new(directory.path());
    std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    paths.socket = directory.path().join("daemon.sock");
    let listener = tokio::net::UnixListener::bind(&paths.socket).unwrap();
    std::fs::set_permissions(&paths.socket, std::fs::Permissions::from_mode(0o600)).unwrap();
    (directory, paths, listener)
}

#[cfg(unix)]
#[tokio::test]
async fn attachment_diagnostics_keep_transport_identity_checks_and_connect_errno() {
    use std::os::unix::fs::PermissionsExt;
    let (_directory, mut paths, listener) = listener();
    std::fs::set_permissions(&paths.socket, std::fs::Permissions::from_mode(0o666)).unwrap();
    let failure = Connection::open_scoped(&paths, None, None)
        .await
        .err()
        .unwrap();
    assert_eq!(failure.stage, "peer_identity");
    assert_eq!(failure.error_kind.as_deref(), Some("PermissionDenied"));
    assert!(
        tokio::time::timeout(Duration::from_millis(20), listener.accept())
            .await
            .is_err()
    );
    std::fs::set_permissions(&paths.socket, std::fs::Permissions::from_mode(0o600)).unwrap();
    drop(listener);
    paths.socket.set_file_name("refused.sock");
    let closed_listener = std::os::unix::net::UnixListener::bind(&paths.socket).unwrap();
    std::fs::set_permissions(&paths.socket, std::fs::Permissions::from_mode(0o600)).unwrap();
    drop(closed_listener);
    let failure = Connection::open_scoped(&paths, None, None)
        .await
        .err()
        .unwrap();
    assert_eq!(failure.stage, "socket_connect");
    assert_eq!(failure.error_kind.as_deref(), Some("ConnectionRefused"));
    assert!(failure.errno.is_some());
}

#[cfg(unix)]
#[tokio::test]
async fn attachment_diagnostics_never_echo_rejected_observer_handshake() {
    let (_directory, paths, listener) = listener();
    let peer = tokio::spawn(async move {
        let (stream, _) = tokio::time::timeout(Duration::from_secs(2), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let mut peer = BufReader::new(stream);
        let mut request = String::new();
        peer.read_line(&mut request).await.unwrap();
        let request: Value = serde_json::from_str(&request).unwrap();
        let token = request["body"]["token"].as_str().unwrap();
        write_line(
            peer.get_mut(),
            &json!({"kind":"response","id":request["id"],"ok":false,
            "error":format!("private-handshake-token={token}")}),
        )
        .await
        .unwrap();
    });
    let failure = Connection::open_scoped(&paths, None, None)
        .await
        .err()
        .unwrap();
    assert_eq!(
        serde_json::to_value(&failure).unwrap(),
        json!({"stage":"observer_handshake"})
    );
    assert!(!format!("{failure:?}").contains("private-handshake"));
    peer.await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn attachment_diagnostics_timeout_does_not_become_a_missing_daemon() {
    let (_directory, paths, listener) = listener();
    let deadline = tokio::time::Instant::now() + Duration::from_millis(50);
    let attaching = Connection::attach_until(&paths, None, None, deadline);
    let peer = async {
        let (stream, _) = tokio::time::timeout(Duration::from_secs(2), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let mut peer = BufReader::new(stream);
        let mut request = String::new();
        peer.read_line(&mut request).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    let (result, ()) = tokio::join!(attaching, peer);
    let failure = result.err().unwrap();
    assert_eq!(
        serde_json::to_value(failure).unwrap(),
        json!({"stage":"attach_timeout"})
    );
}
