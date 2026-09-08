//! Filesystem boundary for an explicitly shared Lattice Remote directory.
//!
//! Every wire path is virtual (rooted at `/`). Existing paths are
//! canonicalised before use, parents are checked before uploads, and symlinks
//! cannot escape the configured root. Uploads stay in private sibling staging
//! files until the announced byte count has arrived and the file is flushed.

use crate::{
    RemoteFileEntry, RemoteFileKind, MAX_DIRECTORY_ENTRIES, MAX_FILE_ROOT_LABEL_BYTES,
    MAX_REMOTE_PATH_BYTES,
};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

static NEXT_STAGING_FILE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone)]
pub struct SharedFiles {
    root: PathBuf,
    label: String,
    text_root: crate::host_text::TextRoot,
}

pub struct DownloadFile {
    pub name: String,
    pub size: u64,
    pub file: File,
}

pub struct HostUpload {
    target: PathBuf,
    staging: PathBuf,
    file: Option<File>,
    expected: u64,
    written: u64,
    overwrite: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UploadFinishOutcome {
    Published,
    /// The destination was atomically published, but a private staging link
    /// or protected old copy could not be removed. This is a local cleanup
    /// warning, never a reason to tell the viewer that the committed upload
    /// failed.
    PublishedWithCleanupWarning(String),
}

impl SharedFiles {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, String> {
        let root = fs::canonicalize(root.as_ref())
            .map_err(|error| format!("Cannot open the shared folder: {error}"))?;
        if !root.is_dir() {
            return Err("The shared file root must be a folder.".to_string());
        }
        let label = root
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| valid_visible_name(name))
            .unwrap_or("Shared files")
            .chars()
            .take(MAX_FILE_ROOT_LABEL_BYTES)
            .collect();
        let text_root = crate::host_text::TextRoot::open(&root)?;
        Ok(Self {
            root,
            label,
            text_root,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    pub fn text_root(&self) -> &crate::host_text::TextRoot {
        &self.text_root
    }

    pub fn list(&self, virtual_path: &str) -> Result<(String, Vec<RemoteFileEntry>), String> {
        let (canonical_virtual, relative) = normalize_virtual_path(virtual_path)?;
        let directory = self.resolve_existing(&relative)?;
        if !directory.is_dir() {
            return Err("The requested remote path is not a folder.".to_string());
        }

        let mut entries = Vec::new();
        for item in fs::read_dir(&directory)
            .map_err(|error| format!("Cannot read the shared folder: {error}"))?
        {
            let item = item.map_err(|error| format!("Cannot read a folder entry: {error}"))?;
            let Some(name) = item.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if !valid_visible_name(&name) {
                continue;
            }
            let entry_path = join_virtual(&canonical_virtual, &name)?;
            let metadata = fs::symlink_metadata(item.path())
                .map_err(|error| format!("Cannot inspect '{name}': {error}"))?;
            let file_type = metadata.file_type();
            let kind = if file_type.is_dir() {
                RemoteFileKind::Directory
            } else if file_type.is_file() {
                RemoteFileKind::File
            } else if file_type.is_symlink() {
                RemoteFileKind::Symlink
            } else {
                RemoteFileKind::Other
            };
            entries.push(RemoteFileEntry {
                name,
                path: entry_path,
                kind,
                size: if file_type.is_file() {
                    metadata.len()
                } else {
                    0
                },
                modified_at: metadata
                    .modified()
                    .ok()
                    .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                    .map(|value| value.as_secs()),
            });
            if entries.len() >= MAX_DIRECTORY_ENTRIES {
                break;
            }
        }
        entries.sort_by(|left, right| {
            let left_directory = left.kind == RemoteFileKind::Directory;
            let right_directory = right.kind == RemoteFileKind::Directory;
            right_directory
                .cmp(&left_directory)
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        });
        Ok((canonical_virtual, entries))
    }

    pub fn download(&self, virtual_path: &str) -> Result<DownloadFile, String> {
        let (_, relative) = normalize_virtual_path(virtual_path)?;
        if relative.as_os_str().is_empty() {
            return Err("Choose a file to download.".to_string());
        }
        let path = self.resolve_existing(&relative)?;
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("Cannot inspect the shared file: {error}"))?;
        if !metadata.is_file() {
            return Err("Only regular files can be downloaded.".to_string());
        }
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| valid_visible_name(value))
            .ok_or_else(|| "The file name cannot be represented safely.".to_string())?
            .to_string();
        let file = File::open(&path).map_err(|error| format!("Cannot open the file: {error}"))?;
        Ok(DownloadFile {
            name,
            size: metadata.len(),
            file,
        })
    }

