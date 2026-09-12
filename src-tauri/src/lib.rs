pub mod agent;
pub mod agent_chat;
pub mod agent_daemon;
pub mod agent_history;
pub mod agent_plans;
mod agent_process;
#[cfg(desktop)]
pub mod app_menu;
pub mod backup;
mod chat_attachments;
pub mod clipboard;
pub mod credentials;
pub mod domain;
pub mod file_exports;
pub mod hostkeys;
#[cfg(target_os = "linux")]
pub mod linux_webkit;
pub mod mcp_desktop;
pub mod mcp_screen;
pub mod metrics;
pub mod notification_sound;
pub mod rdp;
pub mod remote;
pub mod remote_files;
pub mod remote_host;
pub mod remote_pins;
pub mod sftp;
mod sftp_limits;
#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
mod sftp_test_server;
pub mod sftp_text;
pub mod sftp_transfers;
pub mod shared_agent_rules;
mod sidecar;
pub mod ssh;
pub mod storage;
pub mod transcript;
pub mod tunnel;
pub mod vault;
pub mod vnc;

use crate::agent::{
    AgentBroadcastOutcome, AgentDefinition, AgentLaunchPlan, AgentLaunchPlanDraft,
    AgentLaunchRequest, AgentOutputSnapshot, AgentRegistry, AgentRestoreOutcome,
    AgentSessionSummary, MAX_SAVED_AGENT_PLANS,
};
use crate::agent_history::AgentTerminalHistoryStore;
use crate::agent_plans::{AgentPlanSnapshot, FileAgentPlanStore};
use crate::backup::{DecryptedBackup, ValidatedAppData};
use crate::clipboard::{SensitiveClipboard, SensitiveClipboardClearOutcome};
use crate::credentials::{CredentialKind, CredentialStoreStatus};
use crate::domain::{ConnectionProfile, Protocol};
use crate::hostkeys::{HostKeyRecord, HostTrustStore};
use crate::rdp::{
    RdpConnectOutcome, RdpConnectRequest, RdpInputRequest, RdpRegistry, RdpSessionSummary,
};
use crate::remote::{
    RemoteConnectOutcome, RemoteConnectRequest, RemoteInputRequest, RemoteRegistry,
    RemoteSessionSummary, RemoteTerminalSnapshot,
};
use crate::remote_files::{RemoteDirectory, RemoteFileTransfer};
use crate::remote_host::{RemoteHostRegistry, RemoteHostStartRequest, RemoteHostStatus};
use crate::sftp::{
    SftpConnectOutcome, SftpConnectRequest, SftpDirectory, SftpRegistry, SftpSessionSummary,
};
use crate::sftp_transfers::{TransferRegistry, TransferState};
use crate::shared_agent_rules::SharedAgentRulesSnapshot;
use crate::ssh::{ConnectOutcome, ConnectRequest, EventSink, SessionSummary, SshRegistry};
use crate::storage::{FileStorage, Storage};
use crate::tunnel::{StartTunnelRequest, TunnelRegistry, TunnelStatus, TunnelStatusSummary};
use crate::vnc::{
    VncConnectOutcome, VncConnectRequest, VncInputRequest, VncRegistry, VncSessionSummary,
};
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};
use zeroize::Zeroizing;

type AppStorage = Mutex<FileStorage>;
type AppAgentHistory = Mutex<AgentTerminalHistoryStore>;
type AppDaemon = Arc<crate::agent_daemon::client::DaemonClient>;
type AppAgentPlans = Mutex<FileAgentPlanStore>;

/// Serialize persisted launch settings and their daemon grant. A late sync
/// must never restore an older grant after the user has withdrawn it.
#[derive(Default)]
struct McpPlanSync(tokio::sync::Mutex<()>);

#[derive(Default)]
struct McpRemoteSync(tokio::sync::Mutex<()>);

/// The live screens the user could share with MCP: RDP, VNC and Lattice
/// Remote display sessions. A terminal-only Remote share has no screen and
/// is left out rather than offered and then refused.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct McpScreenSession {
    session_id: String,
    host: String,
    backend: mcp_desktop::Backend,
}

#[tauri::command]
fn mcp_screen_sessions(
    rdp: State<'_, Arc<RdpRegistry>>,
    vnc: State<'_, Arc<VncRegistry>>,
    remote: State<'_, Arc<RemoteRegistry>>,
) -> Vec<McpScreenSession> {
    let mut sessions: Vec<McpScreenSession> = rdp
        .list()
        .into_iter()
        .map(|session| McpScreenSession {
            session_id: session.session_id,
            host: session.host,
            backend: mcp_desktop::Backend::Rdp,
        })
        .chain(vnc.list().into_iter().map(|session| McpScreenSession {
            session_id: session.session_id,
            host: session.host,
            backend: mcp_desktop::Backend::Vnc,
        }))
        .chain(
            remote
                .list()
                .into_iter()
                .filter(|session| !session.terminal)
                .map(|session| McpScreenSession {
                    session_id: session.session_id,
                    host: session.host,
                    backend: mcp_desktop::Backend::Remote,
                }),
        )
        .collect();
    sessions.sort_by(|left, right| left.session_id.cmp(&right.session_id));
    sessions
}

#[tauri::command]
fn mcp_remote_targets(
    service: State<'_, Arc<mcp_desktop::DesktopService>>,
) -> Vec<mcp_desktop::TargetView> {
    service.targets()
}

#[tauri::command]
async fn mcp_remote_grant(
    request: mcp_desktop::GrantRequest,
    service: State<'_, Arc<mcp_desktop::DesktopService>>,
    daemon: State<'_, AppDaemon>,
    sync: State<'_, McpRemoteSync>,
) -> Result<Vec<mcp_desktop::TargetView>, String> {
    let _guard = sync.0.lock().await;
    // Ensure and negotiate before creating a grant. No implicit remote login.
    let connection = daemon.ensure().await?;
    connection
        .request(agent_daemon::Request::DesktopGrants {
            targets: service.targets(),
        })
        .await?;
    let grant = service
        .grant(request)
        .await
        .map_err(|error| error.message)?;
    let targets = service.targets();
    if let Err(error) = connection
        .request(agent_daemon::Request::DesktopGrants {
            targets: targets.clone(),
        })
        .await
    {
        let _ = service.revoke(&grant.id);
        if connection
            .request(agent_daemon::Request::DesktopGrants {
                targets: service.targets(),
            })
            .await
            .is_err()
        {
            return Err(format!("{error} Local access was revoked, but the remote grant display could not be synchronized."));
        }
        return Err(error);
    }
    Ok(targets)
}

#[tauri::command]
async fn mcp_remote_revoke(
    target_id: String,
    service: State<'_, Arc<mcp_desktop::DesktopService>>,
    daemon: State<'_, AppDaemon>,
    sync: State<'_, McpRemoteSync>,
) -> Result<Vec<mcp_desktop::TargetView>, String> {
    let _guard = sync.0.lock().await;
    // Backend withdrawal succeeds even when the daemon is unavailable.
    service.revoke(&target_id).map_err(|error| error.message)?;
    let targets = service.targets();
    if let Some(connection) = daemon.attached().await {
        connection
            .request(agent_daemon::Request::DesktopGrants {
                targets: targets.clone(),
            })
            .await?;
    }
    Ok(targets)
}

const MAX_CLIPBOARD_IMAGE_EDGE: u32 = 16_384;
const MAX_CLIPBOARD_IMAGE_PIXELS: usize = 32 * 1024 * 1024;
const CLIPBOARD_EXIT_TIMEOUT: Duration = Duration::from_millis(750);

fn validate_clipboard_image(width: u32, height: u32, rgba_bytes: usize) -> Result<(), String> {
    if width == 0 || height == 0 {
        return Err("The clipboard image is empty.".to_string());
    }
    if width > MAX_CLIPBOARD_IMAGE_EDGE || height > MAX_CLIPBOARD_IMAGE_EDGE {
        return Err("The clipboard image dimensions are too large.".to_string());
    }
    let pixels = usize::try_from(width)
        .ok()
        .and_then(|width| {
            usize::try_from(height)
                .ok()
                .and_then(|height| width.checked_mul(height))
        })
        .ok_or_else(|| "The clipboard image dimensions are invalid.".to_string())?;
    if pixels > MAX_CLIPBOARD_IMAGE_PIXELS {
        return Err("The clipboard image contains too many pixels.".to_string());
    }
    let expected_bytes = pixels
        .checked_mul(4)
        .ok_or_else(|| "The clipboard image size is invalid.".to_string())?;
    if rgba_bytes != expected_bytes {
        return Err("The clipboard image pixel data is invalid.".to_string());
    }
    Ok(())
}

/// The trust store, or the reason it could not be opened.
///
/// An unreadable trust file must never degrade into an empty one: that would
/// turn every already-trusted host back into a fresh prompt and hide a changed
/// key among them. Connecting is refused instead, with the reason attached.
pub enum TrustState {
    Ready(Mutex<HostTrustStore>),
    Unavailable(String),
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

#[tauri::command]
async fn play_notification_sound(sound: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || notification_sound::play(&sound))
        .await
        .map_err(|error| format!("Notification sound did not complete: {error}"))?
}

async fn credential_call<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("Credential operation did not complete: {error}"))?
}

async fn backup_call<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("Backup operation did not complete: {error}"))?
}

async fn clipboard_call<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("Clipboard operation did not complete: {error}"))?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeSummary {
    app_name: &'static str,
    version: &'static str,
    supported_protocols: &'static [&'static str],
    credential_storage_ready: bool,
    /// "windows" | "macos" | "linux" | "android" | "ios" — the interface
    /// hides desktop-only areas (agents, sidecar engines) on mobile.
    platform: &'static str,
    /// Whether a file-scope sandbox tool (bubblewrap) is available, so the
    /// launch form only offers the option where it can be honoured.
    agent_sandbox_available: bool,
}

const DESKTOP_PROTOCOLS: &[&str] = &["ssh", "sftp", "rdp", "vnc", "lattice"];
const MOBILE_PROTOCOLS: &[&str] = &["ssh", "sftp", "lattice"];

/// Session engines registered by each operating-system package. Keeping this
/// platform-driven (rather than compile-target-only) makes the contract easy
/// to verify for Android and iOS in desktop CI.
fn supported_protocols_for(platform: &str) -> &'static [&'static str] {
    match platform {
        "android" | "ios" => MOBILE_PROTOCOLS,
        _ => DESKTOP_PROTOCOLS,
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedBackupExport {
    contents: String,
    created_at: u64,
    app_file_count: usize,
    vault_included: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedBackupRestore {
    source_created_at: u64,
    source_app_version: String,
    profile_count: usize,
    trusted_host_count: usize,
    agent_plan_count: usize,
    vault_included: bool,
    local_storage: BTreeMap<String, String>,
}

/// Probing the OS keyring and the sandbox tool can block for seconds when
/// Secret Service or `bwrap` is slow to answer, so every command that
/// touches them runs off the main thread; a stuck keyring must not freeze
/// the whole window.
#[tauri::command]
async fn runtime_summary() -> Result<RuntimeSummary, String> {
    credential_call(|| {
        let platform = std::env::consts::OS;
        Ok(RuntimeSummary {
            app_name: "LatticeTerm",
            version: env!("CARGO_PKG_VERSION"),
            supported_protocols: supported_protocols_for(platform),
            credential_storage_ready: crate::credentials::status().ready,
            platform,
            agent_sandbox_available: crate::agent::sandbox_tool().is_some(),
        })
    })
    .await
}

fn backup_trust_guard(
    trust: &TrustState,
) -> Result<std::sync::MutexGuard<'_, HostTrustStore>, String> {
    match trust {
        TrustState::Ready(store) => store.lock().map_err(|error| error.to_string()),
        TrustState::Unavailable(reason) => Err(format!(
            "Host trust data is unavailable and cannot be backed up: {reason}"
        )),
    }
}

#[tauri::command]
async fn ios_export_document(
    app: AppHandle,
    filename: String,
    contents: String,
) -> Result<String, String> {
    #[cfg(target_os = "ios")]
    {
        let directory = app
            .path()
            .document_dir()
            .map_err(|error| error.to_string())?;
        tauri::async_runtime::spawn_blocking(move || {
            crate::file_exports::save_document(&directory, &filename, &contents)
        })
        .await
        .map_err(|error| error.to_string())?
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, filename, contents);
        Err("This export destination is only available on iOS.".into())
    }
}

#[tauri::command]
async fn encrypted_backup_export(
    app: AppHandle,
    password: String,
    local_storage: BTreeMap<String, String>,
    storage: State<'_, AppStorage>,
    plans: State<'_, AppAgentPlans>,
    trust: State<'_, TrustState>,
) -> Result<EncryptedBackupExport, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let (files, validated) = crate::vault::manager()?.run_while_locked(|| {
        // Hold every mutable file-backed store while taking the snapshot, so
        // one logical backup cannot contain half of a concurrent mutation.
        let _storage = storage.lock().map_err(|error| error.to_string())?;
        let _plans = plans.lock().map_err(|error| error.to_string())?;
        let _trust = backup_trust_guard(trust.inner())?;
        let files = crate::backup::read_app_files(&directory)?;
        let validated = crate::backup::validate_app_files(&files)?;
        Ok((files, validated))
    })?;
    let created_at = now_seconds();
    let app_file_count = files.len();
    let contents = backup_call(move || {
        let password = Zeroizing::new(password);
        crate::backup::create_encrypted_backup(
            env!("CARGO_PKG_VERSION"),
            created_at,
            files,
            local_storage,
            password.as_str(),
        )
    })
    .await?;
    Ok(EncryptedBackupExport {
        contents,
        created_at,
        app_file_count,
        vault_included: validated.vault_included,
    })
}

fn restore_loaded_stores(
    directory: &std::path::Path,
) -> Result<(FileStorage, FileAgentPlanStore, HostTrustStore), String> {
    let storage = FileStorage::open(directory).map_err(|error| error.to_string())?;
    if let Some(recovery) = storage.recovery() {
        return Err(format!(
            "Restored connection data is invalid: {}",
            recovery.reason
        ));
    }
    let plans = FileAgentPlanStore::open(directory)?;
    if let Some(recovery) = plans.snapshot().recovery {
        return Err(format!(
            "Restored Agent workspace data is invalid: {}",
            recovery.reason
        ));
    }
    let trust = HostTrustStore::open(directory).map_err(|error| error.to_string())?;
    Ok((storage, plans, trust))
}

fn restore_failure_with_rollback(
    directory: &std::path::Path,
    previous: &BTreeMap<String, String>,
    error: String,
) -> String {
    match crate::backup::rollback_app_files(directory, previous) {
        Ok(()) => format!("The backup restore was rolled back: {error}"),
        Err(rollback_error) => format!(
            "The backup restore failed ({error}), and rollback also failed ({rollback_error})."
        ),
    }
}

#[tauri::command]
async fn encrypted_backup_restore(
    app: AppHandle,
    contents: String,
    password: String,
    storage: State<'_, AppStorage>,
    plans: State<'_, AppAgentPlans>,
    trust: State<'_, TrustState>,
    tunnels: State<'_, Arc<TunnelRegistry>>,
) -> Result<EncryptedBackupRestore, String> {
    if tunnels
        .list()
        .iter()
        .any(|entry| matches!(entry.status, TunnelStatus::Starting | TunnelStatus::Active))
    {
        return Err("Stop every running SSH tunnel before restoring a backup.".to_string());
    }

    let (decrypted, validated) = backup_call(move || {
        let password = Zeroizing::new(password);
        let decrypted = crate::backup::open_encrypted_backup(&contents, password.as_str())?;
        let validated = crate::backup::validate_app_files(&decrypted.files)?;
        Ok((decrypted, validated))
    })
    .await?;
    let DecryptedBackup {
        created_at,
        app_version,
        files,
        local_storage,
    } = decrypted;
    let ValidatedAppData {
        profile_count,
        trusted_host_count,
        agent_plan_count,
        vault_included,
    } = validated;

    if tunnels
        .list()
        .iter()
        .any(|entry| matches!(entry.status, TunnelStatus::Starting | TunnelStatus::Active))
    {
        return Err("Stop every running SSH tunnel before restoring a backup.".to_string());
    }

    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    crate::vault::manager()?.run_while_locked(|| {
        let mut storage_guard = storage.lock().map_err(|error| error.to_string())?;
        let mut plans_guard = plans.lock().map_err(|error| error.to_string())?;
        let mut trust_guard = backup_trust_guard(trust.inner())?;
        let previous = crate::backup::replace_app_files(&directory, &files)?;
        let (next_storage, next_plans, next_trust) = match restore_loaded_stores(&directory) {
            Ok(stores) => stores,
            Err(error) => {
                return Err(restore_failure_with_rollback(&directory, &previous, error));
            }
        };

        *storage_guard = next_storage;
        *plans_guard = next_plans;
        *trust_guard = next_trust;
        Ok(())
    })?;

    Ok(EncryptedBackupRestore {
        source_created_at: created_at,
        source_app_version: app_version,
        profile_count,
        trusted_host_count,
        agent_plan_count,
        vault_included,
        local_storage,
    })
}

