//! Process-local Codex configuration. Saved launch arguments contain the
//! endpoint, while credentials are loaded again each time a process starts.

use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

pub const PROVIDER: &str = "latticeterm_cliproxyapi";
pub const KEY_ENV: &str = "LATTICETERM_CLI_PROXY_API_KEY";
/// Sent when the proxy has no saved key. A fixed placeholder keeps Claude
/// Code from sending the user's own Anthropic login to the proxy instead.
const NO_KEY_PLACEHOLDER: &str = "latticeterm-cliproxyapi";

/// Which configured proxy a saved launch belongs to. The marker of the proxy
/// that predates multiple entries carries no identifier, so restoring an
/// older workspace still finds the key in its original slot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProxyTarget {
    pub base_url: String,
    pub id: Option<String>,
}

fn saved_provider(proxy_id: Option<&str>) -> String {
    match proxy_id.filter(|id| *id != crate::credentials::CLI_PROXY_DEFAULT_ID) {
        Some(id) => format!("{PROVIDER}_{id}"),
        None => PROVIDER.to_string(),
    }
}

/// `None` when the marker is not ours; `Some(id)` when it is, where the inner
/// value names the configured proxy.
fn saved_provider_id(name: &str) -> Option<Option<String>> {
    if name == PROVIDER {
        return Some(None);
    }
    let suffix = name.strip_prefix(PROVIDER)?.strip_prefix('_')?;
    let valid = !suffix.is_empty()
        && suffix.len() <= 32
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit());
    valid.then(|| Some(suffix.to_string()))
}

pub struct ProxyLaunch {
    base_url: String,
    key: Option<Zeroizing<String>>,
    provider: String,
}

