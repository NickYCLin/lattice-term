//! Device-local, process-shared online guessing budget. Reserve before any
//! password proof is sent; a crash/timeout counts as a failed attempt. Neither
//! passwords nor password hashes are stored. Restarting cannot reset the budget.

use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const WINDOW_SECONDS: u64 = 600;
const MAX_ATTEMPTS: usize = 5;
const MAX_BYTES: u64 = 2048;
const LIMIT_MESSAGE: &str =
    "Pairing is temporarily locked after five attempts; wait ten minutes before trying again.";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Attempt {
    at: u64,
    ticket: u64,
}

pub struct PairingPermit {
    path: PathBuf,
    ticket: u64,
}

fn now() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_secs())
        .map_err(|_| "The system clock is invalid.".into())
}

fn is_link(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    metadata.file_type().is_symlink()
}

fn check_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err("Pairing state needs an absolute path without traversal.".into());
    }
    let mut ancestor = PathBuf::new();
    for component in path.components() {
        if let Component::Prefix(prefix) = component {
            use std::path::Prefix;
            if !matches!(
                prefix.kind(),
                Prefix::Disk(_)
                    | Prefix::VerbatimDisk(_)
                    | Prefix::UNC(_, _)
                    | Prefix::VerbatimUNC(_, _)
            ) {
                return Err("Pairing state must not use a device namespace.".into());
            }
            // `\\?\C:` is not a path that Win32 metadata APIs can inspect;
            // wait for RootDir so both normal and canonical paths are checked.
            ancestor.push(component);
            continue;
        }
        if let Component::Normal(name) = component {
            let name = name.to_string_lossy();
            if name.contains(':') || name.ends_with(['.', ' ']) {
                return Err("Unsafe pairing state path.".into());
            }
        }
        ancestor.push(component);
        match std::fs::symlink_metadata(&ancestor) {
            Ok(metadata) if is_link(&metadata) => {
                return Err("Pairing state must not use links or junctions.".into())
            }
            Ok(metadata) if ancestor != path && !metadata.is_dir() => {
                return Err("Invalid pairing state folder.".into())
            }
            Ok(metadata) if ancestor == path && !metadata.is_file() => {
                return Err("Pairing state must be a regular file.".into())
            }
            Ok(_) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(format!("Cannot inspect pairing state: {error}")),
        }
    }
    Ok(())
}

fn open(path: &Path, create: bool) -> Result<File, String> {
    check_path(path)?;
    let mut options = OpenOptions::new();
    options.read(true).write(create).create(create);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW).mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000);
    }
    let file = options
        .open(path)
        .map_err(|error| format!("Cannot open pairing state: {error}"))?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if is_link(&metadata) || !metadata.is_file() {
        return Err("Unsafe pairing state file.".into());
    }
    Ok(file)
}

