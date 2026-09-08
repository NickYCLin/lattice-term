//! SSH sessions.
//!
//! Built on russh — a pure Rust implementation — rather than on the system
//! `ssh` binary. iOS forbids launching external executables and Android ships
//! no `ssh`, so shelling out would have made a mobile build impossible; this
//! way the same connection core runs on every target.
//!
//! Trust is resolved before a session can exist. When a host key is unknown or
//! has changed, the connection is refused and the verdict is handed back to the
//! interface to put in front of the user. Nothing is trusted on sight, and no
//! session is ever held open in an undecided state.

use crate::hostkeys::{HostKeyRecord, HostTrustStore, TrustVerdict};
use base64::Engine;
use russh::client;
use russh::keys::ssh_key;
use russh::ChannelMsg;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

/// Where a session's output goes.
///
/// The running app emits Tauri events; a test collects into a buffer. Keeping
/// this behind a trait is what lets the connect-authenticate-shell path be
/// tested against a real server without a window to emit into.
pub trait SessionSink: Send + Sync + 'static {
    fn data(&self, session_id: &str, bytes: &[u8]);
    fn closed(&self, session_id: &str, reason: &str);
}

/// A dedicated exec channel must close even when its caller drops a future.
/// russh's channel halves do not close the peer channel on Drop themselves.
/// This guard never closes the underlying shared SSH connection or its PTY.
pub(crate) struct ChannelCloseGuard(Arc<russh::ChannelWriteHalf<client::Msg>>);

impl ChannelCloseGuard {
    pub(crate) fn new(writer: russh::ChannelWriteHalf<client::Msg>) -> Self {
        Self(Arc::new(writer))
    }

    pub(crate) fn writer(&self) -> &russh::ChannelWriteHalf<client::Msg> {
        &self.0
    }
}

impl Drop for ChannelCloseGuard {
    fn drop(&mut self) {
        let writer = Arc::clone(&self.0);
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = tokio::time::timeout(Duration::from_secs(1), writer.close()).await;
            });
        }
    }
}

/// The sink used by the application: one Tauri event per chunk.
pub struct EventSink(pub AppHandle);

impl SessionSink for EventSink {
    fn data(&self, session_id: &str, bytes: &[u8]) {
        let result = self.0.emit(
            EVENT_DATA,
            SessionData {
                session_id: session_id.to_string(),
                base64: encode(bytes),
            },
        );
        if let Err(error) = result {
            // Losing a chunk of output silently would look like a hung shell.
            eprintln!("failed to deliver session output: {error}");
        }
    }

    fn closed(&self, session_id: &str, reason: &str) {
        let _ = self.0.emit(
            EVENT_CLOSED,
            SessionClosed {
                session_id: session_id.to_string(),
                reason: reason.to_string(),
            },
        );
    }
}

/// Emitted for every chunk the remote host writes.
pub const EVENT_DATA: &str = "ssh://data";
/// Emitted once, when a session ends for any reason.
pub const EVENT_CLOSED: &str = "ssh://closed";

fn encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn decode(text: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(text)
        .map_err(|error| format!("input was not valid base64: {error}"))
}

/// How to prove who we are.
///
/// A password or passphrase is used for the single connection attempt it
/// arrives with and is dropped as soon as authentication finishes. It is never
/// written to the connection store, the trust store, or any log line. A key is
/// read from disk at connect time and never leaves this process.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum AuthMethod {
    Password {
        password: String,
    },
    PrivateKey {
        /// Path to an OpenSSH-format private key on this machine.
        path: String,
        #[serde(default)]
        passphrase: Option<String>,
    },
}

/// Where one authentication attempt ended, before the caller maps it into its
/// own outcome type. Shared by the terminal and SFTP connect paths so the two
/// never drift on what a key failure means.
pub(crate) enum AuthAttempt {
    Accepted,
    /// The host understood the credentials and said no.
    Rejected,
    /// The credentials could not even be assembled — unreadable key file,
    /// wrong passphrase. The host was never asked.
    Credential(String),
    /// The connection failed mid-authentication.
    Transport(String),
}

