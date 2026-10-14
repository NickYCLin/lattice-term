//! What a Codex account offers for explicit use in a message: skills,
//! plugins and connected apps, as `codex app-server` itself reports them.
//! Codex Desktop's composer draws from the same three lists, so a pick here
//! reaches Codex as the same structured input Desktop would send.

use std::path::Path;
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncWriteExt, BufReader};

use super::{
    apply_profile_environment, headless_command, read_bounded_line, stderr_tail, ChatSkill,
    Dialect, LineError,
};

const CATALOG_TIMEOUT: Duration = Duration::from_secs(20);
const RPC_SKILLS: u64 = 2;
const RPC_PLUGINS: u64 = 3;
const RPC_APPS: u64 = 4;
const MAX_ENTRIES: usize = 256;

pub(super) async fn set_archived(
    executable: &Path,
    profile: Option<&Path>,
    thread_id: &str,
    archived: bool,
) -> Result<(), String> {
    let mut command = headless_command(executable);
    command.arg("app-server");
    apply_profile_environment(&mut command, Dialect::Codex, profile);
    command.kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Cannot start Codex: {error}"))?;
    let result = async {
        let mut stdin = child.stdin.take().ok_or("Codex input unavailable")?;
        let stdout = child.stdout.take().ok_or("Codex output unavailable")?;
        tauri::async_runtime::spawn(stderr_tail(child.stderr.take()));
        let mut reader = BufReader::new(stdout);
        let initialize = requests(None).remove(0);
        stdin
            .write_all(format!("{initialize}\n").as_bytes())
            .await
            .map_err(|error| error.to_string())?;
        stdin.flush().await.map_err(|error| error.to_string())?;
        read_rpc_reply(&mut reader, 1).await?;
        let method = if archived {
            "thread/archive"
        } else {
            "thread/unarchive"
        };
        let request =
            serde_json::json!({"id": 2, "method": method, "params": {"threadId": thread_id}});
        stdin
            .write_all(
                format!("{{\"method\":\"initialized\",\"params\":{{}}}}\n{request}\n").as_bytes(),
            )
            .await
            .map_err(|error| error.to_string())?;
        stdin.flush().await.map_err(|error| error.to_string())?;
        read_rpc_reply(&mut reader, 2).await.map(|_| ())
    };
    let result = tokio::time::timeout(CATALOG_TIMEOUT, result)
        .await
        .map_err(|_| {
            "Codex archive outcome is unknown after timeout; the local conversation was retained."
                .to_string()
        });
    let _ = child.start_kill();
    let _ = child.wait().await;
    result?
}

async fn read_rpc_reply<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
    id: u64,
) -> Result<Value, String> {
    let mut line = Vec::new();
    loop {
        line.clear();
        match read_bounded_line(reader, &mut line).await {
            Ok(0) => return Err("Codex ended without confirming the operation".into()),
            Err(_) => return Err("Codex operation response could not be read safely".into()),
            Ok(_) => {}
        }
        let Ok(value) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        if value["id"].as_u64() != Some(id) {
            continue;
        }
        if let Some(error) = value.get("error") {
            return Err(format!("Codex operation rejected: {error}"));
        }
        return value
            .get("result")
            .cloned()
            .ok_or("Codex did not confirm the operation".into());
    }
}

pub(super) async fn list(
    executable: &Path,
    profile_config_directory: Option<&Path>,
    working_directory: Option<&Path>,
) -> Result<Vec<ChatSkill>, String> {
    let mut command = headless_command(executable);
    command.arg("app-server");
    apply_profile_environment(&mut command, Dialect::Codex, profile_config_directory);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Cannot start Codex: {error}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Codex's input could not be opened.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Codex's output could not be captured.".to_string())?;
    tauri::async_runtime::spawn(stderr_tail(child.stderr.take()));
    for line in requests(working_directory) {
        stdin
            .write_all(format!("{line}\n").as_bytes())
            .await
            .map_err(|error| format!("Cannot ask Codex for its skills: {error}"))?;
    }
    let _ = stdin.flush().await;

    let replies = tokio::time::timeout(CATALOG_TIMEOUT, async {
        let mut reader = BufReader::new(stdout);
        let mut line = Vec::new();
        let (mut skills, mut plugins, mut apps) = (None, None, None);
        while skills.is_none() || plugins.is_none() || apps.is_none() {
            line.clear();
            match read_bounded_line(&mut reader, &mut line).await {
                Ok(0) | Err(LineError::Io) => break,
                Ok(_) => {}
                Err(LineError::TooLong) => continue,
            }
            let Ok(value) = serde_json::from_slice::<Value>(&line) else {
                continue;
            };
            if value.get("method").is_some() {
                continue;
            }
            let reply = value.get("result").cloned().unwrap_or(Value::Null);
            match value.get("id").and_then(Value::as_u64) {
                Some(RPC_SKILLS) => skills = Some(reply),
                Some(RPC_PLUGINS) => plugins = Some(reply),
                Some(RPC_APPS) => apps = Some(reply),
                _ => {}
            }
        }
        (skills, plugins, apps)
    })
    .await;
    let _ = child.start_kill();
    let _ = child.wait().await;
    let (skills, plugins, apps) =
        replies.map_err(|_| "Codex did not list its skills in time.".to_string())?;
    let skills = skills.ok_or_else(|| "Codex ended before listing its skills.".to_string())?;
    Ok(catalog(&skills, plugins.as_ref(), apps.as_ref()))
}

