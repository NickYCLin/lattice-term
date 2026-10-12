use super::{AgentLifecycle, MAX_LIFECYCLE_HOOK_BYTES, MAX_RESUME_SESSION_ID_BYTES};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub(super) struct LaunchHooks {
    directory: tempfile::TempDir,
}

impl LaunchHooks {
    pub(super) fn path(&self) -> &Path {
        self.directory.path()
    }
}

pub(super) fn prompt_ready_source(source: Option<&str>) -> bool {
    matches!(source, Some("startup" | "resume" | "clear"))
}

fn hooks_allowed(provider: &str, arguments: &[String]) -> bool {
    !arguments.iter().any(|argument| {
        let flag = argument
            .split_once('=')
            .map_or(argument.as_str(), |(flag, _)| flag);
        matches!(flag, "--bare" | "--safe-mode" | "--no-hooks")
            || (provider == "droid" && flag == "--settings")
    })
}

fn help_has_flag(help: &str, flag: &str) -> bool {
    help.split(|character: char| {
        !character.is_ascii_alphanumeric() && character != '-' && character != '_'
    })
    .any(|token| token == flag)
}

fn supports_launch_flag(executable: &Path, flag: &str) -> bool {
    let (program, prefix) = super::launch_parts(executable);
    let mut command = Command::new(program);
    command
        .args(prefix)
        .arg("--help")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let Ok(mut child) = command.spawn() else {
        return false;
    };
    #[cfg(windows)]
    let job = match super::codex_input_profile::ProcessJob::attach(&child) {
        Ok(job) => job,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return false;
        }
    };
    let output = child.stdout.take().unwrap();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = output.take(64 * 1024 + 1).read_to_end(&mut bytes);
        let _ = sender.send(
            result
                .ok()
                .filter(|_| bytes.len() <= 64 * 1024)
                .map(|_| bytes),
        );
    });
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut success = false;
    let mut exited = false;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(status)) => {
                success = status.success();
                exited = true;
                break;
            }
            Err(_) => break,
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
        }
    }
    #[cfg(unix)]
    if let Ok(process_id) = i32::try_from(child.id()) {
        unsafe {
            libc::kill(-process_id, libc::SIGKILL);
        }
    }
    #[cfg(windows)]
    drop(job);
    if !exited {
        let _ = child.kill();
        let _ = child.wait();
    }
    success
        && receiver
            .recv_timeout(Duration::from_millis(100))
            .ok()
            .flatten()
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .is_some_and(|help| help_has_flag(&help, flag))
}

pub(super) fn launch_hooks_if_supported(
    executable: &Path,
    provider: &str,
    arguments: &mut Vec<String>,
) -> Result<Option<LaunchHooks>, String> {
    let flag = match provider {
        "cursor" => "--plugin-dir",
        "droid" => "--settings",
        _ => return Ok(None),
    };
    if !hooks_allowed(provider, arguments) || !supports_launch_flag(executable, flag) {
        return Ok(None);
    }
    launch_hooks(provider, arguments)
}

fn reporter_command(directory: &Path, provider: &str) -> Result<String, String> {
    #[cfg(windows)]
    let (name, source, runner) = (
        "report.ps1",
        format!("$ErrorActionPreference = 'Stop'\n[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)\n$OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n[Console]::In.ReadToEnd() | & $env:LATTICETERM_AGENT_REPORTER agent-fleet-hook {provider}\nexit $LASTEXITCODE\n"),
        "powershell.exe -NoProfile -NonInteractive -File",
    );
    #[cfg(not(windows))]
    let (name, source, runner) = (
        "report.sh",
        format!("exec \"$LATTICETERM_AGENT_REPORTER\" agent-fleet-hook {provider}\n"),
        "sh",
    );
    let file = directory.join(name);
    let path = file.to_string_lossy().replace('\\', "/");
    if path.contains(['"', '$', '`', '%', '!', '\r', '\n']) {
        return Err("The hook directory cannot be safely passed to a shell.".to_string());
    }
    std::fs::write(&file, source).map_err(|_| "Cannot write the Fleet hook runner.".to_string())?;
    Ok(format!("{runner} \"{path}\""))
}

fn settings(provider: &str, command: &str) -> Value {
    if provider == "cursor" {
        let hook = || json!([{ "command": command }]);
        json!({
            "version": 1,
            "hooks": {
                "sessionStart": hook(),
                "beforeSubmitPrompt": hook(),
                "postToolUse": hook(),
                "postToolUseFailure": hook(),
                "preCompact": hook(),
                "stop": hook()
            }
        })
    } else {
        let hook =
            || json!([{ "hooks": [{ "type": "command", "command": command, "timeout": 5 }] }]);
        json!({
            "hooks": {
                "SessionStart": hook(),
                "UserPromptSubmit": hook(),
                "PostToolUse": hook(),
                "PreCompact": hook(),
                "Stop": hook(),
                "Notification": hook()
            }
        })
    }
}

