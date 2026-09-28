//! SSH connections whose AI-written commands run without the card.
//!
//! The person chooses this from the approval card itself, one connection at a
//! time, or for every SSH connection at once in Settings, and can take either
//! back there. A connection opened from the saved book is keyed by its
//! profile; one typed in by hand is keyed by `ssh:account@host:port`, so
//! reconnecting or restarting the app keeps the choice either way.
//!
//! Anything this build cannot read — a missing, damaged or newer file — means
//! nothing is trusted: a broken file must never skip the card on its own.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const STORE_VERSION: u32 = 1;
const STORE_FILE: &str = "mcp-command-trust.json";
/// Plenty for a person's own machines, and a bound on what one file holds.
const MAX_TRUSTED: usize = 256;
const MAX_LABEL_CHARS: usize = 200;
const MAX_KEY_CHARS: usize = 320;

#[derive(Debug, Serialize, Deserialize)]
struct StoreFile {
    version: u32,
    #[serde(default)]
    profiles: BTreeMap<String, String>,
    #[serde(default)]
    allow_all: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrustedCommandConnection {
    pub profile_id: String,
    pub label: String,
}

#[derive(Debug)]
pub struct CommandTrustSetting {
    path: PathBuf,
    profiles: BTreeMap<String, String>,
    allow_all: bool,
}

impl CommandTrustSetting {
    pub fn open(dir: &Path) -> Self {
        let path = dir.join(STORE_FILE);
        let file = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<StoreFile>(&raw).ok())
            .filter(|file| file.version == STORE_VERSION);
        let allow_all = file.as_ref().is_some_and(|file| file.allow_all);
        let profiles = file
            .map(|file| file.profiles)
            .unwrap_or_default()
            .into_iter()
            .filter(|(id, _)| valid_profile_id(id))
            .take(MAX_TRUSTED)
            .collect();
        Self {
            path,
            profiles,
            allow_all,
        }
    }

    pub fn allows_all(&self) -> bool {
        self.allow_all
    }

    pub fn set_allow_all(&mut self, allow_all: bool) -> Result<(), String> {
        if self.allow_all == allow_all {
            return Ok(());
        }
        self.save(self.profiles.clone(), allow_all)
    }

    pub fn profile_ids(&self) -> Vec<String> {
        self.profiles.keys().cloned().collect()
    }

    pub fn list(&self) -> Vec<TrustedCommandConnection> {
        self.profiles
            .iter()
            .map(|(profile_id, label)| TrustedCommandConnection {
                profile_id: profile_id.clone(),
                label: label.clone(),
            })
            .collect()
    }

    pub fn allow(&mut self, profile_id: &str, label: &str) -> Result<(), String> {
        if !valid_profile_id(profile_id) {
            return Err("The connection ID is invalid.".to_string());
        }
        if !self.profiles.contains_key(profile_id) && self.profiles.len() >= MAX_TRUSTED {
            return Err("Too many connections are already allowed without asking.".to_string());
        }
        let label: String = label
            .chars()
            .filter(|character| !character.is_control())
            .take(MAX_LABEL_CHARS)
            .collect();
        let mut next = self.profiles.clone();
        next.insert(profile_id.to_string(), label);
        self.save(next, self.allow_all)
    }

    pub fn revoke(&mut self, profile_id: &str) -> Result<(), String> {
        if !self.profiles.contains_key(profile_id) {
            return Ok(());
        }
        let mut next = self.profiles.clone();
        next.remove(profile_id);
        self.save(next, self.allow_all)
    }

    /// The file is written first; memory only follows a successful write, so
    /// what the card skips always matches what the next launch will read.
    fn save(&mut self, profiles: BTreeMap<String, String>, allow_all: bool) -> Result<(), String> {
        let encoded = serde_json::to_vec_pretty(&StoreFile {
            version: STORE_VERSION,
            profiles: profiles.clone(),
            allow_all,
        })
        .map_err(|error| error.to_string())?;
        crate::durable_file::atomic_write_private(&self.path, &encoded)
            .map_err(|error| error.to_string())?;
        self.profiles = profiles;
        self.allow_all = allow_all;
        Ok(())
    }
}

fn valid_profile_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_KEY_CHARS && !id.chars().any(char::is_control)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remembers_allowed_connections_across_launches_and_forgets_revoked_ones() {
        let dir = tempfile::tempdir().unwrap();
        let mut setting = CommandTrustSetting::open(dir.path());
        assert!(setting.profile_ids().is_empty());
        setting.allow("mac", "Mac mini\n").unwrap();
        let reopened = CommandTrustSetting::open(dir.path());
        assert_eq!(
            reopened.list(),
            vec![TrustedCommandConnection {
                profile_id: "mac".to_string(),
                label: "Mac mini".to_string(),
            }]
        );
        setting.revoke("mac").unwrap();
        assert!(CommandTrustSetting::open(dir.path())
            .profile_ids()
            .is_empty());
    }

    #[test]
    fn a_damaged_or_newer_file_trusts_nothing() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(STORE_FILE), b"{ not json").unwrap();
        assert!(CommandTrustSetting::open(dir.path())
            .profile_ids()
            .is_empty());
        fs::write(
            dir.path().join(STORE_FILE),
            br#"{"version":2,"profiles":{"mac":"Mac"}}"#,
        )
        .unwrap();
        assert!(CommandTrustSetting::open(dir.path())
            .profile_ids()
            .is_empty());
    }

    #[test]
    fn allow_all_survives_a_restart_and_keeps_single_connections() {
        let dir = tempfile::tempdir().unwrap();
        let mut setting = CommandTrustSetting::open(dir.path());
        assert!(!setting.allows_all());
        setting.allow("ssh:me@mac:22", "mac").unwrap();
        setting.set_allow_all(true).unwrap();
        let reopened = CommandTrustSetting::open(dir.path());
        assert!(reopened.allows_all());
        assert_eq!(reopened.profile_ids(), vec!["ssh:me@mac:22".to_string()]);
        setting.set_allow_all(false).unwrap();
        assert!(!CommandTrustSetting::open(dir.path()).allows_all());
    }

    #[test]
    fn a_file_from_the_previous_release_still_loads() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join(STORE_FILE),
            br#"{"version":1,"profiles":{"mac":"Mac"}}"#,
        )
        .unwrap();
        let setting = CommandTrustSetting::open(dir.path());
        assert!(!setting.allows_all());
        assert_eq!(setting.profile_ids(), vec!["mac".to_string()]);
    }

    #[test]
    fn rejects_an_invalid_profile_id() {
        let dir = tempfile::tempdir().unwrap();
        let mut setting = CommandTrustSetting::open(dir.path());
        assert!(setting.allow("", "x").is_err());
        assert!(setting.allow("bad\nid", "x").is_err());
        assert!(setting.profile_ids().is_empty());
    }
}
