//! Authorization and lifecycle regressions for the real reverse-RPC bridge.
//! Fixtures never connect to an SSH/SFTP host or inspect an account.

use super::*;
use crate::agent_daemon::server::{ClientReceiver, ClientSender, DaemonSink};
use crate::mcp_desktop::{Backend, Scopes, TransferDirection};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

fn target(id: &str) -> TargetView {
    TargetView {
        id: id.into(),
        label: "Synthetic connection".into(),
        backend: Backend::Ssh,
        scopes: Scopes {
            metrics: true,
            ..Scopes::default()
        },
        plans: Vec::new(),
        roots: Vec::new(),
        connected: true,
    }
}

fn metric(id: &str) -> DesktopOperation {
    DesktopOperation::GetMetrics {
        target_id: id.into(),
    }
}

fn desktop(sink: &DaemonSink, bridge: &Bridge) -> (u64, ClientSender, ClientReceiver) {
    let (id, sender, receiver) = sink.subscribe(ClientRole::Desktop, "test desktop".into());
    bridge.attach(id);
    (id, sender, receiver)
}

async fn receive(receiver: &mut ClientReceiver) -> Frame {
    let line = tokio::time::timeout(Duration::from_secs(2), async {
        match receiver {
            ClientReceiver::Desktop(receiver) => receiver.recv().await,
            ClientReceiver::Observer(receiver) => receiver.recv().await,
        }
    })
    .await
    .expect("a bridge frame should arrive promptly")
    .expect("the client remains connected");
    serde_json::from_str(&line).unwrap()
}

fn no_frame(receiver: &mut ClientReceiver) {
    match receiver {
        ClientReceiver::Desktop(receiver) => assert!(matches!(
            receiver.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        )),
        ClientReceiver::Observer(receiver) => assert!(matches!(
            receiver.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        )),
    }
}

fn invoke_id(frame: Frame, expected_target: &str) -> u64 {
    match frame {
        Frame::Request {
            id,
            body: Request::DesktopInvoke { client, operation },
        } => {
            assert_eq!(client, "observer fixture");
            assert_eq!(operation.target_id(), Some(expected_target));
            id
        }
        _ => panic!("expected an explicitly routed desktop invocation"),
    }
}

fn call(
    bridge: &Arc<Bridge>,
    operation: DesktopOperation,
) -> tokio::task::JoinHandle<Result<Value, String>> {
    let bridge = Arc::clone(bridge);
    tokio::spawn(async move { bridge.call("observer fixture", operation).await })
}

async fn completed(task: tokio::task::JoinHandle<Result<Value, String>>) -> Result<Value, String> {
    tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .expect("the call should finish without its 15-second timeout")
        .unwrap()
}

/// A picture is larger than any other reply, so the bridge gives captures
/// their own ceiling — and still has one.
#[tokio::test]
async fn a_screen_capture_may_be_larger_than_other_replies_but_is_still_bounded() {
    let bridge = Arc::new(Bridge::default());
    let sink = DaemonSink::default();
    let (owner, sender, mut receiver) = desktop(&sink, &bridge);
    let mut screen = target("target-screen");
    screen.backend = Backend::Rdp;
    screen.scopes = Scopes {
        screen: true,
        ..Scopes::default()
    };
    bridge
        .replace(owner, ClientRole::Desktop, sender, vec![screen])
        .unwrap();

    // A picture well past the ordinary reply ceiling still arrives.
    let picture = "A".repeat(900 * 1024);
    let task = call(
        &bridge,
        DesktopOperation::CaptureScreen {
            target_id: "target-screen".into(),
        },
    );
    let id = invoke_id(receive(&mut receiver).await, "target-screen");
    bridge.resolve(
        owner,
        ClientRole::Desktop,
        id,
        Ok(json!({ "frameId": 1, "base64": picture })),
    );
    let reply = completed(task).await.unwrap();
    assert_eq!(reply["base64"].as_str().unwrap().len(), 900 * 1024);

    // Beyond the screen ceiling it is refused like any oversized reply.
    let task = call(
        &bridge,
        DesktopOperation::CaptureScreen {
            target_id: "target-screen".into(),
        },
    );
    let id = invoke_id(receive(&mut receiver).await, "target-screen");
    bridge.resolve(
        owner,
        ClientRole::Desktop,
        id,
        Ok(json!({ "frameId": 2, "base64": "B".repeat(3 * 1024 * 1024) })),
    );
    let refused = completed(task).await.unwrap_err();
    assert!(refused.contains("exceeded its limit"), "{refused}");
}

