//! One long-lived `codex app-server` per chat thread.
//!
//! Codex Desktop talks to the same engine over the same JSON-RPC, and keeps
//! it running between turns: the thread stays loaded, so a follow-up is one
//! `turn/start` away instead of a fresh process that has to initialize and
//! resume the conversation from disk. This module does the same. The server
//! is started on the first turn, given `thread/start` (or `thread/resume`
//! for a conversation from an earlier session), and then serves every later
//! turn until the thread is closed, the app exits, or it has sat idle for a
//! while. Approvals travel as server requests on the same channel, whatever
//! the permission mode: the mode only decides what Codex asks about.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::process::Child;
use tokio::sync::oneshot;

use super::{
    apply_profile_environment, bounded_output, codex_approval_line, codex_request_id,
    codex_v2_item_events, headless_command, kill_turn, read_bounded_line, stderr_tail, str_field,
    truncate, u64_field, ChatAttachment, ChatEvent, ChatPermission, ChatSink, ChatUsage, Dialect,
    LineError, SharedStdin,
};

/// A server with no turn in flight for this long is ended; the thread is
/// resumed from Codex's own log if the person comes back.
const IDLE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// How long an interrupted turn may take to acknowledge before the server
/// is killed outright.
const INTERRUPT_GRACE: Duration = Duration::from_secs(5);
const RPC_INITIALIZE: u64 = 1;
const RPC_THREAD_OPEN: u64 = 2;

/// What one of our JSON-RPC requests was for, so its response is routed.
#[derive(Debug, Clone, PartialEq, Eq)]
enum RpcPurpose {
    ThreadOpen,
    BrowserReady { model: Option<String> },
    TurnStart { turn_id: String },
    Interrupt,
}

struct ActiveTurn {
    /// LatticeTerm's turn id, which every event carries.
    turn_id: String,
    /// Codex's own id for the turn, needed to interrupt it.
    codex_turn_id: Option<String>,
    usage: Option<ChatUsage>,
    error: Option<String>,
    /// Approval requests awaiting an answer, by card id, with the JSON-RPC
    /// id the answer must carry.
    pending: HashMap<String, Value>,
}

struct QueuedTurn {
    turn_id: String,
    params: Value,
}

struct PendingSteer {
    codex_turn_id: String,
    reply: oneshot::Sender<Result<(), String>>,
}

struct ServerState {
    codex_thread_id: Option<String>,
    thread_ready: bool,
    active: Option<ActiveTurn>,
    /// The first turn, held until `thread/start` has named the thread.
    queued: Option<QueuedTurn>,
    next_rpc: u64,
    pending_rpc: HashMap<u64, RpcPurpose>,
    pending_steers: HashMap<u64, PendingSteer>,
    last_activity: Instant,
    exited: bool,
}

pub(super) struct CodexServer {
    browser_enabled: bool,
    thread_id: String,
    profile_config_directory: Option<PathBuf>,
    child: Mutex<Option<Child>>,
    stdin: SharedStdin,
    state: Mutex<ServerState>,
}

impl CodexServer {
    fn state(&self) -> MutexGuard<'_, ServerState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn kill(&self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(child) = child.as_mut() {
                let _ = kill_turn(child);
            }
        }
    }

    fn mark_exited(&self) {
        let mut state = self.state();
        state.exited = true;
        state.pending_steers.clear();
    }

    async fn write_line(&self, line: &str) -> Result<(), String> {
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|error| format!("Cannot talk to the agent: {error}"))?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|error| format!("Cannot talk to the agent: {error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("Cannot talk to the agent: {error}"))
    }
}

/// The servers alive right now, by chat thread id.
#[derive(Default)]
pub(super) struct CodexServers {
    servers: Mutex<HashMap<String, Arc<CodexServer>>>,
}

impl CodexServers {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Arc<CodexServer>>> {
        self.servers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(super) fn get(&self, thread_id: &str) -> Option<Arc<CodexServer>> {
        self.lock().get(thread_id).cloned()
    }

    /// Ends and forgets one thread's server.
    pub(super) fn close(&self, thread_id: &str) -> bool {
        let server = self.lock().remove(thread_id);
        match server {
            Some(server) => {
                server.mark_exited();
                server.kill();
                true
            }
            None => false,
        }
    }

    pub(super) fn shutdown(&self) {
        let servers: Vec<Arc<CodexServer>> = self.lock().drain().map(|(_, s)| s).collect();
        for server in servers {
            server.mark_exited();
            server.kill();
        }
    }

