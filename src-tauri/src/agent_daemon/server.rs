//! The daemon process: `lattice-term agent-daemon --data-dir <dir>`.
//!
//! It is the ordinary desktop binary started with a subcommand, so it needs
//! no extra sidecar, and on Windows it inherits the no-console subsystem.
//! The desktop starts it on demand, detached from its own process group, and
//! it exits by itself once it has had nothing to own and nobody attached for
//! [`super::IDLE_EXIT`].

use super::audit;
use super::automations::{self, Scheduler};
use super::mcp::{read_bounded_line, LineRead};
use super::{
    read_or_create_token, transport, CancelScope, ClientRole, DaemonPaths, Frame, HelloReply,
    McpActivity, McpPlan, PromptMode, Request, SharedSession, LOG_FILE, MAX_FRAME_BYTES,
    MAX_MCP_PROMPT_CHARS, MAX_OBSERVE_BYTES, OBSERVER_PROTOCOL_VERSION, SESSION_ID_PREFIX,
};
use crate::agent::{
    self, AgentLifecycle, AgentRegistry, AgentSessionSummary, AgentSink, AgentStateSource,
    AgentTokenUsage,
};
use crate::agent_chat::AgentChatRegistry;
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::ffi::OsStr;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, watch, Notify, Semaphore};
use tokio::task::JoinSet;

const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
const IDLE_CHECK: Duration = Duration::from_secs(5);
/// A pasted image after PNG encoding; the desktop already bounds pixels.
const MAX_STAGED_IMAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_LOG_BYTES: u64 = 1024 * 1024;
const MAX_OBSERVER_QUEUED_FRAMES: usize = 64;
const MAX_OBSERVER_IN_FLIGHT: usize = 48;
const MAX_TOTAL_OBSERVER_REQUESTS: usize = 96;
const MAX_OBSERVER_REQUEST_BYTES: usize = 1024 * 1024;
/// How long an observer's request id is remembered, so a retried call
/// after a lost reply gets the first outcome instead of a second launch or
/// a second prompt.
const RECENT_OUTCOME_TTL: Duration = Duration::from_secs(15 * 60);
const MAX_RECENT_OUTCOMES: usize = 256;
const DUPLICATE_WAIT: Duration = Duration::from_secs(10);
const UNKNOWN_OUTCOME: &str = "Operation outcome is unknown; retry only with the same requestId while this daemon is running. Do not submit a new requestId.";

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
    // Initialize only after acquiring this installation's daemon endpoint.
    // An unreadable audit file must never prevent existing CLI sessions.
    if let Ok(mut history) = sink.history.lock() {
        *history = audit::History::open(&paths.data_dir);
    }
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
    // Registry/reporting tasks may still own the sink. Flush an explicit
    // boundary without holding its mutex or depending on Arc destruction.
    let flush = context
        .sink
        .history
        .lock()
        .ok()
        .and_then(|history| history.flush_handle());
    if let Some(flush) = flush {
        let _ = tokio::task::spawn_blocking(move || flush.flush(Duration::from_millis(250))).await;
    }
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
    let hello = match tokio::time::timeout(
        HELLO_TIMEOUT,
        read_frame(&mut reader, MAX_OBSERVER_REQUEST_BYTES),
    )
    .await
    {
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
    if token != context.token || protocol != role.protocol_version() {
        let _ = tokio::time::timeout(
            HELLO_TIMEOUT,
            write_half.write_all(
                (response_line(
                    hello_id,
                    Err("The background service refused the greeting.".to_string()),
                ) + "\n")
                    .as_bytes(),
            ),
        )
        .await;
        return;
    }
    let reply = match role {
        ClientRole::Desktop => HelloReply {
            protocol: role.protocol_version(),
            mcp_protocol: OBSERVER_PROTOCOL_VERSION,
            mcp_history: true,
            sessions: detached_list(&context.registry),
            snapshots: context.registry.output_snapshots(),
            shared: context.sink.shared(),
        },
        // An observer's greeting carries nothing it could not ask for.
        ClientRole::Observer => HelloReply {
            protocol: role.protocol_version(),
            mcp_protocol: OBSERVER_PROTOCOL_VERSION,
            mcp_history: false,
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

    let mut writer = tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if write_half.write_all(line.as_bytes()).await.is_err()
                || write_half.write_all(b"\n").await.is_err()
            {
                break;
            }
        }
    });
    let mut disconnected = tx.disconnected.subscribe();
    let allowance = Arc::new(Semaphore::new(MAX_OBSERVER_IN_FLIGHT));
    let mut tasks = JoinSet::new();
    let mut writer_finished = false;
    let frame_limit = if role == ClientRole::Observer {
        MAX_OBSERVER_REQUEST_BYTES
    } else {
        MAX_FRAME_BYTES
    };
    loop {
        if *disconnected.borrow() {
            break;
        }
        let frame = tokio::select! {
            biased;
            _ = disconnected.changed() => break,
            _ = &mut writer => {
                writer_finished = true;
                break;
            }
            frame = read_frame(&mut reader, frame_limit) => frame,
        };
        while tasks.try_join_next().is_some() {}
        match frame {
            Ok(Some(Frame::Request { id, body })) => {
                // Reserve before spawning, never put an unlimited number
                // of observer jobs on Tokio's blocking work queue. Keep a
                // daemon-wide reservation until even a disconnected
                // client's already running operation has actually ended.
                let permits = if role == ClientRole::Observer {
                    let Ok(local) = Arc::clone(&allowance).try_acquire_owned() else {
                        break;
                    };
                    let Ok(global) =
                        Arc::clone(&context.sink.observer_requests.0).try_acquire_owned()
                    else {
                        break;
                    };
                    Some((local, global))
                } else {
                    None
                };
                let context = Arc::clone(&context);
                let tx = tx.clone();
                let client_name = client_name.clone();
                tasks.spawn_blocking(move || {
                    let _permits = permits;
                    if role == ClientRole::Observer && tx.is_disconnected() {
                        return;
                    }
                    let result = dispatch_as(&context, role, &client_name, body);
                    let _ = tx.send(response_line(id, result));
                });
            }
            Ok(Some(_)) => {}
            Ok(None) | Err(_) => break,
        }
    }
    if role == ClientRole::Observer {
        tx.disconnect();
    }
    context.sink.unsubscribe(client_id);
    drop(tx);
    // Blocking work that has already started is not abortable, but its
    // permits remain held by the closure. Cancel queued jobs and release
    // the socket immediately rather than waiting behind a slow observer.
    if role == ClientRole::Observer || writer_finished {
        tasks.abort_all();
        if !writer_finished {
            writer.abort();
            let _ = writer.await;
        }
    } else {
        // Preserve the desktop's existing EOF behavior: accepted work
        // and its final responses may finish before its writer closes.
        let _ = writer.await;
    }
    context.log.line(&format!("client {client_id} detached"));
}