#[tauri::command]
fn agent_catalog() -> Vec<AgentDefinition> {
    crate::agent::catalog()
}

#[tauri::command]
fn agent_default_working_directory() -> Result<String, String> {
    crate::agent::default_working_directory()
}

#[tauri::command]
async fn agent_launch(
    app: AppHandle,
    mut request: AgentLaunchRequest,
    registry: State<'_, Arc<AgentRegistry>>,
    plans: State<'_, AppAgentPlans>,
    history: State<'_, AppAgentHistory>,
    daemon: State<'_, AppDaemon>,
) -> Result<AgentSessionSummary, String> {
    let replay_key = request
        .group_id
        .clone()
        .filter(|group_id| !group_id.trim().is_empty())
        .map(|group_id| (group_id, request.definition_id.clone()));
    let restored_output = replay_key.as_ref().and_then(|(group_id, definition_id)| {
        history
            .lock()
            .ok()
            .and_then(|store| store.replay_for(group_id, definition_id))
    });
    let startup_instructions = plans
        .lock()
        .map_err(|error| error.to_string())?
        .snapshot()
        .startup_instructions;
    crate::agent::apply_startup_instructions(&mut request, &startup_instructions)?;
    let launched = if request.detached {
        // The background daemon owns this one; it replays the same tail the
        // desktop would have, then keeps running after the window is gone.
        use base64::Engine as _;
        let restored_output = restored_output
            .as_deref()
            .map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes));
        let value = daemon
            .request(
                true,
                crate::agent_daemon::Request::Launch {
                    request: Box::new(request),
                    restored_output,
                },
            )
            .await?;
        serde_json::from_value(value)
            .map_err(|error| format!("The background service answered oddly: {error}"))?
    } else {
        crate::agent::launch_with_replay(
            Arc::new(crate::agent::EventSink(app)),
            Arc::clone(registry.inner()),
            request,
            restored_output,
        )?
    };
    if let Some((group_id, definition_id)) = replay_key {
        if let Ok(mut store) = history.lock() {
            store.consume_replay(&group_id, &definition_id);
        }
    }
    Ok(launched)
}

#[tauri::command]
async fn agent_send(
    app: AppHandle,
    session_id: String,
    data: String,
    registry: State<'_, Arc<AgentRegistry>>,
    daemon: State<'_, AppDaemon>,
) -> Result<(), String> {
    if crate::agent_daemon::owns(&session_id) {
        daemon
            .request(
                false,
                crate::agent_daemon::Request::Send { session_id, data },
            )
            .await
            .map(|_| ())
    } else {
        crate::agent::send(
            &crate::agent::EventSink(app),
            registry.inner(),
            &session_id,
            &data,
        )
    }
}

/// Lines a prompt up behind whatever the agent is already doing.
///
/// Returns how many prompts are now waiting; zero means the agent was free
/// and took it immediately.
#[tauri::command]
async fn agent_enqueue(
    app: AppHandle,
    session_id: String,
    data: String,
    registry: State<'_, Arc<AgentRegistry>>,
    daemon: State<'_, AppDaemon>,
) -> Result<usize, String> {
    if crate::agent_daemon::owns(&session_id) {
        let value = daemon
            .request(
                false,
                crate::agent_daemon::Request::Enqueue { session_id, data },
            )
            .await?;
        serde_json::from_value(value).map_err(|error| error.to_string())
    } else {
        crate::agent::enqueue(
            &crate::agent::EventSink(app),
            registry.inner(),
            &session_id,
            &data,
        )
    }
}

/// Drops every prompt still waiting for this agent, reporting how many went.
#[tauri::command]
async fn agent_clear_queue(
    app: AppHandle,
    session_id: String,
    registry: State<'_, Arc<AgentRegistry>>,
    daemon: State<'_, AppDaemon>,
) -> Result<usize, String> {
    if crate::agent_daemon::owns(&session_id) {
        let value = daemon
            .request(
                false,
                crate::agent_daemon::Request::ClearQueue { session_id },
            )
            .await?;
        serde_json::from_value(value).map_err(|error| error.to_string())
    } else {
        crate::agent::clear_queue(&crate::agent::EventSink(app), registry.inner(), &session_id)
    }
}

/// Creates (or finds) LatticeTerm's own configuration directory for one
/// account profile and returns its path.
#[tauri::command]
fn agent_account_profile_directory(
    app: AppHandle,
    definition_id: String,
    profile_id: String,
) -> Result<String, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot locate the application data directory: {error}"))?;
    crate::agent::account_profile_directory(&data_dir, &definition_id, &profile_id)
        .map(|path| path.display().to_string())
}

/// Login state of one account profile, read from its own directory.
#[tauri::command]
async fn agent_account_profile_status(
    definition_id: String,
    config_directory: String,
) -> Result<crate::agent::AgentAccountInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::agent::account_profile_status(
            &definition_id,
            std::path::Path::new(&config_directory),
        )
    })
    .await
    .map_err(|error| format!("Account profile status did not complete: {error}"))
}

/// Removes a profile directory LatticeTerm created, login data included.
#[tauri::command]
async fn agent_account_profile_remove(
    app: AppHandle,
    definition_id: String,
    profile_id: String,
) -> Result<bool, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot locate the application data directory: {error}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::agent::remove_account_profile_directory(&data_dir, &definition_id, &profile_id)
    })
    .await
    .map_err(|error| format!("Account profile removal did not complete: {error}"))?
}

/// The CLIs a chat thread can be started with on this machine.
#[tauri::command]
fn agent_chat_supported() -> Vec<String> {
    crate::agent_chat::supported_definitions()
        .iter()
        .map(|id| id.to_string())
        .collect()
}

/// Runs one chat turn. Returns once the CLI is running; its reply arrives
/// as `agent-chat://event` events carrying the same thread and turn ids.
#[tauri::command]
async fn agent_chat_send(
    app: AppHandle,
    mut request: crate::agent_chat::ChatTurnRequest,
    registry: State<'_, Arc<crate::agent_chat::AgentChatRegistry>>,
) -> Result<(), String> {
    if request.working_directory.trim().is_empty() {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("Cannot locate the application data directory: {error}"))?;
        request.working_directory =
            crate::agent_chat::general_chat_directory(&data_dir, &request.thread_id)?
                .display()
                .to_string();
    }
    let registry = Arc::clone(registry.inner());
    crate::agent_chat::send(
        Arc::new(crate::agent_chat::EventSink(app)),
        registry,
        request,
    )
    .await
}

/// Adds an instruction to the specified active Codex turn.
#[tauri::command]
async fn agent_chat_steer(
    request: crate::agent_chat::ChatSteerRequest,
    registry: State<'_, Arc<crate::agent_chat::AgentChatRegistry>>,
) -> Result<(), String> {
    crate::agent_chat::steer(Arc::clone(registry.inner()), request).await
}

/// Stops the turn running on a thread, if any.
#[tauri::command]
fn agent_chat_stop(
    thread_id: String,
    registry: State<'_, Arc<crate::agent_chat::AgentChatRegistry>>,
) -> Result<bool, String> {
    registry.stop(&thread_id)
}

/// Ends everything serving a thread: its running turn and, for Codex, the
/// server kept alive between turns. Called when a thread is deleted.
#[tauri::command]
fn agent_chat_close(
    thread_id: String,
    registry: State<'_, Arc<crate::agent_chat::AgentChatRegistry>>,
) -> Result<bool, String> {
    registry.close(&thread_id)
}

/// Allows or denies one tool call a chat turn is waiting on.
#[tauri::command]
async fn agent_chat_respond(
    thread_id: String,
    request_id: String,
    allow: bool,
    message: Option<String>,
    registry: State<'_, Arc<crate::agent_chat::AgentChatRegistry>>,
) -> Result<(), String> {
    let registry = Arc::clone(registry.inner());
    crate::agent_chat::respond(registry, &thread_id, &request_id, allow, message.as_deref()).await
}

/// The models a chat CLI offers right now; empty when it cannot say.
#[tauri::command]
async fn agent_chat_models(
    definition_id: String,
    profile_config_path: Option<String>,
    registry: State<'_, Arc<crate::agent_chat::AgentChatRegistry>>,
) -> Result<Vec<crate::agent_chat::ChatModelChoice>, String> {
    crate::agent_chat::list_models(
        Arc::clone(registry.inner()),
        &definition_id,
        profile_config_path.as_deref(),
    )
    .await
}

/// Reads skill names/descriptions from the selected local CLI profile and
/// workspace. It deliberately never returns the skill bodies or auth files.
#[tauri::command]
async fn agent_chat_skills(
    definition_id: String,
    working_directory: String,
    profile_config_path: Option<String>,
) -> Result<Vec<crate::agent_chat::ChatSkill>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::agent_chat::list_skills(
            &definition_id,
            &working_directory,
            profile_config_path.as_deref(),
        )
    })
    .await
    .map_err(|error| format!("Skill discovery task did not complete: {error}"))?
}

#[tauri::command]
async fn agent_broadcast(
    app: AppHandle,
    session_ids: Vec<String>,
    data: String,
    registry: State<'_, Arc<AgentRegistry>>,
    daemon: State<'_, AppDaemon>,
) -> Result<Vec<AgentBroadcastOutcome>, String> {
    let (background, local): (Vec<String>, Vec<String>) = session_ids
        .into_iter()
        .partition(|session_id| crate::agent_daemon::owns(session_id));
    let mut outcomes = if local.is_empty() {
        Vec::new()
    } else {
        crate::agent::broadcast(
            &crate::agent::EventSink(app),
            registry.inner(),
            &local,
            &data,
        )?
    };
    if !background.is_empty() {
        match daemon
            .request(
                false,
                crate::agent_daemon::Request::Broadcast {
                    session_ids: background.clone(),
                    data,
                },
            )
            .await
        {
            Ok(value) => {
                let more: Vec<AgentBroadcastOutcome> =
                    serde_json::from_value(value).map_err(|error| error.to_string())?;
                outcomes.extend(more);
            }
            Err(error) => {
                outcomes.extend(
                    background
                        .into_iter()
                        .map(|session_id| AgentBroadcastOutcome {
                            session_id,
                            delivered: false,
                            error: Some(error.clone()),
                        }),
                )
            }
        }
    }
    Ok(outcomes)
}

/// Saves an explicitly pasted chat image for later sends and queued turns.
#[tauri::command]
async fn agent_chat_paste_image(
    app: AppHandle,
    thread_id: String,
    clipboard: State<'_, Arc<SensitiveClipboard>>,
) -> Result<Option<String>, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot locate the application data directory: {error}"))?;
    let clipboard = Arc::clone(clipboard.inner());
    tauri::async_runtime::spawn_blocking(move || {
        // Reject unsafe destinations before reading the clipboard.
        crate::agent_chat::general_chat_directory(&data_dir, &thread_id)?;
        let Some((width, height, rgba)) = clipboard.read_image_rgba(&app)? else {
            return Ok(None);
        };
        let path = crate::chat_attachments::stage_clipboard_image(
            &data_dir, &thread_id, width, height, &rgba,
        )?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|error| format!("Clipboard image operation did not complete: {error}"))?
}

/// Writes an image sitting on the clipboard to a temp PNG and returns its path.
///
/// Local agent CLIs (Claude Code, Gemini, …) accept an image by its file path,
/// so on Ctrl+V the frontend pastes this path in. Returns `None` when the
/// clipboard holds no image, which the caller treats as "nothing to paste".
#[tauri::command]
async fn agent_paste_clipboard_image(
    app: AppHandle,
    session_id: String,
    registry: State<'_, Arc<AgentRegistry>>,
    clipboard: State<'_, Arc<SensitiveClipboard>>,
    daemon: State<'_, AppDaemon>,
) -> Result<Option<String>, String> {
    let registry = Arc::clone(registry.inner());
    let clipboard = Arc::clone(clipboard.inner());
    if crate::agent_daemon::owns(&session_id) {
        // The daemon owns the PTY, so it owns the staged file too; the PNG
        // travels over the socket instead of through a shared temp path.
        let encoded = tauri::async_runtime::spawn_blocking(move || {
            let Some((width, height, rgba)) = clipboard.read_image_rgba(&app)? else {
                return Ok::<Option<String>, String>(None);
            };
            if width == 0 || height == 0 {
                return Ok(None);
            }
            validate_clipboard_image(width, height, rgba.len())?;
            let mut png_bytes = Vec::new();
            {
                let mut encoder = png::Encoder::new(&mut png_bytes, width, height);
                encoder.set_color(png::ColorType::Rgba);
                encoder.set_depth(png::BitDepth::Eight);
                let mut png_writer = encoder
                    .write_header()
                    .map_err(|err| format!("Cannot encode the pasted image: {err}"))?;
                png_writer
                    .write_image_data(&rgba)
                    .map_err(|err| format!("Cannot encode the pasted image: {err}"))?;
            }
            use base64::Engine as _;
            Ok(Some(
                base64::engine::general_purpose::STANDARD.encode(png_bytes),
            ))
        })
        .await
        .map_err(|error| format!("Clipboard image operation did not complete: {error}"))??;
        let Some(png) = encoded else {
            return Ok(None);
        };
        let value = daemon
            .request(
                false,
                crate::agent_daemon::Request::StageImage { session_id, png },
            )
            .await?;
        return Ok(value.as_str().map(str::to_string));
    }
    tauri::async_runtime::spawn_blocking(move || {
        // Validate the target before reading potentially sensitive clipboard data.
        if registry.session_summary(&session_id).is_none() {
            return Err("Agent session no longer exists.".to_string());
        }

        let Some((width, height, rgba)) = clipboard.read_image_rgba(&app)? else {
            return Ok(None);
        };
        if width == 0 || height == 0 {
            return Ok(None);
        }
        validate_clipboard_image(width, height, rgba.len())?;

        let mut file = tempfile::Builder::new()
            .prefix("latticeterm-clip-")
            .suffix(".png")
            .tempfile()
            .map_err(|err| format!("Cannot stage the pasted image: {err}"))?;
        {
            let writer = std::io::BufWriter::new(file.as_file_mut());
            let mut encoder = png::Encoder::new(writer, width, height);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut png_writer = encoder
                .write_header()
                .map_err(|err| format!("Cannot encode the pasted image: {err}"))?;
            png_writer
                .write_image_data(&rgba)
                .map_err(|err| format!("Cannot encode the pasted image: {err}"))?;
        }
        let path = registry.stage_clipboard_image(&session_id, file)?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|error| format!("Clipboard image operation did not complete: {error}"))?
}

/// Reads a running CLI's own conversation into plain, role-labelled text so it
/// can be handed to another CLI as an opening brief. `None` when the CLI's
/// history format is unsupported or nothing was found.
#[tauri::command]
async fn agent_export_transcript(
    session_id: String,
    registry: State<'_, Arc<AgentRegistry>>,
    daemon: State<'_, AppDaemon>,
) -> Result<Option<String>, String> {
    const MAX_HANDOFF_CHARS: usize = 12000;
    let summary = if crate::agent_daemon::owns(&session_id) {
        daemon.session_summary(&session_id).await
    } else {
        registry.session_summary(&session_id)
    };
    let Some(summary) = summary else {
        return Ok(None);
    };
    let Some(kind) = crate::transcript::TranscriptKind::from_definition(&summary.definition_id)
    else {
        return Ok(None);
    };
    // Transcript discovery can walk a large, user-owned CLI history.  It
    // must never occupy Tauri's command worker and make unrelated sessions,
    // connections, or UI actions wait behind a handoff.
    let working_directory = summary.working_directory;
    let captured_session_id = summary.captured_session_id;
    let profile_config_path = summary.profile_config_path;
    tauri::async_runtime::spawn_blocking(move || {
        crate::transcript::export(
            kind,
            &working_directory,
            captured_session_id.as_deref(),
            profile_config_path.as_deref().map(std::path::Path::new),
            MAX_HANDOFF_CHARS,
        )
    })
    .await
    .map_err(|error| format!("Transcript export task did not complete: {error}"))
}

/// Persists an opt-in handoff only when the target CLI has a documented,
/// editable memory format. A false result tells the frontend to keep using the
/// one-time terminal handoff instead.
#[tauri::command]
async fn agent_import_memory_handoff(
    target_definition_id: String,
    working_directory: String,
    source_label: String,
    transcript: String,
) -> Result<bool, String> {
    // This can touch a network-mounted project or a CLI memory file.  Keep
    // the intentional file write off the command executor for the same
    // reason as export above.
    tauri::async_runtime::spawn_blocking(move || {
        crate::transcript::import_handoff_into_memory(
            &target_definition_id,
            &working_directory,
            &source_label,
            &transcript,
        )
    })
    .await
    .map_err(|error| format!("Memory handoff task did not complete: {error}"))?
}

/// Writes a handoff brief to LatticeTerm's data directory and returns its
/// path, so the next CLI can be pointed at it instead of having the whole
/// text pasted into its terminal.
#[tauri::command]
async fn agent_write_handoff_file(
    app: AppHandle,
    source_label: String,
    transcript: String,
) -> Result<String, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot locate the application data directory: {error}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::transcript::write_handoff_file(&data_dir, &source_label, &transcript)
            .map(|path| crate::agent::plain_win32_path(path).display().to_string())
    })
    .await
    .map_err(|error| format!("Handoff file task did not complete: {error}"))?
}