    /// Ends servers that have been idle past the timeout. Called on each
    /// send so a forgotten thread does not keep a process forever.
    fn reap_idle(&self, now: Instant) {
        let idle: Vec<String> = self
            .lock()
            .iter()
            .filter(|(_, server)| {
                let state = server.state();
                state.active.is_none()
                    && state.queued.is_none()
                    && state.pending_steers.is_empty()
                    && now.duration_since(state.last_activity) > IDLE_TIMEOUT
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in idle {
            self.close(&id);
        }
    }
}

/// The per-turn overrides for a permission mode.
fn turn_policies(permission: ChatPermission) -> (Value, Value) {
    match permission {
        ChatPermission::Ask => (
            Value::from("untrusted"),
            serde_json::json!({ "type": "workspaceWrite" }),
        ),
        ChatPermission::ReadOnly => (
            Value::from("never"),
            serde_json::json!({ "type": "readOnly" }),
        ),
        ChatPermission::WorkspaceWrite => (
            Value::from("never"),
            serde_json::json!({ "type": "workspaceWrite" }),
        ),
        ChatPermission::Full => (
            Value::from("never"),
            serde_json::json!({ "type": "dangerFullAccess" }),
        ),
    }
}

/// The `turn/start` params for one message.
pub(super) fn turn_params(
    codex_thread_id: &str,
    prompt: &str,
    attachments: &[ChatAttachment],
    permission: ChatPermission,
    model: Option<&str>,
    working_directory: &Path,
) -> Value {
    let input = turn_input(prompt, attachments);
    let (approval_policy, sandbox_policy) = turn_policies(permission);
    let mut params = serde_json::json!({
        "threadId": codex_thread_id,
        "input": input,
        "approvalPolicy": approval_policy,
        "sandboxPolicy": sandbox_policy,
        "cwd": working_directory.display().to_string(),
    });
    if let Some(model) = model {
        params["model"] = Value::String(model.to_string());
    }
    params
}

fn turn_input(prompt: &str, attachments: &[ChatAttachment]) -> Vec<Value> {
    let mut input = vec![serde_json::json!({ "type": "text", "text": prompt })];
    for attachment in attachments.iter().filter(|attachment| attachment.is_image) {
        input.push(serde_json::json!({
            "type": "localImage",
            "path": attachment.path.display().to_string(),
        }));
    }
    input
}

fn prepare_steer(
    state: &mut ServerState,
    expected_turn_id: &str,
    prompt: &str,
    attachments: &[ChatAttachment],
    reply: oneshot::Sender<Result<(), String>>,
) -> Result<(u64, String), String> {
    if state.exited || !state.thread_ready {
        return Err("The Codex session is not ready. Keep this message queued instead.".into());
    }
    if !state.pending_steers.is_empty() {
        return Err("Another instruction is still awaiting confirmation.".into());
    }
    let turn = state
        .active
        .as_ref()
        .filter(|turn| turn.turn_id == expected_turn_id)
        .ok_or("That turn has ended. Keep this message queued instead.")?;
    let native_turn = turn
        .codex_turn_id
        .as_ref()
        .ok_or("Codex has not started this turn yet. Keep this message queued instead.")?;
    let native_thread = state
        .codex_thread_id
        .as_ref()
        .ok_or("The Codex thread is not ready.")?;
    let id = state.next_rpc;
    let line = rpc_line(
        id,
        "turn/steer",
        serde_json::json!({
            "threadId": native_thread, "expectedTurnId": native_turn,
            "input": turn_input(prompt, attachments),
        }),
    );
    state.next_rpc += 1;
    state.pending_steers.insert(
        id,
        PendingSteer {
            codex_turn_id: native_turn.clone(),
            reply,
        },
    );
    state.last_activity = Instant::now();
    Ok((id, line))
}

pub(super) async fn steer(
    servers: &CodexServers,
    thread_id: &str,
    expected_turn_id: &str,
    prompt: &str,
    attachments: &[ChatAttachment],
) -> Result<(), String> {
    let server = servers
        .get(thread_id)
        .ok_or("No Codex turn is running in this chat.")?;
    let (reply, accepted) = oneshot::channel();
    let (id, line) = prepare_steer(
        &mut server.state(),
        expected_turn_id,
        prompt,
        attachments,
        reply,
    )?;
    // Never silently retry: a transport failure may follow an accepted write.
    let written = tokio::time::timeout(Duration::from_secs(10), server.write_line(&line))
        .await
        .unwrap_or_else(|_| Err("The Codex input channel stopped responding.".into()));
    if let Err(error) = written {
        // A cancelled or failed write may leave half a JSON line on stdin.
        // End this server before another request can use that stream.
        server.mark_exited();
        server.kill();
        return Err(error);
    }
    let result = tokio::time::timeout(Duration::from_secs(30), async {
        accepted.await.map_err(|_| {
            "The Codex session closed before confirming the instruction.".to_string()
        })?
    })
    .await
    .unwrap_or_else(|_| {
        Err(
            "Codex did not confirm receipt in time. Check the conversation before sending again."
                .into(),
        )
    });
    server.state().pending_steers.remove(&id);
    result
}

fn rpc_line(id: u64, method: &str, params: Value) -> String {
    serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
        .to_string()
}

/// The three lines that open a server: handshake, then the thread.
fn opening_lines(
    working_directory: &Path,
    permission: ChatPermission,
    model: Option<&str>,
    native_session_id: Option<&str>,
) -> Vec<String> {
    let (approval_policy, _) = turn_policies(permission);
    let sandbox = match permission {
        ChatPermission::ReadOnly => "read-only",
        ChatPermission::Full => "danger-full-access",
        ChatPermission::Ask | ChatPermission::WorkspaceWrite => "workspace-write",
    };
    let mut thread = serde_json::json!({
        "cwd": working_directory.display().to_string(),
        "approvalPolicy": approval_policy,
        "sandbox": sandbox,
    });
    let method = match native_session_id {
        Some(id) => {
            thread["threadId"] = Value::String(id.to_string());
            "thread/resume"
        }
        None => {
            if let Some(model) = model {
                thread["model"] = Value::String(model.to_string());
            }
            "thread/start"
        }
    };
    vec![
        rpc_line(
            RPC_INITIALIZE,
            "initialize",
            serde_json::json!({ "clientInfo": {
                "name": "latticeterm",
                "title": "LatticeTerm",
                "version": env!("CARGO_PKG_VERSION"),
            } }),
        ),
        serde_json::json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} }).to_string(),
        rpc_line(RPC_THREAD_OPEN, method, thread),
    ]
}

/// Everything `send` has validated about one turn.
pub(super) struct TurnRequest<'a> {
    pub browser_enabled: bool,
    pub thread_id: &'a str,
    pub turn_id: &'a str,
    pub prompt: &'a str,
    pub attachments: &'a [ChatAttachment],
    pub permission: ChatPermission,
    pub model: Option<&'a str>,
    pub native_session_id: Option<&'a str>,
    pub working_directory: &'a Path,
    pub profile_config_directory: Option<&'a Path>,
    pub executable: &'a Path,
}

fn same_server_identity(
    current_profile: Option<&Path>,
    current_native_id: Option<&str>,
    requested_profile: Option<&Path>,
    requested_native_id: Option<&str>,
) -> bool {
    current_profile == requested_profile
        && requested_native_id.is_some_and(|id| !id.is_empty())
        && current_native_id == requested_native_id
}

