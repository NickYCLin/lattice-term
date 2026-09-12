//! Lifecycle bridge for the bundled Lattice Remote Agent.
//!
//! Hosting is always user-initiated. The generated pairing code lives only in
//! this process and the WebView state; it is never written to disk or logs.

use serde::{Deserialize, Serialize};
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex as AsyncMutex;
use tokio::time::timeout;

static NEXT_HOST: AtomicU64 = AtomicU64::new(1);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHostStartRequest {
    pub bind_address: String,
    pub port: u16,
    pub fps: u32,
    /// When true, the paired viewer may control this machine's mouse and
    /// keyboard. Defaults to false so an unset field stays view-only.
    #[serde(default)]
    pub allow_input: bool,
    #[serde(default)]
    pub allow_commands: bool,
    #[serde(default)]
    pub allow_chat: bool,
    /// File access is independently authorised from keyboard/mouse control.
    #[serde(default)]
    pub allow_files: bool,
    /// Empty means the current user's home folder when file sharing is enabled.
    #[serde(default)]
    pub file_root: String,
    /// "direct" (default) listens locally; "relay" registers the permanent
    /// device ID on a relay server and keeps serving sessions until stopped.
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub relay_address: String,
    /// Optional fixed pairing code for relay mode; empty generates one.
    #[serde(default)]
    pub pairing_code: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHostStatus {
    pub host_id: String,
    pub address: String,
    pub pairing_code: String,
    /// Zero means the code stays valid while sharing is on.
    pub expires_at: u64,
    pub view_only: bool,
    pub file_transfer: bool,
    pub commands: bool,
    pub chat: bool,
    pub file_root: Option<String>,
    pub state: &'static str,
    pub peer: Option<String>,
    pub attempts_remaining: u32,
    /// Relay mode: the permanent nine-digit device ID viewers dial.
    pub device_id: Option<String>,
    pub relay: Option<String>,
    /// True when the agent keeps serving sessions until stopped.
    pub persistent: bool,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum AgentEvent {
    Ready {
        address: String,
        pairing_code: String,
        expires_in_seconds: u64,
        view_only: bool,
        file_transfer: bool,
        #[serde(default)]
        commands: bool,
        file_root: Option<String>,
        #[serde(default)]
        device_id: Option<String>,
        #[serde(default)]
        relay: Option<String>,
        #[serde(default)]
        persistent: bool,
    },
    PairingRequest {
        peer: String,
    },
    PairingRejected {
        attempts_remaining: u32,
    },
    Paired {
        peer: String,
    },
    SessionEnded {
        reason: String,
    },
    RelayState {
        connected: bool,
    },
    Failed {
        stage: String,
        detail: String,
    },
    Stopped {
        reason: String,
    },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteHostClosedEvent {
    host_id: String,
    reason: String,
}

struct RemoteHostRecord {
    status: Mutex<RemoteHostStatus>,
    child: AsyncMutex<Child>,
    chat: Option<crate::remote_chat_host::Bridge>,
}

#[derive(Default)]
pub struct RemoteHostRegistry {
    current: Mutex<Option<Arc<RemoteHostRecord>>>,
    start_lock: AsyncMutex<()>,
}

impl RemoteHostRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn current(&self) -> Result<Option<Arc<RemoteHostRecord>>, String> {
        Ok(self
            .current
            .lock()
            .map_err(|error| error.to_string())?
            .clone())
    }

    fn insert(&self, record: Arc<RemoteHostRecord>) -> Result<(), String> {
        *self.current.lock().map_err(|error| error.to_string())? = Some(record);
        Ok(())
    }

    fn take(&self) -> Result<Option<Arc<RemoteHostRecord>>, String> {
        Ok(self
            .current
            .lock()
            .map_err(|error| error.to_string())?
            .take())
    }

    fn remove_if(&self, host_id: &str) -> Result<bool, String> {
        let mut current = self.current.lock().map_err(|error| error.to_string())?;
        let matches = current
            .as_ref()
            .and_then(|record| record.status.lock().ok())
            .map(|status| status.host_id == host_id)
            .unwrap_or(false);
        if matches {
            current.take();
        }
        Ok(matches)
    }

    pub fn status(&self) -> Result<Option<RemoteHostStatus>, String> {
        self.current()?
            .map(|record| {
                record
                    .status
                    .lock()
                    .map(|status| status.clone())
                    .map_err(|error| error.to_string())
            })
            .transpose()
    }
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn host_id() -> String {
    let sequence = NEXT_HOST.fetch_add(1, Ordering::Relaxed);
    format!("host-{}-{sequence}", now_seconds())
}

fn executable_name() -> &'static str {
    if cfg!(windows) {
        "lattice-agent.exe"
    } else {
        "lattice-agent"
    }
}

fn agent_path() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("LATTICE_REMOTE_AGENT") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
        return Err("LATTICE_REMOTE_AGENT does not point to a file.".to_string());
    }

    let mut candidates = Vec::new();
    if let Ok(current) = std::env::current_exe() {
        if let Some(parent) = current.parent() {
            candidates.push(parent.join(executable_name()));
        }
    }
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    candidates.push(
        manifest
            .join("../crates/lattice-remote/target/debug")
            .join(executable_name()),
    );
    candidates.push(
        manifest
            .join("../crates/lattice-remote/target/release")
            .join(executable_name()),
    );

    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            "Lattice Remote Agent is not built. Run `npm run build:remote` or set LATTICE_REMOTE_AGENT."
                .to_string()
        })
}

