//! Durable attachments created by an explicit paste action in chat.

use std::io::BufWriter;
use std::path::{Path, PathBuf};

/// Called only for bytes staged by an explicit clipboard action. Return the
/// durable, conversation-scoped path so native transcripts can show it later.
pub(crate) fn keep_staged_image(
    data_dir: &Path,
    session_id: &str,
    path: &Path,
) -> Result<PathBuf, String> {
    let directory = crate::agent_chat::general_chat_directory(data_dir, session_id)?;
    crate::chat_images::store(
        &directory,
        &[crate::chat_images::ToolImage::File(path.into())],
    )
    .into_iter()
    .next()
    .map(PathBuf::from)
    .ok_or_else(|| "Cannot keep the pasted image for preview.".into())
}

pub(crate) fn stage_clipboard_image(
    data_dir: &Path,
    thread_id: &str,
    width: u32,
    height: u32,
    rgba: &[u8],
) -> Result<PathBuf, String> {
    crate::validate_clipboard_image(width, height, rgba.len())?;
    let directory = crate::agent_chat::general_chat_directory(data_dir, thread_id)?;
    let mut file = tempfile::Builder::new()
        .prefix(".clipboard-")
        .suffix(".png")
        .tempfile_in(&directory)
        .map_err(|error| format!("Cannot stage the pasted image: {error}"))?;
    {
        let mut encoder = png::Encoder::new(BufWriter::new(file.as_file_mut()), width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|error| format!("Cannot encode the pasted image: {error}"))?;
        writer
            .write_image_data(rgba)
            .map_err(|error| format!("Cannot encode the pasted image: {error}"))?;
        writer
            .finish()
            .map_err(|error| format!("Cannot finish the pasted image: {error}"))?;
    }
    file.as_file()
        .sync_all()
        .map_err(|error| format!("Cannot save the pasted image: {error}"))?;
    if file
        .as_file()
        .metadata()
        .map_err(|error| error.to_string())?
        .len()
        > 32 * 1024 * 1024
    {
        return Err("The pasted image exceeds the 32 MiB attachment limit.".into());
    }
    let name = file
        .path()
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Cannot name the pasted image.")?
        .trim_start_matches('.');
    let target = directory.join(name);
    // The complete PNG becomes visible at its final path without replacing
    // existing content. Keep it across restarts for queued messages/history.
    file.persist_noclobber(&target)
        .map_err(|error| format!("Cannot keep the pasted image: {error}"))?;
    Ok(target)
}

/// Keeps an image a phone sent over Lattice Remote. Only real PNG or JPEG
/// data is accepted, and it never replaces an existing file.
pub(crate) fn stage_remote_image(
    data_dir: &Path,
    thread_id: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    use std::io::Write;
    let suffix = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        ".png"
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        ".jpg"
    } else {
        return Err("Only PNG or JPEG images can be attached.".into());
    };
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("The image exceeds the 8 MiB attachment limit.".into());
    }
    let directory = crate::agent_chat::general_chat_directory(data_dir, thread_id)?;
    let mut file = tempfile::Builder::new()
        .prefix(".phone-")
        .suffix(suffix)
        .tempfile_in(&directory)
        .map_err(|error| format!("Cannot stage the image: {error}"))?;
    file.write_all(bytes)
        .and_then(|()| file.as_file().sync_all())
        .map_err(|error| format!("Cannot save the image: {error}"))?;
    let name = file
        .path()
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Cannot name the image.")?
        .trim_start_matches('.');
    let target = directory.join(name);
    file.persist_noclobber(&target)
        .map_err(|error| format!("Cannot keep the image: {error}"))?;
    Ok(target)
}

/// A prior session folder is not a preview root. Only an exact, server-read
/// transcript reference to a managed attachment grants access to that file.
pub(crate) fn managed_attachment_path(data_dir: &Path, raw: &str) -> Option<PathBuf> {
    use std::path::Component;
    let path = Path::new(raw);
    if !path.is_absolute()
        || raw.len() > 32768
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return None;
    }
    let root = data_dir.canonicalize().ok()?.join("chat-workspaces");
    let original_root = data_dir.join("chat-workspaces");
    let relative = path
        .strip_prefix(&root)
        .or_else(|_| path.strip_prefix(&original_root))
        .ok()?;
    let parts: Vec<_> = relative.components().collect();
    let [Component::Normal(folder), Component::Normal(name)] = parts.as_slice() else {
        return None;
    };
    let folder_text = folder.to_str()?;
    if folder_text.is_empty()
        || folder_text.len() > 128
        || !folder_text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        return None;
    }
    let name_text = name.to_str()?;
    let (stem, extension) = name_text.rsplit_once('.')?;
    if !matches!(extension, "png" | "jpg" | "jpeg" | "gif" | "webp") {
        return None;
    }
    let valid_name = if let Some(hash) = stem.strip_prefix("agent-image-") {
        matches!(hash.len(), 32 | 64) && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
    } else if let Some(nonce) = stem
        .strip_prefix("clipboard-")
        .or_else(|| stem.strip_prefix("phone-"))
    {
        (6..=64).contains(&nonce.len()) && nonce.bytes().all(|byte| byte.is_ascii_alphanumeric())
    } else {
        false
    };
    valid_name.then(|| root.join(folder).join(name))
}

