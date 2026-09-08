//! Bounded, optimistic text editing inside an explicitly shared root.
//!
//! Every save retains the displaced inode in a private recovery directory.
//! Filesystem checks and no-clobber publication prevent detected conflicts
//! from destroying either version. This is not a filesystem transaction or
//! a sandbox against a local process concurrently replacing path components.

use crate::{MAX_REMOTE_PATH_BYTES, MAX_TEXT_FILE_BYTES};
use sha2::{Digest, Sha256};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

const CONFLICT: &str = "The remote file changed outside this editor. Reload it before saving.";

pub fn editing_supported() -> bool {
    cfg!(any(target_os = "linux", target_os = "macos"))
}

pub const UNSUPPORTED_PLATFORM: &str = "This host platform does not yet support safe text editing with preserved file permissions. Linux and macOS hosts are supported; Windows hosts are not yet supported.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Identity {
    device: u64,
    inode: u64,
    links: u64,
}

impl Identity {
    fn same_file(self, other: Self) -> bool {
        self.device == other.device && self.inode == other.inode
    }
}

#[derive(Debug)]
struct PathGuard {
    directories: Vec<(PathBuf, Identity)>,
    target: PathBuf,
    virtual_path: String,
}

#[derive(Clone, Debug)]
pub struct TextRoot {
    path: PathBuf,
    identity: Option<Identity>,
}

impl TextRoot {
    pub fn open(root: &Path) -> Result<Self, String> {
        Ok(Self {
            path: root.to_path_buf(),
            // Disabled editors must not add filesystem requirements to
            // ordinary file sharing on unsupported host platforms.
            identity: if editing_supported() {
                Some(inspect_directory(root)?)
            } else {
                None
            },
        })
    }

    fn guard(&self, path: &str) -> Result<PathGuard, String> {
        let identity = self
            .identity
            .ok_or_else(|| UNSUPPORTED_PLATFORM.to_string())?;
        if !inspect_directory(&self.path)?.same_file(identity) {
            return Err(
                "The shared root was replaced. Restart sharing before editing files.".to_string(),
            );
        }
        let guard = PathGuard::new(&self.path, path)?;
        if !guard.directories[0].1.same_file(identity) {
            return Err("The shared root changed while opening the text file.".to_string());
        }
        Ok(guard)
    }

    pub fn read(&self, path: &str) -> Result<TextSnapshot, String> {
        self.guard(path)?.read().map(|(snapshot, _)| snapshot)
    }

    pub fn begin_save(
        &self,
        path: &str,
        expected_bytes: u64,
        expected_revision: [u8; 32],
    ) -> Result<HostTextUpload, String> {
        HostTextUpload::prepare(self.guard(path)?, expected_bytes, expected_revision)
    }
}

pub struct TextSnapshot {
    pub bytes: Vec<u8>,
    pub revision: [u8; 32],
}

#[derive(Debug)]
pub struct TextSaveOutcome {
    pub revision: [u8; 32],
    pub backup_path: String,
}

pub struct HostTextUpload {
    guard: PathGuard,
    expected_revision: [u8; 32],
    expected_bytes: u64,
    bytes: Vec<u8>,
}

fn io_error(context: &str, error: std::io::Error) -> String {
    // Do not include host absolute paths in wire-facing errors.
    format!("{context}: {error}")
}

fn open_nofollow(path: &Path) -> Result<File, String> {
    open_checked(path, false)
}

fn open_checked(path: &Path, writable: bool) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true).write(writable);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        };
        options.custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
    }
    options
        .open(path)
        .map_err(|error| io_error("Cannot open the text file safely", error))
}

fn metadata(file: &File) -> Result<Metadata, String> {
    file.metadata()
        .map_err(|error| io_error("Cannot inspect the text file", error))
}

#[cfg(unix)]
fn identity(_file: &File, metadata: &Metadata) -> Result<Identity, String> {
    use std::os::unix::fs::MetadataExt;
    Ok(Identity {
        device: metadata.dev(),
        inode: metadata.ino(),
        links: metadata.nlink(),
    })
}

#[cfg(windows)]
fn identity(file: &File, _metadata: &Metadata) -> Result<Identity, String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    let mut information = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
    // SAFETY: the borrowed file handle remains open and the output points to
    // a correctly sized Windows structure, read only after API success.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) } == 0 {
        return Err(io_error(
            "Cannot inspect the text file identity",
            std::io::Error::last_os_error(),
        ));
    }
    let information = unsafe { information.assume_init() };
    Ok(Identity {
        device: u64::from(information.dwVolumeSerialNumber),
        inode: (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow),
        links: u64::from(information.nNumberOfLinks),
    })
}

