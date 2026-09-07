//! Durable attachments created by an explicit paste action in chat.

use std::io::BufWriter;
use std::path::{Path, PathBuf};

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::BufReader;

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