/// Prefer a LAN IPv4 address. Link-local IPv6 needs a scope ID and cannot be
/// advertised as a plain IP. Offline hosts remain available on loopback.
fn automatic_bind_address(addresses: impl Iterator<Item = IpAddr>) -> IpAddr {
    addresses
        .filter(|address| match address {
            IpAddr::V4(ip) => {
                !ip.is_loopback()
                    && !ip.is_unspecified()
                    && !ip.is_multicast()
                    && !ip.is_link_local()
                    && !ip.is_broadcast()
            }
            IpAddr::V6(ip) => {
                !ip.is_loopback()
                    && !ip.is_unspecified()
                    && !ip.is_multicast()
                    && !ip.is_unicast_link_local()
            }
        })
        .min_by_key(|address| match address {
            IpAddr::V4(ip) if ip.is_private() => 0,
            IpAddr::V4(_) => 1,
            IpAddr::V6(_) => 2,
        })
        .unwrap_or(IpAddr::V4(std::net::Ipv4Addr::LOCALHOST))
}

fn bind_target(request: &RemoteHostStartRequest) -> Result<SocketAddr, String> {
    let address: IpAddr = if request.bind_address.trim().is_empty() {
        let interfaces = if_addrs::get_if_addrs()
            .map_err(|error| format!("Cannot read network interfaces: {error}"))?;
        automatic_bind_address(
            interfaces
                .into_iter()
                .filter(|interface| interface.is_oper_up())
                .map(|interface| interface.ip()),
        )
    } else {
        request
            .bind_address
            .trim()
            .parse()
            .map_err(|_| "The bind address must be an IP address.".to_string())?
    };
    if address.is_unspecified() || address.is_multicast() {
        return Err("Choose a specific loopback or network interface address.".to_string());
    }
    if request.port == 0 {
        return Err("The host port must be between 1 and 65535.".to_string());
    }
    if !(1..=10).contains(&request.fps) {
        return Err("Frame rate must be between 1 and 10 FPS.".to_string());
    }
    Ok(SocketAddr::new(address, request.port))
}

/// Where the agent runs: listening locally, or registered on a relay under
/// the permanent device identity kept in the app data folder.
enum AgentTarget<'a> {
    Direct(SocketAddr),
    Relay {
        address: &'a str,
        identity: &'a Path,
        pairing_code: Option<&'a str>,
    },
}