fn requests(working_directory: Option<&Path>) -> Vec<String> {
    let cwds: Vec<String> = working_directory
        .map(|path| vec![path.display().to_string()])
        .unwrap_or_default();
    vec![
        serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "clientInfo": {
                "name": "latticeterm", "title": "LatticeTerm",
                "version": env!("CARGO_PKG_VERSION"),
            } },
        })
        .to_string(),
        serde_json::json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} }).to_string(),
        serde_json::json!({
            "jsonrpc": "2.0", "id": RPC_SKILLS, "method": "skills/list",
            "params": { "cwds": cwds },
        })
        .to_string(),
        serde_json::json!({
            "jsonrpc": "2.0", "id": RPC_PLUGINS, "method": "plugin/installed", "params": {},
        })
        .to_string(),
        serde_json::json!({
            "jsonrpc": "2.0", "id": RPC_APPS, "method": "app/installed", "params": {},
        })
        .to_string(),
    ]
}

fn text(value: &Value, key: &str, max_chars: usize) -> Option<String> {
    let text: String = value
        .get(key)?
        .as_str()?
        .chars()
        .filter(|character| !character.is_control())
        .take(max_chars)
        .collect();
    let text = text.trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// A name as Codex's composer writes it after `$` or `@`.
fn mention_slug(name: &str) -> String {
    let mut slug = String::new();
    for character in name.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '_' | ':' | '.') {
            slug.push(character.to_ascii_lowercase());
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    slug.trim_matches('-').to_string()
}

fn catalog(skills: &Value, plugins: Option<&Value>, apps: Option<&Value>) -> Vec<ChatSkill> {
    let mut entries = Vec::new();
    let skill_lists = skills.get("data").and_then(Value::as_array);
    for skill in skill_lists
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.get("skills")?.as_array())
        .flatten()
    {
        if skill.get("enabled").and_then(Value::as_bool) == Some(false) {
            continue;
        }
        let (Some(name), Some(path)) = (text(skill, "name", 128), text(skill, "path", 4096)) else {
            continue;
        };
        if entries
            .iter()
            .any(|entry: &ChatSkill| entry.path.as_deref() == Some(path.as_str()))
        {
            continue;
        }
        let source = if skill.get("pluginId").is_some_and(|id| !id.is_null()) {
            "外掛"
        } else {
            match skill.get("scope").and_then(Value::as_str) {
                Some("repo") => "專案",
                Some("system") => "內建",
                Some("admin") => "系統管理",
                _ => "帳號",
            }
        };
        let description = skill
            .get("interface")
            .and_then(|interface| text(interface, "shortDescription", 280))
            .or_else(|| text(skill, "shortDescription", 280))
            .or_else(|| text(skill, "description", 280));
        entries.push(ChatSkill {
            token: Some(format!("${}", mention_slug(&name))),
            name,
            description,
            source: source.to_string(),
            kind: "skill".to_string(),
            path: Some(path),
        });
    }
    let marketplaces = plugins
        .and_then(|reply| reply.get("marketplaces"))
        .and_then(Value::as_array);
    for plugin in marketplaces
        .into_iter()
        .flatten()
        .filter_map(|marketplace| marketplace.get("plugins")?.as_array())
        .flatten()
    {
        let usable = plugin.get("installed").and_then(Value::as_bool) == Some(true)
            && plugin.get("enabled").and_then(Value::as_bool) == Some(true);
        let (Some(id), Some(raw_name)) = (text(plugin, "id", 200), text(plugin, "name", 128))
        else {
            continue;
        };
        if !usable {
            continue;
        }
        let interface = plugin.get("interface").unwrap_or(&Value::Null);
        entries.push(ChatSkill {
            name: text(interface, "displayName", 128).unwrap_or_else(|| raw_name.clone()),
            description: text(interface, "shortDescription", 280),
            source: "外掛".to_string(),
            kind: "plugin".to_string(),
            token: Some(format!("@{}", mention_slug(&raw_name))),
            path: Some(format!("plugin://{id}")),
        });
    }
    for app in apps
        .and_then(|reply| reply.get("apps"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let callable = app.get("enabled").and_then(Value::as_bool) == Some(true)
            && app.get("callable").and_then(Value::as_bool) == Some(true);
        let Some(id) = text(app, "id", 200) else {
            continue;
        };
        if !callable {
            continue;
        }
        let name = text(app, "runtimeName", 128).unwrap_or_else(|| id.clone());
        entries.push(ChatSkill {
            token: Some(format!("${}", mention_slug(&name))),
            name,
            description: None,
            source: "App".to_string(),
            kind: "app".to_string(),
            path: Some(format!("app://{id}")),
        });
    }
    entries.sort_by(|left, right| {
        kind_order(&left.kind)
            .cmp(&kind_order(&right.kind))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    entries.truncate(MAX_ENTRIES);
    entries
}

fn kind_order(kind: &str) -> u8 {
    match kind {
        "skill" => 0,
        "plugin" => 1,
        _ => 2,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn archive_requires_matching_official_confirmation() {
        let mut replies = BufReader::new(&b"{\"method\":\"thread/updated\"}\n{\"id\":1,\"result\":{}}\n{\"id\":2,\"result\":{}}\n"[..]);
        assert_eq!(
            read_rpc_reply(&mut replies, 2).await.unwrap(),
            serde_json::json!({})
        );
        let mut rejected =
            BufReader::new(&b"{\"id\":2,\"error\":{\"message\":\"synthetic unavailable\"}}\n"[..]);
        assert!(read_rpc_reply(&mut rejected, 2)
            .await
            .unwrap_err()
            .contains("synthetic unavailable"));
        let mut unconfirmed = BufReader::new(&b"{\"id\":1,\"result\":{}}\n"[..]);
        assert!(read_rpc_reply(&mut unconfirmed, 2).await.is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn archive_and_restore_use_the_selected_profile_and_official_protocol() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("synthetic-codex");
        for archived in [true, false] {
            let method = if archived {
                "thread/archive"
            } else {
                "thread/unarchive"
            };
            let script = format!("#!/bin/sh\n[ \"$1\" = app-server ] || exit 1\n[ \"$CODEX_HOME\" = \"{}\" ] || exit 2\nread -r initialize\nprintf '%s\\n' '{{\"id\":1,\"result\":{{}}}}'\nread -r initialized\nread -r operation\ncase \"$operation\" in *\"{method}\"*synthetic-thread*) ;; *) exit 3 ;; esac\nprintf '%s\\n' '{{\"id\":2,\"result\":{{}}}}'\n", directory.path().display());
            std::fs::write(&executable, script).unwrap();
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
            set_archived(
                &executable,
                Some(directory.path()),
                "synthetic-thread",
                archived,
            )
            .await
            .unwrap();
        }
    }

    #[test]
    fn catalog_keeps_enabled_skills_installed_plugins_and_callable_apps() {
        let skills = serde_json::json!({ "data": [{ "cwd": "/w", "errors": [], "skills": [
            { "name": "pdf:pdf", "path": "/h/.codex/plugins/pdf/SKILL.md", "scope": "user",
              "enabled": true, "pluginId": "pdf@runtime", "description": "Read PDFs" },
            { "name": "imagegen", "path": "/h/.codex/skills/.system/imagegen/SKILL.md",
              "scope": "system", "enabled": true, "description": "Images" },
            { "name": "off", "path": "/h/off/SKILL.md", "scope": "user", "enabled": false,
              "description": "" },
        ] }] });
        let plugins = serde_json::json!({ "marketplaces": [{ "name": "m", "plugins": [
            { "id": "github@curated", "name": "github", "installed": true, "enabled": true,
              "interface": { "displayName": "GitHub", "shortDescription": "Repos" } },
            { "id": "notion@curated", "name": "notion", "installed": true, "enabled": false },
        ] }] });
        let apps = serde_json::json!({ "apps": [
            { "id": "connector_1", "runtimeName": "Microsoft SharePoint", "enabled": true, "callable": true },
            { "id": "connector_2", "runtimeName": "Hidden", "enabled": true, "callable": false },
        ] });
        let entries = catalog(&skills, Some(&plugins), Some(&apps));
        let summary: Vec<_> = entries
            .iter()
            .map(|entry| {
                (
                    entry.kind.as_str(),
                    entry.name.as_str(),
                    entry.source.as_str(),
                    entry.token.as_deref().unwrap(),
                    entry.path.as_deref().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                (
                    "skill",
                    "imagegen",
                    "內建",
                    "$imagegen",
                    "/h/.codex/skills/.system/imagegen/SKILL.md"
                ),
                (
                    "skill",
                    "pdf:pdf",
                    "外掛",
                    "$pdf:pdf",
                    "/h/.codex/plugins/pdf/SKILL.md"
                ),
                (
                    "plugin",
                    "GitHub",
                    "外掛",
                    "@github",
                    "plugin://github@curated"
                ),
                (
                    "app",
                    "Microsoft SharePoint",
                    "App",
                    "$microsoft-sharepoint",
                    "app://connector_1"
                ),
            ]
        );
    }

    #[test]
    fn catalog_survives_missing_plugin_and_app_replies() {
        let skills = serde_json::json!({ "data": [] });
        assert!(catalog(&skills, None, None).is_empty());
    }
}