#[tauri::command]
async fn agent_resize(
    session_id: String,
    cols: u32,
    rows: u32,
    registry: State<'_, Arc<AgentRegistry>>,
    daemon: State<'_, AppDaemon>,
) -> Result<(), String> {
    if crate::agent_daemon::owns(&session_id) {
        daemon
            .request(
                false,
                crate::agent_daemon::Request::Resize {
                    session_id,
                    cols,
                    rows,
                },
            )
            .await
            .map(|_| ())
    } else {
        crate::agent::resize(registry.inner(), &session_id, cols, rows)
    }
}

#[tauri::command]
async fn agent_disconnect(
    app: AppHandle,
    session_id: String,
    registry: State<'_, Arc<AgentRegistry>>,
    daemon: State<'_, AppDaemon>,
) -> Result<(), String> {
    if crate::agent_daemon::owns(&session_id) {
        daemon
            .request(
                false,
                crate::agent_daemon::Request::Disconnect { session_id },
            )
            .await
            .map(|_| ())
    } else {
        crate::agent::disconnect(&crate::agent::EventSink(app), registry.inner(), &session_id)
    }
}

/// Desktop sessions plus whatever the background daemon holds, if it runs.
#[tauri::command]
async fn agent_sessions(
    registry: State<'_, Arc<AgentRegistry>>,
    daemon: State<'_, AppDaemon>,
) -> Result<Vec<AgentSessionSummary>, String> {
    let mut sessions = registry.list();
    sessions.extend(daemon.sessions().await);
    Ok(sessions)
}

#[tauri::command]
async fn agent_rename(
    session_id: String,
    label: String,
    registry: State<'_, Arc<AgentRegistry>>,
    daemon: State<'_, AppDaemon>,
) -> Result<AgentSessionSummary, String> {
    if crate::agent_daemon::owns(&session_id) {
        let value = daemon
            .request(
                false,
                crate::agent_daemon::Request::Rename { session_id, label },
            )
            .await?;
        serde_json::from_value(value).map_err(|error| error.to_string())
    } else {
        registry.rename(&session_id, &label)
    }
}

#[tauri::command]
async fn agent_output_snapshots(
    registry: State<'_, Arc<AgentRegistry>>,
    daemon: State<'_, AppDaemon>,
) -> Result<Vec<AgentOutputSnapshot>, String> {
    let mut snapshots = registry.output_snapshots();
    snapshots.extend(daemon.snapshots().await);
    Ok(snapshots)
}

/// Whether the background service is up, how many sessions it holds, which
/// of them the user shared with MCP observers, and how an MCP client should
/// start the adapter for this installation.
#[tauri::command]
async fn agent_daemon_status(daemon: State<'_, AppDaemon>) -> Result<AgentDaemonStatus, String> {
    let sessions = daemon.sessions().await;
    let shared = match daemon
        .request(false, crate::agent_daemon::Request::Shared)
        .await
    {
        Ok(value) => serde_json::from_value(value).unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    // Older running daemons may not implement history. Do not present an
    // unavailable history as a verified empty one.
    let history = daemon
        .request(false, crate::agent_daemon::Request::McpHistory)
        .await
        .ok()
        .and_then(|value| serde_json::from_value(value).ok());
    Ok(AgentDaemonStatus {
        running: daemon.is_running().await,
        mcp_needs_restart: daemon.mcp_needs_restart().await,
        mcp_output_scopes: daemon.mcp_output_scopes().await,
        sessions: sessions.len(),
        shared,
        history,
        mcp: crate::agent_daemon::mcp::launch_for(&daemon.paths().data_dir),
    })
}

/// Shares one background session with MCP observers, or stops sharing it.
/// Only a session the daemon holds can be shared: the desktop's own
/// sessions have no observer path at all.
#[tauri::command]
async fn agent_mcp_share(
    session_id: String,
    shared: bool,
    read_output: Option<bool>,
    daemon: State<'_, AppDaemon>,
) -> Result<Vec<crate::agent_daemon::SharedSession>, String> {
    if !crate::agent_daemon::owns(&session_id) {
        return Err("Only sessions kept in the background can be shared.".to_string());
    }
    let value = daemon
        .request(
            false,
            crate::agent_daemon::Request::ShareSet {
                session_id,
                shared,
                read_output,
            },
        )
        .await?;
    decode_mcp_shared_response(value)
}

/// Lets MCP clients prompt and end one shared background session, or takes
/// that back. A separate grant from sharing: reading is not writing.
#[tauri::command]
async fn agent_mcp_control(
    session_id: String,
    control: bool,
    daemon: State<'_, AppDaemon>,
) -> Result<Vec<crate::agent_daemon::SharedSession>, String> {
    if !crate::agent_daemon::owns(&session_id) {
        return Err("Only sessions kept in the background can be controlled.".to_string());
    }
    let value = daemon
        .request(
            false,
            crate::agent_daemon::Request::ControlSet {
                session_id,
                control,
            },
        )
        .await?;
    decode_mcp_shared_response(value)
}

fn decode_mcp_shared_response(
    value: serde_json::Value,
) -> Result<Vec<crate::agent_daemon::SharedSession>, String> {
    serde_json::from_value(value).map_err(|error| error.to_string())
}

/// Whether MCP clients may start saved plans; persisted with the plans.
#[tauri::command]
async fn agent_workspace_mcp_launch_update(
    enabled: bool,
    plans: State<'_, AppAgentPlans>,
    daemon: State<'_, AppDaemon>,
    sync: State<'_, McpPlanSync>,
) -> Result<bool, String> {
    change_mcp_plan_settings(
        &plans,
        &sync,
        |store| store.update_mcp_launch(enabled),
        |snapshot| publish_mcp_plans(snapshot, &daemon),
    )
    .await
}

/// Hands the background service the saved plans MCP clients may launch:
/// only those marked "keep in the background", already prepared the way
/// a restore prepares them, and only while the user allows launching.
#[tauri::command]
async fn agent_mcp_plans_sync(
    plans: State<'_, AppAgentPlans>,
    daemon: State<'_, AppDaemon>,
    sync: State<'_, McpPlanSync>,
) -> Result<bool, String> {
    sync_mcp_plan_settings(&plans, &sync, |snapshot| {
        publish_mcp_plans(snapshot, &daemon)
    })
    .await
}

async fn sync_mcp_plan_settings<P, Fut>(
    plans: &AppAgentPlans,
    sync: &McpPlanSync,
    publish: P,
) -> Result<bool, String>
where
    P: Fn(AgentPlanSnapshot) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    let _sync = sync.0.lock().await;
    let snapshot = plans.lock().map_err(|error| error.to_string())?.snapshot();
    let enabled = snapshot.mcp_launch;
    // Reopening a window only hands over the current settings. The daemon
    // preserves the generation of an equivalent plan list, so this does not
    // cancel a launch that is already in progress.
    if let Err(error) = publish(snapshot.clone()).await {
        return Err(disable_failed_mcp_plan_sync(plans, snapshot, &publish, error).await);
    }
    Ok(enabled)
}

async fn change_mcp_plan_settings<T, F, P, Fut>(
    plans: &AppAgentPlans,
    sync: &McpPlanSync,
    change: F,
    publish: P,
) -> Result<T, String>
where
    F: FnOnce(&mut FileAgentPlanStore) -> Result<T, String>,
    P: Fn(AgentPlanSnapshot) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    let _sync = sync.0.lock().await;
    let previous = plans.lock().map_err(|error| error.to_string())?.snapshot();
    let result = {
        let mut store = plans.lock().map_err(|error| error.to_string())?;
        change(&mut store)
    };
    let snapshot = plans.lock().map_err(|error| error.to_string())?.snapshot();
    let synchronized = async {
        // A failed save must never reactivate a grant, especially when that
        // save was the user's request to turn it off.
        result.as_ref().map_err(Clone::clone)?;
        // Compare all persisted fields after normalization/upsert. An
        // unchanged autosave must not interrupt an in-flight MCP launch.
        if serde_json::to_value(&previous).map_err(|error| error.to_string())?
            == serde_json::to_value(&snapshot).map_err(|error| error.to_string())?
        {
            return Ok(());
        }
        if previous.mcp_launch {
            let mut disabled = previous;
            disabled.mcp_launch = false;
            disabled.plans.clear();
            publish(disabled).await?;
        }
        publish(snapshot.clone()).await
    }
    .await;
    if let Err(error) = synchronized {
        return Err(disable_failed_mcp_plan_sync(plans, snapshot, &publish, error).await);
    }
    result
}

async fn disable_failed_mcp_plan_sync<P, Fut>(
    plans: &AppAgentPlans,
    mut snapshot: AgentPlanSnapshot,
    publish: &P,
    error: String,
) -> String
where
    P: Fn(AgentPlanSnapshot) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    // Keep the plans but persist a disabled grant, so a failed enable is not
    // retried on the next window open. Failure to confirm live withdrawal
    // remains an explicit error rather than a successful checkbox update.
    let persisted = plans
        .lock()
        .map_err(|error| error.to_string())
        .and_then(|mut store| store.update_mcp_launch(false));
    snapshot.mcp_launch = false;
    snapshot.plans.clear();
    let revoked = publish(snapshot).await;
    let mut reason = format!("MCP launch settings could not be synchronized: {error}");
    if let Err(error) = persisted {
        reason.push_str(&format!("; could not save the disabled grant: {error}"));
    }
    if let Err(error) = revoked {
        reason.push_str(&format!(
            "; could not confirm withdrawal from the background service: {error}"
        ));
    }
    reason
}

fn prepare_mcp_plans(
    snapshot: &AgentPlanSnapshot,
) -> Result<Vec<crate::agent_daemon::McpPlan>, String> {
    if !snapshot.mcp_launch {
        return Ok(Vec::new());
    }
    snapshot
        .plans
        .iter()
        .filter(|plan| plan.detached)
        .map(|plan| {
            let mut request = crate::agent::launch_request_from_plan(plan, 120, 32)?;
            crate::agent::apply_startup_instructions(&mut request, &snapshot.startup_instructions)?;
            Ok(crate::agent_daemon::McpPlan {
                plan_id: plan.id.clone(),
                label: plan.label.clone(),
                note: plan.note.clone(),
                definition_id: plan.definition_id.clone(),
                working_directory: plan.working_directory.clone(),
                sandbox: plan.sandbox,
                request,
            })
        })
        .collect()
}

async fn publish_mcp_plans(snapshot: AgentPlanSnapshot, daemon: &AppDaemon) -> Result<(), String> {
    let enabled = snapshot.mcp_launch;
    let prepared = prepare_mcp_plans(&snapshot)?;
    if !enabled && !daemon.is_running().await {
        return Ok(());
    }
    daemon
        .request(
            enabled,
            crate::agent_daemon::Request::McpPlansReplace {
                enabled,
                plans: prepared,
            },
        )
        .await?;
    Ok(())
}

/// Ends every background session and the service itself. The window asks
/// for confirmation first; nothing here is recoverable.
#[tauri::command]
async fn agent_daemon_stop(daemon: State<'_, AppDaemon>) -> Result<bool, String> {
    match daemon
        .request(false, crate::agent_daemon::Request::Shutdown)
        .await
    {
        Ok(_) => Ok(true),
        Err(error) if daemon.is_running().await => Err(error),
        Err(_) => Ok(false),
    }
}

/// Hands the window's automation list to the background service, starting
/// it when anything is enabled, and returns the service's runtime marks.
#[tauri::command]
async fn agent_automations_sync(
    automations: Vec<serde_json::Value>,
    daemon: State<'_, AppDaemon>,
) -> Result<Vec<crate::agent_daemon::automations::AutomationStatus>, String> {
    let any_enabled = automations.iter().any(|automation| {
        automation
            .get("enabled")
            .and_then(serde_json::Value::as_bool)
            == Some(true)
    });
    if !any_enabled && !daemon.is_running().await {
        return Ok(Vec::new());
    }
    let value = daemon
        .request(
            any_enabled,
            crate::agent_daemon::Request::AutomationsReplace { automations },
        )
        .await?;
    serde_json::from_value(value).map_err(|error| error.to_string())
}

#[tauri::command]
async fn agent_automations_state(
    daemon: State<'_, AppDaemon>,
) -> Result<Vec<crate::agent_daemon::automations::AutomationStatus>, String> {
    match daemon
        .request(false, crate::agent_daemon::Request::AutomationsState)
        .await
    {
        Ok(value) => serde_json::from_value(value).map_err(|error| error.to_string()),
        Err(_) => Ok(Vec::new()),
    }
}