async fn spawn_agent(
    target: AgentTarget<'_>,
    fps: u32,
    allow_input: bool,
    allow_commands: bool,
    file_root: Option<&Path>,
    chat: Option<&crate::remote_chat_host::Bridge>,
    direct_pairing_code: Option<&str>,
) -> Result<(Child, tokio::process::ChildStdout), String> {
    let mut command = Command::new(agent_path()?);
    command.arg("--json");
    // The desktop owns the sharing UI; the bundled console engine stays hidden.
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW; keep redirected pipes.
    command
        .env_remove("LATTICE_CHAT_BRIDGE")
        .env_remove("LATTICE_CHAT_TOKEN");
    if let Some(chat) = chat {
        command
            .env("LATTICE_CHAT_BRIDGE", &chat.address)
            .env("LATTICE_CHAT_TOKEN", &chat.token);
    }
    let mut pairing_code_input = None;
    match target {
        AgentTarget::Direct(address) => {
            if let Some(code) = direct_pairing_code {
                command.arg("--pair-code-stdin");
                pairing_code_input = Some(code);
            }
            command.arg("--bind").arg(address.to_string());
        }
        AgentTarget::Relay {
            address,
            identity,
            pairing_code,
        } => {
            command.arg("--relay").arg(address);
            command.arg("--identity").arg(identity);
            if let Some(code) = pairing_code {
                command.arg("--pair-code-stdin");
                pairing_code_input = Some(code);
            }
        }
    }
    command.arg("--fps").arg(fps.to_string());
    if allow_input {
        command.arg("--allow-input");
    }
    if allow_commands {
        command.arg("--allow-commands");
    }
    if let Some(file_root) = file_root {
        command.arg("--file-root").arg(file_root);
    }
    let mut child = command
        .stdin(if pairing_code_input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| error.to_string())?;
    if let Some(code) = pairing_code_input {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "The Lattice Agent secret pipe is unavailable.".to_string())?;
        stdin
            .write_all(code.as_bytes())
            .await
            .map_err(|error| format!("Cannot send the pairing code to the Agent: {error}"))?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|error| format!("Cannot finish the Agent pairing code: {error}"))?;
        stdin
            .shutdown()
            .await
            .map_err(|error| format!("Cannot close the Agent secret pipe: {error}"))?;
    }
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "The Lattice Agent event stream is unavailable.".to_string())?;
    Ok((child, stdout))
}

fn parse_event(line: &str) -> Result<AgentEvent, String> {
    serde_json::from_str(line).map_err(|error| format!("Invalid Agent event: {error}"))
}

fn emit_status(app: &AppHandle, status: &RemoteHostStatus) {
    let _ = app.emit("remote-host://status", status.clone());
}

fn identity_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot locate the app data folder: {error}"))?;
    std::fs::create_dir_all(&base)
        .map_err(|error| format!("Cannot prepare the app data folder: {error}"))?;
    Ok(base.join("remote-identity.json"))
}

fn permanent_device_id_at(path: &Path) -> Result<String, String> {
    lattice_remote::relay::DeviceIdentity::load_or_create(path)
        .map(|identity| identity.device_id)
        .map_err(|error| format!("Cannot load the permanent device identity: {error}"))
}

/// Returns only the public nine-digit ID. The relay authentication token and
/// Noise private key never cross the native IPC boundary into the WebView.
pub async fn device_id(app: &AppHandle, registry: &RemoteHostRegistry) -> Result<String, String> {
    let _start_guard = registry.start_lock.lock().await;
    permanent_device_id_at(&identity_path(app)?)
}