#[tokio::test]
async fn observers_cannot_register_grants_or_resolve_desktop_results() {
    let bridge = Arc::new(Bridge::default());
    let sink = DaemonSink::default();
    let (owner, sender, mut receiver) = desktop(&sink, &bridge);
    let (observer, observer_sender, mut observer_receiver) =
        sink.subscribe(ClientRole::Observer, "observer fixture".into());
    // Even a mistakenly attached observer ID cannot cross the role check.
    bridge.attach(observer);
    assert!(bridge
        .replace(
            observer,
            ClientRole::Observer,
            observer_sender,
            vec![target("observer-target")]
        )
        .is_err());
    bridge
        .replace(
            owner,
            ClientRole::Desktop,
            sender,
            vec![target("target-one")],
        )
        .unwrap();
    let task = call(&bridge, metric("target-one"));
    let id = invoke_id(receive(&mut receiver).await, "target-one");
    bridge.resolve(
        owner,
        ClientRole::Observer,
        id,
        Ok(json!({"spoofed": true})),
    );
    assert_eq!(bridge.pending.lock().unwrap().len(), 1);
    bridge.resolve(
        observer,
        ClientRole::Desktop,
        id,
        Ok(json!({"spoofed": true})),
    );
    assert_eq!(bridge.pending.lock().unwrap().len(), 1);
    bridge.resolve(owner, ClientRole::Desktop, id, Ok(json!({"trusted": true})));
    assert_eq!(completed(task).await.unwrap(), json!({"trusted": true}));
    no_frame(&mut observer_receiver);
}

#[tokio::test]
async fn invocations_go_only_to_the_owner_and_never_broadcast() {
    let bridge = Arc::new(Bridge::default());
    let sink = DaemonSink::default();
    let (first, first_sender, mut first_receiver) = desktop(&sink, &bridge);
    let (second, second_sender, mut second_receiver) = desktop(&sink, &bridge);
    let (_, _, mut observer_receiver) =
        sink.subscribe(ClientRole::Observer, "other observer".into());
    bridge
        .replace(
            first,
            ClientRole::Desktop,
            first_sender,
            vec![target("target-one")],
        )
        .unwrap();
    bridge
        .replace(
            second,
            ClientRole::Desktop,
            second_sender.clone(),
            vec![target("target-two")],
        )
        .unwrap();
    assert!(bridge
        .replace(
            second,
            ClientRole::Desktop,
            second_sender,
            vec![target("target-one")]
        )
        .is_err());
    let task = call(&bridge, metric("target-one"));
    let id = invoke_id(receive(&mut first_receiver).await, "target-one");
    no_frame(&mut second_receiver);
    no_frame(&mut observer_receiver);
    bridge.resolve(
        second,
        ClientRole::Desktop,
        id,
        Ok(json!({"wrongOwner": true})),
    );
    assert_eq!(bridge.pending.lock().unwrap().len(), 1);
    bridge.resolve(
        first,
        ClientRole::Desktop,
        id,
        Ok(json!({"owner": "first"})),
    );
    assert_eq!(completed(task).await.unwrap(), json!({"owner": "first"}));
}

