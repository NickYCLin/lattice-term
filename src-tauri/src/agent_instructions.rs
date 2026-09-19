//! The instruction files a chat CLI reads on its own, shown read-only so the
//! user can see what shapes a conversation before asking why it behaves the
//! way it does.
//!
//! Only the fixed, documented file names of each CLI are looked at: the
//! user-wide file in the CLI's config directory (or the account profile's)
//! and the project files in the conversation's working folder. Nothing is
//! written, nothing outside those names is read, and each file is capped.

use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_SHOWN_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InstructionScope {
    User,
    Project,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionFile {
    pub scope: InstructionScope,
    pub path: String,
    pub exists: bool,
    /// The file's size on disk, even when only the start is shown.
    pub bytes: u64,
    pub content: String,
    pub truncated: bool,
}

/// `(scope, path)` pairs in the order the CLI documents loading them.
fn candidates(
    definition_id: &str,
    working_directory: Option<&Path>,
    config_directory: Option<&Path>,
    home: Option<&Path>,
    env: &dyn Fn(&str) -> Option<PathBuf>,
) -> Result<Vec<(InstructionScope, PathBuf)>, String> {
    let user_dir = |variable: &str, default: &str| {
        config_directory
            .map(Path::to_path_buf)
            .or_else(|| env(variable))
            .or_else(|| home.map(|home| home.join(default)))
    };
    let (user, project): (Vec<PathBuf>, Vec<&str>) = match definition_id {
        "claude" => (
            user_dir("CLAUDE_CONFIG_DIR", ".claude")
                .map(|dir| vec![dir.join("CLAUDE.md")])
                .unwrap_or_default(),
            vec!["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"],
        ),
        "codex" => (
            user_dir("CODEX_HOME", ".codex")
                .map(|dir| vec![dir.join("AGENTS.override.md"), dir.join("AGENTS.md")])
                .unwrap_or_default(),
            vec!["AGENTS.override.md", "AGENTS.md"],
        ),
        "gemini" => (
            home.map(|home| vec![home.join(".gemini").join("GEMINI.md")])
                .unwrap_or_default(),
            vec!["GEMINI.md"],
        ),
        other => return Err(format!("No instruction files are known for {other}.")),
    };
    let mut files: Vec<_> = user
        .into_iter()
        .map(|path| (InstructionScope::User, path))
        .collect();
    if let Some(directory) = working_directory {
        files.extend(
            project
                .into_iter()
                .map(|name| (InstructionScope::Project, directory.join(name))),
        );
    }
    Ok(files)
}

fn read_bounded(path: &Path) -> (bool, u64, String, bool) {
    let Ok(metadata) = std::fs::metadata(path) else {
        return (false, 0, String::new(), false);
    };
    if !metadata.is_file() {
        return (false, 0, String::new(), false);
    }
    let bytes = metadata.len();
    let mut buffer = Vec::new();
    let read = std::fs::File::open(path)
        .and_then(|file| file.take(MAX_SHOWN_BYTES).read_to_end(&mut buffer));
    if read.is_err() {
        return (true, bytes, String::new(), false);
    }
    let truncated = bytes > MAX_SHOWN_BYTES;
    (
        true,
        bytes,
        String::from_utf8_lossy(&buffer).into_owned(),
        truncated,
    )
}

pub fn inspect(
    definition_id: &str,
    working_directory: Option<&str>,
    config_directory: Option<&str>,
) -> Result<Vec<InstructionFile>, String> {
    let working_directory = working_directory
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    if working_directory
        .as_deref()
        .is_some_and(|directory| !directory.is_absolute())
    {
        return Err("The working folder must be an absolute path.".to_string());
    }
    let config_directory = config_directory
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    if config_directory
        .as_deref()
        .is_some_and(|directory| !directory.is_absolute())
    {
        return Err("The account folder must be an absolute path.".to_string());
    }
    let home = dirs::home_dir();
    let env = |name: &str| std::env::var_os(name).map(PathBuf::from);
    Ok(candidates(
        definition_id,
        working_directory.as_deref(),
        config_directory.as_deref(),
        home.as_deref(),
        &env,
    )?
    .into_iter()
    .map(|(scope, path)| {
        let (exists, bytes, content, truncated) = read_bounded(&path);
        InstructionFile {
            scope,
            path: path.display().to_string(),
            exists,
            bytes,
            content,
            truncated,
        }
    })
    .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_env(_: &str) -> Option<PathBuf> {
        None
    }

    #[test]
    fn each_cli_lists_its_documented_files() {
        let home = Path::new("/home/me");
        let work = Path::new("/work");
        let claude = candidates("claude", Some(work), None, Some(home), &no_env).unwrap();
        assert_eq!(
            claude,
            vec![
                (
                    InstructionScope::User,
                    PathBuf::from("/home/me/.claude/CLAUDE.md")
                ),
                (InstructionScope::Project, PathBuf::from("/work/CLAUDE.md")),
                (
                    InstructionScope::Project,
                    PathBuf::from("/work/.claude/CLAUDE.md")
                ),
                (
                    InstructionScope::Project,
                    PathBuf::from("/work/CLAUDE.local.md")
                ),
            ]
        );
        let codex_env = |name: &str| (name == "CODEX_HOME").then(|| PathBuf::from("/opt/codex"));
        let codex = candidates("codex", None, None, Some(home), &codex_env).unwrap();
        assert_eq!(
            codex[1],
            (
                InstructionScope::User,
                PathBuf::from("/opt/codex/AGENTS.md")
            )
        );
        assert_eq!(codex.len(), 2, "no project files without a folder");
        assert!(candidates("other", Some(work), None, Some(home), &no_env).is_err());
    }

    #[test]
    fn an_account_profile_replaces_the_default_config_folder() {
        let files = candidates(
            "claude",
            None,
            Some(Path::new("/profiles/work")),
            Some(Path::new("/home/me")),
            &no_env,
        )
        .unwrap();
        assert_eq!(files[0].1, PathBuf::from("/profiles/work/CLAUDE.md"));
    }

    #[test]
    fn contents_are_read_bounded_and_missing_files_are_reported() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("AGENTS.md"), "# Rules\n").unwrap();
        std::fs::write(
            dir.path().join("AGENTS.override.md"),
            "x".repeat(MAX_SHOWN_BYTES as usize + 10),
        )
        .unwrap();
        let files = inspect(
            "codex",
            Some(dir.path().to_str().unwrap()),
            Some(dir.path().join("none").to_str().unwrap()),
        )
        .unwrap();
        let project: Vec<_> = files
            .iter()
            .filter(|file| file.scope == InstructionScope::Project)
            .collect();
        assert!(project[0].exists && project[0].truncated);
        assert_eq!(project[0].content.len() as u64, MAX_SHOWN_BYTES);
        assert_eq!(project[1].content, "# Rules\n");
        assert!(!files[0].exists);
        assert!(inspect("codex", Some("relative/dir"), None).is_err());
    }
}
