//! Windows disk usage and opt-in maintenance for app-owned data.
use serde::Serialize;
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io,
    os::windows::{
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawHandle,
    },
    path::{Component, Path, PathBuf},
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;
use windows_sys::Win32::{
    Storage::FileSystem::*,
    System::{Ioctl::FSCTL_SET_COMPRESSION, IO::DeviceIoControl},
};

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiskUsage {
    profiles: u64,
    chats: u64,
    webview: u64,
    partial: bool,
    attachments: Vec<Item>,
    history: Vec<Item>,
}

#[derive(Serialize)]
struct Item {
    path: String,
    bytes: u64,
    compressed: bool,
    stored: Option<u64>,
}

fn compressed_bytes(path: &Path) -> Option<u64> {
    let file = File::open(path).ok()?;
    let mut info = FILE_COMPRESSION_INFO::default();
    let ok = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileCompressionInfo,
            (&mut info as *mut FILE_COMPRESSION_INFO).cast(),
            std::mem::size_of_val(&info) as u32,
        )
    };
    (ok != 0).then_some(info.CompressedFileSize as u64)
}

fn segments(path: &Path) -> Option<Vec<&str>> {
    path.components()
        .map(|part| match part {
            Component::Normal(name) => name
                .to_str()
                .filter(|s| !s.contains([':', '/', '\\']) && !s.ends_with([' ', '.'])),
            _ => None,
        })
        .collect()
}

fn attachment(path: &Path) -> bool {
    let Some(parts) = segments(path) else {
        return false;
    };
    parts.len() >= 2
        && path.extension().and_then(|s| s.to_str()).is_some_and(|s| {
            ["png", "jpeg", "jpg", "webp", "gif"]
                .iter()
                .any(|ext| s.eq_ignore_ascii_case(ext))
        })
}

fn transcript(path: &Path) -> bool {
    let Some(parts) = segments(path) else {
        return false;
    };
    match parts.as_slice() {
        ["codex", _, "sessions", _, _, _, name] => {
            name.starts_with("rollout-") && name.ends_with(".jsonl")
        }
        ["claude", _, "projects", _, name] => name.ends_with(".jsonl"),
        _ => false,
    }
}

fn old_enough(meta: &Metadata) -> bool {
    meta.modified()
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age >= Duration::from_secs(90 * 86400))
}

fn regular(meta: &Metadata) -> bool {
    meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0
}

fn visit(root: &Path, mut on_file: impl FnMut(&Path, &Metadata)) -> (u64, bool) {
    let mut pending = vec![root.to_owned()];
    let mut bytes = 0;
    let mut partial = false;
    while let Some(path) = pending.pop() {
        let meta = match fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(err) if path == root && err.kind() == io::ErrorKind::NotFound => continue,
            Err(_) => {
                partial = true;
                continue;
            }
        };
        if !regular(&meta) {
            continue;
        }
        if meta.is_file() {
            bytes += meta.len();
            on_file(path.strip_prefix(root).unwrap(), &meta);
        } else if meta.is_dir() {
            match fs::read_dir(path) {
                Ok(entries) => {
                    for entry in entries {
                        match entry {
                            Ok(entry) => pending.push(entry.path()),
                            Err(_) => partial = true,
                        }
                    }
                }
                Err(_) => partial = true,
            }
        }
    }
    (bytes, partial)
}

