//! Process-local Codex configuration. Saved launch arguments contain the
//! endpoint, while credentials are loaded again each time a process starts.

use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

pub const PROVIDER: &str = "latticeterm_cliproxyapi";
pub const KEY_ENV: &str = "LATTICETERM_CLI_PROXY_API_KEY";
const BASE_OVERRIDE: &str = "model_providers.latticeterm_cliproxyapi.base_url=";

pub struct ProxyLaunch {
    base_url: String,
    key: Option<Zeroizing<String>>,
    provider: String,
}

impl ProxyLaunch {
    pub fn load(base_url: &str) -> Result<Self, String> {
        let base_url = super::normalize_base_url(base_url)?;
        let key = if crate::credentials::cli_proxy_key_exists()? {
            Some(crate::credentials::load_cli_proxy_key(&base_url)?)
        } else {
            None
        };
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).map_err(|_| "Cannot create a CLIProxyAPI process identity.")?;
        let suffix: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
        Ok(Self {
            base_url,
            key,
            provider: format!("{PROVIDER}_{suffix}"),
        })
    }

    /// Codex deep-merges provider tables. A fresh name prevents stale headers,
    /// bearer tokens or auth commands from an existing provider being inherited.
    pub fn arguments(&self) -> Vec<String> {
        let mut provider = toml::Table::new();
        provider.insert("name".into(), "CLIProxyAPI".into());
        provider.insert("base_url".into(), format!("{}/v1", self.base_url).into());
        provider.insert("wire_api".into(), "responses".into());
        provider.insert("requires_openai_auth".into(), false.into());
        if self.key.is_some() {
            provider.insert("env_key".into(), KEY_ENV.into());
        }
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

    pub fn key(&self) -> Option<&str> {
        self.key.as_ref().map(|key| key.as_str())
    }

    pub fn provider(&self) -> &str {
        &self.provider
    }

    /// Saved metadata uses a stable marker; the actual process must only see
    /// its fresh provider name, including when resuming a native conversation.
    pub fn configure_arguments(&self, arguments: Vec<String>) -> Vec<String> {
        let mut configured = self.arguments();
        let mut iter = arguments.into_iter();
        while let Some(argument) = iter.next() {
            if argument == "-c" || argument == "--config" {
                // base_from_arguments already accepted only our two overrides.
                iter.next();
            } else {
                configured.push(argument);
            }
        }
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

pub fn base_from_arguments(arguments: &[String]) -> Result<Option<String>, String> {
    let overrides: Vec<&str> = arguments
        .windows(2)
        .filter(|pair| pair[0] == "-c" || pair[0] == "--config")
        .map(|pair| pair[1].as_str())
        .collect();
    if !overrides.contains(&"model_provider=latticeterm_cliproxyapi") {
        return Ok(None);
    }
    let bases: Vec<_> = overrides
        .iter()
        .filter_map(|value| value.strip_prefix(BASE_OVERRIDE))
        .collect();
    if bases.len() != 1
        || overrides
            .iter()
            .filter(|value| value.starts_with("model_provider="))
            .count()
            != 1
        || arguments
            .iter()
            .any(|arg| arg.starts_with("--config=") || (arg.starts_with("-c") && arg != "-c"))
        || overrides.iter().any(|value| {
            *value != "model_provider=latticeterm_cliproxyapi" && !value.starts_with(BASE_OVERRIDE)
        })
    {
        return Err("CLIProxyAPI launch settings conflict with another provider override.".into());
    }
    let endpoint: String = serde_json::from_str(bases[0]).map_err(|_| "cliproxy.url.invalid")?;
    let root = endpoint.strip_suffix("/v1").ok_or("cliproxy.url.invalid")?;
    super::normalize_base_url(root).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn launch(key: Option<&str>) -> ProxyLaunch {
        ProxyLaunch {
            provider: format!("{PROVIDER}_fixture"),
            base_url: "http://127.0.0.1:8317/prefix".into(),
            key: key.map(|s| Zeroizing::new(s.into())),
        }
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
        let args = vec![
            "-c".into(),
            format!("model_provider={PROVIDER}"),
            "-c".into(),
            format!("{BASE_OVERRIDE}\"http://localhost:8317/v1\""),
            "--model".into(),
            "test-model".into(),
        ];
        assert_eq!(
            base_from_arguments(&args).unwrap().as_deref(),
            Some("http://localhost:8317")
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
}
