//! The encrypted vault: credential storage that does not need the OS.
//!
//! One file, one master password. The password is stretched with Argon2id
//! into a key that only ever lives in zeroized memory; the entries are sealed
//! with XChaCha20-Poly1305, so any tampering — a flipped byte, a truncated
//! file — fails authentication instead of yielding garbage secrets.
//!
//! The vault exists for the situations the OS credential store cannot cover:
//! a Linux box without a Secret Service, a future mobile build, or a user who
//! simply prefers one portable, password-protected file they can back up.
//! Locking is explicit, and there is no recovery path: losing the master
//! password loses the entries, and the code never pretends otherwise.

use argon2::Argon2;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use zeroize::{Zeroize, Zeroizing};

const VAULT_FILE: &str = "vault.json";
const VAULT_VERSION: u32 = 1;
const SALT_BYTES: usize = 16;
const NONCE_BYTES: usize = 24;
const KEY_BYTES: usize = 32;
/// Argon2id parameters: 64 MiB, 3 passes — interactive-unlock territory that
/// still makes offline guessing expensive.
const KDF_MEMORY_KIB: u32 = 64 * 1024;
const KDF_ITERATIONS: u32 = 3;
const KDF_PARALLELISM: u32 = 1;
const MIN_MASTER_PASSWORD_CHARS: usize = 8;

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn from_b64(value: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|error| format!("the vault file is not valid base64: {error}"))
}

/// What is written to disk. Everything here is safe to read: the work factor,
/// the salt and the sealed bytes. Nothing plaintext.
#[derive(Serialize, Deserialize)]
struct VaultFile {
    version: u32,
    kdf: KdfParameters,
    nonce: String,
    ciphertext: String,
}

#[derive(Serialize, Deserialize)]
struct KdfParameters {
    algorithm: String,
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
    salt: String,
}

/// The decrypted payload, only ever held inside an unlocked vault.
#[derive(Serialize, Deserialize, Default)]
struct VaultEntries {
    entries: HashMap<String, String>,
}

impl Drop for VaultEntries {
    fn drop(&mut self) {
        for secret in self.entries.values_mut() {
            secret.zeroize();
        }
    }
}

struct UnlockedVault {
    key: Zeroizing<[u8; KEY_BYTES]>,
    kdf: KdfParameters,
    entries: HashMap<String, Zeroizing<String>>,
}

/// The vault as the rest of the app sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum VaultLockState {
    /// No vault file exists yet.
    NotCreated,
    Locked,
    Unlocked,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub state: VaultLockState,
    pub entry_count: Option<usize>,
    pub path: String,
}

pub struct VaultManager {
    directory: PathBuf,
    operations: Mutex<()>,
    unlocked: Mutex<Option<UnlockedVault>>,
}

static MANAGER: OnceLock<VaultManager> = OnceLock::new();

/// Called once at startup with the app's data directory.
pub fn initialize(directory: PathBuf) {
    let _ = MANAGER.set(VaultManager {
        directory,
        operations: Mutex::new(()),
        unlocked: Mutex::new(None),
    });
}

pub fn manager() -> Result<&'static VaultManager, String> {
    MANAGER
        .get()
        .ok_or_else(|| "the vault is not initialised yet".to_string())
}

fn derive_key(password: &str, kdf: &KdfParameters) -> Result<Zeroizing<[u8; KEY_BYTES]>, String> {
    let salt = from_b64(&kdf.salt)?;
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
    let mut key = Zeroizing::new([0u8; KEY_BYTES]);
    argon
        .hash_password_into(password.as_bytes(), &salt, key.as_mut())
        .map_err(|error| error.to_string())?;
    Ok(key)
}

