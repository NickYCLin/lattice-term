//! Saved SSH connections whose AI-written commands run without the card.
//!
//! The person chooses this from the approval card itself, one saved
//! connection at a time, and can take it back in Settings. It is keyed by the
//! saved profile, so reconnecting or restarting the app keeps the choice,
//! while a different connection to the same host still asks.
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

#[derive(Debug, Serialize, Deserialize)]
struct StoreFile {
    version: u32,
    #[serde(default)]
    profiles: BTreeMap<String, String>,
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
}

impl CommandTrustSetting {
    pub fn open(dir: &Path) -> Self {
        let path = dir.join(STORE_FILE);
        let profiles = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<StoreFile>(&raw).ok())
            .filter(|file| file.version == STORE_VERSION)
            .map(|file| file.profiles)
            .unwrap_or_default()
            .into_iter()
            .filter(|(id, _)| valid_profile_id(id))
            .take(MAX_TRUSTED)
            .collect();
        Self { path, profiles }
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
            return Err("The saved connection ID is invalid.".to_string());
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
        self.save(next)
    }

    pub fn revoke(&mut self, profile_id: &str) -> Result<(), String> {
        if !self.profiles.contains_key(profile_id) {
            return Ok(());
        }
        let mut next = self.profiles.clone();
        next.remove(profile_id);
        self.save(next)
    }

    /// The file is written first; memory only follows a successful write, so
    /// what the card skips always matches what the next launch will read.
    fn save(&mut self, profiles: BTreeMap<String, String>) -> Result<(), String> {
        let encoded = serde_json::to_vec_pretty(&StoreFile {
            version: STORE_VERSION,
            profiles: profiles.clone(),
        })
        .map_err(|error| error.to_string())?;
        crate::durable_file::atomic_write_private(&self.path, &encoded)
            .map_err(|error| error.to_string())?;
        self.profiles = profiles;
        Ok(())
    }
}

fn valid_profile_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && !id.chars().any(char::is_control)
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
    fn rejects_an_invalid_profile_id() {
        let dir = tempfile::tempdir().unwrap();
        let mut setting = CommandTrustSetting::open(dir.path());
        assert!(setting.allow("", "x").is_err());
        assert!(setting.allow("bad\nid", "x").is_err());
        assert!(setting.profile_ids().is_empty());
    }
}
