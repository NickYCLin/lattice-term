//! The daemon process: `lattice-term agent-daemon --data-dir <dir>`.
//!
//! It is the ordinary desktop binary started with a subcommand, so it needs
//! no extra sidecar, and on Windows it inherits the no-console subsystem.
//! The desktop starts it on demand, detached from its own process group, and
//! it exits by itself once it has had nothing to own and nobody attached for
//! [`super::IDLE_EXIT`].

use super::automations::{self, Scheduler};
use super::{
    read_or_create_token, transport, CancelScope, ClientRole, DaemonPaths, Frame, HelloReply,
    McpActivity, McpPlan, PromptMode, Request, SharedSession, LOG_FILE, MAX_FRAME_BYTES,
    MAX_MCP_PROMPT_CHARS, MAX_OBSERVE_BYTES, PROTOCOL_VERSION, SESSION_ID_PREFIX,
};
use crate::agent::{
    self, AgentLifecycle, AgentRegistry, AgentSessionSummary, AgentSink, AgentStateSource,
    AgentTokenUsage,
};
use crate::agent_chat::AgentChatRegistry;
use base64::Engine;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::ffi::OsStr;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, Notify};

const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
const IDLE_CHECK: Duration = Duration::from_secs(5);
/// A pasted image after PNG encoding; the desktop already bounds pixels.
const MAX_STAGED_IMAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_LOG_BYTES: u64 = 1024 * 1024;
/// How long an observer's request id is remembered, so a retried call
/// after a lost reply gets the first outcome instead of a second launch or
/// a second prompt.
const RECENT_OUTCOME_TTL: Duration = Duration::from_secs(15 * 60);
const MAX_RECENT_OUTCOMES: usize = 256;

/// Handles `agent-daemon`; `None` when the arguments are for something else.
pub fn run_cli<I, S>(args: I) -> Option<i32>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut args = args.into_iter();
    if args.next()?.as_ref() != OsStr::new("agent-daemon") {
        return None;
    }
    let mut data_dir: Option<PathBuf> = None;
    while let Some(argument) = args.next() {
        if argument.as_ref() == OsStr::new("--data-dir") {
            data_dir = args.next().map(|value| PathBuf::from(value.as_ref()));
        } else {
            eprintln!("usage: latticeterm agent-daemon --data-dir <directory>");
            return Some(2);
        }
    }
    let Some(data_dir) = data_dir else {
        eprintln!("usage: latticeterm agent-daemon --data-dir <directory>");
        return Some(2);
    };
    Some(run(&data_dir))
}

fn run(data_dir: &Path) -> i32 {
    let paths = DaemonPaths::new(data_dir);
    let log = Arc::new(Logger::open(&paths));
    let token = match read_or_create_token(&paths) {
        Ok(token) => token,
        Err(error) => {
            log.line(&error);
            return 1;
        }
    };
    let sink = Arc::new(DaemonSink::default());
    let registry = match AgentRegistry::with_local_reporter_prefixed(
        Arc::clone(&sink) as Arc<dyn AgentSink>,
        SESSION_ID_PREFIX,
    ) {
        Ok(registry) => registry,
        Err(error) => {
            log.line(&error);
            return 1;
        }
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            log.line(&format!("Cannot start the daemon runtime: {error}"));
            return 1;
        }
    };
    // Chat turns spawn onto Tauri's runtime handle; here that is ours.
    tauri::async_runtime::set(runtime.handle().clone());
    let scheduler = Arc::new(Scheduler::open(data_dir));
    let chat = Arc::new(AgentChatRegistry::new());
    log.line("Lattice Agent daemon starting");
    let result = runtime.block_on(serve(
        paths.clone(),
        token,
        Arc::clone(&registry),
        Arc::clone(&sink),
        Arc::clone(&scheduler),
        Arc::clone(&chat),
        super::IDLE_EXIT,
        Arc::clone(&log),
    ));
    chat.shutdown();
    registry.stop_all();
    #[cfg(unix)]
    let _ = std::fs::remove_file(&paths.socket);
    match result {
        Ok(()) => {
            log.line("Lattice Agent daemon stopped");
            0
        }
        Err(error) => {
            log.line(&error);
            1
        }
    }
}

