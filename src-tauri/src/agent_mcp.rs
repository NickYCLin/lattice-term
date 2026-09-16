//! Process-scoped MCP access for agents started by LatticeTerm itself.
//!
//! The adapter reaches the same background daemon as an external MCP client.
//! It never edits a CLI account file and receives no credential, host or
//! command details beyond grants the user explicitly created in the desktop.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// How an MCP client should start this installation's local adapter.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpLaunch {
    pub command: String,
    pub args: Vec<String>,
}

/// The command line that reaches this installation's daemon. Inside an
/// AppImage the running executable lives on a temporary mount, so the
/// AppImage file itself is what a child client must start.
pub fn launch_for(data_dir: &Path) -> McpLaunch {
    let command = std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .or_else(|| std::env::current_exe().ok())
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| "lattice-term".to_string());
    McpLaunch {
        command,
        args: vec![
            "mcp".to_string(),
            "--data-dir".to_string(),
            data_dir.to_string_lossy().into_owned(),
        ],
    }
}

/// Codex accepts process-only configuration through repeatable `-c` pairs.
/// Keep LatticeTerm's server separate from user config and ask Codex for its
/// normal tool approval before a call reaches the desktop's own grant checks.
pub fn codex_arguments(launch: &McpLaunch) -> Vec<String> {
    let values = [
        format!(
            "mcp_servers.latticeterm.command={}",
            serde_json::to_string(&launch.command).expect("an executable path serializes")
        ),
        format!(
            "mcp_servers.latticeterm.args={}",
            serde_json::to_string(&launch.args).expect("adapter arguments serialize")
        ),
        "mcp_servers.latticeterm.enabled=true".to_string(),
        "mcp_servers.latticeterm.startup_timeout_sec=30".to_string(),
        "mcp_servers.latticeterm.default_tools_approval_mode=\"prompt\"".to_string(),
    ];
    values
        .into_iter()
        .flat_map(|value| ["-c".to_string(), value])
        .collect()
}

/// Global Codex options must precede subcommands such as `resume`.
pub fn prepend_codex_arguments(arguments: Vec<String>, launch: &McpLaunch) -> Vec<String> {
    let mut configured = codex_arguments(launch);
    configured.extend(arguments);
    configured
}

#[cfg(test)]
mod tests {
    use super::*;

    fn launch() -> McpLaunch {
        McpLaunch {
            command: r#"C:\Program Files\LatticeTerm\lattice-term.exe"#.into(),
            args: vec![
                "mcp".into(),
                "--data-dir".into(),
                r#"C:\Users\me\App Data\LatticeTerm"#.into(),
            ],
        }
    }

    #[test]
    fn codex_gets_a_process_only_local_server_with_prompted_tools() {
        let arguments = codex_arguments(&launch());
        assert!(arguments.chunks(2).all(|pair| pair[0] == "-c"));
        assert!(arguments.iter().any(|value| value
            == r#"mcp_servers.latticeterm.command="C:\\Program Files\\LatticeTerm\\lattice-term.exe""#));
        assert!(arguments.iter().any(|value| value
            == r#"mcp_servers.latticeterm.args=["mcp","--data-dir","C:\\Users\\me\\App Data\\LatticeTerm"]"#));
        assert!(arguments
            .iter()
            .any(|value| value.ends_with("default_tools_approval_mode=\"prompt\"")));
    }

    #[test]
    fn process_configuration_stays_before_a_resume_subcommand() {
        let arguments =
            prepend_codex_arguments(vec!["resume".into(), "conversation-id".into()], &launch());
        assert_eq!(
            &arguments[arguments.len() - 2..],
            &["resume", "conversation-id"]
        );
    }
}
