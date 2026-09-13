//! SSH tunnels: local, remote, and dynamic (SOCKS5) port forwarding.
//!
//! Each tunnel owns one authenticated russh session — pure Rust, no external
//! `ssh` binary — and every byte that crosses it really travels through that
//! session. Trust is resolved the same way terminal sessions resolve it: a
//! host whose key is unknown or changed is refused, and the user is pointed at
//! the normal connect flow to settle the fingerprint first.
//!
//! Errors returned to the interface carry a stable `code: detail` prefix
//! (`credential:`, `trust:`, `auth:`, `bind:`, `connect:`, `forward:`) so the
//! frontend can translate the cause without parsing prose.

use crate::hostkeys::{HostKeyRecord, TrustVerdict};
use crate::ssh::TrustingHandler;
use russh::client;
use russh::{Channel, ChannelMsg, ChannelOpenFailure, Disconnect};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::future::Future;
use std::net::IpAddr;
use std::net::Shutdown;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{
    watch, OwnedSemaphorePermit, RwLock, RwLockReadGuard, RwLockWriteGuard, Semaphore,
};

const MAX_TUNNEL_ID_BYTES: usize = 128;
const MAX_HOST_BYTES: usize = 253;
const MAX_ACTIVE_TUNNELS: usize = 16;
const MAX_GLOBAL_TUNNEL_CONNECTIONS: usize = 128;
const MAX_CONNECTIONS_PER_TUNNEL: usize = 32;
const SSH_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const SSH_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
const SSH_AUTH_TIMEOUT: Duration = Duration::from_secs(15);
const LOCAL_BIND_TIMEOUT: Duration = Duration::from_secs(5);
const REMOTE_FORWARD_SETUP_TIMEOUT: Duration = Duration::from_secs(10);
const REMOTE_FORWARD_RETRY_DELAY: Duration = Duration::from_millis(50);
const REMOTE_FORWARD_RETRY_LIMIT: usize = 20;
const CHANNEL_OPEN_TIMEOUT: Duration = Duration::from_secs(10);
const SOCKS_NEGOTIATION_TIMEOUT: Duration = Duration::from_secs(10);
const LOCAL_TARGET_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const SSH_CONTROL_TIMEOUT: Duration = Duration::from_secs(2);
const REMOTE_FORWARD_CANCEL_TIMEOUT: Duration = Duration::from_secs(2);
const STOP_WAIT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TunnelType {
    Local,
    Remote,
    Dynamic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TunnelStatus {
    Stopped,
    Starting,
    Active,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TunnelStatusSummary {
    pub tunnel_id: String,
    pub status: TunnelStatus,
    pub bytes_uploaded: u64,
    pub bytes_downloaded: u64,
    pub active_connections: u32,
    pub started_at: Option<u64>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StartTunnelRequest {
    pub tunnel_id: String,
    pub tunnel_type: TunnelType,
    /// The connection profile whose saved password authenticates the session.
    pub profile_id: String,
    pub local_host: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    #[serde(default)]
    pub ssh_hostname: String,
    #[serde(default)]
    pub ssh_port: u16,
    #[serde(default)]
    pub ssh_username: String,
}

struct ActiveTunnel {
    tunnel_id: String,
    status: TunnelStatus,
    /// Distinguishes this run from an earlier run of the same tunnel id, so a
    /// task left over from before a restart cannot clobber the new state.
    generation: u64,
    bytes_uploaded: Arc<AtomicU64>,
    bytes_downloaded: Arc<AtomicU64>,
    active_connections: Arc<AtomicU32>,
    started_at: Option<u64>,
    /// Shared with the run's tasks so a per-connection failure — a target the
    /// host cannot reach, a refused forward — becomes visible in the status.
    last_error: Arc<Mutex<Option<String>>>,
    stop_tx: Option<watch::Sender<bool>>,
    /// Becomes true only after the worker has released its listener and SSH
    /// session, so a successful Stop command is a safe restart boundary.
    completion_tx: watch::Sender<bool>,
}

pub struct TunnelRegistry {
    tunnels: Mutex<HashMap<String, ActiveTunnel>>,
    generations: AtomicU64,
    shutting_down: AtomicBool,
    /// Backup restore takes the writer side before its definitive idle check;
    /// every new reservation briefly takes the reader side. This closes the
    /// check/start race without holding the gate for a tunnel's lifetime.
    restore_barrier: RwLock<()>,
    tunnel_admission: Arc<Semaphore>,
    connection_admission: Arc<Semaphore>,
}

impl Default for TunnelRegistry {
    fn default() -> Self {
        Self {
            tunnels: Mutex::new(HashMap::new()),
            generations: AtomicU64::new(0),
            shutting_down: AtomicBool::new(false),
            restore_barrier: RwLock::new(()),
            tunnel_admission: Arc::new(Semaphore::new(MAX_ACTIVE_TUNNELS)),
            connection_admission: Arc::new(Semaphore::new(MAX_GLOBAL_TUNNEL_CONNECTIONS)),
        }
    }
}

/// Holds one tunnel slot until the complete SSH transport has been reaped.
/// The handler owns a clone while russh owns its background task, which makes
/// cancelling a start future unable to release admission ahead of that task.
struct TunnelAdmission {
    permit: Mutex<Option<OwnedSemaphorePermit>>,
}

impl TunnelAdmission {
    fn new(permit: OwnedSemaphorePermit) -> Self {
        Self {
            permit: Mutex::new(Some(permit)),
        }
    }

    fn release(&self) {
        let mut permit = self
            .permit
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        drop(permit.take());
    }
}

/// Atomically claims a tunnel id before any bind, SSH connection, or remote
/// forward is attempted. Dropping an unfinished reservation restores the
/// previous stopped/error summary instead of leaving a phantom Starting row.
pub(crate) struct TunnelStartReservation {
    registry: Arc<TunnelRegistry>,
    tunnel_id: String,
    generation: u64,
    previous: Option<ActiveTunnel>,
    stop_tx: watch::Sender<bool>,
    stop_rx: Option<watch::Receiver<bool>>,
    admission: Option<OwnedSemaphorePermit>,
    committed: bool,
}

impl TunnelStartReservation {
    fn generation(&self) -> u64 {
        self.generation
    }

    fn stop_sender(&self) -> watch::Sender<bool> {
        self.stop_tx.clone()
    }

    fn stop_receiver(&mut self) -> &mut watch::Receiver<bool> {
        self.stop_rx
            .as_mut()
            .expect("a start reservation owns its stop receiver until commit")
    }

    pub(crate) async fn wait_until_stopped(&mut self) {
        wait_for_stop(self.stop_receiver()).await;
    }

    /// Transfers admission into a blocking credential job. If its caller is
    /// cancelled, Tokio detaches that job, whose captured permit continues to
    /// bound the work until the keyring call actually returns.
    pub(crate) fn take_admission_for_credential(&mut self) -> Result<OwnedSemaphorePermit, String> {
        self.admission
            .take()
            .ok_or_else(|| "credential:tunnel admission was already transferred".to_string())
    }

    pub(crate) fn restore_admission_after_credential(
        &mut self,
        admission: OwnedSemaphorePermit,
    ) -> Result<(), String> {
        if self.admission.is_some() {
            return Err("credential:tunnel admission was restored twice".to_string());
        }
        self.admission = Some(admission);
        Ok(())
    }

    fn take_admission_for_session(&mut self) -> Result<Arc<TunnelAdmission>, String> {
        let admission = self.admission.take().ok_or_else(|| {
            "connect:tunnel admission was not available for SSH setup".to_string()
        })?;
        Ok(Arc::new(TunnelAdmission::new(admission)))
    }

    fn commit(&mut self, mut tunnel: ActiveTunnel) -> Result<watch::Receiver<bool>, String> {
        if tunnel.tunnel_id != self.tunnel_id || tunnel.generation != self.generation {
            return Err("connect:tunnel start reservation does not match the run".to_string());
        }
        if self.admission.is_some() {
            return Err(
                "connect:tunnel admission was not transferred to the SSH session".to_string(),
            );
        }
        tunnel.stop_tx = Some(self.stop_tx.clone());
        self.registry
            .commit_start(&self.tunnel_id, self.generation, tunnel)?;
        self.previous.take();
        self.committed = true;
        Ok(self
            .stop_rx
            .take()
            .expect("a committed tunnel keeps the reservation stop receiver"))
    }
}

impl Drop for TunnelStartReservation {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        // Cancellation may come from Stop or from the caller dropping its
        // start future. Make it sticky for any early remote-connection tasks,
        // and release admission before publishing the completion fence.
        self.stop_tx.send_replace(true);
        drop(self.admission.take());
        self.registry
            .cancel_start(&self.tunnel_id, self.generation, self.previous.take());
    }
}

impl TunnelRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Prevents new tunnel reservations until a backup restore has either
    /// committed or left all application stores unchanged.
    pub(crate) async fn lock_backup_restore(&self) -> RwLockWriteGuard<'_, ()> {
        self.restore_barrier.write().await
    }

    /// Start commands take this before reading profiles or host trust and keep
    /// it until their Starting row has been reserved.
    pub(crate) async fn lock_tunnel_start(&self) -> RwLockReadGuard<'_, ()> {
        self.restore_barrier.read().await
    }

    #[cfg(test)]
    fn with_limits(max_tunnels: usize, max_connections: usize) -> Self {
        Self {
            tunnels: Mutex::new(HashMap::new()),
            generations: AtomicU64::new(0),
            shutting_down: AtomicBool::new(false),
            restore_barrier: RwLock::new(()),
            tunnel_admission: Arc::new(Semaphore::new(max_tunnels)),
            connection_admission: Arc::new(Semaphore::new(max_connections)),
        }
    }

    fn summarize(tunnel: &ActiveTunnel) -> TunnelStatusSummary {
        TunnelStatusSummary {
            tunnel_id: tunnel.tunnel_id.clone(),
            status: tunnel.status,
            bytes_uploaded: tunnel.bytes_uploaded.load(Ordering::Relaxed),
            bytes_downloaded: tunnel.bytes_downloaded.load(Ordering::Relaxed),
            active_connections: tunnel.active_connections.load(Ordering::Relaxed),
            started_at: tunnel.started_at,
            last_error: tunnel.last_error.lock().ok().and_then(|slot| slot.clone()),
        }
    }

    pub fn status(&self, tunnel_id: &str) -> Option<TunnelStatusSummary> {
        let guard = self.tunnels.lock().ok()?;
        guard.get(tunnel_id).map(Self::summarize)
    }

    pub fn list(&self) -> Vec<TunnelStatusSummary> {
        let guard = match self.tunnels.lock() {
            Ok(g) => g,
            Err(_) => return Vec::new(),
        };
        guard.values().map(Self::summarize).collect()
    }

    fn owns_worker(tunnel: &ActiveTunnel) -> bool {
        tunnel.status == TunnelStatus::Starting || tunnel.stop_tx.is_some()
    }

    fn reserve_start(self: &Arc<Self>, tunnel_id: &str) -> Result<TunnelStartReservation, String> {
        let mut guard = self.tunnels.lock().map_err(|e| e.to_string())?;
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("connect:tunnel registry is shutting down".to_string());
        }
        if guard.get(tunnel_id).is_some_and(Self::owns_worker) {
            return Err(format!("connect:tunnel '{tunnel_id}' is already running"));
        }

        let admission = Arc::clone(&self.tunnel_admission)
            .try_acquire_owned()
            .map_err(|_| format!("connect:at most {MAX_ACTIVE_TUNNELS} tunnels may run at once"))?;

        let generation = self.generations.fetch_add(1, Ordering::Relaxed) + 1;
        let previous = guard.remove(tunnel_id);
        let (completion_tx, _) = watch::channel(false);
        let (stop_tx, stop_rx) = watch::channel(false);
        guard.insert(
            tunnel_id.to_string(),
            ActiveTunnel {
                tunnel_id: tunnel_id.to_string(),
                status: TunnelStatus::Starting,
                generation,
                bytes_uploaded: Arc::new(AtomicU64::new(0)),
                bytes_downloaded: Arc::new(AtomicU64::new(0)),
                active_connections: Arc::new(AtomicU32::new(0)),
                started_at: None,
                last_error: Arc::new(Mutex::new(None)),
                stop_tx: Some(stop_tx.clone()),
                completion_tx,
            },
        );

        Ok(TunnelStartReservation {
            registry: Arc::clone(self),
            tunnel_id: tunnel_id.to_string(),
            generation,
            previous,
            stop_tx,
            stop_rx: Some(stop_rx),
            admission: Some(admission),
            committed: false,
        })
    }

    fn commit_start(
        &self,
        tunnel_id: &str,
        generation: u64,
        tunnel: ActiveTunnel,
    ) -> Result<(), String> {
        let mut guard = self.tunnels.lock().map_err(|e| e.to_string())?;
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("connect:tunnel registry is shutting down".to_string());
        }
        let owns_reservation = guard.get(tunnel_id).is_some_and(|current| {
            current.generation == generation
                && current.status == TunnelStatus::Starting
                && current.stop_tx.as_ref().is_some_and(|stop| !*stop.borrow())
        });
        if !owns_reservation {
            return Err(format!(
                "connect:tunnel '{tunnel_id}' start reservation was lost"
            ));
        }
        guard.insert(tunnel_id.to_string(), tunnel);
        Ok(())
    }

    fn cancel_start(&self, tunnel_id: &str, generation: u64, previous: Option<ActiveTunnel>) {
        if let Ok(mut guard) = self.tunnels.lock() {
            let owns_reservation = guard.get(tunnel_id).is_some_and(|current| {
                current.generation == generation && current.status == TunnelStatus::Starting
            });
            if !owns_reservation {
                return;
            }
            let Some(current) = guard.remove(tunnel_id) else {
                return;
            };
            current.completion_tx.send_replace(true);
            if let Some(previous) = previous {
                guard.insert(tunnel_id.to_string(), previous);
            }
        }
    }

    pub async fn stop(&self, tunnel_id: &str) -> Result<(), String> {
        let mut completion = {
            let mut guard = self.tunnels.lock().map_err(|e| e.to_string())?;
            let Some(tunnel) = guard.get_mut(tunnel_id) else {
                return Err(format!("Tunnel '{tunnel_id}' was not found."));
            };
            let Some(stop_tx) = tunnel.stop_tx.as_ref() else {
                return Ok(());
            };

            let completion = tunnel.completion_tx.subscribe();
            stop_tx.send_replace(true);
            // Keep stop_tx as the ownership marker until the worker has
            // actually released its listener and SSH session.
            completion
        };

        let already_finished = *completion.borrow();
        if !already_finished {
            tokio::time::timeout(STOP_WAIT_TIMEOUT, completion.changed())
                .await
                .map_err(|_| {
                    format!(
                        "connect:tunnel '{tunnel_id}' did not stop within {} seconds",
                        STOP_WAIT_TIMEOUT.as_secs()
                    )
                })?
                .map_err(|_| format!("connect:tunnel '{tunnel_id}' cleanup signal closed"))?;
        }
        Ok(())
    }

    pub fn stop_all(&self) {
        // Exit cleanup permanently seals this registry. A start which already
        // owns a placeholder may finish its network work, but commit_start
        // will reject it and its reservation will restore the prior summary.
        self.shutting_down.store(true, Ordering::Release);
        if let Ok(mut guard) = self.tunnels.lock() {
            for tunnel in guard.values_mut() {
                if let Some(stop_tx) = tunnel.stop_tx.as_ref() {
                    stop_tx.send_replace(true);
                }
            }
        }
    }

    /// Direct registration is kept for focused registry tests. Production
    /// starts must reserve first so no side effect happens before ownership.
    #[cfg(test)]
    fn register(&self, tunnel: ActiveTunnel) -> Result<u64, String> {
        let generation = tunnel.generation;
        let mut guard = self.tunnels.lock().map_err(|e| e.to_string())?;
        if guard.get(&tunnel.tunnel_id).is_some_and(Self::owns_worker) {
            return Err(format!(
                "connect:tunnel '{}' is already running",
                tunnel.tunnel_id
            ));
        }
        guard.insert(tunnel.tunnel_id.clone(), tunnel);
        Ok(generation)
    }

    /// Marks the end of a run — but only if the entry still belongs to that
    /// run. A tunnel that was restarted in the meantime is left alone.
    fn finish(
        &self,
        tunnel_id: &str,
        generation: u64,
        status: TunnelStatus,
        error: Option<String>,
    ) {
        if let Ok(mut guard) = self.tunnels.lock() {
            if let Some(tunnel) = guard.get_mut(tunnel_id) {
                if tunnel.generation == generation {
                    // The sender is also the registry's running marker. A
                    // worker that ends by itself must clear it; an explicit
                    // Stop also waits for this same cleanup boundary before
                    // allowing a later start.
                    tunnel.stop_tx.take();
                    tunnel.status = status;
                    if error.is_some() {
                        if let Ok(mut slot) = tunnel.last_error.lock() {
                            *slot = error;
                        }
                    }
                    tunnel.completion_tx.send_replace(true);
                }
            }
        }
    }

    #[cfg(test)]
    fn is_running(&self, tunnel_id: &str) -> bool {
        self.tunnels
            .lock()
            .ok()
            .and_then(|guard| guard.get(tunnel_id).map(Self::owns_worker))
            .unwrap_or(false)
    }
}