impl ProxyLaunch {
    pub fn load(base_url: &str, proxy_id: Option<&str>) -> Result<Self, String> {
        let base_url = super::normalize_base_url(base_url)?;
        let key = if crate::credentials::cli_proxy_key_exists(proxy_id)? {
            Some(crate::credentials::load_cli_proxy_key(proxy_id, &base_url)?)
        } else {
            None
        };
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).map_err(|_| "Cannot create a CLIProxyAPI process identity.")?;
        let suffix: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
        Ok(Self {
            base_url,
            key,
            provider: format!(
                "{PROVIDER}_v2_{}_{suffix}",
                proxy_id.unwrap_or(crate::credentials::CLI_PROXY_DEFAULT_ID)
            ),
        })
    }

    /// Codex deep-merges provider tables. A fresh name prevents stale headers,
    /// bearer tokens or auth commands from an existing provider being inherited.
    pub fn arguments(&self) -> Vec<String> {
        let provider = self.provider_table();
        vec![
            "-c".into(),
            format!("model_provider={}", self.provider),
            "-c".into(),
            format!(
                "model_providers.{}={}",
                self.provider,
                toml::Value::Table(provider)
            ),
        ]
    }

    fn provider_table(&self) -> toml::Table {
        let mut provider = toml::Table::new();
        provider.insert("name".into(), "CLIProxyAPI".into());
        provider.insert("base_url".into(), format!("{}/v1", self.base_url).into());
        provider.insert("wire_api".into(), "responses".into());
        provider.insert("requires_openai_auth".into(), false.into());
        if self.key.is_some() {
            provider.insert("env_key".into(), KEY_ENV.into());
        }
        provider
    }

    /// TUI resume restores the provider saved in the thread, even when the
    /// process selects a fresh one. Supply that missing definition only for
    /// our own namespace. Credentials still come from the child environment.
    pub fn resume_arguments(&self, provider: &str) -> Result<Vec<String>, String> {
        if !is_managed_provider(provider) {
            return Err("Cannot replace another provider while resuming a conversation.".into());
        }
        Ok(vec![
            "-c".into(),
            format!(
                "model_providers.{provider}={}",
                toml::Value::Table(self.provider_table())
            ),
        ])
    }

    pub fn key(&self) -> Option<&str> {
        self.key.as_ref().map(|key| key.as_str())
    }

    pub fn provider(&self) -> &str {
        &self.provider
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Claude Code and Gemini CLI read the endpoint and key from the
    /// environment. `None` removes a variable that would route the session
    /// elsewhere or put a different credential in front of the proxy.
    pub fn agent_environment(&self, definition_id: &str) -> Vec<(&'static str, Option<&str>)> {
        let key = Some(self.key().unwrap_or(NO_KEY_PLACEHOLDER));
        match definition_id {
            "claude" => vec![
                ("ANTHROPIC_API_KEY", None),
                ("CLAUDE_CODE_OAUTH_TOKEN", None),
                ("ANTHROPIC_CUSTOM_HEADERS", None),
                ("CLAUDE_CODE_USE_BEDROCK", None),
                ("CLAUDE_CODE_USE_VERTEX", None),
                ("CLAUDE_CODE_USE_FOUNDRY", None),
                ("ANTHROPIC_BASE_URL", Some(self.base_url.as_str())),
                ("ANTHROPIC_AUTH_TOKEN", key),
            ],
            "gemini" => vec![
                ("GOOGLE_API_KEY", None),
                ("GOOGLE_GENAI_USE_GCA", None),
                ("GOOGLE_GENAI_USE_VERTEXAI", None),
                ("GEMINI_DEFAULT_AUTH_TYPE", None),
                ("GOOGLE_GEMINI_BASE_URL", Some(self.base_url.as_str())),
                ("GEMINI_API_KEY", key),
            ],
            _ => Vec::new(),
        }
    }

    /// Saved metadata uses a stable marker; the actual process must only see
    /// its fresh provider name, including when resuming a native conversation.
    pub fn configure_arguments(&self, arguments: Vec<String>) -> Vec<String> {
        let mut configured = self.arguments();
        configured.extend(without_saved_arguments(arguments));
        configured
    }

    /// Reconnect after an address/key change without keeping another copy of
    /// the key in the background server's state or exposing it to the UI.
    pub fn identity(&self) -> [u8; 32] {
        let mut digest = Sha256::new();
        digest.update(self.base_url.as_bytes());
        digest.update([0]);
        digest.update(self.key().unwrap_or_default().as_bytes());
        digest.finalize().into()
    }
}

pub fn is_managed_provider(provider: &str) -> bool {
    provider == PROVIDER
        || provider
            .strip_prefix(&format!("{PROVIDER}_"))
            .is_some_and(|suffix| {
                !suffix.is_empty()
                    && suffix.len() <= 80
                    && suffix.bytes().all(|byte| {
                        byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_'
                    })
            })
}

