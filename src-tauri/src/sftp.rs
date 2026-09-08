//! SFTP sessions and remote file operations.
//!
//! SFTP reuses the pure-Rust SSH transport and strict host-key trust boundary
//! used by terminal sessions. File contents cross IPC only for an explicit
//! upload or download and each operation is capped to protect WebView memory.

use crate::hostkeys::{HostKeyRecord, TrustVerdict};
use crate::sftp_limits::BoundedSftpStream;
use crate::ssh::{authenticate, AuthAttempt, AuthMethod, SessionSummary, TrustingHandler};
use base64::Engine;
use russh::client;
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::{RawSftpSession, SftpSession};
use russh_sftp::protocol::{File as DirectoryEntry, StatusCode};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use tokio::io::AsyncReadExt;

pub const MAX_TRANSFER_BYTES: usize = 32 * 1024 * 1024;
const MAX_PATH_LENGTH: usize = 4096;
const MAX_DIRECTORY_ENTRIES: usize = 10_000;
const MAX_DIRECTORY_BYTES: usize = 16 * 1024 * 1024;
const DIRECTORY_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpConnectRequest {
    pub profile_id: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    #[serde(default)]
    pub use_saved_password: bool,
    #[serde(default)]
    pub remember_password: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpSessionSummary {
    pub session_id: String,
    pub profile_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub current_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "outcome"
)]
pub enum SftpConnectOutcome {
    Connected {
        session: SftpSessionSummary,
    },
    HostUnknown {
        host: String,
        port: u16,
        algorithm: String,
        fingerprint: String,
    },
    HostChanged {
        host: String,
        port: u16,
        algorithm: String,
        received_fingerprint: String,
        expected: HostKeyRecord,
    },
    AuthFailed,
    Failed {
        stage: &'static str,
        detail: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub kind: &'static str,
    pub size: u64,
    pub modified_at: Option<u64>,
    pub permissions: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpDirectory {
    pub path: String,
    pub entries: Vec<SftpEntry>,
}

struct SftpSessionEntry {
    summary: SftpSessionSummary,
    sftp: Arc<SftpSession>,
    // Holding the transport keeps the SSH session alive with the SFTP channel.
    // An Arc so a browser paired to a terminal can share that session's handle.
    _transport: Arc<client::Handle<TrustingHandler>>,
    listing: Arc<tokio::sync::Mutex<()>>,
}

#[derive(Default)]
pub struct SftpRegistry {
    sessions: Mutex<HashMap<String, SftpSessionEntry>>,
    counter: AtomicU64,
    text_gates: Mutex<HashMap<TextTarget, Weak<tokio::sync::Mutex<()>>>>,
}

type TextTarget = (String, u16, String, String);

impl SftpRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn next_id(&self) -> String {
        let number = self.counter.fetch_add(1, Ordering::Relaxed) + 1;
        format!("sftp-{number}")
    }

    pub fn list(&self) -> Vec<SftpSessionSummary> {
        self.sessions
            .lock()
            .map(|guard| guard.values().map(|entry| entry.summary.clone()).collect())
            .unwrap_or_default()
    }

    pub(crate) fn session(&self, session_id: &str) -> Result<Arc<SftpSession>, String> {
        self.sessions
            .lock()
            .map_err(|error| error.to_string())?
            .get(session_id)
            .map(|entry| Arc::clone(&entry.sftp))
            .ok_or_else(|| format!("no SFTP session called '{session_id}'"))
    }

    /// Editors of the same authenticated account/path share a gate, even when
    /// opened through different tabs. Unrelated paths and sessions remain free.
    pub(crate) fn text_gate(
        &self,
        session_id: &str,
        path: &str,
    ) -> Result<Arc<tokio::sync::Mutex<()>>, String> {
        let key = {
            let sessions = self.sessions.lock().map_err(|error| error.to_string())?;
            let entry = sessions
                .get(session_id)
                .ok_or_else(|| format!("no SFTP session called '{session_id}'"))?;
            (
                entry.summary.host.clone(),
                entry.summary.port,
                entry.summary.username.clone(),
                path.to_owned(),
            )
        };
        let mut gates = self.text_gates.lock().map_err(|error| error.to_string())?;
        gates.retain(|_, gate| gate.strong_count() > 0);
        if let Some(gate) = gates.get(&key).and_then(Weak::upgrade) {
            return Ok(gate);
        }
        let gate = Arc::new(tokio::sync::Mutex::new(()));
        gates.insert(key, Arc::downgrade(&gate));
        Ok(gate)
    }

    pub(crate) async fn mutation_gate(
        &self,
        session_id: &str,
        path: &str,
    ) -> Result<Arc<tokio::sync::Mutex<()>>, String> {
        let (parent, name) = path.rsplit_once('/').unwrap_or((".", path));
        let parent = if parent.is_empty() { "/" } else { parent };
        let canonical = self
            .session(session_id)?
            .canonicalize(parent)
            .await
            .map_err(|error| error.to_string())?;
        self.text_gate(session_id, &join_path(&canonical, name))
    }

    /// A retained registry entry is not proof that its SSH transport is alive.
    /// MCP grants use this snapshot without reconnecting or loading a profile.
    pub(crate) fn connected_session(&self, session_id: &str) -> Option<Arc<SftpSession>> {
        let sessions = self.sessions.lock().ok()?;
        let entry = sessions.get(session_id)?;
        (!entry._transport.is_closed()).then(|| Arc::clone(&entry.sftp))
    }

    fn insert(&self, entry: SftpSessionEntry) -> Result<(), String> {
        self.sessions
            .lock()
            .map_err(|error| error.to_string())?
            .insert(entry.summary.session_id.clone(), entry);
        Ok(())
    }

    fn remove(&self, session_id: &str) -> Result<Option<SftpSessionEntry>, String> {
        Ok(self
            .sessions
            .lock()
            .map_err(|error| error.to_string())?
            .remove(session_id))
    }
}

fn failed(stage: &'static str, detail: impl ToString) -> SftpConnectOutcome {
    SftpConnectOutcome::Failed {
        stage,
        detail: detail.to_string(),
    }
}

fn trust_outcome(verdict: Option<TrustVerdict>, fallback: impl ToString) -> SftpConnectOutcome {
    match verdict {
        Some(TrustVerdict::Unknown {
            host,
            port,
            algorithm,
            fingerprint,
        }) => SftpConnectOutcome::HostUnknown {
            host,
            port,
            algorithm,
            fingerprint,
        },
        Some(TrustVerdict::Changed {
            host,
            port,
            algorithm,
            received_fingerprint,
            expected,
        }) => SftpConnectOutcome::HostChanged {
            host,
            port,
            algorithm,
            received_fingerprint,
            expected,
        },
        _ => failed("connect", fallback),
    }
}

pub async fn connect(
    registry: Arc<SftpRegistry>,
    known: Option<HostKeyRecord>,
    request: SftpConnectRequest,
) -> SftpConnectOutcome {
    let verdict = Arc::new(Mutex::new(None));
    let handler = TrustingHandler {
        host: request.hostname.clone(),
        port: request.port,
        known,
        verdict: Arc::clone(&verdict),
    };
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(3600)),
        ..Default::default()
    });

    let mut transport =
        match client::connect(config, (request.hostname.as_str(), request.port), handler).await {
            Ok(transport) => transport,
            Err(error) => {
                let recorded = verdict.lock().ok().and_then(|slot| slot.clone());
                return trust_outcome(recorded, error);
            }
        };

    match authenticate(&mut transport, &request.username, &request.auth).await {
        AuthAttempt::Accepted => {}
        AuthAttempt::Rejected => return SftpConnectOutcome::AuthFailed,
        AuthAttempt::Credential(detail) => {
            return SftpConnectOutcome::Failed {
                stage: "credential",
                detail,
            }
        }
        AuthAttempt::Transport(detail) => {
            return SftpConnectOutcome::Failed {
                stage: "authenticate",
                detail,
            }
        }
    }

    let channel = match transport.channel_open_session().await {
        Ok(channel) => channel,
        Err(error) => return failed("channel", error),
    };
    if let Err(error) = channel.request_subsystem(true, "sftp").await {
        return failed("subsystem", error);
    }
    let sftp = match SftpSession::new(BoundedSftpStream::new(channel.into_stream())).await {
        Ok(sftp) => Arc::new(sftp),
        Err(error) => return failed("subsystem", error),
    };
    sftp.set_timeout(30);

    let current_path = match sftp.canonicalize(".").await {
        Ok(path) => path,
        Err(error) => return failed("directory", error),
    };
    let summary = SftpSessionSummary {
        session_id: registry.next_id(),
        profile_id: request.profile_id,
        host: request.hostname,
        port: request.port,
        username: request.username,
        current_path,
    };
    if let Err(error) = registry.insert(SftpSessionEntry {
        summary: summary.clone(),
        sftp,
        _transport: Arc::new(transport),
        listing: Arc::default(),
    }) {
        return failed("registry", error);
    }

    SftpConnectOutcome::Connected { session: summary }
}

