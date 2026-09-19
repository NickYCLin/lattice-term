//! Per-process browser MCP configuration; never edits the user's CLI config.

pub(super) const PACKAGE: &str = "@playwright/mcp@0.0.80";

fn launch() -> (&'static str, Vec<&'static str>) {
    if cfg!(windows) {
        (
            "cmd",
            vec![
                "/d",
                "/c",
                "npx",
                "--yes",
                PACKAGE,
                "--isolated",
                "--browser",
                "msedge",
            ],
        )
    } else {
        (
            "npx",
            vec!["--yes", PACKAGE, "--isolated", "--browser", "chrome"],
        )
    }
}

/// The same browser server for Claude Code, through its documented
/// `--mcp-config`, which adds servers for this process only. Its tools still
/// go through Claude's own permission prompts in "ask each time" mode.
pub(super) fn claude_arguments() -> Vec<String> {
    let (command, args) = launch();
    vec![
        "--mcp-config".to_string(),
        serde_json::json!({
            "mcpServers": { "latticeterm_browser": { "command": command, "args": args } }
        })
        .to_string(),
    ]
}

pub(super) fn codex_arguments() -> Vec<String> {
    let (command, args) = launch();
    let values = [
        format!(
            "mcp_servers.latticeterm_browser.command={}",
            serde_json::to_string(command).unwrap()
        ),
        format!(
            "mcp_servers.latticeterm_browser.args={}",
            serde_json::to_string(&args).unwrap()
        ),
        "mcp_servers.latticeterm_browser.enabled=true".to_string(),
        "mcp_servers.latticeterm_browser.startup_timeout_sec=120".to_string(),
        "mcp_servers.latticeterm_browser.default_tools_approval_mode=\"prompt\"".to_string(),
    ];
    values
        .into_iter()
        .flat_map(|value| ["-c".to_string(), value])
        .collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn browser_uses_a_pinned_package_and_an_isolated_visible_profile() {
        let args = super::codex_arguments();
        assert!(args.iter().any(|value| value.contains(super::PACKAGE)));
        assert!(args.iter().any(|value| value.contains("--isolated")));
        assert!(!args.iter().any(|value| value.contains("--headless")));
        assert!(args
            .iter()
            .any(|value| value.contains("approval_mode=\"prompt\"")));
        assert!(args.chunks(2).all(|pair| pair[0] == "-c"));
    }

    #[test]
    fn claude_gets_the_same_browser_through_its_own_flag() {
        let args = super::claude_arguments();
        assert_eq!(args[0], "--mcp-config");
        let config: serde_json::Value = serde_json::from_str(&args[1]).unwrap();
        let server = &config["mcpServers"]["latticeterm_browser"];
        assert!(server["args"]
            .as_array()
            .unwrap()
            .iter()
            .any(|arg| arg == super::PACKAGE));
        assert!(server["args"]
            .as_array()
            .unwrap()
            .iter()
            .any(|arg| arg == "--isolated"));
    }
}
