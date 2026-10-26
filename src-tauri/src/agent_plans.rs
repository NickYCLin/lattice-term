//! Non-secret launch metadata for restoring an Agent Fleet workspace.
//!
//! This intentionally does not persist PTY output, per-session prompts,
//! reporter tokens, process identifiers, or model credentials. The only prompt
//! text stored here is the user's explicit workspace-wide startup instruction.
//! Restoring always starts new CLI processes after an explicit confirmation.

pub use crate::agent_project_launch::ProjectLaunchPolicy;

use crate::agent::{
    normalize_launch_plan, AgentLaunchPlan, AgentLaunchPlanDraft, MAX_SAVED_AGENT_PLANS,
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const STORE_VERSION: u32 = 5;
const STORE_FILE: &str = "agent-workspaces.json";
const MAX_STARTUP_INSTRUCTIONS_BYTES: usize = 8 * 1024;

#[derive(Debug, Serialize, Deserialize)]
struct StoreFile {
    version: u32,
    #[serde(default, rename = "workspaceName")]
    workspace_name: String,
    #[serde(default, rename = "startupInstructions")]
    startup_instructions: String,
    #[serde(default, rename = "mcpLaunch")]
    mcp_launch: bool,
    #[serde(default, rename = "mcpProjectLaunch")]
    mcp_project_launch: ProjectLaunchPolicy,
    plans: Vec<AgentLaunchPlan>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPlanRecovery {
    pub reason: String,
    pub backup_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPlanSnapshot {
    pub workspace_name: String,
    pub startup_instructions: String,
    /// Whether MCP clients may start the saved plans marked "keep in the
    /// background".
    #[serde(default)]
    pub mcp_launch: bool,
    pub mcp_project_launch: ProjectLaunchPolicy,
    pub plans: Vec<AgentLaunchPlan>,
    pub recovery: Option<AgentPlanRecovery>,
}

#[derive(Debug)]
pub struct FileAgentPlanStore {
    path: PathBuf,
    last_saved: RefCell<Option<Vec<u8>>>,
    workspace_name: String,
    startup_instructions: String,
    mcp_launch: bool,
    mcp_project_launch: ProjectLaunchPolicy,
    plans: Vec<AgentLaunchPlan>,
    recovery: Option<AgentPlanRecovery>,
}

fn reject_unsafe_store_path(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err("The workspace file must be a regular file, not a link.".into())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

impl FileAgentPlanStore {
    pub fn open(dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(dir).map_err(|error| error.to_string())?;
        let path = dir
            .canonicalize()
            .map_err(|e| e.to_string())?
            .join(STORE_FILE);
        reject_unsafe_store_path(&path)?;
        let mut store = Self {
            path,
            last_saved: RefCell::new(None),
            workspace_name: String::new(),
            startup_instructions: String::new(),
            mcp_launch: false,
            mcp_project_launch: ProjectLaunchPolicy::default(),
            plans: Vec::new(),
            recovery: None,
        };

        let raw = match fs::read_to_string(&store.path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(store),
            Err(error) => return Err(error.to_string()),
        };
        match serde_json::from_str::<StoreFile>(&raw) {
            Ok(file)
                if file.version <= STORE_VERSION && file.plans.len() <= MAX_SAVED_AGENT_PLANS =>
            {
                match (
                    normalize_stored_workspace_name(&file.workspace_name),
                    normalize_startup_instructions(&file.startup_instructions),
                ) {
                    (Ok(name), Ok(instructions)) => {
                        store.workspace_name = name;
                        store.startup_instructions = instructions;
                        store.mcp_launch = file.mcp_launch;
                        store.mcp_project_launch = file.mcp_project_launch;
                        store.plans = file.plans;
                        *store.last_saved.borrow_mut() = Some(raw.as_bytes().to_vec());
                    }
                    (Err(error), _) => {
                        store.recovery = Some(store.set_aside(format!(
                            "file contains an invalid workspace name: {error}"
                        ))?);
                    }
                    (_, Err(error)) => {
                        store.recovery = Some(store.set_aside(format!(
                            "file contains invalid startup instructions: {error}"
                        ))?);
                    }
                }
            }
            Ok(file) if file.version > STORE_VERSION => {
                store.recovery = Some(store.set_aside(format!(
                    "file was written by a newer version (found {}, supported {})",
                    file.version, STORE_VERSION
                ))?);
            }
            Ok(file) => {
                store.recovery = Some(store.set_aside(format!(
                    "file contains too many launch plans (found {}, supported {})",
                    file.plans.len(),
                    MAX_SAVED_AGENT_PLANS
                ))?);
            }
            Err(error) => {
                store.recovery = Some(store.set_aside(format!("file could not be read: {error}"))?);
            }
        }
        Ok(store)
    }

    fn set_aside(&self, reason: String) -> Result<AgentPlanRecovery, String> {
        let mut backup = self.path.clone();
        backup.set_extension("json.unreadable");
        let mut attempt = 1;
        while backup.exists() {
            backup = self.path.clone();
            backup.set_extension(format!("json.unreadable.{attempt}"));
            attempt += 1;
        }
        fs::rename(&self.path, &backup).map_err(|error| error.to_string())?;
        Ok(AgentPlanRecovery {
            reason,
            backup_path: backup.display().to_string(),
        })
    }

    fn next_id() -> Result<String, String> {
        let mut bytes = [0_u8; 16];
        getrandom::fill(&mut bytes)
            .map_err(|error| format!("Cannot create a launch plan ID: {error}"))?;
        Ok(format!(
            "agent-plan-{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
        ))
    }

    fn persist(&self) -> Result<(), String> {
        let json = serde_json::to_string_pretty(&StoreFile {
            version: STORE_VERSION,
            workspace_name: self.workspace_name.clone(),
            startup_instructions: self.startup_instructions.clone(),
            mcp_launch: self.mcp_launch,
            mcp_project_launch: self.mcp_project_launch.clone(),
            plans: self.plans.clone(),
        })
        .map_err(|error| error.to_string())?;
        let directory = self
            .path
            .parent()
            .ok_or_else(|| "Agent plan store path has no directory.".to_string())?;
        let check_current = || -> Result<(), String> {
            reject_unsafe_store_path(&self.path)?;
            let current = match fs::read(&self.path) {
                Ok(bytes) => Some(bytes),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Err(e) => return Err(e.to_string()),
            };
            if current != *self.last_saved.borrow() {
                return Err("The workspace file changed externally; reload before saving.".into());
            }
            Ok(())
        };
        check_current()?;
        let mut temporary = tempfile::Builder::new()
            .prefix(".agent-workspaces-")
            .tempfile_in(directory)
            .map_err(|e| e.to_string())?;
        temporary
            .write_all(json.as_bytes())
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(|e| e.to_string())?;
        check_current()?;
        temporary
            .persist(&self.path)
            .map_err(|e| e.error.to_string())?;
        *self.last_saved.borrow_mut() = Some(json.into_bytes());
        Ok(())
    }

    pub fn snapshot(&self) -> AgentPlanSnapshot {
        AgentPlanSnapshot {
            workspace_name: self.workspace_name.clone(),
            startup_instructions: self.startup_instructions.clone(),
            mcp_launch: self.mcp_launch,
            mcp_project_launch: self.mcp_project_launch.clone(),
            plans: self.plans.clone(),
            recovery: self.recovery.clone(),
        }
    }

    pub fn rename(&mut self, name: &str) -> Result<String, String> {
        let name = normalize_workspace_name(name)?;
        if name == self.workspace_name {
            return Ok(name);
        }
        let previous = std::mem::replace(&mut self.workspace_name, name.clone());
        if let Err(error) = self.persist() {
            self.workspace_name = previous;
            return Err(error);
        }
        Ok(name)
    }

    pub fn update_startup_instructions(&mut self, value: &str) -> Result<String, String> {
        let instructions = normalize_startup_instructions(value)?;
        if instructions == self.startup_instructions {
            return Ok(instructions);
        }
        let previous = std::mem::replace(&mut self.startup_instructions, instructions.clone());
        if let Err(error) = self.persist() {
            self.startup_instructions = previous;
            return Err(error);
        }
        Ok(instructions)
    }

    pub fn update_project_launch(
        &mut self,
        policy: ProjectLaunchPolicy,
    ) -> Result<ProjectLaunchPolicy, String> {
        let policy = policy.normalized()?;
        let previous = std::mem::replace(&mut self.mcp_project_launch, policy.clone());
        if let Err(error) = self.persist() {
            self.mcp_project_launch = previous;
            return Err(error);
        }
        Ok(policy)
    }

    pub fn update_mcp_launch(&mut self, enabled: bool) -> Result<bool, String> {
        if enabled == self.mcp_launch {
            return Ok(enabled);
        }
        self.mcp_launch = enabled;
        if let Err(error) = self.persist() {
            self.mcp_launch = !enabled;
            return Err(error);
        }
        Ok(enabled)
    }

    pub fn reorder(&mut self, ordered_ids: &[String]) -> Result<Vec<AgentLaunchPlan>, String> {
        if ordered_ids.len() != self.plans.len() {
            return Err("The ordered launch plan list must contain every saved item.".to_string());
        }
        let mut reordered = Vec::with_capacity(self.plans.len());
        for id in ordered_ids {
            if id.trim() != id || id.is_empty() || id.len() > 128 {
                return Err("A saved launch plan ID is invalid.".to_string());
            }
            let plan = self
                .plans
                .iter()
                .find(|plan| &plan.id == id)
                .ok_or_else(|| format!("Saved launch plan '{id}' no longer exists."))?;
            if reordered
                .iter()
                .any(|entry: &AgentLaunchPlan| entry.id == plan.id)
            {
                return Err("A saved launch plan appears more than once in the order.".to_string());
            }
            reordered.push(plan.clone());
        }

        if reordered == self.plans {
            return Ok(reordered);
        }
        let previous = std::mem::replace(&mut self.plans, reordered);
        if let Err(error) = self.persist() {
            self.plans = previous;
            return Err(error);
        }
        Ok(self.plans.clone())
    }

    pub fn save(&mut self, draft: AgentLaunchPlanDraft) -> Result<AgentLaunchPlan, String> {
        let candidate = normalize_launch_plan(Self::next_id()?, draft)?;
        let matching_plan = self.plans.iter().position(|existing| {
            existing.definition_id == candidate.definition_id
                && existing.label == candidate.label
                && existing.executable == candidate.executable
                && existing.arguments == candidate.arguments
                && existing.resume_session_id == candidate.resume_session_id
                && existing.working_directory == candidate.working_directory
        });

        if let Some(index) = matching_plan {
            let mut updated = candidate;
            updated.id = self.plans[index].id.clone();
            if updated == self.plans[index] {
                return Ok(updated);
            }
            let previous = std::mem::replace(&mut self.plans[index], updated.clone());
            if let Err(error) = self.persist() {
                self.plans[index] = previous;
                return Err(error);
            }
            return Ok(updated);
        }

        if self.plans.len() >= MAX_SAVED_AGENT_PLANS {
            return Err(format!(
                "At most {MAX_SAVED_AGENT_PLANS} launch plans may be saved."
            ));
        }
        let plan = candidate;
        self.plans.push(plan.clone());
        if let Err(error) = self.persist() {
            self.plans.pop();
            return Err(error);
        }
        Ok(plan)
    }

    pub fn delete(&mut self, id: &str) -> Result<bool, String> {
        let Some(index) = self.plans.iter().position(|plan| plan.id == id) else {
            return Ok(false);
        };
        let removed = self.plans.remove(index);
        if let Err(error) = self.persist() {
            self.plans.insert(index, removed);
            return Err(error);
        }
        Ok(true)
    }

    pub fn find(&self, id: &str) -> Option<AgentLaunchPlan> {
        self.plans.iter().find(|plan| plan.id == id).cloned()
    }
}

fn normalize_workspace_name(value: &str) -> Result<String, String> {
    let name = value.trim();
    if name.is_empty() {
        return Err("Workspace name is required.".to_string());
    }
    if name.len() > 80 {
        return Err("Workspace name is too long (maximum 80 bytes).".to_string());
    }
    if name.chars().any(char::is_control) {
        return Err("Workspace name contains unsupported control characters.".to_string());
    }
    Ok(name.to_string())
}

fn normalize_stored_workspace_name(value: &str) -> Result<String, String> {
    if value.is_empty() {
        Ok(String::new())
    } else {
        normalize_workspace_name(value)
    }
}

fn normalize_startup_instructions(value: &str) -> Result<String, String> {
    let value = value.trim().replace("\r\n", "\n").replace('\r', "\n");
    if value.len() > MAX_STARTUP_INSTRUCTIONS_BYTES {
        return Err(format!(
            "Startup instructions are too long (maximum {MAX_STARTUP_INSTRUCTIONS_BYTES} bytes)."
        ));
    }
    if value
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
    {
        return Err("Startup instructions contain unsupported control characters.".to_string());
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("latticeterm-agent-plan-{label}-{unique}"));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    fn draft(directory: &Path, label: &str) -> AgentLaunchPlanDraft {
        AgentLaunchPlanDraft {
            definition_id: "custom".to_string(),
            label: label.to_string(),
            executable: if cfg!(windows) {
                "cmd.exe".to_string()
            } else {
                "/bin/echo".to_string()
            },
            arguments: vec!["--version".to_string()],
            resume_session_id: None,
            note: String::new(),
            sandbox: false,
            detached: false,
            working_directory: directory.display().to_string(),
        }
    }

    #[test]
    fn saved_plans_survive_reopening_without_secret_fields() {
        let directory = temp_dir("round-trip");
        let mut store = FileAgentPlanStore::open(&directory).unwrap();
        let saved = store.save(draft(&directory, "Review agent")).unwrap();

        let reopened = FileAgentPlanStore::open(&directory).unwrap();
        let snapshot = reopened.snapshot();
        assert_eq!(snapshot.plans, vec![saved]);
        let raw = fs::read_to_string(directory.join(STORE_FILE)).unwrap();
        for secret in ["reportToken", "processId", "prompt", "terminalOutput"] {
            assert!(!raw.contains(secret), "unexpected {secret} in plan store");
        }
    }

    #[test]
    fn saving_the_same_launch_updates_its_memo_without_creating_a_duplicate() {
        let directory = temp_dir("upsert");
        let mut store = FileAgentPlanStore::open(&directory).unwrap();
        let initial = store.save(draft(&directory, "Review agent")).unwrap();
        let mut refreshed = draft(&directory, "Review agent");
        refreshed.note = "Updated memo".to_string();

        let saved = store.save(refreshed).unwrap();
        assert_eq!(saved.id, initial.id);
        assert_eq!(saved.note, "Updated memo");
        assert_eq!(store.snapshot().plans, vec![saved]);
    }

    #[test]
    fn deletion_survives_reopening() {
        let directory = temp_dir("delete");
        let mut store = FileAgentPlanStore::open(&directory).unwrap();
        let saved = store.save(draft(&directory, "Review agent")).unwrap();
        assert!(store.delete(&saved.id).unwrap());
        assert!(!store.delete(&saved.id).unwrap());
        assert!(FileAgentPlanStore::open(&directory)
            .unwrap()
            .snapshot()
            .plans
            .is_empty());
    }

    #[test]
    fn version_one_files_migrate_when_named_and_reordered() {
        let directory = temp_dir("v1-migration");
        let first =
            normalize_launch_plan("agent-plan-first".to_string(), draft(&directory, "First"))
                .unwrap();
        let second =
            normalize_launch_plan("agent-plan-second".to_string(), draft(&directory, "Second"))
                .unwrap();
        fs::write(
            directory.join(STORE_FILE),
            serde_json::json!({ "version": 1, "plans": [first, second] }).to_string(),
        )
        .unwrap();

        let mut store = FileAgentPlanStore::open(&directory).unwrap();
        assert_eq!(store.snapshot().workspace_name, "");
        assert_eq!(store.rename("  Release crew  ").unwrap(), "Release crew");
        store
            .reorder(&[
                "agent-plan-second".to_string(),
                "agent-plan-first".to_string(),
            ])
            .unwrap();

        let reopened = FileAgentPlanStore::open(&directory).unwrap();
        let snapshot = reopened.snapshot();
        assert_eq!(snapshot.workspace_name, "Release crew");
        assert_eq!(
            snapshot
                .plans
                .iter()
                .map(|plan| plan.id.as_str())
                .collect::<Vec<_>>(),
            vec!["agent-plan-second", "agent-plan-first"]
        );
        let raw = fs::read_to_string(directory.join(STORE_FILE)).unwrap();
        assert!(raw.contains("\"version\": 5"));
        assert!(raw.contains("\"workspaceName\": \"Release crew\""));
    }

    #[test]
    fn native_resume_ids_are_saved_only_when_explicitly_requested() {
        let directory = temp_dir("native-resume");
        let mut store = FileAgentPlanStore::open(&directory).unwrap();
        let saved = store
            .save(AgentLaunchPlanDraft {
                definition_id: "hermes".to_string(),
                label: String::new(),
                executable: String::new(),
                arguments: Vec::new(),
                resume_session_id: Some("  architecture review  ".to_string()),
                note: "  接手上週的重構  ".to_string(),
                sandbox: false,
                detached: false,
                working_directory: directory.display().to_string(),
            })
            .unwrap();
        assert_eq!(
            saved.resume_session_id.as_deref(),
            Some("architecture review")
        );
        assert_eq!(saved.note, "接手上週的重構");

        let raw = fs::read_to_string(directory.join(STORE_FILE)).unwrap();
        assert!(raw.contains("\"version\": 5"));
        assert!(raw.contains("\"resumeSessionId\": \"architecture review\""));
        assert!(raw.contains("\"note\": \"接手上週的重構\""));
    }

    #[test]
    fn invalid_reorders_do_not_change_the_saved_order() {
        let directory = temp_dir("invalid-reorder");
        let mut store = FileAgentPlanStore::open(&directory).unwrap();
        let first = store.save(draft(&directory, "First")).unwrap();
        let second = store.save(draft(&directory, "Second")).unwrap();

        assert!(store
            .reorder(&[first.id.clone(), first.id.clone()])
            .is_err());
        assert_eq!(store.snapshot().plans, vec![first, second]);
    }

    #[test]
    fn workspace_names_are_trimmed_and_validated() {
        let directory = temp_dir("workspace-name");
        let mut store = FileAgentPlanStore::open(&directory).unwrap();
        assert_eq!(store.rename("  Planning team  ").unwrap(), "Planning team");
        assert!(store.rename("  ").is_err());
        assert!(store.rename("bad\nname").is_err());
        assert_eq!(store.snapshot().workspace_name, "Planning team");
    }

    #[test]
    fn startup_instructions_are_opt_in_and_survive_reopening() {
        let directory = temp_dir("startup-instructions");
        let mut store = FileAgentPlanStore::open(&directory).unwrap();
        assert!(store.snapshot().startup_instructions.is_empty());
        let saved = store
            .update_startup_instructions("  使用自然的繁體中文提交訊息。\r\n只提交本次檔案。  ")
            .unwrap();
        assert_eq!(saved, "使用自然的繁體中文提交訊息。\n只提交本次檔案。");

        let mut reopened = FileAgentPlanStore::open(&directory).unwrap();
        assert_eq!(reopened.snapshot().startup_instructions, saved);
        assert!(reopened
            .update_startup_instructions("  ")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn startup_instructions_reject_oversized_or_control_text() {
        let directory = temp_dir("invalid-startup-instructions");
        let mut store = FileAgentPlanStore::open(&directory).unwrap();
        assert!(store
            .update_startup_instructions(&"x".repeat(MAX_STARTUP_INSTRUCTIONS_BYTES + 1))
            .is_err());
        assert!(store
            .update_startup_instructions("bad\u{0000}text")
            .is_err());
        assert!(store.snapshot().startup_instructions.is_empty());
    }

    #[test]
    fn unreadable_files_are_preserved_for_recovery() {
        let directory = temp_dir("recovery");
        let path = directory.join(STORE_FILE);
        fs::write(&path, "{ broken json").unwrap();

        let store = FileAgentPlanStore::open(&directory).unwrap();
        let recovery = store.snapshot().recovery.expect("recovery details");
        assert!(recovery.reason.contains("could not be read"));
        assert_eq!(
            fs::read_to_string(recovery.backup_path).unwrap(),
            "{ broken json"
        );
    }

    #[test]
    fn invalid_stored_workspace_names_are_preserved_for_recovery() {
        let directory = temp_dir("invalid-stored-name");
        let path = directory.join(STORE_FILE);
        let raw = serde_json::json!({
            "version": STORE_VERSION,
            "workspaceName": "bad\nname",
            "plans": []
        })
        .to_string();
        fs::write(&path, &raw).unwrap();

        let store = FileAgentPlanStore::open(&directory).unwrap();
        let recovery = store.snapshot().recovery.expect("recovery details");
        assert!(recovery.reason.contains("invalid workspace name"));
        assert_eq!(fs::read_to_string(recovery.backup_path).unwrap(), raw);
    }

    #[test]
    fn failed_writes_roll_back_the_in_memory_change() {
        let directory = temp_dir("rollback");
        let mut store = FileAgentPlanStore::open(&directory).unwrap();
        fs::write(directory.join(STORE_FILE), "external change").unwrap();

        assert!(store.save(draft(&directory, "Review agent")).is_err());
        assert!(store.snapshot().plans.is_empty());
    }
    #[test]
    fn project_grant_persists_and_external_changes_do_not_overwrite_or_enable_it() {
        let directory = temp_dir("project-grant");
        let mut store = FileAgentPlanStore::open(&directory).unwrap();
        let policy = ProjectLaunchPolicy {
            enabled: true,
            roots: vec![directory.display().to_string()],
            full_permissions: true,
        };
        store.update_project_launch(policy.clone()).unwrap();
        assert_eq!(
            FileAgentPlanStore::open(&directory)
                .unwrap()
                .snapshot()
                .mcp_project_launch,
            policy
        );
        let mut external = FileAgentPlanStore::open(&directory).unwrap();
        store
            .update_project_launch(ProjectLaunchPolicy::default())
            .unwrap();
        let before = fs::read(directory.join(STORE_FILE)).unwrap();
        assert!(external.update_project_launch(policy).is_err());
        assert_eq!(fs::read(directory.join(STORE_FILE)).unwrap(), before);
        assert!(
            !FileAgentPlanStore::open(&directory)
                .unwrap()
                .snapshot()
                .mcp_project_launch
                .enabled
        );
    }
    #[cfg(unix)]
    #[test]
    fn project_grant_store_rejects_symlinks_without_touching_the_target() {
        let directory = temp_dir("project-grant-link");
        let outside = tempfile::NamedTempFile::new().unwrap();
        fs::write(outside.path(), "preserve").unwrap();
        std::os::unix::fs::symlink(outside.path(), directory.join(STORE_FILE)).unwrap();
        assert!(FileAgentPlanStore::open(&directory).is_err());
        assert_eq!(fs::read_to_string(outside.path()).unwrap(), "preserve");
    }
}
