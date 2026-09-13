//! Credential storage, routed across two backends.
//!
//! Secrets are addressed by an opaque profile id and credential kind. The
//! plaintext value is only returned to the Rust connection command that needs
//! it; there is deliberately no Tauri command that exposes saved secrets to
//! the WebView.
//!
//! Two backends exist: the OS credential store (default) and the encrypted
//! vault (`vault.rs`). New secrets go to whichever the user prefers. Ordinary
//! connection reads check both backends; the unattended host password instead
//! uses one authoritative marker so rotation can fail closed.

use crate::domain::{ConnectionProfile, Environment, Protocol};
use keyring::{Entry, Error};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use zeroize::{Zeroize, Zeroizing};

const SERVICE: &str = "io.github.NickYCLin.LatticeTerm";
const MAX_PROFILE_ID_LENGTH: usize = 128;
const BACKEND_FILE: &str = "credential_backend.json";
const BOUND_CREDENTIAL_VERSION: u32 = 1;
const LEGACY_CREDENTIAL_ERROR: &str = "This saved credential predates endpoint binding. Re-enter it and choose Remember again before using saved credentials.";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoundCredentialEnvelope {
    version: u32,
    binding_sha256: String,
    secret: String,
}

impl Drop for BoundCredentialEnvelope {
    fn drop(&mut self) {
        self.secret.zeroize();
    }
}

/// Where new secrets are written. Ordinary connection reads cover both.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CredentialBackend {
    OsKeyring,
    Vault,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackendFile {
    version: u32,
    backend: CredentialBackend,
    /// Host credentials deliberately do not use the ordinary cross-backend
    /// fallback. This marker makes an older copy unreachable after rotation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    remote_host_backend: Option<CredentialBackend>,
    /// Backends that may still hold an unreachable host credential. This is
    /// kept after logical revocation so physical deletion can be retried once
    /// a locked vault or temporarily unavailable keyring becomes available.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    remote_host_cleanup_pending: Vec<CredentialBackend>,
}

static DIRECTORY: OnceLock<PathBuf> = OnceLock::new();
static BACKEND_FILE_LOCK: Mutex<()> = Mutex::new(());

/// Called once at startup with the app data directory. Also brings up the
/// vault manager, which lives in the same place.
pub fn initialize(directory: PathBuf) {
    crate::vault::initialize(directory.clone());
    let _ = DIRECTORY.set(directory);
}

fn backend_path() -> Option<PathBuf> {
    DIRECTORY.get().map(|dir| dir.join(BACKEND_FILE))
}

/// Mobile platforms default to the vault so an OS credential store is never
/// selected implicitly; desktop keeps the OS store as its default. iOS still
/// supports its protected Keychain store when the user explicitly selects it.
fn default_backend() -> CredentialBackend {
    if cfg!(any(target_os = "android", target_os = "ios")) {
        CredentialBackend::Vault
    } else {
        CredentialBackend::OsKeyring
    }
}

fn default_backend_file() -> BackendFile {
    BackendFile {
        version: 1,
        backend: default_backend(),
        remote_host_backend: None,
        remote_host_cleanup_pending: Vec::new(),
    }
}

pub fn run_while_backend_file_locked<T>(
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let _guard = BACKEND_FILE_LOCK
        .lock()
        .map_err(|error| error.to_string())?;
    operation()
}

/// Host credential authority is local runtime state, not portable backup
/// state. Export omits it; restore revokes it and conservatively records both
/// backends for later physical cleanup.
pub fn backend_file_for_backup(raw: &str) -> Result<String, String> {
    let mut file: BackendFile = serde_json::from_str(raw).map_err(|error| error.to_string())?;
    file.remote_host_backend = None;
    file.remote_host_cleanup_pending.clear();
    serde_json::to_string_pretty(&file).map_err(|error| error.to_string())
}

pub fn backend_file_for_restore(raw: Option<&str>) -> Result<String, String> {
    let mut file = match raw {
        Some(raw) => serde_json::from_str(raw).map_err(|error| error.to_string())?,
        None => default_backend_file(),
    };
    file.remote_host_backend = None;
    file.remote_host_cleanup_pending = all_credential_backends().to_vec();
    serde_json::to_string_pretty(&file).map_err(|error| error.to_string())
}

