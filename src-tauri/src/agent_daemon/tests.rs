//! End-to-end over a real socket: an in-process daemon on a temporary data
//! directory, and a raw client speaking the wire protocol the way the
//! desktop does. Unix only: the named-pipe transport has no CI here.

use super::server::{serve, DaemonSink, Logger};
use super::{
    read_or_create_token, transport, ClientRole, DaemonPaths, Frame, Request, PROTOCOL_VERSION,
};
use crate::agent::{AgentLaunchRequest, AgentRegistry, AgentSink};
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

struct RawClient {
    reader: BufReader<tokio::io::ReadHalf<transport::ClientStream>>,
    writer: tokio::io::WriteHalf<transport::ClientStream>,
    next: u64,
    events: Vec<(String, Value)>,
}

impl RawClient {
    async fn connect(paths: &DaemonPaths) -> Self {
        let stream = transport::connect(paths).await.expect("connect");
        let (read, writer) = tokio::io::split(stream);
        Self {
            reader: BufReader::new(read),
            writer,
            next: 0,
            events: Vec::new(),
        }
    }

    async fn read(&mut self) -> Frame {
        let mut line = String::new();
        let read = tokio::time::timeout(Duration::from_secs(20), self.reader.read_line(&mut line))
            .await
            .expect("frame within the deadline")
            .expect("readable");
        assert!(read > 0, "daemon closed the connection");
        serde_json::from_str(&line).expect("a frame")
    }

    /// Sends a request and returns its response, keeping every event that
    /// arrives meanwhile.
    async fn request(&mut self, body: Request) -> Result<Value, String> {
        self.next += 1;
        let id = self.next;
        let line = serde_json::to_string(&Frame::Request { id, body }).unwrap();
        self.writer.write_all(line.as_bytes()).await.unwrap();
        self.writer.write_all(b"\n").await.unwrap();
        loop {
            match self.read().await {
                Frame::Response {
                    id: got,
                    ok,
                    result,
                    error,
                } if got == id => {
                    return if ok {
                        Ok(result)
                    } else {
                        Err(error.unwrap_or_default())
                    };
                }
                Frame::Event { name, payload } => self.events.push((name, payload)),
                _ => {}
            }
        }
    }

    async fn wait_for_event(&mut self, name: &str, matches: impl Fn(&Value) -> bool) -> Value {
        if let Some(index) = self
            .events
            .iter()
            .position(|(event, payload)| event == name && matches(payload))
        {
            return self.events.remove(index).1;
        }
        loop {
            if let Frame::Event {
                name: event,
                payload,
            } = self.read().await
            {
                if event == name && matches(&payload) {
                    return payload;
                }
                self.events.push((event, payload));
            }
        }
    }
}

