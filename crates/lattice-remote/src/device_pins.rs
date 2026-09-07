//! Trust-on-first-use pinning of relay devices' Noise static keys.
//!
//! Only public-key fingerprints are stored. Writes are serialised across
//! cooperating desktop/CLI processes and atomically replace the old file, so
//! an interrupted first-use update cannot truncate the trust store.

use fs2::FileExt;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub const PINS_FILE: &str = "remote-device-pins.json";
const MAX_PINS_FILE_BYTES: u64 = 1024 * 1024;
const MAX_PINNED_DEVICES: usize = 4096;

#[derive(Debug, PartialEq, Eq)]
pub enum PinOutcome {
    FirstUse,
    Matched,
}

/// Reads existing trust without creating a file or trusting a presented key.
pub fn pinned_fingerprint(path: &Path, device_id: &str) -> Result<Option<String>, String> {
    let device_id =
        crate::relay::normalize_device_id(device_id).map_err(|error| error.to_string())?;
    Ok(load(path)?.remove(&device_id))
}

pub fn fingerprint(static_key: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(b"lattice-remote-device-key-v1:");
    digest.update(static_key);
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn reject_link(path: &Path, label: &str) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(format!("The {label} must not be a symbolic link."))
        }
        Ok(metadata) if !metadata.is_file() => Err(format!("The {label} must be a file.")),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("The {label} cannot be inspected: {error}")),
    }
}

fn validate(pins: &HashMap<String, String>) -> Result<(), String> {
    if pins.len() > MAX_PINNED_DEVICES {
        return Err("The pin file contains too many devices.".to_string());
    }
    for (device_id, print) in pins {
        crate::relay::normalize_device_id(device_id)
            .map_err(|_| "The pin file contains an invalid device ID.".to_string())?;
        if print.len() != 64
            || !print
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("The pin file contains an invalid fingerprint.".to_string());
        }
    }
    Ok(())
}

fn load(path: &Path) -> Result<HashMap<String, String>, String> {
    reject_link(path, "pin file")?;
    let file = match open_without_following_links(path, false) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(error) => return Err(format!("The pin file is unreadable: {error}")),
    };
    let metadata = file
        .metadata()
        .map_err(|error| format!("The pin file is unreadable: {error}"))?;
    if !metadata.is_file() || metadata.len() > MAX_PINS_FILE_BYTES {
        return Err("The pin file is not a regular bounded file.".to_string());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_PINS_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("The pin file is unreadable: {error}"))?;
    if bytes.len() as u64 > MAX_PINS_FILE_BYTES {
        return Err("The pin file is too large.".to_string());
    }
    let pins: HashMap<String, String> = serde_json::from_slice(&bytes)
        .map_err(|error| format!("The pin file is unreadable: {error}"))?;
    validate(&pins)?;
    Ok(pins)
}

fn open_without_following_links(path: &Path, create: bool) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(create).create(create);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
        if create {
            options.mode(0o600);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    options.open(path)
}

fn lock_path(path: &Path) -> Result<PathBuf, String> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "The pin file path has no valid file name.".to_string())?;
    Ok(path.with_file_name(format!(".{name}.lock")))
}

fn open_lock(path: &Path) -> Result<File, String> {
    reject_link(path, "pin lock file")?;
    let file = open_without_following_links(path, true)
        .map_err(|error| format!("The pin lock file cannot be opened: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("The pin lock file cannot be inspected: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("The pin lock file must be a regular file, not a link.".to_string());
    }
    file.lock_exclusive()
        .map_err(|error| format!("The pin file cannot be locked: {error}"))?;
    Ok(file)
}

fn save(path: &Path, pins: &HashMap<String, String>) -> Result<(), String> {
    validate(pins)?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("The pin folder cannot be created: {error}"))?;
    reject_link(path, "pin file")?;

    let mut staged = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("A private pin staging file cannot be created: {error}"))?;
    serde_json::to_writer_pretty(staged.as_file_mut(), pins)
        .map_err(|error| format!("The pin file cannot be encoded: {error}"))?;
    staged
        .as_file_mut()
        .write_all(b"\n")
        .and_then(|()| staged.as_file_mut().flush())
        .and_then(|()| staged.as_file().sync_all())
        .map_err(|error| format!("The pin file cannot be flushed: {error}"))?;
    staged.persist(path).map_err(|error| {
        format!(
            "The pin file cannot be replaced atomically: {}",
            error.error
        )
    })?;
    Ok(())
}

