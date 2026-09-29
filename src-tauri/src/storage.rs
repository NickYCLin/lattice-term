//! Storage for connection profiles.
//!
//! Two implementations share one trait: an in-memory store used by tests, and
//! a file-backed store used by the running application.
//!
//! Strictly non-secret. `ConnectionProfile` has no field for a password, key
//! or passphrase, so this file can be opened, backed up or attached to a bug
//! report without leaking anything. Secrets belong to the OS credential store,
//! which is a separate subsystem and deliberately not written here.

use crate::domain::ConnectionProfile;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Bumped only when the on-disk shape changes in a way older builds cannot read.
pub const STORE_VERSION: u32 = 1;

const STORE_FILE: &str = "connections.json";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StorageError {
    NotFound(String),
    Validation(String),
    Internal(String),
}

impl std::fmt::Display for StorageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StorageError::NotFound(id) => write!(f, "Profile with ID '{id}' not found"),
            StorageError::Validation(msg) => write!(f, "Validation error: {msg}"),
            StorageError::Internal(msg) => write!(f, "Storage internal error: {msg}"),
        }
    }
}

impl std::error::Error for StorageError {}

pub trait Storage: Send + Sync {
    fn list_profiles(&self) -> Result<Vec<ConnectionProfile>, StorageError>;
    fn get_profile(&self, id: &str) -> Result<Option<ConnectionProfile>, StorageError>;
    fn insert_profile(&mut self, profile: ConnectionProfile) -> Result<(), StorageError>;
    fn update_profile(&mut self, profile: ConnectionProfile) -> Result<(), StorageError>;
    fn delete_profile(&mut self, id: &str) -> Result<bool, StorageError>;
    fn replace_profiles(&mut self, profiles: Vec<ConnectionProfile>) -> Result<(), StorageError>;
}

#[derive(Debug, Default, Clone)]
pub struct InMemoryStorage {
    profiles: HashMap<String, ConnectionProfile>,
}

impl InMemoryStorage {
    pub fn new() -> Self {
        Self {
            profiles: HashMap::new(),
        }
    }
}

fn sorted(profiles: &HashMap<String, ConnectionProfile>) -> Vec<ConnectionProfile> {
    let mut list: Vec<ConnectionProfile> = profiles.values().cloned().collect();
    list.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
    list
}

fn index_profiles(
    profiles: Vec<ConnectionProfile>,
) -> Result<HashMap<String, ConnectionProfile>, StorageError> {
    let mut indexed = HashMap::with_capacity(profiles.len());
    for profile in profiles {
        let id = profile.id.clone();
        if id.trim().is_empty() {
            return Err(StorageError::Validation(
                "profile ID cannot be empty".to_string(),
            ));
        }
        if indexed.insert(id.clone(), profile).is_some() {
            return Err(StorageError::Validation(format!(
                "profile ID '{id}' appears more than once"
            )));
        }
    }
    Ok(indexed)
}

impl Storage for InMemoryStorage {
    fn list_profiles(&self) -> Result<Vec<ConnectionProfile>, StorageError> {
        Ok(sorted(&self.profiles))
    }

    fn get_profile(&self, id: &str) -> Result<Option<ConnectionProfile>, StorageError> {
        Ok(self.profiles.get(id).cloned())
    }

    fn insert_profile(&mut self, profile: ConnectionProfile) -> Result<(), StorageError> {
        self.profiles.insert(profile.id.clone(), profile);
        Ok(())
    }

    fn update_profile(&mut self, profile: ConnectionProfile) -> Result<(), StorageError> {
        if !self.profiles.contains_key(&profile.id) {
            return Err(StorageError::NotFound(profile.id));
        }
        self.profiles.insert(profile.id.clone(), profile);
        Ok(())
    }

    fn delete_profile(&mut self, id: &str) -> Result<bool, StorageError> {
        Ok(self.profiles.remove(id).is_some())
    }

    fn replace_profiles(&mut self, profiles: Vec<ConnectionProfile>) -> Result<(), StorageError> {
        self.profiles = index_profiles(profiles)?;
        Ok(())
    }
}

/// The on-disk shape. `version` lets a future build recognise a file it cannot
/// read instead of silently misinterpreting it.
#[derive(Debug, Serialize, Deserialize)]
struct StoreFile {
    version: u32,
    profiles: Vec<ConnectionProfile>,
}

/// Why the previous file was set aside, when that happened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recovery {
    pub reason: String,
    pub backup_path: PathBuf,
}

