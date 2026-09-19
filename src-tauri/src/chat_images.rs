//! Thumbnails for images a reply mentions, so a chart or screenshot the
//! assistant produced can be seen without leaving the conversation.
//!
//! Only files inside the conversation's working folder are read (after
//! resolving links), only real PNG, JPEG, GIF or WebP data by its magic
//! bytes, and only up to a size a thumbnail needs.

use base64::Engine;
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;

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
/// inside the working folder.
pub fn preview(working_directory: &str, path: &str) -> Result<Option<String>, String> {
    let root = Path::new(working_directory.trim());
    if !root.is_absolute() {
        return Err("The working folder must be an absolute path.".to_string());
    }
    let root = root
        .canonicalize()
        .map_err(|_| "The working folder is unavailable.".to_string())?;
    let requested = PathBuf::from(path.trim());
    let candidate = if requested.is_absolute() {
        requested
    } else {
        root.join(requested)
    };
    let Ok(resolved) = candidate.canonicalize() else {
        return Ok(None);
    };
    if !resolved.starts_with(&root) {
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

#[cfg(test)]
mod tests {
    use super::preview;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

    #[test]
    fn only_real_images_inside_the_folder_are_previewed() {
        let work = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(work.path().join("chart.png"), PNG).unwrap();
        std::fs::write(work.path().join("fake.png"), b"not an image").unwrap();
        std::fs::write(outside.path().join("secret.png"), PNG).unwrap();
        let root = work.path().to_str().unwrap();

        let url = preview(root, "chart.png").unwrap().unwrap();
        assert!(url.starts_with("data:image/png;base64,"));
        assert!(
            preview(root, &work.path().join("chart.png").to_string_lossy())
                .unwrap()
                .is_some()
        );
        assert!(preview(root, "fake.png").unwrap().is_none());
        assert!(preview(root, "missing.png").unwrap().is_none());
        assert!(
            preview(root, &outside.path().join("secret.png").to_string_lossy())
                .unwrap()
                .is_none()
        );
        assert!(preview(root, "../secret.png").unwrap().is_none());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                outside.path().join("secret.png"),
                work.path().join("link.png"),
            )
            .unwrap();
            assert!(
                preview(root, "link.png").unwrap().is_none(),
                "links out of the folder are refused"
            );
        }
        assert!(preview("relative", "chart.png").is_err());
    }
}
