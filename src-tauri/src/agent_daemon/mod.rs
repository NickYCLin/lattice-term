//! Lattice Agent daemon: Agent Fleet sessions that outlive the desktop window.
//!
//! A session launched with "keep in the background" is owned by a separate
//! `lattice-term agent-daemon` process instead of the desktop. The daemon runs
//! the very same [`crate::agent::AgentRegistry`] — PTYs, lifecycle
//! heuristics, the prompt queue, the reporter listener and the integration
//! files all live there unchanged — and the desktop attaches over a
//! user-private local socket as a thin proxy. Closing the window drops the
//! connection; the CLIs keep running; the next window re-attaches and
//! replays the daemon's bounded output tail.
//!
//! Only a session the user explicitly detached goes through here. Every
//! other session stays in the desktop process exactly as before.
//!
//! Wire format: newline-delimited JSON frames, see [`Frame`]. Bytes ride as
//! base64 inside JSON like the desktop events already do. The first frame a
//! client sends must be a [`Request::Hello`] carrying the token from
//! `agent-daemon.token` (owner-only file in the application data directory);
//! anything else closes the connection.

pub mod automations;
pub mod client;
pub mod mcp;
pub mod server;
#[cfg(test)]
mod tests;
mod transport;

use crate::agent::AgentLaunchRequest;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Bumped when a frame changes shape; both sides refuse a mismatch.
pub const PROTOCOL_VERSION: u32 = 1;
/// Session ids minted by the daemon's registry. The desktop routes every
/// command by this prefix, so the two registries can never collide.
pub const SESSION_ID_PREFIX: &str = "agent-bg-session-";
/// The daemon exits once it has had no sessions and no clients this long.
pub const IDLE_EXIT: std::time::Duration = std::time::Duration::from_secs(60);
const TOKEN_FILE: &str = "agent-daemon.token";
/// Where the daemon notes the socket path it actually bound, for clients
/// spawned with a different environment (an MCP client that strips
/// `XDG_RUNTIME_DIR`, say) to find it.
const SOCKET_HINT_FILE: &str = "agent-daemon.socket";
pub const LOG_FILE: &str = "agent-daemon.log";
/// One frame at most: a launch carrying a 256 KiB restored tail as base64 is
/// the largest legitimate message; a staged clipboard image the largest
/// possible one.
pub const MAX_FRAME_BYTES: usize = 24 * 1024 * 1024;
/// The most output one `observe` request returns, after the caller's own cap.
pub const MAX_OBSERVE_BYTES: usize = 64 * 1024;

/// Whether a session id belongs to the daemon rather than the desktop.
pub fn owns(session_id: &str) -> bool {
    session_id.starts_with(SESSION_ID_PREFIX)
}

/// Who is on the other end of a connection. The desktop owns everything;
/// an observer (the MCP adapter) only ever sees the sessions the user chose
/// to share, never receives terminal bytes as events, and cannot launch,
/// send, or stop anything. The daemon enforces this per request; the role
/// is a claim the client makes, but a wrong claim only ever narrows access.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ClientRole {
    #[default]
    Desktop,
    Observer,
}

/// Where this installation keeps its data when nobody passes `--data-dir`:
/// the same directory Tauri resolves for the application identifier, so the
/// MCP adapter finds the daemon the desktop started.
pub fn default_data_dir() -> Option<PathBuf> {
    const IDENTIFIER: &str = "io.github.nickyclin.latticeterm";
    dirs::data_dir().map(|base| base.join(IDENTIFIER))
}

/// Where one installation's daemon listens and keeps its token.
///
/// The token lives in the application data directory. The socket does not:
/// Unix socket paths are capped at about 100 bytes (`SUN_LEN`), which a
/// data directory under a long home path exceeds, so it goes into a short,
/// user-private directory under `$XDG_RUNTIME_DIR` (or the temp directory)
/// named by the user id, with the installation told apart by a hash of its
/// data directory.
#[derive(Clone, Debug)]
pub struct DaemonPaths {
    pub data_dir: PathBuf,
    pub socket: PathBuf,
    pub token: PathBuf,
}

/// FNV-1a of the data directory: stable, short, one per installation.
fn installation_hash(data_dir: &Path) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in data_dir.to_string_lossy().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

#[cfg(unix)]
fn socket_path(data_dir: &Path) -> PathBuf {
    // SAFETY: geteuid has no preconditions and cannot fail.
    let uid = unsafe { libc::geteuid() };
    // The runtime directory by its variable, else by its conventional
    // location, so a client started without the variable (MCP hosts often
    // pass a minimal environment) still resolves the same place.
    let base = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .or_else(|| {
            let conventional = PathBuf::from(format!("/run/user/{uid}"));
            conventional.is_dir().then_some(conventional)
        })
        .unwrap_or_else(std::env::temp_dir);
    base.join(format!("latticeterm-agent-{uid}"))
        .join(format!("{:016x}.sock", installation_hash(data_dir)))
}