/// Connection profiles persisted as JSON in the application data directory.
///
/// Every mutation writes the whole file: the data is small, and a full rewrite
/// keeps the file consistent without a journal. Writes go to a temporary file
/// and are then renamed over the target, so an interrupted write leaves the
/// previous file intact rather than a half-written one.
#[derive(Debug)]
pub struct FileStorage {
    path: PathBuf,
    profiles: HashMap<String, ConnectionProfile>,
    recovery: Option<Recovery>,
}

impl FileStorage {
    /// Opens the store in `dir`, creating the directory if needed.
    ///
    /// A missing file is a first run, not an error. A file that cannot be read
    /// is moved aside rather than deleted, so nothing the user wrote is lost
    /// even when this build cannot understand it.
    pub fn open(dir: &Path) -> Result<Self, StorageError> {
        fs::create_dir_all(dir).map_err(|e| StorageError::Internal(e.to_string()))?;

        let path = dir.join(STORE_FILE);
        let mut store = Self {
            path,
            profiles: HashMap::new(),
            recovery: None,
        };

        let raw = match fs::read_to_string(&store.path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(store),
            Err(error) => return Err(StorageError::Internal(error.to_string())),
        };

        match serde_json::from_str::<StoreFile>(&raw) {
            Ok(file) if file.version <= STORE_VERSION => {
                for profile in file.profiles {
                    store.profiles.insert(profile.id.clone(), profile);
                }
            }
            Ok(file) => {
                let reason = format!(
                    "file was written by a newer version (found {}, supported {})",
                    file.version, STORE_VERSION
                );
                store.recovery = Some(store.set_aside(&reason)?);
            }
            Err(error) => {
                let reason = format!("file could not be read: {error}");
                store.recovery = Some(store.set_aside(&reason)?);
            }
        }

        Ok(store)
    }