fn reject_link(metadata: &Metadata) -> Result<(), String> {
    let is_link = metadata.file_type().is_symlink();
    #[cfg(windows)]
    let is_link = {
        use std::os::windows::fs::MetadataExt;
        is_link || metadata.file_attributes() & 0x400 != 0
    };
    if is_link {
        return Err("Text editing does not follow symbolic links or reparse points.".to_string());
    }
    Ok(())
}

fn inspect_directory(path: &Path) -> Result<Identity, String> {
    let before = fs::symlink_metadata(path)
        .map_err(|error| io_error("The shared folder is unavailable", error))?;
    reject_link(&before)?;
    let file = open_nofollow(path)?;
    let opened = metadata(&file)?;
    reject_link(&opened)?;
    if !before.is_dir() || !opened.is_dir() {
        return Err("A text file parent is not a folder.".to_string());
    }
    identity(&file, &opened)
}

impl PathGuard {
    fn new(root: &Path, virtual_path: &str) -> Result<Self, String> {
        if virtual_path.is_empty()
            || virtual_path.len() > MAX_REMOTE_PATH_BYTES
            || !virtual_path.starts_with('/')
            || virtual_path.ends_with('/')
            || virtual_path.contains('\\')
            || virtual_path.chars().any(char::is_control)
            || virtual_path[1..]
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err("Choose a safe text file path inside the shared folder.".to_string());
        }
        let relative = Path::new(&virtual_path[1..]);
        #[cfg(windows)]
        if virtual_path[1..]
            .split('/')
            .any(|component| !safe_windows_component(component))
        {
            return Err("Text editing rejects Windows device names, alternate streams, and ambiguous file names.".to_string());
        }
        if relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err("The text file path is invalid.".to_string());
        }
        let mut current = root.to_path_buf();
        let mut directories = vec![(current.clone(), inspect_directory(&current)?)];
        if let Some(parent) = relative.parent() {
            for component in parent.components() {
                current.push(component);
                directories.push((current.clone(), inspect_directory(&current)?));
            }
        }
        let guard = Self {
            directories,
            target: root.join(relative),
            virtual_path: virtual_path.to_string(),
        };
        guard.verify()?;
        Ok(guard)
    }

    fn verify(&self) -> Result<(), String> {
        for (path, expected) in &self.directories {
            if !inspect_directory(path)?.same_file(*expected) {
                return Err(
                    "The shared folder changed while editing. Reconnect before saving.".to_string(),
                );
            }
        }
        Ok(())
    }

    fn read(&self) -> Result<(TextSnapshot, Metadata), String> {
        self.verify()?;
        let result = read_regular(&self.target)?;
        self.verify()?;
        Ok(result)
    }
}

#[cfg(any(windows, test))]
fn safe_windows_component(value: &str) -> bool {
    if value.contains(':') || value.ends_with([' ', '.']) {
        return false;
    }
    let stem = value
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    !matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) && !((stem.starts_with("COM") || stem.starts_with("LPT"))
        && matches!(stem.chars().nth(3), Some('1'..='9' | '¹' | '²' | '³'))
        && stem.chars().count() == 4)
}

fn verify_writable_target(path: &Path, snapshot: &TextSnapshot) -> Result<File, String> {
    let file = open_checked(path, true)?;
    let metadata = metadata(&file)?;
    let identity = validate_metadata(&file, &metadata)?;
    validate_writable(&metadata)?;
    reject_extended_attributes(&file)?;
    if revision(&snapshot.bytes, &metadata, identity) != snapshot.revision {
        return Err(CONFLICT.to_string());
    }
    Ok(file)
}

fn reject_extended_attributes(file: &File) -> Result<(), String> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        use std::os::fd::AsRawFd;
        #[cfg(target_os = "linux")]
        let count = unsafe { libc::flistxattr(file.as_raw_fd(), std::ptr::null_mut(), 0) };
        #[cfg(target_os = "macos")]
        let count = unsafe { libc::flistxattr(file.as_raw_fd(), std::ptr::null_mut(), 0, 0) };
        if count > 0 {
            return Err(
                "Text saving does not replace files with extended attributes or ACLs.".to_string(),
            );
        }
        if count < 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ENOTSUP) {
                return Err(io_error(
                    "Cannot inspect extended file attributes safely",
                    error,
                ));
            }
        }
        #[cfg(target_os = "macos")]
        mac_acl::reject_acl(file)?;
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let _ = file;
    Ok(())
}

fn reject_inherited_acl(parent: &Path) -> Result<(), String> {
    let file = open_nofollow(parent)?;
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        let result = unsafe {
            libc::fgetxattr(
                file.as_raw_fd(),
                c"system.posix_acl_default".as_ptr(),
                std::ptr::null_mut(),
                0,
            )
        };
        if result >= 0 {
            return Err(
                "Text saving does not create replacement files in a folder with an inherited ACL."
                    .to_string(),
            );
        }
        let error = std::io::Error::last_os_error();
        if !matches!(error.raw_os_error(), Some(libc::ENODATA | libc::ENOTSUP)) {
            return Err(io_error(
                "Cannot inspect inherited file permissions safely",
                error,
            ));
        }
    }
    #[cfg(target_os = "macos")]
    mac_acl::reject_acl(&file)?;
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let _ = file;
    Ok(())
}