/// Everything a connection handler needs.
pub struct Context {
    pub registry: Arc<AgentRegistry>,
    pub sink: Arc<DaemonSink>,
    pub scheduler: Arc<Scheduler>,
    pub chat: Arc<AgentChatRegistry>,
    token: String,
    shutdown: Arc<Notify>,
    log: Arc<Logger>,
}

/// Accepts clients until told to stop or left idle. Public so a test can run
/// a daemon in-process on a temporary data directory.
#[allow(clippy::too_many_arguments)]
pub async fn serve(
    paths: DaemonPaths,
    token: String,
    registry: Arc<AgentRegistry>,
    sink: Arc<DaemonSink>,
    scheduler: Arc<Scheduler>,
    chat: Arc<AgentChatRegistry>,
    idle_exit: Duration,
    log: Arc<Logger>,
) -> Result<(), String> {
    let mut listener = transport::bind(&paths)
        .await
        .map_err(|error| format!("Cannot listen for the desktop: {error}"))?;
    paths.write_socket_hint();
    let context = Arc::new(Context {
        registry,
        sink,
        scheduler,
        chat,
        token,
        shutdown: Arc::new(Notify::new()),
        log,
    });
    let shutdown = Arc::clone(&context.shutdown);
    let mut idle_since: Option<Instant> = None;
    let mut ticker = tokio::time::interval(IDLE_CHECK);
    loop {
        tokio::select! {
            accepted = transport::accept(&mut listener) => match accepted {
                Ok(stream) => {
                    let context = Arc::clone(&context);
                    tokio::spawn(async move { handle_client(stream, context).await });
                }
                Err(error) => {
                    context.log.line(&format!("accept failed: {error}"));
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            },
            _ = ticker.tick() => {
                // Automations fire here only while no window is attached;
                // an attached window runs them itself and streams them.
                let attached = context.sink.client_count() > 0;
                for planned in context.scheduler.due(chrono::Utc::now().timestamp_millis(), attached) {
                    let scheduler = Arc::clone(&context.scheduler);
                    let chat = Arc::clone(&context.chat);
                    let log = Arc::clone(&context.log);
                    tokio::spawn(async move {
                        automations::execute(scheduler, chat, planned, move |line| log.line(line)).await;
                    });
                }
                let idle = context.registry.list().is_empty()
                    && context.sink.client_count() == 0
                    && !context.scheduler.has_enabled()
                    && context.scheduler.running_count() == 0
                    && !context.sink.plans_enabled();
                match (idle, idle_since) {
                    (true, None) => idle_since = Some(Instant::now()),
                    (true, Some(since)) if since.elapsed() >= idle_exit => {
                        context.log.line("idle: nothing to own and nobody attached");
                        break;
                    }
                    (false, _) => idle_since = None,
                    _ => {}
                }
            },
            _ = shutdown.notified() => break,
            _ = terminate_signal() => break,
        }
    }
    drop(listener);
    paths.remove_socket_hint();
    #[cfg(unix)]
    let _ = std::fs::remove_file(&paths.socket);
    Ok(())
}

async fn terminate_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = match signal(SignalKind::terminate()) {
            Ok(term) => term,
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
                return;
            }
        };
        tokio::select! {
            _ = term.recv() => {}
            _ = tokio::signal::ctrl_c() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

async fn handle_client<S>(stream: S, context: Arc<Context>)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (read_half, mut write_half) = tokio::io::split(stream);
    let mut reader = BufReader::new(read_half);

    // The greeting decides whether this is our desktop at all.
    let hello = match tokio::time::timeout(HELLO_TIMEOUT, read_frame(&mut reader)).await {
        Ok(Ok(Some(Frame::Request { id, body }))) => (id, body),
        _ => return,
    };
    let (
        hello_id,
        Request::Hello {
            token,
            protocol,
            role,
            client,
        },
    ) = hello
    else {
        return;
    };
    let client_name = client_label(client.as_deref());
    if token != context.token || protocol != PROTOCOL_VERSION {
        let _ = write_half
            .write_all(
                (response_line(
                    hello_id,
                    Err("The background service refused the greeting.".to_string()),
                ) + "\n")
                    .as_bytes(),
            )
            .await;
        return;
    }
    let reply = match role {
        ClientRole::Desktop => HelloReply {
            protocol: PROTOCOL_VERSION,
            sessions: detached_list(&context.registry),
            snapshots: context.registry.output_snapshots(),
            shared: context.sink.shared(),
        },
        // An observer's greeting carries nothing it could not ask for.
        ClientRole::Observer => HelloReply {
            protocol: PROTOCOL_VERSION,
            sessions: shared_list(&context),
            snapshots: Vec::new(),
            shared: Vec::new(),
        },
    };
    let (client_id, tx, mut rx) = context.sink.subscribe(role, client_name.clone());
    let _ = tx.send(response_line(
        hello_id,
        serde_json::to_value(reply).map_err(|error| error.to_string()),
    ));
    context.log.line(&format!(
        "client {client_id} attached as {role:?} ({client_name})"
    ));

    let writer = tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if write_half.write_all(line.as_bytes()).await.is_err()
                || write_half.write_all(b"\n").await.is_err()
            {
                break;
            }
        }
    });

    loop {
        match read_frame(&mut reader).await {
            Ok(Some(Frame::Request { id, body })) => {
                let context = Arc::clone(&context);
                let tx = tx.clone();
                let client_name = client_name.clone();
                tokio::task::spawn_blocking(move || {
                    let result = dispatch_as(&context, role, &client_name, body);
                    let _ = tx.send(response_line(id, result));
                });
            }
            Ok(Some(_)) => {}
            Ok(None) | Err(_) => break,
        }
    }
    context.sink.unsubscribe(client_id);
    drop(tx);
    let _ = writer.await;
    context.log.line(&format!("client {client_id} detached"));
}