#[tokio::test]
async fn ungranted_scopes_and_offline_targets_are_rejected_before_dispatch() {
    let bridge = Arc::new(Bridge::default());
    let sink = DaemonSink::default();
    let (owner, sender, mut receiver) = desktop(&sink, &bridge);
    let mut view = target("target-one");
    view.scopes = Scopes::default();
    bridge
        .replace(owner, ClientRole::Desktop, sender.clone(), vec![view])
        .unwrap();
    let operations = vec![
        metric("target-one"),
        DesktopOperation::ListDirectory {
            target_id: "target-one".into(),
            root_id: "root".into(),
            path: String::new(),
        },
        DesktopOperation::Exec {
            target_id: "target-one".into(),
            plan_id: "plan".into(),
            request_id: "exec-test".into(),
        },
        DesktopOperation::Transfer {
            target_id: "target-one".into(),
            root_id: "root".into(),
            direction: TransferDirection::Upload,
            local_path: "fixture.txt".into(),
            remote_path: "fixture.txt".into(),
            request_id: "upload-test".into(),
        },
        DesktopOperation::Transfer {
            target_id: "target-one".into(),
            root_id: "root".into(),
            direction: TransferDirection::Download,
            local_path: "fixture.txt".into(),
            remote_path: "fixture.txt".into(),
            request_id: "download-test".into(),
        },
    ];
    for operation in operations {
        assert!(bridge
            .call("observer fixture", operation)
            .await
            .unwrap_err()
            .contains("not authorized"));
    }
    let mut offline = target("target-one");
    offline.connected = false;
    bridge
        .replace(owner, ClientRole::Desktop, sender.clone(), vec![offline])
        .unwrap();
    assert!(bridge
        .call("observer fixture", metric("target-one"))
        .await
        .unwrap_err()
        .contains("offline"));
    assert!(bridge
        .replace(
            owner,
            ClientRole::Desktop,
            sender,
            vec![target("target-one")],
        )
        .is_err());
    assert!(bridge
        .call("observer fixture", metric("target-one"))
        .await
        .unwrap_err()
        .contains("offline"));
    assert!(bridge
        .call("observer fixture", metric("unknown-target"))
        .await
        .is_err());
    assert!(bridge.pending.lock().unwrap().is_empty());
    no_frame(&mut receiver);
}

#[tokio::test]
async fn revoke_then_regrant_of_the_same_id_cannot_release_a_stale_result() {
    let bridge = Arc::new(Bridge::default());
    let sink = DaemonSink::default();
    let (owner, sender, mut receiver) = desktop(&sink, &bridge);
    bridge
        .replace(
            owner,
            ClientRole::Desktop,
            sender.clone(),
            vec![target("target-one")],
        )
        .unwrap();
    let old = call(&bridge, metric("target-one"));
    let old_id = invoke_id(receive(&mut receiver).await, "target-one");
    bridge
        .replace(owner, ClientRole::Desktop, sender.clone(), Vec::new())
        .unwrap();
    bridge
        .replace(
            owner,
            ClientRole::Desktop,
            sender,
            vec![target("target-one")],
        )
        .unwrap();
    bridge.resolve(
        owner,
        ClientRole::Desktop,
        old_id,
        Ok(json!({"secret": "stale result must not escape"})),
    );
    let error = completed(old).await.unwrap_err();
    assert!(error.contains("revoked"));
    assert!(!error.contains("stale result"));
    let current = call(&bridge, metric("target-one"));
    let current_id = invoke_id(receive(&mut receiver).await, "target-one");
    bridge.resolve(
        owner,
        ClientRole::Desktop,
        current_id,
        Ok(json!({"fresh": true})),
    );
    assert_eq!(completed(current).await.unwrap(), json!({"fresh": true}));
}

#[tokio::test]
async fn changing_scopes_for_the_same_target_invalidates_pending_results() {
    let bridge = Arc::new(Bridge::default());
    let sink = DaemonSink::default();
    let (owner, sender, mut receiver) = desktop(&sink, &bridge);
    bridge
        .replace(
            owner,
            ClientRole::Desktop,
            sender.clone(),
            vec![target("target-one")],
        )
        .unwrap();
    let task = call(&bridge, metric("target-one"));
    let id = invoke_id(receive(&mut receiver).await, "target-one");
    let mut reduced = target("target-one");
    reduced.scopes.metrics = false;
    bridge
        .replace(owner, ClientRole::Desktop, sender, vec![reduced])
        .unwrap();
    bridge.resolve(
        owner,
        ClientRole::Desktop,
        id,
        Ok(json!({"secret": "result from an earlier scope"})),
    );
    assert!(completed(task).await.unwrap_err().contains("revoked"));
}