fn fresh_kdf() -> Result<KdfParameters, String> {
    let mut salt = [0u8; SALT_BYTES];
    getrandom::fill(&mut salt).map_err(|error| error.to_string())?;
    Ok(KdfParameters {
        algorithm: "argon2id".to_string(),
        memory_kib: KDF_MEMORY_KIB,
        iterations: KDF_ITERATIONS,
        parallelism: KDF_PARALLELISM,
        salt: b64(&salt),
    })
}

fn seal(
    key: &[u8; KEY_BYTES],
    kdf: &KdfParameters,
    entries: &HashMap<String, Zeroizing<String>>,
) -> Result<VaultFile, String> {
    let payload = VaultEntries {
        entries: entries
            .iter()
            .map(|(name, secret)| (name.clone(), secret.as_str().to_string()))
            .collect(),
    };
    let plaintext =
        Zeroizing::new(serde_json::to_vec(&payload).map_err(|error| error.to_string())?);

    let mut nonce_bytes = [0u8; NONCE_BYTES];
    getrandom::fill(&mut nonce_bytes).map_err(|error| error.to_string())?;
    let cipher = XChaCha20Poly1305::new(<&Key>::try_from(key.as_slice()).expect("32-byte key"));
    let ciphertext = cipher
        .encrypt(&XNonce::from(nonce_bytes), plaintext.as_slice())
        .map_err(|_| "the vault could not be sealed".to_string())?;
    Ok(VaultFile {
        version: VAULT_VERSION,
        kdf: KdfParameters {
            algorithm: kdf.algorithm.clone(),
            memory_kib: kdf.memory_kib,
            iterations: kdf.iterations,
            parallelism: kdf.parallelism,
            salt: kdf.salt.clone(),
        },
        nonce: b64(&nonce_bytes),
        ciphertext: b64(&ciphertext),
    })
}

fn open_sealed(path: &Path) -> Result<VaultFile, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|error| format!("the vault file cannot be read: {error}"))?;
    let file: VaultFile = serde_json::from_str(&raw)
        .map_err(|error| format!("the vault file is not in a known format: {error}"))?;
    if file.version != VAULT_VERSION {
        return Err(format!(
            "the vault file is version {} but this build understands version {VAULT_VERSION}",
            file.version
        ));
    }
    if file.kdf.algorithm != "argon2id" {
        return Err("the vault uses an unknown key derivation".to_string());
    }
    Ok(file)
}

fn unseal(
    file: &VaultFile,
    key: &[u8; KEY_BYTES],
) -> Result<HashMap<String, Zeroizing<String>>, String> {
    let cipher = XChaCha20Poly1305::new(<&Key>::try_from(key.as_slice()).expect("32-byte key"));
    let nonce = from_b64(&file.nonce)?;
    let Ok(nonce) = <&XNonce>::try_from(nonce.as_slice()) else {
        return Err("the vault nonce has the wrong size".to_string());
    };
    let ciphertext = from_b64(&file.ciphertext)?;
    let plaintext = Zeroizing::new(cipher.decrypt(nonce, ciphertext.as_slice()).map_err(|_| {
        // AEAD cannot tell a wrong key from a tampered file; say both.
        "the master password is wrong, or the vault file was modified".to_string()
    })?);
    let mut payload: VaultEntries =
        serde_json::from_slice(&plaintext).map_err(|error| error.to_string())?;
    Ok(std::mem::take(&mut payload.entries)
        .into_iter()
        .map(|(name, secret)| (name, Zeroizing::new(secret)))
        .collect())
}

impl VaultManager {
    fn path(&self) -> PathBuf {
        self.directory.join(VAULT_FILE)
    }

    /// Serialises a backup file snapshot or replacement with every operation
    /// that can decrypt or rewrite the vault.
    pub fn run_while_locked<T>(
        &self,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let _operation = self.operations.lock().map_err(|error| error.to_string())?;
        let unlocked = self.unlocked.lock().map_err(|error| error.to_string())?;
        if unlocked.is_some() {
            return Err(
                "Lock the encrypted vault before creating or restoring a backup.".to_string(),
            );
        }
        let result = operation();
        drop(unlocked);
        result
    }

