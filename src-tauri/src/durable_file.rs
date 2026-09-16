//! Crash-consistent replacement for private application files.
//!
//! Unix needs the parent directory synced after an atomic rename. Windows
//! instead needs `MOVEFILE_WRITE_THROUGH`; `tempfile::persist` deliberately
//! omits that flag, so security-critical authority files must use this helper.

use std::io::Write as _;
use std::path::Path;

const DELETE_TOMBSTONE_PREFIX: &str = ".latticeterm-delete-";

#[cfg(windows)]
fn wide_path(path: &Path) -> Result<Vec<u16>, String> {
    use std::iter;
    use std::os::windows::ffi::OsStrExt as _;

    let mut encoded = path.as_os_str().encode_wide().collect::<Vec<_>>();
    if encoded.contains(&0) {
        return Err("the application data path contains a null character".to_string());
    }
    encoded.extend(iter::once(0));
    Ok(encoded)
}

#[derive(Debug)]
pub(crate) struct AtomicWriteError {
    detail: String,
    replacement_visible: bool,
}

impl AtomicWriteError {
    pub(crate) fn before_replace(error: impl ToString) -> Self {
        Self {
            detail: error.to_string(),
            replacement_visible: false,
        }
    }

    pub(crate) fn after_replace(error: impl ToString) -> Self {
        Self {
            detail: error.to_string(),
            replacement_visible: true,
        }
    }

    pub(crate) fn replacement_visible(&self) -> bool {
        self.replacement_visible
    }
}

impl std::fmt::Display for AtomicWriteError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.detail)
    }
}

impl std::error::Error for AtomicWriteError {}

pub(crate) fn atomic_write_private(path: &Path, contents: &[u8]) -> Result<(), AtomicWriteError> {
    let directory = path.parent().ok_or_else(|| {
        AtomicWriteError::before_replace("the application data path has no parent directory")
    })?;
    std::fs::create_dir_all(directory).map_err(AtomicWriteError::before_replace)?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(directory).map_err(AtomicWriteError::before_replace)?;
    temporary
        .write_all(contents)
        .map_err(AtomicWriteError::before_replace)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        temporary
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(AtomicWriteError::before_replace)?;
    }
    temporary
        .as_file()
        .sync_all()
        .map_err(AtomicWriteError::before_replace)?;
    persist_synced(temporary, path).map_err(AtomicWriteError::before_replace)?;

    #[cfg(unix)]
    sync_parent_directory(directory).map_err(AtomicWriteError::after_replace)?;
    Ok(())
}

/// Best-effort retry for a Windows tombstone whose final removal was
/// temporarily blocked (for example by an antivirus scanner). The canonical
/// application filename is already gone; this only removes unreachable old
/// bytes and never follows directories.
pub(crate) fn cleanup_private_tombstones(directory: &Path) -> Result<(), String> {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    let mut first_error = None;
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                first_error.get_or_insert_with(|| error.to_string());
                continue;
            }
        };
        if !entry
            .file_name()
            .to_string_lossy()
            .starts_with(DELETE_TOMBSTONE_PREFIX)
        {
            continue;
        }
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) => {
                first_error.get_or_insert_with(|| error.to_string());
                continue;
            }
        };
        if file_type.is_dir() {
            continue;
        }
        if let Err(error) = std::fs::remove_file(entry.path()) {
            first_error.get_or_insert_with(|| error.to_string());
        }
    }
    match first_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

/// Removes a private file without allowing its original authority-bearing
/// name to reappear after a successful Windows restore acknowledgement.
///
/// Windows first moves the file, write-through, to an unreachable random name
/// in the same directory and then removes that tombstone. A crash between the
/// operations can leave only the random tombstone, never the live filename.
pub(crate) fn durable_remove_private(path: &Path) -> Result<(), String> {
    let directory = path
        .parent()
        .ok_or_else(|| "the application data path has no parent directory".to_string())?;

    #[cfg(windows)]
    {
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };

        // Reserve the unpredictable destination while it is created. Closing
        // the handle before MoveFileEx avoids depending on share-delete flags.
        let _ = cleanup_private_tombstones(directory);
        let tombstone = tempfile::Builder::new()
            .prefix(DELETE_TOMBSTONE_PREFIX)
            .tempfile_in(directory)
            .map_err(|error| error.to_string())?
            .into_temp_path();
        let source = wide_path(path)?;
        let destination = wide_path(&tombstone)?;
        let moved = unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if moved == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        return tombstone.close().map_err(|error| error.to_string());
    }

    #[cfg(unix)]
    {
        std::fs::remove_file(path).map_err(|error| error.to_string())?;
        sync_parent_directory(directory)
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = directory;
        std::fs::remove_file(path).map_err(|error| error.to_string())
    }
}