#[tokio::test]
async fn an_identical_grant_refresh_keeps_an_authorized_pending_result() {
    let bridge = Arc::new(Bridge::default());
    let sink = DaemonSink::default();
    let (owner, sender, mut receiver) = desktop(&sink, &bridge);
    bridge
        .replace(
            owner,
            ClientRole::Desktop,
            sender.clone(),
            vec![target("target-one")],
        )
        .unwrap();
    let task = call(&bridge, metric("target-one"));
    let id = invoke_id(receive(&mut receiver).await, "target-one");
    bridge
        .replace(
            owner,
            ClientRole::Desktop,
            sender,
            vec![target("target-one")],
        )
        .unwrap();
    bridge.resolve(owner, ClientRole::Desktop, id, Ok(json!({"fresh": true})));
    assert_eq!(completed(task).await.unwrap(), json!({"fresh": true}));
}

#[tokio::test]
async fn oversized_success_and_error_payloads_are_not_forwarded() {
    let bridge = Arc::new(Bridge::default());
    let sink = DaemonSink::default();
    let (owner, sender, mut receiver) = desktop(&sink, &bridge);
    bridge
        .replace(
            owner,
            ClientRole::Desktop,
            sender,
            vec![target("target-one")],
        )
        .unwrap();
    for response in [
        Ok(json!({"payload": "x".repeat(MAX_REPLY)})),
        Err("x".repeat(MAX_REPLY + 1)),
    ] {
        let task = call(&bridge, metric("target-one"));
        let id = invoke_id(receive(&mut receiver).await, "target-one");
        bridge.resolve(owner, ClientRole::Desktop, id, response);
        let error = completed(task).await.unwrap_err();
        assert!(error.contains("limit"));
        assert!(error.len() < 256);
    }
}

#[test]
fn target_ids_cannot_smuggle_paths_into_persistent_audit_metadata() {
    let bridge = Bridge::default();
    let sink = DaemonSink::default();
    let (owner, sender, _) = desktop(&sink, &bridge);
    for id in [
        "",
        "../private",
        "private.example",
        "C:\\private",
        "target_with_underscores",
    ] {
        assert!(bridge
            .replace(owner, ClientRole::Desktop, sender.clone(), vec![target(id)])
            .is_err());
    }
    assert!(bridge.owners.lock().unwrap().is_empty());
}

#[tokio::test]
async fn disconnected_owners_cannot_restore_grants_or_deliver_late_replies() {
    let bridge = Arc::new(Bridge::default());
    let sink = DaemonSink::default();
    let (owner, sender, mut receiver) = desktop(&sink, &bridge);
    bridge
        .replace(
            owner,
            ClientRole::Desktop,
            sender.clone(),
            vec![target("target-one")],
        )
        .unwrap();
    let task = call(&bridge, metric("target-one"));
    let id = invoke_id(receive(&mut receiver).await, "target-one");
    bridge.remove(owner);
    let error = completed(task).await.unwrap_err();
    assert!(error.contains("unknown"));
    assert!(bridge
        .replace(
            owner,
            ClientRole::Desktop,
            sender,
            vec![target("target-one")]
        )
        .is_err());
    bridge.resolve(owner, ClientRole::Desktop, id, Ok(json!({"late": true})));
    assert!(bridge.pending.lock().unwrap().is_empty());
    let listed = bridge
        .call("observer fixture", DesktopOperation::ListConnections)
        .await
        .unwrap();
    assert_eq!(listed, json!({"connections": []}));
}

