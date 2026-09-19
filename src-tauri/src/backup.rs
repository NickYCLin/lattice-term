//! Password-encrypted, portable application backups.
//!
//! Only an explicit allowlist of LatticeTerm-owned files and WebView storage
//! keys is accepted. The whole payload is authenticated and encrypted before
//! it crosses into the WebView; OS keyring entries and external private-key
//! files are deliberately outside this format.

use argon2::Argon2;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit, Payload as AeadPayload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use zeroize::{Zeroize, Zeroizing};

const BACKUP_FORMAT: &str = "latticeterm-backup";
const BACKUP_VERSION: u32 = 1;
const PAYLOAD_VERSION: u32 = 1;
const CIPHER: &str = "xchacha20poly1305";
const AAD: &[u8] = b"LatticeTerm encrypted backup v1";
const SALT_BYTES: usize = 16;
const NONCE_BYTES: usize = 24;
const KEY_BYTES: usize = 32;
const KDF_MEMORY_KIB: u32 = 64 * 1024;
const KDF_ITERATIONS: u32 = 3;
const KDF_PARALLELISM: u32 = 1;
const MIN_PASSWORD_CHARS: usize = 12;
const MAX_PASSWORD_BYTES: usize = 1024;
const MAX_FILE_BYTES: usize = 8 * 1024 * 1024;
const MAX_LOCAL_VALUE_BYTES: usize = 2 * 1024 * 1024;
const MAX_PAYLOAD_BYTES: usize = 20 * 1024 * 1024;
const MAX_ENVELOPE_BYTES: usize = 28 * 1024 * 1024;

pub const APP_FILES: [&str; 5] = [
    "connections.json",
    "known_hosts.json",
    "agent-workspaces.json",
    "credential_backend.json",
    "vault.json",
];

// Forward restore disables host authority before replacing a vault. Rollback
// reverses that dependency: restore the old vault first and its authority
// marker last, so interruption at any boundary remains fail-closed.
const ROLLBACK_APP_FILES: [&str; 5] = [
    "connections.json",
    "known_hosts.json",
    "agent-workspaces.json",
    "vault.json",
    "credential_backend.json",
];