fn read_backend_file() -> Result<BackendFile, String> {
    let path = backend_path().ok_or_else(|| "credential storage is not initialised".to_string())?;
    match std::fs::read_to_string(path) {
        Ok(raw) => {
            let file: BackendFile =
                serde_json::from_str(&raw).map_err(|error| error.to_string())?;
            if file.version != 1 {
                return Err("the credential backend version is not supported".to_string());
            }
            Ok(file)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(default_backend_file()),
        Err(error) => Err(error.to_string()),
    }
}

fn write_backend_file_detailed(
    file: &BackendFile,
) -> Result<(), crate::durable_file::AtomicWriteError> {
    let path = backend_path().ok_or_else(|| {
        crate::durable_file::AtomicWriteError::before_replace(
            "credential storage is not initialised",
        )
    })?;
    let encoded = serde_json::to_vec_pretty(file)
        .map_err(crate::durable_file::AtomicWriteError::before_replace)?;
    crate::durable_file::atomic_write_private(&path, &encoded)
}

fn write_backend_file(file: &BackendFile) -> Result<(), String> {
    write_backend_file_detailed(file).map_err(|error| error.to_string())
}

fn activate_remote_host_marker(
    revoked: &BackendFile,
    selected: CredentialBackend,
    write: impl FnOnce(&BackendFile) -> Result<(), crate::durable_file::AtomicWriteError>,
) -> Result<BackendFile, String> {
    let mut committed = revoked.clone();
    committed.remote_host_backend = Some(selected);
    remove_cleanup_pending(&mut committed, selected);
    match write(&committed) {
        Ok(()) => Ok(committed),
        // The new marker file is already visible and its contents were synced.
        // The previous durable state was the revoked marker, so a crash can
        // only retain this valid new authority or safely lose it. Treating the
        // visible activation as committed avoids returning failure while
        // leaving an active marker that could be reloaded after restart.
        Err(error) if error.replacement_visible() => Ok(committed),
        Err(error) => Err(error.to_string()),
    }
}

pub fn preferred_backend() -> CredentialBackend {
    read_backend_file()
        .ok()
        .map(|file| file.backend)
        .unwrap_or_else(default_backend)
}

pub fn set_preferred_backend(backend: CredentialBackend) -> Result<CredentialBackend, String> {
    if backend == CredentialBackend::Vault {
        let vault = crate::vault::manager()?;
        if !vault.exists() {
            return Err("create the vault before making it the primary store".to_string());
        }
    }
    let _guard = BACKEND_FILE_LOCK
        .lock()
        .map_err(|error| error.to_string())?;
    let mut file = read_backend_file()?;
    file.backend = backend;
    write_backend_file(&file)?;
    Ok(backend)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CredentialKind {
    SshPassword,
    SftpPassword,
    RdpPassword,
    VncPassword,
    LatticePairingCode,
    LatticeHostPairingCode,
}

impl CredentialKind {
    fn suffix(self) -> &'static str {
        match self {
            Self::SshPassword => "ssh-password",
            Self::SftpPassword => "sftp-password",
            Self::RdpPassword => "rdp-password",
            Self::VncPassword => "vnc-password",
            Self::LatticePairingCode => "lattice-pairing-code",
            Self::LatticeHostPairingCode => "lattice-host-pairing-code",
        }
    }

    fn protocol(self) -> Protocol {
        match self {
            Self::SshPassword => Protocol::Ssh,
            Self::SftpPassword => Protocol::Sftp,
            Self::RdpPassword => Protocol::Rdp,
            Self::VncPassword => Protocol::Vnc,
            Self::LatticePairingCode | Self::LatticeHostPairingCode => Protocol::Lattice,
        }
    }
}

/// The unattended host password is not attached to a user-created connection
/// profile, but it still needs a stable, non-secret key for status/deletion.
pub const REMOTE_HOST_CREDENTIAL_ID: &str = "remote-host";

fn remote_host_profile() -> ConnectionProfile {
    ConnectionProfile {
        id: REMOTE_HOST_CREDENTIAL_ID.to_string(),
        name: "Lattice Remote host".to_string(),
        protocol: Protocol::Lattice,
        hostname: "local-device".to_string(),
        username: String::new(),
        port: 0,
        environment: Environment::Unassigned,
        group: String::new(),
        tags: Vec::new(),
        favorite: false,
        device_id: None,
        relay_address: None,
    }
}

fn remote_host_binding_context(device_id: &str) -> Result<String, String> {
    let device_id = device_id.trim();
    if device_id.len() != 9 || !device_id.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("The permanent Lattice Remote device ID is invalid.".to_string());
    }
    Ok(format!("lattice-host-device:{device_id}"))
}

pub fn store_remote_host_pairing_code(device_id: &str, secret: &str) -> Result<(), String> {
    let context = remote_host_binding_context(device_id)?;
    let encoded = Zeroizing::new(encode_bound_secret_with_context(
        &remote_host_profile(),
        CredentialKind::LatticeHostPairingCode,
        &context,
        secret,
    )?);
    let _guard = BACKEND_FILE_LOCK
        .lock()
        .map_err(|error| error.to_string())?;
    let file = read_backend_file()?;
    let selected = file.backend;

    // Revoke native loading first and journal every possible old copy. The
    // mutex makes this transition invisible to concurrent host starts; a
    // crash or later write failure leaves the credential fail-closed and the
    // physical cleanup work discoverable.
    let mut revoked = file;
    revoked.remote_host_backend = None;
    revoked.remote_host_cleanup_pending = all_credential_backends().to_vec();
    write_backend_file(&revoked)?;

    store_in_backend(
        selected,
        REMOTE_HOST_CREDENTIAL_ID,
        CredentialKind::LatticeHostPairingCode,
        &encoded,
    )?;

    let mut committed =
        match activate_remote_host_marker(&revoked, selected, write_backend_file_detailed) {
            Ok(committed) => committed,
            Err(error) => {
                let cleanup_error = delete_from_backend(
                    selected,
                    REMOTE_HOST_CREDENTIAL_ID,
                    CredentialKind::LatticeHostPairingCode,
                )
                .err();
                let cleanup = cleanup_error
                    .map(|detail| format!("; the uncommitted copy could not be removed: {detail}"))
                    .unwrap_or_default();
                return Err(format!(
                    "cannot activate the new host credential backend: {error}{cleanup}"
                ));
            }
        };

    // An inaccessible older copy stays unreachable and recorded for a later
    // retry. A failed progress write is only a conservative false positive.
    let other = other_backend(selected);
    if delete_from_backend(
        other,
        REMOTE_HOST_CREDENTIAL_ID,
        CredentialKind::LatticeHostPairingCode,
    )
    .is_ok()
    {
        remove_cleanup_pending(&mut committed, other);
        let _ = write_backend_file(&committed);
    }
    Ok(())
}

