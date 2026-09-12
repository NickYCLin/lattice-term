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
            workspace_directory: None,
            token: "nope".to_string(),
            protocol: PROTOCOL_VERSION,
            role: ClientRole::Desktop,
            client: None,
        })
        .await;
    assert!(refused.is_err());

    let mut desktop = RawClient::connect(&paths).await;
    let hello = desktop
        .request(Request::Hello {
            workspace_directory: None,
            token: token.clone(),
            protocol: PROTOCOL_VERSION,
            role: ClientRole::Desktop,
            client: None,
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
            workspace_directory: None,
            token: token.clone(),
            protocol: PROTOCOL_VERSION,
            role: ClientRole::Desktop,
            client: None,
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
            workspace_directory: None,
            token: token.clone(),
            protocol: PROTOCOL_VERSION,
            role: ClientRole::Desktop,
            client: None,
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
            workspace_directory: None,
            token: token.clone(),
            protocol: ClientRole::Observer.protocol_version(),
            role: ClientRole::Observer,
            client: Some("test-client 1.0".to_string()),
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
            read_output: Some(false),
        })
        .await
        .unwrap();
    assert_eq!(
        shared,
        serde_json::json!([{ "sessionId": public.clone(), "control": false, "readOutput": false }])
    );
    assert!(desktop
        .request(Request::ShareSet {
            session_id: "agent-bg-session-nope".to_string(),
            shared: true,
            read_output: None,
        })
        .await
        .is_err());

    let listed = observer.request(Request::Sessions).await.unwrap();
    let listed = listed.as_array().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["sessionId"], public.as_str());
    assert_eq!(listed[0]["mcpControl"], false);
    assert_eq!(listed[0]["mcpReadOutput"], false);
    assert_eq!(listed[0]["launchArguments"], serde_json::json!([]));
    assert_eq!(listed[0]["executable"], "");
    assert!(listed[0]["processId"].is_null());
    assert!(!listed[0].to_string().contains("echo shared-line"));
    let mut additional_observer = RawClient::connect(&paths).await;
    let hello = additional_observer
        .request(Request::Hello {
            workspace_directory: None,
            token: token.clone(),
            protocol: ClientRole::Observer.protocol_version(),
            role: ClientRole::Observer,
            client: Some("metadata observer".into()),
        })
        .await
        .unwrap();
    assert_eq!(
        hello["sessions"][0]["launchArguments"],
        serde_json::json!([])
    );
    assert!(!hello.to_string().contains("echo shared-line"));
    assert!(!hello.to_string().contains("top-secret"));
    drop(additional_observer);
    assert!(observer
        .request(Request::Observe {
            session_id: public.clone(),
            cursor: 0,
            max_bytes: 6,
        })
        .await
        .unwrap_err()
        .contains("not shared"));

    desktop
        .request(Request::ControlSet {
            session_id: public.clone(),
            control: true,
        })
        .await
        .unwrap();
    let changed = desktop
        .request(Request::ShareSet {
            session_id: public.clone(),
            shared: true,
            read_output: Some(true),
        })
        .await
        .unwrap();
    assert_eq!(changed[0]["readOutput"], true);
    assert_eq!(
        changed[0]["control"], true,
        "content access does not change control"
    );
    desktop
        .request(Request::ControlSet {
            session_id: public.clone(),
            control: false,
        })
        .await
        .unwrap();

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

    // Reading a session's terminal is in the history like the writes are,
    // folded per client and session, and an attempt on a session that is
    // not shared is recorded too.
    let history = desktop.request(Request::McpHistory).await.unwrap();
    let reads: Vec<&Value> = history["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["action"] == "read")
        .collect();
    // One folded accepted read, plus the two refusals: before sharing, and
    // on a session that was never shared.
    assert_eq!(reads.len(), 3, "{reads:?}");
    let accepted = reads
        .iter()
        .find(|entry| entry["outcome"] == "accepted")
        .unwrap();
    assert_eq!(accepted["sessionId"], public.as_str());
    assert_eq!(accepted["client"], "test-client 1.0");
    assert!(accepted["repeated"].as_u64().unwrap() >= 2, "{accepted}");
    assert!(accepted["firstAt"].as_u64().unwrap() <= accepted["at"].as_u64().unwrap());
    let denied: Vec<&str> = reads
        .iter()
        .filter(|entry| entry["outcome"] == "failed")
        .map(|entry| entry["sessionId"].as_str().unwrap())
        .collect();
    assert!(denied.contains(&secret.as_str()), "{denied:?}");
    assert!(denied.contains(&public.as_str()), "{denied:?}");
    // The history never carries what was read.
    assert!(!history.to_string().contains("top-secret"));

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
            read_output: None,
        },
        Request::Shutdown,
        launch("echo nope"),
        // Shared is not controlled: prompting and cancelling are refused.
        Request::Prompt {
            session_id: public.clone(),
            text: "hello".to_string(),
            mode: super::PromptMode::Now,
            request_id: String::new(),
        },
        Request::Cancel {
            session_id: public.clone(),
            scope: super::CancelScope::Session,
            request_id: String::new(),
        },
        // Nothing to launch until the user allows plans.
        Request::LaunchPlan {
            plan_id: "agent-plan-x".to_string(),
            request_id: String::new(),
        },
    ] {
        assert!(observer.request(request).await.is_err());
    }
    assert_eq!(registry.list().len(), 2, "the observer stopped nothing");

    // Sharing is revocable — observers are told, so a wait ends at once —
    // and ends with the session.
    desktop
        .request(Request::ShareSet {
            session_id: public.clone(),
            shared: false,
            read_output: None,
        })
        .await
        .unwrap();
    observer
        .wait_for_event("unshared", |payload| {
            payload["sessionId"] == public.as_str()
        })
        .await;
    assert_eq!(
        observer.request(Request::Sessions).await.unwrap(),
        Value::Array(Vec::new())
    );
    desktop
        .request(Request::ShareSet {
            session_id: public.clone(),
            shared: true,
            read_output: None,
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

/// With control granted, an observer can prompt, drop the queue, launch an
/// allowed plan and end what it started — once per request id.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_controlling_observer_prompts_launches_and_cancels_once_per_request() {
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
            workspace_directory: None,
            token: token.clone(),
            protocol: PROTOCOL_VERSION,
            role: ClientRole::Desktop,
            client: None,
        })
        .await
        .unwrap();
    let mut observer = RawClient::connect(&paths).await;
    observer
        .request(Request::Hello {
            workspace_directory: None,
            token: token.clone(),
            protocol: ClientRole::Observer.protocol_version(),
            role: ClientRole::Observer,
            client: Some("test-client 1.0".to_string()),
        })
        .await
        .unwrap();

    // A shell that echoes what it is typed: `cat` answers every line.
    let session = desktop
        .request(Request::Launch {
            request: Box::new(launch_request("cat")),
            restored_output: None,
        })
        .await
        .unwrap()["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    desktop
        .request(Request::ShareSet {
            session_id: session.clone(),
            shared: true,
            read_output: None,
        })
        .await
        .unwrap();
    // Control needs sharing first, and is reported to the desktop.
    assert!(desktop
        .request(Request::ControlSet {
            session_id: "agent-bg-session-nope".to_string(),
            control: true,
        })
        .await
        .is_err());
    let shared = desktop
        .request(Request::ControlSet {
            session_id: session.clone(),
            control: true,
        })
        .await
        .unwrap();
    assert_eq!(shared[0]["control"], true);
    let listed = observer.request(Request::Sessions).await.unwrap();
    assert_eq!(listed[0]["mcpControl"], true);

    // A shell's guessed idle state is not authorization to type into an
    // unknown terminal mode. It can queue, but only a real reporter can
    // release the prompt.
    assert!(observer
        .request(Request::Prompt {
            session_id: session.clone(),
            text: "ping from mcp\n".to_string(),
            mode: super::PromptMode::Now,
            request_id: "unready-now".to_string(),
        })
        .await
        .is_err());
    assert!(observer
        .request(Request::Prompt {
            session_id: session.clone(),
            text: "missing request id".to_string(),
            mode: super::PromptMode::Queue,
            request_id: String::new(),
        })
        .await
        .unwrap_err()
        .contains("requestId"));
    let queued = observer
        .request(Request::Prompt {
            session_id: session.clone(),
            text: "ping from mcp\n".to_string(),
            mode: super::PromptMode::Queue,
            request_id: "req-1".to_string(),
        })
        .await
        .unwrap();
    assert_eq!(queued["sentImmediately"], false);
    assert_eq!(queued["queued"], 1);
    // The same request id again is the same outcome, not a second prompt.
    let again = observer
        .request(Request::Prompt {
            session_id: session.clone(),
            text: "ping from mcp\n".to_string(),
            mode: super::PromptMode::Queue,
            request_id: "req-1".to_string(),
        })
        .await
        .unwrap();
    assert_eq!(again["duplicate"], true);
    let mismatched = observer
        .request(Request::Prompt {
            session_id: session.clone(),
            text: "changed prompt".to_string(),
            mode: super::PromptMode::Queue,
            request_id: "req-1".to_string(),
        })
        .await
        .unwrap_err();
    assert!(mismatched.contains("different operation"));
    assert_eq!(registry.list()[0].queued_prompts, 1);
    // The user sees who did what.
    let shared = desktop.request(Request::Shared).await.unwrap();
    assert_eq!(shared[0]["activity"]["client"], "test-client 1.0");
    assert_eq!(shared[0]["activity"]["action"], "queue");

    // `queue` on a session whose state is only guessed waits for a real
    // report; dropping the queue is the observer's to do.
    let queued = observer
        .request(Request::Prompt {
            session_id: session.clone(),
            text: "later".to_string(),
            mode: super::PromptMode::Queue,
            request_id: "queue-later".to_string(),
        })
        .await
        .unwrap();
    assert_eq!(queued["queued"], 2);
    let cleared = observer
        .request(Request::Cancel {
            session_id: session.clone(),
            scope: super::CancelScope::Queue,
            request_id: "clear-queue".to_string(),
        })
        .await
        .unwrap();
    assert_eq!(cleared["dropped"], 2);

    // Plans: nothing until allowed, then exactly the allowed ones.
    assert_eq!(
        observer.request(Request::Plans).await.unwrap()["enabled"],
        false
    );
    desktop
        .request(Request::McpPlansReplace {
            enabled: true,
            plans: vec![super::McpPlan {
                plan_id: "agent-plan-1".to_string(),
                label: "shell".to_string(),
                note: "echoes".to_string(),
                definition_id: "custom".to_string(),
                working_directory: std::env::temp_dir().display().to_string(),
                sandbox: false,
                request: launch_request("echo planned; sleep 30"),
            }],
        })
        .await
        .unwrap();
    let plans = observer.request(Request::Plans).await.unwrap();
    assert_eq!(plans["plans"][0]["planId"], "agent-plan-1");
    assert!(plans["plans"][0].get("request").is_none());
    let mut retrying_observer = RawClient::connect(&paths).await;
    retrying_observer
        .request(Request::Hello {
            workspace_directory: None,
            token: token.clone(),
            protocol: ClientRole::Observer.protocol_version(),
            role: ClientRole::Observer,
            client: Some("test-client 1.0".to_string()),
        })
        .await
        .unwrap();
    // Concurrent connections must reserve the id before spawning the CLI.
    let (launched, concurrent_retry) = tokio::join!(
        observer.request(Request::LaunchPlan {
            plan_id: "agent-plan-1".to_string(),
            request_id: "launch-1".to_string(),
        }),
        retrying_observer.request(Request::LaunchPlan {
            plan_id: "agent-plan-1".to_string(),
            request_id: "launch-1".to_string(),
        }),
    );
    let launched = launched.unwrap();
    let concurrent_retry = concurrent_retry.unwrap();
    let planned = launched["sessionId"].as_str().unwrap().to_string();
    assert_eq!(concurrent_retry["sessionId"], planned.as_str());
    assert_ne!(
        launched["duplicate"].as_bool().unwrap_or(false),
        concurrent_retry["duplicate"].as_bool().unwrap_or(false),
    );
    assert_eq!(launched["detached"], true);
    // The desktop hears about it and sees it shared with control.
    let announced = desktop
        .wait_for_event("launched", |payload| {
            payload["sessionId"] == planned.as_str()
        })
        .await;
    assert_eq!(announced["label"], "shell");
    let shared = desktop.request(Request::Shared).await.unwrap();
    assert!(shared
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["sessionId"] == planned.as_str() && entry["control"] == true));
    let repeat = observer
        .request(Request::LaunchPlan {
            plan_id: "agent-plan-1".to_string(),
            request_id: "launch-1".to_string(),
        })
        .await
        .unwrap();
    assert_eq!(repeat["sessionId"], planned.as_str());
    assert_eq!(repeat["duplicate"], true);
    assert_eq!(registry.list().len(), 2, "a retry launched nothing new");
    assert_eq!(repeat["launchArguments"], serde_json::json!([]));
    assert_eq!(repeat["executable"], "");
    assert_eq!(repeat["mcpReadOutput"], true);
    desktop
        .request(Request::ShareSet {
            session_id: planned.clone(),
            shared: true,
            read_output: Some(false),
        })
        .await
        .unwrap();
    let metadata_repeat = observer
        .request(Request::LaunchPlan {
            plan_id: "agent-plan-1".into(),
            request_id: "launch-1".into(),
        })
        .await
        .unwrap();
    assert_eq!(metadata_repeat["mcpReadOutput"], false);
    assert_eq!(metadata_repeat["launchArguments"], serde_json::json!([]));
    assert!(sink.has_control(&planned));

    // Ending what it started; the session is unshared with it.
    let ended = observer
        .request(Request::Cancel {
            session_id: planned.clone(),
            scope: super::CancelScope::Session,
            request_id: "end-session".to_string(),
        })
        .await
        .unwrap();
    assert_eq!(ended["ended"], true);
    observer
        .wait_for_event("closed", |payload| payload["sessionId"] == planned.as_str())
        .await;
    assert_eq!(registry.list().len(), 1);
    assert!(!sink.is_shared(&planned));
    let ended_again = observer
        .request(Request::Cancel {
            session_id: planned.clone(),
            scope: super::CancelScope::Session,
            request_id: "end-session".to_string(),
        })
        .await
        .unwrap();
    assert_eq!(ended_again["ended"], true);
    assert_eq!(ended_again["duplicate"], true);
    // A cached launch must not disclose a session after its sharing ends.
    assert!(observer
        .request(Request::LaunchPlan {
            plan_id: "agent-plan-1".to_string(),
            request_id: "launch-1".to_string(),
        })
        .await
        .is_err());

    // Taking control back leaves sharing in place.
    use base64::Engine as _;
    desktop
        .request(Request::Enqueue {
            session_id: session.clone(),
            data: base64::engine::general_purpose::STANDARD.encode(b"user's queued task\r"),
        })
        .await
        .unwrap();
    observer
        .request(Request::Prompt {
            session_id: session.clone(),
            text: "MCP task before revocation".to_string(),
            mode: super::PromptMode::Queue,
            request_id: "before-revoke".to_string(),
        })
        .await
        .unwrap();
    assert_eq!(registry.list()[0].queued_prompts, 2);
    desktop
        .request(Request::ControlSet {
            session_id: session.clone(),
            control: false,
        })
        .await
        .unwrap();
    assert_eq!(
        registry.list()[0].queued_prompts,
        1,
        "keep only the user's prompt"
    );
    assert!(observer
        .request(Request::Prompt {
            session_id: session.clone(),
            text: "ping from mcp\n".to_string(),
            mode: super::PromptMode::Queue,
            request_id: "req-1".to_string(),
        })
        .await
        .is_err());
    assert!(observer
        .request(Request::Prompt {
            session_id: session.clone(),
            text: "nope".to_string(),
            mode: super::PromptMode::Now,
            request_id: "revoked-prompt".to_string(),
        })
        .await
        .is_err());
    assert_eq!(
        observer.request(Request::Sessions).await.unwrap()[0]["sessionId"],
        session.as_str()
    );

    desktop.request(Request::Shutdown).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .expect("the daemon stops when told")
        .unwrap()
        .unwrap();
}

