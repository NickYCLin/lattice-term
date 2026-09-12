//! Core of the lattice-relay server, kept in the library so tests can run a
//! real relay on an ephemeral port. See `bin/lattice-relay.rs` for the CLI.
//!
//! A deliberately blind rendezvous point: agents register a nine-digit device
//! ID over an outbound connection, viewers dial that ID, and the relay pipes
//! the two sockets together. Every session byte after the link is Noise
//! ciphertext negotiated end to end between the peers; the relay never holds
//! a pairing code or a session key, and a stolen relay disk only yields
//! device IDs and token hashes.

use crate::relay::{
    hash_token, normalize_device_id, random_channel_id, read_client_message, write_server_message,
    RelayClientMessage, RelayServerMessage, MAX_RELAY_AUTH_TOKEN_BYTES,
};
use crate::{Transport, MAX_AGENT_NAME_BYTES};
use std::collections::HashMap;
use std::io::Read as _;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot, OwnedSemaphorePermit, Semaphore};
use tokio::time::timeout;

/// A registration is dropped when the agent stays silent longer than this;
/// agents ping every 25 seconds, so three missed pings end the entry.
const CONTROL_IDLE_LIMIT: Duration = Duration::from_secs(90);
/// A control write must not pin its carrier forever when an agent stops
/// reading while continuing to hold the socket open.
const CONTROL_WRITE_LIMIT: Duration = Duration::from_secs(5);
/// How long a dialing viewer waits for the agent to join the channel.
const JOIN_WAIT_LIMIT: Duration = Duration::from_secs(12);
/// How long a brand-new connection has to say what it wants.
const FIRST_MESSAGE_LIMIT: Duration = Duration::from_secs(10);
/// New connections allowed per client IP inside the rate window. Generous
/// for real use (register + a session is a handful), tight enough to stop
/// pairing-code guessing or device-ID scanning through the relay.
const CONNECTIONS_PER_WINDOW: usize = 30;
const RATE_WINDOW: Duration = Duration::from_secs(60);
const MAX_RATE_BUCKETS: usize = 10_000;
/// Hard process-wide carrier cap. This remains effective when HTTPS ingress
/// makes every public peer appear to come from loopback.
const MAX_ACTIVE_RELAY_CONNECTIONS: usize = 512;
/// Viewers waiting for an agent to answer an invite.
const MAX_PENDING_DIALS: usize = 128;
/// Persistent device claims accepted before an operator must expand capacity.
const MAX_DEVICE_REGISTRY_ENTRIES: usize = 10_000;
const MAX_DEVICE_REGISTRY_BYTES: u64 = 2 * 1024 * 1024;
const CHANNEL_ID_HEX_BYTES: usize = 64;

struct AgentEntry {
    agent_name: String,
    invites: mpsc::Sender<RelayServerMessage>,
    cancel: oneshot::Sender<()>,
    generation: u64,
}

struct JoinedTransport {
    transport: Transport,
    /// A joined carrier stays counted until the linked session actually ends.
    _connection_permit: OwnedSemaphorePermit,
}

struct PendingJoin {
    device_id: String,
    sender: oneshot::Sender<JoinedTransport>,
}

#[derive(Default)]
struct DialState {
    joins: HashMap<String, PendingJoin>,
    /// The channel holding a device's single pending or linked Dial.
    device_channels: HashMap<String, String>,
}

#[derive(Debug, PartialEq, Eq)]
enum DialReservationError {
    DeviceBusy,
    Capacity,
    ChannelCollision,
}

struct DialReservation {
    state: Arc<RelayState>,
    channel_id: String,
    device_id: String,
}

impl Drop for DialReservation {
    fn drop(&mut self) {
        self.state.release_dial(&self.channel_id, &self.device_id);
    }
}

#[derive(Debug, PartialEq, Eq)]
enum DeviceClaimError {
    AlreadyClaimed,
    Capacity,
    Unavailable,
}

pub struct RelayState {
    agents: Mutex<HashMap<String, AgentEntry>>,
    dials: Mutex<DialState>,
    tokens: Mutex<HashMap<String, String>>,
    state_path: Option<PathBuf>,
    generations: Mutex<u64>,
    rates: Mutex<HashMap<IpAddr, Vec<Instant>>>,
    forwarded_ip_header: Option<String>,
    connection_slots: Arc<Semaphore>,
    max_pending_dials: usize,
    max_device_registry_entries: usize,
    registry_healthy: AtomicBool,
}

impl Default for RelayState {
    fn default() -> Self {
        Self::new(None)
    }
}

impl RelayState {
    pub fn new(state_path: Option<PathBuf>) -> Self {
        Self::with_limits(
            state_path,
            MAX_ACTIVE_RELAY_CONNECTIONS,
            MAX_PENDING_DIALS,
            MAX_DEVICE_REGISTRY_ENTRIES,
        )
    }

    fn with_limits(
        state_path: Option<PathBuf>,
        max_connections: usize,
        max_pending_dials: usize,
        max_device_registry_entries: usize,
    ) -> Self {
        let state = Self {
            agents: Mutex::new(HashMap::new()),
            dials: Mutex::new(DialState::default()),
            tokens: Mutex::new(HashMap::new()),
            state_path,
            generations: Mutex::new(0),
            rates: Mutex::new(HashMap::new()),
            forwarded_ip_header: None,
            connection_slots: Arc::new(Semaphore::new(max_connections)),
            max_pending_dials,
            max_device_registry_entries,
            registry_healthy: AtomicBool::new(true),
        };
        state.load_tokens();
        state
    }

    /// Charges loopback connections to the address this header carries.
    ///
    /// Only an operator who knows their ingress overwrites the header should
    /// turn this on: with an appending proxy in front, or none at all, a
    /// client could otherwise choose which bucket to spend.
    pub fn trusting_forwarded_ip_header(mut self, header_name: Option<String>) -> Self {
        self.forwarded_ip_header = header_name.filter(|name| !name.trim().is_empty());
        self
    }

    fn next_generation(&self) -> u64 {
        let mut current = self.generations.lock().expect("generation lock");
        *current += 1;
        *current
    }