#[cfg(not(unix))]
fn socket_path(data_dir: &Path) -> PathBuf {
    data_dir.join("agent-daemon.sock")
}

impl DaemonPaths {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            data_dir: data_dir.to_path_buf(),
            socket: socket_path(data_dir),
            token: data_dir.join(TOKEN_FILE),
        }
    }

    /// For a client: the socket the running daemon says it bound, when it
    /// left a note, else the path this environment resolves to. The note
    /// is only a pointer; the transport still checks that whatever it
    /// points at is this user's private socket before connecting.
    pub fn for_client(data_dir: &Path) -> Self {
        let mut paths = Self::new(data_dir);
        if let Some(noted) = read_socket_hint(data_dir) {
            paths.socket = noted;
        }
        paths
    }

    fn socket_hint(&self) -> PathBuf {
        self.data_dir.join(SOCKET_HINT_FILE)
    }

    /// Called by the daemon once it listens.
    pub(crate) fn write_socket_hint(&self) {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        if let Ok(mut file) = options.open(self.socket_hint()) {
            use std::io::Write;
            let _ = file.write_all(self.socket.to_string_lossy().as_bytes());
        }
    }

    pub(crate) fn remove_socket_hint(&self) {
        let _ = std::fs::remove_file(self.socket_hint());
    }

    /// Windows has no socket files; the pipe name is derived from the data
    /// directory so two installations (or two users) never share one.
    #[cfg(windows)]
    pub fn pipe_name(&self) -> String {
        format!(
            r"\\.\pipe\latticeterm-agent-{:016x}",
            installation_hash(&self.data_dir)
        )
    }
}

fn read_socket_hint(data_dir: &Path) -> Option<PathBuf> {
    let noted = std::fs::read_to_string(data_dir.join(SOCKET_HINT_FILE)).ok()?;
    let noted = PathBuf::from(noted.trim());
    (noted.is_absolute() && noted.exists()).then_some(noted)
}

/// Reads the shared token, creating it owner-only on first use. The token is
/// what makes the socket private on platforms whose socket ACLs are loose.
pub fn read_or_create_token(paths: &DaemonPaths) -> Result<String, String> {
    if let Ok(existing) = std::fs::read_to_string(&paths.token) {
        let token = existing.trim();
        if token.len() >= 32
            && token
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Ok(token.to_string());
        }
    }
    std::fs::create_dir_all(&paths.data_dir)
        .map_err(|error| format!("Cannot create the application data directory: {error}"))?;
    let token = crate::agent::random_report_token()?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&paths.token)
        .map_err(|error| format!("Cannot write the daemon token: {error}"))?;
    use std::io::Write;
    file.write_all(token.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|error| format!("Cannot write the daemon token: {error}"))?;
    Ok(token)
}

/// One line on the wire.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Frame {
    Request {
        id: u64,
        body: Request,
    },
    Response {
        id: u64,
        ok: bool,
        #[serde(default)]
        result: Value,
        #[serde(default)]
        error: Option<String>,
    },
    /// The daemon's registry sink, forwarded: `name` is the short event name
    /// (`data`, `state`, ...) and `payload` the exact desktop event payload.
    Event {
        name: String,
        payload: Value,
    },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Request {
    Hello {
        token: String,
        protocol: u32,
        #[serde(default)]
        role: ClientRole,
    },
    Launch {
        request: Box<AgentLaunchRequest>,
        /// Base64 of an earlier terminal tail to replay first, like the
        /// desktop's encrypted history does for a restored tab.
        #[serde(default)]
        restored_output: Option<String>,
    },
    Send {
        session_id: String,
        data: String,
    },
    Enqueue {
        session_id: String,
        data: String,
    },
    ClearQueue {
        session_id: String,
    },
    Broadcast {
        session_ids: Vec<String>,
        data: String,
    },
    Resize {
        session_id: String,
        cols: u32,
        rows: u32,
    },
    Disconnect {
        session_id: String,
    },
    Rename {
        session_id: String,
        label: String,
    },
    Sessions,
    Snapshots,
    /// A pasted image, already encoded as PNG; the daemon owns the temp file
    /// so it lives and dies with the PTY like a desktop-staged one.
    StageImage {
        session_id: String,
        png: String,
    },
    /// Ends every background session and the daemon itself.
    Shutdown,
    /// The window's whole automation list, runtime marks included.
    AutomationsReplace {
        automations: Vec<Value>,
    },
    AutomationsState,
    /// Finished background runs, handed over once.
    AutomationsTakeRuns,
    /// The user shares (or stops sharing) one session with observers.
    ShareSet {
        session_id: String,
        shared: bool,
    },
    /// Session ids currently shared with observers.
    Shared,
    /// A bounded slice of one shared session's output from `cursor` on.
    Observe {
        session_id: String,
        #[serde(default)]
        cursor: u64,
        #[serde(default)]
        max_bytes: usize,
    },
}

