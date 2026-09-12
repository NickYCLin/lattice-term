//! Tauri bridge for Lattice Remote.
//!
//! Pairing secrets cross IPC for one call and are never placed in the
//! registry. The registry retains only public session metadata, bounded writer
//! state, file-transfer progress, admission permits, and a task supervisor
//! handle. Frames and files are already encrypted on the wire before they
//! reach here.

use crate::remote_files::{
    RemoteDirectory, RemoteFileTransfer, RemoteFilesClient, RemoteTextDocument,
};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use lattice_remote::relay::{
    dial, format_device_id, normalize_device_id, normalize_relay_endpoint, RelayError,
};
use lattice_remote::{
    negotiate_protocol_version, normalize_viewer_pairing_code, FrameAssembler, PointerButton,
    RemoteHello, RemoteInput, RemoteMessage, SecureConnection, MAX_WHEEL_UNITS,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, oneshot, OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinHandle;
use tokio::time::timeout;
use zeroize::{Zeroize, Zeroizing};

static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);
static NEXT_SESSION_GENERATION: AtomicU64 = AtomicU64::new(1);
static NEXT_RESERVATION: AtomicU64 = AtomicU64::new(1);
const MAX_REMOTE_SESSIONS: usize = 32;
const REMOTE_TERMINAL_TAIL_BYTES: usize = 256 * 1024;
const REMOTE_CLOSE_SEND_TIMEOUT: Duration = Duration::from_millis(250);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConnectRequest {
    pub profile_id: String,
    #[serde(default)]
    pub hostname: String,
    #[serde(default)]
    pub port: u16,
    /// One-call secret. Never copied into a session record or event.
    pub pairing_code: String,
    #[serde(default)]
    pub use_saved_pairing_code: bool,
    #[serde(default)]
    pub remember_pairing_code: bool,
    #[serde(default)]
    pub legacy_pairing: bool,
    /// When set, the connection goes through a relay by nine-digit device ID
    /// instead of dialing hostname:port directly.
    #[serde(default)]
    pub device_id: String,
    #[serde(default)]
    pub relay_address: String,
}