/// The adapter itself against a live daemon: a wait ends the moment the
/// user stops sharing, reporting the revocation rather than a stale
/// success, and a later call is not stuck behind it.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_wait_ends_when_sharing_is_revoked() {
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
            workspace_directory: None,
            token: token.clone(),
            protocol: PROTOCOL_VERSION,
            role: ClientRole::Desktop,
            client: None,
        })
        .await
        .unwrap();
    let session = desktop
        .request(Request::Launch {
            request: Box::new(launch_request("sleep 30")),
            restored_output: None,
        })
        .await
        .unwrap()["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    desktop
        .request(Request::ShareSet {
            session_id: session.clone(),
            shared: true,
            read_output: None,
        })
        .await
        .unwrap();

    let adapter = Arc::new(super::mcp::McpServer::new(DaemonPaths::new(dir.path())));
    adapter
        .handle(
            serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-06-18", "capabilities": {},
                        "clientInfo": { "name": "test", "version": "1" } } }),
        )
        .await
        .unwrap();
    let waiting = {
        let adapter = Arc::clone(&adapter);
        let session = session.clone();
        tokio::spawn(async move {
            adapter
                .handle(
                    serde_json::json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call",
                    "params": { "name": "wait_agent_state",
                                "arguments": { "sessionId": session, "timeoutMs": 20_000 } } }),
                )
                .await
                .unwrap()
        })
    };
    tokio::time::sleep(Duration::from_millis(300)).await;
    let started = std::time::Instant::now();
    desktop
        .request(Request::ShareSet {
            session_id: session.clone(),
            shared: false,
            read_output: None,
        })
        .await
        .unwrap();
    let reply = tokio::time::timeout(Duration::from_secs(5), waiting)
        .await
        .expect("the wait ends on revocation")
        .unwrap();
    assert!(started.elapsed() < Duration::from_secs(5));
    let outcome = &reply["result"]["structuredContent"];
    assert_eq!(outcome["revoked"], true, "{outcome}");
    assert_eq!(outcome["timedOut"], false);
    assert_eq!(outcome["closed"], false);

    // Reading it now is refused, plainly.
    let read = adapter
        .handle(
            serde_json::json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": { "name": "read_agent_output", "arguments": { "sessionId": session } } }),
        )
        .await
        .unwrap();
    assert_eq!(read["result"]["isError"], true);

    // A wait that runs to its timeout while still shared is a plain timeout.
    desktop
        .request(Request::ShareSet {
            session_id: session.clone(),
            shared: true,
            read_output: None,
        })
        .await
        .unwrap();
    let waited = adapter
        .handle(
            serde_json::json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call",
            "params": { "name": "wait_agent_state",
                        "arguments": { "sessionId": session, "timeoutMs": 200 } } }),
        )
        .await
        .unwrap();
    assert_eq!(waited["result"]["structuredContent"]["timedOut"], true);

    desktop.request(Request::Shutdown).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .expect("the daemon stops when told")
        .unwrap()
        .unwrap();
}