/// Opens an SFTP browser on an already-connected SSH terminal session.
///
/// This is the MobaXterm-style pairing: rather than dialling a second
/// connection and authenticating again, it opens another channel on the SSH
/// session the terminal is already running, so the file browser appears
/// instantly with the same identity and host-key trust.
pub(crate) async fn attach_to_ssh(
    registry: Arc<SftpRegistry>,
    ssh: SessionSummary,
    transport: Arc<client::Handle<TrustingHandler>>,
) -> SftpConnectOutcome {
    let channel = match transport.channel_open_session().await {
        Ok(channel) => channel,
        Err(error) => return failed("channel", error),
    };
    if let Err(error) = channel.request_subsystem(true, "sftp").await {
        return failed("subsystem", error);
    }
    let sftp = match SftpSession::new(BoundedSftpStream::new(channel.into_stream())).await {
        Ok(sftp) => Arc::new(sftp),
        Err(error) => return failed("subsystem", error),
    };
    sftp.set_timeout(30);

    let current_path = match sftp.canonicalize(".").await {
        Ok(path) => path,
        Err(error) => return failed("directory", error),
    };
    let summary = SftpSessionSummary {
        session_id: registry.next_id(),
        profile_id: ssh.profile_id,
        host: ssh.host,
        port: ssh.port,
        username: ssh.username,
        current_path,
    };
    if let Err(error) = registry.insert(SftpSessionEntry {
        summary: summary.clone(),
        sftp,
        _transport: transport,
        listing: Arc::default(),
    }) {
        return failed("registry", error);
    }

    SftpConnectOutcome::Connected { session: summary }
}