pub const LOCAL_STORAGE_KEYS: [&str; 4] = [
    "latticeterm.preferences.v2",
    "latticeterm.tunnels.v1",
    "latticeterm.authPrefs.v1",
    // Scheduled chats: the user's own task text and timing, no credentials.
    "latticeterm.agentAutomations.v1",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
struct KdfParameters {
    algorithm: String,
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
    salt: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct BackupEnvelope {
    format: String,
    version: u32,
    cipher: String,
    kdf: KdfParameters,
    nonce: String,
    ciphertext: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct BackupPayload {
    version: u32,
    created_at: u64,
    app_version: String,
    files: BTreeMap<String, String>,
    local_storage: BTreeMap<String, String>,
}

#[derive(Debug)]
pub struct DecryptedBackup {
    pub created_at: u64,
    pub app_version: String,
    pub files: BTreeMap<String, String>,
    pub local_storage: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ValidatedAppData {
    pub profile_count: usize,
    pub trusted_host_count: usize,
    pub agent_plan_count: usize,
    pub vault_included: bool,
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn from_b64(label: &str, value: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|error| format!("The backup {label} is not valid base64: {error}"))
}

fn validate_password(password: &str) -> Result<(), String> {
    if password.chars().count() < MIN_PASSWORD_CHARS || password.len() > MAX_PASSWORD_BYTES {
        return Err(format!(
            "The backup password must contain at least {MIN_PASSWORD_CHARS} characters and at most {MAX_PASSWORD_BYTES} bytes."
        ));
    }
    Ok(())
}

fn fresh_kdf() -> Result<KdfParameters, String> {
    let mut salt = [0_u8; SALT_BYTES];
    getrandom::fill(&mut salt).map_err(|error| error.to_string())?;
    Ok(KdfParameters {
        algorithm: "argon2id".to_string(),
        memory_kib: KDF_MEMORY_KIB,
        iterations: KDF_ITERATIONS,
        parallelism: KDF_PARALLELISM,
        salt: b64(&salt),
    })
}

fn validate_kdf(kdf: &KdfParameters) -> Result<Vec<u8>, String> {
    if kdf.algorithm != "argon2id"
        || kdf.memory_kib != KDF_MEMORY_KIB
        || kdf.iterations != KDF_ITERATIONS
        || kdf.parallelism != KDF_PARALLELISM
    {
        return Err("The backup uses unsupported key-derivation parameters.".to_string());
    }
    let salt = from_b64("salt", &kdf.salt)?;
    if salt.len() != SALT_BYTES {
        return Err("The backup salt has the wrong size.".to_string());
    }
    Ok(salt)
}

fn derive_key(password: &str, kdf: &KdfParameters) -> Result<Zeroizing<[u8; KEY_BYTES]>, String> {
    let salt = validate_kdf(kdf)?;
    let parameters = argon2::Params::new(
        kdf.memory_kib,
        kdf.iterations,
        kdf.parallelism,
        Some(KEY_BYTES),
    )
    .map_err(|error| error.to_string())?;
    let argon = Argon2::new(
        argon2::Algorithm::Argon2id,
        argon2::Version::V0x13,
        parameters,
    );
    let mut key = Zeroizing::new([0_u8; KEY_BYTES]);
    argon
        .hash_password_into(password.as_bytes(), &salt, key.as_mut())
        .map_err(|error| error.to_string())?;
    Ok(key)
}

fn validate_maps(
    files: &BTreeMap<String, String>,
    local_storage: &BTreeMap<String, String>,
) -> Result<(), String> {
    let mut total = 0_usize;
    for (name, value) in files {
        if !APP_FILES.contains(&name.as_str()) {
            return Err(format!(
                "The backup contains an unsupported app file: {name}"
            ));
        }
        if value.len() > MAX_FILE_BYTES {
            return Err(format!("The backup app file '{name}' is too large."));
        }
        total = total.saturating_add(value.len());
    }
    for (key, value) in local_storage {
        if !LOCAL_STORAGE_KEYS.contains(&key.as_str()) {
            return Err(format!(
                "The backup contains an unsupported local setting: {key}"
            ));
        }
        if value.len() > MAX_LOCAL_VALUE_BYTES {
            return Err(format!("The backup local setting '{key}' is too large."));
        }
        serde_json::from_str::<serde_json::Value>(value)
            .map_err(|error| format!("The backup local setting '{key}' is invalid: {error}"))?;
        total = total.saturating_add(value.len());
    }
    if total > MAX_PAYLOAD_BYTES {
        return Err("The backup payload is too large.".to_string());
    }
    Ok(())
}

pub fn create_encrypted_backup(
    app_version: &str,
    created_at: u64,
    mut files: BTreeMap<String, String>,
    local_storage: BTreeMap<String, String>,
    password: &str,
) -> Result<String, String> {
    validate_password(password)?;
    sanitize_host_credential_for_export(&mut files)?;
    validate_maps(&files, &local_storage)?;
    if app_version.is_empty() || app_version.len() > 64 {
        return Err("The application version is invalid.".to_string());
    }

    let payload = BackupPayload {
        version: PAYLOAD_VERSION,
        created_at,
        app_version: app_version.to_string(),
        files,
        local_storage,
    };
    let mut plaintext = serde_json::to_vec(&payload).map_err(|error| error.to_string())?;
    if plaintext.len() > MAX_PAYLOAD_BYTES {
        plaintext.zeroize();
        return Err("The backup payload is too large.".to_string());
    }

    let kdf = fresh_kdf()?;
    let key = derive_key(password, &kdf)?;
    let mut nonce = [0_u8; NONCE_BYTES];
    getrandom::fill(&mut nonce).map_err(|error| error.to_string())?;
    let cipher = XChaCha20Poly1305::new(
        <&Key>::try_from(key.as_ref()).map_err(|_| "The derived key has the wrong size.")?,
    );
    let ciphertext = cipher
        .encrypt(
            &XNonce::from(nonce),
            AeadPayload {
                msg: &plaintext,
                aad: AAD,
            },
        )
        .map_err(|_| "The backup could not be encrypted.".to_string());
    plaintext.zeroize();
    let ciphertext = ciphertext?;

    serde_json::to_string_pretty(&BackupEnvelope {
        format: BACKUP_FORMAT.to_string(),
        version: BACKUP_VERSION,
        cipher: CIPHER.to_string(),
        kdf,
        nonce: b64(&nonce),
        ciphertext: b64(&ciphertext),
    })
    .map_err(|error| error.to_string())
}

pub fn open_encrypted_backup(contents: &str, password: &str) -> Result<DecryptedBackup, String> {
    validate_password(password)?;
    if contents.len() > MAX_ENVELOPE_BYTES {
        return Err("The backup file is too large.".to_string());
    }
    let envelope: BackupEnvelope = serde_json::from_str(contents)
        .map_err(|error| format!("The backup file is not in a known format: {error}"))?;
    if envelope.format != BACKUP_FORMAT
        || envelope.version != BACKUP_VERSION
        || envelope.cipher != CIPHER
    {
        return Err("The backup format or version is not supported.".to_string());
    }

    let key = derive_key(password, &envelope.kdf)?;
    let nonce = from_b64("nonce", &envelope.nonce)?;
    let Ok(nonce) = <&XNonce>::try_from(nonce.as_slice()) else {
        return Err("The backup nonce has the wrong size.".to_string());
    };
    let ciphertext = from_b64("ciphertext", &envelope.ciphertext)?;
    if ciphertext.len() > MAX_PAYLOAD_BYTES + 16 {
        return Err("The encrypted backup payload is too large.".to_string());
    }
    let cipher = XChaCha20Poly1305::new(
        <&Key>::try_from(key.as_ref()).map_err(|_| "The derived key has the wrong size.")?,
    );
    let mut plaintext = cipher
        .decrypt(
            nonce,
            AeadPayload {
                msg: &ciphertext,
                aad: AAD,
            },
        )
        .map_err(|_| {
            "The backup password is wrong, or the backup file was modified.".to_string()
        })?;
    if plaintext.len() > MAX_PAYLOAD_BYTES {
        plaintext.zeroize();
        return Err("The decrypted backup payload is too large.".to_string());
    }
    let decoded = serde_json::from_slice::<BackupPayload>(&plaintext)
        .map_err(|error| format!("The decrypted backup payload is invalid: {error}"));
    plaintext.zeroize();
    let mut decoded = decoded?;
    if decoded.version != PAYLOAD_VERSION {
        return Err("The decrypted backup payload version is not supported.".to_string());
    }
    if decoded.app_version.is_empty() || decoded.app_version.len() > 64 {
        return Err("The backup application version is invalid.".to_string());
    }
    validate_maps(&decoded.files, &decoded.local_storage)?;
    sanitize_host_credential_for_restore(&mut decoded.files)?;
    validate_maps(&decoded.files, &decoded.local_storage)?;
    Ok(DecryptedBackup {
        created_at: decoded.created_at,
        app_version: decoded.app_version,
        files: decoded.files,
        local_storage: decoded.local_storage,
    })
}

fn sanitize_host_credential_for_export(files: &mut BTreeMap<String, String>) -> Result<(), String> {
    let Some(raw) = files.get("credential_backend.json") else {
        return Ok(());
    };
    let sanitized = crate::credentials::backend_file_for_backup(raw)
        .map_err(|error| format!("The credential backend file is invalid: {error}"))?;
    files.insert("credential_backend.json".to_string(), sanitized);
    Ok(())
}

fn sanitize_host_credential_for_restore(
    files: &mut BTreeMap<String, String>,
) -> Result<(), String> {
    let sanitized = crate::credentials::backend_file_for_restore(
        files.get("credential_backend.json").map(String::as_str),
    )
    .map_err(|error| format!("The credential backend file is invalid: {error}"))?;
    files.insert("credential_backend.json".to_string(), sanitized);
    Ok(())
}

fn ensure_regular_file(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(format!(
            "Refusing to back up or restore through symbolic link '{}'.",
            path.display()
        )),
        Ok(metadata) if metadata.is_file() => Ok(true),
        Ok(_) => Err(format!(
            "The application data path '{}' is not a regular file.",
            path.display()
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

pub fn read_app_files(directory: &Path) -> Result<BTreeMap<String, String>, String> {
    let mut files = BTreeMap::new();
    for name in APP_FILES {
        let path = directory.join(name);
        if !ensure_regular_file(&path)? {
            continue;
        }
        let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
        if metadata.len() > MAX_FILE_BYTES as u64 {
            return Err(format!(
                "Application data file '{name}' is too large to back up."
            ));
        }
        let value = fs::read_to_string(&path)
            .map_err(|error| format!("Application data file '{name}' cannot be read: {error}"))?;
        files.insert(name.to_string(), value);
    }
    Ok(files)
}

fn atomic_write(path: &Path, value: &str) -> Result<(), String> {
    crate::durable_file::atomic_write_private(path, value.as_bytes())
        .map_err(|error| error.to_string())
}

fn write_exact_files_in_order(
    directory: &Path,
    files: &BTreeMap<String, String>,
    order: &[&str],
) -> Result<(), String> {
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    for &name in order {
        let path = directory.join(name);
        let exists = ensure_regular_file(&path)?;
        if let Some(value) = files.get(name) {
            atomic_write(&path, value)?;
        } else if exists {
            crate::durable_file::durable_remove_private(&path)?;
        }
    }
    Ok(())
}

fn write_exact_files(directory: &Path, files: &BTreeMap<String, String>) -> Result<(), String> {
    write_exact_files_in_order(directory, files, &APP_FILES)
}

fn write_rollback_files(directory: &Path, files: &BTreeMap<String, String>) -> Result<(), String> {
    write_exact_files_in_order(directory, files, &ROLLBACK_APP_FILES)
}

pub fn replace_app_files(
    directory: &Path,
    files: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, String> {
    let mut files = files.clone();
    sanitize_host_credential_for_restore(&mut files)?;
    validate_maps(&files, &BTreeMap::new())?;
    let previous = read_app_files(directory)?;
    if let Err(error) = write_exact_files(directory, &files) {
        let rollback = write_rollback_files(directory, &previous);
        return Err(match rollback {
            Ok(()) => format!("The backup could not be restored: {error}"),
            Err(rollback_error) => format!(
                "The backup could not be restored ({error}), and rollback also failed ({rollback_error})."
            ),
        });
    }
    Ok(previous)
}

pub fn rollback_app_files(
    directory: &Path,
    previous: &BTreeMap<String, String>,
) -> Result<(), String> {
    write_rollback_files(directory, previous)
}

fn validate_vault_file(raw: &str) -> Result<(), String> {
    let value: serde_json::Value = serde_json::from_str(raw)
        .map_err(|error| format!("The encrypted vault file is invalid: {error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "The encrypted vault file must be a JSON object.".to_string())?;
    if object.get("version").and_then(serde_json::Value::as_u64) != Some(1) {
        return Err("The encrypted vault version is not supported.".to_string());
    }
    let kdf = object
        .get("kdf")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| "The encrypted vault KDF metadata is missing.".to_string())?;
    if kdf.get("algorithm").and_then(serde_json::Value::as_str) != Some("argon2id")
        || kdf.get("memory_kib").and_then(serde_json::Value::as_u64) != Some(64 * 1024)
        || kdf.get("iterations").and_then(serde_json::Value::as_u64) != Some(3)
        || kdf.get("parallelism").and_then(serde_json::Value::as_u64) != Some(1)
    {
        return Err("The encrypted vault KDF parameters are not supported.".to_string());
    }
    let salt = from_b64(
        "vault salt",
        kdf.get("salt")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "The encrypted vault salt is missing.".to_string())?,
    )?;
    let nonce = from_b64(
        "vault nonce",
        object
            .get("nonce")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "The encrypted vault nonce is missing.".to_string())?,
    )?;
    let ciphertext = from_b64(
        "vault ciphertext",
        object
            .get("ciphertext")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "The encrypted vault ciphertext is missing.".to_string())?,
    )?;
    if salt.len() != SALT_BYTES || nonce.len() != NONCE_BYTES || ciphertext.len() < 16 {
        return Err("The encrypted vault cryptographic fields have invalid sizes.".to_string());
    }
    Ok(())
}

fn validate_credential_backend(raw: &str, vault_included: bool) -> Result<(), String> {
    let value: serde_json::Value = serde_json::from_str(raw)
        .map_err(|error| format!("The credential backend file is invalid: {error}"))?;
    if value.get("version").and_then(serde_json::Value::as_u64) != Some(1) {
        return Err("The credential backend version is not supported.".to_string());
    }
    // Selecting the Vault is valid before the user creates or unlocks one
    // (and is the mobile default). It carries no credential authority by
    // itself; remoteHostBackend below remains strict.
    if !matches!(
        value.get("backend").and_then(serde_json::Value::as_str),
        Some("osKeyring" | "vault")
    ) {
        return Err("The credential backend value is not supported.".to_string());
    }
    match value
        .get("remoteHostBackend")
        .and_then(serde_json::Value::as_str)
    {
        None | Some("osKeyring") => Ok(()),
        Some("vault") if vault_included => Ok(()),
        Some("vault") => Err(
            "The backup selects the encrypted vault for the Remote host password but contains no vault file."
                .to_string(),
        ),
        Some(_) => Err("The Remote host credential backend is not supported.".to_string()),
    }?;
    if let Some(pending) = value.get("remoteHostCleanupPending") {
        let pending = pending
            .as_array()
            .ok_or_else(|| "The Remote host credential cleanup journal is invalid.".to_string())?;
        let mut seen = Vec::new();
        for backend in pending {
            let backend = backend.as_str().ok_or_else(|| {
                "The Remote host credential cleanup journal is invalid.".to_string()
            })?;
            if !matches!(backend, "osKeyring" | "vault") || seen.contains(&backend) {
                return Err("The Remote host credential cleanup journal is invalid.".to_string());
            }
            seen.push(backend);
        }
    }
    Ok(())
}

pub fn validate_app_files(files: &BTreeMap<String, String>) -> Result<ValidatedAppData, String> {
    validate_maps(files, &BTreeMap::new())?;
    let temporary = tempfile::tempdir().map_err(|error| error.to_string())?;
    write_exact_files(temporary.path(), files)?;

    let profiles =
        crate::storage::FileStorage::open(temporary.path()).map_err(|error| error.to_string())?;
    if let Some(recovery) = profiles.recovery() {
        return Err(format!(
            "The connection data is invalid: {}",
            recovery.reason
        ));
    }
    let plans = crate::agent_plans::FileAgentPlanStore::open(temporary.path())?;
    if let Some(recovery) = plans.snapshot().recovery {
        return Err(format!(
            "The Agent workspace data is invalid: {}",
            recovery.reason
        ));
    }
    let trust = crate::hostkeys::HostTrustStore::open(temporary.path())
        .map_err(|error| error.to_string())?;
    let vault_included = files.contains_key("vault.json");
    if let Some(raw) = files.get("vault.json") {
        validate_vault_file(raw)?;
    }
    if let Some(raw) = files.get("credential_backend.json") {
        validate_credential_backend(raw, vault_included)?;
    }

    use crate::storage::Storage;
    Ok(ValidatedAppData {
        profile_count: profiles
            .list_profiles()
            .map_err(|error| error.to_string())?
            .len(),
        trusted_host_count: trust.len(),
        agent_plan_count: plans.snapshot().plans.len(),
        vault_included,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASSWORD: &str = "correct horse battery staple";

    #[test]
    fn encrypted_backup_round_trips_without_plaintext_in_the_envelope() {
        let mut files = BTreeMap::new();
        files.insert(
            "connections.json".to_string(),
            r#"{"version":1,"profiles":[]}"#.to_string(),
        );
        let mut local = BTreeMap::new();
        local.insert(
            "latticeterm.preferences.v2".to_string(),
            r#"{"theme":"dark"}"#.to_string(),
        );

        let encrypted =
            create_encrypted_backup("9.9.9", 123, files.clone(), local.clone(), PASSWORD).unwrap();
        assert!(!encrypted.contains("connections.json"));
        assert!(!encrypted.contains("dark"));

        let opened = open_encrypted_backup(&encrypted, PASSWORD).unwrap();
        assert_eq!(opened.created_at, 123);
        assert_eq!(opened.app_version, "9.9.9");
        assert_eq!(
            opened.files.get("connections.json"),
            files.get("connections.json")
        );
        let backend: serde_json::Value =
            serde_json::from_str(opened.files.get("credential_backend.json").unwrap()).unwrap();
        assert!(backend.get("remoteHostBackend").is_none());
        assert_eq!(
            backend["remoteHostCleanupPending"],
            serde_json::json!(["osKeyring", "vault"])
        );
        assert_eq!(opened.local_storage, local);
    }

    #[test]
    fn backup_round_trip_cannot_restore_host_password_authority() {
        let mut files = BTreeMap::new();
        files.insert(
            "credential_backend.json".to_string(),
            r#"{
              "version": 1,
              "backend": "osKeyring",
              "remoteHostBackend": "osKeyring",
              "remoteHostCleanupPending": ["vault"]
            }"#
            .to_string(),
        );

        let encrypted =
            create_encrypted_backup("9.9.9", 123, files, BTreeMap::new(), PASSWORD).unwrap();
        let opened = open_encrypted_backup(&encrypted, PASSWORD).unwrap();
        let backend: serde_json::Value =
            serde_json::from_str(opened.files.get("credential_backend.json").unwrap()).unwrap();
        assert_eq!(backend["backend"], "osKeyring");
        assert!(backend.get("remoteHostBackend").is_none());
        assert_eq!(
            backend["remoteHostCleanupPending"],
            serde_json::json!(["osKeyring", "vault"])
        );
    }

    #[test]
    fn rejects_short_passwords_and_unknown_storage_keys() {
        assert!(
            create_encrypted_backup("1.0.0", 1, BTreeMap::new(), BTreeMap::new(), "short")
                .unwrap_err()
                .contains("at least")
        );

        let mut local = BTreeMap::new();
        local.insert("unrelated.site.token".to_string(), "\"secret\"".to_string());
        assert!(
            create_encrypted_backup("1.0.0", 1, BTreeMap::new(), local, PASSWORD)
                .unwrap_err()
                .contains("unsupported local setting")
        );
    }

    #[test]
    fn validates_empty_application_data_as_a_real_empty_backup() {
        assert_eq!(
            validate_app_files(&BTreeMap::new()).unwrap(),
            ValidatedAppData {
                profile_count: 0,
                trusted_host_count: 0,
                agent_plan_count: 0,
                vault_included: false,
            }
        );
    }

    #[test]
    fn validates_an_uncreated_preferred_vault_without_host_authority() {
        let mut files = BTreeMap::new();
        files.insert(
            "credential_backend.json".to_string(),
            r#"{
              "version": 1,
              "backend": "vault",
              "remoteHostCleanupPending": ["osKeyring", "vault"]
            }"#
            .to_string(),
        );

        assert_eq!(
            validate_app_files(&files).unwrap(),
            ValidatedAppData {
                profile_count: 0,
                trusted_host_count: 0,
                agent_plan_count: 0,
                vault_included: false,
            }
        );
    }

    #[test]
    fn rejects_missing_vault_when_it_is_still_host_authority() {
        let mut files = BTreeMap::new();
        files.insert(
            "credential_backend.json".to_string(),
            r#"{
              "version": 1,
              "backend": "vault",
              "remoteHostBackend": "vault"
            }"#
            .to_string(),
        );

        assert!(validate_app_files(&files)
            .unwrap_err()
            .contains("Remote host password"));
    }

    #[test]
    fn restore_and_rollback_orders_keep_host_authority_fail_closed() {
        let forward_marker = APP_FILES
            .iter()
            .position(|name| *name == "credential_backend.json")
            .unwrap();
        let forward_vault = APP_FILES
            .iter()
            .position(|name| *name == "vault.json")
            .unwrap();
        assert!(forward_marker < forward_vault);

        let rollback_marker = ROLLBACK_APP_FILES
            .iter()
            .position(|name| *name == "credential_backend.json")
            .unwrap();
        let rollback_vault = ROLLBACK_APP_FILES
            .iter()
            .position(|name| *name == "vault.json")
            .unwrap();
        assert!(rollback_vault < rollback_marker);
    }

    #[test]
    fn replacement_returns_a_snapshot_and_rollback_restores_it() {
        let directory = tempfile::tempdir().unwrap();
        let connections = directory.path().join("connections.json");
        let vault = directory.path().join("vault.json");
        let credential_backend = directory.path().join("credential_backend.json");
        fs::write(&connections, "old connections").unwrap();
        fs::write(&vault, "old vault").unwrap();
        let old_backend = r#"{"version":1,"backend":"osKeyring","remoteHostBackend":"osKeyring"}"#;
        fs::write(&credential_backend, old_backend).unwrap();

        let mut next = BTreeMap::new();
        next.insert(
            "connections.json".to_string(),
            "new connections".to_string(),
        );
        next.insert(
            "credential_backend.json".to_string(),
            r#"{"version":1,"backend":"osKeyring","remoteHostBackend":"vault"}"#.to_string(),
        );
        let previous = replace_app_files(directory.path(), &next).unwrap();

        assert_eq!(fs::read_to_string(&connections).unwrap(), "new connections");
        assert!(!vault.exists());
        assert_eq!(previous.get("connections.json").unwrap(), "old connections");
        assert_eq!(previous.get("vault.json").unwrap(), "old vault");
        assert_eq!(
            previous.get("credential_backend.json").unwrap(),
            old_backend
        );
        let restored_backend: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&credential_backend).unwrap()).unwrap();
        assert!(restored_backend.get("remoteHostBackend").is_none());
        assert_eq!(
            restored_backend["remoteHostCleanupPending"],
            serde_json::json!(["osKeyring", "vault"])
        );

        rollback_app_files(directory.path(), &previous).unwrap();
        assert_eq!(fs::read_to_string(&connections).unwrap(), "old connections");
        assert_eq!(fs::read_to_string(&vault).unwrap(), "old vault");
        assert_eq!(
            fs::read_to_string(&credential_backend).unwrap(),
            old_backend
        );
    }
}