/// Runs one turn on the thread's server, starting the server first when
/// there is none. Returns once the request is on its way; everything else
/// arrives through the sink.
pub(super) async fn send_turn<S: ChatSink>(
    sink: Arc<S>,
    servers: &CodexServers,
    request: TurnRequest<'_>,
) -> Result<(), String> {
    servers.reap_idle(Instant::now());

    if let Some(server) = servers.get(request.thread_id) {
        let line = {
            let mut state = server.state();
            if state.exited {
                None
            } else if state.active.is_some() || state.queued.is_some() {
                return Err("This conversation is still answering.".to_string());
            } else if server.browser_enabled != request.browser_enabled
                || !same_server_identity(
                    server.profile_config_directory.as_deref(),
                    state.codex_thread_id.as_deref(),
                    request.profile_config_directory,
                    request.native_session_id,
                )
            {
                // An account/provider handoff resets the native id. A live
                // process from the old account must never answer that turn.
                None
            } else {
                let codex_thread_id = state
                    .codex_thread_id
                    .clone()
                    .ok_or_else(|| "The agent has not opened its thread yet.".to_string())?;
                let params = turn_params(
                    &codex_thread_id,
                    request.prompt,
                    request.attachments,
                    request.permission,
                    request.model,
                    request.working_directory,
                );
                let id = state.next_rpc;
                state.next_rpc += 1;
                state.pending_rpc.insert(
                    id,
                    RpcPurpose::TurnStart {
                        turn_id: request.turn_id.to_string(),
                    },
                );
                state.active = Some(ActiveTurn {
                    turn_id: request.turn_id.to_string(),
                    codex_turn_id: None,
                    usage: None,
                    error: None,
                    pending: HashMap::new(),
                });
                state.last_activity = Instant::now();
                Some(rpc_line(id, "turn/start", params))
            }
        };
        match line {
            Some(line) => {
                sink.event(
                    request.thread_id,
                    request.turn_id,
                    ChatEvent::Started {
                        native_session_id: server.state().codex_thread_id.clone(),
                        model: None,
                    },
                );
                if let Err(error) = server.write_line(&line).await {
                    server.state().active = None;
                    servers.close(request.thread_id);
                    return Err(error);
                }
                return Ok(());
            }
            // The old server died; fall through and start a fresh one that
            // resumes the same thread.
            None => {
                servers.close(request.thread_id);
            }
        }
    }

    let mut command = headless_command(request.executable);
    apply_profile_environment(
        &mut command,
        Dialect::Codex,
        request.profile_config_directory,
    );
    command.arg("app-server");
    if request.browser_enabled {
        command.args(super::browser::codex_arguments());
    }
    command.current_dir(request.working_directory);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Cannot start codex: {error}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "The agent's input could not be opened.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "The agent's output could not be captured.".to_string())?;
    let stderr = child.stderr.take();

    // The thread id Codex will answer with is not known yet; the first
    // turn waits in `queued` and is sent when `thread/start` returns.
    let native_session_id = request
        .native_session_id
        .map(str::to_string)
        .or_else(|| Some(String::new()));
    let queued_params = turn_params(
        native_session_id.as_deref().unwrap_or_default(),
        request.prompt,
        request.attachments,
        request.permission,
        request.model,
        request.working_directory,
    );
    let server = Arc::new(CodexServer {
        browser_enabled: request.browser_enabled,
        profile_config_directory: request.profile_config_directory.map(Path::to_path_buf),
        thread_id: request.thread_id.to_string(),
        child: Mutex::new(Some(child)),
        stdin: Arc::new(tokio::sync::Mutex::new(stdin)),
        state: Mutex::new(ServerState {
            codex_thread_id: None,
            thread_ready: false,
            active: Some(ActiveTurn {
                turn_id: request.turn_id.to_string(),
                codex_turn_id: None,
                usage: None,
                error: None,
                pending: HashMap::new(),
            }),
            queued: Some(QueuedTurn {
                turn_id: request.turn_id.to_string(),
                params: queued_params,
            }),
            next_rpc: RPC_THREAD_OPEN + 1,
            pending_rpc: HashMap::from([(RPC_THREAD_OPEN, RpcPurpose::ThreadOpen)]),
            pending_steers: HashMap::new(),
            last_activity: Instant::now(),
            exited: false,
        }),
    });
    {
        let mut all = servers.lock();
        if let Some(previous) = all.insert(request.thread_id.to_string(), Arc::clone(&server)) {
            previous.kill();
        }
    }

    let reader_server = Arc::clone(&server);
    let reader_sink = Arc::clone(&sink);
    tauri::async_runtime::spawn(async move {
        let stderr_task = tauri::async_runtime::spawn(stderr_tail(stderr));
        let mut reader = BufReader::new(stdout);
        let mut line = Vec::new();
        loop {
            line.clear();
            match read_bounded_line(&mut reader, &mut line).await {
                Ok(0) | Err(LineError::Io) => break,
                Ok(_) => {}
                Err(LineError::TooLong) => continue,
            }
            let text = String::from_utf8_lossy(&line);
            let Ok(value) = serde_json::from_str::<Value>(text.trim_end()) else {
                continue;
            };
            let outcome = handle_line(&reader_server, &value);
            for (turn_id, event) in outcome.events {
                reader_sink.event(&reader_server.thread_id, &turn_id, event);
            }
            for reply in outcome.writes {
                if reader_server.write_line(&reply).await.is_err() {
                    break;
                }
            }
        }
        // The server is gone. A turn still in flight ends as an error with
        // whatever stderr had to say.
        let tail = stderr_task.await.unwrap_or_default();
        let unfinished = {
            let mut state = reader_server.state();
            state.exited = true;
            state.queued = None;
            state.pending_steers.clear();
            let codex_thread_id = state.codex_thread_id.clone();
            state.active.take().map(|turn| (turn, codex_thread_id))
        };
        if let Some((turn, codex_thread_id)) = unfinished {
            let detail = tail.trim();
            reader_sink.event(
                &reader_server.thread_id,
                &turn.turn_id,
                ChatEvent::Finished {
                    native_session_id: codex_thread_id,
                    usage: turn.usage,
                    cost_usd: None,
                    duration_ms: None,
                    error: Some(if detail.is_empty() {
                        "The agent stopped.".to_string()
                    } else {
                        detail.to_string()
                    }),
                },
            );
        }
        if let Ok(mut child) = reader_server.child.lock() {
            if let Some(child) = child.as_mut() {
                let _ = child.try_wait();
            }
        }
    });

    let opening = opening_lines(
        request.working_directory,
        request.permission,
        request.model,
        request.native_session_id,
    );
    for line in &opening {
        if let Err(error) = server.write_line(line).await {
            servers.close(request.thread_id);
            return Err(error);
        }
    }
    Ok(())
}

/// What one line from the server changes: events to show (tagged with the
/// turn they belong to) and replies the server is owed.
#[derive(Default)]
struct LineOutcome {
    events: Vec<(String, ChatEvent)>,
    writes: Vec<String>,
}

fn start_queued_turn(state: &mut ServerState, out: &mut LineOutcome, model: Option<String>) {
    let Some(codex_thread_id) = state.codex_thread_id.clone() else {
        return;
    };
    let Some(mut queued) = state.queued.take() else {
        return;
    };
    queued.params["threadId"] = Value::String(codex_thread_id.clone());
    let id = state.next_rpc;
    state.next_rpc += 1;
    state.pending_rpc.insert(
        id,
        RpcPurpose::TurnStart {
            turn_id: queued.turn_id.clone(),
        },
    );
    out.events.push((
        queued.turn_id,
        ChatEvent::Started {
            native_session_id: Some(codex_thread_id),
            model,
        },
    ));
    out.writes.push(rpc_line(id, "turn/start", queued.params));
}