pub fn load_remote_host_pairing_code(device_id: &str) -> Result<Zeroizing<String>, String> {
    let context = remote_host_binding_context(device_id)?;
    let _guard = BACKEND_FILE_LOCK
        .lock()
        .map_err(|error| error.to_string())?;
    let backend = read_backend_file()?
        .remote_host_backend
        .ok_or_else(|| NOT_FOUND.to_string())?;
    let encoded = Zeroizing::new(load_from_backend(
        backend,
        REMOTE_HOST_CREDENTIAL_ID,
        CredentialKind::LatticeHostPairingCode,
    )?);
    decode_bound_secret_with_context(
        &remote_host_profile(),
        CredentialKind::LatticeHostPairingCode,
        &context,
        &encoded,
    )
    .map(Zeroizing::new)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteHostCredentialCleanup {
    pub cleanup_pending: bool,
    pub warning: Option<String>,
}

pub fn delete_remote_host_pairing_code() -> Result<RemoteHostCredentialCleanup, String> {
    let _guard = BACKEND_FILE_LOCK
        .lock()
        .map_err(|error| error.to_string())?;
    let mut file = read_backend_file()?;
    file.remote_host_backend = None;
    file.remote_host_cleanup_pending = all_credential_backends().to_vec();
    // Logical revocation is the commit point. Never claim that automatic
    // reuse is disabled unless this durable marker update succeeded.
    write_backend_file(&file)?;
    cleanup_remote_host_backends(&mut file)
}

pub fn retry_remote_host_pairing_code_cleanup() -> Result<RemoteHostCredentialCleanup, String> {
    let _guard = BACKEND_FILE_LOCK
        .lock()
        .map_err(|error| error.to_string())?;
    let mut file = read_backend_file()?;
    cleanup_remote_host_backends(&mut file)
}

pub fn remote_host_pairing_code_cleanup_pending() -> Result<bool, String> {
    let _guard = BACKEND_FILE_LOCK
        .lock()
        .map_err(|error| error.to_string())?;
    Ok(!read_backend_file()?.remote_host_cleanup_pending.is_empty())
}

fn remote_host_pairing_code_exists() -> Result<bool, String> {
    let _guard = BACKEND_FILE_LOCK
        .lock()
        .map_err(|error| error.to_string())?;
    let Some(backend) = read_backend_file()?.remote_host_backend else {
        return Ok(false);
    };
    exists_in_backend(
        backend,
        REMOTE_HOST_CREDENTIAL_ID,
        CredentialKind::LatticeHostPairingCode,
    )
}

/// Stable, non-secret identity of the endpoint a saved credential belongs to.
/// Length-prefixing prevents ambiguous concatenations. Every endpoint field is
/// byte-exact so the digest always matches what the protocol engine actually
/// receives, even for case-sensitive IPv6 zone identifiers or when an IPC
/// caller bypasses draft validation.
pub fn profile_binding_sha256(profile: &ConnectionProfile) -> String {
    profile_binding_sha256_with_context(profile, "")
}

/// Extends the endpoint identity with a protocol-specific authentication
/// realm. RDP uses this for its optional CredSSP domain and Lattice Remote uses
/// it for the permanent relay device ID; other protocols use the context-free
/// wrapper above.
pub fn profile_binding_sha256_with_context(
    profile: &ConnectionProfile,
    authentication_context: &str,
) -> String {
    let fields = [
        profile.protocol.as_str().to_string(),
        profile.hostname.clone(),
        profile.port.to_string(),
        profile.username.clone(),
        authentication_context.to_string(),
    ];
    let mut digest = Sha256::new();
    digest.update(b"latticeterm-credential-binding-v1\0");
    for field in fields {
        digest.update((field.len() as u64).to_be_bytes());
        digest.update(field.as_bytes());
    }
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn validate_bound_kind(profile: &ConnectionProfile, kind: CredentialKind) -> Result<(), String> {
    if profile.protocol != kind.protocol() {
        return Err("The credential kind does not match the connection protocol.".to_string());
    }
    Ok(())
}

fn encode_bound_secret(
    profile: &ConnectionProfile,
    kind: CredentialKind,
    secret: &str,
) -> Result<String, String> {
    encode_bound_secret_with_context(profile, kind, "", secret)
}

fn encode_bound_secret_with_context(
    profile: &ConnectionProfile,
    kind: CredentialKind,
    authentication_context: &str,
    secret: &str,
) -> Result<String, String> {
    validate_bound_kind(profile, kind)?;
    if secret.is_empty() {
        return Err("An empty credential cannot be saved.".to_string());
    }
    serde_json::to_string(&BoundCredentialEnvelope {
        version: BOUND_CREDENTIAL_VERSION,
        binding_sha256: profile_binding_sha256_with_context(profile, authentication_context),
        secret: secret.to_string(),
    })
    .map_err(|error| error.to_string())
}

fn decode_bound_secret(
    profile: &ConnectionProfile,
    kind: CredentialKind,
    encoded: &str,
) -> Result<String, String> {
    decode_bound_secret_with_context(profile, kind, "", encoded)
}

fn decode_bound_secret_with_context(
    profile: &ConnectionProfile,
    kind: CredentialKind,
    authentication_context: &str,
    encoded: &str,
) -> Result<String, String> {
    validate_bound_kind(profile, kind)?;
    let envelope: BoundCredentialEnvelope =
        serde_json::from_str(encoded).map_err(|_| LEGACY_CREDENTIAL_ERROR.to_string())?;
    if envelope.version != BOUND_CREDENTIAL_VERSION {
        return Err(LEGACY_CREDENTIAL_ERROR.to_string());
    }
    if envelope.binding_sha256
        != profile_binding_sha256_with_context(profile, authentication_context)
    {
        return Err(
            "The saved credential belongs to a different endpoint. Delete it or restore the original connection target before reconnecting."
                .to_string(),
        );
    }
    if envelope.secret.is_empty() {
        return Err("The saved credential is empty.".to_string());
    }
    Ok(envelope.secret.clone())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStoreStatus {
    pub ready: bool,
    pub provider: String,
    pub detail: Option<String>,
    pub backend: CredentialBackend,
}

fn provider() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "Windows Credential Manager"
    }
    #[cfg(target_os = "macos")]
    {
        "macOS Keychain"
    }
    #[cfg(target_os = "ios")]
    {
        "iOS Keychain"
    }
    #[cfg(all(unix, not(any(target_os = "macos", target_os = "ios"))))]
    {
        "Secret Service"
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "ios", unix)))]
    {
        "Unsupported platform"
    }
}

