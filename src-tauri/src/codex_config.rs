use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

static REPAIR_LOCK: Mutex<()> = Mutex::new(());
const MAX_CONFIG_BYTES: u64 = 1024 * 1024;

pub(crate) fn repair_legacy_catalog(profile: Option<&Path>) -> Result<bool, String> {
    let directory = profile
        .map(Path::to_path_buf)
        .or_else(|| std::env::var_os("CODEX_HOME").map(PathBuf::from))
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
        .ok_or("Cannot locate the Codex configuration directory.")?;
    repair_in(&directory, || {})
}

fn legacy_catalog(raw: &str) -> bool {
    let normalized = raw.replace('\\', "/");
    let absolute = normalized.starts_with('/')
        || normalized.as_bytes().get(1) == Some(&b':')
            && normalized.as_bytes().get(2) == Some(&b'/')
            && normalized.as_bytes()[0].is_ascii_alphabetic();
    let components = normalized.split('/').collect::<Vec<_>>();
    if !absolute || components.iter().any(|part| matches!(*part, "." | "..")) {
        return false;
    }
    let Some(tail) = components.get(components.len().saturating_sub(4)..) else {
        return false;
    };
    if tail.len() != 4 {
        return false;
    }
    tail[0].eq_ignore_ascii_case("LatticeTerm")
        && tail[1].eq_ignore_ascii_case("diagnostics")
        && tail[2]
            .strip_prefix("codex-direct-tools-")
            .is_some_and(|date| date.len() == 8 && date.bytes().all(|byte| byte.is_ascii_digit()))
        && tail[3] == "models-astra-direct.json"
}

fn without_legacy_catalog(content: &str) -> Option<String> {
    let mut config = content.parse::<toml::Table>().ok()?;
    if config
        .get("model_provider")
        .is_some_and(|provider| provider.as_str() != Some("openai"))
    {
        return None;
    }
    let catalog = config.get("model_catalog_json")?.as_str()?;
    if !legacy_catalog(catalog) {
        return None;
    }
    let catalog = catalog.to_string();
    config.remove("model_catalog_json");
    let mut offset = 0;
    for line in content.split_inclusive('\n') {
        if let Ok(entry) = line.parse::<toml::Table>() {
            if entry.len() == 1
                && entry
                    .get("model_catalog_json")
                    .and_then(toml::Value::as_str)
                    == Some(catalog.as_str())
            {
                let next = format!("{}{}", &content[..offset], &content[offset + line.len()..]);
                if next.parse::<toml::Table>().ok().as_ref() == Some(&config) {
                    return Some(next);
                }
            }
        }
        offset += line.len();
    }
    None
}