fn handle_line(server: &CodexServer, value: &Value) -> LineOutcome {
    let mut out = LineOutcome::default();
    let method = str_field(value, "method");
    let id = value.get("id");
    let mut state = server.state();
    state.last_activity = Instant::now();

    // A response to one of our requests.
    if method.is_none() {
        let Some(rpc_id) = id.and_then(Value::as_u64) else {
            return out;
        };
        if let Some(pending) = state.pending_steers.remove(&rpc_id) {
            let result = if let Some(error) = value.get("error") {
                Err(truncate(
                    str_field(error, "message").unwrap_or("Codex refused the instruction."),
                    2048,
                ))
            } else if value["result"]["turnId"].as_str() == Some(pending.codex_turn_id.as_str()) {
                Ok(())
            } else {
                Err("Codex did not confirm the expected turn. Check the conversation before sending again.".into())
            };
            let _ = pending.reply.send(result);
            return out;
        }
        let Some(purpose) = state.pending_rpc.remove(&rpc_id) else {
            return out;
        };
        let error = value.get("error").map(|error| {
            truncate(
                str_field(error, "message").unwrap_or("The agent refused the request."),
                2048,
            )
        });
        match purpose {
            RpcPurpose::ThreadOpen => {
                let result = value.get("result");
                let codex_thread_id = result
                    .and_then(|result| result.get("thread"))
                    .and_then(|thread| str_field(thread, "id"))
                    .map(str::to_string);
                match (error, codex_thread_id) {
                    (None, Some(codex_thread_id)) => {
                        state.codex_thread_id = Some(codex_thread_id.clone());
                        state.thread_ready = true;
                        let model = result
                            .and_then(|result| str_field(result, "model"))
                            .map(str::to_string);
                        if server.browser_enabled {
                            // The first model request can otherwise race MCP
                            // startup and be sent with no browser tools.
                            let id = state.next_rpc;
                            state.next_rpc += 1;
                            state
                                .pending_rpc
                                .insert(id, RpcPurpose::BrowserReady { model });
                            out.writes.push(rpc_line(
                                id,
                                "mcpServerStatus/list",
                                serde_json::json!({
                                    "threadId": codex_thread_id,
                                }),
                            ));
                        } else {
                            start_queued_turn(&mut state, &mut out, model);
                        }
                    }
                    (error, _) => {
                        let message = error
                            .unwrap_or_else(|| "The agent did not name its thread.".to_string());
                        state.queued = None;
                        if let Some(turn) = state.active.take() {
                            out.events.push((
                                turn.turn_id,
                                ChatEvent::Finished {
                                    native_session_id: None,
                                    usage: None,
                                    cost_usd: None,
                                    duration_ms: None,
                                    error: Some(message),
                                },
                            ));
                        }
                        state.exited = true;
                        drop(state);
                        server.kill();
                    }
                }
            }
            RpcPurpose::BrowserReady { model } => {
                let available = value["result"]["data"].as_array().is_some_and(|servers| {
                    servers.iter().any(|server| {
                        server["name"] == "latticeterm_browser"
                            && server["tools"].as_object().is_some_and(|tools| {
                                tools.contains_key("browser_navigate")
                                    && tools.contains_key("browser_click")
                            })
                    })
                });
                if error.is_none() && available {
                    start_queued_turn(&mut state, &mut out, model);
                } else {
                    state.queued = None;
                    if let Some(turn) = state.active.take() {
                        out.events.push((turn.turn_id, ChatEvent::Finished {
                            native_session_id: state.codex_thread_id.clone(),
                            usage: None, cost_usd: None, duration_ms: None,
                            error: Some(error.unwrap_or_else(|| "Browser tools did not start. Check Node.js and the browser installation, then retry.".to_string())),
                        }));
                    }
                    state.exited = true;
                    drop(state);
                    server.kill();
                }
            }
            RpcPurpose::TurnStart { turn_id } => {
                if let Some(error) = error {
                    if state
                        .active
                        .as_ref()
                        .is_some_and(|turn| turn.turn_id == turn_id)
                    {
                        let turn = state.active.take().expect("checked");
                        out.events.push((
                            turn.turn_id,
                            ChatEvent::Finished {
                                native_session_id: state.codex_thread_id.clone(),
                                usage: turn.usage,
                                cost_usd: None,
                                duration_ms: None,
                                error: Some(error),
                            },
                        ));
                    }
                } else if let Some(turn) = state.active.as_mut() {
                    if turn.turn_id == turn_id {
                        turn.codex_turn_id = value
                            .get("result")
                            .and_then(|result| result.get("turn"))
                            .and_then(|turn| str_field(turn, "id"))
                            .map(str::to_string);
                    }
                }
            }
            RpcPurpose::Interrupt => {}
        }
        return out;
    }
    let method = method.unwrap_or_default();
    let params = value.get("params").cloned().unwrap_or(Value::Null);
    let active_turn_id = state.active.as_ref().map(|turn| turn.turn_id.clone());

    // A server request: something that needs an answer.
    if let Some(rpc_id) = id {
        match method {
            "mcpServer/elicitation/request" => {
                let Some(turn) = state.active.as_mut() else {
                    out.writes.push(
                        serde_json::json!({
                            "id": rpc_id, "result": {"action": "decline", "content": null},
                        })
                        .to_string(),
                    );
                    return out;
                };
                let request_id = codex_request_id(rpc_id);
                out.events.push((
                    turn.turn_id.clone(),
                    ChatEvent::ApprovalRequested {
                        request_id: request_id.clone(),
                        tool_use_id: None,
                        name: if is_mcp_tool_approval(&params) {
                            "mcp_tool"
                        } else {
                            "unsupported_input"
                        }
                        .to_string(),
                        summary: truncate(str_field(&params, "message").unwrap_or_default(), 200),
                        input: bounded_output(
                            &serde_json::to_string_pretty(&params).unwrap_or_default(),
                        ),
                    },
                ));
                turn.pending.insert(
                    request_id,
                    serde_json::json!({
                        "latticeterm_rpc_id": rpc_id, "method": method, "params": params,
                    }),
                );
            }
            "item/tool/requestUserInput" | "tool/requestUserInput" => {
                let Some(turn) = state.active.as_mut() else {
                    out.writes.push(
                        serde_json::json!({"id": rpc_id, "result": {"answers": {}}}).to_string(),
                    );
                    return out;
                };
                let request_id = codex_request_id(rpc_id);
                out.events.push((
                    turn.turn_id.clone(),
                    ChatEvent::ApprovalRequested {
                        request_id: request_id.clone(),
                        tool_use_id: None,
                        name: "user_input".to_string(),
                        summary: "".to_string(),
                        input: bounded_output(&params.to_string()),
                    },
                ));
                turn.pending.insert(
                    request_id,
                    serde_json::json!({
                        "latticeterm_rpc_id": rpc_id, "method": method, "params": params,
                    }),
                );
            }
            "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/permissions/requestApproval" => {
                let Some(turn) = state.active.as_mut() else {
                    // No turn to attach the card to: decline rather than hang.
                    let pending = serde_json::json!({"latticeterm_rpc_id": rpc_id, "method": method, "params": params});
                    out.writes.push(
                        response_line(&pending, false, None)
                            .unwrap_or_else(|_| decline_line(rpc_id)),
                    );
                    return out;
                };
                let request_id = codex_request_id(rpc_id);
                let (name, summary) = match method {
                    "item/commandExecution/requestApproval" => (
                        "command",
                        str_field(&params, "command")
                            .unwrap_or_default()
                            .to_string(),
                    ),
                    "item/fileChange/requestApproval" => (
                        "file_change",
                        str_field(&params, "reason")
                            .or_else(|| str_field(&params, "grantRoot"))
                            .unwrap_or("edit files in the working directory")
                            .to_string(),
                    ),
                    _ => (
                        "permissions",
                        str_field(&params, "reason")
                            .unwrap_or("extra permissions")
                            .to_string(),
                    ),
                };
                let shown = serde_json::json!({
                    "command": params.get("command"),
                    "cwd": params.get("cwd"),
                    "reason": params.get("reason"),
                    "permissions": params.get("permissions"),
                });
                out.events.push((
                    turn.turn_id.clone(),
                    ChatEvent::ApprovalRequested {
                        request_id: request_id.clone(),
                        tool_use_id: str_field(&params, "itemId").map(str::to_string),
                        name: name.to_string(),
                        summary: truncate(&summary, 200),
                        input: bounded_output(
                            &serde_json::to_string_pretty(&shown).unwrap_or_default(),
                        ),
                    },
                ));
                turn.pending.insert(
                    request_id,
                    serde_json::json!({ "latticeterm_rpc_id": rpc_id, "method": method, "params": params }),
                );
            }
            _ => {
                out.writes.push(decline_line(rpc_id));
                if let Some(turn_id) = active_turn_id {
                    out.events.push((
                        turn_id,
                        ChatEvent::Notice {
                            message: format!(
                                "The agent asked something the chat window cannot show ({method}); it was declined."
                            ),
                        },
                    ));
                }
            }
        }
        return out;
    }

    // Notifications about the turn in flight.
    let Some(turn_id) = active_turn_id else {
        return out;
    };
    match method {
        "turn/started" => {
            if let Some(turn) = state.active.as_mut() {
                if turn.codex_turn_id.is_none() {
                    turn.codex_turn_id = params
                        .get("turn")
                        .and_then(|turn| str_field(turn, "id"))
                        .map(str::to_string);
                }
            }
        }
        "item/agentMessage/delta" => {
            if let (Some(item_id), Some(delta)) =
                (str_field(&params, "itemId"), str_field(&params, "delta"))
            {
                out.events.push((
                    turn_id,
                    ChatEvent::TextDelta {
                        item_id: item_id.to_string(),
                        delta: delta.to_string(),
                    },
                ));
            }
        }
        "item/started" | "item/completed" => {
            if let Some(item) = params.get("item") {
                for event in codex_v2_item_events(item, method == "item/completed") {
                    out.events.push((turn_id.clone(), event));
                }
            }
        }
        "thread/tokenUsage/updated" => {
            if let Some(last) = params.get("tokenUsage").and_then(|usage| usage.get("last")) {
                if let Some(turn) = state.active.as_mut() {
                    turn.usage = Some(ChatUsage {
                        input_tokens: u64_field(last, "inputTokens"),
                        output_tokens: u64_field(last, "outputTokens"),
                        cache_read_tokens: u64_field(last, "cachedInputTokens"),
                        cache_write_tokens: u64_field(last, "cacheWriteInputTokens"),
                        reasoning_tokens: u64_field(last, "reasoningOutputTokens"),
                    });
                }
            }
        }
        "turn/completed" => {
            let duration_ms = params
                .get("turn")
                .and_then(|turn| turn.get("durationMs"))
                .and_then(Value::as_u64);
            let error = params
                .get("turn")
                .and_then(|turn| turn.get("error"))
                .filter(|error| !error.is_null())
                .map(|error| {
                    truncate(
                        str_field(error, "message").unwrap_or("The turn failed."),
                        2048,
                    )
                })
                .or_else(|| match params["turn"]["status"].as_str() {
                    Some("interrupted") => Some("The turn was interrupted.".to_string()),
                    Some("failed") => Some("The turn failed.".to_string()),
                    _ => None,
                });
            if let Some(turn) = state.active.take() {
                out.events.push((
                    turn.turn_id,
                    ChatEvent::Finished {
                        native_session_id: state.codex_thread_id.clone(),
                        usage: turn.usage,
                        cost_usd: None,
                        duration_ms,
                        error: error.or(turn.error),
                    },
                ));
            }
        }
        "error" => {
            let message = truncate(str_field(&params, "message").unwrap_or("error"), 2048);
            if let Some(turn) = state.active.as_mut() {
                turn.error = Some(message.clone());
            }
            out.events.push((turn_id, ChatEvent::Notice { message }));
        }
        _ => {}
    }
    out
}