    /// Where a loopback peer is really connecting from, when the operator
    /// named a trusted proxy header and the proxy supplied it.
    ///
    /// Behind the recommended HTTPS/WSS ingress every public client reaches
    /// the relay as 127.0.0.1. Charging the peer address there would let one
    /// busy client exhaust a bucket everyone shares, so loopback is exempt by
    /// default — which also means the per-IP budget covers none of the
    /// traffic it exists to bound. Naming the header the ingress sets charges
    /// that traffic to the real client instead.
    ///
    /// A peer that is not loopback never gets to name its own address: it
    /// reached the port directly, so any header it sent is its own writing,
    /// and it is charged to its real address before the handshake anyway.
    fn forwarded_client_ip(&self, peer: IpAddr, forwarded: Option<&str>) -> Option<IpAddr> {
        if !peer.is_loopback() {
            return None;
        }
        // Only a configured header is ever captured, but refusing here too
        // keeps a future caller from enabling the trust by accident.
        self.forwarded_ip_header.as_ref()?;
        forwarded.and_then(parse_forwarded_ip)
    }

    /// Sliding-window limit on how often one IP may open connections.
    fn allow_connection(&self, ip: IpAddr) -> bool {
        let now = Instant::now();
        let mut rates = self.rates.lock().expect("rate lock");
        if rates.len() >= MAX_RATE_BUCKETS && !rates.contains_key(&ip) {
            rates.retain(|_, entries| {
                entries.retain(|at| now.duration_since(*at) < RATE_WINDOW);
                !entries.is_empty()
            });
            if rates.len() >= MAX_RATE_BUCKETS {
                return false;
            }
        }
        let recent = rates.entry(ip).or_default();
        recent.retain(|at| now.duration_since(*at) < RATE_WINDOW);
        if recent.len() >= CONNECTIONS_PER_WINDOW {
            return false;
        }
        recent.push(now);
        true
    }

    fn try_reserve_connection(&self) -> Option<OwnedSemaphorePermit> {
        Arc::clone(&self.connection_slots).try_acquire_owned().ok()
    }

    fn reserve_dial(
        self: &Arc<Self>,
        channel_id: String,
        device_id: String,
    ) -> Result<(oneshot::Receiver<JoinedTransport>, DialReservation), DialReservationError> {
        let mut dials = self.dials.lock().expect("dial lock");
        if dials.device_channels.contains_key(&device_id) {
            return Err(DialReservationError::DeviceBusy);
        }
        if dials.joins.len() >= self.max_pending_dials {
            return Err(DialReservationError::Capacity);
        }
        if dials.joins.contains_key(&channel_id) {
            return Err(DialReservationError::ChannelCollision);
        }
        let (sender, receiver) = oneshot::channel();
        dials
            .device_channels
            .insert(device_id.clone(), channel_id.clone());
        dials.joins.insert(
            channel_id.clone(),
            PendingJoin {
                device_id: device_id.clone(),
                sender,
            },
        );
        drop(dials);
        Ok((
            receiver,
            DialReservation {
                state: Arc::clone(self),
                channel_id,
                device_id,
            },
        ))
    }

    fn take_pending_join(
        &self,
        channel_id: &str,
        device_id: &str,
    ) -> Option<oneshot::Sender<JoinedTransport>> {
        let mut dials = self.dials.lock().expect("dial lock");
        if dials
            .joins
            .get(channel_id)
            .is_none_or(|pending| pending.device_id != device_id)
        {
            return None;
        }
        dials.joins.remove(channel_id).map(|pending| pending.sender)
    }

    fn release_dial(&self, channel_id: &str, device_id: &str) {
        let mut dials = self.dials.lock().expect("dial lock");
        if dials
            .joins
            .get(channel_id)
            .is_some_and(|pending| pending.device_id == device_id)
        {
            dials.joins.remove(channel_id);
        }
        if dials
            .device_channels
            .get(device_id)
            .is_some_and(|active_channel| active_channel == channel_id)
        {
            dials.device_channels.remove(device_id);
        }
    }

    fn verify_or_claim(&self, device_id: &str, auth_token: &str) -> Result<(), DeviceClaimError> {
        if !self.registry_healthy.load(Ordering::Acquire) {
            return Err(DeviceClaimError::Unavailable);
        }
        let hashed = hash_token(auth_token);
        let mut tokens = self.tokens.lock().expect("token lock");
        match tokens.get(device_id) {
            Some(existing) if *existing == hashed => Ok(()),
            Some(_) => Err(DeviceClaimError::AlreadyClaimed),
            None if tokens.len() >= self.max_device_registry_entries => {
                Err(DeviceClaimError::Capacity)
            }
            None => {
                tokens.insert(device_id.to_string(), hashed);
                if self.save_tokens(&tokens).is_ok() {
                    Ok(())
                } else {
                    tokens.remove(device_id);
                    Err(DeviceClaimError::Unavailable)
                }
            }
        }
    }

    fn verify_only(&self, device_id: &str, auth_token: &str) -> bool {
        if !self.registry_healthy.load(Ordering::Acquire) {
            return false;
        }
        let hashed = hash_token(auth_token);
        self.tokens
            .lock()
            .expect("token lock")
            .get(device_id)
            .is_some_and(|existing| *existing == hashed)
    }

    fn save_tokens(&self, tokens: &HashMap<String, String>) -> Result<(), ()> {
        let Some(path) = &self.state_path else {
            return Ok(());
        };
        match serde_json::to_vec_pretty(tokens) {
            Ok(json) if json.len() as u64 <= MAX_DEVICE_REGISTRY_BYTES => {
                let staging = path.with_extension("tmp");
                let mut options = std::fs::OpenOptions::new();
                options.create(true).truncate(true).write(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                let result = (|| -> std::io::Result<()> {
                    let mut file = options.open(&staging)?;
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
                    }
                    std::io::Write::write_all(&mut file, &json)?;
                    file.sync_all()?;
                    drop(file);
                    std::fs::rename(&staging, path)?;
                    Ok(())
                })();
                if let Err(error) = result {
                    eprintln!("warning: could not persist device registry: {error}");
                    Err(())
                } else {
                    Ok(())
                }
            }
            Ok(_) => {
                eprintln!("warning: device registry exceeds its safe file-size limit");
                Err(())
            }
            Err(error) => {
                eprintln!("warning: could not encode device registry: {error}");
                Err(())
            }
        }
    }

