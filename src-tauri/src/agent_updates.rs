//! Read-only CLI version checks. Never run an installer or a conversation.
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliUpdate {
    id: String,
    label: String,
    current_version: Option<String>,
    latest_version: Option<String>,
    status: &'static str,
    source_url: String,
    updatable: bool,
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

// The CLI's own updater, used when it was not installed through npm (for
// example Claude Code's native installer or a Homebrew/standalone build).
// Running `npm install -g` over those fails with EEXIST or installs a second
// copy that PATH never reaches.
fn self_update_args(id: &str) -> Option<&'static [&'static str]> {
    Some(match id {
        "claude" | "codex" | "copilot" | "qwen" => &["update"],
        "opencode" => &["upgrade"],
        _ => return None,
    })
}

fn installed_by_npm(path: &Path, package: &str) -> bool {
    let resolved = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    if resolved
        .components()
        .any(|part| part.as_os_str() == "node_modules")
    {
        return true;
    }
    // Windows npm shims (`codex.cmd`) sit next to the global node_modules.
    resolved
        .parent()
        .is_some_and(|dir| dir.join("node_modules").join(package).is_dir())
}

/// Program and arguments that update this CLI the same way it was installed.
fn update_command(id: &str, installed: Option<&Path>) -> Result<(PathBuf, Vec<String>), String> {
    let definition = crate::agent::install_definition(id);
    let npm = || -> Result<(PathBuf, Vec<String>), String> {
        let executable = definition
            .executable
            .as_deref()
            .ok_or_else(|| "此 CLI 未提供直接更新指令，請參閱官方說明。".to_string())?;
        let path = crate::agent::find_executable(executable)
            .ok_or_else(|| format!("找不到執行檔 {executable}，無法執行更新。"))?;
        Ok((path, definition.arguments.clone()))
    };
    let (Some(path), Some(package)) = (installed, package(id)) else {
        return npm();
    };
    if installed_by_npm(path, package) {
        return npm();
    }
    match self_update_args(id) {
        Some(args) => Ok((
            path.to_path_buf(),
            args.iter().map(|arg| arg.to_string()).collect(),
        )),
        None => Err(format!(
            "這個 CLI 不是用 npm 安裝的，請用原本的安裝方式更新：{}",
            definition.source_url
        )),
    }
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
            let updatable = update_command(
                &definition.id,
                definition.installed_path.as_deref().map(Path::new),
            )
            .is_ok();
            let mut result = CliUpdate {
                id: definition.id.clone(),
                label: definition.label,
                current_version: None,
                latest_version: None,
                status: "manual",
                source_url: definition.install.source_url,
                updatable,
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

pub async fn update(id: &str) -> Result<String, String> {
    let owned_id = id.to_string();
    let (exe_path, arguments) = tauri::async_runtime::spawn_blocking(move || {
        let installed = crate::agent::catalog()
            .into_iter()
            .find(|item| item.id == owned_id)
            .and_then(|item| item.installed_path);
        update_command(&owned_id, installed.as_deref().map(Path::new))
    })
    .await
    .map_err(|_| "無法檢查已安裝的 CLI。".to_string())??;
    let (program, prefix_args) = crate::agent::launch_parts(&exe_path);
    let mut command = tokio::process::Command::new(program);
    command
        .args(prefix_args)
        .args(&arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let output = tokio::time::timeout(Duration::from_secs(180), command.output())
        .await
        .map_err(|_| "更新執行逾時，請檢查網路連線或稍後再試。".to_string())?
        .map_err(|err| format!("無法啟動更新程序: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else if !stdout.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            format!("退出代碼: {:?}", output.status.code())
        };
        return Err(format!("更新失敗: {detail}"));
    }
    Ok(format!("{id} 更新成功"))
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

    #[test]
    fn native_installs_use_their_own_updater_instead_of_npm() {
        let root = std::env::temp_dir().join(format!("lt-update-{}", std::process::id()));
        let native = root
            .join("share")
            .join("claude")
            .join("versions")
            .join("2.1.0");
        let npm_bin = root
            .join("lib")
            .join("node_modules")
            .join("@openai")
            .join("codex")
            .join("bin");
        let shim_dir = root.join("npm");
        std::fs::create_dir_all(native.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&npm_bin).unwrap();
        std::fs::create_dir_all(shim_dir.join("node_modules").join("@openai").join("codex"))
            .unwrap();
        std::fs::write(&native, "").unwrap();
        std::fs::write(npm_bin.join("codex.js"), "").unwrap();
        std::fs::write(shim_dir.join("codex.cmd"), "").unwrap();

        assert!(!installed_by_npm(&native, "@anthropic-ai/claude-code"));
        assert!(installed_by_npm(&npm_bin.join("codex.js"), "@openai/codex"));
        assert!(installed_by_npm(
            &shim_dir.join("codex.cmd"),
            "@openai/codex"
        ));

        let (program, args) = update_command("claude", Some(&native)).unwrap();
        assert_eq!(program, native);
        assert_eq!(args, ["update"]);
        let error = update_command("gemini", Some(&native)).unwrap_err();
        assert!(error.contains("npm"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn update_rejects_unsupported_or_unknown_cli() {
        assert!(update("unknown-cli").await.is_err());
    }
}
