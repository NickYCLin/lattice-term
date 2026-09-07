//! The daemon process: `lattice-term agent-daemon --data-dir <dir>`.
//!
//! It is the ordinary desktop binary started with a subcommand, so it needs
//! no extra sidecar, and on Windows it inherits the no-console subsystem.
//! The desktop starts it on demand, detached from its own process group, and
//! it exits by itself once it has had nothing to own and nobody attached for
//! [`super::IDLE_EXIT`].

use super::automations::{self, Scheduler};
use super::{
    read_or_create_token, transport, ClientRole, DaemonPaths, Frame, HelloReply, Request, LOG_FILE,
    MAX_FRAME_BYTES, MAX_OBSERVE_BYTES, PROTOCOL_VERSION, SESSION_ID_PREFIX,
};
use crate::agent::{
    self, AgentLifecycle, AgentRegistry, AgentSessionSummary, AgentSink, AgentStateSource,
    AgentTokenUsage,
};
use crate::agent_chat::AgentChatRegistry;
use base64::Engine;
use serde_json::{json, Value};
use std::collections::HashSet;
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
                    && context.scheduler.running_count() == 0;
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
        },
    ) = hello
    else {
        return;
    };
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
    let (client_id, tx, mut rx) = context.sink.subscribe(role);
    let _ = tx.send(response_line(
        hello_id,
        serde_json::to_value(reply).map_err(|error| error.to_string()),
    ));
    context
        .log
        .line(&format!("client {client_id} attached as {role:?}"));

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
                tokio::task::spawn_blocking(move || {
                    let result = dispatch_as(&context, role, body);
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
        .filter(|summary| shared.contains(&summary.session_id))
        .collect()
}

/// Everything an observer can do, and nothing else: read the shared
/// sessions and their output. Every other request is refused before it
/// reaches the registry.
pub fn dispatch_as(context: &Context, role: ClientRole, body: Request) -> Result<Value, String> {
    match role {
        ClientRole::Desktop => dispatch(context, body),
        ClientRole::Observer => match body {
            Request::Sessions => to_value(&shared_list(context)),
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
            _ => Err("Observers may only read shared sessions.".to_string()),
        },
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
            to_value(&context.sink.shared())
        }
        Request::Shared => to_value(&context.sink.shared()),
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
    /// Session ids the user shared with observers. Lives with the daemon:
    /// a session that ends is unshared with it, and sharing never outlives
    /// the process that holds the session.
    shared: Mutex<HashSet<String>>,
    next: AtomicU64,
}

struct Client {
    id: u64,
    role: ClientRole,
    tx: mpsc::UnboundedSender<String>,
}

impl DaemonSink {
    pub fn subscribe(
        &self,
        role: ClientRole,
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

    pub fn shared(&self) -> Vec<String> {
        let mut shared: Vec<String> = self
            .shared
            .lock()
            .map(|shared| shared.iter().cloned().collect())
            .unwrap_or_default();
        shared.sort();
        shared
    }

    pub fn is_shared(&self, session_id: &str) -> bool {
        self.shared
            .lock()
            .map(|shared| shared.contains(session_id))
            .unwrap_or(false)
    }

    pub fn set_shared(&self, session_id: &str, shared: bool) {
        if let Ok(mut set) = self.shared.lock() {
            if shared {
                set.insert(session_id.to_string());
            } else {
                set.remove(session_id);
            }
        }
    }

    fn broadcast(&self, name: &str, payload: Value) {
        let session_id = payload
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let observable = name != "data" && name != "captured" && self.is_shared(session_id);
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
        self.set_shared(session_id, false);
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