async fn read_frame<R: AsyncBufReadExt + Unpin>(reader: &mut R) -> std::io::Result<Option<Frame>> {
    let mut line = Vec::new();
    let read = reader.read_until(b'\n', &mut line).await?;
    if read == 0 {
        return Ok(None);
    }
    if line.len() > MAX_FRAME_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "frame too large",
        ));
    }
    serde_json::from_slice(&line)
        .map(Some)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
}

fn response_line(id: u64, result: Result<Value, String>) -> String {
    let frame = match result {
        Ok(result) => Frame::Response {
            id,
            ok: true,
            result,
            error: None,
        },
        Err(error) => Frame::Response {
            id,
            ok: false,
            result: Value::Null,
            error: Some(error),
        },
    };
    serde_json::to_string(&frame).unwrap_or_else(|_| {
        r#"{"kind":"response","id":0,"ok":false,"error":"unserializable response"}"#.to_string()
    })
}

fn detached(mut summary: AgentSessionSummary) -> AgentSessionSummary {
    summary.detached = true;
    summary
}

fn detached_list(registry: &AgentRegistry) -> Vec<AgentSessionSummary> {
    registry.list().into_iter().map(detached).collect()
}

/// The sessions an observer may see: shared by the user and still alive.
fn shared_list(context: &Context) -> Vec<AgentSessionSummary> {
    let shared = context.sink.shared();
    detached_list(&context.registry)
        .into_iter()
        .filter(|summary| {
            shared
                .iter()
                .any(|entry| entry.session_id == summary.session_id)
        })
        .collect()
}

/// The same, with each session's grant attached (`mcpControl`).
fn observed_list(context: &Context) -> Vec<Value> {
    let shared = context.sink.shared();
    detached_list(&context.registry)
        .into_iter()
        .filter_map(|summary| {
            let entry = shared
                .iter()
                .find(|entry| entry.session_id == summary.session_id)?;
            let mut value = serde_json::to_value(&summary).ok()?;
            value["mcpControl"] = json!(entry.control);
            Some(value)
        })
        .collect()
}

/// A display name for an observer, from what it claimed: bounded, printable.
fn client_label(claimed: Option<&str>) -> String {
    let label: String = claimed
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control())
        .take(80)
        .collect();
    let label = label.trim().to_string();
    if label.is_empty() {
        "MCP client".to_string()
    } else {
        label
    }
}