/// A client that can start an agent can be told to start another by
/// whatever it reads, so the ceiling is the daemon's. It counts only what
/// MCP started, and a slot comes back when that session ends.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_client_cannot_launch_past_its_ceiling() {
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
            workspace_directory: None,
            token: token.clone(),
            protocol: PROTOCOL_VERSION,
            role: ClientRole::Desktop,
            client: None,
        })
        .await
        .unwrap();
    let mut observer = RawClient::connect(&paths).await;
    observer
        .request(Request::Hello {
            workspace_directory: None,
            token: token.clone(),
            protocol: ClientRole::Observer.protocol_version(),
            role: ClientRole::Observer,
            client: Some("test-client 1.0".to_string()),
        })
        .await
        .unwrap();
    desktop
        .request(Request::McpPlansReplace {
            enabled: true,
            plans: vec![super::McpPlan {
                plan_id: "agent-plan-1".to_string(),
                label: "shell".to_string(),
                note: String::new(),
                definition_id: "custom".to_string(),
                working_directory: std::env::temp_dir().display().to_string(),
                sandbox: false,
                request: launch_request("sleep 30"),
            }],
        })
        .await
        .unwrap();

    // The desktop's own session is the user's, and is never counted.
    let user_session = desktop
        .request(Request::Launch {
            request: Box::new(launch_request("sleep 30")),
            restored_output: None,
        })
        .await
        .unwrap()["sessionId"]
        .as_str()
        .unwrap()
        .to_string();

    let mut started = Vec::new();
    for attempt in 0..super::server::MAX_LAUNCHED_PER_CLIENT {
        let launched = observer
            .request(Request::LaunchPlan {
                plan_id: "agent-plan-1".to_string(),
                request_id: format!("launch-{attempt}"),
            })
            .await
            .unwrap();
        started.push(launched["sessionId"].as_str().unwrap().to_string());
    }
    let plans = observer.request(Request::Plans).await.unwrap();
    assert_eq!(
        plans["launchedByYou"],
        super::server::MAX_LAUNCHED_PER_CLIENT
    );
    assert_eq!(
        plans["launchedTotal"],
        super::server::MAX_LAUNCHED_PER_CLIENT
    );
    assert_eq!(
        plans["maxLaunchedPerClient"],
        super::server::MAX_LAUNCHED_PER_CLIENT
    );

    let refused = observer
        .request(Request::LaunchPlan {
            plan_id: "agent-plan-1".to_string(),
            request_id: "one-too-many".to_string(),
        })
        .await
        .unwrap_err();
    assert!(refused.contains("limit"), "{refused}");
    assert_eq!(
        registry.list().len(),
        super::server::MAX_LAUNCHED_PER_CLIENT + 1,
        "the refusal started nothing"
    );

    // Ending one of its own sessions frees exactly one slot.
    observer
        .request(Request::Cancel {
            session_id: started[0].clone(),
            scope: super::CancelScope::Session,
            request_id: "end-one".to_string(),
        })
        .await
        .unwrap();
    observer
        .wait_for_event("closed", |payload| {
            payload["sessionId"] == started[0].as_str()
        })
        .await;
    let replacement = observer
        .request(Request::LaunchPlan {
            plan_id: "agent-plan-1".to_string(),
            request_id: "after-one-ended".to_string(),
        })
        .await
        .unwrap();
    assert!(replacement["sessionId"].is_string());
    assert!(observer
        .request(Request::LaunchPlan {
            plan_id: "agent-plan-1".to_string(),
            request_id: "still-too-many".to_string(),
        })
        .await
        .is_err());
    assert!(registry.session_summary(&user_session).is_some());

    desktop.request(Request::Shutdown).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), server)
        .await
        .expect("the daemon stops when told")
        .unwrap()
        .unwrap();
}
