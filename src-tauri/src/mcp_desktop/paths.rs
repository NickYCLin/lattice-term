//! Conservative path scopes for a trusted SFTP server, not a remote sandbox.
//! Checks are repeated immediately before publication. SFTP v3 has no openat
//! directory capabilities: server-side chroot is required for hostile races.

use super::{sha256, RootRequest, ServiceError, TransferDirection};
use crate::sftp::SftpRegistry;
use base64::Engine;
use russh_sftp::client::SftpSession;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::sync::watch;

const MAX_FILE_BYTES: usize = 8 * 1024 * 1024;
const MAX_LIST_ENTRIES: usize = 512;

pub(super) struct Root {
    pub id: String,
    remote: String,
    local: Option<PathBuf>,
}

fn path_error() -> ServiceError {
    ServiceError::new("path_not_allowed", "Use a regular file or directory within the approved roots; links and parent traversal are not allowed.")
}

fn size_error() -> ServiceError {
    ServiceError::new(
        "file_too_large",
        "MCP file transfers are limited to 8 MiB per file.",
    )
}

fn conflict() -> ServiceError {
    ServiceError::new(
        "file_conflict",
        "The destination already exists or changed during transfer; nothing was overwritten.",
    )
}

pub(super) async fn prepare_root(
    session: &SftpSession,
    request: &RootRequest,
) -> Result<Root, ServiceError> {
    let remote = absolute_remote(&request.remote_path)?;
    let local = request
        .local_path
        .as_deref()
        .map(prepare_local_root)
        .transpose()?;
    tokio::time::timeout(
        Duration::from_secs(10),
        check_remote(session, &remote, "", true),
    )
    .await
    .map_err(|_| {
        ServiceError::new(
            "timed_out",
            "The approved directory could not be verified before the deadline.",
        )
    })??;
    Ok(Root {
        id: request.id.clone(),
        remote,
        local,
    })
}

fn absolute_remote(path: &str) -> Result<String, ServiceError> {
    if !path.starts_with('/') || path.starts_with("//") {
        return Err(path_error());
    }
    let relative = path.trim_start_matches('/').trim_end_matches('/');
    relative_components(relative, false)?;
    // A whole filesystem is not a useful, bounded MCP workspace grant.
    if relative.is_empty() {
        return Err(path_error());
    }
    Ok(format!("/{relative}"))
}

fn relative_components(path: &str, allow_empty: bool) -> Result<Vec<&str>, ServiceError> {
    if path.len() > 2048
        || path.chars().any(char::is_control)
        || path.contains(['\\', ':'])
        || path.starts_with('/')
    {
        return Err(path_error());
    }
    if path.is_empty() {
        return if allow_empty {
            Ok(vec![])
        } else {
            Err(path_error())
        };
    }
    let components: Vec<_> = path.split('/').collect();
    if components
        .iter()
        .any(|part| part.is_empty() || matches!(*part, "." | ".."))
    {
        return Err(path_error());
    }
    Ok(components)
}

pub(super) fn preflight_directory(path: &str) -> Result<(), ServiceError> {
    relative_components(path, true).map(|_| ())
}

pub(super) fn preflight_transfer(local: &str, remote: &str) -> Result<(), ServiceError> {
    relative_components(remote, false)?;
    if relative_components(local, false)?
        .iter()
        .any(|component| !valid_local_name(component))
    {
        return Err(path_error());
    }
    Ok(())
}

fn join_remote(root: &str, components: &[&str]) -> String {
    if components.is_empty() {
        root.into()
    } else {
        format!("{root}/{}", components.join("/"))
    }
}

/// No path returned by a server is trusted merely because it has a prefix.
async fn check_remote(
    session: &SftpSession,
    root: &str,
    relative: &str,
    directory: bool,
) -> Result<String, ServiceError> {
    let components = relative_components(relative, true)?;
    let path = join_remote(root, &components);
    let canonical = session
        .canonicalize(path.clone())
        .await
        .map_err(|_| path_error())?;
    if canonical != path {
        return Err(path_error());
    }
    let mut current = String::new();
    let all: Vec<_> = path.trim_start_matches('/').split('/').collect();
    for (index, part) in all.iter().enumerate() {
        current.push('/');
        current.push_str(part);
        let metadata = session
            .symlink_metadata(current.clone())
            .await
            .map_err(|_| path_error())?;
        let terminal = index + 1 == all.len();
        if metadata.file_type().is_symlink()
            || ((!terminal || directory) && !metadata.file_type().is_dir())
            || (terminal && !directory && !metadata.file_type().is_file())
        {
            return Err(path_error());
        }
    }
    Ok(path)
}

