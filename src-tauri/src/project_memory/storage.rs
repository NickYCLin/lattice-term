//! Bounded, no-follow files and recoverable multi-file replacement.
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};
pub const LIMIT: usize = 1024 * 1024;
pub fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
pub fn directory(value: &Path) -> Result<PathBuf, String> {
    if !value.is_absolute()
        || value
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err("memory.path".into());
    }
    let directory = value.canonicalize().map_err(|_| "memory.path")?;
    if !directory.is_dir() || crate::transcript::redact::forbidden(&directory) {
        return Err("memory.path".into());
    }
    Ok(directory)
}
fn special(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    meta.file_type().is_symlink()
}
pub fn path(root: &Path, relative: &Path, create: bool) -> Result<PathBuf, String> {
    if relative
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("memory.path".into());
    }
    let mut current = root.to_path_buf();
    let count = relative.components().count();
    for (index, part) in relative.components().enumerate() {
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(meta) => {
                if special(&meta)
                    || (index + 1 < count && !meta.is_dir())
                    || (index + 1 == count && !meta.is_file())
                {
                    return Err("memory.path".into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if create && index + 1 < count {
                    match fs::create_dir(&current) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                        Err(_) => return Err("memory.write".into()),
                    }
                    let meta = fs::symlink_metadata(&current).map_err(|_| "memory.path")?;
                    if !meta.is_dir() || special(&meta) {
                        return Err("memory.path".into());
                    }
                }
            }
            Err(_) => return Err("memory.path".into()),
        }
    }
    Ok(current)
}
pub fn read(root: &Path, relative: &Path) -> Result<Option<Vec<u8>>, String> {
    let target = path(root, relative, false)?;
    match fs::symlink_metadata(&target) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("memory.read".into()),
        Ok(_) => {}
    }
    let file = crate::local_files::open_regular(&target).map_err(|_| "memory.read")?;
    if file.metadata().map_err(|_| "memory.read")?.len() > LIMIT as u64 {
        return Err("memory.capacity".into());
    }
    let mut bytes = Vec::new();
    file.take(LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "memory.read")?;
    if bytes.len() > LIMIT {
        return Err("memory.capacity".into());
    }
    Ok(Some(bytes))
}
pub struct Change {
    pub root: PathBuf,
    pub relative: PathBuf,
    pub before: Option<Vec<u8>>,
    pub after: Vec<u8>,
}
impl Change {
    pub fn new(
        root: &Path,
        relative: impl Into<PathBuf>,
        before: Option<Vec<u8>>,
        after: Vec<u8>,
    ) -> Self {
        Self {
            root: root.into(),
            relative: relative.into(),
            before,
            after,
        }
    }
}
pub fn lock(data: &Path) -> Result<fs::File, String> {
    if !data.is_dir() {
        fs::create_dir_all(data).map_err(|_| "memory.write")?;
    }
    let data = directory(data)?;
    let target = path(&data, Path::new("project-memory/.lock"), true)?;
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000);
    }
    let file = options.open(target).map_err(|_| "memory.write")?;
    if special(&file.metadata().map_err(|_| "memory.path")?) {
        return Err("memory.path".into());
    }
    file.lock().map_err(|_| "memory.write")?;
    Ok(file)
}
pub fn commit(changes: Vec<Change>) -> Result<(), String> {
    let changes = changes
        .into_iter()
        .filter(|change| change.before.as_deref() != Some(change.after.as_slice()))
        .collect::<Vec<_>>();
    let mut prepared = Vec::new();
    for change in changes {
        if change.after.len() > LIMIT {
            return Err("memory.capacity".into());
        }
        if read(&change.root, &change.relative)? != change.before {
            return Err("memory.conflict".into());
        }
        let target = path(&change.root, &change.relative, true)?;
        let mut temp = tempfile::NamedTempFile::new_in(target.parent().ok_or("memory.path")?)
            .map_err(|_| "memory.write")?;
        temp.write_all(&change.after)
            .and_then(|()| temp.as_file().sync_all())
            .map_err(|_| "memory.write")?;
        if let Ok(meta) = fs::metadata(&target) {
            fs::set_permissions(temp.path(), meta.permissions()).map_err(|_| "memory.write")?;
        }
        prepared.push((change, target, temp));
    }
    for (change, _, _) in &prepared {
        if read(&change.root, &change.relative)? != change.before {
            return Err("memory.conflict".into());
        }
    }
    let mut applied: Vec<(PathBuf, Option<PathBuf>, Vec<u8>)> = Vec::new();
    for (change, target, temp) in prepared {
        match read(&change.root, &change.relative) {
            Ok(current) if current == change.before => {}
            _ => {
                rollback(&applied);
                return Err("memory.conflict".into());
            }
        }
        let backup = if change.before.is_some() {
            let id = match super::new_id() {
                Ok(id) => id,
                Err(error) => {
                    rollback(&applied);
                    return Err(error);
                }
            };
            let backup = target.with_file_name(format!(".lattice-memory-{id}.bak"));
            if fs::rename(&target, &backup).is_err() {
                rollback(&applied);
                return Err("memory.write".into());
            }
            if crate::local_files::read_text(&backup, LIMIT as u64)
                .ok()
                .map(String::into_bytes)
                != change.before
            {
                restore(&backup, &target);
                rollback(&applied);
                return Err("memory.conflict".into());
            }
            Some(backup)
        } else {
            None
        };
        if temp.persist_noclobber(&target).is_err() {
            if let Some(backup) = &backup {
                restore(backup, &target);
            }
            rollback(&applied);
            return Err("memory.conflict".into());
        }
        applied.push((target, backup, change.after));
    }
    for (_, backup, _) in applied {
        if let Some(backup) = backup {
            let _ = fs::remove_file(backup);
        }
    }
    Ok(())
}
fn restore(backup: &Path, target: &Path) {
    if fs::hard_link(backup, target).is_ok() {
        let _ = fs::remove_file(backup);
    }
}
fn rollback(applied: &[(PathBuf, Option<PathBuf>, Vec<u8>)]) {
    for (target, backup, written) in applied.iter().rev() {
        if fs::read(target).ok().as_deref() == Some(written.as_slice()) {
            let _ = fs::remove_file(target);
            if let Some(backup) = backup {
                restore(backup, target);
            }
        }
    }
}