impl Drop for RemoteConnectRequest {
    fn drop(&mut self) {
        self.pairing_code.zeroize();
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSessionSummary {
    pub session_id: String,
    pub profile_id: String,
    pub host: String,
    pub port: u16,
    /// True when the session reached the host by device ID over a relay.
    pub via_relay: bool,
    pub agent_name: String,
    pub width: u32,
    pub height: u32,
    pub view_only: bool,
    pub file_transfer: bool,
    pub file_edit: bool,
    pub file_root_label: String,
    /// True when the agent shares a shell (headless host) instead of a display.
    pub terminal: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTerminalSnapshot {
    pub session_id: String,
    pub start_offset: u64,
    pub end_offset: u64,
    pub base64: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum RemoteConnectOutcome {
    Connected {
        #[serde(flatten)]
        session: RemoteSessionSummary,
    },
    Failed {
        stage: &'static str,
        detail: String,
    },
}

/// One control action from the viewer. Mirrors the browser event shapes the
/// RDP/VNC panes already emit, so the same pointer/keyboard handlers apply.
#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RemoteInputRequest {
    MouseMove {
        x: u16,
        y: u16,
    },
    /// Browser button numbers: 0 left, 1 middle, 2 right.
    MouseButton {
        button: u8,
        pressed: bool,
    },
    Wheel {
        horizontal: bool,
        units: i32,
    },
    Key {
        keysym: u32,
        pressed: bool,
    },
    ReleaseAll,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteFrameEvent {
    session_id: String,
    frame_id: u64,
    width: u32,
    height: u32,
    mime_type: &'static str,
    base64: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteClosedEvent {
    session_id: String,
    reason: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteTerminalEvent {
    session_id: String,
    /// Absolute byte offset of the first byte in this chunk.
    offset: u64,
    /// Raw PTY bytes; base64 keeps multi-byte characters split across reads
    /// intact until the frontend decodes them.
    base64: String,
}

#[derive(Debug, Default)]
struct RemoteTerminalOutput {
    start_offset: u64,
    end_offset: u64,
    bytes: VecDeque<u8>,
}

impl RemoteTerminalOutput {
    fn append(&mut self, bytes: &[u8]) -> Result<u64, String> {
        let offset = self.end_offset;
        let chunk_len = u64::try_from(bytes.len())
            .map_err(|_| "The remote terminal chunk is too large.".to_string())?;
        let end_offset = self
            .end_offset
            .checked_add(chunk_len)
            .ok_or_else(|| "The remote terminal output offset overflowed.".to_string())?;
        self.end_offset = end_offset;
        self.bytes.extend(bytes.iter().copied());

        let overflow = self.bytes.len().saturating_sub(REMOTE_TERMINAL_TAIL_BYTES);
        if overflow > 0 {
            self.bytes.drain(..overflow);
        }
        // The retained length is capped at 256 KiB and therefore always fits.
        self.start_offset = self.end_offset - self.bytes.len() as u64;
        Ok(offset)
    }

    fn snapshot(&self, session_id: String) -> RemoteTerminalSnapshot {
        RemoteTerminalSnapshot {
            session_id,
            start_offset: self.start_offset,
            end_offset: self.end_offset,
            base64: BASE64.encode(self.bytes.iter().copied().collect::<Vec<_>>()),
        }
    }
}

struct RemoteReaderStart {
    sender: oneshot::Sender<()>,
}

struct RemoteReaderGate {
    receiver: oneshot::Receiver<()>,
}

fn remote_reader_start_gate() -> (RemoteReaderStart, RemoteReaderGate) {
    let (sender, receiver) = oneshot::channel();
    (RemoteReaderStart { sender }, RemoteReaderGate { receiver })
}

impl RemoteReaderStart {
    fn open(self) -> Result<(), ()> {
        self.sender.send(())
    }
}

impl RemoteReaderGate {
    async fn wait(self) -> Result<(), ()> {
        self.receiver.await.map_err(|_| ())
    }
}

struct RemoteSessionRecord {
    summary: RemoteSessionSummary,
    generation: u64,
    supervisor: JoinHandle<()>,
    shutdown: oneshot::Sender<()>,
    outbound: mpsc::Sender<RemoteMessage>,
    files: Option<Arc<RemoteFilesClient>>,
    terminal_output: Option<RemoteTerminalOutput>,
    admission: OwnedSemaphorePermit,
}

struct PendingRemoteSessionRecord {
    summary: RemoteSessionSummary,
    generation: u64,
    supervisor: JoinHandle<()>,
    shutdown: oneshot::Sender<()>,
    outbound: mpsc::Sender<RemoteMessage>,
    files: Option<Arc<RemoteFilesClient>>,
}

#[derive(Clone)]
struct RemoteSessionAccess {
    summary: RemoteSessionSummary,
    outbound: mpsc::Sender<RemoteMessage>,
    files: Option<Arc<RemoteFilesClient>>,
}

#[derive(Default)]
struct RemoteRegistryState {
    sessions: HashMap<String, RemoteSessionRecord>,
    pending_profiles: HashMap<String, u64>,
}

pub struct RemoteRegistry {
    state: Mutex<RemoteRegistryState>,
    admission: Arc<Semaphore>,
}

impl Default for RemoteRegistry {
    fn default() -> Self {
        Self {
            state: Mutex::new(RemoteRegistryState::default()),
            admission: Arc::new(Semaphore::new(MAX_REMOTE_SESSIONS)),
        }
    }
}

struct RemoteConnectReservation {
    registry: Arc<RemoteRegistry>,
    profile_id: String,
    token: u64,
    permit: Option<OwnedSemaphorePermit>,
}

impl Drop for RemoteConnectReservation {
    fn drop(&mut self) {
        if self.permit.is_none() {
            return;
        }
        if let Ok(mut state) = self.registry.state.lock() {
            if state.pending_profiles.get(&self.profile_id) == Some(&self.token) {
                state.pending_profiles.remove(&self.profile_id);
            }
        }
        // The owned permit is released after this method returns. Keeping it
        // until the token-specific pending entry is gone prevents another
        // attempt from observing a slot without a matching reservation.
    }
}

impl RemoteRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn reserve(self: &Arc<Self>, profile_id: String) -> Result<RemoteConnectReservation, String> {
        let permit = Arc::clone(&self.admission)
            .try_acquire_owned()
            .map_err(|_| {
                format!(
                    "At most {MAX_REMOTE_SESSIONS} Lattice Remote sessions can be connecting or connected at once."
                )
            })?;
        let token = NEXT_RESERVATION.fetch_add(1, Ordering::Relaxed);
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        if state.pending_profiles.contains_key(&profile_id)
            || state
                .sessions
                .values()
                .any(|record| record.summary.profile_id == profile_id)
        {
            return Err(format!(
                "A Lattice Remote session for profile '{profile_id}' is already connecting or connected."
            ));
        }
        state.pending_profiles.insert(profile_id.clone(), token);
        drop(state);
        Ok(RemoteConnectReservation {
            registry: Arc::clone(self),
            profile_id,
            token,
            permit: Some(permit),
        })
    }

    fn commit(
        &self,
        reservation: &mut RemoteConnectReservation,
        pending: &mut Option<PendingRemoteSessionRecord>,
    ) -> Result<(), String> {
        if !std::ptr::eq(self, Arc::as_ptr(&reservation.registry)) {
            return Err(
                "The remote connection reservation belongs to another registry.".to_string(),
            );
        }
        let pending_record = pending
            .as_ref()
            .ok_or_else(|| "The remote session has already been registered.".to_string())?;
        if pending_record.summary.profile_id != reservation.profile_id {
            return Err("The remote session profile does not match its reservation.".to_string());
        }
        if reservation.permit.is_none() {
            return Err("The remote connection reservation is no longer active.".to_string());
        }

        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        if state.pending_profiles.get(&reservation.profile_id) != Some(&reservation.token) {
            return Err("The remote connection reservation is no longer active.".to_string());
        }
        if state
            .sessions
            .contains_key(&pending_record.summary.session_id)
        {
            return Err(format!(
                "Lattice Remote session '{}' is already connected.",
                pending_record.summary.session_id
            ));
        }
        if state
            .sessions
            .values()
            .any(|record| record.summary.profile_id == reservation.profile_id)
        {
            return Err(format!(
                "A Lattice Remote session for profile '{}' is already connected.",
                reservation.profile_id
            ));
        }

        let Some(permit) = reservation.permit.take() else {
            return Err("The remote connection reservation is no longer active.".to_string());
        };
        let Some(pending_record) = pending.take() else {
            reservation.permit = Some(permit);
            return Err("The remote session has already been registered.".to_string());
        };
        state.pending_profiles.remove(&reservation.profile_id);
        let terminal_output = pending_record
            .summary
            .terminal
            .then(RemoteTerminalOutput::default);
        state.sessions.insert(
            pending_record.summary.session_id.clone(),
            RemoteSessionRecord {
                summary: pending_record.summary,
                generation: pending_record.generation,
                supervisor: pending_record.supervisor,
                shutdown: pending_record.shutdown,
                outbound: pending_record.outbound,
                files: pending_record.files,
                terminal_output,
                admission: permit,
            },
        );
        Ok(())
    }

    fn append_terminal(
        &self,
        session_id: &str,
        generation: u64,
        bytes: &[u8],
    ) -> Result<u64, String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        let record = state
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("Lattice Remote session '{session_id}' is not connected."))?;
        if record.generation != generation {
            return Err("The remote session was replaced by a newer connection.".to_string());
        }
        let output = record.terminal_output.as_mut().ok_or_else(|| {
            "The Agent sent terminal data without advertising a terminal session.".to_string()
        })?;
        output.append(bytes)
    }

    fn access(&self, session_id: &str) -> Result<RemoteSessionAccess, String> {
        self.state
            .lock()
            .map_err(|error| error.to_string())?
            .sessions
            .get(session_id)
            .map(|record| RemoteSessionAccess {
                summary: record.summary.clone(),
                outbound: record.outbound.clone(),
                files: record.files.clone(),
            })
            .ok_or_else(|| format!("Lattice Remote session '{session_id}' is not connected."))
    }

    fn remove(&self, session_id: &str) -> Result<Option<RemoteSessionRecord>, String> {
        Ok(self
            .state
            .lock()
            .map_err(|error| error.to_string())?
            .sessions
            .remove(session_id))
    }

    fn remove_if_generation(
        &self,
        session_id: &str,
        generation: u64,
    ) -> Result<Option<RemoteSessionRecord>, String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        if state
            .sessions
            .get(session_id)
            .is_some_and(|record| record.generation == generation)
        {
            Ok(state.sessions.remove(session_id))
        } else {
            Ok(None)
        }
    }

    /// Which run of this session is live: the identity an MCP screen grant
    /// binds to, so a reconnection under the same id is not the same screen.
    /// A terminal-only share has no screen to hand over.
    pub(crate) fn screen_controllable(&self, session_id: &str) -> bool {
        self.access(session_id)
            .is_ok_and(|access| !access.summary.view_only && !access.summary.terminal)
    }

    pub(crate) async fn mcp_input<F>(
        &self,
        session_id: &str,
        generation: u64,
        commands: Vec<RemoteInputRequest>,
        validate: F,
    ) -> Result<(), crate::mcp_desktop::ServiceError>
    where
        F: FnOnce() -> Result<(), crate::mcp_desktop::ServiceError>,
    {
        use crate::mcp_desktop::ServiceError;
        let access = self
            .access(session_id)
            .map_err(|_| ServiceError::unavailable())?;
        if access.summary.view_only
            || access.summary.terminal
            || commands.is_empty()
            || commands.len() > 100
        {
            return Err(ServiceError::denied());
        }
        let messages: Vec<_> = commands
            .into_iter()
            .map(|command| {
                resolve_input(command)
                    .map(RemoteMessage::Input)
                    .ok_or_else(ServiceError::invalid)
            })
            .collect::<Result<_, _>>()?;
        // Reserve the whole batch before validation. Sending the permits has
        // no await, so local input cannot interleave inside a chord or drag.
        let permits = tokio::time::timeout(
            Duration::from_secs(1),
            access.outbound.reserve_many(messages.len()),
        )
        .await
        .map_err(|_| ServiceError::new("busy", "The screen input channel is busy."))?
        .map_err(|_| ServiceError::unavailable())?;
        if self.screen_generation(session_id) != Some(generation) {
            return Err(ServiceError::unavailable());
        }
        validate()?;
        for (permit, message) in permits.zip(messages) {
            permit.send(message);
        }
        Ok(())
    }

    pub fn screen_generation(&self, session_id: &str) -> Option<u64> {
        let state = self.state.lock().ok()?;
        state
            .sessions
            .get(session_id)
            .filter(|record| !record.summary.terminal)
            .map(|record| record.generation)
    }

    pub fn list(&self) -> Vec<RemoteSessionSummary> {
        let Ok(state) = self.state.lock() else {
            return Vec::new();
        };
        let mut summaries: Vec<_> = state
            .sessions
            .values()
            .map(|record| record.summary.clone())
            .collect();
        summaries.sort_by(|left, right| left.session_id.cmp(&right.session_id));
        summaries
    }

    pub fn terminal_snapshots(&self) -> Result<Vec<RemoteTerminalSnapshot>, String> {
        let state = self.state.lock().map_err(|error| error.to_string())?;
        let mut snapshots: Vec<_> = state
            .sessions
            .iter()
            .filter_map(|(session_id, record)| {
                record
                    .terminal_output
                    .as_ref()
                    .map(|output| output.snapshot(session_id.clone()))
            })
            .collect();
        snapshots.sort_by(|left, right| left.session_id.cmp(&right.session_id));
        Ok(snapshots)
    }

    pub fn transfers(&self) -> Vec<RemoteFileTransfer> {
        let Ok(state) = self.state.lock() else {
            return Vec::new();
        };
        let mut transfers: Vec<_> = state
            .sessions
            .values()
            .filter_map(|record| record.files.as_ref())
            .flat_map(|files| files.transfers())
            .collect();
        transfers.sort_by(|left, right| left.transfer_id.cmp(&right.transfer_id));
        transfers
    }
}

fn session_id() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let sequence = NEXT_SESSION.fetch_add(1, Ordering::Relaxed);
    format!("remote-{timestamp}-{sequence}")
}

/// Which failure stage a relay dial error belongs to.
///
/// `relay` means the relay itself could not be reached or understood, which
/// points at the address the user saved; the viewer offers to correct it on
/// this stage alone. A relay that answered and rejected the dial reports
/// `connect`: there the address was right and the device was not there, so
/// inviting an address edit would send the user to fix the wrong thing.
fn relay_dial_stage(error: &RelayError) -> &'static str {
    match error {
        RelayError::Rejected { .. } => "connect",
        _ => "relay",
    }
}

