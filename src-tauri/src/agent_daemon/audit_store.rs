//! Private, bounded snapshots, not an append-only or tamper-evident ledger.
//! The worker never runs file I/O under the daemon's history mutex. A single
//! pending snapshot coalesces bursts without retaining an unbounded queue.
//! Checks reject detected external changes; they are not a sandbox against a
//! malicious process running as the same OS user or a privileged administrator.

use super::{Entry, PersistenceReason as Reason, PersistenceState as State, HISTORY_LIMIT};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, SystemTime};

const DIRECTORY: &str = "agent-mcp-audit";
const FILE_NAME: &str = "history.json";
const LOCK_NAME: &str = "writer.lock";
const VERSION: u32 = 1;
const MAX_BYTES: u64 = 256 * 1024;
const DROP_FLUSH: Duration = Duration::from_millis(250);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DiskHistory {
    version: u32,
    pub entries: Vec<Entry>,
    pub next: u64,
    pub discarded: u64,
}

impl DiskHistory {
    pub fn new(entries: Vec<Entry>, next: u64, discarded: u64) -> Self {
        Self {
            version: VERSION,
            entries,
            next,
            discarded,
        }
    }

    fn validate(&self) -> Result<(), Reason> {
        if self.version != VERSION || self.entries.len() > HISTORY_LIMIT || self.next == u64::MAX {
            return Err(Reason::InvalidData);
        }
        for (index, entry) in self.entries.iter().enumerate() {
            if entry.id
                != self
                    .discarded
                    .saturating_add(index as u64)
                    .saturating_add(1)
                || entry.id > self.next
                || entry.client.chars().count() > 128
                || entry.client.chars().any(char::is_control)
                || entry.session_id.as_ref().is_some_and(|id| {
                    !id.starts_with("agent-bg-session-")
                        || id.len() <= "agent-bg-session-".len()
                        || id.len() > 128
                        || !id
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                })
                || entry.target_id.as_ref().is_some_and(|id| {
                    id.is_empty()
                        || id.len() > 128
                        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                })
                || (entry.session_id.is_some() && entry.target_id.is_some())
            {
                return Err(Reason::InvalidData);
            }
        }
        if self
            .entries
            .last()
            .map_or(self.next != 0, |entry| entry.id != self.next)
            || self.discarded != self.next.saturating_sub(self.entries.len() as u64)
        {
            return Err(Reason::InvalidData);
        }
        Ok(())
    }
}

type Status = (State, Option<u64>, Option<Reason>);

struct Pending {
    latest: Option<DiskHistory>,
    closing: bool,
    status: Status,
}

struct Shared {
    pending: Mutex<Pending>,
    changed: Condvar,
}

pub(super) struct Worker {
    shared: Arc<Shared>,
    completed: mpsc::Receiver<()>,
}

/// A captured submission boundary, independent of the History/registry Arc
/// lifetime. Waiting never requires the daemon's history mutex.
pub struct FlushHandle {
    shared: Arc<Shared>,
    through: u64,
}

impl FlushHandle {
    /// Return whether this boundary reached disk. The requested budget is
    /// clamped to 250 ms even if a caller supplies a longer timeout. A broken
    /// worker or failed write cannot make shutdown wait indefinitely.
    pub fn flush(self, timeout: Duration) -> bool {
        let pending = self
            .shared
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let (pending, _) = self
            .shared
            .changed
            .wait_timeout_while(pending, timeout.min(DROP_FLUSH), |pending| {
                pending.status.1.unwrap_or(0) < self.through
                    && pending.status.0 != State::Unavailable
            })
            .unwrap_or_else(|e| e.into_inner());
        pending.status.1.unwrap_or(0) >= self.through
    }
}

impl Worker {
    pub fn flush_handle(&self, through: u64) -> FlushHandle {
        FlushHandle {
            shared: Arc::clone(&self.shared),
            through,
        }
    }

    pub fn open(data_dir: &Path) -> Result<(DiskHistory, Self), Reason> {
        let (mut store, disk) = Store::open(data_dir)?;
        let persisted = store.expected.as_ref().map(|_| disk.next);
        let shared = Arc::new(Shared {
            pending: Mutex::new(Pending {
                latest: None,
                closing: false,
                status: (State::Ready, persisted, None),
            }),
            changed: Condvar::new(),
        });
        let worker_shared = Arc::clone(&shared);
        let (completed, receiver) = mpsc::channel();
        std::thread::Builder::new()
            .name("mcp-audit-store".into())
            .spawn(move || {
                loop {
                    let next = {
                        let mut pending = worker_shared
                            .pending
                            .lock()
                            .unwrap_or_else(|e| e.into_inner());
                        while pending.latest.is_none() && !pending.closing {
                            pending = worker_shared
                                .changed
                                .wait(pending)
                                .unwrap_or_else(|e| e.into_inner());
                        }
                        match pending.latest.take() {
                            Some(next) => next,
                            None => break,
                        }
                    };
                    let result = store.save(&next);
                    let mut pending = worker_shared
                        .pending
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    match result {
                        Ok(()) => {
                            pending.status = (
                                if pending.latest.is_some() {
                                    State::Pending
                                } else {
                                    State::Ready
                                },
                                Some(next.next),
                                None,
                            );
                        }
                        Err(reason) => {
                            pending.latest = None;
                            pending.status.0 = State::Unavailable;
                            pending.status.2 = Some(reason);
                            worker_shared.changed.notify_all();
                            break;
                        }
                    }
                    worker_shared.changed.notify_all();
                }
                // Release the file lock before acknowledging a completed flush.
                drop(store);
                let _ = completed.send(());
            })
            .map_err(|_| Reason::WorkerStopped)?;
        Ok((
            disk,
            Self {
                shared,
                completed: receiver,
            },
        ))
    }

