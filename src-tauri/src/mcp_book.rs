//! Whether external MCP clients may read the saved connection book.
//!
//! A switch, not a grant. It decides only whether the names of the places
//! this person works can be listed at all; reading the book never opens a
//! session and never reports a host, port, account or credential. The flag is
//! therefore plain non-secret state and lives beside the other application
//! files rather than in the credential backend.
//!
//! On by default, matching how a connection the person opened is already
//! offered without asking again. What the file records is the decision to
//! turn it off; nothing else here is worth persisting.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const STORE_VERSION: u32 = 1;
const STORE_FILE: &str = "mcp-connection-book.json";
const DEFAULT_SHARED: bool = true;

fn default_shared() -> bool {
    DEFAULT_SHARED
}

#[derive(Debug, Serialize, Deserialize)]
struct StoreFile {
    version: u32,
    #[serde(default = "default_shared")]
    shared: bool,
}

#[derive(Debug)]
pub struct ConnectionBookSetting {
    path: PathBuf,
    shared: bool,
}

impl ConnectionBookSetting {
    /// A missing, unreadable, damaged or newer file all read as the default.
    /// Only a file this build understands can turn the book off, so a
    /// damaged one never silently changes what the window reports.
    pub fn open(dir: &Path) -> Self {
        let path = dir.join(STORE_FILE);
        let shared = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<StoreFile>(&raw).ok())
            .filter(|file| file.version <= STORE_VERSION)
            .map_or(DEFAULT_SHARED, |file| file.shared);
        Self { path, shared }
    }

    pub fn shared(&self) -> bool {
        self.shared
    }

    /// Keeps the in-memory answer and the file in step: a write that fails
    /// leaves the previous choice in force rather than a silent upgrade.
    pub fn set(&mut self, shared: bool) -> Result<(), String> {
        if shared == self.shared {
            return Ok(());
        }
        let encoded = serde_json::to_vec_pretty(&StoreFile {
            version: STORE_VERSION,
            shared,
        })
        .map_err(|error| error.to_string())?;
        crate::durable_file::atomic_write_private(&self.path, &encoded)
            .map_err(|error| error.to_string())?;
        self.shared = shared;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_shared_and_remembers_being_turned_off() {
        let dir = tempfile::tempdir().unwrap();
        let mut setting = ConnectionBookSetting::open(dir.path());
        assert!(setting.shared());
        setting.set(false).unwrap();
        assert!(!ConnectionBookSetting::open(dir.path()).shared());
        setting.set(true).unwrap();
        assert!(ConnectionBookSetting::open(dir.path()).shared());
    }

    #[test]
    fn damaged_state_reads_as_the_default() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(STORE_FILE), b"{ not json").unwrap();
        assert!(ConnectionBookSetting::open(dir.path()).shared());
    }

    #[test]
    fn a_newer_file_reads_as_the_default() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join(STORE_FILE),
            br#"{"version":99,"shared":true}"#,
        )
        .unwrap();
        assert!(ConnectionBookSetting::open(dir.path()).shared());
    }
}