fn failed(stage: &'static str, detail: impl Into<String>) -> RemoteConnectOutcome {
    RemoteConnectOutcome::Failed {
        stage,
        detail: detail.into(),
    }
}

struct RelayPinCandidate {
    path: PathBuf,
    device_id: String,
    static_key: Vec<u8>,
}

/// Waits for the first PSK-authenticated protocol message before committing a
/// relay device's TOFU pin. With Noise XXpsk3, the initiator can finish its
/// local handshake after sending message 3 even when the responder will reject
/// that message because the pairing code is wrong. The responder's encrypted
/// Hello is therefore the first proof available to the viewer that the peer
/// actually accepted the PSK.
async fn receive_authenticated_hello<S>(
    connection: &mut SecureConnection<S>,
    relay_pin: Option<RelayPinCandidate>,
) -> Result<RemoteHello, (&'static str, String)>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    let hello = match timeout(Duration::from_secs(30), connection.receive()).await {
        Ok(Ok(RemoteMessage::Hello(hello))) => hello,
        Ok(Ok(_)) => {
            return Err((
                "protocol",
                "The Agent did not send its identity first.".to_string(),
            ))
        }
        Ok(Err(_)) => {
            return Err((
                "pairing",
                "The pairing code was rejected by the Agent.".to_string(),
            ))
        }
        Err(_) => {
            return Err((
                "protocol",
                "The Agent did not start screen sharing in time.".to_string(),
            ))
        }
    };
    // Talk down to an older Agent rather than refusing it. A machine that is
    // behind has to stay reachable, or nobody can connect to it to update it.
    // The message names which side to update, since "incompatible" alone
    // leaves the operator guessing.
    if let Err(mismatch) = negotiate_protocol_version(hello.protocol_version) {
        return Err(("protocol", mismatch.to_string()));
    }

    if let Some(candidate) = relay_pin {
        crate::remote_pins::verify_or_pin(
            &candidate.path,
            &candidate.device_id,
            &candidate.static_key,
        )
        .map_err(|detail| ("pinning", detail))?;
    }
    Ok(hello)
}

fn remote_task_reason(
    task: &'static str,
    result: Result<String, tokio::task::JoinError>,
) -> String {
    match result {
        Ok(reason) => reason,
        Err(error) if error.is_cancelled() => format!("The remote {task} task was cancelled."),
        Err(error) => format!("The remote {task} task failed: {error}"),
    }
}

/// Owns both encrypted halves and gives every shutdown path exactly one place
/// that aborts and awaits them. `JoinHandle` completion is sticky, so a writer
/// failure wakes this supervisor even when the reader has no incoming bytes.
async fn supervise_remote_tasks(
    mut reader: JoinHandle<String>,
    mut writer: JoinHandle<String>,
    mut shutdown: oneshot::Receiver<()>,
) -> Option<String> {
    enum RemoteTaskExit {
        Reader(Result<String, tokio::task::JoinError>),
        Writer(Result<String, tokio::task::JoinError>),
        Shutdown,
    }

    let exit = tokio::select! {
        result = &mut reader => RemoteTaskExit::Reader(result),
        result = &mut writer => RemoteTaskExit::Writer(result),
        _ = &mut shutdown => RemoteTaskExit::Shutdown,
    };
    match exit {
        RemoteTaskExit::Reader(result) => {
            writer.abort();
            let _ = writer.await;
            Some(remote_task_reason("reader", result))
        }
        RemoteTaskExit::Writer(result) => {
            reader.abort();
            let _ = reader.await;
            Some(remote_task_reason("writer", result))
        }
        RemoteTaskExit::Shutdown => {
            reader.abort();
            writer.abort();
            let _ = reader.await;
            let _ = writer.await;
            None
        }
    }
}

async fn stop_pending_remote_session(record: PendingRemoteSessionRecord, reason: &str) {
    if let Some(files) = &record.files {
        files.close(reason);
    }
    let PendingRemoteSessionRecord {
        supervisor,
        shutdown,
        outbound,
        files,
        ..
    } = record;
    let _ = shutdown.send(());
    drop(outbound);
    drop(files);
    let _ = supervisor.await;
}

async fn stop_remote_session(
    record: RemoteSessionRecord,
    reason: &str,
    close_send_timeout: Duration,
) {
    if let Some(files) = &record.files {
        files.close(reason);
    }
    let RemoteSessionRecord {
        supervisor,
        shutdown,
        outbound,
        files,
        admission,
        ..
    } = record;
    let _ = timeout(
        close_send_timeout,
        outbound.send(RemoteMessage::Close(reason.to_string())),
    )
    .await;
    let _ = shutdown.send(());
    drop(outbound);
    drop(files);
    let _ = supervisor.await;
    // Keep the global slot occupied through the last task join.
    drop(admission);
}