pub(crate) async fn authenticate<H: client::Handler>(
    session: &mut client::Handle<H>,
    username: &str,
    auth: &AuthMethod,
) -> AuthAttempt {
    match auth {
        AuthMethod::Password { password } => {
            match session.authenticate_password(username, password).await {
                Ok(result) if result.success() => AuthAttempt::Accepted,
                Ok(_) => AuthAttempt::Rejected,
                Err(error) => AuthAttempt::Transport(error.to_string()),
            }
        }
        AuthMethod::PrivateKey { path, passphrase } => {
            let key = match russh::keys::load_secret_key(path, passphrase.as_deref()) {
                Ok(key) => key,
                Err(error) => {
                    return AuthAttempt::Credential(format!(
                        "could not use the private key at {path}: {error}"
                    ))
                }
            };
            // RSA keys sign with the strongest hash the server accepts;
            // other algorithms carry their hash in the key type itself.
            let hash_alg = match session.best_supported_rsa_hash().await {
                Ok(hash) => hash.flatten(),
                Err(error) => return AuthAttempt::Transport(error.to_string()),
            };
            let prepared = russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg);
            match session.authenticate_publickey(username, prepared).await {
                Ok(result) if result.success() => AuthAttempt::Accepted,
                Ok(_) => AuthAttempt::Rejected,
                Err(error) => AuthAttempt::Transport(error.to_string()),
            }
        }
    }
}

/// The default OpenSSH key files that exist on this machine, most modern
/// algorithm first — used to prefill the connect dialog, never read silently.
pub fn default_key_paths() -> Vec<String> {
    let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) else {
        return Vec::new();
    };
    ["id_ed25519", "id_ecdsa", "id_rsa"]
        .iter()
        .filter_map(|name| {
            let path = std::path::Path::new(&home).join(".ssh").join(name);
            path.is_file().then(|| path.display().to_string())
        })
        .collect()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    pub profile_id: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    #[serde(default)]
    pub use_saved_password: bool,
    #[serde(default)]
    pub remember_password: bool,
    /// Terminal size at the moment of connecting.
    pub cols: u32,
    pub rows: u32,
}

