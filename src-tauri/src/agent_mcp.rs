//! Process-scoped MCP access for agents started by LatticeTerm itself.
//!
//! The adapter reaches the same background daemon as an external MCP client.
//! It never edits a CLI account file and receives no credential, host or
//! command details beyond grants the user explicitly created in the desktop.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// The server name this installation registers in every CLI it starts.
const SERVER_NAME: &str = "latticeterm";

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

fn has_explicit_claude_config(arguments: &[String]) -> bool {
    arguments.iter().any(|argument| {
        argument == "--mcp-config" || argument.trim_start().starts_with("--mcp-config=")
    })
}

/// Claude Code reads MCP servers from a JSON string given on the command
/// line, which leaves `~/.claude.json` and the user's own servers alone.
pub fn claude_arguments(launch: &McpLaunch) -> Vec<String> {
    let config = serde_json::json!({
        "mcpServers": {
            "latticeterm": { "command": launch.command, "args": launch.args }
        }
    });
    match serde_json::to_string(&config) {
        Ok(config) => vec!["--mcp-config".to_string(), config],
        Err(_) => Vec::new(),
    }
}

/// Adds this installation's adapter to a Claude Code launch.
///
/// `--mcp-config` takes a space-separated list, so whatever follows the value
/// must be another flag; a launch that starts with a positional argument gets
/// the pair at the end instead, before any `--` separator.
pub fn apply_claude_arguments(mut arguments: Vec<String>, launch: &McpLaunch) -> Vec<String> {
    // A caller who named their own servers decides what this session talks to.
    if has_explicit_claude_config(&arguments) {
        return arguments;
    }
    let configured = claude_arguments(launch);
    if configured.is_empty() {
        return arguments;
    }
    let leads_with_flag = arguments
        .first()
        .is_none_or(|argument| argument.starts_with('-'));
    let at = if leads_with_flag {
        0
    } else {
        arguments
            .iter()
            .position(|argument| argument == "--")
            .unwrap_or(arguments.len())
    };
    arguments.splice(at..at, configured);
    arguments
}

/// Gemini CLI and its Qwen Code fork read stdio servers from the same
/// `mcpServers` map. The settings this fills live in a process-scoped
/// temporary file, so the user's own `settings.json` keeps its servers.
///
/// `trust` stays false on purpose: Gemini then asks before each tool call,
/// which runs ahead of the desktop's own grant checks.
pub fn apply_gemini_settings(settings: &mut serde_json::Value, launch: &McpLaunch) {
    let Some(settings) = settings.as_object_mut() else {
        return;
    };
    let servers = settings
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));
    let Some(servers) = servers.as_object_mut() else {
        return;
    };
    servers.insert(
        SERVER_NAME.to_string(),
        serde_json::json!({
            "command": launch.command,
            "args": launch.args,
            "timeout": 30000,
            "trust": false
        }),
    );
}

/// OpenCode names a local server with one command array. The config this
/// fills is handed over as inline JSON for a single run, which leaves the
/// global, project and administrator layers untouched.
pub fn apply_opencode_config(config: &mut serde_json::Value, launch: &McpLaunch) {
    let Some(config) = config.as_object_mut() else {
        return;
    };
    let mut command = Vec::with_capacity(launch.args.len() + 1);
    command.push(launch.command.clone());
    command.extend(launch.args.iter().cloned());
    let servers = config.entry("mcp").or_insert_with(|| serde_json::json!({}));
    let Some(servers) = servers.as_object_mut() else {
        return;
    };
    servers.insert(
        SERVER_NAME.to_string(),
        serde_json::json!({
            "type": "local",
            "command": command,
            "enabled": true
        }),
    );
}

fn has_explicit_copilot_config(arguments: &[String]) -> bool {
    arguments.iter().any(|argument| {
        argument == "--additional-mcp-config"
            || argument
                .trim_start()
                .starts_with("--additional-mcp-config=")
    })
}

/// Copilot CLI merges `--additional-mcp-config` on top of its own
/// `mcp-config.json` for one run only, so the user's servers, login and
/// trusted directories stay exactly where they are.
pub fn copilot_arguments(launch: &McpLaunch) -> Vec<String> {
    let config = serde_json::json!({
        "mcpServers": {
            SERVER_NAME: {
                "type": "local",
                "command": launch.command,
                "args": launch.args,
                "tools": ["*"]
            }
        }
    });
    match serde_json::to_string(&config) {
        Ok(config) => vec!["--additional-mcp-config".to_string(), config],
        Err(_) => Vec::new(),
    }
}