    fn load_tokens(&self) {
        let Some(path) = &self.state_path else {
            return;
        };
        let loaded = match std::fs::File::open(path) {
            Ok(file) => {
                let mut bytes = Vec::new();
                match file
                    .take(MAX_DEVICE_REGISTRY_BYTES + 1)
                    .read_to_end(&mut bytes)
                {
                    Ok(_) if bytes.len() as u64 <= MAX_DEVICE_REGISTRY_BYTES => {
                        serde_json::from_slice::<HashMap<String, String>>(&bytes)
                            .map_err(|error| format!("invalid JSON: {error}"))
                    }
                    Ok(_) => Err("file exceeds the safe size limit".to_string()),
                    Err(error) => Err(format!("could not read it: {error}")),
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(error) => {
                self.registry_healthy.store(false, Ordering::Release);
                eprintln!("warning: refusing device registry after a read error: {error}");
                return;
            }
        };
        let loaded = match loaded {
            Ok(loaded) => loaded,
            Err(error) => {
                self.registry_healthy.store(false, Ordering::Release);
                eprintln!("warning: refusing unsafe device registry: {error}");
                return;
            }
        };
        let valid = loaded.len() <= self.max_device_registry_entries
            && loaded.iter().all(|(device_id, token_hash)| {
                device_id.len() == 9
                    && device_id.bytes().all(|byte| byte.is_ascii_digit())
                    && token_hash.len() == CHANNEL_ID_HEX_BYTES
                    && token_hash.bytes().all(|byte| byte.is_ascii_hexdigit())
            });
        if !valid {
            self.registry_healthy.store(false, Ordering::Release);
            eprintln!("warning: refusing unsafe or over-capacity device registry");
            return;
        }
        let count = loaded.len();
        *self.tokens.lock().expect("token lock") = loaded;
        println!("Loaded {count} registered device IDs.");
    }
}

/// Reads the client address a trusted proxy wrote into its header.
///
/// Proxies differ on whether they append a port, so both shapes are accepted;
/// anything else is discarded rather than guessed at, which leaves the
/// connection exempt instead of charging it to a bucket it does not own.
fn parse_forwarded_ip(value: &str) -> Option<IpAddr> {
    let value = value.trim();
    value
        .parse::<IpAddr>()
        .ok()
        .or_else(|| value.parse::<SocketAddr>().ok().map(|address| address.ip()))
}

/// Who a connection belongs to, for the log.
///
/// Behind ingress the carrier address is always loopback, which tells an
/// operator investigating abuse nothing; when a trusted proxy supplied the
/// real address, both are shown.
struct ClientAddress {
    peer: SocketAddr,
    forwarded: Option<IpAddr>,
}

impl std::fmt::Display for ClientAddress {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.forwarded {
            Some(forwarded) => write!(formatter, "{forwarded} via {}", self.peer),
            None => write!(formatter, "{}", self.peer),
        }
    }
}

async fn send_error(stream: &mut Transport, code: &str, detail: &str) {
    let _ = write_server_message(
        stream,
        &RelayServerMessage::Error {
            code: code.to_string(),
            detail: detail.to_string(),
        },
    )
    .await;
}

fn valid_agent_name(agent_name: &str) -> bool {
    !agent_name.trim().is_empty()
        && agent_name.len() <= MAX_AGENT_NAME_BYTES
        && !agent_name.chars().any(char::is_control)
}

fn valid_auth_token(auth_token: &str) -> bool {
    !auth_token.is_empty() && auth_token.len() <= MAX_RELAY_AUTH_TOKEN_BYTES
}

fn valid_channel_id(channel_id: &str) -> bool {
    channel_id.len() == CHANNEL_ID_HEX_BYTES
        && channel_id.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Holds an agent's register connection: forwards invites from dial handlers
/// and answers pings until the agent disappears.
async fn run_agent_control(
    state: Arc<RelayState>,
    stream: Transport,
    client: &ClientAddress,
    device_id: String,
    agent_name: String,
) {
    let generation = state.next_generation();
    let (invites_tx, mut invites_rx) = mpsc::channel::<RelayServerMessage>(8);
    let (cancel_tx, mut cancel_rx) = oneshot::channel();
    let previous = state.agents.lock().expect("agent lock").insert(
        device_id.clone(),
        AgentEntry {
            agent_name,
            invites: invites_tx,
            cancel: cancel_tx,
            generation,
        },
    );
    if let Some(previous) = previous {
        let _ = previous.cancel.send(());
    }
    println!("Registered device {device_id} from {client}.");

    let (mut read_half, write_half) = tokio::io::split(stream);
    let writer = Arc::new(tokio::sync::Mutex::new(write_half));
    let ping_writer = Arc::clone(&writer);

    let mut forwarder = tokio::spawn(async move {
        while let Some(message) = invites_rx.recv().await {
            let written = timeout(CONTROL_WRITE_LIMIT, async {
                let mut guard = ping_writer.lock().await;
                write_server_message(&mut *guard, &message).await
            })
            .await;
            if !matches!(written, Ok(Ok(()))) {
                break;
            }
        }
    });

    let forwarder_finished = loop {
        tokio::select! {
            received = timeout(CONTROL_IDLE_LIMIT, read_client_message(&mut read_half)) => {
                match received {
                    Ok(Ok(RelayClientMessage::Ping)) => {
                        let written = timeout(CONTROL_WRITE_LIMIT, async {
                            let mut guard = writer.lock().await;
                            write_server_message(&mut *guard, &RelayServerMessage::Pong).await
                        }).await;
                        if !matches!(written, Ok(Ok(()))) {
                            break false;
                        }
                    }
                    Ok(Ok(_)) | Ok(Err(_)) | Err(_) => break false,
                }
            }
            _ = &mut cancel_rx => break false,
            _ = &mut forwarder => break true,
        }
    };

    if !forwarder_finished {
        forwarder.abort();
        let _ = forwarder.await;
    }
    let mut agents = state.agents.lock().expect("agent lock");
    if agents
        .get(&device_id)
        .is_some_and(|entry| entry.generation == generation)
    {
        agents.remove(&device_id);
        println!("Device {device_id} went offline.");
    }
}

async fn run_dial(
    state: Arc<RelayState>,
    mut stream: Transport,
    client: &ClientAddress,
    device_id: String,
) {
    let device_id = match normalize_device_id(&device_id) {
        Ok(device_id) => device_id,
        Err(_) => {
            send_error(&mut stream, "invalidId", "A device ID has nine digits.").await;
            return;
        }
    };
    let channel_id = match random_channel_id() {
        Ok(channel_id) => channel_id,
        Err(_) => {
            send_error(
                &mut stream,
                "internal",
                "The relay could not open a channel.",
            )
            .await;
            return;
        }
    };
    let entry = state
        .agents
        .lock()
        .expect("agent lock")
        .get(&device_id)
        .map(|entry| (entry.invites.clone(), entry.agent_name.clone()));
    let Some((invite, agent_name)) = entry else {
        send_error(
            &mut stream,
            "offline",
            "That device is not connected to this relay.",
        )
        .await;
        return;
    };

    let (channel_rx, _reservation) = match state.reserve_dial(channel_id.clone(), device_id.clone())
    {
        Ok(reservation) => reservation,
        Err(DialReservationError::DeviceBusy | DialReservationError::Capacity) => {
            send_error(
                &mut stream,
                "busy",
                "The device or relay is already handling another connection.",
            )
            .await;
            return;
        }
        Err(DialReservationError::ChannelCollision) => {
            send_error(
                &mut stream,
                "internal",
                "The relay could not reserve a channel.",
            )
            .await;
            return;
        }
    };

    match invite.try_send(RelayServerMessage::Invite {
        channel_id: channel_id.clone(),
    }) {
        Ok(()) => {}
        Err(mpsc::error::TrySendError::Closed(_)) => {
            send_error(&mut stream, "offline", "That device just went offline.").await;
            return;
        }
        Err(mpsc::error::TrySendError::Full(_)) => {
            send_error(
                &mut stream,
                "busy",
                "That device is not accepting another invite yet.",
            )
            .await;
            return;
        }
    }

    let mut agent_stream = match timeout(JOIN_WAIT_LIMIT, channel_rx).await {
        Ok(Ok(agent_stream)) => agent_stream,
        Ok(Err(_)) | Err(_) => {
            send_error(
                &mut stream,
                "busy",
                "The device did not answer. It may be in another session.",
            )
            .await;
            return;
        }
    };

    let linked = RelayServerMessage::Linked {
        agent_name: agent_name.clone(),
    };
    if write_server_message(&mut agent_stream.transport, &linked)
        .await
        .is_err()
    {
        send_error(&mut stream, "busy", "The device dropped while linking.").await;
        return;
    }
    if write_server_message(&mut stream, &linked).await.is_err() {
        let _ = agent_stream.transport.shutdown().await;
        return;
    }

    println!("Linked a viewer at {client} with device {device_id}.");
    match tokio::io::copy_bidirectional(&mut stream, &mut agent_stream.transport).await {
        Ok((to_agent, to_viewer)) => println!(
            "Channel for device {device_id} closed ({to_agent} bytes in, {to_viewer} bytes out)."
        ),
        Err(error) => println!("Channel for device {device_id} ended: {error}."),
    }
}

async fn run_connection(
    state: Arc<RelayState>,
    mut stream: Transport,
    client: &ClientAddress,
    connection_permit: OwnedSemaphorePermit,
) {
    let first = match timeout(FIRST_MESSAGE_LIMIT, read_client_message(&mut stream)).await {
        Ok(Ok(message)) => message,
        Ok(Err(_)) | Err(_) => return,
    };
    match first {
        RelayClientMessage::Register {
            device_id,
            auth_token,
            agent_name,
        } => {
            if !valid_auth_token(&auth_token) || !valid_agent_name(&agent_name) {
                send_error(
                    &mut stream,
                    "invalidRequest",
                    "The agent name or authentication token is invalid.",
                )
                .await;
                return;
            }
            let device_id = match normalize_device_id(&device_id) {
                Ok(device_id) => device_id,
                Err(_) => {
                    send_error(&mut stream, "invalidId", "A device ID has nine digits.").await;
                    return;
                }
            };
            match state.verify_or_claim(&device_id, &auth_token) {
                Ok(()) => {}
                Err(DeviceClaimError::AlreadyClaimed) => {
                    send_error(
                        &mut stream,
                        "unauthorized",
                        "This device ID belongs to another device.",
                    )
                    .await;
                    return;
                }
                Err(DeviceClaimError::Capacity) => {
                    send_error(
                        &mut stream,
                        "capacity",
                        "The relay device registry is full.",
                    )
                    .await;
                    return;
                }
                Err(DeviceClaimError::Unavailable) => {
                    send_error(
                        &mut stream,
                        "unavailable",
                        "The relay device registry is unavailable.",
                    )
                    .await;
                    return;
                }
            }
            if write_server_message(&mut stream, &RelayServerMessage::Registered)
                .await
                .is_err()
            {
                return;
            }
            run_agent_control(state, stream, client, device_id, agent_name).await;
        }
        RelayClientMessage::Dial { device_id } => {
            run_dial(state, stream, client, device_id).await;
        }
        RelayClientMessage::Join {
            channel_id,
            device_id,
            auth_token,
        } => {
            if !valid_channel_id(&channel_id) || !valid_auth_token(&auth_token) {
                send_error(
                    &mut stream,
                    "invalidRequest",
                    "The channel or authentication token is invalid.",
                )
                .await;
                return;
            }
            let authorized = normalize_device_id(&device_id)
                .ok()
                .filter(|device_id| state.verify_only(device_id, &auth_token));
            let Some(device_id) = authorized else {
                send_error(&mut stream, "unauthorized", "Unknown device or token.").await;
                return;
            };
            let waiting = state.take_pending_join(&channel_id, &device_id);
            match waiting {
                // The dial handler takes over the socket from here.
                Some(channel) => {
                    let _ = channel.send(JoinedTransport {
                        transport: stream,
                        _connection_permit: connection_permit,
                    });
                }
                None => {
                    send_error(&mut stream, "expired", "That invite is no longer waiting.").await;
                }
            }
        }
        RelayClientMessage::Ping => {
            let _ = write_server_message(&mut stream, &RelayServerMessage::Pong).await;
        }
    }
}

/// Accepts connections forever. Callers bind the listener themselves so tests
/// can use an ephemeral port.
pub async fn run(listener: TcpListener, state: Arc<RelayState>) {
    loop {
        match listener.accept().await {
            Ok((stream, peer)) => {
                let Some(connection_permit) = state.try_reserve_connection() else {
                    // Refuse before spawning or negotiating a carrier. This is
                    // the backstop for loopback traffic arriving via ingress.
                    drop(stream);
                    continue;
                };
                let state = Arc::clone(&state);
                tokio::spawn(async move {
                    // A direct peer's budget is spent before the WebSocket
                    // handshake so a flood cannot buy HTTP parsing work with
                    // rejected connections.
                    if !peer.ip().is_loopback() && !state.allow_connection(peer.ip()) {
                        let _ = timeout(FIRST_MESSAGE_LIMIT, reject_rate_limited(stream)).await;
                        return;
                    }
                    let negotiated = timeout(
                        FIRST_MESSAGE_LIMIT,
                        negotiate_carrier(stream, state.forwarded_ip_header.as_deref()),
                    )
                    .await;
                    let Ok(Ok((mut transport, forwarded))) = negotiated else {
                        return;
                    };
                    // A proxied peer only reveals its client inside the
                    // handshake, so its budget is settled here instead. The
                    // process-wide carrier cap bounds the handshake work a
                    // flood can buy in the meantime.
                    let forwarded = state.forwarded_client_ip(peer.ip(), forwarded.as_deref());
                    if let Some(client_ip) = forwarded {
                        if !state.allow_connection(client_ip) {
                            send_error(
                                &mut transport,
                                "rateLimited",
                                "Too many connections from this address; wait a minute.",
                            )
                            .await;
                            return;
                        }
                    }
                    let client = ClientAddress { peer, forwarded };
                    run_connection(state, transport, &client, connection_permit).await;
                });
            }
            Err(error) => {
                eprintln!("Could not accept a connection: {error}");
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }
    }
}

/// Native relay TCP costs nothing extra to answer, so an over-budget peer
/// still hears the rateLimited error; a WebSocket peer would first need the
/// very handshake the limiter exists to avoid, so it is dropped silently.
async fn reject_rate_limited(stream: TcpStream) {
    let mut first = [0_u8; 1];
    if stream.set_nodelay(true).is_ok()
        && matches!(stream.peek(&mut first).await, Ok(1))
        && first[0] == 0
    {
        let mut transport = Transport::Tcp(stream);
        send_error(
            &mut transport,
            "rateLimited",
            "Too many connections from this address; wait a minute.",
        )
        .await;
    }
}

/// One listener supports native relay TCP and WebSocket upgrades. Relay JSON
/// begins with a zero high byte in its bounded length prefix, while every
/// WebSocket handshake begins with an HTTP `GET` request.
async fn negotiate_carrier(
    stream: TcpStream,
    forwarded_ip_header: Option<&str>,
) -> Result<(Transport, Option<String>), std::io::Error> {
    stream.set_nodelay(true)?;
    let mut first = [0_u8; 1];
    if stream.peek(&mut first).await? == 1 && first[0] == 0 {
        // Native TCP has no handshake to carry a forwarded address.
        return Ok((Transport::Tcp(stream), None));
    }
    match forwarded_ip_header {
        Some(header_name) => Transport::accept_websocket_with_header(stream, header_name).await,
        None => Ok((Transport::accept_websocket(stream).await?, None)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::{dial, read_server_message, write_client_message, DeviceIdentity};
    use crate::{RemoteHello, RemoteMessage, SecureConnection, PROTOCOL_VERSION};

    async fn start_relay() -> (SocketAddr, Arc<RelayState>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let state = Arc::new(RelayState::default());
        let run_state = Arc::clone(&state);
        tokio::spawn(run(listener, run_state));
        (address, state)
    }

    async fn register_agent(
        address: SocketAddr,
        identity: &DeviceIdentity,
    ) -> tokio::net::TcpStream {
        let mut control = TcpStream::connect(address).await.unwrap();
        write_client_message(
            &mut control,
            &RelayClientMessage::Register {
                device_id: identity.device_id.clone(),
                auth_token: identity.auth_token.clone(),
                agent_name: "Test host".to_string(),
            },
        )
        .await
        .unwrap();
        assert_eq!(
            read_server_message(&mut control).await.unwrap(),
            RelayServerMessage::Registered
        );
        control
    }

    #[tokio::test]
    async fn viewer_and_agent_run_noise_end_to_end_through_the_relay() {
        let (address, _state) = start_relay().await;
        let identity = DeviceIdentity::generate().unwrap();
        let mut control = register_agent(address, &identity).await;

        // The fake agent answers the invite, then accepts the encrypted
        // session exactly like the real one.
        let agent_identity = identity.clone();
        let agent = tokio::spawn(async move {
            let invite = read_server_message(&mut control).await.unwrap();
            let RelayServerMessage::Invite { channel_id } = invite else {
                panic!("expected an invite, got {invite:?}");
            };
            let mut session = TcpStream::connect(address).await.unwrap();
            write_client_message(
                &mut session,
                &RelayClientMessage::Join {
                    channel_id,
                    device_id: agent_identity.device_id.clone(),
                    auth_token: agent_identity.auth_token.clone(),
                },
            )
            .await
            .unwrap();
            let linked = read_server_message(&mut session).await.unwrap();
            assert!(matches!(linked, RelayServerMessage::Linked { .. }));
            let mut secure = SecureConnection::accept(session, "0123456789ABCDEF0123456789ABCDEF")
                .await
                .unwrap();
            secure
                .send(&RemoteMessage::Hello(RemoteHello {
                    protocol_version: PROTOCOL_VERSION,
                    agent_name: "Test host".into(),
                    width: 640,
                    height: 360,
                    view_only: true,
                    file_transfer: false,
                    file_root_label: String::new(),
                    file_edit: false,
                    command_shells: 0,
                    chat: false,
                    terminal: false,
                }))
                .await
                .unwrap();
            assert_eq!(secure.receive().await.unwrap(), RemoteMessage::KeepAlive);
        });

        let (stream, agent_name) = dial(&address.to_string(), &identity.device_id)
            .await
            .unwrap();
        assert_eq!(agent_name, "Test host");
        let mut viewer =
            SecureConnection::initiate(stream, "0123-4567-89AB-CDEF-0123-4567-89AB-CDEF")
                .await
                .unwrap();
        let hello = viewer.receive().await.unwrap();
        assert!(matches!(hello, RemoteMessage::Hello(_)));
        viewer.send(&RemoteMessage::KeepAlive).await.unwrap();
        agent.await.unwrap();
    }

    #[tokio::test]
    async fn websocket_viewer_and_agent_keep_noise_end_to_end() {
        let (address, _state) = start_relay().await;
        let endpoint = format!("ws://{address}/");
        let identity = DeviceIdentity::generate().unwrap();
        let mut control = Transport::connect(&endpoint).await.unwrap();
        write_client_message(
            &mut control,
            &RelayClientMessage::Register {
                device_id: identity.device_id.clone(),
                auth_token: identity.auth_token.clone(),
                agent_name: "WebSocket host".to_string(),
            },
        )
        .await
        .unwrap();
        assert_eq!(
            read_server_message(&mut control).await.unwrap(),
            RelayServerMessage::Registered
        );

        let session_endpoint = endpoint.clone();
        let agent_identity = identity.clone();
        let agent = tokio::spawn(async move {
            let RelayServerMessage::Invite { channel_id } =
                read_server_message(&mut control).await.unwrap()
            else {
                panic!("expected a relay invite");
            };
            let mut session = Transport::connect(&session_endpoint).await.unwrap();
            write_client_message(
                &mut session,
                &RelayClientMessage::Join {
                    channel_id,
                    device_id: agent_identity.device_id,
                    auth_token: agent_identity.auth_token,
                },
            )
            .await
            .unwrap();
            assert!(matches!(
                read_server_message(&mut session).await.unwrap(),
                RelayServerMessage::Linked { .. }
            ));
            let mut secure = SecureConnection::accept(session, "24681357ABCDEF0124681357ABCDEF01")
                .await
                .unwrap();
            assert_eq!(secure.receive().await.unwrap(), RemoteMessage::KeepAlive);
            secure.send(&RemoteMessage::KeepAlive).await.unwrap();
        });

        let (stream, agent_name) = dial(&endpoint, &identity.device_id).await.unwrap();
        assert_eq!(agent_name, "WebSocket host");
        let mut viewer =
            SecureConnection::initiate(stream, "2468-1357-ABCD-EF01-2468-1357-ABCD-EF01")
                .await
                .unwrap();
        viewer.send(&RemoteMessage::KeepAlive).await.unwrap();
        assert_eq!(viewer.receive().await.unwrap(), RemoteMessage::KeepAlive);
        agent.await.unwrap();
    }

    #[test]
    fn one_address_is_rate_limited_inside_the_window() {
        let state = RelayState::default();
        let ip: IpAddr = "203.0.113.9".parse().unwrap();
        for _ in 0..CONNECTIONS_PER_WINDOW {
            assert!(state.allow_connection(ip));
        }
        assert!(!state.allow_connection(ip));
        // Another address is unaffected.
        assert!(state.allow_connection("203.0.113.10".parse().unwrap()));
    }

    #[test]
    fn loopback_shares_no_budget_behind_the_ingress() {
        let state = RelayState::default();
        let v4: IpAddr = "127.0.0.1".parse().unwrap();
        let v6: IpAddr = "::1".parse().unwrap();
        // Nothing to charge means nothing to exhaust, however many arrive.
        for _ in 0..(CONNECTIONS_PER_WINDOW * 2) {
            assert_eq!(state.forwarded_client_ip(v4, None), None);
            assert_eq!(state.forwarded_client_ip(v6, None), None);
        }
    }

    #[test]
    fn a_trusted_header_charges_the_client_behind_the_ingress() {
        let state = RelayState::default()
            .trusting_forwarded_ip_header(Some("Cf-Connecting-Ip".to_string()));
        let loopback: IpAddr = "127.0.0.1".parse().unwrap();
        let client: IpAddr = "203.0.113.9".parse().unwrap();

        assert_eq!(
            state.forwarded_client_ip(loopback, Some("203.0.113.9")),
            Some(client)
        );
        for _ in 0..CONNECTIONS_PER_WINDOW {
            assert!(state.allow_connection(client));
        }
        assert!(!state.allow_connection(client));
        // One noisy client must not spend anyone else's budget.
        assert!(state.allow_connection("203.0.113.10".parse().unwrap()));
    }

    #[test]
    fn a_local_client_stays_exempt_when_the_ingress_adds_no_header() {
        let state = RelayState::default()
            .trusting_forwarded_ip_header(Some("Cf-Connecting-Ip".to_string()));
        let loopback: IpAddr = "127.0.0.1".parse().unwrap();

        // The desktop app and a headless agent reach their own relay directly,
        // with no proxy to write the header. Charging them to a bucket they
        // never chose would rate limit the operator's own machine.
        assert_eq!(state.forwarded_client_ip(loopback, None), None);
        assert_eq!(
            state.forwarded_client_ip(loopback, Some("not an address")),
            None
        );
    }

    #[test]
    fn a_direct_peer_cannot_choose_its_own_rate_bucket() {
        let state = RelayState::default()
            .trusting_forwarded_ip_header(Some("Cf-Connecting-Ip".to_string()));
        let peer: IpAddr = "203.0.113.9".parse().unwrap();

        // This peer reached the port itself, so the header is its own writing
        // and is ignored; run() charges it to its real address instead.
        assert_eq!(state.forwarded_client_ip(peer, Some("198.51.100.4")), None);
    }

    #[test]
    fn a_forwarded_header_is_ignored_until_an_operator_names_it() {
        let state = RelayState::default();
        let loopback: IpAddr = "127.0.0.1".parse().unwrap();

        assert_eq!(
            state.forwarded_client_ip(loopback, Some("203.0.113.9")),
            None
        );
        assert_eq!(
            RelayState::default()
                .trusting_forwarded_ip_header(Some("   ".to_string()))
                .forwarded_client_ip(loopback, Some("203.0.113.9")),
            None
        );
    }

    #[test]
    fn forwarded_addresses_are_read_in_the_shapes_proxies_write() {
        assert_eq!(
            parse_forwarded_ip("203.0.113.9"),
            Some("203.0.113.9".parse().unwrap())
        );
        assert_eq!(
            parse_forwarded_ip(" 2001:db8::1 "),
            Some("2001:db8::1".parse().unwrap())
        );
        // Some proxies append the source port.
        assert_eq!(
            parse_forwarded_ip("203.0.113.9:51234"),
            Some("203.0.113.9".parse().unwrap())
        );
        assert_eq!(
            parse_forwarded_ip("[2001:db8::1]:51234"),
            Some("2001:db8::1".parse().unwrap())
        );
        // A value that cannot be read leaves the connection exempt rather
        // than charging it to a guess.
        assert_eq!(parse_forwarded_ip("unknown"), None);
        assert_eq!(parse_forwarded_ip(""), None);
    }

    #[test]
    fn logs_name_the_real_client_and_the_carrier_it_arrived_on() {
        let peer: SocketAddr = "127.0.0.1:44408".parse().unwrap();
        assert_eq!(
            ClientAddress {
                peer,
                forwarded: None
            }
            .to_string(),
            "127.0.0.1:44408"
        );
        assert_eq!(
            ClientAddress {
                peer,
                forwarded: Some("203.0.113.9".parse().unwrap())
            }
            .to_string(),
            "203.0.113.9 via 127.0.0.1:44408"
        );
    }

    #[test]
    fn rate_bucket_map_has_a_hard_cardinality_limit() {
        let state = RelayState::default();
        let first = u32::from_be_bytes([10, 0, 0, 1]);
        for offset in 0..MAX_RATE_BUCKETS as u32 {
            assert!(state.allow_connection(IpAddr::from(std::net::Ipv4Addr::from(first + offset))));
        }
        assert!(
            !state.allow_connection(IpAddr::from(std::net::Ipv4Addr::from(
                first + MAX_RATE_BUCKETS as u32
            )))
        );
        assert_eq!(state.rates.lock().unwrap().len(), MAX_RATE_BUCKETS);
        assert!(state.allow_connection(IpAddr::from(std::net::Ipv4Addr::from(first))));
    }

    #[test]
    fn global_connection_budget_caps_loopback_ingress_too() {
        let state = RelayState::default();
        let mut permits = Vec::new();
        for _ in 0..MAX_ACTIVE_RELAY_CONNECTIONS {
            permits.push(
                state
                    .try_reserve_connection()
                    .expect("the configured relay connection slot should exist"),
            );
        }
        assert!(state.try_reserve_connection().is_none());

        permits.pop();
        assert!(state.try_reserve_connection().is_some());
    }

    #[tokio::test]
    async fn joined_transport_keeps_its_connection_slot_until_drop() {
        let state = RelayState::with_limits(None, 1, 1, 1);
        let permit = state.try_reserve_connection().unwrap();
        let (stream, _peer) = tokio::io::duplex(64);
        let joined = JoinedTransport {
            transport: Transport::WebSocket(Box::new(stream)),
            _connection_permit: permit,
        };
        let (sender, receiver) = oneshot::channel();

        assert!(sender.send(joined).is_ok());
        assert!(state.try_reserve_connection().is_none());
        let joined = receiver.await.unwrap();
        assert!(state.try_reserve_connection().is_none());

        drop(joined);
        assert!(state.try_reserve_connection().is_some());
    }

    #[test]
    fn one_device_has_one_dial_and_cancel_restores_pending_capacity() {
        let state = Arc::new(RelayState::with_limits(None, 8, 1, 8));
        let (first_receiver, first) = state
            .reserve_dial("channel-one".to_string(), "123456789".to_string())
            .unwrap();

        assert!(matches!(
            state.reserve_dial("channel-two".to_string(), "123456789".to_string()),
            Err(DialReservationError::DeviceBusy)
        ));
        assert!(matches!(
            state.reserve_dial("channel-two".to_string(), "987654321".to_string()),
            Err(DialReservationError::Capacity)
        ));
        assert!(state
            .take_pending_join("channel-one", "987654321")
            .is_none());
        assert_eq!(state.dials.lock().unwrap().joins.len(), 1);

        drop(first);
        assert!(first_receiver.blocking_recv().is_err());
        assert!(state.dials.lock().unwrap().joins.is_empty());
        assert!(state.dials.lock().unwrap().device_channels.is_empty());
        assert!(state
            .reserve_dial("channel-two".to_string(), "987654321".to_string())
            .is_ok());
    }

    #[test]
    fn a_join_keeps_the_device_reserved_until_the_link_ends() {
        let state = Arc::new(RelayState::with_limits(None, 8, 2, 8));
        let (_receiver, reservation) = state
            .reserve_dial("channel-one".to_string(), "123456789".to_string())
            .unwrap();
        let sender = state
            .take_pending_join("channel-one", "123456789")
            .expect("the matching device should claim its pending channel");
        drop(sender);

        assert!(state.dials.lock().unwrap().joins.is_empty());
        assert!(matches!(
            state.reserve_dial("channel-two".to_string(), "123456789".to_string()),
            Err(DialReservationError::DeviceBusy)
        ));

        drop(reservation);
        assert!(state
            .reserve_dial("channel-two".to_string(), "123456789".to_string())
            .is_ok());
    }

    #[test]
    fn full_device_registry_keeps_existing_owners_but_rejects_new_claims() {
        let state = RelayState::with_limits(None, 8, 2, 1);
        assert_eq!(state.verify_or_claim("123456789", "first-token"), Ok(()));
        assert_eq!(state.verify_or_claim("123456789", "first-token"), Ok(()));
        assert_eq!(
            state.verify_or_claim("123456789", "wrong-token"),
            Err(DeviceClaimError::AlreadyClaimed)
        );
        assert_eq!(
            state.verify_or_claim("987654321", "second-token"),
            Err(DeviceClaimError::Capacity)
        );
    }

    #[test]
    fn oversized_device_registry_is_read_bounded_and_fails_closed() {
        let directory = std::env::temp_dir().join(format!(
            "lattice-relay-oversized-registry-{}-{}",
            std::process::id(),
            random_channel_id().unwrap()
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("devices.json");
        std::fs::write(&path, vec![b' '; MAX_DEVICE_REGISTRY_BYTES as usize + 1]).unwrap();

        let state = RelayState::new(Some(path.clone()));
        assert!(!state.registry_healthy.load(Ordering::Acquire));
        assert_eq!(
            state.verify_or_claim("123456789", "token"),
            Err(DeviceClaimError::Unavailable)
        );

        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn malformed_device_registry_fails_closed() {
        let directory = std::env::temp_dir().join(format!(
            "lattice-relay-malformed-registry-{}-{}",
            std::process::id(),
            random_channel_id().unwrap()
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("devices.json");
        std::fs::write(&path, b"{not-json").unwrap();

        let state = RelayState::new(Some(path.clone()));
        assert!(!state.registry_healthy.load(Ordering::Acquire));
        assert_eq!(
            state.verify_or_claim("123456789", "token"),
            Err(DeviceClaimError::Unavailable)
        );

        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn over_capacity_device_registry_fails_closed_without_dropping_owners() {
        let directory = std::env::temp_dir().join(format!(
            "lattice-relay-full-registry-{}-{}",
            std::process::id(),
            random_channel_id().unwrap()
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("devices.json");
        let registry = HashMap::from([
            ("123456789".to_string(), hash_token("one")),
            ("987654321".to_string(), hash_token("two")),
        ]);
        std::fs::write(&path, serde_json::to_vec(&registry).unwrap()).unwrap();

        let state = RelayState::with_limits(Some(path.clone()), 8, 2, 1);
        assert!(!state.registry_healthy.load(Ordering::Acquire));
        assert!(!state.verify_only("123456789", "one"));
        assert_eq!(
            state.verify_or_claim("555555555", "three"),
            Err(DeviceClaimError::Unavailable)
        );

        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn relay_identity_fields_have_strict_size_and_shape_limits() {
        assert!(valid_agent_name("Remote workstation"));
        assert!(!valid_agent_name(""));
        assert!(!valid_agent_name("line\nbreak"));
        assert!(valid_agent_name(&"a".repeat(MAX_AGENT_NAME_BYTES)));
        assert!(!valid_agent_name(&"a".repeat(MAX_AGENT_NAME_BYTES + 1)));

        assert!(valid_auth_token("token"));
        assert!(!valid_auth_token(""));
        assert!(valid_auth_token(&"a".repeat(MAX_RELAY_AUTH_TOKEN_BYTES)));
        assert!(!valid_auth_token(
            &"a".repeat(MAX_RELAY_AUTH_TOKEN_BYTES + 1)
        ));

        assert!(valid_channel_id(&"a".repeat(CHANNEL_ID_HEX_BYTES)));
        assert!(!valid_channel_id(&"g".repeat(CHANNEL_ID_HEX_BYTES)));
        assert!(!valid_channel_id(&"a".repeat(CHANNEL_ID_HEX_BYTES - 1)));
    }

    #[cfg(unix)]
    #[test]
    fn persisted_device_registry_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let directory = std::env::temp_dir().join(format!(
            "lattice-relay-registry-{}-{}",
            std::process::id(),
            random_channel_id().unwrap()
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("devices.json");
        let state = RelayState::new(Some(path.clone()));

        let first = DeviceIdentity::generate().unwrap();
        state
            .verify_or_claim(&first.device_id, &first.auth_token)
            .unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let second = DeviceIdentity::generate().unwrap();
        state
            .verify_or_claim(&second.device_id, &second.auth_token)
            .unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );

        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    #[tokio::test]
    async fn dialing_an_unknown_device_reports_offline() {
        let (address, _state) = start_relay().await;
        let error = match dial(&address.to_string(), "123456789").await {
            Err(error) => error,
            Ok(_) => panic!("an unknown device unexpectedly connected"),
        };
        match error {
            crate::relay::RelayError::Rejected { code, .. } => assert_eq!(code, "offline"),
            other => panic!("expected an offline rejection, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_device_id_cannot_be_claimed_with_another_token() {
        let (address, _state) = start_relay().await;
        let identity = DeviceIdentity::generate().unwrap();
        let _control = register_agent(address, &identity).await;

        let mut thief = TcpStream::connect(address).await.unwrap();
        write_client_message(
            &mut thief,
            &RelayClientMessage::Register {
                device_id: identity.device_id.clone(),
                auth_token: "different-token".to_string(),
                agent_name: "Impostor".to_string(),
            },
        )
        .await
        .unwrap();
        match read_server_message(&mut thief).await.unwrap() {
            RelayServerMessage::Error { code, .. } => assert_eq!(code, "unauthorized"),
            other => panic!("expected a rejection, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn replacing_a_device_control_closes_the_old_carrier() {
        let (address, state) = start_relay().await;
        let identity = DeviceIdentity::generate().unwrap();
        let mut first = register_agent(address, &identity).await;
        let mut replacement = register_agent(address, &identity).await;

        assert!(
            timeout(Duration::from_secs(1), read_server_message(&mut first))
                .await
                .expect("the replaced control should close promptly")
                .is_err()
        );
        for _ in 0..50 {
            if state.connection_slots.available_permits() == MAX_ACTIVE_RELAY_CONNECTIONS - 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            state.connection_slots.available_permits(),
            MAX_ACTIVE_RELAY_CONNECTIONS - 1
        );

        write_client_message(&mut replacement, &RelayClientMessage::Ping)
            .await
            .unwrap();
        assert_eq!(
            read_server_message(&mut replacement).await.unwrap(),
            RelayServerMessage::Pong
        );
    }
}