    pub fn exists(&self) -> bool {
        self.path().is_file()
    }

    pub fn is_unlocked(&self) -> bool {
        self.unlocked
            .lock()
            .map(|guard| guard.is_some())
            .unwrap_or(false)
    }

    pub fn status(&self) -> VaultStatus {
        let (state, entry_count) = match self.unlocked.lock() {
            Ok(guard) => match guard.as_ref() {
                Some(vault) => (VaultLockState::Unlocked, Some(vault.entries.len())),
                None if self.exists() => (VaultLockState::Locked, None),
                None => (VaultLockState::NotCreated, None),
            },
            Err(_) => (VaultLockState::Locked, None),
        };
        VaultStatus {
            state,
            entry_count,
            path: self.path().display().to_string(),
        }
    }

    /// Writes the current entries through the platform's durable atomic-file
    /// path, so a successful credential update cannot revert after a crash.
    fn persist(&self, vault: &UnlockedVault) -> Result<(), String> {
        let sealed = seal(&vault.key, &vault.kdf, &vault.entries)?;
        let encoded = serde_json::to_vec_pretty(&sealed).map_err(|error| error.to_string())?;
        crate::durable_file::atomic_write_private(&self.path(), &encoded)
            .map_err(|error| error.to_string())
    }

    pub fn create(&self, master_password: &str) -> Result<VaultStatus, String> {
        let _operation = self.operations.lock().map_err(|error| error.to_string())?;
        if master_password.chars().count() < MIN_MASTER_PASSWORD_CHARS {
            return Err(format!(
                "the master password needs at least {MIN_MASTER_PASSWORD_CHARS} characters"
            ));
        }
        if self.exists() {
            return Err("a vault already exists — unlock it instead".to_string());
        }
        let kdf = fresh_kdf()?;
        let key = derive_key(master_password, &kdf)?;
        let vault = UnlockedVault {
            key,
            kdf,
            entries: HashMap::new(),
        };
        self.persist(&vault)?;
        *self.unlocked.lock().map_err(|error| error.to_string())? = Some(vault);
        Ok(self.status())
    }

    pub fn unlock(&self, master_password: &str) -> Result<VaultStatus, String> {
        let _operation = self.operations.lock().map_err(|error| error.to_string())?;
        if !self.exists() {
            return Err("no vault exists yet — create one first".to_string());
        }
        let file = open_sealed(&self.path())?;
        let key = derive_key(master_password, &file.kdf)?;
        let entries = unseal(&file, &key)?;
        *self.unlocked.lock().map_err(|error| error.to_string())? = Some(UnlockedVault {
            key,
            kdf: file.kdf,
            entries,
        });
        Ok(self.status())
    }

    /// Drops the key and the decrypted entries. The file stays.
    pub fn lock(&self) -> VaultStatus {
        let Ok(_operation) = self.operations.lock() else {
            return self.status();
        };
        if let Ok(mut guard) = self.unlocked.lock() {
            *guard = None;
        }
        self.status()
    }

    pub fn change_password(&self, current: &str, next: &str) -> Result<VaultStatus, String> {
        let _operation = self.operations.lock().map_err(|error| error.to_string())?;
        if next.chars().count() < MIN_MASTER_PASSWORD_CHARS {
            return Err(format!(
                "the master password needs at least {MIN_MASTER_PASSWORD_CHARS} characters"
            ));
        }
        // The current password must prove itself against the file, not
        // against whatever happens to be unlocked in memory.
        let file = open_sealed(&self.path())?;
        let key = derive_key(current, &file.kdf)?;
        let entries = unseal(&file, &key)?;

        let kdf = fresh_kdf()?;
        let new_key = derive_key(next, &kdf)?;
        let vault = UnlockedVault {
            key: new_key,
            kdf,
            entries,
        };
        self.persist(&vault)?;
        *self.unlocked.lock().map_err(|error| error.to_string())? = Some(vault);
        Ok(self.status())
    }