fn account(profile_id: &str, kind: CredentialKind) -> Result<String, String> {
    let profile_id = profile_id.trim();
    if profile_id.is_empty() || profile_id.len() > MAX_PROFILE_ID_LENGTH {
        return Err("The credential profile id is missing or too long.".to_string());
    }
    if !profile_id
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("The credential profile id contains unsupported characters.".to_string());
    }
    Ok(format!("profile:{profile_id}:{}", kind.suffix()))
}

fn entry(profile_id: &str, kind: CredentialKind) -> Result<Entry, String> {
    let account = account(profile_id, kind)?;
    Entry::new(SERVICE, &account).map_err(|error| error.to_string())
}

const NOT_FOUND: &str = "No saved credential exists for this connection.";

/// The status of whichever backend new secrets would go to right now.
pub fn status() -> CredentialStoreStatus {
    match preferred_backend() {
        CredentialBackend::OsKeyring => match Entry::store_status() {
            Ok(()) => CredentialStoreStatus {
                ready: true,
                provider: provider().to_string(),
                detail: None,
                backend: CredentialBackend::OsKeyring,
            },
            Err(error) => CredentialStoreStatus {
                ready: false,
                provider: provider().to_string(),
                detail: Some(error.to_string()),
                backend: CredentialBackend::OsKeyring,
            },
        },
        CredentialBackend::Vault => {
            let unlocked = crate::vault::manager()
                .map(|vault| vault.is_unlocked())
                .unwrap_or(false);
            CredentialStoreStatus {
                ready: unlocked,
                provider: "Encrypted vault".to_string(),
                detail: (!unlocked)
                    .then(|| "the vault is locked; unlock it in the Key Vault".to_string()),
                backend: CredentialBackend::Vault,
            }
        }
    }
}

fn keyring_exists(profile_id: &str, kind: CredentialKind) -> Result<bool, String> {
    match entry(profile_id, kind)?.get_password() {
        Ok(secret) => {
            let mut bytes = secret.into_bytes();
            bytes.zeroize();
            Ok(true)
        }
        Err(Error::NoEntry) => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

fn vault_exists(profile_id: &str, kind: CredentialKind) -> Result<bool, String> {
    let vault = crate::vault::manager()?;
    if !vault.exists() {
        return Ok(false);
    }
    vault.exists_entry(&account(profile_id, kind)?)
}

fn keyring_load(profile_id: &str, kind: CredentialKind) -> Result<String, String> {
    entry(profile_id, kind)?
        .get_password()
        .map_err(|error| match error {
            Error::NoEntry => NOT_FOUND.to_string(),
            other => other.to_string(),
        })
}

fn vault_load(profile_id: &str, kind: CredentialKind) -> Result<String, String> {
    crate::vault::manager()?.load(&account(profile_id, kind)?)
}

fn other_backend(backend: CredentialBackend) -> CredentialBackend {
    match backend {
        CredentialBackend::OsKeyring => CredentialBackend::Vault,
        CredentialBackend::Vault => CredentialBackend::OsKeyring,
    }
}

fn all_credential_backends() -> &'static [CredentialBackend; 2] {
    &[CredentialBackend::OsKeyring, CredentialBackend::Vault]
}

fn add_cleanup_pending(file: &mut BackendFile, backend: CredentialBackend) {
    if !file.remote_host_cleanup_pending.contains(&backend) {
        file.remote_host_cleanup_pending.push(backend);
    }
}

fn remove_cleanup_pending(file: &mut BackendFile, backend: CredentialBackend) {
    file.remote_host_cleanup_pending
        .retain(|candidate| *candidate != backend);
}

fn backend_label(backend: CredentialBackend) -> &'static str {
    match backend {
        CredentialBackend::OsKeyring => "OS credential store",
        CredentialBackend::Vault => "encrypted vault",
    }
}