fn decline_line(rpc_id: &Value) -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": rpc_id,
        "error": { "code": -32601, "message": "LatticeTerm cannot answer this request" },
    })
    .to_string()
}

/// Answers one approval card on the thread's server.
pub(super) async fn respond(
    servers: &CodexServers,
    thread_id: &str,
    request_id: &str,
    allow: bool,
    message: Option<&str>,
) -> Result<(), String> {
    let server = servers
        .get(thread_id)
        .ok_or_else(|| "This conversation is not waiting for an answer.".to_string())?;
    let response = {
        let mut state = server.state();
        let turn = state
            .active
            .as_mut()
            .ok_or_else(|| "This conversation is not waiting for an answer.".to_string())?;
        let pending = turn
            .pending
            .get(request_id)
            .ok_or_else(|| "This approval has already been answered.".to_string())?;
        let response = response_line(pending, allow, message)?;
        turn.pending.remove(request_id);
        response
    };
    server.write_line(&response).await
}

fn response_line(pending: &Value, allow: bool, message: Option<&str>) -> Result<String, String> {
    let id = &pending["latticeterm_rpc_id"];
    let result = match pending["method"].as_str() {
        Some("mcpServer/elicitation/request") => {
            if allow && !is_mcp_tool_approval(&pending["params"]) {
                return Err("This input format is not supported yet.".to_string());
            }
            serde_json::json!({
                "action": if allow { "accept" } else { "decline" },
                "content": if allow { serde_json::json!({}) } else { Value::Null },
            })
        }
        Some("item/tool/requestUserInput" | "tool/requestUserInput") => {
            if !allow {
                serde_json::json!({"answers": {}})
            } else {
                let raw = message.ok_or("Answer the questions first.")?;
                if raw.len() > 16_384 {
                    return Err("The answer is too long.".to_string());
                }
                let supplied: Value = serde_json::from_str(raw).map_err(|_| "Invalid answers.")?;
                let questions = pending["params"]["questions"]
                    .as_array()
                    .ok_or("Invalid questions.")?;
                let mut answers = serde_json::Map::new();
                for question in questions {
                    let key = question["id"].as_str().ok_or("Invalid question id.")?;
                    let values = supplied["answers"][key]["answers"]
                        .as_array()
                        .ok_or("Answer every question.")?;
                    if values.len() != 1
                        || !values[0]
                            .as_str()
                            .is_some_and(|answer| !answer.trim().is_empty() && answer.len() <= 4096)
                    {
                        return Err("Provide one answer for each question.".to_string());
                    }
                    answers.insert(key.to_string(), serde_json::json!({"answers": values}));
                }
                serde_json::json!({"answers": answers})
            }
        }
        Some("item/permissions/requestApproval") => serde_json::json!({
            "permissions": if allow { pending["params"]["permissions"].clone() } else { serde_json::json!({}) },
            "scope": "turn",
        }),
        _ => return Ok(codex_approval_line(id, allow)),
    };
    Ok(serde_json::json!({"id": id, "result": result}).to_string())
}

// Codex's MCP tool approval is an empty form with an explicit semantic tag.
// Never turn a login form or another structured input into a generic Yes.
fn is_mcp_tool_approval(params: &Value) -> bool {
    let meta = params.get("_meta").or_else(|| params.get("meta"));
    params["mode"] == "form"
        && meta
            .and_then(|meta| meta.get("codex_approval_kind"))
            .and_then(Value::as_str)
            == Some("mcp_tool_call")
        && params["requestedSchema"] == serde_json::json!({"type": "object", "properties": {}})
}