fn repair_in(directory: &Path, before_replace: impl FnOnce()) -> Result<bool, String> {
    let _guard = REPAIR_LOCK
        .lock()
        .map_err(|_| "Cannot lock the Codex configuration repair.")?;
    if !directory.is_absolute()
        || directory
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("The Codex configuration directory must be an absolute, safe path.".into());
    }
    let path = directory.join("config.toml");
    match path.symlink_metadata() {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Ok(false),
        Ok(metadata) if !metadata.is_file() => {
            return Ok(false);
        }
        Ok(_) => {}
    }
    let Ok(original) = crate::local_files::read_text(&path, MAX_CONFIG_BYTES) else {
        return Ok(false);
    };
    let Some(next) = without_legacy_catalog(&original) else {
        return Ok(false);
    };
    let mut backup = tempfile::Builder::new()
        .prefix(".latticeterm-codex-model-catalog-")
        .suffix(".bak")
        .tempfile_in(directory)
        .map_err(|_| "Cannot create a backup of the Codex configuration.")?;
    backup
        .write_all(original.as_bytes())
        .and_then(|()| backup.as_file().sync_all())
        .map_err(|_| "Cannot finish the Codex configuration backup.")?;
    backup
        .keep()
        .map_err(|_| "Cannot preserve the Codex configuration backup.")?;
    before_replace();
    if crate::local_files::read_text(&path, MAX_CONFIG_BYTES)
        .ok()
        .as_deref()
        != Some(original.as_str())
    {
        return Err(
            "The Codex configuration changed outside LatticeTerm. Please try again.".into(),
        );
    }
    crate::durable_file::atomic_write_private(&path, next.as_bytes())
        .map_err(|_| "Cannot repair the Codex model catalog. The configuration backup was kept.")?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> String {
        "# Keep this comment\r\nmodel = 'gpt-6-astra'\r\nmodel_catalog_json = 'C:\\example\\LatticeTerm\\diagnostics\\codex-direct-tools-20260922\\models-astra-direct.json'\r\n[features]\r\nkeep = true\r\n".into()
    }

    #[test]
    fn removes_only_the_legacy_root_entry_without_reformatting() {
        let next = without_legacy_catalog(&config()).unwrap();
        assert_eq!(
            next,
            "# Keep this comment\r\nmodel = 'gpt-6-astra'\r\n[features]\r\nkeep = true\r\n"
        );
        assert!(without_legacy_catalog(&next).is_none());
        let last_line = "model_catalog_json = '/tmp/LatticeTerm/diagnostics/codex-direct-tools-20260922/models-astra-direct.json'";
        assert_eq!(without_legacy_catalog(last_line), Some(String::new()));
    }

    #[test]
    fn preserves_custom_proxy_nested_and_invalid_configurations() {
        for content in [
            config().replace("models-astra-direct.json", "custom.json"),
            config().replace("LatticeTerm", "another-app"),
            format!("model_provider = 'custom'\n{}", config()),
            format!("[profiles.custom]\n{}", config()),
            format!("[model_providers.custom]\n{}", config()),
            format!("invalid = [\n{}", config()),
            "model_catalog_json = '/tmp/latticeterm-cliproxy-models-test.json'".into(),
        ] {
            assert!(without_legacy_catalog(&content).is_none());
        }
    }

    #[test]
    fn rejects_relative_traversing_and_lookalike_catalog_paths() {
        for raw in [
            "LatticeTerm/diagnostics/codex-direct-tools-20260922/models-astra-direct.json",
            "/tmp/../LatticeTerm/diagnostics/codex-direct-tools-20260922/models-astra-direct.json",
            "/tmp/LatticeTerm/diagnostics/codex-direct-tools-latest/models-astra-direct.json",
            "/tmp/LatticeTerm/diagnostics/codex-direct-tools-20260922/models-astra-direct.json/extra",
        ] {
            assert!(!legacy_catalog(raw));
        }
    }

    #[test]
    fn backs_up_each_profile_once_and_preserves_other_files() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.toml");
        std::fs::write(&path, config()).unwrap();
        std::fs::write(directory.path().join("auth.json"), "untouched").unwrap();
        assert!(repair_in(directory.path(), || {}).unwrap());
        assert!(!repair_in(directory.path(), || {}).unwrap());
        let backups = std::fs::read_dir(directory.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".bak"))
            .collect::<Vec<_>>();
        assert_eq!(backups.len(), 1);
        assert_eq!(
            std::fs::read_to_string(backups[0].path()).unwrap(),
            config()
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join("auth.json")).unwrap(),
            "untouched"
        );
        assert_eq!(
            std::fs::read_to_string(path).unwrap(),
            without_legacy_catalog(&config()).unwrap()
        );
    }

    #[test]
    fn refuses_an_external_edit_without_overwriting_it() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.toml");
        std::fs::write(&path, config()).unwrap();
        let result = repair_in(directory.path(), || {
            std::fs::write(&path, "model = 'changed-elsewhere'\n").unwrap();
        });
        assert!(result.unwrap_err().contains("changed outside"));
        assert_eq!(
            std::fs::read_to_string(path).unwrap(),
            "model = 'changed-elsewhere'\n"
        );
    }

    #[test]
    fn skips_missing_files_and_refuses_unsafe_targets() {
        let directory = tempfile::tempdir().unwrap();
        assert!(!repair_in(directory.path(), || {}).unwrap());
        assert!(repair_in(Path::new("relative"), || {}).is_err());
        std::fs::create_dir(directory.path().join("config.toml")).unwrap();
        assert!(!repair_in(directory.path(), || {}).unwrap());
    }

    #[test]
    fn skips_unreadable_formats_without_creating_backups() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.toml");
        for content in [vec![0xff], vec![b' '; MAX_CONFIG_BYTES as usize + 1]] {
            std::fs::write(&path, &content).unwrap();
            assert!(!repair_in(directory.path(), || {}).unwrap());
            assert_eq!(std::fs::read(&path).unwrap(), content);
            assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
        }
    }

    #[test]
    fn repairs_only_the_selected_profile() {
        let selected = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        for directory in [selected.path(), other.path()] {
            std::fs::write(directory.join("config.toml"), config()).unwrap();
        }
        assert!(repair_legacy_catalog(Some(selected.path())).unwrap());
        assert_eq!(
            std::fs::read_to_string(other.path().join("config.toml")).unwrap(),
            config()
        );
        assert_eq!(std::fs::read_dir(other.path()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_and_keeps_private_backups() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(outside.path(), config()).unwrap();
        let path = directory.path().join("config.toml");
        symlink(outside.path(), &path).unwrap();
        assert!(!repair_in(directory.path(), || {}).unwrap());
        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, config()).unwrap();
        assert!(repair_in(directory.path(), || {}).unwrap());
        for entry in std::fs::read_dir(directory.path())
            .unwrap()
            .filter_map(Result::ok)
        {
            assert_eq!(entry.metadata().unwrap().permissions().mode() & 0o077, 0);
        }
    }
}
