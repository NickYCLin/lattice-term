//! Lets Codex's own `/model` picker offer what a CLIProxyAPI server serves.
//!
//! Codex lists models from its catalog only, so a session started through
//! the proxy used to show the native OpenAI list. A process-local
//! `model_catalog_json` replaces that list with the proxy's models, and a
//! dedicated `--profile` layer receives the picker's saved choice, so a proxy
//! model ID never becomes the default of the user's ordinary Codex.
//!
//! Every entry reproduces the metadata Codex gives a model it does not know
//! (`model_info_from_slug` upstream). Requests therefore look exactly as they
//! did before the catalog existed: same instructions, tools and parameters.

use std::io::{Read as _, Write as _};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use zeroize::Zeroizing;

use super::ProxyModel;

/// Codex's base prompt for models outside its catalog, unmodified from
/// openai/codex (Apache-2.0); see `vendor/openai-codex-prompt`.
const UPSTREAM_PROMPT: &str = include_str!("../../../vendor/openai-codex-prompt/prompt.md");

/// `--profile` layers `<name>.config.toml` on the user config from 0.134.0.
/// Earlier releases read a legacy `[profiles]` table instead, where the same
/// flag would fail or write into the user's own configuration file.
const LAYERED_PROFILE_SINCE: (u64, u64, u64) = (0, 134, 0);
const PROFILE_PREFIX: &str = "latticeterm-cliproxyapi";
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);
const MODELS_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_VERSION_OUTPUT: u64 = 4096;

/// Owns the catalog file for as long as the Codex process may read it.
pub struct ModelCatalog {
    file: tempfile::NamedTempFile,
    profile: String,
}

impl ModelCatalog {
    pub fn write(models: &[ProxyModel], proxy_id: Option<&str>) -> Result<Self, String> {
        let mut file = tempfile::Builder::new()
            .prefix("latticeterm-cliproxy-models-")
            .suffix(".json")
            .tempfile()
            .map_err(|error| format!("Cannot create the CLIProxyAPI model catalog: {error}"))?;
        serde_json::to_writer(&mut file, &catalog(models))
            .map_err(|error| format!("Cannot write the CLIProxyAPI model catalog: {error}"))?;
        file.flush()
            .map_err(|error| format!("Cannot finish the CLIProxyAPI model catalog: {error}"))?;
        Ok(Self {
            file,
            profile: profile_name(proxy_id),
        })
    }

    pub fn arguments(&self) -> Vec<String> {
        let path = self.file.path().to_string_lossy().into_owned();
        vec![
            "-c".into(),
            // A TOML string, so a Windows path keeps its backslashes.
            format!("model_catalog_json={}", toml::Value::String(path)),
            "--profile".into(),
            self.profile.clone(),
        ]
    }
}

/// Each proxy remembers its own last choice; none of them touch the default.
pub fn profile_name(proxy_id: Option<&str>) -> String {
    match proxy_id.filter(|id| *id != crate::credentials::CLI_PROXY_DEFAULT_ID) {
        Some(id) => format!("{PROFILE_PREFIX}-{id}"),
        None => PROFILE_PREFIX.to_string(),
    }
}

/// Best effort: a catalog is a convenience, never a reason to refuse a
/// launch. Without one the session starts as it always has, on the model the
/// user picked, and `/model` shows Codex's own list.
pub fn prepare(
    program: &std::ffi::OsStr,
    prefix: &[std::ffi::OsString],
    base_url: &str,
    key: Option<&str>,
    proxy_id: Option<&str>,
) -> Option<ModelCatalog> {
    let version = codex_version(program, prefix)?;
    if !supports_layered_profiles(&version) {
        return None;
    }
    let models = fetch_models(base_url, key.map(|key| Zeroizing::new(key.to_string())))?;
    ModelCatalog::write(&models, proxy_id).ok()
}

fn codex_version(program: &std::ffi::OsStr, prefix: &[std::ffi::OsString]) -> Option<String> {
    let mut child = Command::new(program)
        .args(prefix)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + VERSION_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) | Err(_) => return None,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
        }
    }
    let mut output = String::new();
    child
        .stdout
        .take()?
        .take(MAX_VERSION_OUTPUT)
        .read_to_string(&mut output)
        .ok()?;
    Some(output)
}