/// Do not merge a recovery alias into a user-defined provider: inherited
/// headers or auth commands could redirect credentials. Check user/profile
/// and project configuration before adding the process-local alias.
pub fn check_resume_alias(
    provider: &str,
    config_home: &std::path::Path,
    cwd: &std::path::Path,
) -> Result<(), String> {
    fn defines(value: &toml::Value, provider: &str) -> bool {
        value
            .get("model_providers")
            .and_then(|v| v.get(provider))
            .is_some()
            || value
                .as_table()
                .is_some_and(|table| table.values().any(|v| defines(v, provider)))
    }
    let mut paths = vec![config_home.join("config.toml")];
    match std::fs::read_dir(config_home) {
        Ok(entries) => {
            for entry in entries {
                let entry = entry.map_err(|_| "Cannot inspect Codex account configuration.")?;
                if entry
                    .file_name()
                    .to_str()
                    .is_some_and(|n| n.ends_with(".config.toml"))
                {
                    paths.push(entry.path());
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("Cannot inspect Codex account configuration.".into()),
    }
    paths.extend(cwd.ancestors().map(|dir| dir.join(".codex/config.toml")));
    for path in paths {
        let file =
            match std::fs::File::open(&path) {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err(
                    "Cannot verify Codex configuration before restoring the proxy conversation."
                        .into(),
                ),
            };
        use std::io::Read;
        let mut text = String::new();
        file.take(2 * 1024 * 1024 + 1)
            .read_to_string(&mut text)
            .map_err(|_| "Cannot read Codex configuration.")?;
        if text.len() > 2 * 1024 * 1024 {
            return Err("Codex configuration exceeds the recovery limit.".into());
        }
        let value: toml::Value =
            toml::from_str(&text).map_err(|_| "Cannot parse Codex configuration.")?;
        if defines(&value, provider) {
            return Err("The saved proxy provider is already defined in Codex configuration. Remove the conflicting definition or resume it directly in Codex.".into());
        }
    }
    Ok(())
}

/// Whether the arguments carry a saved proxy marker at all, including ones
/// that `base_from_arguments` would reject. Used to stop CLIs that cannot be
/// held to the proxy from starting with it.
pub fn names_saved_proxy(arguments: &[String]) -> bool {
    arguments.windows(2).any(|pair| {
        (pair[0] == "-c" || pair[0] == "--config")
            && pair[1]
                .strip_prefix("model_provider=")
                .is_some_and(|name| saved_provider_id(name).is_some())
    })
}

pub fn base_from_arguments(arguments: &[String]) -> Result<Option<ProxyTarget>, String> {
    let overrides: Vec<&str> = arguments
        .windows(2)
        .filter(|pair| pair[0] == "-c" || pair[0] == "--config")
        .map(|pair| pair[1].as_str())
        .collect();
    let providers: Vec<&str> = overrides
        .iter()
        .filter_map(|value| value.strip_prefix("model_provider="))
        .collect();
    let Some(marker) = providers.first().copied() else {
        return Ok(None);
    };
    let Some(id) = saved_provider_id(marker) else {
        return Ok(None);
    };
    let marker_override = format!("model_provider={marker}");
    let base_override = format!("model_providers.{marker}.base_url=");
    let bases: Vec<_> = overrides
        .iter()
        .filter_map(|value| value.strip_prefix(base_override.as_str()))
        .collect();
    if bases.len() != 1
        || providers.len() != 1
        || arguments
            .iter()
            .any(|arg| arg.starts_with("--config=") || (arg.starts_with("-c") && arg != "-c"))
        || overrides
            .iter()
            .any(|value| *value != marker_override && !value.starts_with(base_override.as_str()))
    {
        return Err("CLIProxyAPI launch settings conflict with another provider override.".into());
    }
    let endpoint: String = serde_json::from_str(bases[0]).map_err(|_| "cliproxy.url.invalid")?;
    let root = endpoint.strip_suffix("/v1").ok_or("cliproxy.url.invalid")?;
    super::normalize_base_url(root).map(|base_url| Some(ProxyTarget { base_url, id }))
}

/// Drop the saved proxy marker. Only call after `base_from_arguments`
/// accepted the arguments, which guarantees every `-c` is one of ours. Claude
/// Code would otherwise read `-c` as `--continue`.
pub fn without_saved_arguments(arguments: Vec<String>) -> Vec<String> {
    let mut kept = Vec::with_capacity(arguments.len());
    let mut iter = arguments.into_iter();
    while let Some(argument) = iter.next() {
        if argument == "-c" || argument == "--config" {
            iter.next();
        } else {
            kept.push(argument);
        }
    }
    kept
}

/// The arguments LatticeTerm stores for a saved launch; the running process
/// receives the fresh provider name built in `arguments` instead.
pub fn saved_arguments(base_url: &str, proxy_id: Option<&str>) -> Vec<String> {
    let provider = saved_provider(proxy_id);
    vec![
        "-c".into(),
        format!("model_provider={provider}"),
        "-c".into(),
        format!(
            "model_providers.{provider}.base_url={}",
            serde_json::Value::String(format!("{base_url}/v1"))
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restores_the_missing_native_provider_without_persisting_credentials() {
        let proxy = launch(Some("fixture-secret"));
        let old = format!("{PROVIDER}_{}", "a".repeat(32));
        let args = proxy.resume_arguments(&old).unwrap();
        assert!(args[1].starts_with(&format!("model_providers.{old}=")));
        assert!(!args.join(" ").contains("fixture-secret"));
        let table: toml::Value = args[1].split_once('=').unwrap().1.parse().unwrap();
        assert_eq!(table["env_key"].as_str(), Some(KEY_ENV));
        assert!(proxy.resume_arguments("openai").is_err());
        assert!(proxy
            .resume_arguments("latticeterm_cliproxyapi_bad.key")
            .is_err());
    }

    #[test]
    fn refuses_to_merge_recovery_into_existing_provider_headers() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let provider = format!("{PROVIDER}_old");
        check_resume_alias(&provider, home.path(), project.path()).unwrap();
        std::fs::write(
            home.path().join("work.config.toml"),
            format!("[model_providers.{provider}.http_headers]\nAuthorization = 'stale'\n"),
        )
        .unwrap();
        assert!(check_resume_alias(&provider, home.path(), project.path()).is_err());
    }

    fn launch(key: Option<&str>) -> ProxyLaunch {
        ProxyLaunch {
            provider: format!("{PROVIDER}_fixture"),
            base_url: "http://127.0.0.1:8317/prefix".into(),
            key: key.map(|s| Zeroizing::new(s.into())),
        }
    }

    #[test]
    fn claude_and_gemini_receive_the_proxy_through_their_own_variables() {
        let proxy = launch(Some("fixture-secret"));
        let claude = proxy.agent_environment("claude");
        assert!(claude.contains(&("ANTHROPIC_BASE_URL", Some("http://127.0.0.1:8317/prefix"))));
        assert!(claude.contains(&("ANTHROPIC_AUTH_TOKEN", Some("fixture-secret"))));
        assert!(claude.contains(&("ANTHROPIC_API_KEY", None)));
        assert!(claude.contains(&("CLAUDE_CODE_OAUTH_TOKEN", None)));
        assert!(claude.contains(&("ANTHROPIC_CUSTOM_HEADERS", None)));
        let gemini = proxy.agent_environment("gemini");
        assert!(gemini.contains(&(
            "GOOGLE_GEMINI_BASE_URL",
            Some("http://127.0.0.1:8317/prefix")
        )));
        assert!(gemini.contains(&("GEMINI_API_KEY", Some("fixture-secret"))));
        assert!(gemini.contains(&("GOOGLE_GENAI_USE_GCA", None)));
        assert!(proxy.agent_environment("codex").is_empty());

        // Without a saved key the user's own Anthropic login must not be
        // forwarded to the proxy.
        let keyless = launch(None);
        assert!(keyless
            .agent_environment("claude")
            .contains(&("ANTHROPIC_AUTH_TOKEN", Some(NO_KEY_PLACEHOLDER))));
    }

    #[test]
    fn a_saved_marker_is_recognised_without_parsing_the_address() {
        assert!(names_saved_proxy(&saved_arguments(
            "http://localhost:8317",
            Some("work")
        )));
        assert!(!names_saved_proxy(&[
            "-c".to_string(),
            "model_provider=openai".to_string()
        ]));
        assert!(!names_saved_proxy(&[
            "--model".to_string(),
            "x".to_string()
        ]));
    }

    #[test]
    fn saved_marker_is_removed_before_claude_reads_dash_c() {
        let mut arguments = saved_arguments("http://localhost:8317", Some("work"));
        arguments.extend(["--model".to_string(), "claude-sonnet-4-5".to_string()]);
        assert_eq!(
            base_from_arguments(&arguments)
                .unwrap()
                .unwrap()
                .id
                .as_deref(),
            Some("work")
        );
        assert_eq!(
            without_saved_arguments(arguments),
            vec!["--model".to_string(), "claude-sonnet-4-5".to_string()]
        );
    }

    #[test]
    fn credentials_only_enter_the_child_environment() {
        let config = launch(Some("fixture-secret"));
        let arguments = config.arguments();
        assert!(!arguments.join(" ").contains("fixture-secret"));
        let provider: toml::Value = arguments[3].split_once('=').unwrap().1.parse().unwrap();
        assert_eq!(provider["env_key"].as_str(), Some(KEY_ENV));
        assert_eq!(
            provider["base_url"].as_str(),
            Some("http://127.0.0.1:8317/prefix/v1")
        );
        assert_eq!(provider["requires_openai_auth"].as_bool(), Some(false));
        assert_eq!(config.key(), Some("fixture-secret"));
        assert_ne!(config.identity(), launch(Some("replacement")).identity());
        assert!(!launch(None).arguments()[3].contains("env_key"));
    }

    #[test]
    fn saved_launches_keep_the_address_and_reject_conflicting_overrides() {
        let mut args = saved_arguments("http://localhost:8317", None);
        args.extend(["--model".into(), "test-model".into()]);
        assert_eq!(
            base_from_arguments(&args).unwrap(),
            Some(ProxyTarget {
                base_url: "http://localhost:8317".into(),
                id: None
            })
        );
        let configured = launch(Some("fixture-secret")).configure_arguments(args.clone());
        assert!(!configured
            .iter()
            .any(|arg| arg == "model_provider=latticeterm_cliproxyapi"));
        assert_eq!(
            &configured[configured.len() - 2..],
            &["--model", "test-model"]
        );
        assert!(configured
            .iter()
            .any(|arg| arg == "model_provider=latticeterm_cliproxyapi_fixture"));
        for conflicting in [
            "model_provider=other",
            "model_provider = 'other'",
            "model_providers={}",
            "\"model_provider\"='other'",
        ] {
            let mut conflicting_args = args.clone();
            conflicting_args.extend(["-c".into(), conflicting.into()]);
            assert!(base_from_arguments(&conflicting_args).is_err());
        }
        assert_eq!(
            base_from_arguments(&["--model".into(), "test-model".into()]).unwrap(),
            None
        );
    }

    #[test]
    fn each_configured_proxy_keeps_its_own_marker() {
        assert_eq!(
            saved_arguments("http://localhost:8317", Some("default")),
            saved_arguments("http://localhost:8317", None)
        );
        let args = saved_arguments("https://proxy.example", Some("7f3a91"));
        assert_eq!(
            base_from_arguments(&args).unwrap(),
            Some(ProxyTarget {
                base_url: "https://proxy.example".into(),
                id: Some("7f3a91".into())
            })
        );
        // A marker that is not ours, and an identifier we would never write,
        // are both left to whatever other provider owns them.
        assert_eq!(
            base_from_arguments(&[
                "-c".into(),
                "model_provider=other".into(),
                "-c".into(),
                "model_providers.other.base_url=\"http://localhost/v1\"".into(),
            ])
            .unwrap(),
            None
        );
        assert_eq!(
            base_from_arguments(&[
                "-c".into(),
                format!("model_provider={PROVIDER}_Upper"),
                "-c".into(),
                format!("model_providers.{PROVIDER}_Upper.base_url=\"http://localhost/v1\""),
            ])
            .unwrap(),
            None
        );
        // One proxy's arguments must not smuggle in a second provider table.
        let mut mixed = args.clone();
        mixed.extend([
            "-c".into(),
            format!("model_providers.{PROVIDER}.base_url=\"http://localhost/v1\""),
        ]);
        assert!(base_from_arguments(&mixed).is_err());
    }
}