#[tauri::command]
pub(crate) async fn disk_usage(app: AppHandle) -> Result<DiskUsage, String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let local = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut result = DiskUsage::default();
        for (folder, root) in [
            ("agent-profiles", &data),
            ("chat-workspaces", &data),
            ("EBWebView", &local),
        ] {
            let (bytes, partial) = visit(&root.join(folder), |path, meta| {
                let compressed = meta.file_attributes() & FILE_ATTRIBUTE_COMPRESSED != 0;
                let list = match folder {
                    "agent-profiles" if transcript(path) && (old_enough(meta) || compressed) => {
                        &mut result.history
                    }
                    "chat-workspaces" if attachment(path) => &mut result.attachments,
                    _ => return,
                };
                list.push(Item {
                    path: path.to_string_lossy().into_owned(),
                    bytes: meta.len(),
                    compressed,
                    stored: if compressed && folder == "agent-profiles" {
                        compressed_bytes(&root.join(folder).join(path))
                    } else {
                        None
                    },
                });
            });
            result.partial |= partial;
            match folder {
                "agent-profiles" => result.profiles = bytes,
                "chat-workspaces" => result.chats = bytes,
                _ => result.webview = bytes,
            }
        }
        for list in [&mut result.history, &mut result.attachments] {
            list.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.path.cmp(&b.path)));
        }
        result
    })
    .await
    .map_err(|e| e.to_string())
}