/// Everything an observer can do, and nothing else: read the shared
/// sessions and their output, and — only where the user granted control —
/// prompt or end them, or start a plan the user allowed. Every other
/// request is refused before it reaches the registry.
pub fn dispatch_as(
    context: &Context,
    role: ClientRole,
    client: &str,
    body: Request,
) -> Result<Value, String> {
    match role {
        ClientRole::Desktop => dispatch(context, body),
        ClientRole::Observer => match body {
            Request::Sessions => Ok(Value::Array(observed_list(context))),
            Request::Observe {
                session_id,
                cursor,
                max_bytes,
            } => {
                if !context.sink.is_shared(&session_id) {
                    return Err("This session is not shared with observers.".to_string());
                }
                dispatch(
                    context,
                    Request::Observe {
                        session_id,
                        cursor,
                        max_bytes,
                    },
                )
            }
            Request::Plans => Ok(context.sink.plans_view()),
            Request::LaunchPlan {
                plan_id,
                request_id,
            } => once(context, client, &request_id, || {
                launch_plan(context, client, &plan_id)
            }),
            Request::Prompt {
                session_id,
                text,
                mode,
                request_id,
            } => once(context, client, &request_id, || {
                prompt(context, client, &session_id, &text, mode)
            }),
            Request::Cancel {
                session_id,
                scope,
                request_id,
            } => once(context, client, &request_id, || {
                cancel(context, client, &session_id, scope)
            }),
            _ => Err("Observers may only read shared sessions.".to_string()),
        },
    }
}

/// Runs an observer's action at most once per request id: a retry after a
/// lost reply gets the first outcome back, marked `duplicate`.
fn once(
    context: &Context,
    client: &str,
    request_id: &str,
    action: impl FnOnce() -> Result<Value, String>,
) -> Result<Value, String> {
    if request_id.is_empty() {
        return action();
    }
    if request_id.len() > 128 {
        return Err("requestId is too long.".to_string());
    }
    let key = format!("{client}\u{1f}{request_id}");
    if let Some(previous) = context.sink.recall(&key) {
        return previous.map(|mut value| {
            if let Some(object) = value.as_object_mut() {
                object.insert("duplicate".to_string(), json!(true));
            }
            value
        });
    }
    let outcome = action();
    context.sink.remember(key, outcome.clone());
    outcome
}

fn launch_plan(context: &Context, client: &str, plan_id: &str) -> Result<Value, String> {
    let Some(plan) = context.sink.plan(plan_id) else {
        return Err(if context.sink.plans_enabled() {
            "No saved plan with that id is available to MCP clients.".to_string()
        } else {
            "The user has not allowed MCP clients to launch saved plans.".to_string()
        });
    };
    let mut request = plan.request;
    request.detached = true;
    let summary = agent::launch_with_replay(
        Arc::clone(&context.sink) as Arc<dyn AgentSink>,
        Arc::clone(&context.registry),
        request,
        None,
    )?;
    let summary = detached(summary);
    // What a client started, it may watch and drive; the user allowed the
    // plan for exactly that.
    context.sink.set_shared(&summary.session_id, true);
    let _ = context.sink.set_control(&summary.session_id, true);
    context
        .sink
        .note_activity(&summary.session_id, client, "launch");
    context.log.line(&format!(
        "mcp {client}: launched plan {plan_id} as {}",
        summary.session_id
    ));
    let value = to_value(&summary)?;
    context.sink.broadcast("launched", value.clone());
    Ok(value)
}