fn cleanup_remote_host_backends(
    file: &mut BackendFile,
) -> Result<RemoteHostCredentialCleanup, String> {
    let previous = file.clone();
    let active = file.remote_host_backend;
    let targets = file.remote_host_cleanup_pending.clone();
    let mut warnings = Vec::new();

    for backend in targets {
        if Some(backend) == active {
            // Never delete the authoritative copy while cleaning up an older
            // backend. It cannot be both live and pending.
            remove_cleanup_pending(file, backend);
            continue;
        }
        match delete_from_backend(
            backend,
            REMOTE_HOST_CREDENTIAL_ID,
            CredentialKind::LatticeHostPairingCode,
        ) {
            Ok(_) => remove_cleanup_pending(file, backend),
            Err(error) => {
                add_cleanup_pending(file, backend);
                warnings.push(format!("{}: {error}", backend_label(backend)));
            }
        }
    }

    let cleanup_pending = if *file == previous {
        !file.remote_host_cleanup_pending.is_empty()
    } else if let Err(error) = write_backend_file(file) {
        // The on-disk journal remains conservative, so another retry can
        // safely repeat already completed deletions.
        *file = previous;
        warnings.push(format!("cannot record secure cleanup progress: {error}"));
        !file.remote_host_cleanup_pending.is_empty()
    } else {
        !file.remote_host_cleanup_pending.is_empty()
    };

    Ok(RemoteHostCredentialCleanup {
        cleanup_pending,
        warning: (!warnings.is_empty()).then(|| warnings.join("; ")),
    })
}

fn exists_in_backend(
    backend: CredentialBackend,
    profile_id: &str,
    kind: CredentialKind,
) -> Result<bool, String> {
    match backend {
        CredentialBackend::OsKeyring => keyring_exists(profile_id, kind),
        CredentialBackend::Vault => vault_exists(profile_id, kind),
    }
}

fn load_from_backend(
    backend: CredentialBackend,
    profile_id: &str,
    kind: CredentialKind,
) -> Result<String, String> {
    match backend {
        CredentialBackend::OsKeyring => keyring_load(profile_id, kind),
        CredentialBackend::Vault => vault_load(profile_id, kind),
    }
}

fn store_in_backend(
    backend: CredentialBackend,
    profile_id: &str,
    kind: CredentialKind,
    secret: &str,
) -> Result<(), String> {
    if secret.is_empty() {
        return Err("An empty credential cannot be saved.".to_string());
    }
    match backend {
        CredentialBackend::OsKeyring => entry(profile_id, kind)?
            .set_password(secret)
            .map_err(|error| error.to_string()),
        CredentialBackend::Vault => {
            crate::vault::manager()?.store(&account(profile_id, kind)?, secret)
        }
    }
}

fn delete_from_backend(
    backend: CredentialBackend,
    profile_id: &str,
    kind: CredentialKind,
) -> Result<bool, String> {
    match backend {
        CredentialBackend::OsKeyring => match entry(profile_id, kind)?.delete_credential() {
            Ok(()) => Ok(true),
            Err(Error::NoEntry) => Ok(false),
            Err(error) => Err(error.to_string()),
        },
        CredentialBackend::Vault => match crate::vault::manager() {
            Ok(vault) if vault.exists() && vault.is_unlocked() => {
                vault.delete(&account(profile_id, kind)?)
            }
            Ok(vault) if vault.exists() => {
                Err("the vault is locked; unlock it to remove its copy too".to_string())
            }
            Ok(_) => Ok(false),
            Err(error) => Err(error),
        },
    }
}

fn merge_exists_results(
    first: Result<bool, String>,
    second: Result<bool, String>,
) -> Result<bool, String> {
    match (first, second) {
        (Ok(true), _) | (_, Ok(true)) => Ok(true),
        (Ok(false), Ok(false)) => Ok(false),
        (Err(error), Ok(false)) | (Ok(false), Err(error)) => Err(error),
        (Err(first_error), Err(second_error)) => Err(format!("{first_error}; {second_error}")),
    }
}