/// Adds this installation's adapter to a Copilot CLI launch.
pub fn apply_copilot_arguments(mut arguments: Vec<String>, launch: &McpLaunch) -> Vec<String> {
    // A caller who passed their own additional config decides what this
    // session talks to.
    if has_explicit_copilot_config(&arguments) {
        return arguments;
    }
    let configured = copilot_arguments(launch);
    if configured.is_empty() {
        return arguments;
    }
    arguments.splice(0..0, configured);
    arguments
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

    #[test]
    fn claude_gets_the_same_adapter_without_touching_its_config_file() {
        let arguments = apply_claude_arguments(vec!["--continue".into()], &launch());
        assert_eq!(arguments[0], "--mcp-config");
        let config: serde_json::Value = serde_json::from_str(&arguments[1]).expect("valid JSON");
        assert_eq!(
            config["mcpServers"]["latticeterm"]["command"],
            serde_json::json!(r#"C:\Program Files\LatticeTerm\lattice-term.exe"#)
        );
        assert_eq!(arguments[2], "--continue");
    }

    #[test]
    fn a_caller_that_named_its_own_servers_is_left_alone() {
        let chosen = vec!["--mcp-config".to_string(), "{}".to_string()];
        assert_eq!(apply_claude_arguments(chosen.clone(), &launch()), chosen);
    }

    #[test]
    fn a_leading_prompt_keeps_the_value_from_swallowing_it() {
        let arguments = apply_claude_arguments(
            vec!["說明這個專案".into(), "--".into(), "--not-a-flag".into()],
            &launch(),
        );
        assert_eq!(arguments[0], "說明這個專案");
        assert_eq!(arguments[1], "--mcp-config");
        assert_eq!(&arguments[3..], &["--", "--not-a-flag"]);
    }

    #[test]
    fn gemini_keeps_the_hooks_that_were_already_in_the_settings() {
        let mut settings = serde_json::json!({ "hooks": { "BeforeAgent": [] } });
        apply_gemini_settings(&mut settings, &launch());
        assert!(settings["hooks"]["BeforeAgent"].is_array());
        assert_eq!(
            settings["mcpServers"]["latticeterm"]["args"],
            serde_json::json!(["mcp", "--data-dir", r#"C:\Users\me\App Data\LatticeTerm"#])
        );
    }

    #[test]
    fn gemini_still_confirms_every_tool_call() {
        let mut settings = serde_json::json!({});
        apply_gemini_settings(&mut settings, &launch());
        assert_eq!(
            settings["mcpServers"]["latticeterm"]["trust"],
            serde_json::json!(false)
        );
    }

    #[test]
    fn opencode_gets_one_command_array_next_to_its_plugin() {
        let mut config = serde_json::json!({ "plugin": ["/tmp/status.js"] });
        apply_opencode_config(&mut config, &launch());
        assert_eq!(config["plugin"], serde_json::json!(["/tmp/status.js"]));
        assert_eq!(
            config["mcp"]["latticeterm"],
            serde_json::json!({
                "type": "local",
                "command": [
                    r#"C:\Program Files\LatticeTerm\lattice-term.exe"#,
                    "mcp",
                    "--data-dir",
                    r#"C:\Users\me\App Data\LatticeTerm"#
                ],
                "enabled": true
            })
        );
    }

    #[test]
    fn copilot_gets_a_session_only_server_beside_its_own_config() {
        let arguments = apply_copilot_arguments(vec!["--model=auto".into()], &launch());
        assert_eq!(arguments[0], "--additional-mcp-config");
        let config: serde_json::Value = serde_json::from_str(&arguments[1]).expect("valid JSON");
        assert_eq!(
            config["mcpServers"]["latticeterm"]["command"],
            serde_json::json!(r#"C:\Program Files\LatticeTerm\lattice-term.exe"#)
        );
        assert_eq!(config["mcpServers"]["latticeterm"]["type"], "local");
        assert_eq!(arguments[2], "--model=auto");
    }

    #[test]
    fn copilot_keeps_the_servers_a_caller_chose_for_the_run() {
        let chosen = vec!["--additional-mcp-config".to_string(), "{}".to_string()];
        assert_eq!(apply_copilot_arguments(chosen.clone(), &launch()), chosen);
    }
}