    pub fn submit(&self, next: DiskHistory) {
        let mut pending = self
            .shared
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if pending.status.0 == State::Unavailable || pending.closing {
            return;
        }
        pending.latest = Some(next);
        pending.status.0 = State::Pending;
        self.shared.changed.notify_one();
    }

    pub fn status(&self) -> Status {
        self.shared
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .status
    }

    #[cfg(test)]
    fn wait(&self) -> Status {
        let pending = self
            .shared
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let (pending, _) = self
            .shared
            .changed
            .wait_timeout_while(pending, Duration::from_secs(5), |pending| {
                pending.status.0 == State::Pending
            })
            .unwrap_or_else(|e| e.into_inner());
        pending.status
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        {
            let mut pending = self
                .shared
                .pending
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            pending.closing = true;
            self.shared.changed.notify_one();
        }
        // Best effort, explicitly bounded. A slow/full filesystem cannot keep
        // the daemon or the desktop alive indefinitely. Abrupt exit can lose
        // the most recent pending snapshot; the prior complete file survives.
        let _ = self.completed.recv_timeout(DROP_FLUSH);
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Identity(u64, u64);

#[derive(Debug, PartialEq, Eq)]
struct Revision {
    identity: Identity,
    modified: Option<SystemTime>,
    bytes: Vec<u8>,
}

struct Store {
    directory: PathBuf,
    directory_handle: File,
    directory_identity: Identity,
    // A second cooperating daemon fails immediately instead of waiting.
    _lock: File,
    expected: Option<Revision>,
}

impl Store {
    fn open(data_dir: &Path) -> Result<(Self, DiskHistory), Reason> {
        check_path(data_dir)?;
        if !data_dir.is_dir() {
            return Err(Reason::UnsafePath);
        }
        let directory = data_dir.join(DIRECTORY);
        check_path(&directory)?;
        create_private_directory(&directory)?;
        let directory_handle = open_directory(&directory)?;
        check_private(&directory_handle, true)?;
        let directory_identity = identity(&directory_handle)?;
        let lock_path = directory.join(LOCK_NAME);
        check_path(&lock_path)?;
        let lock = match options(true).create_new(true).open(&lock_path) {
            Ok(file) => {
                secure_new_file(&file)?;
                file
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => options(true)
                .open(&lock_path)
                .map_err(|_| Reason::IoFailure)?,
            Err(_) => return Err(Reason::IoFailure),
        };
        check_private(&lock, false)?;
        lock.try_lock().map_err(|_| Reason::Busy)?;
        let mut store = Self {
            directory,
            directory_handle,
            directory_identity,
            _lock: lock,
            expected: None,
        };
        store.check_directory()?;
        let original = store.read()?;
        let disk = match &original {
            Some(revision) => serde_json::from_slice::<DiskHistory>(&revision.bytes)
                .map_err(|_| Reason::InvalidData)?,
            None => DiskHistory::new(Vec::new(), 0, 0),
        };
        disk.validate()?;
        store.expected = original;
        Ok((store, disk))
    }

    fn check_directory(&self) -> Result<(), Reason> {
        check_path(&self.directory)?;
        check_private(&self.directory_handle, true)?;
        let current = open_directory(&self.directory)?;
        check_private(&current, true)?;
        if identity(&current)? != self.directory_identity {
            return Err(Reason::ExternalChange);
        }
        Ok(())
    }

    fn read(&self) -> Result<Option<Revision>, Reason> {
        self.check_directory()?;
        let path = self.directory.join(FILE_NAME);
        check_path(&path)?;
        let file = match options(false).open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(Reason::IoFailure),
        };
        check_private(&file, false)?;
        let metadata = file.metadata().map_err(|_| Reason::IoFailure)?;
        if metadata.len() > MAX_BYTES {
            return Err(Reason::InvalidData);
        }
        let identity = identity(&file)?;
        let modified = metadata.modified().ok();
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        (&file)
            .take(MAX_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Reason::IoFailure)?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err(Reason::InvalidData);
        }
        let after = file.metadata().map_err(|_| Reason::IoFailure)?;
        if metadata.len() != after.len() || modified != after.modified().ok() {
            return Err(Reason::ExternalChange);
        }
        Ok(Some(Revision {
            identity,
            modified,
            bytes,
        }))
    }

    fn save(&mut self, disk: &DiskHistory) -> Result<(), Reason> {
        self.save_before_publish(disk, || {})
    }

    fn save_before_publish(
        &mut self,
        disk: &DiskHistory,
        prepared: impl FnOnce(),
    ) -> Result<(), Reason> {
        disk.validate()?;
        self.check_directory()?;
        if self.read()? != self.expected {
            return Err(Reason::ExternalChange);
        }
        let bytes = serde_json::to_vec(disk).map_err(|_| Reason::InvalidData)?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err(Reason::InvalidData);
        }
        let mut staged = tempfile::Builder::new()
            .prefix(".history-")
            .suffix(".tmp")
            .tempfile_in(&self.directory)
            .map_err(|_| Reason::IoFailure)?;
        secure_new_file(staged.as_file())?;
        check_private(staged.as_file(), false)?;
        staged
            .write_all(&bytes)
            .and_then(|()| staged.flush())
            .and_then(|()| staged.as_file().sync_all())
            .map_err(|_| Reason::IoFailure)?;
        prepared();
        // Detect edits that happened while preparing the next complete file.
        // The private directory and no-follow handles defend against other
        // users; this optimistic check is not an adversarial same-UID CAS.
        if self.read()? != self.expected {
            return Err(Reason::ExternalChange);
        }
        let path = self.directory.join(FILE_NAME);
        let published = if self.expected.is_none() {
            staged.persist_noclobber(&path)
        } else {
            staged.persist(&path)
        }
        .map_err(|_| Reason::IoFailure)?;
        check_private(&published, false)?;
        let metadata = published.metadata().map_err(|_| Reason::IoFailure)?;
        self.expected = Some(Revision {
            identity: identity(&published)?,
            modified: metadata.modified().ok(),
            bytes,
        });
        #[cfg(unix)]
        self.directory_handle
            .sync_all()
            .map_err(|_| Reason::IoFailure)?;
        Ok(())
    }
}

fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    metadata.file_type().is_symlink()
}

fn check_path(path: &Path) -> Result<(), Reason> {
    if !path.is_absolute()
        || path
            .as_os_str()
            .to_string_lossy()
            .split(['/', '\\'])
            .any(|part| matches!(part, "." | ".."))
        || path
            .components()
            .any(|part| matches!(part, Component::CurDir | Component::ParentDir))
    {
        return Err(Reason::UnsafePath);
    }
    let mut current = PathBuf::new();
    for part in path.components() {
        #[cfg(windows)]
        if let Component::Prefix(prefix) = part {
            if !matches!(
                prefix.kind(),
                std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_)
            ) {
                return Err(Reason::UnsafePath);
            }
            current.push(part);
            continue;
        }
        if let Component::Normal(name) = part {
            let name = name.to_string_lossy();
            if name.contains(':') || name.ends_with(['.', ' ']) {
                return Err(Reason::UnsafePath);
            }
            #[cfg(windows)]
            {
                let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
                if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                    || (stem.len() == 4
                        && (stem.starts_with("COM") || stem.starts_with("LPT"))
                        && matches!(stem.as_bytes()[3], b'1'..=b'9'))
                {
                    return Err(Reason::UnsafePath);
                }
            }
        }
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if is_link(&metadata) || (current != path && !metadata.is_dir()) => {
                return Err(Reason::UnsafePath)
            }
            Ok(_) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return Err(Reason::IoFailure),
        }
    }
    Ok(())
}

fn options(write: bool) -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(true).write(write);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // A raced-in FIFO must not block daemon startup before the opened
        // handle can be rejected. O_NONBLOCK has no effect on regular files.
        options
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000);
    }
    options
}

#[cfg(unix)]
fn create_private_directory(path: &Path) -> Result<(), Reason> {
    use std::os::unix::fs::DirBuilderExt;
    match fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(_) => Err(Reason::IoFailure),
    }
}

#[cfg(unix)]
fn open_directory(path: &Path) -> Result<File, Reason> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY)
        .open(path)
        .map_err(|_| Reason::UnsafePath)
}

#[cfg(unix)]
fn check_private(file: &File, directory: bool) -> Result<(), Reason> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let metadata = file.metadata().map_err(|_| Reason::IoFailure)?;
    // SAFETY: geteuid has no preconditions.
    if metadata.uid() != unsafe { libc::geteuid() }
        || metadata.permissions().mode() & 0o077 != 0
        || (directory && !metadata.is_dir())
        || (!directory && (!metadata.is_file() || metadata.nlink() != 1))
    {
        return Err(Reason::UnsafePath);
    }
    Ok(())
}

#[cfg(unix)]
fn identity(file: &File) -> Result<Identity, Reason> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata().map_err(|_| Reason::IoFailure)?;
    Ok(Identity(metadata.dev(), metadata.ino()))
}

#[cfg(unix)]
fn secure_new_file(file: &File) -> Result<(), Reason> {
    check_private(file, false)
}

#[cfg(windows)]
use windows::{check_private, create_private_directory, identity, open_directory, secure_new_file};

