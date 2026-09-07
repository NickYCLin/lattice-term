//! Per-process browser MCP configuration; never edits the user's CLI config.

pub(super) const PACKAGE: &str = "@playwright/mcp@0.0.80";

pub(super) fn codex_arguments() -> Vec<String> {
    let (command, args) = if cfg!(windows) {
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
    };
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
}
