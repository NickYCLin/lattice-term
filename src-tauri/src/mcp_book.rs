//! Whether external MCP clients may read the saved connection book.
//!
//! A switch, not a grant. It decides only whether the names of the places
//! this person works can be listed at all; reading the book never opens a
//! session and never reports a host, port, account or credential. The flag is
//! therefore plain non-secret state and lives beside the other application
//! files rather than in the credential backend.
//!
//! On by default, matching how a connection the person opened is already
//! offered without asking again. Separate endpoint-bound credential grants
//! default to denied and never include the credential itself.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
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
    #[serde(default)]
    credential_bindings: BTreeMap<String, String>,
}

#[derive(Debug)]
pub struct ConnectionBookSetting {
    path: PathBuf,
    shared: bool,
    credential_bindings: BTreeMap<String, String>,
    observed: Option<Vec<u8>>,
    writable: bool,
}

impl ConnectionBookSetting {
    /// A missing, unreadable, damaged or newer file all read as the default.
    /// Only a file this build understands can turn the book off, so a
    /// damaged one never silently changes what the window reports.
    pub fn open(dir: &Path) -> Self {
        let path = dir.join(STORE_FILE);
        let observed = fs::read(&path).ok();
        let file = observed
            .as_deref()
            .and_then(|raw| serde_json::from_slice::<StoreFile>(raw).ok())
            .filter(|file| file.version <= STORE_VERSION);
        let writable = observed.is_none() || file.is_some();
        Self {
            path,
            shared: file.as_ref().map_or(DEFAULT_SHARED, |file| file.shared),
            credential_bindings: file.map_or_else(BTreeMap::new, |file| file.credential_bindings),
            observed,
            writable,
        }
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
            credential_bindings: self.credential_bindings.clone(),
        })
        .map_err(|error| error.to_string())?;
        self.persist(&encoded)?;
        self.shared = shared;
        Ok(())
    }

    pub fn credential_allowed(&self, profile_id: &str, binding: &str) -> bool {
        self.credential_bindings
            .get(profile_id)
            .is_some_and(|saved| saved == binding)
            && fs::symlink_metadata(&self.path)
                .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
            && fs::read(&self.path).ok().as_ref() == self.observed.as_ref()
    }

    pub fn share_credential(
        &mut self,
        profile_id: &str,
        binding: Option<&str>,
    ) -> Result<(), String> {
        let mut credential_bindings = self.credential_bindings.clone();
        if let Some(binding) = binding {
            credential_bindings.insert(profile_id.to_string(), binding.to_string());
        } else {
            credential_bindings.remove(profile_id);
        }
        if binding.is_none() && credential_bindings == self.credential_bindings {
            return Ok(());
        }
        let encoded = serde_json::to_vec_pretty(&StoreFile {
            version: STORE_VERSION,
            shared: self.shared,
            credential_bindings: credential_bindings.clone(),
        })
        .map_err(|error| error.to_string())?;
        self.persist(&encoded)?;
        self.credential_bindings = credential_bindings;
        Ok(())
    }

    fn persist(&mut self, encoded: &[u8]) -> Result<(), String> {
        if !self.writable {
            return Err("The connection-book settings are damaged or newer than this build. Restore them before changing access.".into());
        }
        match fs::symlink_metadata(&self.path) {
            Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => {
                return Err("The connection-book settings must be a regular file.".into());
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                return Err(error.to_string())
            }
            _ => {}
        }
        let current = match fs::read(&self.path) {
            Ok(raw) => Some(raw),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.to_string()),
        };
        if current != self.observed {
            return Err("The connection-book settings changed outside this window. Reopen LatticeTerm before changing access.".into());
        }
        match crate::durable_file::atomic_write_private(&self.path, encoded) {
            Ok(()) => {
                self.observed = Some(encoded.to_vec());
                Ok(())
            }
            Err(error) => {
                if error.replacement_visible() {
                    self.observed = Some(encoded.to_vec());
                }
                Err(error.to_string())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_access_is_opt_in_bound_and_revocable() {
        let dir = tempfile::tempdir().unwrap();
        let mut setting = ConnectionBookSetting::open(dir.path());
        assert!(!setting.credential_allowed("profile", "endpoint"));
        setting
            .share_credential("profile", Some("endpoint"))
            .unwrap();
        setting = ConnectionBookSetting::open(dir.path());
        assert!(setting.credential_allowed("profile", "endpoint"));
        assert!(!setting.credential_allowed("profile", "other-endpoint"));
        assert!(!setting.credential_allowed("other-profile", "endpoint"));
        setting.set(false).unwrap();
        setting.set(true).unwrap();
        assert!(setting.credential_allowed("profile", "endpoint"));
        setting.share_credential("profile", None).unwrap();
        assert!(!ConnectionBookSetting::open(dir.path()).credential_allowed("profile", "endpoint"));
    }

    #[test]
    fn old_damaged_and_newer_settings_do_not_authorize_credential_reads() {
        let dir = tempfile::tempdir().unwrap();
        for raw in [
            r#"{"version":1,"shared":true}"#,
            "{ broken",
            r#"{"version":99,"shared":true,"credential_bindings":{"profile":"endpoint"}}"#,
        ] {
            fs::write(dir.path().join(STORE_FILE), raw).unwrap();
            assert!(
                !ConnectionBookSetting::open(dir.path()).credential_allowed("profile", "endpoint")
            );
        }
    }

    #[test]
    fn failed_credential_grant_write_keeps_the_previous_choice() {
        let dir = tempfile::tempdir().unwrap();
        let mut setting = ConnectionBookSetting::open(dir.path());
        fs::create_dir(dir.path().join(STORE_FILE)).unwrap();
        assert!(setting
            .share_credential("profile", Some("endpoint"))
            .is_err());
        assert!(!setting.credential_allowed("profile", "endpoint"));
    }

    #[test]
    fn credential_changes_preserve_external_settings_and_reject_damaged_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(STORE_FILE);
        let mut setting = ConnectionBookSetting::open(dir.path());
        let external = br#"{"version":1,"shared":false}"#;
        fs::write(&path, external).unwrap();
        assert!(setting
            .share_credential("profile", Some("endpoint"))
            .is_err());
        assert_eq!(fs::read(&path).unwrap(), external);
        fs::write(&path, b"{ broken").unwrap();
        let mut damaged = ConnectionBookSetting::open(dir.path());
        assert!(damaged
            .share_credential("profile", Some("endpoint"))
            .is_err());
        assert_eq!(fs::read(&path).unwrap(), b"{ broken");
    }

    #[test]
    fn externally_changed_grants_stop_credential_reads_until_reloaded() {
        let dir = tempfile::tempdir().unwrap();
        let mut setting = ConnectionBookSetting::open(dir.path());
        setting
            .share_credential("profile", Some("endpoint"))
            .unwrap();
        assert!(setting.credential_allowed("profile", "endpoint"));
        fs::write(
            dir.path().join(STORE_FILE),
            br#"{"version":1,"shared":false}"#,
        )
        .unwrap();
        assert!(!setting.credential_allowed("profile", "endpoint"));
    }

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
