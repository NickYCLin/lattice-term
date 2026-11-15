//! Bounded artifact reads from the project or this conversation's own directory.
use base64::Engine;
use serde::Serialize;
use std::{
    io::Read,
    path::{Component, Path},
};
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub name: String,
    pub kind: &'static str,
    pub content: String,
}
pub fn read(
    directory: &str,
    value: &str,
    chat_directory: Option<&Path>,
) -> Result<Artifact, String> {
    if value.len() > 4096 || value.chars().any(char::is_control) {
        return Err("產物路徑無效。".into());
    }
    let without_fragment = value.split('#').next().unwrap_or(value);
    let value = without_fragment
        .rsplit_once(':')
        .filter(|(_, line)| !line.is_empty() && line.bytes().all(|c| c.is_ascii_digit()))
        .map_or(without_fragment, |(path, _)| path);
    let chat_root = chat_directory.and_then(|path| path.canonicalize().ok());
    let root = if directory.trim().is_empty() {
        chat_root.clone().ok_or("對話產物資料夾不可用。")?
    } else {
        let root = Path::new(directory);
        if !root.is_absolute() {
            return Err("專案路徑必須是絕對路徑。".into());
        }
        root.canonicalize().map_err(|e| e.to_string())?
    };
    let requested = Path::new(value);
    if requested
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err("產物路徑不可跨出專案。".into());
    }
    let path = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        root.join(requested)
    };
    let resolved = path.canonicalize().map_err(|e| e.to_string())?;
    if !resolved.starts_with(&root)
        && !chat_root
            .as_ref()
            .is_some_and(|root| resolved.starts_with(root))
    {
        return Err("只能預覽目前專案與本對話的產物。".into());
    }
    let mut file = crate::local_files::open_regular(&resolved)?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > 16 * 1024 * 1024 {
        return Err("產物必須是 16 MiB 內的檔案。".into());
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("產物讀取時超過大小限制。".into());
    }
    let name = resolved
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let extension = resolved
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    let mime = if bytes.starts_with(b"%PDF-") {
        Some("application/pdf")
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[255, 216, 255]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF8") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else {
        None
    };
    if let Some(mime) = mime {
        return Ok(Artifact {
            name,
            kind: if mime == "application/pdf" {
                "pdf"
            } else {
                "image"
            },
            content: format!(
                "data:{mime};base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            ),
        });
    }
    if bytes.len() > 1024 * 1024 || bytes.contains(&0) {
        return Err("文字預覽上限為 1 MiB。".into());
    }
    let content = String::from_utf8(bytes).map_err(|_| "這個檔案不是 UTF-8 文字。")?;
    let kind = match extension.as_str() {
        "html" | "htm" => "html",
        "md" | "markdown" => "markdown",
        "svg" => "svg",
        _ => "text",
    };
    Ok(Artifact {
        name,
        kind,
        content,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scopes_reads_and_preserves_html_for_a_separate_sandbox() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("page.html"), "<script>bad()</script>").unwrap();
        std::fs::write(outside.path().join("private.txt"), "private").unwrap();
        let dir = root.path().to_str().unwrap();
        assert_eq!(read(dir, "page.html:12", None).unwrap().kind, "html");
        assert!(read(dir, "../private.txt", None).is_err());
        assert!(read(
            dir,
            outside.path().join("private.txt").to_str().unwrap(),
            None
        )
        .is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                outside.path().join("private.txt"),
                root.path().join("link"),
            )
            .unwrap();
            assert!(read(dir, "link", None).is_err());
        }
        std::fs::write(root.path().join("bad.txt"), b"binary\0data").unwrap();
        assert!(read(dir, "bad.txt", None).is_err());
    }
    #[test]
    fn own_chat_artifacts_are_available_without_reading_other_conversations() {
        let project = tempfile::tempdir().unwrap();
        let own = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        std::fs::write(own.path().join("generated.svg"), "<svg/>").unwrap();
        std::fs::write(other.path().join("private.txt"), "private").unwrap();
        assert_eq!(
            read("", "generated.svg", Some(own.path())).unwrap().kind,
            "svg"
        );
        assert!(read(
            project.path().to_str().unwrap(),
            own.path().join("generated.svg").to_str().unwrap(),
            Some(own.path())
        )
        .is_ok());
        assert!(read(
            project.path().to_str().unwrap(),
            other.path().join("private.txt").to_str().unwrap(),
            Some(own.path())
        )
        .is_err());
    }
}