pub async fn start(
    app: AppHandle,
    registry: Arc<RemoteHostRegistry>,
    request: RemoteHostStartRequest,
) -> Result<RemoteHostStatus, String> {
    start_inner(app, registry, request, false).await
}
pub async fn configure(
    app: AppHandle,
    registry: Arc<RemoteHostRegistry>,
    request: RemoteHostStartRequest,
) -> Result<RemoteHostStatus, String> {
    start_inner(app, registry, request, true).await
}
async fn start_inner(
    app: AppHandle,
    registry: Arc<RemoteHostRegistry>,
    request: RemoteHostStartRequest,
    replace: bool,
) -> Result<RemoteHostStatus, String> {
    let _start_guard = registry.start_lock.lock().await;
    if !replace && registry.current()?.is_some() {
        return Err("This device is already sharing its display.".to_string());
    }

    if request.allow_commands && !cfg!(windows) {
        return Err("Command execution requires a Windows sharing host.".into());
    }
    let relay_mode = request.mode.trim() == "relay";
    let direct_target = if relay_mode {
        if !(1..=10).contains(&request.fps) {
            return Err("Frame rate must be between 1 and 10 FPS.".to_string());
        }
        lattice_remote::relay::normalize_relay_endpoint(&request.relay_address)
            .map_err(|error| error.to_string())?;
        None
    } else {
        Some(bind_target(&request)?)
    };
    let fixed_code = if !request.pairing_code.is_empty() {
        Some(
            lattice_remote::normalize_pairing_code(&request.pairing_code)
                .map_err(|error| error.to_string())?,
        )
    } else {
        None
    };
    let identity_path = if relay_mode {
        let path = identity_path(&app)?;
        permanent_device_id_at(&path)?;
        Some(path)
    } else {
        None
    };
    let file_root = if request.allow_files {
        let requested = request.file_root.trim();
        let path = if requested.is_empty() {
            app.path()
                .home_dir()
                .map_err(|error| format!("Cannot locate the home folder: {error}"))?
        } else {
            PathBuf::from(requested)
        };
        let canonical = std::fs::canonicalize(&path)
            .map_err(|error| format!("Cannot open the shared folder: {error}"))?;
        if !canonical.is_dir() {
            return Err("The shared file root must be a folder.".to_string());
        }
        Some(canonical)
    } else {
        None
    };
    let target = match (&direct_target, &identity_path) {
        (Some(address), _) => AgentTarget::Direct(*address),
        (None, Some(identity)) => AgentTarget::Relay {
            address: request.relay_address.trim(),
            identity,
            pairing_code: fixed_code.as_deref(),
        },
        (None, None) => return Err("The sharing mode is incomplete.".to_string()),
    };
    if replace {
        stop(&app, &registry).await?;
    }
    let sharing_id = host_id();
    let chat = if request.allow_chat {
        Some(crate::remote_chat_host::Bridge::start(app.clone(), sharing_id.clone()).await?)
    } else {
        None
    };
    let (mut child, stdout) = spawn_agent(
        target,
        request.fps,
        request.allow_input,
        request.allow_commands,
        file_root.as_deref(),
        chat.as_ref(),
        fixed_code.as_deref(),
    )
    .await?;
    let mut lines = BufReader::new(stdout).lines();
    let first = match timeout(Duration::from_secs(12), lines.next_line()).await {
        Ok(Ok(Some(line))) => parse_event(&line),
        Ok(Ok(None)) => Err("The Lattice Agent exited before it was ready.".to_string()),
        Ok(Err(error)) => Err(error.to_string()),
        Err(_) => Err("The Lattice Agent did not become ready within 12 seconds.".to_string()),
    };

    let ready = match first {
        Ok(ready @ AgentEvent::Ready { .. }) => ready,
        Ok(AgentEvent::Failed { stage, detail }) => {
            let _ = child.kill().await;
            return Err(format!("{stage}: {detail}"));
        }
        Ok(_) => {
            let _ = child.kill().await;
            return Err("The Lattice Agent did not report a ready event first.".to_string());
        }
        Err(error) => {
            let _ = child.kill().await;
            return Err(error);
        }
    };
    let AgentEvent::Ready {
        address,
        pairing_code,
        expires_in_seconds,
        view_only,
        file_transfer,
        commands,
        file_root,
        device_id,
        relay,
        persistent,
    } = ready
    else {
        unreachable!("checked above");
    };

    let status = RemoteHostStatus {
        host_id: sharing_id,
        address,
        pairing_code,
        // Zero from the agent means the code never expires while sharing.
        expires_at: if expires_in_seconds == 0 {
            0
        } else {
            now_seconds().saturating_add(expires_in_seconds)
        },
        view_only,
        file_transfer,
        commands,
        chat: request.allow_chat,
        file_root,
        state: "waiting",
        peer: None,
        attempts_remaining: 5,
        device_id,
        relay,
        persistent,
    };
    let record = Arc::new(RemoteHostRecord {
        status: Mutex::new(status.clone()),
        child: AsyncMutex::new(child),
        chat,
    });
    registry.insert(Arc::clone(&record))?;

    let watcher_app = app.clone();
    let watcher_registry = Arc::clone(&registry);
    let watcher_host_id = status.host_id.clone();
    tokio::spawn(async move {
        let mut reason = "The Lattice Agent exited.".to_string();
        loop {
            let line = match lines.next_line().await {
                Ok(Some(line)) => line,
                Ok(None) => break,
                Err(error) => {
                    reason = error.to_string();
                    break;
                }
            };
            match parse_event(&line) {
                Ok(AgentEvent::PairingRequest { peer }) => {
                    if let Ok(mut status) = record.status.lock() {
                        status.state = "pairing";
                        status.peer = Some(peer);
                        emit_status(&watcher_app, &status);
                    }
                }
                Ok(AgentEvent::PairingRejected { attempts_remaining }) => {
                    if let Ok(mut status) = record.status.lock() {
                        status.state = "waiting";
                        status.peer = None;
                        status.attempts_remaining = attempts_remaining;
                        emit_status(&watcher_app, &status);
                    }
                }
                Ok(AgentEvent::Paired { peer }) => {
                    if let Ok(mut status) = record.status.lock() {
                        status.state = "streaming";
                        status.peer = Some(peer);
                        // A one-shot code is spent now; a persistent share
                        // keeps its code for the sessions that follow.
                        if !status.persistent {
                            status.pairing_code.clear();
                        }
                        emit_status(&watcher_app, &status);
                    }
                }
                Ok(AgentEvent::SessionEnded { reason }) => {
                    // The viewer side already surfaced the reason through
                    // remote://closed; the host only returns to waiting.
                    drop(reason);
                    if let Ok(mut status) = record.status.lock() {
                        status.state = "waiting";
                        status.peer = None;
                        emit_status(&watcher_app, &status);
                    }
                }
                Ok(AgentEvent::RelayState { connected }) => {
                    if let Ok(mut status) = record.status.lock() {
                        if status.state != "streaming" {
                            status.state = if connected { "waiting" } else { "reconnecting" };
                            emit_status(&watcher_app, &status);
                        }
                    }
                }
                Ok(AgentEvent::Failed { stage, detail }) => {
                    reason = format!("{stage}: {detail}");
                    break;
                }
                Ok(AgentEvent::Stopped {
                    reason: stopped_reason,
                }) => {
                    reason = stopped_reason;
                    break;
                }
                Ok(AgentEvent::Ready { .. }) => {
                    reason = "The Lattice Agent sent a second ready event.".to_string();
                    break;
                }
                Err(error) => {
                    reason = error;
                    break;
                }
            }
        }
        let mut child = record.child.lock().await;
        if !matches!(child.try_wait(), Ok(Some(_))) {
            let _ = child.kill().await;
        }
        drop(child);
        if watcher_registry
            .remove_if(&watcher_host_id)
            .unwrap_or(false)
        {
            let _ = watcher_app.emit(
                "remote-host://closed",
                RemoteHostClosedEvent {
                    host_id: watcher_host_id,
                    reason,
                },
            );
        }
    });

    Ok(status)
}