    /// Renames the unreadable file out of the way and reports where it went.
    fn set_aside(&self, reason: &str) -> Result<Recovery, StorageError> {
        let mut backup = self.path.clone();
        backup.set_extension("json.unreadable");

        // Never overwrite an earlier rescue; keep numbering until one is free.
        let mut attempt = 1;
        while backup.exists() {
            backup = self.path.clone();
            backup.set_extension(format!("json.unreadable.{attempt}"));
            attempt += 1;
        }

        fs::rename(&self.path, &backup).map_err(|e| StorageError::Internal(e.to_string()))?;

        Ok(Recovery {
            reason: reason.to_string(),
            backup_path: backup,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn recovery(&self) -> Option<&Recovery> {
        self.recovery.as_ref()
    }

    fn persist_profiles(
        &self,
        profiles: &HashMap<String, ConnectionProfile>,
    ) -> Result<(), StorageError> {
        let file = StoreFile {
            version: STORE_VERSION,
            profiles: sorted(profiles),
        };

        let json = serde_json::to_string_pretty(&file)
            .map_err(|e| StorageError::Internal(e.to_string()))?;

        let dir = self
            .path
            .parent()
            .ok_or_else(|| StorageError::Internal("store path has no directory".into()))?;
        let mut temp = tempfile::Builder::new()
            .prefix(".connections-")
            .suffix(".tmp")
            .tempfile_in(dir)
            .map_err(|e| StorageError::Internal(e.to_string()))?;

        temp.write_all(json.as_bytes())
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        // Flush before the rename, so the swap cannot publish a short file.
        temp.as_file()
            .sync_all()
            .map_err(|e| StorageError::Internal(e.to_string()))?;

        // NamedTempFile::persist atomically replaces the destination on all
        // supported desktop platforms and cleans the temporary file on error.
        temp.persist(&self.path)
            .map(|_| ())
            .map_err(|e| StorageError::Internal(e.to_string()))
    }
}

impl Storage for FileStorage {
    fn list_profiles(&self) -> Result<Vec<ConnectionProfile>, StorageError> {
        Ok(sorted(&self.profiles))
    }

    fn get_profile(&self, id: &str) -> Result<Option<ConnectionProfile>, StorageError> {
        Ok(self.profiles.get(id).cloned())
    }

    fn insert_profile(&mut self, profile: ConnectionProfile) -> Result<(), StorageError> {
        let mut next = self.profiles.clone();
        next.insert(profile.id.clone(), profile);
        self.persist_profiles(&next)?;
        self.profiles = next;
        Ok(())
    }

    fn update_profile(&mut self, profile: ConnectionProfile) -> Result<(), StorageError> {
        if !self.profiles.contains_key(&profile.id) {
            return Err(StorageError::NotFound(profile.id));
        }
        let mut next = self.profiles.clone();
        next.insert(profile.id.clone(), profile);
        self.persist_profiles(&next)?;
        self.profiles = next;
        Ok(())
    }

    fn delete_profile(&mut self, id: &str) -> Result<bool, StorageError> {
        if !self.profiles.contains_key(id) {
            return Ok(false);
        }

        let mut next = self.profiles.clone();
        next.remove(id);
        self.persist_profiles(&next)?;
        self.profiles = next;
        Ok(true)
    }

    fn replace_profiles(&mut self, profiles: Vec<ConnectionProfile>) -> Result<(), StorageError> {
        let next = index_profiles(profiles)?;
        self.persist_profiles(&next)?;
        self.profiles = next;
        Ok(())
    }
}

#[cfg(test)]
mod file_storage_tests {
    use super::*;
    use crate::domain::{Environment, Protocol};

    /// A unique directory per test, so cases cannot disturb each other.
    fn temp_dir(label: &str) -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("latticeterm-{label}-{unique}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn profile(id: &str, name: &str) -> ConnectionProfile {
        ConnectionProfile {
            id: id.to_string(),
            name: name.to_string(),
            protocol: Protocol::Ssh,
            hostname: "gateway.example.com".to_string(),
            username: "operator".to_string(),
            port: 22,
            environment: Environment::Production,
            group: "Core platform".to_string(),
            tags: vec!["edge".to_string()],
            favorite: true,
            device_id: None,
            relay_address: None,
            machine_id: None,
        }
    }

    #[test]
    fn machine_link_round_trips_and_stays_out_of_unlinked_entries() {
        let plain = serde_json::to_value(profile("a", "A")).unwrap();
        assert!(plain.get("machineId").is_none());
        let linked = ConnectionProfile {
            machine_id: Some("m1".to_string()),
            ..profile("b", "B")
        };
        let value = serde_json::to_value(&linked).unwrap();
        assert_eq!(value["machineId"], "m1");
        let back: ConnectionProfile = serde_json::from_value(value).unwrap();
        assert_eq!(back, linked);
        let old: ConnectionProfile = serde_json::from_value(plain).unwrap();
        assert_eq!(old.machine_id, None);
    }

    #[test]
    fn a_missing_file_is_a_first_run_not_an_error() {
        let dir = temp_dir("first-run");
        let store = FileStorage::open(&dir).unwrap();

        assert!(store.list_profiles().unwrap().is_empty());
        assert!(store.recovery().is_none());
        // Nothing is written until there is something to write.
        assert!(!store.path().exists());
    }

    #[test]
    fn profiles_survive_reopening() {
        let dir = temp_dir("round-trip");

        let mut store = FileStorage::open(&dir).unwrap();
        store
            .insert_profile(profile("p-1", "Edge gateway"))
            .unwrap();
        store.insert_profile(profile("p-2", "App node")).unwrap();

        let reopened = FileStorage::open(&dir).unwrap();
        let names: Vec<String> = reopened
            .list_profiles()
            .unwrap()
            .into_iter()
            .map(|p| p.name)
            .collect();

        assert_eq!(names, vec!["App node", "Edge gateway"]);
    }

    #[test]
    fn deletions_survive_reopening() {
        let dir = temp_dir("delete");

        let mut store = FileStorage::open(&dir).unwrap();
        store
            .insert_profile(profile("p-1", "Edge gateway"))
            .unwrap();
        store.insert_profile(profile("p-2", "App node")).unwrap();
        assert!(store.delete_profile("p-1").unwrap());
        assert!(!store.delete_profile("p-1").unwrap());

        let reopened = FileStorage::open(&dir).unwrap();
        assert_eq!(reopened.list_profiles().unwrap().len(), 1);
    }

    #[test]
    fn the_written_file_carries_a_version_and_no_secret_fields() {
        let dir = temp_dir("shape");
        let mut store = FileStorage::open(&dir).unwrap();
        store
            .insert_profile(profile("p-1", "Edge gateway"))
            .unwrap();

        let raw = fs::read_to_string(store.path()).unwrap();

        assert!(raw.contains("\"version\": 1"));
        assert!(raw.contains("gateway.example.com"));
        for secret in ["password", "passphrase", "privateKey", "secret", "token"] {
            assert!(
                !raw.contains(secret),
                "unexpected {secret} in the store file"
            );
        }
    }

    #[test]
    fn writing_leaves_no_temporary_file_behind() {
        let dir = temp_dir("atomic");
        let mut store = FileStorage::open(&dir).unwrap();
        store
            .insert_profile(profile("p-1", "Edge gateway"))
            .unwrap();

        let temporary_files = fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                name.starts_with(".connections-") && name.ends_with(".tmp")
            })
            .count();
        assert_eq!(temporary_files, 0);
    }

    #[test]
    fn replacing_profiles_is_one_durable_operation() {
        let dir = temp_dir("replace");
        let mut store = FileStorage::open(&dir).unwrap();

        store
            .replace_profiles(vec![
                profile("p-1", "Edge gateway"),
                profile("p-2", "App node"),
            ])
            .unwrap();

        let reopened = FileStorage::open(&dir).unwrap();
        let names: Vec<String> = reopened
            .list_profiles()
            .unwrap()
            .into_iter()
            .map(|profile| profile.name)
            .collect();
        assert_eq!(names, vec!["App node", "Edge gateway"]);
    }

    #[test]
    fn failed_writes_leave_the_published_state_unchanged() {
        let dir = temp_dir("transaction-rollback");
        let mut store = FileStorage::open(&dir).unwrap();
        store
            .insert_profile(profile("p-1", "Edge gateway"))
            .unwrap();
        let before = store.list_profiles().unwrap();

        let blocked_target = dir.join("blocked-target");
        fs::create_dir(&blocked_target).unwrap();
        store.path = blocked_target;

        assert!(store.insert_profile(profile("p-2", "App node")).is_err());
        assert_eq!(store.list_profiles().unwrap(), before);

        assert!(store
            .update_profile(profile("p-1", "Renamed gateway"))
            .is_err());
        assert_eq!(store.list_profiles().unwrap(), before);

        assert!(store.delete_profile("p-1").is_err());
        assert_eq!(store.list_profiles().unwrap(), before);

        assert!(store
            .replace_profiles(vec![profile("p-3", "Replacement")])
            .is_err());
        assert_eq!(store.list_profiles().unwrap(), before);

        let temporary_files = fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(temporary_files, 0);
    }

    #[test]
    fn an_unreadable_file_is_set_aside_rather_than_lost() {
        let dir = temp_dir("corrupt");
        let path = dir.join(STORE_FILE);
        fs::write(&path, "{ this is not json").unwrap();

        let store = FileStorage::open(&dir).unwrap();
        let recovery = store.recovery().expect("recovery should be reported");

        assert!(recovery.reason.contains("could not be read"));
        assert!(store.list_profiles().unwrap().is_empty());
        // The original bytes are still on disk under the backup name.
        assert_eq!(
            fs::read_to_string(&recovery.backup_path).unwrap(),
            "{ this is not json"
        );
    }

    #[test]
    fn a_file_from_a_newer_version_is_set_aside_rather_than_misread() {
        let dir = temp_dir("newer");
        let path = dir.join(STORE_FILE);
        fs::write(&path, r#"{"version":99,"profiles":[]}"#).unwrap();

        let store = FileStorage::open(&dir).unwrap();
        let recovery = store.recovery().expect("recovery should be reported");

        assert!(recovery.reason.contains("newer version"));
        assert!(recovery.backup_path.exists());
    }

    #[test]
    fn a_second_rescue_does_not_overwrite_the_first() {
        let dir = temp_dir("twice");
        let path = dir.join(STORE_FILE);

        fs::write(&path, "first broken file").unwrap();
        let first = FileStorage::open(&dir).unwrap().recovery().unwrap().clone();

        fs::write(&path, "second broken file").unwrap();
        let second = FileStorage::open(&dir).unwrap().recovery().unwrap().clone();

        assert_ne!(first.backup_path, second.backup_path);
        assert_eq!(
            fs::read_to_string(&first.backup_path).unwrap(),
            "first broken file"
        );
        assert_eq!(
            fs::read_to_string(&second.backup_path).unwrap(),
            "second broken file"
        );
    }

    #[test]
    fn updating_a_missing_profile_is_reported_and_writes_nothing() {
        let dir = temp_dir("update-missing");
        let mut store = FileStorage::open(&dir).unwrap();

        let error = store.update_profile(profile("ghost", "Ghost")).unwrap_err();

        assert_eq!(error, StorageError::NotFound("ghost".to_string()));
        assert!(!store.path().exists());
    }
}