pub(crate) fn validate_path(path: &str) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("The remote path is empty.".to_string());
    }
    if trimmed.len() > MAX_PATH_LENGTH {
        return Err("The remote path is too long.".to_string());
    }
    if trimmed
        .chars()
        .any(|character| matches!(character, '\0' | '\r' | '\n'))
    {
        return Err("The remote path contains unsupported control characters.".to_string());
    }
    Ok(trimmed.to_string())
}

pub(crate) fn validate_name(name: &str) -> Result<String, String> {
    let name = validate_path(name)?;
    if name == "." || name == ".." || name.contains('/') {
        return Err("The name must be one file or folder name.".to_string());
    }
    Ok(name)
}

pub(crate) fn join_path(parent: &str, name: &str) -> String {
    if parent == "/" {
        format!("/{name}")
    } else {
        format!("{}/{}", parent.trim_end_matches('/'), name)
    }
}

pub async fn list_directory(
    registry: &SftpRegistry,
    session_id: &str,
    path: &str,
) -> Result<SftpDirectory, String> {
    let path = validate_path(path)?;
    let (transport, listing) = {
        let sessions = registry
            .sessions
            .lock()
            .map_err(|error| error.to_string())?;
        let entry = sessions
            .get(session_id)
            .ok_or_else(|| format!("no SFTP session called '{session_id}'"))?;
        (Arc::clone(&entry._transport), Arc::clone(&entry.listing))
    };
    let _permit = listing
        .try_lock_owned()
        .map_err(|_| "A directory listing is already running for this session.".to_string())?;
    // A short-lived channel on the already authenticated SSH connection avoids
    // the high-level read_dir API, which buffers every entry before returning.
    tokio::time::timeout(DIRECTORY_TIMEOUT, async {
        let channel = transport
            .channel_open_session()
            .await
            .map_err(|error| error.to_string())?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|error| error.to_string())?;
        let raw = RawSftpSession::new(BoundedSftpStream::new(channel.into_stream()));
        raw.init().await.map_err(|error| error.to_string())?;
        let canonical = raw
            .realpath(path)
            .await
            .map_err(|error| error.to_string())?
            .files
            .into_iter()
            .next()
            .ok_or_else(|| "The server returned no directory path.".to_string())?
            .filename;
        let canonical = validate_path(&canonical)?;
        let handle = raw
            .opendir(canonical.clone())
            .await
            .map_err(|error| error.to_string())?
            .handle;
        let result = collect_directory(&raw, &handle, &canonical).await;
        // Drop also closes the dedicated subsystem on cancellation/deadline.
        let close = raw.close(handle).await.map_err(|error| error.to_string());
        let entries = result?;
        close?;
        Ok(SftpDirectory {
            path: canonical,
            entries,
        })
    })
    .await
    .map_err(|_| "The directory listing exceeded its 30-second deadline.".to_string())?
}