fn now_epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Counters and the error slot shared between a tunnel's registry entry and
/// its worker tasks.
#[derive(Clone)]
struct Counters {
    up: Arc<AtomicU64>,
    down: Arc<AtomicU64>,
    connections: Arc<AtomicU32>,
    last_error: Arc<Mutex<Option<String>>>,
    fatal: Arc<AtomicBool>,
    /// The tunnel handler sets this only after russh has shut down the
    /// transport writer (or when the handler is dropped on an error path).
    session_cleanup_tx: watch::Sender<bool>,
    connection_slots: Arc<Semaphore>,
    connection_limit: u32,
    global_connection_slots: Arc<Semaphore>,
    stop_tx: watch::Sender<bool>,
}

impl Counters {
    fn new(global_connection_slots: Arc<Semaphore>, stop_tx: watch::Sender<bool>) -> Self {
        Self::with_connection_limit(global_connection_slots, stop_tx, MAX_CONNECTIONS_PER_TUNNEL)
    }

    fn with_connection_limit(
        global_connection_slots: Arc<Semaphore>,
        stop_tx: watch::Sender<bool>,
        max_connections: usize,
    ) -> Self {
        let (session_cleanup_tx, _) = watch::channel(false);
        Self {
            up: Arc::new(AtomicU64::new(0)),
            down: Arc::new(AtomicU64::new(0)),
            connections: Arc::new(AtomicU32::new(0)),
            last_error: Arc::new(Mutex::new(None)),
            fatal: Arc::new(AtomicBool::new(false)),
            session_cleanup_tx,
            connection_slots: Arc::new(Semaphore::new(max_connections)),
            connection_limit: u32::try_from(max_connections)
                .expect("the configured tunnel connection limit fits in u32"),
            global_connection_slots,
            stop_tx,
        }
    }

    fn try_open_connection(&self) -> Result<ConnectionLease, ConnectionAdmissionError> {
        if *self.stop_tx.borrow() {
            return Err(ConnectionAdmissionError::Stopping);
        }
        let tunnel = Arc::clone(&self.connection_slots)
            .try_acquire_owned()
            .map_err(|_| ConnectionAdmissionError::TunnelLimit)?;
        let global = Arc::clone(&self.global_connection_slots)
            .try_acquire_owned()
            .map_err(|_| ConnectionAdmissionError::GlobalLimit)?;
        // Stop and admission can race. Recheck after both permits so the drain
        // barrier never misses a connection admitted concurrently with Stop.
        if *self.stop_tx.borrow() {
            return Err(ConnectionAdmissionError::Stopping);
        }
        Ok(ConnectionLease {
            stop_rx: self.stop_tx.subscribe(),
            guard: Some(ConnectionGuard::open(&self.connections)),
            global: Some(global),
            // This permit is the drain barrier and must be released last.
            tunnel: Some(tunnel),
        })
    }

    fn seal_connections(&self) {
        self.stop_tx.send_replace(true);
    }

    async fn wait_for_connections(&self) {
        // Every connection owns exactly one local permit. Taking the complete
        // set is therefore a deterministic drain barrier after cancellation.
        if let Ok(permits) = Arc::clone(&self.connection_slots)
            .acquire_many_owned(self.connection_limit)
            .await
        {
            drop(permits);
        }
    }