pub async fn connect(
    app: AppHandle,
    registry: Arc<RemoteRegistry>,
    request: RemoteConnectRequest,
) -> RemoteConnectOutcome {
    let device_id = if request.device_id.trim().is_empty() {
        None
    } else {
        match normalize_device_id(&request.device_id) {
            Ok(device_id) => Some(device_id),
            Err(error) => return failed("connect", error.to_string()),
        }
    };
    let via_relay = device_id.is_some();
    if request.profile_id.trim().is_empty() || (!via_relay && request.hostname.trim().is_empty()) {
        return failed("connect", "The connection target is incomplete.");
    }
    let pairing_code = match if request.legacy_pairing {
        lattice_remote::normalize_legacy_pairing_code(&request.pairing_code)
    } else {
        normalize_viewer_pairing_code(&request.pairing_code)
    } {
        Ok(code) => Zeroizing::new(code),
        Err(error) => return failed("pairing", error.to_string()),
    };
    let trusted_device = if let Some(device_id) = &device_id {
        let path = match app.path().app_data_dir() {
            Ok(base) => base.join(crate::remote_pins::PINS_FILE),
            Err(error) => {
                return failed(
                    "pinning",
                    format!("Cannot locate the app data folder: {error}"),
                )
            }
        };
        let pin = match crate::remote_pins::pinned_fingerprint(&path, device_id) {
            Ok(pin) => pin,
            Err(error) => return failed("pinning", error),
        };
        Some((path, pin))
    } else {
        None
    };
    let expected_pin = trusted_device.as_ref().and_then(|(_, pin)| pin.as_deref());
    if request.legacy_pairing && pairing_code.len() == 8 && expected_pin.is_none() {
        return failed(
            "legacyTrust",
            lattice_remote::RemoteError::LegacyRequiresTrustedDevice.to_string(),
        );
    }
    // Admission covers dialing, the Noise handshake, authenticated Hello, and
    // the live session. Reserving the profile in the same critical section
    // also preserves the product's one-active-session-per-profile contract.
    let mut reservation = match registry.reserve(request.profile_id.clone()) {
        Ok(reservation) => reservation,
        Err(error) => return failed("session", error),
    };

    let mut connection = if let Some(device_id) = &device_id {
        // "relay" means the relay itself could not be reached or understood,
        // which points at the address; a relay that answers and rejects the
        // dial keeps "connect", because there the address was right and the
        // far machine was simply not there. The caller offers to correct a
        // saved address only on the former.
        let relay_endpoint = match normalize_relay_endpoint(&request.relay_address) {
            Ok(endpoint) => endpoint,
            Err(error) => return failed("relay", error.to_string()),
        };
        let stream = match timeout(Duration::from_secs(15), dial(&relay_endpoint, device_id)).await
        {
            Ok(Ok((stream, _agent_name))) => stream,
            Ok(Err(error)) => {
                let stage = relay_dial_stage(&error);
                let detail = match error {
                    RelayError::Rejected { detail, .. } => detail,
                    other => other.to_string(),
                };
                return failed(stage, detail);
            }
            Err(_) => return failed("relay", "The relay did not answer within 15 seconds."),
        };
        match timeout(Duration::from_secs(12), async {
            if request.legacy_pairing {
                SecureConnection::initiate_for_device(stream, &pairing_code, expected_pin).await
            } else {
                SecureConnection::initiate_for_target(
                    stream,
                    &pairing_code,
                    expected_pin,
                    Some(device_id),
                )
                .await
            }
        })
        .await
        {
            Ok(Ok(connection)) => connection,
            Ok(Err(error)) => {
                return failed(
                    if matches!(error, lattice_remote::RemoteError::PeerIdentityMismatch) {
                        "identityChanged"
                    } else {
                        "pairing"
                    },
                    error.to_string(),
                )
            }
            Err(_) => return failed("connect", "The Agent did not answer within 12 seconds."),
        }
    } else {
        match timeout(Duration::from_secs(12), async {
            if request.legacy_pairing {
                let stream =
                    tokio::net::TcpStream::connect((request.hostname.as_str(), request.port))
                        .await?;
                stream.set_nodelay(true)?;
                SecureConnection::initiate_for_device(
                    lattice_remote::Transport::from(stream),
                    &pairing_code,
                    None,
                )
                .await
            } else {
                SecureConnection::connect(request.hostname.as_str(), request.port, &pairing_code)
                    .await
            }
        })
        .await
        {
            Ok(Ok(connection)) => connection,
            Ok(Err(error)) => return failed("pairing", error.to_string()),
            Err(_) => return failed("connect", "The Agent did not answer within 12 seconds."),
        }
    };

    // Keep the presented relay identity in memory until an encrypted Hello
    // proves that the responder accepted the pairing code. In particular, do
    // not persist a first-use pin merely because the initiator produced Noise
    // handshake message 3.
    let relay_pin = if let (Some(device_id), Some((pins_path, _))) = (&device_id, trusted_device) {
        let Some(static_key) = connection.remote_static_key() else {
            return failed("pinning", "The Agent did not present an identity key.");
        };
        Some(RelayPinCandidate {
            path: pins_path,
            device_id: device_id.clone(),
            static_key,
        })
    } else {
        None
    };

    let hello = match receive_authenticated_hello(&mut connection, relay_pin).await {
        Ok(hello) => hello,
        Err((stage, detail)) => return failed(stage, detail),
    };

    let session = RemoteSessionSummary {
        session_id: session_id(),
        profile_id: request.profile_id.clone(),
        host: match &device_id {
            Some(device_id) => format_device_id(device_id),
            None => request.hostname.clone(),
        },
        port: request.port,
        via_relay,
        agent_name: hello.agent_name,
        width: hello.width,
        height: hello.height,
        view_only: hello.view_only,
        file_transfer: hello.file_transfer,
        file_edit: hello.file_edit,
        file_root_label: hello.file_root_label,
        terminal: hello.terminal,
    };

    // Input and file requests share one bounded encrypted writer queue. File
    // access remains available to a view-only display session only when the
    // host advertised its independently authorised shared root.
    let generation = NEXT_SESSION_GENERATION.fetch_add(1, Ordering::Relaxed);
    let (mut reader, mut writer_half) = connection.split();
    let (outbound, mut outbound_rx) = mpsc::channel::<RemoteMessage>(128);
    let writer = tokio::spawn(async move {
        loop {
            let Some(message) = outbound_rx.recv().await else {
                break "The local remote writer was closed.".to_string();
            };
            if let Err(error) = writer_half.send(&message).await {
                break format!("The remote writer failed: {error}");
            }
        }
    });
    let files = session.file_transfer.then(|| {
        Arc::new(RemoteFilesClient::new(
            session.session_id.clone(),
            app.clone(),
            outbound.clone(),
        ))
    });

    let task_session_id = session.session_id.clone();
    let task_registry = Arc::clone(&registry);
    let task_app = app.clone();
    let task_files = files.clone();
    let (reader_start, reader_gate) = remote_reader_start_gate();
    let reader = tokio::spawn(async move {
        if reader_gate.wait().await.is_err() {
            return "The remote reader was cancelled before registration.".to_string();
        }
        let mut assembler = FrameAssembler::new();
        loop {
            match reader.receive().await {
                Ok(RemoteMessage::Close(reason)) => break reason,
                Ok(RemoteMessage::KeepAlive) => {}
                Ok(message @ RemoteMessage::FrameStart(_))
                | Ok(message @ RemoteMessage::FrameChunk { .. }) => match assembler.push(message) {
                    Ok(Some(frame)) => {
                        if let Some(frames) =
                            task_app.try_state::<Arc<crate::mcp_screen::ScreenFrames>>()
                        {
                            frames.offer(
                                &crate::mcp_screen::ScreenKey::new(
                                    crate::mcp_screen::ScreenBackend::Remote,
                                    &task_session_id,
                                    generation,
                                ),
                                frame.frame_id,
                                frame.width,
                                frame.height,
                                frame.format.mime_type(),
                                &frame.bytes,
                            );
                        }
                        let payload = RemoteFrameEvent {
                            session_id: task_session_id.clone(),
                            frame_id: frame.frame_id,
                            width: frame.width,
                            height: frame.height,
                            mime_type: frame.format.mime_type(),
                            base64: BASE64.encode(frame.bytes),
                        };
                        if task_app.emit("remote://frame", payload).is_err() {
                            break "The application window is no longer available.".to_string();
                        }
                    }
                    Ok(None) => {}
                    Err(error) => break format!("Invalid frame stream: {error}"),
                },
                Ok(RemoteMessage::TerminalData { bytes }) => {
                    let offset =
                        match task_registry.append_terminal(&task_session_id, generation, &bytes) {
                            Ok(offset) => offset,
                            Err(error) => break error,
                        };
                    let payload = RemoteTerminalEvent {
                        session_id: task_session_id.clone(),
                        offset,
                        base64: BASE64.encode(bytes),
                    };
                    if task_app.emit("remote://terminal-data", payload).is_err() {
                        break "The application window is no longer available.".to_string();
                    }
                }
                Ok(RemoteMessage::Input(_))
                | Ok(RemoteMessage::TerminalInput { .. })
                | Ok(RemoteMessage::TerminalResize { .. }) => {
                    break "The Agent echoed an input message.".to_string()
                }
                Ok(RemoteMessage::FileResponse(response)) => {
                    if let Some(files) = &task_files {
                        files.handle_response(response);
                    } else {
                        break "The Agent sent file data without advertising file sharing."
                            .to_string();
                    }
                }
                Ok(RemoteMessage::FileRequest(_)) => {
                    break "The Agent sent a viewer-only file request.".to_string()
                }
                Ok(RemoteMessage::Hello(_)) => {
                    break "The Agent sent a second identity message.".to_string()
                }
                Err(error) => break error.to_string(),
            }
        }
    });
    let supervisor_session_id = session.session_id.clone();
    let supervisor_registry = Arc::clone(&registry);
    let supervisor_app = app.clone();
    let (shutdown, shutdown_receiver) = oneshot::channel();
    let supervisor = tokio::spawn(async move {
        let Some(reason) = supervise_remote_tasks(reader, writer, shutdown_receiver).await else {
            return;
        };

        crate::mcp_screen::end_shared_screen(
            &supervisor_app,
            &crate::mcp_screen::ScreenKey::new(
                crate::mcp_screen::ScreenBackend::Remote,
                &supervisor_session_id,
                generation,
            ),
        );
        // A local disconnect removes first and owns its event. Generation
        // matching prevents an old task from mutating/removing a newer record
        // if a session identifier is ever reused.
        if let Ok(Some(record)) =
            supervisor_registry.remove_if_generation(&supervisor_session_id, generation)
        {
            if let Some(files) = &record.files {
                files.close(&reason);
            }
            let _ = supervisor_app.emit(
                "remote://closed",
                RemoteClosedEvent {
                    session_id: supervisor_session_id,
                    reason,
                },
            );
            // Both child tasks have already been joined. Dropping this record
            // releases its own supervisor handle and then the admission slot.
            drop(record);
        }
    });
    let mut pending = Some(PendingRemoteSessionRecord {
        summary: session.clone(),
        generation,
        supervisor,
        shutdown,
        outbound,
        files,
    });
    if let Err(error) = registry.commit(&mut reservation, &mut pending) {
        if let Some(record) = pending.take() {
            stop_pending_remote_session(record, &error).await;
        }
        return failed("session", error);
    }
    if reader_start.open().is_err() {
        let reason = "The remote reader could not be started.";
        if let Ok(Some(record)) = registry.remove_if_generation(&session.session_id, generation) {
            stop_remote_session(record, reason, Duration::ZERO).await;
        }
        return failed("session", reason);
    }
    RemoteConnectOutcome::Connected { session }
}