#[derive(Default)]
struct DirectoryBudget {
    entries: usize,
    bytes: usize,
}

impl DirectoryBudget {
    fn accept(&mut self, batch: &[DirectoryEntry]) -> Result<(), String> {
        if batch.is_empty() {
            return Err("The server returned an empty directory batch without EOF.".to_string());
        }
        self.entries = self.entries.saturating_add(batch.len());
        self.bytes = batch.iter().fold(self.bytes, |bytes, entry| {
            bytes
                .saturating_add(entry.filename.len())
                .saturating_add(entry.longname.len())
                .saturating_add(128)
        });
        if self.entries > MAX_DIRECTORY_ENTRIES + 2 || self.bytes > MAX_DIRECTORY_BYTES {
            return Err(
                "This directory exceeds the entry or size limit; narrow the remote path."
                    .to_string(),
            );
        }
        Ok(())
    }
}

async fn collect_directory(
    raw: &RawSftpSession,
    handle: &str,
    canonical: &str,
) -> Result<Vec<SftpEntry>, String> {
    let mut budget = DirectoryBudget::default();
    let mut entries = Vec::new();
    loop {
        let batch = match raw.readdir(handle).await {
            Ok(batch) => batch.files,
            Err(SftpError::Status(status)) if status.status_code == StatusCode::Eof => break,
            Err(error) => return Err(error.to_string()),
        };
        budget.accept(&batch)?;
        for entry in batch {
            if entry.filename == "." || entry.filename == ".." {
                continue;
            }
            let name = validate_name(&entry.filename)?;
            let metadata = entry.attrs;
            let kind = if metadata.file_type().is_dir() {
                "directory"
            } else if metadata.file_type().is_symlink() {
                "symlink"
            } else if metadata.file_type().is_file() {
                "file"
            } else {
                "other"
            };
            entries.push(SftpEntry {
                path: join_path(canonical, &name),
                name,
                kind,
                size: metadata.len(),
                modified_at: metadata.mtime.map(u64::from),
                permissions: metadata.permissions().to_string(),
            });
        }
        if entries.len() > MAX_DIRECTORY_ENTRIES {
            return Err(format!("This directory has more than {MAX_DIRECTORY_ENTRIES} entries; narrow the remote path."));
        }
    }

    entries.sort_by(|left, right| {
        let left_group = if left.kind == "directory" { 0 } else { 1 };
        let right_group = if right.kind == "directory" { 0 } else { 1 };
        left_group
            .cmp(&right_group)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });

    Ok(entries)
}

pub async fn create_directory(
    registry: &SftpRegistry,
    session_id: &str,
    parent: &str,
    name: &str,
) -> Result<(), String> {
    let parent = validate_path(parent)?;
    let name = validate_name(name)?;
    registry
        .session(session_id)?
        .create_dir(join_path(&parent, &name))
        .await
        .map_err(|error| error.to_string())
}

