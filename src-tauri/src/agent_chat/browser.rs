//! Native tools and Playwright configuration are local to the CLI subprocess.
pub(super) const PACKAGE: &str = "@playwright/mcp@0.0.80";
fn command() -> String {
    std::env::current_exe()
        .unwrap_or_else(|_| std::path::PathBuf::from("lattice-term"))
        .to_string_lossy()
        .into_owned()
}
fn playwright(endpoint: &str) -> (String, Vec<String>) {
    let mut args = if cfg!(windows) {
        vec!["/d", "/c", "npx", "--yes", PACKAGE]
    } else {
        vec!["--yes", PACKAGE]
    }
    .into_iter()
    .map(str::to_string)
    .collect::<Vec<_>>();
    args.extend(["--cdp-endpoint".into(), endpoint.into()]);
    (if cfg!(windows) { "cmd" } else { "npx" }.into(), args)
}
pub(crate) fn claude_arguments(endpoint: Option<&str>) -> Vec<String> {
    let mut servers = serde_json::json!({"latticeterm_chat_tools":{"command":command(),"args":["--mcp-chat-tools"],"env":{"LATTICETERM_CHAT_TOOLS_URL":"${LATTICETERM_CHAT_TOOLS_URL}"}}});
    if let Some(endpoint) = endpoint {
        let (command, args) = playwright(endpoint);
        servers["latticeterm_browser"] = serde_json::json!({"command":command,"args":args});
    }
    vec![
        "--mcp-config".into(),
        serde_json::json!({"mcpServers":servers}).to_string(),
    ]
}
pub(crate) fn codex_arguments() -> Vec<String> {
    [
        format!(
            "mcp_servers.latticeterm_chat_tools.command={}",
            serde_json::to_string(&command()).unwrap()
        ),
        "mcp_servers.latticeterm_chat_tools.args=[\"--mcp-chat-tools\"]".into(),
        "mcp_servers.latticeterm_chat_tools.env_vars=[\"LATTICETERM_CHAT_TOOLS_URL\"]".into(),
        "mcp_servers.latticeterm_chat_tools.enabled=true".into(),
        "mcp_servers.latticeterm_chat_tools.startup_timeout_sec=15".into(),
        "mcp_servers.latticeterm_chat_tools.default_tools_approval_mode=\"prompt\"".into(),
    ]
    .into_iter()
    .flat_map(|value| ["-c".to_string(), value])
    .collect()
}
pub(crate) fn playwright_codex_arguments(endpoint: &str) -> Vec<String> {
    let (command, args) = playwright(endpoint);
    [
        format!(
            "mcp_servers.latticeterm_browser.command={}",
            serde_json::to_string(&command).unwrap()
        ),
        format!(
            "mcp_servers.latticeterm_browser.args={}",
            serde_json::to_string(&args).unwrap()
        ),
        "mcp_servers.latticeterm_browser.enabled=true".into(),
        "mcp_servers.latticeterm_browser.startup_timeout_sec=120".into(),
        "mcp_servers.latticeterm_browser.default_tools_approval_mode=\"prompt\"".into(),
    ]
    .into_iter()
    .flat_map(|value| ["-c".to_string(), value])
    .collect()
}
/// Claude accepts multiple config values after a single --mcp-config flag.
/// Preserve the Fleet server when adding the per-conversation tool bridge.
pub(crate) fn session_arguments(
    definition: &str,
    mut original: Vec<String>,
    tools: &[String],
) -> Vec<String> {
    if definition == "claude" {
        if let Some(index) = original.iter().rposition(|arg| arg == "--mcp-config") {
            if tools.len() == 2 && tools[0] == "--mcp-config" {
                original.insert(index + 1, tools[1].clone());
                return original;
            }
        }
    }
    tools.iter().cloned().chain(original).collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn foreground_claude_keeps_fleet_configuration_and_original_resume_arguments() {
        let original = vec!["--mcp-config", "fleet.json", "--resume", "native-id"]
            .into_iter()
            .map(str::to_string)
            .collect();
        let tools = super::claude_arguments(None);
        let result = super::session_arguments("claude", original, &tools);
        assert_eq!(
            result.iter().filter(|arg| *arg == "--mcp-config").count(),
            1
        );
        assert!(result[1].contains("latticeterm_chat_tools"));
        assert_eq!(&result[2..], &["fleet.json", "--resume", "native-id"]);
    }

    #[test]
    fn native_tools_use_the_scoped_bridge_and_playwright_shares_the_embedded_browser() {
        let args = super::codex_arguments();
        assert!(args.iter().any(|value| value.contains("--mcp-chat-tools")));
        assert!(args.iter().any(|value| value.contains("env_vars=")));
        assert!(!args.iter().any(|value| value.contains("127.0.0.1")));
        assert!(args
            .iter()
            .any(|value| value.contains("approval_mode=\"prompt\"")));
        assert!(args.chunks(2).all(|pair| pair[0] == "-c"));
        let endpoint = "http://127.0.0.1:1234";
        let browser = super::playwright_codex_arguments(endpoint);
        assert!(browser.iter().any(|value| value.contains(super::PACKAGE)
            && value.contains("--cdp-endpoint")
            && value.contains(endpoint)));
        let claude = super::claude_arguments(Some(endpoint));
        assert_eq!(claude[0], "--mcp-config");
        let config: serde_json::Value = serde_json::from_str(&claude[1]).unwrap();
        assert_eq!(
            config["mcpServers"]["latticeterm_chat_tools"]["env"]["LATTICETERM_CHAT_TOOLS_URL"],
            "${LATTICETERM_CHAT_TOOLS_URL}"
        );
        assert_eq!(
            config["mcpServers"]["latticeterm_chat_tools"]["args"],
            serde_json::json!(["--mcp-chat-tools"])
        );
        assert!(config["mcpServers"]["latticeterm_browser"]["args"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value == endpoint));
        let disabled: serde_json::Value =
            serde_json::from_str(&super::claude_arguments(None)[1]).unwrap();
        assert!(disabled["mcpServers"].get("latticeterm_browser").is_none());
    }
}