fn launch_request(command: &str) -> AgentLaunchRequest {
    AgentLaunchRequest {
        definition_id: "custom".to_string(),
        label: "shell".to_string(),
        executable: "/bin/sh".to_string(),
        arguments: vec!["-c".to_string(), command.to_string()],
        resume_session_id: None,
        group_id: None,
        seed_input: None,
        restore_existing_session: false,
        profile_config_path: None,
        sandbox: false,
        detached: false,
        working_directory: std::env::temp_dir().display().to_string(),
        cols: 80,
        rows: 24,
    }
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_desktop_attaches_launches_and_reattaches_over_the_socket() {
    let dir = tempfile::tempdir().unwrap();
    let paths = DaemonPaths::new(dir.path());
    let token = read_or_create_token(&paths).unwrap();
    let sink = Arc::new(DaemonSink::default());
    let registry = AgentRegistry::with_local_reporter_prefixed(
        Arc::clone(&sink) as Arc<dyn AgentSink>,
        super::SESSION_ID_PREFIX,
    )
    .unwrap();
    let server = tokio::spawn(serve(
        paths.clone(),
        token.clone(),
        Arc::clone(&registry),
        Arc::clone(&sink),
        Arc::new(super::automations::Scheduler::open(dir.path())),
        Arc::new(crate::agent_chat::AgentChatRegistry::new()),
        Duration::from_secs(600),
        Arc::new(Logger::silent()),
    ));
    for _ in 0..50 {
        if paths.socket.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    // A wrong token is refused before anything else happens.
    let mut stranger = RawClient::connect(&paths).await;
    let refused = stranger
        .request(Request::Hello {
            token: "nope".to_string(),
            protocol: PROTOCOL_VERSION,
            role: ClientRole::Desktop,
        })
        .await;
    assert!(refused.is_err());

    let mut desktop = RawClient::connect(&paths).await;
    let hello = desktop
        .request(Request::Hello {
            token: token.clone(),
            protocol: PROTOCOL_VERSION,
            role: ClientRole::Desktop,
        })
        .await
        .unwrap();
    assert_eq!(hello["protocol"], PROTOCOL_VERSION);
    assert_eq!(hello["sessions"].as_array().unwrap().len(), 0);

    let launched = desktop
        .request(Request::Launch {
            request: Box::new(launch_request("echo daemon-hello; sleep 30")),
            restored_output: None,
        })
        .await
        .unwrap();
    let session_id = launched["sessionId"].as_str().unwrap().to_string();
    assert!(session_id.starts_with(super::SESSION_ID_PREFIX));
    assert_eq!(launched["detached"], true);

    use base64::Engine as _;
    let data = desktop
        .wait_for_event("data", |payload| {
            payload["sessionId"] == session_id.as_str()
                && base64::engine::general_purpose::STANDARD
                    .decode(payload["base64"].as_str().unwrap_or(""))
                    .map(|bytes| String::from_utf8_lossy(&bytes).contains("daemon-hello"))
                    .unwrap_or(false)
        })
        .await;
    assert!(data["offset"].is_u64());

    // The window goes away; the CLI does not.
    drop(desktop);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(registry.list().len(), 1);
    assert_eq!(sink.client_count(), 0);

    // A new window sees the session and its output tail in the greeting.
    let mut next_window = RawClient::connect(&paths).await;
    let hello = next_window
        .request(Request::Hello {
            token: token.clone(),
            protocol: PROTOCOL_VERSION,
            role: ClientRole::Desktop,
        })
        .await
        .unwrap();
    let sessions = hello["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["sessionId"], session_id.as_str());
    assert_eq!(sessions[0]["detached"], true);
    let snapshots = hello["snapshots"].as_array().unwrap();
    let tail = base64::engine::general_purpose::STANDARD
        .decode(snapshots[0]["base64"].as_str().unwrap())
        .unwrap();
    assert!(String::from_utf8_lossy(&tail).contains("daemon-hello"));

    let renamed = next_window
        .request(Request::Rename {
            session_id: session_id.clone(),
            label: "renamed".to_string(),
        })
        .await
        .unwrap();
    assert_eq!(renamed["groupLabel"], "renamed");

    next_window
        .request(Request::Disconnect {
            session_id: session_id.clone(),
        })
        .await
        .unwrap();
    let closed = next_window
        .wait_for_event("closed", |payload| {
            payload["sessionId"] == session_id.as_str()
        })
        .await;
    assert!(closed["reason"].is_string());
    assert!(registry.list().is_empty());

    next_window.request(Request::Shutdown).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .expect("the daemon stops when told")
        .unwrap()
        .unwrap();
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_idle_daemon_exits_by_itself() {
    let dir = tempfile::tempdir().unwrap();
    let paths = DaemonPaths::new(dir.path());
    let token = read_or_create_token(&paths).unwrap();
    let sink = Arc::new(DaemonSink::default());
    let registry = AgentRegistry::with_local_reporter_prefixed(
        Arc::clone(&sink) as Arc<dyn AgentSink>,
        super::SESSION_ID_PREFIX,
    )
    .unwrap();
    let server = tokio::spawn(serve(
        paths,
        token,
        registry,
        sink,
        Arc::new(super::automations::Scheduler::open(dir.path())),
        Arc::new(crate::agent_chat::AgentChatRegistry::new()),
        Duration::from_millis(1),
        Arc::new(Logger::silent()),
    ));
    tokio::time::timeout(Duration::from_secs(15), server)
        .await
        .expect("idle exit")
        .unwrap()
        .unwrap();
}

/// The MCP adapter's view: an observer sees only what the user shared, is
/// never fed terminal bytes as events, and cannot do anything but read.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_observer_reads_only_shared_sessions_and_nothing_else() {
    use base64::Engine as _;
    let dir = tempfile::tempdir().unwrap();
    let paths = DaemonPaths::new(dir.path());
    let token = read_or_create_token(&paths).unwrap();
    let sink = Arc::new(DaemonSink::default());
    let registry = AgentRegistry::with_local_reporter_prefixed(
        Arc::clone(&sink) as Arc<dyn AgentSink>,
        super::SESSION_ID_PREFIX,
    )
    .unwrap();
    let server = tokio::spawn(serve(
        paths.clone(),
        token.clone(),
        Arc::clone(&registry),
        Arc::clone(&sink),
        Arc::new(super::automations::Scheduler::open(dir.path())),
        Arc::new(crate::agent_chat::AgentChatRegistry::new()),
        Duration::from_secs(600),
        Arc::new(Logger::silent()),
    ));
    for _ in 0..50 {
        if paths.socket.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    let mut desktop = RawClient::connect(&paths).await;
    desktop
        .request(Request::Hello {
            token: token.clone(),
            protocol: PROTOCOL_VERSION,
            role: ClientRole::Desktop,
        })
        .await
        .unwrap();
    let launch = |command: &str| Request::Launch {
        request: Box::new(launch_request(command)),
        restored_output: None,
    };
    let secret = desktop
        .request(launch("echo top-secret; sleep 30"))
        .await
        .unwrap()["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    let public = desktop
        .request(launch("echo shared-line; sleep 30"))
        .await
        .unwrap()["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    for id in [&secret, &public] {
        desktop
            .wait_for_event("data", |payload| payload["sessionId"] == id.as_str())
            .await;
    }

    // Nothing is shared until the user says so.
    let mut observer = RawClient::connect(&paths).await;
    let hello = observer
        .request(Request::Hello {
            token: token.clone(),
            protocol: PROTOCOL_VERSION,
            role: ClientRole::Observer,
        })
        .await
        .unwrap();
    assert_eq!(hello["sessions"].as_array().unwrap().len(), 0);
    assert_eq!(hello["snapshots"].as_array().unwrap().len(), 0);
    assert_eq!(
        observer.request(Request::Sessions).await.unwrap(),
        Value::Array(Vec::new())
    );
    // Observers are not desktops: automations and idle exit ignore them.
    assert_eq!(sink.client_count(), 1);

    let shared = desktop
        .request(Request::ShareSet {
            session_id: public.clone(),
            shared: true,
        })
        .await
        .unwrap();
    assert_eq!(shared, serde_json::json!([public.clone()]));
    assert!(desktop
        .request(Request::ShareSet {
            session_id: "agent-bg-session-nope".to_string(),
            shared: true,
        })
        .await
        .is_err());

    let listed = observer.request(Request::Sessions).await.unwrap();
    let listed = listed.as_array().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["sessionId"], public.as_str());

    // Output follows a cursor, only for the shared session.
    let first = observer
        .request(Request::Observe {
            session_id: public.clone(),
            cursor: 0,
            max_bytes: 6,
        })
        .await
        .unwrap();
    let decoded = |value: &Value| {
        String::from_utf8(
            base64::engine::general_purpose::STANDARD
                .decode(value["base64"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap()
    };
    assert_eq!(decoded(&first), "shared");
    assert_eq!(first["nextCursor"], 6);
    let rest = observer
        .request(Request::Observe {
            session_id: public.clone(),
            cursor: first["nextCursor"].as_u64().unwrap(),
            max_bytes: 0,
        })
        .await
        .unwrap();
    assert!(decoded(&rest).starts_with("-line"));
    assert_eq!(rest["truncated"], false);
    let refused = observer
        .request(Request::Observe {
            session_id: secret.clone(),
            cursor: 0,
            max_bytes: 0,
        })
        .await
        .unwrap_err();
    assert!(refused.contains("not shared"), "{refused}");

    // Nothing that changes state is allowed, whatever the request.
    for request in [
        Request::Send {
            session_id: public.clone(),
            data: "aGk=".to_string(),
        },
        Request::Disconnect {
            session_id: public.clone(),
        },
        Request::Snapshots,
        Request::Shared,
        Request::ShareSet {
            session_id: secret.clone(),
            shared: true,
        },
        Request::Shutdown,
        launch("echo nope"),
    ] {
        assert!(observer.request(request).await.is_err());
    }
    assert_eq!(registry.list().len(), 2, "the observer stopped nothing");

    // Sharing is revocable, and ends with the session.
    desktop
        .request(Request::ShareSet {
            session_id: public.clone(),
            shared: false,
        })
        .await
        .unwrap();
    assert_eq!(
        observer.request(Request::Sessions).await.unwrap(),
        Value::Array(Vec::new())
    );
    desktop
        .request(Request::ShareSet {
            session_id: public.clone(),
            shared: true,
        })
        .await
        .unwrap();
    desktop
        .request(Request::Disconnect {
            session_id: public.clone(),
        })
        .await
        .unwrap();
    let closed = observer
        .wait_for_event("closed", |payload| payload["sessionId"] == public.as_str())
        .await;
    assert!(closed["reason"].is_string());
    assert_eq!(
        desktop.request(Request::Shared).await.unwrap(),
        Value::Array(Vec::new())
    );
    // The observer heard about the shared session's end but never saw a
    // byte of either session's terminal as an event.
    assert!(observer
        .events
        .iter()
        .all(|(name, payload)| name != "data" && payload["sessionId"] != secret.as_str()));

    desktop.request(Request::Shutdown).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .expect("the daemon stops when told")
        .unwrap()
        .unwrap();
}