#[cfg(windows)]
mod windows {
    use super::*;
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::ptr::{addr_of_mut, null, null_mut};
    use windows_sys::Win32::Foundation::{LocalFree, ERROR_ALREADY_EXISTS, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        GetSecurityInfo, SetSecurityInfo, SDDL_REVISION_1, SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::{
        EqualSid, GetAce, GetSecurityDescriptorControl, GetSecurityDescriptorDacl,
        GetTokenInformation, TokenUser, ACCESS_ALLOWED_ACE, ACL, DACL_SECURITY_INFORMATION,
        INHERIT_ONLY_ACE, OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
        PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, SE_DACL_PROTECTED, TOKEN_QUERY,
        TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateDirectoryW, GetFileInformationByHandle, ReOpenFile, BY_HANDLE_FILE_INFORMATION,
        FILE_ALL_ACCESS, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, READ_CONTROL, WRITE_DAC, WRITE_OWNER,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    struct LocalAllocation(*mut c_void);
    impl Drop for LocalAllocation {
        fn drop(&mut self) {
            // SAFETY: every value comes from a documented LocalAlloc API.
            unsafe {
                LocalFree(self.0);
            }
        }
    }

    struct CurrentUser {
        buffer: Vec<usize>,
    }
    impl CurrentUser {
        fn get() -> Result<Self, Reason> {
            let mut token = null_mut();
            // SAFETY: output points to a live local; returned handle is owned.
            if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
                return Err(Reason::IoFailure);
            }
            let token = unsafe { OwnedHandle::from_raw_handle(token) };
            let mut bytes = 0;
            // First query returns the required bounded buffer length.
            unsafe {
                GetTokenInformation(token.as_raw_handle(), TokenUser, null_mut(), 0, &mut bytes);
            }
            if bytes < std::mem::size_of::<TOKEN_USER>() as u32 || bytes > 64 * 1024 {
                return Err(Reason::IoFailure);
            }
            let mut buffer = vec![0usize; (bytes as usize).div_ceil(std::mem::size_of::<usize>())];
            // SAFETY: allocation has pointer alignment and at least bytes bytes.
            if unsafe {
                GetTokenInformation(
                    token.as_raw_handle(),
                    TokenUser,
                    buffer.as_mut_ptr().cast(),
                    bytes,
                    &mut bytes,
                )
            } == 0
            {
                return Err(Reason::IoFailure);
            }
            Ok(Self { buffer })
        }

        fn sid(&self) -> PSID {
            // SAFETY: the buffer contains the TOKEN_USER populated above and
            // remains allocated for the entire use of its embedded SID.
            unsafe { (*(self.buffer.as_ptr().cast::<TOKEN_USER>())).User.Sid }
        }

        fn descriptor(&self, directory: bool) -> Result<LocalAllocation, Reason> {
            let mut text = null_mut();
            if unsafe { ConvertSidToStringSidW(self.sid(), &mut text) } == 0 {
                return Err(Reason::IoFailure);
            }
            let allocation = LocalAllocation(text.cast());
            let mut length = 0;
            // SAFETY: this API returns a NUL-terminated SID string.
            while unsafe { *text.add(length) } != 0 {
                length += 1;
            }
            let sid = String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) })
                .map_err(|_| Reason::IoFailure)?;
            drop(allocation);
            let inherit = if directory { "OICI" } else { "" };
            let sddl: Vec<u16> = format!("O:{sid}D:P(A;{inherit};FA;;;{sid})")
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
            if unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    SDDL_REVISION_1,
                    &mut descriptor,
                    null_mut(),
                )
            } == 0
            {
                return Err(Reason::IoFailure);
            }
            Ok(LocalAllocation(descriptor))
        }
    }

    pub(super) fn create_private_directory(path: &Path) -> Result<(), Reason> {
        let user = CurrentUser::get()?;
        let descriptor = user.descriptor(true)?;
        let security = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: 0,
        };
        let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        // The restrictive descriptor is applied at creation, never after data
        // has become visible. Existing directories are verified, not modified.
        if unsafe { CreateDirectoryW(path.as_ptr(), &security) } == 0
            && std::io::Error::last_os_error().raw_os_error() != Some(ERROR_ALREADY_EXISTS as i32)
        {
            return Err(Reason::IoFailure);
        }
        Ok(())
    }

    pub(super) fn open_directory(path: &Path) -> Result<File, Reason> {
        // Keep this handle open without FILE_SHARE_DELETE for the store's
        // lifetime, so Windows refuses to rename/delete its containing folder.
        OpenOptions::new()
            .read(true)
            .access_mode(READ_CONTROL | FILE_READ_ATTRIBUTES)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(path)
            .map_err(|_| Reason::UnsafePath)
    }

    fn information(file: &File) -> Result<BY_HANDLE_FILE_INFORMATION, Reason> {
        let mut information = BY_HANDLE_FILE_INFORMATION::default();
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 {
            return Err(Reason::IoFailure);
        }
        Ok(information)
    }

    pub(super) fn identity(file: &File) -> Result<Identity, Reason> {
        let info = information(file)?;
        Ok(Identity(
            info.dwVolumeSerialNumber as u64,
            ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
        ))
    }

    pub(super) fn check_private(file: &File, directory: bool) -> Result<(), Reason> {
        let metadata = file.metadata().map_err(|_| Reason::IoFailure)?;
        let info = information(file)?;
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || (directory && !metadata.is_dir())
            || (!directory && (!metadata.is_file() || info.nNumberOfLinks != 1))
        {
            return Err(Reason::UnsafePath);
        }
        let user = CurrentUser::get()?;
        let mut owner = null_mut();
        let mut dacl: *mut ACL = null_mut();
        let mut descriptor = null_mut();
        if unsafe {
            GetSecurityInfo(
                file.as_raw_handle(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut descriptor,
            )
        } != 0
        {
            return Err(Reason::UnsafePath);
        }
        let _allocation = LocalAllocation(descriptor);
        if owner.is_null() || dacl.is_null() || unsafe { EqualSid(owner, user.sid()) } == 0 {
            return Err(Reason::UnsafePath);
        }
        let mut control = 0;
        let mut revision = 0;
        if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0
            || (directory && control & SE_DACL_PROTECTED == 0)
        {
            return Err(Reason::UnsafePath);
        }
        let mut granted = false;
        // The security subsystem owns/validates the returned ACL. Reject every
        // ACE shape except ordinary owner-only allow entries, including grants
        // that only apply to children. No NULL or foreign-user DACL is accepted.
        for index in 0..unsafe { (*dacl).AceCount } as u32 {
            let mut ace = null_mut();
            if unsafe { GetAce(dacl, index, &mut ace) } == 0 || ace.is_null() {
                return Err(Reason::UnsafePath);
            }
            let allowed = ace.cast::<ACCESS_ALLOWED_ACE>();
            if unsafe { (*allowed).Header.AceType } != 0 // ACCESS_ALLOWED_ACE_TYPE
                || unsafe { (*allowed).Header.AceSize } < std::mem::size_of::<ACCESS_ALLOWED_ACE>() as u16
            {
                return Err(Reason::UnsafePath);
            }
            let sid = unsafe { addr_of_mut!((*allowed).SidStart).cast() };
            if unsafe { EqualSid(sid, user.sid()) } == 0 {
                return Err(Reason::UnsafePath);
            }
            if unsafe { (*allowed).Header.AceFlags } as u32 & INHERIT_ONLY_ACE == 0
                && unsafe { (*allowed).Mask } & FILE_ALL_ACCESS == FILE_ALL_ACCESS
            {
                granted = true;
            }
        }
        if !granted {
            return Err(Reason::UnsafePath);
        }
        Ok(())
    }

    pub(super) fn secure_new_file(file: &File) -> Result<(), Reason> {
        // A new empty staging/lock file inherits the private directory DACL.
        // Explicit owner/protection also handles elevated process token owners.
        // Never call this on an existing user's file.
        let user = CurrentUser::get()?;
        // std/tempfile handles need not have WRITE_DAC/WRITE_OWNER. Reopen the
        // same kernel file object, not a pathname that another process can swap.
        let handle = unsafe {
            ReOpenFile(
                file.as_raw_handle(),
                READ_CONTROL | WRITE_DAC | WRITE_OWNER,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                FILE_FLAG_OPEN_REPARSE_POINT,
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(Reason::IoFailure);
        }
        let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
        let descriptor = user.descriptor(false)?;
        let mut present = 0;
        let mut defaulted = 0;
        let mut dacl = null_mut();
        if unsafe {
            GetSecurityDescriptorDacl(descriptor.0, &mut present, &mut dacl, &mut defaulted)
        } == 0
            || present == 0
            || dacl.is_null()
        {
            return Err(Reason::IoFailure);
        }
        if unsafe {
            SetSecurityInfo(
                handle.as_raw_handle(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION
                    | DACL_SECURITY_INFORMATION
                    | PROTECTED_DACL_SECURITY_INFORMATION,
                user.sid(),
                null_mut(),
                dacl,
                null(),
            )
        } != 0
        {
            return Err(Reason::IoFailure);
        }
        check_private(file, false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_daemon::audit::{Action, History, Outcome};

    fn scratch() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        // macOS temporary paths commonly enter through /var -> /private/var.
        // Canonicalize only this test-owned root, never untrusted store input.
        let path = dir.path().canonicalize().unwrap();
        (dir, path)
    }

    fn entry(id: u64) -> Entry {
        Entry {
            id,
            at: 1,
            client: "test client".into(),
            action: Action::Prompt,
            outcome: Outcome::Accepted,
            session_id: Some("agent-bg-session-test".into()),
            target_id: None,
        }
    }

    fn disk(next: u64) -> DiskHistory {
        DiskHistory::new((1..=next).map(entry).collect(), next, 0)
    }

    fn wait(history: &History) -> Status {
        history
            .persistence
            .as_ref()
            .expect("persistence should be enabled")
            .wait()
    }

    #[test]
    fn restart_restores_bounded_history_and_monotonic_ids() {
        let (_dir, path) = scratch();
        let mut history = History::open(&path);
        assert_eq!(history.snapshot().persistence, State::Ready);
        for at in 0..(HISTORY_LIMIT + 3) {
            history.record("client", Action::Prompt, Outcome::Accepted, None, at as u64);
        }
        assert_eq!(wait(&history), (State::Ready, Some(259), None));
        drop(history);
        let mut reopened = History::open(&path);
        let snapshot = reopened.snapshot();
        assert_eq!(snapshot.persistence, State::Ready);
        assert_eq!(snapshot.entries.len(), HISTORY_LIMIT);
        assert_eq!(snapshot.discarded, 3);
        assert_eq!(snapshot.entries.first().unwrap().id, 259);
        assert_eq!(snapshot.entries.last().unwrap().id, 4);
        reopened.record("later", Action::Stop, Outcome::Unknown, None, 300);
        assert_eq!(wait(&reopened), (State::Ready, Some(260), None));
        assert_eq!(reopened.snapshot().entries[0].outcome, Outcome::Unknown);
    }

    #[test]
    fn normal_drop_flushes_the_latest_snapshot_before_reopening() {
        let (_dir, path) = scratch();
        let mut history = History::open(&path);
        let worker = history
            .persistence
            .as_mut()
            .expect("persistence should be enabled");
        let (drop_sender, drop_receiver) = mpsc::channel();
        let completed = std::mem::replace(&mut worker.completed, drop_receiver);
        let (observed_sender, observed) = mpsc::channel();
        let relay = std::thread::spawn(move || {
            completed
                .recv_timeout(Duration::from_secs(5))
                .expect("the audit worker must finish and release its file lock");
            let _ = drop_sender.send(());
            let _ = observed_sender.send(());
        });
        history.record("client", Action::Stop, Outcome::Failed, None, 1);
        drop(history);
        // Drop keeps its production 250 ms best-effort budget. A loaded
        // filesystem can finish later; observe actual worker completion
        // without pre-flushing the pending snapshot or weakening assertions.
        observed
            .recv_timeout(Duration::from_secs(5))
            .expect("the audit worker must complete before reopening its store");
        relay.join().unwrap();
        let reopened = History::open(&path);
        assert_eq!(reopened.snapshot().persistence, State::Ready);
        assert_eq!(reopened.snapshot().entries.len(), 1);
        assert_eq!(reopened.snapshot().entries[0].outcome, Outcome::Failed);
    }

    #[test]
    fn explicit_flush_persists_while_history_is_still_owned() {
        let (_dir, path) = scratch();
        let mut history = History::open(&path);
        history.record("client", Action::RemoteMetrics, Outcome::Accepted, None, 1);
        let flush = history.flush_handle().unwrap();
        // The production deadline is best effort, not a promise that a real
        // filesystem always finishes within 250 ms on a loaded test machine.
        // Capture before persistence, then prove this same boundary remains
        // usable without dropping History once the worker has reached disk.
        assert_eq!(wait(&history), (State::Ready, Some(1), None));
        assert!(flush.flush(Duration::ZERO));
        let disk: DiskHistory =
            serde_json::from_slice(&fs::read(path.join(DIRECTORY).join(FILE_NAME)).unwrap())
                .unwrap();
        assert_eq!(disk.next, 1);
        assert_eq!(history.snapshot().entries.len(), 1);
    }

    #[test]
    fn flush_waits_for_its_boundary_not_for_later_submissions() {
        let shared = Arc::new(Shared {
            pending: Mutex::new(Pending {
                latest: Some(disk(2)),
                closing: false,
                status: (State::Pending, Some(1), None),
            }),
            changed: Condvar::new(),
        });
        let flush = FlushHandle { shared, through: 1 };
        assert!(flush.flush(Duration::ZERO));
    }

    #[test]
    fn flush_of_a_stopped_worker_is_bounded_even_with_an_excessive_budget() {
        let shared = Arc::new(Shared {
            pending: Mutex::new(Pending {
                latest: Some(disk(1)),
                closing: false,
                status: (State::Pending, None, None),
            }),
            changed: Condvar::new(),
        });
        let flush = FlushHandle { shared, through: 1 };
        let started = std::time::Instant::now();
        assert!(!flush.flush(Duration::from_secs(60)));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn flush_reports_write_failure_without_waiting_for_the_full_budget() {
        let (_dir, path) = scratch();
        let mut history = History::open(&path);
        history.record("client", Action::Prompt, Outcome::Accepted, None, 1);
        assert_eq!(wait(&history).0, State::Ready);
        fs::write(path.join(DIRECTORY).join(FILE_NAME), b"external edit").unwrap();
        history.record("client", Action::Prompt, Outcome::Accepted, None, 2);
        let flush = history.flush_handle().unwrap();
        assert!(!flush.flush(Duration::from_millis(250)));
        assert_eq!(wait(&history).2, Some(Reason::ExternalChange));
    }

    #[test]
    fn a_second_writer_does_not_wait_or_replace_the_first_writer() {
        let (_dir, path) = scratch();
        let first = History::open(&path);
        let second = History::open(&path);
        assert_eq!(second.snapshot().persistence, State::Unavailable);
        assert_eq!(second.snapshot().persistence_reason, Some(Reason::Busy));
        assert_eq!(first.snapshot().persistence, State::Ready);
    }

    #[test]
    fn malformed_or_future_history_is_preserved_and_does_not_disable_memory() {
        let (_dir, path) = scratch();
        let (mut store, _) = Store::open(&path).unwrap();
        store.save(&disk(1)).unwrap();
        let file = path.join(DIRECTORY).join(FILE_NAME);
        drop(store);
        for bytes in [
            b"not json".to_vec(),
            br#"{"version":999,"entries":[],"next":0,"discarded":0}"#.to_vec(),
            vec![b' '; MAX_BYTES as usize + 1],
        ] {
            fs::write(&file, &bytes).unwrap();
            let mut history = History::open(&path);
            assert_eq!(
                history.snapshot().persistence_reason,
                Some(Reason::InvalidData)
            );
            history.record("client", Action::Prompt, Outcome::Accepted, None, 2);
            assert_eq!(history.snapshot().entries.len(), 1);
            assert_eq!(fs::read(&file).unwrap(), bytes);
            drop(history);
        }
    }

    #[test]
    fn schema_rejects_unknown_fields_duplicates_gaps_and_unbounded_metadata() {
        let mut value = serde_json::to_value(disk(1)).unwrap();
        value["prompt"] = "not allowed".into();
        assert!(serde_json::from_value::<DiskHistory>(value).is_err());
        let mut value = serde_json::to_value(disk(1)).unwrap();
        value["entries"][0]["requestId"] = "not allowed".into();
        assert!(serde_json::from_value::<DiskHistory>(value).is_err());
        let mut bad = disk(2);
        bad.entries[1].id = 1;
        assert_eq!(bad.validate(), Err(Reason::InvalidData));
        bad = disk(2);
        bad.entries[0].id = 0;
        assert!(bad.validate().is_err());
        bad = disk(1);
        bad.entries[0].client = "測".repeat(129);
        assert!(bad.validate().is_err());
        bad = disk(1);
        bad.entries[0].client = "line\nbreak".into();
        assert!(bad.validate().is_err());
        bad = disk(1);
        bad.entries[0].session_id = Some("arbitrary-secret".into());
        assert!(bad.validate().is_err());
        assert!(disk(HISTORY_LIMIT as u64 + 1).validate().is_err());
    }

    #[test]
    fn remote_target_metadata_is_bounded_and_legacy_entries_remain_readable() {
        let legacy = serde_json::to_vec(&disk(1)).unwrap();
        assert!(!String::from_utf8_lossy(&legacy).contains("targetId"));
        assert!(serde_json::from_slice::<DiskHistory>(&legacy)
            .unwrap()
            .entries[0]
            .target_id
            .is_none());
        let (_dir, path) = scratch();
        let mut history = History::open(&path);
        history.record_target(
            "remote client",
            Action::RemoteUpload,
            Outcome::Accepted,
            Some("target-a123".into()),
            10,
        );
        assert_eq!(wait(&history).0, State::Ready);
        drop(history);
        let reopened = History::open(&path);
        let entry = &reopened.snapshot().entries[0];
        assert_eq!(entry.target_id.as_deref(), Some("target-a123"));
        assert!(entry.session_id.is_none());
        assert_eq!(entry.action, Action::RemoteUpload);
        for target in [
            "",
            "../outside",
            "host.example",
            "target_with_underscore",
            "C:\\private",
        ] {
            let mut bad = disk(1);
            bad.entries[0].session_id = None;
            bad.entries[0].target_id = Some(target.into());
            assert_eq!(bad.validate(), Err(Reason::InvalidData));
        }
        let mut bad = disk(1);
        bad.entries[0].target_id = Some("target-a123".into());
        assert!(
            bad.validate().is_err(),
            "an entry cannot point to both kinds of target"
        );
    }

    #[test]
    fn external_edits_between_prepare_and_publish_are_never_overwritten() {
        let (_dir, path) = scratch();
        let (mut store, _) = Store::open(&path).unwrap();
        store.save(&disk(1)).unwrap();
        let file = path.join(DIRECTORY).join(FILE_NAME);
        let result =
            store.save_before_publish(&disk(2), || fs::write(&file, b"external edit").unwrap());
        assert_eq!(result, Err(Reason::ExternalChange));
        assert_eq!(fs::read(&file).unwrap(), b"external edit");
    }

    #[test]
    fn externally_removed_or_replaced_files_are_not_recreated_or_overwritten() {
        let (_dir, path) = scratch();
        let (mut store, _) = Store::open(&path).unwrap();
        store.save(&disk(1)).unwrap();
        let file = path.join(DIRECTORY).join(FILE_NAME);
        let original = fs::read(&file).unwrap();
        // Keep the removed file's inode alive. ext4 hands a freed inode
        // straight to the next file, and on kernels with coarse timestamps
        // an identical copy written in the same tick would then look like
        // the original itself (same dev, inode, mtime and bytes), which is
        // not the replacement this test is about. (Windows cannot reuse a
        // name whose file is still open, and does not recycle file ids so
        // eagerly, so this is Unix only.)
        #[cfg(unix)]
        let _removed = File::open(&file).unwrap();
        fs::remove_file(&file).unwrap();
        assert_eq!(store.save(&disk(2)), Err(Reason::ExternalChange));
        assert!(!file.exists());
        let mut replacement = tempfile::NamedTempFile::new_in(file.parent().unwrap()).unwrap();
        secure_new_file(replacement.as_file()).unwrap();
        replacement.write_all(&original).unwrap();
        replacement.persist(&file).unwrap();
        assert_eq!(store.save(&disk(2)), Err(Reason::ExternalChange));
        assert_eq!(fs::read(&file).unwrap(), original);
    }

    #[test]
    fn failed_publish_keeps_previous_data_and_only_marks_history_unavailable() {
        let (_dir, path) = scratch();
        let mut history = History::open(&path);
        history.record("client", Action::Prompt, Outcome::Accepted, None, 1);
        assert_eq!(wait(&history).0, State::Ready);
        let file = path.join(DIRECTORY).join(FILE_NAME);
        fs::write(&file, b"changed elsewhere").unwrap();
        history.record("client", Action::Queue, Outcome::Replayed, None, 2);
        assert_eq!(
            wait(&history),
            (State::Unavailable, Some(1), Some(Reason::ExternalChange))
        );
        history.record("client", Action::Stop, Outcome::Unknown, None, 3);
        assert_eq!(history.snapshot().entries.len(), 3);
        assert_eq!(fs::read(&file).unwrap(), b"changed elsewhere");
    }

    #[test]
    fn hard_links_are_rejected_without_modifying_the_linked_file() {
        let (_dir, path) = scratch();
        let (mut store, _) = Store::open(&path).unwrap();
        store.save(&disk(1)).unwrap();
        let file = path.join(DIRECTORY).join(FILE_NAME);
        let outside = path.join("outside.json");
        fs::hard_link(&file, &outside).unwrap();
        let original = fs::read(&outside).unwrap();
        assert_eq!(store.save(&disk(2)), Err(Reason::UnsafePath));
        assert_eq!(fs::read(&outside).unwrap(), original);
        drop(store);
        assert_eq!(
            History::open(&path).snapshot().persistence_reason,
            Some(Reason::UnsafePath)
        );
    }

    #[test]
    fn unsafe_path_spellings_and_non_regular_targets_are_rejected() {
        let (_dir, path) = scratch();
        assert_eq!(check_path(Path::new("relative")), Err(Reason::UnsafePath));
        let traversal = PathBuf::from(format!(
            "{}{sep}..{sep}elsewhere",
            path.display(),
            sep = std::path::MAIN_SEPARATOR
        ));
        assert_eq!(check_path(&traversal), Err(Reason::UnsafePath));
        assert_eq!(
            check_path(&path.join("history:stream")),
            Err(Reason::UnsafePath)
        );
        let (store, _) = Store::open(&path).unwrap();
        fs::create_dir(path.join(DIRECTORY).join(FILE_NAME)).unwrap();
        assert!(store.read().is_err());
    }

    #[test]
    fn pending_snapshot_is_coalesced_in_one_slot() {
        let shared = Arc::new(Shared {
            pending: Mutex::new(Pending {
                latest: None,
                closing: false,
                status: (State::Ready, None, None),
            }),
            changed: Condvar::new(),
        });
        let (sender, receiver) = mpsc::channel();
        let worker = Worker {
            shared: Arc::clone(&shared),
            completed: receiver,
        };
        for next in 1..=200 {
            worker.submit(disk(next));
        }
        assert_eq!(
            shared.pending.lock().unwrap().latest.as_ref().unwrap().next,
            200
        );
        assert_eq!(worker.status(), (State::Pending, None, None));
        sender.send(()).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn unix_private_modes_and_symlinks_are_checked_without_repairs() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let (_dir, path) = scratch();
        let (mut store, _) = Store::open(&path).unwrap();
        store.save(&disk(1)).unwrap();
        let file = path.join(DIRECTORY).join(FILE_NAME);
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(file.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        let original = fs::read(&file).unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o640)).unwrap();
        assert_eq!(store.save(&disk(2)), Err(Reason::UnsafePath));
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o640
        );
        assert_eq!(fs::read(&file).unwrap(), original);
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        fs::rename(&file, path.join("outside")).unwrap();
        symlink(path.join("outside"), &file).unwrap();
        assert_eq!(store.save(&disk(2)), Err(Reason::UnsafePath));
        assert_eq!(fs::read(path.join("outside")).unwrap(), original);
    }

    #[cfg(unix)]
    #[test]
    fn unix_fifo_cannot_block_history_startup() {
        use std::os::unix::ffi::OsStrExt;
        let (_dir, path) = scratch();
        // This fixture only needs the private folder. Opening a Store also
        // takes an unrelated lock that a parallel process fork can inherit.
        create_private_directory(&path.join(DIRECTORY)).unwrap();
        let file = path.join(DIRECTORY).join(FILE_NAME);
        let name = std::ffi::CString::new(file.as_os_str().as_bytes()).unwrap();
        // SAFETY: name is a NUL-terminated path inside this test's directory.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let (send, receive) = mpsc::channel();
        std::thread::spawn(move || {
            send.send(History::open(&path).snapshot().persistence_reason)
                .unwrap();
        });
        assert_eq!(
            receive.recv_timeout(Duration::from_secs(2)).unwrap(),
            Some(Reason::UnsafePath)
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_directory_and_files_have_explicit_current_user_only_security() {
        let (_dir, path) = scratch();
        let (mut store, _) = Store::open(&path).unwrap();
        store.save(&disk(1)).unwrap();
        check_private(&store.directory_handle, true).unwrap();
        let file = options(false)
            .open(path.join(DIRECTORY).join(FILE_NAME))
            .unwrap();
        check_private(&file, false).unwrap();
        assert_eq!(
            check_path(Path::new(r"\\.\C:\audit")),
            Err(Reason::UnsafePath)
        );
        assert_eq!(
            check_path(Path::new(r"C:\audit\NUL")),
            Err(Reason::UnsafePath)
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_existing_nonprivate_directory_is_rejected_without_acl_repair() {
        let (_dir, path) = scratch();
        let directory = path.join(DIRECTORY);
        fs::create_dir(&directory).unwrap();
        let file = directory.join(FILE_NAME);
        fs::write(&file, b"existing content").unwrap();
        let history = History::open(&path);
        assert_eq!(
            history.snapshot().persistence_reason,
            Some(Reason::UnsafePath)
        );
        assert_eq!(fs::read(&file).unwrap(), b"existing content");
        assert_eq!(
            check_private(&open_directory(&directory).unwrap(), true),
            Err(Reason::UnsafePath)
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_failed_atomic_replace_preserves_the_previous_complete_file() {
        let (_dir, path) = scratch();
        let (mut store, _) = Store::open(&path).unwrap();
        store.save(&disk(1)).unwrap();
        let file = path.join(DIRECTORY).join(FILE_NAME);
        let original = fs::read(&file).unwrap();
        let original_permissions = fs::metadata(&file).unwrap().permissions();
        let mut permissions = original_permissions.clone();
        permissions.set_readonly(true);
        fs::set_permissions(&file, permissions).unwrap();
        let result = store.save(&disk(2));
        let after = fs::read(&file).unwrap();
        fs::set_permissions(&file, original_permissions).unwrap();
        assert_eq!(result, Err(Reason::IoFailure));
        assert_eq!(after, original);
    }

    #[cfg(windows)]
    #[test]
    fn windows_junction_does_not_redirect_audit_writes() {
        use std::os::windows::process::CommandExt;
        let (dir, _) = scratch();
        let outside = dir.path().join("outside");
        let junction = dir.path().join("redirect");
        fs::create_dir(&outside).unwrap();
        let system = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        let cmd = PathBuf::from(system).join("System32").join("cmd.exe");
        // Junction creation does not need the symbolic-link privilege. Both
        // destinations are generated test fixtures, never user-supplied paths.
        let output = std::process::Command::new(cmd)
            .args(["/D", "/C", "mklink", "/J"])
            .arg(&junction)
            .arg(&outside)
            .creation_flags(0x0800_0000)
            .output()
            .unwrap();
        assert!(output.status.success(), "cannot create the test junction");
        let history = History::open(&junction);
        let result = history.snapshot().persistence_reason;
        let escaped = outside.join(DIRECTORY).exists();
        fs::remove_dir(&junction).unwrap();
        assert_eq!(result, Some(Reason::UnsafePath));
        assert!(!escaped);
    }
}