async fn read_frame<R: AsyncBufReadExt + Unpin>(
    reader: &mut R,
    limit: usize,
) -> std::io::Result<Option<Frame>> {
    let mut line = Vec::new();
    match read_bounded_line(reader, &mut line, limit).await? {
        LineRead::Eof => return Ok(None),
        LineRead::TooLong => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "frame too large",
            ));
        }
        LineRead::Ready => {}
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
    let descriptor = if role == ClientRole::Observer {
        match &body {
            Request::LaunchPlan { .. } => Some((audit::Action::Launch, None)),
            Request::Prompt {
                session_id, mode, ..
            } => Some((
                if *mode == PromptMode::Now {
                    audit::Action::Prompt
                } else {
                    audit::Action::Queue
                },
                context
                    .registry
                    .session_summary(session_id)
                    .map(|session| session.session_id),
            )),
            Request::Cancel {
                session_id, scope, ..
            } => Some((
                if *scope == CancelScope::Queue {
                    audit::Action::ClearQueue
                } else {
                    audit::Action::Stop
                },
                context
                    .registry
                    .session_summary(session_id)
                    .map(|session| session.session_id),
            )),
            _ => None,
        }
    } else {
        None
    };
    let result = dispatch_as_inner(context, role, client, body);
    if let Some((action, mut session_id)) = descriptor {
        let outcome = match &result {
            Ok(value) => {
                if session_id.is_none() {
                    // Successful results are generated by this daemon (or
                    // its deduplication cache), never copied from input.
                    session_id = value["sessionId"].as_str().map(str::to_string);
                }
                if value["duplicate"] == true {
                    audit::Outcome::Replayed
                } else {
                    audit::Outcome::Accepted
                }
            }
            Err(error) if error == UNKNOWN_OUTCOME => audit::Outcome::Unknown,
            Err(_) => audit::Outcome::Failed,
        };
        if let Ok(mut history) = context.sink.history.lock() {
            history.record(client, action, outcome, session_id, now_millis());
        }
    }
    result
}

fn dispatch_as_inner(
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
            } => once(
                context,
                client,
                &request_id,
                &json!(["launch", plan_id]),
                || {
                    context
                        .sink
                        .plan(&plan_id)
                        .ok_or_else(|| {
                            "No authorized launch plan with that id is available.".to_string()
                        })
                        .map(|_| ())
                },
                || launch_plan(context, client, &plan_id),
                |value| {
                    if context.sink.plan(&plan_id).is_none()
                        || !value["sessionId"]
                            .as_str()
                            .is_some_and(|id| context.sink.has_control(id))
                    {
                        return Err("The launch or session authorization has been revoked.".into());
                    }
                    Ok(())
                },
            ),
            Request::Prompt {
                session_id,
                text,
                mode,
                request_id,
            } => once(
                context,
                client,
                &request_id,
                &json!(["prompt", session_id, text, mode]),
                || {
                    require_control(context, &session_id)?;
                    agent::validate_mcp_prompt(&text)
                },
                || prompt(context, client, &session_id, &text, mode),
                |_| require_control(context, &session_id),
            ),
            Request::Cancel {
                session_id,
                scope,
                request_id,
            } => once(
                context,
                client,
                &request_id,
                &json!(["cancel", session_id, scope]),
                || require_control(context, &session_id),
                || cancel(context, client, &session_id, scope),
                |_| {
                    // An acknowledged termination removes the grant itself.
                    // Its replay contains only the caller's id and `ended`.
                    if scope == CancelScope::Session {
                        Ok(())
                    } else {
                        require_control(context, &session_id)
                    }
                },
            ),
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
    identity: &Value,
    preflight: impl FnOnce() -> Result<(), String>,
    action: impl FnOnce() -> Result<Value, String>,
    authorize_replay: impl FnOnce(&Value) -> Result<(), String>,
) -> Result<Value, String> {
    if request_id.trim().is_empty() {
        return Err("A non-empty requestId is required for MCP writes.".to_string());
    }
    if request_id.len() > 128 {
        return Err("requestId is too long.".to_string());
    }
    let fingerprint: [u8; 32] =
        Sha256::digest(serde_json::to_vec(identity).map_err(|error| error.to_string())?).into();
    let (operation, fresh) =
        if let Some(operation) = context.sink.existing(client, request_id, fingerprint)? {
            (operation, false)
        } else {
            // Invalid/unauthorized requests must not consume the bounded write
            // history. Recheck inside the atomic reservation in case another
            // connection claimed this id while preflight was running.
            preflight()?;
            context.sink.reserve(client, request_id, fingerprint)?
        };
    if !fresh {
        let mut value = operation.wait()?;
        authorize_replay(&value)?;
        if let Some(object) = value.as_object_mut() {
            object.insert("duplicate".to_string(), json!(true));
        }
        return Ok(value);
    }
    let mut guard = OutcomeGuard {
        operation,
        completed: false,
    };
    let outcome = action();
    guard.complete(outcome.clone());
    outcome
}