/// True in either backend counts. If neither backend confirms an entry and one
/// cannot answer (for example, a locked encrypted vault), fail closed so a
/// profile cannot be deleted while an orphaned credential may still exist.
pub fn exists(profile_id: &str, kind: CredentialKind) -> Result<bool, String> {
    if kind == CredentialKind::LatticeHostPairingCode {
        if profile_id != REMOTE_HOST_CREDENTIAL_ID {
            return Err("The Lattice Remote host credential id is invalid.".to_string());
        }
        return remote_host_pairing_code_exists();
    }
    merge_exists_results(
        keyring_exists(profile_id, kind),
        vault_exists(profile_id, kind),
    )
}

/// New secrets go to the preferred backend only.
fn store(profile_id: &str, kind: CredentialKind, secret: &str) -> Result<(), String> {
    store_in_backend(preferred_backend(), profile_id, kind, secret)
}

/// Stores a credential together with the exact saved endpoint it may be used
/// for. Editing or replacing a profile can never silently retarget this
/// credential because the binding is authenticated by the credential store's
/// own confidentiality boundary and checked before any connection attempt.
pub fn store_bound(
    profile: &ConnectionProfile,
    kind: CredentialKind,
    secret: &str,
) -> Result<(), String> {
    let encoded = Zeroizing::new(encode_bound_secret(profile, kind, secret)?);
    store(&profile.id, kind, &encoded)
}

pub fn store_bound_with_context(
    profile: &ConnectionProfile,
    kind: CredentialKind,
    authentication_context: &str,
    secret: &str,
) -> Result<(), String> {
    let encoded = Zeroizing::new(encode_bound_secret_with_context(
        profile,
        kind,
        authentication_context,
        secret,
    )?);
    store(&profile.id, kind, &encoded)
}

/// Reads the preferred backend first, then the other, so a secret saved
/// before a preference change is still found. When both miss, the preferred
/// backend's error wins: "the vault is locked" is actionable, a bare
/// "not found" after it would be misleading.
fn load(profile_id: &str, kind: CredentialKind) -> Result<String, String> {
    type Loader = fn(&str, CredentialKind) -> Result<String, String>;
    let (first, second): (Loader, Loader) = match preferred_backend() {
        CredentialBackend::OsKeyring => (keyring_load, vault_load),
        CredentialBackend::Vault => (vault_load, keyring_load),
    };
    match first(profile_id, kind) {
        Ok(secret) => Ok(secret),
        Err(first_error) => match second(profile_id, kind) {
            Ok(secret) => Ok(secret),
            Err(_) => Err(first_error),
        },
    }
}

/// Loads only the versioned endpoint-bound envelope. Legacy raw passwords are
/// deliberately not guessed or auto-migrated: there is no trustworthy way to
/// know which endpoint an old profile-id-only secret originally belonged to.
pub fn load_bound(profile: &ConnectionProfile, kind: CredentialKind) -> Result<String, String> {
    let encoded = Zeroizing::new(load(&profile.id, kind)?);
    decode_bound_secret(profile, kind, &encoded)
}

pub fn load_bound_with_context(
    profile: &ConnectionProfile,
    kind: CredentialKind,
    authentication_context: &str,
) -> Result<String, String> {
    let encoded = Zeroizing::new(load(&profile.id, kind)?);
    decode_bound_secret_with_context(profile, kind, authentication_context, &encoded)
}

