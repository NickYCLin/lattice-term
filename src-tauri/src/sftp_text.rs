//! Bounded text editing over an already authenticated SFTP connection.
//!
//! SFTP v3 has no compare-and-swap, inode identity, NOFOLLOW, or ACL API. This
//! implementation checks snapshots, publishes without clobbering a newly
//! appearing destination, and retains the original inode as a recovery copy.
//! There is a short rename gap, not an atomic replacement. POSIX owner/group/
//! mode are verified; arbitrary ACLs and hostile concurrent parent renames are
//! outside the protocol's guarantees. No shell command or new login is used.

use crate::sftp::{join_path, SftpRegistry};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub const MAX_TEXT_BYTES: usize = 1024 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(30);
const READ_WARNING: &str = "SFTP text saves preserve POSIX owner/group/mode and retain the original as a backup, but are not an atomic compare-and-swap. SFTP cannot inspect or preserve arbitrary ACLs. A replacement may inherit the parent folder's ACL and grant access to additional users despite matching mode bits; shared-access files require explicit confirmation on every save. Use a host-side editor for ACL-sensitive files.";
const SAVE_WARNING: &str = "SFTP keeps the original file at the backup path. Saving is recoverable, not an atomic compare-and-swap; POSIX owner/group/mode are preserved, but arbitrary ACLs are not guaranteed. Avoid concurrent external edits.";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    pub path: String,
    pub content: String,
    pub revision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    pub requires_access_confirmation: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Attributes {
    size: u64,
    uid: u32,
    gid: u32,
    mode: u32,
    modified: u32,
}

impl Attributes {
    fn inspect(attributes: &FileAttributes) -> Result<Self, String> {
        if !attributes.file_type().is_file() {
            return Err(
                "Only regular files can be edited; symbolic links are not supported.".into(),
            );
        }
        let missing =
            || "The SFTP server did not report the metadata required for safe editing.".to_owned();
        let result = Self {
            size: attributes.size.ok_or_else(missing)?,
            uid: attributes.uid.ok_or_else(missing)?,
            gid: attributes.gid.ok_or_else(missing)?,
            mode: attributes.permissions.ok_or_else(missing)?,
            modified: attributes.mtime.ok_or_else(missing)?,
        };
        if result.size > MAX_TEXT_BYTES as u64 {
            return Err("Text editing supports files up to 1 MiB.".into());
        }
        if result.mode & 0o7000 != 0 {
            return Err(
                "Files with special permission bits cannot be edited safely over SFTP.".into(),
            );
        }
        Ok(result)
    }

    fn same_access(&self, other: &Self) -> bool {
        self.uid == other.uid && self.gid == other.gid && self.mode == other.mode
    }
}

struct Snapshot {
    content: String,
    attributes: Attributes,
}

