//! Images shown in a conversation: the ones a reply mentions, the ones the
//! user attached and the ones a tool handed back, so a chart or screenshot
//! can be seen without leaving the chat.
//!
//! Only files inside the conversation's working folder or its own chat
//! folder are read (after resolving links), only real PNG, JPEG, GIF or
//! WebP data by its magic bytes, and only up to a size a thumbnail needs.

use base64::Engine;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const MAX_IMAGE_BYTES: u64 = 16 * 1024 * 1024;
/// A tool that returns a whole album still only adds this many to the chat.
const MAX_STORED_PER_TOOL: usize = 8;

/// An image a tool returned. The parser only collects it; the app's sink
/// keeps it in the conversation folder and sends the frontend a path, so
/// image bytes never travel through events or WebView storage.
#[derive(Debug, Clone, PartialEq)]
pub enum ToolImage {
    /// Base64 bytes, e.g. a screenshot from an MCP tool.
    Data(String),
    /// An absolute path the agent looked at.
    File(PathBuf),
}

fn mime(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// A `data:` URL for the image, or `None` when the path is not an image
/// inside the working folder or the conversation's own folder.
pub fn preview(
    working_directory: &str,
    chat_directory: Option<&Path>,
    path: &str,
) -> Result<Option<String>, String> {
    let root = Path::new(working_directory.trim());
    if !root.is_absolute() {
        return Err("The working folder must be an absolute path.".to_string());
    }
    let root = root
        .canonicalize()
        .map_err(|_| "The working folder is unavailable.".to_string())?;
    let chat_root = chat_directory.and_then(|directory| directory.canonicalize().ok());
    let requested = PathBuf::from(path.trim());
    let candidate = if requested.is_absolute() {
        requested
    } else {
        root.join(requested)
    };
    let Ok(resolved) = candidate.canonicalize() else {
        return Ok(None);
    };
    if !resolved.starts_with(&root)
        && !chat_root
            .as_ref()
            .is_some_and(|chat_root| resolved.starts_with(chat_root))
    {
        return Ok(None);
    }
    let Ok(metadata) = std::fs::metadata(&resolved) else {
        return Ok(None);
    };
    if !metadata.is_file() || metadata.len() > MAX_IMAGE_BYTES {
        return Ok(None);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    std::fs::File::open(&resolved)
        .and_then(|file| file.take(MAX_IMAGE_BYTES).read_to_end(&mut bytes))
        .map_err(|error| error.to_string())?;
    let Some(mime) = mime(&bytes) else {
        return Ok(None);
    };
    Ok(Some(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    )))
}

fn extension(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        _ => "webp",
    }
}

fn image_bytes(image: &ToolImage) -> Option<Vec<u8>> {
    match image {
        ToolImage::Data(data) => {
            if data.len() as u64 > MAX_IMAGE_BYTES / 3 * 4 + 4 {
                return None;
            }
            base64::engine::general_purpose::STANDARD
                .decode(data.trim())
                .ok()
        }
        ToolImage::File(path) => {
            if !path.is_absolute() {
                return None;
            }
            let file = std::fs::File::open(path).ok()?;
            let metadata = file.metadata().ok()?;
            if !metadata.is_file() || metadata.len() > MAX_IMAGE_BYTES {
                return None;
            }
            let mut bytes = Vec::with_capacity(metadata.len() as usize);
            file.take(MAX_IMAGE_BYTES).read_to_end(&mut bytes).ok()?;
            Some(bytes)
        }
    }
}

/// Keeps the images a tool returned in the conversation folder and returns
/// their paths. Files are named by content, so the same screenshot read
/// twice is stored once, and an existing file is never replaced.
pub fn store(directory: &Path, images: &[ToolImage]) -> Vec<String> {
    let mut paths = Vec::new();
    for image in images.iter().take(MAX_STORED_PER_TOOL) {
        let Some(bytes) = image_bytes(image) else {
            continue;
        };
        let Some(mime) = mime(&bytes) else {
            continue;
        };
        let digest = Sha256::digest(&bytes);
        let name: String = digest[..16]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let target = directory.join(format!("agent-image-{name}.{}", extension(mime)));
        let kept = |target: &Path| {
            std::fs::symlink_metadata(target).is_ok_and(|metadata| metadata.is_file())
        };
        if !kept(&target) {
            let Ok(mut file) = tempfile::Builder::new()
                .prefix(".agent-image-")
                .tempfile_in(directory)
            else {
                continue;
            };
            if file
                .write_all(&bytes)
                .and_then(|_| file.as_file().sync_all())
                .is_err()
            {
                continue;
            }
            // Another turn may have kept the same picture a moment ago.
            if file.persist_noclobber(&target).is_err() && !kept(&target) {
                continue;
            }
        }
        let path = target.display().to_string();
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    paths
}

pub fn stored_images(directory: &Path, limit: usize) -> Result<(Vec<String>, bool), String> {
    let entries = std::fs::read_dir(directory)
        .map_err(|error| format!("Cannot read the session image folder: {error}"))?;
    let mut found = Vec::new();
    let mut truncated = false;
    for (index, entry) in entries.enumerate() {
        if index >= 1024 {
            truncated = true;
            break;
        }
        let entry = entry.map_err(|error| format!("Cannot inspect a session image: {error}"))?;
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("agent-image-") && !name.starts_with("clipboard-") {
            continue;
        }
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|error| format!("Cannot inspect a session image: {error}"))?;
        if !metadata.is_file() || metadata.len() > MAX_IMAGE_BYTES {
            continue;
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                continue;
            }
        }
        let mut head = [0; 12];
        let mut file = std::fs::File::open(&path)
            .map_err(|error| format!("Cannot read a session image: {error}"))?;
        let read = file.read(&mut head).map_err(|error| error.to_string())?;
        if mime(&head[..read]).is_none() {
            continue;
        }
        found.push((metadata.modified().ok(), path.display().to_string()));
    }
    found.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
    truncated |= found.len() > limit;
    found.truncate(limit);
    Ok((found.into_iter().map(|(_, path)| path).collect(), truncated))
}