/// What `Hello` answers with: everything a fresh window needs to attach.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloReply {
    pub protocol: u32,
    pub sessions: Vec<crate::agent::AgentSessionSummary>,
    pub snapshots: Vec<crate::agent::AgentOutputSnapshot>,
    /// Sessions the user shared with observers; empty for observers who
    /// see only those anyway.
    #[serde(default)]
    pub shared: Vec<String>,
}

/// Desktop event name for a forwarded sink event.
pub(crate) fn event_channel(name: &str) -> Option<&'static str> {
    use crate::agent::{
        EVENT_CAPTURE, EVENT_CLOSED, EVENT_DATA, EVENT_MODEL, EVENT_QUEUE, EVENT_STATE, EVENT_USAGE,
    };
    Some(match name {
        "data" => EVENT_DATA,
        "state" => EVENT_STATE,
        "closed" => EVENT_CLOSED,
        "captured" => EVENT_CAPTURE,
        "model" => EVENT_MODEL,
        "usage" => EVENT_USAGE,
        "queue" => EVENT_QUEUE,
        _ => return None,
    })
}

#[cfg(test)]
mod wire_tests {
    use super::*;

    #[test]
    fn frames_round_trip_with_camel_case_tags() {
        let frame = Frame::Request {
            id: 7,
            body: Request::ClearQueue {
                session_id: "agent-bg-session-1".into(),
            },
        };
        let line = serde_json::to_string(&frame).unwrap();
        assert!(line.contains(r#""kind":"request""#));
        assert!(line.contains(r#""type":"clearQueue""#));
        assert!(line.contains(r#""sessionId":"agent-bg-session-1""#));
        match serde_json::from_str::<Frame>(&line).unwrap() {
            Frame::Request {
                id: 7,
                body: Request::ClearQueue { session_id },
            } => assert_eq!(session_id, "agent-bg-session-1"),
            other => panic!("unexpected frame {other:?}"),
        }
        assert!(owns("agent-bg-session-3"));
        assert!(!owns("agent-session-3"));

        // A greeting from before roles existed is a desktop greeting.
        let old = r#"{"kind":"request","id":1,"body":{"type":"hello","token":"t","protocol":1}}"#;
        match serde_json::from_str::<Frame>(old).unwrap() {
            Frame::Request {
                body: Request::Hello { role, .. },
                ..
            } => assert_eq!(role, ClientRole::Desktop),
            other => panic!("unexpected frame {other:?}"),
        }
    }

    #[test]
    fn a_client_follows_the_daemon_s_socket_note_when_it_exists() {
        let dir = tempfile::tempdir().unwrap();
        let mut paths = DaemonPaths::new(dir.path());
        // Nothing noted: the environment's own resolution.
        assert_eq!(DaemonPaths::for_client(dir.path()).socket, paths.socket);
        // A note pointing at something that exists wins; a stale one is ignored.
        let elsewhere = dir.path().join("elsewhere.sock");
        std::fs::write(&elsewhere, b"").unwrap();
        paths.socket = elsewhere.clone();
        paths.write_socket_hint();
        assert_eq!(DaemonPaths::for_client(dir.path()).socket, elsewhere);
        std::fs::remove_file(&elsewhere).unwrap();
        assert_ne!(DaemonPaths::for_client(dir.path()).socket, elsewhere);
        paths.remove_socket_hint();
        assert!(!dir.path().join(SOCKET_HINT_FILE).exists());
    }

    #[cfg(unix)]
    #[test]
    fn the_socket_path_stays_short_and_per_installation() {
        let long = Path::new("/home/someone/with/a/really/long/home/directory/.local/share/io.github.nickyclin.latticeterm");
        let paths = DaemonPaths::new(long);
        assert!(paths.socket.as_os_str().len() < 100, "{:?}", paths.socket);
        assert_ne!(
            paths.socket,
            DaemonPaths::new(Path::new("/elsewhere")).socket
        );
        assert_eq!(paths.token, long.join("agent-daemon.token"));
    }

    #[test]
    fn the_token_is_created_once_and_reused() {
        let dir = tempfile::tempdir().unwrap();
        let paths = DaemonPaths::new(dir.path());
        let first = read_or_create_token(&paths).unwrap();
        let second = read_or_create_token(&paths).unwrap();
        assert_eq!(first, second);
        assert!(first.len() >= 32);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&paths.token)
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
        std::fs::write(&paths.token, "not a token\n").unwrap();
        let third = read_or_create_token(&paths).unwrap();
        assert_ne!(third, "not a token");
    }
}