impl Snapshot {
    fn revision(&self, path: &str) -> String {
        let mut digest = Sha256::new();
        digest.update(b"latticeterm-sftp-text-v1\0");
        digest.update((path.len() as u64).to_be_bytes());
        digest.update(path.as_bytes());
        digest.update(self.attributes.size.to_be_bytes());
        digest.update(self.attributes.uid.to_be_bytes());
        digest.update(self.attributes.gid.to_be_bytes());
        digest.update(self.attributes.mode.to_be_bytes());
        digest.update(self.attributes.modified.to_be_bytes());
        digest.update(self.content.as_bytes());
        digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    fn into_file(self, path: &str) -> TextFile {
        TextFile {
            path: path.to_owned(),
            revision: self.revision(path),
            content: self.content,
            backup_path: None,
            warning: Some(READ_WARNING.to_owned()),
            requires_access_confirmation: self.attributes.mode & 0o077 != 0,
        }
    }
}

fn validate_text(content: &str) -> Result<(), String> {
    if content.len() > MAX_TEXT_BYTES {
        return Err("Text editing supports files up to 1 MiB.".into());
    }
    if content
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\t' | '\r' | '\n'))
    {
        return Err("The file contains binary data or unsupported control characters.".into());
    }
    Ok(())
}

fn validate_path(path: &str) -> Result<(&str, &str), String> {
    if path.len() > 4096
        || !path.starts_with('/')
        || path.contains('\\')
        || path.chars().any(char::is_control)
        || path[1..]
            .split('/')
            .any(|part| matches!(part, "" | "." | ".."))
    {
        return Err("Text editing requires an absolute file path without dot segments, control characters, or ambiguous separators.".into());
    }
    let (parent, name) = path.rsplit_once('/').ok_or("The file path is invalid.")?;
    Ok((if parent.is_empty() { "/" } else { parent }, name))
}

async fn checked_parent(session: &SftpSession, path: &str) -> Result<String, String> {
    let (parent, _) = validate_path(path)?;
    let canonical = session
        .canonicalize(parent)
        .await
        .map_err(|error| error.to_string())?;
    if canonical != parent {
        return Err(
            "Open this file from its canonical folder; symbolic-link folders are not editable."
                .into(),
        );
    }
    let attributes = session
        .symlink_metadata(parent)
        .await
        .map_err(|error| error.to_string())?;
    if !attributes.file_type().is_dir() {
        return Err("The parent is no longer a regular directory.".into());
    }
    Ok(parent.to_owned())
}

async fn read_snapshot(session: &SftpSession, path: &str) -> Result<Snapshot, String> {
    tokio::time::timeout(READ_TIMEOUT, async {
        checked_parent(session, path).await?;
        let before = Attributes::inspect(
            &session
                .symlink_metadata(path)
                .await
                .map_err(|error| error.to_string())?,
        )?;
        let mut file = session
            .open(path)
            .await
            .map_err(|error| error.to_string())?;
        let result = async {
            let opened =
                Attributes::inspect(&file.metadata().await.map_err(|error| error.to_string())?)?;
            if opened != before {
                return Err("The file changed while opening it. Reload before editing.".into());
            }
            let mut bytes = Vec::with_capacity(opened.size as usize);
            (&mut file)
                .take(MAX_TEXT_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
                .await
                .map_err(|error| error.to_string())?;
            let after =
                Attributes::inspect(&file.metadata().await.map_err(|error| error.to_string())?)?;
            let named = Attributes::inspect(
                &session
                    .symlink_metadata(path)
                    .await
                    .map_err(|error| error.to_string())?,
            )?;
            checked_parent(session, path).await?;
            if before != after || after != named || bytes.len() as u64 != after.size {
                return Err("The file changed while reading it. Reload before editing.".into());
            }
            let content = String::from_utf8(bytes)
                .map_err(|_| "Only UTF-8 text files can be edited.".to_owned())?;
            validate_text(&content)?;
            Ok(Snapshot {
                content,
                attributes: after,
            })
        }
        .await;
        let closed = file.close().await.map_err(|error| error.to_string());
        match (result, closed) {
            (Ok(snapshot), Ok(())) => Ok(snapshot),
            (Err(error), _) | (_, Err(error)) => Err(error),
        }
    })
    .await
    .map_err(|_| "Reading the remote text file timed out.".to_owned())?
}

pub async fn read_text_file(
    registry: &SftpRegistry,
    session_id: &str,
    path: &str,
) -> Result<TextFile, String> {
    validate_path(path)?;
    let gate = registry.text_gate(session_id, path)?;
    let _guard = gate
        .try_lock()
        .map_err(|_| "Another editor operation is already running for this file.".to_owned())?;
    let session = registry.session(session_id)?;
    Ok(read_snapshot(&session, path).await?.into_file(path))
}

pub async fn save_text_file(
    registry: &SftpRegistry,
    session_id: &str,
    path: &str,
    content: &str,
    revision: &str,
    acknowledge_access_change: bool,
) -> Result<TextFile, String> {
    validate_path(path)?;
    validate_text(content)?;
    let gate = registry.text_gate(session_id, path)?;
    let _guard = gate
        .try_lock()
        .map_err(|_| "Another editor operation is already running for this file.".to_owned())?;
    let session = registry.session(session_id)?;
    save_on_session(&session, path, content, revision, acknowledge_access_change).await
}

fn private_path(parent: &str, purpose: &str) -> Result<String, String> {
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|error| error.to_string())?;
    let token: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(join_path(
        parent,
        &format!(".latticeterm-edit-{purpose}-{token}"),
    ))
}

async fn clean_staging(session: &SftpSession, staging: &str, error: String) -> String {
    match session.remove_file(staging).await {
        Ok(()) => error,
        Err(cleanup) => {
            format!("{error} The temporary file could not be removed from '{staging}': {cleanup}")
        }
    }
}

async fn prepare_staging(
    session: &SftpSession,
    staging: &str,
    content: &str,
    original: &Attributes,
) -> Result<Snapshot, String> {
    let mut file = session
        .open_with_flags_and_attributes(
            staging,
            OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
            FileAttributes {
                permissions: Some(0o600),
                ..FileAttributes::empty()
            },
        )
        .await
        .map_err(|error| format!("Could not create the private editing file: {error}"))?;
    let result = async {
        let private =
            Attributes::inspect(&file.metadata().await.map_err(|error| error.to_string())?)?;
        if private.mode & 0o777 != 0o600 {
            return Err("The server did not establish private temporary-file permissions.".into());
        }
        file.write_all(content.as_bytes())
            .await
            .map_err(|error| error.to_string())?;
        file.flush().await.map_err(|error| error.to_string())?;
        file.set_metadata(FileAttributes {
            uid: Some(original.uid),
            gid: Some(original.gid),
            ..FileAttributes::empty()
        })
        .await
        .map_err(|error| format!("Could not preserve the original file owner/group: {error}"))?;
        file.set_metadata(FileAttributes {
            permissions: Some(original.mode & 0o777),
            ..FileAttributes::empty()
        })
        .await
        .map_err(|error| format!("Could not preserve the original file permissions: {error}"))?;
        // sync_all is best effort: russh-sftp returns Ok when the peer lacks
        // fsync@openssh.com. Do not claim power-loss durability.
        file.sync_all().await.map_err(|error| error.to_string())?;
        let confirmed =
            Attributes::inspect(&file.metadata().await.map_err(|error| error.to_string())?)?;
        if !original.same_access(&confirmed) || confirmed.size != content.len() as u64 {
            return Err(
                "The server could not verify the replacement owner, group, permissions, or size."
                    .into(),
            );
        }
        Ok(Snapshot {
            content: content.to_owned(),
            attributes: confirmed,
        })
    }
    .await;
    let closed = file.close().await.map_err(|error| error.to_string());
    match (result, closed) {
        (Ok(snapshot), Ok(())) => Ok(snapshot),
        (Err(error), _) | (_, Err(error)) => Err(clean_staging(session, staging, error).await),
    }
}

async fn restore_original(
    session: &SftpSession,
    path: &str,
    backup: &str,
    error: String,
) -> String {
    // The v3 rename must refuse an existing destination. Never remove a file
    // that appeared concurrently merely to make rollback succeed.
    match session.rename(backup, path).await {
        Ok(()) => format!("{error} The original file was restored."),
        Err(restore) => format!("{error} The original could not be restored without overwriting another file ({restore}); check the recovery copy at '{backup}' before retrying."),
    }
}

async fn save_on_session(
    session: &SftpSession,
    path: &str,
    content: &str,
    revision: &str,
    acknowledge_access_change: bool,
) -> Result<TextFile, String> {
    validate_path(path)?;
    validate_text(content)?;
    if revision.len() != 64 || !revision.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("The editing revision is invalid. Reload the file first.".into());
    }
    let original = read_snapshot(session, path).await?;
    if original.revision(path) != revision {
        return Err("The remote file changed after it was opened. Your draft was not saved; reload and reconcile the changes.".into());
    }
    if original.attributes.mode & 0o222 == 0 {
        return Err("The remote file is read-only. Its permissions were not changed.".into());
    }
    if original.attributes.mode & 0o077 != 0 && !acknowledge_access_change {
        return Err("This file grants group or other access. SFTP cannot verify ACLs: the replacement may inherit parent-folder ACLs and grant additional users access despite matching POSIX mode bits. Explicit confirmation is required for this save; no file was changed. Use a host-side editor for ACL-sensitive files.".into());
    }
    // Directory write access alone must not bypass the target's file access.
    // Neither CREATE nor TRUNCATE is set; this never changes original bytes.
    let writable = session
        .open_with_flags(path, OpenFlags::READ | OpenFlags::WRITE)
        .await
        .map_err(|error| format!("The remote file is not writable: {error}"))?;
    writable.close().await.map_err(|error| error.to_string())?;
    if original.content == content {
        return Ok(original.into_file(path));
    }
    let parent = checked_parent(session, path).await?;
    let staging = private_path(&parent, "staging")?;
    let backup = private_path(&parent, "backup")?;
    let replacement = prepare_staging(session, &staging, content, &original.attributes).await?;
    let current = match read_snapshot(session, path).await {
        Ok(current) if current.revision(path) == revision => current,
        Ok(_) => {
            return Err(clean_staging(
                session,
                &staging,
                "The remote file changed while saving. The original was not replaced.".into(),
            )
            .await)
        }
        Err(error) => return Err(clean_staging(session, &staging, error).await),
    };
    if let Err(error) = session.rename(path, &backup).await {
        // A disconnect can lose the reply after the server committed RENAME.
        // Recovery is no-clobber, and the backup is never deleted on an error.
        let detail = restore_original(
            session,
            path,
            &backup,
            format!("Could not confirm protection of the original file: {error}."),
        )
        .await;
        return Err(clean_staging(session, &staging, detail).await);
    }
    match read_snapshot(session, &backup).await {
        Ok(protected) if protected.revision(path) == current.revision(path) => {}
        result => {
            let reason = match result {
                Ok(_) => "The remote file changed during publication.".into(),
                Err(error) => format!("Could not verify the protected original: {error}"),
            };
            let detail = restore_original(session, path, &backup, reason).await;
            return Err(clean_staging(session, &staging, detail).await);
        }
    }
    // The temporary pathname can also be changed by another process. Verify
    // its bytes and access metadata before publishing that pathname.
    match read_snapshot(session, &staging).await {
        Ok(staged) if staged.revision(path) == replacement.revision(path) => {}
        result => {
            let reason = match result {
                Ok(_) => "The replacement file changed before publication.".into(),
                Err(error) => format!("Could not verify the replacement: {error}"),
            };
            let detail = restore_original(session, path, &backup, reason).await;
            return Err(clean_staging(session, &staging, detail).await);
        }
    }
    if let Err(error) = session.rename(&staging, path).await {
        let detail = restore_original(
            session,
            path,
            &backup,
            format!("Could not confirm publication of the edit: {error}."),
        )
        .await;
        return Err(clean_staging(session, &staging, detail).await);
    }
    // Keep the original inode: an external writer may still have it open.
    // Nothing fallible after confirmed publication turns success into failure.
    let mut saved = replacement.into_file(path);
    saved.backup_path = Some(backup);
    saved.warning = Some(SAVE_WARNING.to_owned());
    Ok(saved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_strict_without_trimming_real_names() {
        for path in [
            "",
            "/",
            "relative.txt",
            "/a/../b",
            "/a/./b",
            "/a//b",
            "/a/b/",
            "/a/\\b",
            "/a/\0b",
            "/a/\nb",
        ] {
            assert!(validate_path(path).is_err(), "{path:?}");
        }
        assert_eq!(
            validate_path("/folder/ file ").unwrap(),
            ("/folder", " file ")
        );
        assert_eq!(validate_path("/報表.txt").unwrap(), ("/", "報表.txt"));
    }

    #[test]
    fn text_limits_count_utf8_bytes_and_reject_binary_controls() {
        assert!(validate_text("\u{feff}報表\r\n\tOK\n").is_ok());
        assert!(validate_text(&"a".repeat(MAX_TEXT_BYTES)).is_ok());
        assert!(validate_text(&"a".repeat(MAX_TEXT_BYTES + 1)).is_err());
        assert!(validate_text(&"中".repeat(MAX_TEXT_BYTES / 3 + 1)).is_err());
        for text in ["a\0b", "\u{1b}[m", "\u{7f}", "\u{85}"] {
            assert!(validate_text(text).is_err());
        }
    }

    #[test]
    fn revision_detects_same_size_changes_and_permission_changes() {
        let mut snapshot = Snapshot {
            content: "one".into(),
            attributes: Attributes {
                size: 3,
                uid: 1,
                gid: 2,
                mode: 0o100640,
                modified: 42,
            },
        };
        let before = snapshot.revision("/a");
        snapshot.content = "two".into();
        assert_ne!(before, snapshot.revision("/a"));
        snapshot.content = "one".into();
        snapshot.attributes.mode = 0o100600;
        assert_ne!(before, snapshot.revision("/a"));
        assert_ne!(snapshot.revision("/a"), snapshot.revision("/b"));
    }

    #[test]
    fn missing_or_special_metadata_is_rejected() {
        assert!(Attributes::inspect(&FileAttributes::empty()).is_err());
        let attrs = FileAttributes {
            size: Some(1),
            uid: Some(1),
            gid: Some(1),
            permissions: Some(0o104600),
            mtime: Some(1),
            ..FileAttributes::empty()
        };
        assert!(Attributes::inspect(&attrs).is_err());
    }
}

#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
#[path = "sftp_text/openssh_tests.rs"]
mod openssh_tests;