fn prompt(
    context: &Context,
    client: &str,
    session_id: &str,
    text: &str,
    mode: PromptMode,
) -> Result<Value, String> {
    if !context.sink.has_control(session_id) {
        return Err("This session is not under MCP control.".to_string());
    }
    let text = text.trim_end_matches(['\r', '\n']);
    if text.trim().is_empty() {
        return Err("A prompt is required.".to_string());
    }
    if text.chars().count() > MAX_MCP_PROMPT_CHARS {
        return Err(format!(
            "A prompt may have at most {MAX_MCP_PROMPT_CHARS} characters."
        ));
    }
    // Exactly what the interface types: newlines become carriage returns
    // so multi-line text stays one submission, then Enter.
    let mut typed = text.replace("\r\n", "\n").replace('\n', "\r");
    typed.push('\r');
    let encoded = base64::engine::general_purpose::STANDARD.encode(typed.as_bytes());
    let registry = &context.registry;
    let sink: &dyn AgentSink = context.sink.as_ref();
    let before = registry
        .session_summary(session_id)
        .ok_or_else(|| "Agent session no longer exists.".to_string())?;
    let (queued, sent_now) = match mode {
        PromptMode::Queue => {
            let depth = agent::enqueue(sink, registry, session_id, &encoded)?;
            (depth, depth == 0)
        }
        PromptMode::Now => {
            if matches!(
                before.state,
                AgentLifecycle::Working | AgentLifecycle::NeedsAttention
            ) {
                return Err(format!(
                    "The session is {} right now; queue the prompt or wait for it to finish.",
                    match before.state {
                        AgentLifecycle::Working => "working",
                        _ => "waiting for a person",
                    }
                ));
            }
            agent::send(sink, registry, session_id, &encoded)?;
            (0, true)
        }
    };
    context.sink.note_activity(
        session_id,
        client,
        if sent_now { "prompt" } else { "queue" },
    );
    context.log.line(&format!(
        "mcp {client}: prompt to {session_id} ({} chars, {})",
        text.chars().count(),
        if sent_now { "sent" } else { "queued" }
    ));
    let after = registry.session_summary(session_id).unwrap_or(before);
    Ok(json!({
        "sessionId": session_id,
        "sentImmediately": sent_now,
        "queued": queued,
        "state": after.state,
        "stateSource": after.state_source,
    }))
}

fn cancel(
    context: &Context,
    client: &str,
    session_id: &str,
    scope: CancelScope,
) -> Result<Value, String> {
    if !context.sink.has_control(session_id) {
        return Err("This session is not under MCP control.".to_string());
    }
    let registry = &context.registry;
    let sink: &dyn AgentSink = context.sink.as_ref();
    match scope {
        CancelScope::Queue => {
            let dropped = agent::clear_queue(sink, registry, session_id)?;
            context.sink.note_activity(session_id, client, "clearQueue");
            context.log.line(&format!(
                "mcp {client}: cleared {dropped} queued prompt(s) on {session_id}"
            ));
            Ok(json!({ "sessionId": session_id, "scope": "queue", "dropped": dropped }))
        }
        CancelScope::Session => {
            agent::disconnect(sink, registry, session_id)?;
            context
                .log
                .line(&format!("mcp {client}: ended {session_id}"));
            Ok(json!({ "sessionId": session_id, "scope": "session", "ended": true }))
        }
    }
}

fn decode(encoded: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| format!("Invalid base64 payload: {error}"))
}