/// Runs the background service finished while no window was open. Each is
/// handed over exactly once; the window turns it into an unread thread.
#[tauri::command]
async fn agent_automations_take_runs(
    daemon: State<'_, AppDaemon>,
) -> Result<Vec<crate::agent_daemon::automations::RunRecord>, String> {
    match daemon
        .request(false, crate::agent_daemon::Request::AutomationsTakeRuns)
        .await
    {
        Ok(value) => serde_json::from_value(value).map_err(|error| error.to_string()),
        Err(_) => Ok(Vec::new()),
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentDaemonStatus {
    running: bool,
    mcp_needs_restart: bool,
    mcp_output_scopes: bool,
    sessions: usize,
    /// Sessions shared with MCP observers, with their grants.
    shared: Vec<crate::agent_daemon::SharedSession>,
    history: Option<crate::agent_daemon::audit::Snapshot>,
    mcp: crate::agent_daemon::mcp::McpLaunch,
}

#[tauri::command]
fn agent_shared_rules_inspect(
    project_directory: String,
) -> Result<SharedAgentRulesSnapshot, String> {
    crate::shared_agent_rules::inspect(&project_directory)
}

#[tauri::command]
fn agent_shared_rules_save(
    project_directory: String,
    content: String,
    expected_revision: String,
) -> Result<SharedAgentRulesSnapshot, String> {
    crate::shared_agent_rules::save(&project_directory, &content, &expected_revision)
}

#[tauri::command]
fn agent_plan_snapshot(plans: State<'_, AppAgentPlans>) -> Result<AgentPlanSnapshot, String> {
    Ok(plans.lock().map_err(|error| error.to_string())?.snapshot())
}

#[tauri::command]
async fn agent_plan_save(
    draft: AgentLaunchPlanDraft,
    plans: State<'_, AppAgentPlans>,
    daemon: State<'_, AppDaemon>,
    sync: State<'_, McpPlanSync>,
) -> Result<AgentLaunchPlan, String> {
    change_mcp_plan_settings(
        &plans,
        &sync,
        |store| store.save(draft),
        |snapshot| publish_mcp_plans(snapshot, &daemon),
    )
    .await
}

#[tauri::command]
async fn agent_plan_delete(
    id: String,
    plans: State<'_, AppAgentPlans>,
    daemon: State<'_, AppDaemon>,
    sync: State<'_, McpPlanSync>,
) -> Result<bool, String> {
    change_mcp_plan_settings(
        &plans,
        &sync,
        |store| store.delete(&id),
        |snapshot| publish_mcp_plans(snapshot, &daemon),
    )
    .await
}

#[tauri::command]
fn agent_workspace_rename(name: String, plans: State<'_, AppAgentPlans>) -> Result<String, String> {
    plans
        .lock()
        .map_err(|error| error.to_string())?
        .rename(&name)
}

#[tauri::command]
async fn agent_workspace_instructions_update(
    instructions: String,
    plans: State<'_, AppAgentPlans>,
    daemon: State<'_, AppDaemon>,
    sync: State<'_, McpPlanSync>,
) -> Result<String, String> {
    change_mcp_plan_settings(
        &plans,
        &sync,
        |store| store.update_startup_instructions(&instructions),
        |snapshot| publish_mcp_plans(snapshot, &daemon),
    )
    .await
}

#[tauri::command]
fn agent_plan_reorder(
    ordered_ids: Vec<String>,
    plans: State<'_, AppAgentPlans>,
) -> Result<Vec<AgentLaunchPlan>, String> {
    plans
        .lock()
        .map_err(|error| error.to_string())?
        .reorder(&ordered_ids)
}

#[tauri::command]
async fn agent_plan_restore(
    app: AppHandle,
    plan_ids: Vec<String>,
    plans: State<'_, AppAgentPlans>,
    registry: State<'_, Arc<AgentRegistry>>,
    daemon: State<'_, AppDaemon>,
) -> Result<Vec<AgentRestoreOutcome>, String> {
    if plan_ids.is_empty() {
        return Err("Select at least one saved launch plan.".to_string());
    }
    if plan_ids.len() > MAX_SAVED_AGENT_PLANS {
        return Err(format!(
            "At most {MAX_SAVED_AGENT_PLANS} launch plans may be restored at once."
        ));
    }
    let mut unique = HashSet::with_capacity(plan_ids.len());
    for plan_id in &plan_ids {
        if plan_id.trim() != plan_id || plan_id.is_empty() || plan_id.len() > 128 {
            return Err("A saved launch plan ID is invalid.".to_string());
        }
        if !unique.insert(plan_id.as_str()) {
            return Err(
                "Saved launch plans cannot be restored more than once per request.".to_string(),
            );
        }
    }

    let (selected, startup_instructions) = {
        let guard = plans.lock().map_err(|error| error.to_string())?;
        let selected = plan_ids
            .iter()
            .map(|plan_id| {
                guard
                    .find(plan_id)
                    .ok_or_else(|| format!("Saved launch plan '{plan_id}' no longer exists."))
            })
            .collect::<Result<Vec<_>, _>>()?;
        (selected, guard.snapshot().startup_instructions)
    };
    let sink: Arc<dyn crate::agent::AgentSink> = Arc::new(crate::agent::EventSink(app));
    let mut outcomes = Vec::with_capacity(selected.len());
    for plan in selected {
        let plan_id = plan.id.clone();
        let label = plan.label.clone();
        let prepared =
            crate::agent::launch_request_from_plan(&plan, 120, 32).and_then(|mut request| {
                crate::agent::apply_startup_instructions(&mut request, &startup_instructions)?;
                Ok(request)
            });
        let launched = match prepared {
            // A plan saved with "keep in the background" comes back the same
            // way: the daemon owns it again after this restart.
            Ok(request) if request.detached => daemon
                .request(
                    true,
                    crate::agent_daemon::Request::Launch {
                        request: Box::new(request),
                        restored_output: None,
                    },
                )
                .await
                .and_then(|value| {
                    serde_json::from_value::<AgentSessionSummary>(value)
                        .map_err(|error| format!("The background service answered oddly: {error}"))
                }),
            Ok(request) => {
                crate::agent::launch(Arc::clone(&sink), Arc::clone(registry.inner()), request)
            }
            Err(error) => Err(error),
        };
        outcomes.push(match launched {
            Ok(session) => AgentRestoreOutcome {
                plan_id,
                label,
                session: Some(session),
                error: None,
            },
            Err(error) => AgentRestoreOutcome {
                plan_id,
                label,
                session: None,
                error: Some(error),
            },
        });
    }
    Ok(outcomes)
}

/// Where connection data lives, and whether anything had to be rescued on the
/// way in. Surfaced in Settings so the file is never a mystery to the user.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageStatus {
    path: String,
    profile_count: usize,
    /// Present only when an unreadable file was set aside at startup.
    recovered_reason: Option<String>,
    recovered_backup_path: Option<String>,
}

#[tauri::command]
fn storage_status(storage: State<'_, AppStorage>) -> Result<StorageStatus, String> {
    let guard = storage.lock().map_err(|e| e.to_string())?;
    let recovery = guard.recovery();

    Ok(StorageStatus {
        path: guard.path().display().to_string(),
        profile_count: guard.list_profiles().map_err(|e| e.to_string())?.len(),
        recovered_reason: recovery.map(|r| r.reason.clone()),
        recovered_backup_path: recovery.map(|r| r.backup_path.display().to_string()),
    })
}

#[tauri::command]
fn list_connection_profiles(
    storage: State<'_, AppStorage>,
) -> Result<Vec<ConnectionProfile>, String> {
    let guard = storage.lock().map_err(|e| e.to_string())?;
    guard.list_profiles().map_err(|e| e.to_string())
}

#[tauri::command]
fn save_connection_profile(
    profile: ConnectionProfile,
    storage: State<'_, AppStorage>,
) -> Result<(), String> {
    let mut guard = storage.lock().map_err(|e| e.to_string())?;
    guard.insert_profile(profile).map_err(|e| e.to_string())
}

#[tauri::command]
fn replace_connection_profiles(
    profiles: Vec<ConnectionProfile>,
    storage: State<'_, AppStorage>,
) -> Result<(), String> {
    let mut guard = storage.lock().map_err(|e| e.to_string())?;
    guard.replace_profiles(profiles).map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_connection_profile(
    id: String,
    storage: State<'_, AppStorage>,
) -> Result<bool, String> {
    let credential_kind = {
        let guard = storage.lock().map_err(|e| e.to_string())?;
        guard
            .get_profile(&id)
            .map_err(|e| e.to_string())?
            .map(|profile| match profile.protocol {
                Protocol::Ssh => CredentialKind::SshPassword,
                Protocol::Sftp => CredentialKind::SftpPassword,
                Protocol::Rdp => CredentialKind::RdpPassword,
                Protocol::Vnc => CredentialKind::VncPassword,
                Protocol::Lattice => CredentialKind::LatticePairingCode,
            })
    };

    if let Some(kind) = credential_kind {
        let credential_profile_id = id.clone();
        if credential_call(move || crate::credentials::exists(&credential_profile_id, kind)).await?
        {
            return Err(
                "Delete the saved credential from the Key Vault before deleting this connection."
                    .to_string(),
            );
        }
    }

    let mut guard = storage.lock().map_err(|e| e.to_string())?;
    guard.delete_profile(&id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn credential_status() -> Result<CredentialStoreStatus, String> {
    credential_call(|| Ok(crate::credentials::status())).await
}

#[tauri::command]
async fn credential_backend_get() -> Result<crate::credentials::CredentialBackend, String> {
    credential_call(|| Ok(crate::credentials::preferred_backend())).await
}

#[tauri::command]
async fn credential_backend_set(
    backend: crate::credentials::CredentialBackend,
) -> Result<crate::credentials::CredentialBackend, String> {
    credential_call(move || crate::credentials::set_preferred_backend(backend)).await
}

#[tauri::command]
fn vault_status() -> Result<crate::vault::VaultStatus, String> {
    Ok(crate::vault::manager()?.status())
}

#[tauri::command]
async fn vault_create(master_password: String) -> Result<crate::vault::VaultStatus, String> {
    // Argon2id takes real time by design; keep it off the event loop.
    credential_call(move || crate::vault::manager()?.create(&master_password)).await
}

#[tauri::command]
async fn vault_unlock(master_password: String) -> Result<crate::vault::VaultStatus, String> {
    credential_call(move || crate::vault::manager()?.unlock(&master_password)).await
}

#[tauri::command]
fn vault_lock() -> Result<crate::vault::VaultStatus, String> {
    Ok(crate::vault::manager()?.lock())
}

#[tauri::command]
async fn vault_change_password(
    current_password: String,
    new_password: String,
) -> Result<crate::vault::VaultStatus, String> {
    credential_call(move || {
        crate::vault::manager()?.change_password(&current_password, &new_password)
    })
    .await
}

#[tauri::command]
async fn sensitive_clipboard_copy(
    app: AppHandle,
    value: String,
    clear_after_seconds: Option<u64>,
    clipboard: State<'_, Arc<SensitiveClipboard>>,
) -> Result<(), String> {
    let clipboard = Arc::clone(clipboard.inner());
    clipboard_call(move || clipboard.copy(&app, value, clear_after_seconds)).await
}

#[tauri::command]
async fn sensitive_clipboard_clear(
    app: AppHandle,
    clipboard: State<'_, Arc<SensitiveClipboard>>,
) -> Result<SensitiveClipboardClearOutcome, String> {
    let clipboard = Arc::clone(clipboard.inner());
    clipboard_call(move || Ok(clipboard.clear_current(&app))).await
}

#[tauri::command]
async fn terminal_clipboard_read_text(
    app: AppHandle,
    clipboard: State<'_, Arc<SensitiveClipboard>>,
) -> Result<Option<String>, String> {
    let clipboard = Arc::clone(clipboard.inner());
    clipboard_call(move || clipboard.read_terminal_text(&app)).await
}

#[tauri::command]
async fn terminal_clipboard_write_text(
    app: AppHandle,
    text: String,
    clipboard: State<'_, Arc<SensitiveClipboard>>,
) -> Result<(), String> {
    let clipboard = Arc::clone(clipboard.inner());
    clipboard_call(move || clipboard.write_terminal_text(&app, text)).await
}

/// The restart exit code cannot be prevented by Tauri's ExitRequested API.
/// Seal and time-bound clipboard cleanup before requesting it instead.
#[tauri::command]
async fn app_restart_safely(
    app: AppHandle,
    clipboard: State<'_, Arc<SensitiveClipboard>>,
) -> Result<(), String> {
    let clipboard = Arc::clone(clipboard.inner());
    if !clipboard.seal_for_exit() {
        if clipboard.exit_ready() {
            app.request_restart();
            return Ok(());
        }
        return Err("LatticeTerm is already preparing to exit.".to_string());
    }
    let _ = clipboard
        .clear_auto_on_exit_timeboxed(app.clone(), CLIPBOARD_EXIT_TIMEOUT)
        .await;
    clipboard.mark_exit_ready();
    app.request_restart();
    Ok(())
}

#[tauri::command]
async fn credential_exists(profile_id: String, kind: CredentialKind) -> Result<bool, String> {
    credential_call(move || crate::credentials::exists(&profile_id, kind)).await
}

#[tauri::command]
async fn credential_delete(profile_id: String, kind: CredentialKind) -> Result<bool, String> {
    credential_call(move || crate::credentials::delete(&profile_id, kind)).await
}

fn validate_connection_profile(
    profile_id: &str,
    expected_protocol: Protocol,
    profile: &ConnectionProfile,
) -> Result<(), String> {
    if profile.id != profile_id {
        return Err("the selected profile does not match the saved record".to_string());
    }
    if profile.protocol != expected_protocol {
        return Err(format!(
            "the selected connection is not a {} profile",
            expected_protocol.as_str().to_ascii_uppercase()
        ));
    }
    Ok(())
}

fn bind_ssh_request_to_profile(
    request: &mut ConnectRequest,
    profile: &ConnectionProfile,
) -> Result<(), String> {
    validate_connection_profile(&request.profile_id, Protocol::Ssh, profile)?;

    // The WebView selects an opaque profile id. Its accompanying endpoint
    // fields are presentation data, never authority to pair a saved secret
    // with a different host or username.
    request.hostname = profile.hostname.clone();
    request.port = profile.port;
    request.username = profile.username.clone();
    Ok(())
}

fn bind_sftp_request_to_profile(
    request: &mut SftpConnectRequest,
    profile: &ConnectionProfile,
) -> Result<(), String> {
    validate_connection_profile(&request.profile_id, Protocol::Sftp, profile)?;
    request.hostname = profile.hostname.clone();
    request.port = profile.port;
    request.username = profile.username.clone();
    Ok(())
}

fn bind_rdp_request_to_profile(
    request: &mut RdpConnectRequest,
    profile: &ConnectionProfile,
) -> Result<(), String> {
    validate_connection_profile(&request.profile_id, Protocol::Rdp, profile)?;
    request.hostname = profile.hostname.clone();
    request.port = profile.port;
    request.username = profile.username.clone();
    Ok(())
}

fn rdp_credential_context(domain: &Option<String>) -> String {
    match domain {
        Some(domain) => format!("rdp-domain:some:{}:{domain}", domain.len()),
        None => "rdp-domain:none".to_string(),
    }
}

fn bind_vnc_request_to_profile(
    request: &mut VncConnectRequest,
    profile: &ConnectionProfile,
) -> Result<(), String> {
    validate_connection_profile(&request.profile_id, Protocol::Vnc, profile)?;
    request.hostname = profile.hostname.clone();
    request.port = profile.port;
    Ok(())
}

fn lattice_pairing_context(profile: &ConnectionProfile) -> Result<String, String> {
    validate_connection_profile(&profile.id, Protocol::Lattice, profile)?;
    let device_id = profile.device_id.as_deref().ok_or_else(|| {
        "Only relay devices with a permanent ID can remember a pairing code.".to_string()
    })?;
    let device_id = lattice_remote::relay::normalize_device_id(device_id)
        .map_err(|_| "The saved Lattice Remote device ID is invalid.".to_string())?;
    Ok(format!("lattice-relay-device:{device_id}"))
}

fn bind_remote_request_to_profile(
    request: &mut RemoteConnectRequest,
    profile: &ConnectionProfile,
) -> Result<(), String> {
    validate_connection_profile(&request.profile_id, Protocol::Lattice, profile)?;
    request.hostname = profile.hostname.clone();
    request.port = profile.port;

    if let Some(device_id) = profile.device_id.as_deref() {
        request.device_id = lattice_remote::relay::normalize_device_id(device_id)
            .map_err(|_| "The saved Lattice Remote device ID is invalid.".to_string())?;
        if request.relay_address.trim().is_empty() {
            request.relay_address = profile.relay_address.clone().unwrap_or_default();
        }
    } else {
        request.device_id.clear();
        request.relay_address.clear();
    }
    Ok(())
}

#[tauri::command]
async fn ssh_connect(
    app: AppHandle,
    mut request: ConnectRequest,
    storage: State<'_, AppStorage>,
    trust: State<'_, TrustState>,
    registry: State<'_, Arc<SshRegistry>>,
) -> Result<ConnectOutcome, String> {
    if request.use_saved_password && request.remember_password {
        return Ok(ConnectOutcome::Failed {
            stage: "credential",
            detail: "Choose either the saved password or a new password to remember.".to_string(),
        });
    }

    let profile = {
        let guard = storage.lock().map_err(|error| error.to_string())?;
        guard
            .get_profile(&request.profile_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "the selected SSH profile no longer exists".to_string())?
    };
    if let Err(detail) = bind_ssh_request_to_profile(&mut request, &profile) {
        return Ok(ConnectOutcome::Failed {
            stage: "profile",
            detail,
        });
    }

    if request.use_saved_password {
        let credential_profile = profile.clone();
        let password = match credential_call(move || {
            crate::credentials::load_bound(&credential_profile, CredentialKind::SshPassword)
        })
        .await
        {
            Ok(password) => password,
            Err(detail) => {
                return Ok(ConnectOutcome::Failed {
                    stage: "credential",
                    detail,
                })
            }
        };
        request.auth = crate::ssh::AuthMethod::Password { password };
    }

    let password_to_store = if request.remember_password {
        match &request.auth {
            crate::ssh::AuthMethod::Password { password } => Some(Zeroizing::new(password.clone())),
            // A key never has a password to remember; the checkbox is hidden
            // for key authentication, so this arm is purely defensive.
            crate::ssh::AuthMethod::PrivateKey { .. } => None,
        }
    } else {
        None
    };

    // The trust lookup happens up front, so the store's lock is never held
    // across the connection attempt.
    let known: Option<HostKeyRecord> = match trust.inner() {
        TrustState::Unavailable(reason) => {
            return Ok(ConnectOutcome::Failed {
                stage: "trust",
                detail: reason.clone(),
            })
        }
        TrustState::Ready(store) => {
            let guard = store.lock().map_err(|e| e.to_string())?;
            crate::ssh::known_record(&guard, &request.hostname, request.port)
        }
    };

    let outcome = crate::ssh::connect(
        Arc::new(EventSink(app)),
        Arc::clone(registry.inner()),
        known,
        request,
    )
    .await;

    if let (ConnectOutcome::Connected { session_id }, Some(password)) =
        (&outcome, password_to_store)
    {
        let credential_profile = profile.clone();
        let save_result = credential_call(move || {
            crate::credentials::store_bound(
                &credential_profile,
                CredentialKind::SshPassword,
                password.as_str(),
            )
        })
        .await;
        if let Err(detail) = save_result {
            let _ = crate::ssh::disconnect(registry.inner(), session_id).await;
            return Ok(ConnectOutcome::Failed {
                stage: "credential",
                detail,
            });
        }
    }

    Ok(outcome)
}

#[tauri::command]
async fn ssh_send(
    session_id: String,
    data: String,
    registry: State<'_, Arc<SshRegistry>>,
) -> Result<(), String> {
    crate::ssh::send(registry.inner(), &session_id, &data).await
}

#[tauri::command]
async fn ssh_resize(
    session_id: String,
    cols: u32,
    rows: u32,
    registry: State<'_, Arc<SshRegistry>>,
) -> Result<(), String> {
    crate::ssh::resize(registry.inner(), &session_id, cols, rows).await
}

#[tauri::command]
async fn ssh_disconnect(
    session_id: String,
    registry: State<'_, Arc<SshRegistry>>,
) -> Result<(), String> {
    crate::ssh::disconnect(registry.inner(), &session_id).await
}

#[tauri::command]
async fn host_metrics(
    session_id: String,
    registry: State<'_, Arc<SshRegistry>>,
) -> Result<crate::metrics::HostMetricsPayload, String> {
    crate::metrics::collect_for_session(registry.inner(), &session_id).await
}

#[tauri::command]
fn ssh_default_keys() -> Vec<String> {
    crate::ssh::default_key_paths()
}

#[tauri::command]
fn ssh_sessions(registry: State<'_, Arc<SshRegistry>>) -> Vec<SessionSummary> {
    registry.list()
}

/// Opens an SFTP file browser on an existing SSH terminal session — the
/// MobaXterm-style side panel — without a second connection or login.
#[tauri::command]
async fn sftp_attach_ssh(
    ssh_session_id: String,
    ssh: State<'_, Arc<SshRegistry>>,
    sftp: State<'_, Arc<SftpRegistry>>,
) -> Result<SftpConnectOutcome, String> {
    let Some((summary, transport)) = ssh.session_transport(&ssh_session_id) else {
        return Err(format!("SSH session '{ssh_session_id}' is not connected."));
    };
    Ok(crate::sftp::attach_to_ssh(Arc::clone(sftp.inner()), summary, transport).await)
}

#[tauri::command]
async fn sftp_connect(
    mut request: SftpConnectRequest,
    storage: State<'_, AppStorage>,
    trust: State<'_, TrustState>,
    registry: State<'_, Arc<SftpRegistry>>,
) -> Result<SftpConnectOutcome, String> {
    if request.use_saved_password && request.remember_password {
        return Ok(SftpConnectOutcome::Failed {
            stage: "credential",
            detail: "Choose either the saved password or a new password to remember.".to_string(),
        });
    }

    let profile = {
        let guard = storage.lock().map_err(|error| error.to_string())?;
        guard
            .get_profile(&request.profile_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "the selected SFTP profile no longer exists".to_string())?
    };
    if let Err(detail) = bind_sftp_request_to_profile(&mut request, &profile) {
        return Ok(SftpConnectOutcome::Failed {
            stage: "profile",
            detail,
        });
    }

    if request.use_saved_password {
        let credential_profile = profile.clone();
        request.auth = match credential_call(move || {
            crate::credentials::load_bound(&credential_profile, CredentialKind::SftpPassword)
        })
        .await
        {
            Ok(password) => crate::ssh::AuthMethod::Password { password },
            Err(detail) => {
                return Ok(SftpConnectOutcome::Failed {
                    stage: "credential",
                    detail,
                })
            }
        };
    }

    let password_to_store = if request.remember_password {
        match &request.auth {
            crate::ssh::AuthMethod::Password { password } => Some(Zeroizing::new(password.clone())),
            // A key never has a password to remember; the checkbox is hidden
            // for key authentication, so this arm is purely defensive.
            crate::ssh::AuthMethod::PrivateKey { .. } => None,
        }
    } else {
        None
    };
    let known = match trust.inner() {
        TrustState::Unavailable(reason) => {
            return Ok(SftpConnectOutcome::Failed {
                stage: "trust",
                detail: reason.clone(),
            })
        }
        TrustState::Ready(store) => {
            let guard = store.lock().map_err(|error| error.to_string())?;
            crate::ssh::known_record(&guard, &request.hostname, request.port)
        }
    };

    let outcome = crate::sftp::connect(Arc::clone(registry.inner()), known, request).await;
    if let (SftpConnectOutcome::Connected { session }, Some(password)) =
        (&outcome, password_to_store)
    {
        let session_id = session.session_id.clone();
        let credential_profile = profile.clone();
        if let Err(detail) = credential_call(move || {
            crate::credentials::store_bound(
                &credential_profile,
                CredentialKind::SftpPassword,
                password.as_str(),
            )
        })
        .await
        {
            let _ = crate::sftp::disconnect(registry.inner(), &session_id).await;
            return Ok(SftpConnectOutcome::Failed {
                stage: "credential",
                detail,
            });
        }
    }
    Ok(outcome)
}

#[tauri::command]
async fn sftp_download_start(
    app: AppHandle,
    session_id: String,
    remote_path: String,
    sessions: State<'_, Arc<SftpRegistry>>,
    transfers: State<'_, Arc<TransferRegistry>>,
) -> Result<TransferState, String> {
    let target = user_download_directory(&app)?;
    crate::sftp_transfers::start_download(
        Arc::clone(transfers.inner()),
        sessions.inner(),
        Arc::new(crate::sftp_transfers::EventSink(app.clone())),
        &session_id,
        &remote_path,
        target,
    )
    .await
}

pub(crate) fn user_download_directory(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    // iOS exposes Documents through Files; a desktop-style Downloads path
    // is not a user-visible download destination inside an iOS sandbox.
    #[cfg(target_os = "ios")]
    let target = {
        let directory = app
            .path()
            .document_dir()
            .map_err(|error| error.to_string())?;
        crate::file_exports::prepare_documents(&directory)?;
        directory
    };
    #[cfg(not(target_os = "ios"))]
    let target = app
        .path()
        .download_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|error| format!("no download folder is available: {error}"))?;
    Ok(target)
}

#[tauri::command]
async fn sftp_upload_begin(
    app: AppHandle,
    plan: crate::sftp_transfers::UploadPlan,
    sessions: State<'_, Arc<SftpRegistry>>,
    transfers: State<'_, Arc<TransferRegistry>>,
) -> Result<TransferState, String> {
    crate::sftp_transfers::begin_upload(
        Arc::clone(transfers.inner()),
        sessions.inner(),
        &crate::sftp_transfers::EventSink(app.clone()),
        plan,
    )
    .await
}

#[tauri::command]
async fn sftp_upload_path(
    app: AppHandle,
    session_id: String,
    parent: String,
    local_path: String,
    overwrite: bool,
    sessions: State<'_, Arc<SftpRegistry>>,
    transfers: State<'_, Arc<TransferRegistry>>,
) -> Result<TransferState, String> {
    crate::sftp_transfers::start_upload_from_path(
        Arc::clone(transfers.inner()),
        sessions.inner(),
        Arc::new(crate::sftp_transfers::EventSink(app.clone())),
        &session_id,
        &parent,
        std::path::PathBuf::from(local_path),
        overwrite,
    )
    .await
}

#[tauri::command]
async fn sftp_upload_chunk(
    app: AppHandle,
    transfer_id: String,
    data: String,
    transfers: State<'_, Arc<TransferRegistry>>,
) -> Result<(), String> {
    crate::sftp_transfers::upload_chunk(
        transfers.inner(),
        &crate::sftp_transfers::EventSink(app.clone()),
        &transfer_id,
        &data,
    )
    .await
}

#[tauri::command]
async fn sftp_upload_finish(
    app: AppHandle,
    transfer_id: String,
    transfers: State<'_, Arc<TransferRegistry>>,
) -> Result<(), String> {
    crate::sftp_transfers::finish_upload(
        transfers.inner(),
        &crate::sftp_transfers::EventSink(app.clone()),
        &transfer_id,
    )
    .await
}

#[tauri::command]
async fn sftp_transfer_cancel(
    app: AppHandle,
    transfer_id: String,
    transfers: State<'_, Arc<TransferRegistry>>,
) -> Result<(), String> {
    crate::sftp_transfers::cancel(
        transfers.inner(),
        &crate::sftp_transfers::EventSink(app.clone()),
        &transfer_id,
    )
    .await
}

#[tauri::command]
fn sftp_transfer_dismiss(
    transfer_id: String,
    transfers: State<'_, Arc<TransferRegistry>>,
) -> Result<(), String> {
    transfers.dismiss(&transfer_id)
}

#[tauri::command]
fn sftp_transfers(transfers: State<'_, Arc<TransferRegistry>>) -> Vec<TransferState> {
    transfers.list()
}

#[tauri::command]
fn sftp_sessions(registry: State<'_, Arc<SftpRegistry>>) -> Vec<SftpSessionSummary> {
    registry.list()
}

#[tauri::command]
async fn sftp_list(
    session_id: String,
    path: String,
    registry: State<'_, Arc<SftpRegistry>>,
) -> Result<SftpDirectory, String> {
    crate::sftp::list_directory(registry.inner(), &session_id, &path).await
}

#[tauri::command]
async fn sftp_create_directory(
    session_id: String,
    parent: String,
    name: String,
    registry: State<'_, Arc<SftpRegistry>>,
) -> Result<(), String> {
    crate::sftp::create_directory(registry.inner(), &session_id, &parent, &name).await
}

#[tauri::command]
async fn sftp_rename(
    session_id: String,
    path: String,
    new_name: String,
    registry: State<'_, Arc<SftpRegistry>>,
) -> Result<(), String> {
    crate::sftp::rename(registry.inner(), &session_id, &path, &new_name).await
}

#[tauri::command]
async fn sftp_remove(
    session_id: String,
    path: String,
    directory: bool,
    registry: State<'_, Arc<SftpRegistry>>,
) -> Result<(), String> {
    crate::sftp::remove(registry.inner(), &session_id, &path, directory).await
}

#[tauri::command]
async fn sftp_read_file(
    session_id: String,
    path: String,
    registry: State<'_, Arc<SftpRegistry>>,
) -> Result<String, String> {
    crate::sftp::read_file(registry.inner(), &session_id, &path).await
}

#[tauri::command]
async fn sftp_write_file(
    session_id: String,
    parent: String,
    name: String,
    data: String,
    overwrite: bool,
    registry: State<'_, Arc<SftpRegistry>>,
) -> Result<(), String> {
    crate::sftp::write_file(
        registry.inner(),
        &session_id,
        &parent,
        &name,
        &data,
        overwrite,
    )
    .await
}

#[tauri::command]
async fn sftp_read_text_file(
    session_id: String,
    path: String,
    registry: State<'_, Arc<SftpRegistry>>,
) -> Result<crate::sftp_text::TextFile, String> {
    crate::sftp_text::read_text_file(registry.inner(), &session_id, &path).await
}

#[tauri::command]
async fn sftp_save_text_file(
    session_id: String,
    path: String,
    content: String,
    revision: String,
    acknowledge_access_change: Option<bool>,
    registry: State<'_, Arc<SftpRegistry>>,
) -> Result<crate::sftp_text::TextFile, String> {
    crate::sftp_text::save_text_file(
        registry.inner(),
        &session_id,
        &path,
        &content,
        &revision,
        acknowledge_access_change.unwrap_or(false),
    )
    .await
}

#[tauri::command]
async fn sftp_disconnect(
    app: AppHandle,
    session_id: String,
    registry: State<'_, Arc<SftpRegistry>>,
    transfers: State<'_, Arc<TransferRegistry>>,
) -> Result<(), String> {
    let cancel_result = crate::sftp_transfers::cancel_session(
        transfers.inner(),
        &crate::sftp_transfers::EventSink(app),
        &session_id,
    )
    .await;
    let disconnect_result = crate::sftp::disconnect(registry.inner(), &session_id).await;
    match (cancel_result, disconnect_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(cancel_error), Ok(())) => Err(format!(
            "the session closed, but one or more transfers could not be cleaned up: {cancel_error}"
        )),
        (Ok(()), Err(disconnect_error)) => Err(disconnect_error),
        (Err(cancel_error), Err(disconnect_error)) => Err(format!(
            "transfer cleanup failed ({cancel_error}); closing the SFTP session also failed ({disconnect_error})"
        )),
    }
}

#[tauri::command]
async fn remote_connect(
    app: AppHandle,
    mut request: RemoteConnectRequest,
    storage: State<'_, AppStorage>,
    registry: State<'_, Arc<RemoteRegistry>>,
) -> Result<RemoteConnectOutcome, String> {
    if request.use_saved_pairing_code && request.remember_pairing_code {
        return Ok(RemoteConnectOutcome::Failed {
            stage: "credential",
            detail: "Choose either the saved pairing code or a new code to remember.".to_string(),
        });
    }

    let profile = {
        let guard = storage.lock().map_err(|error| error.to_string())?;
        guard
            .get_profile(&request.profile_id)
            .map_err(|error| error.to_string())?
    };
    if let Some(profile) = &profile {
        if let Err(detail) = bind_remote_request_to_profile(&mut request, profile) {
            return Ok(RemoteConnectOutcome::Failed {
                stage: "profile",
                detail,
            });
        }
    } else if request.use_saved_pairing_code || request.remember_pairing_code {
        return Ok(RemoteConnectOutcome::Failed {
            stage: "credential",
            detail: "Save this Lattice Remote device before remembering its pairing code."
                .to_string(),
        });
    }

    let credential_binding = if request.use_saved_pairing_code || request.remember_pairing_code {
        let Some(credential_profile) = profile.as_ref() else {
            return Ok(RemoteConnectOutcome::Failed {
                stage: "credential",
                detail: "Save this Lattice Remote device before remembering its pairing code."
                    .to_string(),
            });
        };
        let context = match lattice_pairing_context(credential_profile) {
            Ok(context) => context,
            Err(detail) => {
                return Ok(RemoteConnectOutcome::Failed {
                    stage: "credential",
                    detail,
                })
            }
        };
        Some((credential_profile.clone(), context))
    } else {
        None
    };

    if request.use_saved_pairing_code {
        let Some((credential_profile, load_context)) = credential_binding.clone() else {
            return Ok(RemoteConnectOutcome::Failed {
                stage: "credential",
                detail: "The saved pairing code is not bound to this device.".to_string(),
            });
        };
        request.pairing_code = match credential_call(move || {
            crate::credentials::load_bound_with_context(
                &credential_profile,
                CredentialKind::LatticePairingCode,
                &load_context,
            )
        })
        .await
        {
            Ok(code) => code,
            Err(detail) => {
                return Ok(RemoteConnectOutcome::Failed {
                    stage: "credential",
                    detail,
                })
            }
        };
    }

    let pairing_code_to_store = if request.remember_pairing_code {
        match if request.legacy_pairing {
            lattice_remote::normalize_legacy_pairing_code(&request.pairing_code)
        } else {
            lattice_remote::normalize_viewer_pairing_code(&request.pairing_code)
        } {
            Ok(code) => Some(Zeroizing::new(code)),
            Err(error) => {
                return Ok(RemoteConnectOutcome::Failed {
                    stage: "pairing",
                    detail: error.to_string(),
                })
            }
        }
    } else {
        None
    };

    let outcome = crate::remote::connect(app.clone(), Arc::clone(registry.inner()), request).await;
    if let (RemoteConnectOutcome::Connected { session }, Some(pairing_code)) =
        (&outcome, pairing_code_to_store)
    {
        let Some((credential_profile, store_context)) = credential_binding else {
            let _ = crate::remote::disconnect(&app, registry.inner(), &session.session_id).await;
            return Ok(RemoteConnectOutcome::Failed {
                stage: "credential",
                detail: "The pairing code could not be bound to this device.".to_string(),
            });
        };
        let save_result = credential_call(move || {
            crate::credentials::store_bound_with_context(
                &credential_profile,
                CredentialKind::LatticePairingCode,
                &store_context,
                pairing_code.as_str(),
            )
        })
        .await;
        if let Err(detail) = save_result {
            let _ = crate::remote::disconnect(&app, registry.inner(), &session.session_id).await;
            return Ok(RemoteConnectOutcome::Failed {
                stage: "credential",
                detail,
            });
        }
    }
    Ok(outcome)
}

#[tauri::command]
async fn remote_disconnect(
    app: AppHandle,
    session_id: String,
    registry: State<'_, Arc<RemoteRegistry>>,
) -> Result<(), String> {
    crate::remote::disconnect(&app, registry.inner(), &session_id).await
}

#[tauri::command]
fn remote_sessions(registry: State<'_, Arc<RemoteRegistry>>) -> Vec<RemoteSessionSummary> {
    registry.list()
}

#[tauri::command]
fn remote_terminal_snapshots(
    registry: State<'_, Arc<RemoteRegistry>>,
) -> Result<Vec<RemoteTerminalSnapshot>, String> {
    registry.terminal_snapshots()
}

/// Publish a local takeover promptly without making human input wait for
/// daemon I/O. Service-side revocation is already effective before spawning.
fn notify_mcp_screen_takeover(
    app: &AppHandle,
    service: &Arc<mcp_desktop::DesktopService>,
    backend: mcp_desktop::Backend,
    session_id: &str,
) {
    if !service.take_over_screen(backend, session_id) {
        return;
    }
    let app = app.clone();
    let service = Arc::clone(service);
    tauri::async_runtime::spawn(async move {
        let sync = app.state::<McpRemoteSync>();
        let _guard = sync.0.lock().await;
        if let Some(connection) = app.state::<AppDaemon>().attached().await {
            let _ = connection
                .request(agent_daemon::Request::DesktopGrants {
                    targets: service.targets(),
                })
                .await;
        }
    });
}

#[tauri::command]
async fn remote_input(
    app: AppHandle,
    session_id: String,
    request: RemoteInputRequest,
    registry: State<'_, Arc<RemoteRegistry>>,
    service: State<'_, Arc<mcp_desktop::DesktopService>>,
) -> Result<(), String> {
    if request.takes_over_screen() {
        notify_mcp_screen_takeover(
            &app,
            service.inner(),
            mcp_desktop::Backend::Remote,
            &session_id,
        );
    }
    crate::remote::input(registry.inner(), &session_id, request).await
}

#[tauri::command]
async fn remote_terminal_input(
    session_id: String,
    data: String,
    registry: State<'_, Arc<RemoteRegistry>>,
) -> Result<(), String> {
    crate::remote::terminal_input(registry.inner(), &session_id, data).await
}

#[tauri::command]
async fn remote_terminal_resize(
    session_id: String,
    cols: u16,
    rows: u16,
    registry: State<'_, Arc<RemoteRegistry>>,
) -> Result<(), String> {
    crate::remote::terminal_resize(registry.inner(), &session_id, cols, rows).await
}

#[tauri::command]
async fn remote_file_list(
    session_id: String,
    path: String,
    registry: State<'_, Arc<RemoteRegistry>>,
) -> Result<RemoteDirectory, String> {
    crate::remote::file_list(registry.inner(), &session_id, path).await
}

#[tauri::command]
async fn remote_file_read_text(
    session_id: String,
    path: String,
    registry: State<'_, Arc<RemoteRegistry>>,
) -> Result<crate::remote_files::RemoteTextDocument, String> {
    crate::remote::file_read_text(registry.inner(), &session_id, path).await
}

#[tauri::command]
async fn remote_file_save_text(
    session_id: String,
    path: String,
    content: String,
    revision: String,
    registry: State<'_, Arc<RemoteRegistry>>,
) -> Result<crate::remote_files::RemoteTextDocument, String> {
    crate::remote::file_save_text(registry.inner(), &session_id, path, content, revision).await
}

#[tauri::command]
async fn remote_file_download_start(
    session_id: String,
    path: String,
    registry: State<'_, Arc<RemoteRegistry>>,
) -> Result<RemoteFileTransfer, String> {
    crate::remote::file_download_start(registry.inner(), &session_id, path).await
}

#[tauri::command]
async fn remote_file_upload_begin(
    session_id: String,
    parent: String,
    name: String,
    size: u64,
    overwrite: bool,
    registry: State<'_, Arc<RemoteRegistry>>,
) -> Result<RemoteFileTransfer, String> {
    crate::remote::file_upload_begin(registry.inner(), &session_id, parent, name, size, overwrite)
        .await
}

#[tauri::command]
async fn remote_file_upload_chunk(
    session_id: String,
    transfer_id: String,
    data: String,
    registry: State<'_, Arc<RemoteRegistry>>,
) -> Result<(), String> {
    crate::remote::file_upload_chunk(registry.inner(), &session_id, &transfer_id, &data).await
}

#[tauri::command]
async fn remote_file_upload_finish(
    session_id: String,
    transfer_id: String,
    registry: State<'_, Arc<RemoteRegistry>>,
) -> Result<(), String> {
    crate::remote::file_upload_finish(registry.inner(), &session_id, &transfer_id).await
}

#[tauri::command]
async fn remote_file_transfer_cancel(
    session_id: String,
    transfer_id: String,
    registry: State<'_, Arc<RemoteRegistry>>,
) -> Result<(), String> {
    crate::remote::file_transfer_cancel(registry.inner(), &session_id, &transfer_id).await
}

#[tauri::command]
fn remote_file_transfer_dismiss(
    session_id: String,
    transfer_id: String,
    registry: State<'_, Arc<RemoteRegistry>>,
) -> Result<(), String> {
    crate::remote::file_transfer_dismiss(registry.inner(), &session_id, &transfer_id)
}

#[tauri::command]
fn remote_file_transfers(registry: State<'_, Arc<RemoteRegistry>>) -> Vec<RemoteFileTransfer> {
    registry.transfers()
}

#[tauri::command]
async fn remote_host_start(
    app: AppHandle,
    request: RemoteHostStartRequest,
    registry: State<'_, Arc<RemoteHostRegistry>>,
) -> Result<RemoteHostStatus, String> {
    crate::remote_host::start(app, Arc::clone(registry.inner()), request).await
}

#[tauri::command]
async fn remote_host_device_id(
    app: AppHandle,
    registry: State<'_, Arc<RemoteHostRegistry>>,
) -> Result<String, String> {
    crate::remote_host::device_id(&app, registry.inner()).await
}

#[tauri::command]
async fn remote_host_stop(
    app: AppHandle,
    registry: State<'_, Arc<RemoteHostRegistry>>,
) -> Result<(), String> {
    crate::remote_host::stop(&app, registry.inner()).await
}

#[tauri::command]
fn remote_host_status(
    registry: State<'_, Arc<RemoteHostRegistry>>,
) -> Result<Option<RemoteHostStatus>, String> {
    registry.status()
}

#[tauri::command]
async fn rdp_connect(
    app: AppHandle,
    mut request: RdpConnectRequest,
    storage: State<'_, AppStorage>,
    registry: State<'_, Arc<RdpRegistry>>,
) -> Result<RdpConnectOutcome, String> {
    if request.use_saved_password && request.remember_password {
        return Ok(RdpConnectOutcome::Failed {
            stage: "credential",
            detail: "Choose either the saved password or a new password to remember.".to_string(),
        });
    }

    let profile = {
        let guard = storage.lock().map_err(|error| error.to_string())?;
        guard
            .get_profile(&request.profile_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "the selected RDP profile no longer exists".to_string())?
    };
    if let Err(detail) = bind_rdp_request_to_profile(&mut request, &profile) {
        return Ok(RdpConnectOutcome::Failed {
            stage: "profile",
            detail,
        });
    }
    let credential_context = rdp_credential_context(&request.domain);

    if request.use_saved_password {
        let credential_profile = profile.clone();
        let load_context = credential_context.clone();
        request.password = match credential_call(move || {
            crate::credentials::load_bound_with_context(
                &credential_profile,
                CredentialKind::RdpPassword,
                &load_context,
            )
        })
        .await
        {
            Ok(password) => password,
            Err(detail) => {
                return Ok(RdpConnectOutcome::Failed {
                    stage: "credential",
                    detail,
                })
            }
        };
    }

    let password_to_store = request
        .remember_password
        .then(|| Zeroizing::new(request.password.clone()));
    let outcome = crate::rdp::connect(app.clone(), Arc::clone(registry.inner()), request).await;

    if let (RdpConnectOutcome::Connected { session }, Some(password)) =
        (&outcome, password_to_store)
    {
        let credential_profile = profile.clone();
        let save_result = credential_call(move || {
            crate::credentials::store_bound_with_context(
                &credential_profile,
                CredentialKind::RdpPassword,
                &credential_context,
                password.as_str(),
            )
        })
        .await;
        if let Err(detail) = save_result {
            let _ = crate::rdp::disconnect(&app, registry.inner(), &session.session_id).await;
            return Ok(RdpConnectOutcome::Failed {
                stage: "credential",
                detail,
            });
        }
    }

    Ok(outcome)
}

#[tauri::command]
async fn rdp_input(
    app: AppHandle,
    session_id: String,
    request: RdpInputRequest,
    registry: State<'_, Arc<RdpRegistry>>,
    service: State<'_, Arc<mcp_desktop::DesktopService>>,
) -> Result<(), String> {
    if request.takes_over_screen() {
        notify_mcp_screen_takeover(
            &app,
            service.inner(),
            mcp_desktop::Backend::Rdp,
            &session_id,
        );
    }
    crate::rdp::input(&app, registry.inner(), &session_id, request).await
}

#[tauri::command]
async fn rdp_disconnect(
    app: AppHandle,
    session_id: String,
    registry: State<'_, Arc<RdpRegistry>>,
) -> Result<(), String> {
    crate::rdp::disconnect(&app, registry.inner(), &session_id).await
}

#[tauri::command]
fn rdp_sessions(registry: State<'_, Arc<RdpRegistry>>) -> Vec<RdpSessionSummary> {
    registry.list()
}

/// Records a key the user has just compared and accepted.
#[tauri::command]
fn ssh_trust_host(
    host: String,
    port: u16,
    algorithm: String,
    fingerprint: String,
    trust: State<'_, TrustState>,
) -> Result<HostKeyRecord, String> {
    match trust.inner() {
        TrustState::Unavailable(reason) => Err(reason.clone()),
        TrustState::Ready(store) => {
            let mut guard = store.lock().map_err(|e| e.to_string())?;
            guard
                .trust(&host, port, &algorithm, &fingerprint, now_seconds())
                .map_err(|e| e.to_string())
        }
    }
}

#[tauri::command]
fn ssh_known_hosts(trust: State<'_, TrustState>) -> Result<Vec<HostKeyRecord>, String> {
    match trust.inner() {
        TrustState::Unavailable(reason) => Err(reason.clone()),
        TrustState::Ready(store) => {
            let guard = store.lock().map_err(|e| e.to_string())?;
            Ok(guard.records())
        }
    }
}

#[tauri::command]
fn ssh_forget_host(host: String, port: u16, trust: State<'_, TrustState>) -> Result<bool, String> {
    match trust.inner() {
        TrustState::Unavailable(reason) => Err(reason.clone()),
        TrustState::Ready(store) => {
            let mut guard = store.lock().map_err(|e| e.to_string())?;
            guard.forget(&host, port).map_err(|e| e.to_string())
        }
    }
}

#[tauri::command]
async fn vnc_connect(
    app: AppHandle,
    mut request: VncConnectRequest,
    storage: State<'_, AppStorage>,
    registry: State<'_, Arc<VncRegistry>>,
) -> Result<VncConnectOutcome, String> {
    if request.use_saved_password && request.remember_password {
        return Ok(VncConnectOutcome::Failed {
            stage: "credential",
            detail: "Choose either the saved password or a new password to remember.".to_string(),
        });
    }

    let profile = {
        let guard = storage.lock().map_err(|error| error.to_string())?;
        guard
            .get_profile(&request.profile_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "the selected VNC profile no longer exists".to_string())?
    };
    if let Err(detail) = bind_vnc_request_to_profile(&mut request, &profile) {
        return Ok(VncConnectOutcome::Failed {
            stage: "profile",
            detail,
        });
    }

    if request.use_saved_password {
        let credential_profile = profile.clone();
        request.password = match credential_call(move || {
            crate::credentials::load_bound(&credential_profile, CredentialKind::VncPassword)
        })
        .await
        {
            Ok(password) => password,
            Err(detail) => {
                return Ok(VncConnectOutcome::Failed {
                    stage: "credential",
                    detail,
                })
            }
        };
    }

    let password_to_store = request
        .remember_password
        .then(|| Zeroizing::new(request.password.clone()));
    let outcome = crate::vnc::connect(app.clone(), Arc::clone(registry.inner()), request).await;

    if let (VncConnectOutcome::Connected { session }, Some(password)) =
        (&outcome, password_to_store)
    {
        let credential_profile = profile.clone();
        let save_result = credential_call(move || {
            crate::credentials::store_bound(
                &credential_profile,
                CredentialKind::VncPassword,
                password.as_str(),
            )
        })
        .await;
        if let Err(detail) = save_result {
            let _ = crate::vnc::disconnect(&app, registry.inner(), &session.session_id).await;
            return Ok(VncConnectOutcome::Failed {
                stage: "credential",
                detail,
            });
        }
    }

    Ok(outcome)
}

#[tauri::command]
async fn vnc_input(
    app: AppHandle,
    session_id: String,
    request: VncInputRequest,
    registry: State<'_, Arc<VncRegistry>>,
    service: State<'_, Arc<mcp_desktop::DesktopService>>,
) -> Result<(), String> {
    if request.takes_over_screen() {
        notify_mcp_screen_takeover(
            &app,
            service.inner(),
            mcp_desktop::Backend::Vnc,
            &session_id,
        );
    }
    crate::vnc::input(&app, registry.inner(), &session_id, request).await
}

#[tauri::command]
async fn vnc_disconnect(
    app: AppHandle,
    session_id: String,
    registry: State<'_, Arc<VncRegistry>>,
) -> Result<(), String> {
    crate::vnc::disconnect(&app, registry.inner(), &session_id).await
}

#[tauri::command]
fn vnc_sessions(registry: State<'_, Arc<VncRegistry>>) -> Vec<VncSessionSummary> {
    registry.list()
}

#[tauri::command]
async fn tunnel_start(
    mut request: StartTunnelRequest,
    storage: State<'_, AppStorage>,
    trust: State<'_, TrustState>,
    registry: State<'_, Arc<TunnelRegistry>>,
) -> Result<TunnelStatusSummary, String> {
    // A tunnel rides its own SSH session, so it needs the same two things a
    // terminal session needs: a trusted host key and a credential. Both are
    // resolved here, before any listener exists, so failure leaves nothing
    // half-started behind.
    // Resolve the endpoint from the stored profile. The WebView only selects
    // an opaque id; altering IPC fields cannot pair that profile's credential
    // with a different SSH host.
    let profile = {
        let guard = storage.lock().map_err(|error| error.to_string())?;
        guard
            .get_profile(&request.profile_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "profile:the SSH gateway profile no longer exists".to_string())?
    };
    if profile.protocol != Protocol::Ssh {
        return Err("profile:SSH tunnels require an SSH connection profile".to_string());
    }
    request.ssh_hostname = profile.hostname.clone();
    request.ssh_port = profile.port;
    request.ssh_username = profile.username.clone();

    let known: Option<HostKeyRecord> = match trust.inner() {
        TrustState::Unavailable(reason) => return Err(format!("trust:{reason}")),
        TrustState::Ready(store) => {
            let guard = store.lock().map_err(|e| e.to_string())?;
            crate::ssh::known_record(&guard, &request.ssh_hostname, request.ssh_port)
        }
    };

    if known.is_none() {
        return Err(
            "trust:this host is not trusted yet — connect over SSH once to confirm its fingerprint"
                .to_string(),
        );
    }

    // Reserve before keyring I/O. A flood of distinct tunnel ids must not
    // create an unbounded number of blocking credential jobs before the
    // tunnel runtime has applied its global admission limit.
    let mut reservation =
        crate::tunnel::reserve_tunnel_start(Arc::clone(registry.inner()), &request)?;
    let credential_profile = profile.clone();
    let admission = reservation.take_admission_for_credential()?;
    let mut credential_job = tauri::async_runtime::spawn_blocking(move || {
        (
            crate::credentials::load_bound(&credential_profile, CredentialKind::SshPassword)
                .map(Zeroizing::new),
            admission,
        )
    });
    let (password, admission) = tokio::select! {
        biased;
        _ = reservation.wait_until_stopped() => {
            // Dropping a blocking JoinHandle detaches rather than cancels it.
            // The job itself owns admission, so repeated cancelled starts stay
            // bounded until their keyring calls have truly returned.
            drop(credential_job);
            return Err("connect:tunnel start was cancelled".to_string());
        }
        result = &mut credential_job => {
            result.map_err(|error| {
                format!("credential:Credential operation did not complete: {error}")
            })?
        }
    };
    reservation.restore_admission_after_credential(admission)?;
    let password = password.map_err(|detail| format!("credential:{detail}"))?;

    crate::tunnel::start_reserved_tunnel(reservation, request, password.as_str(), known).await
}

#[tauri::command]
async fn tunnel_stop(
    tunnel_id: String,
    registry: State<'_, Arc<TunnelRegistry>>,
) -> Result<(), String> {
    registry.stop(&tunnel_id).await
}

#[tauri::command]
fn tunnel_status(
    tunnel_id: String,
    registry: State<'_, Arc<TunnelRegistry>>,
) -> Result<Option<TunnelStatusSummary>, String> {
    Ok(registry.status(&tunnel_id))
}

#[tauri::command]
fn tunnel_list(
    registry: State<'_, Arc<TunnelRegistry>>,
) -> Result<Vec<TunnelStatusSummary>, String> {
    Ok(registry.list())
}

fn install_rustls_crypto_provider() {
    // Another dependency may already have selected the same process-wide
    // provider. Re-installation is harmless and must not prevent app startup.
    let _ = rustls::crypto::ring::default_provider().install_default();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_rustls_crypto_provider();

    #[cfg(desktop)]
    let builder = tauri::Builder::default().plugin(tauri_plugin_single_instance::init(
        |app, _arguments, _working_directory| {
            if let Some(window) = app.get_webview_window("main") {
                let handle = window.clone();
                let _ = window.run_on_main_thread(move || {
                    let _ = handle.show();
                    let _ = handle.unminimize();
                    let _ = handle.set_focus();
                    #[cfg(target_os = "linux")]
                    if let Ok(gtk_window) = handle.gtk_window() {
                        use gtk::prelude::{GtkWindowExt, WidgetExt};

                        gtk_window.hide();
                        gtk_window.show_all();
                        gtk_window.deiconify();
                        gtk_window.present();
                    }
                });
            }
        },
    ));
    #[cfg(mobile)]
    let builder = tauri::Builder::default();
    let builder = builder.plugin(tauri_plugin_dialog::init());
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_clipboard_manager::init());
    // Auto-update and relaunch are desktop concerns; mobile installs come
    // from a package manager and restart through the OS.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    let app = builder
        .setup(|app| {
            // Connection data belongs beside the app's other data, not next to
            // the executable, so it survives an update and follows the user
            // profile on a shared machine.
            let dir = app.path().app_data_dir()?;
            // The credential router and the encrypted vault live in the same
            // directory as the rest of the app's data.
            crate::credentials::initialize(dir.clone());
            let storage = FileStorage::open(&dir)?;
            app.manage(Mutex::new(storage));
            let agent_plans = FileAgentPlanStore::open(&dir).map_err(std::io::Error::other)?;
            app.manage(Mutex::new(agent_plans));
            app.manage(McpPlanSync::default());
            app.manage(Mutex::new(AgentTerminalHistoryStore::open(&dir)));

            // A trust store that cannot be read is carried as a reason rather
            // than a panic: the app still runs, and connecting explains why it
            // will not proceed.
            let trust = match HostTrustStore::open(&dir) {
                Ok(store) => TrustState::Ready(Mutex::new(store)),
                Err(error) => TrustState::Unavailable(error.to_string()),
            };
            app.manage(trust);
            app.manage(Arc::new(SshRegistry::new()));
            app.manage(Arc::new(SftpRegistry::new()));
            app.manage(Arc::new(mcp_screen::ScreenFrames::default()));
            app.manage(McpRemoteSync::default());
            app.manage(Arc::new(TransferRegistry::new()));
            app.manage(Arc::new(RemoteRegistry::new()));
            app.manage(Arc::new(RemoteHostRegistry::new()));
            let desktop_sidecar_admission = crate::sidecar::desktop_sidecar_admission();
            app.manage(Arc::new(RdpRegistry::with_admission(Arc::clone(
                &desktop_sidecar_admission,
            ))));
            app.manage(Arc::new(VncRegistry::with_admission(
                desktop_sidecar_admission,
            )));
            // Built last: it binds an MCP grant to the live session in each
            // of the registries it can share.
            app.manage(Arc::new(
                mcp_desktop::DesktopService::new(
                    app.state::<Arc<SshRegistry>>().inner().clone(),
                    app.state::<Arc<SftpRegistry>>().inner().clone(),
                )
                .with_screens(
                    app.state::<Arc<RdpRegistry>>().inner().clone(),
                    app.state::<Arc<VncRegistry>>().inner().clone(),
                    app.state::<Arc<RemoteRegistry>>().inner().clone(),
                    app.state::<Arc<mcp_screen::ScreenFrames>>().inner().clone(),
                ),
            ));
            app.manage(Arc::new(TunnelRegistry::new()));
            app.manage(Arc::new(SensitiveClipboard::default()));
            let agent_registry = AgentRegistry::with_local_reporter(Arc::new(
                crate::agent::EventSink(app.handle().clone()),
            ))
            .map_err(std::io::Error::other)?;
            app.manage(agent_registry);
            let data_dir = app.path().app_data_dir().map_err(std::io::Error::other)?;
            app.manage(Arc::new(crate::agent_daemon::client::DaemonClient::new(
                app.handle().clone(),
                &data_dir,
            )));
            app.manage(Arc::new(crate::agent_chat::AgentChatRegistry::new()));
            #[cfg(target_os = "macos")]
            crate::app_menu::install_guarded_quit(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            runtime_summary,
            mcp_remote_targets,
            mcp_screen_sessions,
            mcp_remote_grant,
            mcp_remote_revoke,
            play_notification_sound,
            ios_export_document,
            encrypted_backup_export,
            encrypted_backup_restore,
            agent_catalog,
            agent_default_working_directory,
            agent_launch,
            agent_send,
            agent_broadcast,
            agent_enqueue,
            agent_clear_queue,
            agent_chat_supported,
            agent_account_profile_directory,
            agent_account_profile_status,
            agent_account_profile_remove,
            agent_chat_send,
            agent_chat_steer,
            agent_chat_stop,
            agent_chat_close,
            agent_chat_respond,
            agent_chat_models,
            agent_chat_skills,
            agent_paste_clipboard_image,
            agent_chat_paste_image,
            agent_export_transcript,
            agent_import_memory_handoff,
            agent_write_handoff_file,
            agent_resize,
            agent_disconnect,
            agent_sessions,
            agent_rename,
            agent_output_snapshots,
            agent_daemon_status,
            agent_daemon_stop,
            agent_mcp_share,
            agent_mcp_control,
            agent_mcp_plans_sync,
            agent_workspace_mcp_launch_update,
            agent_automations_sync,
            agent_automations_state,
            agent_automations_take_runs,
            agent_shared_rules_inspect,
            agent_shared_rules_save,
            agent_plan_snapshot,
            agent_plan_save,
            agent_plan_delete,
            agent_workspace_rename,
            agent_workspace_instructions_update,
            agent_plan_reorder,
            agent_plan_restore,
            credential_status,
            credential_backend_get,
            credential_backend_set,
            vault_status,
            vault_create,
            vault_unlock,
            vault_lock,
            vault_change_password,
            sensitive_clipboard_copy,
            sensitive_clipboard_clear,
            terminal_clipboard_read_text,
            terminal_clipboard_write_text,
            app_restart_safely,
            credential_exists,
            credential_delete,
            storage_status,
            list_connection_profiles,
            save_connection_profile,
            replace_connection_profiles,
            delete_connection_profile,
            ssh_connect,
            ssh_send,
            ssh_resize,
            ssh_disconnect,
            ssh_sessions,
            ssh_default_keys,
            host_metrics,
            sftp_connect,
            sftp_attach_ssh,
            sftp_sessions,
            sftp_list,
            sftp_create_directory,
            sftp_rename,
            sftp_remove,
            sftp_read_file,
            sftp_write_file,
            sftp_read_text_file,
            sftp_save_text_file,
            sftp_disconnect,
            sftp_download_start,
            sftp_upload_begin,
            sftp_upload_path,
            sftp_upload_chunk,
            sftp_upload_finish,
            sftp_transfer_cancel,
            sftp_transfer_dismiss,
            sftp_transfers,
            remote_connect,
            remote_disconnect,
            remote_sessions,
            remote_terminal_snapshots,
            remote_input,
            remote_terminal_input,
            remote_terminal_resize,
            remote_file_list,
            remote_file_read_text,
            remote_file_save_text,
            remote_file_download_start,
            remote_file_upload_begin,
            remote_file_upload_chunk,
            remote_file_upload_finish,
            remote_file_transfer_cancel,
            remote_file_transfer_dismiss,
            remote_file_transfers,
            remote_host_device_id,
            remote_host_start,
            remote_host_stop,
            remote_host_status,
            rdp_connect,
            rdp_input,
            rdp_disconnect,
            rdp_sessions,
            vnc_connect,
            vnc_input,
            vnc_disconnect,
            vnc_sessions,
            ssh_trust_host,
            ssh_known_hosts,
            ssh_forget_host,
            tunnel_start,
            tunnel_stop,
            tunnel_status,
            tunnel_list
        ])
        .build(tauri::generate_context!())
        .expect("error while building LatticeTerm");
    app.run(|handle, event| {
        if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
            let clipboard = Arc::clone(handle.state::<Arc<SensitiveClipboard>>().inner());
            let is_restart = code == Some(tauri::RESTART_EXIT_CODE);

            if !clipboard.exit_ready() && !is_restart {
                // A normal close can be delayed. Raise the seal synchronously,
                // clear off-main with a deadline, then request the real exit.
                api.prevent_exit();
                if clipboard.seal_for_exit() {
                    let exit_app = handle.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = clipboard
                            .clear_auto_on_exit_timeboxed(exit_app.clone(), CLIPBOARD_EXIT_TIMEOUT)
                            .await;
                        clipboard.mark_exit_ready();
                        exit_app.exit(code.unwrap_or(0));
                    });
                }
                return;
            }

            // Safe updater restarts arrive ready. An unexpected restart cannot
            // be prevented by Tauri, but still seals new writes and performs
            // the non-clipboard shutdown exactly once.
            if is_restart && !clipboard.exit_ready() {
                clipboard.seal_for_exit();
            }
            if !clipboard.begin_runtime_cleanup() {
                return;
            }
            let registry = handle.state::<Arc<AgentRegistry>>();
            if let Ok(mut history) = handle.state::<AppAgentHistory>().lock() {
                let _ = history.save(registry.terminal_history_snapshots());
            }
            registry.stop_all();
            handle
                .state::<Arc<crate::agent_chat::AgentChatRegistry>>()
                .shutdown();
            handle.state::<Arc<TunnelRegistry>>().stop_all();
            handle.state::<Arc<RdpRegistry>>().stop_all();
            handle.state::<Arc<VncRegistry>>().stop_all();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{
        parse_tags, validate_connection_draft, ConnectionDraft, ConnectionProfile, Environment,
        Protocol,
    };
    use crate::storage::{InMemoryStorage, Storage};

    #[test]
    fn mcp_share_response_preserves_the_daemons_grants_and_activity() {
        let sink = crate::agent_daemon::server::DaemonSink::default();
        sink.set_shared("agent-bg-test", true);
        sink.set_control("agent-bg-test", true).unwrap();
        sink.note_activity("agent-bg-test", "test-client", "prompt");
        let expected = sink.shared();
        let response = serde_json::to_value(&expected).unwrap();
        assert_eq!(decode_mcp_shared_response(response).unwrap(), expected);

        sink.set_shared("agent-bg-test", false);
        assert!(
            decode_mcp_shared_response(serde_json::to_value(sink.shared()).unwrap())
                .unwrap()
                .is_empty()
        );
        assert!(decode_mcp_shared_response(serde_json::json!(["agent-bg-test"])).is_err());
    }

    fn mcp_plan_test_store(directory: &std::path::Path) -> (AppAgentPlans, AgentLaunchPlanDraft) {
        let draft = AgentLaunchPlanDraft {
            definition_id: "codex".to_string(),
            label: "Test agent".to_string(),
            executable: "codex".to_string(),
            arguments: vec!["--model".to_string(), "test-model".to_string()],
            resume_session_id: None,
            note: String::new(),
            sandbox: false,
            detached: true,
            working_directory: directory.display().to_string(),
        };
        let mut store = FileAgentPlanStore::open(directory).unwrap();
        store.save(draft.clone()).unwrap();
        store.update_mcp_launch(true).unwrap();
        (Mutex::new(store), draft)
    }

    #[tokio::test]
    async fn mcp_plan_sync_publishes_same_id_sandbox_and_same_length_instruction_changes() {
        let directory = tempfile::tempdir().unwrap();
        let (store, mut draft) = mcp_plan_test_store(directory.path());
        store
            .lock()
            .unwrap()
            .update_startup_instructions("before")
            .unwrap();
        let original_id = store.lock().unwrap().snapshot().plans[0].id.clone();
        draft.sandbox = true;
        draft.note = "Changed memo".to_string();
        let published = Mutex::new(Vec::new());
        change_mcp_plan_settings(
            &store,
            &McpPlanSync::default(),
            |store| {
                store.save(draft)?;
                store.update_startup_instructions("after!")
            },
            |snapshot| {
                published.lock().unwrap().push(snapshot);
                std::future::ready(Ok(()))
            },
        )
        .await
        .unwrap();
        let published = published.lock().unwrap();
        assert_eq!(published.len(), 2);
        assert!(!published[0].mcp_launch);
        assert!(published[0].plans.is_empty());
        assert!(published[1].mcp_launch);
        assert_eq!(published[1].plans[0].id, original_id);
        let prepared = prepare_mcp_plans(&published[1]).unwrap();
        assert!(prepared[0].sandbox);
        assert!(prepared[0].request.sandbox);
        assert_eq!(prepared[0].note, "Changed memo");
        assert_eq!(prepared[0].request.seed_input.as_deref(), Some("after!"));
    }

    #[tokio::test]
    async fn mcp_plan_sync_failure_withdraws_persisted_grant_and_cached_plans() {
        let directory = tempfile::tempdir().unwrap();
        let (store, mut draft) = mcp_plan_test_store(directory.path());
        draft.sandbox = true;
        let published = Mutex::new(Vec::new());
        let error = change_mcp_plan_settings(
            &store,
            &McpPlanSync::default(),
            |store| store.save(draft),
            |snapshot| {
                let enabled = snapshot.mcp_launch;
                published.lock().unwrap().push(snapshot);
                std::future::ready(if enabled {
                    Err("lost acknowledgement".to_string())
                } else {
                    Ok(())
                })
            },
        )
        .await
        .unwrap_err();
        assert!(error.contains("lost acknowledgement"));
        let snapshot = FileAgentPlanStore::open(directory.path())
            .unwrap()
            .snapshot();
        assert!(!snapshot.mcp_launch);
        assert!(snapshot.plans[0].sandbox);
        let published = published.lock().unwrap();
        assert_eq!(
            published
                .iter()
                .map(|entry| entry.mcp_launch)
                .collect::<Vec<_>>(),
            vec![false, true, false]
        );
        assert!(published.last().unwrap().plans.is_empty());
    }

    #[tokio::test]
    async fn mcp_plan_sync_does_not_claim_revocation_if_daemon_cannot_acknowledge() {
        let directory = tempfile::tempdir().unwrap();
        let (store, _) = mcp_plan_test_store(directory.path());
        let error = change_mcp_plan_settings(
            &store,
            &McpPlanSync::default(),
            |store| store.update_mcp_launch(false),
            |_| std::future::ready(Err("daemon not responding".to_string())),
        )
        .await
        .unwrap_err();
        assert!(error.contains("daemon not responding"));
        assert!(error.contains("could not confirm withdrawal"));
        assert!(!store.lock().unwrap().snapshot().mcp_launch);
    }

    #[tokio::test]
    async fn mcp_plan_sync_never_reenables_a_grant_after_a_failed_save() {
        let directory = tempfile::tempdir().unwrap();
        let (store, _) = mcp_plan_test_store(directory.path());
        let published = Mutex::new(Vec::new());
        let error = change_mcp_plan_settings::<(), _, _, _>(
            &store,
            &McpPlanSync::default(),
            |_| Err("settings could not be saved".to_string()),
            |snapshot| {
                published.lock().unwrap().push(snapshot.mcp_launch);
                std::future::ready(Ok(()))
            },
        )
        .await
        .unwrap_err();
        assert!(error.contains("settings could not be saved"));
        assert!(!store.lock().unwrap().snapshot().mcp_launch);
        assert_eq!(*published.lock().unwrap(), vec![false]);
    }

    #[tokio::test]
    async fn mcp_plan_sync_initialization_publishes_without_temporary_revocation() {
        let directory = tempfile::tempdir().unwrap();
        let (store, _) = mcp_plan_test_store(directory.path());
        let published = Mutex::new(Vec::new());
        assert!(
            sync_mcp_plan_settings(&store, &McpPlanSync::default(), |snapshot| {
                published.lock().unwrap().push(snapshot.mcp_launch);
                std::future::ready(Ok(()))
            })
            .await
            .unwrap()
        );
        assert_eq!(*published.lock().unwrap(), vec![true]);
    }

    #[tokio::test]
    async fn mcp_plan_sync_initialization_failure_still_withdraws_the_grant() {
        let directory = tempfile::tempdir().unwrap();
        let (store, _) = mcp_plan_test_store(directory.path());
        let published = Mutex::new(Vec::new());
        let error = sync_mcp_plan_settings(&store, &McpPlanSync::default(), |snapshot| {
            let enabled = snapshot.mcp_launch;
            published.lock().unwrap().push(enabled);
            std::future::ready(if enabled {
                Err("initial sync failed".to_string())
            } else {
                Ok(())
            })
        })
        .await
        .unwrap_err();
        assert!(error.contains("initial sync failed"));
        assert_eq!(*published.lock().unwrap(), vec![true, false]);
        assert!(
            !FileAgentPlanStore::open(directory.path())
                .unwrap()
                .snapshot()
                .mcp_launch
        );
    }

    #[tokio::test]
    async fn mcp_plan_sync_unchanged_autosaves_do_not_publish_or_revoke() {
        let directory = tempfile::tempdir().unwrap();
        let (store, draft) = mcp_plan_test_store(directory.path());
        let sync = McpPlanSync::default();
        let published = Mutex::new(Vec::new());
        let publish = |snapshot: AgentPlanSnapshot| {
            published.lock().unwrap().push(snapshot.mcp_launch);
            std::future::ready(Ok(()))
        };
        let original = store.lock().unwrap().snapshot().plans[0].clone();
        let saved = change_mcp_plan_settings(&store, &sync, |store| store.save(draft), &publish)
            .await
            .unwrap();
        assert_eq!(saved, original);
        change_mcp_plan_settings(
            &store,
            &sync,
            |store| store.update_startup_instructions(""),
            &publish,
        )
        .await
        .unwrap();
        change_mcp_plan_settings(
            &store,
            &sync,
            |store| store.update_mcp_launch(true),
            &publish,
        )
        .await
        .unwrap();
        assert!(published.lock().unwrap().is_empty());
        assert!(store.lock().unwrap().snapshot().mcp_launch);
    }

    #[tokio::test]
    async fn mcp_plan_sync_serializes_pending_enable_before_revocation() {
        let directory = tempfile::tempdir().unwrap();
        let (store, _) = mcp_plan_test_store(directory.path());
        store.lock().unwrap().update_mcp_launch(false).unwrap();
        let sync = McpPlanSync::default();
        let pending = tokio::sync::Notify::new();
        let proceed = tokio::sync::Notify::new();
        let published = Mutex::new(Vec::new());
        let enable = change_mcp_plan_settings(
            &store,
            &sync,
            |store| store.update_mcp_launch(true),
            |snapshot| {
                let pending = &pending;
                let proceed = &proceed;
                let published = &published;
                async move {
                    if snapshot.mcp_launch {
                        pending.notify_one();
                        proceed.notified().await;
                    }
                    published.lock().unwrap().push(snapshot.mcp_launch);
                    Ok(())
                }
            },
        );
        let revoke = async {
            pending.notified().await;
            proceed.notify_one();
            change_mcp_plan_settings(
                &store,
                &sync,
                |store| store.update_mcp_launch(false),
                |snapshot| {
                    published.lock().unwrap().push(snapshot.mcp_launch);
                    std::future::ready(Ok(()))
                },
            )
            .await
        };
        let (enabled, revoked) = tokio::join!(enable, revoke);
        assert!(enabled.unwrap());
        assert!(!revoked.unwrap());
        assert!(!store.lock().unwrap().snapshot().mcp_launch);
        assert_eq!(*published.lock().unwrap(), vec![true, false, false]);
    }

    fn saved_profile(id: &str, protocol: Protocol) -> ConnectionProfile {
        ConnectionProfile {
            id: id.to_string(),
            name: "Saved endpoint".to_string(),
            protocol,
            hostname: "saved.internal".to_string(),
            username: "saved-user".to_string(),
            port: protocol.default_port(),
            environment: Environment::Production,
            group: "Servers".to_string(),
            tags: Vec::new(),
            favorite: false,
            device_id: None,
            relay_address: None,
        }
    }

    #[test]
    fn installs_a_crypto_provider_before_tauri_creates_http_clients() {
        install_rustls_crypto_provider();

        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    }

    #[test]
    fn runtime_summary_reports_the_real_secure_storage_status() {
        let summary =
            tauri::async_runtime::block_on(runtime_summary()).expect("summary is computed");

        assert_eq!(summary.app_name, "LatticeTerm");
        assert_eq!(
            summary.supported_protocols,
            supported_protocols_for(std::env::consts::OS)
        );
        assert_eq!(
            summary.credential_storage_ready,
            crate::credentials::status().ready
        );
    }

    #[test]
    fn runtime_protocols_match_desktop_and_mobile_engines() {
        assert_eq!(
            supported_protocols_for("linux"),
            ["ssh", "sftp", "rdp", "vnc", "lattice"]
        );
        assert_eq!(
            supported_protocols_for("windows"),
            ["ssh", "sftp", "rdp", "vnc", "lattice"]
        );
        assert_eq!(
            supported_protocols_for("android"),
            ["ssh", "sftp", "lattice"]
        );
        assert_eq!(supported_protocols_for("ios"), ["ssh", "sftp", "lattice"]);
    }

    #[test]
    fn saved_ssh_profile_owns_the_endpoint_used_with_its_credential() {
        let mut request = ConnectRequest {
            profile_id: "profile-safe".to_string(),
            hostname: "attacker.example".to_string(),
            port: 2222,
            username: "stolen-user".to_string(),
            auth: crate::ssh::AuthMethod::Password {
                password: "one-call-secret".to_string(),
            },
            use_saved_password: true,
            remember_password: false,
            cols: 80,
            rows: 24,
        };
        let profile = ConnectionProfile {
            id: "profile-safe".to_string(),
            name: "Production gateway".to_string(),
            protocol: Protocol::Ssh,
            hostname: "gateway.internal".to_string(),
            username: "operator".to_string(),
            port: 22,
            environment: Environment::Production,
            group: "Servers".to_string(),
            tags: Vec::new(),
            favorite: false,
            device_id: None,
            relay_address: None,
        };

        bind_ssh_request_to_profile(&mut request, &profile).unwrap();

        assert_eq!(request.hostname, "gateway.internal");
        assert_eq!(request.port, 22);
        assert_eq!(request.username, "operator");
    }

    #[test]
    fn ssh_credentials_cannot_be_paired_with_another_protocol_profile() {
        let mut request = ConnectRequest {
            profile_id: "profile-rdp".to_string(),
            hostname: "gateway.internal".to_string(),
            port: 22,
            username: "operator".to_string(),
            auth: crate::ssh::AuthMethod::Password {
                password: "one-call-secret".to_string(),
            },
            use_saved_password: false,
            remember_password: true,
            cols: 80,
            rows: 24,
        };
        let profile = ConnectionProfile {
            id: "profile-rdp".to_string(),
            name: "Desktop".to_string(),
            protocol: Protocol::Rdp,
            hostname: "desktop.internal".to_string(),
            username: "operator".to_string(),
            port: 3389,
            environment: Environment::Production,
            group: "Servers".to_string(),
            tags: Vec::new(),
            favorite: false,
            device_id: None,
            relay_address: None,
        };

        assert!(bind_ssh_request_to_profile(&mut request, &profile).is_err());
        assert_eq!(request.hostname, "gateway.internal");
        assert_eq!(request.port, 22);
    }

    #[test]
    fn every_password_protocol_uses_its_saved_profile_endpoint() {
        let mut sftp = SftpConnectRequest {
            profile_id: "profile-sftp".to_string(),
            hostname: "attacker.example".to_string(),
            port: 2222,
            username: "attacker".to_string(),
            auth: crate::ssh::AuthMethod::Password {
                password: "one-call-secret".to_string(),
            },
            use_saved_password: true,
            remember_password: false,
        };
        bind_sftp_request_to_profile(&mut sftp, &saved_profile("profile-sftp", Protocol::Sftp))
            .unwrap();
        assert_eq!(
            (sftp.hostname.as_str(), sftp.port, sftp.username.as_str()),
            ("saved.internal", 22, "saved-user")
        );

        let mut rdp = RdpConnectRequest {
            profile_id: "profile-rdp".to_string(),
            hostname: "attacker.example".to_string(),
            port: 4444,
            username: "attacker".to_string(),
            password: "one-call-secret".to_string(),
            use_saved_password: true,
            remember_password: false,
            domain: None,
            width: 1280,
            height: 720,
        };
        bind_rdp_request_to_profile(&mut rdp, &saved_profile("profile-rdp", Protocol::Rdp))
            .unwrap();
        assert_eq!(
            (rdp.hostname.as_str(), rdp.port, rdp.username.as_str()),
            ("saved.internal", 3389, "saved-user")
        );

        let mut vnc = VncConnectRequest {
            profile_id: "profile-vnc".to_string(),
            hostname: "attacker.example".to_string(),
            port: 4444,
            password: "one-call-secret".to_string(),
            use_saved_password: true,
            remember_password: false,
        };
        bind_vnc_request_to_profile(&mut vnc, &saved_profile("profile-vnc", Protocol::Vnc))
            .unwrap();
        assert_eq!((vnc.hostname.as_str(), vnc.port), ("saved.internal", 5900));
    }

    #[test]
    fn saved_lattice_profile_owns_the_permanent_device_identity() {
        let mut profile = saved_profile("profile-remote", Protocol::Lattice);
        profile.hostname.clear();
        profile.username.clear();
        profile.port = 0;
        profile.device_id = Some("123 456 789".to_string());
        profile.relay_address = Some("wss://saved-relay.example.test".to_string());
        let mut request = RemoteConnectRequest {
            profile_id: "profile-remote".to_string(),
            hostname: "attacker.example".to_string(),
            port: 44900,
            pairing_code: "12345678".to_string(),
            use_saved_pairing_code: true,
            remember_pairing_code: false,
            legacy_pairing: false,
            device_id: "987654321".to_string(),
            relay_address: "wss://current-relay.example.test".to_string(),
        };

        bind_remote_request_to_profile(&mut request, &profile).unwrap();

        assert_eq!(request.device_id, "123456789");
        assert_eq!(
            request.relay_address, "wss://current-relay.example.test",
            "a user-supplied relay repair must remain usable"
        );
        assert_eq!(
            lattice_pairing_context(&profile).unwrap(),
            "lattice-relay-device:123456789"
        );
    }

    #[test]
    fn direct_lattice_profile_cannot_remember_a_pairing_code() {
        let profile = saved_profile("profile-direct", Protocol::Lattice);
        let mut request = RemoteConnectRequest {
            profile_id: "profile-direct".to_string(),
            hostname: "attacker.example".to_string(),
            port: 44900,
            pairing_code: "12345678".to_string(),
            use_saved_pairing_code: false,
            remember_pairing_code: true,
            legacy_pairing: false,
            device_id: "987654321".to_string(),
            relay_address: "wss://attacker.example.test".to_string(),
        };

        bind_remote_request_to_profile(&mut request, &profile).unwrap();

        assert_eq!(request.hostname, "saved.internal");
        assert_eq!(request.port, Protocol::Lattice.default_port());
        assert!(request.device_id.is_empty());
        assert!(request.relay_address.is_empty());
        assert!(lattice_pairing_context(&profile).is_err());
    }

    #[test]
    fn rdp_saved_password_binding_distinguishes_the_authentication_domain() {
        assert_ne!(
            rdp_credential_context(&Some("CORP".to_string())),
            rdp_credential_context(&Some("EVIL".to_string()))
        );
        assert_ne!(
            rdp_credential_context(&None),
            rdp_credential_context(&Some(String::new()))
        );
    }

    #[test]
    fn validates_and_constructs_profile_from_draft() {
        let draft = ConnectionDraft {
            name: "Edge Gateway".to_string(),
            protocol: Protocol::Ssh,
            hostname: "gateway.example.com".to_string(),
            username: "operator".to_string(),
            port: 22,
            environment: Environment::Production,
            group: Some("Core platform".to_string()),
            tags: vec!["edge".to_string(), "eu-west".to_string()],
            favorite: true,
            device_id: None,
            relay_address: None,
        };

        let errors = validate_connection_draft(&draft);
        assert!(errors.is_empty(), "Expected valid draft, got {:?}", errors);

        let profile = ConnectionProfile::from_draft(draft, "test-id-1".to_string());
        assert_eq!(profile.id, "test-id-1");
        assert_eq!(profile.name, "Edge Gateway");
        assert_eq!(profile.protocol, Protocol::Ssh);
        assert_eq!(profile.group, "Core platform");
        assert_eq!(profile.tags, vec!["edge", "eu-west"]);
        assert_eq!(profile.target_string(), "operator@gateway.example.com:22");
    }

    #[test]
    fn accepts_a_relay_draft_addressed_by_device_id() {
        let draft = ConnectionDraft {
            name: "Workshop".to_string(),
            protocol: Protocol::Lattice,
            // A relay entry has neither of these; the relay finds the machine
            // by its identity.
            hostname: String::new(),
            username: String::new(),
            port: 0,
            environment: Environment::Unassigned,
            group: None,
            tags: vec![],
            favorite: false,
            device_id: Some("018 536 454".to_string()),
            relay_address: Some("wss://relay.example.com".to_string()),
        };

        let errors = validate_connection_draft(&draft);
        assert!(errors.is_empty(), "Expected valid draft, got {:?}", errors);

        let profile = ConnectionProfile::from_draft(draft, "relay-1".to_string());
        assert_eq!(profile.device_id.as_deref(), Some("018536454"));
        assert_eq!(
            profile.relay_address.as_deref(),
            Some("wss://relay.example.com")
        );
        assert_eq!(profile.target_string(), "018536454");
    }

    #[test]
    fn rejects_a_relay_draft_without_a_readable_identity() {
        let draft = ConnectionDraft {
            name: "Workshop".to_string(),
            protocol: Protocol::Lattice,
            hostname: String::new(),
            username: String::new(),
            port: 0,
            environment: Environment::Unassigned,
            group: None,
            tags: vec![],
            favorite: false,
            device_id: Some("12345".to_string()),
            relay_address: Some("wss://relay.example.com".to_string()),
        };

        assert!(validate_connection_draft(&draft).hostname.is_some());
    }

    #[test]
    fn a_relay_entry_survives_a_storage_round_trip() {
        let draft = ConnectionDraft {
            name: "Workshop".to_string(),
            protocol: Protocol::Lattice,
            hostname: String::new(),
            username: String::new(),
            port: 0,
            environment: Environment::Unassigned,
            group: None,
            tags: vec![],
            favorite: false,
            device_id: Some("018536454".to_string()),
            relay_address: Some("wss://relay.example.com".to_string()),
        };
        let profile = ConnectionProfile::from_draft(draft, "relay-1".to_string());

        let written = serde_json::to_string(&profile).unwrap();
        // Pairing codes never reach connection-profile storage. An optional
        // saved code lives in the separate secure credential backend.
        assert!(written.contains("018536454"));
        let restored: ConnectionProfile = serde_json::from_str(&written).unwrap();
        assert_eq!(restored, profile);

        // Entries written before relay support still load.
        let legacy = r#"{"id":"a","name":"Gateway","protocol":"ssh",
            "hostname":"gw.example.com","username":"root","port":22,
            "environment":"production","group":"Servers","tags":[],
            "favorite":false}"#;
        let old: ConnectionProfile = serde_json::from_str(legacy).unwrap();
        assert_eq!(old.device_id, None);
        assert_eq!(old.relay_address, None);
    }

    #[test]
    fn rejects_invalid_draft_fields() {
        let invalid_draft = ConnectionDraft {
            name: "".to_string(),
            protocol: Protocol::Ssh,
            hostname: "ssh://invalid host with spaces".to_string(),
            username: "user name".to_string(),
            port: 0,
            environment: Environment::Unassigned,
            group: None,
            tags: vec![],
            favorite: false,
            device_id: None,
            relay_address: None,
        };

        let errors = validate_connection_draft(&invalid_draft);
        assert!(errors.name.is_some());
        assert!(errors.hostname.is_some());
        assert!(errors.username.is_some());
        assert!(errors.port.is_some());
    }

    #[test]
    fn tag_parsing_deduplicates_and_normalizes() {
        let parsed = parse_tags([" Edge, edge ", "EU West\nprod", ""]);
        assert_eq!(parsed, vec!["edge", "eu-west", "prod"]);
    }

    #[test]
    fn storage_trait_crud_operations() {
        let mut storage = InMemoryStorage::new();

        let profile = ConnectionProfile {
            id: "p1".to_string(),
            name: "Server A".to_string(),
            protocol: Protocol::Ssh,
            hostname: "a.example.com".to_string(),
            username: "root".to_string(),
            port: 22,
            environment: Environment::Production,
            group: "Servers".to_string(),
            tags: vec!["db".to_string()],
            favorite: true,
            device_id: None,
            relay_address: None,
        };

        assert!(storage.insert_profile(profile.clone()).is_ok());

        let retrieved = storage.get_profile("p1").unwrap();
        assert_eq!(retrieved, Some(profile.clone()));

        let list = storage.list_profiles().unwrap();
        assert_eq!(list.len(), 1);

        assert!(storage.delete_profile("p1").unwrap());
        assert_eq!(storage.get_profile("p1").unwrap(), None);
    }

    #[test]
    fn clipboard_images_have_bounded_consistent_rgba_data() {
        assert!(validate_clipboard_image(32, 32, 32 * 32 * 4).is_ok());
        assert!(validate_clipboard_image(0, 32, 0).is_err());
        assert!(validate_clipboard_image(MAX_CLIPBOARD_IMAGE_EDGE + 1, 1, 4).is_err());
        assert!(validate_clipboard_image(8192, 8192, 8192 * 8192 * 4).is_err());
        assert!(validate_clipboard_image(32, 32, 32 * 32 * 3).is_err());
    }
}