/// Verifies or records the permanent key presented by a relay device.
///
/// Call this only after the encrypted Hello proves that the peer accepted the
/// pairing code. The lock covers the read/compare/write transaction so a GUI
/// and CLI connecting concurrently cannot overwrite each other's first-use
/// decisions.
pub fn verify_or_pin(
    path: &Path,
    device_id: &str,
    static_key: &[u8],
) -> Result<PinOutcome, String> {
    let device_id =
        crate::relay::normalize_device_id(device_id).map_err(|error| error.to_string())?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("The pin folder cannot be created: {error}"))?;
    let lock = open_lock(&lock_path(path)?)?;
    let result = (|| {
        let mut pins = load(path)?;
        let presented = fingerprint(static_key);
        match pins.get(&device_id) {
            Some(pinned) if *pinned == presented => Ok(PinOutcome::Matched),
            Some(_) => Err(format!(
                "Device {device_id} presented a different identity key than it did before. \
If the device was reinstalled this is expected once — remove its entry from \
{PINS_FILE} in the app data folder and connect again. Otherwise someone may be \
impersonating it; do not enter the pairing code anywhere else."
            )),
            None => {
                if pins.len() >= MAX_PINNED_DEVICES {
                    return Err("The pin file cannot accept more devices.".to_string());
                }
                pins.insert(device_id, presented);
                save(path, &pins)?;
                Ok(PinOutcome::FirstUse)
            }
        }
    })();
    let _ = lock.unlock();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_file(name: &str) -> (tempfile::TempDir, PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(name);
        (directory, path)
    }

    #[test]
    fn first_use_pins_and_matching_key_passes() {
        let (_directory, path) = scratch_file("pins-a.json");
        assert_eq!(
            verify_or_pin(&path, "123456789", b"key-one").unwrap(),
            PinOutcome::FirstUse
        );
        assert_eq!(
            verify_or_pin(&path, "123456789", b"key-one").unwrap(),
            PinOutcome::Matched
        );
    }

    #[test]
    fn lookup_requires_existing_valid_trust_without_writing() {
        let (_directory, path) = scratch_file("existing-pins.json");
        assert_eq!(pinned_fingerprint(&path, "123456789").unwrap(), None);
        assert!(!path.exists());
        assert!(!lock_path(&path).unwrap().exists());
        verify_or_pin(&path, "123456789", b"known-key").unwrap();
        let before = std::fs::read(&path).unwrap();
        assert_eq!(
            pinned_fingerprint(&path, "123 456 789").unwrap(),
            Some(fingerprint(b"known-key"))
        );
        assert_eq!(pinned_fingerprint(&path, "987654321").unwrap(), None);
        assert_eq!(std::fs::read(&path).unwrap(), before);
        std::fs::write(&path, b"invalid").unwrap();
        assert!(pinned_fingerprint(&path, "123456789").is_err());
    }

    #[test]
    fn a_changed_key_is_rejected_without_replacing_the_pin() {
        let (_directory, path) = scratch_file("pins-b.json");
        verify_or_pin(&path, "123456789", b"key-one").unwrap();
        let error = verify_or_pin(&path, "123456789", b"key-two").unwrap_err();
        assert!(error.contains("different identity key"));
        assert_eq!(
            verify_or_pin(&path, "123456789", b"key-one").unwrap(),
            PinOutcome::Matched
        );
    }

    #[test]
    fn devices_are_pinned_independently() {
        let (_directory, path) = scratch_file("pins-c.json");
        verify_or_pin(&path, "111111111", b"key-one").unwrap();
        assert_eq!(
            verify_or_pin(&path, "222222222", b"key-two").unwrap(),
            PinOutcome::FirstUse
        );
    }

    #[test]
    fn fingerprints_hide_the_key_and_stay_stable() {
        let print = fingerprint(b"some-public-key");
        assert_eq!(print, fingerprint(b"some-public-key"));
        assert_ne!(print, fingerprint(b"other-public-key"));
        assert_eq!(print.len(), 64);
    }

    #[test]
    fn rejects_invalid_or_oversized_pin_files() {
        let (_directory, path) = scratch_file("pins-invalid.json");
        std::fs::write(&path, br#"{"bad":"fingerprint"}"#).unwrap();
        assert!(verify_or_pin(&path, "123456789", b"key")
            .unwrap_err()
            .contains("invalid device ID"));

        std::fs::write(&path, vec![b' '; (MAX_PINS_FILE_BYTES + 1) as usize]).unwrap();
        assert!(verify_or_pin(&path, "123456789", b"key")
            .unwrap_err()
            .contains("bounded"));
    }
}