    fn with_unlocked<T>(
        &self,
        operation: impl FnOnce(&mut UnlockedVault) -> Result<T, String>,
    ) -> Result<T, String> {
        let _operation = self.operations.lock().map_err(|error| error.to_string())?;
        let mut guard = self.unlocked.lock().map_err(|error| error.to_string())?;
        let vault = guard
            .as_mut()
            .ok_or_else(|| "the vault is locked — unlock it in the Key Vault first".to_string())?;
        operation(vault)
    }

    pub fn store(&self, account: &str, secret: &str) -> Result<(), String> {
        if secret.is_empty() {
            return Err("An empty password cannot be saved.".to_string());
        }
        self.with_unlocked(|vault| {
            let previous = vault
                .entries
                .insert(account.to_string(), Zeroizing::new(secret.to_string()));
            if let Err(error) = self.persist(vault) {
                match previous {
                    Some(previous) => {
                        vault.entries.insert(account.to_string(), previous);
                    }
                    None => {
                        vault.entries.remove(account);
                    }
                }
                return Err(error);
            }
            Ok(())
        })
    }

    pub fn load(&self, account: &str) -> Result<String, String> {
        self.with_unlocked(|vault| {
            vault
                .entries
                .get(account)
                .map(|secret| secret.as_str().to_string())
                .ok_or_else(|| "No saved credential exists for this connection.".to_string())
        })
    }

    pub fn exists_entry(&self, account: &str) -> Result<bool, String> {
        self.with_unlocked(|vault| Ok(vault.entries.contains_key(account)))
    }