#[cfg(target_os = "macos")]
mod mac_acl {
    use super::*;
    use std::os::fd::AsRawFd;

    // Signatures/constants from Apple's public <sys/acl.h>. libc's Rust
    // bindings currently omit these APIs:
    // https://github.com/apple-oss-distributions/Libc/blob/main/include/sys/acl.h
    unsafe extern "C" {
        fn acl_get_fd_np(fd: libc::c_int, kind: libc::c_int) -> *mut libc::c_void;
        fn acl_get_entry(
            acl: *mut libc::c_void,
            entry: libc::c_int,
            output: *mut *mut libc::c_void,
        ) -> libc::c_int;
        fn acl_valid(acl: *mut libc::c_void) -> libc::c_int;
        fn acl_free(acl: *mut libc::c_void) -> libc::c_int;
    }

    pub(super) fn reject_acl(file: &File) -> Result<(), String> {
        // SAFETY: the borrowed FD remains valid throughout retrieval. Every
        // non-null ACL is released once, after the entry query completes.
        let acl = unsafe { acl_get_fd_np(file.as_raw_fd(), 0x100) };
        if acl.is_null() {
            let error = std::io::Error::last_os_error();
            // Apple's filesec_get_property returns ENOENT for an absent ACL;
            // filesystems without ACL support return ENOTSUP.
            return if matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ENOTSUP)) {
                Ok(())
            } else {
                Err(io_error("Cannot inspect macOS file ACLs safely", error))
            };
        }
        if acl as usize == 1 {
            return Err("Cannot inspect a macOS ACL removal marker safely.".to_string());
        }
        if unsafe { acl_valid(acl) } != 0 {
            unsafe { acl_free(acl) };
            return Err("Cannot inspect an invalid macOS file ACL safely.".to_string());
        }
        let mut entry = std::ptr::null_mut();
        let result = unsafe { acl_get_entry(acl, 0, &mut entry) };
        let error = std::io::Error::last_os_error();
        unsafe { acl_free(acl) };
        // Unlike Linux, Darwin returns zero for an entry and -1/EINVAL for
        // an empty valid ACL (see Apple's posix1e/acl_entry.c).
        if result == -1 && error.raw_os_error() == Some(libc::EINVAL) {
            Ok(())
        } else if result == 0 {
            Err("Text saving does not replace files or folders with macOS ACLs.".to_string())
        } else {
            Err(io_error("Cannot inspect macOS ACL entries safely", error))
        }
    }
}

fn validate_metadata(file: &File, metadata: &Metadata) -> Result<Identity, String> {
    reject_link(metadata)?;
    if !metadata.is_file() {
        return Err("Only regular files can be edited.".to_string());
    }
    if metadata.len() > MAX_TEXT_FILE_BYTES as u64 {
        return Err("The text file is larger than 1 MiB.".to_string());
    }
    let identity = identity(file, metadata)?;
    if identity.links != 1 {
        return Err("Text editing does not replace hard-linked files.".to_string());
    }
    Ok(identity)
}