/// What happened, in terms the interface can act on. Failure to connect is a
/// normal outcome here rather than an error string, because each case needs a
/// different response from the user.
#[derive(Debug, Clone, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "outcome"
)]
pub enum ConnectOutcome {
    Connected {
        session_id: String,
    },
    /// First contact with this host. The user must compare the fingerprint.
    HostUnknown {
        host: String,
        port: u16,
        algorithm: String,
        fingerprint: String,
    },
    /// The key is not the one trusted before. Blocking, and never auto-resolved.
    HostChanged {
        host: String,
        port: u16,
        algorithm: String,
        received_fingerprint: String,
        expected: HostKeyRecord,
    },
    /// The host answered, but rejected the credentials.
    AuthFailed,
    /// Anything else: name resolution, refused connection, timeout.
    Failed {
        stage: &'static str,
        detail: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub session_id: String,
    pub profile_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
}

/// Messages the command handlers send into a running session's pump task.
enum ClientInput {
    Data(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

struct SessionEntry {
    summary: SessionSummary,
    input: mpsc::Sender<ClientInput>,
    /// The connection itself, kept so other features — metrics probes, future
    /// file transfers — can open their own channels on this session.
    handle: Arc<client::Handle<TrustingHandler>>,
}

#[derive(Default)]
pub struct SshRegistry {
    sessions: Mutex<HashMap<String, SessionEntry>>,
    counter: AtomicU64,
}

impl SshRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn next_id(&self) -> String {
        let n = self.counter.fetch_add(1, Ordering::Relaxed) + 1;
        format!("session-{n}")
    }

    pub fn list(&self) -> Vec<SessionSummary> {
        self.sessions
            .lock()
            .map(|guard| guard.values().map(|entry| entry.summary.clone()).collect())
            .unwrap_or_default()
    }

    fn sender(&self, session_id: &str) -> Option<mpsc::Sender<ClientInput>> {
        self.sessions
            .lock()
            .ok()?
            .get(session_id)
            .map(|entry| entry.input.clone())
    }

    fn remove(&self, session_id: &str) {
        if let Ok(mut guard) = self.sessions.lock() {
            guard.remove(session_id);
        }
    }

    /// The live connection behind a session, for opening additional channels.
    pub(crate) fn session_handle(
        &self,
        session_id: &str,
    ) -> Option<Arc<client::Handle<TrustingHandler>>> {
        self.sessions
            .lock()
            .ok()?
            .get(session_id)
            .map(|entry| Arc::clone(&entry.handle))
    }

    /// The connection details plus its live handle, so a paired SFTP browser can
    /// open its own channel on the very session the terminal is already using —
    /// no second connection, no second authentication.
    pub(crate) fn session_transport(
        &self,
        session_id: &str,
    ) -> Option<(SessionSummary, Arc<client::Handle<TrustingHandler>>)> {
        self.sessions
            .lock()
            .ok()?
            .get(session_id)
            .map(|entry| (entry.summary.clone(), Arc::clone(&entry.handle)))
    }
}

/// Answers russh's "do you accept this host key?" question from the trust
/// store, and remembers the verdict so the caller can explain a refusal.
pub(crate) struct TrustingHandler {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) known: Option<HostKeyRecord>,
    pub(crate) verdict: Arc<Mutex<Option<TrustVerdict>>>,
}

impl client::Handler for TrustingHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // `ssh-key` already formats fingerprints the way OpenSSH prints them,
        // so what the user compares here matches `ssh-keygen -lf` byte for byte.
        // A host certificate is pinned by its embedded key, keeping the
        // trust-on-first-use record independent of certificate renewals.
        let (fingerprint, algorithm) = match server_public_key {
            russh::keys::PublicKeyOrCertificate::PublicKey { key, .. } => (
                key.fingerprint(ssh_key::HashAlg::Sha256).to_string(),
                key.algorithm().to_string(),
            ),
            russh::keys::PublicKeyOrCertificate::Certificate(certificate) => (
                certificate
                    .public_key()
                    .fingerprint(ssh_key::HashAlg::Sha256)
                    .to_string(),
                certificate.algorithm().to_string(),
            ),
        };

        let verdict = match &self.known {
            Some(record) if record.fingerprint == fingerprint => TrustVerdict::Trusted {
                record: record.clone(),
            },
            Some(record) => TrustVerdict::Changed {
                host: self.host.clone(),
                port: self.port,
                algorithm,
                received_fingerprint: fingerprint,
                expected: record.clone(),
            },
            None => TrustVerdict::Unknown {
                host: self.host.clone(),
                port: self.port,
                algorithm,
                fingerprint,
            },
        };

        let accepted = verdict.may_proceed();
        if let Ok(mut slot) = self.verdict.lock() {
            *slot = Some(verdict);
        }

        Ok(accepted)
    }
}

/// Turns a recorded verdict into the outcome the interface receives.
fn outcome_for(verdict: Option<TrustVerdict>, fallback: String) -> ConnectOutcome {
    match verdict {
        Some(TrustVerdict::Unknown {
            host,
            port,
            algorithm,
            fingerprint,
        }) => ConnectOutcome::HostUnknown {
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
        }) => ConnectOutcome::HostChanged {
            host,
            port,
            algorithm,
            received_fingerprint,
            expected,
        },
        // No verdict means the failure happened before the key exchange.
        _ => ConnectOutcome::Failed {
            stage: "connect",
            detail: fallback,
        },
    }
}

