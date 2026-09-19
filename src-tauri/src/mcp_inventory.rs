//! Which MCP servers a chat CLI will load, read from that CLI's own
//! configuration, so a conversation can show what tools it may reach.
//!
//! Read-only on purpose: each CLI owns its file format (and rewrites it),
//! so adding or removing a server goes through the CLI's own `mcp`
//! command. What leaves this module is shaped for display: environment
//! variables and headers by name only, URLs without their query, and
//! arguments that look like credentials masked.

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

const MAX_CONFIG_BYTES: u64 = 4 * 1024 * 1024;
const MAX_SERVERS: usize = 200;
const MASK: &str = "••••";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum McpScope {
    /// Every conversation of this account.
    User,
    /// Only this project, from a file in it.
    Project,
    /// Only this project, but stored in the user's own config.
    Local,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInfo {
    pub name: String,
    pub scope: McpScope,
    pub source: String,
    /// `stdio`, `http` or `sse`.
    pub transport: String,
    /// The program and its (masked) arguments, or the address.
    pub target: String,
    pub enabled: bool,
    pub env_keys: Vec<String>,
    pub header_keys: Vec<String>,
}

fn read_limited(path: &Path) -> Option<String> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_CONFIG_BYTES {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

fn sensitive(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    [
        "key",
        "token",
        "secret",
        "password",
        "passwd",
        "auth",
        "bearer",
        "credential",
    ]
    .iter()
    .any(|word| lower.contains(word))
}

/// Arguments with credential-looking names lose their values; so does the
/// argument right after a credential-looking flag.
fn masked_args(args: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len());
    let mut hide_next = false;
    for arg in args {
        if hide_next {
            out.push(MASK.to_string());
            hide_next = false;
            continue;
        }
        // An address keeps its host and path only, whatever its query says.
        if arg.starts_with("http://") || arg.starts_with("https://") {
            out.push(without_query(arg));
            continue;
        }
        if let Some((name, _)) = arg.split_once('=') {
            if sensitive(name) {
                out.push(format!("{name}={MASK}"));
                continue;
            }
        }
        if arg.starts_with('-') && sensitive(arg) {
            hide_next = true;
        }
        out.push(arg.clone());
    }
    out
}

fn without_query(url: &str) -> String {
    let end = url.find(['?', '#']).unwrap_or(url.len());
    // Credentials in the authority (`user:pass@host`) are dropped too.
    let (scheme, rest) = url[..end].split_once("://").unwrap_or(("", &url[..end]));
    let rest = match rest.split_once('/') {
        Some((authority, path)) => {
            let host = authority
                .rsplit_once('@')
                .map_or(authority, |(_, host)| host);
            format!("{host}/{path}")
        }
        None => rest
            .rsplit_once('@')
            .map_or(rest, |(_, host)| host)
            .to_string(),
    };
    if scheme.is_empty() {
        rest
    } else {
        format!("{scheme}://{rest}")
    }
}

fn keys(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_object)
        .map(|map| map.keys().cloned().collect())
        .unwrap_or_default()
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// One server entry in the JSON shape Claude Code and Gemini CLI share.
fn json_server(
    name: &str,
    entry: &Value,
    scope: McpScope,
    source: &Path,
    enabled: bool,
) -> Option<McpServerInfo> {
    let entry = entry.as_object()?;
    let url = entry
        .get("url")
        .or_else(|| entry.get("httpUrl"))
        .and_then(Value::as_str);
    let (transport, target) = match (entry.get("command").and_then(Value::as_str), url) {
        (Some(command), _) => {
            let mut parts = vec![command.to_string()];
            parts.extend(masked_args(&strings(entry.get("args"))));
            ("stdio".to_string(), parts.join(" "))
        }
        (None, Some(url)) => {
            let declared = entry.get("type").and_then(Value::as_str);
            let transport = match declared {
                Some("sse") => "sse",
                _ if entry.contains_key("httpUrl") => "http",
                Some("http") | Some("streamable-http") => "http",
                _ => "sse",
            };
            (transport.to_string(), without_query(url))
        }
        (None, None) => return None,
    };
    Some(McpServerInfo {
        name: name.to_string(),
        scope,
        source: source.display().to_string(),
        transport,
        target,
        enabled: enabled && entry.get("disabled").and_then(Value::as_bool) != Some(true),
        env_keys: keys(entry.get("env")),
        header_keys: keys(entry.get("headers")),
    })
}

fn json_servers(
    servers: Option<&Value>,
    scope: McpScope,
    source: &Path,
    is_enabled: &dyn Fn(&str) -> bool,
    out: &mut Vec<McpServerInfo>,
) {
    let Some(servers) = servers.and_then(Value::as_object) else {
        return;
    };
    for (name, entry) in servers {
        if out.len() >= MAX_SERVERS {
            return;
        }
        if let Some(info) = json_server(name, entry, scope, source, is_enabled(name)) {
            out.push(info);
        }
    }
}

fn claude(
    config_dir: Option<&Path>,
    home: Option<&Path>,
    project: Option<&Path>,
) -> Vec<McpServerInfo> {
    let mut out = Vec::new();
    // Claude keeps `.claude.json` beside its config folder by default, and
    // inside it when CLAUDE_CONFIG_DIR (or a profile) points elsewhere.
    let state = match config_dir {
        Some(dir) => dir.join(".claude.json"),
        None => match home {
            Some(home) => home.join(".claude.json"),
            None => return out,
        },
    };
    let parsed = read_limited(&state).and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let project_entry = parsed.as_ref().zip(project).and_then(|(value, project)| {
        value
            .get("projects")?
            .get(project.to_string_lossy().as_ref())
            .cloned()
    });
    if let Some(value) = parsed.as_ref() {
        json_servers(
            value.get("mcpServers"),
            McpScope::User,
            &state,
            &|_| true,
            &mut out,
        );
    }
    if let Some(entry) = project_entry.as_ref() {
        json_servers(
            entry.get("mcpServers"),
            McpScope::Local,
            &state,
            &|_| true,
            &mut out,
        );
    }
    if let Some(project) = project {
        let file = project.join(".mcp.json");
        if let Some(value) =
            read_limited(&file).and_then(|text| serde_json::from_str::<Value>(&text).ok())
        {
            // A project file's servers wait for the user's approval in
            // Claude; the lists of approved and refused names say which.
            let enabled = strings(
                project_entry
                    .as_ref()
                    .and_then(|e| e.get("enabledMcpjsonServers")),
            );
            let disabled = strings(
                project_entry
                    .as_ref()
                    .and_then(|e| e.get("disabledMcpjsonServers")),
            );
            let all = project_entry
                .as_ref()
                .and_then(|e| e.get("enableAllProjectMcpServers"))
                .and_then(Value::as_bool)
                == Some(true);
            json_servers(
                value.get("mcpServers"),
                McpScope::Project,
                &file,
                &|name| {
                    !disabled.iter().any(|n| n == name)
                        && (all || enabled.iter().any(|n| n == name))
                },
                &mut out,
            );
        }
    }
    out
}

fn gemini(home: Option<&Path>, project: Option<&Path>) -> Vec<McpServerInfo> {
    let mut out = Vec::new();
    let files = home
        .map(|home| (McpScope::User, home.join(".gemini").join("settings.json")))
        .into_iter()
        .chain(project.map(|p| (McpScope::Project, p.join(".gemini").join("settings.json"))));
    for (scope, file) in files {
        if let Some(value) =
            read_limited(&file).and_then(|text| serde_json::from_str::<Value>(&text).ok())
        {
            let excluded = strings(value.get("mcp").and_then(|mcp| mcp.get("excluded")));
            json_servers(
                value.get("mcpServers"),
                scope,
                &file,
                &|name| !excluded.iter().any(|n| n == name),
                &mut out,
            );
        }
    }
    out
}

fn codex(config_dir: Option<&Path>, home: Option<&Path>) -> Vec<McpServerInfo> {
    let mut out = Vec::new();
    let Some(dir) = config_dir
        .map(Path::to_path_buf)
        .or_else(|| home.map(|home| home.join(".codex")))
    else {
        return out;
    };
    let file = dir.join("config.toml");
    let Some(table) = read_limited(&file).and_then(|text| text.parse::<toml::Table>().ok()) else {
        return out;
    };
    let Some(servers) = table.get("mcp_servers").and_then(toml::Value::as_table) else {
        return out;
    };
    for (name, entry) in servers.iter().take(MAX_SERVERS) {
        let Some(entry) = entry.as_table() else {
            continue;
        };
        let text_keys = |key: &str| -> Vec<String> {
            entry
                .get(key)
                .and_then(toml::Value::as_table)
                .map(|t| t.keys().cloned().collect())
                .unwrap_or_default()
        };
        let (transport, target) =
            if let Some(command) = entry.get("command").and_then(toml::Value::as_str) {
                let args: Vec<String> = entry
                    .get("args")
                    .and_then(toml::Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|i| i.as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default();
                let mut parts = vec![command.to_string()];
                parts.extend(masked_args(&args));
                ("stdio".to_string(), parts.join(" "))
            } else if let Some(url) = entry.get("url").and_then(toml::Value::as_str) {
                ("http".to_string(), without_query(url))
            } else {
                continue;
            };
        let mut header_keys = text_keys("http_headers");
        header_keys.extend(text_keys("env_http_headers"));
        if entry.contains_key("bearer_token_env_var") {
            header_keys.push("Authorization".to_string());
        }
        out.push(McpServerInfo {
            name: name.clone(),
            scope: McpScope::User,
            source: file.display().to_string(),
            transport,
            target,
            enabled: entry.get("enabled").and_then(toml::Value::as_bool) != Some(false),
            env_keys: text_keys("env"),
            header_keys,
        });
    }
    out
}

pub fn inspect(
    definition_id: &str,
    working_directory: Option<&str>,
    config_directory: Option<&str>,
) -> Result<Vec<McpServerInfo>, String> {
    let absolute = |value: Option<&str>, what: &str| -> Result<Option<PathBuf>, String> {
        match value.map(str::trim).filter(|value| !value.is_empty()) {
            None => Ok(None),
            Some(value) if Path::new(value).is_absolute() => Ok(Some(PathBuf::from(value))),
            Some(_) => Err(format!("The {what} must be an absolute path.")),
        }
    };
    let project = absolute(working_directory, "working folder")?;
    let config = absolute(config_directory, "account folder")?;
    let home = dirs::home_dir();
    let env_dir = |name: &str| {
        std::env::var_os(name)
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
    };
    Ok(match definition_id {
        "claude" => claude(
            config.or_else(|| env_dir("CLAUDE_CONFIG_DIR")).as_deref(),
            home.as_deref(),
            project.as_deref(),
        ),
        "codex" => codex(
            config.or_else(|| env_dir("CODEX_HOME")).as_deref(),
            home.as_deref(),
        ),
        "gemini" => gemini(home.as_deref(), project.as_deref()),
        other => return Err(format!("No MCP configuration is known for {other}.")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_never_leave_the_module() {
        assert_eq!(
            masked_args(&[
                "--api-key".into(),
                "sk-live-123".into(),
                "TOKEN=abc".into(),
                "--port".into(),
                "8080".into(),
                "https://user:pw@example.com/mcp?key=1".into(),
            ]),
            [
                "--api-key",
                MASK,
                "TOKEN=••••",
                "--port",
                "8080",
                "https://example.com/mcp"
            ]
        );
        assert_eq!(
            without_query("https://a.example/x#frag"),
            "https://a.example/x"
        );
    }

    #[test]
    fn claude_lists_user_local_and_project_servers() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let project_key = project.path().to_string_lossy().to_string();
        std::fs::write(
            home.path().join(".claude.json"),
            serde_json::json!({
                "mcpServers": {"github": {"type": "http", "url": "https://api.example.com/mcp", "headers": {"Authorization": "Bearer secret"}}},
                "projects": {project_key: {
                    "mcpServers": {"local-db": {"command": "db-mcp", "args": ["--password", "hunter2"], "env": {"DB_URL": "postgres://x"}}},
                    "enabledMcpjsonServers": ["shared"],
                }}
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            project.path().join(".mcp.json"),
            serde_json::json!({"mcpServers": {
                "shared": {"command": "npx", "args": ["shared-mcp"]},
                "pending": {"command": "npx", "args": ["other"]}
            }})
            .to_string(),
        )
        .unwrap();
        let servers = claude(None, Some(home.path()), Some(project.path()));
        let by_name = |name: &str| servers.iter().find(|s| s.name == name).unwrap();
        assert_eq!(by_name("github").transport, "http");
        assert_eq!(by_name("github").header_keys, ["Authorization"]);
        assert_eq!(by_name("local-db").scope, McpScope::Local);
        assert_eq!(
            by_name("local-db").target,
            format!("db-mcp --password {MASK}")
        );
        assert_eq!(by_name("local-db").env_keys, ["DB_URL"]);
        assert!(by_name("shared").enabled);
        assert!(
            !by_name("pending").enabled,
            "unapproved project servers are off"
        );
        let text = serde_json::to_string(&servers).unwrap();
        assert!(
            !text.contains("secret") && !text.contains("hunter2") && !text.contains("postgres")
        );
    }

    #[test]
    fn codex_reads_its_toml_tables() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("config.toml"),
            r#"
model = "x"
[mcp_servers.node_repl]
command = "node"
args = ["repl.js"]
[mcp_servers.node_repl.env]
NODE_PATH = "/opt"
[mcp_servers.remote]
url = "https://mcp.example.com/v1?token=abc"
bearer_token_env_var = "REMOTE_TOKEN"
enabled = false
"#,
        )
        .unwrap();
        let servers = codex(Some(dir.path()), None);
        assert_eq!(servers.len(), 2);
        let repl = servers.iter().find(|s| s.name == "node_repl").unwrap();
        assert_eq!(repl.target, "node repl.js");
        assert_eq!(repl.env_keys, ["NODE_PATH"]);
        let remote = servers.iter().find(|s| s.name == "remote").unwrap();
        assert_eq!(remote.target, "https://mcp.example.com/v1");
        assert!(!remote.enabled);
        assert_eq!(remote.header_keys, ["Authorization"]);
    }

    #[test]
    fn gemini_honours_its_exclusion_list() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir(home.path().join(".gemini")).unwrap();
        std::fs::write(
            home.path().join(".gemini").join("settings.json"),
            serde_json::json!({
                "mcpServers": {"a": {"httpUrl": "https://a.example/mcp"}, "b": {"command": "b"}},
                "mcp": {"excluded": ["b"]}
            })
            .to_string(),
        )
        .unwrap();
        let servers = gemini(Some(home.path()), None);
        assert_eq!(
            servers.iter().find(|s| s.name == "a").unwrap().transport,
            "http"
        );
        assert!(!servers.iter().find(|s| s.name == "b").unwrap().enabled);
        assert!(inspect("gemini", Some("relative"), None).is_err());
    }
}
