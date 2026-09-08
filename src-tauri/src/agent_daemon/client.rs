//! The desktop's side of the daemon: attach, proxy commands, forward events.
//!
//! One connection per desktop process. Requests are correlated by id and
//! answered out of order; every event the daemon's registry publishes is
//! re-emitted on the same Tauri channels the desktop's own sessions use, so
//! the interface never learns which process owns a session. Losing the
//! connection closes every session the daemon had, from the window's point
//! of view: the CLIs are gone with the daemon, or unreachable, which is the
//! same thing to a terminal pane.

use super::{
    event_channel, read_or_create_token, transport, DaemonPaths, Frame, HelloReply, Request,
    MAX_FRAME_BYTES, PROTOCOL_VERSION,
};
use crate::agent::{AgentOutputSnapshot, AgentSessionSummary, EVENT_CLOSED};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const ATTACH_TIMEOUT: Duration = Duration::from_secs(5);
const START_TIMEOUT: Duration = Duration::from_secs(8);
const DAEMON_GONE: &str = "The background service is no longer running.";

pub struct DaemonClient {
    app: AppHandle,
    paths: DaemonPaths,
    connection: tokio::sync::Mutex<Option<Arc<Connection>>>,
}

pub struct Connection {
    tx: mpsc::UnboundedSender<String>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    next_id: AtomicU64,
    alive: AtomicBool,
    /// Sessions the daemon told us about, so a lost connection can close
    /// them in the interface.
    sessions: Mutex<HashSet<String>>,
}

impl DaemonClient {
    pub fn new(app: AppHandle, data_dir: &Path) -> Self {
        Self {
            app,
            paths: DaemonPaths::new(data_dir),
            connection: tokio::sync::Mutex::new(None),
        }
    }

    pub fn paths(&self) -> &DaemonPaths {
        &self.paths
    }

    /// Attaches to a daemon that is already running; never starts one.
    pub async fn attached(&self) -> Option<Arc<Connection>> {
        let mut guard = self.connection.lock().await;
        if let Some(connection) = guard.as_ref() {
            if connection.alive.load(Ordering::Relaxed) {
                return Some(Arc::clone(connection));
            }
        }
        *guard = None;
        if !self.daemon_present() {
            return None;
        }
        match tokio::time::timeout(ATTACH_TIMEOUT, self.open()).await {
            Ok(Ok(connection)) => {
                *guard = Some(Arc::clone(&connection));
                Some(connection)
            }
            _ => None,
        }
    }

    /// Attaches, starting the daemon first when none is listening.
    pub async fn ensure(&self) -> Result<Arc<Connection>, String> {
        if let Some(connection) = self.attached().await {
            return Ok(connection);
        }
        let mut guard = self.connection.lock().await;
        spawn_daemon(&self.paths)?;
        let deadline = tokio::time::Instant::now() + START_TIMEOUT;
        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if let Ok(Ok(connection)) = tokio::time::timeout(ATTACH_TIMEOUT, self.open()).await {
                *guard = Some(Arc::clone(&connection));
                return Ok(connection);
            }
            if tokio::time::Instant::now() >= deadline {
                return Err("The background service did not start in time.".to_string());
            }
        }
    }

    fn daemon_present(&self) -> bool {
        #[cfg(unix)]
        {
            DaemonPaths::for_client(&self.paths.data_dir)
                .socket
                .exists()
        }
        #[cfg(not(unix))]
        {
            true
        }
    }

    async fn open(&self) -> Result<Arc<Connection>, String> {
        let token = read_or_create_token(&self.paths)?;
        let stream = transport::connect(&DaemonPaths::for_client(&self.paths.data_dir))
            .await
            .map_err(|error| format!("Cannot reach the background service: {error}"))?;
        let (read_half, mut write_half) = tokio::io::split(stream);
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        let connection = Arc::new(Connection {
            tx,
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(0),
            alive: AtomicBool::new(true),
            sessions: Mutex::new(HashSet::new()),
        });
        tauri::async_runtime::spawn(async move {
            while let Some(line) = rx.recv().await {
                if write_half.write_all(line.as_bytes()).await.is_err()
                    || write_half.write_all(b"\n").await.is_err()
                {
                    break;
                }
            }
        });
        let reader_connection = Arc::clone(&connection);
        let app = self.app.clone();
        tauri::async_runtime::spawn(async move {
            reader_loop(BufReader::new(read_half), reader_connection, app).await;
        });

        let reply = connection
            .request(Request::Hello {
                token,
                protocol: PROTOCOL_VERSION,
                role: super::ClientRole::Desktop,
                client: None,
            })
            .await?;
        let reply: HelloReply = serde_json::from_value(reply)
            .map_err(|error| format!("The background service greeted oddly: {error}"))?;
        if reply.protocol != PROTOCOL_VERSION {
            connection.alive.store(false, Ordering::Relaxed);
            return Err(format!(
                "The background service speaks protocol {} but this LatticeTerm expects {}. Stop it and start again.",
                reply.protocol, PROTOCOL_VERSION
            ));
        }
        if let Ok(mut sessions) = connection.sessions.lock() {
            sessions.extend(reply.sessions.into_iter().map(|summary| summary.session_id));
        }
        Ok(connection)
    }

    /// Sends a request, starting the daemon when `start` says a missing one
    /// is fine to create (a launch) rather than an error (everything else).
    pub async fn request(&self, start: bool, request: Request) -> Result<Value, String> {
        let connection = if start {
            self.ensure().await?
        } else {
            self.attached()
                .await
                .ok_or_else(|| DAEMON_GONE.to_string())?
        };
        connection.request(request).await
    }

    /// The daemon's sessions, or none when it is not running.
    pub async fn sessions(&self) -> Vec<AgentSessionSummary> {
        match self.request(false, Request::Sessions).await {
            Ok(value) => serde_json::from_value(value).unwrap_or_default(),
            Err(_) => Vec::new(),
        }
    }

    pub async fn snapshots(&self) -> Vec<AgentOutputSnapshot> {
        match self.request(false, Request::Snapshots).await {
            Ok(value) => serde_json::from_value(value).unwrap_or_default(),
            Err(_) => Vec::new(),
        }
    }

    /// One session's summary as the daemon sees it right now.
    pub async fn session_summary(&self, session_id: &str) -> Option<AgentSessionSummary> {
        self.sessions()
            .await
            .into_iter()
            .find(|summary| summary.session_id == session_id)
    }

    pub async fn is_running(&self) -> bool {
        self.attached().await.is_some()
    }
}