pub(super) fn launch_hooks(
    provider: &str,
    arguments: &mut Vec<String>,
) -> Result<Option<LaunchHooks>, String> {
    if !matches!(provider, "cursor" | "droid") || !hooks_allowed(provider, arguments) {
        return Ok(None);
    }
    let directory = tempfile::Builder::new()
        .prefix("latticeterm-fleet-hooks-")
        .tempdir()
        .map_err(|_| "Cannot create Fleet lifecycle hooks.".to_string())?;
    let command = reporter_command(directory.path(), provider)?;
    let config = serde_json::to_vec(&settings(provider, &command))
        .map_err(|_| "Cannot encode Fleet lifecycle hooks.".to_string())?;
    let (flag, path) = if provider == "cursor" {
        let manifest_dir = directory.path().join(".cursor-plugin");
        let hook_dir = directory.path().join("hooks");
        std::fs::create_dir(&manifest_dir)
            .and_then(|_| std::fs::create_dir(&hook_dir))
            .map_err(|_| "Cannot create the Cursor hook plugin.".to_string())?;
        std::fs::write(manifest_dir.join("plugin.json"), serde_json::to_vec(&json!({
            "name": "latticeterm-session-status", "version": "1.0.0", "hooks": "./hooks/hooks.json"
        })).unwrap()).map_err(|_| "Cannot write the Cursor hook manifest.".to_string())?;
        std::fs::write(hook_dir.join("hooks.json"), config)
            .map_err(|_| "Cannot write Cursor lifecycle hooks.".to_string())?;
        ("--plugin-dir", directory.path().to_path_buf())
    } else {
        let path = directory.path().join("settings.json");
        std::fs::write(&path, config)
            .map_err(|_| "Cannot write Droid lifecycle hooks.".to_string())?;
        ("--settings", path)
    };
    arguments.splice(
        0..0,
        [flag.to_string(), path.to_string_lossy().into_owned()],
    );
    Ok(Some(LaunchHooks { directory }))
}

fn user_reporter_command(provider: &str, event: Option<&str>, windows: bool) -> String {
    let arguments = format!(
        "agent-fleet-hook {provider}{}",
        event.map(|event| format!(" {event}")).unwrap_or_default()
    );
    if windows {
        use base64::Engine;
        let source = format!(
            "if ($env:LATTICETERM_AGENT_REPORTER -and $env:LATTICETERM_AGENT_SESSION -and $env:LATTICETERM_AGENT_REPORT_ADDR -and $env:LATTICETERM_AGENT_REPORT_TOKEN) {{ [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); $payload = [char[]]::new({read_limit}); $count = [Console]::In.ReadBlock($payload, 0, $payload.Length); if ($count -gt 0 -and $count -le {limit}) {{ (-join $payload[0..($count - 1)]) | & $env:LATTICETERM_AGENT_REPORTER {arguments} | ForEach-Object {{ $_ }} }} }}; exit 0",
            read_limit = MAX_LIFECYCLE_HOOK_BYTES + 1,
            limit = MAX_LIFECYCLE_HOOK_BYTES,
        );
        let bytes: Vec<u8> = source.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        format!("powershell.exe -NoProfile -NonInteractive -EncodedCommand {encoded}")
    } else {
        format!(
            "if [ -n \"$LATTICETERM_AGENT_REPORTER\" ] && [ -n \"$LATTICETERM_AGENT_SESSION\" ] && [ -n \"$LATTICETERM_AGENT_REPORT_ADDR\" ] && [ -n \"$LATTICETERM_AGENT_REPORT_TOKEN\" ]; then \"$LATTICETERM_AGENT_REPORTER\" {arguments}; fi; exit 0"
        )
    }
}

pub(super) fn user_hook_config(provider: &str) -> Result<String, String> {
    user_hook_config_for_platform(provider, cfg!(windows))
}

fn user_hook_config_for_platform(provider: &str, windows: bool) -> Result<String, String> {
    let events: &[&str] = match provider {
        "kimi" => &[
            "SessionStart",
            "UserPromptSubmit",
            "TurnStarted",
            "PostToolUse",
            "PostToolUseFailure",
            "PreCompact",
            "Stop",
            "StopFailure",
            "PermissionRequest",
            "PermissionResult",
            "Interrupt",
        ],
        "grok" => &[
            "SessionStart",
            "UserPromptSubmit",
            "PreToolUse",
            "PostToolUse",
            "PostToolUseFailure",
            "PreCompact",
            "Stop",
            "StopFailure",
        ],
        "antigravity" => &[
            "PreInvocation",
            "PostInvocation",
            "PreToolUse",
            "PostToolUse",
            "Stop",
        ],
        _ => return Err("Only kimi, grok and antigravity have user hook exports.".to_string()),
    };
    let command = user_reporter_command(provider, None, windows);
    if provider == "kimi" {
        let hooks: Vec<Value> = events
            .iter()
            .map(|event| {
                json!({
                    "event": event, "command": command, "timeout": 5,
                })
            })
            .collect();
        toml::to_string_pretty(&json!({"hooks": hooks}))
            .map_err(|_| "Cannot encode Kimi user hooks.".to_string())
    } else {
        let mut hooks = serde_json::Map::new();
        for event in events {
            let handler = json!({
                "type": "command", "timeout": 5,
                "command": if provider == "antigravity" {
                    user_reporter_command(provider, Some(event), windows)
                } else {
                    command.clone()
                },
            });
            let handlers = if provider == "grok" || matches!(*event, "PreToolUse" | "PostToolUse") {
                json!([{"hooks": [handler]}])
            } else {
                json!([handler])
            };
            hooks.insert(event.to_string(), handlers);
        }
        let config = if provider == "grok" {
            json!({"hooks": hooks})
        } else {
            json!({"latticeterm-session-status": hooks})
        };
        serde_json::to_string_pretty(&config).map_err(|_| "Cannot encode user hooks.".to_string())
    }
}

