//! Read-only CLI version checks. Never run an installer or a conversation.
use serde::Serialize;
use std::{path::Path, process::Stdio, time::Duration};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliUpdate {
    id: String,
    label: String,
    current_version: Option<String>,
    latest_version: Option<String>,
    status: &'static str,
    source_url: String,
}

fn package(id: &str) -> Option<&'static str> {
    Some(match id {
        "codex" => "@openai/codex",
        "claude" => "@anthropic-ai/claude-code",
        "gemini" => "@google/gemini-cli",
        "opencode" => "opencode-ai",
        "copilot" => "@github/copilot",
        "qwen" => "@qwen-code/qwen-code",
        _ => return None,
    })
}

// Accept only stable three-part versions. Preview/nightly builds must not be
// mistaken for an old stable release or silently downgraded.
fn version(text: &str) -> Option<[u64; 3]> {
    let mut parts = text.strip_prefix('v').unwrap_or(text).split('.');
    let result = [
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    ];
    parts.next().is_none().then_some(result)
}

fn output_version(text: &str) -> Option<String> {
    text.split_whitespace()
        .find(|word| version(word).is_some())
        .map(|word| word.trim_start_matches('v').to_string())
}

async fn installed_version(path: &Path) -> Option<String> {
    let (program, args) = crate::agent::launch_parts(path);
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .arg("--version")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let output = tokio::time::timeout(Duration::from_secs(8), command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    output_version(&String::from_utf8_lossy(&output.stdout))
}

pub async fn check() -> Result<Vec<CliUpdate>, String> {
    let catalog = tauri::async_runtime::spawn_blocking(crate::agent::catalog)
        .await
        .map_err(|_| "Cannot inspect installed CLIs.".to_string())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Cannot create the CLI update client.".to_string())?;
    let mut tasks = tokio::task::JoinSet::new();
    for definition in catalog.into_iter().filter(|item| item.installed) {
        let client = client.clone();
        tasks.spawn(async move {
            let mut result = CliUpdate {
                id: definition.id.clone(),
                label: definition.label,
                current_version: None,
                latest_version: None,
                status: "manual",
                source_url: definition.install.source_url,
            };
            let Some(package) = package(&definition.id) else {
                return result;
            };
            result.status = "error";
            let Some(path) = definition.installed_path else {
                return result;
            };
            result.current_version = installed_version(Path::new(&path)).await;
            let Some(current) = result.current_version.as_deref().and_then(version) else {
                return result;
            };
            // Fixed public package names only; no account data or local paths
            // are sent to the registry, and no npm configuration is read.
            let response = client
                .get(format!("https://registry.npmjs.org/{package}/latest"))
                .send()
                .await;
            let Ok(response) = response.and_then(reqwest::Response::error_for_status) else {
                return result;
            };
            let Ok(body) = response.json::<serde_json::Value>().await else {
                return result;
            };
            let Some(latest_text) = body["version"].as_str() else {
                return result;
            };
            let Some(latest) = version(latest_text) else {
                return result;
            };
            result.latest_version = Some(latest_text.to_string());
            result.status = if latest > current {
                "available"
            } else {
                "current"
            };
            result
        });
    }
    let mut results = Vec::new();
    while let Some(result) = tasks.join_next().await {
        results.push(result.map_err(|_| "A CLI update check could not finish.".to_string())?);
    }
    results.sort_by(|a, b| a.label.cmp(&b.label));
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_real_cli_output_without_treating_previews_as_stable() {
        assert_eq!(
            output_version("codex-cli 0.114.0\n"),
            Some("0.114.0".into())
        );
        assert_eq!(output_version("2.1.3 (Claude Code)"), Some("2.1.3".into()));
        assert_eq!(output_version("v1.2.3"), Some("1.2.3".into()));
        assert_eq!(output_version("0.114.0-alpha.2"), None);
        assert_eq!(output_version("failed to launch"), None);
        assert!(version("1.10.0") > version("1.9.9"));
        assert_eq!(version("1.2.3.4"), None);
    }

    #[test]
    fn only_reviewed_packages_use_registry_checks() {
        assert_eq!(package("codex"), Some("@openai/codex"));
        assert_eq!(package("droid"), None);
        assert_eq!(package("custom"), None);
    }
}
