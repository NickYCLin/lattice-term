//! Bounded readers for Lattice Remote pairing-code sources.
//!
//! Pairing codes are secrets. Long-running services and automated clients read
//! them from an owner-only regular file so the value never appears in process
//! arguments, logs, or shell history.

use crate::normalize_pairing_code;
use std::fs::OpenOptions;
use std::io::Read;
use std::path::Path;
use zeroize::Zeroizing;

const MAX_PAIR_CODE_SOURCE_BYTES: u64 = 64;

/// Reads and validates one pairing code from a regular, bounded file.
///
/// Unix files must be inaccessible to group and other users. Links are
/// rejected on every platform so replacing a configured credential path does
/// not silently redirect the reader elsewhere.
pub fn read_pairing_code_file(path: &Path) -> Result<String, String> {
    let input = read_private_code_file(path)?;
    normalize_pairing_code(&input).map_err(|error| error.to_string())
}

/// Viewer-only reader; legacy codes still require a trusted device at pairing.
pub fn read_viewer_pairing_code_file(path: &Path) -> Result<String, String> {
    let input = read_private_code_file(path)?;
    crate::normalize_viewer_pairing_code(&input).map_err(|error| error.to_string())
}

fn read_private_code_file(path: &Path) -> Result<Zeroizing<String>, String> {
    let path_metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("cannot inspect --pair-code-file: {error}"))?;
    if path_metadata.file_type().is_symlink() || !path_metadata.is_file() {
        return Err("--pair-code-file must be a regular file, not a link".to_string());
    }

    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options
        .open(path)
        .map_err(|error| format!("cannot safely read --pair-code-file: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("cannot inspect --pair-code-file: {error}"))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_PAIR_CODE_SOURCE_BYTES
    {
        return Err(format!(
            "--pair-code-file must be a regular file of at most {MAX_PAIR_CODE_SOURCE_BYTES} bytes"
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(
                "--pair-code-file must not be accessible by group or other users".to_string(),
            );
        }
    }

    let mut input = Zeroizing::new(String::new());
    file.take(MAX_PAIR_CODE_SOURCE_BYTES + 1)
        .read_to_string(&mut input)
        .map_err(|error| format!("cannot read --pair-code-file: {error}"))?;
    if input.len() as u64 > MAX_PAIR_CODE_SOURCE_BYTES {
        return Err(format!(
            "--pair-code-file must be at most {MAX_PAIR_CODE_SOURCE_BYTES} bytes"
        ));
    }
    Ok(input)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn legacy_file_is_viewer_only() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.as_file()
                .set_permissions(std::fs::Permissions::from_mode(0o600))
                .unwrap();
        }
        file.write_all(b"1234-5678\n").unwrap();
        assert_eq!(
            read_viewer_pairing_code_file(file.path()).unwrap(),
            "12345678"
        );
        assert!(read_pairing_code_file(file.path()).is_err());
    }

    #[test]
    fn reads_a_bounded_regular_pairing_code_file() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.as_file()
                .set_permissions(std::fs::Permissions::from_mode(0o600))
                .unwrap();
        }
        writeln!(file, "0123-4567-89AB-CDEF-0123-4567-89AB-CDEF").unwrap();
        assert_eq!(
            read_pairing_code_file(file.path()).unwrap(),
            "0123456789ABCDEF0123456789ABCDEF"
        );
    }

    #[test]
    fn rejects_an_oversized_pairing_code_file() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.as_file()
                .set_permissions(std::fs::Permissions::from_mode(0o600))
                .unwrap();
        }
        file.write_all(&[b'1'; 65]).unwrap();
        assert!(read_pairing_code_file(file.path())
            .unwrap_err()
            .contains("at most 64 bytes"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_group_readable_pairing_code_file() {
        use std::os::unix::fs::PermissionsExt;

        let mut file = tempfile::NamedTempFile::new().unwrap();
        writeln!(file, "0123456789ABCDEF0123456789ABCDEF").unwrap();
        file.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o640))
            .unwrap();
        assert!(read_pairing_code_file(file.path())
            .unwrap_err()
            .contains("group or other"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symbolic_link_pairing_code_file() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target");
        let link = directory.path().join("pair-code");
        std::fs::write(&target, "0123456789ABCDEF0123456789ABCDEF\n").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).unwrap();
        symlink(&target, &link).unwrap();
        assert!(read_pairing_code_file(&link)
            .unwrap_err()
            .contains("regular file"));
    }
}