/// Sends one viewer control action to an interactive session. A view-only
/// session (no input channel) or a closed session is a no-op — the frontend
/// already gates on `viewOnly`, so this stays quiet rather than erroring.
pub async fn input(
    registry: &RemoteRegistry,
    session_id: &str,
    request: RemoteInputRequest,
) -> Result<(), String> {
    let access = registry.access(session_id)?;
    if access.summary.view_only {
        return Ok(());
    }
    if let Some(input) = resolve_input(request) {
        access
            .outbound
            .send(RemoteMessage::Input(input))
            .await
            .map_err(|_| "The remote session is no longer connected.".to_string())?;
    }
    Ok(())
}

/// Sends viewer keystrokes to a terminal-mode session. Mirrors `input`'s
/// quiet handling of view-only sessions.
pub async fn terminal_input(
    registry: &RemoteRegistry,
    session_id: &str,
    data: String,
) -> Result<(), String> {
    let access = registry.access(session_id)?;
    if access.summary.view_only || !access.summary.terminal || data.is_empty() {
        return Ok(());
    }
    // A large paste must not exceed the protocol's per-message payload limit.
    for chunk in data.into_bytes().chunks(32 * 1024) {
        access
            .outbound
            .send(RemoteMessage::TerminalInput {
                bytes: chunk.to_vec(),
            })
            .await
            .map_err(|_| "The remote session is no longer connected.".to_string())?;
    }
    Ok(())
}

pub async fn terminal_resize(
    registry: &RemoteRegistry,
    session_id: &str,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let access = registry.access(session_id)?;
    if access.summary.view_only || !access.summary.terminal {
        return Ok(());
    }
    access
        .outbound
        .send(RemoteMessage::TerminalResize { cols, rows })
        .await
        .map_err(|_| "The remote session is no longer connected.".to_string())
}

fn file_access(registry: &RemoteRegistry, session_id: &str) -> Result<RemoteSessionAccess, String> {
    let access = registry.access(session_id)?;
    if access.files.is_none() {
        return Err("The remote host did not enable file sharing.".to_string());
    }
    Ok(access)
}

pub async fn file_list(
    registry: &RemoteRegistry,
    session_id: &str,
    path: String,
) -> Result<RemoteDirectory, String> {
    let access = file_access(registry, session_id)?;
    access
        .files
        .expect("file access checked")
        .list(&access.outbound, path)
        .await
}

fn text_file_access(
    registry: &RemoteRegistry,
    session_id: &str,
) -> Result<RemoteSessionAccess, String> {
    let access = file_access(registry, session_id)?;
    if !access.summary.file_edit {
        return Err("This remote host does not support text editing. Update LatticeTerm on the sharing device and reconnect.".into());
    }
    Ok(access)
}

pub async fn file_read_text(
    registry: &RemoteRegistry,
    session_id: &str,
    path: String,
) -> Result<RemoteTextDocument, String> {
    text_file_access(registry, session_id)?
        .files
        .expect("file access checked")
        .read_text(path)
        .await
}

pub async fn file_save_text(
    registry: &RemoteRegistry,
    session_id: &str,
    path: String,
    content: String,
    revision: String,
) -> Result<RemoteTextDocument, String> {
    text_file_access(registry, session_id)?
        .files
        .expect("file access checked")
        .save_text(path, content, revision)
        .await
}

pub async fn file_download_start(
    registry: &RemoteRegistry,
    session_id: &str,
    path: String,
) -> Result<RemoteFileTransfer, String> {
    let access = file_access(registry, session_id)?;
    access
        .files
        .expect("file access checked")
        .download_start(&access.outbound, path)
        .await
}

pub async fn file_upload_begin(
    registry: &RemoteRegistry,
    session_id: &str,
    parent: String,
    name: String,
    size: u64,
    overwrite: bool,
) -> Result<RemoteFileTransfer, String> {
    let access = file_access(registry, session_id)?;
    access
        .files
        .expect("file access checked")
        .upload_begin(&access.outbound, parent, name, size, overwrite)
        .await
}

pub async fn file_upload_chunk(
    registry: &RemoteRegistry,
    session_id: &str,
    transfer_id: &str,
    data: &str,
) -> Result<(), String> {
    let access = file_access(registry, session_id)?;
    access
        .files
        .expect("file access checked")
        .upload_chunk(&access.outbound, transfer_id, data)
        .await
}

pub async fn file_upload_finish(
    registry: &RemoteRegistry,
    session_id: &str,
    transfer_id: &str,
) -> Result<(), String> {
    let access = file_access(registry, session_id)?;
    access
        .files
        .expect("file access checked")
        .upload_finish(&access.outbound, transfer_id)
        .await
}

pub async fn file_transfer_cancel(
    registry: &RemoteRegistry,
    session_id: &str,
    transfer_id: &str,
) -> Result<(), String> {
    let access = file_access(registry, session_id)?;
    access
        .files
        .expect("file access checked")
        .cancel(&access.outbound, transfer_id)
        .await
}

pub fn file_transfer_dismiss(
    registry: &RemoteRegistry,
    session_id: &str,
    transfer_id: &str,
) -> Result<(), String> {
    let access = file_access(registry, session_id)?;
    access
        .files
        .expect("file access checked")
        .dismiss(transfer_id)
}

/// Converts a browser-shaped request into a protocol input, dropping anything
/// the wire cannot carry (unknown button, zero-distance scroll).
fn resolve_input(request: RemoteInputRequest) -> Option<RemoteInput> {
    match request {
        RemoteInputRequest::MouseMove { x, y } => Some(RemoteInput::MouseMove { x, y }),
        RemoteInputRequest::MouseButton { button, pressed } => {
            let button = match button {
                0 => PointerButton::Left,
                1 => PointerButton::Middle,
                2 => PointerButton::Right,
                _ => return None,
            };
            Some(RemoteInput::MouseButton { button, pressed })
        }
        RemoteInputRequest::Wheel { horizontal, units } => {
            if units == 0 {
                return None;
            }
            let limit = i32::from(MAX_WHEEL_UNITS);
            let clamped = units.clamp(-limit, limit) as i8;
            Some(RemoteInput::Wheel {
                horizontal,
                units: clamped,
            })
        }
        RemoteInputRequest::Key { keysym, pressed } => Some(RemoteInput::Key { keysym, pressed }),
        RemoteInputRequest::ReleaseAll => Some(RemoteInput::ReleaseAll),
    }
}