/// Runs one request against the daemon's registry. Everything here is the
/// same code the desktop runs for its own sessions.
pub fn dispatch(context: &Context, body: Request) -> Result<Value, String> {
    let registry = &context.registry;
    let sink: &dyn AgentSink = context.sink.as_ref();
    match body {
        Request::Hello { .. } => Err("Already greeted.".to_string()),
        Request::Launch {
            request,
            restored_output,
        } => {
            let mut request = *request;
            request.detached = true;
            let restored = restored_output.as_deref().map(decode).transpose()?;
            let summary = agent::launch_with_replay(
                Arc::clone(&context.sink) as Arc<dyn AgentSink>,
                Arc::clone(registry),
                request,
                restored,
            )?;
            to_value(&detached(summary))
        }
        Request::Send { session_id, data } => {
            agent::send(sink, registry, &session_id, &data).map(|_| Value::Null)
        }
        Request::Enqueue { session_id, data } => {
            agent::enqueue(sink, registry, &session_id, &data).map(|depth| json!(depth))
        }
        Request::ClearQueue { session_id } => {
            agent::clear_queue(sink, registry, &session_id).map(|dropped| json!(dropped))
        }
        Request::Broadcast { session_ids, data } => {
            let outcomes = agent::broadcast(sink, registry, &session_ids, &data)?;
            to_value(&outcomes)
        }
        Request::Resize {
            session_id,
            cols,
            rows,
        } => agent::resize(registry, &session_id, cols, rows).map(|_| Value::Null),
        Request::Disconnect { session_id } => {
            agent::disconnect(sink, registry, &session_id).map(|_| Value::Null)
        }
        Request::Rename { session_id, label } => {
            let summary = registry.rename(&session_id, &label)?;
            to_value(&detached(summary))
        }
        Request::Sessions => to_value(&detached_list(registry)),
        Request::Snapshots => to_value(&registry.output_snapshots()),
        Request::StageImage { session_id, png } => {
            if registry.session_summary(&session_id).is_none() {
                return Err("Agent session no longer exists.".to_string());
            }
            let bytes = decode(&png)?;
            if bytes.is_empty() || bytes.len() > MAX_STAGED_IMAGE_BYTES {
                return Err("The pasted image is empty or too large.".to_string());
            }
            let mut file = tempfile::Builder::new()
                .prefix("latticeterm-clip-")
                .suffix(".png")
                .tempfile()
                .map_err(|error| format!("Cannot stage the pasted image: {error}"))?;
            file.write_all(&bytes)
                .map_err(|error| format!("Cannot stage the pasted image: {error}"))?;
            let path = registry.stage_clipboard_image(&session_id, file)?;
            Ok(json!(path.to_string_lossy()))
        }
        Request::Shutdown => {
            context.shutdown.notify_one();
            Ok(Value::Null)
        }
        Request::AutomationsReplace { automations } => {
            to_value(&context.scheduler.replace(automations))
        }
        Request::AutomationsState => to_value(&context.scheduler.status()),
        Request::AutomationsTakeRuns => to_value(&context.scheduler.take_runs()),
        Request::ShareSet { session_id, shared } => {
            if shared && registry.session_summary(&session_id).is_none() {
                return Err("Agent session no longer exists.".to_string());
            }
            context.sink.set_shared(&session_id, shared);
            context.log.line(&format!(
                "desktop: {} {session_id} with observers",
                if shared { "shared" } else { "unshared" }
            ));
            to_value(&context.sink.shared())
        }
        Request::ControlSet {
            session_id,
            control,
        } => {
            context.sink.set_control(&session_id, control)?;
            context.log.line(&format!(
                "desktop: {} control of {session_id}",
                if control { "granted" } else { "revoked" }
            ));
            to_value(&context.sink.shared())
        }
        Request::Shared => to_value(&context.sink.shared()),
        Request::McpPlansReplace { enabled, plans } => {
            context.log.line(&format!(
                "desktop: observers may launch {} saved plan(s)",
                if enabled { plans.len() } else { 0 }
            ));
            context.sink.plans_replace(enabled, plans);
            Ok(Value::Null)
        }
        Request::Plans
        | Request::LaunchPlan { .. }
        | Request::Prompt { .. }
        | Request::Cancel { .. } => Err("These requests are for observers.".to_string()),
        Request::Observe {
            session_id,
            cursor,
            max_bytes,
        } => {
            let max = if max_bytes == 0 {
                MAX_OBSERVE_BYTES
            } else {
                max_bytes.min(MAX_OBSERVE_BYTES)
            };
            to_value(&registry.output_range(&session_id, cursor, max)?)
        }
    }
}

fn to_value<T: serde::Serialize>(value: &T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| error.to_string())
}

/// The registry sink: every event goes to every attached client, and to
/// nobody at all when the window is closed — the registry keeps working
/// regardless, which is the whole point.
///
/// Observers are told less: only the lifecycle events (`state`, `closed`,
/// `model`, `usage`, `queue`) of sessions the user shared, never `data`
/// — output is read on request, by cursor, so a slow observer can never
/// pile up terminal bytes in a channel.
#[derive(Default)]
pub struct DaemonSink {
    clients: Mutex<Vec<Client>>,
    /// Sessions the user shared with observers, with what each observer may
    /// do to them. Lives with the daemon: a session that ends is unshared
    /// with it, and sharing never outlives the process that holds the
    /// session.
    shared: Mutex<HashMap<String, ShareEntry>>,
    /// Saved plans the user allowed observers to launch.
    plans: Mutex<(bool, Vec<McpPlan>)>,
    /// Outcomes of recent observer actions, by client and request id.
    recent: Mutex<VecDeque<RecentOutcome>>,
    next: AtomicU64,
}

struct Client {
    id: u64,
    role: ClientRole,
    tx: mpsc::UnboundedSender<String>,
}

#[derive(Default, Clone)]
struct ShareEntry {
    control: bool,
    activity: Option<McpActivity>,
}

