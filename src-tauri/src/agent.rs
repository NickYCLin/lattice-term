//! Local AI CLI sessions backed by real pseudo-terminals.
//!
//! Commands are never interpolated into a shell string. A known agent resolves
//! to its fixed executable name; custom agents provide an executable and an
//! argument vector. Authentication stays with each CLI and its own config.

use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::{OsStr, OsString};
use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[cfg(any(windows, test))]
#[cfg_attr(not(windows), allow(dead_code))]
mod codex_input_profile;
mod codex_resume;

pub const EVENT_DATA: &str = "agent://data";
pub const EVENT_CLOSED: &str = "agent://closed";
pub const EVENT_STATE: &str = "agent://state";
pub const EVENT_CAPTURE: &str = "agent://capture";
pub const EVENT_MODEL: &str = "agent://model";
pub const EVENT_USAGE: &str = "agent://usage";
pub const EVENT_QUEUE: &str = "agent://queue";
/// A session somebody other than this window started (an MCP client through
/// the background service); the payload is its summary.
pub const EVENT_LAUNCHED: &str = "agent://launched";

const MAX_INPUT_BYTES: usize = 64 * 1024;
const MAX_ARGUMENTS: usize = 64;
const MAX_ARGUMENT_BYTES: usize = 4096;
const MAX_RESUME_SESSION_ID_BYTES: usize = 512;
const MAX_ANTIGRAVITY_CAPTURE_LOG_BYTES: u64 = 2 * 1024 * 1024;
const MAX_PLAN_NOTE_BYTES: usize = 200;
const MAX_BROADCAST_TARGETS: usize = 32;
/// Prompts one session may hold waiting for it to finish. Deep enough for a
/// planned sequence of steps, shallow enough that a queue built by accident
/// cannot keep feeding a CLI long after the user stopped watching.
const MAX_QUEUED_PROMPTS: usize = 16;
pub const MAX_AGENT_SESSIONS: usize = 32;
pub const MAX_SAVED_AGENT_PLANS: usize = 32;
const MAX_OUTPUT_SNAPSHOT_BYTES: usize = 256 * 1024;
const MAX_REPORT_BYTES: u64 = 4096;
const MAX_NOTIFY_FORWARD_ARGUMENTS: usize = 16;
const MAX_NOTIFY_FORWARD_BYTES: usize = 8192;
const MAX_LIFECYCLE_HOOK_BYTES: u64 = 1024 * 1024;
const MAX_REPORTED_TOKENS_PER_REQUEST: u64 = 1_000_000_000_000;
const MAX_REPORTED_USAGE_REQUESTS: usize = 4096;
const MAX_SERIALIZED_USAGE_VALUE: u64 = (1_u64 << 53) - 1;
const MAX_STAGED_IMAGES_PER_SESSION: usize = 32;
const MAX_STAGED_IMAGE_BYTES_PER_SESSION: u64 = 256 * 1024 * 1024;
const REPORT_TIMEOUT: Duration = Duration::from_secs(1);
const REPORT_RETRIES: usize = 5;
const STARTUP_SEED_PROMPT_SETTLE: Duration = Duration::from_millis(120);
const STARTUP_SEED_MIN_WAIT: Duration = Duration::from_millis(1800);
const STARTUP_SEED_OUTPUT_QUIET: Duration = Duration::from_millis(550);
const STARTUP_SEED_TIMEOUT: Duration = Duration::from_secs(20);
const STARTUP_CONTROL_WINDOW_BYTES: usize = 64;
/// How often a session is checked for a terminal that has gone completely
/// silent while the interface still claims it is working.
const SILENT_WORKING_CHECK_INTERVAL: Duration = Duration::from_secs(60);
/// Every interactive CLI redraws an elapsed-time or token counter while it
/// works, so a PTY this quiet is parked at its prompt.
const SILENT_WORKING_TIMEOUT: Duration = Duration::from_secs(600);
/// How long a prompt-ready control code has to be followed by silence before
/// a CLI without a lifecycle integration is called done. A spinner redraws
/// many times a second, so a CLI still working never stays quiet this long;
/// a CLI parked at its prompt prints nothing at all.
#[cfg(not(test))]
const PROMPT_READY_SETTLE: Duration = Duration::from_secs(2);
#[cfg(test)]
const PROMPT_READY_SETTLE: Duration = Duration::from_millis(150);

const AGENT_ADAPTER_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy)]
enum AgentResumeRecipe {
    Subcommand,
    Flag,
}

impl AgentResumeRecipe {
    fn arguments(self, session_id: String) -> Vec<String> {
        match self {
            Self::Subcommand => vec!["resume".to_string(), session_id],
            Self::Flag => vec!["--resume".to_string(), session_id],
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum AgentResumeLatestRecipe {
    Codex,
    Continue,
}

impl AgentResumeLatestRecipe {
    fn arguments(self) -> Vec<String> {
        match self {
            Self::Codex => vec!["resume".to_string(), "--last".to_string()],
            Self::Continue => vec!["--continue".to_string()],
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct AgentSpec {
    id: &'static str,
    label: &'static str,
    executable: &'static str,
    resume_recipe: Option<AgentResumeRecipe>,
    resume_latest_recipe: Option<AgentResumeLatestRecipe>,
}

const AGENTS: [AgentSpec; 13] = [
    AgentSpec {
        id: "codex",
        label: "OpenAI Codex",
        executable: "codex",
        resume_recipe: Some(AgentResumeRecipe::Subcommand),
        resume_latest_recipe: Some(AgentResumeLatestRecipe::Codex),
    },
    AgentSpec {
        id: "claude",
        label: "Claude Code",
        executable: "claude",
        resume_recipe: Some(AgentResumeRecipe::Flag),
        // Claude keeps its recent conversations per working directory. Use
        // its documented --continue path when an older LatticeTerm snapshot
        // predates the hook-based native session-id capture.
        resume_latest_recipe: Some(AgentResumeLatestRecipe::Continue),
    },
    AgentSpec {
        id: "gemini",
        label: "Gemini CLI",
        executable: "gemini",
        resume_recipe: Some(AgentResumeRecipe::Flag),
        resume_latest_recipe: None,
    },
    AgentSpec {
        id: "antigravity",
        label: "Google Antigravity CLI",
        executable: "agy",
        resume_recipe: None,
        resume_latest_recipe: Some(AgentResumeLatestRecipe::Continue),
    },
    AgentSpec {
        id: "opencode",
        label: "OpenCode",
        executable: "opencode",
        resume_recipe: None,
        resume_latest_recipe: None,
    },
    AgentSpec {
        id: "copilot",
        label: "GitHub Copilot CLI",
        executable: "copilot",
        resume_recipe: None,
        resume_latest_recipe: None,
    },
    AgentSpec {
        id: "hermes",
        label: "Hermes Agent",
        executable: "hermes",
        resume_recipe: Some(AgentResumeRecipe::Flag),
        resume_latest_recipe: None,
    },
    AgentSpec {
        id: "cursor",
        label: "Cursor Agent",
        executable: "agent",
        resume_recipe: Some(AgentResumeRecipe::Flag),
        resume_latest_recipe: Some(AgentResumeLatestRecipe::Continue),
    },
    AgentSpec {
        id: "aider",
        label: "Aider",
        executable: "aider",
        resume_recipe: None,
        resume_latest_recipe: None,
    },
    AgentSpec {
        id: "qwen",
        label: "Qwen Code",
        executable: "qwen",
        resume_recipe: None,
        resume_latest_recipe: None,
    },
    AgentSpec {
        id: "kimi",
        label: "Kimi Code CLI",
        executable: "kimi",
        resume_recipe: None,
        resume_latest_recipe: None,
    },
    AgentSpec {
        id: "droid",
        label: "Factory Droid",
        executable: "droid",
        resume_recipe: None,
        resume_latest_recipe: None,
    },
    AgentSpec {
        id: "grok",
        label: "Grok CLI",
        executable: "grok",
        resume_recipe: None,
        resume_latest_recipe: None,
    },
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinition {
    pub id: String,
    pub label: String,
    pub executable: String,
    pub adapter_version: u32,
    pub resume_supported: bool,
    /// Whether a saved launch item can resume the latest context without
    /// persisting a native session identifier.
    pub resume_latest_supported: bool,
    /// Whether this CLI's conversation can be read for a handoff to another CLI.
    pub transcript_supported: bool,
    pub installed: bool,
    pub installed_path: Option<String>,
    /// Whether this installation selected Gemini's retired personal Google
    /// OAuth client. Enterprise, API-key and Vertex authentication remain
    /// valid, so the warning must follow the configured auth mode, not merely
    /// the executable name.
    pub consumer_oauth_deprecated: bool,
    /// Non-secret identity metadata read from each CLI's own local account
    /// file. Tokens and credential values never cross the Tauri boundary.
    pub account: AgentAccountInfo,
    /// Fixed, source-reviewed installation command for this platform.
    pub install: AgentInstallDefinition,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentAccountState {
    SignedIn,
    SignedOut,
    Unknown,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAccountInfo {
    pub state: AgentAccountState,
    pub label: Option<String>,
    pub method: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstallDefinition {
    /// `None` means this platform needs the linked manual installation path.
    pub executable: Option<String>,
    pub arguments: Vec<String>,
    pub display_command: String,
    pub source_url: String,
    pub available: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentLifecycle {
    Working,
    NeedsAttention,
    Idle,
    Done,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentStateSource {
    Heuristic,
    Integration,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub reasoning_tokens: u64,
    pub total_tokens: u64,
    pub api_calls: u64,
}

impl AgentTokenUsage {
    fn add_report(&mut self, report: &AgentUsageReport) {
        let add = |current: u64, increment: u64| {
            current
                .saturating_add(increment)
                .min(MAX_SERIALIZED_USAGE_VALUE)
        };
        self.input_tokens = add(self.input_tokens, report.input_tokens);
        self.output_tokens = add(self.output_tokens, report.output_tokens);
        self.cache_read_tokens = add(self.cache_read_tokens, report.cache_read_tokens);
        self.cache_write_tokens = add(self.cache_write_tokens, report.cache_write_tokens);
        self.reasoning_tokens = add(self.reasoning_tokens, report.reasoning_tokens);
        self.total_tokens = add(self.total_tokens, report.total_tokens());
        self.api_calls = add(self.api_calls, 1);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionSummary {
    pub session_id: String,
    /// Groups CLIs that share one tab; defaults to the session's own id.
    pub group_id: String,
    /// User-facing tab name shared by every CLI in the same group.
    pub group_label: String,
    pub definition_id: String,
    /// Local-only account identity, also needed when restoring this process.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_config_path: Option<String>,
    /// CLI name. This stays independent from the user-facing tab name.
    pub label: String,
    /// Model announced by the CLI or explicitly supplied through `--model`.
    pub model: Option<String>,
    pub executable: String,
    /// Original requested arguments, retained for a safe relaunch elsewhere.
    pub launch_arguments: Vec<String>,
    /// Whether this process was recreated from the persisted workspace.
    /// The frontend keeps failed automatic restores recoverable until the user
    /// explicitly closes their tab.
    pub restore_existing_session: bool,
    pub working_directory: String,
    pub state: AgentLifecycle,
    pub state_source: AgentStateSource,
    pub process_id: Option<u32>,
    /// Token buckets reported by an authenticated semantic adapter. `None`
    /// means this CLI has not supplied trustworthy usage data.
    pub token_usage: Option<AgentTokenUsage>,
    /// Prompts waiting for this session to finish its current turn.
    #[serde(default)]
    pub queued_prompts: usize,
    /// The CLI's own session id, when its output announced one — the value
    /// native resume takes. Never guessed: absent until actually seen.
    pub captured_session_id: Option<String>,
    /// True when the process runs inside the file-scope sandbox.
    #[serde(default)]
    pub sandboxed: bool,
    /// Owned by the background daemon: survives closing the window.
    #[serde(default)]
    pub detached: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBroadcastOutcome {
    pub session_id: String,
    pub delivered: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOutputSnapshot {
    pub session_id: String,
    pub start_offset: u64,
    pub end_offset: u64,
    pub base64: String,
}

/// A slice of one session's retained output for a reader that keeps its own
/// cursor. `start_offset` is the oldest byte still retained: a cursor below
/// it has missed output that is gone for good, which `truncated` says.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentOutputRange {
    pub session_id: String,
    pub start_offset: u64,
    pub end_offset: u64,
    /// Offset of the first byte in `base64`.
    pub cursor: u64,
    /// Offset just past the last byte in `base64`: the next cursor.
    pub next_cursor: u64,
    pub truncated: bool,
    pub base64: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLaunchRequest {
    pub definition_id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub executable: String,
    #[serde(default)]
    pub arguments: Vec<String>,
    #[serde(default)]
    pub resume_session_id: Option<String>,
    /// The tab this CLI joins. Absent means it starts its own group (a new tab);
    /// present means it docks into an existing tab's CLI switcher.
    #[serde(default)]
    pub group_id: Option<String>,
    /// A handoff brief pasted into the CLI once it is interactive, so a new CLI
    /// can pick up the previous one's conversation. Absent means a clean start.
    #[serde(default)]
    pub seed_input: Option<String>,
    /// Automatic workspace restoration resumes existing work. It must not
    /// prepend instructions intended only for a newly started CLI task.
    #[serde(default)]
    pub restore_existing_session: bool,
    /// An ephemeral, user-selected CLI config root for Codex or Claude. It is
    /// intentionally excluded from saved workspace plans: credentials and
    /// machine-local account paths must not be restored or shared by a plan.
    #[serde(default)]
    pub profile_config_path: Option<String>,
    /// Run the CLI in a file-scope sandbox: everything read-only except the
    /// working directory, its own state directories and /tmp. Refused where
    /// no sandbox tool exists rather than silently running unconfined.
    #[serde(default)]
    pub sandbox: bool,
    /// Hand the session to the background daemon so it outlives the window.
    #[serde(default)]
    pub detached: bool,
    pub working_directory: String,
    pub cols: u32,
    pub rows: u32,
}

fn profile_config_directory(
    definition_id: &str,
    raw: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    let Some(raw) = raw.map(str::trim).filter(|path| !path.is_empty()) else {
        return Ok(None);
    };
    if definition_id != "codex" && definition_id != "claude" {
        return Err("Only Codex and Claude Code support account profiles.".to_string());
    }
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err("The account profile directory must be an absolute path.".to_string());
    }
    let path = plain_win32_path(
        path.canonicalize()
            .map_err(|error| format!("Cannot open the account profile directory: {error}"))?,
    );
    if !path.is_dir() {
        return Err("The account profile path is not a directory.".to_string());
    }
    Ok(Some(path))
}

/// A configuration root of LatticeTerm's own for one account profile,
/// created on first use under the app's data directory.
///
/// Claude Code and Codex keep their login inside their config directory, so
/// a second account needs a second directory or the logins overwrite each
/// other. Making that directory here means the person only names the
/// account; the CLI then logs in there the first time it starts. Nothing is
/// written into it by LatticeTerm, and nothing is read back.
pub fn account_profile_directory(
    data_dir: &Path,
    definition_id: &str,
    profile_id: &str,
) -> Result<PathBuf, String> {
    if definition_id != "codex" && definition_id != "claude" {
        return Err("Only Codex and Claude Code support account profiles.".to_string());
    }
    if profile_id.is_empty()
        || profile_id.len() > 64
        || !profile_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Invalid account profile id.".to_string());
    }
    let directory = data_dir
        .join("agent-profiles")
        .join(definition_id)
        .join(profile_id);
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Cannot create the account profile directory: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // The CLI will keep a login token in here.
        let _ = std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700));
    }
    Ok(plain_win32_path(
        directory.canonicalize().unwrap_or(directory),
    ))
}

/// Where a CLI keeps its login inside an account profile directory.
fn account_profile_auth_file(definition_id: &str, directory: &Path) -> Option<PathBuf> {
    match definition_id {
        "codex" => Some(directory.join("auth.json")),
        "claude" => Some(directory.join(".claude.json")),
        _ => None,
    }
}

const ACCOUNT_FILE_LIMIT: u64 = 256 * 1024;

/// The login state of one account profile, read the same way as the default
/// account but from the profile's own directory. Only a state, a display
/// label and the login method leave this function; tokens stay in the file.
pub fn account_profile_status(definition_id: &str, directory: &Path) -> AgentAccountInfo {
    let Some(auth_file) = account_profile_auth_file(definition_id, directory) else {
        return account_info(AgentAccountState::Unsupported, None, None);
    };
    if !directory.is_absolute() || !directory.is_dir() {
        return account_info(AgentAccountState::Unknown, None, None);
    }
    let Ok(metadata) = std::fs::metadata(&auth_file) else {
        // Claude Code writes `.credentials.json` first; a profile that has
        // only that is signed in even before the account file exists.
        if definition_id == "claude" && directory.join(".credentials.json").is_file() {
            return account_info(AgentAccountState::SignedIn, None, Some("Claude.ai"));
        }
        return account_info(AgentAccountState::SignedOut, None, None);
    };
    if !metadata.is_file() || metadata.len() > ACCOUNT_FILE_LIMIT {
        return account_info(AgentAccountState::Unknown, None, None);
    }
    let Ok(raw) = std::fs::read_to_string(&auth_file) else {
        return account_info(AgentAccountState::Unknown, None, None);
    };
    let info = match definition_id {
        "codex" => codex_account_from_json(&raw),
        _ => claude_account_from_json(&raw),
    };
    if info.state == AgentAccountState::Unknown
        && definition_id == "claude"
        && directory.join(".credentials.json").is_file()
    {
        return account_info(AgentAccountState::SignedIn, None, Some("Claude.ai"));
    }
    info
}

/// Removes a profile directory LatticeTerm created itself, login data
/// included. Only the fixed `agent-profiles/<cli>/<id>` shape is accepted so
/// a stored path can never point the removal anywhere else.
pub fn remove_account_profile_directory(
    data_dir: &Path,
    definition_id: &str,
    profile_id: &str,
) -> Result<bool, String> {
    if definition_id != "codex" && definition_id != "claude" {
        return Err("Only Codex and Claude Code support account profiles.".to_string());
    }
    if profile_id.is_empty()
        || profile_id.len() > 64
        || !profile_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Invalid account profile id.".to_string());
    }
    let directory = data_dir
        .join("agent-profiles")
        .join(definition_id)
        .join(profile_id);
    match std::fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.is_dir() => std::fs::remove_dir_all(&directory)
            .map(|_| true)
            .map_err(|error| format!("Cannot remove the account profile directory: {error}")),
        Ok(_) => Err("The account profile path is not a directory.".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!(
            "Cannot inspect the account profile directory: {error}"
        )),
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLaunchPlanDraft {
    pub definition_id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub executable: String,
    #[serde(default)]
    pub arguments: Vec<String>,
    #[serde(default)]
    pub resume_session_id: Option<String>,
    /// Free-text memo, e.g. which project this CLI works on. Never launched.
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub sandbox: bool,
    /// Restore into the background service so it outlives the window.
    #[serde(default)]
    pub detached: bool,
    pub working_directory: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLaunchPlan {
    pub id: String,
    pub definition_id: String,
    pub label: String,
    pub executable: String,
    pub arguments: Vec<String>,
    #[serde(default)]
    pub resume_session_id: Option<String>,
    /// Free-text memo shown in the saved list so a plan's purpose is obvious.
    #[serde(default)]
    pub note: String,
    /// Whether this plan launches inside the file-scope sandbox.
    #[serde(default)]
    pub sandbox: bool,
    #[serde(default)]
    pub detached: bool,
    pub working_directory: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRestoreOutcome {
    pub plan_id: String,
    pub label: String,
    pub session: Option<AgentSessionSummary>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentData {
    session_id: String,
    offset: u64,
    base64: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentClosed {
    session_id: String,
    reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentStateChanged {
    session_id: String,
    state: AgentLifecycle,
    source: AgentStateSource,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentModelChanged {
    session_id: String,
    model: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentUsageChanged {
    session_id: String,
    token_usage: AgentTokenUsage,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentQueueChanged {
    session_id: String,
    queued_prompts: usize,
}

pub trait AgentSink: Send + Sync + 'static {
    fn data(&self, session_id: &str, offset: u64, bytes: &[u8]);
    fn state(&self, session_id: &str, state: AgentLifecycle, source: AgentStateSource);
    fn closed(&self, session_id: &str, reason: &str);
    fn captured(&self, session_id: &str, native_session_id: &str);
    fn model(&self, session_id: &str, model: &str);
    fn usage(&self, session_id: &str, token_usage: &AgentTokenUsage);
    /// How many prompts are now waiting for this session.
    fn queue(&self, session_id: &str, queued_prompts: usize);
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentSessionIdCaptured {
    session_id: String,
    native_session_id: String,
}

pub struct EventSink(pub AppHandle);

impl AgentSink for EventSink {
    fn data(&self, session_id: &str, offset: u64, bytes: &[u8]) {
        let result = self.0.emit(
            EVENT_DATA,
            AgentData {
                session_id: session_id.to_string(),
                offset,
                base64: encode(bytes),
            },
        );
        if let Err(error) = result {
            // Losing PTY output silently makes a healthy local CLI look hung.
            eprintln!("failed to deliver agent output: {error}");
        }
    }

    fn state(&self, session_id: &str, state: AgentLifecycle, source: AgentStateSource) {
        let _ = self.0.emit(
            EVENT_STATE,
            AgentStateChanged {
                session_id: session_id.to_string(),
                state,
                source,
            },
        );
    }

    fn closed(&self, session_id: &str, reason: &str) {
        let _ = self.0.emit(
            EVENT_CLOSED,
            AgentClosed {
                session_id: session_id.to_string(),
                reason: reason.to_string(),
            },
        );
    }

    fn captured(&self, session_id: &str, native_session_id: &str) {
        let _ = self.0.emit(
            EVENT_CAPTURE,
            AgentSessionIdCaptured {
                session_id: session_id.to_string(),
                native_session_id: native_session_id.to_string(),
            },
        );
    }

    fn model(&self, session_id: &str, model: &str) {
        let _ = self.0.emit(
            EVENT_MODEL,
            AgentModelChanged {
                session_id: session_id.to_string(),
                model: model.to_string(),
            },
        );
    }

    fn usage(&self, session_id: &str, token_usage: &AgentTokenUsage) {
        let _ = self.0.emit(
            EVENT_USAGE,
            AgentUsageChanged {
                session_id: session_id.to_string(),
                token_usage: token_usage.clone(),
            },
        );
    }

    fn queue(&self, session_id: &str, queued_prompts: usize) {
        let _ = self.0.emit(
            EVENT_QUEUE,
            AgentQueueChanged {
                session_id: session_id.to_string(),
                queued_prompts,
            },
        );
    }
}

struct AgentSessionEntry {
    summary: Mutex<AgentSessionSummary>,
    /// Serializes input, lifecycle readiness and MCP grant changes for this
    /// PTY only. A user editing a prompt owns it until submitting it.
    input: Mutex<AgentInputControl>,
    /// Revocation and stopping must stay available when a PTY write blocks.
    /// Odd epochs grant control; even epochs revoke it. A new grant cannot
    /// revive a prompt accepted under an earlier one.
    mcp_grant_epoch: AtomicU64,
    /// Tickets are acquired before waiting on input, so a cancelled split
    /// paste can reject already-waiting desktop writes instead of merging them.
    desktop_input_ticket: AtomicU64,
    /// A control re-grant never restores the launch-time keyboard attestation.
    /// Human input invalidates it before waiting for the shared input lock.
    mcp_input_profile_invalidated: AtomicBool,
    #[cfg(windows)]
    codex_input_profile: Option<CodexInputAttestation>,
    #[cfg(all(windows, test))]
    codex_input_profile_test_supported: AtomicBool,
    stopping: AtomicBool,
    report_token: Option<String>,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    capture: Mutex<CaptureState>,
    model_capture: Mutex<ModelCaptureState>,
    output: Mutex<OutputBuffer>,
    startup_gate: StartupGate,
    completion_gate: Mutex<CompletionReadiness>,
    /// When this PTY last produced output, used to release a heuristic
    /// "working" guess that no lifecycle integration ever confirmed.
    last_output_at: Mutex<Instant>,
    /// A prompt-ready control code seen at this instant, waiting to see
    /// whether the terminal goes quiet afterwards. TUIs re-enable bracketed
    /// paste on ordinary redraws too, so the code alone proves nothing.
    prompt_ready_at: Mutex<Option<Instant>>,
    /// An official CLI lifecycle hook will report completion for this session,
    /// so prompt-rendering control codes must never guess that it is done.
    integrated_completion: AtomicBool,
    /// Copilot can leave background subagents running after its main agent
    /// emits Stop. Track them independently so Stop is not mistaken for the
    /// end of all work in the PTY.
    copilot_activity: Option<Mutex<CopilotActivity>>,
    /// Hermes emits lifecycle events for both the main conversation and each
    /// delegated child. Keep their identities separate so a child finishing
    /// can never mark the main turn done.
    hermes_activity: Option<Mutex<HermesActivity>>,
    /// Reporter retries must be idempotent: if the local acknowledgement is
    /// lost, the same successful API request can be delivered more than once.
    reported_usage_requests: Mutex<ReportedUsageRequests>,
    /// Prompts lined up while this session was busy, delivered one at a time.
    ///
    /// Only an official integration event releases the next one. A heuristic
    /// guess that the CLI went idle is not proof that it stopped reading, and
    /// typing into a session that is still working would land the prompt in
    /// the middle of whatever it was doing.
    queued_prompts: Mutex<VecDeque<QueuedPrompt>>,
    /// Keeps per-session integration files alive only as long as their PTY.
    _integration_settings: Option<AgentIntegrationSettings>,
    /// Clipboard images may contain sensitive material. Keep their temporary
    /// paths tied to this PTY instead of leaking permanent files into /tmp.
    staged_images: Mutex<StagedAgentImages>,
}

#[derive(Default)]
struct AgentInputControl {
    desktop_editing: bool,
    desktop_paste: bool,
    desktop_escape: Vec<u8>,
    startup_seed_pending: bool,
    rejected_desktop_through: u64,
}

impl AgentInputControl {
    fn desktop_busy(&self) -> bool {
        self.desktop_editing || self.desktop_paste || !self.desktop_escape.is_empty()
    }
}

struct QueuedPrompt {
    bytes: Vec<u8>,
    /// Desktop prompts have no MCP grant; external prompts remember the
    /// exact authorization under which they entered the queue.
    mcp_grant_epoch: Option<u64>,
}

#[cfg(windows)]
struct CodexInputAttestation {
    context: codex_input_profile::ProbeContext,
    profile: codex_input_profile::SupportedProfile,
}

fn invalidate_mcp_input_profile(entry: &AgentSessionEntry, bytes: &[u8]) {
    if !bytes.is_empty() && !is_terminal_status_reply(bytes) {
        entry
            .mcp_input_profile_invalidated
            .store(true, Ordering::Release);
    }
}

fn next_desktop_input_ticket(entry: &AgentSessionEntry, bytes: &[u8]) -> Result<u64, String> {
    let ticket = entry
        .desktop_input_ticket
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |ticket| {
            ticket.checked_add(1)
        })
        .map_err(|_| "The terminal input ticket limit was reached.".to_string())?
        + 1;
    invalidate_mcp_input_profile(entry, bytes);
    Ok(ticket)
}

fn mcp_input_profile_valid(entry: &AgentSessionEntry) -> bool {
    #[cfg(windows)]
    let supported = entry.codex_input_profile.is_some() || {
        #[cfg(test)]
        {
            entry
                .codex_input_profile_test_supported
                .load(Ordering::Acquire)
        }
        #[cfg(not(test))]
        {
            false
        }
    };
    #[cfg(not(windows))]
    let supported = false;
    supported && !entry.mcp_input_profile_invalidated.load(Ordering::Acquire)
}

fn revalidate_mcp_input_profile(
    entry: &AgentSessionEntry,
    definition_id: &str,
) -> Result<(), String> {
    require_mcp_input_profile(entry, definition_id)?;
    #[cfg(windows)]
    if definition_id == "codex" {
        if let Some(attestation) = entry.codex_input_profile.as_ref() {
            if attestation
                .profile
                .revalidate(&attestation.context)
                .is_err()
            {
                entry
                    .mcp_input_profile_invalidated
                    .store(true, Ordering::Release);
            }
        }
        // A human waiter can invalidate the profile while source hashing runs.
        require_mcp_input_profile(entry, definition_id)?;
    }
    Ok(())
}

fn require_mcp_input_profile(entry: &AgentSessionEntry, definition_id: &str) -> Result<(), String> {
    if cfg!(windows) && definition_id == "codex" && !mcp_input_profile_valid(entry) {
        return Err(MCP_INPUT_PROFILE_UNSUPPORTED.to_string());
    }
    Ok(())
}

fn current_mcp_grant(entry: &AgentSessionEntry) -> Option<u64> {
    let epoch = entry.mcp_grant_epoch.load(Ordering::Acquire);
    (epoch & 1 == 1).then_some(epoch)
}

fn prompt_grant_matches(entry: &AgentSessionEntry, epoch: Option<u64>) -> bool {
    match epoch {
        Some(expected) => current_mcp_grant(entry) == Some(expected),
        None => true,
    }
}

#[derive(Default)]
struct StagedAgentImages {
    files: Vec<tempfile::TempPath>,
    total_bytes: u64,
}

impl StagedAgentImages {
    fn add(&mut self, file: tempfile::NamedTempFile) -> Result<PathBuf, String> {
        let bytes = file
            .as_file()
            .metadata()
            .map_err(|error| format!("Cannot inspect the staged clipboard image: {error}"))?
            .len();
        let total_bytes = self
            .total_bytes
            .checked_add(bytes)
            .ok_or_else(|| "Staged clipboard image storage is too large.".to_string())?;
        if self.files.len() >= MAX_STAGED_IMAGES_PER_SESSION {
            return Err("This agent session has too many staged clipboard images.".to_string());
        }
        if total_bytes > MAX_STAGED_IMAGE_BYTES_PER_SESSION {
            return Err("This agent session's staged clipboard images are too large.".to_string());
        }

        let path = file.path().to_path_buf();
        self.files.push(file.into_temp_path());
        self.total_bytes = total_bytes;
        Ok(path)
    }

    fn clear(&mut self) {
        self.files.clear();
        self.total_bytes = 0;
    }
}

enum AgentIntegrationSettings {
    Antigravity(AntigravityCaptureLog),
    Copilot(CopilotReporterPlugin),
    Gemini(tempfile::NamedTempFile),
    Hermes(HermesReporterPlugin),
    Qwen(tempfile::NamedTempFile),
    OpenCode(OpenCodeReporterPlugin),
}

struct AntigravityCaptureLog {
    _directory: tempfile::TempDir,
    path: PathBuf,
}

struct CopilotReporterPlugin {
    directory: tempfile::TempDir,
}

impl CopilotReporterPlugin {
    fn path(&self) -> &Path {
        self.directory.path()
    }
}

struct HermesReporterPlugin {
    directory: tempfile::TempDir,
}

impl HermesReporterPlugin {
    fn path(&self) -> &Path {
        self.directory.path()
    }
}

struct OpenCodeReporterPlugin {
    _file: tempfile::NamedTempFile,
    config_content: String,
}

#[derive(Debug, Default)]
struct StartupReadiness {
    saw_output: bool,
    prompt_ready: bool,
    interactive_gate_open: bool,
    cancelled: bool,
    restarted_at: Option<Instant>,
    last_output_at: Option<Instant>,
    control_window: Vec<u8>,
}

impl StartupReadiness {
    fn observe(&mut self, bytes: &[u8], now: Instant) {
        self.saw_output = true;
        self.last_output_at = Some(now);
        self.control_window.extend_from_slice(bytes);
        if self
            .control_window
            .windows(b"\x1b[?2004h".len())
            .any(|window| window == b"\x1b[?2004h")
        {
            self.prompt_ready = true;
        }
        // Codex enables bracketed paste before it finishes deciding whether a
        // new project needs an explicit trust decision. Treating that first
        // mode switch as the chat prompt can paste startup instructions into
        // the selector; Codex then exits successfully instead of opening the
        // session. Keep the seed behind the dialog until the user submits a
        // choice and fresh prompt output has settled.
        if self
            .control_window
            .windows(b"Do you trust the contents of this directory?".len())
            .any(|window| window == b"Do you trust the contents of this directory?")
        {
            self.interactive_gate_open = true;
            self.prompt_ready = false;
        }
        if self.control_window.len() > STARTUP_CONTROL_WINDOW_BYTES {
            let overflow = self.control_window.len() - STARTUP_CONTROL_WINDOW_BYTES;
            self.control_window.drain(..overflow);
        }
    }

    fn observe_input(&mut self, bytes: &[u8], now: Instant) {
        if !self.interactive_gate_open || !prompt_input_shape(bytes).1 {
            return;
        }
        self.interactive_gate_open = false;
        self.saw_output = false;
        self.prompt_ready = false;
        self.restarted_at = Some(now);
        self.last_output_at = None;
        self.control_window.clear();
    }

    fn should_deliver(&self, started_at: Instant, now: Instant) -> bool {
        if self.cancelled || self.interactive_gate_open {
            return false;
        }
        let started_at = self.restarted_at.unwrap_or(started_at);
        let elapsed = now.saturating_duration_since(started_at);
        if elapsed >= STARTUP_SEED_TIMEOUT {
            return true;
        }
        let Some(last_output_at) = self.last_output_at else {
            return false;
        };
        let quiet_for = now.saturating_duration_since(last_output_at);
        if self.prompt_ready {
            elapsed >= STARTUP_SEED_MIN_WAIT && quiet_for >= STARTUP_SEED_PROMPT_SETTLE
        } else {
            self.saw_output
                && elapsed >= STARTUP_SEED_MIN_WAIT
                && quiet_for >= STARTUP_SEED_OUTPUT_QUIET
        }
    }

    fn wait_duration(&self, started_at: Instant, now: Instant) -> Duration {
        if self.interactive_gate_open {
            // Output, user input, or process cancellation wakes the condition
            // variable. The finite wait is only a guard against a lost wakeup.
            return Duration::from_secs(60);
        }
        let started_at = self.restarted_at.unwrap_or(started_at);
        let until_timeout =
            STARTUP_SEED_TIMEOUT.saturating_sub(now.saturating_duration_since(started_at));
        if let Some(last_output_at) = self.last_output_at {
            let quiet_target = if self.prompt_ready {
                STARTUP_SEED_PROMPT_SETTLE
            } else {
                STARTUP_SEED_OUTPUT_QUIET
            };
            let until_quiet =
                quiet_target.saturating_sub(now.saturating_duration_since(last_output_at));
            let until_min_wait =
                STARTUP_SEED_MIN_WAIT.saturating_sub(now.saturating_duration_since(started_at));
            return until_timeout
                .min(until_quiet.max(until_min_wait))
                .max(Duration::from_millis(1));
        }
        until_timeout
            .min(Duration::from_millis(250))
            .max(Duration::from_millis(1))
    }
}

/// Splits a keystroke chunk into "carries prompt text" and "ends with Enter".
/// Escape sequences are skipped so arrow keys, function keys and bracketed
/// paste markers never look like typed characters.
fn prompt_input_shape(bytes: &[u8]) -> (bool, bool) {
    let mut typed = false;
    let mut submitted = false;
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == 0x1b {
            index += 1;
            if matches!(bytes.get(index), Some(b'[') | Some(b'O')) {
                index += 1;
                while index < bytes.len() && !(0x40..=0x7e).contains(&bytes[index]) {
                    index += 1;
                }
            }
            index += 1;
            continue;
        }
        if matches!(byte, b'\r' | b'\n') {
            submitted = true;
        } else if byte >= 0x20 && byte != 0x7f {
            typed = true;
        }
        index += 1;
    }
    (typed, submitted)
}

/// What one keystroke chunk did to the CLI's prompt.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum PromptSubmission {
    /// Editing keys only; the prompt was not sent.
    #[default]
    None,
    /// Enter with an empty prompt: a dialog answer, not a new task.
    BareEnter,
    /// Enter after the user typed something.
    Text,
}

#[derive(Debug, Default)]
struct CompletionReadiness {
    submitted: bool,
    typed: bool,
    working_footer_seen: bool,
    control_window: Vec<u8>,
}

// Keep enough of one TUI redraw to relate an approval question to its choices.
const COMPLETION_CONTROL_WINDOW_BYTES: usize = 4096;

impl CompletionReadiness {
    /// Records one keystroke chunk and reports how it left the prompt.
    fn observe_input(&mut self, bytes: &[u8]) -> PromptSubmission {
        let (typed, submitted) = prompt_input_shape(bytes);
        self.typed |= typed;
        if !submitted {
            return PromptSubmission::None;
        }
        let carried_text = self.typed;
        self.typed = false;
        self.submitted = true;
        self.working_footer_seen = false;
        self.control_window.clear();
        if carried_text {
            PromptSubmission::Text
        } else {
            PromptSubmission::BareEnter
        }
    }

    fn observe_output(
        &mut self,
        bytes: &[u8],
        integrated_completion: bool,
    ) -> Option<AgentLifecycle> {
        self.control_window.extend_from_slice(bytes);
        if self.control_window.len() > COMPLETION_CONTROL_WINDOW_BYTES {
            let overflow = self.control_window.len() - COMPLETION_CONTROL_WINDOW_BYTES;
            self.control_window.drain(..overflow);
        }
        let text = strip_ansi(&String::from_utf8_lossy(&self.control_window)).to_lowercase();
        let working = has_explicit_working_status(&text);

        // A real approval dialog can interrupt active work. Ordinary prose,
        // diffs and the always-visible composer cannot establish that state.
        let attention = has_attention_marker(&text)
            && (!(self.working_footer_seen || working) || has_actionable_attention_prompt(&text));
        if attention {
            self.cancel();
            return Some(AgentLifecycle::NeedsAttention);
        }

        // Codex renders an explicit working footer while a foreground turn or
        // a background terminal is still active. A stale conversational
        // question must not leave the sidebar on "needs attention" after
        // this authoritative-looking activity signal arrives.
        // Read the accumulated, ANSI-free tail: both styles and PTY read
        // boundaries can split the words the user sees on one line.
        if working {
            self.working_footer_seen = true;
            self.control_window.clear();
            return Some(AgentLifecycle::Working);
        }

        // Bracketed-paste mode is enabled when an interactive prompt is ready
        // for the next command. Cursor visibility (`CSI ? 25 h`) is not a
        // completion signal: spinners and full-screen CLIs toggle it while a
        // response is still being generated.
        let prompt_ready = self.submitted
            && !integrated_completion
            && self
                .control_window
                .windows(b"\x1b[?2004h".len())
                .any(|window| window == b"\x1b[?2004h");
        if prompt_ready {
            // `submitted` stays set: this may be a redraw rather than the
            // prompt, and if it is, the real prompt-ready must still count.
            // The registry clears it once the terminal has gone quiet.
            self.control_window.clear();
            return Some(AgentLifecycle::Done);
        }
        None
    }

    fn cancel(&mut self) {
        self.submitted = false;
        self.working_footer_seen = false;
        self.control_window.clear();
    }
}

/// What became of a prompt-ready sighting once its quiet window elapsed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PromptReadySettle {
    /// The terminal stayed quiet: the CLI is at its prompt.
    Done,
    /// More output arrived; check again this long after the newest of it.
    Retry(Instant),
    /// Something authoritative moved the state, or the sighting was
    /// superseded; nothing to show.
    Dropped,
}

/// Decides whether a session that only *looks* busy should be released. The
/// state must be this process's own guess from submitted input: an integration
/// verdict is authoritative and is never second-guessed, and "idle" is used
/// instead of "done" because nothing observed a result.
fn should_settle_silent_working(
    state: AgentLifecycle,
    source: AgentStateSource,
    silent_for: Duration,
) -> bool {
    state == AgentLifecycle::Working
        && source == AgentStateSource::Heuristic
        && silent_for >= SILENT_WORKING_TIMEOUT
}

fn heuristic_state_from_output(
    completion: &mut CompletionReadiness,
    bytes: &[u8],
    integrated_completion: bool,
) -> Option<AgentLifecycle> {
    completion.observe_output(bytes, integrated_completion)
}

#[derive(Debug, Default)]
struct StartupGate {
    readiness: Mutex<StartupReadiness>,
    changed: Condvar,
}

impl StartupGate {
    fn observe(&self, bytes: &[u8]) {
        if let Ok(mut readiness) = self.readiness.lock() {
            readiness.observe(bytes, Instant::now());
            self.changed.notify_all();
        }
    }

    fn observe_input(&self, bytes: &[u8]) {
        if let Ok(mut readiness) = self.readiness.lock() {
            readiness.observe_input(bytes, Instant::now());
            self.changed.notify_all();
        }
    }

    fn cancel(&self) {
        if let Ok(mut readiness) = self.readiness.lock() {
            readiness.cancelled = true;
            self.changed.notify_all();
        }
    }

    fn wait_until_ready(&self, started_at: Instant) -> bool {
        let Ok(mut readiness) = self.readiness.lock() else {
            return false;
        };
        loop {
            if readiness.cancelled {
                return false;
            }
            let now = Instant::now();
            if readiness.should_deliver(started_at, now) {
                return true;
            }
            let duration = readiness.wait_duration(started_at, now);
            let Ok((next, _)) = self.changed.wait_timeout(readiness, duration) else {
                return false;
            };
            readiness = next;
        }
    }
}

fn startup_seed_payload(seed: &str) -> Vec<u8> {
    format!("\u{1b}[200~{seed}\u{1b}[201~\r").into_bytes()
}

#[derive(Default)]
struct OutputBuffer {
    bytes: VecDeque<u8>,
    start_offset: u64,
    end_offset: u64,
}

impl OutputBuffer {
    fn from_tail(bytes: &[u8]) -> Self {
        let start = bytes.len().saturating_sub(MAX_OUTPUT_SNAPSHOT_BYTES);
        let tail = &bytes[start..];
        Self {
            bytes: tail.iter().copied().collect(),
            start_offset: 0,
            end_offset: tail.len() as u64,
        }
    }

    fn append(&mut self, bytes: &[u8]) -> u64 {
        let offset = self.end_offset;
        self.end_offset = self.end_offset.saturating_add(bytes.len() as u64);
        self.bytes.extend(bytes);
        if self.bytes.len() > MAX_OUTPUT_SNAPSHOT_BYTES {
            let overflow = self.bytes.len() - MAX_OUTPUT_SNAPSHOT_BYTES;
            self.bytes.drain(..overflow);
            self.start_offset = self.start_offset.saturating_add(overflow as u64);
        }
        offset
    }

    fn snapshot(&self, session_id: &str) -> AgentOutputSnapshot {
        let bytes = self.bytes.iter().copied().collect::<Vec<_>>();
        AgentOutputSnapshot {
            session_id: session_id.to_string(),
            start_offset: self.start_offset,
            end_offset: self.end_offset,
            base64: encode(&bytes),
        }
    }

    fn tail(&self) -> Vec<u8> {
        self.bytes.iter().copied().collect()
    }

    /// At most `max` bytes from `cursor` on. A cursor older than the
    /// retained window starts at the window instead and says so.
    fn range(&self, session_id: &str, cursor: u64, max: usize) -> AgentOutputRange {
        let truncated = cursor < self.start_offset;
        let from = cursor.clamp(self.start_offset, self.end_offset);
        let skip = (from - self.start_offset) as usize;
        let bytes: Vec<u8> = self.bytes.iter().skip(skip).take(max).copied().collect();
        let next = from + bytes.len() as u64;
        AgentOutputRange {
            session_id: session_id.to_string(),
            start_offset: self.start_offset,
            end_offset: self.end_offset,
            cursor: from,
            next_cursor: next,
            truncated,
            base64: encode(&bytes),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentTerminalHistorySnapshot {
    pub group_id: String,
    pub definition_id: String,
    pub output: Vec<u8>,
}

/// Rolling window over a session's output while its native session id has
/// not been seen yet. Bounded so an agent that never announces one costs a
/// few kilobytes, not unbounded growth.
struct CaptureState {
    enabled: bool,
    buffer: String,
}

/// How much stripped output the capture window retains across chunks.
const CAPTURE_WINDOW_CHARS: usize = 4096;

impl CaptureState {
    /// Feeds one raw output chunk into the window and returns a session id
    /// the moment one is seen. Ids split across chunks are still found,
    /// because matching runs over the retained window, not the chunk.
    fn feed(&mut self, bytes: &[u8]) -> Option<String> {
        if !self.enabled {
            return None;
        }
        let stripped = strip_ansi(&String::from_utf8_lossy(bytes));
        self.buffer.push_str(&stripped);
        let length = self.buffer.chars().count();
        if length > CAPTURE_WINDOW_CHARS {
            self.buffer = self
                .buffer
                .chars()
                .skip(length - CAPTURE_WINDOW_CHARS)
                .collect();
        }
        let found = find_native_session_id(&self.buffer)?;
        self.enabled = false;
        self.buffer.clear();
        Some(found)
    }
}

/// Reads only the CLI's startup output (and explicit `/model` responses) so a
/// model name printed later by generated content is never mistaken for state.
struct ModelCaptureState {
    definition_id: String,
    enabled: bool,
    buffer: String,
    scanned_chars: usize,
    input_buffer: String,
    model_command_active: bool,
}

const MODEL_CAPTURE_WINDOW_CHARS: usize = 4096;
const MODEL_CAPTURE_LIMIT_CHARS: usize = 32 * 1024;

impl ModelCaptureState {
    fn feed(&mut self, bytes: &[u8]) -> Option<String> {
        if !self.enabled {
            return None;
        }
        let stripped = strip_ansi(&String::from_utf8_lossy(bytes));
        self.scanned_chars = self.scanned_chars.saturating_add(stripped.chars().count());
        self.buffer.push_str(&stripped);
        let length = self.buffer.chars().count();
        if length > MODEL_CAPTURE_WINDOW_CHARS {
            self.buffer = self
                .buffer
                .chars()
                .skip(length - MODEL_CAPTURE_WINDOW_CHARS)
                .collect();
        }
        if let Some(model) = find_model_name(&self.definition_id, &self.buffer) {
            if self.model_command_active {
                // A /model picker lists several names before the choice
                // lands, so the first sighting is usually the menu itself.
                // Stay armed and let the last sighting win; the watch ends
                // when the next ordinary command line is submitted.
                self.scanned_chars = 0;
                self.buffer.clear();
                return Some(model);
            }
            self.enabled = false;
            self.buffer.clear();
            return Some(model);
        }
        if self.scanned_chars >= MODEL_CAPTURE_LIMIT_CHARS {
            self.enabled = false;
            self.buffer.clear();
        }
        None
    }

    fn input(&mut self, bytes: &[u8]) {
        let input = strip_ansi(&String::from_utf8_lossy(bytes));
        // xterm sends terminal-generated replies (device attributes, cursor
        // position, focus, colour queries, and similar CSI/OSC sequences)
        // through the same onData channel as keyboard input. Those replies are
        // stripped to an empty string and must not end startup model capture.
        if input.is_empty() {
            return;
        }
        if !self.model_command_active {
            self.enabled = false;
            self.buffer.clear();
        }
        for character in input.chars() {
            match character {
                '\r' | '\n' => {
                    let submitted = self.input_buffer.trim();
                    if submitted.starts_with("/model") {
                        self.enabled = true;
                        self.model_command_active = true;
                        self.buffer.clear();
                        self.scanned_chars = 0;
                    } else if self.model_command_active && !submitted.is_empty() {
                        // Picking with arrows submits an empty line and keeps
                        // the watch; the next real command ends it so later
                        // generated content is never read as a model change.
                        self.model_command_active = false;
                        self.enabled = false;
                        self.buffer.clear();
                    }
                    self.input_buffer.clear();
                }
                '\u{8}' | '\u{7f}' => {
                    self.input_buffer.pop();
                }
                value if !value.is_control() && self.input_buffer.len() < 256 => {
                    self.input_buffer.push(value);
                }
                _ => {}
            }
        }
    }
}

#[derive(Clone)]
struct ReporterEndpoint {
    address: SocketAddr,
    executable: PathBuf,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReporterMessage {
    session_id: String,
    token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    state: Option<AgentLifecycle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    native_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    copilot_event: Option<CopilotReporterEvent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hermes_event: Option<HermesReporterEvent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    usage: Option<AgentUsageReport>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentUsageReport {
    source_session_id: String,
    request_id: String,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
    reasoning_tokens: u64,
}

impl AgentUsageReport {
    fn total_tokens(&self) -> u64 {
        self.input_tokens
            .saturating_add(self.output_tokens)
            .saturating_add(self.cache_read_tokens)
            .saturating_add(self.cache_write_tokens)
    }

    fn validate(&self) -> Result<(), String> {
        for (label, value) in [
            ("input", self.input_tokens),
            ("output", self.output_tokens),
            ("cache read", self.cache_read_tokens),
            ("cache write", self.cache_write_tokens),
            ("reasoning", self.reasoning_tokens),
        ] {
            if value > MAX_REPORTED_TOKENS_PER_REQUEST {
                return Err(format!("Reported {label} token usage is too large."));
            }
        }
        for (label, value) in [
            ("source session", self.source_session_id.as_str()),
            ("request", self.request_id.as_str()),
        ] {
            if value.is_empty()
                || value.len() > MAX_RESUME_SESSION_ID_BYTES
                || value.chars().any(char::is_control)
            {
                return Err(format!("Reported usage {label} id is invalid."));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Default)]
struct ReportedUsageRequests {
    order: VecDeque<(String, String)>,
    ids: HashSet<(String, String)>,
}

impl ReportedUsageRequests {
    fn remember(&mut self, report: &AgentUsageReport) -> bool {
        let key = (report.source_session_id.clone(), report.request_id.clone());
        if !self.ids.insert(key.clone()) {
            return false;
        }
        self.order.push_back(key);
        if self.order.len() > MAX_REPORTED_USAGE_REQUESTS {
            if let Some(expired) = self.order.pop_front() {
                self.ids.remove(&expired);
            }
        }
        true
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CopilotReporterEvent {
    source_session_id: String,
    #[serde(flatten)]
    action: CopilotReporterAction,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum CopilotReporterAction {
    SessionStarted,
    TurnStarted,
    Working,
    Stop,
    NeedsAttention,
    RecoverableError,
    FatalError,
    BackgroundSubagentQueued,
    SubagentStart {
        #[serde(rename = "agentName")]
        agent_name: String,
    },
    SubagentStop {
        #[serde(rename = "agentName")]
        agent_name: String,
    },
    BackgroundCompleted,
    BackgroundIdle,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HermesReporterEvent {
    source_session_id: String,
    #[serde(flatten)]
    action: HermesReporterAction,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum HermesReporterAction {
    SessionStarted,
    TurnStarted,
    TurnEnded {
        completed: bool,
        failed: bool,
        interrupted: bool,
    },
    SubagentStarted {
        #[serde(rename = "childSessionId")]
        child_session_id: String,
    },
    SubagentStopped {
        #[serde(rename = "childSessionId")]
        child_session_id: String,
    },
    NeedsAttention,
    ApprovalResolved,
}

#[derive(Debug, Default)]
struct CopilotActivity {
    primary_session_id: Option<String>,
    main_stopped: bool,
    fatal_error: bool,
    pending_background_subagents: usize,
    active_subagents: HashMap<String, usize>,
}

impl CopilotActivity {
    fn begin_turn(&mut self) {
        self.main_stopped = false;
        self.fatal_error = false;
    }

    fn has_background_work(&self) -> bool {
        self.pending_background_subagents > 0 || !self.active_subagents.is_empty()
    }

    fn is_primary(&self, source_session_id: &str) -> bool {
        self.primary_session_id.as_deref() == Some(source_session_id)
    }

    fn apply(&mut self, event: &CopilotReporterEvent) -> Option<AgentLifecycle> {
        match &event.action {
            CopilotReporterAction::SessionStarted => {
                self.primary_session_id
                    .get_or_insert_with(|| event.source_session_id.clone());
                None
            }
            CopilotReporterAction::TurnStarted => {
                self.primary_session_id
                    .get_or_insert_with(|| event.source_session_id.clone());
                if self.is_primary(&event.source_session_id) {
                    self.begin_turn();
                }
                Some(AgentLifecycle::Working)
            }
            CopilotReporterAction::Working | CopilotReporterAction::RecoverableError => {
                Some(AgentLifecycle::Working)
            }
            CopilotReporterAction::Stop if !self.is_primary(&event.source_session_id) => None,
            CopilotReporterAction::Stop => {
                self.main_stopped = true;
                Some(if self.fatal_error {
                    AgentLifecycle::NeedsAttention
                } else if !self.has_background_work() {
                    AgentLifecycle::Done
                } else {
                    AgentLifecycle::Working
                })
            }
            CopilotReporterAction::NeedsAttention => Some(AgentLifecycle::NeedsAttention),
            CopilotReporterAction::FatalError => {
                if self.is_primary(&event.source_session_id) {
                    self.fatal_error = true;
                }
                Some(AgentLifecycle::NeedsAttention)
            }
            CopilotReporterAction::BackgroundSubagentQueued => {
                self.pending_background_subagents =
                    self.pending_background_subagents.saturating_add(1);
                Some(AgentLifecycle::Working)
            }
            CopilotReporterAction::SubagentStart { agent_name } => {
                self.pending_background_subagents =
                    self.pending_background_subagents.saturating_sub(1);
                *self.active_subagents.entry(agent_name.clone()).or_default() += 1;
                Some(AgentLifecycle::Working)
            }
            CopilotReporterAction::SubagentStop { agent_name } => {
                if let Some(count) = self.active_subagents.get_mut(agent_name) {
                    *count = count.saturating_sub(1);
                    if *count == 0 {
                        self.active_subagents.remove(agent_name);
                    }
                }
                Some(if self.main_stopped && self.fatal_error {
                    AgentLifecycle::NeedsAttention
                } else if self.main_stopped && !self.has_background_work() {
                    AgentLifecycle::Done
                } else {
                    AgentLifecycle::Working
                })
            }
            CopilotReporterAction::BackgroundCompleted | CopilotReporterAction::BackgroundIdle => {
                // Older Copilot versions may notify completion without a
                // matching subagentStart/subagentStop pair. Consume only the
                // pending launch so current versions cannot double-decrement
                // their independently tracked active subagents.
                self.pending_background_subagents =
                    self.pending_background_subagents.saturating_sub(1);
                if !self.main_stopped {
                    None
                } else if self.fatal_error {
                    Some(AgentLifecycle::NeedsAttention)
                } else if self.has_background_work() {
                    Some(AgentLifecycle::Working)
                } else if matches!(&event.action, CopilotReporterAction::BackgroundIdle) {
                    Some(AgentLifecycle::Idle)
                } else {
                    Some(AgentLifecycle::Done)
                }
            }
        }
    }
}

#[derive(Debug, Default)]
struct HermesActivity {
    primary_session_id: Option<String>,
    active_subagents: HashSet<String>,
    main_outcome: Option<AgentLifecycle>,
}

impl HermesActivity {
    fn is_primary(&self, source_session_id: &str) -> bool {
        self.primary_session_id.as_deref() == Some(source_session_id)
    }

    fn is_child(&self, source_session_id: &str) -> bool {
        self.active_subagents.contains(source_session_id)
    }

    fn begin_turn(&mut self) {
        self.main_outcome = None;
    }

    fn current_or_working(&self) -> AgentLifecycle {
        if self.active_subagents.is_empty() {
            self.main_outcome.unwrap_or(AgentLifecycle::Working)
        } else {
            AgentLifecycle::Working
        }
    }

    fn apply(&mut self, event: &HermesReporterEvent) -> Option<AgentLifecycle> {
        match &event.action {
            HermesReporterAction::SessionStarted | HermesReporterAction::TurnStarted => {
                if self.is_child(&event.source_session_id) {
                    return None;
                }
                self.primary_session_id
                    .get_or_insert_with(|| event.source_session_id.clone());
                if !self.is_primary(&event.source_session_id) {
                    return None;
                }
                self.begin_turn();
                Some(AgentLifecycle::Working)
            }
            HermesReporterAction::TurnEnded {
                completed,
                failed,
                interrupted,
            } => {
                if !self.is_primary(&event.source_session_id) {
                    return None;
                }
                let outcome = if *failed {
                    AgentLifecycle::NeedsAttention
                } else if *interrupted {
                    AgentLifecycle::Idle
                } else if *completed {
                    AgentLifecycle::Done
                } else {
                    AgentLifecycle::NeedsAttention
                };
                self.main_outcome = Some(outcome);
                Some(self.current_or_working())
            }
            HermesReporterAction::SubagentStarted { child_session_id } => {
                self.primary_session_id
                    .get_or_insert_with(|| event.source_session_id.clone());
                self.active_subagents.insert(child_session_id.clone());
                Some(AgentLifecycle::Working)
            }
            HermesReporterAction::SubagentStopped { child_session_id } => {
                self.active_subagents.remove(child_session_id);
                Some(self.current_or_working())
            }
            HermesReporterAction::NeedsAttention => Some(AgentLifecycle::NeedsAttention),
            HermesReporterAction::ApprovalResolved => Some(self.current_or_working()),
        }
    }
}

fn agent_session_limit_reached(session_count: usize) -> bool {
    session_count >= MAX_AGENT_SESSIONS
}

#[derive(Default)]
pub struct AgentRegistry {
    sessions: Mutex<HashMap<String, Arc<AgentSessionEntry>>>,
    counter: AtomicU64,
    reporter: Option<ReporterEndpoint>,
    /// Session ids start with this; the background daemon uses its own so
    /// the desktop can route by prefix. `None` is the desktop default.
    id_prefix: Option<String>,
}

impl AgentRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_local_reporter(sink: Arc<dyn AgentSink>) -> Result<Arc<Self>, String> {
        let executable = std::env::current_exe()
            .map_err(|error| format!("Cannot locate the LatticeTerm executable: {error}"))?;
        Self::with_local_reporter_executable(sink, executable, None)
    }

    /// A registry whose session ids start with `prefix`, for the background
    /// daemon: same reporter, same everything, distinguishable ids.
    pub fn with_local_reporter_prefixed(
        sink: Arc<dyn AgentSink>,
        prefix: &str,
    ) -> Result<Arc<Self>, String> {
        let executable = std::env::current_exe()
            .map_err(|error| format!("Cannot locate the LatticeTerm executable: {error}"))?;
        Self::with_local_reporter_executable(sink, executable, Some(prefix.to_string()))
    }

    fn with_local_reporter_executable(
        sink: Arc<dyn AgentSink>,
        executable: PathBuf,
        id_prefix: Option<String>,
    ) -> Result<Arc<Self>, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|error| format!("Cannot start the local agent reporter: {error}"))?;
        let address = listener
            .local_addr()
            .map_err(|error| format!("Cannot read the local reporter address: {error}"))?;
        let registry = Arc::new(Self {
            reporter: Some(ReporterEndpoint {
                address,
                executable,
            }),
            id_prefix,
            ..Self::default()
        });
        let thread_registry = Arc::clone(&registry);
        let active_reports = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        std::thread::Builder::new()
            .name("latticeterm-agent-reporter".to_string())
            .spawn(move || {
                for stream in listener.incoming().flatten() {
                    if active_reports
                        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                            (active < 8).then_some(active + 1)
                        })
                        .is_err()
                    {
                        continue;
                    }
                    let permit = ReporterPermit(Arc::clone(&active_reports));
                    let registry = Arc::clone(&thread_registry);
                    let sink = Arc::clone(&sink);
                    let _ = std::thread::Builder::new()
                        .name("latticeterm-report-client".to_string())
                        .spawn(move || {
                            let _permit = permit;
                            handle_report_connection(stream, &registry, sink.as_ref());
                        });
                }
            })
            .map_err(|error| format!("Cannot run the local agent reporter: {error}"))?;
        Ok(registry)
    }

    fn next_id(&self) -> Result<String, String> {
        // A saved group defaults to its original session id and outlives this
        // registry. A counter alone can join a new CLI to that old group after
        // restart. Keep the routing prefix and add entropy for every launch.
        let mut nonce = [0_u8; 16];
        getrandom::fill(&mut nonce)
            .map_err(|error| format!("Cannot create an agent session identifier: {error}"))?;
        let n = self.counter.fetch_add(1, Ordering::Relaxed) + 1;
        let prefix = self.id_prefix.as_deref().unwrap_or("agent-session-");
        let nonce = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(nonce);
        Ok(format!("{prefix}{n}-{nonce}"))
    }

    fn insert(
        &self,
        summary: &AgentSessionSummary,
        entry: Arc<AgentSessionEntry>,
    ) -> Result<(), String> {
        let mut sessions = self.sessions.lock().map_err(|error| error.to_string())?;
        if agent_session_limit_reached(sessions.len()) {
            return Err(format!(
                "At most {MAX_AGENT_SESSIONS} agent sessions may run at once."
            ));
        }
        sessions.insert(summary.session_id.clone(), entry);
        Ok(())
    }

    fn get(&self, session_id: &str) -> Result<Arc<AgentSessionEntry>, String> {
        self.sessions
            .lock()
            .map_err(|error| error.to_string())?
            .get(session_id)
            .cloned()
            .ok_or_else(|| "Agent session no longer exists.".to_string())
    }

    fn remove(&self, session_id: &str) -> Option<Arc<AgentSessionEntry>> {
        let entry = self.sessions.lock().ok()?.remove(session_id)?;
        entry.stopping.store(true, Ordering::Release);
        entry.startup_gate.cancel();
        if let Ok(mut images) = entry.staged_images.lock() {
            images.clear();
        }
        Some(entry)
    }

    fn update_state(
        &self,
        session_id: &str,
        next: AgentLifecycle,
        source: AgentStateSource,
    ) -> bool {
        let Ok(entry) = self.get(session_id) else {
            return false;
        };
        // A PTY reader must keep draining output while a large write waits
        // for the child to consume stdin. Never block it on the input lock.
        let input = match source {
            AgentStateSource::Heuristic => entry.input.try_lock().ok(),
            AgentStateSource::Integration => entry.input.lock().ok(),
        };
        let Some(_input) = input else {
            return false;
        };
        let Ok(mut summary) = entry.summary.lock() else {
            return false;
        };
        if summary.state_source == AgentStateSource::Integration
            && source == AgentStateSource::Heuristic
        {
            return false;
        }
        if summary.state == next && summary.state_source == source {
            return false;
        }
        summary.state = next;
        summary.state_source = source;
        true
    }

    /// Submitted user input starts a new lifecycle turn, even when the previous
    /// turn was completed by an authoritative integration event.
    ///
    /// `submission` separates a real prompt from a bare Enter. Accepting a
    /// folder-trust dialog or clearing an empty prompt is not new work, and a
    /// CLI whose integration reports only turn ends would otherwise stay on
    /// "working" until it is restarted. Answering an open question still
    /// resumes the turn that asked it.
    fn mark_working_from_input(&self, session_id: &str, submission: PromptSubmission) -> bool {
        if submission == PromptSubmission::None {
            return false;
        }
        let Ok(entry) = self.get(session_id) else {
            return false;
        };
        if submission == PromptSubmission::BareEnter {
            let Ok(summary) = entry.summary.lock() else {
                return false;
            };
            if summary.state != AgentLifecycle::NeedsAttention {
                return false;
            }
        }
        if let Some(activity) = &entry.copilot_activity {
            if let Ok(mut activity) = activity.lock() {
                activity.begin_turn();
            }
        }
        if let Some(activity) = &entry.hermes_activity {
            if let Ok(mut activity) = activity.lock() {
                activity.begin_turn();
            }
        }
        let Ok(mut summary) = entry.summary.lock() else {
            return false;
        };
        if summary.state == AgentLifecycle::Working
            && summary.state_source == AgentStateSource::Heuristic
        {
            return false;
        }
        summary.state = AgentLifecycle::Working;
        summary.state_source = AgentStateSource::Heuristic;
        true
    }

    /// Notes a prompt-ready control code and says whether a settle check
    /// should be scheduled for it. One check at a time is enough: a redraw
    /// storm would otherwise spawn a thread per frame.
    fn note_prompt_ready(&self, session_id: &str) -> Option<Instant> {
        let entry = self.get(session_id).ok()?;
        let mut pending = entry.prompt_ready_at.lock().ok()?;
        if pending.is_some() {
            return None;
        }
        let now = Instant::now();
        *pending = Some(now);
        Some(now)
    }

    /// Turns a prompt-ready guess into "done" if, and only if, the terminal
    /// has said nothing since and nothing authoritative moved the state in
    /// the meantime. Output that arrived after the sighting moves the quiet
    /// window forward instead of ending the check: a CLI that was redrawing
    /// still parks at its prompt eventually, and that moment is what counts.
    fn settle_prompt_ready(&self, session_id: &str, marker: Instant) -> PromptReadySettle {
        let Ok(entry) = self.get(session_id) else {
            return PromptReadySettle::Dropped;
        };
        let Ok(mut pending) = entry.prompt_ready_at.lock() else {
            return PromptReadySettle::Dropped;
        };
        if *pending != Some(marker) {
            return PromptReadySettle::Dropped;
        }
        let still_guessing = matches!(
            entry.summary.lock().as_deref(),
            Ok(summary)
                if summary.state == AgentLifecycle::Working
                    && summary.state_source == AgentStateSource::Heuristic
        );
        if !still_guessing {
            *pending = None;
            return PromptReadySettle::Dropped;
        }
        let last_output_at = match entry.last_output_at.lock() {
            Ok(at) => *at,
            Err(_) => {
                *pending = None;
                return PromptReadySettle::Dropped;
            }
        };
        if last_output_at > marker {
            *pending = Some(last_output_at);
            return PromptReadySettle::Retry(last_output_at);
        }
        *pending = None;
        drop(pending);
        if !self.update_state(
            session_id,
            AgentLifecycle::Done,
            AgentStateSource::Heuristic,
        ) {
            return PromptReadySettle::Dropped;
        }
        if let Ok(mut completion) = entry.completion_gate.lock() {
            completion.cancel();
        }
        PromptReadySettle::Done
    }

    /// Releases a heuristic "working" guess for a PTY that has produced no
    /// output for long enough that no CLI could still be running a turn.
    fn settle_silent_working(&self, session_id: &str) -> bool {
        let Ok(entry) = self.get(session_id) else {
            return false;
        };
        let silent_for = match entry.last_output_at.lock() {
            Ok(at) => at.elapsed(),
            Err(_) => return false,
        };
        let Ok(mut summary) = entry.summary.lock() else {
            return false;
        };
        if !should_settle_silent_working(summary.state, summary.state_source, silent_for) {
            return false;
        }
        summary.state = AgentLifecycle::Idle;
        true
    }

    /// Feeds one output chunk into the session's capture window and returns
    /// a newly seen native session id, if any. The window spans chunks, so an
    /// id split across two reads is still found.
    fn scan_for_session_id(&self, session_id: &str, bytes: &[u8]) -> Option<String> {
        let entry = self.get(session_id).ok()?;
        let found = entry.capture.lock().ok()?.feed(bytes)?;

        self.set_captured_session_id(session_id, found)
    }

    fn set_captured_session_id(&self, session_id: &str, found: String) -> Option<String> {
        let entry = self.get(session_id).ok()?;
        let mut summary = entry.summary.lock().ok()?;
        if summary.captured_session_id.as_deref() == Some(found.as_str()) {
            return None;
        }
        summary.captured_session_id = Some(found.clone());
        Some(found)
    }

    fn scan_for_model(&self, session_id: &str, bytes: &[u8]) -> Option<String> {
        let entry = self.get(session_id).ok()?;
        let found = entry.model_capture.lock().ok()?.feed(bytes)?;

        let mut summary = entry.summary.lock().ok()?;
        if summary.model.as_deref() == Some(found.as_str()) {
            return None;
        }
        summary.model = Some(found.clone());
        Some(found)
    }

    fn mark_model_input(&self, session_id: &str, bytes: &[u8]) {
        let Ok(entry) = self.get(session_id) else {
            return;
        };
        if let Ok(mut capture) = entry.model_capture.lock() {
            capture.input(bytes);
        };
    }

    fn record_output(&self, session_id: &str, bytes: &[u8]) -> Result<u64, String> {
        let entry = self.get(session_id)?;
        let offset = entry
            .output
            .lock()
            .map_err(|error| error.to_string())?
            .append(bytes);
        Ok(offset)
    }

    fn update_reported_state(
        &self,
        session_id: &str,
        token: &str,
        next: AgentLifecycle,
        native_session_id: Option<&str>,
    ) -> Result<(bool, Option<String>), String> {
        let entry = self.get(session_id)?;
        if entry.report_token.as_deref() != Some(token) {
            return Err("Reporter authentication failed.".to_string());
        }
        let native_session_id = native_session_id
            .map(|value| validate_text(value, "Native session ID", MAX_RESUME_SESSION_ID_BYTES))
            .transpose()?;
        // A real authenticated report proves the child integration is active.
        // From this point onward prompt-control rendering must not guess that
        // the turn completed, even for integrations whose config can be
        // disabled by a higher-precedence user mode.
        entry.integrated_completion.store(true, Ordering::Release);
        let state_changed = self.update_state(session_id, next, AgentStateSource::Integration);
        let captured = if let Some(native_session_id) = native_session_id {
            let mut summary = entry.summary.lock().map_err(|error| error.to_string())?;
            if summary.captured_session_id.as_deref() == Some(native_session_id.as_str()) {
                None
            } else {
                summary.captured_session_id = Some(native_session_id.clone());
                Some(native_session_id)
            }
        } else {
            None
        };
        Ok((state_changed, captured))
    }

    fn update_reported_usage(
        &self,
        session_id: &str,
        token: &str,
        report: &AgentUsageReport,
    ) -> Result<Option<AgentTokenUsage>, String> {
        let entry = self.get(session_id)?;
        if entry.report_token.as_deref() != Some(token) {
            return Err("Reporter authentication failed.".to_string());
        }
        report.validate()?;
        let is_new = entry
            .reported_usage_requests
            .lock()
            .map_err(|error| error.to_string())?
            .remember(report);
        if !is_new {
            return Ok(None);
        }
        let mut summary = entry.summary.lock().map_err(|error| error.to_string())?;
        let usage = summary
            .token_usage
            .get_or_insert_with(AgentTokenUsage::default);
        usage.add_report(report);
        Ok(Some(usage.clone()))
    }

    fn update_copilot_event(
        &self,
        session_id: &str,
        token: &str,
        event: &CopilotReporterEvent,
    ) -> Result<Option<(bool, AgentLifecycle)>, String> {
        let entry = self.get(session_id)?;
        if entry.report_token.as_deref() != Some(token) {
            return Err("Reporter authentication failed.".to_string());
        }
        let activity = entry
            .copilot_activity
            .as_ref()
            .ok_or_else(|| "Copilot lifecycle tracking is unavailable.".to_string())?;
        let next = activity
            .lock()
            .map_err(|error| error.to_string())?
            .apply(event);
        entry.integrated_completion.store(true, Ordering::Release);
        Ok(next.map(|next| {
            (
                self.update_state(session_id, next, AgentStateSource::Integration),
                next,
            )
        }))
    }

    fn update_hermes_event(
        &self,
        session_id: &str,
        token: &str,
        event: &HermesReporterEvent,
    ) -> Result<Option<(bool, AgentLifecycle)>, String> {
        let entry = self.get(session_id)?;
        if entry.report_token.as_deref() != Some(token) {
            return Err("Reporter authentication failed.".to_string());
        }
        let activity = entry
            .hermes_activity
            .as_ref()
            .ok_or_else(|| "Hermes lifecycle tracking is unavailable.".to_string())?;
        let next = activity
            .lock()
            .map_err(|error| error.to_string())?
            .apply(event);
        entry.integrated_completion.store(true, Ordering::Release);
        Ok(next.map(|next| {
            (
                self.update_state(session_id, next, AgentStateSource::Integration),
                next,
            )
        }))
    }

    #[cfg(test)]
    fn reporter_credentials(&self, session_id: &str) -> Option<(SocketAddr, String)> {
        let endpoint = self.reporter.as_ref()?;
        let entry = self.get(session_id).ok()?;
        Some((endpoint.address, entry.report_token.clone()?))
    }

    pub fn session_summary(&self, session_id: &str) -> Option<AgentSessionSummary> {
        let sessions = self.sessions.lock().ok()?;
        let entry = sessions.get(session_id)?;
        entry.summary.lock().ok().map(|summary| summary.clone())
    }

    pub fn list(&self) -> Vec<AgentSessionSummary> {
        let Ok(sessions) = self.sessions.lock() else {
            return Vec::new();
        };
        let mut summaries: Vec<_> = sessions
            .values()
            .filter_map(|entry| entry.summary.lock().ok().map(|summary| summary.clone()))
            .collect();
        summaries.sort_by(|left, right| left.session_id.cmp(&right.session_id));
        summaries
    }

    /// Renames a CLI group's tab without changing any CLI's own name. The new
    /// label flows into the next hydration snapshot so it survives a reload.
    pub fn rename(&self, session_id: &str, label: &str) -> Result<AgentSessionSummary, String> {
        let label = validate_text(label, "Session name", 80)?;
        let entry = self.get(session_id)?;
        let group_id = entry
            .summary
            .lock()
            .map_err(|error| error.to_string())?
            .group_id
            .clone();
        let sessions = self.sessions.lock().map_err(|error| error.to_string())?;
        for candidate in sessions.values() {
            let mut summary = candidate
                .summary
                .lock()
                .map_err(|error| error.to_string())?;
            if summary.group_id == group_id {
                summary.group_label = label.clone();
            }
        }
        entry
            .summary
            .lock()
            .map_err(|error| error.to_string())
            .map(|summary| summary.clone())
    }

    fn group_label(&self, group_id: &str) -> Option<String> {
        let sessions = self.sessions.lock().ok()?;
        sessions.values().find_map(|entry| {
            let summary = entry.summary.lock().ok()?;
            (summary.group_id == group_id).then(|| summary.group_label.clone())
        })
    }

    pub fn output_snapshots(&self) -> Vec<AgentOutputSnapshot> {
        let Ok(sessions) = self.sessions.lock() else {
            return Vec::new();
        };
        let mut snapshots = sessions
            .iter()
            .filter_map(|(session_id, entry)| {
                entry
                    .output
                    .lock()
                    .ok()
                    .map(|output| output.snapshot(session_id))
            })
            .collect::<Vec<_>>();
        snapshots.sort_by(|left, right| left.session_id.cmp(&right.session_id));
        snapshots
    }

    /// Retained output from `cursor` on, for an observer with its own cursor.
    pub fn output_range(
        &self,
        session_id: &str,
        cursor: u64,
        max: usize,
    ) -> Result<AgentOutputRange, String> {
        let entry = self.get(session_id)?;
        let output = entry.output.lock().map_err(|error| error.to_string())?;
        Ok(output.range(session_id, cursor, max))
    }

    /// Retains an owner-only clipboard image only while its target PTY exists.
    pub fn stage_clipboard_image(
        &self,
        session_id: &str,
        file: tempfile::NamedTempFile,
    ) -> Result<PathBuf, String> {
        let entry = self.get(session_id)?;
        let mut images = entry
            .staged_images
            .lock()
            .map_err(|error| error.to_string())?;
        images.add(file)
    }

    pub fn terminal_history_snapshots(&self) -> Vec<AgentTerminalHistorySnapshot> {
        let Ok(sessions) = self.sessions.lock() else {
            return Vec::new();
        };
        let mut snapshots = sessions
            .values()
            .filter_map(|entry| {
                let summary = entry.summary.lock().ok()?;
                let output = entry.output.lock().ok()?.tail();
                (!output.is_empty()).then(|| AgentTerminalHistorySnapshot {
                    group_id: summary.group_id.clone(),
                    definition_id: summary.definition_id.clone(),
                    output,
                })
            })
            .collect::<Vec<_>>();
        snapshots.sort_by(|left, right| {
            left.group_id
                .cmp(&right.group_id)
                .then_with(|| left.definition_id.cmp(&right.definition_id))
        });
        snapshots
    }

    /// Stop every child before the desktop process exits or restarts.
    pub fn stop_all(&self) {
        let entries: Vec<_> = match self.sessions.lock() {
            Ok(mut sessions) => sessions.drain().map(|(_, entry)| entry).collect(),
            Err(_) => return,
        };
        for entry in entries {
            let _ = terminate_agent_entry(entry.as_ref());
            if let Ok(mut images) = entry.staged_images.lock() {
                images.clear();
            }
        }
    }
}

fn terminate_agent_entry(entry: &AgentSessionEntry) -> Result<(), String> {
    // Cancellation must prevent a delayed submit before waiting on a killer.
    entry.stopping.store(true, Ordering::Release);
    #[cfg(unix)]
    {
        let process_id = entry
            .summary
            .lock()
            .map_err(|error| error.to_string())?
            .process_id;
        if let Some(process_id) = process_id {
            let process_group = i32::try_from(process_id)
                .map_err(|_| "The agent process ID is invalid.".to_string())?;

            // portable-pty creates the child with setsid(), so its PID is also
            // the PTY process-group ID. ChildKiller only sends SIGHUP to the
            // leader on Unix; interactive Node CLIs such as Codex can keep
            // running after that signal. Terminating the group lets the CLI
            // perform its normal child cleanup instead of orphaning it.
            let result = unsafe { libc::kill(-process_group, libc::SIGTERM) };
            if result == 0 {
                return Ok(());
            }

            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                return Ok(());
            }
            return Err(format!("Cannot stop the agent process group: {error}"));
        }
    }

    let result = entry
        .killer
        .lock()
        .map_err(|error| error.to_string())?
        .kill();
    result.map_err(|error| format!("Cannot stop the agent process: {error}"))
}

pub(crate) fn random_report_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("Cannot create an agent reporter token: {error}"))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

fn write_report_response(stream: &mut TcpStream, accepted: bool) {
    let _ = stream.write_all(if accepted { b"ok\n" } else { b"error\n" });
    let _ = stream.flush();
}

struct ReporterPermit(Arc<std::sync::atomic::AtomicUsize>);

impl Drop for ReporterPermit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn read_report_payload(stream: &mut TcpStream, timeout: Duration) -> std::io::Result<Vec<u8>> {
    let deadline = std::time::Instant::now() + timeout;
    let mut payload = Vec::new();
    loop {
        let remaining = deadline
            .checked_duration_since(std::time::Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::TimedOut, "report deadline exceeded")
            })?;
        stream.set_read_timeout(Some(remaining))?;
        let mut buffer = [0; 512];
        let read = std::io::Read::read(stream, &mut buffer)?;
        if read == 0 {
            return Ok(payload);
        }
        if payload.len() + read > MAX_REPORT_BYTES as usize {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "report too large",
            ));
        }
        payload.extend_from_slice(&buffer[..read]);
    }
}

fn handle_report_connection(mut stream: TcpStream, registry: &AgentRegistry, sink: &dyn AgentSink) {
    let _ = stream.set_write_timeout(Some(REPORT_TIMEOUT));
    let payload = match read_report_payload(&mut stream, REPORT_TIMEOUT) {
        Ok(payload) => payload,
        Err(_) => {
            write_report_response(&mut stream, false);
            return;
        }
    };
    let Ok(message) = serde_json::from_slice::<ReporterMessage>(&payload) else {
        write_report_response(&mut stream, false);
        return;
    };
    let update = match (
        message.state,
        message.native_session_id.as_deref(),
        message.copilot_event.as_ref(),
        message.hermes_event.as_ref(),
        message.usage.as_ref(),
    ) {
        (Some(state), native_session_id, None, None, None) => registry
            .update_reported_state(
                &message.session_id,
                &message.token,
                state,
                native_session_id,
            )
            .map(|(changed, captured)| {
                Some(ReporterUpdate::State {
                    changed,
                    state,
                    captured,
                })
            }),
        (None, None, Some(event), None, None) => registry
            .update_copilot_event(&message.session_id, &message.token, event)
            .map(|update| {
                update.map(|(changed, state)| ReporterUpdate::State {
                    changed,
                    state,
                    captured: None,
                })
            }),
        (None, None, None, Some(event), None) => registry
            .update_hermes_event(&message.session_id, &message.token, event)
            .map(|update| {
                update.map(|(changed, state)| ReporterUpdate::State {
                    changed,
                    state,
                    captured: None,
                })
            }),
        (None, None, None, None, Some(usage)) => registry
            .update_reported_usage(&message.session_id, &message.token, usage)
            .map(|usage| usage.map(ReporterUpdate::Usage)),
        _ => Err("Reporter message must contain exactly one update.".to_string()),
    };
    let accepted = match update {
        Ok(Some(ReporterUpdate::State {
            changed,
            state,
            captured,
        })) => {
            if changed {
                sink.state(&message.session_id, state, AgentStateSource::Integration);
                // The only path that releases a queued prompt. Every
                // integration event funnels through here, and nothing
                // heuristic does.
                if releases_queued_prompt(state, AgentStateSource::Integration) {
                    deliver_next_queued(sink, registry, &message.session_id);
                }
            }
            if let Some(native_session_id) = captured {
                sink.captured(&message.session_id, &native_session_id);
            }
            true
        }
        Ok(Some(ReporterUpdate::Usage(usage))) => {
            sink.usage(&message.session_id, &usage);
            true
        }
        Ok(None) => true,
        Err(_) => false,
    };
    write_report_response(&mut stream, accepted);
}

enum ReporterUpdate {
    State {
        changed: bool,
        state: AgentLifecycle,
        captured: Option<String>,
    },
    Usage(AgentTokenUsage),
}

fn send_report_once(
    address: SocketAddr,
    session_id: &str,
    token: &str,
    state: Option<AgentLifecycle>,
    native_session_id: Option<&str>,
    copilot_event: Option<&CopilotReporterEvent>,
    hermes_event: Option<&HermesReporterEvent>,
) -> Result<(), String> {
    if !address.ip().is_loopback() {
        return Err("The agent reporter address must be loopback-only.".to_string());
    }
    let mut stream = TcpStream::connect_timeout(&address, REPORT_TIMEOUT)
        .map_err(|error| format!("Cannot reach the local agent reporter: {error}"))?;
    stream
        .set_read_timeout(Some(REPORT_TIMEOUT))
        .map_err(|error| format!("Cannot configure the agent reporter: {error}"))?;
    stream
        .set_write_timeout(Some(REPORT_TIMEOUT))
        .map_err(|error| format!("Cannot configure the agent reporter: {error}"))?;
    let payload = serde_json::to_vec(&ReporterMessage {
        session_id: session_id.to_string(),
        token: token.to_string(),
        state,
        native_session_id: native_session_id.map(str::to_string),
        copilot_event: copilot_event.cloned(),
        hermes_event: hermes_event.cloned(),
        usage: None,
    })
    .map_err(|error| format!("Cannot encode the agent state: {error}"))?;
    if payload.len() as u64 > MAX_REPORT_BYTES {
        return Err("The agent state report is too large.".to_string());
    }
    stream
        .write_all(&payload)
        .and_then(|_| stream.shutdown(Shutdown::Write))
        .map_err(|error| format!("Cannot send the agent state: {error}"))?;
    let mut response = String::new();
    stream
        .take(16)
        .read_to_string(&mut response)
        .map_err(|error| format!("Cannot read the agent reporter response: {error}"))?;
    if response == "ok\n" {
        Ok(())
    } else {
        Err("The agent reporter rejected the state update.".to_string())
    }
}

fn send_usage_once(
    address: SocketAddr,
    session_id: &str,
    token: &str,
    usage: &AgentUsageReport,
) -> Result<(), String> {
    if !address.ip().is_loopback() {
        return Err("The agent reporter address must be loopback-only.".to_string());
    }
    let mut stream = TcpStream::connect_timeout(&address, REPORT_TIMEOUT)
        .map_err(|error| format!("Cannot reach the local agent reporter: {error}"))?;
    stream
        .set_read_timeout(Some(REPORT_TIMEOUT))
        .map_err(|error| format!("Cannot configure the agent reporter: {error}"))?;
    stream
        .set_write_timeout(Some(REPORT_TIMEOUT))
        .map_err(|error| format!("Cannot configure the agent reporter: {error}"))?;
    let payload = serde_json::to_vec(&ReporterMessage {
        session_id: session_id.to_string(),
        token: token.to_string(),
        state: None,
        native_session_id: None,
        copilot_event: None,
        hermes_event: None,
        usage: Some(usage.clone()),
    })
    .map_err(|error| format!("Cannot encode the agent usage: {error}"))?;
    if payload.len() as u64 > MAX_REPORT_BYTES {
        return Err("The agent usage report is too large.".to_string());
    }
    stream
        .write_all(&payload)
        .and_then(|_| stream.shutdown(Shutdown::Write))
        .map_err(|error| format!("Cannot send the agent usage: {error}"))?;
    let mut response = String::new();
    stream
        .take(16)
        .read_to_string(&mut response)
        .map_err(|error| format!("Cannot read the agent reporter response: {error}"))?;
    if response == "ok\n" {
        Ok(())
    } else {
        Err("The agent reporter rejected the usage update.".to_string())
    }
}

fn send_report_with_native_session(
    address: SocketAddr,
    session_id: &str,
    token: &str,
    state: AgentLifecycle,
    native_session_id: Option<&str>,
) -> Result<(), String> {
    let mut last_error = None;
    for attempt in 0..REPORT_RETRIES {
        match send_report_once(
            address,
            session_id,
            token,
            Some(state),
            native_session_id,
            None,
            None,
        ) {
            Ok(()) => return Ok(()),
            Err(error) => last_error = Some(error),
        }
        if attempt + 1 < REPORT_RETRIES {
            std::thread::sleep(Duration::from_millis(40));
        }
    }
    Err(last_error.unwrap_or_else(|| "The agent state report failed.".to_string()))
}

fn send_copilot_event(
    address: SocketAddr,
    session_id: &str,
    token: &str,
    event: &CopilotReporterEvent,
) -> Result<(), String> {
    let mut last_error = None;
    for attempt in 0..REPORT_RETRIES {
        match send_report_once(address, session_id, token, None, None, Some(event), None) {
            Ok(()) => return Ok(()),
            Err(error) => last_error = Some(error),
        }
        if attempt + 1 < REPORT_RETRIES {
            std::thread::sleep(Duration::from_millis(40));
        }
    }
    Err(last_error.unwrap_or_else(|| "The Copilot lifecycle report failed.".to_string()))
}

fn send_hermes_event(
    address: SocketAddr,
    session_id: &str,
    token: &str,
    event: &HermesReporterEvent,
) -> Result<(), String> {
    let mut last_error = None;
    for attempt in 0..REPORT_RETRIES {
        match send_report_once(address, session_id, token, None, None, None, Some(event)) {
            Ok(()) => return Ok(()),
            Err(error) => last_error = Some(error),
        }
        if attempt + 1 < REPORT_RETRIES {
            std::thread::sleep(Duration::from_millis(40));
        }
    }
    Err(last_error.unwrap_or_else(|| "The Hermes lifecycle report failed.".to_string()))
}

fn send_usage(
    address: SocketAddr,
    session_id: &str,
    token: &str,
    usage: &AgentUsageReport,
) -> Result<(), String> {
    let mut last_error = None;
    for attempt in 0..REPORT_RETRIES {
        match send_usage_once(address, session_id, token, usage) {
            Ok(()) => return Ok(()),
            Err(error) => last_error = Some(error),
        }
        if attempt + 1 < REPORT_RETRIES {
            std::thread::sleep(Duration::from_millis(40));
        }
    }
    Err(last_error.unwrap_or_else(|| "The agent usage report failed.".to_string()))
}

fn lifecycle_from_report_arg(value: &str) -> Option<AgentLifecycle> {
    match value {
        "working" => Some(AgentLifecycle::Working),
        "needs-attention" | "needsAttention" => Some(AgentLifecycle::NeedsAttention),
        "idle" => Some(AgentLifecycle::Idle),
        "done" => Some(AgentLifecycle::Done),
        _ => None,
    }
}

fn codex_notify_command_from_config(raw: &str) -> Option<Vec<String>> {
    let value = toml::from_str::<toml::Table>(raw).ok()?;
    let command = value
        .get("notify")?
        .as_array()?
        .iter()
        .map(|value| value.as_str().map(str::to_string))
        .collect::<Option<Vec<_>>>()?;
    let total_bytes = command.iter().map(String::len).sum::<usize>();
    (!command.is_empty()
        && command.len() <= MAX_NOTIFY_FORWARD_ARGUMENTS
        && total_bytes <= MAX_NOTIFY_FORWARD_BYTES
        && command
            .iter()
            .all(|argument| !argument.chars().any(char::is_control)))
    .then_some(command)
}

fn configured_codex_notify_command() -> Option<Vec<String>> {
    read_account_file(&[".codex", "config.toml"])
        .and_then(|raw| codex_notify_command_from_config(&raw))
}

fn codex_reporter_arguments_with_forward(
    mut arguments: Vec<String>,
    reporter_executable: &Path,
    forward_command: Option<Vec<String>>,
) -> Vec<String> {
    let explicitly_overridden = arguments.windows(2).any(|pair| {
        pair[0] == "-c"
            && pair[1]
                .trim_start()
                .strip_prefix("notify")
                .is_some_and(|value| value.trim_start().starts_with('='))
    });
    if explicitly_overridden {
        return arguments;
    }

    let forwarded = forward_command
        .and_then(|command| serde_json::to_vec(&command).ok())
        .map(|encoded| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(encoded))
        .unwrap_or_default();
    let command = vec![
        reporter_executable.display().to_string(),
        "agent-notify".to_string(),
        forwarded,
    ];
    let Ok(command) = serde_json::to_string(&command) else {
        return arguments;
    };
    arguments.insert(0, format!("notify={command}"));
    arguments.insert(0, "-c".to_string());
    arguments
}

fn codex_reporter_arguments(arguments: Vec<String>, reporter_executable: &Path) -> Vec<String> {
    codex_reporter_arguments_with_forward(
        arguments,
        reporter_executable,
        configured_codex_notify_command(),
    )
}

fn has_explicit_claude_settings(arguments: &[String]) -> bool {
    arguments.iter().any(|argument| {
        argument == "--settings" || argument.trim_start().starts_with("--settings=")
    })
}

fn claude_customizations_disabled(arguments: &[String]) -> bool {
    arguments
        .iter()
        .any(|argument| matches!(argument.trim(), "--safe-mode" | "--bare"))
}

fn claude_reporter_arguments(
    mut arguments: Vec<String>,
    reporter_executable: &Path,
) -> Vec<String> {
    // Safe/bare mode deliberately runs without user customizations, including
    // hooks. Do not add LatticeTerm's observer hook back into that recovery
    // path. A second --settings value also has version-dependent precedence,
    // so preserve an explicit caller override instead of replacing its hooks.
    if claude_customizations_disabled(&arguments) || has_explicit_claude_settings(&arguments) {
        return arguments;
    }

    let handler = serde_json::json!({
        "type": "command",
        "command": reporter_executable.display().to_string(),
        "args": ["agent-claude-hook"],
        "timeout": 5
    });
    let hook = |matcher: Option<&str>| {
        let mut value = serde_json::json!({ "hooks": [handler.clone()] });
        if let Some(matcher) = matcher {
            value["matcher"] = serde_json::Value::String(matcher.to_string());
        }
        value
    };
    let settings = serde_json::json!({
        "hooks": {
            "UserPromptSubmit": [hook(None)],
            "PermissionRequest": [hook(None)],
            "PermissionDenied": [hook(None)],
            "PostToolUse": [hook(None)],
            "PostToolUseFailure": [hook(None)],
            "PostToolBatch": [hook(None)],
            "PreCompact": [hook(None)],
            "PostCompact": [hook(None)],
            "Elicitation": [hook(None)],
            "SessionStart": [hook(None)],
            "Stop": [hook(None)],
            "StopFailure": [hook(None)],
            "Notification": [hook(None)]
        }
    });
    let Ok(settings) = serde_json::to_string(&settings) else {
        return arguments;
    };
    arguments.insert(0, settings);
    arguments.insert(0, "--settings".to_string());
    arguments
}

#[cfg(windows)]
const GEMINI_REPORTER_COMMAND: &str = r#"& "$env:LATTICETERM_AGENT_REPORTER" agent-gemini-hook"#;
#[cfg(not(windows))]
const GEMINI_REPORTER_COMMAND: &str = r#""$LATTICETERM_AGENT_REPORTER" agent-gemini-hook"#;

fn gemini_reporter_settings_value() -> serde_json::Value {
    let handler = serde_json::json!({
        "name": "latticeterm-agent-status",
        "type": "command",
        "command": GEMINI_REPORTER_COMMAND,
        "timeout": 5000
    });
    let hook = |matcher: Option<&str>| {
        let mut value = serde_json::json!({ "hooks": [handler.clone()] });
        if let Some(matcher) = matcher {
            value["matcher"] = serde_json::Value::String(matcher.to_string());
        }
        value
    };
    serde_json::json!({
        "hooks": {
            "BeforeAgent": [hook(None)],
            "AfterAgent": [hook(None)],
            "Notification": [hook(Some("ToolPermission"))]
        }
    })
}

fn default_gemini_system_settings_paths() -> Option<(PathBuf, PathBuf)> {
    #[cfg(target_os = "windows")]
    let directory = std::env::var_os("ProgramData")
        .map(PathBuf::from)
        .map(|path| path.join("gemini-cli"));
    #[cfg(target_os = "macos")]
    let directory = Some(PathBuf::from("/Library/Application Support/GeminiCli"));
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let directory = Some(PathBuf::from("/etc/gemini-cli"));

    directory.map(|directory| {
        (
            directory.join("settings.json"),
            directory.join("system-defaults.json"),
        )
    })
}

fn gemini_reporter_settings_file() -> Result<Option<tempfile::NamedTempFile>, String> {
    // Never replace an administrator-selected settings layer. Pointing Gemini
    // at our temporary file would otherwise bypass system policy for this PTY.
    if std::env::var_os("GEMINI_CLI_SYSTEM_SETTINGS_PATH").is_some() {
        return Ok(None);
    }
    if let Some((system, defaults)) = default_gemini_system_settings_paths() {
        if system.exists()
            || (std::env::var_os("GEMINI_CLI_SYSTEM_DEFAULTS_PATH").is_none() && defaults.exists())
        {
            return Ok(None);
        }
    }

    let mut file = tempfile::Builder::new()
        .prefix("latticeterm-gemini-hooks-")
        .suffix(".json")
        .tempfile()
        .map_err(|error| format!("Cannot create Gemini hook settings: {error}"))?;
    serde_json::to_writer(&mut file, &gemini_reporter_settings_value())
        .map_err(|error| format!("Cannot write Gemini hook settings: {error}"))?;
    file.flush()
        .map_err(|error| format!("Cannot finish Gemini hook settings: {error}"))?;
    Ok(Some(file))
}

fn antigravity_capture_log(
    arguments: &mut Vec<String>,
) -> Result<Option<AntigravityCaptureLog>, String> {
    if arguments.iter().any(|argument| {
        argument == "--log-file" || argument.trim_start().starts_with("--log-file=")
    }) {
        return Ok(None);
    }
    let directory = tempfile::Builder::new()
        .prefix("latticeterm-antigravity-")
        .tempdir()
        .map_err(|error| format!("Cannot create the Antigravity capture directory: {error}"))?;
    let path = directory.path().join("agy.log");
    arguments.insert(0, path.display().to_string());
    arguments.insert(0, "--log-file".to_string());
    Ok(Some(AntigravityCaptureLog {
        _directory: directory,
        path,
    }))
}

#[cfg(windows)]
const QWEN_REPORTER_COMMAND: &str = r#"& "$env:LATTICETERM_AGENT_REPORTER" agent-qwen-hook"#;
#[cfg(not(windows))]
const QWEN_REPORTER_COMMAND: &str = r#""$LATTICETERM_AGENT_REPORTER" agent-qwen-hook"#;

fn qwen_reporter_settings_value() -> serde_json::Value {
    let handler = serde_json::json!({
        "name": "latticeterm-agent-status",
        "type": "command",
        "command": QWEN_REPORTER_COMMAND,
        "timeout": 5000
    });
    let hook = |matcher: Option<&str>| {
        let mut value = serde_json::json!({ "hooks": [handler.clone()] });
        if let Some(matcher) = matcher {
            value["matcher"] = serde_json::Value::String(matcher.to_string());
        }
        value
    };
    serde_json::json!({
        "hooks": {
            "UserPromptSubmit": [hook(None)],
            "PermissionRequest": [hook(None)],
            "PermissionDenied": [hook(None)],
            "PostToolUse": [hook(None)],
            "PostToolUseFailure": [hook(None)],
            "Stop": [hook(None)],
            "StopFailure": [hook(None)],
            "Notification": [hook(Some("permission_prompt"))]
        }
    })
}

fn qwen_reporter_allowed(arguments: &[String]) -> bool {
    !arguments.iter().any(|argument| {
        argument == "--bare"
            || argument == "--bare=true"
            || argument == "--bare=1"
            || argument == "--safe-mode"
            || argument == "--safe-mode=true"
            || argument == "--safe-mode=1"
    })
}

fn default_qwen_system_settings_paths() -> Option<(PathBuf, PathBuf)> {
    #[cfg(target_os = "windows")]
    let directory = std::env::var_os("ProgramData")
        .map(PathBuf::from)
        .map(|path| path.join("qwen-code"));
    #[cfg(target_os = "macos")]
    let directory = Some(PathBuf::from("/Library/Application Support/QwenCode"));
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let directory = Some(PathBuf::from("/etc/qwen-code"));

    directory.map(|directory| {
        (
            directory.join("settings.json"),
            directory.join("system-defaults.json"),
        )
    })
}

fn qwen_reporter_settings_file(
    arguments: &[String],
) -> Result<Option<tempfile::NamedTempFile>, String> {
    // Bare and safe mode intentionally disable hooks. Existing administrator
    // paths also win so a per-session status integration never bypasses policy.
    if !qwen_reporter_allowed(arguments)
        || std::env::var_os("QWEN_CODE_SYSTEM_SETTINGS_PATH").is_some()
    {
        return Ok(None);
    }
    if let Some((system, defaults)) = default_qwen_system_settings_paths() {
        if system.exists()
            || (std::env::var_os("QWEN_CODE_SYSTEM_DEFAULTS_PATH").is_none() && defaults.exists())
        {
            return Ok(None);
        }
    }

    let mut file = tempfile::Builder::new()
        .prefix("latticeterm-qwen-hooks-")
        .suffix(".json")
        .tempfile()
        .map_err(|error| format!("Cannot create Qwen hook settings: {error}"))?;
    serde_json::to_writer(&mut file, &qwen_reporter_settings_value())
        .map_err(|error| format!("Cannot write Qwen hook settings: {error}"))?;
    file.flush()
        .map_err(|error| format!("Cannot finish Qwen hook settings: {error}"))?;
    Ok(Some(file))
}

const HERMES_REPORTER_PLUGIN: &str = include_str!("agent_hermes_plugin.py");
const HERMES_REPORTER_MANIFEST: &str = include_str!("agent_hermes_plugin.yaml");
const HERMES_REPORTER_PLUGIN_NAME: &str = "latticeterm-session-status-bridge";

fn is_hermes_bundled_plugins_directory(path: &Path) -> bool {
    path.is_dir() && path.join("model-providers").is_dir()
}

fn hermes_bundled_plugins_directory(executable: &Path) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("HERMES_BUNDLED_PLUGINS") {
        candidates.push(PathBuf::from(path));
    }

    if let Some(home) = std::env::var_os("HERMES_HOME").map(PathBuf::from) {
        candidates.push(home.join("hermes-agent").join("plugins"));
        if home.parent().and_then(Path::file_name) == Some(OsStr::new("profiles")) {
            if let Some(root) = home.parent().and_then(Path::parent) {
                candidates.push(root.join("hermes-agent").join("plugins"));
            }
        }
    }

    if let Some(home) = user_home_directory() {
        candidates.push(home.join(".hermes").join("hermes-agent").join("plugins"));
    }
    #[cfg(windows)]
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local_app_data)
                .join("hermes")
                .join("hermes-agent")
                .join("plugins"),
        );
    }

    for ancestor in executable.ancestors().skip(1) {
        candidates.push(ancestor.join("plugins"));
        candidates.push(ancestor.join("hermes-agent").join("plugins"));
    }

    candidates
        .into_iter()
        .find(|path| is_hermes_bundled_plugins_directory(path))
}

#[cfg(unix)]
fn mirror_hermes_bundled_plugins(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::unix::fs::symlink;

    for entry in std::fs::read_dir(source)
        .map_err(|error| format!("Cannot read Hermes bundled plugins: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Cannot inspect Hermes plugin: {error}"))?;
        let target = std::fs::canonicalize(entry.path())
            .map_err(|error| format!("Cannot resolve Hermes plugin: {error}"))?;
        symlink(target, destination.join(entry.file_name()))
            .map_err(|error| format!("Cannot mirror Hermes plugin: {error}"))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn mirror_hermes_bundled_plugins(source: &Path, destination: &Path) -> Result<(), String> {
    fn copy_tree(source: &Path, destination: &Path) -> Result<(), String> {
        std::fs::create_dir(destination)
            .map_err(|error| format!("Cannot create Hermes plugin directory: {error}"))?;
        for entry in std::fs::read_dir(source)
            .map_err(|error| format!("Cannot read Hermes plugin directory: {error}"))?
        {
            let entry = entry.map_err(|error| format!("Cannot inspect Hermes plugin: {error}"))?;
            let source = entry.path();
            let destination = destination.join(entry.file_name());
            let file_type = entry
                .file_type()
                .map_err(|error| format!("Cannot inspect Hermes plugin type: {error}"))?;
            if file_type.is_dir() {
                copy_tree(&source, &destination)?;
            } else if file_type.is_file() {
                std::fs::copy(&source, &destination)
                    .map_err(|error| format!("Cannot copy Hermes plugin: {error}"))?;
            } else {
                return Err("Hermes bundled plugins contain an unsupported link.".to_string());
            }
        }
        Ok(())
    }

    for entry in std::fs::read_dir(source)
        .map_err(|error| format!("Cannot read Hermes bundled plugins: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Cannot inspect Hermes plugin: {error}"))?;
        let source = entry.path();
        let destination = destination.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Cannot inspect Hermes plugin type: {error}"))?;
        if file_type.is_dir() {
            copy_tree(&source, &destination)?;
        } else if file_type.is_file() {
            std::fs::copy(&source, &destination)
                .map_err(|error| format!("Cannot copy Hermes plugin: {error}"))?;
        } else {
            return Err("Hermes bundled plugins contain an unsupported link.".to_string());
        }
    }
    Ok(())
}

fn write_hermes_reporter_plugin_from_bundle(
    bundled_plugins: &Path,
) -> Result<HermesReporterPlugin, String> {
    let directory = tempfile::Builder::new()
        .prefix("latticeterm-hermes-status-")
        .tempdir()
        .map_err(|error| format!("Cannot create Hermes status plugin overlay: {error}"))?;
    mirror_hermes_bundled_plugins(bundled_plugins, directory.path())?;

    let plugin = directory.path().join(HERMES_REPORTER_PLUGIN_NAME);
    std::fs::create_dir(&plugin)
        .map_err(|error| format!("Cannot create Hermes status plugin: {error}"))?;
    std::fs::write(plugin.join("plugin.yaml"), HERMES_REPORTER_MANIFEST)
        .map_err(|error| format!("Cannot write Hermes status manifest: {error}"))?;
    std::fs::write(plugin.join("__init__.py"), HERMES_REPORTER_PLUGIN)
        .map_err(|error| format!("Cannot write Hermes status observer: {error}"))?;
    Ok(HermesReporterPlugin { directory })
}

fn hermes_reporter_plugin(
    executable: &Path,
    arguments: &[String],
) -> Result<Option<HermesReporterPlugin>, String> {
    if environment_flag_is_true("HERMES_SAFE_MODE")
        || arguments.iter().any(|argument| {
            argument == "--safe-mode"
                || argument == "--safe-mode=1"
                || argument.eq_ignore_ascii_case("--safe-mode=true")
        })
    {
        return Ok(None);
    }
    let Some(bundled_plugins) = hermes_bundled_plugins_directory(executable) else {
        return Ok(None);
    };
    if bundled_plugins.join(HERMES_REPORTER_PLUGIN_NAME).exists() {
        // A future Hermes release or administrator may already own this
        // namespace. Never replace it merely to add status observability.
        return Ok(None);
    }
    write_hermes_reporter_plugin_from_bundle(&bundled_plugins).map(Some)
}

fn copilot_reporter_command(event: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "command",
        "bash": format!(
            "\"$LATTICETERM_AGENT_REPORTER\" agent-copilot-hook {event}"
        ),
        "powershell": format!(
            "& \"$env:LATTICETERM_AGENT_REPORTER\" agent-copilot-hook {event}"
        ),
        "timeoutSec": 5
    })
}

fn copilot_reporter_hooks_value() -> serde_json::Value {
    let hook = |event: &str, matcher: Option<&str>| {
        let mut value = copilot_reporter_command(event);
        if let Some(matcher) = matcher {
            value["matcher"] = serde_json::Value::String(matcher.to_string());
        }
        serde_json::Value::Array(vec![value])
    };
    serde_json::json!({
        "version": 1,
        "hooks": {
            "sessionStart": hook("sessionStart", None),
            "userPromptSubmitted": hook("userPromptSubmitted", None),
            "postToolUse": hook("postToolUse", None),
            "postToolUseFailure": hook("postToolUseFailure", None),
            "agentStop": hook("agentStop", None),
            "permissionRequest": hook("permissionRequest", None),
            "notification": hook(
                "notification",
                Some("permission_prompt|elicitation_dialog|agent_completed|agent_idle")
            ),
            "errorOccurred": hook("errorOccurred", None),
            "subagentStart": hook("subagentStart", None),
            "subagentStop": hook("subagentStop", None)
        }
    })
}

fn write_copilot_reporter_plugin() -> Result<CopilotReporterPlugin, String> {
    let directory = tempfile::Builder::new()
        .prefix("latticeterm-copilot-status-")
        .tempdir()
        .map_err(|error| format!("Cannot create Copilot status plugin: {error}"))?;
    let manifest = serde_json::json!({
        "name": "latticeterm-agent-status",
        "version": "1.0.0",
        "hooks": "hooks.json"
    });
    let manifest = serde_json::to_vec(&manifest)
        .map_err(|error| format!("Cannot encode Copilot status plugin: {error}"))?;
    let hooks = serde_json::to_vec(&copilot_reporter_hooks_value())
        .map_err(|error| format!("Cannot encode Copilot status hooks: {error}"))?;
    std::fs::write(directory.path().join("plugin.json"), manifest)
        .map_err(|error| format!("Cannot write Copilot status plugin: {error}"))?;
    std::fs::write(directory.path().join("hooks.json"), hooks)
        .map_err(|error| format!("Cannot write Copilot status hooks: {error}"))?;
    Ok(CopilotReporterPlugin { directory })
}

fn copilot_reporter_arguments(
    mut arguments: Vec<String>,
    plugin: &CopilotReporterPlugin,
) -> Vec<String> {
    arguments.insert(0, plugin.path().display().to_string());
    arguments.insert(0, "--plugin-dir".to_string());
    arguments
}

const OPENCODE_REPORTER_PLUGIN: &str = include_str!("agent_opencode_plugin.js");

fn opencode_reporter_allowed(
    arguments: &[String],
    config_content_is_set: bool,
    pure_environment: Option<&OsStr>,
) -> bool {
    if config_content_is_set {
        return false;
    }
    let pure_environment = pure_environment
        .and_then(OsStr::to_str)
        .is_some_and(|value| value == "1" || value.eq_ignore_ascii_case("true"));
    if pure_environment {
        return false;
    }
    !arguments.iter().any(|argument| {
        argument == "--pure"
            || argument == "--pure=1"
            || argument.eq_ignore_ascii_case("--pure=true")
    })
}

fn write_opencode_reporter_plugin() -> Result<OpenCodeReporterPlugin, String> {
    let mut file = tempfile::Builder::new()
        .prefix("latticeterm-opencode-status-")
        .suffix(".js")
        .tempfile()
        .map_err(|error| format!("Cannot create OpenCode status plugin: {error}"))?;
    file.write_all(OPENCODE_REPORTER_PLUGIN.as_bytes())
        .map_err(|error| format!("Cannot write OpenCode status plugin: {error}"))?;
    file.flush()
        .map_err(|error| format!("Cannot finish OpenCode status plugin: {error}"))?;
    let path = file
        .path()
        .to_str()
        .ok_or_else(|| "OpenCode status plugin path is not valid UTF-8.".to_string())?;
    let config_content = serde_json::json!({ "plugin": [path] }).to_string();
    Ok(OpenCodeReporterPlugin {
        _file: file,
        config_content,
    })
}

fn opencode_reporter_plugin(
    arguments: &[String],
) -> Result<Option<OpenCodeReporterPlugin>, String> {
    if !opencode_reporter_allowed(
        arguments,
        std::env::var_os("OPENCODE_CONFIG_CONTENT").is_some(),
        std::env::var_os("OPENCODE_PURE").as_deref(),
    ) {
        return Ok(None);
    }
    write_opencode_reporter_plugin().map(Some)
}

#[derive(Debug, Deserialize)]
struct ClaudeHookPayload {
    hook_event_name: String,
    /// Claude sends this common hook field for both a new and resumed
    /// conversation. It is opaque application data, never terminal output.
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    notification_type: Option<String>,
    #[serde(default)]
    background_tasks: Vec<serde_json::Value>,
    #[serde(default)]
    session_crons: Vec<serde_json::Value>,
}

fn lifecycle_from_claude_hook(payload: &ClaudeHookPayload) -> Option<AgentLifecycle> {
    match payload.hook_event_name.as_str() {
        // SessionStart runs for both a fresh CLI and a resumed conversation.
        // It captures the native id early while accurately representing the
        // prompt as ready for input.
        "SessionStart" => Some(AgentLifecycle::Idle),
        "UserPromptSubmit" => Some(AgentLifecycle::Working),
        "PermissionDenied" | "PostToolUse" | "PostToolUseFailure" | "PostToolBatch"
        | "PreCompact" | "PostCompact" => Some(AgentLifecycle::Working),
        "PermissionRequest" | "Elicitation" | "StopFailure" => Some(AgentLifecycle::NeedsAttention),
        "Stop" if !payload.background_tasks.is_empty() => Some(AgentLifecycle::Working),
        "Stop" if !payload.session_crons.is_empty() => Some(AgentLifecycle::Idle),
        "Stop" => Some(AgentLifecycle::Done),
        "Notification" => match payload.notification_type.as_deref() {
            Some(
                "permission_prompt"
                | "elicitation_dialog"
                | "elicitation_url_dialog"
                | "agent_needs_input"
                | "quota_auto_resume_stale"
                | "quota_auto_resume_disabled",
            ) => Some(AgentLifecycle::NeedsAttention),
            Some("quota_auto_resume_fired" | "elicitation_response") => {
                Some(AgentLifecycle::Working)
            }
            _ => None,
        },
        _ => None,
    }
}

#[cfg(test)]
fn lifecycle_from_claude_hook_payload(raw: &[u8]) -> Result<Option<AgentLifecycle>, String> {
    let payload: ClaudeHookPayload =
        serde_json::from_slice(raw).map_err(|_| "Claude hook payload is invalid.".to_string())?;
    Ok(lifecycle_from_claude_hook(&payload))
}

fn report_from_claude_hook_payload(
    raw: &[u8],
) -> Result<Option<(AgentLifecycle, Option<String>)>, String> {
    let payload: ClaudeHookPayload =
        serde_json::from_slice(raw).map_err(|_| "Claude hook payload is invalid.".to_string())?;
    let Some(state) = lifecycle_from_claude_hook(&payload) else {
        return Ok(None);
    };
    let native_session_id = payload
        .session_id
        .as_deref()
        .map(|value| validate_text(value, "Claude session ID", MAX_RESUME_SESSION_ID_BYTES))
        .transpose()?;
    Ok(Some((state, native_session_id)))
}

fn report_claude_hook_from_stdin() -> Result<(), String> {
    let mut payload = Vec::new();
    std::io::stdin()
        .take(MAX_LIFECYCLE_HOOK_BYTES + 1)
        .read_to_end(&mut payload)
        .map_err(|error| format!("Cannot read the Claude hook payload: {error}"))?;
    if payload.len() as u64 > MAX_LIFECYCLE_HOOK_BYTES {
        return Err("Claude hook payload is too large.".to_string());
    }
    if let Some((state, native_session_id)) = report_from_claude_hook_payload(&payload)? {
        report_from_environment_with_native_session(state, native_session_id.as_deref())?;
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct GeminiHookPayload {
    hook_event_name: String,
    session_id: String,
    #[serde(default)]
    notification_type: Option<String>,
}

fn report_from_gemini_hook_payload(raw: &[u8]) -> Result<Option<(AgentLifecycle, String)>, String> {
    let payload: GeminiHookPayload =
        serde_json::from_slice(raw).map_err(|_| "Gemini hook payload is invalid.".to_string())?;
    let state = match payload.hook_event_name.as_str() {
        "BeforeAgent" => Some(AgentLifecycle::Working),
        "AfterAgent" => Some(AgentLifecycle::Done),
        "Notification" if payload.notification_type.as_deref() == Some("ToolPermission") => {
            Some(AgentLifecycle::NeedsAttention)
        }
        _ => None,
    };
    let Some(state) = state else {
        return Ok(None);
    };
    let native_session_id = validate_text(
        &payload.session_id,
        "Gemini session ID",
        MAX_RESUME_SESSION_ID_BYTES,
    )?;
    Ok(Some((state, native_session_id)))
}

fn report_gemini_hook_from_stdin() -> Result<(), String> {
    let mut payload = Vec::new();
    std::io::stdin()
        .take(MAX_LIFECYCLE_HOOK_BYTES + 1)
        .read_to_end(&mut payload)
        .map_err(|error| format!("Cannot read the Gemini hook payload: {error}"))?;
    if payload.len() as u64 > MAX_LIFECYCLE_HOOK_BYTES {
        return Err("Gemini hook payload is too large.".to_string());
    }
    if let Some((state, native_session_id)) = report_from_gemini_hook_payload(&payload)? {
        report_from_environment_with_native_session(state, Some(&native_session_id))?;
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct QwenHookPayload {
    hook_event_name: String,
    #[serde(default)]
    notification_type: Option<String>,
    #[serde(default)]
    background_tasks: Vec<serde_json::Value>,
    #[serde(default)]
    crons: Vec<serde_json::Value>,
}

fn lifecycle_from_qwen_hook_payload(raw: &[u8]) -> Result<Option<AgentLifecycle>, String> {
    let payload: QwenHookPayload =
        serde_json::from_slice(raw).map_err(|_| "Qwen hook payload is invalid.".to_string())?;
    Ok(match payload.hook_event_name.as_str() {
        "UserPromptSubmit" | "PermissionDenied" | "PostToolUse" | "PostToolUseFailure" => {
            Some(AgentLifecycle::Working)
        }
        "Stop" if !payload.background_tasks.is_empty() => Some(AgentLifecycle::Working),
        "Stop" if !payload.crons.is_empty() => Some(AgentLifecycle::Idle),
        "Stop" => Some(AgentLifecycle::Done),
        "StopFailure" | "PermissionRequest" => Some(AgentLifecycle::NeedsAttention),
        "Notification" if payload.notification_type.as_deref() == Some("permission_prompt") => {
            Some(AgentLifecycle::NeedsAttention)
        }
        _ => None,
    })
}

fn report_qwen_hook_from_stdin() -> Result<(), String> {
    let mut payload = Vec::new();
    std::io::stdin()
        .take(MAX_LIFECYCLE_HOOK_BYTES + 1)
        .read_to_end(&mut payload)
        .map_err(|error| format!("Cannot read the Qwen hook payload: {error}"))?;
    if payload.len() as u64 > MAX_LIFECYCLE_HOOK_BYTES {
        return Err("Qwen hook payload is too large.".to_string());
    }
    if let Some(state) = lifecycle_from_qwen_hook_payload(&payload)? {
        report_from_environment(state)?;
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct HermesHookPayload {
    hook_event_name: String,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    parent_session_id: Option<String>,
    #[serde(default)]
    child_session_id: Option<String>,
    #[serde(default)]
    api_request_id: Option<String>,
    #[serde(default)]
    usage: Option<HermesHookUsage>,
    #[serde(default)]
    completed: bool,
    #[serde(default)]
    failed: bool,
    #[serde(default)]
    interrupted: bool,
}

#[derive(Debug, Deserialize)]
struct HermesHookUsage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_read_tokens: u64,
    #[serde(default)]
    cache_write_tokens: u64,
    #[serde(default)]
    reasoning_tokens: u64,
}

fn valid_hermes_session_id(value: Option<String>, label: &str) -> Result<String, String> {
    let value = value.ok_or_else(|| format!("Hermes {label} session id is missing."))?;
    if value.is_empty()
        || value.len() > MAX_RESUME_SESSION_ID_BYTES
        || value.chars().any(char::is_control)
    {
        return Err(format!("Hermes {label} session id is invalid."));
    }
    Ok(value)
}

fn hermes_event_from_hook_payload(raw: &[u8]) -> Result<HermesReporterEvent, String> {
    let payload: HermesHookPayload =
        serde_json::from_slice(raw).map_err(|_| "Hermes hook payload is invalid.".to_string())?;
    let (source_session_id, action) = match payload.hook_event_name.as_str() {
        "on_session_start" => (
            valid_hermes_session_id(payload.session_id, "source")?,
            HermesReporterAction::SessionStarted,
        ),
        "pre_llm_call" => (
            valid_hermes_session_id(payload.session_id, "source")?,
            HermesReporterAction::TurnStarted,
        ),
        "on_session_end" => (
            valid_hermes_session_id(payload.session_id, "source")?,
            HermesReporterAction::TurnEnded {
                completed: payload.completed,
                failed: payload.failed,
                interrupted: payload.interrupted,
            },
        ),
        "subagent_start" => (
            valid_hermes_session_id(payload.parent_session_id, "parent")?,
            HermesReporterAction::SubagentStarted {
                child_session_id: valid_hermes_session_id(payload.child_session_id, "child")?,
            },
        ),
        "subagent_stop" => (
            valid_hermes_session_id(payload.parent_session_id, "parent")?,
            HermesReporterAction::SubagentStopped {
                child_session_id: valid_hermes_session_id(payload.child_session_id, "child")?,
            },
        ),
        "pre_approval_request" => (
            payload.session_id.unwrap_or_default(),
            HermesReporterAction::NeedsAttention,
        ),
        "post_approval_response" => (
            payload.session_id.unwrap_or_default(),
            HermesReporterAction::ApprovalResolved,
        ),
        _ => return Err("Hermes hook event is unknown.".to_string()),
    };
    Ok(HermesReporterEvent {
        source_session_id,
        action,
    })
}

fn hermes_usage_from_hook_payload(raw: &[u8]) -> Result<AgentUsageReport, String> {
    let payload: HermesHookPayload =
        serde_json::from_slice(raw).map_err(|_| "Hermes hook payload is invalid.".to_string())?;
    if payload.hook_event_name != "post_api_request" {
        return Err("Hermes hook event is not a usage report.".to_string());
    }
    let usage = payload
        .usage
        .ok_or_else(|| "Hermes token usage is missing.".to_string())?;
    let report = AgentUsageReport {
        source_session_id: valid_hermes_session_id(payload.session_id, "source")?,
        request_id: valid_hermes_session_id(payload.api_request_id, "request")?,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_tokens: usage.cache_read_tokens,
        cache_write_tokens: usage.cache_write_tokens,
        reasoning_tokens: usage.reasoning_tokens,
    };
    report.validate()?;
    Ok(report)
}

fn report_hermes_hook_from_stdin() -> Result<(), String> {
    let mut payload = Vec::new();
    std::io::stdin()
        .take(MAX_LIFECYCLE_HOOK_BYTES + 1)
        .read_to_end(&mut payload)
        .map_err(|error| format!("Cannot read the Hermes hook payload: {error}"))?;
    if payload.len() as u64 > MAX_LIFECYCLE_HOOK_BYTES {
        return Err("Hermes hook payload is too large.".to_string());
    }
    let hook_event_name = serde_json::from_slice::<serde_json::Value>(&payload)
        .ok()
        .and_then(|value| value.get("hook_event_name")?.as_str().map(str::to_string))
        .ok_or_else(|| "Hermes hook payload is invalid.".to_string())?;
    if hook_event_name == "post_api_request" {
        report_usage_from_environment(&hermes_usage_from_hook_payload(&payload)?)
    } else {
        report_hermes_event_from_environment(&hermes_event_from_hook_payload(&payload)?)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CopilotHookPayload {
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    agent_name: Option<String>,
    #[serde(default, alias = "notification_type")]
    notification_type: Option<String>,
    #[serde(default)]
    recoverable: Option<bool>,
    #[serde(default)]
    tool_name: Option<String>,
    #[serde(default)]
    tool_args: Option<serde_json::Value>,
}

fn valid_copilot_session_id(value: Option<String>) -> Result<String, String> {
    let value = value.ok_or_else(|| "Copilot hook session id is missing.".to_string())?;
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err("Copilot hook session id is invalid.".to_string());
    }
    Ok(value)
}

fn valid_copilot_agent_name(value: Option<String>) -> Result<String, String> {
    let value = value.ok_or_else(|| "Copilot subagent name is missing.".to_string())?;
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err("Copilot subagent name is invalid.".to_string());
    }
    Ok(value)
}

fn copilot_event_from_hook_payload(
    event: &str,
    raw: &[u8],
) -> Result<Option<CopilotReporterEvent>, String> {
    let payload: CopilotHookPayload =
        serde_json::from_slice(raw).map_err(|_| "Copilot hook payload is invalid.".to_string())?;
    let action = match event {
        "sessionStart" => Some(CopilotReporterAction::SessionStarted),
        "userPromptSubmitted" => Some(CopilotReporterAction::TurnStarted),
        "postToolUse"
            if payload.tool_name.as_deref() == Some("task")
                && payload
                    .tool_args
                    .as_ref()
                    .and_then(|args| args.get("mode"))
                    .and_then(serde_json::Value::as_str)
                    == Some("background") =>
        {
            Some(CopilotReporterAction::BackgroundSubagentQueued)
        }
        "postToolUse" | "postToolUseFailure" => Some(CopilotReporterAction::Working),
        "agentStop" => Some(CopilotReporterAction::Stop),
        "permissionRequest" => Some(CopilotReporterAction::NeedsAttention),
        "notification" => match payload.notification_type.as_deref() {
            Some("permission_prompt" | "elicitation_dialog") => {
                Some(CopilotReporterAction::NeedsAttention)
            }
            Some("agent_completed") => Some(CopilotReporterAction::BackgroundCompleted),
            Some("agent_idle") => Some(CopilotReporterAction::BackgroundIdle),
            _ => None,
        },
        "errorOccurred" if payload.recoverable == Some(true) => {
            Some(CopilotReporterAction::RecoverableError)
        }
        "errorOccurred" => Some(CopilotReporterAction::FatalError),
        "subagentStart" => Some(CopilotReporterAction::SubagentStart {
            agent_name: valid_copilot_agent_name(payload.agent_name)?,
        }),
        "subagentStop" => Some(CopilotReporterAction::SubagentStop {
            agent_name: valid_copilot_agent_name(payload.agent_name)?,
        }),
        _ => return Err("Copilot hook event is unknown.".to_string()),
    };
    let Some(action) = action else {
        return Ok(None);
    };
    Ok(Some(CopilotReporterEvent {
        source_session_id: valid_copilot_session_id(payload.session_id)?,
        action,
    }))
}

fn report_copilot_hook_from_stdin(event: &str) -> Result<(), String> {
    let mut payload = Vec::new();
    std::io::stdin()
        .take(MAX_LIFECYCLE_HOOK_BYTES + 1)
        .read_to_end(&mut payload)
        .map_err(|error| format!("Cannot read the Copilot hook payload: {error}"))?;
    if payload.len() as u64 > MAX_LIFECYCLE_HOOK_BYTES {
        return Err("Copilot hook payload is too large.".to_string());
    }
    if let Some(event) = copilot_event_from_hook_payload(event, &payload)? {
        report_copilot_event_from_environment(&event)?;
    }
    Ok(())
}

fn report_from_environment(state: AgentLifecycle) -> Result<(), String> {
    report_from_environment_with_native_session(state, None)
}

fn report_from_environment_with_native_session(
    state: AgentLifecycle,
    native_session_id: Option<&str>,
) -> Result<(), String> {
    let address: SocketAddr = std::env::var("LATTICETERM_AGENT_REPORT_ADDR")
        .map_err(|_| "Agent reporter environment is unavailable.".to_string())?
        .parse()
        .map_err(|_| "Agent reporter address is invalid.".to_string())?;
    let session_id = std::env::var("LATTICETERM_AGENT_SESSION")
        .map_err(|_| "Agent reporter session is unavailable.".to_string())?;
    let token = std::env::var("LATTICETERM_AGENT_REPORT_TOKEN")
        .map_err(|_| "Agent reporter token is unavailable.".to_string())?;
    send_report_with_native_session(address, &session_id, &token, state, native_session_id)
}

fn report_copilot_event_from_environment(event: &CopilotReporterEvent) -> Result<(), String> {
    let address: SocketAddr = std::env::var("LATTICETERM_AGENT_REPORT_ADDR")
        .map_err(|_| "Agent reporter environment is unavailable.".to_string())?
        .parse()
        .map_err(|_| "Agent reporter address is invalid.".to_string())?;
    let session_id = std::env::var("LATTICETERM_AGENT_SESSION")
        .map_err(|_| "Agent reporter session is unavailable.".to_string())?;
    let token = std::env::var("LATTICETERM_AGENT_REPORT_TOKEN")
        .map_err(|_| "Agent reporter token is unavailable.".to_string())?;
    send_copilot_event(address, &session_id, &token, event)
}

fn report_hermes_event_from_environment(event: &HermesReporterEvent) -> Result<(), String> {
    let address: SocketAddr = std::env::var("LATTICETERM_AGENT_REPORT_ADDR")
        .map_err(|_| "Agent reporter environment is unavailable.".to_string())?
        .parse()
        .map_err(|_| "Agent reporter address is invalid.".to_string())?;
    let session_id = std::env::var("LATTICETERM_AGENT_SESSION")
        .map_err(|_| "Agent reporter session is unavailable.".to_string())?;
    let token = std::env::var("LATTICETERM_AGENT_REPORT_TOKEN")
        .map_err(|_| "Agent reporter token is unavailable.".to_string())?;
    send_hermes_event(address, &session_id, &token, event)
}

fn report_usage_from_environment(usage: &AgentUsageReport) -> Result<(), String> {
    let address: SocketAddr = std::env::var("LATTICETERM_AGENT_REPORT_ADDR")
        .map_err(|_| "Agent reporter environment is unavailable.".to_string())?
        .parse()
        .map_err(|_| "Agent reporter address is invalid.".to_string())?;
    let session_id = std::env::var("LATTICETERM_AGENT_SESSION")
        .map_err(|_| "Agent reporter session is unavailable.".to_string())?;
    let token = std::env::var("LATTICETERM_AGENT_REPORT_TOKEN")
        .map_err(|_| "Agent reporter token is unavailable.".to_string())?;
    send_usage(address, &session_id, &token, usage)
}

fn decode_forward_notify(value: &str) -> Option<Vec<String>> {
    if value.is_empty() || value.len() > MAX_NOTIFY_FORWARD_BYTES * 2 {
        return None;
    }
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(value)
        .ok()?;
    let command: Vec<String> = serde_json::from_slice(&decoded).ok()?;
    let total_bytes = command.iter().map(String::len).sum::<usize>();
    (!command.is_empty()
        && command.len() <= MAX_NOTIFY_FORWARD_ARGUMENTS
        && total_bytes <= MAX_NOTIFY_FORWARD_BYTES
        && command
            .iter()
            .all(|argument| !argument.chars().any(char::is_control)))
    .then_some(command)
}

fn forward_codex_notification(encoded: &str, payload: &OsStr) {
    let Some(command) = decode_forward_notify(encoded) else {
        return;
    };
    let mut child = std::process::Command::new(&command[0]);
    child.args(&command[1..]).arg(payload);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        child.creation_flags(0x08000000);
    }
    let _ = child.spawn();
}

#[derive(Debug, Deserialize)]
struct CodexNotificationKind {
    #[serde(rename = "type")]
    kind: String,
}

fn is_codex_turn_complete_notification(payload: &OsStr) -> bool {
    payload
        .to_str()
        .and_then(|raw| serde_json::from_str::<CodexNotificationKind>(raw).ok())
        .is_some_and(|notification| notification.kind == "agent-turn-complete")
}

/// Handle the tiny reporter subcommand before Tauri starts.
///
/// Adapter hooks can run `$LATTICETERM_AGENT_REPORTER agent-report done` and
/// credentials are taken only from the environment of that PTY child.
pub fn run_reporter_cli<I, S>(args: I) -> Option<i32>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut args = args.into_iter();
    let command = args.next()?;
    let result = if command.as_ref() == OsStr::new("agent-report") {
        let Some(state) = args
            .next()
            .and_then(|value| value.as_ref().to_str().and_then(lifecycle_from_report_arg))
        else {
            eprintln!("usage: latticeterm agent-report <working|needs-attention|idle|done>");
            return Some(2);
        };
        if args.next().is_some() {
            eprintln!("agent-report accepts exactly one state");
            return Some(2);
        }
        report_from_environment(state)
    } else if command.as_ref() == OsStr::new("agent-notify") {
        let encoded = args
            .next()
            .and_then(|value| value.as_ref().to_str().map(str::to_string));
        let payload = args.next();
        if args.next().is_some() {
            eprintln!("agent-notify accepts one forwarded command and one payload");
            return Some(2);
        }
        let Some(encoded) = encoded else {
            eprintln!("agent-notify is missing its forwarded command");
            return Some(2);
        };
        let Some(payload) = payload.as_ref() else {
            eprintln!("agent-notify is missing its notification payload");
            return Some(2);
        };
        forward_codex_notification(&encoded, payload.as_ref());
        if is_codex_turn_complete_notification(payload.as_ref()) {
            report_from_environment(AgentLifecycle::Done)
        } else {
            Ok(())
        }
    } else if command.as_ref() == OsStr::new("agent-claude-hook") {
        if args.next().is_some() {
            eprintln!("agent-claude-hook accepts no arguments");
            return Some(2);
        }
        report_claude_hook_from_stdin()
    } else if command.as_ref() == OsStr::new("agent-gemini-hook") {
        if args.next().is_some() {
            eprintln!("agent-gemini-hook accepts no arguments");
            return Some(2);
        }
        let result = report_gemini_hook_from_stdin();
        if result.is_ok() {
            // Gemini parses successful hook stdout as JSON. Suppress its
            // internal status hook from adding noise to the terminal UI.
            println!(r#"{{"suppressOutput":true}}"#);
        }
        result
    } else if command.as_ref() == OsStr::new("agent-copilot-hook") {
        let event = args
            .next()
            .and_then(|value| value.as_ref().to_str().map(str::to_string));
        if args.next().is_some() {
            eprintln!("agent-copilot-hook accepts exactly one event");
            return Some(2);
        }
        let Some(event) = event else {
            eprintln!("agent-copilot-hook is missing its event");
            return Some(2);
        };
        report_copilot_hook_from_stdin(&event)
    } else if command.as_ref() == OsStr::new("agent-hermes-hook") {
        if args.next().is_some() {
            eprintln!("agent-hermes-hook accepts no arguments");
            return Some(2);
        }
        report_hermes_hook_from_stdin()
    } else if command.as_ref() == OsStr::new("agent-qwen-hook") {
        if args.next().is_some() {
            eprintln!("agent-qwen-hook accepts no arguments");
            return Some(2);
        }
        report_qwen_hook_from_stdin()
    } else {
        return None;
    };
    match result {
        Ok(()) => Some(0),
        Err(error) => {
            eprintln!("agent state report failed: {error}");
            Some(1)
        }
    }
}

pub fn catalog() -> Vec<AgentDefinition> {
    AGENTS
        .iter()
        .map(|agent| {
            let path = find_agent_executable(agent);
            AgentDefinition {
                id: agent.id.to_string(),
                label: agent.label.to_string(),
                executable: agent.executable.to_string(),
                adapter_version: AGENT_ADAPTER_VERSION,
                resume_supported: agent.resume_recipe.is_some(),
                resume_latest_supported: agent.resume_latest_recipe.is_some(),
                transcript_supported: crate::transcript::TranscriptKind::from_definition(agent.id)
                    .is_some(),
                installed: path.is_some(),
                installed_path: path.map(|path| path.display().to_string()),
                consumer_oauth_deprecated: agent.id == "gemini"
                    && gemini_consumer_oauth_deprecated(),
                account: detect_agent_account(agent.id),
                install: install_definition(agent.id),
            }
        })
        .collect()
}

fn account_info(
    state: AgentAccountState,
    label: Option<String>,
    method: Option<&str>,
) -> AgentAccountInfo {
    AgentAccountInfo {
        state,
        label,
        method: method.map(str::to_string),
    }
}

fn safe_account_label(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && value.len() <= 320 && !value.chars().any(char::is_control))
        .then(|| value.to_string())
}

/// The sandbox tool this machine offers, if any. Only bubblewrap is
/// supported: it is unprivileged, ubiquitous on Linux, and its bind-mount
/// model maps directly onto "this directory may change, nothing else may".
///
/// Finding the binary is not enough: a kernel or AppArmor policy that
/// forbids unprivileged user namespaces makes every launch fail with
/// "setting up uid map: Permission denied". The tool is probed once with a
/// trivial command, and the interface offers the option only when that
/// probe succeeded, rather than letting a launch fail later.
pub fn sandbox_tool() -> Option<PathBuf> {
    static PROBED: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
    PROBED
        .get_or_init(|| {
            if !cfg!(target_os = "linux") {
                return None;
            }
            let bwrap = find_executable("bwrap")?;
            let works = std::process::Command::new(&bwrap)
                .args([
                    "--ro-bind",
                    "/",
                    "/",
                    "--dev",
                    "/dev",
                    "--proc",
                    "/proc",
                    "--unshare-pid",
                    "--die-with-parent",
                    "--",
                    "/bin/true",
                ])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|status| status.success())
                .unwrap_or(false);
            works.then_some(bwrap)
        })
        .clone()
}

/// Directories a CLI must still be able to write while sandboxed, relative
/// to the home directory: its own login and state. Anything not listed
/// stays read-only, so a runaway command cannot touch the rest of the home.
fn sandbox_home_writable_paths(definition_id: &str) -> Vec<&'static str> {
    let mut paths: Vec<&'static str> = vec![".cache", ".npm", ".local/state"];
    paths.extend(match definition_id {
        "claude" => vec![".claude", ".claude.json"],
        "codex" => vec![".codex"],
        "gemini" | "antigravity" => vec![".gemini", ".antigravity"],
        "qwen" => vec![".qwen"],
        "opencode" => vec![".config/opencode", ".local/share/opencode"],
        "copilot" => vec![".copilot"],
        "hermes" => vec![".hermes"],
        "cursor" => vec![
            ".cursor",
            ".config/cursor-agent",
            ".local/share/cursor-agent",
        ],
        "aider" => vec![".aider", ".aider.conf.yml"],
        "kimi" => vec![".kimi"],
        "droid" => vec![".factory"],
        "grok" => vec![".grok"],
        _ => vec![],
    });
    paths
}

/// Files under the home directory that decide what a CLI *does* — its
/// hooks, MCP servers, execution policy — bound read-only on top of the
/// writable state root, so a runaway sandboxed run cannot plant something
/// that executes at the next unsandboxed launch.
fn sandbox_home_readonly_paths(definition_id: &str) -> Vec<&'static str> {
    match definition_id {
        "claude" => vec![".claude/settings.json", ".claude/settings.local.json"],
        "codex" => vec![".codex/config.toml", ".codex/rules"],
        "gemini" | "antigravity" => vec![".gemini/settings.json"],
        "qwen" => vec![".qwen/settings.json"],
        "cursor" => vec![".cursor/hooks.json", ".cursor/mcp.json"],
        _ => vec![],
    }
}

/// Bubblewrap can only re-bind a path that already exists, and the rest of
/// the home directory is read-only inside the sandbox. A CLI that has never
/// run would therefore fail to create its state directory or, for Claude
/// Code, its `.claude.json` on first login. Create the empty state first so
/// the first sandboxed launch behaves like an unsandboxed one. Nothing is
/// written when the path is already there, and nothing but empty
/// directories and an empty JSON object is ever created.
pub fn prepare_sandbox_state(definition_id: &str, home: &Path) -> std::io::Result<()> {
    for relative in sandbox_home_writable_paths(definition_id) {
        let path = home.join(relative);
        if path.exists() {
            continue;
        }
        if relative == ".claude.json" {
            write_private_file(&path, b"{}\n")?;
        } else if relative.ends_with(".yml") {
            // Aider runs without its config file; do not invent one.
            continue;
        } else {
            std::fs::create_dir_all(&path)?;
        }
    }
    for relative in sandbox_home_readonly_paths(definition_id) {
        prepare_sandbox_policy_path(&home.join(relative))?;
    }
    Ok(())
}

/// A missing policy must also be mounted read-only; otherwise a sandboxed
/// process can create it for the next unsandboxed launch. Empty JSON/TOML
/// and rules directories preserve the CLI's default configuration.
fn prepare_sandbox_policy_path(path: &Path) -> std::io::Result<()> {
    use std::io::{Error, ErrorKind};
    let parent = path
        .parent()
        .ok_or_else(|| Error::new(ErrorKind::InvalidInput, "missing policy parent"))?;
    let parent_metadata = std::fs::symlink_metadata(parent)?;
    if !parent_metadata.is_dir() || parent_metadata.file_type().is_symlink() {
        return Err(Error::new(
            ErrorKind::PermissionDenied,
            "sandbox policy root must be a real directory",
        ));
    }
    let directory = path.file_name() == Some(OsStr::new("rules"));
    if directory {
        if let Err(error) = std::fs::create_dir(path) {
            if error.kind() != ErrorKind::AlreadyExists {
                return Err(error);
            }
        }
    } else {
        write_private_file(
            path,
            if path.extension() == Some(OsStr::new("json")) {
                b"{}\n"
            } else {
                b""
            },
        )?;
    }
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink()
        || (if directory {
            !metadata.is_dir()
        } else {
            !metadata.is_file()
        })
    {
        return Err(Error::new(
            ErrorKind::PermissionDenied,
            "sandbox policy must not be a link or special file",
        ));
    }
    Ok(())
}

fn sandbox_profile_readonly_paths(definition_id: &str, root: &Path) -> Vec<PathBuf> {
    sandbox_home_readonly_paths(definition_id)
        .into_iter()
        .filter_map(|relative| {
            // These paths all have one CLI directory followed by the policy name.
            Path::new(relative)
                .components()
                .nth(1)
                .map(|name| root.join(name))
        })
        .collect()
}

fn prepare_sandbox_profile(definition_id: &str, root: &Path) -> std::io::Result<()> {
    for path in sandbox_profile_readonly_paths(definition_id, root) {
        prepare_sandbox_policy_path(&path)?;
    }
    Ok(())
}

fn write_private_file(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(path) {
        Ok(mut file) => file.write_all(contents),
        // Created by someone else between the check and now: keep theirs.
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error),
    }
}

/// The bubblewrap argument vector that confines one CLI launch.
///
/// The whole filesystem is bound read-only, then the working directory, the
/// CLI's own state under the home directory, an account profile directory
/// when one is in use, and /tmp are re-bound writable. Network stays shared:
/// the CLI has to reach its model. PIDs are unshared so the CLI cannot see
/// or signal the desktop, and the sandbox dies with LatticeTerm.
pub fn sandbox_arguments(
    working_directory: &Path,
    definition_id: &str,
    home: Option<&Path>,
    extra_writable: &[&Path],
    exists: &dyn Fn(&Path) -> bool,
) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec![
        "--ro-bind".into(),
        "/".into(),
        "/".into(),
        "--dev".into(),
        "/dev".into(),
        "--proc".into(),
        "/proc".into(),
        "--bind".into(),
        "/tmp".into(),
        "/tmp".into(),
    ];
    let mut bind = |path: &Path| {
        if exists(path) {
            args.push("--bind".into());
            args.push(path.as_os_str().to_os_string());
            args.push(path.as_os_str().to_os_string());
        }
    };
    bind(working_directory);
    if let Some(home) = home {
        for relative in sandbox_home_writable_paths(definition_id) {
            bind(&home.join(relative));
        }
    }
    for path in extra_writable {
        bind(path);
    }
    if let Some(home) = home {
        // Later binds win: the policy files stay read-only inside the
        // writable state root.
        for relative in sandbox_home_readonly_paths(definition_id) {
            let path = home.join(relative);
            args.push("--ro-bind".into());
            args.push(path.as_os_str().to_os_string());
            args.push(path.as_os_str().to_os_string());
        }
    }
    for root in extra_writable {
        for path in sandbox_profile_readonly_paths(definition_id, root) {
            // Preparation must have created every policy path. Do not skip a
            // missing path here: let bwrap fail closed if it disappeared.
            args.push("--ro-bind".into());
            args.push(path.as_os_str().to_os_string());
            args.push(path.as_os_str().to_os_string());
        }
    }
    args.extend(["--unshare-pid", "--die-with-parent", "--chdir"].map(OsString::from));
    args.push(working_directory.as_os_str().to_os_string());
    args.push("--".into());
    args
}

fn user_home_directory() -> Option<PathBuf> {
    #[cfg(windows)]
    let variable = "USERPROFILE";
    #[cfg(not(windows))]
    let variable = "HOME";
    std::env::var_os(variable)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn read_account_file(relative: &[&str]) -> Option<String> {
    let mut path = user_home_directory()?;
    for component in relative {
        path.push(component);
    }
    std::fs::read_to_string(path).ok()
}

fn gemini_auth_type_from_json(raw: &str) -> Option<String> {
    let document = serde_json::from_str::<serde_json::Value>(raw).ok()?;
    document
        .pointer("/security/auth/selectedType")
        .or_else(|| document.get("selectedAuthType"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 80)
        .map(str::to_string)
}

fn environment_value_is_present(name: &str) -> bool {
    std::env::var_os(name).is_some_and(|value| !value.is_empty())
}

fn environment_flag_is_true(name: &str) -> bool {
    std::env::var_os(name).is_some_and(|value| {
        matches!(
            value.to_string_lossy().trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

fn gemini_consumer_oauth_deprecated() -> bool {
    if [
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GOOGLE_CLOUD_PROJECT",
        "GOOGLE_CLOUD_PROJECT_ID",
    ]
    .iter()
    .any(|name| environment_value_is_present(name))
        || environment_flag_is_true("GOOGLE_GENAI_USE_VERTEXAI")
    {
        return false;
    }
    read_account_file(&[".gemini", "settings.json"])
        .and_then(|raw| gemini_auth_type_from_json(&raw))
        .is_some_and(|auth_type| auth_type.eq_ignore_ascii_case("oauth-personal"))
}

fn codex_account_from_json(raw: &str) -> AgentAccountInfo {
    let Ok(document) = serde_json::from_str::<serde_json::Value>(raw) else {
        return account_info(AgentAccountState::Unknown, None, None);
    };
    let mode = document
        .get("auth_mode")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let method = if mode.eq_ignore_ascii_case("chatgpt") {
        "ChatGPT"
    } else if mode.to_ascii_lowercase().contains("api") {
        "OpenAI API Key"
    } else {
        "OpenAI Codex"
    };
    let email = document
        .pointer("/tokens/id_token")
        .and_then(serde_json::Value::as_str)
        .and_then(|token| token.split('.').nth(1))
        .and_then(|payload| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(payload)
                .ok()
        })
        .and_then(|payload| serde_json::from_slice::<serde_json::Value>(&payload).ok())
        .and_then(|claims| {
            claims
                .get("email")
                .and_then(serde_json::Value::as_str)
                .and_then(safe_account_label)
        });
    if email.is_some() || !mode.is_empty() {
        account_info(AgentAccountState::SignedIn, email, Some(method))
    } else {
        account_info(AgentAccountState::Unknown, None, None)
    }
}

fn claude_account_from_json(raw: &str) -> AgentAccountInfo {
    let Ok(document) = serde_json::from_str::<serde_json::Value>(raw) else {
        return account_info(AgentAccountState::Unknown, None, None);
    };
    let email = document
        .pointer("/oauthAccount/emailAddress")
        .and_then(serde_json::Value::as_str)
        .and_then(safe_account_label);
    if email.is_some() {
        account_info(AgentAccountState::SignedIn, email, Some("Claude.ai"))
    } else {
        account_info(AgentAccountState::Unknown, None, None)
    }
}

fn gemini_account_from_json(raw: &str) -> AgentAccountInfo {
    let Ok(document) = serde_json::from_str::<serde_json::Value>(raw) else {
        return account_info(AgentAccountState::Unknown, None, None);
    };
    let email = document
        .get("active")
        .and_then(serde_json::Value::as_str)
        .and_then(safe_account_label);
    if email.is_some() {
        account_info(AgentAccountState::SignedIn, email, Some("Google"))
    } else {
        account_info(AgentAccountState::Unknown, None, None)
    }
}

fn detect_agent_account(definition_id: &str) -> AgentAccountInfo {
    match definition_id {
        "codex" => read_account_file(&[".codex", "auth.json"])
            .map(|raw| codex_account_from_json(&raw))
            .unwrap_or_else(|| account_info(AgentAccountState::Unknown, None, None)),
        "claude" => read_account_file(&[".claude.json"])
            .map(|raw| claude_account_from_json(&raw))
            .unwrap_or_else(|| account_info(AgentAccountState::Unknown, None, None)),
        "gemini" => read_account_file(&[".gemini", "google_accounts.json"])
            .map(|raw| gemini_account_from_json(&raw))
            .unwrap_or_else(|| account_info(AgentAccountState::Unknown, None, None)),
        _ => account_info(AgentAccountState::Unsupported, None, None),
    }
}

/// Where the catalog found a CLI, by definition id.
///
/// Shared with chat mode so a CLI the fleet can see is a CLI a conversation
/// can start: both use the same PATH, npm-global and well-known lookups.
pub(crate) fn catalog_executable(definition_id: &str) -> Option<PathBuf> {
    AGENTS
        .iter()
        .find(|agent| agent.id == definition_id)
        .and_then(find_agent_executable)
}

fn find_agent_executable(agent: &AgentSpec) -> Option<PathBuf> {
    find_executable(agent.executable)
        .or_else(|| find_npm_global_agent_executable(agent.executable))
        .or_else(|| find_well_known_agent_executable(agent))
        .or_else(|| {
            (agent.id == "cursor")
                .then(|| find_executable("cursor-agent"))
                .flatten()
        })
}

#[cfg(windows)]
fn well_known_agent_path(agent_id: &str, local_app_data: &Path) -> Option<PathBuf> {
    match agent_id {
        // The official Windows installer adds this new directory to the user
        // PATH. The running desktop process keeps its old environment block,
        // so catalog refresh also checks the documented install location.
        "antigravity" => Some(local_app_data.join("agy").join("bin").join("agy.exe")),
        _ => None,
    }
}

#[cfg(windows)]
fn find_well_known_agent_executable(agent: &AgentSpec) -> Option<PathBuf> {
    let local_app_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)?;
    let candidate = well_known_agent_path(agent.id, &local_app_data)?;
    is_executable(&candidate)
        .then(|| plain_win32_path(candidate.canonicalize().unwrap_or(candidate)))
}

#[cfg(not(windows))]
fn find_well_known_agent_executable(_agent: &AgentSpec) -> Option<PathBuf> {
    None
}

/// npm installs global command shims in `%APPDATA%\npm` on Windows. Explorer
/// does not refresh an already-running process's environment when that folder
/// is added to PATH, so the desktop app must also inspect the stable shim
/// directory directly.
#[cfg(windows)]
fn find_npm_global_agent_executable(command: &str) -> Option<PathBuf> {
    let app_data = std::env::var_os("APPDATA").map(PathBuf::from)?;
    find_npm_global_agent_executable_in(command, &app_data)
}

#[cfg(windows)]
fn find_npm_global_agent_executable_in(command: &str, app_data: &Path) -> Option<PathBuf> {
    if command.trim().is_empty() || Path::new(command).extension().is_some() {
        return None;
    }
    ["cmd", "bat"].into_iter().find_map(|extension| {
        let candidate = app_data.join("npm").join(command).with_extension(extension);
        is_executable(&candidate)
            .then(|| plain_win32_path(candidate.canonicalize().unwrap_or(candidate)))
    })
}

#[cfg(not(windows))]
fn find_npm_global_agent_executable(_command: &str) -> Option<PathBuf> {
    None
}

fn direct_install(
    executable: &str,
    arguments: &[&str],
    display_command: &str,
    source_url: &str,
) -> AgentInstallDefinition {
    AgentInstallDefinition {
        executable: Some(executable.to_string()),
        arguments: arguments.iter().map(|value| value.to_string()).collect(),
        display_command: display_command.to_string(),
        source_url: source_url.to_string(),
        available: find_executable(executable).is_some(),
    }
}

fn manual_install(display_command: &str, source_url: &str) -> AgentInstallDefinition {
    AgentInstallDefinition {
        executable: None,
        arguments: Vec::new(),
        display_command: display_command.to_string(),
        source_url: source_url.to_string(),
        available: false,
    }
}

fn npm_install(package: &str, source_url: &str) -> AgentInstallDefinition {
    direct_install(
        "npm",
        &["install", "-g", package],
        &format!("npm install -g {package}"),
        source_url,
    )
}

#[cfg(windows)]
fn official_script_install(
    script_url: &str,
    display_command: &str,
    source_url: &str,
) -> AgentInstallDefinition {
    let command = format!("Invoke-RestMethod '{script_url}' | Invoke-Expression");
    direct_install(
        "powershell.exe",
        &[
            "-NoLogo",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &command,
        ],
        display_command,
        source_url,
    )
}

#[cfg(not(windows))]
fn official_script_install(
    _script_url: &str,
    display_command: &str,
    source_url: &str,
) -> AgentInstallDefinition {
    direct_install("sh", &["-c", display_command], display_command, source_url)
}

fn install_definition(definition_id: &str) -> AgentInstallDefinition {
    match definition_id {
        "codex" => npm_install(
            "@openai/codex",
            "https://developers.openai.com/codex/cli/",
        ),
        "claude" => npm_install(
            "@anthropic-ai/claude-code",
            "https://docs.anthropic.com/en/docs/claude-code/getting-started",
        ),
        "gemini" => npm_install(
            "@google/gemini-cli",
            "https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/installation.md",
        ),
        "antigravity" => official_script_install(
            if cfg!(windows) {
                "https://antigravity.google/cli/install.ps1"
            } else {
                "https://antigravity.google/cli/install.sh"
            },
            if cfg!(windows) {
                "irm https://antigravity.google/cli/install.ps1 | iex"
            } else {
                "curl -fsSL https://antigravity.google/cli/install.sh | bash"
            },
            "https://codelabs.developers.google.com/antigravity-cli-hands-on",
        ),
        "opencode" => npm_install("opencode-ai", "https://opencode.ai/docs/"),
        "copilot" => npm_install("@github/copilot", "https://github.com/features/copilot/cli/"),
        "hermes" => official_script_install(
            if cfg!(windows) {
                "https://hermes-agent.nousresearch.com/install.ps1"
            } else {
                "https://hermes-agent.nousresearch.com/install.sh"
            },
            if cfg!(windows) {
                "irm https://hermes-agent.nousresearch.com/install.ps1 | iex"
            } else {
                "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash"
            },
            "https://github.com/NousResearch/hermes-agent#quick-install",
        ),
        "cursor" => official_script_install(
            if cfg!(windows) {
                "https://cursor.com/install?win32=true"
            } else {
                "https://cursor.com/install"
            },
            if cfg!(windows) {
                "irm 'https://cursor.com/install?win32=true' | iex"
            } else {
                "curl https://cursor.com/install -fsS | bash"
            },
            "https://cursor.com/docs/cli/installation",
        ),
        "aider" => official_script_install(
            if cfg!(windows) {
                "https://aider.chat/install.ps1"
            } else {
                "https://aider.chat/install.sh"
            },
            if cfg!(windows) {
                "powershell -ExecutionPolicy ByPass -c \"irm https://aider.chat/install.ps1 | iex\""
            } else {
                "curl -LsSf https://aider.chat/install.sh | sh"
            },
            "https://aider.chat/docs/install.html",
        ),
        "qwen" => npm_install(
            "@qwen-code/qwen-code@latest",
            "https://github.com/QwenLM/qwen-code/blob/main/scripts/installation/INSTALLATION_GUIDE.md",
        ),
        "kimi" => official_script_install(
            if cfg!(windows) {
                "https://code.kimi.com/kimi-code/install.ps1"
            } else {
                "https://code.kimi.com/kimi-code/install.sh"
            },
            if cfg!(windows) {
                "irm https://code.kimi.com/kimi-code/install.ps1 | iex"
            } else {
                "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash"
            },
            "https://github.com/MoonshotAI/kimi-code#install",
        ),
        "droid" => npm_install("droid", "https://github.com/Factory-AI/factory#installation"),
        "grok" => {
            #[cfg(windows)]
            {
                manual_install(
                    "curl -fsSL https://raw.githubusercontent.com/superagent-ai/grok-cli/main/install.sh | bash",
                    "https://github.com/superagent-ai/grok-cli#install",
                )
            }
            #[cfg(not(windows))]
            {
                official_script_install(
                    "https://raw.githubusercontent.com/superagent-ai/grok-cli/main/install.sh",
                    "curl -fsSL https://raw.githubusercontent.com/superagent-ai/grok-cli/main/install.sh | bash",
                    "https://github.com/superagent-ai/grok-cli#install",
                )
            }
        }
        _ => manual_install("", ""),
    }
}

pub fn default_working_directory() -> Result<String, String> {
    std::env::current_dir()
        .map(|path| path.display().to_string())
        .map_err(|error| format!("Cannot read the current working directory: {error}"))
}

fn has_path_separator(value: &OsStr) -> bool {
    Path::new(value).components().count() > 1
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(windows)]
fn is_executable(path: &Path) -> bool {
    path.is_file()
        && path
            .extension()
            .and_then(OsStr::to_str)
            .is_some_and(|extension| {
                // .cmd/.bat cover npm/pnpm/yarn global shims — how Claude Code,
                // Gemini CLI and most Node-based agents land on Windows PATH.
                extension.eq_ignore_ascii_case("exe")
                    || extension.eq_ignore_ascii_case("com")
                    || extension.eq_ignore_ascii_case("cmd")
                    || extension.eq_ignore_ascii_case("bat")
            })
}

#[cfg(not(any(unix, windows)))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

fn executable_extensions(command: &OsStr) -> Vec<OsString> {
    #[cfg(windows)]
    {
        if Path::new(command).extension().is_some() {
            return vec![OsString::new()];
        }
        let mut values = vec![OsString::new()];
        let path_ext =
            std::env::var_os("PATHEXT").unwrap_or_else(|| OsString::from(".COM;.EXE;.BAT;.CMD"));
        values.extend(
            path_ext
                .to_string_lossy()
                .split(';')
                .filter(|value| {
                    value.eq_ignore_ascii_case(".COM")
                        || value.eq_ignore_ascii_case(".EXE")
                        || value.eq_ignore_ascii_case(".CMD")
                        || value.eq_ignore_ascii_case(".BAT")
                })
                .map(OsString::from),
        );
        values
    }
    #[cfg(not(windows))]
    {
        let _ = command;
        vec![OsString::new()]
    }
}

fn find_executable(command: &str) -> Option<PathBuf> {
    let command = OsStr::new(command.trim());
    if command.is_empty() {
        return None;
    }
    let extensions = executable_extensions(command);
    let directories: Vec<PathBuf> = if has_path_separator(command) {
        vec![PathBuf::new()]
    } else {
        std::env::var_os("PATH")
            .map(|value| std::env::split_paths(&value).collect())
            .unwrap_or_default()
    };

    for directory in directories {
        for extension in &extensions {
            let mut candidate = directory.join(command);
            if !extension.is_empty() {
                candidate.set_extension(extension.to_string_lossy().trim_start_matches('.'));
            }
            if is_executable(&candidate) {
                return Some(plain_win32_path(
                    candidate.canonicalize().unwrap_or(candidate),
                ));
            }
        }
    }
    None
}

/// Resolves how to actually launch a detected executable.
///
/// Converts the verbatim path returned by `canonicalize` into a Win32 path.
/// Some executables accept `\\?\` while others do not; notably Windows
/// PowerShell 5.1 fails during .NET initialization when launched that way.
#[cfg(windows)]
fn plain_windows_path(path: &Path) -> OsString {
    let raw = path.as_os_str().to_string_lossy();
    const VERBATIM_UNC: &str = r"\\?\UNC\";
    if raw
        .get(..VERBATIM_UNC.len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(VERBATIM_UNC))
    {
        return OsString::from(format!(r"\\{}", &raw[VERBATIM_UNC.len()..]));
    }
    raw.strip_prefix(r"\\?\")
        .map(OsString::from)
        .unwrap_or_else(|| path.as_os_str().to_os_string())
}

/// `canonicalize` returns verbatim (`\\?\`) paths on Windows, and the prefix
/// leaks into everything downstream: the child CLI records its cwd exactly as
/// given, and detected executable paths show up on the Agent Fleet cards.
/// Every canonicalized path is stripped back to plain Win32 form.
#[cfg(windows)]
pub(crate) fn plain_win32_path(path: PathBuf) -> PathBuf {
    PathBuf::from(plain_windows_path(&path))
}

#[cfg(not(windows))]
pub(crate) fn plain_win32_path(path: PathBuf) -> PathBuf {
    path
}

/// Windows cannot `CreateProcess` a `.cmd`/`.bat` shim directly, so those are
/// routed through the command processor (`cmd.exe /d /c <script>`). `/d`
/// prevents unrelated interactive Command Processor AutoRun hooks from
/// breaking a non-interactive CLI launch before the shim itself starts. All
/// launch paths are first converted out of verbatim form for child
/// compatibility.
#[cfg(windows)]
pub(crate) fn launch_parts(executable: &Path) -> (OsString, Vec<OsString>) {
    let executable = plain_windows_path(executable);
    let is_script = Path::new(&executable)
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
        });
    if !is_script {
        return (executable, Vec::new());
    }
    let comspec = std::env::var_os("ComSpec").unwrap_or_else(|| OsString::from("cmd.exe"));
    (
        comspec,
        vec![OsString::from("/d"), OsString::from("/c"), executable],
    )
}

#[cfg(windows)]
fn inherit_process_environment_in(
    command: &mut CommandBuilder,
    environment: impl IntoIterator<Item = (OsString, OsString)>,
) {
    // portable-pty 0.9 reloads HKLM/HKCU after inheriting the process env.
    // That can replace a working PATH with a stale/oversized registry value
    // and fail in the Windows loader before a native CLI starts. Match normal
    // child-process inheritance instead: keep the complete process snapshot,
    // including SystemRoot/PATHEXT, without trimming any legitimate PATH entry.
    // Profile, reporter, and terminal overrides must be applied afterwards.
    command.env_clear();
    for (name, value) in environment {
        command.env(name, value);
    }
}

#[cfg(windows)]
fn inherit_process_environment(command: &mut CommandBuilder) {
    inherit_process_environment_in(command, std::env::vars_os());
}

#[cfg(windows)]
fn final_codex_launch_environment(
    command: &CommandBuilder,
    inherited: &[(OsString, OsString)],
) -> Vec<(OsString, OsString)> {
    // Match portable-pty's case-insensitive Windows environment map without
    // converting non-Unicode names or values to a lossy string. Values must
    // come from the final command, after account/reporter overrides.
    let mut keys = std::collections::BTreeMap::new();
    for key in inherited
        .iter()
        .map(|(key, _)| key.clone())
        .chain(command.iter_full_env_as_str().map(|(key, _)| key.into()))
        .chain(
            [
                "TERM",
                "COLORTERM",
                "CODEX_HOME",
                "LATTICETERM_AGENT_SESSION",
                "LATTICETERM_REMOTE_CLI",
                "LATTICETERM_AGENT_REPORTER",
                "LATTICETERM_AGENT_REPORT_ADDR",
                "LATTICETERM_AGENT_REPORT_TOKEN",
            ]
            .map(OsString::from),
        )
    {
        let normalized = key
            .to_str()
            .map(|key| OsString::from(key.to_lowercase()))
            .unwrap_or_else(|| key.clone());
        keys.insert(normalized, key);
    }
    keys.into_values()
        .filter_map(|key| {
            command
                .get_env(&key)
                .map(|value| (key.clone(), value.to_os_string()))
        })
        .collect()
}

#[cfg(windows)]
fn configure_node_runtime_for_script_in(
    command: &mut CommandBuilder,
    executable: &Path,
    candidate_directories: &[PathBuf],
    inherited_path: Option<&OsStr>,
) -> bool {
    use std::os::windows::ffi::OsStrExt;

    const MAX_CMD_PATH_CODE_UNITS: usize = 7_800;
    let is_script = executable
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
        });
    if !is_script {
        return false;
    }
    let Some(runtime_directory) = candidate_directories
        .iter()
        .find(|directory| is_executable(&directory.join("node.exe")))
    else {
        return false;
    };
    let mut path_entries = vec![runtime_directory.clone()];
    let mut seen = HashSet::from([runtime_directory
        .as_os_str()
        .to_string_lossy()
        .to_ascii_lowercase()]);
    if let Some(inherited_path) = inherited_path {
        for entry in std::env::split_paths(inherited_path) {
            let identity = entry.as_os_str().to_string_lossy().to_ascii_lowercase();
            if !seen.insert(identity) {
                continue;
            }
            path_entries.push(entry);
            let exceeds_cmd_limit = std::env::join_paths(&path_entries)
                .ok()
                .is_none_or(|path| path.encode_wide().count() > MAX_CMD_PATH_CODE_UNITS);
            if exceeds_cmd_limit {
                path_entries.pop();
            }
        }
    }
    let Ok(path) = std::env::join_paths(path_entries) else {
        return false;
    };
    command.env("PATH", path);
    true
}

/// Explorer does not refresh a running desktop process after Node.js updates
/// the user PATH. npm shims can therefore be discovered under `%APPDATA%\npm`
/// but still exit immediately because their internal `node` command cannot be
/// resolved. Prepend an installed Node.js runtime for script shims only, and
/// bound a bloated inherited PATH to what `cmd.exe` can search reliably.
#[cfg(windows)]
fn configure_node_runtime_for_script(command: &mut CommandBuilder, executable: &Path) {
    let mut candidates = Vec::new();
    if let Some(directory) = executable.parent() {
        candidates.push(directory.to_path_buf());
    }
    for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(root) = std::env::var_os(variable) {
            candidates.push(PathBuf::from(root).join("nodejs"));
        }
    }
    if let Some(root) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(PathBuf::from(root).join("Programs").join("nodejs"));
    }
    let _ = configure_node_runtime_for_script_in(
        command,
        executable,
        &candidates,
        std::env::var_os("PATH").as_deref(),
    );
}

/// The bounded PATH a non-PTY child should use for an npm `.cmd` shim.
/// Agent chat uses Tokio rather than `portable_pty::CommandBuilder`, but it
/// needs the same stale-Explorer-PATH protection as an interactive terminal.
#[cfg(windows)]
pub(crate) fn node_runtime_path_for_script(executable: &Path) -> Option<OsString> {
    let mut command = CommandBuilder::new("cmd.exe");
    inherit_process_environment(&mut command);
    configure_node_runtime_for_script(&mut command, executable);
    command.get_env("PATH").map(OsStr::to_os_string)
}

#[cfg(not(windows))]
pub(crate) fn launch_parts(executable: &Path) -> (OsString, Vec<OsString>) {
    (executable.as_os_str().to_os_string(), Vec::new())
}

/// A LatticeTerm PTY is not a Herdr pane. When the desktop app was itself
/// opened from Herdr, inheriting these markers makes global Claude hooks send
/// pane updates to a host that cannot accept them, then emit a misleading
/// startup-hook failure inside the new CLI.
fn clear_host_terminal_markers(command: &mut CommandBuilder) {
    command.env_remove("HERDR_ENV");
    command.env_remove("HERDR_PANE_ID");
}

fn remote_cli_executable_name() -> &'static str {
    if cfg!(windows) {
        "lattice-remote.exe"
    } else {
        "lattice-remote"
    }
}

/// Finds the bundled Lattice Remote client for Agent Fleet children.
///
/// The absolute path is exposed as a non-secret environment variable instead
/// of prepending the application directory to PATH, where unrelated bundled
/// names could unexpectedly shadow the user's normal commands.
fn remote_cli_executable() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(current) = std::env::current_exe() {
        if let Some(parent) = current.parent() {
            candidates.push(parent.join(remote_cli_executable_name()));
        }
    }
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    candidates.push(
        manifest
            .join("../crates/lattice-remote/target/debug")
            .join(remote_cli_executable_name()),
    );
    candidates.push(
        manifest
            .join("../crates/lattice-remote/target/release")
            .join(remote_cli_executable_name()),
    );
    candidates.into_iter().find(|path| path.is_file())
}

fn validated_size(cols: u32, rows: u32) -> Result<PtySize, String> {
    if !(1..=1000).contains(&cols) || !(1..=1000).contains(&rows) {
        return Err("Terminal dimensions must be between 1 and 1000.".to_string());
    }
    Ok(PtySize {
        cols: cols as u16,
        rows: rows as u16,
        pixel_width: 0,
        pixel_height: 0,
    })
}

fn validate_text(value: &str, field: &str, max_bytes: usize) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{field} is required."));
    }
    if trimmed.len() > max_bytes {
        return Err(format!("{field} is too long."));
    }
    if trimmed.chars().any(char::is_control) {
        return Err(format!("{field} contains control characters."));
    }
    Ok(trimmed.to_string())
}

/// Validates the optional free-text note on a saved launch plan. Unlike
/// `validate_text`, an empty note is allowed and normalises to `""`.
fn validate_optional_note(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if trimmed.len() > MAX_PLAN_NOTE_BYTES {
        return Err(format!(
            "Note is too long (maximum {MAX_PLAN_NOTE_BYTES} bytes)."
        ));
    }
    if trimmed.chars().any(char::is_control) {
        return Err("Note contains unsupported control characters.".to_string());
    }
    Ok(trimmed.to_string())
}

fn validate_arguments(arguments: &[String]) -> Result<Vec<String>, String> {
    if arguments.len() > MAX_ARGUMENTS {
        return Err(format!("At most {MAX_ARGUMENTS} arguments are allowed."));
    }
    for argument in arguments {
        if argument.len() > MAX_ARGUMENT_BYTES || argument.chars().any(char::is_control) {
            return Err("An argument is too long or contains control characters.".to_string());
        }
    }
    Ok(arguments.to_vec())
}

fn normalize_resume_session_id(
    spec: Option<&AgentSpec>,
    resume_session_id: Option<&str>,
    arguments: &[String],
) -> Result<Option<String>, String> {
    let Some(resume_session_id) = resume_session_id else {
        return Ok(None);
    };
    let spec = spec
        .ok_or_else(|| "Native session restore is not available for custom agents.".to_string())?;
    if spec.resume_recipe.is_none() {
        return Err(format!(
            "Native session restore is not available for {}.",
            spec.label
        ));
    }
    if !arguments.is_empty() {
        return Err(
            "Native session restore cannot be combined with additional launch arguments."
                .to_string(),
        );
    }
    let resume_session_id = validate_text(
        resume_session_id,
        "Native session ID or title",
        MAX_RESUME_SESSION_ID_BYTES,
    )?;
    if resume_session_id.starts_with('-') {
        return Err("Native session ID or title cannot begin with '-'.".to_string());
    }
    Ok(Some(resume_session_id))
}

fn looks_like_sensitive_argument(argument: &str) -> bool {
    let lower = argument.trim().to_ascii_lowercase();
    let option = lower.split('=').next().unwrap_or_default();
    if matches!(
        option,
        "--password" | "--passphrase" | "--token" | "--api-key" | "--apikey" | "--secret"
    ) {
        return true;
    }

    let Some((name, _)) = lower.split_once('=') else {
        return false;
    };
    let name = name.trim_matches('-');
    matches!(
        name,
        "password" | "passphrase" | "token" | "api_key" | "apikey" | "secret"
    ) || name.ends_with("_password")
        || name.ends_with("_passphrase")
        || name.ends_with("_token")
        || name.ends_with("_api_key")
        || name.ends_with("_secret")
}

pub fn normalize_launch_plan(
    id: String,
    draft: AgentLaunchPlanDraft,
) -> Result<AgentLaunchPlan, String> {
    let id = validate_text(&id, "Launch plan ID", 128)?;
    let definition_id = validate_text(&draft.definition_id, "Agent type", 64)?;
    let spec = AGENTS.iter().find(|agent| agent.id == definition_id);
    let (default_label, executable) = if definition_id == "custom" {
        (
            validate_text(&draft.label, "Agent label", 80)?,
            validate_text(&draft.executable, "Executable", 512)?,
        )
    } else {
        let spec = spec.ok_or_else(|| "Unknown agent type.".to_string())?;
        (spec.label.to_string(), spec.executable.to_string())
    };
    let label = if draft.label.trim().is_empty() {
        default_label
    } else {
        validate_text(&draft.label, "Agent label", 80)?
    };
    let arguments = validate_arguments(&draft.arguments)?;
    let resume_session_id =
        normalize_resume_session_id(spec, draft.resume_session_id.as_deref(), &arguments)?;
    if arguments
        .iter()
        .any(|argument| looks_like_sensitive_argument(argument))
    {
        return Err(
            "Saved launch plans cannot contain password, token, API key, passphrase, or secret arguments."
                .to_string(),
        );
    }
    let working_directory = plain_win32_path(
        PathBuf::from(validate_text(
            &draft.working_directory,
            "Working directory",
            4096,
        )?)
        .canonicalize()
        .map_err(|error| format!("Cannot open the working directory: {error}"))?,
    );
    if !working_directory.is_dir() {
        return Err("Working directory is not a directory.".to_string());
    }

    let note = validate_optional_note(&draft.note)?;

    Ok(AgentLaunchPlan {
        id,
        definition_id,
        label,
        executable,
        arguments,
        resume_session_id,
        note,
        sandbox: draft.sandbox,
        detached: draft.detached,
        working_directory: working_directory.display().to_string(),
    })
}

pub fn launch_request_from_plan(
    plan: &AgentLaunchPlan,
    cols: u32,
    rows: u32,
) -> Result<AgentLaunchRequest, String> {
    let validated = normalize_launch_plan(
        plan.id.clone(),
        AgentLaunchPlanDraft {
            definition_id: plan.definition_id.clone(),
            label: plan.label.clone(),
            executable: plan.executable.clone(),
            arguments: plan.arguments.clone(),
            resume_session_id: plan.resume_session_id.clone(),
            note: plan.note.clone(),
            sandbox: plan.sandbox,
            detached: plan.detached,
            working_directory: plan.working_directory.clone(),
        },
    )?;
    // A saved Codex item means "continue this directory" rather than "open a
    // blank chat". Codex itself resolves --last within the current working
    // directory, so LatticeTerm does not need to persist a session id or read
    // the CLI's private transcript store. Explicit legacy resume ids still win.
    let mut restore_existing_session = validated.resume_session_id.is_some();
    let arguments = if validated.resume_session_id.is_none() {
        let resume_arguments = AGENTS
            .iter()
            .find(|agent| agent.id == validated.definition_id)
            .and_then(|agent| agent.resume_latest_recipe)
            .map(AgentResumeLatestRecipe::arguments);
        if validated.definition_id == "claude" {
            if let Some(mut resume_arguments) = resume_arguments {
                // --continue is compatible with normal Claude startup flags.
                // Preserve an explicit model or permission preference while
                // resuming the project's latest native conversation.
                resume_arguments.extend(validated.arguments);
                restore_existing_session = true;
                resume_arguments
            } else {
                validated.arguments
            }
        } else if validated.arguments.is_empty() {
            restore_existing_session = resume_arguments.is_some();
            resume_arguments.unwrap_or_default()
        } else {
            validated.arguments
        }
    } else {
        validated.arguments
    };

    Ok(AgentLaunchRequest {
        definition_id: validated.definition_id,
        label: validated.label,
        executable: validated.executable,
        arguments,
        resume_session_id: validated.resume_session_id,
        // A saved plan launches its own tab; grouping is a live-tab action.
        group_id: None,
        seed_input: None,
        restore_existing_session,
        // Account profiles are intentionally an ephemeral launch choice. A
        // workspace plan must never retain a machine-local credential root.
        profile_config_path: None,
        sandbox: validated.sandbox,
        detached: validated.detached,
        working_directory: validated.working_directory,
        cols,
        rows,
    })
}

/// Adds the user's opt-in workspace instructions ahead of any one-off handoff
/// seed. Custom sessions are installation/helper commands rather than AI CLIs
/// and must never receive the workspace prompt.
pub fn apply_startup_instructions(
    request: &mut AgentLaunchRequest,
    instructions: &str,
) -> Result<(), String> {
    let instructions = instructions.trim();
    if instructions.is_empty()
        || request.definition_id == "custom"
        || request.restore_existing_session
    {
        return Ok(());
    }
    let existing = request
        .seed_input
        .take()
        .filter(|value| !value.trim().is_empty());
    let merged = existing
        .map(|seed| format!("{instructions}\n\n---\n\n{seed}"))
        .unwrap_or_else(|| instructions.to_string());
    if merged.len() > MAX_INPUT_BYTES {
        return Err(format!(
            "Startup instructions and handoff text exceed {MAX_INPUT_BYTES} bytes."
        ));
    }
    request.seed_input = Some(merged);
    Ok(())
}

fn resolve_launch(
    request: &AgentLaunchRequest,
) -> Result<(String, String, PathBuf, Vec<String>, PathBuf), String> {
    let mut arguments = validate_arguments(&request.arguments)?;

    let definition_id = validate_text(&request.definition_id, "Agent type", 64)?;
    let spec = AGENTS.iter().find(|agent| agent.id == definition_id);
    let (default_label, command) = if definition_id == "custom" {
        (
            validate_text(&request.label, "Agent label", 80)?,
            validate_text(&request.executable, "Executable", 512)?,
        )
    } else {
        let spec = spec.ok_or_else(|| "Unknown agent type.".to_string())?;
        (spec.label.to_string(), spec.executable.to_string())
    };
    if let Some(resume_session_id) =
        normalize_resume_session_id(spec, request.resume_session_id.as_deref(), &arguments)?
    {
        arguments = spec
            .and_then(|agent| agent.resume_recipe)
            .expect("validated resume recipe")
            .arguments(resume_session_id);
    }

    let executable = spec
        .and_then(find_agent_executable)
        .or_else(|| {
            (definition_id == "custom")
                .then(|| find_executable(&command))
                .flatten()
        })
        .ok_or_else(|| format!("{default_label} is not installed or is not available on PATH."))?;
    let working_directory = plain_win32_path(
        PathBuf::from(validate_text(
            &request.working_directory,
            "Working directory",
            4096,
        )?)
        .canonicalize()
        .map_err(|error| format!("Cannot open the working directory: {error}"))?,
    );
    if !working_directory.is_dir() {
        return Err("Working directory is not a directory.".to_string());
    }

    if definition_id == "codex" {
        arguments = codex_resume::with_working_directory(arguments, &working_directory);
    }

    let label = if request.label.trim().is_empty() {
        default_label
    } else {
        validate_text(&request.label, "Agent label", 80)?
    };
    Ok((
        definition_id,
        label,
        executable,
        arguments,
        working_directory,
    ))
}

fn migrate_deprecated_google_consumer_request(
    request: &AgentLaunchRequest,
    deprecated: bool,
) -> Result<AgentLaunchRequest, String> {
    if request.definition_id != "gemini" || !deprecated {
        return Ok(request.clone());
    }
    if (!request.arguments.is_empty() || request.resume_session_id.is_some())
        && !request.restore_existing_session
    {
        return Err(
            "Gemini CLI personal OAuth moved to Google Antigravity CLI, but Gemini-specific arguments or session IDs cannot be migrated safely. Start a new Antigravity session instead."
                .to_string(),
        );
    }

    let mut migrated = request.clone();
    migrated.definition_id = "antigravity".to_string();
    migrated.executable = "agy".to_string();
    if migrated.label.trim().is_empty() || migrated.label.trim() == "Gemini CLI" {
        migrated.label = "Google Antigravity CLI".to_string();
    }
    // Gemini and Antigravity use different native conversation identifiers
    // and flags. Reopening the project is safe; pretending the old identifier
    // can be resumed is not.
    migrated.arguments.clear();
    migrated.resume_session_id = None;
    Ok(migrated)
}

fn encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn decode(value: &str) -> Result<Vec<u8>, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|error| format!("Input was not valid base64: {error}"))?;
    if bytes.len() > MAX_INPUT_BYTES {
        return Err(format!(
            "One input event may contain at most {MAX_INPUT_BYTES} bytes."
        ));
    }
    Ok(bytes)
}

/// Drops ANSI escape sequences (CSI, OSC, and single-character escapes) so
/// pattern matching sees the text a human sees.
pub(crate) fn strip_ansi(text: &str) -> String {
    let mut cleaned = String::with_capacity(text.len());
    let mut characters = text.chars().peekable();
    while let Some(character) = characters.next() {
        if character != '\u{1b}' {
            cleaned.push(character);
            continue;
        }
        match characters.peek() {
            // CSI: ESC [ ... final byte in @-~
            Some('[') => {
                characters.next();
                for follower in characters.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&follower) {
                        break;
                    }
                }
            }
            // OSC: ESC ] ... BEL or ESC backslash
            Some(']') => {
                characters.next();
                let mut previous = '\0';
                for follower in characters.by_ref() {
                    if follower == '\u{7}' || (previous == '\u{1b}' && follower == '\\') {
                        break;
                    }
                    previous = follower;
                }
            }
            // Two-character escapes such as ESC ( B.
            Some(_) => {
                characters.next();
            }
            None => {}
        }
    }
    cleaned
}

fn is_uuid_shaped(candidate: &[char]) -> bool {
    if candidate.len() != 36 {
        return false;
    }
    candidate.iter().enumerate().all(|(index, character)| {
        if matches!(index, 8 | 13 | 18 | 23) {
            *character == '-'
        } else {
            character.is_ascii_hexdigit()
        }
    })
}

fn find_antigravity_conversation_id(text: &str) -> Option<String> {
    const MARKER: &str = "Created conversation ";
    for (index, _) in text.match_indices(MARKER) {
        let candidate = text[index + MARKER.len()..]
            .chars()
            .take(36)
            .collect::<Vec<_>>();
        if is_uuid_shaped(&candidate) {
            return Some(
                candidate
                    .into_iter()
                    .collect::<String>()
                    .to_ascii_lowercase(),
            );
        }
    }
    None
}

fn watch_antigravity_conversation_id(
    path: PathBuf,
    session_id: String,
    registry: Arc<AgentRegistry>,
    sink: Arc<dyn AgentSink>,
) {
    std::thread::spawn(move || loop {
        if registry.get(&session_id).is_err() {
            return;
        }
        if let Ok(metadata) = std::fs::metadata(&path) {
            if !metadata.is_file() || metadata.len() > MAX_ANTIGRAVITY_CAPTURE_LOG_BYTES {
                return;
            }
            if let Ok(log) = std::fs::read_to_string(&path) {
                if let Some(native_session_id) = find_antigravity_conversation_id(&log) {
                    if let Some(captured) =
                        registry.set_captured_session_id(&session_id, native_session_id)
                    {
                        sink.captured(&session_id, &captured);
                    }
                    return;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    });
}

/// Finds a CLI session id announced in output: a UUID with the word
/// "session" shortly before it. The word requirement is what keeps this
/// conservative — agents print plenty of UUIDs that are not session ids.
fn find_native_session_id(text: &str) -> Option<String> {
    let characters: Vec<char> = text.chars().collect();
    let lowered: Vec<char> = characters.iter().map(|c| c.to_ascii_lowercase()).collect();
    let needle: Vec<char> = "session".chars().collect();

    for start in 0..characters.len().saturating_sub(35) {
        let window = &characters[start..start + 36];
        if !is_uuid_shaped(window) {
            continue;
        }
        // A UUID is only trusted as a session id if "session" appears within
        // the preceding few dozen characters.
        let context_start = start.saturating_sub(64);
        let context = &lowered[context_start..start];
        if context
            .windows(needle.len())
            .any(|slice| slice == needle.as_slice())
        {
            return Some(window.iter().collect::<String>().to_ascii_lowercase());
        }
    }
    None
}

fn clean_model_token(value: &str) -> Option<String> {
    let value = value.trim().trim_matches(|character: char| {
        matches!(
            character,
            '`' | '"' | '\'' | '[' | ']' | '(' | ')' | '│' | '┃'
        )
    });
    let token = value
        .split_whitespace()
        .next()?
        .trim_matches(|character: char| !character.is_ascii_alphanumeric() && character != '.')
        .trim_end_matches([',', ';', ':']);
    if token.is_empty()
        || token.len() > 80
        || !token.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_' | '/' | ':')
        })
    {
        return None;
    }
    let lowered = token.to_ascii_lowercase();
    let named_alias = matches!(
        lowered.as_str(),
        "auto" | "default" | "opus" | "sonnet" | "haiku" | "flash" | "pro"
    );
    (token.chars().any(|character| character.is_ascii_digit()) || named_alias)
        .then(|| token.to_string())
}

fn model_from_arguments(arguments: &[String]) -> Option<String> {
    for (index, argument) in arguments.iter().enumerate() {
        if matches!(argument.as_str(), "--model" | "-m") {
            return arguments
                .get(index + 1)
                .and_then(|value| clean_model_token(value));
        }
        if let Some(value) = argument.strip_prefix("--model=") {
            return clean_model_token(value);
        }
    }
    None
}

fn codex_model_from_config(raw: &str) -> Option<String> {
    for line in raw.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            // Codex profiles and other sections may contain their own model.
            // Only the top-level value describes the model used by default.
            break;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() == "model" {
            return clean_model_token(value);
        }
    }
    None
}

fn configured_agent_model(definition_id: &str) -> Option<String> {
    match definition_id {
        "codex" => read_account_file(&[".codex", "config.toml"])
            .and_then(|raw| codex_model_from_config(&raw)),
        _ => None,
    }
}

fn claude_family_model(line: &str) -> Option<String> {
    let lowered = line.to_ascii_lowercase();
    for family in ["opus", "sonnet", "haiku"] {
        let Some(index) = lowered.find(family) else {
            continue;
        };
        let suffix = &line[index + family.len()..];
        let version = suffix.split_whitespace().next().and_then(clean_model_token);
        let title = format!("{}{}", family[..1].to_ascii_uppercase(), &family[1..]);
        return Some(match version {
            Some(version) if version.chars().any(|character| character.is_ascii_digit()) => {
                format!("Claude {title} {version}")
            }
            _ => format!("Claude {title}"),
        });
    }
    None
}

fn status_model_token(definition_id: &str, line: &str) -> Option<String> {
    let prefixes: &[&str] = match definition_id {
        "codex" => &["gpt-", "o1-", "o3-", "o4-", "codex-"],
        "claude" => &["claude-"],
        "gemini" => &["gemini-"],
        "qwen" => &["qwen"],
        "kimi" => &["kimi-", "moonshot-"],
        "grok" => &["grok-"],
        _ => &[],
    };
    line.split_whitespace().find_map(|value| {
        let token = clean_model_token(value)?;
        let lowered = token.to_ascii_lowercase();
        prefixes
            .iter()
            .any(|prefix| lowered.starts_with(prefix))
            .then_some(token)
    })
}

/// Conservatively reads model fields from CLI startup/status output. Generic
/// matching requires an explicit `model:`/`model=` label; Claude's TUI is the
/// one verified exception because it prints family names as a status badge.
fn find_model_name(definition_id: &str, text: &str) -> Option<String> {
    for line in text.lines().rev() {
        if definition_id == "claude" {
            if let Some(model) = claude_family_model(line) {
                return Some(model);
            }
        }
        if let Some(model) = status_model_token(definition_id, line) {
            return Some(model);
        }
        let lowered = line.to_ascii_lowercase();
        let marker = lowered
            .find("model:")
            .map(|index| (index, "model:".len()))
            .or_else(|| {
                lowered
                    .find("model =")
                    .map(|index| (index, "model =".len()))
            })
            .or_else(|| lowered.find("model=").map(|index| (index, "model=".len())));
        if let Some((index, marker_length)) = marker {
            if let Some(model) = clean_model_token(&line[index + marker_length..]) {
                if definition_id == "claude" {
                    let lowered = model.to_ascii_lowercase();
                    if matches!(lowered.as_str(), "opus" | "sonnet" | "haiku") {
                        return Some(format!(
                            "Claude {}{}",
                            lowered[..1].to_ascii_uppercase(),
                            &lowered[1..]
                        ));
                    }
                }
                return Some(model);
            }
        }
    }
    None
}

fn lifecycle_from_output(bytes: &[u8]) -> AgentLifecycle {
    let text = strip_ansi(&String::from_utf8_lossy(bytes)).to_lowercase();
    if has_attention_marker(&text)
        && (!has_explicit_working_status(&text) || has_actionable_attention_prompt(&text))
    {
        AgentLifecycle::NeedsAttention
    } else {
        AgentLifecycle::Working
    }
}

fn has_attention_marker(text: &str) -> bool {
    const ATTENTION_MARKERS: [&str; 12] = [
        "do you want to",
        "would you like",
        "permission required",
        "approve?",
        "allow this",
        "proceed?",
        "continue?",
        "[y/n]",
        "(y/n)",
        "press enter",
        "是否允許",
        "請確認",
    ];
    ATTENTION_MARKERS.iter().any(|marker| text.contains(marker))
}

fn has_explicit_working_status(text: &str) -> bool {
    text.contains("working (")
        || text.contains("esc to interrupt")
        || text.contains("background terminal running")
}

fn has_actionable_attention_prompt(text: &str) -> bool {
    text.lines().any(|line| {
        let line = line.trim_start_matches(|c: char| {
            c.is_whitespace() || matches!(c, '│' | '┃' | '›' | '❯' | '>')
        });
        line.starts_with("permission required")
            || line.starts_with("press enter")
            || line.starts_with("1. yes")
            || line.starts_with("1) yes")
            || line.starts_with("1. 是")
            || line.starts_with("[y/n]")
            || line.starts_with("(y/n)")
            || line.ends_with("[y/n]")
            || line.ends_with("(y/n)")
            || line.contains("enter to confirm")
    })
}

pub fn launch(
    sink: Arc<dyn AgentSink>,
    registry: Arc<AgentRegistry>,
    request: AgentLaunchRequest,
) -> Result<AgentSessionSummary, String> {
    launch_with_replay(sink, registry, request, None)
}

pub fn launch_with_replay(
    sink: Arc<dyn AgentSink>,
    registry: Arc<AgentRegistry>,
    request: AgentLaunchRequest,
    restored_output: Option<Vec<u8>>,
) -> Result<AgentSessionSummary, String> {
    let request =
        migrate_deprecated_google_consumer_request(&request, gemini_consumer_oauth_deprecated())?;
    let size = validated_size(request.cols, request.rows)?;
    let launch_arguments = request.arguments.clone();
    let (definition_id, label, executable, mut arguments, working_directory) =
        resolve_launch(&request)?;
    let profile_config_path =
        profile_config_directory(&definition_id, request.profile_config_path.as_deref())?;
    let launch_model = model_from_arguments(&arguments).or_else(|| {
        // The default login's configured model says nothing about a profile.
        profile_config_path
            .is_none()
            .then(|| configured_agent_model(&definition_id))
            .flatten()
    });
    let session_id = registry.next_id()?;
    let reporter = registry.reporter.clone();
    let report_token = reporter
        .as_ref()
        .map(|_| random_report_token())
        .transpose()?;
    let mut integration_settings = None;
    let mut integrated_completion = false;
    if definition_id == "codex" {
        if let Some(endpoint) = reporter.as_ref() {
            let adapted = codex_reporter_arguments(arguments.clone(), &endpoint.executable);
            integrated_completion = adapted != arguments;
            arguments = adapted;
        }
    } else if definition_id == "antigravity" {
        // Antigravity does not expose a new interactive conversation id on
        // stdout. Its process-scoped log does, so use an isolated temporary
        // log unless the caller explicitly selected their own log file.
        integration_settings = antigravity_capture_log(&mut arguments)
            .ok()
            .flatten()
            .map(AgentIntegrationSettings::Antigravity);
    } else if definition_id == "claude" {
        if let Some(endpoint) = reporter.as_ref() {
            let adapted = claude_reporter_arguments(arguments.clone(), &endpoint.executable);
            integrated_completion = adapted != arguments;
            arguments = adapted;
        }
    } else if definition_id == "gemini" && reporter.is_some() {
        // Gemini has no one-shot --settings argument. Its documented system
        // settings path is process-scoped, so a temporary file adds hooks
        // without touching ~/.gemini or the selected workspace.
        integration_settings = gemini_reporter_settings_file()
            .ok()
            .flatten()
            .map(AgentIntegrationSettings::Gemini);
        // Only disable prompt-control completion guesses when the settings
        // file was actually installed. Managed-policy fallbacks stay
        // heuristic, while an active official AfterAgent hook is authoritative.
        integrated_completion = integration_settings.is_some();
    } else if definition_id == "opencode" && reporter.is_some() {
        // OpenCode merges runtime config with global/project/admin layers. A
        // temporary local plugin observes only this process and never edits
        // the user's files. Explicit inline config or pure mode wins.
        integration_settings = opencode_reporter_plugin(&arguments)
            .ok()
            .flatten()
            .map(AgentIntegrationSettings::OpenCode);
        integrated_completion = integration_settings.is_some();
    } else if definition_id == "copilot" && reporter.is_some() {
        // Copilot's repeatable --plugin-dir flag mounts lifecycle hooks only
        // for this child process while preserving the user's home, login,
        // history, permissions, project hooks, and installed plugins.
        if let Ok(plugin) = write_copilot_reporter_plugin() {
            arguments = copilot_reporter_arguments(arguments, &plugin);
            integration_settings = Some(AgentIntegrationSettings::Copilot(plugin));
        }
        // Repository settings may intentionally disable all non-policy hooks.
        // Keep heuristics enabled until the first real hook event arrives.
    } else if definition_id == "hermes" && reporter.is_some() {
        // Hermes has no per-invocation hook flag. Build a temporary overlay of
        // its official bundled plugin tree and add one observer backend there;
        // HERMES_HOME, credentials, user config/plugins, and the workspace are
        // untouched. Safe mode and an unrecognised package layout fall back to
        // conservative terminal heuristics.
        integration_settings = hermes_reporter_plugin(&executable, &arguments)
            .ok()
            .flatten()
            .map(AgentIntegrationSettings::Hermes);
    } else if definition_id == "qwen" && reporter.is_some() {
        // Qwen's system settings override can be scoped to this child process.
        // Keep heuristics enabled until the first hook actually reports: user
        // settings may intentionally disable hooks even when this file loads.
        integration_settings = qwen_reporter_settings_file(&arguments)
            .ok()
            .flatten()
            .map(AgentIntegrationSettings::Qwen);
    }

    let pair = native_pty_system()
        .openpty(size)
        .map_err(|error| format!("Cannot create a local terminal: {error}"))?;
    let (mut program, mut prefix_args) = launch_parts(&executable);
    if request.sandbox {
        let Some(bwrap) = sandbox_tool() else {
            return Err(
                "Sandboxed launch needs bubblewrap (bwrap) and permission to create user \
                 namespaces; this machine has neither or blocks them."
                    .to_string(),
            );
        };
        let home = user_home_directory();
        if let Some(home) = home.as_deref() {
            prepare_sandbox_state(&definition_id, home).map_err(|error| {
                format!("Cannot prepare the CLI state directory for the sandbox: {error}")
            })?;
        }
        let override_root = if profile_config_path.is_none() {
            let variable = match definition_id.as_str() {
                "codex" => Some("CODEX_HOME"),
                "claude" => Some("CLAUDE_CONFIG_DIR"),
                _ => None,
            };
            variable.and_then(std::env::var_os).map(PathBuf::from)
        } else {
            None
        };
        if override_root
            .as_ref()
            .is_some_and(|path| !path.is_absolute())
        {
            return Err("Sandbox configuration directory must be an absolute path.".to_string());
        }
        let extra: Vec<&Path> = profile_config_path
            .iter()
            .chain(override_root.iter())
            .map(PathBuf::as_path)
            .collect();
        for root in &extra {
            prepare_sandbox_profile(&definition_id, root)
                .map_err(|error| format!("Cannot protect the account profile policy: {error}"))?;
        }
        let mut wrapped = sandbox_arguments(
            &working_directory,
            &definition_id,
            home.as_deref(),
            &extra,
            &|path| path.exists(),
        );
        wrapped.push(program);
        wrapped.extend(prefix_args);
        program = bwrap.into_os_string();
        prefix_args = wrapped;
    }
    let mut command = CommandBuilder::new(&program);
    #[cfg(windows)]
    let launch_environment = std::env::vars_os().collect::<Vec<_>>();
    #[cfg(windows)]
    inherit_process_environment_in(&mut command, launch_environment.clone());
    clear_host_terminal_markers(&mut command);
    #[cfg(windows)]
    configure_node_runtime_for_script(&mut command, &executable);
    for prefix in &prefix_args {
        command.arg(prefix);
    }
    command.args(arguments);
    command.cwd(&working_directory);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("LATTICETERM_AGENT_SESSION", &session_id);
    if let Some(profile_config_path) = profile_config_path.as_deref() {
        if definition_id == "codex" {
            command.env("CODEX_HOME", profile_config_path);
        } else if definition_id == "claude" {
            command.env("CLAUDE_CONFIG_DIR", profile_config_path);
        }
    }
    if let Some(remote_cli) = remote_cli_executable() {
        command.env("LATTICETERM_REMOTE_CLI", remote_cli);
    }
    if let (Some(endpoint), Some(token)) = (&reporter, &report_token) {
        command.env("LATTICETERM_AGENT_REPORTER", &endpoint.executable);
        command.env(
            "LATTICETERM_AGENT_REPORT_ADDR",
            endpoint.address.to_string(),
        );
        command.env("LATTICETERM_AGENT_REPORT_TOKEN", token);
    }
    if let Some(settings) = integration_settings.as_ref() {
        match settings {
            AgentIntegrationSettings::Antigravity(log) => {
                // The path is already present in --log-file; retaining the
                // temporary directory keeps it available to the watcher.
                let _ = &log.path;
            }
            AgentIntegrationSettings::Copilot(plugin) => {
                // The path is already present in --plugin-dir; retaining and
                // touching the TempDir here documents its launch-time lifetime.
                let _ = plugin.path();
            }
            AgentIntegrationSettings::Gemini(file) => {
                command.env("GEMINI_CLI_SYSTEM_SETTINGS_PATH", file.path());
            }
            AgentIntegrationSettings::Hermes(plugin) => {
                command.env("HERMES_BUNDLED_PLUGINS", plugin.path());
            }
            AgentIntegrationSettings::Qwen(file) => {
                command.env("QWEN_CODE_SYSTEM_SETTINGS_PATH", file.path());
            }
            AgentIntegrationSettings::OpenCode(plugin) => {
                command.env("OPENCODE_CONFIG_CONTENT", &plugin.config_content);
            }
        }
    }

    #[cfg(windows)]
    let codex_input_profile = if definition_id == "codex"
        && program == executable.as_os_str()
        && prefix_args.is_empty()
        && seed_preserves_codex_input_profile(request.seed_input.as_deref())
    {
        // Capture the exact final child environment, including account and
        // reporter overrides. Keep values local; never log this snapshot.
        let context = codex_input_profile::ProbeContext {
            native_executable: executable.clone(),
            cwd: working_directory.clone(),
            environment: final_codex_launch_environment(&command, &launch_environment),
            arguments: command.get_argv().iter().skip(1).cloned().collect(),
        };
        codex_input_profile::inspect(&context)
            .ok()
            .map(|profile| CodexInputAttestation { context, profile })
    } else {
        None
    };

    // Configuration preflight may take seconds. The seed's minimum wait and
    // fallback deadline must begin at the actual PTY launch, not before it.
    let launched_at = Instant::now();
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("Cannot start {label}: {error}"))?;
    drop(pair.slave);

    let process_id = child.process_id();
    let killer = crate::agent_process::clone_killer(child.as_ref()).map_err(|error| {
        let _ = child.kill();
        format!("Cannot retain the agent process handle: {error}")
    })?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("Cannot read the local terminal: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("Cannot write to the local terminal: {error}"))?;

    // Only CLIs whose resume shape is verified get automatic id capture;
    // for the rest a captured id would be a guess nothing can use.
    let capture_enabled = AGENTS
        .iter()
        .any(|agent| agent.id == definition_id && agent.resume_recipe.is_some());

    let group_id = request
        .group_id
        .clone()
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| session_id.clone());
    let group_label = registry
        .group_label(&group_id)
        .unwrap_or_else(|| label.clone());
    let summary = AgentSessionSummary {
        session_id: session_id.clone(),
        group_id,
        group_label,
        definition_id,
        label,
        model: launch_model,
        executable: executable.display().to_string(),
        launch_arguments,
        profile_config_path: profile_config_path
            .as_ref()
            .map(|path| path.display().to_string()),
        restore_existing_session: request.restore_existing_session,
        working_directory: working_directory.display().to_string(),
        // Opening a CLI only creates an interactive prompt; it does not mean
        // the CLI has received work. Mark it idle until a submitted prompt or
        // a trusted lifecycle integration reports actual activity.
        state: AgentLifecycle::Idle,
        state_source: AgentStateSource::Heuristic,
        process_id,
        token_usage: None,
        queued_prompts: 0,
        // A session launched as a native resume already knows its id; a
        // fresh announcement in the output still overwrites it.
        captured_session_id: request.resume_session_id.clone(),
        sandboxed: request.sandbox,
        detached: false,
    };
    let antigravity_capture_path = match integration_settings.as_ref() {
        Some(AgentIntegrationSettings::Antigravity(log)) => Some(log.path.clone()),
        _ => None,
    };
    let copilot_activity = matches!(
        integration_settings.as_ref(),
        Some(AgentIntegrationSettings::Copilot(_))
    )
    .then(|| Mutex::new(CopilotActivity::default()));
    let hermes_activity = matches!(
        integration_settings.as_ref(),
        Some(AgentIntegrationSettings::Hermes(_))
    )
    .then(|| Mutex::new(HermesActivity::default()));
    let entry = Arc::new(AgentSessionEntry {
        summary: Mutex::new(summary.clone()),
        report_token,
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        killer: Mutex::new(killer),
        capture: Mutex::new(CaptureState {
            enabled: capture_enabled,
            buffer: String::new(),
        }),
        model_capture: Mutex::new(ModelCaptureState {
            definition_id: summary.definition_id.clone(),
            enabled: true,
            buffer: String::new(),
            scanned_chars: 0,
            input_buffer: String::new(),
            model_command_active: false,
        }),
        output: Mutex::new(OutputBuffer::from_tail(
            restored_output.as_deref().unwrap_or_default(),
        )),
        startup_gate: StartupGate::default(),
        completion_gate: Mutex::new(CompletionReadiness::default()),
        input: Mutex::new(AgentInputControl {
            startup_seed_pending: request
                .seed_input
                .as_ref()
                .is_some_and(|seed| !seed.trim().is_empty()),
            ..AgentInputControl::default()
        }),
        mcp_grant_epoch: AtomicU64::new(0),
        desktop_input_ticket: AtomicU64::new(0),
        mcp_input_profile_invalidated: AtomicBool::new(!seed_preserves_codex_input_profile(
            request.seed_input.as_deref(),
        )),
        #[cfg(windows)]
        codex_input_profile,
        #[cfg(all(windows, test))]
        codex_input_profile_test_supported: AtomicBool::new(false),
        stopping: AtomicBool::new(false),
        last_output_at: Mutex::new(launched_at),
        prompt_ready_at: Mutex::new(None),
        integrated_completion: AtomicBool::new(integrated_completion),
        copilot_activity,
        hermes_activity,
        reported_usage_requests: Mutex::new(ReportedUsageRequests::default()),
        queued_prompts: Mutex::new(VecDeque::new()),
        _integration_settings: integration_settings,
        staged_images: Mutex::new(StagedAgentImages::default()),
    });
    if let Err(error) = registry.insert(&summary, Arc::clone(&entry)) {
        let _ = terminate_agent_entry(entry.as_ref());
        return Err(error);
    }

    if let Some(path) = antigravity_capture_path {
        watch_antigravity_conversation_id(
            path,
            session_id.clone(),
            Arc::clone(&registry),
            Arc::clone(&sink),
        );
    }

    if let Some(bytes) = restored_output.as_deref().filter(|bytes| !bytes.is_empty()) {
        let start = bytes.len().saturating_sub(MAX_OUTPUT_SNAPSHOT_BYTES);
        sink.data(&session_id, 0, &bytes[start..]);
    }

    let reader_id = session_id.clone();
    let reader_sink = Arc::clone(&sink);
    let reader_registry = Arc::clone(&registry);
    let reader_entry = Arc::clone(&entry);
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let bytes = &buffer[..count];
                    if let Ok(mut last_output_at) = reader_entry.last_output_at.lock() {
                        *last_output_at = Instant::now();
                    }
                    reader_entry.startup_gate.observe(bytes);
                    let Ok(offset) = reader_registry.record_output(&reader_id, bytes) else {
                        break;
                    };
                    reader_sink.data(&reader_id, offset, bytes);
                    let state = if let Ok(mut completion) = reader_entry.completion_gate.lock() {
                        heuristic_state_from_output(
                            &mut completion,
                            bytes,
                            reader_entry.integrated_completion.load(Ordering::Acquire),
                        )
                    } else {
                        Some(lifecycle_from_output(bytes))
                    };
                    if state == Some(AgentLifecycle::Done) {
                        // A guess, not a verdict: wait for the terminal to go
                        // quiet before showing it. Redraws re-enable bracketed
                        // paste too, and a CLI mid-task must not read as done.
                        if let Some(marker) = reader_registry.note_prompt_ready(&reader_id) {
                            let settle_id = reader_id.clone();
                            let settle_registry = Arc::clone(&reader_registry);
                            let settle_sink = Arc::clone(&reader_sink);
                            std::thread::spawn(move || {
                                let mut marker = marker;
                                loop {
                                    std::thread::sleep(PROMPT_READY_SETTLE);
                                    match settle_registry.settle_prompt_ready(&settle_id, marker) {
                                        PromptReadySettle::Done => {
                                            settle_sink.state(
                                                &settle_id,
                                                AgentLifecycle::Done,
                                                AgentStateSource::Heuristic,
                                            );
                                            break;
                                        }
                                        PromptReadySettle::Retry(next) => marker = next,
                                        PromptReadySettle::Dropped => break,
                                    }
                                }
                            });
                        }
                    } else if let Some(state) = state {
                        if reader_registry.update_state(
                            &reader_id,
                            state,
                            AgentStateSource::Heuristic,
                        ) {
                            reader_sink.state(&reader_id, state, AgentStateSource::Heuristic);
                        }
                    }
                    if let Some(native_id) = reader_registry.scan_for_session_id(&reader_id, bytes)
                    {
                        reader_sink.captured(&reader_id, &native_id);
                    }
                    if let Some(model) = reader_registry.scan_for_model(&reader_id, bytes) {
                        reader_sink.model(&reader_id, &model);
                    }
                }
                Err(_) => break,
            }
        }
    });

    // A CLI whose lifecycle integration never reports leaves the sidebar on
    // "working" for the rest of the session. Watch for a terminal that has
    // gone completely silent and release only this process's own guess.
    let watchdog_id = session_id.clone();
    let watchdog_registry = Arc::clone(&registry);
    let watchdog_sink = Arc::clone(&sink);
    std::thread::spawn(move || loop {
        std::thread::sleep(SILENT_WORKING_CHECK_INTERVAL);
        if watchdog_registry.get(&watchdog_id).is_err() {
            return;
        }
        if watchdog_registry.settle_silent_working(&watchdog_id) {
            watchdog_sink.state(
                &watchdog_id,
                AgentLifecycle::Idle,
                AgentStateSource::Heuristic,
            );
        }
    });

    if let Some(seed) = request
        .seed_input
        .clone()
        .filter(|value| !value.trim().is_empty())
    {
        let seed_id = session_id.clone();
        let seed_registry = Arc::clone(&registry);
        let seed_entry = Arc::clone(&entry);
        let seed_sink = Arc::clone(&sink);
        std::thread::spawn(move || {
            // Each terminal starts at a different speed, especially when the
            // user launches several CLIs together. Wait for this PTY to enable
            // bracketed paste or for its own startup output to settle.
            if !seed_entry.startup_gate.wait_until_ready(launched_at) {
                return;
            }
            let payload = startup_seed_payload(&seed);
            if let Ok(entry) = seed_registry.get(&seed_id) {
                if let Ok(mut input) = entry.input.lock() {
                    if input.startup_seed_pending && !input.desktop_busy() {
                        let _ = send_bytes_locked(
                            seed_sink.as_ref(),
                            &seed_registry,
                            &seed_id,
                            &payload,
                        );
                    }
                    input.startup_seed_pending = false;
                }
            }
        });
    }

    let wait_id = session_id;
    let wait_registry = Arc::clone(&registry);
    std::thread::spawn(move || {
        let reason = match child.wait() {
            Ok(status) => format!("Process exited: {status:?}"),
            Err(error) => format!("Process wait failed: {error}"),
        };
        if wait_registry.remove(&wait_id).is_some() {
            sink.closed(&wait_id, &reason);
        }
    });

    Ok(summary)
}

pub fn send(
    sink: &dyn AgentSink,
    registry: &AgentRegistry,
    session_id: &str,
    encoded: &str,
) -> Result<(), String> {
    let bytes = decode(encoded)?;
    send_bytes(sink, registry, session_id, &bytes)
}

fn send_bytes(
    sink: &dyn AgentSink,
    registry: &AgentRegistry,
    session_id: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let entry = registry.get(session_id)?;
    let ticket = next_desktop_input_ticket(&entry, bytes)?;
    let mut input = entry.input.lock().map_err(|error| error.to_string())?;
    if rejects_interrupted_desktop_input(&input, ticket, bytes) {
        return Err(MCP_DRAFT_RECOVERY_ERROR.to_string());
    }
    discard_profile_invalidated_queue(sink, registry, session_id, &entry);
    let desktop_input = observe_desktop_input(&mut input, bytes);
    if desktop_input && input.startup_seed_pending {
        let choosing_trust = entry
            .startup_gate
            .readiness
            .lock()
            .map(|readiness| readiness.interactive_gate_open)
            .unwrap_or(false);
        if !choosing_trust {
            input.startup_seed_pending = false;
        }
    }
    send_bytes_locked(sink, registry, session_id, bytes)?;
    Ok(())
}

/// xterm uses the same channel for typing and terminal query replies. Track
/// escape/paste boundaries across chunks; only an Enter outside a paste
/// completes an edit, and trailing text starts another edit immediately.
fn observe_desktop_input(input: &mut AgentInputControl, bytes: &[u8]) -> bool {
    let mut activity = false;
    for &byte in bytes {
        if !input.desktop_escape.is_empty() {
            input.desktop_escape.push(byte);
            let sequence = &input.desktop_escape;
            let complete = if sequence.starts_with(b"\x1b[") {
                sequence.len() > 2 && (0x40..=0x7e).contains(&byte)
            } else if sequence.starts_with(b"\x1b]") {
                byte == 7 || sequence.ends_with(b"\x1b\\")
            } else {
                sequence.len() >= 2
            };
            if complete || sequence.len() >= 4096 {
                match sequence.as_slice() {
                    b"\x1b[200~" => {
                        input.desktop_paste = true;
                    }
                    b"\x1b[201~" => {
                        input.desktop_paste = false;
                    }
                    sequence if is_terminal_status_reply(sequence) => {}
                    _ => {
                        input.desktop_editing = true;
                        activity = true;
                    }
                }
                input.desktop_escape.clear();
            }
        } else if byte == 27 {
            input.desktop_escape.push(byte);
        } else {
            input.desktop_editing = input.desktop_paste || !matches!(byte, b'\r' | b'\n');
            activity = true;
        }
    }
    activity
}

fn is_terminal_status_reply(bytes: &[u8]) -> bool {
    let mut remaining = bytes;
    while !remaining.is_empty() {
        if let Some(body) = remaining.strip_prefix(b"\x1b[") {
            let Some(end) = body.iter().position(|byte| (0x40..=0x7e).contains(byte)) else {
                return false;
            };
            let parameters = &body[..end];
            let reply = match body[end] {
                b'R' | b'c' | b'n' | b't' => parameters
                    .iter()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b';' | b'?' | b'>')),
                // DECRPM is xterm's reply to DECRQM (CSI [ ? ] mode $ p).
                // It is a terminal status report, not a human edit. Accept
                // only one numeric mode and one defined status (0..=4).
                b'y' => parameters.strip_suffix(b"$").is_some_and(|parameters| {
                    let parameters = parameters.strip_prefix(b"?").unwrap_or(parameters);
                    let mut fields = parameters.split(|byte| *byte == b';');
                    matches!(
                        (fields.next(), fields.next(), fields.next()),
                        (Some(mode), Some([status]), None)
                            if (1..=5).contains(&mode.len())
                                && mode.iter().all(u8::is_ascii_digit)
                                && (b'0'..=b'4').contains(status)
                    )
                }),
                b'I' | b'O' => parameters.is_empty(),
                _ => false,
            };
            if !reply {
                return false;
            }
            remaining = &body[end + 1..];
        } else if let Some(body) = remaining.strip_prefix(b"\x1b]") {
            let Some(end) = body.iter().position(|byte| *byte == 7 || *byte == 27) else {
                return false;
            };
            let payload = &body[..end];
            if !is_terminal_color_report(payload) {
                return false;
            }
            let terminator = if body[end] == 7 {
                1
            } else if body.get(end + 1) == Some(&b'\\') {
                2
            } else {
                return false;
            };
            remaining = &body[end + terminator..];
        } else {
            return false;
        }
    }
    true
}

fn is_terminal_color_report(payload: &[u8]) -> bool {
    let color = if let Some(palette) = payload.strip_prefix(b"4;") {
        let Some(separator) = palette.iter().position(|byte| *byte == b';') else {
            return false;
        };
        let index = &palette[..separator];
        if !(1..=3).contains(&index.len())
            || !index.iter().all(u8::is_ascii_digit)
            || std::str::from_utf8(index)
                .ok()
                .and_then(|index| index.parse::<u16>().ok())
                .is_none_or(|index| index > 255)
        {
            return false;
        }
        &palette[separator + 1..]
    } else if let Some(color) = [b"10;".as_slice(), b"11;", b"12;"]
        .into_iter()
        .find_map(|prefix| payload.strip_prefix(prefix))
    {
        color
    } else {
        return false;
    };
    let Some(color) = color.strip_prefix(b"rgb:") else {
        return false;
    };
    let mut components = color.split(|byte| *byte == b'/');
    (0..3).all(|_| {
        components.next().is_some_and(|component| {
            (1..=4).contains(&component.len()) && component.iter().all(u8::is_ascii_hexdigit)
        })
    }) && components.next().is_none()
}

/// The caller holds this session's input lock through the readiness check,
/// write and lifecycle change. Never acquire it recursively here.
fn send_bytes_locked(
    sink: &dyn AgentSink,
    registry: &AgentRegistry,
    session_id: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let entry = registry.get(session_id)?;
    entry.startup_gate.observe_input(bytes);
    registry.mark_model_input(session_id, bytes);
    let mut writer = entry.writer.lock().map_err(|error| error.to_string())?;
    writer
        .write_all(bytes)
        .and_then(|_| writer.flush())
        .map_err(|error| format!("Cannot write to the agent terminal: {error}"))?;
    drop(writer);
    record_sent_input(sink, registry, session_id, &entry, bytes);
    Ok(())
}

fn record_sent_input(
    sink: &dyn AgentSink,
    registry: &AgentRegistry,
    session_id: &str,
    entry: &AgentSessionEntry,
    bytes: &[u8],
) {
    let submission = match entry.completion_gate.lock() {
        Ok(mut completion) => completion.observe_input(bytes),
        Err(_) => match prompt_input_shape(bytes) {
            (_, false) => PromptSubmission::None,
            (true, true) => PromptSubmission::Text,
            (false, true) => PromptSubmission::BareEnter,
        },
    };
    if registry.mark_working_from_input(session_id, submission) {
        sink.state(
            session_id,
            AgentLifecycle::Working,
            AgentStateSource::Heuristic,
        );
    }
}

pub(crate) const MCP_DRAFT_RECOVERY_ERROR: &str = "MCP submission could not be confirmed. Inspect the visible draft before typing or retrying; pending input was rejected and nothing was automatically retried.";
const MCP_INPUT_PROFILE_UNSUPPORTED: &str = "Windows Codex automatic MCP input is unsupported for this session: the launch-time default keymap and Vim-off profile was not verified, changed, or has been taken over by human input. No input was sent or queued. Reading output and session cancellation remain available; do not automatically restart or retry.";

fn rejects_interrupted_desktop_input(input: &AgentInputControl, ticket: u64, bytes: &[u8]) -> bool {
    // Only complete, recognized reports bypass this recovery cutoff. Unknown
    // or partial control sequences are rejected rather than guessed as safe.
    ticket <= input.rejected_desktop_through && !is_terminal_status_reply(bytes)
}

fn needs_codex_mcp_submit(
    windows: bool,
    definition_id: &str,
    grant: Option<u64>,
    bytes: &[u8],
) -> bool {
    windows
        && definition_id == "codex"
        && grant.is_some()
        && bytes.starts_with(b"\x1b[200~")
        && bytes.ends_with(b"\x1b[201~\r")
}

#[derive(Debug)]
struct CodexSubmitError {
    draft_may_remain: bool,
}

fn write_codex_mcp_submit(
    writer: &mut dyn Write,
    bytes: &[u8],
    mut authorized_and_alive: impl FnMut() -> bool,
) -> Result<(), CodexSubmitError> {
    if !authorized_and_alive() {
        return Err(CodexSubmitError {
            draft_may_remain: false,
        });
    }
    // Windows ConPTY turns bracketed paste into native Char/Enter events.
    // Default Codex 0.153.4 End flushes a pending paste burst and clears its
    // Enter-suppression window before the following Enter is handled. Native
    // event order survives a delayed consumer; sender-side sleeps do not.
    // The caller must verify the launch-time default keyboard profile first.
    let paste = bytes.strip_suffix(b"\r").ok_or(CodexSubmitError {
        draft_may_remain: false,
    })?;
    writer
        .write_all(paste)
        .and_then(|_| writer.flush())
        .map_err(|_| CodexSubmitError {
            draft_may_remain: true,
        })?;
    if !authorized_and_alive() {
        return Err(CodexSubmitError {
            draft_may_remain: true,
        });
    }
    writer
        .write_all(b"\x1b[F")
        .and_then(|_| writer.flush())
        .map_err(|_| CodexSubmitError {
            draft_may_remain: true,
        })?;
    if !authorized_and_alive() {
        return Err(CodexSubmitError {
            draft_may_remain: true,
        });
    }
    // Exactly one submit; write failures are never retried into a live CLI.
    writer
        .write_all(b"\r")
        .and_then(|_| writer.flush())
        .map_err(|_| CodexSubmitError {
            draft_may_remain: true,
        })
}

/// All immediate and queued MCP writes use the same framing and grant check.
/// The caller holds input through paste/End/Enter; desktop typing can only follow
/// the complete submit, or receive an explicit recovery error after aborting.
fn send_prompt_bytes_locked(
    sink: &dyn AgentSink,
    registry: &AgentRegistry,
    session_id: &str,
    bytes: &[u8],
    grant: Option<u64>,
    input: &mut AgentInputControl,
) -> Result<(), String> {
    let entry = registry.get(session_id)?;
    if !prompt_grant_matches(&entry, grant) || entry.stopping.load(Ordering::Acquire) {
        return Err("This session is not under active MCP control.".to_string());
    }
    let codex_submit = {
        let summary = entry.summary.lock().map_err(|error| error.to_string())?;
        if grant.is_some() {
            require_mcp_input_profile(&entry, &summary.definition_id)?;
        }
        needs_codex_mcp_submit(cfg!(windows), &summary.definition_id, grant, bytes)
    };
    if !codex_submit {
        return send_bytes_locked(sink, registry, session_id, bytes);
    }
    let result = {
        let mut writer = entry.writer.lock().map_err(|error| error.to_string())?;
        write_codex_mcp_submit(writer.as_mut(), bytes, || {
            registry
                .get(session_id)
                .is_ok_and(|current| Arc::ptr_eq(&current, &entry))
                && !entry.stopping.load(Ordering::Acquire)
                && prompt_grant_matches(&entry, grant)
                && mcp_input_profile_valid(&entry)
        })
    };
    if let Err(error) = result {
        if !error.draft_may_remain {
            return Err("The MCP prompt was not written because its original control grant, session, or verified input profile is no longer active.".to_string());
        }
        if error.draft_may_remain {
            input.desktop_editing = true;
            input.rejected_desktop_through = entry.desktop_input_ticket.load(Ordering::Acquire);
            if registry
                .get(session_id)
                .is_ok_and(|current| Arc::ptr_eq(&current, &entry))
            {
                if let Ok(mut summary) = entry.summary.lock() {
                    summary.state = AgentLifecycle::NeedsAttention;
                    summary.state_source = AgentStateSource::Heuristic;
                }
                sink.state(
                    session_id,
                    AgentLifecycle::NeedsAttention,
                    AgentStateSource::Heuristic,
                );
                // Application notice only: do not type it into the CLI or claim
                // it came from the model. Queued-write errors must also be visible.
                let notice = format!("\r\n[LatticeTerm] {MCP_DRAFT_RECOVERY_ERROR}\r\n");
                if let Ok(offset) = registry.record_output(session_id, notice.as_bytes()) {
                    sink.data(session_id, offset, notice.as_bytes());
                }
            }
        }
        return Err(MCP_DRAFT_RECOVERY_ERROR.to_string());
    }
    entry.startup_gate.observe_input(bytes);
    registry.mark_model_input(session_id, bytes);
    record_sent_input(sink, registry, session_id, &entry, bytes);
    Ok(())
}

/// Whether a state change means the session is free to receive a queued
/// prompt.
///
/// Only an integration event counts. A heuristic `Idle` is a guess — the
/// silent-working watchdog produces one after ten minutes of quiet, and a CLI
/// that is merely slow would then be typed into mid-turn.
fn releases_queued_prompt(state: AgentLifecycle, source: AgentStateSource) -> bool {
    source == AgentStateSource::Integration
        && matches!(state, AgentLifecycle::Done | AgentLifecycle::Idle)
}

/// Records how many prompts are still waiting, so the interface can show it.
fn store_queue_depth(registry: &AgentRegistry, session_id: &str, depth: usize) {
    let Ok(entry) = registry.get(session_id) else {
        return;
    };
    let Ok(mut summary) = entry.summary.lock() else {
        return;
    };
    summary.queued_prompts = depth;
}

/// Lines a prompt up behind whatever this session is already doing.
///
/// A session that is already free takes the prompt straight away: queueing it
/// would leave it sitting there until some future integration event that may
/// never come, because nothing is running to produce one.
pub fn enqueue(
    sink: &dyn AgentSink,
    registry: &AgentRegistry,
    session_id: &str,
    encoded: &str,
) -> Result<usize, String> {
    let bytes = decode(encoded)?;
    if bytes.is_empty() {
        return Err("A queued prompt is required.".to_string());
    }
    let entry = registry.get(session_id)?;
    let ticket = next_desktop_input_ticket(&entry, &bytes)?;
    let mut input = entry.input.lock().map_err(|error| error.to_string())?;
    if rejects_interrupted_desktop_input(&input, ticket, &bytes) {
        return Err(MCP_DRAFT_RECOVERY_ERROR.to_string());
    }
    discard_profile_invalidated_queue(sink, registry, session_id, &entry);
    enqueue_locked(sink, registry, session_id, bytes, None, &mut input)
}

fn publish_mcp_input_notice(
    sink: &dyn AgentSink,
    registry: &AgentRegistry,
    id: &str,
    message: &str,
) {
    let notice = format!("\r\n[LatticeTerm] {message}\r\n");
    if let Ok(offset) = registry.record_output(id, notice.as_bytes()) {
        sink.data(id, offset, notice.as_bytes());
    }
}

fn discard_profile_invalidated_queue(
    sink: &dyn AgentSink,
    registry: &AgentRegistry,
    id: &str,
    entry: &AgentSessionEntry,
) {
    if cfg!(windows)
        && entry.mcp_input_profile_invalidated.load(Ordering::Acquire)
        && entry
            .summary
            .lock()
            .is_ok_and(|summary| summary.definition_id == "codex")
        && clear_queue_locked(sink, registry, id, true).is_ok_and(|count| count > 0)
    {
        publish_mcp_input_notice(sink, registry, id,
            "Pending MCP prompts were cancelled because this Windows Codex session's input profile is no longer verified. Human input remains available; nothing was automatically retried.");
    }
}

fn enqueue_locked(
    sink: &dyn AgentSink,
    registry: &AgentRegistry,
    session_id: &str,
    bytes: Vec<u8>,
    mcp_grant_epoch: Option<u64>,
    input: &mut AgentInputControl,
) -> Result<usize, String> {
    let entry = registry.get(session_id)?;

    let (state, source, definition_id) = {
        let summary = entry.summary.lock().map_err(|error| error.to_string())?;
        (
            summary.state,
            summary.state_source,
            summary.definition_id.clone(),
        )
    };
    let queue_is_empty = entry
        .queued_prompts
        .lock()
        .map(|queue| queue.is_empty())
        .unwrap_or(false);
    if queue_is_empty
        && !input.desktop_busy()
        && !input.startup_seed_pending
        && releases_queued_prompt(state, source)
    {
        if !prompt_grant_matches(&entry, mcp_grant_epoch) {
            return Err("This session is not under MCP control.".to_string());
        }
        send_prompt_bytes_locked(sink, registry, session_id, &bytes, mcp_grant_epoch, input)?;
        return Ok(0);
    }

    let depth = {
        let mut queue = entry
            .queued_prompts
            .lock()
            .map_err(|error| error.to_string())?;
        if !prompt_grant_matches(&entry, mcp_grant_epoch) {
            return Err("This session is not under MCP control.".to_string());
        }
        if queue.len() >= MAX_QUEUED_PROMPTS {
            return Err(format!(
                "This agent already has {MAX_QUEUED_PROMPTS} prompts waiting."
            ));
        }
        if mcp_grant_epoch.is_some() {
            // Human input/cancellation can arrive after the expensive source
            // check while this call waits for the queue. Recheck only cheap
            // state here, without taking summary while holding the queue lock.
            if !registry
                .get(session_id)
                .is_ok_and(|current| Arc::ptr_eq(&current, &entry))
                || entry.stopping.load(Ordering::Acquire)
                || !prompt_grant_matches(&entry, mcp_grant_epoch)
            {
                return Err("This session is not under active MCP control.".to_string());
            }
            require_mcp_input_profile(&entry, &definition_id)?;
        }
        queue.push_back(QueuedPrompt {
            bytes,
            mcp_grant_epoch,
        });
        queue.len()
    };
    store_queue_depth(registry, session_id, depth);
    sink.queue(session_id, depth);
    Ok(depth)
}

/// Drops everything still waiting for this session and reports how many went.
pub fn clear_queue(
    sink: &dyn AgentSink,
    registry: &AgentRegistry,
    session_id: &str,
) -> Result<usize, String> {
    let entry = registry.get(session_id)?;
    let _input = entry.input.lock().map_err(|error| error.to_string())?;
    clear_queue_locked(sink, registry, session_id, false)
}

fn clear_queue_locked(
    sink: &dyn AgentSink,
    registry: &AgentRegistry,
    session_id: &str,
    mcp_only: bool,
) -> Result<usize, String> {
    let entry = registry.get(session_id)?;
    let (dropped, depth) = {
        let mut queue = entry
            .queued_prompts
            .lock()
            .map_err(|error| error.to_string())?;
        let before = queue.len();
        queue.retain(|prompt| mcp_only && prompt.mcp_grant_epoch.is_none());
        (before - queue.len(), queue.len())
    };
    store_queue_depth(registry, session_id, depth);
    sink.queue(session_id, depth);
    Ok(dropped)
}

/// Hands the next waiting prompt to a session whose turn just ended.
///
/// Called only from the one place an integration state change is published,
/// so a heuristic guess can never trigger a delivery.
fn deliver_next_queued(sink: &dyn AgentSink, registry: &AgentRegistry, session_id: &str) {
    let Ok(entry) = registry.get(session_id) else {
        return;
    };
    let Ok(mut input) = entry.input.lock() else {
        return;
    };
    let ready = entry
        .summary
        .lock()
        .map(|summary| releases_queued_prompt(summary.state, summary.state_source))
        .unwrap_or(false);
    if input.desktop_busy() || input.startup_seed_pending || !ready {
        return;
    }
    let next = {
        let Ok(mut queue) = entry.queued_prompts.lock() else {
            return;
        };
        queue.retain(|prompt| prompt_grant_matches(&entry, prompt.mcp_grant_epoch));
        queue.pop_front()
    };
    let Some(prompt) = next else {
        return;
    };
    let depth = entry
        .queued_prompts
        .lock()
        .map(|queue| queue.len())
        .unwrap_or(0);
    store_queue_depth(registry, session_id, depth);
    sink.queue(session_id, depth);
    // A write that fails means the PTY is gone; the remaining prompts are
    // dropped with the session rather than retried into a dead terminal.
    let is_mcp = prompt.mcp_grant_epoch.is_some();
    if let Err(error) = send_queued_prompt_locked(sink, registry, session_id, prompt, &mut input) {
        if is_mcp && error != MCP_DRAFT_RECOVERY_ERROR {
            let _ = clear_queue_locked(sink, registry, session_id, true);
            publish_mcp_input_notice(sink, registry, session_id,
                "A queued MCP prompt could not be delivered safely. Remaining MCP prompts were cancelled; nothing was automatically retried. Check this session's control grant and verified input profile before trying again.");
        }
    }
}

/// The caller holds input, but revocation remains out-of-band. Recheck the
/// original grant immediately before writing, including after dequeueing.
fn send_queued_prompt_locked(
    sink: &dyn AgentSink,
    registry: &AgentRegistry,
    session_id: &str,
    prompt: QueuedPrompt,
    input: &mut AgentInputControl,
) -> Result<bool, String> {
    let entry = registry.get(session_id)?;
    if !prompt_grant_matches(&entry, prompt.mcp_grant_epoch) {
        return Ok(false);
    }
    if prompt.mcp_grant_epoch.is_some() {
        revalidate_mcp_input_profile(
            &entry,
            &entry
                .summary
                .lock()
                .map_err(|error| error.to_string())?
                .definition_id,
        )?;
    }
    send_prompt_bytes_locked(
        sink,
        registry,
        session_id,
        &prompt.bytes,
        prompt.mcp_grant_epoch,
        input,
    )?;
    Ok(true)
}

/// Revoke before touching the queue, without waiting for a blocked PTY
/// writer. Already accepted writes cannot be undone, but can still be stopped.
pub fn set_mcp_control(
    sink: &dyn AgentSink,
    registry: &AgentRegistry,
    session_id: &str,
    enabled: bool,
) -> Result<usize, String> {
    let entry = registry.get(session_id)?;
    let _ = entry
        .mcp_grant_epoch
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |epoch| {
            ((epoch & 1 == 1) != enabled).then(|| epoch.wrapping_add(1))
        });
    if enabled {
        Ok(0)
    } else {
        clear_queue_locked(sink, registry, session_id, true)
    }
}

/// Natural-language MCP prompts never carry arbitrary terminal key input.
/// Even immediate delivery requires an official ready report, and never
/// appends to a prompt the user is editing.
pub fn mcp_prompt(
    sink: &dyn AgentSink,
    registry: &AgentRegistry,
    session_id: &str,
    text: &str,
    send_now: bool,
) -> Result<usize, String> {
    mcp_prompt_with_grant_observer(sink, registry, session_id, text, send_now, || {})
}

// The no-op production observer lets regression tests pause at the exact
// original-grant boundary, without sleeps or a global cross-test hook.
fn mcp_prompt_with_grant_observer(
    sink: &dyn AgentSink,
    registry: &AgentRegistry,
    session_id: &str,
    text: &str,
    send_now: bool,
    after_grant_snapshot: impl FnOnce(),
) -> Result<usize, String> {
    let bytes = mcp_prompt_payload(text)?;
    let entry = registry.get(session_id)?;
    // Remember the grant when this call enters, not after it waits behind a
    // split write. Re-granting cannot revive an already-waiting MCP request.
    let grant_epoch = current_mcp_grant(&entry)
        .ok_or_else(|| "This session is not under MCP control.".to_string())?;
    validate_mcp_prompt_transport(
        cfg!(windows),
        &entry
            .summary
            .lock()
            .map_err(|error| error.to_string())?
            .definition_id,
        text,
    )?;
    require_mcp_input_profile(
        &entry,
        &entry
            .summary
            .lock()
            .map_err(|error| error.to_string())?
            .definition_id,
    )?;
    after_grant_snapshot();
    let mut input = entry.input.lock().map_err(|error| error.to_string())?;
    if !prompt_grant_matches(&entry, Some(grant_epoch)) {
        return Err("This session is not under the original MCP control grant.".to_string());
    }
    revalidate_mcp_input_profile(
        &entry,
        &entry
            .summary
            .lock()
            .map_err(|error| error.to_string())?
            .definition_id,
    )?;
    if send_now {
        let summary = entry.summary.lock().map_err(|error| error.to_string())?;
        if input.desktop_busy()
            || input.startup_seed_pending
            || !releases_queued_prompt(summary.state, summary.state_source)
        {
            return Err("The CLI has not confirmed it is ready, or the user is editing its prompt. Queue the prompt or wait for an official idle/done report.".to_string());
        }
        if !entry
            .queued_prompts
            .lock()
            .map_err(|error| error.to_string())?
            .is_empty()
        {
            return Err(
                "This session already has queued prompts. Use queue mode to preserve their order."
                    .to_string(),
            );
        }
        drop(summary);
        if !prompt_grant_matches(&entry, Some(grant_epoch)) {
            return Err("This session is not under MCP control.".to_string());
        }
        send_prompt_bytes_locked(
            sink,
            registry,
            session_id,
            &bytes,
            Some(grant_epoch),
            &mut input,
        )?;
        Ok(0)
    } else {
        enqueue_locked(
            sink,
            registry,
            session_id,
            bytes,
            Some(grant_epoch),
            &mut input,
        )
    }
}

fn mcp_prompt_payload(text: &str) -> Result<Vec<u8>, String> {
    validate_mcp_prompt(text)?;
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    Ok(startup_seed_payload(&text))
}

fn seed_preserves_codex_input_profile(seed: Option<&str>) -> bool {
    seed.is_none_or(|seed| {
        seed.trim().is_empty()
            || (validate_mcp_prompt(seed).is_ok()
                && validate_mcp_prompt_transport(true, "codex", seed).is_ok())
    })
}

fn validate_mcp_prompt_transport(
    windows: bool,
    definition_id: &str,
    text: &str,
) -> Result<(), String> {
    // ConPTY turns body LF/Tab into native Enter/Tab events. Codex can treat
    // them as submission keys before paste-burst detection becomes active.
    // Reject before enqueueing; never silently rewrite a controlled prompt.
    if windows
        && definition_id == "codex"
        && (text.contains(['\r', '\n', '\t', '@', '$'])
            || text.starts_with('?')
            || text.trim_start().starts_with(['/', '!']))
    {
        return Err(
            "Windows Codex MCP requires a single-line prompt without carriage returns, newlines, tabs, @ or $. Leading slash and ! commands, and text starting with ?, are unsupported. No input was sent or queued; do not silently rewrite rejected text."
                .to_string(),
        );
    }
    Ok(())
}

pub(crate) fn validate_mcp_prompt(text: &str) -> Result<(), String> {
    if text.trim().is_empty() || text.chars().count() > crate::agent_daemon::MAX_MCP_PROMPT_CHARS {
        return Err("A prompt must contain 1 to 16000 characters.".to_string());
    }
    if text
        .chars()
        .any(|ch| ch.is_control() && !matches!(ch, '\r' | '\n' | '\t'))
    {
        return Err("A prompt must not contain terminal control characters.".to_string());
    }
    Ok(())
}

pub fn mcp_cancel_queue(
    sink: &dyn AgentSink,
    registry: &AgentRegistry,
    session_id: &str,
) -> Result<usize, String> {
    let entry = registry.get(session_id)?;
    if current_mcp_grant(&entry).is_none() {
        return Err("This session is not under MCP control.".to_string());
    }
    clear_queue_locked(sink, registry, session_id, true)
}

pub fn mcp_disconnect(
    sink: &dyn AgentSink,
    registry: &AgentRegistry,
    session_id: &str,
) -> Result<(), String> {
    let entry = registry.get(session_id)?;
    if current_mcp_grant(&entry).is_none() {
        return Err("This session is not under MCP control.".to_string());
    }
    disconnect_locked(sink, registry, session_id, &entry)
}

pub fn broadcast(
    sink: &dyn AgentSink,
    registry: &AgentRegistry,
    session_ids: &[String],
    encoded: &str,
) -> Result<Vec<AgentBroadcastOutcome>, String> {
    if session_ids.is_empty() {
        return Err("Select at least one agent session.".to_string());
    }
    if session_ids.len() > MAX_BROADCAST_TARGETS {
        return Err(format!(
            "A broadcast may target at most {MAX_BROADCAST_TARGETS} agent sessions."
        ));
    }

    let mut unique = HashSet::with_capacity(session_ids.len());
    for session_id in session_ids {
        if session_id.trim() != session_id
            || validate_text(session_id, "Agent session", 128).is_err()
        {
            return Err("An agent session ID is invalid.".to_string());
        }
        if !unique.insert(session_id.as_str()) {
            return Err("A broadcast cannot contain duplicate agent sessions.".to_string());
        }
    }

    let bytes = decode(encoded)?;
    if bytes.is_empty() {
        return Err("A broadcast prompt is required.".to_string());
    }

    Ok(session_ids
        .iter()
        .map(
            |session_id| match send_bytes(sink, registry, session_id, &bytes) {
                Ok(()) => AgentBroadcastOutcome {
                    session_id: session_id.clone(),
                    delivered: true,
                    error: None,
                },
                Err(error) => AgentBroadcastOutcome {
                    session_id: session_id.clone(),
                    delivered: false,
                    error: Some(error),
                },
            },
        )
        .collect())
}

pub fn resize(
    registry: &AgentRegistry,
    session_id: &str,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let size = validated_size(cols, rows)?;
    let entry = registry.get(session_id)?;
    let result = entry
        .master
        .lock()
        .map_err(|error| error.to_string())?
        .resize(size)
        .map_err(|error| format!("Cannot resize the agent terminal: {error}"));
    result
}

pub fn disconnect(
    sink: &dyn AgentSink,
    registry: &AgentRegistry,
    session_id: &str,
) -> Result<(), String> {
    // Removing a session the registry no longer holds is a success, not a
    // failure: a CLI that already exited has nothing left to stop, and the
    // caller only wants it gone.
    let Ok(entry) = registry.get(session_id) else {
        return Ok(());
    };
    disconnect_locked(sink, registry, session_id, &entry)
}

fn disconnect_locked(
    sink: &dyn AgentSink,
    registry: &AgentRegistry,
    session_id: &str,
    entry: &AgentSessionEntry,
) -> Result<(), String> {
    terminate_agent_entry(entry)?;
    if registry.remove(session_id).is_some() {
        sink.closed(session_id, "Stopped by user");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_dripping_report_cannot_extend_the_message_deadline() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let peer = std::thread::spawn(move || {
            let mut stream = std::net::TcpStream::connect(address).unwrap();
            for _ in 0..20 {
                if std::io::Write::write_all(&mut stream, b"x").is_err() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        });
        let (mut stream, _) = listener.accept().unwrap();
        let result = super::read_report_payload(&mut stream, std::time::Duration::from_millis(100));
        assert!(
            result.is_err(),
            "partial reads must not restart the message deadline"
        );
        drop(stream);
        peer.join().unwrap();
    }

    #[test]
    fn a_saved_plan_keeps_its_background_choice_through_restore() {
        let directory = tempfile::tempdir().unwrap();
        let plan = normalize_launch_plan(
            "plan-bg".to_string(),
            AgentLaunchPlanDraft {
                definition_id: "codex".to_string(),
                label: "night batch".to_string(),
                executable: String::new(),
                arguments: vec![],
                resume_session_id: None,
                note: String::new(),
                sandbox: false,
                detached: true,
                working_directory: directory.path().display().to_string(),
            },
        )
        .unwrap();
        assert!(plan.detached);
        let request = launch_request_from_plan(&plan, 120, 32).unwrap();
        assert!(request.detached);
        let json = serde_json::to_string(&plan).unwrap();
        assert!(json.contains("\"detached\":true"));
        // An older plan file without the field restores into the desktop.
        let legacy: AgentLaunchPlan =
            serde_json::from_str(&json.replace(",\"detached\":true", "")).unwrap();
        assert!(!legacy.detached);
    }

    #[test]
    fn account_profile_status_reads_only_the_profile_directory() {
        let root = tempfile::tempdir().expect("tempdir");
        let codex = root.path().join("codex");
        std::fs::create_dir_all(&codex).unwrap();
        assert_eq!(
            account_profile_status("codex", &codex).state,
            AgentAccountState::SignedOut
        );
        std::fs::write(codex.join("auth.json"), r#"{"auth_mode":"chatgpt"}"#).unwrap();
        let info = account_profile_status("codex", &codex);
        assert_eq!(info.state, AgentAccountState::SignedIn);
        assert_eq!(info.method.as_deref(), Some("ChatGPT"));

        let claude = root.path().join("claude");
        std::fs::create_dir_all(&claude).unwrap();
        assert_eq!(
            account_profile_status("claude", &claude).state,
            AgentAccountState::SignedOut
        );
        std::fs::write(claude.join(".credentials.json"), "{}").unwrap();
        assert_eq!(
            account_profile_status("claude", &claude).state,
            AgentAccountState::SignedIn
        );
        std::fs::write(
            claude.join(".claude.json"),
            r#"{"oauthAccount":{"emailAddress":"person@example.com"}}"#,
        )
        .unwrap();
        assert_eq!(
            account_profile_status("claude", &claude).label.as_deref(),
            Some("person@example.com")
        );

        assert_eq!(
            account_profile_status("gemini", &claude).state,
            AgentAccountState::Unsupported
        );
        assert_eq!(
            account_profile_status("codex", &root.path().join("missing")).state,
            AgentAccountState::Unknown
        );
        assert_eq!(
            account_profile_status("codex", Path::new("relative")).state,
            AgentAccountState::Unknown
        );
    }

    #[test]
    fn removing_a_profile_directory_only_touches_the_managed_shape() {
        let data = tempfile::tempdir().expect("tempdir");
        let created = account_profile_directory(data.path(), "codex", "abc-123").unwrap();
        std::fs::write(created.join("auth.json"), "{}").unwrap();
        assert!(remove_account_profile_directory(data.path(), "codex", "abc-123").unwrap());
        assert!(!created.exists());
        assert!(!remove_account_profile_directory(data.path(), "codex", "abc-123").unwrap());
        assert!(remove_account_profile_directory(data.path(), "codex", "../x").is_err());
        assert!(remove_account_profile_directory(data.path(), "gemini", "abc").is_err());
        assert!(data.path().join("agent-profiles").join("codex").is_dir());
    }

    #[test]
    fn preparing_sandbox_state_creates_only_the_missing_empty_state() {
        let home = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(home.path().join(".claude")).unwrap();
        std::fs::write(home.path().join(".claude/settings.json"), "{\"kept\":true}").unwrap();

        prepare_sandbox_state("claude", home.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(home.path().join(".claude.json")).unwrap(),
            "{}\n"
        );
        assert_eq!(
            std::fs::read_to_string(home.path().join(".claude/settings.json")).unwrap(),
            "{\"kept\":true}"
        );
        assert_eq!(
            std::fs::read_to_string(home.path().join(".claude/settings.local.json")).unwrap(),
            "{}\n"
        );
        assert!(home.path().join(".cache").is_dir());
        assert!(home.path().join(".local/state").is_dir());

        std::fs::write(home.path().join(".claude.json"), "{\"mine\":1}").unwrap();
        prepare_sandbox_state("claude", home.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(home.path().join(".claude.json")).unwrap(),
            "{\"mine\":1}"
        );

        prepare_sandbox_state("aider", home.path()).unwrap();
        assert!(home.path().join(".aider").is_dir());
        assert!(!home.path().join(".aider.conf.yml").exists());
    }
    use super::*;
    use std::collections::{HashMap, HashSet};
    use std::time::{Duration, Instant};

    #[derive(Default)]
    struct TestSink {
        data: Mutex<Vec<u8>>,
        session_data: Mutex<HashMap<String, Vec<u8>>>,
        chunks: Mutex<Vec<(String, u64, Vec<u8>)>>,
        states: Mutex<Vec<(String, AgentLifecycle, AgentStateSource)>>,
        closed: Mutex<Vec<String>>,
        captured: Mutex<Vec<(String, String)>>,
        models: Mutex<Vec<(String, String)>>,
        usages: Mutex<Vec<(String, AgentTokenUsage)>>,
        queues: Mutex<Vec<(String, usize)>>,
    }

    impl AgentSink for TestSink {
        fn data(&self, session_id: &str, offset: u64, bytes: &[u8]) {
            self.data.lock().unwrap().extend_from_slice(bytes);
            self.chunks
                .lock()
                .unwrap()
                .push((session_id.to_string(), offset, bytes.to_vec()));
            self.session_data
                .lock()
                .unwrap()
                .entry(session_id.to_string())
                .or_default()
                .extend_from_slice(bytes);
        }

        fn state(&self, session_id: &str, state: AgentLifecycle, source: AgentStateSource) {
            self.states
                .lock()
                .unwrap()
                .push((session_id.to_string(), state, source));
        }

        fn closed(&self, _session_id: &str, reason: &str) {
            self.closed.lock().unwrap().push(reason.to_string());
        }

        fn captured(&self, session_id: &str, native_session_id: &str) {
            self.captured
                .lock()
                .unwrap()
                .push((session_id.to_string(), native_session_id.to_string()));
        }

        fn model(&self, session_id: &str, model: &str) {
            self.models
                .lock()
                .unwrap()
                .push((session_id.to_string(), model.to_string()));
        }

        fn usage(&self, session_id: &str, token_usage: &AgentTokenUsage) {
            self.usages
                .lock()
                .unwrap()
                .push((session_id.to_string(), token_usage.clone()));
        }

        fn queue(&self, session_id: &str, queued_prompts: usize) {
            self.queues
                .lock()
                .unwrap()
                .push((session_id.to_string(), queued_prompts));
        }
    }

    #[test]
    fn ansi_noise_is_stripped_before_matching() {
        let noisy = "\u{1b}[1;32msession id:\u{1b}[0m \u{1b}]0;title\u{7}0199aa11-bb22-4c33-8d44-ee55ff667788";
        let cleaned = strip_ansi(noisy);
        assert_eq!(cleaned, "session id: 0199aa11-bb22-4c33-8d44-ee55ff667788");
    }

    #[test]
    fn a_uuid_near_the_word_session_is_captured() {
        assert_eq!(
            find_native_session_id("session id: 0199AA11-BB22-4C33-8D44-EE55FF667788").as_deref(),
            Some("0199aa11-bb22-4c33-8d44-ee55ff667788")
        );
        assert_eq!(
            find_native_session_id("Resuming session 0199aa11-bb22-4c33-8d44-ee55ff667788 now")
                .as_deref(),
            Some("0199aa11-bb22-4c33-8d44-ee55ff667788")
        );
    }

    #[test]
    fn antigravity_log_capture_requires_the_created_conversation_record() {
        assert_eq!(
            find_antigravity_conversation_id(
                "I0901 server.go:1153] Created conversation 0199AA11-BB22-4C33-8D44-EE55FF667788"
            )
            .as_deref(),
            Some("0199aa11-bb22-4c33-8d44-ee55ff667788")
        );
        assert!(find_antigravity_conversation_id(
            "Loading project 0199aa11-bb22-4c33-8d44-ee55ff667788"
        )
        .is_none());
        assert!(find_antigravity_conversation_id("Created conversation not-a-uuid").is_none());
    }

    #[test]
    fn antigravity_capture_log_preserves_an_explicit_log_file() {
        let mut arguments = vec!["--model".to_string(), "auto".to_string()];
        let log = antigravity_capture_log(&mut arguments).unwrap().unwrap();
        assert_eq!(arguments[0], "--log-file");
        assert_eq!(PathBuf::from(&arguments[1]), log.path);

        let mut explicit = vec!["--log-file=chosen.log".to_string()];
        assert!(antigravity_capture_log(&mut explicit).unwrap().is_none());
        assert_eq!(explicit, vec!["--log-file=chosen.log"]);
    }

    #[test]
    fn an_id_split_across_chunks_is_still_captured_once() {
        let mut capture = CaptureState {
            enabled: true,
            buffer: String::new(),
        };
        assert!(capture
            .feed(
                b"starting up...
session id: 0199aa11-"
            )
            .is_none());
        let found = capture.feed(
            b"bb22-4c33-8d44-ee55ff667788
",
        );
        assert_eq!(
            found.as_deref(),
            Some("0199aa11-bb22-4c33-8d44-ee55ff667788")
        );
        // Once captured, later output is no longer scanned.
        assert!(capture
            .feed(b"session id: 99998888-7777-4666-8555-444433332222")
            .is_none());
    }

    #[test]
    fn a_disabled_capture_never_matches() {
        let mut capture = CaptureState {
            enabled: false,
            buffer: String::new(),
        };
        assert!(capture
            .feed(b"session id: 0199aa11-bb22-4c33-8d44-ee55ff667788")
            .is_none());
    }

    #[test]
    fn a_uuid_without_session_context_is_not_trusted() {
        assert!(
            find_native_session_id("request 0199aa11-bb22-4c33-8d44-ee55ff667788 finished")
                .is_none()
        );
        assert!(find_native_session_id("session id: not-a-uuid").is_none());
        // "session" appearing far away does not vouch for the id.
        let far = format!(
            "session opened{}0199aa11-bb22-4c33-8d44-ee55ff667788",
            " ".repeat(100)
        );
        assert!(find_native_session_id(&far).is_none());
    }

    #[test]
    fn model_capture_requires_cli_status_shaped_output() {
        assert_eq!(
            find_model_name("codex", "│ model: gpt-5.3-codex xhigh │").as_deref(),
            Some("gpt-5.3-codex")
        );
        assert_eq!(
            find_model_name("codex", "gpt-5.6-sol xhigh · ~/project").as_deref(),
            Some("gpt-5.6-sol")
        );
        assert_eq!(
            find_model_name("claude", "Claude Sonnet 4.6 · API Usage Billing").as_deref(),
            Some("Claude Sonnet 4.6")
        );
        assert!(find_model_name("codex", "please review the model layer").is_none());
    }

    #[test]
    fn account_parsers_return_identity_metadata_without_credentials() {
        let claims = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(r#"{"email":"developer@example.com"}"#);
        let codex = codex_account_from_json(
            &serde_json::json!({
                "auth_mode": "chatgpt",
                "tokens": {
                    "id_token": format!("header.{claims}.signature"),
                    "access_token": "must-not-escape"
                }
            })
            .to_string(),
        );
        assert_eq!(codex.state, AgentAccountState::SignedIn);
        assert_eq!(codex.label.as_deref(), Some("developer@example.com"));
        assert_eq!(codex.method.as_deref(), Some("ChatGPT"));
        assert!(!format!("{codex:?}").contains("must-not-escape"));

        let claude = claude_account_from_json(
            r#"{"oauthAccount":{"emailAddress":"claude@example.com"},"token":"secret"}"#,
        );
        assert_eq!(claude.label.as_deref(), Some("claude@example.com"));
        assert_eq!(claude.method.as_deref(), Some("Claude.ai"));

        let gemini =
            gemini_account_from_json(r#"{"active":"gemini@example.com","oauth":"secret"}"#);
        assert_eq!(gemini.label.as_deref(), Some("gemini@example.com"));
        assert_eq!(gemini.method.as_deref(), Some("Google"));
    }

    #[test]
    fn gemini_auth_parser_distinguishes_personal_oauth_from_other_modes() {
        assert_eq!(
            gemini_auth_type_from_json(
                r#"{"security":{"auth":{"selectedType":"oauth-personal"}}}"#,
            )
            .as_deref(),
            Some("oauth-personal")
        );
        assert_eq!(
            gemini_auth_type_from_json(r#"{"selectedAuthType":"gemini-api-key"}"#).as_deref(),
            Some("gemini-api-key")
        );
        assert!(gemini_auth_type_from_json(r#"{"security":{"auth":{}}}"#).is_none());
    }

    #[test]
    fn deprecated_personal_gemini_launches_migrate_without_reusing_native_ids() {
        let request = AgentLaunchRequest {
            definition_id: "gemini".to_string(),
            label: "Gemini CLI".to_string(),
            executable: "gemini".to_string(),
            arguments: vec!["--resume".to_string(), "legacy-session".to_string()],
            resume_session_id: Some("legacy-session".to_string()),
            group_id: Some("google-project".to_string()),
            seed_input: None,
            restore_existing_session: true,
            profile_config_path: None,
            sandbox: false,
            detached: false,
            working_directory: std::env::current_dir().unwrap().display().to_string(),
            cols: 120,
            rows: 32,
        };

        let migrated = migrate_deprecated_google_consumer_request(&request, true).unwrap();
        assert_eq!(migrated.definition_id, "antigravity");
        assert_eq!(migrated.label, "Google Antigravity CLI");
        assert_eq!(migrated.executable, "agy");
        assert!(migrated.arguments.is_empty());
        assert!(migrated.resume_session_id.is_none());
        assert_eq!(migrated.group_id.as_deref(), Some("google-project"));

        let unchanged = migrate_deprecated_google_consumer_request(&request, false).unwrap();
        assert_eq!(unchanged.definition_id, "gemini");
        assert_eq!(
            unchanged.resume_session_id.as_deref(),
            Some("legacy-session")
        );
    }

    #[test]
    fn explicit_gemini_arguments_require_a_manual_antigravity_restart() {
        let request = AgentLaunchRequest {
            definition_id: "gemini".to_string(),
            label: String::new(),
            executable: String::new(),
            arguments: vec!["--model".to_string(), "gemini-2.5-pro".to_string()],
            resume_session_id: None,
            group_id: None,
            seed_input: None,
            restore_existing_session: false,
            profile_config_path: None,
            sandbox: false,
            detached: false,
            working_directory: std::env::current_dir().unwrap().display().to_string(),
            cols: 120,
            rows: 32,
        };

        assert!(migrate_deprecated_google_consumer_request(&request, true)
            .unwrap_err()
            .contains("cannot be migrated safely"));
    }

    #[test]
    fn workspace_instructions_precede_handoffs_but_skip_custom_commands() {
        let mut request = AgentLaunchRequest {
            definition_id: "codex".to_string(),
            label: String::new(),
            executable: String::new(),
            arguments: Vec::new(),
            resume_session_id: None,
            group_id: None,
            seed_input: Some("Continue the previous review.".to_string()),
            restore_existing_session: false,
            profile_config_path: None,
            sandbox: false,
            detached: false,
            working_directory: std::env::current_dir().unwrap().display().to_string(),
            cols: 120,
            rows: 32,
        };
        apply_startup_instructions(&mut request, "Use Traditional Chinese commits.").unwrap();
        assert_eq!(
            request.seed_input.as_deref(),
            Some("Use Traditional Chinese commits.\n\n---\n\nContinue the previous review.")
        );

        request.definition_id = "custom".to_string();
        request.seed_input = None;
        apply_startup_instructions(&mut request, "Never send this to installers.").unwrap();
        assert!(request.seed_input.is_none());

        request.definition_id = "codex".to_string();
        request.restore_existing_session = true;
        apply_startup_instructions(&mut request, "Do not repeat this in resumed work.").unwrap();
        assert!(request.seed_input.is_none());
    }

    #[test]
    fn startup_seed_waits_for_each_terminal_instead_of_a_shared_delay() {
        let started_at = Instant::now();
        let mut fast = StartupReadiness::default();
        let slow = StartupReadiness::default();
        fast.observe(b"loading\x1b[?20", started_at + Duration::from_millis(80));
        let prompt_at = started_at + Duration::from_millis(100);
        fast.observe(b"04h", prompt_at);

        assert!(!fast.should_deliver(
            started_at,
            prompt_at + STARTUP_SEED_PROMPT_SETTLE - Duration::from_millis(1)
        ));
        assert!(!fast.should_deliver(started_at, prompt_at + STARTUP_SEED_PROMPT_SETTLE));
        assert!(fast.should_deliver(started_at, started_at + STARTUP_SEED_MIN_WAIT));
        assert!(!slow.should_deliver(started_at, started_at + STARTUP_SEED_MIN_WAIT));

        let mut noisy = StartupReadiness::default();
        let mut prompt_then_screen = b"\x1b[?2004h".to_vec();
        prompt_then_screen.extend(vec![b'x'; STARTUP_CONTROL_WINDOW_BYTES * 2]);
        noisy.observe(&prompt_then_screen, prompt_at);
        assert!(noisy.should_deliver(started_at, started_at + STARTUP_SEED_MIN_WAIT));
    }

    #[test]
    fn startup_seed_clock_excludes_configuration_preflight() {
        let preflight_started_at = Instant::now();
        let launched_at = preflight_started_at + STARTUP_SEED_TIMEOUT + Duration::from_secs(5);
        let mut readiness = StartupReadiness::default();
        let prompt_at = launched_at + Duration::from_millis(1);

        assert!(readiness.should_deliver(preflight_started_at, prompt_at));
        assert!(!readiness.should_deliver(launched_at, prompt_at));
        readiness.observe(b"\x1b[?2004h", prompt_at);
        assert!(!readiness.should_deliver(
            launched_at,
            launched_at + STARTUP_SEED_MIN_WAIT - Duration::from_millis(1)
        ));
        assert!(readiness.should_deliver(launched_at, launched_at + STARTUP_SEED_MIN_WAIT));
    }

    #[test]
    fn startup_seed_waits_for_a_folder_trust_decision() {
        let started_at = Instant::now();
        let mut readiness = StartupReadiness::default();
        readiness.observe(b"\x1b[?2004h", started_at + Duration::from_millis(100));
        readiness.observe(
            b"Do you trust the contents of this directory?",
            started_at + Duration::from_millis(400),
        );

        assert!(!readiness.should_deliver(
            started_at,
            started_at + STARTUP_SEED_TIMEOUT + Duration::from_secs(1)
        ));

        let answered_at = started_at + Duration::from_secs(22);
        readiness.observe_input(b"\r", answered_at);
        readiness.observe(
            b"Ask Codex to do anything",
            answered_at + Duration::from_millis(100),
        );
        assert!(!readiness.should_deliver(
            started_at,
            answered_at + STARTUP_SEED_MIN_WAIT - Duration::from_millis(1)
        ));
        assert!(readiness.should_deliver(started_at, answered_at + STARTUP_SEED_MIN_WAIT));
    }

    #[test]
    fn startup_seed_fallback_requires_output_to_settle() {
        let started_at = Instant::now();
        let mut readiness = StartupReadiness::default();
        let last_output_at = started_at + STARTUP_SEED_MIN_WAIT;
        readiness.observe(b"CLI startup without bracketed paste", last_output_at);

        assert!(!readiness.should_deliver(
            started_at,
            last_output_at + STARTUP_SEED_OUTPUT_QUIET - Duration::from_millis(1)
        ));
        assert!(readiness.should_deliver(started_at, last_output_at + STARTUP_SEED_OUTPUT_QUIET));
    }

    #[test]
    fn startup_seed_payload_preserves_the_full_unicode_prompt() {
        let seed = "請使用繁體中文。\n第二行不可截斷。";
        let payload = startup_seed_payload(seed);
        assert_eq!(
            String::from_utf8(payload).unwrap(),
            format!("\u{1b}[200~{seed}\u{1b}[201~\r")
        );
    }

    #[test]
    fn a_bare_enter_is_not_a_submitted_prompt() {
        let mut readiness = CompletionReadiness::default();

        // Accepting a folder-trust dialog: arrow keys and Enter, no text.
        assert_eq!(readiness.observe_input(b"\x1b[B"), PromptSubmission::None);
        assert_eq!(readiness.observe_input(b"\r"), PromptSubmission::BareEnter);

        // Editing keys alone still do not submit anything.
        assert_eq!(
            readiness.observe_input(b"\x1b[A\x7f"),
            PromptSubmission::None
        );
        assert_eq!(readiness.observe_input(b"\r"), PromptSubmission::BareEnter);

        // Text typed across several reads is remembered until Enter arrives.
        assert_eq!(readiness.observe_input(b"review "), PromptSubmission::None);
        assert_eq!(readiness.observe_input(b"this"), PromptSubmission::None);
        assert_eq!(readiness.observe_input(b"\r"), PromptSubmission::Text);
        assert_eq!(readiness.observe_input(b"\r"), PromptSubmission::BareEnter);

        // A pasted prompt carries its own bracketed-paste markers.
        assert_eq!(
            readiness.observe_input(b"\x1b[200~pasted\x1b[201~\r"),
            PromptSubmission::Text
        );
    }

    #[test]
    fn completion_waits_for_a_submitted_prompt_to_return() {
        let mut readiness = CompletionReadiness::default();

        assert_eq!(readiness.observe_output(b"\x1b[?2004h", false), None);
        readiness.observe_input(b"draft text");
        assert_eq!(readiness.observe_output(b"\x1b[?2004h", false), None);

        readiness.observe_input(b"\r");
        assert_eq!(readiness.observe_output(b"answer\x1b[?20", false), None);
        assert_eq!(
            readiness.observe_output(b"04h", false),
            Some(AgentLifecycle::Done)
        );
        // Still a guess: a redraw re-enabling bracketed paste reports it
        // again, and the registry decides whether the terminal went quiet.
        assert_eq!(
            readiness.observe_output(b"\x1b[?2004h", false),
            Some(AgentLifecycle::Done)
        );
        readiness.cancel();
        assert_eq!(readiness.observe_output(b"\x1b[?2004h", false), None);
    }

    /// A TUI re-enables bracketed paste on ordinary redraws, so the code
    /// alone must not flip the sidebar to "done" while the CLI is mid-task.
    #[cfg(unix)]
    #[test]
    fn a_prompt_ready_code_only_counts_once_the_terminal_goes_quiet() {
        let sink: Arc<dyn AgentSink> = Arc::new(TestSink::default());
        let registry = Arc::new(AgentRegistry::new());
        let session = launch(
            sink.clone(),
            registry.clone(),
            AgentLaunchRequest {
                definition_id: "custom".to_string(),
                label: "Prompt ready".to_string(),
                executable: "/bin/cat".to_string(),
                arguments: Vec::new(),
                resume_session_id: None,
                group_id: None,
                seed_input: None,
                restore_existing_session: false,
                profile_config_path: None,
                sandbox: false,
                detached: false,
                working_directory: std::env::current_dir().unwrap().display().to_string(),
                cols: 80,
                rows: 24,
            },
        )
        .unwrap();
        let id = session.session_id.clone();

        send_bytes(sink.as_ref(), &registry, &id, b"do the task\r").unwrap();
        assert_eq!(registry.list()[0].state, AgentLifecycle::Working);

        // cat echoes the code back, so every one of these is a "prompt ready"
        // sighting followed by more output within the settle window.
        for _ in 0..6 {
            send_bytes(sink.as_ref(), &registry, &id, b"\x1b[?2004h redraw\r").unwrap();
            std::thread::sleep(PROMPT_READY_SETTLE / 3);
        }
        assert_eq!(
            registry.list()[0].state,
            AgentLifecycle::Working,
            "a redraw storm must not read as done"
        );

        // Now the terminal goes quiet: the last sighting settles into done.
        let deadline = Instant::now() + PROMPT_READY_SETTLE * 20;
        while registry.list()[0].state != AgentLifecycle::Done {
            assert!(Instant::now() < deadline, "a quiet terminal never settled");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(registry.list()[0].state_source, AgentStateSource::Heuristic);

        registry.stop_all();
    }

    #[test]
    fn completion_ignores_cursor_visibility_while_the_agent_is_working() {
        let mut readiness = CompletionReadiness::default();

        assert_eq!(readiness.observe_output(b"\x1b[?25h", false), None);
        readiness.observe_input(b"review this\r");
        assert_eq!(readiness.observe_output(b"answer\x1b[?2", false), None);
        assert_eq!(readiness.observe_output(b"5hstill working", false), None);
        assert_eq!(
            readiness.observe_output(b"done\x1b[?2004h", false),
            Some(AgentLifecycle::Done)
        );
    }

    #[test]
    fn integrated_completion_never_falls_back_to_prompt_control_codes() {
        let mut readiness = CompletionReadiness::default();
        readiness.observe_input(b"review this\r");

        assert_eq!(
            heuristic_state_from_output(&mut readiness, b"answer\x1b[?2004h", true),
            None
        );
        assert_eq!(
            heuristic_state_from_output(&mut readiness, "是否允許執行？".as_bytes(), true),
            Some(AgentLifecycle::NeedsAttention)
        );
    }

    #[test]
    fn attention_prompt_cancels_the_pending_completion() {
        let mut readiness = CompletionReadiness::default();
        readiness.observe_input(b"\r");

        assert_eq!(readiness.observe_output(b"permission requ", false), None);
        assert_eq!(
            readiness.observe_output(b"ired\x1b[?2004h", false),
            Some(AgentLifecycle::NeedsAttention)
        );
        assert_eq!(readiness.observe_output(b"\x1b[?2004h", false), None);
    }

    #[test]
    fn codex_working_footer_clears_a_stale_attention_prompt() {
        let mut readiness = CompletionReadiness::default();

        assert_eq!(
            readiness.observe_output(b"Do you want to continue?", false),
            Some(AgentLifecycle::NeedsAttention)
        );
        assert_eq!(
            readiness.observe_output(
                b"Working (1s; esc to interrupt) 1 background terminal running",
                false,
            ),
            Some(AgentLifecycle::Working)
        );
        assert_eq!(readiness.observe_output(b"still compiling", false), None);
    }

    #[test]
    fn codex_working_footer_survives_ansi_styles_and_every_read_boundary() {
        let footer = b"\x1b[90mWorking\x1b[0m \x1b[2m(8m 12s \xc2\xb7 esc to interrupt)\x1b[0m";
        for split in 0..=footer.len() {
            let mut readiness = CompletionReadiness::default();
            let first = readiness.observe_output(&footer[..split], true);
            let second = readiness.observe_output(&footer[split..], true);
            assert!(
                first == Some(AgentLifecycle::Working) || second == Some(AgentLifecycle::Working),
                "missed working footer at byte {split}"
            );
            assert_ne!(first, Some(AgentLifecycle::NeedsAttention));
            assert_ne!(second, Some(AgentLifecycle::NeedsAttention));
        }
    }

    #[test]
    fn codex_busy_diff_and_permanent_composer_are_not_a_question() {
        let mut readiness = CompletionReadiness::default();
        readiness.observe_input(b"fix the task\r");
        readiness.observe_output(b"Working (8m 12s; esc to interrupt)", true);
        let redraw = concat!(
            "+ throw new Error(\"請確認專案設定\");\n",
            "The log contains 'would you like to' and 'do you want to'.\n",
            "> Ask Codex to do anything\n",
            "gpt-6-astra xhigh\x1b[?2004h"
        );
        // TUI redraws often update only a few cells, omitting the footer.
        for chunk in redraw.as_bytes().chunks(3) {
            assert_eq!(readiness.observe_output(chunk, true), None);
        }
    }

    #[test]
    fn codex_partial_spinner_redraw_still_recovers_working() {
        let mut readiness = CompletionReadiness::default();
        readiness.observe_output(b"Do you want to continue?", true);
        assert_eq!(
            readiness.observe_output(b"8m 13s; esc to inter", true),
            None
        );
        assert_eq!(
            readiness.observe_output(b"rupt)", true),
            Some(AgentLifecycle::Working)
        );
    }

    #[test]
    fn an_actual_approval_menu_can_interrupt_a_working_turn() {
        for prefix in ["", "Working (8m 12s; esc to interrupt)\n"] {
            let mut readiness = CompletionReadiness::default();
            readiness.observe_output(b"Working (1s; esc to interrupt)", true);
            let menu = format!(
                "{prefix}Would you like to run the following command?\n\
                 $ npm test\n\x1b[36m\u{203a} 1. Yes, proceed (y)\x1b[0m\n\
                 2. No, and tell Codex what to do differently (esc)\x1b[?2004h"
            );
            assert_eq!(
                readiness.observe_output(menu.as_bytes(), true),
                Some(AgentLifecycle::NeedsAttention)
            );
            readiness.observe_input(b"\r");
            assert_eq!(
                readiness.observe_output(b"Working (1s; esc to interrupt)", true),
                Some(AgentLifecycle::Working)
            );
        }
    }

    #[test]
    fn explicit_model_arguments_are_available_before_startup_output() {
        assert_eq!(
            model_from_arguments(&["--model".to_string(), "gemini-2.5-pro".to_string()]).as_deref(),
            Some("gemini-2.5-pro")
        );
        assert_eq!(
            model_from_arguments(&["--model=sonnet".to_string()]).as_deref(),
            Some("sonnet")
        );
    }

    #[test]
    fn codex_default_model_is_read_from_the_top_level_config() {
        assert_eq!(
            codex_model_from_config(
                r#"
model = "gpt-5.6-sol"
model_reasoning_effort = "high"

[profiles.review]
model = "gpt-5.3-codex"
"#,
            )
            .as_deref(),
            Some("gpt-5.6-sol")
        );
    }

    #[test]
    fn codex_profile_model_is_not_reported_as_the_default() {
        assert!(codex_model_from_config(
            r#"
[profiles.review]
model = "gpt-5.3-codex"
"#,
        )
        .is_none());
    }

    #[test]
    fn model_command_rearms_capture_when_typed_in_separate_events() {
        let mut capture = ModelCaptureState {
            definition_id: "codex".to_string(),
            enabled: true,
            buffer: String::new(),
            scanned_chars: 0,
            input_buffer: String::new(),
            model_command_active: false,
        };
        capture.input(b"hello");
        assert!(!capture.enabled);
        capture.input(b"\r");
        for byte in b"/model\r" {
            capture.input(&[*byte]);
        }
        assert!(capture.enabled);
        assert_eq!(
            capture.feed(b"gpt-5.6-sol xhigh").as_deref(),
            Some("gpt-5.6-sol")
        );
        // The picker may still be open; the watch survives the first match.
        assert!(capture.model_command_active);
        assert!(capture.enabled);
    }

    #[test]
    fn model_picker_keeps_watching_until_the_next_real_command() {
        let mut capture = ModelCaptureState {
            definition_id: "codex".to_string(),
            enabled: false,
            buffer: String::new(),
            scanned_chars: 0,
            input_buffer: String::new(),
            model_command_active: false,
        };
        for byte in b"/model\r" {
            capture.input(&[*byte]);
        }
        // The menu redraw shows the current model first...
        assert_eq!(
            capture.feed(b"model: gpt-5.6-sol").as_deref(),
            Some("gpt-5.6-sol")
        );
        // ...arrow keys and a bare Enter pick another entry...
        capture.input(b"\x1b[B");
        capture.input(b"\r");
        assert!(capture.enabled);
        // ...and the confirmation redraw carries the real choice.
        assert_eq!(
            capture.feed(b"model: gpt-5.6-max").as_deref(),
            Some("gpt-5.6-max")
        );
        // The next ordinary command ends the watch for good.
        for byte in b"run the tests\r" {
            capture.input(&[*byte]);
        }
        assert!(!capture.enabled);
        assert!(!capture.model_command_active);
        assert_eq!(capture.feed(b"model: gpt-9.9-fake"), None);
    }

    #[cfg(windows)]
    #[test]
    fn working_directories_lose_the_verbatim_prefix() {
        assert_eq!(
            plain_win32_path(PathBuf::from(r"\\?\D:\project\demo")),
            PathBuf::from(r"D:\project\demo")
        );
        assert_eq!(
            plain_win32_path(PathBuf::from(r"\\?\UNC\nas\share")),
            PathBuf::from(r"\\nas\share")
        );
    }

    #[test]
    fn terminal_protocol_replies_do_not_cancel_startup_model_capture() {
        let mut capture = ModelCaptureState {
            definition_id: "codex".to_string(),
            enabled: true,
            buffer: String::new(),
            scanned_chars: 0,
            input_buffer: String::new(),
            model_command_active: false,
        };

        // xterm emits these through onData while a full-screen TUI starts.
        capture.input(b"\x1b[?1;2c");
        capture.input(b"\x1b[24;1R");
        capture.input(b"\x1b[I");
        assert!(capture.enabled);
        assert_eq!(
            capture
                .feed(b"\x1b[2m model: \x1b[0mgpt-5.6-sol xhigh")
                .as_deref(),
            Some("gpt-5.6-sol")
        );
    }

    #[test]
    fn catalog_ids_are_unique() {
        let ids: HashSet<_> = AGENTS.iter().map(|agent| agent.id).collect();
        assert_eq!(ids.len(), AGENTS.len());
        assert!(ids.contains("codex"));
        assert!(ids.contains("hermes"));
    }

    #[test]
    fn every_missing_cli_has_a_reviewable_install_path() {
        for definition in catalog() {
            assert!(
                definition.install.source_url.starts_with("https://"),
                "{} needs an HTTPS installation source",
                definition.id
            );
            assert!(
                !definition.install.display_command.is_empty(),
                "{} needs a visible installation command",
                definition.id
            );
            if definition.install.executable.is_some() {
                assert!(
                    !definition.install.arguments.is_empty(),
                    "{} direct installer needs an argument vector",
                    definition.id
                );
            }
        }
    }

    #[test]
    fn native_resume_adapters_use_the_verified_cli_argument_shape() {
        for (definition_id, expected) in [
            ("codex", vec!["resume", "session-42"]),
            ("claude", vec!["--resume", "session-42"]),
            ("gemini", vec!["--resume", "session-42"]),
            ("hermes", vec!["--resume", "session-42"]),
            ("cursor", vec!["--resume", "session-42"]),
        ] {
            let spec = AGENTS
                .iter()
                .find(|agent| agent.id == definition_id)
                .unwrap();
            let session_id = normalize_resume_session_id(Some(spec), Some("  session-42  "), &[])
                .unwrap()
                .unwrap();
            assert_eq!(spec.resume_recipe.unwrap().arguments(session_id), expected);
        }

        let definitions = catalog();
        let supported: HashSet<_> = definitions
            .iter()
            .filter(|definition| definition.resume_supported)
            .map(|definition| definition.id.as_str())
            .collect();
        assert_eq!(
            supported,
            HashSet::from(["codex", "claude", "gemini", "hermes", "cursor"])
        );
        let latest_supported: HashSet<_> = definitions
            .iter()
            .filter(|definition| definition.resume_latest_supported)
            .map(|definition| definition.id.as_str())
            .collect();
        assert_eq!(
            latest_supported,
            HashSet::from(["codex", "claude", "antigravity", "cursor"])
        );
        assert_eq!(
            AGENTS[0].resume_latest_recipe.unwrap().arguments(),
            vec!["resume", "--last"]
        );
        let antigravity = AGENTS
            .iter()
            .find(|agent| agent.id == "antigravity")
            .unwrap();
        assert_eq!(
            antigravity.resume_latest_recipe.unwrap().arguments(),
            vec!["--continue"]
        );
        let claude = AGENTS.iter().find(|agent| agent.id == "claude").unwrap();
        assert_eq!(
            claude.resume_latest_recipe.unwrap().arguments(),
            vec!["--continue"]
        );
        let cursor = AGENTS.iter().find(|agent| agent.id == "cursor").unwrap();
        assert_eq!(
            cursor.resume_latest_recipe.unwrap().arguments(),
            vec!["--continue"]
        );
        assert!(definitions
            .iter()
            .all(|definition| definition.adapter_version == AGENT_ADAPTER_VERSION));
    }

    #[test]
    fn native_resume_rejects_ambiguous_or_unsupported_inputs() {
        let codex = AGENTS.iter().find(|agent| agent.id == "codex").unwrap();
        let opencode = AGENTS.iter().find(|agent| agent.id == "opencode").unwrap();

        assert!(normalize_resume_session_id(None, Some("session-42"), &[])
            .unwrap_err()
            .contains("custom agents"));
        assert!(
            normalize_resume_session_id(Some(opencode), Some("session-42"), &[])
                .unwrap_err()
                .contains("OpenCode")
        );
        assert!(
            normalize_resume_session_id(Some(codex), Some("-latest"), &[])
                .unwrap_err()
                .contains("cannot begin")
        );
        assert!(
            normalize_resume_session_id(Some(codex), Some("bad\ntitle"), &[])
                .unwrap_err()
                .contains("control")
        );
        assert!(normalize_resume_session_id(
            Some(codex),
            Some("session-42"),
            &["--full-auto".to_string()],
        )
        .unwrap_err()
        .contains("cannot be combined"));
        assert!(normalize_resume_session_id(
            Some(codex),
            Some(&"x".repeat(MAX_RESUME_SESSION_ID_BYTES + 1)),
            &[],
        )
        .unwrap_err()
        .contains("too long"));
    }

    #[test]
    #[ignore = "depends on the host having claude installed on PATH"]
    fn claude_is_detected_on_this_host() {
        let claude = catalog()
            .into_iter()
            .find(|agent| agent.id == "claude")
            .expect("claude is in the catalog");
        println!("claude installed_path = {:?}", claude.installed_path);
        assert!(claude.installed, "claude should be detected on PATH");
    }

    #[test]
    #[ignore = "spawns the real claude CLI; run manually on a host that has it"]
    fn claude_shim_launches_via_launch_parts() {
        // Proves the resolved .cmd shim runs when driven through launch_parts.
        // Uses a plain captured process (the PTY layer is portable_pty's job).
        let executable = find_executable("claude").expect("claude on PATH");
        let (program, prefix_args) = launch_parts(&executable);

        let mut command = std::process::Command::new(&program);
        command.args(&prefix_args);
        command.arg("--version");
        let output = command.output().expect("run claude --version");

        let text = String::from_utf8_lossy(&output.stdout);
        println!("program={program:?} prefix={prefix_args:?} -> {text}");
        assert!(
            output.status.success() && text.chars().any(|character| character.is_ascii_digit()),
            "expected a version string, got status={:?} out={text:?}",
            output.status
        );
    }

    #[test]
    #[ignore = "spawns the real Hermes CLI and uses the configured inference provider"]
    fn hermes_official_hooks_report_a_real_oneshot_completion() {
        let collector = Arc::new(TestSink::default());
        let sink: Arc<dyn AgentSink> = collector.clone();
        let test_executable = std::env::current_exe().unwrap();
        let debug_directory = test_executable
            .parent()
            .and_then(Path::parent)
            .expect("unit test binary should live under target/debug/deps");
        #[cfg(windows)]
        let reporter_executable = debug_directory.join("lattice-term.exe");
        #[cfg(not(windows))]
        let reporter_executable = debug_directory.join("lattice-term");
        assert!(
            reporter_executable.is_file(),
            "build the real reporter first with `cargo build --bin lattice-term`"
        );
        let registry =
            AgentRegistry::with_local_reporter_executable(sink.clone(), reporter_executable, None)
                .unwrap();
        let request = AgentLaunchRequest {
            definition_id: "hermes".to_string(),
            label: "Hermes lifecycle probe".to_string(),
            executable: String::new(),
            arguments: vec![
                "--oneshot".to_string(),
                "Reply with exactly LATTICETERM_HERMES_OK and no other text.".to_string(),
                "--ignore-rules".to_string(),
            ],
            resume_session_id: None,
            group_id: None,
            seed_input: None,
            restore_existing_session: false,
            profile_config_path: None,
            sandbox: false,
            detached: false,
            working_directory: std::env::current_dir().unwrap().display().to_string(),
            cols: 100,
            rows: 30,
        };
        let session = launch(sink.clone(), registry.clone(), request).unwrap();

        let deadline = Instant::now() + Duration::from_secs(180);
        while Instant::now() < deadline {
            let done =
                collector
                    .states
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|(session_id, state, source)| {
                        session_id == &session.session_id
                            && *state == AgentLifecycle::Done
                            && *source == AgentStateSource::Integration
                    });
            let output = collector.data.lock().unwrap();
            let answered = String::from_utf8_lossy(&output).contains("LATTICETERM_HERMES_OK");
            drop(output);
            let closed = !collector.closed.lock().unwrap().is_empty();
            let usage_reported = !collector.usages.lock().unwrap().is_empty();
            if (done && answered && usage_reported) || closed {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }

        let states = collector.states.lock().unwrap();
        let integrated_done = states.iter().any(|(session_id, state, source)| {
            session_id == &session.session_id
                && *state == AgentLifecycle::Done
                && *source == AgentStateSource::Integration
        });
        let observed_states = states.clone();
        drop(states);
        let output = String::from_utf8_lossy(&collector.data.lock().unwrap()).to_string();
        let closed = collector.closed.lock().unwrap().clone();
        let observed_usage = collector.usages.lock().unwrap().clone();
        let latest_usage = observed_usage.last().map(|(_, usage)| usage);
        assert!(
            integrated_done
                && output.contains("LATTICETERM_HERMES_OK")
                && latest_usage.is_some_and(|usage| {
                    usage.api_calls > 0 && usage.total_tokens > 0
                }),
            "states={observed_states:?} usage={observed_usage:?} closed={closed:?} output={output:?}"
        );
        disconnect(sink.as_ref(), registry.as_ref(), &session.session_id).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_pty_environment_profile_snapshot_deduplicates_case_and_keeps_final_values() {
        use std::os::windows::ffi::OsStringExt;

        let opaque = OsString::from_wide(&[0xD800, b'x' as u16]);
        let inherited = vec![
            (OsString::from("Codex_Home"), OsString::from("inherited")),
            (OsString::from("tErM"), OsString::from("inherited-term")),
            (OsString::from("OPAQUE"), opaque.clone()),
            (opaque.clone(), OsString::from("opaque-name-value")),
        ];
        let mut command = CommandBuilder::new("owned-fixture.exe");
        inherit_process_environment_in(&mut command, inherited.clone());
        command.env("CODEX_HOME", "final-account-home");
        command.env("TERM", "xterm-256color");
        // Additional overrides with a non-Unicode value cannot be found by
        // iter_full_env_as_str, but their fixed known keys still must survive.
        command.env("LATTICETERM_AGENT_REPORTER", &opaque);
        let environment = final_codex_launch_environment(&command, &inherited);
        assert_eq!(environment.len(), 5);
        for (key, value) in [
            (
                OsString::from("CODEX_HOME"),
                OsString::from("final-account-home"),
            ),
            (OsString::from("TERM"), OsString::from("xterm-256color")),
            (OsString::from("OPAQUE"), opaque.clone()),
            (opaque.clone(), OsString::from("opaque-name-value")),
            (OsString::from("LATTICETERM_AGENT_REPORTER"), opaque),
        ] {
            assert_eq!(
                environment
                    .iter()
                    .filter(|(actual, _)| actual == &key)
                    .count(),
                1
            );
            assert!(environment.contains(&(key, value)));
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_pty_environment_uses_process_snapshot_not_registry_values() {
        let mut command = CommandBuilder::new(r"C:\fixture\agent.exe");
        command.env("PATH", "registry-entry;".repeat(4000));
        command.env("REGISTRY_ONLY_FIXTURE", "not inherited by the parent");
        let snapshot = [
            (
                "Path",
                r"C:\Windows\System32;C:\tools one;C:\工具;C:\tools one",
            ),
            ("SystemRoot", r"C:\Windows"),
            ("PATHEXT", ".COM;.EXE;.BAT;.CMD"),
            ("ComSpec", r"C:\Windows\System32\cmd.exe"),
            ("USERPROFILE", r"C:\fixture-user"),
        ];
        inherit_process_environment_in(
            &mut command,
            snapshot.map(|(key, value)| (OsString::from(key), OsString::from(value))),
        );
        for (key, value) in snapshot {
            assert_eq!(command.get_env(key), Some(OsStr::new(value)));
        }
        assert_eq!(command.get_env("PATH"), Some(OsStr::new(snapshot[0].1)));
        assert!(command.get_env("REGISTRY_ONLY_FIXTURE").is_none());
        assert_eq!(
            command.get_argv(),
            &[OsString::from(r"C:\fixture\agent.exe")]
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_pty_environment_preserves_explicit_launch_overrides() {
        let mut command = CommandBuilder::new("agent.exe");
        inherit_process_environment_in(
            &mut command,
            [
                ("CODEX_HOME", r"C:\fixture-default-codex"),
                ("CLAUDE_CONFIG_DIR", r"C:\fixture-default-claude"),
                ("HERDR_ENV", "1"),
                ("HERDR_PANE_ID", "old-pane"),
                ("LATTICETERM_AGENT_REPORT_TOKEN", "old-fixture-token"),
            ]
            .map(|(key, value)| (OsString::from(key), OsString::from(value))),
        );
        clear_host_terminal_markers(&mut command);
        command.env("CODEX_HOME", r"C:\fixture-account-b-codex");
        command.env("CLAUDE_CONFIG_DIR", r"C:\fixture-account-b-claude");
        command.env("LATTICETERM_AGENT_REPORT_TOKEN", "new-fixture-token");
        assert_eq!(
            command.get_env("CODEX_HOME"),
            Some(OsStr::new(r"C:\fixture-account-b-codex"))
        );
        assert_eq!(
            command.get_env("CLAUDE_CONFIG_DIR"),
            Some(OsStr::new(r"C:\fixture-account-b-claude"))
        );
        assert_eq!(
            command.get_env("LATTICETERM_AGENT_REPORT_TOKEN"),
            Some(OsStr::new("new-fixture-token"))
        );
        assert!(command.get_env("HERDR_ENV").is_none());
        assert!(command.get_env("HERDR_PANE_ID").is_none());
    }

    #[cfg(windows)]
    #[test]
    fn windows_pty_environment_never_truncates_the_inherited_path() {
        let mut command = CommandBuilder::new("agent.exe");
        let path = OsString::from(format!(
            "{};C:\\last-legitimate-entry",
            "C:\\fixture;".repeat(4000)
        ));
        inherit_process_environment_in(&mut command, [(OsString::from("PATH"), path.clone())]);
        assert_eq!(command.get_env("PATH"), Some(path.as_os_str()));
    }

    #[cfg(windows)]
    #[test]
    fn detects_and_wraps_windows_script_shims() {
        // npm/pnpm global installs land as .cmd shims (e.g. claude.cmd).
        let dir = tempfile::tempdir().unwrap();
        let shim = dir.path().join("faux-agent.cmd");
        std::fs::write(&shim, "@echo off\r\n").unwrap();

        assert!(is_executable(&shim), ".cmd shims must count as executable");

        let (program, prefix) = launch_parts(&shim);
        assert!(
            program
                .to_string_lossy()
                .to_ascii_lowercase()
                .contains("cmd"),
            "a .cmd shim must launch through the command processor"
        );
        assert_eq!(
            prefix.first().map(|arg| arg.to_string_lossy().to_string()),
            Some("/d".to_string())
        );
        assert_eq!(
            prefix.get(1).map(|arg| arg.to_string_lossy().to_string()),
            Some("/c".to_string())
        );

        // A real .exe launches directly, with no wrapper.
        let exe = dir.path().join("faux-agent.exe");
        std::fs::write(&exe, "MZ").unwrap();
        let (exe_program, exe_prefix) = launch_parts(&exe);
        assert_eq!(exe_program, exe.as_os_str());
        assert!(exe_prefix.is_empty());

        let canonical_exe = exe.canonicalize().unwrap();
        let (canonical_program, canonical_prefix) = launch_parts(&canonical_exe);
        assert_eq!(canonical_program, exe.as_os_str());
        assert!(canonical_prefix.is_empty());

        assert_eq!(
            plain_windows_path(Path::new(r"\\?\UNC\server\share\agent.exe")),
            OsString::from(r"\\server\share\agent.exe")
        );

        assert_eq!(
            well_known_agent_path("antigravity", Path::new(r"C:\Users\dev\AppData\Local")),
            Some(PathBuf::from(r"C:\Users\dev\AppData\Local\agy\bin\agy.exe"))
        );
        assert!(well_known_agent_path("custom", Path::new(r"C:\Temp")).is_none());

        let node_directory = dir.path().join("nodejs");
        std::fs::create_dir_all(&node_directory).unwrap();
        std::fs::write(node_directory.join("node.exe"), "MZ").unwrap();
        let mut command = CommandBuilder::new("cmd.exe");
        assert!(configure_node_runtime_for_script_in(
            &mut command,
            &shim,
            std::slice::from_ref(&node_directory),
            Some(OsStr::new(r"C:\stale-path")),
        ));
        let refreshed_path = command.get_env("PATH").expect("refreshed PATH");
        assert_eq!(
            std::env::split_paths(refreshed_path).next(),
            Some(node_directory.clone())
        );

        let bloated_path = std::env::join_paths(
            (0..1_000).map(|index| PathBuf::from(format!(r"C:\temporary\path-{index}"))),
        )
        .unwrap();
        let mut bounded = CommandBuilder::new("cmd.exe");
        assert!(configure_node_runtime_for_script_in(
            &mut bounded,
            &shim,
            std::slice::from_ref(&node_directory),
            Some(&bloated_path),
        ));
        use std::os::windows::ffi::OsStrExt;
        assert!(
            bounded
                .get_env("PATH")
                .expect("bounded PATH")
                .encode_wide()
                .count()
                <= 7_800
        );
    }

    #[test]
    fn agent_launches_do_not_inherit_herdr_pane_markers() {
        let mut command = CommandBuilder::new("agent");
        command.env("HERDR_ENV", "1");
        command.env("HERDR_PANE_ID", "pane-123");

        clear_host_terminal_markers(&mut command);

        assert!(command.get_env("HERDR_ENV").is_none());
        assert!(command.get_env("HERDR_PANE_ID").is_none());
    }

    #[test]
    fn account_profile_directories_are_created_under_the_data_dir_and_checked() {
        let root = tempfile::tempdir().expect("tempdir");
        let created =
            account_profile_directory(root.path(), "claude", "profile-1").expect("created");
        assert!(created.is_dir());
        assert!(created.ends_with(Path::new("agent-profiles/claude/profile-1")));
        // Creating it again is fine; the existing directory is returned.
        assert_eq!(
            account_profile_directory(root.path(), "claude", "profile-1").unwrap(),
            created
        );
        // It passes the same check a chosen directory does.
        assert!(profile_config_directory("claude", Some(&created.display().to_string())).is_ok());

        assert!(account_profile_directory(root.path(), "gemini", "p").is_err());
        assert!(account_profile_directory(root.path(), "codex", "../escape").is_err());
        assert!(account_profile_directory(root.path(), "codex", "").is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&created).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
    }

    #[test]
    fn sandbox_arguments_open_only_the_working_directory_and_the_cli_state() {
        let home = Path::new("/home/u");
        let existing = |path: &Path| {
            matches!(
                path.to_str(),
                Some("/work")
                    | Some("/home/u/.claude")
                    | Some("/home/u/.claude.json")
                    | Some("/home/u/.claude/settings.json")
                    | Some("/home/u/.cache")
            )
        };
        let args = sandbox_arguments(Path::new("/work"), "claude", Some(home), &[], &existing);
        let args: Vec<String> = args
            .into_iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        let joined = args.join(" ");
        assert!(joined.starts_with("--ro-bind / / --dev /dev --proc /proc --bind /tmp /tmp"));
        assert!(joined.contains("--bind /work /work"));
        assert!(joined.contains("--bind /home/u/.claude /home/u/.claude"));
        assert!(joined.contains("--bind /home/u/.claude.json /home/u/.claude.json"));
        assert!(joined.contains("--bind /home/u/.cache /home/u/.cache"));
        // A state directory that does not exist is not bound: bwrap would
        // refuse to start, and there is nothing there to protect anyway.
        assert!(!joined.contains(".npm"));
        assert!(!joined.contains(".codex"));
        // The hooks file is bound read-only after the writable state root, so
        // the later bind shadows it.
        let rw = joined
            .find("--bind /home/u/.claude /home/u/.claude")
            .unwrap();
        let ro = joined
            .find("--ro-bind /home/u/.claude/settings.json /home/u/.claude/settings.json")
            .unwrap();
        assert!(ro > rw);
        assert!(joined.ends_with("--unshare-pid --die-with-parent --chdir /work --"));

        // An account profile directory is writable too.
        let profile = Path::new("/data/profiles/x");
        let args = sandbox_arguments(Path::new("/work"), "codex", None, &[profile], &|_| true);
        let joined = args
            .iter()
            .map(|a| a.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");
        let profile_bind = joined
            .find("--bind /data/profiles/x /data/profiles/x")
            .unwrap();
        assert!(
            joined
                .find("--ro-bind /data/profiles/x/config.toml /data/profiles/x/config.toml")
                .unwrap()
                > profile_bind
        );
        assert!(
            joined
                .find("--ro-bind /data/profiles/x/rules /data/profiles/x/rules")
                .unwrap()
                > profile_bind
        );
        assert!(!joined.contains(".codex"), "no home, no home binds");
    }

    #[cfg(unix)]
    #[test]
    fn sandbox_policy_preparation_rejects_links_and_preserves_settings() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let profile = directory.path().join("profile");
        std::fs::create_dir(&profile).unwrap();
        prepare_sandbox_profile("codex", &profile).unwrap();
        assert_eq!(std::fs::read(profile.join("config.toml")).unwrap(), b"");
        assert!(profile.join("rules").is_dir());
        std::fs::write(profile.join("config.toml"), "model = 'kept'\n").unwrap();
        prepare_sandbox_profile("codex", &profile).unwrap();
        assert_eq!(
            std::fs::read_to_string(profile.join("config.toml")).unwrap(),
            "model = 'kept'\n"
        );
        let outside = directory.path().join("outside");
        std::fs::write(&outside, "unchanged").unwrap();
        std::fs::remove_file(profile.join("config.toml")).unwrap();
        symlink(&outside, profile.join("config.toml")).unwrap();
        assert!(prepare_sandbox_profile("codex", &profile).is_err());
        assert_eq!(std::fs::read_to_string(outside).unwrap(), "unchanged");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_real_sandbox_cannot_plant_default_or_profile_policy() {
        let Some(bwrap) = sandbox_tool() else {
            assert!(
                std::env::var_os("LATTICETERM_REQUIRE_SANDBOX_TEST").is_none(),
                "required bwrap probe failed"
            );
            return;
        };
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let profile = root.path().join("profile");
        let work = root.path().join("work");
        for path in [&home, &profile, &work] {
            std::fs::create_dir(path).unwrap();
        }
        for definition in ["claude", "codex"] {
            prepare_sandbox_state(definition, &home).unwrap();
            prepare_sandbox_profile(definition, &profile).unwrap();
            let mut args =
                sandbox_arguments(&work, definition, Some(&home), &[&profile], &|path| {
                    path.exists()
                });
            args.extend(["/bin/sh", "-c", r#"touch "$1/session-state" || exit 1; shift; for target do if echo planted > "$target" 2>/dev/null; then exit 2; fi; if rm -rf "$target" 2>/dev/null; then exit 3; fi; done"#, "sandbox-test"].map(OsString::from));
            args.push(profile.as_os_str().to_os_string());
            for relative in sandbox_home_readonly_paths(definition) {
                args.push(home.join(relative).into_os_string());
            }
            for path in sandbox_profile_readonly_paths(definition, &profile) {
                args.push(path.into_os_string());
            }
            assert!(std::process::Command::new(&bwrap)
                .args(args)
                .status()
                .unwrap()
                .success());
        }
    }

    /// Runs bubblewrap for real when it is installed: the sandbox must stop
    /// a write outside the working directory and allow one inside it.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_real_sandbox_confines_writes_to_the_working_directory() {
        let Some(bwrap) = sandbox_tool() else {
            eprintln!("bwrap missing or unprivileged user namespaces blocked; skipping");
            return;
        };
        // Both directories live under the home directory, which the sandbox
        // binds read-only: /tmp is deliberately writable, so a probe there
        // would prove nothing.
        let Some(home) = user_home_directory().filter(|home| home.is_dir()) else {
            eprintln!("no home directory; skipping");
            return;
        };
        let work = tempfile::tempdir_in(&home).expect("tempdir in home");
        let outside = tempfile::tempdir_in(&home).expect("tempdir in home");
        let script = format!(
            "touch {}/inside && echo inside=$? ; touch {}/outside 2>/dev/null; echo outside=$?",
            work.path().display(),
            outside.path().display()
        );
        let mut args = sandbox_arguments(work.path(), "custom", None, &[], &|path| path.exists());
        args.push("/bin/sh".into());
        args.push("-c".into());
        args.push(script.into());
        let output = std::process::Command::new(&bwrap)
            .args(&args)
            .output()
            .expect("bwrap runs");
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(stdout.contains("inside=0"), "stdout: {stdout}");
        assert!(stdout.contains("outside=1"), "stdout: {stdout}");
        assert!(work.path().join("inside").exists());
        assert!(!outside.path().join("outside").exists());
    }

    #[test]
    fn account_profiles_accept_only_local_codex_or_claude_directories() {
        let directory = tempfile::tempdir().unwrap();
        let raw = directory.path().display().to_string();
        let expected = plain_win32_path(directory.path().canonicalize().unwrap());

        assert_eq!(
            profile_config_directory("codex", Some(&raw)).unwrap(),
            Some(expected.clone())
        );
        assert_eq!(
            profile_config_directory("claude", Some(&raw)).unwrap(),
            Some(expected)
        );
        assert!(profile_config_directory("codex", None).unwrap().is_none());
        assert!(profile_config_directory("custom", Some(&raw))
            .unwrap_err()
            .contains("Only Codex and Claude"));
        assert!(profile_config_directory("claude", Some("relative-profile"))
            .unwrap_err()
            .contains("absolute path"));
    }

    #[cfg(windows)]
    #[test]
    fn detects_npm_global_shims_when_the_process_path_is_stale() {
        let app_data = tempfile::tempdir().unwrap();
        let npm = app_data.path().join("npm");
        std::fs::create_dir_all(&npm).unwrap();
        let codex = npm.join("codex.cmd");
        let claude = npm.join("claude.bat");
        std::fs::write(&codex, "@echo off\r\n").unwrap();
        std::fs::write(&claude, "@echo off\r\n").unwrap();

        assert_eq!(
            find_npm_global_agent_executable_in("codex", app_data.path()),
            Some(codex)
        );
        assert_eq!(
            find_npm_global_agent_executable_in("claude", app_data.path()),
            Some(claude)
        );
        assert!(find_npm_global_agent_executable_in("", app_data.path()).is_none());
        assert!(find_npm_global_agent_executable_in("codex.exe", app_data.path()).is_none());
    }

    #[test]
    fn attention_prompts_are_detected_conservatively() {
        assert_eq!(
            lifecycle_from_output(b"Permission required. Do you want to continue?"),
            AgentLifecycle::NeedsAttention
        );
        assert_eq!(
            lifecycle_from_output(b"Compiling dependency 42/100"),
            AgentLifecycle::Working
        );
    }

    #[test]
    fn active_agent_limit_keeps_output_memory_bounded() {
        assert!(!agent_session_limit_reached(MAX_AGENT_SESSIONS - 1));
        assert!(agent_session_limit_reached(MAX_AGENT_SESSIONS));
        assert_eq!(
            MAX_AGENT_SESSIONS * MAX_OUTPUT_SNAPSHOT_BYTES,
            8 * 1024 * 1024
        );
    }

    #[test]
    fn output_buffer_retains_a_bounded_tail_with_monotonic_offsets() {
        let mut output = OutputBuffer::default();
        let prefix = vec![b'a'; MAX_OUTPUT_SNAPSHOT_BYTES - 2];
        assert_eq!(output.append(&prefix), 0);
        assert_eq!(
            output.append(b"bcde"),
            (MAX_OUTPUT_SNAPSHOT_BYTES - 2) as u64
        );

        let snapshot = output.snapshot("agent-session-test");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&snapshot.base64)
            .unwrap();
        assert_eq!(snapshot.session_id, "agent-session-test");
        assert_eq!(snapshot.start_offset, 2);
        assert_eq!(snapshot.end_offset, (MAX_OUTPUT_SNAPSHOT_BYTES + 2) as u64);
        let wire = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(wire["sessionId"], "agent-session-test");
        assert_eq!(wire["startOffset"], 2);
        assert_eq!(wire["endOffset"], (MAX_OUTPUT_SNAPSHOT_BYTES + 2) as u64);
        assert_eq!(decoded.len(), MAX_OUTPUT_SNAPSHOT_BYTES);
        assert_eq!(&decoded[decoded.len() - 4..], b"bcde");
    }

    #[test]
    fn output_buffer_ranges_follow_a_cursor_and_flag_lost_output() {
        let mut output = OutputBuffer::default();
        output.append(b"hello ");
        output.append(b"world");
        let decoded = |range: &AgentOutputRange| {
            base64::engine::general_purpose::STANDARD
                .decode(&range.base64)
                .unwrap()
        };

        let first = output.range("s", 0, 4);
        assert_eq!((first.cursor, first.next_cursor), (0, 4));
        assert_eq!(decoded(&first), b"hell");
        assert!(!first.truncated);
        let rest = output.range("s", first.next_cursor, 1024);
        assert_eq!(decoded(&rest), b"o world");
        assert_eq!(rest.next_cursor, 11);
        let nothing = output.range("s", rest.next_cursor, 1024);
        assert!(decoded(&nothing).is_empty());
        assert_eq!(nothing.next_cursor, 11);
        // Past the end is clamped, never a panic.
        assert_eq!(output.range("s", 999, 10).next_cursor, 11);

        // Once the window rolled, an old cursor starts at the window and says so.
        output.append(&vec![b'x'; MAX_OUTPUT_SNAPSHOT_BYTES]);
        let stale = output.range("s", 0, 3);
        assert!(stale.truncated);
        assert_eq!(stale.cursor, stale.start_offset);
        assert_eq!(decoded(&stale), b"xxx");
    }

    #[test]
    fn input_decoder_rejects_oversized_events() {
        let encoded = encode(&vec![0_u8; MAX_INPUT_BYTES + 1]);
        assert!(decode(&encoded).unwrap_err().contains("at most"));
    }

    #[test]
    fn launch_plans_normalize_paths_and_reject_secret_arguments() {
        let directory = std::env::current_dir().unwrap();
        let plan = normalize_launch_plan(
            "agent-plan-safe".to_string(),
            AgentLaunchPlanDraft {
                definition_id: "codex".to_string(),
                label: "Review agent".to_string(),
                executable: String::new(),
                arguments: vec!["--full-auto".to_string()],
                resume_session_id: None,
                note: "  審查 payments 專案  ".to_string(),
                sandbox: false,
                detached: false,
                working_directory: directory.display().to_string(),
            },
        )
        .unwrap();
        assert_eq!(plan.executable, "codex");
        // The note is trimmed and preserved for the saved list.
        assert_eq!(plan.note, "審查 payments 專案");
        assert_eq!(
            PathBuf::from(&plan.working_directory),
            plain_win32_path(directory.canonicalize().unwrap())
        );
        let mut tampered = plan.clone();
        tampered.arguments = vec!["--token=manually-injected".to_string()];
        assert!(launch_request_from_plan(&tampered, 80, 24).is_err());

        for argument in ["--api-key", "--token=secret", "SERVICE_PASSWORD=value"] {
            let error = normalize_launch_plan(
                "agent-plan-secret".to_string(),
                AgentLaunchPlanDraft {
                    definition_id: "custom".to_string(),
                    label: "Unsafe agent".to_string(),
                    executable: "/bin/echo".to_string(),
                    arguments: vec![argument.to_string()],
                    resume_session_id: None,
                    note: String::new(),
                    sandbox: false,
                    detached: false,
                    working_directory: directory.display().to_string(),
                },
            )
            .unwrap_err();
            assert!(error.contains("cannot contain"));
        }
    }

    #[test]
    fn plan_notes_reject_oversized_or_control_characters() {
        let directory = std::env::current_dir().unwrap();
        let make = |note: &str| {
            normalize_launch_plan(
                "agent-plan-note".to_string(),
                AgentLaunchPlanDraft {
                    definition_id: "codex".to_string(),
                    label: "Agent".to_string(),
                    executable: String::new(),
                    arguments: Vec::new(),
                    resume_session_id: None,
                    note: note.to_string(),
                    sandbox: false,
                    detached: false,
                    working_directory: directory.display().to_string(),
                },
            )
        };
        // Empty is allowed and normalises to "".
        assert_eq!(make("").unwrap().note, "");
        assert!(make(&"x".repeat(MAX_PLAN_NOTE_BYTES + 1)).is_err());
        assert!(make("line one\nline two").is_err());
    }

    #[test]
    fn launch_plans_preserve_an_explicit_native_resume_id() {
        let directory = std::env::current_dir().unwrap();
        let plan = normalize_launch_plan(
            "agent-plan-resume".to_string(),
            AgentLaunchPlanDraft {
                definition_id: "codex".to_string(),
                label: String::new(),
                executable: String::new(),
                arguments: Vec::new(),
                resume_session_id: Some("  session-42  ".to_string()),
                note: String::new(),
                sandbox: false,
                detached: false,
                working_directory: directory.display().to_string(),
            },
        )
        .unwrap();
        assert_eq!(plan.resume_session_id.as_deref(), Some("session-42"));

        let request = launch_request_from_plan(&plan, 80, 24).unwrap();
        assert_eq!(request.resume_session_id.as_deref(), Some("session-42"));
        assert!(request.arguments.is_empty());
        assert!(request.restore_existing_session);
        assert!(request.profile_config_path.is_none());
    }

    #[test]
    fn saved_sessions_resume_latest_only_for_verified_cli_adapters() {
        let directory = std::env::current_dir().unwrap();
        let plan = normalize_launch_plan(
            "agent-plan-latest-codex".to_string(),
            AgentLaunchPlanDraft {
                definition_id: "codex".to_string(),
                label: String::new(),
                executable: String::new(),
                arguments: Vec::new(),
                resume_session_id: None,
                note: String::new(),
                sandbox: false,
                detached: false,
                working_directory: directory.display().to_string(),
            },
        )
        .unwrap();

        let request = launch_request_from_plan(&plan, 80, 24).unwrap();
        assert_eq!(request.arguments, vec!["resume", "--last"]);
        assert!(request.resume_session_id.is_none());
        assert!(request.restore_existing_session);

        let claude = normalize_launch_plan(
            "agent-plan-latest-claude".to_string(),
            AgentLaunchPlanDraft {
                definition_id: "claude".to_string(),
                label: String::new(),
                executable: String::new(),
                arguments: vec!["--model".to_string(), "sonnet".to_string()],
                resume_session_id: None,
                note: String::new(),
                sandbox: false,
                detached: false,
                working_directory: directory.display().to_string(),
            },
        )
        .unwrap();
        let claude_request = launch_request_from_plan(&claude, 80, 24).unwrap();
        assert_eq!(
            claude_request.arguments,
            vec!["--continue", "--model", "sonnet"]
        );
        assert!(claude_request.restore_existing_session);

        let antigravity = normalize_launch_plan(
            "agent-plan-latest-antigravity".to_string(),
            AgentLaunchPlanDraft {
                definition_id: "antigravity".to_string(),
                label: String::new(),
                executable: String::new(),
                arguments: Vec::new(),
                resume_session_id: None,
                note: String::new(),
                sandbox: false,
                detached: false,
                working_directory: directory.display().to_string(),
            },
        )
        .unwrap();
        let antigravity_request = launch_request_from_plan(&antigravity, 80, 24).unwrap();
        assert_eq!(antigravity_request.arguments, vec!["--continue"]);
        assert!(antigravity_request.restore_existing_session);

        let cursor = normalize_launch_plan(
            "agent-plan-latest-cursor".to_string(),
            AgentLaunchPlanDraft {
                definition_id: "cursor".to_string(),
                label: String::new(),
                executable: String::new(),
                arguments: Vec::new(),
                resume_session_id: None,
                note: String::new(),
                sandbox: false,
                detached: false,
                working_directory: directory.display().to_string(),
            },
        )
        .unwrap();
        let cursor_request = launch_request_from_plan(&cursor, 80, 24).unwrap();
        assert_eq!(cursor_request.arguments, vec!["--continue"]);
        assert!(cursor_request.restore_existing_session);

        let hermes = normalize_launch_plan(
            "agent-plan-fresh-hermes".to_string(),
            AgentLaunchPlanDraft {
                definition_id: "hermes".to_string(),
                label: String::new(),
                executable: String::new(),
                arguments: Vec::new(),
                resume_session_id: None,
                note: String::new(),
                sandbox: false,
                detached: false,
                working_directory: directory.display().to_string(),
            },
        )
        .unwrap();
        let hermes_request = launch_request_from_plan(&hermes, 80, 24).unwrap();
        assert!(hermes_request.arguments.is_empty());
        assert!(!hermes_request.restore_existing_session);
    }

    #[test]
    fn rename_validates_label_and_requires_an_existing_session() {
        let registry = AgentRegistry::new();
        // Empty/blank labels are rejected before any lookup.
        assert!(registry.rename("agent-session-1", "   ").is_err());
        assert!(registry.rename("agent-session-1", &"x".repeat(81)).is_err());
        // A valid label still fails when the session does not exist.
        assert!(registry.rename("missing", "payments 重構").is_err());
    }

    #[test]
    fn broadcast_rejects_duplicate_targets_before_sending() {
        let sink = TestSink::default();
        let registry = AgentRegistry::new();
        let error = broadcast(
            &sink,
            &registry,
            &["agent-session-1".to_string(), "agent-session-1".to_string()],
            &encode(b"review this\r"),
        )
        .unwrap_err();
        assert!(error.contains("duplicate"));
    }

    #[test]
    fn reporter_subcommand_accepts_only_known_states() {
        assert_eq!(
            lifecycle_from_report_arg("needs-attention"),
            Some(AgentLifecycle::NeedsAttention)
        );
        assert_eq!(
            lifecycle_from_report_arg("done"),
            Some(AgentLifecycle::Done)
        );
        assert_eq!(lifecycle_from_report_arg("arbitrary-command"), None);
        assert_eq!(run_reporter_cli(["different-command", "done"]), None);
    }

    #[test]
    fn codex_completion_requires_the_documented_notification_type() {
        assert!(is_codex_turn_complete_notification(OsStr::new(
            r#"{"type":"agent-turn-complete","turn-id":"turn-1"}"#,
        )));
        assert!(!is_codex_turn_complete_notification(OsStr::new(
            r#"{"type":"tool-complete"}"#,
        )));
        assert!(!is_codex_turn_complete_notification(OsStr::new("not-json")));
        assert_eq!(
            run_reporter_cli(["agent-notify", "", r#"{"type":"tool-complete"}"#]),
            Some(0),
        );
        assert_eq!(run_reporter_cli(["agent-notify", ""]), Some(2));
    }

    #[test]
    fn codex_notify_config_is_parsed_with_conservative_limits() {
        assert_eq!(
            codex_notify_command_from_config(
                r#"model = "gpt-5"
notify = ["notify.exe", "turn-ended"]"#,
            ),
            Some(vec!["notify.exe".to_string(), "turn-ended".to_string()])
        );
        assert_eq!(codex_notify_command_from_config("notify = []"), None);
        assert_eq!(
            codex_notify_command_from_config("notify = [\"ok\", 1]"),
            None
        );
        assert_eq!(
            codex_notify_command_from_config("notify = [\"bad\\ncommand\"]"),
            None
        );
    }

    #[test]
    fn codex_reporter_preserves_the_existing_notify_command() {
        let original = vec!["notify.exe".to_string(), "turn-ended".to_string()];
        let arguments = codex_reporter_arguments_with_forward(
            vec!["--model".to_string(), "gpt-5".to_string()],
            Path::new(r"C:\Program Files\LatticeTerm\lattice-term.exe"),
            Some(original.clone()),
        );

        assert_eq!(arguments[0], "-c");
        let encoded_command = arguments[1].strip_prefix("notify=").unwrap();
        let command: Vec<String> = serde_json::from_str(encoded_command).unwrap();
        assert_eq!(command[1], "agent-notify");
        assert_eq!(decode_forward_notify(&command[2]), Some(original));
        assert_eq!(&arguments[2..], &["--model", "gpt-5"]);
    }

    #[test]
    fn codex_reporter_respects_an_explicit_launch_override() {
        let arguments = vec!["-c".to_string(), "notify=[\"custom.exe\"]".to_string()];
        assert_eq!(
            codex_reporter_arguments_with_forward(
                arguments.clone(),
                Path::new("lattice-term"),
                None,
            ),
            arguments
        );
    }

    #[test]
    fn claude_reporter_uses_exec_hooks_without_replacing_user_files() {
        let arguments = claude_reporter_arguments(
            vec!["--model".to_string(), "sonnet".to_string()],
            Path::new(r"C:\Program Files\LatticeTerm\lattice-term.exe"),
        );
        assert_eq!(arguments[0], "--settings");
        let settings: serde_json::Value = serde_json::from_str(&arguments[1]).unwrap();
        let stop = &settings["hooks"]["Stop"][0]["hooks"][0];
        assert_eq!(stop["type"], "command");
        assert_eq!(
            stop["command"],
            r"C:\Program Files\LatticeTerm\lattice-term.exe"
        );
        assert_eq!(stop["args"], serde_json::json!(["agent-claude-hook"]));
        for event in [
            "SessionStart",
            "PermissionDenied",
            "PostToolUse",
            "PostToolUseFailure",
            "PostToolBatch",
            "PreCompact",
            "PostCompact",
        ] {
            assert_eq!(settings["hooks"][event][0]["hooks"][0], *stop);
        }
        assert_eq!(&arguments[2..], &["--model", "sonnet"]);

        let explicit = vec!["--settings=/tmp/claude.json".to_string()];
        assert_eq!(
            claude_reporter_arguments(explicit.clone(), Path::new("lattice-term")),
            explicit
        );

        for safe_mode in ["--safe-mode", "--bare"] {
            let arguments = vec![
                safe_mode.to_string(),
                "--model".to_string(),
                "sonnet".to_string(),
            ];
            assert_eq!(
                claude_reporter_arguments(arguments.clone(), Path::new("lattice-term")),
                arguments
            );
        }
    }

    #[test]
    fn claude_hooks_distinguish_done_background_work_and_attention() {
        let state = |payload: &str| lifecycle_from_claude_hook_payload(payload.as_bytes()).unwrap();
        assert_eq!(
            state(r#"{"hook_event_name":"UserPromptSubmit"}"#),
            Some(AgentLifecycle::Working)
        );
        assert_eq!(
            state(r#"{"hook_event_name":"SessionStart"}"#),
            Some(AgentLifecycle::Idle)
        );
        assert_eq!(
            state(r#"{"hook_event_name":"Stop","background_tasks":[],"session_crons":[]}"#),
            Some(AgentLifecycle::Done)
        );
        assert_eq!(
            state(r#"{"hook_event_name":"Stop","background_tasks":[{"status":"running"}]}"#),
            Some(AgentLifecycle::Working)
        );
        assert_eq!(
            state(r#"{"hook_event_name":"Stop","session_crons":[{"id":"cron-1"}]}"#),
            Some(AgentLifecycle::Idle)
        );
        assert_eq!(
            state(r#"{"hook_event_name":"StopFailure","error":"rate_limit"}"#),
            Some(AgentLifecycle::NeedsAttention)
        );
        assert_eq!(
            state(r#"{"hook_event_name":"Notification","notification_type":"permission_prompt"}"#),
            Some(AgentLifecycle::NeedsAttention)
        );
        assert_eq!(
            state(r#"{"hook_event_name":"Notification","notification_type":"idle_prompt"}"#),
            None
        );
        for event in [
            "PermissionDenied",
            "PostToolUse",
            "PostToolUseFailure",
            "PostToolBatch",
            "PreCompact",
            "PostCompact",
        ] {
            assert_eq!(
                state(&format!(r#"{{"hook_event_name":"{event}"}}"#)),
                Some(AgentLifecycle::Working)
            );
        }
        assert!(lifecycle_from_claude_hook_payload(b"not-json").is_err());
    }

    #[test]
    fn claude_hooks_report_the_native_session_id() {
        let report = |payload: &str| report_from_claude_hook_payload(payload.as_bytes()).unwrap();
        assert_eq!(
            report(
                r#"{"hook_event_name":"SessionStart","session_id":"0199aa11-bb22-4c33-8d44-ee55ff667788"}"#
            ),
            Some((
                AgentLifecycle::Idle,
                Some("0199aa11-bb22-4c33-8d44-ee55ff667788".to_string()),
            ))
        );
        assert_eq!(
            report(r#"{"hook_event_name":"UserPromptSubmit"}"#),
            Some((AgentLifecycle::Working, None))
        );
        assert!(report_from_claude_hook_payload(
            br#"{"hook_event_name":"SessionStart","session_id":"bad\nvalue"}"#,
        )
        .is_err());
    }

    #[test]
    fn gemini_reporter_uses_process_scoped_lifecycle_hooks() {
        let settings = gemini_reporter_settings_value();
        let before = &settings["hooks"]["BeforeAgent"][0]["hooks"][0];
        let after = &settings["hooks"]["AfterAgent"][0]["hooks"][0];
        let permission = &settings["hooks"]["Notification"][0];

        assert_eq!(before["name"], "latticeterm-agent-status");
        assert_eq!(before["type"], "command");
        assert_eq!(before["command"], GEMINI_REPORTER_COMMAND);
        assert_eq!(before, after);
        assert_eq!(permission["matcher"], "ToolPermission");
        assert_eq!(permission["hooks"][0], *before);
        assert!(settings.get("hooksConfig").is_none());
    }

    #[test]
    fn gemini_hooks_distinguish_work_done_and_permission() {
        let state = |payload: &str| report_from_gemini_hook_payload(payload.as_bytes()).unwrap();
        assert_eq!(
            state(r#"{"hook_event_name":"BeforeAgent","session_id":"gemini-1"}"#),
            Some((AgentLifecycle::Working, "gemini-1".to_string()))
        );
        assert_eq!(
            state(r#"{"hook_event_name":"AfterAgent","session_id":"gemini-1"}"#),
            Some((AgentLifecycle::Done, "gemini-1".to_string()))
        );
        assert_eq!(
            state(
                r#"{"hook_event_name":"Notification","notification_type":"ToolPermission","session_id":"gemini-1"}"#
            ),
            Some((AgentLifecycle::NeedsAttention, "gemini-1".to_string()))
        );
        assert_eq!(
            state(
                r#"{"hook_event_name":"Notification","notification_type":"Info","session_id":"gemini-1"}"#
            ),
            None
        );
        assert!(report_from_gemini_hook_payload(b"not-json").is_err());
        assert!(report_from_gemini_hook_payload(br#"{"hook_event_name":"BeforeAgent"}"#).is_err());
        let oversized = serde_json::json!({
            "hook_event_name": "BeforeAgent",
            "session_id": "x".repeat(MAX_RESUME_SESSION_ID_BYTES + 1)
        });
        assert!(report_from_gemini_hook_payload(oversized.to_string().as_bytes()).is_err());
    }

    #[test]
    fn qwen_reporter_uses_process_scoped_lifecycle_hooks() {
        let settings = qwen_reporter_settings_value();
        let submitted = &settings["hooks"]["UserPromptSubmit"][0]["hooks"][0];
        let stop = &settings["hooks"]["Stop"][0]["hooks"][0];
        let permission = &settings["hooks"]["Notification"][0];

        assert_eq!(submitted["name"], "latticeterm-agent-status");
        assert_eq!(submitted["type"], "command");
        assert_eq!(submitted["command"], QWEN_REPORTER_COMMAND);
        assert_eq!(submitted, stop);
        assert_eq!(permission["matcher"], "permission_prompt");
        assert_eq!(permission["hooks"][0], *submitted);
        assert!(settings.get("disableAllHooks").is_none());
        assert!(qwen_reporter_allowed(&[]));
        assert!(!qwen_reporter_allowed(&["--safe-mode".to_string()]));
        assert!(!qwen_reporter_allowed(&["--bare=true".to_string()]));
        assert!(qwen_reporter_allowed(&["--safe-mode=false".to_string()]));
    }

    #[test]
    fn qwen_hooks_distinguish_work_done_failure_and_permission() {
        let state = |payload: &str| lifecycle_from_qwen_hook_payload(payload.as_bytes()).unwrap();
        assert_eq!(
            state(r#"{"hook_event_name":"UserPromptSubmit"}"#),
            Some(AgentLifecycle::Working)
        );
        assert_eq!(
            state(r#"{"hook_event_name":"Stop"}"#),
            Some(AgentLifecycle::Done)
        );
        assert_eq!(
            state(r#"{"hook_event_name":"Stop","background_tasks":[{"status":"running"}]}"#),
            Some(AgentLifecycle::Working)
        );
        assert_eq!(
            state(r#"{"hook_event_name":"Stop","crons":[{"id":"cron-1"}]}"#),
            Some(AgentLifecycle::Idle)
        );
        assert_eq!(
            state(r#"{"hook_event_name":"StopFailure","error":"rate_limit"}"#),
            Some(AgentLifecycle::NeedsAttention)
        );
        assert_eq!(
            state(r#"{"hook_event_name":"PermissionRequest"}"#),
            Some(AgentLifecycle::NeedsAttention)
        );
        assert_eq!(
            state(r#"{"hook_event_name":"PermissionDenied"}"#),
            Some(AgentLifecycle::Working)
        );
        assert_eq!(
            state(r#"{"hook_event_name":"Notification","notification_type":"permission_prompt"}"#),
            Some(AgentLifecycle::NeedsAttention)
        );
        assert_eq!(
            state(r#"{"hook_event_name":"Notification","notification_type":"idle_prompt"}"#),
            None
        );
        assert!(lifecycle_from_qwen_hook_payload(b"not-json").is_err());
    }

    #[test]
    fn hermes_reporter_uses_a_process_scoped_bundled_plugin_overlay() {
        let source = tempfile::tempdir().unwrap();
        let provider = source.path().join("model-providers").join("mock");
        std::fs::create_dir_all(&provider).unwrap();
        std::fs::write(
            provider.join("plugin.yaml"),
            "name: mock\nkind: model-provider\n",
        )
        .unwrap();

        let plugin = write_hermes_reporter_plugin_from_bundle(source.path()).unwrap();
        assert!(plugin
            .path()
            .join("model-providers/mock/plugin.yaml")
            .is_file());
        let bridge = plugin.path().join(HERMES_REPORTER_PLUGIN_NAME);
        let manifest = std::fs::read_to_string(bridge.join("plugin.yaml")).unwrap();
        let observer = std::fs::read_to_string(bridge.join("__init__.py")).unwrap();
        assert!(manifest.contains("kind: backend"));
        assert!(manifest.contains("on_session_end"));
        assert!(manifest.contains("post_api_request"));
        assert!(observer.contains("agent-hermes-hook"));
        assert!(observer.contains("child_session_id"));
        assert!(observer.contains("_USAGE_FIELDS"));
        assert!(!observer.contains("user_message"));
        assert!(!observer.contains("assistant_message"));
        assert!(!source.path().join(HERMES_REPORTER_PLUGIN_NAME).exists());
    }

    #[test]
    fn hermes_hooks_forward_only_valid_lifecycle_events() {
        let action = |payload: &str| {
            hermes_event_from_hook_payload(payload.as_bytes())
                .unwrap()
                .action
        };
        assert_eq!(
            action(r#"{"hook_event_name":"on_session_start","session_id":"main"}"#),
            HermesReporterAction::SessionStarted
        );
        assert_eq!(
            action(r#"{"hook_event_name":"pre_llm_call","session_id":"main"}"#),
            HermesReporterAction::TurnStarted
        );
        assert_eq!(
            action(
                r#"{"hook_event_name":"on_session_end","session_id":"main","completed":true,"failed":false,"interrupted":false}"#
            ),
            HermesReporterAction::TurnEnded {
                completed: true,
                failed: false,
                interrupted: false
            }
        );
        assert_eq!(
            action(
                r#"{"hook_event_name":"subagent_start","parent_session_id":"main","child_session_id":"child"}"#
            ),
            HermesReporterAction::SubagentStarted {
                child_session_id: "child".to_string()
            }
        );
        assert_eq!(
            action(r#"{"hook_event_name":"pre_approval_request"}"#),
            HermesReporterAction::NeedsAttention
        );
        assert!(hermes_event_from_hook_payload(
            br#"{"hook_event_name":"subagent_stop","parent_session_id":"main"}"#
        )
        .is_err());
        assert!(hermes_event_from_hook_payload(
            br#"{"hook_event_name":"pre_llm_call","session_id":"bad\nvalue"}"#
        )
        .is_err());
        let oversized = serde_json::json!({
            "hook_event_name": "pre_llm_call",
            "session_id": "x".repeat(MAX_RESUME_SESSION_ID_BYTES + 1)
        });
        assert!(hermes_event_from_hook_payload(oversized.to_string().as_bytes()).is_err());
        assert!(hermes_event_from_hook_payload(br#"{"hook_event_name":"unknown"}"#).is_err());
        assert!(hermes_event_from_hook_payload(b"not-json").is_err());

        let usage = hermes_usage_from_hook_payload(
            br#"{"hook_event_name":"post_api_request","session_id":"child","api_request_id":"turn-1:api:2","usage":{"input_tokens":120,"output_tokens":30,"cache_read_tokens":40,"cache_write_tokens":5,"reasoning_tokens":12}}"#,
        )
        .unwrap();
        assert_eq!(usage.source_session_id, "child");
        assert_eq!(usage.request_id, "turn-1:api:2");
        assert_eq!(usage.total_tokens(), 195);
        assert_eq!(usage.reasoning_tokens, 12);
        assert!(hermes_usage_from_hook_payload(
            br#"{"hook_event_name":"post_api_request","session_id":"main","api_request_id":"turn-1:api:1"}"#
        )
        .is_err());
        assert!(hermes_usage_from_hook_payload(
            format!(
                r#"{{"hook_event_name":"post_api_request","session_id":"main","api_request_id":"turn-1:api:1","usage":{{"input_tokens":{}}}}}"#,
                MAX_REPORTED_TOKENS_PER_REQUEST + 1
            )
            .as_bytes()
        )
        .is_err());
    }

    #[test]
    fn reported_usage_totals_stay_exact_for_webview_numbers() {
        let mut totals = AgentTokenUsage {
            input_tokens: MAX_SERIALIZED_USAGE_VALUE - 1,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            reasoning_tokens: 0,
            total_tokens: MAX_SERIALIZED_USAGE_VALUE - 1,
            api_calls: MAX_SERIALIZED_USAGE_VALUE,
        };
        totals.add_report(&AgentUsageReport {
            source_session_id: "main".to_string(),
            request_id: "turn-1:api:1".to_string(),
            input_tokens: 10,
            output_tokens: 2,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            reasoning_tokens: 1,
        });
        assert_eq!(totals.input_tokens, MAX_SERIALIZED_USAGE_VALUE);
        assert_eq!(totals.total_tokens, MAX_SERIALIZED_USAGE_VALUE);
        assert_eq!(totals.api_calls, MAX_SERIALIZED_USAGE_VALUE);
    }

    #[test]
    fn hermes_child_completion_never_finishes_the_main_turn() {
        let mut activity = HermesActivity::default();
        let event = |source: &str, action| HermesReporterEvent {
            source_session_id: source.to_string(),
            action,
        };

        assert_eq!(
            activity.apply(&event("main", HermesReporterAction::SessionStarted)),
            Some(AgentLifecycle::Working)
        );
        assert_eq!(
            activity.apply(&event(
                "main",
                HermesReporterAction::SubagentStarted {
                    child_session_id: "child".to_string()
                }
            )),
            Some(AgentLifecycle::Working)
        );
        assert_eq!(
            activity.apply(&event("child", HermesReporterAction::SessionStarted)),
            None
        );
        assert_eq!(
            activity.apply(&event(
                "child",
                HermesReporterAction::TurnEnded {
                    completed: true,
                    failed: false,
                    interrupted: false
                }
            )),
            None
        );
        assert_eq!(
            activity.apply(&event(
                "main",
                HermesReporterAction::TurnEnded {
                    completed: true,
                    failed: false,
                    interrupted: false
                }
            )),
            Some(AgentLifecycle::Working)
        );
        assert_eq!(
            activity.apply(&event(
                "main",
                HermesReporterAction::SubagentStopped {
                    child_session_id: "child".to_string()
                }
            )),
            Some(AgentLifecycle::Done)
        );

        assert_eq!(
            activity.apply(&event("main", HermesReporterAction::TurnStarted)),
            Some(AgentLifecycle::Working)
        );
        assert_eq!(
            activity.apply(&event(
                "main",
                HermesReporterAction::TurnEnded {
                    completed: false,
                    failed: true,
                    interrupted: false
                }
            )),
            Some(AgentLifecycle::NeedsAttention)
        );
    }

    #[test]
    fn copilot_plugin_is_process_scoped_without_replacing_user_config() {
        let hooks = copilot_reporter_hooks_value();
        let submitted = &hooks["hooks"]["userPromptSubmitted"][0];
        let stop = &hooks["hooks"]["agentStop"][0];
        let notification = &hooks["hooks"]["notification"][0];

        assert_eq!(hooks["version"], 1);
        assert_eq!(submitted["type"], "command");
        assert!(submitted["bash"]
            .as_str()
            .unwrap()
            .ends_with("agent-copilot-hook userPromptSubmitted"));
        assert!(submitted["powershell"]
            .as_str()
            .unwrap()
            .ends_with("agent-copilot-hook userPromptSubmitted"));
        assert!(stop["bash"]
            .as_str()
            .unwrap()
            .ends_with("agent-copilot-hook agentStop"));
        assert_eq!(
            notification["matcher"],
            "permission_prompt|elicitation_dialog|agent_completed|agent_idle"
        );
        assert!(hooks.get("disableAllHooks").is_none());

        let plugin = write_copilot_reporter_plugin().unwrap();
        let manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(plugin.path().join("plugin.json")).unwrap())
                .unwrap();
        let written_hooks: serde_json::Value =
            serde_json::from_slice(&std::fs::read(plugin.path().join("hooks.json")).unwrap())
                .unwrap();
        assert_eq!(manifest["name"], "latticeterm-agent-status");
        assert_eq!(manifest["hooks"], "hooks.json");
        assert_eq!(written_hooks, hooks);

        let arguments = copilot_reporter_arguments(vec!["--model=auto".to_string()], &plugin);
        assert_eq!(arguments[0], "--plugin-dir");
        assert_eq!(arguments[1], plugin.path().display().to_string());
        assert_eq!(arguments[2], "--model=auto");
    }

    #[test]
    fn copilot_hooks_distinguish_work_stop_attention_errors_and_subagents() {
        let event = |name: &str, payload: &str| {
            let mut payload: serde_json::Value = serde_json::from_str(payload).unwrap();
            payload["sessionId"] = serde_json::json!("main-session");
            copilot_event_from_hook_payload(name, payload.to_string().as_bytes())
                .unwrap()
                .map(|event| event.action)
        };
        assert_eq!(
            event("userPromptSubmitted", "{}"),
            Some(CopilotReporterAction::TurnStarted)
        );
        assert_eq!(
            event("sessionStart", "{}"),
            Some(CopilotReporterAction::SessionStarted)
        );
        assert_eq!(event("agentStop", "{}"), Some(CopilotReporterAction::Stop));
        assert_eq!(
            event("permissionRequest", "{}"),
            Some(CopilotReporterAction::NeedsAttention)
        );
        assert_eq!(
            event("errorOccurred", r#"{"recoverable":true}"#),
            Some(CopilotReporterAction::RecoverableError)
        );
        assert_eq!(
            event("errorOccurred", r#"{"recoverable":false}"#),
            Some(CopilotReporterAction::FatalError)
        );
        assert_eq!(
            event(
                "postToolUse",
                r#"{"toolName":"task","toolArgs":{"mode":"background"}}"#
            ),
            Some(CopilotReporterAction::BackgroundSubagentQueued)
        );
        assert_eq!(
            event(
                "notification",
                r#"{"notification_type":"permission_prompt"}"#
            ),
            Some(CopilotReporterAction::NeedsAttention)
        );
        assert_eq!(
            event("notification", r#"{"notificationType":"agent_idle"}"#),
            Some(CopilotReporterAction::BackgroundIdle)
        );
        assert_eq!(
            event("notification", r#"{"notificationType":"shell_completed"}"#),
            None
        );
        assert_eq!(
            event("subagentStart", r#"{"agentName":"explore"}"#),
            Some(CopilotReporterAction::SubagentStart {
                agent_name: "explore".to_string()
            })
        );
        assert_eq!(
            event("subagentStop", r#"{"agentName":"explore"}"#),
            Some(CopilotReporterAction::SubagentStop {
                agent_name: "explore".to_string()
            })
        );
        assert!(copilot_event_from_hook_payload("subagentStart", b"{}").is_err());
        assert!(copilot_event_from_hook_payload("agentStop", b"{}").is_err());
        assert!(copilot_event_from_hook_payload("unknown", b"{}").is_err());
        assert!(copilot_event_from_hook_payload("agentStop", b"not-json").is_err());
    }

    #[test]
    fn copilot_stop_waits_for_every_active_subagent() {
        let mut activity = CopilotActivity::default();
        let event = |source: &str, action| CopilotReporterEvent {
            source_session_id: source.to_string(),
            action,
        };
        assert_eq!(
            activity.apply(&event(
                "main-session",
                CopilotReporterAction::SessionStarted
            )),
            None
        );
        assert_eq!(
            activity.apply(&event(
                "main-session",
                CopilotReporterAction::BackgroundSubagentQueued
            )),
            Some(AgentLifecycle::Working)
        );
        assert_eq!(
            activity.apply(&event("main-session", CopilotReporterAction::Stop)),
            Some(AgentLifecycle::Working)
        );
        assert_eq!(
            activity.apply(&event(
                "main-session",
                CopilotReporterAction::SubagentStart {
                    agent_name: "general-purpose".to_string()
                }
            )),
            Some(AgentLifecycle::Working)
        );
        assert_eq!(
            activity.apply(&event("child-session", CopilotReporterAction::TurnStarted)),
            Some(AgentLifecycle::Working)
        );
        assert_eq!(
            activity.apply(&event("child-session", CopilotReporterAction::Stop)),
            None
        );
        assert_eq!(
            activity.apply(&event(
                "main-session",
                CopilotReporterAction::SubagentStop {
                    agent_name: "general-purpose".to_string()
                }
            )),
            Some(AgentLifecycle::Done)
        );

        activity.begin_turn();
        assert_eq!(
            activity.apply(&event("main-session", CopilotReporterAction::FatalError)),
            Some(AgentLifecycle::NeedsAttention)
        );
        assert_eq!(
            activity.apply(&event("main-session", CopilotReporterAction::Stop)),
            Some(AgentLifecycle::NeedsAttention)
        );

        activity.begin_turn();
        assert_eq!(
            activity.apply(&event("main-session", CopilotReporterAction::Stop)),
            Some(AgentLifecycle::Done)
        );

        activity.begin_turn();
        assert_eq!(
            activity.apply(&event(
                "main-session",
                CopilotReporterAction::BackgroundSubagentQueued
            )),
            Some(AgentLifecycle::Working)
        );
        assert_eq!(
            activity.apply(&event("main-session", CopilotReporterAction::Stop)),
            Some(AgentLifecycle::Working)
        );
        assert_eq!(
            activity.apply(&event(
                "main-session",
                CopilotReporterAction::BackgroundIdle
            )),
            Some(AgentLifecycle::Idle)
        );
    }

    #[test]
    fn copilot_official_background_event_order_never_finishes_early() {
        let mut activity = CopilotActivity::default();
        let mut apply = |name: &str, payload: &str| {
            let event = copilot_event_from_hook_payload(name, payload.as_bytes())
                .unwrap()
                .unwrap();
            activity.apply(&event)
        };

        assert_eq!(
            apply("sessionStart", r#"{"sessionId":"main-session"}"#),
            None
        );
        assert_eq!(
            apply(
                "userPromptSubmitted",
                r#"{"sessionId":"main-session","prompt":"start"}"#
            ),
            Some(AgentLifecycle::Working)
        );
        assert_eq!(
            apply(
                "postToolUse",
                r#"{"sessionId":"main-session","toolName":"task","toolArgs":{"agent_type":"general-purpose","mode":"background"}}"#
            ),
            Some(AgentLifecycle::Working)
        );
        // Current Copilot emits the main stop before subagentStart. The
        // successful background task event above must close this race window.
        assert_eq!(
            apply("agentStop", r#"{"sessionId":"main-session"}"#),
            Some(AgentLifecycle::Working)
        );
        assert_eq!(
            apply(
                "subagentStart",
                r#"{"sessionId":"main-session","agentName":"general-purpose"}"#
            ),
            Some(AgentLifecycle::Working)
        );
        assert_eq!(
            apply(
                "userPromptSubmitted",
                r#"{"sessionId":"child-session","prompt":"work"}"#
            ),
            Some(AgentLifecycle::Working)
        );
        // A child agentStop must never be interpreted as the main turn stop.
        assert_eq!(apply("agentStop", r#"{"sessionId":"child-session"}"#), None);
        assert_eq!(
            apply(
                "subagentStop",
                r#"{"sessionId":"main-session","agentName":"general-purpose"}"#
            ),
            Some(AgentLifecycle::Done)
        );
    }

    #[test]
    fn opencode_plugin_respects_explicit_runtime_config_and_pure_mode() {
        assert!(opencode_reporter_allowed(&[], false, None));
        assert!(!opencode_reporter_allowed(&[], true, None));
        assert!(!opencode_reporter_allowed(
            &[],
            false,
            Some(OsStr::new("true"))
        ));
        assert!(!opencode_reporter_allowed(
            &["--pure".to_string()],
            false,
            None
        ));
        assert!(opencode_reporter_allowed(
            &["--pure=false".to_string()],
            false,
            None
        ));
    }

    #[test]
    fn opencode_plugin_is_process_scoped_without_editing_user_config() {
        let plugin = write_opencode_reporter_plugin().unwrap();
        assert_eq!(
            std::fs::read_to_string(plugin._file.path()).unwrap(),
            OPENCODE_REPORTER_PLUGIN
        );
        let config: serde_json::Value = serde_json::from_str(&plugin.config_content).unwrap();
        assert_eq!(
            config["plugin"][0],
            plugin._file.path().to_string_lossy().as_ref()
        );
        assert!(config.get("permission").is_none());
    }

    #[test]
    fn a_silent_terminal_only_releases_this_process_own_guess() {
        let long_silence = SILENT_WORKING_TIMEOUT + Duration::from_secs(1);

        assert!(should_settle_silent_working(
            AgentLifecycle::Working,
            AgentStateSource::Heuristic,
            long_silence,
        ));
        // A CLI still redrawing its elapsed-time counter is genuinely working.
        assert!(!should_settle_silent_working(
            AgentLifecycle::Working,
            AgentStateSource::Heuristic,
            SILENT_WORKING_TIMEOUT - Duration::from_secs(1),
        ));
        // An official lifecycle event outranks any silence.
        assert!(!should_settle_silent_working(
            AgentLifecycle::Working,
            AgentStateSource::Integration,
            long_silence,
        ));
        // Waiting for an answer is not something silence can resolve.
        assert!(!should_settle_silent_working(
            AgentLifecycle::NeedsAttention,
            AgentStateSource::Heuristic,
            long_silence,
        ));
    }

    #[test]
    fn dismissing_a_dialog_does_not_put_a_fresh_cli_to_work() {
        let collector = Arc::new(TestSink::default());
        let sink: Arc<dyn AgentSink> = collector.clone();
        let registry = Arc::new(AgentRegistry::new());
        #[cfg(unix)]
        let (executable, arguments) = ("/bin/cat".to_string(), Vec::new());
        #[cfg(windows)]
        let (executable, arguments) = ("cmd.exe".to_string(), vec!["/Q".to_string()]);
        let request = AgentLaunchRequest {
            definition_id: "custom".to_string(),
            label: "Trust dialog test".to_string(),
            executable,
            arguments,
            resume_session_id: None,
            group_id: None,
            seed_input: None,
            restore_existing_session: false,
            profile_config_path: None,
            sandbox: false,
            detached: false,
            working_directory: std::env::current_dir().unwrap().display().to_string(),
            cols: 80,
            rows: 24,
        };
        let session = launch(sink.clone(), registry.clone(), request).unwrap();
        assert_eq!(registry.list()[0].state, AgentLifecycle::Idle);

        // Accepting a first-run folder-trust prompt is not new work.
        send_bytes(sink.as_ref(), &registry, &session.session_id, b"\r").unwrap();
        assert_eq!(registry.list()[0].state, AgentLifecycle::Idle);

        // Answering an open question resumes the turn that asked it.
        registry.update_state(
            &session.session_id,
            AgentLifecycle::NeedsAttention,
            AgentStateSource::Heuristic,
        );
        send_bytes(sink.as_ref(), &registry, &session.session_id, b"\r").unwrap();
        assert_eq!(registry.list()[0].state, AgentLifecycle::Working);

        // A prompt the user actually typed always starts a turn.
        registry.update_state(
            &session.session_id,
            AgentLifecycle::Done,
            AgentStateSource::Integration,
        );
        send_bytes(
            sink.as_ref(),
            &registry,
            &session.session_id,
            b"review this\r",
        )
        .unwrap();
        assert_eq!(registry.list()[0].state, AgentLifecycle::Working);

        // A terminal that has said nothing for long enough is parked, not busy.
        let entry = registry.get(&session.session_id).unwrap();
        assert!(!registry.settle_silent_working(&session.session_id));
        let settle_deadline = Instant::now() + Duration::from_secs(1);
        loop {
            *entry.last_output_at.lock().unwrap() = Instant::now() - SILENT_WORKING_TIMEOUT;
            if registry.settle_silent_working(&session.session_id)
                || registry.list()[0].state == AgentLifecycle::Idle
            {
                break;
            }
            assert!(
                Instant::now() < settle_deadline,
                "silent heuristic state never settled"
            );
            // The PTY reader may publish an input echo concurrently and refresh
            // last_output_at after the test backdates it. Retry after it drains.
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(registry.list()[0].state, AgentLifecycle::Idle);
        // Nothing observed a result, so the sidebar must not claim completion.
        assert_ne!(registry.list()[0].state, AgentLifecycle::Done);
        assert!(!registry.settle_silent_working(&session.session_id));

        registry.stop_all();
    }

    #[test]
    fn semantic_reporter_authenticates_and_overrides_heuristics() {
        let collector = Arc::new(TestSink::default());
        let sink: Arc<dyn AgentSink> = collector.clone();
        let registry = AgentRegistry::with_local_reporter(sink.clone()).unwrap();
        #[cfg(unix)]
        let (executable, arguments) = ("/bin/cat".to_string(), Vec::new());
        #[cfg(windows)]
        let (executable, arguments) = ("cmd.exe".to_string(), vec!["/Q".to_string()]);
        let request = AgentLaunchRequest {
            definition_id: "custom".to_string(),
            label: "Reporter test".to_string(),
            executable,
            arguments,
            resume_session_id: None,
            group_id: None,
            seed_input: None,
            restore_existing_session: false,
            profile_config_path: None,
            sandbox: false,
            detached: false,
            working_directory: std::env::current_dir().unwrap().display().to_string(),
            cols: 80,
            rows: 24,
        };
        let session = launch(sink.clone(), registry.clone(), request).unwrap();
        let (address, token) = registry
            .reporter_credentials(&session.session_id)
            .expect("reporter credentials");
        let entry = registry.get(&session.session_id).unwrap();
        assert!(!entry.integrated_completion.load(Ordering::Acquire));

        assert!(send_report_with_native_session(
            address,
            &session.session_id,
            "wrong-token",
            AgentLifecycle::NeedsAttention,
            None,
        )
        .is_err());
        assert!(send_report_with_native_session(
            address,
            &session.session_id,
            "wrong-token",
            AgentLifecycle::NeedsAttention,
            Some("must-not-be-captured"),
        )
        .is_err());
        // A newly opened CLI is waiting for input, not processing a task.
        assert_eq!(registry.list()[0].state, AgentLifecycle::Idle);
        assert!(registry.list()[0].captured_session_id.is_none());
        assert!(!entry.integrated_completion.load(Ordering::Acquire));

        send_report_with_native_session(
            address,
            &session.session_id,
            &token,
            AgentLifecycle::Done,
            None,
        )
        .unwrap();
        assert!(entry.integrated_completion.load(Ordering::Acquire));
        let summary = &registry.list()[0];
        assert_eq!(summary.state, AgentLifecycle::Done);
        assert_eq!(summary.state_source, AgentStateSource::Integration);
        assert!(!registry.update_state(
            &session.session_id,
            AgentLifecycle::NeedsAttention,
            AgentStateSource::Heuristic,
        ));
        assert_eq!(registry.list()[0].state, AgentLifecycle::Done);

        send_report_with_native_session(
            address,
            &session.session_id,
            &token,
            AgentLifecycle::Done,
            Some("gemini-native-session"),
        )
        .unwrap();
        assert_eq!(
            registry.list()[0].captured_session_id.as_deref(),
            Some("gemini-native-session")
        );
        assert!(collector.captured.lock().unwrap().iter().any(
            |(reported_session_id, native_session_id)| reported_session_id == &session.session_id
                && native_session_id == "gemini-native-session"
        ));

        send_bytes(sink.as_ref(), &registry, &session.session_id, b"\x1b[1;1R").unwrap();
        assert_eq!(registry.list()[0].state, AgentLifecycle::Done);

        send_bytes(
            sink.as_ref(),
            &registry,
            &session.session_id,
            b"next turn\r",
        )
        .unwrap();
        let summary = &registry.list()[0];
        assert_eq!(summary.state, AgentLifecycle::Working);
        assert_eq!(summary.state_source, AgentStateSource::Heuristic);
        send_report_with_native_session(
            address,
            &session.session_id,
            &token,
            AgentLifecycle::Done,
            None,
        )
        .unwrap();
        let summary = &registry.list()[0];
        assert_eq!(summary.state, AgentLifecycle::Done);
        assert_eq!(summary.state_source, AgentStateSource::Integration);
        assert!(collector
            .states
            .lock()
            .unwrap()
            .iter()
            .any(|(_, state, source)| *state == AgentLifecycle::Done
                && *source == AgentStateSource::Integration));

        let usage = AgentUsageReport {
            source_session_id: "child-session".to_string(),
            request_id: "turn-1:api:1".to_string(),
            input_tokens: 120,
            output_tokens: 30,
            cache_read_tokens: 40,
            cache_write_tokens: 5,
            reasoning_tokens: 12,
        };
        assert!(send_usage(address, &session.session_id, "wrong-token", &usage).is_err());
        send_usage(address, &session.session_id, &token, &usage).unwrap();
        // A lost acknowledgement can make the sidecar retry the same request;
        // the authenticated request id keeps the totals idempotent.
        send_usage(address, &session.session_id, &token, &usage).unwrap();
        let summary = &registry.list()[0];
        assert_eq!(
            summary.token_usage,
            Some(AgentTokenUsage {
                input_tokens: 120,
                output_tokens: 30,
                cache_read_tokens: 40,
                cache_write_tokens: 5,
                reasoning_tokens: 12,
                total_tokens: 195,
                api_calls: 1,
            })
        );
        assert_eq!(collector.usages.lock().unwrap().len(), 1);

        disconnect(sink.as_ref(), &registry, &session.session_id).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn restored_output_replays_before_new_pty_data() {
        let collector = Arc::new(TestSink::default());
        let sink: Arc<dyn AgentSink> = collector.clone();
        let registry = Arc::new(AgentRegistry::new());
        let request = AgentLaunchRequest {
            definition_id: "custom".to_string(),
            label: "History replay smoke test".to_string(),
            executable: "powershell.exe".to_string(),
            arguments: vec![
                "-NoLogo".to_string(),
                "-NoProfile".to_string(),
                "-Command".to_string(),
                "Write-Output 'fresh-terminal-output'; Start-Sleep -Seconds 5".to_string(),
            ],
            resume_session_id: None,
            group_id: Some("restored-project".to_string()),
            seed_input: None,
            restore_existing_session: true,
            profile_config_path: None,
            sandbox: false,
            detached: false,
            working_directory: std::env::current_dir().unwrap().display().to_string(),
            cols: 80,
            rows: 24,
        };
        let restored = b"previous-terminal-output\r\n".to_vec();
        let session = launch_with_replay(
            sink.clone(),
            registry.clone(),
            request,
            Some(restored.clone()),
        )
        .unwrap();

        let query_deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < query_deadline
            && !collector
                .data
                .lock()
                .unwrap()
                .windows(4)
                .any(|bytes| bytes == b"\x1b[6n")
        {
            std::thread::sleep(Duration::from_millis(20));
        }
        send_bytes(sink.as_ref(), &registry, &session.session_id, b"\x1b[1;1R").unwrap();

        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline
            && !String::from_utf8_lossy(&collector.data.lock().unwrap())
                .contains("fresh-terminal-output")
        {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(String::from_utf8_lossy(&collector.data.lock().unwrap())
            .contains("fresh-terminal-output"));

        let chunks = collector.chunks.lock().unwrap();
        assert_eq!(chunks[0], (session.session_id.clone(), 0, restored.clone()));
        assert!(chunks
            .iter()
            .skip(1)
            .all(|(id, offset, _)| id != &session.session_id || *offset >= restored.len() as u64));
        drop(chunks);

        let history = registry.terminal_history_snapshots();
        let restored_history = history
            .iter()
            .find(|entry| entry.group_id == "restored-project")
            .expect("restored session history");
        assert!(restored_history.output.starts_with(&restored));
        assert!(String::from_utf8_lossy(&restored_history.output).contains("fresh-terminal-output"));
        disconnect(sink.as_ref(), &registry, &session.session_id).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_pty_runs_powershell_install_pipeline_shape() {
        let collector = Arc::new(TestSink::default());
        let sink: Arc<dyn AgentSink> = collector.clone();
        let registry = Arc::new(AgentRegistry::new());
        let request = AgentLaunchRequest {
            definition_id: "custom".to_string(),
            label: "PowerShell installer smoke test".to_string(),
            executable: "powershell.exe".to_string(),
            arguments: vec![
                "-NoLogo".to_string(),
                "-NoProfile".to_string(),
                "-ExecutionPolicy".to_string(),
                "Bypass".to_string(),
                "-Command".to_string(),
                "Write-Output \"Write-Output 'lattice-install-pipeline-ok'\" | Invoke-Expression"
                    .to_string(),
            ],
            resume_session_id: None,
            group_id: None,
            seed_input: None,
            restore_existing_session: false,
            profile_config_path: None,
            sandbox: false,
            detached: false,
            working_directory: std::env::current_dir().unwrap().display().to_string(),
            cols: 80,
            rows: 24,
        };
        let session = launch(sink.clone(), registry.clone(), request).unwrap();

        let query_deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < query_deadline
            && !collector
                .data
                .lock()
                .unwrap()
                .windows(4)
                .any(|bytes| bytes == b"\x1b[6n")
        {
            std::thread::sleep(Duration::from_millis(20));
        }
        send_bytes(sink.as_ref(), &registry, &session.session_id, b"\x1b[1;1R").unwrap();

        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline && collector.closed.lock().unwrap().is_empty() {
            std::thread::sleep(Duration::from_millis(20));
        }

        let output = String::from_utf8_lossy(&collector.data.lock().unwrap()).into_owned();
        let closed = collector.closed.lock().unwrap();
        assert!(
            output.contains("lattice-install-pipeline-ok"),
            "unexpected PTY output {output:?}; closed reasons: {closed:?}"
        );
        assert_eq!(
            closed.as_slice(),
            ["Process exited: ExitStatus { code: 0, signal: None }"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn local_pty_round_trips_terminal_bytes() {
        let collector = Arc::new(TestSink::default());
        let sink: Arc<dyn AgentSink> = collector.clone();
        let registry = Arc::new(AgentRegistry::new());
        let request = AgentLaunchRequest {
            definition_id: "custom".to_string(),
            label: "Test cat".to_string(),
            executable: "/bin/cat".to_string(),
            arguments: Vec::new(),
            resume_session_id: None,
            group_id: None,
            seed_input: None,
            restore_existing_session: false,
            profile_config_path: None,
            sandbox: false,
            detached: false,
            working_directory: std::env::current_dir().unwrap().display().to_string(),
            cols: 80,
            rows: 24,
        };
        let session = launch(sink.clone(), registry.clone(), request).unwrap();
        send(
            sink.as_ref(),
            &registry,
            &session.session_id,
            &encode(b"lattice-agent-test\n"),
        )
        .unwrap();

        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if String::from_utf8_lossy(&collector.data.lock().unwrap())
                .contains("lattice-agent-test")
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            String::from_utf8_lossy(&collector.data.lock().unwrap()).contains("lattice-agent-test")
        );
        let snapshots = registry.output_snapshots();
        let snapshot = snapshots
            .iter()
            .find(|entry| entry.session_id == session.session_id)
            .expect("active session output snapshot");
        let replay = base64::engine::general_purpose::STANDARD
            .decode(&snapshot.base64)
            .unwrap();
        assert!(String::from_utf8_lossy(&replay).contains("lattice-agent-test"));
        assert_eq!(
            snapshot.end_offset - snapshot.start_offset,
            replay.len() as u64
        );
        disconnect(sink.as_ref(), &registry, &session.session_id).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rapid_process_exit_is_removed_and_emitted_once() {
        let collector = Arc::new(TestSink::default());
        let sink: Arc<dyn AgentSink> = collector.clone();
        let registry = Arc::new(AgentRegistry::new());
        let session = launch(
            sink,
            registry.clone(),
            AgentLaunchRequest {
                definition_id: "custom".to_string(),
                label: "Immediate exit".to_string(),
                executable: "/usr/bin/true".to_string(),
                arguments: Vec::new(),
                resume_session_id: None,
                group_id: None,
                seed_input: None,
                restore_existing_session: false,
                profile_config_path: None,
                sandbox: false,
                detached: false,
                working_directory: std::env::current_dir().unwrap().display().to_string(),
                cols: 80,
                rows: 24,
            },
        )
        .unwrap();

        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline && collector.closed.lock().unwrap().is_empty() {
            std::thread::sleep(Duration::from_millis(20));
        }

        assert!(registry.session_summary(&session.session_id).is_none());
        let closed = collector.closed.lock().unwrap();
        assert_eq!(closed.len(), 1);
        assert!(closed[0].starts_with("Process exited:"));
    }

    #[cfg(unix)]
    #[test]
    fn split_attention_prompt_is_not_reported_as_completed_by_the_pty_reader() {
        let collector = Arc::new(TestSink::default());
        let sink: Arc<dyn AgentSink> = collector.clone();
        let registry = Arc::new(AgentRegistry::new());
        let request = AgentLaunchRequest {
            definition_id: "custom".to_string(),
            label: "Split prompt test".to_string(),
            executable: "/bin/sh".to_string(),
            arguments: vec![
                "-c".to_string(),
                "printf 'permission requ'; sleep 0.1; printf 'ired\\033[?2004h'; sleep 30"
                    .to_string(),
            ],
            resume_session_id: None,
            group_id: None,
            seed_input: None,
            restore_existing_session: false,
            profile_config_path: None,
            sandbox: false,
            detached: false,
            working_directory: std::env::current_dir().unwrap().display().to_string(),
            cols: 80,
            rows: 24,
        };
        let session = launch(sink.clone(), registry.clone(), request).unwrap();

        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline
            && !collector
                .states
                .lock()
                .unwrap()
                .iter()
                .any(|(_, state, _)| *state == AgentLifecycle::NeedsAttention)
        {
            std::thread::sleep(Duration::from_millis(20));
        }

        let states = collector.states.lock().unwrap();
        assert!(states.iter().any(|(_, state, source)| {
            *state == AgentLifecycle::NeedsAttention && *source == AgentStateSource::Heuristic
        }));
        assert!(!states
            .iter()
            .any(|(_, state, _)| *state == AgentLifecycle::Done));
        drop(states);
        disconnect(sink.as_ref(), &registry, &session.session_id).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn disconnect_terminates_a_pty_process_group_that_ignores_sighup() {
        let sink: Arc<dyn AgentSink> = Arc::new(TestSink::default());
        let registry = Arc::new(AgentRegistry::new());
        let request = AgentLaunchRequest {
            definition_id: "custom".to_string(),
            label: "Signal-resistant shell".to_string(),
            executable: "/bin/sh".to_string(),
            arguments: vec!["-c".to_string(), "trap '' HUP; sleep 30 & wait".to_string()],
            resume_session_id: None,
            group_id: None,
            seed_input: None,
            restore_existing_session: false,
            profile_config_path: None,
            sandbox: false,
            detached: false,
            working_directory: std::env::current_dir().unwrap().display().to_string(),
            cols: 80,
            rows: 24,
        };
        let session = launch(sink.clone(), registry.clone(), request).unwrap();
        let process_group = i32::try_from(session.process_id.expect("PTY process ID")).unwrap();

        assert_eq!(unsafe { libc::kill(-process_group, 0) }, 0);
        disconnect(sink.as_ref(), &registry, &session.session_id).unwrap();

        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            let result = unsafe { libc::kill(-process_group, 0) };
            if result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(unsafe { libc::kill(-process_group, 0) }, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH),
        );
    }

    #[test]
    fn disconnect_is_idempotent_after_a_session_is_gone() {
        let sink = TestSink::default();
        let registry = AgentRegistry::new();

        disconnect(&sink, &registry, "agent-missing").unwrap();

        assert!(sink.closed.lock().unwrap().is_empty());
    }

    #[test]
    fn a_clipboard_image_for_a_missing_session_is_not_left_on_disk() {
        let registry = AgentRegistry::new();
        let file = tempfile::NamedTempFile::new().unwrap();
        let path = file.path().to_path_buf();

        assert!(registry
            .stage_clipboard_image("agent-missing", file)
            .is_err());
        assert!(!path.exists());
    }

    #[test]
    fn staged_clipboard_images_have_a_per_session_count_limit() {
        let mut images = StagedAgentImages::default();
        let mut paths = Vec::new();
        for _ in 0..MAX_STAGED_IMAGES_PER_SESSION {
            let file = tempfile::NamedTempFile::new().unwrap();
            paths.push(images.add(file).unwrap());
        }
        let rejected = tempfile::NamedTempFile::new().unwrap();
        let rejected_path = rejected.path().to_path_buf();

        assert!(images.add(rejected).is_err());
        assert!(!rejected_path.exists());
        assert!(paths.iter().all(|path| path.exists()));

        images.clear();
        assert!(paths.iter().all(|path| !path.exists()));
    }

    #[cfg(unix)]
    #[test]
    fn disconnect_removes_staged_clipboard_images() {
        use std::os::unix::fs::PermissionsExt;

        let sink: Arc<dyn AgentSink> = Arc::new(TestSink::default());
        let registry = Arc::new(AgentRegistry::new());
        let session = launch(
            sink.clone(),
            registry.clone(),
            AgentLaunchRequest {
                definition_id: "custom".to_string(),
                label: "Clipboard cleanup".to_string(),
                executable: "/bin/cat".to_string(),
                arguments: Vec::new(),
                resume_session_id: None,
                group_id: None,
                seed_input: None,
                restore_existing_session: false,
                profile_config_path: None,
                sandbox: false,
                detached: false,
                working_directory: std::env::current_dir().unwrap().display().to_string(),
                cols: 80,
                rows: 24,
            },
        )
        .unwrap();
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(b"private clipboard image").unwrap();
        let path = registry
            .stage_clipboard_image(&session.session_id, file)
            .unwrap();

        assert!(path.exists());
        assert_eq!(path.metadata().unwrap().permissions().mode() & 0o077, 0);

        disconnect(sink.as_ref(), &registry, &session.session_id).unwrap();
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn natural_process_exit_removes_staged_clipboard_images() {
        let collector = Arc::new(TestSink::default());
        let sink: Arc<dyn AgentSink> = collector.clone();
        let registry = Arc::new(AgentRegistry::new());
        let session = launch(
            sink.clone(),
            registry.clone(),
            AgentLaunchRequest {
                definition_id: "custom".to_string(),
                label: "Natural clipboard cleanup".to_string(),
                executable: "/bin/sh".to_string(),
                arguments: Vec::new(),
                resume_session_id: None,
                group_id: None,
                seed_input: None,
                restore_existing_session: false,
                profile_config_path: None,
                sandbox: false,
                detached: false,
                working_directory: std::env::current_dir().unwrap().display().to_string(),
                cols: 80,
                rows: 24,
            },
        )
        .unwrap();
        let file = tempfile::NamedTempFile::new().unwrap();
        let path = registry
            .stage_clipboard_image(&session.session_id, file)
            .unwrap();

        send_bytes(sink.as_ref(), &registry, &session.session_id, b"exit\r").unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline && path.exists() {
            std::thread::sleep(Duration::from_millis(20));
        }

        assert!(!path.exists());
        assert!(registry.session_summary(&session.session_id).is_none());
        assert!(collector
            .closed
            .lock()
            .unwrap()
            .iter()
            .any(|reason| reason.starts_with("Process exited:")));
    }

    #[test]
    fn session_identifiers_do_not_repeat_after_registry_restart() {
        for prefix in [
            None,
            Some(crate::agent_daemon::SESSION_ID_PREFIX.to_string()),
        ] {
            let previous = AgentRegistry {
                id_prefix: prefix.clone(),
                ..AgentRegistry::default()
            };
            let restarted = AgentRegistry {
                id_prefix: prefix.clone(),
                ..AgentRegistry::default()
            };
            let mut seen = HashSet::new();
            for registry in [&previous, &restarted] {
                for _ in 0..MAX_AGENT_SESSIONS {
                    let id = registry.next_id().unwrap();
                    assert_eq!(crate::agent_daemon::owns(&id), prefix.is_some());
                    assert!(seen.insert(id), "a restarted registry reused a session id");
                }
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn fresh_launch_stays_separate_from_restored_numeric_groups() {
        for prefix in ["agent-session-", crate::agent_daemon::SESSION_ID_PREFIX] {
            let collector = Arc::new(TestSink::default());
            let sink: Arc<dyn AgentSink> = collector.clone();
            let registry = Arc::new(AgentRegistry {
                id_prefix: Some(prefix.to_string()),
                ..AgentRegistry::default()
            });
            // An earlier run closed its first tab and saved only its second.
            // Restoring that tab consumes id 1; a counter-based quick launch
            // then gets id 2 and accidentally joins the saved tab's group.
            let saved_group = format!("{prefix}2");
            let request = AgentLaunchRequest {
                definition_id: "custom".to_string(),
                label: "Fresh chat".to_string(),
                executable: "/bin/cat".to_string(),
                arguments: Vec::new(),
                resume_session_id: None,
                group_id: None,
                seed_input: None,
                restore_existing_session: false,
                profile_config_path: None,
                sandbox: false,
                detached: false,
                working_directory: std::env::temp_dir().display().to_string(),
                cols: 80,
                rows: 24,
            };
            let restored = launch_with_replay(
                sink.clone(),
                registry.clone(),
                AgentLaunchRequest {
                    group_id: Some(saved_group.clone()),
                    restore_existing_session: true,
                    ..request.clone()
                },
                Some(b"previous conversation\r\n".to_vec()),
            )
            .unwrap();
            registry
                .rename(&restored.session_id, "Existing conversation")
                .unwrap();
            let fresh = launch(sink.clone(), registry.clone(), request.clone()).unwrap();
            let joined = launch(
                sink.clone(),
                registry.clone(),
                AgentLaunchRequest {
                    group_id: Some(saved_group.clone()),
                    ..request
                },
            )
            .unwrap();
            let snapshots = registry.output_snapshots();
            for session in [&restored, &fresh, &joined] {
                disconnect(sink.as_ref(), &registry, &session.session_id).unwrap();
            }

            assert_ne!(fresh.group_id, restored.group_id);
            assert_eq!(fresh.group_id, fresh.session_id);
            assert_eq!(fresh.group_label, "Fresh chat");
            assert!(fresh.captured_session_id.is_none());
            assert!(fresh.launch_arguments.is_empty());
            assert!(!fresh.restore_existing_session);
            let fresh_output = snapshots
                .iter()
                .find(|s| s.session_id == fresh.session_id)
                .unwrap();
            assert!(fresh_output.base64.is_empty());
            // Explicitly adding a CLI to an existing tab still works.
            assert_eq!(joined.group_id, saved_group);
            assert_eq!(joined.group_label, "Existing conversation");
        }
    }

    #[cfg(unix)]
    fn launch_cat(
        sink: &Arc<dyn AgentSink>,
        registry: &Arc<AgentRegistry>,
        label: &str,
    ) -> AgentSessionSummary {
        launch(
            sink.clone(),
            registry.clone(),
            AgentLaunchRequest {
                definition_id: "custom".to_string(),
                label: label.to_string(),
                executable: "/bin/cat".to_string(),
                arguments: Vec::new(),
                resume_session_id: None,
                group_id: None,
                seed_input: None,
                restore_existing_session: false,
                profile_config_path: None,
                sandbox: false,
                detached: false,
                working_directory: std::env::current_dir().unwrap().display().to_string(),
                cols: 80,
                rows: 24,
            },
        )
        .unwrap()
    }

    /// Whether the PTY echoed `needle` back within `within`.
    ///
    /// `/bin/cat` echoes whatever it is given, so this reports whether the
    /// bytes were actually written to the terminal.
    #[cfg(unix)]
    fn received_within(
        collector: &TestSink,
        session_id: &str,
        needle: &str,
        within: Duration,
    ) -> bool {
        let deadline = Instant::now() + within;
        while Instant::now() < deadline {
            let received = collector.session_data.lock().unwrap();
            if received
                .get(session_id)
                .is_some_and(|bytes| String::from_utf8_lossy(bytes).contains(needle))
            {
                return true;
            }
            drop(received);
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn a_heuristic_idle_never_releases_a_queued_prompt() {
        // The silent-working watchdog produces a heuristic Idle after ten
        // minutes of quiet. Typing into a CLI that is merely slow would land
        // the prompt in the middle of whatever it was still doing.
        for state in [AgentLifecycle::Done, AgentLifecycle::Idle] {
            assert!(releases_queued_prompt(state, AgentStateSource::Integration));
            assert!(!releases_queued_prompt(state, AgentStateSource::Heuristic));
        }
        // A turn that is running, or one waiting on the user, is not free
        // whoever reported it.
        for state in [AgentLifecycle::Working, AgentLifecycle::NeedsAttention] {
            for source in [AgentStateSource::Integration, AgentStateSource::Heuristic] {
                assert!(!releases_queued_prompt(state, source));
            }
        }
    }

    #[test]
    fn mcp_prompt_preserves_multiline_text_but_rejects_terminal_keys() {
        assert_eq!(
            mcp_prompt_payload("第一行\r\n第二行\t內容").unwrap(),
            b"\x1b[200~\xe7\xac\xac\xe4\xb8\x80\xe8\xa1\x8c\n\xe7\xac\xac\xe4\xba\x8c\xe8\xa1\x8c\t\xe5\x85\xa7\xe5\xae\xb9\x1b[201~\r"
        );
        for text in [
            "\x03stop",
            "\x1b[201~exit",
            "delete\x7f",
            "\u{009b}31m",
            "\0",
        ] {
            assert!(mcp_prompt_payload(text).is_err());
        }
    }

    #[test]
    fn codex_mcp_submit_unsafe_seed_loses_profile_without_rewriting_seed() {
        for seed in [
            None,
            Some(""),
            Some("   "),
            Some("Read the fixture and report the result."),
            Some("Can you check this?"),
            Some(" ?literal"),
        ] {
            assert!(seed_preserves_codex_input_profile(seed));
        }
        for seed in [
            "first\nsecond",
            "/vim",
            " !echo test",
            "read @file",
            "inspect $skill",
            "?help",
            "\x1b[A",
        ] {
            assert!(!seed_preserves_codex_input_profile(Some(seed)));
            // The eligibility check neither consumes nor rewrites startup text.
            let payload = startup_seed_payload(seed);
            assert!(payload
                .windows(seed.len())
                .any(|part| part == seed.as_bytes()));
        }
    }

    #[test]
    fn codex_mcp_submit_transport_rejects_only_windows_codex_body_keys() {
        for windows in [false, true] {
            for provider in ["codex", "claude", "gemini", "custom"] {
                for text in [
                    "first\rsecond",
                    "first\nsecond",
                    "first\r\nsecond",
                    "first\tsecond",
                    "/vim",
                    "  /keymap",
                    "!echo test",
                    "  !echo test",
                    "email@example.test",
                    "use $variable",
                    "?",
                    "?help",
                ] {
                    assert_eq!(
                        validate_mcp_prompt_transport(windows, provider, text).is_err(),
                        windows && provider == "codex",
                        "windows={windows}, provider={provider}, text={text:?}"
                    );
                }
                for text in [
                    "single line",
                    "單行中文",
                    "甲乙🙂",
                    "Check this?",
                    " ?literal",
                ] {
                    assert!(validate_mcp_prompt_transport(windows, provider, text).is_ok());
                }
            }
        }
    }

    #[test]
    fn codex_mcp_submit_only_frames_windows_controlled_complete_pastes() {
        let bytes = mcp_prompt_payload("first second").unwrap();
        assert!(needs_codex_mcp_submit(true, "codex", Some(1), &bytes));
        assert!(!needs_codex_mcp_submit(false, "codex", Some(1), &bytes));
        for provider in ["claude", "custom", "gemini", "Codex"] {
            assert!(!needs_codex_mcp_submit(true, provider, Some(1), &bytes));
        }
        assert!(!needs_codex_mcp_submit(true, "codex", None, &bytes));
        for bytes in [
            b"\r".as_slice(),
            b"text\r",
            b"\x1b[?2026;1$y",
            b"\x1b[200~draft\x1b[201~",
        ] {
            assert!(!needs_codex_mcp_submit(true, "codex", Some(1), bytes));
        }
    }

    #[test]
    fn codex_mcp_submit_flushes_paste_then_end_and_sends_one_enter() {
        use std::cell::RefCell;
        struct Writer<'a>(&'a RefCell<Vec<Vec<u8>>>);
        impl Write for Writer<'_> {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.borrow_mut().push(bytes.to_vec());
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                self.0.borrow_mut().push(b"flush".to_vec());
                Ok(())
            }
        }
        let events = RefCell::new(Vec::new());
        let bytes = mcp_prompt_payload("first second").unwrap();
        write_codex_mcp_submit(&mut Writer(&events), &bytes, || true).unwrap();
        assert_eq!(
            *events.borrow(),
            vec![
                b"\x1b[200~first second\x1b[201~".to_vec(),
                b"flush".to_vec(),
                b"\x1b[F".to_vec(),
                b"flush".to_vec(),
                b"\r".to_vec(),
                b"flush".to_vec(),
            ]
        );
    }

    #[test]
    fn codex_mcp_submit_rechecks_original_grant_and_liveness_without_retry() {
        use std::cell::Cell;
        let bytes = mcp_prompt_payload("owned prompt").unwrap();
        for change in ["revoke", "regrant", "cancel", "profile-invalidated"] {
            for change_at in [1, 2, 3] {
                let grant = Cell::new(1_u64);
                let alive = Cell::new(true);
                let supported = Cell::new(true);
                let mut checks = 0;
                let mut writer = Vec::new();
                let result = write_codex_mcp_submit(&mut writer, &bytes, || {
                    checks += 1;
                    if checks == change_at {
                        match change {
                            "revoke" => grant.set(2),
                            "regrant" => grant.set(3),
                            "cancel" => alive.set(false),
                            _ => supported.set(false),
                        }
                    }
                    grant.get() == 1 && alive.get() && supported.get()
                });
                assert_eq!(result.unwrap_err().draft_may_remain, change_at > 1);
                let mut expected = if change_at > 1 {
                    bytes[..bytes.len() - 1].to_vec()
                } else {
                    Vec::new()
                };
                if change_at == 3 {
                    expected.extend_from_slice(b"\x1b[F");
                }
                assert_eq!(writer, expected);
                assert!(!writer.contains(&b'\r'));
            }
        }
        let mut writer = Vec::new();
        let result = write_codex_mcp_submit(&mut writer, &bytes, || false);
        assert!(!result.unwrap_err().draft_may_remain);
        assert!(writer.is_empty());
    }

    #[test]
    fn codex_mcp_submit_partial_write_failure_never_retries_enter() {
        struct FailAfterPrefix {
            bytes: Vec<u8>,
        }
        impl Write for FailAfterPrefix {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                if self.bytes.is_empty() {
                    self.bytes.extend_from_slice(&bytes[..3]);
                    return Ok(3);
                }
                Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "owned fixture",
                ))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut writer = FailAfterPrefix { bytes: Vec::new() };
        let bytes = mcp_prompt_payload("test").unwrap();
        let result = write_codex_mcp_submit(&mut writer, &bytes, || true);
        assert!(result.unwrap_err().draft_may_remain);
        assert_eq!(writer.bytes, b"\x1b[2");
    }

    #[test]
    fn codex_mcp_submit_body_end_and_enter_write_errors_never_retry() {
        struct FailingWriter {
            writes: Vec<Vec<u8>>,
            call: usize,
            fail_at: usize,
        }
        impl Write for FailingWriter {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.call += 1;
                if self.call == self.fail_at {
                    return Err(std::io::Error::other("owned fixture"));
                }
                self.writes.push(bytes.to_vec());
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        for fail_at in [1, 2, 3] {
            let mut writer = FailingWriter {
                writes: Vec::new(),
                call: 0,
                fail_at,
            };
            assert!(
                write_codex_mcp_submit(&mut writer, &mcp_prompt_payload("owned").unwrap(), || true)
                    .unwrap_err()
                    .draft_may_remain
            );
            assert_eq!(writer.call, fail_at);
            assert_eq!(writer.writes.len(), fail_at - 1);
            assert!(writer.writes.iter().all(|bytes| !bytes.contains(&b'\r')));
        }
    }

    #[test]
    fn codex_mcp_submit_recovery_rejects_waiters_but_preserves_terminal_reports() {
        let mut input = AgentInputControl {
            desktop_editing: true,
            rejected_desktop_through: 8,
            ..AgentInputControl::default()
        };
        for bytes in [
            b"typed".as_slice(),
            b"\r",
            b"\x1b[A",
            b"\x1b",
            b"\x1b[?2026;1$ytyped",
            b"\x1b]10;draft\r\x07",
            b"\x1b]10;rgb:ffff/ffff/ffff\r\x07",
            b"\x1b]4;999;rgb:ffff/ffff/ffff\x07",
            b"\x1b]10;rgb:ffff/ffff/ffff/text\x07",
        ] {
            assert!(rejects_interrupted_desktop_input(&input, 8, bytes));
        }
        for reply in [
            b"\x1b[1;1R".as_slice(),
            b"\x1b[?2026;1$y",
            b"\x1b]11;rgb:0000/0000/0000\x07",
            b"\x1b]4;255;rgb:f/ff/ffff\x1b\\",
        ] {
            assert!(!rejects_interrupted_desktop_input(&input, 8, reply));
            observe_desktop_input(&mut input, reply);
            assert!(
                input.desktop_busy(),
                "terminal replies cannot release the draft"
            );
        }
        assert!(!rejects_interrupted_desktop_input(
            &input,
            9,
            b"manual review"
        ));
        assert!(
            input.desktop_busy(),
            "a new ticket is manual takeover, not MCP readiness"
        );
    }

    #[test]
    fn codex_mcp_submit_flush_errors_leave_uncertain_draft_without_retry() {
        struct FlushFailure {
            bytes: Vec<u8>,
            calls: usize,
            fail_at: usize,
        }
        impl Write for FlushFailure {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.bytes.extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                self.calls += 1;
                if self.calls == self.fail_at {
                    Err(std::io::Error::other("owned fixture"))
                } else {
                    Ok(())
                }
            }
        }
        for fail_at in [1, 2, 3] {
            let mut writer = FlushFailure {
                bytes: Vec::new(),
                calls: 0,
                fail_at,
            };
            let result =
                write_codex_mcp_submit(&mut writer, &mcp_prompt_payload("test").unwrap(), || true);
            assert!(result.unwrap_err().draft_may_remain);
            assert_eq!(
                writer.bytes.iter().filter(|byte| **byte == b'\r').count(),
                usize::from(fail_at == 3)
            );
            assert!(MCP_DRAFT_RECOVERY_ERROR.contains("could not be confirmed"));
        }
    }

    #[cfg(windows)]
    struct CodexSubmitFixture {
        registry: Arc<AgentRegistry>,
        sink: Arc<TestSink>,
        id: String,
        writes: Arc<Mutex<Vec<Vec<u8>>>>,
        _original_writer: Box<dyn Write + Send>,
    }

    #[cfg(windows)]
    struct CodexSubmitWriter {
        writes: Arc<Mutex<Vec<Vec<u8>>>>,
        flushes: usize,
        gate_at_flush: usize,
        gate: Option<(
            std::sync::mpsc::SyncSender<()>,
            std::sync::mpsc::Receiver<()>,
        )>,
    }

    #[cfg(windows)]
    impl Write for CodexSubmitWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.writes.lock().unwrap().push(bytes.to_vec());
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            self.flushes += 1;
            if self.flushes == self.gate_at_flush {
                if let Some((entered, release)) = self.gate.take() {
                    entered.send(()).map_err(std::io::Error::other)?;
                    release
                        .recv_timeout(Duration::from_secs(5))
                        .map_err(std::io::Error::other)?;
                }
            }
            Ok(())
        }
    }

    #[cfg(windows)]
    impl CodexSubmitFixture {
        fn new(
            gate: Option<(
                std::sync::mpsc::SyncSender<()>,
                std::sync::mpsc::Receiver<()>,
            )>,
        ) -> Self {
            Self::with_flush_gate(gate, 1)
        }

        fn with_flush_gate(
            gate: Option<(
                std::sync::mpsc::SyncSender<()>,
                std::sync::mpsc::Receiver<()>,
            )>,
            gate_at_flush: usize,
        ) -> Self {
            let registry = Arc::new(AgentRegistry::new());
            let sink = Arc::new(TestSink::default());
            let system = PathBuf::from(std::env::var_os("SystemRoot").unwrap());
            // A new owned cmd process provides the real registry/PTY lifetime.
            // No provider, account, model, or provider reporter is launched.
            let session = launch(
                sink.clone(),
                registry.clone(),
                AgentLaunchRequest {
                    definition_id: "custom".into(),
                    label: "Owned submit unit fixture".into(),
                    executable: system.join("System32/cmd.exe").display().to_string(),
                    arguments: vec!["/d".into(), "/q".into()],
                    resume_session_id: None,
                    group_id: None,
                    seed_input: None,
                    restore_existing_session: false,
                    profile_config_path: None,
                    sandbox: false,
                    detached: true,
                    working_directory: std::env::current_dir().unwrap().display().to_string(),
                    cols: 80,
                    rows: 24,
                },
            )
            .unwrap();
            let entry = registry.get(&session.session_id).unwrap();
            entry.summary.lock().unwrap().definition_id = "codex".into();
            // Explicit unit-only attestation; no provider config/model probe.
            entry
                .codex_input_profile_test_supported
                .store(true, Ordering::Release);
            let writes = Arc::new(Mutex::new(Vec::new()));
            let original_writer = std::mem::replace(
                &mut *entry.writer.lock().unwrap(),
                Box::new(CodexSubmitWriter {
                    writes: writes.clone(),
                    flushes: 0,
                    gate_at_flush,
                    gate,
                }),
            );
            set_mcp_control(sink.as_ref(), &registry, &session.session_id, true).unwrap();
            registry.update_state(
                &session.session_id,
                AgentLifecycle::Idle,
                AgentStateSource::Integration,
            );
            Self {
                registry,
                sink,
                id: session.session_id,
                writes,
                _original_writer: original_writer,
            }
        }
    }

    #[cfg(windows)]
    impl Drop for CodexSubmitFixture {
        fn drop(&mut self) {
            self.registry.stop_all();
        }
    }

    #[cfg(windows)]
    #[test]
    fn codex_mcp_submit_unknown_or_invalidated_profile_never_writes_or_queues() {
        for unavailable in ["unknown", "human-input"] {
            let fixture = CodexSubmitFixture::new(None);
            let entry = fixture.registry.get(&fixture.id).unwrap();
            if unavailable == "unknown" {
                entry
                    .codex_input_profile_test_supported
                    .store(false, Ordering::Release);
            } else {
                invalidate_mcp_input_profile(&entry, b"manual");
            }
            for mode in ["now", "queue-ready", "queue-busy"] {
                fixture.registry.update_state(
                    &fixture.id,
                    if mode == "queue-busy" {
                        AgentLifecycle::Working
                    } else {
                        AgentLifecycle::Done
                    },
                    AgentStateSource::Integration,
                );
                for _ in 0..2 {
                    assert_eq!(
                        mcp_prompt(
                            fixture.sink.as_ref(),
                            &fixture.registry,
                            &fixture.id,
                            "owned prompt",
                            mode == "now"
                        )
                        .unwrap_err(),
                        MCP_INPUT_PROFILE_UNSUPPORTED
                    );
                    set_mcp_control(fixture.sink.as_ref(), &fixture.registry, &fixture.id, false)
                        .unwrap();
                    set_mcp_control(fixture.sink.as_ref(), &fixture.registry, &fixture.id, true)
                        .unwrap();
                }
                assert!(fixture.writes.lock().unwrap().is_empty());
                assert!(entry.queued_prompts.lock().unwrap().is_empty());
            }
            // Input capability does not revoke metadata/output or cancellation.
            assert!(fixture.registry.output_range(&fixture.id, 0, 64).is_ok());
            assert_eq!(
                mcp_cancel_queue(fixture.sink.as_ref(), &fixture.registry, &fixture.id).unwrap(),
                0
            );
            mcp_disconnect(fixture.sink.as_ref(), &fixture.registry, &fixture.id).unwrap();
            assert!(fixture.registry.get(&fixture.id).is_err());
        }
    }

    #[cfg(windows)]
    #[test]
    fn codex_mcp_submit_busy_queue_rechecks_profile_and_control_after_preflight() {
        for change in ["human-input", "unknown-profile", "stopping", "regrant"] {
            let fixture = CodexSubmitFixture::new(None);
            let entry = fixture.registry.get(&fixture.id).unwrap();
            fixture.registry.update_state(
                &fixture.id,
                AgentLifecycle::Working,
                AgentStateSource::Integration,
            );
            let original_grant = current_mcp_grant(&entry);
            let mut input = entry.input.lock().unwrap();
            revalidate_mcp_input_profile(&entry, "codex").unwrap();
            // Model a change after launch/source qualification but before the
            // busy queue's final insertion. It must not acknowledge a new task.
            match change {
                "human-input" => invalidate_mcp_input_profile(&entry, b"manual"),
                "unknown-profile" => entry
                    .codex_input_profile_test_supported
                    .store(false, Ordering::Release),
                "stopping" => entry.stopping.store(true, Ordering::Release),
                _ => {
                    set_mcp_control(fixture.sink.as_ref(), &fixture.registry, &fixture.id, false)
                        .unwrap();
                    set_mcp_control(fixture.sink.as_ref(), &fixture.registry, &fixture.id, true)
                        .unwrap();
                }
            }
            let result = enqueue_locked(
                fixture.sink.as_ref(),
                &fixture.registry,
                &fixture.id,
                mcp_prompt_payload("must not queue").unwrap(),
                original_grant,
                &mut input,
            );
            assert!(result.is_err(), "change={change}");
            if matches!(change, "human-input" | "unknown-profile") {
                assert_eq!(result.unwrap_err(), MCP_INPUT_PROFILE_UNSUPPORTED);
            }
            assert!(fixture.writes.lock().unwrap().is_empty());
            assert!(entry.queued_prompts.lock().unwrap().is_empty());
            assert_eq!(entry.summary.lock().unwrap().queued_prompts, 0);
        }
    }

    #[cfg(windows)]
    #[test]
    fn codex_mcp_submit_human_send_and_enqueue_invalidate_before_waiting_for_input() {
        for queued in [false, true] {
            let fixture = CodexSubmitFixture::new(None);
            let entry = fixture.registry.get(&fixture.id).unwrap();
            let input = entry.input.lock().unwrap();
            let human = {
                let (sink, registry, id) = (
                    fixture.sink.clone(),
                    fixture.registry.clone(),
                    fixture.id.clone(),
                );
                std::thread::spawn(move || {
                    if queued {
                        enqueue(sink.as_ref(), &registry, &id, &encode(b"manual prompt\r"))
                            .map(|_| ())
                    } else {
                        send_bytes(sink.as_ref(), &registry, &id, b"manual prompt\r")
                    }
                })
            };
            let deadline = Instant::now() + Duration::from_secs(5);
            while !entry.mcp_input_profile_invalidated.load(Ordering::Acquire)
                && Instant::now() < deadline
            {
                std::thread::yield_now();
            }
            assert!(entry.mcp_input_profile_invalidated.load(Ordering::Acquire));
            assert_eq!(entry.desktop_input_ticket.load(Ordering::Acquire), 1);
            // The rejected MCP call must not wait behind the held input lock.
            assert_eq!(
                mcp_prompt(
                    fixture.sink.as_ref(),
                    &fixture.registry,
                    &fixture.id,
                    "must not merge",
                    false
                )
                .unwrap_err(),
                MCP_INPUT_PROFILE_UNSUPPORTED
            );
            assert!(fixture.writes.lock().unwrap().is_empty());
            drop(input);
            human.join().unwrap().unwrap();
            assert_eq!(
                *fixture.writes.lock().unwrap(),
                vec![b"manual prompt\r".to_vec()]
            );
            assert!(!mcp_input_profile_valid(&entry));
        }
    }

    #[cfg(windows)]
    #[test]
    fn codex_mcp_submit_only_complete_terminal_reports_preserve_profile() {
        let fixture = CodexSubmitFixture::new(None);
        let entry = fixture.registry.get(&fixture.id).unwrap();
        for reply in [
            b"\x1b[1;1R".as_slice(),
            b"\x1b[?2026;1$y",
            b"\x1b]11;rgb:0000/0000/0000\x07",
        ] {
            send_bytes(fixture.sink.as_ref(), &fixture.registry, &fixture.id, reply).unwrap();
            assert!(mcp_input_profile_valid(&entry));
        }
        fixture.writes.lock().unwrap().clear();
        mcp_prompt(
            fixture.sink.as_ref(),
            &fixture.registry,
            &fixture.id,
            "owned prompt",
            true,
        )
        .unwrap();
        assert_eq!(
            fixture
                .writes
                .lock()
                .unwrap()
                .iter()
                .filter(|bytes| bytes.as_slice() == b"\r")
                .count(),
            1
        );
        for bytes in [
            b"\x1b".as_slice(),
            b"\x1b[?2026;",
            b"\x1b]10;draft\r\x07",
            b"\x1b[1;1Rtext",
        ] {
            let fixture = CodexSubmitFixture::new(None);
            let entry = fixture.registry.get(&fixture.id).unwrap();
            send_bytes(fixture.sink.as_ref(), &fixture.registry, &fixture.id, bytes).unwrap();
            assert!(!mcp_input_profile_valid(&entry));
            // Conservative capability loss must not swallow the original input.
            assert_eq!(*fixture.writes.lock().unwrap(), vec![bytes.to_vec()]);
        }
    }

    #[cfg(windows)]
    #[test]
    fn codex_mcp_submit_queued_profile_loss_is_visible_and_does_not_write() {
        let fixture = CodexSubmitFixture::new(None);
        let entry = fixture.registry.get(&fixture.id).unwrap();
        fixture.registry.update_state(
            &fixture.id,
            AgentLifecycle::Working,
            AgentStateSource::Integration,
        );
        for text in ["first task", "second task"] {
            mcp_prompt(
                fixture.sink.as_ref(),
                &fixture.registry,
                &fixture.id,
                text,
                false,
            )
            .unwrap();
        }
        entry
            .codex_input_profile_test_supported
            .store(false, Ordering::Release);
        fixture.registry.update_state(
            &fixture.id,
            AgentLifecycle::Done,
            AgentStateSource::Integration,
        );
        deliver_next_queued(fixture.sink.as_ref(), &fixture.registry, &fixture.id);
        assert!(fixture.writes.lock().unwrap().is_empty());
        assert!(entry.queued_prompts.lock().unwrap().is_empty());
        assert!(String::from_utf8_lossy(&fixture.sink.data.lock().unwrap())
            .contains("could not be delivered safely"));
    }

    #[cfg(windows)]
    #[test]
    fn codex_mcp_submit_desktop_queue_failure_does_not_report_mcp_profile_failure() {
        struct BrokenWriter;
        impl Write for BrokenWriter {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("owned desktop fixture"))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let fixture = CodexSubmitFixture::new(None);
        let entry = fixture.registry.get(&fixture.id).unwrap();
        *entry.writer.lock().unwrap() = Box::new(BrokenWriter);
        entry
            .queued_prompts
            .lock()
            .unwrap()
            .push_back(QueuedPrompt {
                bytes: b"owned desktop prompt\r".to_vec(),
                mcp_grant_epoch: None,
            });
        // A desktop failure must not incorrectly clear another kind of entry
        // or label its cause as a verified MCP input-profile failure.
        entry
            .queued_prompts
            .lock()
            .unwrap()
            .push_back(QueuedPrompt {
                bytes: mcp_prompt_payload("queued MCP prompt").unwrap(),
                mcp_grant_epoch: current_mcp_grant(&entry),
            });
        deliver_next_queued(fixture.sink.as_ref(), &fixture.registry, &fixture.id);
        assert_eq!(entry.queued_prompts.lock().unwrap().len(), 1);
        assert!(!String::from_utf8_lossy(&fixture.sink.data.lock().unwrap())
            .contains("A queued MCP prompt could not be delivered safely"));
    }

    #[cfg(windows)]
    #[test]
    fn codex_mcp_submit_manual_takeover_discards_only_mcp_queue_with_notice() {
        let fixture = CodexSubmitFixture::new(None);
        let entry = fixture.registry.get(&fixture.id).unwrap();
        fixture.registry.update_state(
            &fixture.id,
            AgentLifecycle::Working,
            AgentStateSource::Integration,
        );
        assert_eq!(
            mcp_prompt(
                fixture.sink.as_ref(),
                &fixture.registry,
                &fixture.id,
                "MCP draft",
                false
            )
            .unwrap(),
            1
        );
        enqueue(
            fixture.sink.as_ref(),
            &fixture.registry,
            &fixture.id,
            &encode(b"human draft\r"),
        )
        .unwrap();
        let queue = entry.queued_prompts.lock().unwrap();
        assert_eq!(queue.len(), 1);
        assert!(queue[0].mcp_grant_epoch.is_none());
        assert_eq!(queue[0].bytes, b"human draft\r");
        drop(queue);
        assert!(fixture.writes.lock().unwrap().is_empty());
        assert!(String::from_utf8_lossy(&fixture.sink.data.lock().unwrap())
            .contains("Pending MCP prompts were cancelled"));
    }

    #[cfg(windows)]
    #[test]
    fn codex_mcp_submit_registry_rejects_body_keys_before_send_or_queue() {
        let fixture = CodexSubmitFixture::new(None);
        let entry = fixture.registry.get(&fixture.id).unwrap();
        for mode in ["now", "queue-ready", "queue-busy"] {
            for text in [
                "first\rsecond",
                "first\nsecond",
                "first\r\nsecond",
                "first\tsecond",
                "/vim",
                "  /keymap",
                "!echo test",
                "  !echo test",
                "email@example.test",
                "use $variable",
            ] {
                fixture.registry.update_state(
                    &fixture.id,
                    if mode == "queue-busy" {
                        AgentLifecycle::Working
                    } else {
                        AgentLifecycle::Idle
                    },
                    AgentStateSource::Integration,
                );
                let error = mcp_prompt(
                    fixture.sink.as_ref(),
                    &fixture.registry,
                    &fixture.id,
                    text,
                    mode == "now",
                )
                .unwrap_err();
                assert!(error.contains("single-line prompt"));
                assert!(error.contains("No input was sent or queued"));
                assert!(fixture.writes.lock().unwrap().is_empty());
                assert!(entry.queued_prompts.lock().unwrap().is_empty());
                assert!(!entry.input.lock().unwrap().desktop_busy());
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn codex_mcp_submit_registry_immediate_and_queued_share_the_same_framing() {
        let fixture = CodexSubmitFixture::new(None);
        for mode in ["now", "queue-ready", "queue-busy"] {
            fixture.registry.update_state(
                &fixture.id,
                AgentLifecycle::Idle,
                AgentStateSource::Integration,
            );
            if mode == "queue-busy" {
                fixture.registry.update_state(
                    &fixture.id,
                    AgentLifecycle::Working,
                    AgentStateSource::Integration,
                );
            }
            let depth = mcp_prompt(
                fixture.sink.as_ref(),
                &fixture.registry,
                &fixture.id,
                "first second",
                mode == "now",
            )
            .unwrap();
            if mode == "queue-busy" {
                assert_eq!(depth, 1);
                fixture.registry.update_state(
                    &fixture.id,
                    AgentLifecycle::Done,
                    AgentStateSource::Integration,
                );
                deliver_next_queued(fixture.sink.as_ref(), &fixture.registry, &fixture.id);
            } else {
                assert_eq!(depth, 0);
            }
            assert_eq!(
                *fixture.writes.lock().unwrap(),
                vec![
                    b"\x1b[200~first second\x1b[201~".to_vec(),
                    b"\x1b[F".to_vec(),
                    b"\r".to_vec()
                ]
            );
            fixture.writes.lock().unwrap().clear();
        }
    }

    #[cfg(windows)]
    #[test]
    fn codex_mcp_submit_human_waiter_stops_end_or_enter_without_revoking_grant() {
        for gate_at_flush in [1, 2] {
            for queued_human in [false, true] {
                let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
                let (release_tx, release_rx) = std::sync::mpsc::channel();
                let fixture = CodexSubmitFixture::with_flush_gate(
                    Some((entered_tx, release_rx)),
                    gate_at_flush,
                );
                let entry = fixture.registry.get(&fixture.id).unwrap();
                let submit = {
                    let (sink, registry, id) = (
                        fixture.sink.clone(),
                        fixture.registry.clone(),
                        fixture.id.clone(),
                    );
                    std::thread::spawn(move || {
                        mcp_prompt(sink.as_ref(), &registry, &id, "owned draft", true)
                    })
                };
                entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                let human = {
                    let (sink, registry, id) = (
                        fixture.sink.clone(),
                        fixture.registry.clone(),
                        fixture.id.clone(),
                    );
                    std::thread::spawn(move || {
                        if queued_human {
                            enqueue(sink.as_ref(), &registry, &id, &encode(b"old human input\r"))
                                .map(|_| ())
                        } else {
                            send_bytes(sink.as_ref(), &registry, &id, b"old human input\r")
                        }
                    })
                };
                let deadline = Instant::now() + Duration::from_secs(5);
                while !entry.mcp_input_profile_invalidated.load(Ordering::Acquire)
                    && Instant::now() < deadline
                {
                    std::thread::yield_now();
                }
                assert!(entry.mcp_input_profile_invalidated.load(Ordering::Acquire));
                assert_eq!(
                    current_mcp_grant(&entry),
                    Some(1),
                    "no revoke masks the profile check"
                );
                release_tx.send(()).unwrap();
                assert_eq!(
                    submit.join().unwrap().unwrap_err(),
                    MCP_DRAFT_RECOVERY_ERROR
                );
                assert_eq!(human.join().unwrap().unwrap_err(), MCP_DRAFT_RECOVERY_ERROR);
                let mut expected = vec![b"\x1b[200~owned draft\x1b[201~".to_vec()];
                if gate_at_flush == 2 {
                    expected.push(b"\x1b[F".to_vec());
                }
                assert_eq!(*fixture.writes.lock().unwrap(), expected);
                assert!(entry.queued_prompts.lock().unwrap().is_empty());
                assert!(entry.input.lock().unwrap().desktop_busy());
                send_bytes(
                    fixture.sink.as_ref(),
                    &fixture.registry,
                    &fixture.id,
                    b"manual review",
                )
                .unwrap();
                assert_eq!(
                    fixture.writes.lock().unwrap().last().unwrap(),
                    b"manual review"
                );
                assert_eq!(
                    mcp_prompt(
                        fixture.sink.as_ref(),
                        &fixture.registry,
                        &fixture.id,
                        "must not restart",
                        false
                    )
                    .unwrap_err(),
                    MCP_INPUT_PROFILE_UNSUPPORTED
                );
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn codex_mcp_submit_registry_abort_rejects_waiting_typing_and_keeps_replies() {
        let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let fixture = CodexSubmitFixture::new(Some((entered_tx, release_rx)));
        let entry = fixture.registry.get(&fixture.id).unwrap();
        let submit = {
            let (sink, registry, id) = (
                fixture.sink.clone(),
                fixture.registry.clone(),
                fixture.id.clone(),
            );
            std::thread::spawn(move || {
                mcp_prompt(sink.as_ref(), &registry, &id, "owned draft", true)
            })
        };
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let typing = {
            let (sink, registry, id) = (
                fixture.sink.clone(),
                fixture.registry.clone(),
                fixture.id.clone(),
            );
            std::thread::spawn(move || send_bytes(sink.as_ref(), &registry, &id, b"do not merge\r"))
        };
        let reply = {
            let (sink, registry, id) = (
                fixture.sink.clone(),
                fixture.registry.clone(),
                fixture.id.clone(),
            );
            std::thread::spawn(move || send_bytes(sink.as_ref(), &registry, &id, b"\x1b[?2026;1$y"))
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        while entry.desktop_input_ticket.load(Ordering::Acquire) < 2 && Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert_eq!(entry.desktop_input_ticket.load(Ordering::Acquire), 2);
        set_mcp_control(fixture.sink.as_ref(), &fixture.registry, &fixture.id, false).unwrap();
        set_mcp_control(fixture.sink.as_ref(), &fixture.registry, &fixture.id, true).unwrap();
        release_tx.send(()).unwrap();
        assert!(submit.join().unwrap().is_err());
        assert_eq!(
            typing.join().unwrap().unwrap_err(),
            MCP_DRAFT_RECOVERY_ERROR
        );
        assert!(reply.join().unwrap().is_ok());
        assert_eq!(
            *fixture.writes.lock().unwrap(),
            vec![
                b"\x1b[200~owned draft\x1b[201~".to_vec(),
                b"\x1b[?2026;1$y".to_vec()
            ]
        );
        assert!(entry.input.lock().unwrap().desktop_busy());
        let summary = fixture.registry.session_summary(&fixture.id).unwrap();
        assert_eq!(summary.state, AgentLifecycle::NeedsAttention);
        assert_eq!(summary.state_source, AgentStateSource::Heuristic);
        assert!(
            String::from_utf8_lossy(&fixture.sink.data.lock().unwrap()).contains("[LatticeTerm]")
        );
        mcp_prompt(
            fixture.sink.as_ref(),
            &fixture.registry,
            &fixture.id,
            "queued next",
            false,
        )
        .unwrap_err();
        fixture.registry.update_state(
            &fixture.id,
            AgentLifecycle::Done,
            AgentStateSource::Integration,
        );
        deliver_next_queued(fixture.sink.as_ref(), &fixture.registry, &fixture.id);
        assert_eq!(
            fixture.writes.lock().unwrap().len(),
            2,
            "late official completion must not pass draft ownership"
        );
    }

    #[cfg(windows)]
    #[test]
    fn codex_mcp_submit_waiting_request_cannot_adopt_a_regranted_epoch() {
        for send_now in [true, false] {
            let fixture = CodexSubmitFixture::new(None);
            let entry = fixture.registry.get(&fixture.id).unwrap();
            let input = entry.input.lock().unwrap();
            let (snapshotted_tx, snapshotted_rx) = std::sync::mpsc::sync_channel(1);
            let (resume_tx, resume_rx) = std::sync::mpsc::channel();
            let pending = {
                let (sink, registry, id) = (
                    fixture.sink.clone(),
                    fixture.registry.clone(),
                    fixture.id.clone(),
                );
                std::thread::spawn(move || {
                    mcp_prompt_with_grant_observer(
                        sink.as_ref(),
                        &registry,
                        &id,
                        "old request",
                        send_now,
                        || {
                            snapshotted_tx.send(()).unwrap();
                            resume_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                        },
                    )
                })
            };
            snapshotted_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            set_mcp_control(fixture.sink.as_ref(), &fixture.registry, &fixture.id, false).unwrap();
            set_mcp_control(fixture.sink.as_ref(), &fixture.registry, &fixture.id, true).unwrap();
            resume_tx.send(()).unwrap();
            drop(input);
            assert!(pending
                .join()
                .unwrap()
                .unwrap_err()
                .contains("original MCP control grant"));
            assert!(fixture.writes.lock().unwrap().is_empty());
            assert!(entry.queued_prompts.lock().unwrap().is_empty());
        }
    }

    #[cfg(windows)]
    #[test]
    fn codex_mcp_submit_cancel_during_paste_never_sends_the_enter() {
        let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let fixture = CodexSubmitFixture::new(Some((entered_tx, release_rx)));
        let submit = {
            let (sink, registry, id) = (
                fixture.sink.clone(),
                fixture.registry.clone(),
                fixture.id.clone(),
            );
            std::thread::spawn(move || {
                mcp_prompt(sink.as_ref(), &registry, &id, "cancelled draft", true)
            })
        };
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        disconnect(fixture.sink.as_ref(), &fixture.registry, &fixture.id).unwrap();
        release_tx.send(()).unwrap();
        assert_eq!(
            submit.join().unwrap().unwrap_err(),
            MCP_DRAFT_RECOVERY_ERROR
        );
        assert_eq!(
            *fixture.writes.lock().unwrap(),
            vec![b"\x1b[200~cancelled draft\x1b[201~".to_vec()]
        );
        assert!(fixture.registry.get(&fixture.id).is_err());
    }

    #[test]
    fn terminal_replies_and_multiline_paste_preserve_desktop_ownership_across_chunks() {
        for reply in [
            b"\x1b[1;1R".as_slice(),
            b"\x1b[?1;2c",
            b"\x1b[>0;1;0c",
            b"\x1b[?2026;2$y",
            b"\x1b[4;2$y",
            b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\",
            b"\x1b]11;rgb:0000/0000/0000\x07",
            b"\x1b[I\x1b[O",
        ] {
            for split in 0..=reply.len() {
                let mut input = AgentInputControl::default();
                assert!(!observe_desktop_input(&mut input, &reply[..split]));
                assert!(!observe_desktop_input(&mut input, &reply[split..]));
                assert!(!input.desktop_busy());
            }
        }
        let paste = b"\x1b[200~first\nsecond\x1b[201~";
        for split in 0..=paste.len() {
            let mut input = AgentInputControl::default();
            observe_desktop_input(&mut input, &paste[..split]);
            observe_desktop_input(&mut input, &paste[split..]);
            assert!(
                input.desktop_busy(),
                "paste is not submitted at split {split}"
            );
            observe_desktop_input(&mut input, b"\r");
            assert!(!input.desktop_busy());
            observe_desktop_input(&mut input, b"submitted\rstill editing");
            assert!(input.desktop_busy());
        }
        let mut input = AgentInputControl::default();
        observe_desktop_input(&mut input, b"\x1b[A");
        assert!(input.desktop_busy(), "history selection is user editing");
    }

    #[test]
    fn malformed_mode_reports_and_unknown_csi_keep_desktop_ownership() {
        for sequence in [
            b"\x1b[?2026;9$y".as_slice(),
            b"\x1b[?2026;1;0$y",
            b"\x1b[?;1$y",
            b"\x1b[?2026;1y",
            b"\x1b[>2026;1$y",
            b"\x1b[?2026x",
            b"\x1b[A",
        ] {
            assert!(!is_terminal_status_reply(sequence));
            for split in 0..=sequence.len() {
                let mut input = AgentInputControl::default();
                observe_desktop_input(&mut input, &sequence[..split]);
                observe_desktop_input(&mut input, &sequence[split..]);
                assert!(input.desktop_busy(), "unknown input at split {split}");
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_blocked_terminal_write_cannot_block_revocation_or_stopping() {
        struct BlockedWriter {
            entered: std::sync::mpsc::SyncSender<()>,
            release: std::sync::mpsc::Receiver<()>,
        }
        impl Write for BlockedWriter {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                let _ = self.entered.send(());
                let _ = self.release.recv();
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let collector = Arc::new(TestSink::default());
        let sink: Arc<dyn AgentSink> = collector.clone();
        let registry = Arc::new(AgentRegistry::new());
        let session = launch_cat(&sink, &registry, "Blocked input");
        let id = &session.session_id;
        let entry = registry.get(id).unwrap();
        set_mcp_control(sink.as_ref(), &registry, id, true).unwrap();
        let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
        let _original_writer = std::mem::replace(
            &mut *entry.writer.lock().unwrap(),
            Box::new(BlockedWriter {
                entered: entered_tx,
                release: release_rx,
            }),
        );
        let writer = {
            let sink = sink.clone();
            let registry = registry.clone();
            let id = id.clone();
            std::thread::spawn(move || send_bytes(sink.as_ref(), &registry, &id, b"blocked\r"))
        };
        entered_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        // The output reader's heuristic update must also return promptly,
        // otherwise output backpressure can deadlock the blocked writer.
        let (result_tx, result_rx) = std::sync::mpsc::sync_channel(1);
        let stop = {
            let sink = sink.clone();
            let registry = registry.clone();
            let id = id.clone();
            std::thread::spawn(move || {
                let _ =
                    registry.update_state(&id, AgentLifecycle::Idle, AgentStateSource::Heuristic);
                let revoked = set_mcp_control(sink.as_ref(), &registry, &id, false);
                let stopped = disconnect(sink.as_ref(), &registry, &id);
                let _ = result_tx.send((revoked, stopped));
            })
        };
        let result = result_rx.recv_timeout(Duration::from_secs(2));
        // Always release our synthetic writer before assertions or joining.
        let _ = release_tx.send(());
        let _ = writer.join();
        stop.join().unwrap();
        let (revoked, stopped) = result.expect("revocation and stop waited for the writer");
        assert!(
            revoked.is_ok() && stopped.is_ok(),
            "revoke: {revoked:?}, stop: {stopped:?}"
        );
        assert!(registry.session_summary(id).is_none());
        registry.stop_all();
    }

    #[cfg(unix)]
    #[test]
    fn pending_startup_instructions_precede_mcp_prompts() {
        let collector = Arc::new(TestSink::default());
        let sink: Arc<dyn AgentSink> = collector.clone();
        let registry = Arc::new(AgentRegistry::new());
        let session = launch(
            sink.clone(),
            registry.clone(),
            AgentLaunchRequest {
                definition_id: "custom".into(),
                label: "Seed ordering".into(),
                executable: "/bin/cat".into(),
                arguments: Vec::new(),
                resume_session_id: None,
                group_id: None,
                seed_input: Some("startup-first".into()),
                restore_existing_session: false,
                profile_config_path: None,
                sandbox: false,
                detached: false,
                working_directory: std::env::current_dir().unwrap().display().to_string(),
                cols: 80,
                rows: 24,
            },
        )
        .unwrap();
        let id = &session.session_id;
        set_mcp_control(sink.as_ref(), &registry, id, true).unwrap();
        registry.update_state(id, AgentLifecycle::Idle, AgentStateSource::Integration);
        assert!(mcp_prompt(sink.as_ref(), &registry, id, "too-early", true).is_err());
        assert_eq!(
            mcp_prompt(sink.as_ref(), &registry, id, "external-second", false).unwrap(),
            1
        );
        let entry = registry.get(id).unwrap();
        entry.startup_gate.observe(b"\x1b[?2004h");
        assert!(received_within(
            &collector,
            id,
            "startup-first",
            Duration::from_secs(4)
        ));
        registry.update_state(id, AgentLifecycle::Done, AgentStateSource::Integration);
        deliver_next_queued(sink.as_ref(), &registry, id);
        assert!(received_within(
            &collector,
            id,
            "external-second",
            Duration::from_secs(3)
        ));
        let output = collector.session_data.lock().unwrap()[id].clone();
        let output = String::from_utf8_lossy(&output);
        assert!(output.find("startup-first") < output.find("external-second"));
        registry.stop_all();
    }

    #[cfg(unix)]
    #[test]
    fn mcp_now_requires_authoritative_readiness_and_a_current_grant() {
        let collector = Arc::new(TestSink::default());
        let sink: Arc<dyn AgentSink> = collector.clone();
        let registry = Arc::new(AgentRegistry::new());
        let session = launch_cat(&sink, &registry, "MCP readiness");
        let id = &session.session_id;
        set_mcp_control(sink.as_ref(), &registry, id, true).unwrap();
        assert!(mcp_prompt(sink.as_ref(), &registry, id, "not-ready", true).is_err());
        for state in [AgentLifecycle::Working, AgentLifecycle::NeedsAttention] {
            registry.update_state(id, state, AgentStateSource::Integration);
            assert!(mcp_prompt(sink.as_ref(), &registry, id, "not-ready", true).is_err());
        }
        registry.update_state(id, AgentLifecycle::Idle, AgentStateSource::Integration);
        assert_eq!(
            mcp_prompt(sink.as_ref(), &registry, id, "official-ready", true).unwrap(),
            0
        );
        assert!(received_within(
            &collector,
            id,
            "official-ready",
            Duration::from_secs(3)
        ));
        assert!(mcp_prompt(sink.as_ref(), &registry, id, "second-turn", true).is_err());
        set_mcp_control(sink.as_ref(), &registry, id, false).unwrap();
        assert!(mcp_prompt(sink.as_ref(), &registry, id, "revoked", false).is_err());
        assert!(mcp_cancel_queue(sink.as_ref(), &registry, id).is_err());
        assert!(mcp_disconnect(sink.as_ref(), &registry, id).is_err());
        registry.stop_all();
    }

    #[cfg(unix)]
    #[test]
    fn revoking_mcp_control_drops_external_queue_but_preserves_desktop_work() {
        let collector = Arc::new(TestSink::default());
        let sink: Arc<dyn AgentSink> = collector.clone();
        let registry = Arc::new(AgentRegistry::new());
        let session = launch_cat(&sink, &registry, "MCP revoke");
        let id = &session.session_id;
        set_mcp_control(sink.as_ref(), &registry, id, true).unwrap();
        registry.update_state(id, AgentLifecycle::Working, AgentStateSource::Integration);
        mcp_prompt(sink.as_ref(), &registry, id, "external-revoked", false).unwrap();
        enqueue(
            sink.as_ref(),
            &registry,
            id,
            &encode(b"desktop-preserved\r"),
        )
        .unwrap();
        assert_eq!(
            set_mcp_control(sink.as_ref(), &registry, id, false).unwrap(),
            1
        );
        assert_eq!(registry.session_summary(id).unwrap().queued_prompts, 1);
        // Re-granting never revives a prompt submitted under the old grant.
        set_mcp_control(sink.as_ref(), &registry, id, true).unwrap();
        registry.update_state(id, AgentLifecycle::Done, AgentStateSource::Integration);
        deliver_next_queued(sink.as_ref(), &registry, id);
        assert!(received_within(
            &collector,
            id,
            "desktop-preserved",
            Duration::from_secs(3)
        ));
        assert!(!received_within(
            &collector,
            id,
            "external-revoked",
            Duration::from_millis(100)
        ));
        registry.stop_all();
    }

    #[cfg(unix)]
    #[test]
    fn regranting_control_cannot_revive_a_prompt_already_taken_from_the_queue() {
        let collector = Arc::new(TestSink::default());
        let sink: Arc<dyn AgentSink> = collector.clone();
        let registry = Arc::new(AgentRegistry::new());
        let session = launch_cat(&sink, &registry, "MCP grant epochs");
        let id = &session.session_id;
        let entry = registry.get(id).unwrap();
        set_mcp_control(sink.as_ref(), &registry, id, true).unwrap();
        let first_grant = current_mcp_grant(&entry).unwrap();
        set_mcp_control(sink.as_ref(), &registry, id, true).unwrap();
        assert_eq!(current_mcp_grant(&entry), Some(first_grant));
        registry.update_state(id, AgentLifecycle::Working, AgentStateSource::Integration);
        mcp_prompt(sink.as_ref(), &registry, id, "popped-old-grant", false).unwrap();
        enqueue(
            sink.as_ref(),
            &registry,
            id,
            &encode(b"desktop-unaffected\r"),
        )
        .unwrap();
        registry.update_state(id, AgentLifecycle::Done, AgentStateSource::Integration);

        {
            let mut input = entry.input.lock().unwrap();
            let old_prompt = entry.queued_prompts.lock().unwrap().pop_front().unwrap();
            assert_eq!(old_prompt.mcp_grant_epoch, Some(first_grant));
            // Revoke after dequeueing, while the delivery still holds input.
            // The old prompt is no longer visible to queue cleanup.
            assert_eq!(
                set_mcp_control(sink.as_ref(), &registry, id, false).unwrap(),
                0
            );
            let revoked_epoch = entry.mcp_grant_epoch.load(Ordering::Acquire);
            set_mcp_control(sink.as_ref(), &registry, id, false).unwrap();
            assert_eq!(entry.mcp_grant_epoch.load(Ordering::Acquire), revoked_epoch);
            set_mcp_control(sink.as_ref(), &registry, id, true).unwrap();
            assert_ne!(current_mcp_grant(&entry), Some(first_grant));
            assert!(!send_queued_prompt_locked(
                sink.as_ref(),
                &registry,
                id,
                old_prompt,
                &mut input
            )
            .unwrap());

            let desktop_prompt = entry.queued_prompts.lock().unwrap().pop_front().unwrap();
            assert!(desktop_prompt.mcp_grant_epoch.is_none());
            assert!(send_queued_prompt_locked(
                sink.as_ref(),
                &registry,
                id,
                desktop_prompt,
                &mut input
            )
            .unwrap());
            store_queue_depth(&registry, id, 0);
        }
        assert!(received_within(
            &collector,
            id,
            "desktop-unaffected",
            Duration::from_secs(3)
        ));
        let output = collector.session_data.lock().unwrap()[id].clone();
        assert!(!String::from_utf8_lossy(&output).contains("popped-old-grant"));

        registry.update_state(id, AgentLifecycle::Done, AgentStateSource::Integration);
        assert_eq!(
            mcp_prompt(sink.as_ref(), &registry, id, "new-grant-works", true).unwrap(),
            0
        );
        assert!(received_within(
            &collector,
            id,
            "new-grant-works",
            Duration::from_secs(3)
        ));
        registry.stop_all();
    }

    #[cfg(unix)]
    #[test]
    fn mcp_prompt_never_appends_to_a_desktop_edit_in_progress() {
        let collector = Arc::new(TestSink::default());
        let sink: Arc<dyn AgentSink> = collector.clone();
        let registry = Arc::new(AgentRegistry::new());
        let session = launch_cat(&sink, &registry, "MCP manual input");
        let id = &session.session_id;
        set_mcp_control(sink.as_ref(), &registry, id, true).unwrap();
        registry.update_state(id, AgentLifecycle::Idle, AgentStateSource::Integration);
        send_bytes(sink.as_ref(), &registry, id, b"unfinished-desktop").unwrap();
        assert!(mcp_prompt(sink.as_ref(), &registry, id, "must-not-append", true).is_err());
        assert_eq!(
            mcp_prompt(sink.as_ref(), &registry, id, "queued-external", false).unwrap(),
            1
        );
        deliver_next_queued(sink.as_ref(), &registry, id);
        assert_eq!(registry.session_summary(id).unwrap().queued_prompts, 1);
        send_bytes(sink.as_ref(), &registry, id, b"\r").unwrap();
        registry.update_state(id, AgentLifecycle::Done, AgentStateSource::Integration);
        deliver_next_queued(sink.as_ref(), &registry, id);
        assert!(received_within(
            &collector,
            id,
            "queued-external",
            Duration::from_secs(3)
        ));
        registry.stop_all();
    }

    #[cfg(unix)]
    #[test]
    fn concurrent_mcp_prompts_cannot_both_claim_the_same_ready_turn() {
        let collector = Arc::new(TestSink::default());
        let sink: Arc<dyn AgentSink> = collector.clone();
        let registry = Arc::new(AgentRegistry::new());
        let session = launch_cat(&sink, &registry, "MCP concurrent input");
        set_mcp_control(sink.as_ref(), &registry, &session.session_id, true).unwrap();
        registry.update_state(
            &session.session_id,
            AgentLifecycle::Idle,
            AgentStateSource::Integration,
        );
        let gate = Arc::new(std::sync::Barrier::new(3));
        let workers = (0..2)
            .map(|index| {
                let sink = sink.clone();
                let registry = registry.clone();
                let gate = gate.clone();
                let id = session.session_id.clone();
                std::thread::spawn(move || {
                    gate.wait();
                    mcp_prompt(
                        sink.as_ref(),
                        &registry,
                        &id,
                        &format!("prompt-{index}"),
                        true,
                    )
                })
            })
            .collect::<Vec<_>>();
        gate.wait();
        let successes = workers
            .into_iter()
            .filter_map(|worker| worker.join().unwrap().ok())
            .count();
        assert_eq!(successes, 1);
        registry.stop_all();
    }

    #[cfg(unix)]
    #[test]
    fn a_free_agent_takes_a_queued_prompt_immediately() {
        let collector = Arc::new(TestSink::default());
        let sink: Arc<dyn AgentSink> = collector.clone();
        let registry = Arc::new(AgentRegistry::new());
        let session = launch_cat(&sink, &registry, "Queue idle");
        registry.update_state(
            &session.session_id,
            AgentLifecycle::Done,
            AgentStateSource::Integration,
        );

        // Queueing it would leave it waiting for an integration event that
        // nothing is running to produce.
        let depth = enqueue(
            sink.as_ref(),
            &registry,
            &session.session_id,
            &encode(b"queued-immediate\n"),
        )
        .unwrap();

        assert_eq!(depth, 0);
        assert!(received_within(
            &collector,
            &session.session_id,
            "queued-immediate",
            Duration::from_secs(3)
        ));
        registry.stop_all();
    }

    #[cfg(unix)]
    #[test]
    fn a_busy_agent_holds_prompts_until_its_turn_ends() {
        let collector = Arc::new(TestSink::default());
        let sink: Arc<dyn AgentSink> = collector.clone();
        let registry = Arc::new(AgentRegistry::new());
        let session = launch_cat(&sink, &registry, "Queue busy");
        registry.update_state(
            &session.session_id,
            AgentLifecycle::Working,
            AgentStateSource::Integration,
        );

        assert_eq!(
            enqueue(
                sink.as_ref(),
                &registry,
                &session.session_id,
                &encode(b"queued-first\n")
            )
            .unwrap(),
            1
        );
        assert_eq!(
            enqueue(
                sink.as_ref(),
                &registry,
                &session.session_id,
                &encode(b"queued-second\n")
            )
            .unwrap(),
            2
        );
        assert_eq!(
            registry
                .session_summary(&session.session_id)
                .unwrap()
                .queued_prompts,
            2
        );
        assert!(!received_within(
            &collector,
            &session.session_id,
            "queued-first",
            Duration::from_millis(300)
        ));

        // One turn end releases exactly one prompt, so a queue cannot empty
        // itself into a CLI that has only reported finishing once.
        registry.update_state(
            &session.session_id,
            AgentLifecycle::Done,
            AgentStateSource::Integration,
        );
        deliver_next_queued(sink.as_ref(), &registry, &session.session_id);
        assert!(received_within(
            &collector,
            &session.session_id,
            "queued-first",
            Duration::from_secs(3)
        ));
        assert_eq!(
            registry
                .session_summary(&session.session_id)
                .unwrap()
                .queued_prompts,
            1
        );
        assert!(!received_within(
            &collector,
            &session.session_id,
            "queued-second",
            Duration::from_millis(300)
        ));
        registry.stop_all();
    }

    #[cfg(unix)]
    #[test]
    fn a_queue_is_bounded_and_can_be_dropped() {
        let collector = Arc::new(TestSink::default());
        let sink: Arc<dyn AgentSink> = collector.clone();
        let registry = Arc::new(AgentRegistry::new());
        let session = launch_cat(&sink, &registry, "Queue bounds");
        registry.update_state(
            &session.session_id,
            AgentLifecycle::Working,
            AgentStateSource::Integration,
        );

        for index in 0..MAX_QUEUED_PROMPTS {
            enqueue(
                sink.as_ref(),
                &registry,
                &session.session_id,
                &encode(format!("queued-{index}\n").as_bytes()),
            )
            .unwrap();
        }
        let refused = enqueue(
            sink.as_ref(),
            &registry,
            &session.session_id,
            &encode(b"one-too-many\n"),
        );
        assert!(refused.is_err(), "expected the queue to be bounded");

        assert_eq!(
            clear_queue(sink.as_ref(), &registry, &session.session_id).unwrap(),
            MAX_QUEUED_PROMPTS
        );
        assert_eq!(
            registry
                .session_summary(&session.session_id)
                .unwrap()
                .queued_prompts,
            0
        );
        registry.stop_all();
    }

    #[cfg(unix)]
    #[test]
    fn an_empty_queued_prompt_is_refused() {
        let collector = Arc::new(TestSink::default());
        let sink: Arc<dyn AgentSink> = collector.clone();
        let registry = Arc::new(AgentRegistry::new());
        let session = launch_cat(&sink, &registry, "Queue empty");

        assert!(enqueue(sink.as_ref(), &registry, &session.session_id, &encode(b"")).is_err());
        registry.stop_all();
    }

    #[test]
    fn broadcast_fans_out_to_each_selected_pty() {
        let collector = Arc::new(TestSink::default());
        let sink: Arc<dyn AgentSink> = collector.clone();
        let registry = Arc::new(AgentRegistry::new());
        let mut sessions = Vec::new();
        for label in ["Agent one", "Agent two"] {
            sessions.push(
                launch(
                    sink.clone(),
                    registry.clone(),
                    AgentLaunchRequest {
                        definition_id: "custom".to_string(),
                        label: label.to_string(),
                        executable: "/bin/cat".to_string(),
                        arguments: Vec::new(),
                        resume_session_id: None,
                        group_id: None,
                        seed_input: None,
                        restore_existing_session: false,
                        profile_config_path: None,
                        sandbox: false,
                        detached: false,
                        working_directory: std::env::current_dir().unwrap().display().to_string(),
                        cols: 80,
                        rows: 24,
                    },
                )
                .unwrap(),
            );
        }

        let target_ids: Vec<_> = sessions
            .iter()
            .map(|session| session.session_id.clone())
            .collect();
        let outcomes = broadcast(
            sink.as_ref(),
            &registry,
            &target_ids,
            &encode(b"fleet-broadcast-test\n"),
        )
        .unwrap();
        assert!(outcomes.iter().all(|outcome| outcome.delivered));

        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            let received = collector.session_data.lock().unwrap();
            if target_ids.iter().all(|session_id| {
                received.get(session_id).is_some_and(|bytes| {
                    String::from_utf8_lossy(bytes).contains("fleet-broadcast-test")
                })
            }) {
                break;
            }
            drop(received);
            std::thread::sleep(Duration::from_millis(20));
        }
        let received = collector.session_data.lock().unwrap();
        assert!(target_ids.iter().all(|session_id| {
            received.get(session_id).is_some_and(|bytes| {
                String::from_utf8_lossy(bytes).contains("fleet-broadcast-test")
            })
        }));
        drop(received);

        for session in sessions {
            disconnect(sink.as_ref(), &registry, &session.session_id).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn stop_all_removes_and_terminates_registered_processes() {
        let sink: Arc<dyn AgentSink> = Arc::new(TestSink::default());
        let registry = Arc::new(AgentRegistry::new());
        let request = AgentLaunchRequest {
            definition_id: "custom".to_string(),
            label: "Test cat".to_string(),
            executable: "/bin/cat".to_string(),
            arguments: Vec::new(),
            resume_session_id: None,
            group_id: None,
            seed_input: None,
            restore_existing_session: false,
            profile_config_path: None,
            sandbox: false,
            detached: false,
            working_directory: std::env::current_dir().unwrap().display().to_string(),
            cols: 80,
            rows: 24,
        };
        let session = launch(sink, registry.clone(), request).unwrap();
        let file = tempfile::NamedTempFile::new().unwrap();
        let path = registry
            .stage_clipboard_image(&session.session_id, file)
            .unwrap();
        assert_eq!(registry.list().len(), 1);
        assert!(path.exists());

        registry.stop_all();

        assert!(registry.list().is_empty());
        assert!(!path.exists());
    }
}