#[tokio::test]
async fn aborting_a_call_releases_its_pending_entry_and_capacity() {
    let bridge = Arc::new(Bridge::default());
    let sink = DaemonSink::default();
    let (owner, sender, mut receiver) = desktop(&sink, &bridge);
    bridge
        .replace(
            owner,
            ClientRole::Desktop,
            sender,
            vec![target("target-one")],
        )
        .unwrap();
    let task = call(&bridge, metric("target-one"));
    let id = invoke_id(receive(&mut receiver).await, "target-one");
    assert_eq!(bridge.pending.lock().unwrap().len(), 1);
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(bridge.pending.lock().unwrap().is_empty());
    assert_eq!(bridge.allowance.available_permits(), MAX_CALLS);
    bridge.resolve(owner, ClientRole::Desktop, id, Ok(json!({"late": true})));
    assert!(bridge.pending.lock().unwrap().is_empty());
}

#[tokio::test]
async fn at_most_sixteen_invocations_can_be_in_flight() {
    let bridge = Arc::new(Bridge::default());
    let sink = DaemonSink::default();
    let (owner, sender, mut receiver) = desktop(&sink, &bridge);
    bridge
        .replace(
            owner,
            ClientRole::Desktop,
            sender,
            vec![target("target-one")],
        )
        .unwrap();
    let mut calls = Vec::new();
    for _ in 0..MAX_CALLS {
        calls.push(call(&bridge, metric("target-one")));
        invoke_id(receive(&mut receiver).await, "target-one");
    }
    assert_eq!(bridge.pending.lock().unwrap().len(), 16);
    assert_eq!(bridge.allowance.available_permits(), 0);
    assert!(bridge
        .call("observer fixture", metric("target-one"))
        .await
        .unwrap_err()
        .contains("Too many"));
    no_frame(&mut receiver);
    for task in calls {
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
    }
    assert!(bridge.pending.lock().unwrap().is_empty());
    assert_eq!(bridge.allowance.available_permits(), 16);
}

// This final test goes through the actual line reader, daemon connection role,
// inline grant handling, reverse-RPC writer, and response dispatch. Two frames
// in one write reproduce a revoke racing a result already queued by a desktop.
struct WireClient {
    reader: BufReader<tokio::io::ReadHalf<crate::agent_daemon::transport::ClientStream>>,
    writer: tokio::io::WriteHalf<crate::agent_daemon::transport::ClientStream>,
    role: ClientRole,
    last_sent: String,
    frames_read: usize,
}

impl WireClient {
    async fn connect(
        paths: &crate::agent_daemon::DaemonPaths,
        token: &str,
        role: ClientRole,
    ) -> Self {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let stream = loop {
            match crate::agent_daemon::transport::connect(paths).await {
                Ok(stream) => break stream,
                Err(_) if tokio::time::Instant::now() < deadline => {
                    tokio::time::sleep(Duration::from_millis(10)).await
                }
                Err(error) => panic!("test daemon should accept its local transport: {error}"),
            }
        };
        let (reader, writer) = tokio::io::split(stream);
        let mut client = Self {
            reader: BufReader::new(reader),
            writer,
            role,
            last_sent: "none".into(),
            frames_read: 0,
        };
        client
            .send(&[Frame::Request {
                id: 1,
                body: Request::Hello {
                    workspace_directory: None,
                    token: token.into(),
                    protocol: role.protocol_version(),
                    role,
                    client: Some("observer fixture".into()),
                },
            }])
            .await;
        assert!(matches!(
            client.read().await,
            Frame::Response {
                id: 1,
                ok: true,
                ..
            }
        ));
        client
    }

    async fn send(&mut self, frames: &[Frame]) {
        let mut batch = Vec::new();
        for frame in frames {
            self.last_sent = match frame {
                Frame::Request { id, body } => {
                    let kind = match body {
                        Request::Hello { .. } => "hello",
                        Request::DesktopGrants { .. } => "grants",
                        Request::DesktopCall { .. } => "call",
                        Request::Sessions => "sessions",
                        Request::Shutdown => "shutdown",
                        _ => "other request",
                    };
                    format!("{kind} id={id}")
                }
                Frame::Response { id, .. } => format!("response id={id}"),
                Frame::Event { .. } => "event".into(),
            };
            serde_json::to_writer(&mut batch, frame).unwrap();
            batch.push(b'\n');
        }
        self.writer.write_all(&batch).await.unwrap();
    }