struct RecentOutcome {
    key: String,
    at: Instant,
    outcome: Result<Value, String>,
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl DaemonSink {
    pub fn subscribe(
        &self,
        role: ClientRole,
        _client: String,
    ) -> (
        u64,
        mpsc::UnboundedSender<String>,
        mpsc::UnboundedReceiver<String>,
    ) {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = mpsc::unbounded_channel();
        if let Ok(mut clients) = self.clients.lock() {
            clients.push(Client {
                id,
                role,
                tx: tx.clone(),
            });
        }
        (id, tx, rx)
    }

    pub fn unsubscribe(&self, id: u64) {
        if let Ok(mut clients) = self.clients.lock() {
            clients.retain(|client| client.id != id);
        }
    }

    /// Attached desktops. Observers do not count: they neither run
    /// automations nor keep an otherwise idle daemon alive.
    pub fn client_count(&self) -> usize {
        self.clients
            .lock()
            .map(|clients| {
                clients
                    .iter()
                    .filter(|client| client.role == ClientRole::Desktop)
                    .count()
            })
            .unwrap_or(0)
    }

    pub fn shared(&self) -> Vec<SharedSession> {
        let mut shared: Vec<SharedSession> = self
            .shared
            .lock()
            .map(|shared| {
                shared
                    .iter()
                    .map(|(session_id, entry)| SharedSession {
                        session_id: session_id.clone(),
                        control: entry.control,
                        activity: entry.activity.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default();
        shared.sort_by(|a, b| a.session_id.cmp(&b.session_id));
        shared
    }

    pub fn is_shared(&self, session_id: &str) -> bool {
        self.shared
            .lock()
            .map(|shared| shared.contains_key(session_id))
            .unwrap_or(false)
    }

    pub fn has_control(&self, session_id: &str) -> bool {
        self.shared
            .lock()
            .map(|shared| shared.get(session_id).is_some_and(|entry| entry.control))
            .unwrap_or(false)
    }

    /// Sharing on keeps an existing grant; sharing off drops everything and
    /// tells observers, so a wait on that session ends now rather than at
    /// its timeout.
    pub fn set_shared(&self, session_id: &str, shared: bool) {
        let revoked = match self.shared.lock() {
            Ok(mut set) => {
                if shared {
                    set.entry(session_id.to_string()).or_default();
                    false
                } else {
                    set.remove(session_id).is_some()
                }
            }
            Err(_) => false,
        };
        if revoked {
            self.broadcast("unshared", json!({ "sessionId": session_id }));
        }
    }

    /// Control is a grant on top of sharing, never instead of it.
    pub fn set_control(&self, session_id: &str, control: bool) -> Result<(), String> {
        let mut set = self.shared.lock().map_err(|error| error.to_string())?;
        match set.get_mut(session_id) {
            Some(entry) => {
                entry.control = control;
                Ok(())
            }
            None => Err("Share the session with observers first.".to_string()),
        }
    }

    pub fn note_activity(&self, session_id: &str, client: &str, action: &str) {
        if let Ok(mut set) = self.shared.lock() {
            if let Some(entry) = set.get_mut(session_id) {
                entry.activity = Some(McpActivity {
                    client: client.to_string(),
                    action: action.to_string(),
                    at: now_millis(),
                });
            }
        }
    }

    pub fn plans_replace(&self, enabled: bool, plans: Vec<McpPlan>) {
        if let Ok(mut current) = self.plans.lock() {
            *current = (enabled, if enabled { plans } else { Vec::new() });
        }
    }

    pub fn plans_enabled(&self) -> bool {
        self.plans.lock().map(|plans| plans.0).unwrap_or(false)
    }

    fn plan(&self, plan_id: &str) -> Option<McpPlan> {
        self.plans.lock().ok().and_then(|plans| {
            plans
                .0
                .then(|| plans.1.iter().find(|plan| plan.plan_id == plan_id).cloned())
                .flatten()
        })
    }

    /// What an observer learns about launchable plans: never the request.
    fn plans_view(&self) -> Value {
        let (enabled, plans) = self
            .plans
            .lock()
            .map(|plans| (plans.0, plans.1.clone()))
            .unwrap_or_default();
        json!({
            "enabled": enabled,
            "plans": plans.iter().map(|plan| json!({
                "planId": plan.plan_id,
                "label": plan.label,
                "note": plan.note,
                "definitionId": plan.definition_id,
                "workingDirectory": plan.working_directory,
                "sandbox": plan.sandbox,
            })).collect::<Vec<_>>(),
        })
    }

    fn recall(&self, key: &str) -> Option<Result<Value, String>> {
        let mut recent = self.recent.lock().ok()?;
        recent.retain(|entry| entry.at.elapsed() < RECENT_OUTCOME_TTL);
        recent
            .iter()
            .find(|entry| entry.key == key)
            .map(|entry| entry.outcome.clone())
    }

    fn remember(&self, key: String, outcome: Result<Value, String>) {
        if let Ok(mut recent) = self.recent.lock() {
            while recent.len() >= MAX_RECENT_OUTCOMES {
                recent.pop_front();
            }
            recent.push_back(RecentOutcome {
                key,
                at: Instant::now(),
                outcome,
            });
        }
    }

    fn broadcast(&self, name: &str, payload: Value) {
        let session_id = payload
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        // Observers hear only lifecycle news about shared sessions (and
        // that a session stopped being shared); never terminal bytes,
        // native ids, or launches.
        let observable = name == "unshared"
            || (matches!(name, "state" | "closed" | "model" | "usage" | "queue")
                && self.is_shared(session_id));
        let frame = Frame::Event {
            name: name.to_string(),
            payload,
        };
        let Ok(line) = serde_json::to_string(&frame) else {
            return;
        };
        if let Ok(mut clients) = self.clients.lock() {
            clients.retain(|client| match client.role {
                ClientRole::Desktop => client.tx.send(line.clone()).is_ok(),
                ClientRole::Observer => !observable || client.tx.send(line.clone()).is_ok(),
            });
        }
    }
}

impl AgentSink for DaemonSink {
    fn data(&self, session_id: &str, offset: u64, bytes: &[u8]) {
        self.broadcast(
            "data",
            json!({
                "sessionId": session_id,
                "offset": offset,
                "base64": base64::engine::general_purpose::STANDARD.encode(bytes),
            }),
        );
    }

    fn state(&self, session_id: &str, state: AgentLifecycle, source: AgentStateSource) {
        self.broadcast(
            "state",
            json!({ "sessionId": session_id, "state": state, "source": source }),
        );
    }

    fn closed(&self, session_id: &str, reason: &str) {
        self.broadcast(
            "closed",
            json!({ "sessionId": session_id, "reason": reason }),
        );
        // Observers already heard `closed`; drop the grant quietly.
        if let Ok(mut set) = self.shared.lock() {
            set.remove(session_id);
        }
    }

    fn captured(&self, session_id: &str, native_session_id: &str) {
        self.broadcast(
            "captured",
            json!({ "sessionId": session_id, "nativeSessionId": native_session_id }),
        );
    }

    fn model(&self, session_id: &str, model: &str) {
        self.broadcast("model", json!({ "sessionId": session_id, "model": model }));
    }

    fn usage(&self, session_id: &str, token_usage: &AgentTokenUsage) {
        self.broadcast(
            "usage",
            json!({ "sessionId": session_id, "tokenUsage": token_usage }),
        );
    }

    fn queue(&self, session_id: &str, queued_prompts: usize) {
        self.broadcast(
            "queue",
            json!({ "sessionId": session_id, "queuedPrompts": queued_prompts }),
        );
    }
}

/// Appends timestamped lines to `agent-daemon.log`, truncating a log that
/// grew past a megabyte. Nothing secret is ever logged: no prompts, no
/// output, no tokens.
pub struct Logger(Mutex<Option<std::fs::File>>);

impl Logger {
    pub fn open(paths: &DaemonPaths) -> Self {
        let path = paths.data_dir.join(LOG_FILE);
        let oversized = std::fs::metadata(&path)
            .map(|m| m.len() > MAX_LOG_BYTES)
            .unwrap_or(false);
        let mut options = std::fs::OpenOptions::new();
        options
            .create(true)
            .append(!oversized)
            .write(true)
            .truncate(oversized);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        Self(Mutex::new(options.open(path).ok()))
    }

    pub fn silent() -> Self {
        Self(Mutex::new(None))
    }

    pub fn line(&self, message: &str) {
        if let Ok(mut file) = self.0.lock() {
            if let Some(file) = file.as_mut() {
                let seconds = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let _ = writeln!(file, "{seconds} {message}");
            }
        }
    }
}
