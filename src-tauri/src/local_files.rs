//! Read-only access to files explicitly selected or dropped in the desktop UI.
use serde::Serialize;
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::path::Path;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPathInfo {
    name: String,
    size: u64,
    kind: &'static str,
}

fn validate_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute() || path.as_os_str().len() > 32768 {
        return Err("localFile.invalidPath".into());
    }
    Ok(())
}
pub fn info(path: &Path) -> Result<LocalPathInfo, String> {
    validate_path(path)?;
    let metadata = path
        .symlink_metadata()
        .map_err(|_| "localFile.unreadable")?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("localFile.unsupported".into());
        }
    }
    let kind = if metadata.is_file() {
        "file"
    } else if metadata.is_dir() {
        "directory"
    } else {
        return Err("localFile.unsupported".into());
    };
    let name = path
        .file_name()
        .or_else(|| metadata.is_dir().then_some(path.as_os_str()))
        .and_then(|name| name.to_str())
        .ok_or("localFile.invalidPath")?
        .to_owned();
    Ok(LocalPathInfo {
        name,
        size: metadata.len(),
        kind,
    })
}

pub fn open_regular(path: &Path) -> Result<File, String> {
    validate_path(path)?;
    if !path
        .symlink_metadata()
        .map_err(|_| "localFile.unreadable")?
        .is_file()
    {
        return Err("localFile.unsupported".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = options.open(path).map_err(|_| "localFile.unreadable")?;
    if !file
        .metadata()
        .map_err(|_| "localFile.unreadable")?
        .is_file()
    {
        return Err("localFile.unsupported".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if file
            .metadata()
            .map_err(|_| "localFile.unreadable")?
            .file_attributes()
            & 0x400
            != 0
        {
            return Err("localFile.unsupported".into());
        }
    }
    Ok(file)
}

pub fn read_text(path: &Path, max_bytes: u64) -> Result<String, String> {
    if max_bytes == 0 || max_bytes > 28 * 1024 * 1024 {
        return Err("localFile.tooLarge".into());
    }
    let file = open_regular(path)?;
    if file.metadata().map_err(|_| "localFile.unreadable")?.len() > max_bytes {
        return Err("localFile.tooLarge".into());
    }
    let mut bytes = Vec::new();
    file.take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "localFile.unreadable")?;
    if bytes.len() as u64 > max_bytes {
        return Err("localFile.tooLarge".into());
    }
    String::from_utf8(bytes).map_err(|_| "localFile.invalidText".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn text_import_is_bounded_and_rejects_non_files() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(info(dir.path()).unwrap().kind, "directory");
        assert_eq!(
            info(dir.path().ancestors().last().unwrap()).unwrap().kind,
            "directory"
        );
        let path = dir.path().join("設定.json");
        std::fs::write(&path, "中文").unwrap();
        assert_eq!(read_text(&path, 6).unwrap(), "中文");
        assert!(read_text(&path, 5).is_err());
        assert!(read_text(dir.path(), 100).is_err());
        assert!(read_text(Path::new("relative.json"), 100).is_err());
        std::fs::write(&path, [0xff]).unwrap();
        assert!(read_text(&path, 100).is_err());
        #[cfg(unix)]
        {
            let link = dir.path().join("link");
            std::os::unix::fs::symlink(&path, &link).unwrap();
            assert!(open_regular(&link).is_err());
        }
    }
}