fn read(path: &Path) -> Result<Option<Vec<u8>>, String> {
    check_path(path)?;
    if !path.try_exists().map_err(|error| error.to_string())? {
        return Ok(None);
    }
    let file = open(path, false)?;
    if file.metadata().map_err(|error| error.to_string())?.len() > MAX_BYTES {
        return Err("Pairing state is too large.".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Pairing state is too large.".into());
    }
    Ok(Some(bytes))
}

fn update(
    path: &Path,
    change: impl FnOnce(&mut Vec<Attempt>) -> Result<(), String>,
) -> Result<(), String> {
    check_path(path)?;
    let parent = path.parent().ok_or("Missing pairing state folder.")?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    check_path(path)?;
    let lock_path = path.with_extension("lock");
    let lock = open(&lock_path, true)?;
    lock.lock_exclusive().map_err(|error| error.to_string())?;
    let original = read(path)?;
    let mut attempts: Vec<Attempt> = match &original {
        Some(bytes) => serde_json::from_slice(bytes)
            .map_err(|_| "Pairing state is invalid; refusing to reset its budget.")?,
        None => Vec::new(),
    };
    if attempts.len() > MAX_ATTEMPTS {
        return Err("Pairing state contains too many attempts.".into());
    }
    change(&mut attempts)?;
    let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    serde_json::to_writer(staged.as_file_mut(), &attempts).map_err(|error| error.to_string())?;
    staged
        .flush()
        .and_then(|()| staged.as_file().sync_all())
        .map_err(|error| error.to_string())?;
    if read(path)? != original {
        return Err("Pairing state changed outside this process; nothing was overwritten.".into());
    }
    if original.is_none() {
        staged
            .persist_noclobber(path)
            .map_err(|error| error.to_string())?;
    } else {
        staged.persist(path).map_err(|error| error.to_string())?;
    }
    #[cfg(unix)]
    File::open(parent)
        .and_then(|file| file.sync_all())
        .map_err(|error| error.to_string())?;
    Ok(())
}

impl PairingPermit {
    pub fn reserve(path: &Path) -> Result<Self, String> {
        Self::reserve_at(path, now()?)
    }

    fn reserve_at(path: &Path, now: u64) -> Result<Self, String> {
        let mut random = [0u8; 8];
        getrandom::fill(&mut random).map_err(|_| "Pairing randomness unavailable.")?;
        let ticket = u64::from_le_bytes(random);
        update(path, |attempts| {
            // Future timestamps remain charged if the clock moves backwards.
            attempts.retain(|attempt| now.saturating_sub(attempt.at) < WINDOW_SECONDS);
            if attempts.len() >= MAX_ATTEMPTS {
                return Err(LIMIT_MESSAGE.into());
            }
            attempts.push(Attempt { at: now, ticket });
            Ok(())
        })?;
        Ok(Self {
            path: path.to_owned(),
            ticket,
        })
    }

    /// Only after authenticated pairing. Do not clear other processes' failures.
    pub fn authenticated(self) -> Result<(), String> {
        update(&self.path, |attempts| {
            attempts.retain(|attempt| attempt.ticket != self.ticket);
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crashes_restarts_and_clock_rollback_do_not_reset_budget() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().canonicalize().unwrap().join("attempts.json");
        for _ in 0..5 {
            PairingPermit::reserve_at(&path, 1000).unwrap();
        }
        assert!(PairingPermit::reserve_at(&path, 1000).is_err());
        assert!(PairingPermit::reserve_at(&path, 500).is_err());
        assert!(PairingPermit::reserve_at(&path, 1599).is_err());
        assert!(PairingPermit::reserve_at(&path, 1600).is_ok());
    }

    #[test]
    fn success_only_refunds_its_own_attempt() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().canonicalize().unwrap().join("attempts.json");
        let permit = PairingPermit::reserve_at(&path, 1000).unwrap();
        for _ in 0..4 {
            PairingPermit::reserve_at(&path, 1000).unwrap();
        }
        permit.authenticated().unwrap();
        PairingPermit::reserve_at(&path, 1000).unwrap();
        assert!(PairingPermit::reserve_at(&path, 1000).is_err());
    }

    #[test]
    fn corrupt_state_fails_closed_without_overwriting() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().canonicalize().unwrap().join("attempts.json");
        std::fs::write(&path, b"interrupted").unwrap();
        assert!(PairingPermit::reserve_at(&path, 1000).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"interrupted");
        assert!(PairingPermit::reserve_at(&dir.path().join("../escape.json"), 1000).is_err());
        let oversized = dir.path().canonicalize().unwrap().join("oversized.json");
        std::fs::write(&oversized, vec![b' '; MAX_BYTES as usize + 1]).unwrap();
        assert!(PairingPermit::reserve_at(&oversized, 1000).is_err());
        assert_eq!(std::fs::metadata(&oversized).unwrap().len(), MAX_BYTES + 1);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_files_and_parent_folders_without_external_writes() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let target = base.join("original.json");
        std::fs::write(&target, b"[]").unwrap();
        let alias = base.join("alias.json");
        symlink(&target, &alias).unwrap();
        assert!(PairingPermit::reserve_at(&alias, 1000).is_err());
        let folder_alias = base.join("alias-folder");
        symlink(&base, &folder_alias).unwrap();
        assert!(PairingPermit::reserve_at(&folder_alias.join("new.json"), 1000).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"[]");
        assert!(!base.join("new.json").exists());
    }

    #[test]
    fn concurrent_process_style_reservations_share_one_budget() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().canonicalize().unwrap().join("attempts.json");
        let threads: Vec<_> = (0..12)
            .map(|_| {
                let path = path.clone();
                std::thread::spawn(move || PairingPermit::reserve_at(&path, 1000).is_ok())
            })
            .collect();
        assert_eq!(
            threads
                .into_iter()
                .map(|thread| thread.join().unwrap())
                .filter(|accepted| *accepted)
                .count(),
            5
        );
    }
}