/// Launches may run on an async worker, so the request gets its own runtime
/// on its own thread rather than nesting one inside the caller's.
fn fetch_models(base_url: &str, key: Option<Zeroizing<String>>) -> Option<Vec<ProxyModel>> {
    let base_url = base_url.to_string();
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .ok()?;
        runtime.block_on(async {
            tokio::time::timeout(MODELS_TIMEOUT, super::models(&base_url, key))
                .await
                .ok()?
                .ok()
        })
    })
    .join()
    .ok()
    .flatten()
}

pub fn supports_layered_profiles(version_output: &str) -> bool {
    let Some(version) = version_output
        .split_whitespace()
        .find(|word| word.starts_with(|c: char| c.is_ascii_digit()))
    else {
        return false;
    };
    // "0.156.1" or "0.156.1-alpha.2"; anything else is not a version.
    let core = version.split(['-', '+']).next().unwrap_or_default();
    let parts: Vec<u64> = core
        .split('.')
        .map(str::parse)
        .collect::<Result<_, _>>()
        .unwrap_or_default();
    let [major, minor, patch] = parts[..] else {
        return false;
    };
    (major, minor, patch) >= LAYERED_PROFILE_SINCE
}

pub fn catalog(models: &[ProxyModel]) -> Value {
    let instructions = fallback_instructions();
    let entries: Vec<Value> = models
        .iter()
        .enumerate()
        .map(|(index, model)| entry(model, index, &instructions))
        .collect();
    json!({ "models": entries })
}

/// Mirrors upstream `model_info_from_slug`, except that the model is listed.
/// The fallback advertises no reasoning levels, which makes `/model` save
/// "none". The proxy cannot say which levels a model takes, so offer the
/// usual three and keep medium, the effort an unknown model already gets.
fn entry(model: &ProxyModel, index: usize, instructions: &str) -> Value {
    json!({
        "slug": model.id,
        "display_name": model.id,
        "description": model.owned_by.as_deref().map(|owner| format!("CLIProxyAPI · {owner}")),
        "default_reasoning_level": "medium",
        "supported_reasoning_levels": [
            { "effort": "low", "description": "Fast responses with lighter reasoning" },
            { "effort": "medium", "description": "Balances speed and reasoning depth" },
            { "effort": "high", "description": "Greater reasoning depth for complex problems" },
        ],
        "shell_type": "unified_exec",
        "visibility": "list",
        "supported_in_api": true,
        // Keep the proxy's order in the picker.
        "priority": i32::try_from(index + 1).unwrap_or(i32::MAX),
        "availability_nux": null,
        "upgrade": null,
        "base_instructions": instructions,
        "include_skills_usage_instructions": false,
        "include_plugin_usage_instructions": false,
        "include_apps_usage_instructions": false,
        "default_reasoning_summary": "auto",
        "support_verbosity": false,
        "default_verbosity": null,
        "apply_patch_tool_type": null,
        "web_search_tool_type": "text",
        "truncation_policy": { "mode": "bytes", "limit": 10_000 },
        "context_window": 272_000,
        "max_context_window": 272_000,
        "effective_context_window_percent": 95,
        "experimental_supported_tools": [],
    })
}

/// Codex removes its checklist-tool guidance from its own prompt when the
/// `update_plan` tool is off, which is the default, but leaves catalog text
/// alone. Applying the same rule here keeps the prompt identical to the one
/// an unknown model received. Port of upstream
/// `codex_prompts::without_update_plan_instructions` (Apache-2.0).
pub fn fallback_instructions() -> String {
    without_update_plan_instructions(UPSTREAM_PROMPT)
}

