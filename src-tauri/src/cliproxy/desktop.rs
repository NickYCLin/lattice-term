use std::ffi::OsStr;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Mutex;
use zeroize::Zeroizing;

const MAX_CONFIG_BYTES: u64 = 2 * 1024 * 1024;
const NO_KEY: &str = "latticeterm-cliproxyapi";
static CONFIG_WRITE: Mutex<()> = Mutex::new(());

fn safe_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err(
            "The Codex configuration path must be absolute and contain no parent traversal.".into(),
        );
    }
    for ancestor in path.ancestors() {
        match std::fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                let unsafe_path = metadata.file_type().is_symlink();
                #[cfg(windows)]
                let unsafe_path = {
                    use std::os::windows::fs::MetadataExt;
                    unsafe_path || metadata.file_attributes() & 0x400 != 0
                };
                if unsafe_path
                    || (ancestor != path && !metadata.is_dir())
                    || (ancestor == path && !metadata.is_file())
                {
                    return Err(
                        "The Codex configuration path must not contain links or special files."
                            .into(),
                    );
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Cannot inspect the Codex configuration path.".into()),
        }
    }
    Ok(())
}

fn snapshot(path: &Path) -> Result<Option<String>, String> {
    safe_path(path)?;
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot open the Codex configuration.".into()),
    };
    let mut text = String::new();
    file.take(MAX_CONFIG_BYTES + 1)
        .read_to_string(&mut text)
        .map_err(|_| "Cannot read the Codex configuration.")?;
    if text.len() as u64 > MAX_CONFIG_BYTES {
        return Err("The Codex configuration exceeds the compatibility limit.".into());
    }
    Ok(Some(text))
}

pub(super) fn register(home: &Path, providers: &[&str], table: &toml::Table) -> Result<(), String> {
    register_with(home, providers, table, || {})
}

fn register_with(
    home: &Path,
    providers: &[&str],
    table: &toml::Table,
    before_save: impl FnOnce(),
) -> Result<(), String> {
    let _guard = CONFIG_WRITE
        .lock()
        .map_err(|_| "The Codex configuration lock is unavailable.")?;
    let path = home.join("config.toml");
    let original = snapshot(&path)?;
    let original_text = original.as_deref().unwrap_or_default();
    let value: toml::Table = toml::from_str(original_text)
        .map_err(|_| "Cannot parse the Codex configuration; it was not changed.")?;
    let mut additions = toml::Table::new();
    for provider in providers {
        if !super::launch::is_managed_provider(provider) {
            return Err("Only LatticeTerm CLIProxyAPI providers can be registered.".into());
        }
        match value
            .get("model_providers")
            .and_then(|providers| providers.get(provider))
        {
            Some(existing) if existing.as_table() == Some(table) => {}
            Some(_) => {
                return Err(
                    "The saved provider conflicts with Codex configuration; it was not changed."
                        .into(),
                )
            }
            None => {
                additions.insert((*provider).into(), table.clone().into());
            }
        }
    }
    if additions.is_empty() {
        return Ok(());
    }
    let mut root = toml::Table::new();
    root.insert("model_providers".into(), additions.into());
    let suffix = toml::to_string(&root).map_err(|_| "Cannot encode the provider configuration.")?;
    let updated = format!("{original_text}\n{suffix}");
    let _: toml::Table = toml::from_str(&updated).map_err(|_| {
        "The existing Codex table layout cannot be extended safely; it was not changed."
    })?;
    if updated.len() as u64 > MAX_CONFIG_BYTES {
        return Err("The Codex configuration exceeds the compatibility limit.".into());
    }
    std::fs::create_dir_all(home)
        .map_err(|_| "Cannot create the Codex configuration directory.")?;
    safe_path(&path)?;
    let mut temporary = tempfile::NamedTempFile::new_in(home)
        .map_err(|_| "Cannot prepare the Codex configuration.")?;
    if original.is_some() {
        let permissions = std::fs::metadata(&path)
            .map_err(|_| "Cannot inspect Codex configuration permissions.")?
            .permissions();
        temporary
            .as_file()
            .set_permissions(permissions)
            .map_err(|_| "Cannot preserve Codex configuration permissions.")?;
    }
    temporary
        .write_all(updated.as_bytes())
        .map_err(|_| "Cannot write the provider configuration.")?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| "Cannot sync the provider configuration.")?;
    before_save();
    if snapshot(&path)? != original {
        return Err(
            "The Codex configuration changed outside LatticeTerm. Retry after reviewing it.".into(),
        );
    }
    temporary
        .persist(&path)
        .map_err(|_| "Cannot replace the Codex configuration.")?;
    Ok(())
}

fn inherited_token(
    route: Option<String>,
    key: Option<String>,
    expected: &str,
) -> Option<Zeroizing<String>> {
    let key = key.map(Zeroizing::new);
    (route.as_deref() == Some(expected))
        .then(|| key.unwrap_or_else(|| Zeroizing::new(NO_KEY.into())))
}

fn token(proxy_id: &str, base_url: &str) -> Result<Zeroizing<String>, String> {
    crate::credentials::cli_proxy_credential_id(Some(proxy_id))?;
    let normalized = super::normalize_base_url(base_url)?;
    if normalized != base_url {
        return Err("The saved CLIProxyAPI address is invalid.".into());
    }
    let route = super::launch::desktop_provider(base_url, proxy_id);
    let key = if let Some(key) = inherited_token(
        std::env::var(super::launch::KEY_ROUTE_ENV).ok(),
        std::env::var(super::launch::KEY_ENV).ok(),
        &route,
    ) {
        key
    } else {
        let data_dir = crate::agent_daemon::default_data_dir()
            .ok_or("Cannot locate LatticeTerm credential storage.")?;
        crate::credentials::initialize(data_dir);
        if crate::credentials::cli_proxy_key_exists(Some(proxy_id))? {
            crate::credentials::load_cli_proxy_key(Some(proxy_id), base_url)?
        } else {
            Zeroizing::new(NO_KEY.into())
        }
    };
    if key.is_empty() || key.len() > 512 || key.chars().any(char::is_control) {
        return Err("The saved CLIProxyAPI key is invalid.".into());
    }
    Ok(key)
}