fn require_control(context: &Context, session_id: &str) -> Result<(), String> {
    if context.sink.has_control(session_id) {
        Ok(())
    } else {
        Err("This session is not under MCP control.".to_string())
    }
}

fn launch_plan(context: &Context, client: &str, plan_id: &str) -> Result<Value, String> {
    let Some((plan, generation)) = context.sink.plan_with_generation(plan_id) else {
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
    finish_plan_launch(context, &summary.session_id, generation)?;
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

fn finish_plan_launch(context: &Context, session_id: &str, generation: u64) -> Result<(), String> {
    let grant = context.sink.grant_change_lock(session_id)?;
    let _grant = grant.lock().map_err(|error| error.to_string())?;
    let plans = context
        .sink
        .plans
        .lock()
        .map_err(|error| error.to_string())?;
    if !plans.enabled || plans.generation != generation {
        drop(plans);
        drop(_grant);
        agent::disconnect(context.sink.as_ref(), &context.registry, session_id)?;
        return Err("The launch authorization changed while this plan was starting; the new session was stopped.".into());
    }
    agent::set_mcp_control(context.sink.as_ref(), &context.registry, session_id, true)?;
    context.sink.set_shared(session_id, true);
    context.sink.set_control(session_id, true)
}

fn prompt(
    context: &Context,
    client: &str,
    session_id: &str,
    text: &str,
    mode: PromptMode,
) -> Result<Value, String> {
    require_control(context, session_id)?;
    if text.chars().count() > MAX_MCP_PROMPT_CHARS {
        return Err(format!(
            "A prompt may have at most {MAX_MCP_PROMPT_CHARS} characters."
        ));
    }
    let registry = &context.registry;
    let sink: &dyn AgentSink = context.sink.as_ref();
    let before = registry
        .session_summary(session_id)
        .ok_or_else(|| "Agent session no longer exists.".to_string())?;
    let queued = agent::mcp_prompt(sink, registry, session_id, text, mode == PromptMode::Now)?;
    let sent_now = queued == 0;
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
            let dropped = agent::mcp_cancel_queue(sink, registry, session_id)?;
            context.sink.note_activity(session_id, client, "clearQueue");
            context.log.line(&format!(
                "mcp {client}: cleared {dropped} queued prompt(s) on {session_id}"
            ));
            Ok(json!({ "sessionId": session_id, "scope": "queue", "dropped": dropped }))
        }
        CancelScope::Session => {
            agent::mcp_disconnect(sink, registry, session_id)?;
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
            let grant = context.sink.grant_change_lock(&session_id)?;
            let _grant = grant.lock().map_err(|error| error.to_string())?;
            if shared && registry.session_summary(&session_id).is_none() {
                return Err("Agent session no longer exists.".to_string());
            }
            if !shared && registry.session_summary(&session_id).is_some() {
                agent::set_mcp_control(sink, registry, &session_id, false)?;
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
            let grant = context.sink.grant_change_lock(&session_id)?;
            let _grant = grant.lock().map_err(|error| error.to_string())?;
            if control && !context.sink.is_shared(&session_id) {
                return Err("Share the session with observers first.".to_string());
            }
            agent::set_mcp_control(sink, registry, &session_id, control)?;
            context.sink.set_control(&session_id, control)?;
            context.log.line(&format!(
                "desktop: {} control of {session_id}",
                if control { "granted" } else { "revoked" }
            ));
            to_value(&context.sink.shared())
        }
        Request::Shared => to_value(&context.sink.shared()),
        Request::McpHistory => {
            let history = context
                .sink
                .history
                .lock()
                .map_err(|error| error.to_string())?;
            to_value(&history.snapshot())
        }
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
    /// Independent from shares: revocation and session exit keep metadata.
    history: Mutex<audit::History>,
    clients: Mutex<Vec<Client>>,
    observer_requests: ObserverRequestLimit,
    /// Serialize only grant changes, keeping the registry's authoritative
    /// input grant and this sink's display/observation mirror consistent.
    grant_changes: Mutex<HashMap<String, Weak<Mutex<()>>>>,
    /// Sessions the user shared with observers, with what each observer may
    /// do to them. Lives with the daemon: a session that ends is unshared
    /// with it, and sharing never outlives the process that holds the
    /// session.
    shared: Mutex<HashMap<String, ShareEntry>>,
    /// Saved plans the user allowed observers to launch.
    plans: Mutex<LaunchPlans>,
    /// Outcomes of recent observer actions, by client and request id.
    recent: Mutex<VecDeque<Arc<RecentOutcome>>>,
    next: AtomicU64,
}

struct Client {
    id: u64,
    role: ClientRole,
    tx: ClientSender,
}

struct ObserverRequestLimit(Arc<Semaphore>);

impl Default for ObserverRequestLimit {
    fn default() -> Self {
        Self(Arc::new(Semaphore::new(MAX_TOTAL_OBSERVER_REQUESTS)))
    }
}

/// Desktop terminal delivery retains its existing queue. Observers have a
/// bounded queue; synchronous registry broadcasts must never wait for them.
#[derive(Clone)]
pub struct ClientSender {
    channel: ClientChannel,
    disconnected: watch::Sender<bool>,
}

#[derive(Clone)]
enum ClientChannel {
    Desktop(mpsc::UnboundedSender<String>),
    Observer(mpsc::Sender<String>),
}

pub enum ClientReceiver {
    Desktop(mpsc::UnboundedReceiver<String>),
    Observer(mpsc::Receiver<String>),
}

impl ClientSender {
    fn send(&self, line: String) -> Result<(), ()> {
        if self.is_disconnected() {
            return Err(());
        }
        let sent = match &self.channel {
            ClientChannel::Desktop(tx) => tx.send(line).map_err(|_| ()),
            ClientChannel::Observer(_) if line.len() >= MAX_FRAME_BYTES => Err(()),
            ClientChannel::Observer(tx) => tx.try_send(line).map_err(|_| ()),
        };
        if sent.is_err() {
            self.disconnect();
        }
        sent
    }

    fn is_disconnected(&self) -> bool {
        *self.disconnected.borrow()
    }

    fn disconnect(&self) {
        self.disconnected.send_replace(true);
    }
}

impl ClientReceiver {
    async fn recv(&mut self) -> Option<String> {
        match self {
            Self::Desktop(rx) => rx.recv().await,
            Self::Observer(rx) => rx.recv().await,
        }
    }
}

#[derive(Default, Clone)]
struct ShareEntry {
    control: bool,
    activity: Option<McpActivity>,
}

#[derive(Default)]
struct LaunchPlans {
    enabled: bool,
    generation: u64,
    plans: Vec<McpPlan>,
}

struct RecentOutcome {
    key: (String, String),
    fingerprint: [u8; 32],
    completion: Mutex<Option<(Instant, Result<Value, String>)>>,
    ready: Condvar,
}

impl RecentOutcome {
    fn expired(&self) -> bool {
        self.completion
            .lock()
            .map(|completion| {
                completion
                    .as_ref()
                    .is_some_and(|(at, _)| at.elapsed() >= RECENT_OUTCOME_TTL)
            })
            .unwrap_or(false)
    }

    fn finish(&self, outcome: Result<Value, String>) {
        if let Ok(mut completion) = self.completion.lock() {
            *completion = Some((Instant::now(), outcome));
            self.ready.notify_all();
        }
    }

    fn wait(&self) -> Result<Value, String> {
        let completion = self.completion.lock().map_err(|_| UNKNOWN_OUTCOME)?;
        let (completion, _) = self
            .ready
            .wait_timeout_while(completion, DUPLICATE_WAIT, |value| value.is_none())
            .map_err(|_| UNKNOWN_OUTCOME)?;
        completion
            .as_ref()
            .map(|(_, outcome)| outcome.clone())
            .unwrap_or_else(|| Err(UNKNOWN_OUTCOME.into()))
    }
}

/// A panic can leave a write partially performed. Preserve that uncertainty
/// instead of forgetting the reservation and executing a retry again.
struct OutcomeGuard {
    operation: Arc<RecentOutcome>,
    completed: bool,
}

impl OutcomeGuard {
    fn complete(&mut self, outcome: Result<Value, String>) {
        self.operation.finish(outcome);
        self.completed = true;
    }
}

impl Drop for OutcomeGuard {
    fn drop(&mut self) {
        if !self.completed {
            self.operation.finish(Err(UNKNOWN_OUTCOME.into()));
        }
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl DaemonSink {
    fn grant_change_lock(&self, session_id: &str) -> Result<Arc<Mutex<()>>, String> {
        let mut changes = self
            .grant_changes
            .lock()
            .map_err(|error| error.to_string())?;
        changes.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = changes.get(session_id).and_then(Weak::upgrade) {
            return Ok(lock);
        }
        let lock = Arc::new(Mutex::new(()));
        changes.insert(session_id.to_string(), Arc::downgrade(&lock));
        Ok(lock)
    }

    pub fn subscribe(
        &self,
        role: ClientRole,
        _client: String,
    ) -> (u64, ClientSender, ClientReceiver) {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (channel, rx) = match role {
            ClientRole::Desktop => {
                let (tx, rx) = mpsc::unbounded_channel();
                (ClientChannel::Desktop(tx), ClientReceiver::Desktop(rx))
            }
            ClientRole::Observer => {
                let (tx, rx) = mpsc::channel(MAX_OBSERVER_QUEUED_FRAMES);
                (ClientChannel::Observer(tx), ClientReceiver::Observer(rx))
            }
        };
        let (disconnected, _) = watch::channel(false);
        let tx = ClientSender {
            channel,
            disconnected,
        };
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
            let plans = if enabled { plans } else { Vec::new() };
            if current.enabled == enabled
                && serde_json::to_value(&current.plans).ok() == serde_json::to_value(&plans).ok()
            {
                return;
            }
            current.enabled = enabled;
            current.generation = current.generation.wrapping_add(1);
            current.plans = plans;
        }
    }

    pub fn plans_enabled(&self) -> bool {
        self.plans
            .lock()
            .map(|plans| plans.enabled)
            .unwrap_or(false)
    }

    fn plan(&self, plan_id: &str) -> Option<McpPlan> {
        self.plan_with_generation(plan_id).map(|(plan, _)| plan)
    }

    fn plan_with_generation(&self, plan_id: &str) -> Option<(McpPlan, u64)> {
        self.plans.lock().ok().and_then(|plans| {
            plans
                .enabled
                .then(|| {
                    plans
                        .plans
                        .iter()
                        .find(|plan| plan.plan_id == plan_id)
                        .cloned()
                        .map(|plan| (plan, plans.generation))
                })
                .flatten()
        })
    }

    /// What an observer learns about launchable plans: never the request.
    fn plans_view(&self) -> Value {
        let (enabled, plans) = self
            .plans
            .lock()
            .map(|plans| (plans.enabled, plans.plans.clone()))
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

    fn reserve(
        &self,
        client: &str,
        request_id: &str,
        fingerprint: [u8; 32],
    ) -> Result<(Arc<RecentOutcome>, bool), String> {
        let key = (client.to_string(), request_id.to_string());
        let mut recent = self.recent.lock().map_err(|error| error.to_string())?;
        recent.retain(|entry| !entry.expired());
        if let Some(existing) = recent.iter().find(|entry| entry.key == key) {
            if existing.fingerprint != fingerprint {
                return Err("This requestId was already used for a different operation.".into());
            }
            return Ok((Arc::clone(existing), false));
        }
        // Never evict a still-valid result: doing so would turn an ordinary
        // retry into a second side effect within the promised retention time.
        if recent.len() >= MAX_RECENT_OUTCOMES {
            return Err("MCP operation history is full; wait for its 15-minute retention period before submitting a new operation.".into());
        }
        let operation = Arc::new(RecentOutcome {
            key,
            fingerprint,
            completion: Mutex::new(None),
            ready: Condvar::new(),
        });
        recent.push_back(Arc::clone(&operation));
        Ok((operation, true))
    }

    fn existing(
        &self,
        client: &str,
        request_id: &str,
        fingerprint: [u8; 32],
    ) -> Result<Option<Arc<RecentOutcome>>, String> {
        let recent = self.recent.lock().map_err(|error| error.to_string())?;
        let existing = recent
            .iter()
            .find(|entry| entry.key.0 == client && entry.key.1 == request_id && !entry.expired());
        match existing {
            Some(existing) if existing.fingerprint != fingerprint => {
                Err("This requestId was already used for a different operation.".into())
            }
            Some(existing) => Ok(Some(Arc::clone(existing))),
            None => Ok(None),
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

#[cfg(test)]
mod observer_transport_tests {
    use super::*;

    #[test]
    fn mcp_history_distinguishes_replays_and_unknown_outcomes_after_session_exit() {
        let dir = tempfile::tempdir().unwrap();
        let context = test_context(dir.path());
        let session_id = "agent-bg-session-audit-test";
        let fingerprint: [u8; 32] = Sha256::digest(
            serde_json::to_vec(&json!(["cancel", session_id, CancelScope::Session])).unwrap(),
        )
        .into();
        for (id, outcome) in [
            (
                "finished",
                Ok(json!({ "sessionId": session_id, "ended": true })),
            ),
            ("unknown", Err(UNKNOWN_OUTCOME.to_string())),
        ] {
            let (operation, _) = context.sink.reserve("client", id, fingerprint).unwrap();
            operation.finish(outcome);
            let _ = dispatch_as(
                &context,
                ClientRole::Observer,
                "client",
                Request::Cancel {
                    session_id: session_id.into(),
                    scope: CancelScope::Session,
                    request_id: id.into(),
                },
            );
        }
        let history = dispatch(&context, Request::McpHistory).unwrap();
        assert_eq!(history["entries"][0]["outcome"], "unknown");
        assert_eq!(history["entries"][1]["outcome"], "replayed");
        assert_eq!(history["entries"][1]["sessionId"], session_id);
        assert_eq!(history["entries"][1]["action"], "stop");
        assert!(context.registry.list().is_empty());
    }

    #[test]
    fn mcp_history_records_failed_writes_without_exposing_payloads_to_observers() {
        let dir = tempfile::tempdir().unwrap();
        let context = test_context(dir.path());
        let secret = "not-a-real-secret-test-fixture";
        let result = dispatch_as(
            &context,
            ClientRole::Observer,
            "test-client",
            Request::Prompt {
                session_id: secret.into(),
                text: secret.into(),
                mode: PromptMode::Now,
                request_id: secret.into(),
            },
        );
        assert!(result.is_err());
        assert!(dispatch_as(
            &context,
            ClientRole::Observer,
            "test-client",
            Request::McpHistory
        )
        .is_err());
        let history = dispatch_as(
            &context,
            ClientRole::Desktop,
            "desktop",
            Request::McpHistory,
        )
        .unwrap();
        assert_eq!(history["entries"].as_array().unwrap().len(), 1);
        assert_eq!(history["entries"][0]["outcome"], "failed");
        assert_eq!(history["entries"][0]["sessionId"], Value::Null);
        assert!(!history.to_string().contains(secret));
        context.sink.set_shared("agent-bg-session-test", false);
        assert_eq!(dispatch(&context, Request::McpHistory).unwrap(), history);
    }

    fn test_context(dir: &Path) -> Arc<Context> {
        Arc::new(Context {
            registry: Arc::new(AgentRegistry::new()),
            sink: Arc::new(DaemonSink::default()),
            scheduler: Arc::new(Scheduler::open(dir)),
            chat: Arc::new(AgentChatRegistry::new()),
            token: "test-token".into(),
            shutdown: Arc::new(Notify::new()),
            log: Arc::new(Logger::silent()),
        })
    }

    async fn send_request<W: AsyncWrite + Unpin>(writer: &mut W, id: u64, body: Request) {
        let mut bytes = serde_json::to_vec(&Frame::Request { id, body }).unwrap();
        bytes.push(b'\n');
        writer.write_all(&bytes).await.unwrap();
    }

    async fn greeting(client: &mut BufReader<tokio::io::DuplexStream>, role: ClientRole) {
        send_request(
            client.get_mut(),
            1,
            Request::Hello {
                token: "test-token".into(),
                protocol: role.protocol_version(),
                role,
                client: Some("transport-test".into()),
            },
        )
        .await;
        let frame =
            tokio::time::timeout(Duration::from_secs(2), read_frame(client, MAX_FRAME_BYTES))
                .await
                .unwrap()
                .unwrap()
                .unwrap();
        assert!(matches!(
            frame,
            Frame::Response {
                id: 1,
                ok: true,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn mismatched_role_protocols_are_rejected_before_subscribing() {
        for (role, protocol) in [
            (ClientRole::Observer, super::super::PROTOCOL_VERSION),
            (ClientRole::Desktop, OBSERVER_PROTOCOL_VERSION),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let context = test_context(dir.path());
            let (client, stream) = tokio::io::duplex(4096);
            let handler = tokio::spawn(handle_client(stream, Arc::clone(&context)));
            let mut client = BufReader::new(client);
            send_request(
                client.get_mut(),
                1,
                Request::Hello {
                    token: "test-token".into(),
                    protocol,
                    role,
                    client: None,
                },
            )
            .await;
            let frame = read_frame(&mut client, MAX_FRAME_BYTES)
                .await
                .unwrap()
                .unwrap();
            assert!(matches!(
                frame,
                Frame::Response {
                    ok: false,
                    result: Value::Null,
                    ..
                }
            ));
            tokio::time::timeout(Duration::from_secs(2), handler)
                .await
                .unwrap()
                .unwrap();
            assert!(context.sink.clients.lock().unwrap().is_empty());
            assert!(read_frame(&mut client, MAX_FRAME_BYTES)
                .await
                .unwrap()
                .is_none());
        }
    }

    #[tokio::test]
    async fn a_slow_observer_is_disconnected_without_stalling_other_clients() {
        let dir = tempfile::tempdir().unwrap();
        let context = test_context(dir.path());
        context.sink.set_shared("shared-session", true);
        let (client, stream) = tokio::io::duplex(256);
        let handler = tokio::spawn(handle_client(stream, Arc::clone(&context)));
        let mut client = BufReader::new(client);
        greeting(&mut client, ClientRole::Observer).await;
        let (_desktop_id, _desktop_tx, mut desktop_rx) = context
            .sink
            .subscribe(ClientRole::Desktop, "desktop".into());
        let (_healthy_id, healthy_tx, mut healthy_rx) = context
            .sink
            .subscribe(ClientRole::Observer, "healthy".into());

        // This observer stops reading after hello. Its first model frame
        // fills the duplex socket, then its bounded queue fills as well.
        for index in 0..MAX_OBSERVER_QUEUED_FRAMES + 3 {
            context.sink.broadcast(
                "model",
                json!({ "sessionId": "shared-session", "model": "x".repeat(512),
                    "sequence": index }),
            );
            for receiver in [&mut desktop_rx, &mut healthy_rx] {
                let line = tokio::time::timeout(Duration::from_secs(2), receiver.recv())
                    .await
                    .unwrap()
                    .unwrap();
                let frame: Frame = serde_json::from_str(&line).unwrap();
                assert!(matches!(frame, Frame::Event { name, payload }
                    if name == "model" && payload["sequence"] == index));
            }
            tokio::task::yield_now().await;
        }
        tokio::time::timeout(Duration::from_secs(2), handler)
            .await
            .expect("a full observer queue must close its blocked socket")
            .unwrap();
        assert!(!healthy_tx.is_disconnected());
        assert_eq!(context.sink.client_count(), 1);
        assert_eq!(context.sink.clients.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn observer_work_overload_closes_only_that_connection() {
        let dir = tempfile::tempdir().unwrap();
        let context = test_context(dir.path());
        // Leave two global slots, then make those two accepted requests
        // wait on the plans registry while a third request overloads it.
        let reserved = Arc::clone(&context.sink.observer_requests.0)
            .acquire_many_owned((MAX_TOTAL_OBSERVER_REQUESTS - 2) as u32)
            .await
            .unwrap();
        let (client, stream) = tokio::io::duplex(4096);
        let handler = tokio::spawn(handle_client(stream, Arc::clone(&context)));
        let mut client = BufReader::new(client);
        greeting(&mut client, ClientRole::Observer).await;
        let locked_context = Arc::clone(&context);
        let (locked_tx, locked_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let held_plans = tokio::task::spawn_blocking(move || {
            let _plans = locked_context.sink.plans.lock().unwrap();
            let _ = locked_tx.send(());
            // Dropping the sender on assertion failure also releases the
            // lock, so a failing test cannot strand blocking workers.
            let _ = release_rx.blocking_recv();
        });
        locked_rx.await.unwrap();
        for id in 2..=3 {
            send_request(client.get_mut(), id, Request::Plans).await;
        }
        tokio::time::timeout(Duration::from_secs(2), async {
            while context.sink.observer_requests.0.available_permits() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        send_request(client.get_mut(), 4, Request::Plans).await;
        tokio::time::timeout(Duration::from_secs(2), handler)
            .await
            .expect("overload closes without waiting for blocking dispatch")
            .unwrap();

        // Desktops do not consume the observer allowance, so a saturated
        // observer cannot exhaust their ability to list ordinary sessions.
        let (desktop, stream) = tokio::io::duplex(4096);
        let desktop_handler = tokio::spawn(handle_client(stream, Arc::clone(&context)));
        let mut desktop = BufReader::new(desktop);
        greeting(&mut desktop, ClientRole::Desktop).await;
        send_request(desktop.get_mut(), 2, Request::Sessions).await;
        let reply = tokio::time::timeout(
            Duration::from_secs(2),
            read_frame(&mut desktop, MAX_FRAME_BYTES),
        )
        .await
        .unwrap()
        .unwrap()
        .unwrap();
        assert!(matches!(
            reply,
            Frame::Response {
                id: 2,
                ok: true,
                ..
            }
        ));
        release_tx.send(()).unwrap();
        held_plans.await.unwrap();
        drop(reserved);
        tokio::time::timeout(Duration::from_secs(2), async {
            while context.sink.observer_requests.0.available_permits()
                != MAX_TOTAL_OBSERVER_REQUESTS
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        drop(desktop);
        tokio::time::timeout(Duration::from_secs(2), desktop_handler)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn frame_limit_rejects_an_unterminated_frame_before_eof() {
        let (mut client, stream) = tokio::io::duplex(65);
        let mut reader = BufReader::new(stream);
        client.write_all(&[b'x'; 65]).await.unwrap();
        let error = tokio::time::timeout(Duration::from_secs(2), read_frame(&mut reader, 64))
            .await
            .expect("oversized frames must not wait for newline or EOF")
            .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);

        let frame = Frame::Request {
            id: 1,
            body: Request::Sessions,
        };
        let mut bytes = serde_json::to_vec(&frame).unwrap();
        bytes.push(b'\n');
        let mut reader = BufReader::new(bytes.as_slice());
        assert!(matches!(
            read_frame(&mut reader, bytes.len()).await.unwrap(),
            Some(Frame::Request {
                id: 1,
                body: Request::Sessions
            })
        ));
        assert!(read_frame(&mut reader, bytes.len())
            .await
            .unwrap()
            .is_none());
    }
}

#[cfg(test)]
mod operation_tests {
    use super::*;
    use std::sync::Barrier;

    #[test]
    fn concurrent_requests_reserve_one_operation_and_share_its_result() {
        let sink = Arc::new(DaemonSink::default());
        let start = Arc::new(Barrier::new(12));
        let workers: Vec<_> = (0..12)
            .map(|_| {
                let sink = Arc::clone(&sink);
                let start = Arc::clone(&start);
                std::thread::spawn(move || {
                    start.wait();
                    let (operation, fresh) = sink.reserve("client", "request", [7; 32]).unwrap();
                    if fresh {
                        operation.finish(Ok(json!({ "sessionId": "one-session" })));
                    }
                    assert_eq!(operation.wait().unwrap()["sessionId"], "one-session");
                    usize::from(fresh)
                })
            })
            .collect();
        let executed: usize = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .sum();
        assert_eq!(executed, 1);
    }

    #[test]
    fn pending_operation_does_not_block_other_sessions_or_allow_content_changes() {
        let sink = DaemonSink::default();
        let (pending, first) = sink.reserve("client", "request-a", [1; 32]).unwrap();
        assert!(first);
        let (other, first) = sink.reserve("client", "request-b", [2; 32]).unwrap();
        assert!(first);
        other.finish(Ok(json!({ "queued": 1 })));
        assert_eq!(other.wait().unwrap()["queued"], 1);
        assert!(pending.completion.lock().unwrap().is_none());
        assert!(sink.reserve("client", "request-a", [3; 32]).is_err());
        let (retry, fresh) = sink.reserve("client", "request-a", [1; 32]).unwrap();
        assert!(!fresh);
        assert!(Arc::ptr_eq(&pending, &retry));
        assert!(
            sink.reserve("another client", "request-a", [3; 32])
                .unwrap()
                .1
        );
    }

    #[test]
    fn cache_capacity_never_evicts_valid_or_inflight_requests() {
        let sink = DaemonSink::default();
        let mut oldest = None;
        for index in 0..MAX_RECENT_OUTCOMES {
            let (entry, _) = sink.reserve("client", &index.to_string(), [0; 32]).unwrap();
            if index == 0 {
                entry.finish(Ok(json!({ "ended": true })));
                oldest = Some(entry);
            }
        }
        assert!(sink.reserve("client", "overflow", [0; 32]).is_err());
        assert!(!sink.reserve("client", "0", [0; 32]).unwrap().1);
        assert!(!sink.reserve("client", "1", [0; 32]).unwrap().1);

        // Only an actually expired, completed operation frees capacity.
        *oldest.unwrap().completion.lock().unwrap() = Some((
            Instant::now() - RECENT_OUTCOME_TTL,
            Ok(json!({ "ended": true })),
        ));
        assert!(sink.reserve("client", "overflow", [0; 32]).unwrap().1);
        assert_eq!(sink.recent.lock().unwrap().len(), MAX_RECENT_OUTCOMES);
    }

    #[test]
    fn interrupted_operation_stays_unknown_instead_of_reexecuting() {
        let sink = DaemonSink::default();
        let (operation, _) = sink.reserve("client", "request", [0; 32]).unwrap();
        drop(OutcomeGuard {
            operation: Arc::clone(&operation),
            completed: false,
        });
        assert_eq!(operation.wait().unwrap_err(), UNKNOWN_OUTCOME);
        let (retry, fresh) = sink.reserve("client", "request", [0; 32]).unwrap();
        assert!(!fresh);
        assert_eq!(retry.wait().unwrap_err(), UNKNOWN_OUTCOME);
    }

    #[cfg(unix)]
    #[test]
    fn a_plan_revoked_during_launch_stops_only_its_new_session() {
        let dir = tempfile::tempdir().unwrap();
        let sink = Arc::new(DaemonSink::default());
        let registry = AgentRegistry::with_local_reporter_prefixed(
            Arc::clone(&sink) as Arc<dyn AgentSink>,
            SESSION_ID_PREFIX,
        )
        .unwrap();
        let context = Context {
            registry: Arc::clone(&registry),
            sink: Arc::clone(&sink),
            scheduler: Arc::new(Scheduler::open(dir.path())),
            chat: Arc::new(AgentChatRegistry::new()),
            token: String::new(),
            shutdown: Arc::new(Notify::new()),
            log: Arc::new(Logger::silent()),
        };
        let plan: McpPlan = serde_json::from_value(json!({
            "planId": "test-plan", "label": "launch authorization test", "note": "",
            "definitionId": "custom", "workingDirectory": dir.path(), "sandbox": false,
            "request": {
                "definitionId": "custom", "label": "launch authorization test",
                "executable": "/bin/cat", "workingDirectory": dir.path(),
                "cols": 80, "rows": 24,
            },
        }))
        .unwrap();
        let launch = || {
            agent::launch_with_replay(
                Arc::clone(&sink) as Arc<dyn AgentSink>,
                Arc::clone(&registry),
                plan.request.clone(),
                None,
            )
            .unwrap()
            .session_id
        };
        let existing = launch();
        for replacement_enabled in [false, true] {
            sink.plans_replace(true, vec![plan.clone()]);
            let generation = sink.plans.lock().unwrap().generation;
            let new_session = launch();
            // The user disables launch or replaces the approved plans while
            // process creation is in progress, before the result is shared.
            let mut replacement = plan.clone();
            replacement.request.arguments = vec!["--help".into()];
            sink.plans_replace(replacement_enabled, vec![replacement]);
            assert!(finish_plan_launch(&context, &new_session, generation).is_err());
            assert!(registry.session_summary(&new_session).is_none());
            assert!(!sink.is_shared(&new_session));
            assert!(registry.session_summary(&existing).is_some());
        }
        // Reattaching a desktop with the exact same snapshot changes no
        // authorization and must not cancel an in-flight launch.
        sink.plans_replace(true, vec![plan.clone()]);
        let generation = sink.plans.lock().unwrap().generation;
        let new_session = launch();
        sink.plans_replace(true, vec![plan.clone()]);
        finish_plan_launch(&context, &new_session, generation).unwrap();
        assert!(sink.has_control(&new_session));
        registry.stop_all();
    }

    #[cfg(unix)]
    #[test]
    fn unauthorized_and_invalid_writes_cannot_exhaust_operation_history() {
        let dir = tempfile::tempdir().unwrap();
        let sink = Arc::new(DaemonSink::default());
        let registry = Arc::new(AgentRegistry::new());
        let context = Context {
            registry: Arc::clone(&registry),
            sink: Arc::clone(&sink),
            scheduler: Arc::new(Scheduler::open(dir.path())),
            chat: Arc::new(AgentChatRegistry::new()),
            token: String::new(),
            shutdown: Arc::new(Notify::new()),
            log: Arc::new(Logger::silent()),
        };
        for index in 0..(MAX_RECENT_OUTCOMES + 1) {
            assert!(dispatch_as(
                &context,
                ClientRole::Observer,
                "read-only observer",
                Request::Prompt {
                    session_id: "unshared-session".into(),
                    text: "not authorized".into(),
                    mode: PromptMode::Queue,
                    request_id: format!("denied-{index}"),
                },
            )
            .is_err());
        }
        assert!(sink.recent.lock().unwrap().is_empty());
        assert!(dispatch_as(
            &context,
            ClientRole::Observer,
            "read-only observer",
            Request::LaunchPlan {
                plan_id: "not-authorized".into(),
                request_id: "denied-launch".into(),
            },
        )
        .is_err());
        assert!(sink.recent.lock().unwrap().is_empty());

        let session = agent::launch_with_replay(
            Arc::clone(&sink) as Arc<dyn AgentSink>,
            Arc::clone(&registry),
            serde_json::from_value(json!({
                "definitionId": "custom", "label": "validation test",
                "executable": "/bin/cat", "workingDirectory": dir.path(),
                "cols": 80, "rows": 24,
            }))
            .unwrap(),
            None,
        )
        .unwrap()
        .session_id;
        sink.set_shared(&session, true);
        sink.set_control(&session, true).unwrap();
        agent::set_mcp_control(sink.as_ref(), &registry, &session, true).unwrap();
        for text in ["\x1b[201~", "\x03", "", "\n  "] {
            assert!(dispatch_as(
                &context,
                ClientRole::Observer,
                "authorized observer",
                Request::Prompt {
                    session_id: session.clone(),
                    text: text.into(),
                    mode: PromptMode::Queue,
                    request_id: format!("invalid-{}", text.len()),
                },
            )
            .is_err());
        }
        assert!(sink.recent.lock().unwrap().is_empty());
        let valid = dispatch_as(
            &context,
            ClientRole::Observer,
            "authorized observer",
            Request::Prompt {
                session_id: session,
                text: "valid work remains possible".into(),
                mode: PromptMode::Queue,
                request_id: "valid".into(),
            },
        )
        .unwrap();
        assert_eq!(valid["queued"], 1);
        assert_eq!(sink.recent.lock().unwrap().len(), 1);
        registry.stop_all();
    }

    #[test]
    fn claimed_client_names_cannot_insert_log_lines_or_terminal_controls() {
        assert_eq!(client_label(Some("client\nforged\r\x1b\t")), "clientforged");
        assert_eq!(client_label(Some("\n\r\t")), "MCP client");
        assert_eq!(client_label(Some(&"x".repeat(200))).len(), 80);
    }
}
