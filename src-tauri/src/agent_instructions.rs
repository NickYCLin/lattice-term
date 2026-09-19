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
    /// Claude Code's own memory notes for this project, read-only here.
    Memory,
}

const MAX_MEMORY_FILES: usize = 30;

/// Claude Code names a project's folder by replacing every character that
/// is not an ASCII letter or digit in its path with `-`.
fn claude_project_slug(directory: &Path) -> String {
    directory
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn claude_memory_files(user_directory: &Path, working_directory: &Path) -> Vec<PathBuf> {
    let memory = user_directory
        .join("projects")
        .join(claude_project_slug(working_directory))
        .join("memory");
    let Ok(entries) = std::fs::read_dir(&memory) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension().is_some_and(|ext| ext == "md")
                && std::fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file())
        })
        .collect();
    files.sort();
    // The index first, the notes after it.
    files.sort_by_key(|path| path.file_name().is_none_or(|name| name != "MEMORY.md"));
    files.truncate(MAX_MEMORY_FILES);
    files
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
    /// Fingerprint of the whole file (or "missing"); a save must name it.
    pub revision: String,
    /// Whether the window may edit this file here: user-level files only,
    /// and only when all of it was shown.
    pub editable: bool,
}

fn revision_of(path: &Path) -> String {
    use sha2::{Digest, Sha256};
    match std::fs::read(path) {
        Ok(bytes) => Sha256::digest(&bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
        Err(_) => "missing".to_string(),
    }
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
        if definition_id == "claude" {
            if let Some(user) = user_dir("CLAUDE_CONFIG_DIR", ".claude") {
                files.extend(
                    claude_memory_files(&user, directory)
                        .into_iter()
                        .map(|path| (InstructionScope::Memory, path)),
                );
            }
        }
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
            revision: revision_of(&path),
            editable: scope == InstructionScope::User && !truncated,
            path: path.display().to_string(),
            exists,
            bytes,
            content,
            truncated,
        }
    })
    .collect())
}

const MAX_SAVED_BYTES: usize = 64 * 1024;

/// Saves one user-level instruction file the window showed. The path must
/// be one this CLI reads at user level, and the file must still be what
/// was shown; the new text replaces it atomically, keeping its permissions.
pub fn save(
    definition_id: &str,
    config_directory: Option<&str>,
    path: &str,
    content: &str,
    expected_revision: &str,
) -> Result<(), String> {
    if content.len() > MAX_SAVED_BYTES {
        return Err("Instructions are limited to 64 KiB here.".to_string());
    }
    let allowed = inspect(definition_id, None, config_directory)?
        .into_iter()
        .find(|file| file.scope == InstructionScope::User && file.path == path)
        .ok_or_else(|| {
            "Only this assistant's own user instruction files can be edited here.".to_string()
        })?;
    if !allowed.editable {
        return Err("This file is too large to edit here safely.".to_string());
    }
    let target = PathBuf::from(&allowed.path);
    if revision_of(&target) != expected_revision {
        return Err("The file changed outside LatticeTerm. Reload it before saving.".to_string());
    }
    if let Ok(metadata) = std::fs::symlink_metadata(&target) {
        if !metadata.is_file() {
            return Err("The instruction file is not a regular file.".to_string());
        }
    }
    let parent = target
        .parent()
        .ok_or_else(|| "The instruction file has no folder.".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    {
        use std::io::Write;
        let normalized = content.replace("\r\n", "\n");
        temporary
            .write_all(normalized.as_bytes())
            .and_then(|()| temporary.as_file().sync_all())
            .map_err(|error| error.to_string())?;
    }
    if let Ok(metadata) = std::fs::metadata(&target) {
        let _ = std::fs::set_permissions(temporary.path(), metadata.permissions());
    }
    temporary
        .persist(&target)
        .map_err(|error| format!("Cannot save the instructions: {}", error.error))?;
    Ok(())
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

    #[test]
    fn user_instructions_save_only_where_they_were_read_and_unchanged() {
        let profile = tempfile::tempdir().unwrap();
        let root = profile.path().to_str().unwrap();
        let listed = inspect("claude", None, Some(root)).unwrap();
        let user = listed
            .iter()
            .find(|f| f.scope == InstructionScope::User)
            .unwrap();
        assert!(user.editable && !user.exists);
        save("claude", Some(root), &user.path, "# Mine\n", &user.revision).unwrap();
        assert_eq!(std::fs::read_to_string(&user.path).unwrap(), "# Mine\n");
        // The old revision no longer matches: a stale window cannot overwrite.
        assert!(save("claude", Some(root), &user.path, "# Old\n", &user.revision).is_err());
        // Paths outside what this CLI reads are refused.
        let elsewhere = profile.path().join("other.md");
        assert!(save(
            "claude",
            Some(root),
            elsewhere.to_str().unwrap(),
            "x",
            "missing"
        )
        .is_err());
    }

    #[test]
    fn claude_memory_notes_are_listed_read_only() {
        let config = tempfile::tempdir().unwrap();
        let work = Path::new("/data/me/My Project");
        let memory = config
            .path()
            .join("projects")
            .join("-data-me-My-Project")
            .join("memory");
        std::fs::create_dir_all(&memory).unwrap();
        std::fs::write(memory.join("b-note.md"), "note").unwrap();
        std::fs::write(memory.join("MEMORY.md"), "- index").unwrap();
        std::fs::write(memory.join("skip.txt"), "x").unwrap();
        let files = candidates("claude", Some(work), Some(config.path()), None, &no_env).unwrap();
        let notes: Vec<_> = files
            .iter()
            .filter(|(scope, _)| *scope == InstructionScope::Memory)
            .map(|(_, path)| path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(notes, ["MEMORY.md", "b-note.md"]);
        assert_eq!(claude_project_slug(work), "-data-me-My-Project");
    }
}