/// Interrupts the turn in flight, keeping the server for the next one. A
/// server that does not acknowledge within the grace period is killed; its
/// reader then reports the turn as stopped.
pub(super) fn stop(servers: &CodexServers, thread_id: &str) -> Result<bool, String> {
    let Some(server) = servers.get(thread_id) else {
        return Ok(false);
    };
    let (codex_thread_id, codex_turn_id, turn_id) = {
        let state = server.state();
        let Some(turn) = state.active.as_ref() else {
            return Ok(false);
        };
        (
            state.codex_thread_id.clone(),
            turn.codex_turn_id.clone(),
            turn.turn_id.clone(),
        )
    };
    match (codex_thread_id, codex_turn_id) {
        (Some(codex_thread_id), Some(codex_turn_id)) => {
            let interrupt_server = Arc::clone(&server);
            tauri::async_runtime::spawn(async move {
                let line = {
                    let mut state = interrupt_server.state();
                    let id = state.next_rpc;
                    state.next_rpc += 1;
                    state.pending_rpc.insert(id, RpcPurpose::Interrupt);
                    rpc_line(
                        id,
                        "turn/interrupt",
                        serde_json::json!({ "threadId": codex_thread_id, "turnId": codex_turn_id }),
                    )
                };
                let _ = interrupt_server.write_line(&line).await;
                tokio::time::sleep(INTERRUPT_GRACE).await;
                let still_running = interrupt_server
                    .state()
                    .active
                    .as_ref()
                    .is_some_and(|turn| turn.turn_id == turn_id);
                if still_running {
                    interrupt_server.state().exited = true;
                    interrupt_server.kill();
                }
            });
        }
        _ => {
            // Nothing to address an interrupt to yet; the reader reports the
            // stop once the process is gone.
            server.state().exited = true;
            server.kill();
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn question_responses_keep_rpc_ids_and_only_requested_answers() {
        let pending = serde_json::json!({
            "latticeterm_rpc_id": "question-1", "method": "item/tool/requestUserInput",
            "params": {"questions": [{"id": "browser"}]},
        });
        let response: Value = serde_json::from_str(&response_line(&pending, true, Some(
            r#"{"answers":{"browser":{"answers":["Accept"]},"unrequested":{"answers":["extra"]}}}"#,
        )).unwrap()).unwrap();
        assert_eq!(response["id"], "question-1");
        assert_eq!(response["result"]["answers"].as_object().unwrap().len(), 1);
        assert_eq!(
            response["result"]["answers"]["browser"]["answers"][0],
            "Accept"
        );
        assert!(response_line(&pending, true, Some("{}")).is_err());
        let declined: Value =
            serde_json::from_str(&response_line(&pending, false, None).unwrap()).unwrap();
        assert_eq!(declined["result"], serde_json::json!({"answers": {}}));
    }

    #[test]
    fn extra_permissions_grant_only_the_requested_scope() {
        let permissions = serde_json::json!({"network": {"enabled": true}});
        let pending = serde_json::json!({"latticeterm_rpc_id": 5, "method": "item/permissions/requestApproval", "params": {"permissions": permissions}});
        let granted: Value =
            serde_json::from_str(&response_line(&pending, true, None).unwrap()).unwrap();
        assert_eq!(granted["result"]["permissions"], permissions);
        assert_eq!(granted["result"]["scope"], "turn");
        let denied: Value =
            serde_json::from_str(&response_line(&pending, false, None).unwrap()).unwrap();
        assert_eq!(denied["result"]["permissions"], serde_json::json!({}));
    }

    #[test]
    fn mcp_tool_approval_is_explicit_and_never_persisted() {
        let params = serde_json::json!({
            "mode": "form", "_meta": {"codex_approval_kind": "mcp_tool_call", "persist": "always"},
            "requestedSchema": {"type": "object", "properties": {}},
        });
        let pending = serde_json::json!({"latticeterm_rpc_id": "browser-1", "method": "mcpServer/elicitation/request", "params": params});
        let accepted: Value =
            serde_json::from_str(&response_line(&pending, true, None).unwrap()).unwrap();
        assert_eq!(
            accepted,
            serde_json::json!({"id": "browser-1", "result": {"action": "accept", "content": {}}})
        );
        let declined: Value =
            serde_json::from_str(&response_line(&pending, false, None).unwrap()).unwrap();
        assert_eq!(
            declined["result"],
            serde_json::json!({"action": "decline", "content": null})
        );
    }

    #[test]
    fn unknown_mcp_forms_cannot_be_accepted_as_tool_approval() {
        for params in [
            serde_json::json!({"mode": "url", "url": "https://example.com"}),
            serde_json::json!({"mode": "form", "requestedSchema": {"type": "object", "properties": {}}}),
            serde_json::json!({"mode": "form", "_meta": {"codex_approval_kind": "mcp_tool_call"}, "requestedSchema": {"type": "object", "properties": {"password": {"type": "string"}}}}),
        ] {
            let pending = serde_json::json!({"latticeterm_rpc_id": 1, "method": "mcpServer/elicitation/request", "params": params});
            assert!(response_line(&pending, true, None).is_err());
            assert!(response_line(&pending, false, None).is_ok());
        }
    }

    struct RecordingSink(std::sync::mpsc::Sender<(String, ChatEvent)>);

    impl ChatSink for RecordingSink {
        fn event(&self, _thread_id: &str, turn_id: &str, event: ChatEvent) {
            let _ = self.0.send((turn_id.to_string(), event));
        }
    }

    /// Two real turns on one server: the first opens the thread and asks
    /// for approval, the second reuses the running server. `LATTICETERM_CHAT_E2E=codex
    /// cargo test a_real_codex_server -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn a_real_codex_server_serves_two_turns_and_asks_for_approval() {
        let workdir = tempfile::tempdir().expect("tempdir");
        let executable = crate::agent::catalog_executable("codex").expect("codex installed");
        let (tx, rx) = std::sync::mpsc::channel();
        let sink = Arc::new(RecordingSink(tx));
        let servers = CodexServers::default();
        let run_turn = |turn_id: &str, prompt: &str, native: Option<&str>| {
            tauri::async_runtime::block_on(send_turn(
                Arc::clone(&sink),
                &servers,
                TurnRequest {
                    browser_enabled: false,
                    thread_id: "e2e-codex",
                    turn_id,
                    prompt,
                    attachments: &[],
                    permission: ChatPermission::Ask,
                    model: None,
                    native_session_id: native,
                    working_directory: workdir.path(),
                    profile_config_directory: None,
                    executable: &executable,
                },
            ))
            .expect("turn starts");
        };
        let wait_finished = |turn_id: &str| -> (Option<String>, Option<String>, String) {
            let deadline = Instant::now() + Duration::from_secs(240);
            let mut text = String::new();
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                match rx.recv_timeout(remaining) {
                    Ok((turn, ChatEvent::ApprovalRequested { request_id, .. })) => {
                        assert_eq!(turn, turn_id);
                        tauri::async_runtime::block_on(respond(
                            &servers,
                            "e2e-codex",
                            &request_id,
                            true,
                            None,
                        ))
                        .expect("answer delivered");
                    }
                    Ok((_, ChatEvent::Text { text: t, .. })) => text.push_str(&t),
                    Ok((
                        turn,
                        ChatEvent::Finished {
                            error,
                            native_session_id,
                            ..
                        },
                    )) => {
                        assert_eq!(turn, turn_id);
                        return (error, native_session_id, text);
                    }
                    Ok(_) => {}
                    Err(_) => panic!("no Finished event within the deadline"),
                }
            }
        };

        let started = Instant::now();
        run_turn("t1", "Run the shell command `printf approved > probe.txt && cat probe.txt`, then reply with the single word DONE.", None);
        let (error, native, text) = wait_finished("t1");
        assert_eq!(error, None, "first turn failed");
        assert!(native.is_some());
        assert!(text.contains("DONE"), "reply was {text:?}");
        assert!(workdir.path().join("probe.txt").exists());
        let first = started.elapsed();

        // Follow-up on the same server: no new process, thread already open.
        let started = Instant::now();
        run_turn(
            "t2",
            "Reply with exactly the word AGAIN and nothing else.",
            native.as_deref(),
        );
        let (error, native2, text) = wait_finished("t2");
        assert_eq!(error, None, "second turn failed");
        assert_eq!(
            native2, native,
            "the follow-up must stay on the same thread"
        );
        assert!(text.contains("AGAIN"), "reply was {text:?}");
        let second = started.elapsed();
        eprintln!("first turn {first:?}, follow-up {second:?}");
        assert!(
            servers.get("e2e-codex").is_some(),
            "server must stay alive between turns"
        );
        assert!(servers.close("e2e-codex"));
    }

    #[test]
    fn account_or_native_conversation_changes_cannot_reuse_a_server() {
        let a = Some(Path::new("/profiles/a"));
        let b = Some(Path::new("/profiles/b"));
        assert!(same_server_identity(
            a,
            Some("native-a"),
            a,
            Some("native-a")
        ));
        assert!(!same_server_identity(
            a,
            Some("native-a"),
            b,
            Some("native-a")
        ));
        assert!(!same_server_identity(
            a,
            Some("native-a"),
            None,
            Some("native-a")
        ));
        assert!(!same_server_identity(
            None,
            Some("native-a"),
            a,
            Some("native-a")
        ));
        assert!(!same_server_identity(a, Some("native-a"), a, None));
        assert!(!same_server_identity(
            a,
            Some("native-a"),
            a,
            Some("native-b")
        ));
        assert!(same_server_identity(
            None,
            Some("native-a"),
            None,
            Some("native-a")
        ));
    }

    fn server_with(state: ServerState) -> CodexServer {
        // A stdin nobody reads is fine for the parser: tests never write.
        let (_, child_stdin) = fake_stdin();
        CodexServer {
            browser_enabled: false,
            thread_id: "thread-1".into(),
            profile_config_directory: None,
            child: Mutex::new(None),
            stdin: Arc::new(tokio::sync::Mutex::new(child_stdin)),
            state: Mutex::new(state),
        }
    }

    fn fake_stdin() -> (Child, tokio::process::ChildStdin) {
        let mut child = tokio::process::Command::new(if cfg!(windows) { "cmd" } else { "cat" })
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn cat");
        let stdin = child.stdin.take().expect("stdin");
        (child, stdin)
    }

    fn fresh_state(turn_id: &str) -> ServerState {
        ServerState {
            codex_thread_id: None,
            thread_ready: false,
            active: Some(ActiveTurn {
                turn_id: turn_id.into(),
                codex_turn_id: None,
                usage: None,
                error: None,
                pending: HashMap::new(),
            }),
            queued: Some(QueuedTurn {
                turn_id: turn_id.into(),
                params: turn_params("", "hi", &[], ChatPermission::Ask, None, Path::new("/w")),
            }),
            next_rpc: RPC_THREAD_OPEN + 1,
            pending_rpc: HashMap::from([(RPC_THREAD_OPEN, RpcPurpose::ThreadOpen)]),
            pending_steers: HashMap::new(),
            last_activity: Instant::now(),
            exited: false,
        }
    }

    fn feed(server: &CodexServer, line: &str) -> LineOutcome {
        handle_line(server, &serde_json::from_str(line).unwrap())
    }

    fn steer_ready_state() -> ServerState {
        let mut state = fresh_state("lattice-turn");
        state.thread_ready = true;
        state.codex_thread_id = Some("native-thread".into());
        state.active.as_mut().unwrap().codex_turn_id = Some("native-turn".into());
        state.queued = None;
        state.pending_rpc.clear();
        state
    }

    #[test]
    fn steering_rejects_stale_starting_and_finished_turns_before_writing() {
        for kind in ["stale", "starting", "finished", "exited", "unready"] {
            let mut state = steer_ready_state();
            match kind {
                "starting" => state.active.as_mut().unwrap().codex_turn_id = None,
                "finished" => state.active = None,
                "exited" => state.exited = true,
                "unready" => state.thread_ready = false,
                _ => {}
            }
            let expected = if kind == "stale" {
                "other-turn"
            } else {
                "lattice-turn"
            };
            let (tx, _) = oneshot::channel();
            let id = state.next_rpc;
            assert!(
                prepare_steer(&mut state, expected, "extra", &[], tx).is_err(),
                "{kind}"
            );
            assert_eq!(state.next_rpc, id);
            assert!(state.pending_steers.is_empty());
        }
    }

    #[tokio::test]
    async fn steering_waits_for_matching_receipt_without_overriding_turn_settings() {
        let server = server_with(steer_ready_state());
        let (tx, mut rx) = oneshot::channel();
        let attachments = [ChatAttachment {
            path: PathBuf::from("/fixture/image.png"),
            is_image: true,
        }];
        let (id, line) = prepare_steer(
            &mut server.state(),
            "lattice-turn",
            "extra",
            &attachments,
            tx,
        )
        .unwrap();
        let request: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(request["method"], "turn/steer");
        assert_eq!(
            request["params"],
            serde_json::json!({
                "threadId":"native-thread", "expectedTurnId":"native-turn",
                "input":[{"type":"text","text":"extra"},{"type":"localImage","path":attachments[0].path.display().to_string()}]
            })
        );
        assert!(matches!(
            rx.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        let (other, _) = oneshot::channel();
        assert!(
            prepare_steer(&mut server.state(), "lattice-turn", "duplicate", &[], other).is_err()
        );

        // Completion may reach the client before the steering receipt.
        let completed = feed(
            &server,
            r#"{"method":"turn/completed","params":{"turn":{"id":"native-turn","status":"completed"}}}"#,
        );
        assert_eq!(completed.events.len(), 1);
        let receipt = handle_line(
            &server,
            &serde_json::json!({"id":id,"result":{"turnId":"native-turn"}}),
        );
        assert!(receipt.events.is_empty());
        assert!(receipt.writes.is_empty());
        assert_eq!(rx.await.unwrap(), Ok(()));
        assert!(server.state().active.is_none());
        assert!(server.state().pending_steers.is_empty());
    }

    #[tokio::test]
    async fn rejected_or_malformed_steering_does_not_end_the_active_turn() {
        for response in [
            serde_json::json!({"error":{"code":-32601,"message":"unsupported"}}),
            serde_json::json!({"result":{"turnId":"different-turn"}}),
            serde_json::json!({"result":{}}),
        ] {
            let server = server_with(steer_ready_state());
            let (tx, rx) = oneshot::channel();
            let (id, _) =
                prepare_steer(&mut server.state(), "lattice-turn", "extra", &[], tx).unwrap();
            let mut response = response;
            response["id"] = Value::from(id);
            let out = handle_line(&server, &response);
            assert!(out.events.is_empty());
            assert!(rx.await.unwrap().is_err());
            assert_eq!(
                server.state().active.as_ref().unwrap().turn_id,
                "lattice-turn"
            );
            assert!(server.state().pending_steers.is_empty());
        }
    }

    #[tokio::test]
    async fn closing_a_server_releases_pending_steering_receipts() {
        let server = server_with(steer_ready_state());
        let (tx, rx) = oneshot::channel();
        prepare_steer(&mut server.state(), "lattice-turn", "extra", &[], tx).unwrap();
        server.mark_exited();
        assert!(rx.await.is_err());
        assert!(server.state().pending_steers.is_empty());
    }

    #[tokio::test]
    async fn browser_start_waits_for_tools_and_reports_startup_failures() {
        for ready in [true, false] {
            let mut server = server_with(fresh_state("turn-1"));
            server.browser_enabled = true;
            let opened = feed(
                &server,
                r#"{"id":2,"result":{"thread":{"id":"native"},"model":"test-model"}}"#,
            );
            let inventory: Value = serde_json::from_str(&opened.writes[0]).unwrap();
            assert_eq!(inventory["method"], "mcpServerStatus/list");
            assert!(opened.events.is_empty());
            assert!(server.state().queued.is_some());
            let data = if ready {
                serde_json::json!([{"name":"latticeterm_browser","tools":{"browser_navigate":{},"browser_click":{}}}])
            } else {
                serde_json::json!([])
            };
            let out = handle_line(
                &server,
                &serde_json::json!({"id":inventory["id"],"result":{"data":data}}),
            );
            if ready {
                let turn: Value = serde_json::from_str(&out.writes[0]).unwrap();
                assert_eq!(turn["method"], "turn/start");
                assert!(
                    matches!(&out.events[0].1, ChatEvent::Started { model: Some(model), .. } if model == "test-model")
                );
            } else {
                assert!(out.writes.is_empty());
                assert!(matches!(
                    &out.events[0].1,
                    ChatEvent::Finished { error: Some(_), .. }
                ));
                assert!(server.state().exited);
            }
        }
    }

    #[tokio::test]
    async fn interrupted_turns_are_not_successful_completions() {
        let server = server_with(fresh_state("turn-1"));
        let out = feed(
            &server,
            r#"{"method":"turn/completed","params":{"turn":{"status":"interrupted","error":null}}}"#,
        );
        assert!(matches!(
            &out.events[0].1,
            ChatEvent::Finished { error: Some(_), .. }
        ));
    }

    #[tokio::test]
    async fn the_first_turn_waits_for_the_thread_then_later_turns_reuse_it() {
        let server = server_with(fresh_state("turn-1"));
        let (_keep, _) = fake_stdin();

        // thread/start names the thread: Started goes out and turn/start follows.
        let out = feed(
            &server,
            r#"{"id":2,"result":{"thread":{"id":"01a0-thread"},"model":"gpt-5.6-sol"}}"#,
        );
        assert_eq!(
            out.events,
            vec![(
                "turn-1".to_string(),
                ChatEvent::Started {
                    native_session_id: Some("01a0-thread".into()),
                    model: Some("gpt-5.6-sol".into()),
                }
            )]
        );
        let start: Value = serde_json::from_str(&out.writes[0]).unwrap();
        assert_eq!(start["method"], "turn/start");
        assert_eq!(start["params"]["threadId"], "01a0-thread");
        assert_eq!(start["params"]["approvalPolicy"], "untrusted");
        assert_eq!(start["params"]["sandboxPolicy"]["type"], "workspaceWrite");
        assert!(server.state().queued.is_none());
        assert!(server.state().thread_ready);

        // The turn/start response carries Codex's turn id, used to interrupt.
        let out = feed(
            &server,
            r#"{"id":3,"result":{"turn":{"id":"codex-turn-1"}}}"#,
        );
        assert!(out.events.is_empty());
        assert_eq!(
            server
                .state()
                .active
                .as_ref()
                .unwrap()
                .codex_turn_id
                .as_deref(),
            Some("codex-turn-1")
        );

        // Items stream to the active turn.
        let out = feed(
            &server,
            r#"{"method":"item/agentMessage/delta","params":{"itemId":"m1","delta":"Hi","threadId":"t","turnId":"u"}}"#,
        );
        assert_eq!(
            out.events,
            vec![(
                "turn-1".into(),
                ChatEvent::TextDelta {
                    item_id: "m1".into(),
                    delta: "Hi".into()
                }
            )]
        );

        // An approval becomes a card tied to the turn and remembers the rpc id.
        let out = feed(
            &server,
            r#"{"method":"item/commandExecution/requestApproval","id":0,"params":{"itemId":"exec-1","command":"ls","cwd":"/w"}}"#,
        );
        assert!(matches!(
            &out.events[0],
            (turn, ChatEvent::ApprovalRequested { request_id, name, .. })
                if turn == "turn-1" && request_id == "rpc-0" && name == "command"
        ));
        assert!(server
            .state()
            .active
            .as_ref()
            .unwrap()
            .pending
            .contains_key("rpc-0"));

        // Usage then completion finish the turn but keep the server.
        feed(
            &server,
            r#"{"method":"thread/tokenUsage/updated","params":{"tokenUsage":{"last":{"inputTokens":10,"cachedInputTokens":4,"outputTokens":2,"reasoningOutputTokens":1,"cacheWriteInputTokens":0}}}}"#,
        );
        let out = feed(
            &server,
            r#"{"method":"turn/completed","params":{"turn":{"id":"codex-turn-1","status":"completed","error":null,"durationMs":900}}}"#,
        );
        assert_eq!(
            out.events,
            vec![(
                "turn-1".into(),
                ChatEvent::Finished {
                    native_session_id: Some("01a0-thread".into()),
                    usage: Some(ChatUsage {
                        input_tokens: 10,
                        output_tokens: 2,
                        cache_read_tokens: 4,
                        cache_write_tokens: 0,
                        reasoning_tokens: 1,
                    }),
                    cost_usd: None,
                    duration_ms: Some(900),
                    error: None,
                }
            )]
        );
        let state = server.state();
        assert!(state.active.is_none());
        assert!(!state.exited);
        assert_eq!(state.codex_thread_id.as_deref(), Some("01a0-thread"));
    }

    #[tokio::test]
    async fn a_failed_thread_open_ends_the_turn_and_the_server() {
        let server = server_with(fresh_state("turn-1"));
        let out = feed(
            &server,
            r#"{"id":2,"error":{"code":-1,"message":"no such thread"}}"#,
        );
        assert!(matches!(
            &out.events[0],
            (turn, ChatEvent::Finished { error: Some(error), .. })
                if turn == "turn-1" && error == "no such thread"
        ));
        assert!(server.state().exited);
        assert!(server.state().active.is_none());
    }

    #[tokio::test]
    async fn notifications_without_a_turn_are_dropped_and_requests_declined() {
        let mut state = fresh_state("turn-1");
        state.active = None;
        state.queued = None;
        let server = server_with(state);
        let out = feed(
            &server,
            r#"{"method":"item/agentMessage/delta","params":{"itemId":"m1","delta":"late"}}"#,
        );
        assert!(out.events.is_empty());
        let out = feed(
            &server,
            r#"{"method":"item/tool/requestUserInput","id":9,"params":{}}"#,
        );
        let reply: Value = serde_json::from_str(&out.writes[0]).unwrap();
        assert_eq!(reply["id"], 9);
        assert_eq!(reply["result"], serde_json::json!({"answers": {}}));
        assert!(out.events.is_empty());

        let out = feed(
            &server,
            r#"{"method":"mcpServer/elicitation/request","id":10,"params":{"mode":"form","_meta":{"codex_approval_kind":"mcp_tool_call"},"requestedSchema":{"type":"object","properties":{}}}}"#,
        );
        let reply: Value = serde_json::from_str(&out.writes[0]).unwrap();
        assert_eq!(reply["id"], 10);
        assert_eq!(
            reply["result"],
            serde_json::json!({"action": "decline", "content": null})
        );
        assert!(out.events.is_empty());

        let out = feed(
            &server,
            r#"{"method":"unknown/request","id":11,"params":{}}"#,
        );
        let reply: Value = serde_json::from_str(&out.writes[0]).unwrap();
        assert_eq!(reply["id"], 11);
        assert!(reply.get("error").is_some());
        assert!(out.events.is_empty());
        assert!(server.state().active.is_none());
    }

    #[test]
    fn permission_modes_map_to_codex_policies() {
        let (approval, sandbox) = turn_policies(ChatPermission::ReadOnly);
        assert_eq!(approval, "never");
        assert_eq!(sandbox["type"], "readOnly");
        let (approval, sandbox) = turn_policies(ChatPermission::Full);
        assert_eq!(approval, "never");
        assert_eq!(sandbox["type"], "dangerFullAccess");
        let (approval, _) = turn_policies(ChatPermission::Ask);
        assert_eq!(approval, "untrusted");

        let params = turn_params(
            "t",
            "look",
            &[ChatAttachment {
                path: std::path::PathBuf::from("/p/a.png"),
                is_image: true,
            }],
            ChatPermission::WorkspaceWrite,
            Some("gpt-5.6-terra"),
            Path::new("/w"),
        );
        assert_eq!(params["input"][1]["type"], "localImage");
        assert_eq!(params["input"][1]["path"], "/p/a.png");
        assert_eq!(params["model"], "gpt-5.6-terra");
        assert_eq!(params["cwd"], "/w");

        let lines = opening_lines(Path::new("/w"), ChatPermission::ReadOnly, None, Some("old"));
        let open: Value = serde_json::from_str(&lines[2]).unwrap();
        assert_eq!(open["method"], "thread/resume");
        assert_eq!(open["params"]["threadId"], "old");
        assert_eq!(open["params"]["sandbox"], "read-only");
    }
}