#[cfg(test)]
mod tests {
    use super::{preview, store, stored_images, ToolImage};

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

    #[test]
    fn session_gallery_lists_only_owned_regular_images_and_discloses_limits() {
        let directory = tempfile::tempdir().unwrap();
        for name in ["clipboard-one.png", "agent-image-two.png", "unrelated.png"] {
            std::fs::write(directory.path().join(name), PNG).unwrap();
        }
        std::fs::write(
            directory.path().join("agent-image-fake.png"),
            b"not an image",
        )
        .unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(
            directory.path().join("unrelated.png"),
            directory.path().join("agent-image-link.png"),
        )
        .unwrap();
        let (paths, truncated) = stored_images(directory.path(), 64).unwrap();
        assert_eq!(paths.len(), 2);
        assert!(!truncated);
        assert!(paths.iter().all(|path| !path.ends_with("unrelated.png")));
        let (paths, truncated) = stored_images(directory.path(), 1).unwrap();
        assert_eq!(paths.len(), 1);
        assert!(truncated);
        assert!(stored_images(&directory.path().join("missing"), 64).is_err());
    }

    #[test]
    fn only_real_images_inside_the_folder_are_previewed() {
        let work = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(work.path().join("chart.png"), PNG).unwrap();
        std::fs::write(work.path().join("fake.png"), b"not an image").unwrap();
        std::fs::write(outside.path().join("secret.png"), PNG).unwrap();
        let root = work.path().to_str().unwrap();

        let url = preview(root, None, "chart.png").unwrap().unwrap();
        assert!(url.starts_with("data:image/png;base64,"));
        assert!(
            preview(root, None, &work.path().join("chart.png").to_string_lossy())
                .unwrap()
                .is_some()
        );
        assert!(preview(root, None, "fake.png").unwrap().is_none());
        assert!(preview(root, None, "missing.png").unwrap().is_none());
        assert!(preview(
            root,
            None,
            &outside.path().join("secret.png").to_string_lossy()
        )
        .unwrap()
        .is_none());
        assert!(preview(root, None, "../secret.png").unwrap().is_none());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                outside.path().join("secret.png"),
                work.path().join("link.png"),
            )
            .unwrap();
            assert!(
                preview(root, None, "link.png").unwrap().is_none(),
                "links out of the folder are refused"
            );
        }
        assert!(preview("relative", None, "chart.png").is_err());
    }

    #[test]
    fn tool_images_are_kept_once_in_the_chat_folder_and_previewed_from_there() {
        let work = tempfile::tempdir().unwrap();
        let chat = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let screenshot = elsewhere.path().join("shot.png");
        std::fs::write(&screenshot, PNG).unwrap();
        let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, PNG);

        let stored = store(
            chat.path(),
            &[
                ToolImage::Data(encoded.clone()),
                ToolImage::File(screenshot.clone()),
                ToolImage::Data("bm90IGFuIGltYWdl".into()),
                ToolImage::Data("%%%".into()),
                ToolImage::File("relative.png".into()),
            ],
        );
        assert_eq!(stored.len(), 1, "only real images, and the same bytes once");
        assert_eq!(std::fs::read(&stored[0]).unwrap(), PNG);
        assert_eq!(std::fs::read_dir(chat.path()).unwrap().count(), 1);
        assert_eq!(store(chat.path(), &[ToolImage::Data(encoded)]), stored);

        let root = work.path().to_str().unwrap();
        assert!(preview(root, None, &stored[0]).unwrap().is_none());
        assert!(preview(root, Some(chat.path()), &stored[0])
            .unwrap()
            .is_some());
        assert!(
            preview(root, Some(chat.path()), &screenshot.to_string_lossy())
                .unwrap()
                .is_none(),
            "the chat folder does not open the rest of the disk"
        );
    }
}