pub async fn disconnect(
    app: &AppHandle,
    registry: &RemoteRegistry,
    session_id: &str,
) -> Result<(), String> {
    if let Some(record) = registry.remove(session_id)? {
        crate::mcp_screen::end_shared_screen(
            app,
            &crate::mcp_screen::ScreenKey::new(
                crate::mcp_screen::ScreenBackend::Remote,
                session_id,
                record.generation,
            ),
        );
        let reason = "Disconnected by the local user.";
        stop_remote_session(record, reason, REMOTE_CLOSE_SEND_TIMEOUT).await;
        let _ = app.emit(
            "remote://closed",
            RemoteClosedEvent {
                session_id: session_id.to_string(),
                reason: reason.to_string(),
            },
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use lattice_remote::relay::DeviceIdentity;
    use lattice_remote::{MIN_COMPATIBLE_PROTOCOL_VERSION, PROTOCOL_VERSION};
    use std::future::pending;
    use std::sync::atomic::AtomicBool;
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::Barrier;

    #[test]
    fn only_an_unreachable_relay_blames_the_address() {
        // The viewer offers to correct a saved relay address on this stage
        // alone, so the split has to survive edits to the dial path.
        assert_eq!(
            relay_dial_stage(&RelayError::Io(std::io::Error::from(
                std::io::ErrorKind::ConnectionRefused
            ))),
            "relay"
        );
        assert_eq!(relay_dial_stage(&RelayError::Closed), "relay");
        assert_eq!(relay_dial_stage(&RelayError::Protocol), "relay");
        assert_eq!(relay_dial_stage(&RelayError::InvalidRelayAddress), "relay");

        // The relay answered, so the address was right and the device simply
        // was not registered there.
        assert_eq!(
            relay_dial_stage(&RelayError::Rejected {
                code: "offline".to_string(),
                detail: "That device is not connected.".to_string(),
            }),
            "connect"
        );
    }

    fn hello(protocol_version: u16) -> RemoteHello {
        RemoteHello {
            protocol_version,
            agent_name: "Test Agent".to_string(),
            width: 80,
            height: 24,
            view_only: true,
            file_transfer: false,
            file_edit: false,
            file_root_label: String::new(),
            terminal: true,
        }
    }

    fn remote_summary(session_id: impl Into<String>, terminal: bool) -> RemoteSessionSummary {
        remote_summary_for_profile("test-profile", session_id, terminal)
    }

    fn remote_summary_for_profile(
        profile_id: impl Into<String>,
        session_id: impl Into<String>,
        terminal: bool,
    ) -> RemoteSessionSummary {
        RemoteSessionSummary {
            session_id: session_id.into(),
            profile_id: profile_id.into(),
            host: "test-host".to_string(),
            port: 443,
            via_relay: true,
            agent_name: "Test Agent".to_string(),
            width: 80,
            height: 24,
            view_only: false,
            file_transfer: false,
            file_edit: false,
            file_root_label: String::new(),
            terminal,
        }
    }

    fn pending_test_record(
        summary: RemoteSessionSummary,
        generation: u64,
        outbound: mpsc::Sender<RemoteMessage>,
        reader: JoinHandle<String>,
        writer: JoinHandle<String>,
    ) -> PendingRemoteSessionRecord {
        let (shutdown, shutdown_receiver) = oneshot::channel();
        let supervisor = tokio::spawn(async move {
            let _ = supervise_remote_tasks(reader, writer, shutdown_receiver).await;
        });
        PendingRemoteSessionRecord {
            summary,
            generation,
            supervisor,
            shutdown,
            outbound,
            files: None,
        }
    }

    fn idle_test_record(
        summary: RemoteSessionSummary,
        generation: u64,
    ) -> PendingRemoteSessionRecord {
        let (outbound, outbound_rx) = mpsc::channel(1);
        let reader = tokio::spawn(pending::<String>());
        let writer = tokio::spawn(async move {
            let _outbound_rx = outbound_rx;
            pending::<String>().await
        });
        pending_test_record(summary, generation, outbound, reader, writer)
    }

    fn register_test_record(registry: &Arc<RemoteRegistry>, record: PendingRemoteSessionRecord) {
        let profile_id = record.summary.profile_id.clone();
        let mut reservation = registry.reserve(profile_id).unwrap();
        let mut pending = Some(record);
        registry.commit(&mut reservation, &mut pending).unwrap();
        assert!(pending.is_none());
    }

    struct Dropped(Arc<AtomicBool>);

    impl Drop for Dropped {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    fn pin_candidate(path: PathBuf, connection: &SecureConnection<TcpStream>) -> RelayPinCandidate {
        RelayPinCandidate {
            path,
            device_id: "123456789".to_string(),
            static_key: connection
                .remote_static_key()
                .expect("the relay Agent presented its permanent identity"),
        }
    }

    #[test]
    fn session_ids_are_distinct_and_namespaced() {
        let first = session_id();
        let second = session_id();
        assert!(first.starts_with("remote-"));
        assert_ne!(first, second);
    }

    #[test]
    fn terminal_output_tracks_absolute_offsets_and_keeps_a_bounded_tail() {
        let mut output = RemoteTerminalOutput::default();
        assert_eq!(output.append(b"abc").unwrap(), 0);
        assert_eq!(output.append(b"def").unwrap(), 3);

        let snapshot = output.snapshot("remote-test".to_string());
        assert_eq!(snapshot.start_offset, 0);
        assert_eq!(snapshot.end_offset, 6);
        assert_eq!(BASE64.decode(snapshot.base64).unwrap(), b"abcdef");

        let mut output = RemoteTerminalOutput::default();
        let prefix = vec![b'x'; REMOTE_TERMINAL_TAIL_BYTES - 2];
        assert_eq!(output.append(&prefix).unwrap(), 0);
        assert_eq!(
            output.append(b"wxyz").unwrap(),
            u64::try_from(REMOTE_TERMINAL_TAIL_BYTES - 2).unwrap()
        );

        let snapshot = output.snapshot("remote-tail".to_string());
        assert_eq!(snapshot.start_offset, 2);
        assert_eq!(
            snapshot.end_offset,
            u64::try_from(REMOTE_TERMINAL_TAIL_BYTES + 2).unwrap()
        );
        let retained = BASE64.decode(snapshot.base64).unwrap();
        assert_eq!(retained.len(), REMOTE_TERMINAL_TAIL_BYTES);
        assert_eq!(&retained[retained.len() - 4..], b"wxyz");
    }

    #[test]
    fn terminal_output_rejects_offset_overflow_without_mutating_the_tail() {
        let mut output = RemoteTerminalOutput {
            start_offset: u64::MAX,
            end_offset: u64::MAX,
            bytes: VecDeque::new(),
        };

        assert!(output.append(b"x").is_err());
        assert_eq!(output.start_offset, u64::MAX);
        assert_eq!(output.end_offset, u64::MAX);
        assert!(output.bytes.is_empty());
    }

    #[test]
    fn terminal_event_and_snapshot_serialize_with_offsets() {
        let event = RemoteTerminalEvent {
            session_id: "remote-event".to_string(),
            offset: 42,
            base64: "YWJj".to_string(),
        };
        assert_eq!(
            serde_json::to_value(event).unwrap(),
            serde_json::json!({
                "sessionId": "remote-event",
                "offset": 42,
                "base64": "YWJj"
            })
        );

        let snapshot = RemoteTerminalSnapshot {
            session_id: "remote-snapshot".to_string(),
            start_offset: 40,
            end_offset: 43,
            base64: "YWJj".to_string(),
        };
        assert_eq!(
            serde_json::to_value(snapshot).unwrap(),
            serde_json::json!({
                "sessionId": "remote-snapshot",
                "startOffset": 40,
                "endOffset": 43,
                "base64": "YWJj"
            })
        );
    }

    #[tokio::test]
    async fn reader_waits_until_its_start_gate_opens() {
        let (start, gate) = remote_reader_start_gate();
        let passed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let task_passed = Arc::clone(&passed);
        let waiter = tokio::spawn(async move {
            gate.wait().await.unwrap();
            task_passed.store(true, Ordering::SeqCst);
        });

        tokio::task::yield_now().await;
        assert!(!passed.load(Ordering::SeqCst));
        start.open().unwrap();
        waiter.await.unwrap();
        assert!(passed.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn admission_enforces_the_pending_and_live_limit_atomically() {
        let registry = Arc::new(RemoteRegistry::new());
        register_test_record(
            &registry,
            idle_test_record(
                remote_summary_for_profile("live-profile", "remote-live", true),
                30,
            ),
        );
        let attempts = MAX_REMOTE_SESSIONS + 16;
        let barrier = Arc::new(Barrier::new(attempts));
        let mut admissions = Vec::with_capacity(attempts);

        for index in 0..attempts {
            let registry = Arc::clone(&registry);
            let barrier = Arc::clone(&barrier);
            admissions.push(tokio::spawn(async move {
                barrier.wait().await;
                registry.reserve(format!("profile-limit-{index}"))
            }));
        }

        let mut admitted = Vec::new();
        let mut rejected = 0;
        for admission in admissions {
            match admission.await.unwrap() {
                Ok(reservation) => admitted.push(reservation),
                Err(error) => {
                    assert!(error.contains("At most 32"));
                    rejected += 1;
                }
            }
        }

        assert_eq!(admitted.len(), MAX_REMOTE_SESSIONS - 1);
        assert_eq!(rejected, attempts - (MAX_REMOTE_SESSIONS - 1));
        assert_eq!(registry.admission.available_permits(), 0);
        assert_eq!(
            registry.state.lock().unwrap().pending_profiles.len(),
            MAX_REMOTE_SESSIONS - 1
        );
        assert_eq!(registry.list().len(), 1);

        drop(admitted);
        assert_eq!(
            registry.admission.available_permits(),
            MAX_REMOTE_SESSIONS - 1
        );
        assert!(registry.state.lock().unwrap().pending_profiles.is_empty());
        let record = registry.remove("remote-live").unwrap().unwrap();
        stop_remote_session(record, "test cleanup", Duration::ZERO).await;
        assert_eq!(registry.admission.available_permits(), MAX_REMOTE_SESSIONS);
    }

    #[tokio::test]
    async fn admission_serializes_concurrent_connects_for_one_profile() {
        let registry = Arc::new(RemoteRegistry::new());
        let attempts = 16;
        let barrier = Arc::new(Barrier::new(attempts));
        let mut admissions = Vec::with_capacity(attempts);
        for _ in 0..attempts {
            let registry = Arc::clone(&registry);
            let barrier = Arc::clone(&barrier);
            admissions.push(tokio::spawn(async move {
                barrier.wait().await;
                registry.reserve("shared-profile".to_string())
            }));
        }

        let mut winner = None;
        let mut rejected = 0;
        for admission in admissions {
            match admission.await.unwrap() {
                Ok(reservation) => {
                    assert!(winner.replace(reservation).is_none());
                }
                Err(error) => {
                    assert!(error.contains("already connecting or connected"));
                    rejected += 1;
                }
            }
        }
        assert_eq!(rejected, attempts - 1);
        drop(winner);

        let record = idle_test_record(
            remote_summary_for_profile("shared-profile", "remote-shared", true),
            1,
        );
        register_test_record(&registry, record);
        let error = registry
            .reserve("shared-profile".to_string())
            .err()
            .expect("a live profile rejects another connect");
        assert!(error.contains("already connecting or connected"));

        let record = registry.remove("remote-shared").unwrap().unwrap();
        stop_remote_session(record, "test cleanup", Duration::ZERO).await;
        assert_eq!(registry.admission.available_permits(), MAX_REMOTE_SESSIONS);
    }

    #[tokio::test]
    async fn failed_admission_and_registration_return_their_permits() {
        let registry = Arc::new(RemoteRegistry::new());
        let reservation = registry.reserve("failed-handshake".to_string()).unwrap();
        assert_eq!(
            registry.admission.available_permits(),
            MAX_REMOTE_SESSIONS - 1
        );
        drop(reservation);
        assert_eq!(registry.admission.available_permits(), MAX_REMOTE_SESSIONS);
        assert!(registry.state.lock().unwrap().pending_profiles.is_empty());

        let mut reservation = registry.reserve("reserved-profile".to_string()).unwrap();
        let mut pending = Some(idle_test_record(
            remote_summary_for_profile("wrong-profile", "remote-failed", true),
            2,
        ));
        let error = registry.commit(&mut reservation, &mut pending).unwrap_err();
        assert!(error.contains("does not match"));
        stop_pending_remote_session(pending.take().unwrap(), &error).await;
        drop(reservation);
        assert_eq!(registry.admission.available_permits(), MAX_REMOTE_SESSIONS);
        assert!(registry.state.lock().unwrap().pending_profiles.is_empty());
    }

    #[test]
    fn stale_reservation_drop_does_not_clear_a_newer_profile_token() {
        let registry = Arc::new(RemoteRegistry::new());
        let reservation = registry.reserve("reused-profile".to_string()).unwrap();
        let replacement = reservation.token.wrapping_add(1);
        registry
            .state
            .lock()
            .unwrap()
            .pending_profiles
            .insert("reused-profile".to_string(), replacement);

        drop(reservation);
        assert_eq!(
            registry
                .state
                .lock()
                .unwrap()
                .pending_profiles
                .get("reused-profile"),
            Some(&replacement)
        );
        registry
            .state
            .lock()
            .unwrap()
            .pending_profiles
            .remove("reused-profile");
        assert_eq!(registry.admission.available_permits(), MAX_REMOTE_SESSIONS);
    }

    #[tokio::test]
    async fn removing_a_closed_session_drops_its_terminal_snapshot() {
        let registry = Arc::new(RemoteRegistry::new());
        let generation = 3;
        register_test_record(
            &registry,
            idle_test_record(remote_summary("remote-closed", true), generation),
        );
        assert_eq!(
            registry
                .append_terminal("remote-closed", generation, b"ready")
                .unwrap(),
            0
        );
        assert_eq!(
            registry.terminal_snapshots().unwrap(),
            vec![RemoteTerminalSnapshot {
                session_id: "remote-closed".to_string(),
                start_offset: 0,
                end_offset: 5,
                base64: BASE64.encode(b"ready"),
            }]
        );

        let record = registry.remove("remote-closed").unwrap().unwrap();
        stop_remote_session(record, "test cleanup", Duration::ZERO).await;
        assert!(registry.terminal_snapshots().unwrap().is_empty());
        assert!(registry
            .append_terminal("remote-closed", generation, b"late")
            .is_err());
    }

    #[tokio::test]
    async fn stale_generation_cannot_mutate_or_remove_a_reused_session_id() {
        let registry = Arc::new(RemoteRegistry::new());
        register_test_record(
            &registry,
            idle_test_record(
                remote_summary_for_profile("old-profile", "remote-reused", true),
                10,
            ),
        );
        let old_record = registry.remove("remote-reused").unwrap().unwrap();
        register_test_record(
            &registry,
            idle_test_record(
                remote_summary_for_profile("new-profile", "remote-reused", true),
                11,
            ),
        );

        assert!(registry
            .append_terminal("remote-reused", 10, b"stale")
            .is_err());
        assert_eq!(
            registry
                .append_terminal("remote-reused", 11, b"current")
                .unwrap(),
            0
        );
        assert!(registry
            .remove_if_generation("remote-reused", 10)
            .unwrap()
            .is_none());
        assert_eq!(registry.list().len(), 1);

        stop_remote_session(old_record, "old cleanup", Duration::ZERO).await;
        let current = registry.remove("remote-reused").unwrap().unwrap();
        stop_remote_session(current, "current cleanup", Duration::ZERO).await;
        assert_eq!(registry.admission.available_permits(), MAX_REMOTE_SESSIONS);
    }

    #[tokio::test]
    async fn writer_completion_wakes_and_stops_an_idle_reader() {
        let reader_dropped = Arc::new(AtomicBool::new(false));
        let reader_guard = Dropped(Arc::clone(&reader_dropped));
        let reader = tokio::spawn(async move {
            let _guard = reader_guard;
            pending::<String>().await
        });
        let writer = tokio::spawn(async { "writer stopped first".to_string() });
        let (_shutdown, shutdown_receiver) = oneshot::channel();

        let reason = timeout(
            Duration::from_secs(1),
            supervise_remote_tasks(reader, writer, shutdown_receiver),
        )
        .await
        .expect("writer completion wakes the supervisor")
        .expect("writer completion is a natural stop");
        assert_eq!(reason, "writer stopped first");
        assert!(reader_dropped.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn full_outbound_queue_does_not_block_disconnect_or_task_cleanup() {
        let registry = Arc::new(RemoteRegistry::new());
        let (outbound, outbound_rx) = mpsc::channel(1);
        outbound.send(RemoteMessage::KeepAlive).await.unwrap();
        let channel_probe = outbound.clone();

        let reader_dropped = Arc::new(AtomicBool::new(false));
        let writer_dropped = Arc::new(AtomicBool::new(false));
        let reader_guard = Dropped(Arc::clone(&reader_dropped));
        let writer_guard = Dropped(Arc::clone(&writer_dropped));
        let reader = tokio::spawn(async move {
            let _guard = reader_guard;
            pending::<String>().await
        });
        let writer = tokio::spawn(async move {
            let _guard = writer_guard;
            let _outbound_rx = outbound_rx;
            pending::<String>().await
        });
        let pending = pending_test_record(
            remote_summary_for_profile("blocked-profile", "remote-blocked", true),
            20,
            outbound,
            reader,
            writer,
        );
        register_test_record(&registry, pending);

        let record = registry.remove("remote-blocked").unwrap().unwrap();
        timeout(
            Duration::from_secs(1),
            stop_remote_session(record, "test disconnect", Duration::from_millis(10)),
        )
        .await
        .expect("a full outbound queue must not hang disconnect");

        assert!(reader_dropped.load(Ordering::SeqCst));
        assert!(writer_dropped.load(Ordering::SeqCst));
        assert!(matches!(
            channel_probe.try_send(RemoteMessage::KeepAlive),
            Err(mpsc::error::TrySendError::Closed(_))
        ));
        assert_eq!(registry.admission.available_permits(), MAX_REMOTE_SESSIONS);
    }

    #[tokio::test]
    async fn admission_slot_is_held_until_closing_supervisor_finishes() {
        let registry = Arc::new(RemoteRegistry::new());
        let (outbound, _outbound_rx) = mpsc::channel(1);
        let (shutdown, shutdown_receiver) = oneshot::channel();
        let (closing, closing_receiver) = oneshot::channel();
        let (release, release_receiver) = oneshot::channel();
        let supervisor = tokio::spawn(async move {
            let _ = shutdown_receiver.await;
            let _ = closing.send(());
            let _ = release_receiver.await;
        });
        let pending = PendingRemoteSessionRecord {
            summary: remote_summary_for_profile("closing-profile", "remote-closing", true),
            generation: 21,
            supervisor,
            shutdown,
            outbound,
            files: None,
        };
        register_test_record(&registry, pending);

        let record = registry.remove("remote-closing").unwrap().unwrap();
        let cleanup = tokio::spawn(async move {
            stop_remote_session(record, "test closing", Duration::ZERO).await;
        });
        timeout(Duration::from_secs(1), closing_receiver)
            .await
            .expect("cleanup reached the supervisor")
            .unwrap();
        assert_eq!(
            registry.admission.available_permits(),
            MAX_REMOTE_SESSIONS - 1
        );

        release.send(()).unwrap();
        cleanup.await.unwrap();
        assert_eq!(registry.admission.available_permits(), MAX_REMOTE_SESSIONS);
    }

    #[test]
    fn resolves_browser_inputs_and_drops_impossible_ones() {
        assert_eq!(
            resolve_input(RemoteInputRequest::MouseButton {
                button: 2,
                pressed: true
            }),
            Some(RemoteInput::MouseButton {
                button: PointerButton::Right,
                pressed: true
            })
        );
        assert_eq!(
            resolve_input(RemoteInputRequest::MouseButton {
                button: 9,
                pressed: true
            }),
            None
        );
        assert_eq!(
            resolve_input(RemoteInputRequest::Wheel {
                horizontal: false,
                units: 0
            }),
            None
        );
        // Runaway scroll deltas are clamped to the protocol's range.
        assert_eq!(
            resolve_input(RemoteInputRequest::Wheel {
                horizontal: false,
                units: 9_999
            }),
            Some(RemoteInput::Wheel {
                horizontal: false,
                units: MAX_WHEEL_UNITS
            })
        );
    }

    #[test]
    fn input_request_decodes_from_camel_case_wire() {
        let request: RemoteInputRequest =
            serde_json::from_str(r#"{"kind":"mouseMove","x":12,"y":34}"#).unwrap();
        assert!(matches!(
            request,
            RemoteInputRequest::MouseMove { x: 12, y: 34 }
        ));
        let release: RemoteInputRequest = serde_json::from_str(r#"{"kind":"releaseAll"}"#).unwrap();
        assert!(matches!(release, RemoteInputRequest::ReleaseAll));
    }

    #[tokio::test]
    async fn rejected_pairing_code_does_not_create_a_first_use_pin() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let identity = DeviceIdentity::generate().unwrap();
        let key = identity.noise_private_bytes().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            SecureConnection::accept_with_static_key(
                stream,
                "11112222333344445555666677778888",
                &key,
            )
            .await
        });

        let stream = TcpStream::connect(address).await.unwrap();
        let viewer = SecureConnection::initiate(stream, "9999AAAABBBBCCCCDDDDEEEEFFFF0000").await;
        assert!(
            viewer.is_err(),
            "OPAQUE rejects before a pin candidate can be created"
        );
        assert!(server.await.unwrap().is_err());

        let directory = tempfile::tempdir().unwrap();
        let pins_path = directory.path().join(crate::remote_pins::PINS_FILE);
        assert!(!pins_path.exists());
    }

    #[tokio::test]
    async fn valid_authenticated_hello_commits_the_first_use_pin() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let identity = DeviceIdentity::generate().unwrap();
        let key = identity.noise_private_bytes().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut connection = SecureConnection::accept_with_static_key(
                stream,
                "0123456789ABCDEF0123456789ABCDEF",
                &key,
            )
            .await
            .unwrap();
            connection
                .send(&RemoteMessage::Hello(hello(PROTOCOL_VERSION)))
                .await
                .unwrap();
        });

        let stream = TcpStream::connect(address).await.unwrap();
        let mut viewer = SecureConnection::initiate(stream, "0123456789ABCDEF0123456789ABCDEF")
            .await
            .unwrap();
        let directory = tempfile::tempdir().unwrap();
        let pins_path = directory.path().join(crate::remote_pins::PINS_FILE);
        let candidate = pin_candidate(pins_path.clone(), &viewer);
        let presented_key = candidate.static_key.clone();

        let received = receive_authenticated_hello(&mut viewer, Some(candidate))
            .await
            .unwrap();
        server.await.unwrap();

        assert_eq!(received, hello(PROTOCOL_VERSION));
        assert!(pins_path.exists());
        assert_eq!(
            crate::remote_pins::verify_or_pin(&pins_path, "123456789", &presented_key).unwrap(),
            crate::remote_pins::PinOutcome::Matched
        );
    }

    /// Runs one handshake against an Agent announcing `announced`, and reports
    /// what the viewer made of it.
    async fn viewer_meets_agent(announced: u16) -> Result<RemoteHello, (&'static str, String)> {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let identity = DeviceIdentity::generate().unwrap();
        let key = identity.noise_private_bytes().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut connection = SecureConnection::accept_with_static_key(
                stream,
                "0123456789ABCDEF0123456789ABCDEF",
                &key,
            )
            .await
            .unwrap();
            connection
                .send(&RemoteMessage::Hello(hello(announced)))
                .await
                .unwrap();
        });

        let stream = TcpStream::connect(address).await.unwrap();
        let mut viewer = SecureConnection::initiate(stream, "0123456789ABCDEF0123456789ABCDEF")
            .await
            .unwrap();
        let outcome = receive_authenticated_hello(&mut viewer, None).await;
        server.await.unwrap();
        outcome
    }

    #[tokio::test]
    async fn an_older_agent_stays_reachable() {
        // The machine that is behind is exactly the one someone needs to
        // connect to in order to update it, so a newer viewer talks down
        // instead of refusing.
        for announced in MIN_COMPATIBLE_PROTOCOL_VERSION..=PROTOCOL_VERSION {
            let hello = viewer_meets_agent(announced)
                .await
                .unwrap_or_else(|error| panic!("protocol {announced} was refused: {error:?}"));
            assert_eq!(hello.protocol_version, announced);
        }
    }

    #[tokio::test]
    async fn a_peer_on_either_side_of_the_supported_range_is_named_in_the_error() {
        let (stage, detail) = viewer_meets_agent(PROTOCOL_VERSION + 1).await.unwrap_err();
        assert_eq!(stage, "protocol");
        // The operator has to learn which machine to update.
        assert!(detail.contains("this machine"), "{detail}");

        if MIN_COMPATIBLE_PROTOCOL_VERSION > 0 {
            let (stage, detail) = viewer_meets_agent(MIN_COMPATIBLE_PROTOCOL_VERSION - 1)
                .await
                .unwrap_err();
            assert_eq!(stage, "protocol");
            assert!(detail.contains("that machine"), "{detail}");
        }
    }

    #[tokio::test]
    async fn incompatible_hello_does_not_create_a_first_use_pin() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let identity = DeviceIdentity::generate().unwrap();
        let key = identity.noise_private_bytes().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut connection = SecureConnection::accept_with_static_key(
                stream,
                "0123456789ABCDEF0123456789ABCDEF",
                &key,
            )
            .await
            .unwrap();
            connection
                .send(&RemoteMessage::Hello(hello(PROTOCOL_VERSION + 1)))
                .await
                .unwrap();
        });

        let stream = TcpStream::connect(address).await.unwrap();
        let mut viewer = SecureConnection::initiate(stream, "0123456789ABCDEF0123456789ABCDEF")
            .await
            .unwrap();
        let directory = tempfile::tempdir().unwrap();
        let pins_path = directory.path().join(crate::remote_pins::PINS_FILE);
        let candidate = pin_candidate(pins_path.clone(), &viewer);

        let (stage, _) = receive_authenticated_hello(&mut viewer, Some(candidate))
            .await
            .unwrap_err();
        server.await.unwrap();

        assert_eq!(stage, "protocol");
        assert!(!pins_path.exists());
    }
}