    async fn read(&mut self) -> Frame {
        let mut line = String::new();
        let bytes = tokio::time::timeout(Duration::from_secs(5), self.reader.read_line(&mut line))
            .await
            .expect("a wire frame should arrive before the timeout")
            .unwrap();
        assert!(
            bytes > 0,
            "the {:?} peer should remain connected after {} ({} frames received)",
            self.role,
            self.last_sent,
            self.frames_read
        );
        self.frames_read += 1;
        serde_json::from_str(&line).unwrap()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_same_write_revocation_precedes_the_following_reverse_rpc_reply() {
    use crate::agent_daemon::{
        automations::Scheduler,
        server::{serve, Logger},
        DaemonPaths,
    };
    let directory = tempfile::tempdir().unwrap();
    let canonical = directory.path().canonicalize().unwrap();
    let paths = DaemonPaths::new(&canonical);
    let token = "bridge-wire-test-token-not-a-credential".to_string();
    let sink = Arc::new(DaemonSink::default());
    let server = tokio::spawn(serve(
        paths.clone(),
        token.clone(),
        Arc::new(crate::agent::AgentRegistry::new()),
        sink,
        Arc::new(Scheduler::open(&canonical)),
        Arc::new(crate::agent_chat::AgentChatRegistry::new()),
        Duration::from_secs(600),
        Arc::new(Logger::silent()),
    ));
    let mut desktop = WireClient::connect(&paths, &token, ClientRole::Desktop).await;
    let mut observer = WireClient::connect(&paths, &token, ClientRole::Observer).await;
    desktop
        .send(&[Frame::Request {
            id: 2,
            body: Request::DesktopGrants {
                targets: vec![target("target-wire")],
            },
        }])
        .await;
    assert!(matches!(
        desktop.read().await,
        Frame::Response {
            id: 2,
            ok: true,
            ..
        }
    ));
    // The real server also rejects observer attempts, not just Bridge::replace.
    observer
        .send(&[Frame::Request {
            id: 2,
            body: Request::DesktopGrants {
                targets: vec![target("forged-target")],
            },
        }])
        .await;
    assert!(matches!(
        observer.read().await,
        Frame::Response {
            id: 2,
            ok: false,
            ..
        }
    ));
    observer
        .send(&[Frame::Request {
            id: 3,
            body: Request::DesktopCall {
                operation: metric("target-wire"),
            },
        }])
        .await;
    let invocation = invoke_id(desktop.read().await, "target-wire");
    desktop
        .send(&[
            Frame::Request {
                id: 3,
                body: Request::DesktopGrants {
                    targets: Vec::new(),
                },
            },
            Frame::Response {
                id: invocation,
                ok: true,
                result: json!({"secret": "queued before revoke"}),
                error: None,
            },
        ])
        .await;
    assert!(matches!(
        desktop.read().await,
        Frame::Response {
            id: 3,
            ok: true,
            ..
        }
    ));
    match observer.read().await {
        Frame::Response {
            id: 3,
            ok: false,
            result,
            error,
        } => {
            assert!(result.is_null());
            let error = error.unwrap();
            assert!(error.contains("revoked"));
            assert!(!error.contains("queued before revoke"));
        }
        _ => panic!("a revoked operation must not reveal the queued result"),
    }
    desktop
        .send(&[Frame::Request {
            id: 4,
            body: Request::Shutdown,
        }])
        .await;
    assert!(matches!(
        desktop.read().await,
        Frame::Response {
            id: 4,
            ok: true,
            ..
        }
    ));
    drop(observer);
    drop(desktop);
    tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

async fn adapter_tool(
    adapter: &crate::agent_daemon::mcp::McpServer,
    id: u64,
    name: &str,
    arguments: Value,
) -> Value {
    tokio::time::timeout(
        Duration::from_secs(3),
        adapter.handle(json!({
            "jsonrpc": "2.0", "id": id, "method": "tools/call",
            "params": { "name": name, "arguments": arguments },
        })),
    )
    .await
    .expect("the synthetic adapter call should finish promptly")
    .unwrap()
}

fn adapter_metric(
    adapter: &Arc<crate::agent_daemon::mcp::McpServer>,
    id: u64,
) -> tokio::task::JoinHandle<Value> {
    let adapter = Arc::clone(adapter);
    tokio::spawn(async move {
        adapter_tool(
            &adapter,
            id,
            "get_host_metrics",
            json!({"targetId": "target-adapter"}),
        )
        .await
    })
}

async fn adapter_invocation(desktop: &mut WireClient) -> u64 {
    match desktop.read().await {
        Frame::Request {
            id,
            body: Request::DesktopInvoke { client, operation },
        } => {
            assert_eq!(client, "synthetic adapter 1.0");
            assert!(
                matches!(operation, DesktopOperation::GetMetrics { ref target_id } if target_id == "target-adapter")
            );
            assert_eq!(
                serde_json::to_value(operation).unwrap(),
                json!({"type": "getMetrics", "targetId": "target-adapter"})
            );
            id
        }
        _ => panic!("get_host_metrics must map to the fixed metrics operation only"),
    }
}

/// Contract test, not host acceptance: a real MCP adapter and daemon observer
/// transport talk to a synthetic desktop peer. No SSH command is executed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_adapter_remote_tools_obey_desktop_scope_revocation_and_disconnect() {
    use crate::agent_daemon::{
        automations::Scheduler,
        mcp::McpServer,
        read_or_create_token,
        server::{serve, Logger},
        DaemonPaths,
    };
    let directory = tempfile::tempdir().unwrap();
    let canonical = directory.path().canonicalize().unwrap();
    let paths = DaemonPaths::new(&canonical);
    let token = read_or_create_token(&paths).unwrap();
    let server = tokio::spawn(serve(
        paths.clone(),
        token.clone(),
        Arc::new(crate::agent::AgentRegistry::new()),
        Arc::new(DaemonSink::default()),
        Arc::new(Scheduler::open(&canonical)),
        Arc::new(crate::agent_chat::AgentChatRegistry::new()),
        Duration::from_secs(600),
        Arc::new(Logger::silent()),
    ));
    let mut desktop = WireClient::connect(&paths, &token, ClientRole::Desktop).await;
    // Connected does not mean shared: this second peer never grants a target.
    let mut unshared_desktop = WireClient::connect(&paths, &token, ClientRole::Desktop).await;
    let adapter = Arc::new(McpServer::new(paths));
    let initialized = adapter
        .handle(json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-06-18", "capabilities": {},
                "clientInfo": {"name": "synthetic adapter", "version": "1.0"} },
        }))
        .await
        .unwrap();
    assert_eq!(initialized["result"]["protocolVersion"], "2025-06-18");
    let empty = adapter_tool(&adapter, 2, "list_authorized_connections", json!({})).await;
    assert_eq!(empty["result"]["isError"], false);
    assert_eq!(
        empty["result"]["structuredContent"]["connections"],
        json!([])
    );

    desktop
        .send(&[Frame::Request {
            id: 2,
            body: Request::DesktopGrants {
                targets: vec![target("target-adapter")],
            },
        }])
        .await;
    assert!(matches!(
        desktop.read().await,
        Frame::Response {
            id: 2,
            ok: true,
            ..
        }
    ));
    let listed = adapter_tool(&adapter, 3, "list_authorized_connections", json!({})).await;
    let connections = listed["result"]["structuredContent"]["connections"]
        .as_array()
        .unwrap();
    assert_eq!(connections.len(), 1);
    assert_eq!(connections[0]["id"], "target-adapter");
    for private in [
        "host",
        "username",
        "sessionId",
        "command",
        "localPath",
        "remotePath",
    ] {
        assert!(
            connections[0].get(private).is_none(),
            "unexpected private field: {private}"
        );
    }

    let metrics = adapter_metric(&adapter, 4);
    let invocation = adapter_invocation(&mut desktop).await;
    let fixture =
        json!({"syntheticFixture": true, "metrics": {"cpuPercent": 12.5}, "platform": "linux"});
    desktop
        .send(&[Frame::Response {
            id: invocation,
            ok: true,
            result: fixture.clone(),
            error: None,
        }])
        .await;
    let metrics = metrics.await.unwrap();
    assert_eq!(metrics["result"]["isError"], false);
    assert_eq!(metrics["result"]["structuredContent"], fixture);

    let denied = adapter_tool(
        &adapter,
        5,
        "ssh_exec_job",
        json!({
            "targetId": "target-adapter", "planId": "not-granted", "requestId": "scope-check",
        }),
    )
    .await;
    assert_eq!(denied["result"]["isError"], true);
    for (id, arguments) in [
        (6, json!({"targetId": "target-adapter", "type": "exec"})),
        (
            7,
            json!({"targetId": "target-adapter", "command": "never executed"}),
        ),
    ] {
        let invalid = adapter_tool(&adapter, id, "get_host_metrics", arguments).await;
        assert_eq!(invalid["error"]["code"], -32602);
    }
    // A marker response must be the next frame: none of these rejected calls
    // may have queued a DesktopInvoke for either desktop connection.
    for (peer, id) in [(&mut desktop, 3), (&mut unshared_desktop, 2)] {
        peer.send(&[Frame::Request {
            id,
            body: Request::Sessions,
        }])
        .await;
        assert!(
            matches!(peer.read().await, Frame::Response { id: got, ok: true, .. } if got == id)
        );
    }

    let revoked = adapter_metric(&adapter, 8);
    let invocation = adapter_invocation(&mut desktop).await;
    desktop
        .send(&[
            Frame::Request {
                id: 4,
                body: Request::DesktopGrants {
                    targets: Vec::new(),
                },
            },
            Frame::Response {
                id: invocation,
                ok: true,
                result: json!({"secret": "withheld synthetic result"}),
                error: None,
            },
        ])
        .await;
    assert!(matches!(
        desktop.read().await,
        Frame::Response {
            id: 4,
            ok: true,
            ..
        }
    ));
    let revoked = revoked.await.unwrap();
    assert_eq!(revoked["result"]["isError"], true);
    assert!(!revoked.to_string().contains("withheld synthetic result"));
    assert!(revoked["result"]["structuredContent"]["error"]
        .as_str()
        .unwrap()
        .contains("revoked"));
    let still_revoked = adapter_tool(
        &adapter,
        9,
        "get_host_metrics",
        json!({"targetId": "target-adapter"}),
    )
    .await;
    assert_eq!(still_revoked["result"]["isError"], true);

    desktop
        .send(&[Frame::Request {
            id: 5,
            body: Request::DesktopGrants {
                targets: vec![target("target-adapter")],
            },
        }])
        .await;
    assert!(matches!(
        desktop.read().await,
        Frame::Response {
            id: 5,
            ok: true,
            ..
        }
    ));
    let disconnected = adapter_metric(&adapter, 10);
    adapter_invocation(&mut desktop).await;
    drop(desktop);
    let disconnected = disconnected.await.unwrap();
    assert_eq!(disconnected["result"]["isError"], true);
    assert!(disconnected["result"]["structuredContent"]["error"]
        .as_str()
        .unwrap()
        .contains("unknown"));
    let no_longer_shared =
        adapter_tool(&adapter, 11, "list_authorized_connections", json!({})).await;
    assert_eq!(
        no_longer_shared["result"]["structuredContent"]["connections"],
        json!([])
    );
    drop(adapter);

    unshared_desktop
        .send(&[Frame::Request {
            id: 3,
            body: Request::Shutdown,
        }])
        .await;
    assert!(matches!(
        unshared_desktop.read().await,
        Frame::Response {
            id: 3,
            ok: true,
            ..
        }
    ));
    drop(unshared_desktop);
    tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}
