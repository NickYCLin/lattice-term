//! Explicit desktop grant for model-selected project launches. The directory
//! allowlist limits startup location, not what an unconfined CLI can access.
use crate::agent::AgentLaunchRequest;
use serde::{Deserialize, Serialize};
use std::path::{Component, Path};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectLaunchPolicy {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub roots: Vec<String>,
    #[serde(default = "default_full")]
    pub full_permissions: bool,
}
fn default_full() -> bool {
    true
}
impl Default for ProjectLaunchPolicy {
    fn default() -> Self {
        Self {
            enabled: false,
            roots: vec![],
            full_permissions: true,
        }
    }
}
impl ProjectLaunchPolicy {
    pub fn normalized(mut self) -> Result<Self, String> {
        if self.roots.len() > 32 {
            return Err("At most 32 project roots are allowed.".into());
        }
        self.roots = self
            .roots
            .iter()
            .map(|root| {
                canonical_directory(root).or_else(|error| {
                    if !self.enabled
                        && Path::new(root).is_absolute()
                        && root.len() <= 4096
                        && !root.chars().any(char::is_control)
                        && !Path::new(root)
                            .components()
                            .any(|part| matches!(part, Component::ParentDir))
                    {
                        Ok(root.clone())
                    } else {
                        Err(error)
                    }
                })
            })
            .collect::<Result<_, _>>()?;
        self.roots.sort();
        self.roots.dedup();
        if self.enabled && self.roots.is_empty() {
            return Err("Register a project root before enabling project launches.".into());
        }
        Ok(self)
    }
    pub fn directory(&self, raw: &str) -> Result<String, String> {
        if !self.enabled {
            return Err(
                "Project launch is not authorized. Enable it in Agent Fleet settings.".into(),
            );
        }
        let directory = canonical_directory(raw)?;
        if !self.roots.iter().any(|root| {
            // Re-resolve roots too: replacing an approved root with an external
            // symlink must revoke access rather than silently move the grant.
            canonical_directory(root).ok().as_deref() == Some(root.as_str())
                && Path::new(&directory).starts_with(root)
        }) {
            return Err("Working directory is outside the registered project roots.".into());
        }
        Ok(directory)
    }
    pub fn request(
        &self,
        directory: &str,
        cli: &str,
        saved: Option<&AgentLaunchRequest>,
    ) -> Result<AgentLaunchRequest, String> {
        let directory = self.directory(directory)?;
        if !["codex", "claude", "gemini"].contains(&cli) {
            return Err("Project launches support only Codex, Claude and Gemini.".into());
        }
        let (arguments, sandbox) = if self.full_permissions {
            (
                match cli {
                    "codex" => vec![
                        "--ask-for-approval",
                        "never",
                        "--sandbox",
                        "danger-full-access",
                    ],
                    "claude" => vec!["--permission-mode", "bypassPermissions"],
                    _ => vec!["--approval-mode", "yolo"],
                }
                .into_iter()
                .map(str::to_string)
                .collect(),
                false,
            )
        } else {
            let saved = saved
                .filter(|p| p.definition_id == cli)
                .ok_or("Select a matching saved plan when inheriting permissions.")?;
            if saved.arguments.iter().any(|argument| {
                let key = argument.split('=').next().unwrap_or(argument);
                [
                    "-c",
                    "--config",
                    "--settings",
                    "--profile",
                    "--policy",
                    "--allowed-tools",
                    "--allowedTools",
                    "--disallowed-tools",
                    "--disallowedTools",
                ]
                .contains(&key)
            }) {
                return Err("Cannot inherit permission overrides from custom configuration; save a plan using explicit permission flags.".into());
            }
            // Inherit only permission flags, never resume IDs, prompts, config,
            // executable overrides or other arguments from a saved restore.
            let flags: &[&str] = match cli {
                "codex" => &["--ask-for-approval", "-a", "--sandbox", "-s"],
                "claude" => &["--permission-mode"],
                _ => &["--approval-mode"],
            };
            let mut args = Vec::new();
            let standalone: &[&str] = match cli {
                "codex" => &["--dangerously-bypass-approvals-and-sandbox", "--full-auto"],
                "claude" => &["--dangerously-skip-permissions"],
                _ => &["--yolo", "-y", "--sandbox", "-s"],
            };
            let mut index = 0;
            while index < saved.arguments.len() {
                let argument = &saved.arguments[index];
                let key = argument.split('=').next().unwrap_or(argument);
                if standalone.contains(&key) || (argument.contains('=') && flags.contains(&key)) {
                    args.push(argument.clone());
                    if cli == "gemini"
                        && ["--sandbox", "-s"].contains(&key)
                        && !argument.contains('=')
                        && saved
                            .arguments
                            .get(index + 1)
                            .is_some_and(|value| ["true", "false"].contains(&value.as_str()))
                    {
                        index += 1;
                        args.push(saved.arguments[index].clone());
                    }
                } else if flags.contains(&key) {
                    let value = saved
                        .arguments
                        .get(index + 1)
                        .ok_or("Incomplete saved permission flag.")?;
                    args.extend([argument.clone(), value.clone()]);
                    index += 1;
                }
                index += 1;
            }
            (args, saved.sandbox)
        };
        Ok(AgentLaunchRequest {
            definition_id: cli.into(),
            label: String::new(),
            executable: String::new(),
            arguments,
            resume_session_id: None,
            group_id: None,
            seed_input: None,
            restore_existing_session: false,
            profile_config_path: None,
            sandbox,
            detached: true,
            working_directory: directory,
            cols: 120,
            rows: 32,
        })
    }
}
fn canonical_directory(raw: &str) -> Result<String, String> {
    let path = Path::new(raw);
    if raw.len() > 4096
        || raw.chars().any(char::is_control)
        || !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("Use an absolute project directory without parent traversal.".into());
    }
    let canonical = path.canonicalize().map(crate::agent::plain_win32_path);
    let canonical = canonical.map_err(|_| "Cannot resolve project directory.")?;
    if !canonical.is_dir() {
        return Err("Project path must be a directory.".into());
    }
    Ok(canonical.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn policy(root: &Path) -> ProjectLaunchPolicy {
        ProjectLaunchPolicy {
            enabled: true,
            roots: vec![root.display().to_string()],
            full_permissions: true,
        }
        .normalized()
        .unwrap()
    }
    #[test]
    fn project_launch_requires_explicit_grant_and_a_registered_existing_absolute_directory() {
        let root = tempfile::tempdir().unwrap();
        assert!(!ProjectLaunchPolicy::default().enabled);
        assert!(ProjectLaunchPolicy::default().full_permissions);
        assert!(ProjectLaunchPolicy::default()
            .directory(root.path().to_str().unwrap())
            .is_err());
        let granted = policy(root.path());
        let child = root.path().join("child");
        std::fs::create_dir(&child).unwrap();
        assert!(granted.directory(child.to_str().unwrap()).is_ok());
        let outside = tempfile::tempdir().unwrap();
        assert!(granted.directory(outside.path().to_str().unwrap()).is_err());
        for bad in [
            "relative".to_string(),
            root.path().join("child/../child").display().to_string(),
            root.path().join("missing").display().to_string(),
        ] {
            assert!(granted.directory(&bad).is_err(), "{bad}");
        }
        assert!(granted
            .request(child.to_str().unwrap(), "custom", None)
            .is_err());
    }
    #[cfg(unix)]
    #[test]
    fn project_launch_rejects_symlink_escape_and_a_replaced_approved_root() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let approved = root.path().join("approved");
        std::fs::create_dir(&approved).unwrap();
        let granted = policy(&approved);
        std::os::unix::fs::symlink(outside.path(), approved.join("escape")).unwrap();
        assert!(granted
            .directory(approved.join("escape").to_str().unwrap())
            .is_err());
        std::fs::rename(&approved, root.path().join("original")).unwrap();
        std::os::unix::fs::symlink(outside.path(), &approved).unwrap();
        assert!(granted.directory(approved.to_str().unwrap()).is_err());
    }
    #[test]
    fn project_launch_builds_full_permission_flags_without_resuming_or_enabling_sandbox() {
        let root = tempfile::tempdir().unwrap();
        let policy = policy(root.path());
        for (cli, expected) in [
            (
                "codex",
                vec![
                    "--ask-for-approval",
                    "never",
                    "--sandbox",
                    "danger-full-access",
                ],
            ),
            ("claude", vec!["--permission-mode", "bypassPermissions"]),
            ("gemini", vec!["--approval-mode", "yolo"]),
        ] {
            let request = policy
                .request(root.path().to_str().unwrap(), cli, None)
                .unwrap();
            assert_eq!(request.arguments, expected);
            assert!(request.detached);
            assert!(!request.sandbox);
            assert!(!request.restore_existing_session);
            assert!(request.resume_session_id.is_none());
            assert!(request.executable.is_empty());
        }
    }
    #[test]
    fn project_launch_inherits_only_the_matching_saved_permission_flags() {
        let root = tempfile::tempdir().unwrap();
        let mut policy = policy(root.path());
        let mut saved = policy
            .request(root.path().to_str().unwrap(), "codex", None)
            .unwrap();
        saved.arguments = vec![
            "--model",
            "fixture",
            "--ask-for-approval",
            "on-request",
            "--sandbox",
            "read-only",
        ]
        .into_iter()
        .map(str::to_string)
        .collect();
        saved.sandbox = true;
        policy.full_permissions = false;
        assert!(policy
            .request(root.path().to_str().unwrap(), "codex", None)
            .is_err());
        assert!(policy
            .request(root.path().to_str().unwrap(), "claude", Some(&saved))
            .is_err());
        let request = policy
            .request(root.path().to_str().unwrap(), "codex", Some(&saved))
            .unwrap();
        assert_eq!(
            request.arguments,
            ["--ask-for-approval", "on-request", "--sandbox", "read-only"]
        );
        assert!(request.sandbox);
        saved.arguments = vec![
            "--ask-for-approval=on-request".into(),
            "--sandbox=read-only".into(),
        ];
        assert_eq!(
            policy
                .request(root.path().to_str().unwrap(), "codex", Some(&saved))
                .unwrap()
                .arguments,
            saved.arguments
        );
        saved
            .arguments
            .extend(["-c".into(), "sandbox_mode=read-only".into()]);
        assert!(policy
            .request(root.path().to_str().unwrap(), "codex", Some(&saved))
            .is_err());
    }
}