fn validate_writable(metadata: &Metadata) -> Result<(), String> {
    if metadata.permissions().readonly() {
        return Err("The text file is read-only.".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // Replacing another user's file changes ownership; setuid/setgid and
        // sticky modes also have semantics that a text editor must not copy.
        if metadata.mode() & 0o7000 != 0 || metadata.uid() != unsafe { libc::geteuid() } {
            return Err(
                "Text editing requires an owned file without special permission bits.".to_string(),
            );
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_ATTRIBUTE_ARCHIVE, FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_NORMAL,
            FILE_ATTRIBUTE_NOT_CONTENT_INDEXED,
        };
        let supported = FILE_ATTRIBUTE_ARCHIVE
            | FILE_ATTRIBUTE_HIDDEN
            | FILE_ATTRIBUTE_NORMAL
            | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED;
        if metadata.file_attributes() & !supported != 0 {
            return Err(
                "Text editing does not replace files with special Windows attributes.".to_string(),
            );
        }
    }
    Ok(())
}

pub fn validate_text(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_TEXT_FILE_BYTES {
        return Err("The text file is larger than 1 MiB.".to_string());
    }
    let text =
        std::str::from_utf8(bytes).map_err(|_| "The file is not valid UTF-8 text.".to_string())?;
    if text
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\r' | '\n' | '\t'))
    {
        return Err("The file contains binary or unsupported control characters.".to_string());
    }
    Ok(())
}

fn revision(bytes: &[u8], metadata: &Metadata, identity: Identity) -> [u8; 32] {
    let mut digest = Sha256::new();
    digest.update(b"lattice-text-v1\0");
    digest.update(identity.device.to_le_bytes());
    digest.update(identity.inode.to_le_bytes());
    digest.update(metadata.len().to_le_bytes());
    if let Ok(modified) = metadata.modified().and_then(|time| {
        time.duration_since(UNIX_EPOCH)
            .map_err(std::io::Error::other)
    }) {
        digest.update(modified.as_secs().to_le_bytes());
        digest.update(modified.subsec_nanos().to_le_bytes());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        digest.update(metadata.mode().to_le_bytes());
        digest.update(metadata.uid().to_le_bytes());
        digest.update(metadata.gid().to_le_bytes());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        digest.update(metadata.file_attributes().to_le_bytes());
    }
    digest.update(bytes);
    digest.finalize().into()
}

fn read_regular(path: &Path) -> Result<(TextSnapshot, Metadata), String> {
    let before = fs::symlink_metadata(path)
        .map_err(|error| io_error("The text file is unavailable", error))?;
    reject_link(&before)?;
    if !before.is_file() {
        return Err("Only regular files can be edited.".to_string());
    }
    let file = open_nofollow(path)?;
    let before = metadata(&file)?;
    let before_id = validate_metadata(&file, &before)?;
    let mut bytes = Vec::with_capacity(before.len() as usize);
    (&file)
        .take(MAX_TEXT_FILE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| io_error("Cannot read the text file", error))?;
    validate_text(&bytes)?;
    let after = metadata(&file)?;
    let after_id = validate_metadata(&file, &after)?;
    if revision(&bytes, &before, before_id) != revision(&bytes, &after, after_id)
        || after.len() != bytes.len() as u64
    {
        return Err(CONFLICT.to_string());
    }
    let path_file = open_nofollow(path)?;
    let path_metadata = metadata(&path_file)?;
    let path_id = validate_metadata(&path_file, &path_metadata)?;
    if revision(&bytes, &after, after_id) != revision(&bytes, &path_metadata, path_id) {
        return Err(CONFLICT.to_string());
    }
    Ok((
        TextSnapshot {
            revision: revision(&bytes, &after, after_id),
            bytes,
        },
        after,
    ))
}

pub fn read(root: &Path, path: &str) -> Result<TextSnapshot, String> {
    TextRoot::open(root)?.read(path)
}

impl HostTextUpload {
    pub fn begin(
        root: &Path,
        path: &str,
        expected_bytes: u64,
        expected_revision: [u8; 32],
    ) -> Result<Self, String> {
        TextRoot::open(root)?.begin_save(path, expected_bytes, expected_revision)
    }

    fn prepare(
        guard: PathGuard,
        expected_bytes: u64,
        expected_revision: [u8; 32],
    ) -> Result<Self, String> {
        if expected_bytes > MAX_TEXT_FILE_BYTES as u64 {
            return Err("The text file is larger than 1 MiB.".to_string());
        }
        let (current, metadata) = guard.read()?;
        validate_writable(&metadata)?;
        if current.revision != expected_revision {
            return Err(CONFLICT.to_string());
        }
        guard.verify()?;
        let _writable = verify_writable_target(&guard.target, &current)?;
        reject_inherited_acl(guard.target.parent().expect("validated file parent"))?;
        guard.verify()?;
        Ok(Self {
            guard,
            expected_revision,
            expected_bytes,
            bytes: Vec::with_capacity(expected_bytes as usize),
        })
    }

    pub fn destination(&self) -> &Path {
        &self.guard.target
    }

    pub fn write_chunk(&mut self, bytes: &[u8]) -> Result<u64, String> {
        let next = self.bytes.len().saturating_add(bytes.len());
        if bytes.is_empty() || next as u64 > self.expected_bytes {
            return Err("The text save contains more bytes than announced.".to_string());
        }
        self.bytes.extend_from_slice(bytes);
        Ok(next as u64)
    }

    pub fn finish(self) -> Result<TextSaveOutcome, String> {
        self.finish_with(|_, _| {})
    }

    fn finish_with(
        self,
        before_publish: impl FnOnce(&Path, &Path),
    ) -> Result<TextSaveOutcome, String> {
        if self.bytes.len() as u64 != self.expected_bytes {
            return Err("The text save ended before all bytes arrived.".to_string());
        }
        validate_text(&self.bytes)?;
        let (current, metadata) = self.guard.read()?;
        validate_writable(&metadata)?;
        if current.revision != self.expected_revision {
            return Err(CONFLICT.to_string());
        }
        self.guard.verify()?;
        let _writable = verify_writable_target(&self.guard.target, &current)?;
        self.guard.verify()?;
        let parent = self
            .guard
            .target
            .parent()
            .expect("validated text file parent");
        reject_inherited_acl(parent)?;
        self.guard.verify()?;
        let mut staged = tempfile::Builder::new()
            .prefix(".latticeterm-edit-")
            .suffix(".part")
            .tempfile_in(parent)
            .map_err(|error| io_error("Cannot prepare the text save", error))?;
        self.guard.verify()?;
        reject_extended_attributes(staged.as_file())?;
        staged
            .write_all(&self.bytes)
            .map_err(|error| io_error("Cannot prepare the text save", error))?;
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            use std::os::unix::fs::MetadataExt;
            // Keep group ownership as well as the mode. A parent setgid bit
            // may otherwise silently assign the staged file to another group.
            if unsafe { libc::fchown(staged.as_raw_fd(), metadata.uid(), metadata.gid()) } != 0 {
                return Err(io_error(
                    "Cannot preserve the original file ownership",
                    std::io::Error::last_os_error(),
                ));
            }
        }
        staged
            .as_file()
            .set_permissions(metadata.permissions())
            .map_err(|error| io_error("Cannot preserve the original file permissions", error))?;
        staged
            .as_file()
            .sync_all()
            .map_err(|error| io_error("Cannot finish the text save safely", error))?;
        // Closing the writable handle also finalises Windows last-write
        // metadata, so the returned revision is usable on the next save.
        let staged = staged.into_temp_path();
        let staged_file = open_nofollow(&staged)?;
        let saved_metadata = staged_file
            .metadata()
            .map_err(|error| io_error("Cannot inspect the prepared text file", error))?;
        let saved_revision = revision(
            &self.bytes,
            &saved_metadata,
            identity(&staged_file, &saved_metadata)?,
        );

        self.guard.verify()?;
        let recovery = tempfile::Builder::new()
            .prefix(".latticeterm-edit-backup-")
            .tempdir_in(parent)
            .map_err(|error| io_error("Cannot prepare a private text backup", error))?;
        let recovery_identity = inspect_directory(recovery.path())?;
        let backup_name = recovery
            .path()
            .file_name()
            .and_then(|name| name.to_str())
            .expect("temporary ASCII folder name");
        let target_name = self.guard.target.file_name().expect("validated file name");
        let virtual_parent = self
            .guard
            .virtual_path
            .rsplit_once('/')
            .expect("virtual absolute path")
            .0;
        let backup_path = format!(
            "{virtual_parent}/{backup_name}/{}",
            target_name.to_string_lossy()
        );
        if backup_path.len() > MAX_REMOTE_PATH_BYTES {
            return Err(
                "The text file path is too long to retain a recovery copy safely.".to_string(),
            );
        }
        self.guard.verify()?;
        let (latest, _) = self.guard.read()?;
        if latest.revision != self.expected_revision {
            return Err(CONFLICT.to_string());
        }
        reject_inherited_acl(parent)?;
        let _writable = verify_writable_target(&self.guard.target, &latest)?;
        self.guard.verify()?;
        let backup = recovery.path().join(target_name);
        if !inspect_directory(recovery.path())?.same_file(recovery_identity) {
            return Err("The recovery directory changed before the text save.".to_string());
        }
        fs::rename(&self.guard.target, &backup)
            .map_err(|error| io_error("Cannot safeguard the original text file", error))?;
        // Once the original was moved, never let automatic temporary-folder
        // cleanup erase it, even when a later syscall fails.
        let _recovery_directory = recovery.keep();
        before_publish(&self.guard.target, &backup);
        let publish = (|| {
            self.guard.verify()?;
            if !inspect_directory(&_recovery_directory)?.same_file(recovery_identity) {
                return Err("The recovery directory changed during the text save.".to_string());
            }
            let (displaced, _) = read_regular(&backup)?;
            reject_extended_attributes(&open_nofollow(&backup)?)?;
            if displaced.revision != self.expected_revision {
                return Err(CONFLICT.to_string());
            }
            self.guard.verify()?;
            let stage_check = open_nofollow(&staged)?;
            reject_extended_attributes(&stage_check)?;
            if !identity(
                &stage_check,
                &stage_check
                    .metadata()
                    .map_err(|error| io_error("Cannot inspect the text staging file", error))?,
            )?
            .same_file(identity(&staged_file, &saved_metadata)?)
            {
                return Err("The staged text file changed before publication.".to_string());
            }
            #[cfg(unix)]
            {
                open_nofollow(&_recovery_directory)?
                    .sync_all()
                    .map_err(|error| io_error("Cannot sync the original text backup", error))?;
                self.guard.verify()?;
                open_nofollow(parent)?
                    .sync_all()
                    .map_err(|error| io_error("Cannot sync the protected text file", error))?;
                self.guard.verify()?;
            }
            // Atomically create-if-absent. Never rename over a path another
            // writer recreated during the safeguard/publish interval.
            fs::hard_link(&staged, &self.guard.target).map_err(|error| {
                io_error(
                    "Cannot publish the text save without overwriting another file",
                    error,
                )
            })?;
            #[cfg(unix)]
            {
                self.guard.verify()?;
                open_nofollow(parent)?.sync_all().map_err(|error| {
                    io_error(
                        "The text was published but the folder could not be synced",
                        error,
                    )
                })?;
            }
            Ok(())
        })();
        if let Err(error) = publish {
            // Restore only into an absent target; if another writer claimed
            // it, preserve that version and expose the original recovery path.
            if self.guard.verify().is_ok() && fs::hard_link(&backup, &self.guard.target).is_ok() {
                return Err(format!("{error} The original was restored and a recovery link remains at {backup_path}. Remove that recovery link after checking both copies before editing again."));
            }
            return Err(format!(
                "{error} The original is retained at {backup_path}; recovery may be required."
            ));
        }
        drop(staged);
        // The old inode intentionally remains: an external process may still
        // have an open writable handle to it after this successful save.
        Ok(TextSaveOutcome {
            revision: saved_revision,
            backup_path,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_limits_preserve_empty_utf8_bom_and_newlines() {
        for content in ["", "\u{feff}繁體中文\r\n\tend\r"] {
            assert!(validate_text(content.as_bytes()).is_ok());
        }
        assert!(validate_text(&vec![b'a'; MAX_TEXT_FILE_BYTES]).is_ok());
        assert!(validate_text(&vec![b'a'; MAX_TEXT_FILE_BYTES + 1]).is_err());
        assert!(validate_text(&[0xff]).is_err());
        assert!(validate_text(b"binary\0text").is_err());
        assert!(validate_text(b"escape\x1btext").is_err());
    }

    #[test]
    fn windows_device_stream_and_ambiguous_names_are_rejected() {
        for name in [
            "file.txt:secret",
            "COM1",
            "COM1.txt",
            "LPT9",
            "COM¹",
            "con",
            "NUL.md",
            "AUX",
            "file.",
            "file ",
        ] {
            assert!(!safe_windows_component(name), "{name}");
        }
        for name in ["note.txt", "中文.md", "COM10", "COMPANY.txt", "file.name"] {
            assert!(safe_windows_component(name), "{name}");
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_extended_attributes_and_inherited_acls_are_not_silently_dropped() {
        use std::os::fd::AsRawFd;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("note.txt");
        fs::write(&path, b"original").unwrap();
        let file = open_checked(&path, true).unwrap();
        let value = b"retained metadata";
        assert_eq!(
            unsafe {
                libc::fsetxattr(
                    file.as_raw_fd(),
                    c"user.latticeterm-test".as_ptr(),
                    value.as_ptr().cast(),
                    value.len(),
                    0,
                )
            },
            0,
            "fixture filesystem must support user xattrs"
        );
        let revision = read(root.path(), "/note.txt").unwrap().revision;
        assert!(HostTextUpload::begin(root.path(), "/note.txt", 0, revision)
            .err()
            .unwrap()
            .contains("extended attributes"));
        assert_eq!(
            unsafe { libc::fremovexattr(file.as_raw_fd(), c"user.latticeterm-test".as_ptr()) },
            0
        );
        let parent = open_nofollow(root.path()).unwrap();
        // Linux's documented POSIX ACL xattr wire layout: version 2, then
        // owner/group/other entries with undefined IDs. A minimal default ACL
        // is still inherited and must not be silently replaced by plain mode.
        let mut acl = 2_u32.to_le_bytes().to_vec();
        for (tag, permissions) in [(1_u16, 7_u16), (4, 5), (32, 0)] {
            acl.extend_from_slice(&tag.to_le_bytes());
            acl.extend_from_slice(&permissions.to_le_bytes());
            acl.extend_from_slice(&u32::MAX.to_le_bytes());
        }
        assert_eq!(
            unsafe {
                libc::fsetxattr(
                    parent.as_raw_fd(),
                    c"system.posix_acl_default".as_ptr(),
                    acl.as_ptr().cast(),
                    acl.len(),
                    0,
                )
            },
            0,
            "fixture filesystem must support POSIX default ACLs"
        );
        let revision = read(root.path(), "/note.txt").unwrap().revision;
        assert!(HostTextUpload::begin(root.path(), "/note.txt", 0, revision)
            .err()
            .unwrap()
            .contains("inherited ACL"));
        assert_eq!(fs::read(path).unwrap(), b"original");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_nonempty_acls_are_rejected_without_changing_the_file() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("note.txt");
        fs::write(&path, b"original").unwrap();
        let initial = read(root.path(), "/note.txt").unwrap().revision;
        assert!(HostTextUpload::begin(root.path(), "/note.txt", 0, initial).is_ok());
        assert!(std::process::Command::new("/bin/chmod")
            .args(["+a", "everyone allow read"])
            .arg(&path)
            .status()
            .unwrap()
            .success());
        let revision = read(root.path(), "/note.txt").unwrap().revision;
        assert!(HostTextUpload::begin(root.path(), "/note.txt", 0, revision)
            .err()
            .unwrap()
            .contains("ACL"));
        assert_eq!(fs::read(path).unwrap(), b"original");
    }

    #[cfg(windows)]
    #[test]
    fn windows_hosts_fail_closed_without_an_acl_preserving_editor() {
        let root = tempfile::tempdir().unwrap();
        let unavailable = TextRoot::open(&root.path().join("missing")).unwrap();
        assert!(unavailable.identity.is_none());
        assert!(unavailable.read("/note.txt").is_err());
        assert!(unavailable.begin_save("/note.txt", 0, [0; 32]).is_err());
        fs::write(root.path().join("note.txt"), b"original").unwrap();
        let shared = TextRoot::open(root.path()).unwrap();
        assert!(!editing_supported());
        assert!(shared
            .read("/note.txt")
            .err()
            .unwrap()
            .contains("Windows hosts are not yet supported"));
        assert!(shared
            .begin_save("/note.txt", 0, [0; 32])
            .err()
            .unwrap()
            .contains("Windows hosts are not yet supported"));
        assert_eq!(fs::read(root.path().join("note.txt")).unwrap(), b"original");
    }

    #[cfg(unix)]
    #[test]
    fn destination_recreated_during_publish_is_not_overwritten_and_backup_survives() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("note.txt");
        fs::write(&path, b"original").unwrap();
        let revision = read(root.path(), "/note.txt").unwrap().revision;
        let mut upload = HostTextUpload::begin(root.path(), "/note.txt", 6, revision).unwrap();
        upload.write_chunk(b"editor").unwrap();
        let error = upload
            .finish_with(|target, backup| {
                assert_eq!(fs::read(backup).unwrap(), b"original");
                fs::write(target, b"external writer").unwrap();
            })
            .unwrap_err();
        assert!(error.contains("original is retained"));
        assert_eq!(fs::read(&path).unwrap(), b"external writer");
        let recovery = fs::read_dir(root.path())
            .unwrap()
            .find_map(|entry| {
                let path = entry.unwrap().path();
                path.is_dir().then_some(path.join("note.txt"))
            })
            .unwrap();
        assert_eq!(fs::read(recovery).unwrap(), b"original");
    }

    #[cfg(unix)]
    #[test]
    fn displaced_original_is_rechecked_and_restored_without_losing_external_writes() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("note.txt");
        fs::write(&path, b"original").unwrap();
        let revision = read(root.path(), "/note.txt").unwrap().revision;
        let upload = HostTextUpload::begin(root.path(), "/note.txt", 0, revision).unwrap();
        let error = upload
            .finish_with(|_, backup| {
                fs::write(backup, b"external write on original inode").unwrap();
            })
            .unwrap_err();
        assert!(error.contains("changed outside") && error.contains("restored"));
        assert_eq!(
            fs::read(&path).unwrap(),
            b"external write on original inode"
        );
        // The retained recovery hard link deliberately requires manual review
        // rather than silently deleting the last copy after a restore race.
        assert!(read(root.path(), "/note.txt").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn save_retains_original_and_returns_revision_for_the_next_save() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("note.txt");
        fs::write(&path, b"original").unwrap();
        let before = read(root.path(), "/note.txt").unwrap();
        let mut upload =
            HostTextUpload::begin(root.path(), "/note.txt", 7, before.revision).unwrap();
        upload.write_chunk("中文\n".as_bytes()).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"original");
        let result = upload.finish().unwrap();
        assert_eq!(
            fs::read(root.path().join(&result.backup_path[1..])).unwrap(),
            b"original"
        );
        assert_eq!(fs::read(&path).unwrap(), "中文\n".as_bytes());
        assert_eq!(
            read(root.path(), "/note.txt").unwrap().revision,
            result.revision
        );
        let second = HostTextUpload::begin(root.path(), "/note.txt", 0, result.revision)
            .unwrap()
            .finish()
            .unwrap();
        assert!(fs::read(&path).unwrap().is_empty());
        assert_eq!(
            fs::read(root.path().join(&second.backup_path[1..])).unwrap(),
            "中文\n".as_bytes()
        );
    }

    #[cfg(unix)]
    #[test]
    fn same_size_external_edits_and_incomplete_saves_preserve_the_file() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("note.txt");
        fs::write(&path, b"before").unwrap();
        let before = read(root.path(), "/note.txt").unwrap();
        let mut upload =
            HostTextUpload::begin(root.path(), "/note.txt", 6, before.revision).unwrap();
        upload.write_chunk(b"editor").unwrap();
        fs::write(&path, b"extern").unwrap();
        assert!(upload.finish().unwrap_err().contains("changed outside"));
        assert_eq!(fs::read(&path).unwrap(), b"extern");
        assert!(HostTextUpload::begin(root.path(), "/note.txt", 6, before.revision).is_err());
        let revision = read(root.path(), "/note.txt").unwrap().revision;
        assert!(HostTextUpload::begin(root.path(), "/note.txt", 1, revision)
            .unwrap()
            .finish()
            .is_err());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[test]
    fn rejects_unsafe_paths_directories_hardlinks_and_binary_files() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("note.txt"), b"text").unwrap();
        for path in [
            "/",
            "note.txt",
            "/../note.txt",
            "/./note.txt",
            "/folder//note.txt",
            "/bad\\name",
            "/bad\0name",
        ] {
            assert!(read(root.path(), path).is_err(), "{path:?}");
        }
        fs::create_dir(root.path().join("folder")).unwrap();
        assert!(read(root.path(), "/folder").is_err());
        fs::hard_link(root.path().join("note.txt"), root.path().join("linked.txt")).unwrap();
        assert!(read(root.path(), "/linked.txt").is_err());
        fs::write(root.path().join("binary"), [0xff]).unwrap();
        assert!(read(root.path(), "/binary").is_err());
        fs::write(
            root.path().join("large"),
            vec![b'a'; MAX_TEXT_FILE_BYTES + 1],
        )
        .unwrap();
        assert!(read(root.path(), "/large").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn sharing_root_identity_remains_pinned_and_readonly_files_cannot_be_saved() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("shared");
        fs::create_dir(&root).unwrap();
        let path = root.join("note.txt");
        fs::write(&path, b"original").unwrap();
        let shared = TextRoot::open(&root).unwrap();
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        let writable = permissions.clone();
        permissions.set_readonly(true);
        fs::set_permissions(&path, permissions).unwrap();
        let revision = shared.read("/note.txt").unwrap().revision;
        assert!(shared.begin_save("/note.txt", 0, revision).is_err());
        fs::set_permissions(&path, writable).unwrap();
        fs::rename(&root, temporary.path().join("original")).unwrap();
        fs::create_dir(&root).unwrap();
        fs::write(&path, b"replacement").unwrap();
        assert!(shared.read("/note.txt").is_err());
        assert!(shared.begin_save("/note.txt", 0, revision).is_err());
        assert_eq!(fs::read(path).unwrap(), b"replacement");
    }

    #[cfg(unix)]
    #[test]
    fn invalid_text_save_is_rejected_before_creating_a_backup() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("note.txt");
        fs::write(&path, b"original").unwrap();
        let revision = read(root.path(), "/note.txt").unwrap().revision;
        let mut upload = HostTextUpload::begin(root.path(), "/note.txt", 1, revision).unwrap();
        upload.write_chunk(&[0xff]).unwrap();
        assert!(upload.finish().is_err());
        assert_eq!(fs::read(path).unwrap(), b"original");
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn preserves_mode_and_rejects_links_special_modes_and_parent_replacement() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("folder")).unwrap();
        let path = root.path().join("folder/note.txt");
        fs::write(&path, b"before").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        let revision = read(root.path(), "/folder/note.txt").unwrap().revision;
        let mut upload =
            HostTextUpload::begin(root.path(), "/folder/note.txt", 5, revision).unwrap();
        upload.write_chunk(b"after").unwrap();
        upload.finish().unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640
        );
        symlink("folder/note.txt", root.path().join("link")).unwrap();
        symlink(outside.path(), root.path().join("escape")).unwrap();
        assert!(read(root.path(), "/link").is_err());
        assert!(read(root.path(), "/escape/note.txt").is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o4640)).unwrap();
        let revision = read(root.path(), "/folder/note.txt").unwrap().revision;
        assert!(HostTextUpload::begin(root.path(), "/folder/note.txt", 0, revision).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        let revision = read(root.path(), "/folder/note.txt").unwrap().revision;
        let upload = HostTextUpload::begin(root.path(), "/folder/note.txt", 0, revision).unwrap();
        fs::rename(
            root.path().join("folder"),
            root.path().join("original-folder"),
        )
        .unwrap();
        symlink(outside.path(), root.path().join("folder")).unwrap();
        assert!(upload.finish().is_err());
        assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
        assert_eq!(
            fs::read(root.path().join("original-folder/note.txt")).unwrap(),
            b"after"
        );
    }
}