pub async fn stop(app: &AppHandle, registry: &RemoteHostRegistry) -> Result<(), String> {
    if let Some(record) = registry.take()? {
        if let Some(chat) = &record.chat {
            chat.stop();
        }
        let host_id = record
            .status
            .lock()
            .map_err(|error| error.to_string())?
            .host_id
            .clone();
        let _ = record.child.lock().await.kill().await;
        let _ = app.emit(
            "remote-host://closed",
            RemoteHostClosedEvent {
                host_id,
                reason: "Sharing was stopped on this device.".to_string(),
            },
        );
    }
    Ok(())
}

pub fn chat_reply(
    registry: &RemoteHostRegistry,
    host_id: &str,
    response: lattice_remote::chat_protocol::ChatResponse,
) -> Result<(), String> {
    let record = registry.current()?.ok_or("Sharing stopped.")?;
    if record.status.lock().map_err(|e| e.to_string())?.host_id != host_id {
        return Err("Sharing changed.".into());
    }
    record
        .chat
        .as_ref()
        .ok_or("Conversation sharing is disabled.")?
        .reply(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automatic_standby_selects_a_connectable_interface() {
        let addresses = [
            "127.0.0.1",
            "fe80::1",
            "0.0.0.0",
            "::",
            "203.0.113.2",
            "192.168.1.2",
        ];
        assert_eq!(
            automatic_bind_address(addresses.into_iter().map(|value| value.parse().unwrap()))
                .to_string(),
            "192.168.1.2"
        );
        assert_eq!(
            automatic_bind_address(std::iter::empty()).to_string(),
            "127.0.0.1"
        );
    }

    #[test]
    fn accepts_specific_ipv4_and_ipv6_bind_addresses() {
        let ipv4 = bind_target(&RemoteHostStartRequest {
            bind_address: "192.168.1.20".to_string(),
            port: 44_900,
            fps: 5,
            allow_input: false,
            allow_commands: false,
            allow_chat: false,
            allow_files: false,
            file_root: String::new(),
            mode: String::new(),
            relay_address: String::new(),
            pairing_code: String::new(),
        })
        .unwrap();
        assert_eq!(ipv4.to_string(), "192.168.1.20:44900");

        let ipv6 = bind_target(&RemoteHostStartRequest {
            bind_address: "::1".to_string(),
            port: 44_900,
            fps: 10,
            allow_input: true,
            allow_commands: false,
            allow_chat: false,
            allow_files: false,
            file_root: String::new(),
            mode: String::new(),
            relay_address: String::new(),
            pairing_code: String::new(),
        })
        .unwrap();
        assert_eq!(ipv6.to_string(), "[::1]:44900");
    }

    #[test]
    fn refuses_broad_or_invalid_host_bindings() {
        for bind_address in ["0.0.0.0", "::", "example.com"] {
            assert!(bind_target(&RemoteHostStartRequest {
                bind_address: bind_address.to_string(),
                port: 44_900,
                fps: 5,
                allow_input: false,
                allow_commands: false,
                allow_chat: false,
                allow_files: false,
                file_root: String::new(),
                mode: String::new(),
                relay_address: String::new(),
                pairing_code: String::new(),
            })
            .is_err());
        }
    }

    #[test]
    fn permanent_device_id_is_reused_from_the_identity_file() {
        let directory = std::env::temp_dir().join(format!(
            "latticeterm-host-identity-{}-{}",
            std::process::id(),
            now_seconds()
        ));
        let path = directory.join("remote-identity.json");
        let first = permanent_device_id_at(&path).unwrap();
        let second = permanent_device_id_at(&path).unwrap();

        assert_eq!(first, second);
        assert_eq!(first.len(), 9);
        assert!(first.bytes().all(|byte| byte.is_ascii_digit()));

        let _ = std::fs::remove_dir_all(directory);
    }
}
