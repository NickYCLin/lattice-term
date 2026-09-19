//! Where cmd scripts live, and clearing the ones a crashed host left behind.
//!
//! A cmd command runs from a temporary `.cmd` file that is deleted when the
//! run ends. If the host process dies first, nothing deletes it. Scripts go
//! into one directory of their own so the next host can find those leftovers
//! by name alone, and anything older than the longest possible run is
//! removed before the first new script is written.
#![cfg_attr(not(windows), allow(dead_code))]

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub(super) const PREFIX: &str = "lattice-command-";
pub(super) const SUFFIX: &str = ".cmd";

/// Longer than any run can last (300 s limit plus startup), so a script that
/// another live host is still running is never mistaken for a leftover.
pub(super) const STALE_AFTER: Duration = Duration::from_secs(15 * 60);

pub(super) fn directory() -> PathBuf {
    std::env::temp_dir().join("lattice-remote-commands")
}

/// Removes scripts in `directory` older than `stale_after`, returning how
/// many went. Only regular files named like our scripts are touched; a
/// link, a folder, or someone else's file is left where it is.
pub(super) fn sweep(directory: &Path, now: SystemTime, stale_after: Duration) -> usize {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !name.starts_with(PREFIX) || !name.ends_with(SUFFIX) {
            continue;
        }
        let Ok(metadata) = std::fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if !metadata.file_type().is_file() {
            continue;
        }
        let stale = metadata
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= stale_after);
        if stale && std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_old_scripts_with_our_name_are_removed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        std::fs::write(path.join("lattice-command-old.cmd"), "echo").unwrap();
        std::fs::write(path.join("unrelated.cmd"), "echo").unwrap();
        std::fs::write(path.join("lattice-command-notes.txt"), "keep").unwrap();
        std::fs::create_dir(path.join("lattice-command-dir.cmd")).unwrap();

        let later = SystemTime::now() + Duration::from_secs(60 * 60);
        assert_eq!(sweep(path, later, STALE_AFTER), 1);
        assert!(!path.join("lattice-command-old.cmd").exists());
        assert!(path.join("unrelated.cmd").exists());
        assert!(path.join("lattice-command-notes.txt").exists());
        assert!(path.join("lattice-command-dir.cmd").is_dir());
    }

    #[test]
    fn a_script_that_may_still_be_running_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("lattice-command-live.cmd");
        std::fs::write(&script, "echo").unwrap();
        assert_eq!(sweep(dir.path(), SystemTime::now(), STALE_AFTER), 0);
        assert!(script.exists());
    }

    #[test]
    fn a_missing_directory_is_nothing_to_do() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            sweep(&dir.path().join("absent"), SystemTime::now(), STALE_AFTER),
            0
        );
    }
}