pub async fn rename(
    registry: &SftpRegistry,
    session_id: &str,
    path: &str,
    new_name: &str,
) -> Result<(), String> {
    let path = validate_path(path)?;
    let new_name = validate_name(new_name)?;
    let parent = path
        .rsplit_once('/')
        .map(|(parent, _)| if parent.is_empty() { "/" } else { parent })
        .unwrap_or(".")
        .to_string();
    let target = join_path(&parent, &new_name);
    let source_gate = registry.mutation_gate(session_id, &path).await?;
    let _source = source_gate
        .try_lock()
        .map_err(|_| "Another file operation is already running for this path.".to_owned())?;
    let target_gate = registry.mutation_gate(session_id, &target).await?;
    let _target = if Arc::ptr_eq(&source_gate, &target_gate) {
        None
    } else {
        Some(target_gate.try_lock().map_err(|_| {
            "Another file operation is already running for the destination.".to_owned()
        })?)
    };
    registry
        .session(session_id)?
        .rename(path, target)
        .await
        .map_err(|error| error.to_string())
}

pub async fn remove(
    registry: &SftpRegistry,
    session_id: &str,
    path: &str,
    directory: bool,
) -> Result<(), String> {
    let path = validate_path(path)?;
    let gate = registry.mutation_gate(session_id, &path).await?;
    let _guard = gate
        .try_lock()
        .map_err(|_| "Another file operation is already running for this path.".to_owned())?;
    let session = registry.session(session_id)?;
    if directory {
        session
            .remove_dir(path)
            .await
            .map_err(|error| error.to_string())
    } else {
        session
            .remove_file(path)
            .await
            .map_err(|error| error.to_string())
    }
}