pub(super) async fn list_directory(
    registry: &SftpRegistry,
    session_id: &str,
    root: &Root,
    relative: &str,
) -> Result<Value, ServiceError> {
    let session = registry
        .session(session_id)
        .map_err(|_| ServiceError::unavailable())?;
    let path = check_remote(&session, &root.remote, relative, true).await?;
    let directory = crate::sftp::list_directory(registry, session_id, &path)
        .await
        .map_err(|_| ServiceError::failed())?;
    if directory.path != path {
        return Err(path_error());
    }
    check_remote(&session, &root.remote, relative, true).await?;
    let truncated = directory.entries.len() > MAX_LIST_ENTRIES;
    let mut entries = Vec::new();
    for entry in directory.entries.into_iter().take(MAX_LIST_ENTRIES) {
        let parts = relative_components(&entry.name, false)?;
        if parts.len() != 1 {
            return Err(path_error());
        }
        let path = if relative.is_empty() {
            entry.name.clone()
        } else {
            format!("{relative}/{}", entry.name)
        };
        entries.push(json!({ "name": entry.name, "path": path, "kind": entry.kind, "size": entry.size, "modifiedAt": entry.modified_at }));
    }
    Ok(
        json!({ "rootId": root.id, "path": relative, "entries": entries, "truncated": truncated, "maxEntries": MAX_LIST_ENTRIES }),
    )
}

fn has_link_metadata(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Junctions and other reparse points must not bypass symlink checks.
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn prepare_local_root(path: &str) -> Result<PathBuf, ServiceError> {
    let path = PathBuf::from(path);
    #[cfg(windows)]
    if path.components().any(|component| matches!(component, Component::Prefix(prefix) if !matches!(prefix.kind(), std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_)))) {
        return Err(path_error());
    }
    if !path.is_absolute()
        || path.parent().is_none()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err(path_error());
    }
    let canonical = path.canonicalize().map_err(|_| path_error())?;
    // Never authorize the root of a drive or filesystem.
    if canonical.parent().is_none() {
        return Err(path_error());
    }
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component);
        if matches!(component, Component::Prefix(_) | Component::RootDir) {
            continue;
        }
        let metadata = std::fs::symlink_metadata(&current).map_err(|_| path_error())?;
        if has_link_metadata(&metadata) || !metadata.is_dir() {
            return Err(path_error());
        }
    }
    Ok(canonical)
}

fn valid_local_name(name: &str) -> bool {
    if name.ends_with([' ', '.'])
        || name
            .chars()
            .any(|character| matches!(character, '<' | '>' | '"' | '|' | '?' | '*'))
    {
        return false;
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        && !["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|number| {
                matches!(number, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            })
        })
}

fn local_path(root: &Path, relative: &str, existing_file: bool) -> Result<PathBuf, ServiceError> {
    // Recheck the complete original root, not just its final entry. An ancestor
    // swapped for a junction/symlink must not silently authorize a new root.
    let checked_root = prepare_local_root(root.to_str().ok_or_else(path_error)?)?;
    if checked_root != root {
        return Err(path_error());
    }
    let components = relative_components(relative, false)?;
    if components
        .iter()
        .any(|component| !valid_local_name(component))
    {
        return Err(path_error());
    }
    let root_metadata = std::fs::symlink_metadata(root).map_err(|_| path_error())?;
    if has_link_metadata(&root_metadata) || !root_metadata.is_dir() {
        return Err(path_error());
    }
    let mut current = root.to_path_buf();
    for (index, component) in components.iter().enumerate() {
        current.push(component);
        let terminal = index + 1 == components.len();
        if terminal && !existing_file {
            match std::fs::symlink_metadata(&current) {
                Ok(_) => return Err(conflict()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(path_error()),
            }
            continue;
        }
        let metadata = std::fs::symlink_metadata(&current).map_err(|_| path_error())?;
        if has_link_metadata(&metadata)
            || (terminal && !metadata.is_file())
            || (!terminal && !metadata.is_dir())
        {
            return Err(path_error());
        }
        let canonical = current.canonicalize().map_err(|_| path_error())?;
        if !canonical.starts_with(root) {
            return Err(path_error());
        }
    }
    Ok(current)
}

fn read_local(root: &Path, relative: &str) -> Result<Vec<u8>, ServiceError> {
    let path = local_path(root, relative, true)?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = options.open(path).map_err(|_| path_error())?;
    let metadata = file.metadata().map_err(|_| path_error())?;
    if has_link_metadata(&metadata) || !metadata.is_file() {
        return Err(path_error());
    }
    require_single_link(&file)?;
    if metadata.len() > MAX_FILE_BYTES as u64 {
        return Err(size_error());
    }
    let mut bytes = Vec::new();
    (&file)
        .take(MAX_FILE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ServiceError::failed())?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err(size_error());
    }
    local_path(root, relative, true)?;
    require_single_link(&file)?;
    Ok(bytes)
}