pub async fn connect(
    sink: Arc<dyn SessionSink>,
    registry: Arc<SshRegistry>,
    known: Option<HostKeyRecord>,
    request: ConnectRequest,
) -> ConnectOutcome {
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

    let mut session =
        match client::connect(config, (request.hostname.as_str(), request.port), handler).await {
            Ok(session) => session,
            Err(error) => {
                // A rejected host key surfaces here as a generic failure, so the
                // recorded verdict is what distinguishes "unreachable" from
                // "reachable but not trusted".
                let recorded = verdict.lock().ok().and_then(|slot| slot.clone());
                return outcome_for(recorded, error.to_string());
            }
        };

    match authenticate(&mut session, &request.username, &request.auth).await {
        AuthAttempt::Accepted => {}
        AuthAttempt::Rejected => return ConnectOutcome::AuthFailed,
        AuthAttempt::Credential(detail) => {
            return ConnectOutcome::Failed {
                stage: "credential",
                detail,
            }
        }
        AuthAttempt::Transport(detail) => {
            return ConnectOutcome::Failed {
                stage: "authenticate",
                detail,
            }
        }
    }

    // Everything after authentication takes `&self`, so the handle can be
    // shared: the registry keeps a clone for later channels on this session.
    let session = Arc::new(session);

    let mut channel = match session.channel_open_session().await {
        Ok(channel) => channel,
        Err(error) => {
            return ConnectOutcome::Failed {
                stage: "channel",
                detail: error.to_string(),
            }
        }
    };

    if let Err(error) = channel
        .request_pty(
            false,
            "xterm-256color",
            request.cols,
            request.rows,
            0,
            0,
            &[],
        )
        .await
    {
        return ConnectOutcome::Failed {
            stage: "pty",
            detail: error.to_string(),
        };
    }

    if let Err(error) = channel.request_shell(true).await {
        return ConnectOutcome::Failed {
            stage: "shell",
            detail: error.to_string(),
        };
    }

    let session_id = registry.next_id();
    let summary = SessionSummary {
        session_id: session_id.clone(),
        profile_id: request.profile_id.clone(),
        host: request.hostname.clone(),
        port: request.port,
        username: request.username.clone(),
    };

    let (input_tx, mut input_rx) = mpsc::channel::<ClientInput>(64);

    if let Ok(mut guard) = registry.sessions.lock() {
        guard.insert(
            session_id.clone(),
            SessionEntry {
                summary: summary.clone(),
                input: input_tx,
                handle: Arc::clone(&session),
            },
        );
    }

    let pump_registry = Arc::clone(&registry);
    let pump_id = session_id.clone();

    // One task owns the channel for the life of the session: everything else
    // talks to it through the input queue, so there is no lock to hold across
    // an await and no way for two writers to interleave mid-message.
    tauri::async_runtime::spawn(async move {
        let mut reason = "closed".to_string();

        loop {
            tokio::select! {
                incoming = input_rx.recv() => match incoming {
                    Some(ClientInput::Data(bytes)) => {
                        if let Err(error) = channel.data(&bytes[..]).await {
                            reason = error.to_string();
                            break;
                        }
                    }
                    Some(ClientInput::Resize { cols, rows }) => {
                        if let Err(error) = channel.window_change(cols, rows, 0, 0).await {
                            reason = error.to_string();
                            break;
                        }
                    }
                    Some(ClientInput::Close) | None => {
                        let _ = channel.eof().await;
                        reason = "disconnected".to_string();
                        break;
                    }
                },
                message = channel.wait() => match message {
                    Some(ChannelMsg::Data { ref data }) => {
                        sink.data(&pump_id, data);
                    }
                    Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                        // Standard error shares the terminal, exactly as it
                        // would in a local shell.
                        sink.data(&pump_id, data);
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        reason = format!("exit status {exit_status}");
                    }
                    Some(ChannelMsg::Eof) | None => break,
                    Some(_) => {}
                }
            }
        }

        pump_registry.remove(&pump_id);
        sink.closed(&pump_id, &reason);
    });

    ConnectOutcome::Connected { session_id }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionData {
    session_id: String,
    /// Base64 so arbitrary bytes survive the trip through JSON intact.
    base64: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionClosed {
    session_id: String,
    reason: String,
}

pub async fn send(
    registry: &SshRegistry,
    session_id: &str,
    data_base64: &str,
) -> Result<(), String> {
    let sender = registry
        .sender(session_id)
        .ok_or_else(|| format!("no session called '{session_id}'"))?;

    sender
        .send(ClientInput::Data(decode(data_base64)?))
        .await
        .map_err(|_| "the session has already ended".to_string())
}

pub async fn resize(
    registry: &SshRegistry,
    session_id: &str,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let sender = registry
        .sender(session_id)
        .ok_or_else(|| format!("no session called '{session_id}'"))?;

    sender
        .send(ClientInput::Resize { cols, rows })
        .await
        .map_err(|_| "the session has already ended".to_string())
}

pub async fn disconnect(registry: &SshRegistry, session_id: &str) -> Result<(), String> {
    let Some(sender) = registry.sender(session_id) else {
        // Already gone is the state the caller wanted.
        return Ok(());
    };

    let _ = sender.send(ClientInput::Close).await;
    Ok(())
}

/// Reads the record for one host so the connection attempt can decide trust
/// without holding the store's lock across an await.
pub fn known_record(store: &HostTrustStore, host: &str, port: u16) -> Option<HostKeyRecord> {
    store
        .records()
        .into_iter()
        .find(|record| record.port == port && record.host.eq_ignore_ascii_case(host.trim()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The interface reads these payloads by field name, and a mismatch fails
    /// silently: a session whose id arrives as `session_id` is simply never
    /// found, so output goes nowhere and input is dropped. Pin the wire shape.
    #[test]
    fn connect_outcomes_use_the_field_names_the_interface_reads() {
        let connected = serde_json::to_value(ConnectOutcome::Connected {
            session_id: "session-1".into(),
        })
        .unwrap();

        assert_eq!(connected["outcome"], "connected");
        assert_eq!(connected["sessionId"], "session-1");
        assert!(connected.get("session_id").is_none());

        let changed = serde_json::to_value(ConnectOutcome::HostChanged {
            host: "gateway.example.com".into(),
            port: 22,
            algorithm: "ssh-ed25519".into(),
            received_fingerprint: "SHA256:new".into(),
            expected: HostKeyRecord {
                host: "gateway.example.com".into(),
                port: 22,
                algorithm: "ssh-ed25519".into(),
                fingerprint: "SHA256:old".into(),
                first_trusted_at: 1,
                last_seen_at: 2,
            },
        })
        .unwrap();

        assert_eq!(changed["outcome"], "hostChanged");
        assert_eq!(changed["receivedFingerprint"], "SHA256:new");
        assert_eq!(changed["expected"]["firstTrustedAt"], 1);
        assert!(changed.get("received_fingerprint").is_none());

        let unknown = serde_json::to_value(ConnectOutcome::HostUnknown {
            host: "gateway.example.com".into(),
            port: 22,
            algorithm: "ssh-ed25519".into(),
            fingerprint: "SHA256:abc".into(),
        })
        .unwrap();
        assert_eq!(unknown["outcome"], "hostUnknown");

        let failed = serde_json::to_value(ConnectOutcome::Failed {
            stage: "connect",
            detail: "refused".into(),
        })
        .unwrap();
        assert_eq!(failed["outcome"], "failed");
        assert_eq!(failed["stage"], "connect");

        assert_eq!(
            serde_json::to_value(ConnectOutcome::AuthFailed).unwrap()["outcome"],
            "authFailed"
        );
    }

    #[test]
    fn session_events_use_the_field_names_the_interface_reads() {
        let data = serde_json::to_value(SessionData {
            session_id: "session-1".into(),
            base64: "aGk=".into(),
        })
        .unwrap();
        assert_eq!(data["sessionId"], "session-1");

        let closed = serde_json::to_value(SessionClosed {
            session_id: "session-1".into(),
            reason: "disconnected".into(),
        })
        .unwrap();
        assert_eq!(closed["sessionId"], "session-1");

        let summary = serde_json::to_value(SessionSummary {
            session_id: "session-1".into(),
            profile_id: "p-1".into(),
            host: "gateway.example.com".into(),
            port: 22,
            username: "operator".into(),
        })
        .unwrap();
        assert_eq!(summary["sessionId"], "session-1");
        assert_eq!(summary["profileId"], "p-1");
    }

    #[test]
    fn auth_methods_deserialize_from_the_field_names_the_interface_sends() {
        let password: AuthMethod = serde_json::from_value(serde_json::json!({
            "kind": "password",
            "password": "secret",
        }))
        .unwrap();
        assert!(matches!(password, AuthMethod::Password { .. }));

        let with_passphrase: AuthMethod = serde_json::from_value(serde_json::json!({
            "kind": "privateKey",
            "path": "C:/Users/me/.ssh/id_ed25519",
            "passphrase": "secret",
        }))
        .unwrap();
        match with_passphrase {
            AuthMethod::PrivateKey { path, passphrase } => {
                assert_eq!(path, "C:/Users/me/.ssh/id_ed25519");
                assert_eq!(passphrase.as_deref(), Some("secret"));
            }
            other => panic!("expected a private key, got {other:?}"),
        }

        // The passphrase is optional on the wire, not just nullable.
        let without: AuthMethod = serde_json::from_value(serde_json::json!({
            "kind": "privateKey",
            "path": "/home/me/.ssh/id_ed25519",
        }))
        .unwrap();
        assert!(matches!(
            without,
            AuthMethod::PrivateKey {
                passphrase: None,
                ..
            }
        ));
    }

    #[test]
    fn an_unreadable_key_file_is_a_credential_problem_not_a_rejection() {
        let missing = std::env::temp_dir().join("latticeterm-no-such-key");
        let result = russh::keys::load_secret_key(&missing, None);
        assert!(result.is_err(), "a missing key cannot be loaded");
    }

    #[test]
    fn payloads_survive_bytes_that_are_not_text() {
        let raw = vec![0x00, 0x1b, 0x5b, 0x41, 0xff, 0xfe];
        assert_eq!(decode(&encode(&raw)).unwrap(), raw);
    }

    #[test]
    fn malformed_input_is_rejected_rather_than_guessed_at() {
        assert!(decode("not base64!!").is_err());
    }

    #[test]
    fn a_verdict_of_unknown_becomes_a_question_for_the_user() {
        let outcome = outcome_for(
            Some(TrustVerdict::Unknown {
                host: "gateway.example.com".into(),
                port: 22,
                algorithm: "ssh-ed25519".into(),
                fingerprint: "SHA256:abc".into(),
            }),
            "unused".into(),
        );

        assert!(matches!(outcome, ConnectOutcome::HostUnknown { .. }));
    }

    #[test]
    fn a_changed_key_keeps_both_fingerprints_for_comparison() {
        let expected = HostKeyRecord {
            host: "gateway.example.com".into(),
            port: 22,
            algorithm: "ssh-ed25519".into(),
            fingerprint: "SHA256:old".into(),
            first_trusted_at: 1,
            last_seen_at: 2,
        };

        let outcome = outcome_for(
            Some(TrustVerdict::Changed {
                host: "gateway.example.com".into(),
                port: 22,
                algorithm: "ssh-ed25519".into(),
                received_fingerprint: "SHA256:new".into(),
                expected: expected.clone(),
            }),
            "unused".into(),
        );

        match outcome {
            ConnectOutcome::HostChanged {
                received_fingerprint,
                expected: reported,
                ..
            } => {
                assert_eq!(received_fingerprint, "SHA256:new");
                assert_eq!(reported.fingerprint, "SHA256:old");
            }
            other => panic!("expected HostChanged, got {other:?}"),
        }
    }

    #[test]
    fn a_failure_before_key_exchange_reports_the_transport_error() {
        let outcome = outcome_for(None, "connection refused".into());

        match outcome {
            ConnectOutcome::Failed { stage, detail } => {
                assert_eq!(stage, "connect");
                assert_eq!(detail, "connection refused");
            }
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    #[test]
    fn sending_to_an_unknown_session_is_an_error_not_a_silent_drop() {
        let registry = SshRegistry::new();
        let result = tauri::async_runtime::block_on(send(&registry, "session-404", "aGk="));

        assert!(result.unwrap_err().contains("session-404"));
    }

    #[test]
    fn disconnecting_an_already_closed_session_succeeds() {
        let registry = SshRegistry::new();
        let result = tauri::async_runtime::block_on(disconnect(&registry, "session-404"));

        assert!(result.is_ok());
    }

    #[test]
    fn session_ids_do_not_repeat() {
        let registry = SshRegistry::new();
        let first = registry.next_id();
        let second = registry.next_id();

        assert_ne!(first, second);
    }
}