    fn record_error(&self, message: String) {
        if let Ok(mut slot) = self.last_error.lock() {
            *slot = Some(message);
        }
    }

    fn fail_tunnel(&self, message: String) {
        self.record_error(message);
        self.fatal.store(true, Ordering::Release);
        self.stop_tx.send_replace(true);
    }

    fn fatal_error(&self) -> Option<String> {
        if !self.fatal.load(Ordering::Acquire) {
            return None;
        }
        self.last_error.lock().ok().and_then(|slot| slot.clone())
    }

    fn mark_session_cleaned_up(&self) {
        self.session_cleanup_tx.send_replace(true);
    }

    async fn wait_for_session_cleanup(&self) {
        let mut cleanup = self.session_cleanup_tx.subscribe();
        while !*cleanup.borrow_and_update() {
            if cleanup.changed().await.is_err() {
                break;
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConnectionAdmissionError {
    Stopping,
    TunnelLimit,
    GlobalLimit,
}

impl ConnectionAdmissionError {
    fn message(self) -> String {
        match self {
            Self::Stopping => "connect:the tunnel is stopping".to_string(),
            Self::TunnelLimit => format!(
                "connect:the tunnel connection limit of {MAX_CONNECTIONS_PER_TUNNEL} was reached"
            ),
            Self::GlobalLimit => format!(
                "connect:the global tunnel connection limit of {MAX_GLOBAL_TUNNEL_CONNECTIONS} was reached"
            ),
        }
    }

    fn channel_failure(self) -> ChannelOpenFailure {
        match self {
            Self::Stopping => ChannelOpenFailure::AdministrativelyProhibited,
            Self::TunnelLimit | Self::GlobalLimit => ChannelOpenFailure::ResourceShortage,
        }
    }
}

struct ConnectionLease {
    stop_rx: watch::Receiver<bool>,
    guard: Option<ConnectionGuard>,
    global: Option<OwnedSemaphorePermit>,
    tunnel: Option<OwnedSemaphorePermit>,
}

impl ConnectionLease {
    async fn run<F>(mut self, operation: F)
    where
        F: Future<Output = ()>,
    {
        tokio::select! {
            biased;
            _ = wait_for_stop(&mut self.stop_rx) => {}
            _ = operation => {}
        }
    }
}

impl Drop for ConnectionLease {
    fn drop(&mut self) {
        // `wait_for_connections` waits on the per-tunnel permit. Release the
        // observable counter and global capacity first, then release that
        // barrier permit last so a completed drain is a complete cleanup fence.
        drop(self.guard.take());
        drop(self.global.take());
        drop(self.tunnel.take());
    }
}

async fn wait_for_stop(stop_rx: &mut watch::Receiver<bool>) {
    while !*stop_rx.borrow_and_update() {
        if stop_rx.changed().await.is_err() {
            break;
        }
    }
}

/// Decrements the live-connection count however the connection ends.
struct ConnectionGuard(Arc<AtomicU32>);

impl ConnectionGuard {
    fn open(counter: &Arc<AtomicU32>) -> Self {
        counter.fetch_add(1, Ordering::AcqRel);
        Self(Arc::clone(counter))
    }
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        let previous = self.0.fetch_sub(1, Ordering::AcqRel);
        debug_assert!(previous > 0, "connection count underflowed");
    }
}

/// Copies until EOF or error, adding every byte to `counted`.
async fn copy_counted<R, W>(reader: &mut R, writer: &mut W, counted: &AtomicU64)
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut buffer = [0u8; 16384];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if writer.write_all(&buffer[..n]).await.is_err() {
                    break;
                }
                counted.fetch_add(n as u64, Ordering::Relaxed);
            }
        }
    }
}

async fn copy_channel_counted<W>(
    channel: &mut Channel<client::Msg>,
    writer: &mut W,
    counted: &AtomicU64,
) -> bool
where
    W: AsyncWrite + Unpin,
{
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Data { data }) => {
                if writer.write_all(&data).await.is_err() {
                    return false;
                }
                counted.fetch_add(data.len() as u64, Ordering::Relaxed);
            }
            Some(ChannelMsg::Close) | None => return true,
            Some(ChannelMsg::Eof) => return false,
            Some(_) => {}
        }
    }
}

async fn close_channel_or_fail(
    channel: &mut Channel<client::Msg>,
    counters: &Counters,
    context: &str,
) {
    let closed = tokio::time::timeout(SSH_CONTROL_TIMEOUT, async {
        channel.close().await.map_err(|error| error.to_string())?;
        while let Some(message) = channel.wait().await {
            if matches!(message, ChannelMsg::Close) {
                return Ok::<(), String>(());
            }
        }
        // A closed receiver means the transport itself has gone away, so its
        // channel maps can no longer survive this connection.
        Ok(())
    })
    .await;
    if !matches!(closed, Ok(Ok(()))) {
        counters.fail_tunnel(format!(
            "connect:the SSH host did not close {context} within {} seconds",
            SSH_CONTROL_TIMEOUT.as_secs()
        ));
    }
}

/// Moves bytes both ways between a TCP socket and an SSH channel until both
/// directions have closed. Socket-to-channel counts as upload. A completed
/// connection explicitly closes and acknowledges the SSH channel so the
/// session's internal maps cannot outlive the connection admission lease.
async fn pump(socket: TcpStream, mut channel: Channel<client::Msg>, counters: Counters) {
    let mut channel_write = channel.make_writer();
    let (mut socket_read, mut socket_write) = socket.into_split();

    let upload = async {
        copy_counted(&mut socket_read, &mut channel_write, &counters.up).await;
        let _ = channel_write.shutdown().await;
    };
    let download = async {
        let remote_closed =
            copy_channel_counted(&mut channel, &mut socket_write, &counters.down).await;
        let _ = socket_write.shutdown().await;
        remote_closed
    };

    let (_, remote_closed) = tokio::join!(upload, download);
    if !remote_closed {
        close_channel_or_fail(&mut channel, &counters, "a forwarded channel").await;
    }
}

/// SOCKS5 reply codes, straight from RFC 1928.
const SOCKS_OK: u8 = 0x00;
const SOCKS_GENERAL_FAILURE: u8 = 0x01;
const SOCKS_CONNECTION_REFUSED: u8 = 0x05;
const SOCKS_COMMAND_NOT_SUPPORTED: u8 = 0x07;
const SOCKS_ADDRESS_NOT_SUPPORTED: u8 = 0x08;

async fn socks_reply<S>(socket: &mut S, code: u8) -> bool
where
    S: AsyncWrite + Unpin,
{
    // The bind address in a reply is informational; all-zero IPv4 is standard
    // practice for a proxy that does not expose one.
    socket
        .write_all(&[0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
        .await
        .is_ok()
}

/// Runs the SOCKS5 greeting and CONNECT negotiation, returning the target the
/// client asked for. On protocol violations the appropriate refusal has
/// already been written before `None` is returned.
async fn socks5_read_target<S>(socket: &mut S) -> Option<(String, u16)>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut greeting = [0u8; 2];
    socket.read_exact(&mut greeting).await.ok()?;
    if greeting[0] != 0x05 {
        return None;
    }

    let mut methods = vec![0u8; greeting[1] as usize];
    socket.read_exact(&mut methods).await.ok()?;
    if !methods.contains(&0x00) {
        // 0xFF: none of the offered authentication methods are acceptable.
        let _ = socket.write_all(&[0x05, 0xFF]).await;
        return None;
    }
    socket.write_all(&[0x05, 0x00]).await.ok()?;

    let mut request = [0u8; 4];
    socket.read_exact(&mut request).await.ok()?;
    if request[0] != 0x05 || request[2] != 0x00 {
        socks_reply(socket, SOCKS_GENERAL_FAILURE).await;
        return None;
    }
    if request[1] != 0x01 {
        socks_reply(socket, SOCKS_COMMAND_NOT_SUPPORTED).await;
        return None;
    }

    let host = match request[3] {
        0x01 => {
            let mut addr = [0u8; 4];
            socket.read_exact(&mut addr).await.ok()?;
            std::net::Ipv4Addr::from(addr).to_string()
        }
        0x03 => {
            let mut len = [0u8; 1];
            socket.read_exact(&mut len).await.ok()?;
            let mut name = vec![0u8; len[0] as usize];
            socket.read_exact(&mut name).await.ok()?;
            match String::from_utf8(name) {
                Ok(name) if validate_host(&name, "SOCKS target").is_ok() => name,
                Err(_) => {
                    socks_reply(socket, SOCKS_ADDRESS_NOT_SUPPORTED).await;
                    return None;
                }
                Ok(_) => {
                    socks_reply(socket, SOCKS_ADDRESS_NOT_SUPPORTED).await;
                    return None;
                }
            }
        }
        0x04 => {
            let mut addr = [0u8; 16];
            socket.read_exact(&mut addr).await.ok()?;
            std::net::Ipv6Addr::from(addr).to_string()
        }
        _ => {
            socks_reply(socket, SOCKS_ADDRESS_NOT_SUPPORTED).await;
            return None;
        }
    };

    let mut port = [0u8; 2];
    socket.read_exact(&mut port).await.ok()?;
    let port = u16::from_be_bytes(port);
    if port == 0 {
        socks_reply(socket, SOCKS_GENERAL_FAILURE).await;
        return None;
    }
    Some((host, port))
}

async fn socks5_read_target_with_deadline<S>(
    socket: &mut S,
    deadline: Duration,
) -> Option<(String, u16)>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    tokio::time::timeout(deadline, socks5_read_target(socket))
        .await
        .ok()
        .flatten()
}

struct RemoteForwardGate {
    enabled: AtomicBool,
    bind_address: IpAddr,
    bind_port: u32,
    target_host: String,
    target_port: u16,
}

impl RemoteForwardGate {
    fn new(request: &StartTunnelRequest) -> Self {
        Self {
            enabled: AtomicBool::new(false),
            bind_address: request
                .local_host
                .parse()
                .expect("validated tunnel bind addresses are IP literals"),
            bind_port: u32::from(request.local_port),
            target_host: request.remote_host.clone(),
            target_port: request.remote_port,
        }
    }

    fn enable(&self) {
        self.enabled.store(true, Ordering::Release);
    }

    fn disable(&self) {
        self.enabled.store(false, Ordering::Release);
    }

    fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Acquire)
    }

    fn matches_bind(&self, connected_address: &str, connected_port: u32) -> bool {
        if connected_port != self.bind_port {
            return false;
        }
        let Ok(connected) = connected_address
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<IpAddr>()
        else {
            return false;
        };
        match (self.bind_address, connected) {
            (IpAddr::V4(expected), IpAddr::V4(actual)) => {
                expected.is_unspecified() || expected == actual
            }
            (IpAddr::V6(expected), IpAddr::V6(actual)) => {
                expected.is_unspecified() || expected == actual
            }
            _ => false,
        }
    }
}

/// The russh handler for a tunnel session: answers the host key question from
/// the trust store, and — only after a remote forward is published — delivers
/// the server's matching forwarded connections to the configured local target.
struct TunnelHandler {
    trust: TrustingHandler,
    remote_forward: Option<Arc<RemoteForwardGate>>,
    counters: Counters,
    /// Keeps tunnel admission tied to russh's actual transport task even if
    /// the outer start future is dropped before it can run async cleanup.
    _tunnel_admission: Arc<TunnelAdmission>,
}

impl Drop for TunnelHandler {
    fn drop(&mut self) {
        // russh skips Handler::disconnected when transport shutdown itself
        // errors. Handler drop is still after its transport halves leave the
        // session runner, so it closes that exceptional cleanup path.
        self.counters.mark_session_cleaned_up();
    }
}

impl client::Handler for TunnelHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        self.trust.check_server_key(server_public_key).await
    }

    async fn disconnected(
        &mut self,
        reason: client::DisconnectReason<Self::Error>,
    ) -> Result<(), Self::Error> {
        // russh invokes this after stream_write.shutdown(). This notification,
        // rather than Handle::is_closed(), is the safe immediate-restart
        // fence for remote forwards whose explicit cancellation timed out.
        self.counters.mark_session_cleaned_up();
        match reason {
            client::DisconnectReason::ReceivedDisconnect(_) => Ok(()),
            client::DisconnectReason::Error(error) => Err(error),
        }
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<client::Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: russh::client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let Some(forward) = self.remote_forward.clone() else {
            let _ = tokio::time::timeout(
                SSH_CONTROL_TIMEOUT,
                reply.reject(ChannelOpenFailure::AdministrativelyProhibited),
            )
            .await;
            return Ok(());
        };
        if !forward.is_enabled() {
            let _ = tokio::time::timeout(
                SSH_CONTROL_TIMEOUT,
                reply.reject(ChannelOpenFailure::AdministrativelyProhibited),
            )
            .await;
            return Ok(());
        }
        if !forward.matches_bind(connected_address, connected_port) {
            self.counters.fail_tunnel(
                "forward:the SSH host opened a connection for an unexpected remote bind"
                    .to_string(),
            );
            let _ = tokio::time::timeout(
                SSH_CONTROL_TIMEOUT,
                reply.reject(ChannelOpenFailure::AdministrativelyProhibited),
            )
            .await;
            return Ok(());
        }
        let host = forward.target_host.clone();
        let port = forward.target_port;

        let counters = self.counters.clone();
        let lease = match counters.try_open_connection() {
            Ok(lease) => lease,
            Err(error) => {
                counters.record_error(error.message());
                let failure = error.channel_failure();
                let _ = tokio::time::timeout(SSH_CONTROL_TIMEOUT, reply.reject(failure)).await;
                return Ok(());
            }
        };
        tokio::spawn(lease.run(async move {
            match tokio::time::timeout(
                LOCAL_TARGET_CONNECT_TIMEOUT,
                TcpStream::connect((host.as_str(), port)),
            )
            .await
            {
                Ok(Ok(socket)) => {
                    if tokio::time::timeout(SSH_CONTROL_TIMEOUT, reply.accept())
                        .await
                        .is_ok()
                    {
                        // For a remote tunnel "upload" is what local services send
                        // back toward the remote side, mirroring `ssh -R`.
                        pump(socket, channel, counters).await;
                    }
                }
                Ok(Err(_)) => {
                    counters.record_error(format!(
                        "forward:the local target {host}:{port} is unavailable"
                    ));
                    let _ = tokio::time::timeout(
                        SSH_CONTROL_TIMEOUT,
                        reply.reject(ChannelOpenFailure::ConnectFailed),
                    )
                    .await;
                }
                Err(_) => {
                    counters.record_error(format!(
                        "forward:the local target {host}:{port} did not connect within {} seconds",
                        LOCAL_TARGET_CONNECT_TIMEOUT.as_secs()
                    ));
                    let _ = tokio::time::timeout(
                        SSH_CONTROL_TIMEOUT,
                        reply.reject(ChannelOpenFailure::ConnectFailed),
                    )
                    .await;
                }
            }
        }));
        Ok(())
    }
}

/// Turns a recorded trust verdict, or its absence, into the coded error the
/// interface translates.
fn connect_error(verdict: Option<TrustVerdict>, fallback: String) -> String {
    match verdict {
        Some(TrustVerdict::Unknown { fingerprint, .. }) => format!(
            "trust:unknown host key {fingerprint} — connect over SSH once to confirm it first"
        ),
        Some(TrustVerdict::Changed {
            received_fingerprint,
            ..
        }) => format!(
            "trust:host key changed to {received_fingerprint} — resolve it in the SSH connect flow"
        ),
        _ => format!("connect:{fallback}"),
    }
}

fn validate_identifier(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > MAX_TUNNEL_ID_BYTES
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(format!(
            "profile:{label} is missing or contains unsupported characters"
        ));
    }
    Ok(())
}

fn validate_host(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > MAX_HOST_BYTES
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(character, '.' | '_' | ':' | '-' | '[' | ']' | '%')
        })
    {
        return Err(format!("connect:{label} is invalid"));
    }
    Ok(())
}

fn validate_request(request: &StartTunnelRequest) -> Result<(), String> {
    validate_identifier(&request.tunnel_id, "tunnel id")?;
    validate_identifier(&request.profile_id, "profile id")?;
    validate_host(&request.ssh_hostname, "SSH hostname")?;
    if request.ssh_port == 0
        || request.ssh_username.trim().is_empty()
        || request.ssh_username.len() > 64
        || request.ssh_username.chars().any(char::is_whitespace)
        || request.ssh_username.chars().any(char::is_control)
    {
        return Err("connect:the SSH endpoint is invalid".to_string());
    }

    let bind_ip = request
        .local_host
        .parse::<IpAddr>()
        .map_err(|_| "bind:the bind address must be an IPv4 or IPv6 literal".to_string())?;
    if request.local_port == 0 {
        return Err("bind:the bind port must be between 1 and 65535".to_string());
    }
    if request.tunnel_type == TunnelType::Dynamic && !bind_ip.is_loopback() {
        return Err(
            "bind:a no-authentication SOCKS5 proxy may only use a loopback address".to_string(),
        );
    }
    if request.tunnel_type != TunnelType::Dynamic {
        validate_host(&request.remote_host, "tunnel target hostname")?;
        if request.remote_port == 0 {
            return Err("connect:the target port must be between 1 and 65535".to_string());
        }
    }
    Ok(())
}

async fn run_start_stage<T, F>(
    stop_rx: &mut watch::Receiver<bool>,
    deadline: Duration,
    timeout_error: String,
    operation: F,
) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    if *stop_rx.borrow() {
        return Err("connect:tunnel start was cancelled".to_string());
    }
    tokio::select! {
        biased;
        _ = wait_for_stop(stop_rx) => {
            Err("connect:tunnel start was cancelled".to_string())
        }
        result = tokio::time::timeout(deadline, operation) => {
            result.map_err(|_| timeout_error)?
        }
    }
}

/// Owns an OS-level duplicate of the SSH transport. russh can temporarily stop
/// polling its command receiver during key exchange or a blocked write; this
/// guard is the non-cooperative cancellation path that still tears the socket
/// down when a setup future or worker is cancelled.
struct SessionSocketGuard(Option<std::net::TcpStream>);

impl SessionSocketGuard {
    fn new(socket: std::net::TcpStream) -> Self {
        Self(Some(socket))
    }

    fn shutdown_now(&mut self) {
        if let Some(socket) = self.0.take() {
            let _ = socket.shutdown(Shutdown::Both);
        }
    }
}

impl Drop for SessionSocketGuard {
    fn drop(&mut self) {
        self.shutdown_now();
    }
}

struct OpenSession {
    handle: client::Handle<TunnelHandler>,
    shutdown: SessionSocketGuard,
    remote_forward: Option<Arc<RemoteForwardGate>>,
}

async fn shutdown_unpublished_session(mut session: OpenSession, counters: &Counters) {
    // A hostile server can send forwarded-tcpip before tcpip_forward has been
    // published. Seal and drain those tasks even on auth/setup/commit failure.
    counters.seal_connections();
    counters.wait_for_connections().await;
    let _ = tokio::time::timeout(
        SSH_CONTROL_TIMEOUT,
        session
            .handle
            .disconnect(Disconnect::ByApplication, "tunnel setup stopped", ""),
    )
    .await;
    session.shutdown.shutdown_now();
    let mut handle = session.handle;
    let _ = (&mut handle).await;
    counters.wait_for_session_cleanup().await;
}