    pub fn begin_upload(
        &self,
        transfer_id: u64,
        virtual_path: &str,
        expected: u64,
        overwrite: bool,
    ) -> Result<HostUpload, String> {
        let target = self.upload_destination(virtual_path)?;
        let parent = target
            .parent()
            .ok_or_else(|| "The upload destination has no parent folder.".to_string())?;
        if let Ok(metadata) = fs::symlink_metadata(&target) {
            if metadata.file_type().is_symlink() || metadata.is_dir() {
                return Err("The upload destination cannot replace a folder or link.".to_string());
            }
            if !overwrite {
                return Err("A file with this name already exists.".to_string());
            }
        }

        let token = NEXT_STAGING_FILE.fetch_add(1, Ordering::Relaxed);
        let staging = parent.join(format!(
            ".latticeterm-upload-{transfer_id}-{}-{token}.part",
            std::process::id()
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options
            .open(&staging)
            .map_err(|error| format!("Cannot create a private upload staging file: {error}"))?;
        Ok(HostUpload {
            target,
            staging,
            file: Some(file),
            expected,
            written: 0,
            overwrite,
        })
    }

    /// Resolves the canonical parent and stable destination key without
    /// opening a staging file. The Agent uses this key for a process-lifetime
    /// same-target reservation before calling `begin_upload`.
    pub fn upload_destination(&self, virtual_path: &str) -> Result<PathBuf, String> {
        let (_, relative) = normalize_virtual_path(virtual_path)?;
        let name = relative
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| valid_visible_name(value))
            .ok_or_else(|| "Choose a valid destination file name.".to_string())?;
        let parent_relative = relative.parent().unwrap_or_else(|| Path::new(""));
        let parent = self.resolve_existing(parent_relative)?;
        if !parent.is_dir() {
            return Err("The upload destination is not a folder.".to_string());
        }
        Ok(parent.join(name))
    }

    fn resolve_existing(&self, relative: &Path) -> Result<PathBuf, String> {
        let candidate = self.root.join(relative);
        let canonical = fs::canonicalize(&candidate)
            .map_err(|error| format!("The shared path is unavailable: {error}"))?;
        if !canonical.starts_with(&self.root) {
            return Err("The requested path leaves the shared folder.".to_string());
        }
        Ok(canonical)
    }
}

impl DownloadFile {
    pub fn read_chunk(&mut self, buffer: &mut [u8]) -> Result<usize, String> {
        self.file
            .read(buffer)
            .map_err(|error| format!("Cannot read the shared file: {error}"))
    }
}

impl HostUpload {
    pub fn destination(&self) -> &Path {
        &self.target
    }

    pub fn write_chunk(&mut self, bytes: &[u8]) -> Result<u64, String> {
        let next = self
            .written
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| "The upload byte count overflowed.".to_string())?;
        if bytes.is_empty() || next > self.expected {
            return Err("The upload contains more bytes than announced.".to_string());
        }
        self.file
            .as_mut()
            .ok_or_else(|| "The upload is no longer writable.".to_string())?
            .write_all(bytes)
            .map_err(|error| format!("Cannot write the upload: {error}"))?;
        self.written = next;
        Ok(next)
    }