pub fn run_cli<I, S>(arguments: I) -> Option<i32>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let arguments: Vec<_> = arguments
        .into_iter()
        .map(|argument| argument.as_ref().to_os_string())
        .collect();
    if arguments.first().and_then(|value| value.to_str()) != Some("cliproxy-token") {
        return None;
    }
    let result = match arguments.as_slice() {
        [_, proxy_id, base_url] => match (proxy_id.to_str(), base_url.to_str()) {
            (Some(proxy_id), Some(base_url)) => token(proxy_id, base_url),
            _ => Err("Invalid credential helper arguments.".into()),
        },
        _ => Err("Invalid credential helper arguments.".into()),
    };
    match result {
        Ok(key) => Some(
            if writeln!(std::io::stdout().lock(), "{}", key.as_str()).is_ok() {
                0
            } else {
                1
            },
        ),
        Err(_) => {
            eprintln!("Cannot load this CLIProxyAPI credential. Check its address and saved key in LatticeTerm. Standalone desktop resume cannot read encrypted-vault credentials; continue in LatticeTerm instead. No other account was used.");
            Some(1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider() -> toml::Table {
        toml::from_str("name = 'CLIProxyAPI'\nbase_url = 'http://127.0.0.1:8317/v1'\nwire_api = 'responses'\n[auth]\ncommand = 'fixture-helper'\nargs = ['cliproxy-token', 'work', 'http://127.0.0.1:8317']").unwrap()
    }

    #[test]
    fn registers_without_changing_chatgpt_defaults_or_comments() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("config.toml");
        let original = "# keep this\nmodel_provider = 'openai'\nmodel = 'native-model'\n[projects.'/work']\ntrust_level = 'trusted'\n";
        std::fs::write(&path, original).unwrap();
        let name = "latticeterm_cliproxyapi_v3_work_0123";
        register(home.path(), &[name], &provider()).unwrap();
        let first = std::fs::read_to_string(&path).unwrap();
        assert!(first.starts_with(original));
        let parsed: toml::Value = toml::from_str(&first).unwrap();
        assert_eq!(parsed["model_provider"].as_str(), Some("openai"));
        assert_eq!(
            parsed["model_providers"][name]["auth"]["command"].as_str(),
            Some("fixture-helper")
        );
        assert!(parsed["model_providers"][name].get("env_key").is_none());
        register(home.path(), &[name], &provider()).unwrap();
        assert_eq!(std::fs::read_to_string(path).unwrap(), first);
    }

    #[test]
    fn refuses_conflicts_invalid_toml_and_external_edits() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("config.toml");
        let name = "latticeterm_cliproxyapi_fixture";
        for original in [
            "not valid TOML",
            "[model_providers.latticeterm_cliproxyapi_fixture]\nbase_url = 'https://other.invalid'",
            "model_providers = {}",
        ] {
            std::fs::write(&path, original).unwrap();
            assert!(register(home.path(), &[name], &provider()).is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        }
        std::fs::write(&path, "model = 'original'").unwrap();
        assert!(register_with(home.path(), &[name], &provider(), || {
            std::fs::write(&path, "model = 'external'").unwrap();
        })
        .is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "model = 'external'");
    }

    #[test]
    fn rejects_native_provider_names_and_directory_targets() {
        let home = tempfile::tempdir().unwrap();
        assert!(register(home.path(), &["openai"], &provider()).is_err());
        assert!(!home.path().join("config.toml").exists());
        std::fs::create_dir(home.path().join("config.toml")).unwrap();
        assert!(register(home.path(), &["latticeterm_cliproxyapi_work"], &provider()).is_err());
        assert!(safe_path(Path::new("relative/config.toml")).is_err());
        assert!(safe_path(&home.path().join("../config.toml")).is_err());
    }

    #[test]
    fn inherited_credentials_are_bound_to_the_exact_route() {
        assert!(inherited_token(
            Some("other".into()),
            Some("fixture-secret".into()),
            "expected"
        )
        .is_none());
        assert!(inherited_token(None, Some("fixture-secret".into()), "expected").is_none());
        assert_eq!(
            inherited_token(
                Some("expected".into()),
                Some("fixture-secret".into()),
                "expected"
            )
            .unwrap()
            .as_str(),
            "fixture-secret"
        );
        assert_eq!(
            inherited_token(Some("expected".into()), None, "expected")
                .unwrap()
                .as_str(),
            NO_KEY
        );
    }

    #[test]
    fn helper_does_not_handle_other_commands_or_incomplete_requests() {
        assert_eq!(run_cli(["mcp"]), None);
        assert_eq!(run_cli(["cliproxy-token"]), Some(1));
        assert_eq!(
            run_cli(["cliproxy-token", "bad.id", "http://127.0.0.1:8317"]),
            Some(1)
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_configuration() {
        let home = tempfile::tempdir().unwrap();
        let target = home.path().join("external.toml");
        std::fs::write(&target, "model = 'external'").unwrap();
        std::os::unix::fs::symlink(&target, home.path().join("config.toml")).unwrap();
        assert!(register(home.path(), &["latticeterm_cliproxyapi_work"], &provider()).is_err());
        assert_eq!(
            std::fs::read_to_string(target).unwrap(),
            "model = 'external'"
        );
    }
}