async fn request_remote_forward(
    session: &client::Handle<TunnelHandler>,
    address: &str,
    port: u16,
) -> Result<(), russh::Error> {
    for attempt in 0..=REMOTE_FORWARD_RETRY_LIMIT {
        match session.tcpip_forward(address, u32::from(port)).await {
            Ok(_) => return Ok(()),
            // OpenSSH can acknowledge cancellation and close the old SSH
            // transport just before its forwarding listener becomes
            // re-bindable. Retry only that protocol-level refusal, for at
            // most one second, so Stop followed by immediate Start is stable
            // without hiding transport failures or a lasting port conflict.
            Err(russh::Error::RequestDenied) if attempt < REMOTE_FORWARD_RETRY_LIMIT => {
                tokio::time::sleep(REMOTE_FORWARD_RETRY_DELAY).await;
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("the bounded remote-forward retry loop always returns")
}

/// Connects and authenticates the tunnel's own SSH session.
async fn open_session(
    request: &StartTunnelRequest,
    password: &str,
    known: Option<HostKeyRecord>,
    counters: Counters,
    tunnel_admission: Arc<TunnelAdmission>,
    stop_rx: &mut watch::Receiver<bool>,
) -> Result<OpenSession, String> {
    let verdict = Arc::new(Mutex::new(None));
    let remote_forward = matches!(request.tunnel_type, TunnelType::Remote)
        .then(|| Arc::new(RemoteForwardGate::new(request)));
    let handler = TunnelHandler {
        trust: TrustingHandler {
            host: request.ssh_hostname.clone(),
            port: request.ssh_port,
            known,
            verdict: Arc::clone(&verdict),
        },
        remote_forward: remote_forward.clone(),
        counters: counters.clone(),
        _tunnel_admission: tunnel_admission,
    };

    let config = Arc::new(client::Config {
        // A tunnel is expected to sit idle; keepalives hold the path open
        // instead of an inactivity timeout tearing it down.
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(30)),
        ..Default::default()
    });

    let socket = run_start_stage(
        stop_rx,
        SSH_CONNECT_TIMEOUT,
        format!(
            "connect:the SSH host did not connect within {} seconds",
            SSH_CONNECT_TIMEOUT.as_secs()
        ),
        async {
            TcpStream::connect((request.ssh_hostname.as_str(), request.ssh_port))
                .await
                .map_err(|error| format!("connect:{error}"))
        },
    )
    .await?;

    // `connect_stream` starts russh's transport task before key exchange has
    // completed. Keep a duplicate OS socket solely as a cancellation handle;
    // on timeout it forces that task to leave before admission is released.
    let std_socket = socket
        .into_std()
        .map_err(|error| format!("connect:cannot prepare the SSH socket: {error}"))?;
    let shutdown_socket = std_socket
        .try_clone()
        .map_err(|error| format!("connect:cannot guard the SSH socket: {error}"))?;
    let mut shutdown = SessionSocketGuard::new(shutdown_socket);
    let socket = TcpStream::from_std(std_socket)
        .map_err(|error| format!("connect:cannot activate the SSH socket: {error}"))?;

    let handshake = run_start_stage(
        stop_rx,
        SSH_HANDSHAKE_TIMEOUT,
        format!(
            "connect:the SSH handshake did not finish within {} seconds",
            SSH_HANDSHAKE_TIMEOUT.as_secs()
        ),
        async {
            client::connect_stream(config, socket, handler)
                .await
                .map_err(|error| {
                    let recorded = verdict.lock().ok().and_then(|slot| slot.clone());
                    connect_error(recorded, error.to_string())
                })
        },
    )
    .await;
    let handle = match handshake {
        Ok(session) => session,
        Err(error) => {
            shutdown.shutdown_now();
            counters.wait_for_session_cleanup().await;
            return Err(error);
        }
    };
    let mut session = OpenSession {
        handle,
        shutdown,
        remote_forward,
    };

    let authenticated = match run_start_stage(
        stop_rx,
        SSH_AUTH_TIMEOUT,
        format!(
            "auth:the SSH host did not authenticate within {} seconds",
            SSH_AUTH_TIMEOUT.as_secs()
        ),
        async {
            session
                .handle
                .authenticate_password(&request.ssh_username, password)
                .await
                .map(|result| result.success())
                .map_err(|error| format!("auth:{error}"))
        },
    )
    .await
    {
        Ok(authenticated) => authenticated,
        Err(error) => {
            shutdown_unpublished_session(session, &counters).await;
            return Err(error);
        }
    };

    if !authenticated {
        shutdown_unpublished_session(session, &counters).await;
        return Err("auth:the host rejected the credentials".to_string());
    }

    Ok(session)
}

/// Reserves admission before any potentially blocking credential or network
/// operation. The command layer deliberately calls this before keyring I/O.
pub(crate) fn reserve_tunnel_start(
    registry: Arc<TunnelRegistry>,
    request: &StartTunnelRequest,
    _restore_guard: &RwLockReadGuard<'_, ()>,
) -> Result<TunnelStartReservation, String> {
    validate_request(request)?;
    registry.reserve_start(&request.tunnel_id)
}

/// Starts a tunnel from a previously admitted reservation.
pub(crate) async fn start_reserved_tunnel(
    mut reservation: TunnelStartReservation,
    request: StartTunnelRequest,
    password: &str,
    known: Option<HostKeyRecord>,
) -> Result<TunnelStatusSummary, String> {
    validate_request(&request)?;
    if reservation.tunnel_id != request.tunnel_id {
        return Err("connect:tunnel start reservation does not match the request".to_string());
    }
    let registry = Arc::clone(&reservation.registry);
    let generation = reservation.generation();

    // Bind first: a port squatted by another process should fail fast, before
    // any network round trip to the SSH host.
    let listener = match request.tunnel_type {
        TunnelType::Local | TunnelType::Dynamic => Some(
            run_start_stage(
                reservation.stop_receiver(),
                LOCAL_BIND_TIMEOUT,
                format!(
                    "bind:cannot listen on {}:{} within {} seconds",
                    request.local_host,
                    request.local_port,
                    LOCAL_BIND_TIMEOUT.as_secs()
                ),
                async {
                    TcpListener::bind((request.local_host.as_str(), request.local_port))
                        .await
                        .map_err(|err| {
                            format!(
                                "bind:cannot listen on {}:{}: {err}",
                                request.local_host, request.local_port
                            )
                        })
                },
            )
            .await?,
        ),
        TunnelType::Remote => None,
    };

    let tunnel_admission = reservation.take_admission_for_session()?;
    let counters = Counters::new(
        Arc::clone(&registry.connection_admission),
        reservation.stop_sender(),
    );
    let session = open_session(
        &request,
        password,
        known,
        counters.clone(),
        Arc::clone(&tunnel_admission),
        reservation.stop_receiver(),
    )
    .await;
    let session = match session {
        Ok(session) => session,
        // `connect_stream` may already have spawned russh's transport task.
        // Let the handler's Arc own admission until that task has truly
        // dropped instead of releasing the slot at this API boundary.
        Err(error) => return Err(error),
    };

    if matches!(request.tunnel_type, TunnelType::Remote) {
        let forward = run_start_stage(
            reservation.stop_receiver(),
            REMOTE_FORWARD_SETUP_TIMEOUT,
            format!(
                "forward:the host did not open the remote forward within {} seconds",
                REMOTE_FORWARD_SETUP_TIMEOUT.as_secs()
            ),
            async {
                request_remote_forward(
                    &session.handle,
                    request.local_host.as_str(),
                    request.local_port,
                )
                .await
                .map_err(|error| format!("forward:the host refused the remote forward: {error}"))
            },
        )
        .await;
        if let Err(error) = forward {
            shutdown_unpublished_session(session, &counters).await;
            tunnel_admission.release();
            return Err(error);
        }
    }

    let (completion_tx, _) = watch::channel(false);
    let started_at = Some(now_epoch_secs());

    let committed = reservation.commit(ActiveTunnel {
        tunnel_id: request.tunnel_id.clone(),
        status: TunnelStatus::Active,
        generation,
        bytes_uploaded: Arc::clone(&counters.up),
        bytes_downloaded: Arc::clone(&counters.down),
        active_connections: Arc::clone(&counters.connections),
        started_at,
        last_error: Arc::clone(&counters.last_error),
        stop_tx: None,
        completion_tx,
    });
    let mut stop_rx = match committed {
        Ok(committed) => committed,
        Err(error) => {
            if request.tunnel_type == TunnelType::Remote && !session.handle.is_closed() {
                let _ = tokio::time::timeout(
                    REMOTE_FORWARD_CANCEL_TIMEOUT,
                    session.handle.cancel_tcpip_forward(
                        request.local_host.clone(),
                        u32::from(request.local_port),
                    ),
                )
                .await;
            }
            shutdown_unpublished_session(session, &counters).await;
            tunnel_admission.release();
            return Err(error);
        }
    };
    if let Some(forward) = session.remote_forward.as_ref() {
        forward.enable();
    }

    // Shared because every forwarded connection opens its own channel; keep
    // the OS hard-stop guard separately in the owning worker for the complete
    // lifetime of the russh transport.
    let OpenSession {
        handle,
        mut shutdown,
        remote_forward,
    } = session;
    let session = Arc::new(handle);

    let summary = TunnelStatusSummary {
        tunnel_id: request.tunnel_id.clone(),
        status: TunnelStatus::Active,
        bytes_uploaded: 0,
        bytes_downloaded: 0,
        active_connections: 0,
        started_at,
        last_error: None,
    };

    let registry_task = Arc::clone(&registry);
    tokio::spawn(async move {
        let mut health = tokio::time::interval(Duration::from_secs(10));
        health.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut outcome: (TunnelStatus, Option<String>) = (TunnelStatus::Stopped, None);

        loop {
            let accept = async {
                match &listener {
                    Some(listener) => Some(listener.accept().await),
                    // A remote tunnel has nothing to accept locally; its
                    // connections arrive through the session handler.
                    None => std::future::pending().await,
                }
            };

            tokio::select! {
                biased;
                _ = wait_for_stop(&mut stop_rx) => break,
                _ = health.tick() => {
                    if session.is_closed() {
                        outcome = (
                            TunnelStatus::Error,
                            Some("connect:the SSH connection dropped".to_string()),
                        );
                        break;
                    }
                }
                accepted = accept => match accepted {
                    Some(Ok((socket, peer))) => {
                        spawn_connection(&session, &request, socket, peer, counters.clone());
                    }
                    Some(Err(error)) => {
                        outcome = (
                            TunnelStatus::Error,
                            Some(format!("bind:the listener failed: {error}")),
                        );
                        break;
                    }
                    None => unreachable!("pending() never resolves"),
                }
            }
        }

        if let Some(error) = counters.fatal_error() {
            outcome = (TunnelStatus::Error, Some(error));
        }
        if let Some(forward) = remote_forward.as_ref() {
            forward.disable();
        }
        counters.seal_connections();
        // Release a local/dynamic bind before publishing the restartable
        // terminal status. Without this explicit ordering, an immediate
        // restart can race the worker closure dropping its listener.
        drop(listener);
        counters.wait_for_connections().await;

        // A remote forwarding request survives independently on the SSH
        // server until it is explicitly cancelled or the session is truly
        // closed. Bound the polite cancellation request, then disconnect and
        // retain registry ownership until russh confirms that its session
        // task has closed. Handle::disconnect only enqueues a message.
        if request.tunnel_type == TunnelType::Remote && !session.is_closed() {
            let _ = tokio::time::timeout(
                REMOTE_FORWARD_CANCEL_TIMEOUT,
                session.cancel_tcpip_forward(
                    request.local_host.clone(),
                    u32::from(request.local_port),
                ),
            )
            .await;
        }
        let _ = tokio::time::timeout(
            SSH_CONTROL_TIMEOUT,
            session.disconnect(Disconnect::ByApplication, "tunnel stopped", ""),
        )
        .await;
        // A rekey or zero-window write can prevent russh from polling its
        // command receiver. Always force the underlying socket closed after
        // the bounded polite shutdown, then reap the session task.
        shutdown.shutdown_now();
        let mut shared = session;
        let mut handle = loop {
            match Arc::try_unwrap(shared) {
                Ok(handle) => break handle,
                Err(still_shared) => {
                    // The connection drain above should make this at most one
                    // scheduler turn; fail closed and retain admission if an
                    // unexpected clone ever survives.
                    shared = still_shared;
                    tokio::task::yield_now().await;
                }
            }
        };
        let _ = (&mut handle).await;
        counters.wait_for_session_cleanup().await;
        // Stop completion is the documented immediate-restart boundary. Free
        // admission before publishing it so a full registry cannot report a
        // spurious capacity error immediately after Stop succeeds.
        tunnel_admission.release();
        registry_task.finish(&request.tunnel_id, generation, outcome.0, outcome.1);
    });

    Ok(summary)
}

/// Convenience entry used by library consumers and live tests that already
/// have a credential. The Tauri command reserves before loading its password.
pub async fn start_tunnel(
    registry: Arc<TunnelRegistry>,
    request: StartTunnelRequest,
    password: &str,
    known: Option<HostKeyRecord>,
) -> Result<TunnelStatusSummary, String> {
    let restore_guard = registry.lock_tunnel_start().await;
    let reservation = reserve_tunnel_start(Arc::clone(&registry), &request, &restore_guard)?;
    drop(restore_guard);
    start_reserved_tunnel(reservation, request, password, known).await
}

/// Handles one accepted local connection according to the tunnel type.
fn spawn_connection(
    session: &Arc<client::Handle<TunnelHandler>>,
    request: &StartTunnelRequest,
    mut socket: TcpStream,
    peer: std::net::SocketAddr,
    counters: Counters,
) {
    let lease = match counters.try_open_connection() {
        Ok(lease) => lease,
        Err(error) => {
            counters.record_error(error.message());
            return;
        }
    };
    let session = Arc::clone(session);
    let tunnel_type = request.tunnel_type;
    let remote_host = request.remote_host.clone();
    let remote_port = request.remote_port;

    tokio::spawn(lease.run(async move {
        match tunnel_type {
            TunnelType::Local => {
                match tokio::time::timeout(
                    CHANNEL_OPEN_TIMEOUT,
                    session.channel_open_direct_tcpip(
                        remote_host.clone(),
                        u32::from(remote_port),
                        peer.ip().to_string(),
                        u32::from(peer.port()),
                    ),
                )
                .await
                {
                    Ok(Ok(channel)) => pump(socket, channel, counters).await,
                    Ok(Err(error)) => {
                        // The user sees a connection that opens and instantly
                        // dies; the status has to say why. A host with
                        // AllowTcpForwarding off lands here.
                        counters.record_error(format!(
                            "connect:the host would not forward to {remote_host}:{remote_port}: {error}"
                        ));
                    }
                    Err(_) => counters.fail_tunnel(format!(
                        "connect:the host did not open a channel to {remote_host}:{remote_port} within {} seconds",
                        CHANNEL_OPEN_TIMEOUT.as_secs()
                    )),
                }
            }
            TunnelType::Dynamic => {
                let Some((target_host, target_port)) = socks5_read_target_with_deadline(
                    &mut socket,
                    SOCKS_NEGOTIATION_TIMEOUT,
                )
                .await
                else {
                    return;
                };
                let target_host_label = format!("{target_host}:{target_port}");
                match tokio::time::timeout(
                    CHANNEL_OPEN_TIMEOUT,
                    session.channel_open_direct_tcpip(
                        target_host,
                        u32::from(target_port),
                        peer.ip().to_string(),
                        u32::from(peer.port()),
                    ),
                )
                .await
                {
                    Ok(Ok(mut channel)) => {
                        if tokio::time::timeout(
                            SSH_CONTROL_TIMEOUT,
                            socks_reply(&mut socket, SOCKS_OK),
                        )
                        .await
                        .is_ok_and(|sent| sent)
                        {
                            pump(socket, channel, counters).await;
                        } else {
                            close_channel_or_fail(
                                &mut channel,
                                &counters,
                                "a SOCKS forwarding channel",
                            )
                            .await;
                        }
                    }
                    Ok(Err(error)) => {
                        counters.record_error(format!(
                            "connect:the host would not open a connection to {target_host_label}: {error}"
                        ));
                        let _ = tokio::time::timeout(
                            SSH_CONTROL_TIMEOUT,
                            socks_reply(&mut socket, SOCKS_CONNECTION_REFUSED),
                        )
                        .await;
                    }
                    Err(_) => {
                        counters.fail_tunnel(format!(
                            "connect:the host did not open a connection to {target_host_label} within {} seconds",
                            CHANNEL_OPEN_TIMEOUT.as_secs()
                        ));
                        let _ = tokio::time::timeout(
                            SSH_CONTROL_TIMEOUT,
                            socks_reply(&mut socket, SOCKS_CONNECTION_REFUSED),
                        )
                        .await;
                    }
                }
            }
            // Remote connections never arrive through the local listener.
            TunnelType::Remote => {}
        }
    }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::client::Handler as _;

    fn test_tunnel_admission() -> Arc<TunnelAdmission> {
        let semaphore = Arc::new(Semaphore::new(1));
        let permit = semaphore.try_acquire_owned().unwrap();
        Arc::new(TunnelAdmission::new(permit))
    }

    fn test_counters(global: Arc<Semaphore>, per_tunnel: usize) -> Counters {
        let (stop_tx, _) = watch::channel(false);
        Counters::with_connection_limit(global, stop_tx, per_tunnel)
    }

    fn entry(tunnel_id: &str, generation: u64) -> ActiveTunnel {
        let (completion_tx, _) = watch::channel(false);
        ActiveTunnel {
            tunnel_id: tunnel_id.to_string(),
            status: TunnelStatus::Active,
            generation,
            bytes_uploaded: Arc::new(AtomicU64::new(0)),
            bytes_downloaded: Arc::new(AtomicU64::new(0)),
            active_connections: Arc::new(AtomicU32::new(0)),
            started_at: Some(1),
            last_error: Arc::new(Mutex::new(None)),
            stop_tx: Some(watch::channel(false).0),
            completion_tx,
        }
    }

    fn request(tunnel_type: TunnelType) -> StartTunnelRequest {
        StartTunnelRequest {
            tunnel_id: "tunnel-1".to_string(),
            tunnel_type,
            profile_id: "profile-1".to_string(),
            local_host: "127.0.0.1".to_string(),
            local_port: 8080,
            remote_host: "db.internal".to_string(),
            remote_port: 5432,
            ssh_hostname: "gateway.internal".to_string(),
            ssh_port: 22,
            ssh_username: "operator".to_string(),
        }
    }

    #[tokio::test]
    async fn backup_restore_barrier_cannot_miss_a_concurrent_start() {
        let registry = Arc::new(TunnelRegistry::new());
        let restore_guard = registry.lock_backup_restore().await;
        let starting_registry = Arc::clone(&registry);
        let mut starting = tokio::spawn(async move {
            let guard = starting_registry.lock_tunnel_start().await;
            let reservation = reserve_tunnel_start(
                Arc::clone(&starting_registry),
                &request(TunnelType::Local),
                &guard,
            )?;
            drop(guard);
            Ok::<_, String>(reservation)
        });

        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut starting)
                .await
                .is_err(),
            "a start must wait while restore owns the barrier"
        );
        drop(restore_guard);

        let reservation = tokio::time::timeout(Duration::from_secs(1), starting)
            .await
            .expect("the start should resume after restore")
            .expect("the start task should not panic")
            .expect("the start should reserve successfully");
        assert_eq!(
            registry.status("tunnel-1").unwrap().status,
            TunnelStatus::Starting,
            "a later restore writer must observe the reserved row"
        );
        drop(reservation);
    }

    #[tokio::test]
    async fn handler_disconnection_opens_the_transport_cleanup_fence() {
        let counters = test_counters(Arc::new(Semaphore::new(1)), 1);
        let waiting_counters = counters.clone();
        let waiting = tokio::spawn(async move {
            waiting_counters.wait_for_session_cleanup().await;
        });
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());

        let mut handler = TunnelHandler {
            trust: TrustingHandler {
                host: "gateway.internal".into(),
                port: 22,
                known: None,
                verdict: Arc::new(Mutex::new(None)),
            },
            remote_forward: None,
            counters,
            _tunnel_admission: test_tunnel_admission(),
        };
        handler
            .disconnected(client::DisconnectReason::ReceivedDisconnect(
                client::RemoteDisconnectInfo {
                    reason_code: Disconnect::ByApplication,
                    message: "done".into(),
                    lang_tag: String::new(),
                },
            ))
            .await
            .unwrap();

        tokio::time::timeout(Duration::from_secs(1), waiting)
            .await
            .expect("cleanup waiter should be released")
            .expect("cleanup waiter should not panic");
    }

    #[tokio::test]
    async fn stop_waits_for_worker_cleanup_before_allowing_a_restart() {
        let registry = Arc::new(TunnelRegistry::new());
        let active = entry("t1", 1);
        let mut stop_rx = active.stop_tx.as_ref().unwrap().subscribe();
        registry.register(active).unwrap();
        registry.generations.store(1, Ordering::Relaxed);

        let stopping_registry = Arc::clone(&registry);
        let stopping = tokio::spawn(async move { stopping_registry.stop("t1").await });
        tokio::time::timeout(Duration::from_secs(1), stop_rx.changed())
            .await
            .expect("stop request should reach the worker")
            .expect("stop signal should remain open");
        assert!(*stop_rx.borrow());

        // Stop has returned a signal, but restart remains blocked until the
        // worker confirms that its listener and SSH session are gone.
        assert_eq!(registry.status("t1").unwrap().status, TunnelStatus::Active);
        assert!(registry.is_running("t1"));
        assert!(registry.reserve_start("t1").is_err());

        registry.finish("t1", 1, TunnelStatus::Stopped, None);
        stopping.await.unwrap().unwrap();
        assert!(!registry.is_running("t1"));

        let restart = registry.reserve_start("t1").unwrap();
        assert_eq!(restart.generation(), 2);
    }

    #[test]
    fn shutdown_seals_starts_without_losing_a_reserved_previous_summary() {
        let registry = Arc::new(TunnelRegistry::new());
        registry.register(entry("t1", 7)).unwrap();
        registry.finish(
            "t1",
            7,
            TunnelStatus::Error,
            Some("connect:old failure".into()),
        );
        registry.generations.store(7, Ordering::Relaxed);

        let mut reservation = registry.reserve_start("t1").unwrap();
        let generation = reservation.generation();
        let _admission = reservation.take_admission_for_session().unwrap();
        registry.stop_all();

        assert_eq!(
            registry.status("t1").unwrap().status,
            TunnelStatus::Starting
        );
        assert!(reservation.commit(entry("t1", generation)).is_err());
        drop(reservation);

        let restored = registry.status("t1").unwrap();
        assert_eq!(restored.status, TunnelStatus::Error);
        assert_eq!(restored.last_error.as_deref(), Some("connect:old failure"));
        assert!(registry.reserve_start("t2").is_err());
    }

    #[tokio::test]
    async fn stopping_an_unknown_tunnel_reports_it() {
        let registry = TunnelRegistry::new();
        assert!(registry
            .stop("missing")
            .await
            .unwrap_err()
            .contains("missing"));
    }

    #[test]
    fn a_stale_run_cannot_overwrite_a_restarted_tunnel() {
        let registry = TunnelRegistry::new();
        registry.register(entry("t1", 1)).unwrap();
        registry.finish("t1", 1, TunnelStatus::Stopped, None);
        // The tunnel restarts: same id, new generation.
        registry.register(entry("t1", 2)).unwrap();

        // The first run's task finishes late and tries to record its ending.
        registry.finish("t1", 1, TunnelStatus::Error, Some("stale".into()));

        let status = registry.status("t1").unwrap();
        assert_eq!(status.status, TunnelStatus::Active);
        assert!(status.last_error.is_none());
        assert!(registry.is_running("t1"));

        // The current run's ending is still recorded normally.
        registry.finish("t1", 2, TunnelStatus::Stopped, None);
        assert_eq!(registry.status("t1").unwrap().status, TunnelStatus::Stopped);
        assert!(!registry.is_running("t1"));
    }

    #[test]
    fn a_run_that_ends_with_an_error_can_restart() {
        let registry = TunnelRegistry::new();
        registry.register(entry("t1", 1)).unwrap();

        registry.finish(
            "t1",
            1,
            TunnelStatus::Error,
            Some("connect:the SSH connection dropped".into()),
        );

        let failed = registry.status("t1").unwrap();
        assert_eq!(failed.status, TunnelStatus::Error);
        assert_eq!(
            failed.last_error.as_deref(),
            Some("connect:the SSH connection dropped")
        );
        assert!(!registry.is_running("t1"));

        registry.register(entry("t1", 2)).unwrap();
        assert!(registry.is_running("t1"));
        assert_eq!(registry.status("t1").unwrap().status, TunnelStatus::Active);
    }

    #[test]
    fn a_start_reservation_blocks_concurrent_side_effects_and_cleans_up() {
        let registry = Arc::new(TunnelRegistry::new());
        let reservation = registry.reserve_start("t1").unwrap();

        assert!(registry.is_running("t1"));
        assert_eq!(
            registry.status("t1").unwrap().status,
            TunnelStatus::Starting
        );
        assert!(registry.reserve_start("t1").is_err());
        assert!(registry.register(entry("t1", 99)).is_err());

        drop(reservation);
        assert!(!registry.is_running("t1"));
        assert!(registry.status("t1").is_none());
    }

    #[test]
    fn tunnel_admission_is_released_before_cleanup_completion_is_published() {
        let registry = Arc::new(TunnelRegistry::with_limits(1, 2));
        let mut first = registry.reserve_start("t1").unwrap();
        assert!(registry.reserve_start("t2").is_err());

        let generation = first.generation();
        let admission = first.take_admission_for_session().unwrap();
        let _stop_rx = first.commit(entry("t1", generation)).unwrap();

        // Active cleanup retains admission, but the worker releases it before
        // publishing the completion fence observed by Stop.
        assert!(registry.reserve_start("t2").is_err());
        admission.release();
        registry.finish("t1", generation, TunnelStatus::Stopped, None);
        assert!(registry.reserve_start("t2").is_ok());
    }

    #[tokio::test]
    async fn a_starting_tunnel_can_be_stopped_before_network_setup() {
        let registry = Arc::new(TunnelRegistry::with_limits(1, 2));
        let reservation = registry.reserve_start("t1").unwrap();
        let stopping_registry = Arc::clone(&registry);
        let stopping = tokio::spawn(async move { stopping_registry.stop("t1").await });

        tokio::time::timeout(Duration::from_secs(1), async {
            while !*reservation.stop_tx.borrow() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the starting reservation should observe Stop");
        drop(reservation);

        stopping.await.unwrap().unwrap();
        assert!(registry.status("t1").is_none());
        assert!(
            registry.reserve_start("t2").is_ok(),
            "Stop completion must follow admission release for Starting runs"
        );
    }

    #[test]
    fn a_detached_credential_job_keeps_its_admission_but_not_its_starting_row() {
        let registry = Arc::new(TunnelRegistry::with_limits(1, 2));
        let mut reservation = registry.reserve_start("t1").unwrap();
        let credential_admission = reservation.take_admission_for_credential().unwrap();

        drop(reservation);
        assert!(registry.status("t1").is_none());
        assert!(
            registry.reserve_start("t2").is_err(),
            "the detached blocking job must retain admission"
        );

        drop(credential_admission);
        assert!(registry.reserve_start("t2").is_ok());
    }

    #[test]
    fn a_failed_start_restores_the_previous_terminal_summary() {
        let registry = Arc::new(TunnelRegistry::new());
        registry.register(entry("t1", 7)).unwrap();
        registry.finish(
            "t1",
            7,
            TunnelStatus::Error,
            Some("connect:old failure".into()),
        );
        registry.generations.store(7, Ordering::Relaxed);

        let reservation = registry.reserve_start("t1").unwrap();
        assert_eq!(
            registry.status("t1").unwrap().status,
            TunnelStatus::Starting
        );
        drop(reservation);

        let restored = registry.status("t1").unwrap();
        assert_eq!(restored.status, TunnelStatus::Error);
        assert_eq!(restored.last_error.as_deref(), Some("connect:old failure"));
    }

    #[test]
    fn only_the_matching_reservation_can_publish_an_active_run() {
        let registry = Arc::new(TunnelRegistry::new());
        let mut reservation = registry.reserve_start("t1").unwrap();
        let generation = reservation.generation();
        let _admission = reservation.take_admission_for_session().unwrap();

        let _run = reservation.commit(entry("t1", generation)).unwrap();

        assert!(registry.is_running("t1"));
        assert_eq!(registry.status("t1").unwrap().status, TunnelStatus::Active);
    }

    #[test]
    fn a_running_tunnel_cannot_be_replaced_by_a_concurrent_start() {
        let registry = TunnelRegistry::new();
        registry.register(entry("t1", 1)).unwrap();
        assert!(registry.register(entry("t1", 2)).is_err());
        let guard = registry.tunnels.lock().unwrap();
        assert_eq!(guard.get("t1").unwrap().generation, 1);
    }

    #[test]
    fn unsafe_ids_and_public_no_auth_socks_bindings_are_rejected() {
        let mut unsafe_id = request(TunnelType::Local);
        unsafe_id.tunnel_id = "../tunnel".to_string();
        assert!(validate_request(&unsafe_id).is_err());

        let mut public_socks = request(TunnelType::Dynamic);
        public_socks.local_host = "0.0.0.0".to_string();
        assert!(validate_request(&public_socks).is_err());
    }

    #[test]
    fn russh_handler_retains_tunnel_admission_until_transport_drop() {
        let slots = Arc::new(Semaphore::new(1));
        let permit = Arc::clone(&slots).try_acquire_owned().unwrap();
        let admission = Arc::new(TunnelAdmission::new(permit));
        let counters = test_counters(Arc::new(Semaphore::new(1)), 1);
        let handler = TunnelHandler {
            trust: TrustingHandler {
                host: "gateway.internal".into(),
                port: 22,
                known: None,
                verdict: Arc::new(Mutex::new(None)),
            },
            remote_forward: None,
            counters,
            _tunnel_admission: Arc::clone(&admission),
        };

        drop(admission);
        assert_eq!(slots.available_permits(), 0);
        drop(handler);
        assert_eq!(slots.available_permits(), 1);
    }

    #[test]
    fn remote_forward_gate_requires_publication_and_the_requested_bind() {
        let mut remote = request(TunnelType::Remote);
        remote.local_host = "0.0.0.0".into();
        remote.local_port = 3333;
        let gate = RemoteForwardGate::new(&remote);

        assert!(!gate.is_enabled());
        gate.enable();
        assert!(gate.is_enabled());
        assert!(gate.matches_bind("127.0.0.1", 3333));
        assert!(!gate.matches_bind("127.0.0.1", 3334));
        assert!(!gate.matches_bind("::1", 3333));
        gate.disable();
        assert!(!gate.is_enabled());

        remote.local_host = "127.0.0.1".into();
        let specific = RemoteForwardGate::new(&remote);
        assert!(specific.matches_bind("127.0.0.1", 3333));
        assert!(!specific.matches_bind("127.0.0.2", 3333));
    }

    #[test]
    fn fatal_connection_errors_are_sticky_and_stop_the_tunnel() {
        let counters = test_counters(Arc::new(Semaphore::new(1)), 1);
        counters.fail_tunnel("connect:pending channel timed out".into());

        assert!(*counters.stop_tx.borrow());
        assert_eq!(
            counters.fatal_error().as_deref(),
            Some("connect:pending channel timed out")
        );
    }

    #[test]
    fn a_connection_guard_tracks_real_lifetime() {
        let counter = Arc::new(AtomicU32::new(0));
        let guard = ConnectionGuard::open(&counter);
        assert_eq!(counter.load(Ordering::Acquire), 1);
        drop(guard);
        assert_eq!(counter.load(Ordering::Acquire), 0);
    }

    #[test]
    fn per_tunnel_and_global_connection_caps_are_atomic() {
        let global = Arc::new(Semaphore::new(2));
        let first = test_counters(Arc::clone(&global), 1);
        let second = test_counters(Arc::clone(&global), 2);

        let first_lease = first.try_open_connection().unwrap();
        assert!(matches!(
            first.try_open_connection(),
            Err(ConnectionAdmissionError::TunnelLimit)
        ));
        assert_eq!(first.connections.load(Ordering::Acquire), 1);

        let second_lease = second.try_open_connection().unwrap();
        assert!(matches!(
            second.try_open_connection(),
            Err(ConnectionAdmissionError::GlobalLimit)
        ));
        assert_eq!(global.available_permits(), 0);

        drop(first_lease);
        let replacement = second.try_open_connection().unwrap();
        assert_eq!(first.connections.load(Ordering::Acquire), 0);
        assert_eq!(second.connections.load(Ordering::Acquire), 2);

        drop(second_lease);
        drop(replacement);
        assert_eq!(global.available_permits(), 2);
        assert_eq!(second.connections.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn stop_cancels_and_drains_pending_connection_tasks() {
        struct DropProbe(Arc<AtomicBool>);
        impl Drop for DropProbe {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Release);
            }
        }

        let global = Arc::new(Semaphore::new(1));
        let counters = test_counters(Arc::clone(&global), 1);
        let lease = counters.try_open_connection().unwrap();
        let dropped = Arc::new(AtomicBool::new(false));
        let task_dropped = Arc::clone(&dropped);
        let task = tokio::spawn(lease.run(async move {
            let _probe = DropProbe(task_dropped);
            std::future::pending::<()>().await;
        }));
        tokio::task::yield_now().await;
        assert_eq!(counters.connections.load(Ordering::Acquire), 1);

        counters.seal_connections();
        tokio::time::timeout(Duration::from_secs(1), counters.wait_for_connections())
            .await
            .expect("connection drain should not hang");
        // The barrier itself, not joining a detached task afterwards, must
        // prove every observable resource has already been released.
        assert!(dropped.load(Ordering::Acquire));
        assert_eq!(counters.connections.load(Ordering::Acquire), 0);
        assert_eq!(global.available_permits(), 1);
        assert!(matches!(
            counters.try_open_connection(),
            Err(ConnectionAdmissionError::Stopping)
        ));
        task.await.unwrap();
    }

    #[tokio::test]
    async fn start_stage_deadline_and_sticky_stop_both_cancel_work() {
        let (stop_tx, mut stop_rx) = watch::channel(false);
        let timeout_error = run_start_stage(
            &mut stop_rx,
            Duration::from_millis(10),
            "connect:test stage timed out".to_string(),
            std::future::pending::<Result<(), String>>(),
        )
        .await
        .unwrap_err();
        assert_eq!(timeout_error, "connect:test stage timed out");

        stop_tx.send_replace(true);
        let cancelled = run_start_stage(
            &mut stop_rx,
            Duration::from_secs(1),
            "unused".to_string(),
            std::future::pending::<Result<(), String>>(),
        )
        .await
        .unwrap_err();
        assert!(cancelled.contains("cancelled"));
    }

    #[tokio::test]
    async fn socks5_slow_reads_and_stalled_writes_hit_one_total_deadline() {
        let (mut slow_client, mut slow_server) = tokio::io::duplex(16);
        slow_client.write_all(&[0x05]).await.unwrap();
        assert_eq!(
            socks5_read_target_with_deadline(&mut slow_server, Duration::from_millis(20)).await,
            None
        );

        let (mut stalled_client, mut stalled_server) = tokio::io::duplex(1);
        let writer = tokio::spawn(async move {
            let _ = stalled_client.write_all(&[0x05, 0x01, 0x00]).await;
            std::future::pending::<()>().await;
        });
        assert_eq!(
            socks5_read_target_with_deadline(&mut stalled_server, Duration::from_millis(20),).await,
            None
        );
        writer.abort();
        let _ = writer.await;
    }

    #[tokio::test]
    async fn socks5_connect_to_an_ipv4_address_is_parsed() {
        let (mut client, mut server) = tokio::io::duplex(256);

        let negotiation = tokio::spawn(async move { socks5_read_target(&mut server).await });

        // Greeting: version 5, one method, no-auth.
        client.write_all(&[0x05, 0x01, 0x00]).await.unwrap();
        let mut chosen = [0u8; 2];
        client.read_exact(&mut chosen).await.unwrap();
        assert_eq!(chosen, [0x05, 0x00]);

        // CONNECT 10.1.2.3:443 over IPv4.
        client
            .write_all(&[0x05, 0x01, 0x00, 0x01, 10, 1, 2, 3, 0x01, 0xBB])
            .await
            .unwrap();

        let target = negotiation.await.unwrap();
        assert_eq!(target, Some(("10.1.2.3".to_string(), 443)));
    }

    #[tokio::test]
    async fn socks5_connect_to_a_domain_name_is_parsed() {
        let (mut client, mut server) = tokio::io::duplex(256);

        let negotiation = tokio::spawn(async move { socks5_read_target(&mut server).await });

        client.write_all(&[0x05, 0x01, 0x00]).await.unwrap();
        let mut chosen = [0u8; 2];
        client.read_exact(&mut chosen).await.unwrap();

        let mut request = vec![0x05, 0x01, 0x00, 0x03, 11];
        request.extend_from_slice(b"example.com");
        request.extend_from_slice(&80u16.to_be_bytes());
        client.write_all(&request).await.unwrap();

        let target = negotiation.await.unwrap();
        assert_eq!(target, Some(("example.com".to_string(), 80)));
    }

    #[tokio::test]
    async fn socks5_rejects_empty_control_or_oversized_domain_names() {
        for name in [Vec::new(), b"bad\nname".to_vec(), vec![b'a'; 254]] {
            let (mut client, mut server) = tokio::io::duplex(512);
            let negotiation = tokio::spawn(async move { socks5_read_target(&mut server).await });

            client.write_all(&[0x05, 0x01, 0x00]).await.unwrap();
            let mut chosen = [0u8; 2];
            client.read_exact(&mut chosen).await.unwrap();

            let mut request = vec![0x05, 0x01, 0x00, 0x03, name.len() as u8];
            request.extend_from_slice(&name);
            request.extend_from_slice(&80u16.to_be_bytes());
            client.write_all(&request).await.unwrap();

            assert_eq!(negotiation.await.unwrap(), None);
            let mut refusal = [0u8; 10];
            client.read_exact(&mut refusal).await.unwrap();
            assert_eq!(refusal[1], SOCKS_ADDRESS_NOT_SUPPORTED);
        }
    }

    #[tokio::test]
    async fn socks5_rejects_invalid_request_headers_and_zero_ports() {
        for request in [
            [0x04, 0x01, 0x00, 0x01, 127, 0, 0, 1, 0x00, 0x50],
            [0x05, 0x01, 0x01, 0x01, 127, 0, 0, 1, 0x00, 0x50],
            [0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, 0x00, 0x00],
        ] {
            let (mut client, mut server) = tokio::io::duplex(64);
            let negotiation = tokio::spawn(async move { socks5_read_target(&mut server).await });

            client.write_all(&[0x05, 0x01, 0x00]).await.unwrap();
            let mut chosen = [0u8; 2];
            client.read_exact(&mut chosen).await.unwrap();
            client.write_all(&request).await.unwrap();

            assert_eq!(negotiation.await.unwrap(), None);
            let mut refusal = [0u8; 10];
            client.read_exact(&mut refusal).await.unwrap();
            assert_eq!(refusal[1], SOCKS_GENERAL_FAILURE);
        }
    }

    #[tokio::test]
    async fn socks5_refuses_commands_other_than_connect() {
        let (mut client, mut server) = tokio::io::duplex(256);

        let negotiation = tokio::spawn(async move { socks5_read_target(&mut server).await });

        client.write_all(&[0x05, 0x01, 0x00]).await.unwrap();
        let mut chosen = [0u8; 2];
        client.read_exact(&mut chosen).await.unwrap();

        // BIND (0x02) is not supported.
        client
            .write_all(&[0x05, 0x02, 0x00, 0x01, 127, 0, 0, 1, 0x00, 0x50])
            .await
            .unwrap();

        assert_eq!(negotiation.await.unwrap(), None);

        let mut reply = [0u8; 10];
        client.read_exact(&mut reply).await.unwrap();
        assert_eq!(reply[1], SOCKS_COMMAND_NOT_SUPPORTED);
    }

    #[tokio::test]
    async fn socks5_refuses_clients_that_cannot_skip_authentication() {
        let (mut client, mut server) = tokio::io::duplex(256);

        let negotiation = tokio::spawn(async move { socks5_read_target(&mut server).await });

        // Only username/password (0x02) offered; this proxy needs no-auth.
        client.write_all(&[0x05, 0x01, 0x02]).await.unwrap();

        assert_eq!(negotiation.await.unwrap(), None);

        let mut refusal = [0u8; 2];
        client.read_exact(&mut refusal).await.unwrap();
        assert_eq!(refusal, [0x05, 0xFF]);
    }

    #[tokio::test]
    async fn counted_copy_records_every_byte() {
        let counter = AtomicU64::new(0);
        let mut source: &[u8] = b"twelve bytes";
        let mut sink_buffer = Vec::new();

        copy_counted(&mut source, &mut sink_buffer, &counter).await;

        assert_eq!(sink_buffer, b"twelve bytes");
        assert_eq!(counter.load(Ordering::Relaxed), 12);
    }

    #[test]
    fn a_missing_verdict_reports_the_transport_error() {
        let error = connect_error(None, "connection refused".into());
        assert_eq!(error, "connect:connection refused");
    }

    #[test]
    fn an_unknown_host_key_is_a_trust_error_not_a_transport_error() {
        let error = connect_error(
            Some(TrustVerdict::Unknown {
                host: "gateway.example.com".into(),
                port: 22,
                algorithm: "ssh-ed25519".into(),
                fingerprint: "SHA256:abc".into(),
            }),
            "unused".into(),
        );
        assert!(error.starts_with("trust:"));
        assert!(error.contains("SHA256:abc"));
    }
}