fn checked_path(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    let mut target = root.to_path_buf();
    for part in std::iter::once("").chain(segments(relative).ok_or("Invalid file name")?) {
        if !part.is_empty() {
            target.push(part);
        }
        let meta = fs::symlink_metadata(&target).map_err(|e| e.to_string())?;
        if !regular(&meta) {
            return Err("Linked files and folders are excluded.".into());
        }
    }
    target.canonicalize().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn disk_reveal_attachment(app: AppHandle, path: PathBuf) -> Result<(), String> {
    if !attachment(&path) {
        return Err("Unknown attachment.".into());
    }
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let file = checked_path(&data.join("chat-workspaces"), &path)?;
    let expected = data
        .canonicalize()
        .map_err(|e| e.to_string())?
        .join("chat-workspaces")
        .join(path);
    if file != expected || !file.is_file() {
        return Err("The image changed location or no longer exists.".into());
    }
    app.opener()
        .reveal_item_in_dir(file)
        .map_err(|e| e.to_string())
}

fn verify_handle(file: &File, expected: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStringExt;
    let handle = file.as_raw_handle();
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    let mut path = vec![0u16; 32768];
    // Identity, link count and attributes are checked on the exclusive handle used below.
    unsafe {
        if GetFileInformationByHandle(handle, &mut info) == 0 {
            return Err(io::Error::last_os_error());
        }
        let len = GetFinalPathNameByHandleW(
            handle,
            path.as_mut_ptr(),
            path.len() as u32,
            VOLUME_NAME_DOS,
        );
        if len == 0 || len as usize >= path.len() {
            return Err(io::Error::last_os_error());
        }
        let actual = PathBuf::from(std::ffi::OsString::from_wide(&path[..len as usize]));
        if actual != expected
            || info.nNumberOfLinks != 1
            || info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)
                != 0
        {
            return Err(io::Error::other(
                "The history file changed location or has links.",
            ));
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn disk_compress_history(
    app: AppHandle,
    path: PathBuf,
    compress: bool,
) -> Result<(), String> {
    if !transcript(&path) {
        return Err("Unknown transcript.".into());
    }
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("agent-profiles");
    tauri::async_runtime::spawn_blocking(move || set_compression(&root, &path, compress))
        .await
        .map_err(|e| e.to_string())?
}

fn set_compression(root: &Path, path: &Path, compress: bool) -> Result<(), String> {
    let expected = root
        .parent()
        .ok_or("Invalid profile directory")?
        .canonicalize()
        .map_err(|e| e.to_string())?
        .join("agent-profiles")
        .join(path);
    let target = checked_path(root, path)?;
    if target != expected {
        return Err("The history file changed location.".into());
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(target)
        .map_err(|e| e.to_string())?;
    verify_handle(&file, &expected).map_err(|e| e.to_string())?;
    if compress && !old_enough(&file.metadata().map_err(|e| e.to_string())?) {
        return Err("The transcript was recently modified.".into());
    }
    let mode: u16 = u16::from(compress);
    let mut returned = 0;
    let ok = unsafe {
        DeviceIoControl(
            file.as_raw_handle(),
            FSCTL_SET_COMPRESSION,
            (&mode as *const u16).cast(),
            2,
            std::ptr::null_mut(),
            0,
            &mut returned,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error().to_string());
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn disk_clear_cache(window: tauri::WebviewWindow) -> Result<(), String> {
    use webview2_com::{ClearBrowsingDataCompletedHandler, Microsoft::Web::WebView2::Win32::*};
    use windows_core::Interface;
    let (send, receive) = tokio::sync::oneshot::channel();
    window
        .with_webview(move |view| {
            let start = || -> windows_core::Result<_> {
                unsafe {
                    let core: ICoreWebView2_13 = view.controller().CoreWebView2()?.cast()?;
                    let profile: ICoreWebView2Profile2 = core.Profile()?.cast()?;
                    Ok(profile)
                }
            };
            match start() {
                Err(e) => {
                    let _ = send.send(Err(e.to_string()));
                }
                Ok(profile) => {
                    let send = std::rc::Rc::new(std::cell::RefCell::new(Some(send)));
                    let done = send.clone();
                    let callback =
                        ClearBrowsingDataCompletedHandler::create(Box::new(move |status| {
                            if let Some(send) = done.borrow_mut().take() {
                                let _ = send.send(status.map_err(|e| e.to_string()));
                            }
                            Ok(())
                        }));
                    if let Err(e) = unsafe {
                        profile.ClearBrowsingData(
                            COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE,
                            &callback,
                        )
                    } {
                        if let Some(send) = send.borrow_mut().take() {
                            let _ = send.send(Err(e.to_string()));
                        }
                    }
                }
            }
        })
        .map_err(|e| e.to_string())?;
    receive.await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compresses_and_restores_an_idle_transcript_without_changing_its_bytes() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("agent-profiles");
        let relative = Path::new("codex/id/sessions/2026/01/01/rollout-old.jsonl");
        let target = root.join(relative);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        let bytes = b"sample transcript line\n".repeat(8192);
        fs::write(&target, &bytes).unwrap();
        assert!(set_compression(&root, relative, true).is_err());
        let file = File::options().write(true).open(&target).unwrap();
        file.set_modified(std::time::SystemTime::now() - Duration::from_secs(91 * 86400))
            .unwrap();
        assert!(set_compression(&root, relative, true).is_err());
        drop(file);
        let alias = tmp.path().join("external-link");
        fs::hard_link(&target, &alias).unwrap();
        assert!(set_compression(&root, relative, true).is_err());
        fs::remove_file(alias).unwrap();
        set_compression(&root, relative, true).unwrap();
        assert_ne!(
            fs::metadata(&target).unwrap().file_attributes() & FILE_ATTRIBUTE_COMPRESSED,
            0
        );
        assert_eq!(fs::read(&target).unwrap(), bytes);
        set_compression(&root, relative, false).unwrap();
        assert_eq!(
            fs::metadata(&target).unwrap().file_attributes() & FILE_ATTRIBUTE_COMPRESSED,
            0
        );
        assert_eq!(fs::read(&target).unwrap(), bytes);
    }

    #[test]
    fn actions_only_accept_managed_files() {
        assert!(attachment(Path::new("chat/clipboard-abc123.png")));
        assert!(!attachment(Path::new("../clipboard-abc123.png")));
        assert!(attachment(Path::new("chat/images/photo.png")));
        assert!(!attachment(Path::new("chat/phone-a:stream.jpg")));
        assert!(transcript(Path::new(
            "codex/id/sessions/2026/01/01/rollout-old.jsonl"
        )));
        assert!(!transcript(Path::new("codex/id/.tmp/rollout-old.jsonl")));
        assert!(!transcript(Path::new(
            "claude/id/projects/../history.jsonl"
        )));
    }
}