#[cfg(unix)]
fn sync_parent_directory(directory: &Path) -> Result<(), String> {
    #[cfg(test)]
    if FAIL_NEXT_PARENT_SYNC.with(|fail| fail.replace(false)) {
        return Err("injected parent-directory sync failure".to_string());
    }
    std::fs::File::open(directory)
        .and_then(|file| file.sync_all())
        .map_err(|error| error.to_string())
}

#[cfg(all(unix, test))]
thread_local! {
    static FAIL_NEXT_PARENT_SYNC: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(all(unix, test))]
pub(crate) fn fail_next_parent_sync_for_test() {
    FAIL_NEXT_PARENT_SYNC.with(|fail| fail.set(true));
}

#[cfg(not(windows))]
fn persist_synced(temporary: tempfile::NamedTempFile, path: &Path) -> Result<(), String> {
    temporary
        .persist(path)
        .map(|_| ())
        .map_err(|error| error.error.to_string())
}

#[cfg(windows)]
fn persist_synced(temporary: tempfile::NamedTempFile, path: &Path) -> Result<(), String> {
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, SetFileAttributesW, FILE_ATTRIBUTE_NORMAL, MOVEFILE_REPLACE_EXISTING,
        MOVEFILE_WRITE_THROUGH,
    };

    // Closing the handle first avoids relying on share-delete flags. Keep the
    // TempPath cleanup guard until the move succeeds so failures remain tidy.
    let mut temporary = temporary.into_temp_path();
    let source = wide_path(&temporary)?;
    let destination = wide_path(path)?;
    unsafe {
        // NamedTempFile marks the file temporary on Windows. Clear that bit
        // before making it the durable application file.
        if SetFileAttributesW(source.as_ptr(), FILE_ATTRIBUTE_NORMAL) == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        if MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        ) == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    temporary.disable_cleanup(true);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomically_replaces_a_private_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.json");
        std::fs::write(&path, "old").unwrap();

        atomic_write_private(&path, b"new").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn durably_removes_a_private_file_without_leaving_a_tombstone() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.json");
        std::fs::write(&path, "secret").unwrap();

        durable_remove_private(&path).unwrap();

        assert!(!path.exists());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[test]
    fn cleanup_removes_only_owned_delete_tombstones() {
        let directory = tempfile::tempdir().unwrap();
        let tombstone = directory
            .path()
            .join(format!("{DELETE_TOMBSTONE_PREFIX}stale"));
        let unrelated = directory.path().join("user-data.json");
        std::fs::write(&tombstone, "old private bytes").unwrap();
        std::fs::write(&unrelated, "keep").unwrap();

        cleanup_private_tombstones(directory.path()).unwrap();

        assert!(!tombstone.exists());
        assert_eq!(std::fs::read_to_string(unrelated).unwrap(), "keep");
    }

    #[cfg(unix)]
    #[test]
    fn reports_when_replacement_is_visible_but_parent_sync_failed() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.json");
        std::fs::write(&path, "old").unwrap();
        fail_next_parent_sync_for_test();

        let error = atomic_write_private(&path, b"new").unwrap_err();

        assert!(error.replacement_visible());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "new");
    }

    #[cfg(unix)]
    #[test]
    fn reports_when_removal_is_visible_but_parent_sync_failed() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.json");
        std::fs::write(&path, "secret").unwrap();
        fail_next_parent_sync_for_test();

        let error = durable_remove_private(&path).unwrap_err();

        assert!(error.contains("injected parent-directory sync failure"));
        assert!(!path.exists());
    }
}