#[derive(Deserialize)]
struct HookPayload {
    #[serde(default)]
    hook_event_name: String,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    conversation_id: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    notification_type: Option<String>,
    #[serde(default)]
    client_type: Option<String>,
    #[serde(default, rename = "conversationId")]
    antigravity_conversation_id: Option<String>,
    #[serde(default, rename = "fullyIdle")]
    fully_idle: Option<bool>,
    #[serde(default, rename = "terminationReason")]
    termination_reason: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

fn report_from_payload(
    provider: &str,
    raw: &[u8],
) -> Result<Option<(AgentLifecycle, String)>, String> {
    let payload: HookPayload =
        serde_json::from_slice(raw).map_err(|_| "Fleet hook payload is invalid.".to_string())?;
    if payload.hook_event_name.is_empty() {
        return Err("Fleet hook payload has no event.".to_string());
    }
    classify_payload(provider, payload)
}

fn classify_payload(
    provider: &str,
    payload: HookPayload,
) -> Result<Option<(AgentLifecycle, String)>, String> {
    if provider == "kimi" && payload.client_type.as_deref() != Some("kimi_code_cli") {
        return Ok(None);
    }
    let state = match (provider, payload.hook_event_name.as_str()) {
        ("cursor", "sessionStart") => AgentLifecycle::Idle,
        (
            "cursor",
            "beforeSubmitPrompt" | "preToolUse" | "postToolUse" | "postToolUseFailure"
            | "preCompact",
        ) => AgentLifecycle::Working,
        ("cursor", "stop") => match payload.status.as_deref() {
            Some("completed") => AgentLifecycle::Done,
            Some("aborted") => AgentLifecycle::Idle,
            Some("error") => AgentLifecycle::NeedsAttention,
            _ => return Ok(None),
        },
        ("droid", "SessionStart") if prompt_ready_source(payload.source.as_deref()) => {
            AgentLifecycle::Idle
        }
        ("droid", "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "PreCompact") => {
            AgentLifecycle::Working
        }
        ("droid", "Stop") => AgentLifecycle::Done,
        ("droid", "Notification") => match payload.notification_type.as_deref() {
            Some("permission_prompt" | "elicitation_dialog") => AgentLifecycle::NeedsAttention,
            Some("idle_prompt") => AgentLifecycle::Idle,
            _ => return Ok(None),
        },
        ("kimi" | "grok", "SessionStart") if prompt_ready_source(payload.source.as_deref()) => {
            AgentLifecycle::Working
        }
        (
            "kimi" | "grok",
            "UserPromptSubmit" | "PostToolUse" | "PostToolUseFailure" | "PreCompact",
        )
        | ("kimi", "TurnStarted" | "PermissionResult") => AgentLifecycle::Working,
        ("kimi" | "grok", "Stop") => AgentLifecycle::Working,
        ("kimi" | "grok", "StopFailure")
        | ("kimi", "PermissionRequest" | "Interrupt")
        | ("grok" | "antigravity", "PreToolUse") => AgentLifecycle::NeedsAttention,
        ("antigravity", "PreInvocation" | "PostInvocation" | "PostToolUse") => {
            AgentLifecycle::Working
        }
        ("antigravity", "Stop") => {
            if payload
                .error
                .as_deref()
                .is_some_and(|error| !error.is_empty())
            {
                AgentLifecycle::NeedsAttention
            } else {
                match (payload.termination_reason.as_deref(), payload.fully_idle) {
                    (Some("model_stop"), Some(true | false)) => AgentLifecycle::Working,
                    (Some("error" | "max_steps_exceeded"), _) => AgentLifecycle::NeedsAttention,
                    _ => return Ok(None),
                }
            }
        }
        _ => return Ok(None),
    };
    let native = if provider == "cursor" {
        payload.conversation_id
    } else if provider == "antigravity" {
        payload.antigravity_conversation_id
    } else {
        payload.session_id
    };
    let native =
        native.ok_or_else(|| "Fleet hook is missing its native session ID.".to_string())?;
    let native = super::validate_text(&native, "Native session ID", MAX_RESUME_SESSION_ID_BYTES)?;
    Ok(Some((state, native)))
}

fn parse_report(
    provider: &str,
    event: Option<&str>,
    raw: &[u8],
) -> Result<Option<(AgentLifecycle, String)>, String> {
    if !matches!(
        provider,
        "cursor" | "droid" | "kimi" | "grok" | "antigravity"
    ) {
        return Err("Unsupported Fleet hook provider.".to_string());
    }
    if raw.len() as u64 > MAX_LIFECYCLE_HOOK_BYTES {
        return Err("Fleet hook payload is too large.".to_string());
    }
    if provider == "antigravity" {
        let event = event
            .filter(|event| {
                matches!(
                    *event,
                    "PreInvocation" | "PostInvocation" | "PreToolUse" | "PostToolUse" | "Stop"
                )
            })
            .ok_or_else(|| "Antigravity requires a supported hook event argument.".to_string())?;
        let mut payload: HookPayload = serde_json::from_slice(raw)
            .map_err(|_| "Fleet hook payload is invalid.".to_string())?;
        if !payload.hook_event_name.is_empty() && payload.hook_event_name != event {
            return Err("Fleet hook event arguments conflict with the payload.".to_string());
        }
        payload.hook_event_name = event.to_string();
        classify_payload(provider, payload)
    } else {
        if event.is_some() {
            return Err("This Fleet hook provider does not accept an event argument.".to_string());
        }
        report_from_payload(provider, raw)
    }
}

pub(super) fn report_from_stdin(provider: &str, event: Option<&str>) -> Result<(), String> {
    let mut raw = Vec::new();
    std::io::stdin()
        .take(MAX_LIFECYCLE_HOOK_BYTES + 1)
        .read_to_end(&mut raw)
        .map_err(|_| "Cannot read Fleet hook input.".to_string())?;
    let report = parse_report(provider, event, &raw)?;
    if let Some((state, native)) = report {
        super::report_from_environment_with_native_session(state, Some(&native))?;
    }
    if provider == "cursor" {
        println!(r#"{{"continue":true}}"#);
    } else if provider == "antigravity" {
        println!("{{}}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command_source(command: &str, windows: bool) -> String {
        if windows {
            use base64::Engine;
            let encoded = command
                .strip_prefix("powershell.exe -NoProfile -NonInteractive -EncodedCommand ")
                .unwrap();
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .unwrap();
            let words: Vec<u16> = bytes
                .as_chunks::<2>()
                .0
                .iter()
                .map(|chunk| u16::from_le_bytes(*chunk))
                .collect();
            String::from_utf16(&words).unwrap()
        } else {
            command.to_string()
        }
    }

    #[test]
    fn kimi_observer_requires_cli_identity_and_never_releases_the_queue() {
        let events = [
            "SessionStart",
            "UserPromptSubmit",
            "TurnStarted",
            "PostToolUse",
            "PostToolUseFailure",
            "PreCompact",
            "Stop",
            "PermissionResult",
        ];
        for name in events {
            assert_eq!(
                event(
                    "kimi",
                    name,
                    json!({
                        "client_type": "kimi_code_cli", "source": "startup",
                        "stop_hook_active": true,
                    })
                ),
                Some(AgentLifecycle::Working)
            );
            assert_eq!(event("kimi", name, json!({"source":"startup"})), None);
            assert_eq!(
                event(
                    "kimi",
                    name,
                    json!({
                        "client_type": "kimi_other_client", "source": "startup",
                    })
                ),
                None
            );
        }
        for name in ["PermissionRequest", "StopFailure", "Interrupt"] {
            assert_eq!(
                event("kimi", name, json!({"client_type":"kimi_code_cli"})),
                Some(AgentLifecycle::NeedsAttention)
            );
        }
        for name in [
            "SessionHeartbeat",
            "SubagentStop",
            "Notification",
            "SessionEnd",
            "unknown",
        ] {
            assert_eq!(
                event("kimi", name, json!({"client_type":"kimi_code_cli"})),
                None
            );
        }
        for source in ["compact", "other", ""] {
            assert_eq!(
                event(
                    "kimi",
                    "SessionStart",
                    json!({
                        "client_type":"kimi_code_cli", "source":source,
                    })
                ),
                None
            );
        }
    }

    #[test]
    fn grok_observer_does_not_confuse_blockable_stop_with_readiness() {
        for name in [
            "SessionStart",
            "UserPromptSubmit",
            "PostToolUse",
            "PostToolUseFailure",
            "PreCompact",
            "Stop",
        ] {
            for stop_hook_active in [true, false] {
                assert_eq!(
                    event(
                        "grok",
                        name,
                        json!({
                            "source":"resume", "stop_hook_active":stop_hook_active,
                        })
                    ),
                    Some(AgentLifecycle::Working)
                );
            }
        }
        for name in ["PreToolUse", "StopFailure"] {
            assert_eq!(
                event("grok", name, json!({})),
                Some(AgentLifecycle::NeedsAttention)
            );
        }
        for name in ["Notification", "SubagentStop", "SessionEnd", "unknown"] {
            assert_eq!(
                event("grok", name, json!({"message":"idle ready done"})),
                None
            );
        }
        assert_eq!(event("grok", "SessionStart", json!({})), None);
    }

    #[test]
    fn antigravity_requires_its_explicit_event_and_tracks_the_original_conversation() {
        let payload = json!({
            "conversationId":"original-conversation", "terminationReason":"model_stop",
            "fullyIdle":true, "session_id":"unrelated-session", "prompt":"private prompt",
        });
        let bytes = serde_json::to_vec(&payload).unwrap();
        for name in ["PreInvocation", "PostInvocation", "PostToolUse", "Stop"] {
            assert_eq!(
                parse_report("antigravity", Some(name), &bytes).unwrap(),
                Some((AgentLifecycle::Working, "original-conversation".to_string()))
            );
        }
        assert_eq!(
            parse_report("antigravity", Some("PreToolUse"), &bytes).unwrap(),
            Some((
                AgentLifecycle::NeedsAttention,
                "original-conversation".to_string()
            ))
        );
        for event in [None, Some("SessionStart"), Some("unknown")] {
            assert!(parse_report("antigravity", event, &bytes).is_err());
        }
        let mut conflicting = payload;
        conflicting["hook_event_name"] = json!("PreInvocation");
        assert!(parse_report(
            "antigravity",
            Some("Stop"),
            &serde_json::to_vec(&conflicting).unwrap()
        )
        .is_err());
    }

    #[test]
    fn antigravity_background_completion_and_continuation_are_not_final_readiness() {
        for idle in [true, false] {
            assert_eq!(
                event(
                    "antigravity",
                    "Stop",
                    json!({
                        "conversationId":"原生對話", "terminationReason":"model_stop", "fullyIdle":idle,
                    })
                ),
                Some(AgentLifecycle::Working)
            );
        }
        for extra in [
            json!({"terminationReason":"model_stop"}),
            json!({"fullyIdle":true}),
            json!({"terminationReason":"other", "fullyIdle":true}),
        ] {
            let mut payload = extra;
            payload["conversationId"] = json!("original");
            assert_eq!(event("antigravity", "Stop", payload), None);
        }
        for reason in ["error", "max_steps_exceeded"] {
            assert_eq!(
                event(
                    "antigravity",
                    "Stop",
                    json!({
                        "conversationId":"original", "terminationReason":reason, "fullyIdle":true,
                    })
                ),
                Some(AgentLifecycle::NeedsAttention)
            );
        }
        assert_eq!(
            event(
                "antigravity",
                "Stop",
                json!({
                    "conversationId":"original", "terminationReason":"model_stop", "fullyIdle":true,
                    "error":"upstream error",
                })
            ),
            Some(AgentLifecycle::NeedsAttention)
        );
    }

    #[test]
    fn user_hook_reports_reject_missing_unsafe_and_conflicting_input() {
        for provider in ["kimi", "grok", "antigravity"] {
            let event_arg = (provider == "antigravity").then_some("PreInvocation");
            for native in [
                None,
                Some("".to_string()),
                Some("bad\nidentity".to_string()),
                Some("x".repeat(MAX_RESUME_SESSION_ID_BYTES + 1)),
            ] {
                let mut payload = json!({
                    "client_type":"kimi_code_cli", "hook_event_name":"UserPromptSubmit",
                });
                if provider == "antigravity" {
                    payload["hook_event_name"] = json!("PreInvocation");
                    if let Some(native) = native {
                        payload["conversationId"] = json!(native);
                    }
                } else if let Some(native) = native {
                    payload["session_id"] = json!(native);
                }
                assert!(
                    parse_report(provider, event_arg, &serde_json::to_vec(&payload).unwrap())
                        .is_err()
                );
            }
            assert!(parse_report(provider, event_arg, b"invalid").is_err());
            assert!(parse_report(
                provider,
                event_arg,
                &vec![b' '; MAX_LIFECYCLE_HOOK_BYTES as usize + 1]
            )
            .is_err());
        }
        let payload = br#"{"hook_event_name":"Stop","session_id":"original"}"#;
        for provider in ["cursor", "droid", "kimi", "grok"] {
            assert!(parse_report(provider, Some("Stop"), payload).is_err());
            assert!(parse_report(provider, None, br#"{"session_id":"original"}"#).is_err());
        }
        assert!(parse_report("unknown", None, payload).is_err());
    }

    #[test]
    fn user_hook_exports_use_each_native_schema_without_account_values_or_policy_changes() {
        for windows in [true, false] {
            let raw = user_hook_config_for_platform("kimi", windows).unwrap();
            let config: toml::Value = toml::from_str(&raw).unwrap();
            let hooks = config["hooks"].as_array().unwrap();
            assert_eq!(hooks.len(), 11);
            for hook in hooks {
                assert_eq!(hook.as_table().unwrap().len(), 3);
                assert!(hook["event"].as_str().is_some());
                assert_eq!(hook["timeout"].as_integer(), Some(5));
                assert!(command_source(hook["command"].as_str().unwrap(), windows)
                    .contains("agent-fleet-hook kimi"));
            }
            let grok: Value =
                serde_json::from_str(&user_hook_config_for_platform("grok", windows).unwrap())
                    .unwrap();
            assert_eq!(grok.as_object().unwrap().len(), 1);
            assert_eq!(grok["hooks"].as_object().unwrap().len(), 8);
            for handlers in grok["hooks"].as_object().unwrap().values() {
                assert_eq!(handlers[0].as_object().unwrap().len(), 1);
                assert!(command_source(
                    handlers[0]["hooks"][0]["command"].as_str().unwrap(),
                    windows
                )
                .contains("agent-fleet-hook grok"));
                assert_eq!(handlers[0]["hooks"][0]["timeout"], 5);
            }
            let ag: Value = serde_json::from_str(
                &user_hook_config_for_platform("antigravity", windows).unwrap(),
            )
            .unwrap();
            assert_eq!(ag.as_object().unwrap().len(), 1);
            for (event, handlers) in ag["latticeterm-session-status"].as_object().unwrap() {
                let handler = if matches!(event.as_str(), "PreToolUse" | "PostToolUse") {
                    &handlers[0]["hooks"][0]
                } else {
                    &handlers[0]
                };
                assert_eq!(handler.as_object().unwrap().len(), 3);
                assert_eq!(handler["timeout"], 5);
                assert!(
                    command_source(handler["command"].as_str().unwrap(), windows)
                        .contains(&format!("agent-fleet-hook antigravity {event}"))
                );
            }
            for provider in ["kimi", "grok", "antigravity"] {
                let raw = user_hook_config_for_platform(provider, windows).unwrap();
                let source =
                    command_source(&user_reporter_command(provider, None, windows), windows);
                for guard in [
                    "LATTICETERM_AGENT_REPORTER",
                    "LATTICETERM_AGENT_SESSION",
                    "LATTICETERM_AGENT_REPORT_ADDR",
                    "LATTICETERM_AGENT_REPORT_TOKEN",
                ] {
                    assert!(source.contains(guard));
                }
                for forbidden in [
                    "apiKey",
                    "HOME=",
                    "KIMI_CODE_HOME",
                    "force_continue",
                    "injectSteps",
                    "permissionDecision",
                    "allowManagedHooksOnly",
                    "hooksDisabled",
                ] {
                    assert!(!raw.contains(forbidden));
                    assert!(!source.contains(forbidden));
                }
                assert!(source.contains("exit 0"));
            }
        }
        for provider in ["aider", "cursor", "unknown", "grok; echo unsafe"] {
            assert!(user_hook_config(provider).is_err());
        }
    }

    #[test]
    fn user_hook_runner_preserves_stdin_and_is_silent_without_its_fleet_environment() {
        use std::io::Write;
        let node = super::super::find_executable("node")
            .expect("Node is required by the repository build");
        let directory = tempfile::tempdir().unwrap();
        let hook_directory = directory.path().join("user hook space 繁體");
        std::fs::create_dir(&hook_directory).unwrap();
        let script = directory.path().join("observer.cjs");
        std::fs::write(&script,
            "const chunks=[]; process.stdin.on('data',chunk=>chunks.push(chunk)); process.stdin.on('end',()=>{if(process.env.OBSERVER_TEST_FAIL==='1')process.exit(2); process.stdout.write(JSON.stringify({arguments:process.argv.slice(2),input:Buffer.concat(chunks).toString('base64')}));});"
        ).unwrap();
        #[cfg(windows)]
        let executable = hook_directory.join("observer.cmd");
        #[cfg(not(windows))]
        let executable = hook_directory.join("observer");
        #[cfg(windows)]
        std::fs::write(
            &executable,
            format!("@\"{}\" \"{}\" %*\r\n", node.display(), script.display()),
        )
        .unwrap();
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::write(
                &executable,
                format!(
                    "#!/bin/sh\nexec \"{}\" \"{}\" \"$@\"\n",
                    node.display(),
                    script.display()
                ),
            )
            .unwrap();
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let environment = [
            "LATTICETERM_AGENT_REPORTER",
            "LATTICETERM_AGENT_SESSION",
            "LATTICETERM_AGENT_REPORT_ADDR",
            "LATTICETERM_AGENT_REPORT_TOKEN",
        ];
        let raw = serde_json::to_vec(&json!({"conversationId":"繁體對話", "prompt":"截圖與草稿"}))
            .unwrap();
        for (provider, event) in [
            ("kimi", None),
            ("grok", None),
            ("antigravity", Some("Stop")),
        ] {
            let command = user_reporter_command(provider, event, cfg!(windows));
            for missing in 0..=environment.len() + 1 {
                #[cfg(windows)]
                let mut shell = {
                    let mut shell = Command::new("cmd.exe");
                    shell.args(["/d", "/s", "/c", &command]);
                    shell
                };
                #[cfg(not(windows))]
                let mut shell = {
                    let mut shell = Command::new("sh");
                    shell.args(["-c", &command]);
                    shell
                };
                shell
                    .env("LATTICETERM_AGENT_REPORTER", &executable)
                    .env("LATTICETERM_AGENT_SESSION", "fixture-session")
                    .env("LATTICETERM_AGENT_REPORT_ADDR", "127.0.0.1:1")
                    .env("LATTICETERM_AGENT_REPORT_TOKEN", "fixture-token")
                    .env_remove("OBSERVER_TEST_FAIL");
                if missing < environment.len() {
                    shell.env_remove(environment[missing]);
                } else if missing > environment.len() {
                    shell.env("OBSERVER_TEST_FAIL", "1");
                }
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    shell.creation_flags(0x08000000);
                }
                let mut child = shell
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn()
                    .unwrap();
                child.stdin.take().unwrap().write_all(&raw).unwrap();
                let output = child.wait_with_output().unwrap();
                assert!(
                    output.status.success(),
                    "{}",
                    String::from_utf8_lossy(&output.stderr)
                );
                if missing == environment.len() {
                    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
                    let actual_input = base64::Engine::decode(
                        &base64::engine::general_purpose::STANDARD,
                        report["input"].as_str().unwrap(),
                    )
                    .unwrap();
                    assert_eq!(
                        serde_json::from_slice::<Value>(&actual_input).unwrap(),
                        serde_json::from_slice::<Value>(&raw).unwrap()
                    );
                    let mut expected_args = vec!["agent-fleet-hook", provider];
                    if let Some(event) = event {
                        expected_args.push(event);
                    }
                    assert_eq!(report["arguments"], json!(expected_args));
                } else {
                    assert!(
                        output.stdout.is_empty(),
                        "{provider} missing={missing}: stdout={} stderr={}",
                        String::from_utf8_lossy(&output.stdout),
                        String::from_utf8_lossy(&output.stderr)
                    );
                }
            }
        }
    }

    #[test]
    fn help_flags_are_capabilities_not_version_pins() {
        assert!(help_has_flag(
            "Usage: agent --plugin-dir <path>",
            "--plugin-dir"
        ));
        assert!(help_has_flag("  --settings=<path>", "--settings"));
        assert!(!help_has_flag("--settings-other", "--settings"));
        assert!(!help_has_flag("--no-plugin-dir", "--plugin-dir"));
        assert!(!help_has_flag("v9999.9.9", "--settings"));
    }

    fn event(provider: &str, event: &str, extra: Value) -> Option<AgentLifecycle> {
        let mut payload = json!({
            "hook_event_name": event, "session_id": "droid-session",
            "conversation_id": "cursor-conversation"
        });
        for (name, value) in extra.as_object().unwrap() {
            payload[name] = value.clone();
        }
        report_from_payload(provider, &serde_json::to_vec(&payload).unwrap())
            .unwrap()
            .map(|(state, _)| state)
    }

    #[test]
    fn cursor_uses_only_main_conversation_lifecycle() {
        assert_eq!(
            event("cursor", "sessionStart", json!({})),
            Some(AgentLifecycle::Idle)
        );
        for name in [
            "beforeSubmitPrompt",
            "preToolUse",
            "postToolUse",
            "postToolUseFailure",
            "preCompact",
        ] {
            assert_eq!(
                event("cursor", name, json!({})),
                Some(AgentLifecycle::Working)
            );
        }
        for (status, expected) in [
            ("completed", AgentLifecycle::Done),
            ("aborted", AgentLifecycle::Idle),
            ("error", AgentLifecycle::NeedsAttention),
        ] {
            assert_eq!(
                event("cursor", "stop", json!({"status":status})),
                Some(expected)
            );
        }
        for name in [
            "subagentStop",
            "afterAgentResponse",
            "sessionEnd",
            "unknown",
        ] {
            assert_eq!(event("cursor", name, json!({"status":"completed"})), None);
        }
        assert_eq!(event("cursor", "stop", json!({})), None);
        assert_eq!(event("cursor", "stop", json!({"status":"unknown"})), None);
        let raw =
            br#"{"hook_event_name":"stop","conversation_id":"original-id","status":"completed"}"#;
        assert_eq!(
            report_from_payload("cursor", raw).unwrap(),
            Some((AgentLifecycle::Done, "original-id".to_string()))
        );
    }

    #[test]
    fn droid_permissions_authentication_and_compaction_are_not_completion() {
        for source in ["startup", "resume", "clear"] {
            assert_eq!(
                event("droid", "SessionStart", json!({"source":source})),
                Some(AgentLifecycle::Idle)
            );
        }
        assert_eq!(
            event("droid", "SessionStart", json!({"source":"compact"})),
            None
        );
        assert_eq!(event("droid", "SessionStart", json!({})), None);
        for name in [
            "UserPromptSubmit",
            "PreToolUse",
            "PostToolUse",
            "PreCompact",
        ] {
            assert_eq!(
                event("droid", name, json!({})),
                Some(AgentLifecycle::Working)
            );
        }
        for kind in ["permission_prompt", "elicitation_dialog"] {
            assert_eq!(
                event("droid", "Notification", json!({"notification_type":kind})),
                Some(AgentLifecycle::NeedsAttention)
            );
        }
        assert_eq!(
            event(
                "droid",
                "Notification",
                json!({"notification_type":"idle_prompt"})
            ),
            Some(AgentLifecycle::Idle)
        );
        assert_eq!(
            event(
                "droid",
                "Notification",
                json!({"notification_type":"auth_success"})
            ),
            None
        );
        assert_eq!(
            event("droid", "Stop", json!({})),
            Some(AgentLifecycle::Done)
        );
        assert_eq!(event("droid", "SubagentStop", json!({})), None);
        assert_eq!(event("droid", "SessionEnd", json!({})), None);
    }

    #[test]
    fn invalid_payloads_and_session_ids_cannot_report_readiness() {
        assert!(report_from_payload("cursor", b"not json").is_err());
        assert!(report_from_payload("cursor", br#"{"hook_event_name":"sessionStart"}"#).is_err());
        for native in [
            String::new(),
            "bad\nid".to_string(),
            "x".repeat(MAX_RESUME_SESSION_ID_BYTES + 1),
        ] {
            let payload = serde_json::to_vec(
                &json!({"hook_event_name":"SessionStart","source":"startup","session_id":native}),
            )
            .unwrap();
            assert!(report_from_payload("droid", &payload).is_err());
        }
        assert_eq!(
            event("unknown", "SessionStart", json!({"source":"startup"})),
            None
        );
    }

    #[test]
    fn launch_preserves_explicit_settings_safe_mode_and_unrelated_arguments() {
        for provider in ["cursor", "droid"] {
            for disabled in [
                "--bare",
                "--bare=true",
                "--bare=1",
                "--safe-mode",
                "--safe-mode=true",
                "--safe-mode=1",
                "--no-hooks",
                "--no-hooks=true",
                "--no-hooks=1",
            ] {
                let mut arguments = vec![
                    disabled.to_string(),
                    "--model".to_string(),
                    "original-model".to_string(),
                ];
                let original = arguments.clone();
                assert!(launch_hooks(provider, &mut arguments).unwrap().is_none());
                assert_eq!(arguments, original);
            }
        }
        for settings in ["--settings", "--settings=original.json"] {
            let mut arguments = vec![settings.to_string(), "original.json".to_string()];
            let original = arguments.clone();
            assert!(launch_hooks("droid", &mut arguments).unwrap().is_none());
            assert_eq!(arguments, original);
        }
        for provider in ["cursor", "droid"] {
            let original = vec![
                "--model".to_string(),
                "original-model".to_string(),
                "--resume".to_string(),
                "original-session".to_string(),
            ];
            let mut arguments = original.clone();
            let hooks = launch_hooks(provider, &mut arguments).unwrap().unwrap();
            assert_eq!(&arguments[2..], original);
            assert!(hooks.path().exists());
            let path = if provider == "cursor" {
                hooks.path().join("hooks/hooks.json")
            } else {
                hooks.path().join("settings.json")
            };
            let config: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
            assert!(config["hooks"].is_object());
            assert!(config.get("disableAllHooks").is_none());
            assert!(config.get("allowManagedHooksOnly").is_none());
            assert!(config.get("model").is_none());
        }
    }

    #[test]
    fn runner_quotes_paths_with_spaces_and_rejects_shell_expansion() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("hook space 繁體");
        std::fs::create_dir(&directory).unwrap();
        let command = reporter_command(&directory, "cursor").unwrap();
        assert!(command.contains("\""));
        assert!(!command.contains("\\\""));
        assert!(command.contains("hook space 繁體"));
        for bad in ["hook$expansion", "hook%expansion", "hook`expansion"] {
            assert!(reporter_command(&root.path().join(bad), "cursor").is_err());
        }
    }

    #[test]
    fn hook_settings_observe_without_replacing_policy_or_permission_hooks() {
        for provider in ["cursor", "droid"] {
            let config = settings(provider, "observer");
            assert!(config["hooks"].get("preToolUse").is_none());
            assert!(config["hooks"].get("PreToolUse").is_none());
            for name in [
                "hooksDisabled",
                "disableAllHooks",
                "allowManagedHooksOnly",
                "permissionRules",
                "model",
            ] {
                assert!(config.get(name).is_none());
            }
        }
    }

    #[test]
    fn help_probe_requires_success_supported_flags_and_bounded_output() {
        let node = super::super::find_executable("node")
            .expect("Node is required by the repository build");
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("probe.cjs");
        #[cfg(windows)]
        let executable = directory.path().join("probe.cmd");
        #[cfg(not(windows))]
        let executable = directory.path().join("probe");
        #[cfg(windows)]
        std::fs::write(
            &executable,
            format!("@\"{}\" \"{}\" %*\r\n", node.display(), script.display()),
        )
        .unwrap();
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::write(
                &executable,
                format!(
                    "#!/bin/sh\nexec \"{}\" \"{}\" \"$@\"\n",
                    node.display(),
                    script.display()
                ),
            )
            .unwrap();
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        for (source, expected) in [
            ("if (process.argv[2] !== '--help') process.exit(4); process.stdout.write('Usage: agent --plugin-dir <directory>');", true),
            ("process.stdout.write('--plugin-dir'); process.exitCode = 1;", false),
            ("process.stdout.write('--no-plugin-dir --plugin-dir-extra');", false),
            ("process.stdout.write('--plugin-dir' + 'x'.repeat(65536));", false),
            ("process.stdout.write(Buffer.from([255]));", false),
            ("setTimeout(() => process.stdout.write('--plugin-dir'), 10000);", false),
        ] {
            std::fs::write(&script, source).unwrap();
            let started = Instant::now();
            assert_eq!(supports_launch_flag(&executable, "--plugin-dir"), expected, "{source}");
            assert!(started.elapsed() < Duration::from_secs(6));
        }
        std::fs::write(&script, "process.stdout.write('--settings');").unwrap();
        let original = vec!["--model".to_string(), "chosen-model".to_string()];
        let mut arguments = original.clone();
        assert!(
            launch_hooks_if_supported(&executable, "cursor", &mut arguments)
                .unwrap()
                .is_none()
        );
        assert_eq!(arguments, original);
        assert!(
            launch_hooks_if_supported(&executable, "droid", &mut arguments)
                .unwrap()
                .is_some()
        );
        assert_eq!(&arguments[2..], original);
    }

    #[cfg(windows)]
    #[test]
    fn windows_hook_runner_preserves_unicode_stdin_and_arguments() {
        use std::io::Write;
        let node = super::super::find_executable("node")
            .expect("Node is required by the repository build");
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("hook space 繁體");
        std::fs::create_dir(&directory).unwrap();
        reporter_command(&directory, "cursor").unwrap();
        let stub = root.path().join("reporter.cmd");
        let capture = root.path().join("capture.cjs");
        std::fs::write(&capture, r#"let data = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => {data += chunk}); process.stdin.on('end', () => process.stdout.write(JSON.stringify({args: process.argv.slice(2), payload: JSON.parse(data)})));"#).unwrap();
        std::fs::write(
            &stub,
            format!("@\"{}\" \"{}\" %*\r\n", node.display(), capture.display()),
        )
        .unwrap();
        let mut child = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-File"])
            .arg(directory.join("report.ps1"))
            .env("LATTICETERM_AGENT_REPORTER", &stub)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let payload = json!({"hook_event_name":"sessionStart", "conversation_id":"原始對話", "unused_text":"不應轉送的內容"});
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&serde_json::to_vec(&payload).unwrap())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let captured: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(captured["args"], json!(["agent-fleet-hook", "cursor"]));
        assert_eq!(captured["payload"], payload);
    }
}