fn without_update_plan_instructions(instructions: &str) -> String {
    let lines: Vec<&str> = instructions.split_inclusive('\n').collect();
    let mut rendered = String::with_capacity(instructions.len());
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index].trim_end();
        if matches!(
            line,
            "## Planning"
                | "## `update_plan`"
                | "## Plan tool"
                | "## Plan Mode vs update_plan tool"
        ) {
            let end = (index + 1..lines.len())
                .find(|&next| lines[next].starts_with("# ") || lines[next].starts_with("## "))
                .unwrap_or(lines.len());
            let checklist = line != "## Planning"
                || lines[index..end].iter().any(|line| {
                    line.starts_with("You have access to an `update_plan` tool")
                        || line.starts_with("When `update_plan` is available, follow this section")
                });
            if checklist {
                index = end;
                continue;
            }
        }
        if line == "Progress visibility:"
            && lines
                .get(index + 1)
                .is_some_and(|line| line.starts_with("If update_plan is available"))
        {
            index += 2;
            if lines.get(index).is_some_and(|line| line.trim().is_empty()) {
                index += 1;
            }
            continue;
        }
        if line.starts_with("- Use the plan tool ")
            || line.starts_with("- If you create a checklist or task list,")
        {
            index += 1;
            while index < lines.len()
                && (lines[index].starts_with(' ') || lines[index].starts_with('\t'))
            {
                index += 1;
            }
            continue;
        }
        rendered.push_str(lines[index]);
        index += 1;
    }
    rendered
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn model(id: &str, owner: Option<&str>) -> ProxyModel {
        ProxyModel {
            id: id.into(),
            owned_by: owner.map(Into::into),
        }
    }

    #[test]
    fn only_layered_profile_releases_qualify() {
        for (output, expected) in [
            ("codex-cli 0.156.1\n", true),
            ("codex-cli 0.134.0", true),
            ("codex-cli 1.0.0", true),
            ("codex-cli 0.200.0-alpha.3", true),
            ("codex-cli 0.133.9", false),
            ("codex-cli 0.99.0", false),
            ("codex-cli", false),
            ("codex-cli 0.156", false),
            ("", false),
        ] {
            assert_eq!(supports_layered_profiles(output), expected, "{output:?}");
        }
    }

    #[test]
    fn each_proxy_writes_its_choice_to_its_own_profile() {
        assert_eq!(profile_name(None), "latticeterm-cliproxyapi");
        assert_eq!(profile_name(Some("default")), "latticeterm-cliproxyapi");
        assert_eq!(
            profile_name(Some("7f3a91")),
            "latticeterm-cliproxyapi-7f3a91"
        );
    }

    #[test]
    fn entries_describe_proxy_models_the_way_codex_describes_unknown_ones() {
        let value = catalog(&[
            model("claude-opus-5", Some("anthropic")),
            model("local-model", None),
        ]);
        let entries = value["models"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["slug"], "claude-opus-5");
        assert_eq!(entries[0]["description"], "CLIProxyAPI · anthropic");
        assert!(entries[1]["description"].is_null());
        assert_eq!(entries[0]["priority"], 1);
        assert_eq!(entries[1]["priority"], 2);
        for entry in entries {
            assert_eq!(entry["visibility"], "list");
            // Picking a model in `/model` must not switch reasoning off.
            assert_eq!(entry["default_reasoning_level"], "medium");
            assert!(entry["supported_reasoning_levels"]
                .as_array()
                .unwrap()
                .iter()
                .any(|level| level["effort"] == "medium"));
            // No freeform patch grammar or search tool: a proxied model may
            // not accept tools beyond plain functions.
            assert!(entry["apply_patch_tool_type"].is_null());
            assert_eq!(entry["truncation_policy"]["mode"], "bytes");
            assert_eq!(entry["base_instructions"], fallback_instructions());
        }
    }

    #[test]
    fn prompt_drops_only_the_checklist_tool_guidance() {
        let prompt = fallback_instructions();
        assert!(UPSTREAM_PROMPT.contains("\n## Planning\n"));
        assert!(!prompt.contains("## Planning"));
        assert!(!prompt.contains("update_plan"));
        assert!(prompt.starts_with("You are a coding agent running in the Codex CLI"));
        assert!(prompt.len() > UPSTREAM_PROMPT.len() / 2);
    }

    #[test]
    fn checklist_filter_matches_upstream_cases() {
        // Cases from upstream update_plan_instructions_tests.rs.
        assert_eq!(
            without_update_plan_instructions(
                "Before.\n\n## Planning\nYou have access to an `update_plan` tool which tracks steps.\n\n### Examples\nKeep steps current.\n\n## Work\nImplement.\n\n## `update_plan`\nUpdate the checklist.\n\n# Next\n## Planning\nDiscuss architecture and inspect update_plan before editing.\n"
            ),
            "Before.\n\n## Work\nImplement.\n\n# Next\n## Planning\nDiscuss architecture and inspect update_plan before editing.\n",
        );
        assert_eq!(
            without_update_plan_instructions(
                "Keep working.\n- Use the plan tool to explain the work\n    - Skip simple tasks.\n    - Keep steps current.\n- Explain discoveries.\n- If you create a checklist or task list, update its statuses.\n\nProgress visibility:\nIf update_plan is available, use it for complex work.\n\nCompletion:\nVerify the result.\n"
            ),
            "Keep working.\n- Explain discoveries.\n\nCompletion:\nVerify the result.\n",
        );
    }

    #[test]
    fn arguments_point_codex_at_the_file_and_the_profile() {
        let catalog = ModelCatalog::write(&[model("gemini-3-pro", None)], Some("7f3a91")).unwrap();
        let arguments = catalog.arguments();
        assert_eq!(arguments[0], "-c");
        let value: toml::Table = arguments[1].parse().unwrap();
        let path = value["model_catalog_json"].as_str().unwrap();
        assert_eq!(Path::new(path), catalog.file.path());
        let written: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(written["models"][0]["slug"], "gemini-3-pro");
        assert_eq!(
            &arguments[2..],
            ["--profile", "latticeterm-cliproxyapi-7f3a91"]
        );
    }

    /// A stand-in `codex` that only answers `--version`. It is run through
    /// `sh` so a freshly written file is never executed directly, which can
    /// fail with "text file busy" while other tests fork.
    #[cfg(unix)]
    fn fake_codex(
        directory: &Path,
        version: &str,
    ) -> (std::ffi::OsString, Vec<std::ffi::OsString>) {
        let path = directory.join(format!("codex-{version}"));
        std::fs::write(&path, format!("echo 'codex-cli {version}'\n")).unwrap();
        ("/bin/sh".into(), vec![path.into_os_string()])
    }

    /// Answers one `/v1/models` request and reports the request head.
    fn serve_models_once(body: &'static str) -> (String, std::thread::JoinHandle<String>) {
        use std::io::{BufRead as _, BufReader};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut head = String::new();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
                head.push_str(&line);
            }
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).unwrap();
            head
        });
        (address, handle)
    }

    #[cfg(unix)]
    #[test]
    fn a_current_codex_gets_the_proxy_models_it_can_switch_between() {
        let directory = tempfile::tempdir().unwrap();
        let (sh, codex) = fake_codex(directory.path(), "0.156.1");
        let (address, served) = serve_models_once(
            r#"{"data":[{"id":"claude-opus-5","owned_by":"anthropic"},{"id":"gemini-3-pro"}]}"#,
        );
        let catalog = prepare(&sh, &codex, &address, Some("sk-fixture"), None).unwrap();
        let head = served.join().unwrap();
        assert!(head.starts_with("GET /v1/models "));
        assert!(head
            .to_ascii_lowercase()
            .contains("authorization: bearer sk-fixture"));
        let written: Value =
            serde_json::from_slice(&std::fs::read(catalog.file.path()).unwrap()).unwrap();
        let slugs: Vec<&str> = written["models"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["slug"].as_str().unwrap())
            .collect();
        assert_eq!(slugs, ["claude-opus-5", "gemini-3-pro"]);
        // The file goes away with the session that owned it.
        let path = catalog.file.path().to_path_buf();
        drop(catalog);
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn older_codex_or_an_unreachable_proxy_keeps_the_plain_launch() {
        let directory = tempfile::tempdir().unwrap();
        // Before layered profiles the picker would write into the user's own
        // configuration, so the proxy is not even asked.
        let (sh, old) = fake_codex(directory.path(), "0.133.0");
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        assert!(prepare(&sh, &old, &address, None, None).is_none());
        assert!(listener.accept().is_err());
        drop(listener);

        let (_, current) = fake_codex(directory.path(), "0.156.1");
        assert!(prepare(&sh, &current, &address, None, None).is_none());
        let missing = directory.path().join("missing-codex").into_os_string();
        assert!(prepare(&missing, &[], &address, None, None).is_none());
    }
}