    pub fn finish(mut self) -> Result<UploadFinishOutcome, String> {
        if self.written != self.expected {
            return Err(format!(
                "The upload ended after {} of {} bytes.",
                self.written, self.expected
            ));
        }
        let mut file = self
            .file
            .take()
            .ok_or_else(|| "The upload is no longer writable.".to_string())?;
        file.flush()
            .and_then(|()| file.sync_all())
            .map_err(|error| format!("Cannot finish the upload safely: {error}"))?;
        drop(file);

        if !self.overwrite {
            return publish_without_overwrite(&self.staging, &self.target);
        }
        if !self.target.exists() {
            fs::rename(&self.staging, &self.target)
                .map_err(|error| format!("Cannot publish the uploaded file: {error}"))?;
            return Ok(UploadFinishOutcome::Published);
        }

        let token = NEXT_STAGING_FILE.fetch_add(1, Ordering::Relaxed);
        let backup = self.target.with_file_name(format!(
            ".latticeterm-replaced-{}-{token}.bak",
            std::process::id()
        ));
        fs::rename(&self.target, &backup)
            .map_err(|error| format!("Cannot protect the existing file: {error}"))?;
        if let Err(error) = fs::rename(&self.staging, &self.target) {
            let restore = fs::rename(&backup, &self.target);
            return Err(match restore {
                Ok(()) => format!("Cannot publish the uploaded file: {error}"),
                Err(restore_error) => format!(
                    "Cannot publish the uploaded file ({error}) or restore the original ({restore_error})."
                ),
            });
        }
        Ok(cleanup_published_backup(&backup))
    }
}

fn publish_without_overwrite(staging: &Path, target: &Path) -> Result<UploadFinishOutcome, String> {
    // Both paths are siblings, so hard-link creation is an atomic
    // create-if-absent publish. Never fall back to rename: POSIX rename would
    // silently replace a destination that appeared after the last check.
    fs::hard_link(staging, target).map_err(|error| {
        if target.exists() {
            "A file with this name appeared during the upload.".to_string()
        } else {
            format!("Cannot publish the upload without overwriting safely: {error}")
        }
    })?;
    match fs::remove_file(staging) {
        Ok(()) => Ok(UploadFinishOutcome::Published),
        Err(error) => Ok(UploadFinishOutcome::PublishedWithCleanupWarning(format!(
            "The private staging link could not be removed: {error}"
        ))),
    }
}

fn cleanup_published_backup(backup: &Path) -> UploadFinishOutcome {
    match fs::remove_file(backup) {
        Ok(()) => UploadFinishOutcome::Published,
        Err(error) => UploadFinishOutcome::PublishedWithCleanupWarning(format!(
            "The protected backup could not be removed: {error}"
        )),
    }
}

impl Drop for HostUpload {
    fn drop(&mut self) {
        let _ = self.file.take();
        let _ = fs::remove_file(&self.staging);
    }
}

fn normalize_virtual_path(input: &str) -> Result<(String, PathBuf), String> {
    if input.is_empty()
        || input.len() > MAX_REMOTE_PATH_BYTES
        || !input.starts_with('/')
        || input.contains('\\')
        || input.contains('\0')
        || input.chars().any(char::is_control)
    {
        return Err("The remote path is invalid.".to_string());
    }
    let mut relative = PathBuf::new();
    for component in Path::new(input).components() {
        match component {
            Component::RootDir => {}
            Component::Normal(value) => {
                let value = value
                    .to_str()
                    .filter(|name| valid_visible_name(name))
                    .ok_or_else(|| "The remote path contains an unsafe name.".to_string())?;
                relative.push(value);
            }
            Component::CurDir | Component::ParentDir | Component::Prefix(_) => {
                return Err("The remote path may not leave the shared folder.".to_string())
            }
        }
    }
    let canonical = if relative.as_os_str().is_empty() {
        "/".to_string()
    } else {
        format!("/{}", relative.to_string_lossy().replace('\\', "/"))
    };
    Ok((canonical, relative))
}

fn join_virtual(parent: &str, name: &str) -> Result<String, String> {
    let joined = if parent == "/" {
        format!("/{name}")
    } else {
        format!("{parent}/{name}")
    };
    if joined.len() > MAX_REMOTE_PATH_BYTES {
        return Err("A shared path is too long to send safely.".to_string());
    }
    Ok(joined)
}

fn valid_visible_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && name.len() <= MAX_FILE_ROOT_LABEL_BYTES
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains('\0')
        && !name.chars().any(char::is_control)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        let token = NEXT_STAGING_FILE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "lattice-remote-files-{label}-{}-{token}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn lists_only_virtual_paths_and_rejects_parent_escape() {
        let root = temp_root("list");
        fs::create_dir(root.join("folder")).unwrap();
        fs::write(root.join("note.txt"), b"hello").unwrap();
        let shared = SharedFiles::open(&root).unwrap();
        let (path, entries) = shared.list("/").unwrap();
        assert_eq!(path, "/");
        assert_eq!(entries[0].path, "/folder");
        assert!(entries.iter().any(|entry| entry.path == "/note.txt"));
        assert!(shared.list("/../").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn uploads_atomically_and_preserves_existing_files_until_finish() {
        let root = temp_root("upload");
        fs::write(root.join("note.txt"), b"old").unwrap();
        let shared = SharedFiles::open(&root).unwrap();
        let mut upload = shared.begin_upload(7, "/note.txt", 6, true).unwrap();
        upload.write_chunk(b"new").unwrap();
        assert_eq!(fs::read(root.join("note.txt")).unwrap(), b"old");
        upload.write_chunk(b"est").unwrap();
        assert_eq!(upload.finish().unwrap(), UploadFinishOutcome::Published);
        assert_eq!(fs::read(root.join("note.txt")).unwrap(), b"newest");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cancelled_or_incomplete_upload_removes_staging_file() {
        let root = temp_root("cancel");
        let shared = SharedFiles::open(&root).unwrap();
        let mut upload = shared.begin_upload(8, "/partial.bin", 5, false).unwrap();
        upload.write_chunk(b"12").unwrap();
        drop(upload);
        assert!(!root.join("partial.bin").exists());
        assert!(fs::read_dir(&root).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".part")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_non_overwrite_finishes_publish_exactly_one_complete_file() {
        let root = temp_root("no-clobber");
        let shared = SharedFiles::open(&root).unwrap();
        let mut first = shared.begin_upload(21, "/winner.bin", 5, false).unwrap();
        let mut second = shared.begin_upload(22, "/winner.bin", 5, false).unwrap();
        first.write_chunk(b"first").unwrap();
        second.write_chunk(b"other").unwrap();

        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let first_barrier = std::sync::Arc::clone(&barrier);
        let first_finish = std::thread::spawn(move || {
            first_barrier.wait();
            first.finish()
        });
        let second_finish = std::thread::spawn(move || {
            barrier.wait();
            second.finish()
        });
        let first_result = first_finish.join().unwrap();
        let second_result = second_finish.join().unwrap();

        assert_ne!(first_result.is_ok(), second_result.is_ok());
        let expected = if first_result.is_ok() {
            b"first".as_slice()
        } else {
            b"other".as_slice()
        };
        assert_eq!(fs::read(root.join("winner.bin")).unwrap(), expected);
        assert!(fs::read_dir(&root).unwrap().all(|entry| {
            let name = entry.unwrap().file_name();
            let name = name.to_string_lossy();
            !name.contains(".latticeterm-upload-") && !name.contains(".latticeterm-replaced-")
        }));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn published_backup_cleanup_failure_is_a_success_with_local_warning() {
        let root = temp_root("cleanup-warning");
        let backup = root.join("protected-backup");
        fs::create_dir(&backup).unwrap();

        let outcome = cleanup_published_backup(&backup);

        assert!(matches!(
            outcome,
            UploadFinishOutcome::PublishedWithCleanupWarning(detail)
                if detail.contains("protected backup")
        ));
        fs::remove_dir_all(root).unwrap();
    }
}