    pub fn delete(&self, account: &str) -> Result<bool, String> {
        self.with_unlocked(|vault| {
            let Some(removed) = vault.entries.remove(account) else {
                return Ok(false);
            };
            if let Err(error) = self.persist(vault) {
                vault.entries.insert(account.to_string(), removed);
                return Err(error);
            }
            Ok(true)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_manager() -> VaultManager {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("latticeterm-vault-test-{unique}"));
        std::fs::create_dir_all(&directory).unwrap();
        VaultManager {
            directory,
            operations: Mutex::new(()),
            unlocked: Mutex::new(None),
        }
    }

    #[test]
    fn a_created_vault_stores_and_returns_secrets() {
        let vault = test_manager();
        assert_eq!(vault.status().state, VaultLockState::NotCreated);

        vault.create("correct horse battery").unwrap();
        assert_eq!(vault.status().state, VaultLockState::Unlocked);

        vault.store("profile:p1:ssh-password", "hunter2!").unwrap();
        assert_eq!(vault.load("profile:p1:ssh-password").unwrap(), "hunter2!");
        assert!(vault.exists_entry("profile:p1:ssh-password").unwrap());
        assert!(!vault.exists_entry("profile:p2:ssh-password").unwrap());
    }

    #[test]
    fn entries_survive_lock_and_unlock() {
        let vault = test_manager();
        vault.create("correct horse battery").unwrap();
        vault.store("profile:p1:ssh-password", "hunter2!").unwrap();

        vault.lock();
        assert_eq!(vault.status().state, VaultLockState::Locked);
        assert!(vault.load("profile:p1:ssh-password").is_err());

        vault.unlock("correct horse battery").unwrap();
        assert_eq!(vault.load("profile:p1:ssh-password").unwrap(), "hunter2!");
    }

    #[test]
    fn the_wrong_master_password_is_refused() {
        let vault = test_manager();
        vault.create("correct horse battery").unwrap();
        vault.lock();

        let error = vault.unlock("wrong password!").unwrap_err();
        assert!(error.contains("master password"), "{error}");
        assert_eq!(vault.status().state, VaultLockState::Locked);
    }

    #[test]
    fn a_tampered_file_fails_authentication() {
        let vault = test_manager();
        vault.create("correct horse battery").unwrap();
        vault.store("profile:p1:ssh-password", "hunter2!").unwrap();
        vault.lock();

        // Flip one byte inside the sealed payload.
        let path = vault.path();
        let mut raw = std::fs::read_to_string(&path).unwrap();
        let mut file: VaultFile = serde_json::from_str(&raw).unwrap();
        let mut bytes = from_b64(&file.ciphertext).unwrap();
        bytes[0] ^= 0x01;
        file.ciphertext = b64(&bytes);
        raw = serde_json::to_string(&file).unwrap();
        std::fs::write(&path, raw).unwrap();

        assert!(vault.unlock("correct horse battery").is_err());
    }

    #[test]
    fn changing_the_password_requires_the_current_one() {
        let vault = test_manager();
        vault.create("correct horse battery").unwrap();
        vault.store("profile:p1:ssh-password", "hunter2!").unwrap();

        assert!(vault
            .change_password("not the password", "next password!")
            .is_err());

        vault
            .change_password("correct horse battery", "next password!")
            .unwrap();
        vault.lock();
        assert!(vault.unlock("correct horse battery").is_err());
        vault.unlock("next password!").unwrap();
        assert_eq!(vault.load("profile:p1:ssh-password").unwrap(), "hunter2!");
    }

    #[test]
    fn weak_master_passwords_are_rejected_up_front() {
        let vault = test_manager();
        assert!(vault.create("short").is_err());
        assert_eq!(vault.status().state, VaultLockState::NotCreated);
    }

    #[test]
    fn deleting_an_entry_persists_and_reports_honestly() {
        let vault = test_manager();
        vault.create("correct horse battery").unwrap();
        vault.store("profile:p1:ssh-password", "hunter2!").unwrap();

        assert!(vault.delete("profile:p1:ssh-password").unwrap());
        assert!(!vault.delete("profile:p1:ssh-password").unwrap());

        vault.lock();
        vault.unlock("correct horse battery").unwrap();
        assert!(!vault.exists_entry("profile:p1:ssh-password").unwrap());
    }

    #[test]
    fn failed_persistence_rolls_back_store_and_delete_in_memory() {
        let vault = test_manager();
        let account = "profile:p1:ssh-password";
        vault.create("correct horse battery").unwrap();
        vault.store(account, "old password").unwrap();

        let moved_directory = vault.directory.with_extension("moved");
        std::fs::rename(&vault.directory, &moved_directory).unwrap();
        std::fs::write(&vault.directory, "blocks directory creation").unwrap();

        assert!(vault.store(account, "new password").is_err());
        assert_eq!(vault.load(account).unwrap(), "old password");
        assert!(vault.delete(account).is_err());
        assert_eq!(vault.load(account).unwrap(), "old password");

        std::fs::remove_file(&vault.directory).unwrap();
        std::fs::rename(moved_directory, &vault.directory).unwrap();
    }

    #[test]
    fn the_file_on_disk_never_contains_the_secret() {
        let vault = test_manager();
        vault.create("correct horse battery").unwrap();
        vault
            .store("profile:p1:ssh-password", "super-secret-value")
            .unwrap();

        let raw = std::fs::read_to_string(vault.path()).unwrap();
        assert!(!raw.contains("super-secret-value"));
        assert!(!raw.contains("correct horse battery"));
        assert!(!raw.contains("ssh-password"), "entry names are sealed too");
    }

    #[test]
    fn backup_file_operations_require_a_locked_vault() {
        let vault = test_manager();
        vault.create("correct horse battery").unwrap();

        assert!(vault.run_while_locked(|| Ok(())).is_err());
        vault.lock();
        assert_eq!(
            vault.run_while_locked(|| Ok("snapshot")).unwrap(),
            "snapshot"
        );
    }
}