pub async fn read_file(
    registry: &SftpRegistry,
    session_id: &str,
    path: &str,
) -> Result<String, String> {
    let path = validate_path(path)?;
    let session = registry.session(session_id)?;
    let metadata = session
        .metadata(path.clone())
        .await
        .map_err(|error| error.to_string())?;
    if metadata.len() > MAX_TRANSFER_BYTES as u64 {
        return Err(format!(
            "The file is larger than the {} MiB transfer limit.",
            MAX_TRANSFER_BYTES / 1024 / 1024
        ));
    }
    let file = session
        .open(path)
        .await
        .map_err(|error| error.to_string())?;
    let mut limited = file.take(MAX_TRANSFER_BYTES as u64 + 1);
    let mut bytes = Vec::with_capacity(
        usize::try_from(metadata.len())
            .unwrap_or(MAX_TRANSFER_BYTES)
            .min(MAX_TRANSFER_BYTES),
    );
    limited
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| error.to_string())?;
    if bytes.len() > MAX_TRANSFER_BYTES {
        return Err("The remote file exceeded the transfer limit while reading.".to_string());
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

pub async fn write_file(
    registry: &SftpRegistry,
    session_id: &str,
    parent: &str,
    name: &str,
    data_base64: &str,
    overwrite: bool,
) -> Result<(), String> {
    let parent = validate_path(parent)?;
    let name = validate_name(name)?;
    let estimated = data_base64.len().saturating_mul(3) / 4;
    if estimated > MAX_TRANSFER_BYTES {
        return Err(format!(
            "The file is larger than the {} MiB transfer limit.",
            MAX_TRANSFER_BYTES / 1024 / 1024
        ));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|error| format!("The upload was not valid base64: {error}"))?;
    if bytes.len() > MAX_TRANSFER_BYTES {
        return Err(format!(
            "The file is larger than the {} MiB transfer limit.",
            MAX_TRANSFER_BYTES / 1024 / 1024
        ));
    }
    crate::sftp_transfers::write_small_upload(
        registry,
        crate::sftp_transfers::UploadPlan {
            session_id: session_id.to_string(),
            parent,
            name,
            total_bytes: bytes.len() as u64,
            overwrite,
        },
        &bytes,
    )
    .await
}

pub async fn disconnect(registry: &SftpRegistry, session_id: &str) -> Result<(), String> {
    let Some(entry) = registry.remove(session_id)? else {
        return Ok(());
    };
    entry.sftp.close().await.map_err(|error| error.to_string())
}

#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
#[path = "sftp/openssh_tests.rs"]
mod openssh_tests;

#[cfg(test)]
mod tests {
    use super::*;

    struct ListingServer {
        calls: Arc<AtomicU64>,
        endless: bool,
    }

    impl russh_sftp::server::Handler for ListingServer {
        type Error = StatusCode;
        fn unimplemented(&self) -> Self::Error {
            StatusCode::OpUnsupported
        }
        async fn readdir(
            &mut self,
            id: u32,
            _handle: String,
        ) -> Result<russh_sftp::protocol::Name, Self::Error> {
            let call = self.calls.fetch_add(1, Ordering::Relaxed);
            if !self.endless && call > 0 {
                return Err(StatusCode::Eof);
            }
            let files = if self.endless {
                (0..500)
                    .map(|index| DirectoryEntry::dummy(format!("file-{call}-{index}")))
                    .collect()
            } else {
                vec![
                    DirectoryEntry::dummy("."),
                    DirectoryEntry::dummy(".."),
                    DirectoryEntry::dummy("report.txt"),
                ]
            };
            Ok(russh_sftp::protocol::Name { id, files })
        }
    }

    #[tokio::test]
    async fn directory_collection_stops_an_endless_peer_before_more_requests() {
        for endless in [false, true] {
            let (client, server) = tokio::io::duplex(64 * 1024);
            let calls = Arc::new(AtomicU64::new(0));
            let peer = tokio::spawn(russh_sftp::server::run(
                server,
                ListingServer {
                    calls: Arc::clone(&calls),
                    endless,
                },
            ));
            let raw = RawSftpSession::new(BoundedSftpStream::new(client));
            raw.init().await.unwrap();
            let result = tokio::time::timeout(
                Duration::from_secs(5),
                collect_directory(&raw, "directory", "/srv"),
            )
            .await
            .unwrap();
            if endless {
                assert!(result.unwrap_err().contains("limit"));
                assert_eq!(calls.load(Ordering::Relaxed), 21);
            } else {
                let entries = result.unwrap();
                assert_eq!(entries.len(), 1);
                assert_eq!(entries[0].path, "/srv/report.txt");
                assert_eq!(calls.load(Ordering::Relaxed), 2);
            }
            drop(raw);
            tokio::time::timeout(Duration::from_secs(1), peer)
                .await
                .unwrap()
                .unwrap();
        }
    }

    #[test]
    fn directory_budgets_include_longnames_and_reject_empty_batches() {
        let mut budget = DirectoryBudget::default();
        assert!(budget.accept(&[]).is_err());
        budget.bytes = MAX_DIRECTORY_BYTES - 100;
        assert!(budget.accept(&[DirectoryEntry::dummy("a")]).is_err());
        let mut budget = DirectoryBudget::default();
        let mut entry = DirectoryEntry::dummy("a");
        entry.longname = "x".repeat(256);
        budget.accept(&[entry]).unwrap();
        assert_eq!(budget.bytes, 1 + 256 + 128);
    }

    #[test]
    fn paths_reject_control_characters_and_invalid_names() {
        assert!(validate_path("/srv/files").is_ok());
        assert!(validate_path("/srv/\nfiles").is_err());
        assert!(validate_name("report.csv").is_ok());
        assert!(validate_name("../report.csv").is_err());
        assert!(validate_name("folder/report.csv").is_err());
    }

    #[test]
    fn path_joining_keeps_the_remote_root_valid() {
        assert_eq!(join_path("/", "home"), "/home");
        assert_eq!(
            join_path("/srv/files/", "report.csv"),
            "/srv/files/report.csv"
        );
    }

    #[test]
    fn connected_outcome_uses_frontend_field_names() {
        let outcome = serde_json::to_value(SftpConnectOutcome::Connected {
            session: SftpSessionSummary {
                session_id: "sftp-1".into(),
                profile_id: "profile-1".into(),
                host: "example.test".into(),
                port: 22,
                username: "operator".into(),
                current_path: "/home/operator".into(),
            },
        })
        .unwrap();

        assert_eq!(outcome["outcome"], "connected");
        assert_eq!(outcome["session"]["sessionId"], "sftp-1");
        assert_eq!(outcome["session"]["currentPath"], "/home/operator");
    }
}