pub(crate) fn is_other_workspace(data_dir: &Path, current: Option<&Path>, raw: &str) -> bool {
    let path = Path::new(raw);
    let root = data_dir
        .canonicalize()
        .ok()
        .map(|dir| dir.join("chat-workspaces"));
    let managed = path.starts_with(data_dir.join("chat-workspaces"))
        || root.as_ref().is_some_and(|root| path.starts_with(root));
    managed && path.parent() != current
}

fn regular_directory(path: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(image_io_error)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("chat.images.denied".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("chat.images.denied".into());
        }
    }
    Ok(())
}
fn image_io_error(error: std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        "chat.images.missing"
    } else {
        "chat.images.denied"
    }
    .into()
}

pub(crate) fn preview_referenced_image(
    data_dir: &Path,
    references: &[String],
    raw: &str,
) -> Result<Option<String>, String> {
    let candidate = managed_attachment_path(data_dir, raw).ok_or("chat.images.denied")?;
    if !references
        .iter()
        .any(|reference| managed_attachment_path(data_dir, reference).as_ref() == Some(&candidate))
    {
        return Err("chat.images.denied".into());
    }
    let root = data_dir
        .canonicalize()
        .map_err(image_io_error)?
        .join("chat-workspaces");
    let parent = candidate.parent().ok_or("chat.images.denied")?;
    regular_directory(&root)?;
    regular_directory(parent)?;
    let resolved = candidate.canonicalize().map_err(image_io_error)?;
    if !resolved.starts_with(root.canonicalize().map_err(image_io_error)?) || resolved != candidate
    {
        return Err("chat.images.denied".into());
    }
    // On Unix, pin both directories and open the file relative to their handles.
    // No directory/file symlink substitution can redirect the read after validation.
    #[cfg(unix)]
    let file = {
        use std::os::{
            fd::{AsRawFd, FromRawFd},
            unix::{ffi::OsStrExt, fs::OpenOptionsExt},
        };
        let root_file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(&root)
            .map_err(image_io_error)?;
        let folder =
            std::ffi::CString::new(parent.file_name().ok_or("chat.images.denied")?.as_bytes())
                .map_err(|_| "chat.images.denied")?;
        let name = std::ffi::CString::new(
            candidate
                .file_name()
                .ok_or("chat.images.denied")?
                .as_bytes(),
        )
        .map_err(|_| "chat.images.denied")?;
        let fd = unsafe {
            libc::openat(
                root_file.as_raw_fd(),
                folder.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(image_io_error(std::io::Error::last_os_error()));
        }
        let directory = unsafe { std::fs::File::from_raw_fd(fd) };
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(image_io_error(std::io::Error::last_os_error()));
        }
        unsafe { std::fs::File::from_raw_fd(fd) }
    };
    #[cfg(not(unix))]
    let file = {
        let file =
            crate::local_files::open_regular(&candidate).map_err(|_| "chat.images.denied")?;
        regular_directory(&root)?;
        regular_directory(parent)?;
        if candidate.canonicalize().map_err(image_io_error)? != resolved {
            return Err("chat.images.denied".into());
        }
        file
    };
    crate::chat_images::preview_file(file)?
        .ok_or_else(|| "chat.images.denied".into())
        .map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::BufReader;

    #[test]
    fn restored_images_reject_unreferenced_paths_and_traversal() {
        let root = tempfile::tempdir().unwrap();
        let path = stage_clipboard_image(root.path(), "old", 1, 1, &[1, 2, 3, 255]).unwrap();
        let raw = path.to_str().unwrap();
        assert_eq!(
            preview_referenced_image(root.path(), &[], raw).unwrap_err(),
            "chat.images.denied"
        );
        assert!(preview_referenced_image(root.path(), &[raw.into()], raw)
            .unwrap()
            .is_some());
        let traversal = format!(
            "{}/chat-workspaces/old/../old/{}",
            root.path().display(),
            path.file_name().unwrap().to_str().unwrap()
        );
        assert_eq!(
            preview_referenced_image(root.path(), std::slice::from_ref(&traversal), &traversal)
                .unwrap_err(),
            "chat.images.denied"
        );
        let arbitrary = path.parent().unwrap().join("private.png");
        fs::copy(&path, &arbitrary).unwrap();
        assert_eq!(
            preview_referenced_image(
                root.path(),
                &[arbitrary.display().to_string()],
                arbitrary.to_str().unwrap()
            )
            .unwrap_err(),
            "chat.images.denied"
        );
        fs::remove_file(&path).unwrap();
        assert_eq!(
            preview_referenced_image(root.path(), &[raw.into()], raw).unwrap_err(),
            "chat.images.missing"
        );
    }

    #[cfg(unix)]
    #[test]
    fn restored_images_refuse_file_and_directory_symlink_escapes() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let path = stage_clipboard_image(root.path(), "old", 1, 1, &[1, 2, 3, 255]).unwrap();
        let target = outside.path().join(path.file_name().unwrap());
        fs::rename(&path, &target).unwrap();
        symlink(&target, &path).unwrap();
        let raw = path.to_str().unwrap();
        assert_eq!(
            preview_referenced_image(root.path(), &[raw.into()], raw).unwrap_err(),
            "chat.images.denied"
        );
        fs::remove_file(&path).unwrap();
        fs::remove_dir(path.parent().unwrap()).unwrap();
        symlink(outside.path(), path.parent().unwrap()).unwrap();
        assert_eq!(
            preview_referenced_image(root.path(), &[raw.into()], raw).unwrap_err(),
            "chat.images.denied"
        );
    }

    #[test]
    fn native_clipboard_previews_survive_the_temporary_file_and_stay_in_their_conversation() {
        let data = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let original =
            stage_clipboard_image(data.path(), "source", 1, 1, &[20, 40, 60, 255]).unwrap();
        let png = fs::read(original).unwrap();
        let source = tempfile::NamedTempFile::new().unwrap();
        fs::write(source.path(), &png).unwrap();
        let kept = keep_staged_image(data.path(), "native-one", source.path()).unwrap();
        let other = crate::agent_chat::general_chat_directory(data.path(), "native-two").unwrap();
        drop(source);
        assert_eq!(fs::read(&kept).unwrap(), png);
        assert!(crate::chat_images::preview(
            work.path().to_str().unwrap(),
            kept.parent(),
            kept.to_str().unwrap()
        )
        .unwrap()
        .is_some());
        assert!(crate::chat_images::preview(
            work.path().to_str().unwrap(),
            Some(&other),
            kept.to_str().unwrap()
        )
        .unwrap()
        .is_none());
        assert!(
            keep_staged_image(data.path(), "native-one", Path::new("/missing-image.png")).is_err()
        );
    }

    #[test]
    fn pasted_images_are_durable_complete_and_do_not_replace_existing_files() {
        let root = tempfile::tempdir().unwrap();
        let rgba = [10, 20, 30, 255, 40, 50, 60, 128];
        let first = stage_clipboard_image(root.path(), "chat-one", 2, 1, &rgba).unwrap();
        let original = fs::read(&first).unwrap();
        let second = stage_clipboard_image(root.path(), "chat-one", 2, 1, &rgba).unwrap();
        let other = stage_clipboard_image(root.path(), "chat-two", 2, 1, &rgba).unwrap();
        assert_ne!(first, second);
        assert_ne!(first.parent(), other.parent());
        assert_eq!(fs::read(&first).unwrap(), original);
        let mut reader = png::Decoder::new(BufReader::new(fs::File::open(&first).unwrap()))
            .read_info()
            .unwrap();
        let mut decoded = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut decoded).unwrap();
        assert_eq!((info.width, info.height), (2, 1));
        assert_eq!(decoded, rgba);
        assert_eq!(fs::read_dir(first.parent().unwrap()).unwrap().count(), 2);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(first).unwrap().permissions().mode() & 0o077, 0);
        }
    }

    #[test]
    fn phone_images_must_be_png_or_jpeg() {
        let root = tempfile::tempdir().unwrap();
        let jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3];
        let path = stage_remote_image(root.path(), "chat", &jpeg).unwrap();
        assert_eq!(path.extension().unwrap(), "jpg");
        assert_eq!(fs::read(&path).unwrap(), jpeg);
        assert!(stage_remote_image(root.path(), "chat", b"<svg/>").is_err());
        assert!(stage_remote_image(root.path(), "../chat", &jpeg).is_err());
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn invalid_pixels_and_paths_never_create_an_attachment() {
        let root = tempfile::tempdir().unwrap();
        for (width, height, data) in [(0, 1, vec![]), (2, 2, vec![0; 4]), (u32::MAX, 1, vec![])] {
            assert!(stage_clipboard_image(root.path(), "chat", width, height, &data).is_err());
        }
        for thread in ["../outside", "a/b", "a\\b", "", "/absolute"] {
            assert!(stage_clipboard_image(root.path(), thread, 1, 1, &[0; 4]).is_err());
        }
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
        fs::write(root.path().join("chat-workspaces"), "keep this").unwrap();
        assert!(stage_clipboard_image(root.path(), "chat", 1, 1, &[0; 4]).is_err());
        assert_eq!(
            fs::read_to_string(root.path().join("chat-workspaces")).unwrap(),
            "keep this"
        );
    }

    #[cfg(unix)]
    #[test]
    fn pasted_images_refuse_linked_conversation_folders() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("chat-workspaces")).unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("chat-workspaces/chat"))
            .unwrap();
        assert!(stage_clipboard_image(root.path(), "chat", 1, 1, &[0; 4]).is_err());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    }
}