impl Connection {
    pub async fn request(&self, request: Request) -> Result<Value, String> {
        if !self.alive.load(Ordering::Relaxed) {
            return Err(DAEMON_GONE.to_string());
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|error| error.to_string())?
            .insert(id, tx);
        let line = serde_json::to_string(&Frame::Request { id, body: request })
            .map_err(|error| error.to_string())?;
        if self.tx.send(line).is_err() {
            self.forget(id);
            return Err(DAEMON_GONE.to_string());
        }
        match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(DAEMON_GONE.to_string()),
            Err(_) => {
                self.forget(id);
                Err("The background service did not answer in time.".to_string())
            }
        }
    }

    fn forget(&self, id: u64) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&id);
        }
    }

    fn resolve(&self, id: u64, result: Result<Value, String>) {
        let sender = self
            .pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(&id));
        if let Some(sender) = sender {
            let _ = sender.send(result);
        }
    }

    fn note_session(&self, payload: &Value, closed: bool) {
        let Some(session_id) = payload.get("sessionId").and_then(Value::as_str) else {
            return;
        };
        if let Ok(mut sessions) = self.sessions.lock() {
            if closed {
                sessions.remove(session_id);
            } else {
                sessions.insert(session_id.to_string());
            }
        }
    }

    /// The daemon went away: fail what is waiting and close its sessions in
    /// the interface.
    fn lost(&self, app: &AppHandle) {
        self.alive.store(false, Ordering::Relaxed);
        if let Ok(mut pending) = self.pending.lock() {
            for (_, sender) in pending.drain() {
                let _ = sender.send(Err(DAEMON_GONE.to_string()));
            }
        }
        let sessions: Vec<String> = self
            .sessions
            .lock()
            .map(|mut sessions| sessions.drain().collect())
            .unwrap_or_default();
        for session_id in sessions {
            let _ = app.emit(
                EVENT_CLOSED,
                json!({ "sessionId": session_id, "reason": DAEMON_GONE }),
            );
        }
    }
}

async fn reader_loop<R: AsyncBufReadExt + Unpin>(
    mut reader: R,
    connection: Arc<Connection>,
    app: AppHandle,
) {
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) if line.len() > MAX_FRAME_BYTES => break,
            Ok(_) => {}
        }
        let Ok(frame) = serde_json::from_slice::<Frame>(&line) else {
            continue;
        };
        match frame {
            Frame::Response {
                id,
                ok,
                result,
                error,
            } => connection.resolve(
                id,
                if ok {
                    Ok(result)
                } else {
                    Err(error.unwrap_or_else(|| "The background service failed.".to_string()))
                },
            ),
            Frame::Event { name, payload } => {
                connection.note_session(&payload, name == "closed");
                if let Some(channel) = event_channel(&name) {
                    let _ = app.emit(channel, payload);
                }
            }
            Frame::Request { .. } => {}
        }
    }
    connection.lost(&app);
}

/// Starts `lattice-term agent-daemon` detached from this process: its own
/// session on Unix, no console and no job on Windows. Nothing is inherited
/// but the environment; the log file catches what it has to say.
fn spawn_daemon(paths: &DaemonPaths) -> Result<(), String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("Cannot locate the LatticeTerm executable: {error}"))?;
    std::fs::create_dir_all(&paths.data_dir)
        .map_err(|error| format!("Cannot create the application data directory: {error}"))?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(paths.data_dir.join(super::LOG_FILE))
        .ok();
    let mut command = std::process::Command::new(executable);
    command
        .arg("agent-daemon")
        .arg("--data-dir")
        .arg(&paths.data_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null());
    match log {
        Some(log) => {
            command.stderr(log);
        }
        None => {
            command.stderr(std::process::Stdio::null());
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid only changes the child's session id before exec.
        unsafe {
            command.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("Cannot start the background service: {error}"))?;
    // Reap it whenever it ends so a finished daemon never lingers as a zombie
    // of this window; the wait holds nothing else.
    std::thread::Builder::new()
        .name("latticeterm-agent-daemon-reaper".to_string())
        .spawn(move || {
            let _ = child.wait();
        })
        .map_err(|error| format!("Cannot watch the background service: {error}"))?;
    Ok(())
}