/// Removes the secret from both backends. A backend that cannot be asked
/// right now surfaces as an error rather than a silent skip, so "deleted"
/// always means deleted everywhere reachable.
pub fn delete(profile_id: &str, kind: CredentialKind) -> Result<bool, String> {
    if kind == CredentialKind::LatticeHostPairingCode {
        return Err("Use delete_remote_host_pairing_code for host credentials.".to_string());
    }
    let keyring_result = delete_from_backend(CredentialBackend::OsKeyring, profile_id, kind);
    let vault_result = delete_from_backend(CredentialBackend::Vault, profile_id, kind);
    match (keyring_result, vault_result) {
        (Ok(a), Ok(b)) => Ok(a || b),
        (Err(error), _) | (_, Err(error)) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(protocol: Protocol) -> ConnectionProfile {
        ConnectionProfile {
            id: "profile-123".to_string(),
            name: "Gateway".to_string(),
            protocol,
            hostname: "Gateway.Example.COM".to_string(),
            username: "Operator".to_string(),
            port: protocol.default_port(),
            environment: crate::domain::Environment::Production,
            group: "Servers".to_string(),
            tags: Vec::new(),
            favorite: false,
            device_id: None,
            relay_address: None,
        }
    }

    #[test]
    fn account_is_namespaced_without_secret_material() {
        let result = account("profile-123", CredentialKind::SshPassword).unwrap();
        assert_eq!(result, "profile:profile-123:ssh-password");
        assert!(!result.contains("secret"));
    }

    #[test]
    fn account_rejects_path_like_profile_ids() {
        assert!(account("../profile", CredentialKind::RdpPassword).is_err());
        assert!(account("profile/child", CredentialKind::RdpPassword).is_err());
    }

    #[test]
    fn existence_checks_fail_closed_when_an_unavailable_backend_may_hold_a_secret() {
        assert!(!merge_exists_results(Ok(false), Ok(false)).unwrap());
        assert!(merge_exists_results(Ok(true), Err("locked".into())).unwrap());
        assert!(merge_exists_results(Ok(false), Err("locked".into())).is_err());
        assert!(merge_exists_results(Err("keyring".into()), Ok(false)).is_err());
    }

    #[test]
    fn sftp_passwords_have_their_own_namespace() {
        assert_eq!(
            account("profile-123", CredentialKind::SftpPassword).unwrap(),
            "profile:profile-123:sftp-password"
        );
    }

    #[test]
    fn lattice_pairing_codes_have_their_own_namespace() {
        assert_eq!(
            account("profile-123", CredentialKind::LatticePairingCode).unwrap(),
            "profile:profile-123:lattice-pairing-code"
        );
    }

    #[test]
    fn lattice_host_password_has_a_separate_non_secret_namespace() {
        let result = account(
            REMOTE_HOST_CREDENTIAL_ID,
            CredentialKind::LatticeHostPairingCode,
        )
        .unwrap();
        assert_eq!(result, "profile:remote-host:lattice-host-pairing-code");
        assert!(!result.contains("12345678"));
    }

    #[test]
    fn legacy_backend_files_default_host_authority_to_disabled() {
        let file: BackendFile =
            serde_json::from_str(r#"{"version":1,"backend":"osKeyring"}"#).unwrap();
        assert_eq!(file.remote_host_backend, None);
        assert!(file.remote_host_cleanup_pending.is_empty());
    }

    #[test]
    fn backup_backend_files_never_carry_host_authentication_authority() {
        let raw = r#"{
          "version": 1,
          "backend": "vault",
          "remoteHostBackend": "vault",
          "remoteHostCleanupPending": ["osKeyring"]
        }"#;
        let exported = backend_file_for_backup(raw).unwrap();
        let exported: serde_json::Value = serde_json::from_str(&exported).unwrap();
        assert_eq!(exported["backend"], "vault");
        assert!(exported.get("remoteHostBackend").is_none());
        assert!(exported.get("remoteHostCleanupPending").is_none());

        let restored = backend_file_for_restore(Some(raw)).unwrap();
        let restored: BackendFile = serde_json::from_str(&restored).unwrap();
        assert_eq!(restored.backend, CredentialBackend::Vault);
        assert_eq!(restored.remote_host_backend, None);
        assert_eq!(
            restored.remote_host_cleanup_pending,
            all_credential_backends()
        );
    }

    #[test]
    fn cleanup_journal_never_marks_the_active_backend_for_deletion() {
        let mut file = BackendFile {
            version: 1,
            backend: CredentialBackend::Vault,
            remote_host_backend: Some(CredentialBackend::Vault),
            remote_host_cleanup_pending: all_credential_backends().to_vec(),
        };
        remove_cleanup_pending(&mut file, CredentialBackend::Vault);
        add_cleanup_pending(&mut file, CredentialBackend::OsKeyring);
        add_cleanup_pending(&mut file, CredentialBackend::OsKeyring);
        assert_eq!(
            file.remote_host_cleanup_pending,
            vec![CredentialBackend::OsKeyring]
        );
    }

    #[cfg(unix)]
    #[test]
    fn post_replace_sync_failure_commits_only_the_visible_new_authority() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(BACKEND_FILE);
        let revoked = BackendFile {
            version: 1,
            backend: CredentialBackend::Vault,
            remote_host_backend: None,
            remote_host_cleanup_pending: all_credential_backends().to_vec(),
        };
        let encoded = serde_json::to_vec_pretty(&revoked).unwrap();
        crate::durable_file::atomic_write_private(&path, &encoded).unwrap();
        crate::durable_file::fail_next_parent_sync_for_test();
        let committed = activate_remote_host_marker(&revoked, CredentialBackend::Vault, |file| {
            crate::durable_file::atomic_write_private(
                &path,
                &serde_json::to_vec_pretty(file).unwrap(),
            )
        })
        .unwrap();

        assert_eq!(
            committed.remote_host_backend,
            Some(CredentialBackend::Vault)
        );
        // A process restart reads this same self-contained marker. If the
        // unsynced directory entry were lost in a real crash, the previously
        // durable revoked marker would be the only other possible state.
        let persisted: BackendFile =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(
            persisted.remote_host_backend,
            Some(CredentialBackend::Vault)
        );
        assert_eq!(
            persisted.remote_host_cleanup_pending,
            vec![CredentialBackend::OsKeyring]
        );
    }

    #[test]
    fn endpoint_bound_envelopes_round_trip_only_for_the_same_profile() {
        let original = profile(Protocol::Ssh);
        let encoded =
            encode_bound_secret(&original, CredentialKind::SshPassword, "secret").unwrap();

        assert_eq!(
            decode_bound_secret(&original, CredentialKind::SshPassword, &encoded).unwrap(),
            "secret"
        );

        let mut changed_host = original.clone();
        changed_host.hostname = "attacker.example".to_string();
        assert!(
            decode_bound_secret(&changed_host, CredentialKind::SshPassword, &encoded)
                .unwrap_err()
                .contains("different endpoint")
        );

        let mut changed_user = original.clone();
        changed_user.username = "root".to_string();
        assert!(decode_bound_secret(&changed_user, CredentialKind::SshPassword, &encoded).is_err());
    }

    #[test]
    fn protocol_authentication_context_cannot_be_retargeted() {
        let rdp = profile(Protocol::Rdp);
        let encoded = encode_bound_secret_with_context(
            &rdp,
            CredentialKind::RdpPassword,
            "rdp-domain:some:4:CORP",
            "secret",
        )
        .unwrap();

        assert_eq!(
            decode_bound_secret_with_context(
                &rdp,
                CredentialKind::RdpPassword,
                "rdp-domain:some:4:CORP",
                &encoded,
            )
            .unwrap(),
            "secret"
        );
        assert!(decode_bound_secret_with_context(
            &rdp,
            CredentialKind::RdpPassword,
            "rdp-domain:some:4:EVIL",
            &encoded,
        )
        .unwrap_err()
        .contains("different endpoint"));
    }

    #[test]
    fn lattice_pairing_code_is_bound_to_the_permanent_device_identity() {
        let mut lattice = profile(Protocol::Lattice);
        lattice.hostname.clear();
        lattice.port = 0;
        lattice.username.clear();
        lattice.device_id = Some("123 456 789".to_string());
        lattice.relay_address = Some("wss://relay.example.test".to_string());
        let encoded = encode_bound_secret_with_context(
            &lattice,
            CredentialKind::LatticePairingCode,
            "lattice-relay-device:123456789",
            "12345678",
        )
        .unwrap();

        assert_eq!(
            decode_bound_secret_with_context(
                &lattice,
                CredentialKind::LatticePairingCode,
                "lattice-relay-device:123456789",
                &encoded,
            )
            .unwrap(),
            "12345678"
        );
        assert!(decode_bound_secret_with_context(
            &lattice,
            CredentialKind::LatticePairingCode,
            "lattice-relay-device:987654321",
            &encoded,
        )
        .unwrap_err()
        .contains("different endpoint"));
        assert!(encode_bound_secret_with_context(
            &lattice,
            CredentialKind::SshPassword,
            "lattice-relay-device:123456789",
            "12345678",
        )
        .is_err());
    }

    #[test]
    fn lattice_host_password_cannot_be_retargeted_to_a_new_device_identity() {
        let host = remote_host_profile();
        let original_context = remote_host_binding_context("123456789").unwrap();
        let encoded = encode_bound_secret_with_context(
            &host,
            CredentialKind::LatticeHostPairingCode,
            &original_context,
            "correct horse battery staple",
        )
        .unwrap();

        assert_eq!(
            decode_bound_secret_with_context(
                &host,
                CredentialKind::LatticeHostPairingCode,
                &original_context,
                &encoded,
            )
            .unwrap(),
            "correct horse battery staple"
        );
        assert!(decode_bound_secret_with_context(
            &host,
            CredentialKind::LatticeHostPairingCode,
            &remote_host_binding_context("987654321").unwrap(),
            &encoded,
        )
        .unwrap_err()
        .contains("different endpoint"));
        assert!(remote_host_binding_context("not-a-device").is_err());
    }

    #[test]
    fn endpoint_binding_is_byte_exact_for_every_protocol_field() {
        let original = profile(Protocol::Ssh);
        let mut same_host = original.clone();
        same_host.hostname = "gateway.example.com".to_string();
        assert_ne!(
            profile_binding_sha256(&original),
            profile_binding_sha256(&same_host)
        );

        let mut changed_protocol = original.clone();
        changed_protocol.protocol = Protocol::Sftp;
        assert_ne!(
            profile_binding_sha256(&original),
            profile_binding_sha256(&changed_protocol)
        );

        let mut changed_username = original.clone();
        changed_username.username = "operator".to_string();
        assert_ne!(
            profile_binding_sha256(&original),
            profile_binding_sha256(&changed_username)
        );

        let mut padded_username = original.clone();
        padded_username.username.push(' ');
        assert_ne!(
            profile_binding_sha256(&original),
            profile_binding_sha256(&padded_username)
        );

        let mut padded_host = original.clone();
        padded_host.hostname.push(' ');
        assert_ne!(
            profile_binding_sha256(&original),
            profile_binding_sha256(&padded_host)
        );

        let mut ipv6_upper = original.clone();
        ipv6_upper.hostname = "fe80::1%ETH0".to_string();
        let mut ipv6_lower = ipv6_upper.clone();
        ipv6_lower.hostname = "fe80::1%eth0".to_string();
        assert_ne!(
            profile_binding_sha256(&ipv6_upper),
            profile_binding_sha256(&ipv6_lower)
        );
    }

    #[test]
    fn legacy_raw_passwords_and_cross_protocol_envelopes_fail_closed() {
        let ssh = profile(Protocol::Ssh);
        assert_eq!(
            decode_bound_secret(&ssh, CredentialKind::SshPassword, "legacy password").unwrap_err(),
            LEGACY_CREDENTIAL_ERROR
        );
        assert!(encode_bound_secret(&ssh, CredentialKind::RdpPassword, "secret").is_err());
        assert!(encode_bound_secret(&ssh, CredentialKind::SshPassword, "").is_err());
    }
}