fn require_single_link(file: &std::fs::File) -> Result<(), ServiceError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if file.metadata().map_err(|_| path_error())?.nlink() != 1 {
            return Err(path_error());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: File owns a valid live handle; info is a writable output buffer.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0
            || info.nNumberOfLinks != 1
        {
            return Err(path_error());
        }
    }
    Ok(())
}

struct QuietSink;
impl crate::sftp_transfers::TransferSink for QuietSink {
    fn update(&self, _: &crate::sftp_transfers::TransferState) {}
}

struct UploadCleanup {
    transfers: Arc<crate::sftp_transfers::TransferRegistry>,
    id: String,
    complete: bool,
}

impl Drop for UploadCleanup {
    fn drop(&mut self) {
        if self.complete {
            return;
        }
        let transfers = Arc::clone(&self.transfers);
        let id = self.id.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = tokio::time::timeout(
                    Duration::from_secs(5),
                    crate::sftp_transfers::cancel(&transfers, &QuietSink, &id),
                )
                .await;
            });
        }
    }
}

fn still_allowed(
    revoked: &watch::Receiver<bool>,
    cancel: &watch::Receiver<bool>,
) -> Result<(), ServiceError> {
    if *revoked.borrow() {
        return Err(ServiceError::denied());
    }
    if *cancel.borrow() {
        return Err(ServiceError::new(
            "unknown_outcome",
            "Cancellation was requested; inspect the destination before retrying.",
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn transfer(
    registry: &SftpRegistry,
    session_id: &str,
    root: &Root,
    direction: TransferDirection,
    local_relative: &str,
    remote_relative: &str,
    revoked: watch::Receiver<bool>,
    cancel: watch::Receiver<bool>,
) -> Result<Value, ServiceError> {
    still_allowed(&revoked, &cancel)?;
    let local = root.local.as_ref().ok_or_else(ServiceError::denied)?;
    let components = relative_components(remote_relative, false)?;
    let session = registry
        .session(session_id)
        .map_err(|_| ServiceError::unavailable())?;
    match direction {
        TransferDirection::Upload => {
            let bytes = read_local(local, local_relative)?;
            let (name, parents) = components.split_last().ok_or_else(path_error)?;
            let parent_relative = parents.join("/");
            let parent = check_remote(&session, &root.remote, &parent_relative, true).await?;
            still_allowed(&revoked, &cancel)?;
            let transfers = Arc::new(crate::sftp_transfers::TransferRegistry::new());
            let state = crate::sftp_transfers::begin_upload(
                Arc::clone(&transfers),
                registry,
                &QuietSink,
                crate::sftp_transfers::UploadPlan {
                    session_id: session_id.into(),
                    parent,
                    name: (*name).into(),
                    total_bytes: bytes.len() as u64,
                    overwrite: false,
                },
            )
            .await
            .map_err(|_| conflict())?;
            let mut cleanup = UploadCleanup {
                transfers,
                id: state.transfer_id,
                complete: false,
            };
            for chunk in bytes.chunks(256 * 1024) {
                still_allowed(&revoked, &cancel)?;
                let encoded = base64::engine::general_purpose::STANDARD.encode(chunk);
                crate::sftp_transfers::upload_chunk(
                    &cleanup.transfers,
                    &QuietSink,
                    &cleanup.id,
                    &encoded,
                )
                .await
                .map_err(|_| ServiceError::failed())?;
            }
            check_remote(&session, &root.remote, &parent_relative, true).await?;
            still_allowed(&revoked, &cancel)?;
            crate::sftp_transfers::finish_upload(&cleanup.transfers, &QuietSink, &cleanup.id).await.map_err(|_| ServiceError::new("unknown_outcome", "The upload did not return a confirmed result; inspect the destination before retrying."))?;
            cleanup.complete = true;
            Ok(json!({ "count": bytes.len(), "sha256": sha256(&bytes) }))
        }
        TransferDirection::Download => {
            let destination = local_path(local, local_relative, false)?;
            let remote = check_remote(&session, &root.remote, remote_relative, false).await?;
            let file = session
                .open(remote)
                .await
                .map_err(|_| ServiceError::failed())?;
            let metadata = file.metadata().await.map_err(|_| ServiceError::failed())?;
            if !metadata.file_type().is_file() || metadata.len() > MAX_FILE_BYTES as u64 {
                return Err(size_error());
            }
            let mut bytes = Vec::new();
            file.take(MAX_FILE_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| ServiceError::failed())?;
            if bytes.len() > MAX_FILE_BYTES {
                return Err(size_error());
            }
            check_remote(&session, &root.remote, remote_relative, false).await?;
            let parent = destination.parent().ok_or_else(path_error)?;
            let mut staging =
                tempfile::NamedTempFile::new_in(parent).map_err(|_| ServiceError::failed())?;
            staging
                .write_all(&bytes)
                .and_then(|_| staging.as_file().sync_all())
                .map_err(|_| ServiceError::failed())?;
            // A file created after the first check is never overwritten.
            if local_path(local, local_relative, false)? != destination {
                return Err(path_error());
            }
            still_allowed(&revoked, &cancel)?;
            staging
                .persist_noclobber(destination)
                .map_err(|_| conflict())?;
            Ok(json!({ "count": bytes.len(), "sha256": sha256(&bytes) }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths_reject_traversal_drives_unc_control_and_empty_segments() {
        for bad in [
            "..",
            "../outside",
            "a/../b",
            "/absolute",
            "C:/file",
            "\\\\host\\file",
            "a\\b",
            "a//b",
            "a/./b",
            "a\0b",
            "a\nb",
            "a/",
        ] {
            assert!(relative_components(bad, false).is_err(), "{bad:?}");
        }
        assert_eq!(
            relative_components("專案/a file.txt", false).unwrap(),
            vec!["專案", "a file.txt"]
        );
        assert!(absolute_remote("/").is_err());
        assert!(absolute_remote("//host/root").is_err());
        assert_eq!(absolute_remote("/tmp/project/").unwrap(), "/tmp/project");
    }

    #[test]
    fn local_destinations_are_explicit_no_clobber_and_never_device_names() {
        let root = tempfile::tempdir().unwrap();
        let canonical = root.path().canonicalize().unwrap();
        std::fs::write(root.path().join("exists.txt"), b"original").unwrap();
        assert!(local_path(&canonical, "exists.txt", false).is_err());
        for bad in [
            "NUL",
            "COM1.txt",
            "trailing.",
            "file:stream",
            "../escape",
            "bad?name",
        ] {
            assert!(local_path(&canonical, bad, false).is_err(), "{bad}");
        }
        assert_eq!(
            std::fs::read(root.path().join("exists.txt")).unwrap(),
            b"original"
        );
        assert!(local_path(&canonical, "new.txt", false).is_ok());
    }

    #[test]
    fn a_hard_link_cannot_upload_a_file_from_outside_the_approved_root() {
        let fixture = tempfile::tempdir().unwrap();
        let approved = fixture.path().join("approved");
        std::fs::create_dir(&approved).unwrap();
        let outside = fixture.path().join("private.txt");
        std::fs::write(&outside, b"private outside contents").unwrap();
        std::fs::hard_link(&outside, approved.join("link.txt")).unwrap();
        let root = prepare_local_root(approved.to_str().unwrap()).unwrap();
        assert_eq!(
            read_local(&root, "link.txt").unwrap_err().code,
            "path_not_allowed"
        );
    }

    #[cfg(unix)]
    #[test]
    fn local_read_and_write_paths_reject_links_to_outside_and_inside_the_root() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret"), b"private").unwrap();
        std::fs::write(root.path().join("file"), b"public").unwrap();
        symlink(outside.path(), root.path().join("outside")).unwrap();
        symlink(root.path().join("file"), root.path().join("inside")).unwrap();
        assert!(local_path(root.path(), "outside/secret", true).is_err());
        assert!(local_path(root.path(), "outside/new", false).is_err());
        assert!(local_path(root.path(), "inside", true).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn replacing_an_approved_root_ancestor_cannot_redirect_a_download() {
        use std::os::unix::fs::symlink;
        let fixture = tempfile::tempdir().unwrap();
        let parent = fixture.path().join("approved");
        let outside = fixture.path().join("outside");
        std::fs::create_dir_all(parent.join("root")).unwrap();
        std::fs::create_dir_all(outside.join("root")).unwrap();
        let root = prepare_local_root(parent.join("root").to_str().unwrap()).unwrap();
        std::fs::rename(&parent, fixture.path().join("old-approved")).unwrap();
        symlink(&outside, &parent).unwrap();
        assert!(local_path(&root, "download.txt", false).is_err());
        assert!(!outside.join("root/download.txt").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "Requires local OpenSSH sftp-server; CI runs openssh_ tests explicitly"]
    async fn openssh_mcp_roots_reject_links_traversal_and_sibling_prefixes() {
        use crate::sftp_test_server::{bounded, OpenSshServer};
        use std::os::unix::fs::symlink;
        bounded(async {
            let (server, stream) = OpenSshServer::start(None);
            std::fs::create_dir(server.path("approved")).unwrap();
            std::fs::create_dir(server.path("approved-other")).unwrap();
            std::fs::write(server.path("approved/report.txt"), b"report").unwrap();
            std::fs::write(server.path("approved-other/secret.txt"), b"private").unwrap();
            symlink(server.path("approved-other"), server.path("approved/link")).unwrap();
            symlink(
                server.path("approved/report.txt"),
                server.path("approved/file-link"),
            )
            .unwrap();
            let session = SftpSession::new(stream).await.unwrap();
            let root = prepare_root(
                &session,
                &RootRequest {
                    id: "test".into(),
                    label: "Test".into(),
                    remote_path: server.path("approved"),
                    local_path: None,
                },
            )
            .await
            .unwrap();
            assert!(check_remote(&session, &root.remote, "", true).await.is_ok());
            assert!(check_remote(&session, &root.remote, "report.txt", false)
                .await
                .is_ok());
            for (path, directory) in [
                ("../approved-other", true),
                ("link", true),
                ("link/secret.txt", false),
                ("file-link", false),
            ] {
                assert!(
                    check_remote(&session, &root.remote, path, directory)
                        .await
                        .is_err(),
                    "{path}"
                );
            }
            assert!(
                check_remote(&session, &root.remote, &server.path("approved-other"), true)
                    .await
                    .is_err()
            );
            // A directory swapped for a symlink after granting cannot reuse the
            // previous authorization at the next operation boundary.
            std::fs::rename(server.path("approved"), server.path("old-approved")).unwrap();
            symlink(server.path("approved-other"), server.path("approved")).unwrap();
            assert!(check_remote(&session, &root.remote, "secret.txt", false)
                .await
                .is_err());
            server.stop().await;
        })
        .await;
    }

    #[test]
    fn cancellation_is_rechecked_before_publication() {
        let (revoked, revoke_check) = watch::channel(false);
        let (cancelled, cancel_check) = watch::channel(false);
        assert!(still_allowed(&revoke_check, &cancel_check).is_ok());
        cancelled.send_replace(true);
        assert_eq!(
            still_allowed(&revoke_check, &cancel_check)
                .unwrap_err()
                .code,
            "unknown_outcome"
        );
        revoked.send_replace(true);
        assert_eq!(
            still_allowed(&revoke_check, &cancel_check)
                .unwrap_err()
                .code,
            "not_authorized"
        );
    }
}
