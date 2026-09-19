//! The working-tree view behind a conversation: what changed, the diff of
//! one file, staging, and a commit.
//!
//! Everything runs the user's own `git` with explicit arguments and no
//! shell. Paths come back from `git status` and are checked again before
//! they reach another command: relative, inside the repository, never an
//! option. Nothing here pushes, rewrites history or touches a remote.

use serde::Serialize;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output, Stdio};

const MAX_DIFF_BYTES: usize = 512 * 1024;
const MAX_FILES: usize = 2000;
const MAX_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_PATHS: usize = 500;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    /// Porcelain status letters: index (staged) and work tree.
    pub staged: String,
    pub unstaged: String,
    pub original_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub root: String,
    pub branch: Option<String>,
    pub files: Vec<ChangedFile>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiff {
    pub text: String,
    pub truncated: bool,
}

fn git(directory: &Path) -> Command {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(directory)
        // Read-only views must not run a repository's fsmonitor hook or
        // leave lock files behind; colour codes would only be noise.
        .args(["-c", "core.fsmonitor=false", "-c", "color.ui=false"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
}

fn run(mut command: Command) -> Result<Output, String> {
    command
        .output()
        .map_err(|error| format!("Cannot run git: {error}"))
}

fn failure(output: &Output) -> String {
    let text = String::from_utf8_lossy(&output.stderr);
    let text = text.trim();
    if text.is_empty() {
        "git reported an error.".to_string()
    } else {
        text.chars().take(2000).collect()
    }
}

/// The repository root for a conversation folder.
fn repository_root(directory: &str) -> Result<PathBuf, String> {
    let directory = Path::new(directory.trim());
    if !directory.is_absolute() || !directory.is_dir() {
        return Err("The working folder is not an existing absolute folder.".to_string());
    }
    let mut command = git(directory);
    command.args(["rev-parse", "--show-toplevel"]);
    let output = run(command)?;
    if !output.status.success() {
        return Err("This folder is not inside a git repository.".to_string());
    }
    let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if root.is_empty() {
        return Err("This folder is not inside a git repository.".to_string());
    }
    Ok(PathBuf::from(root))
}

/// A path as git status printed it, safe to hand back to git.
fn checked_path(path: &str) -> Result<&str, String> {
    let bad = path.is_empty()
        || path.starts_with('-')
        || path.starts_with('\\')
        || path.contains('\0')
        || Path::new(path).is_absolute()
        || Path::new(path)
            .components()
            // On Windows `\\x` or `/x` is not "absolute" (no drive) but still
            // starts at the drive root, outside the repository.
            .any(|part| {
                matches!(
                    part,
                    Component::ParentDir | Component::Prefix(_) | Component::RootDir
                )
            });
    if bad {
        Err(format!("Refusing an unexpected path: {path}"))
    } else {
        Ok(path)
    }
}

fn parse_status(raw: &[u8]) -> (Option<String>, Vec<ChangedFile>, bool) {
    let mut branch = None;
    let mut files = Vec::new();
    let mut truncated = false;
    let mut entries = raw.split(|byte| *byte == 0).peekable();
    while let Some(entry) = entries.next() {
        if entry.is_empty() {
            continue;
        }
        let entry = String::from_utf8_lossy(entry);
        if let Some(head) = entry.strip_prefix("## ") {
            let name = head.split("...").next().unwrap_or(head);
            let name = name.strip_prefix("No commits yet on ").unwrap_or(name);
            branch = Some(name.to_string());
            continue;
        }
        if entry.len() < 4 {
            continue;
        }
        let (codes, path) = entry.split_at(3);
        let mut chars = codes.chars();
        let staged = chars.next().unwrap_or(' ');
        let unstaged = chars.next().unwrap_or(' ');
        // A rename or copy is followed by its original path as its own entry.
        let original_path = if matches!(staged, 'R' | 'C') {
            entries
                .next()
                .map(|original| String::from_utf8_lossy(original).into_owned())
        } else {
            None
        };
        if files.len() >= MAX_FILES {
            truncated = true;
            continue;
        }
        files.push(ChangedFile {
            path: path.to_string(),
            staged: staged.to_string().trim().to_string(),
            unstaged: unstaged.to_string().trim().to_string(),
            original_path,
        });
    }
    (branch, files, truncated)
}

pub fn status(directory: &str) -> Result<GitStatus, String> {
    let root = repository_root(directory)?;
    let mut command = git(&root);
    command.args([
        "status",
        "--porcelain=v1",
        "-z",
        "--branch",
        "--untracked-files=all",
    ]);
    let output = run(command)?;
    if !output.status.success() {
        return Err(failure(&output));
    }
    let (branch, files, truncated) = parse_status(&output.stdout);
    Ok(GitStatus {
        root: root.display().to_string(),
        branch,
        files,
        truncated,
    })
}

fn bounded(bytes: &[u8]) -> GitDiff {
    let truncated = bytes.len() > MAX_DIFF_BYTES;
    let mut end = bytes.len().min(MAX_DIFF_BYTES);
    while end > 0 && end < bytes.len() && (bytes[end] & 0b1100_0000) == 0b1000_0000 {
        end -= 1;
    }
    GitDiff {
        text: String::from_utf8_lossy(&bytes[..end]).into_owned(),
        truncated,
    }
}

/// One file's diff: staged against HEAD, or the work tree against the index.
/// An untracked file is shown whole, as an addition.
pub fn diff(directory: &str, path: &str, staged: bool) -> Result<GitDiff, String> {
    let root = repository_root(directory)?;
    let path = checked_path(path)?;
    let untracked = {
        let mut command = git(&root);
        command.args(["ls-files", "--error-unmatch", "--", path]);
        !run(command)?.status.success()
    };
    let mut command = git(&root);
    command.args(["diff", "--no-ext-diff", "--no-textconv"]);
    if untracked && !staged {
        // git treats this name as the empty side on every platform.
        command.args(["--no-index", "--", "/dev/null", path]);
    } else {
        if staged {
            command.arg("--cached");
        }
        command.args(["--", path]);
    }
    let output = run(command)?;
    // `--no-index` exits 1 whenever the files differ, which they always do.
    if !(output.status.success() || untracked && output.status.code() == Some(1)) {
        return Err(failure(&output));
    }
    Ok(bounded(&output.stdout))
}

fn checked_paths(paths: &[String]) -> Result<Vec<&str>, String> {
    if paths.is_empty() || paths.len() > MAX_PATHS {
        return Err("Choose between 1 and 500 files.".to_string());
    }
    paths.iter().map(|path| checked_path(path)).collect()
}

pub fn stage(directory: &str, paths: &[String]) -> Result<(), String> {
    let root = repository_root(directory)?;
    let paths = checked_paths(paths)?;
    let mut command = git(&root);
    command.args(["add", "--"]).args(&paths);
    let output = run(command)?;
    output
        .status
        .success()
        .then_some(())
        .ok_or_else(|| failure(&output))
}

pub fn unstage(directory: &str, paths: &[String]) -> Result<(), String> {
    let root = repository_root(directory)?;
    let paths = checked_paths(paths)?;
    let mut command = git(&root);
    command.args(["restore", "--staged", "--"]).args(&paths);
    let output = run(command)?;
    output
        .status
        .success()
        .then_some(())
        .ok_or_else(|| failure(&output))
}

/// Commits what is staged, with the message on stdin so it never becomes an
/// argument. The repository's own hooks and signing settings still apply.
pub fn commit(directory: &str, message: &str) -> Result<String, String> {
    let root = repository_root(directory)?;
    let message = message.replace("\r\n", "\n");
    if message.trim().is_empty() {
        return Err("Write a commit message first.".to_string());
    }
    if message.len() > MAX_MESSAGE_BYTES {
        return Err("The commit message is too long.".to_string());
    }
    let mut command = git(&root);
    command
        .args(["commit", "--file=-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("Cannot run git: {error}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(message.as_bytes())
            .map_err(|error| format!("Cannot pass the message to git: {error}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("Cannot run git: {error}"))?;
    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        if stdout.contains("nothing to commit") || stdout.contains("no changes added") {
            return Err("Nothing is staged to commit.".to_string());
        }
        return Err(failure(&output));
    }
    let mut command = git(&root);
    command.args(["rev-parse", "--short", "HEAD"]);
    let output = run(command)?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        let init = |args: &[&str]| {
            let status = Command::new("git")
                .arg("-C")
                .arg(path)
                .args(args)
                .status()
                .unwrap();
            assert!(status.success(), "{args:?}");
        };
        init(&["init", "-q", "-b", "main"]);
        init(&["config", "user.email", "test@example.com"]);
        init(&["config", "user.name", "Test"]);
        init(&["config", "commit.gpgsign", "false"]);
        std::fs::write(path.join("kept.txt"), "one\n").unwrap();
        init(&["add", "kept.txt"]);
        init(&["commit", "-q", "-m", "start"]);
        dir
    }

    #[test]
    fn status_diff_stage_and_commit_follow_the_work_tree() {
        let dir = repo();
        let root = dir.path().to_str().unwrap();
        std::fs::write(dir.path().join("kept.txt"), "one\ntwo\n").unwrap();
        std::fs::write(dir.path().join("new file.txt"), "fresh\n").unwrap();

        let status = status(root).unwrap();
        assert_eq!(status.branch.as_deref(), Some("main"));
        let paths: Vec<_> = status
            .files
            .iter()
            .map(|file| (file.path.as_str(), file.unstaged.as_str()))
            .collect();
        assert!(paths.contains(&("kept.txt", "M")));
        assert!(paths.contains(&("new file.txt", "?")));

        assert!(diff(root, "kept.txt", false).unwrap().text.contains("+two"));
        assert!(diff(root, "new file.txt", false)
            .unwrap()
            .text
            .contains("+fresh"));

        stage(root, &["kept.txt".to_string()]).unwrap();
        assert!(diff(root, "kept.txt", true).unwrap().text.contains("+two"));
        unstage(root, &["kept.txt".to_string()]).unwrap();
        assert!(diff(root, "kept.txt", true).unwrap().text.is_empty());

        assert!(commit(root, "nothing staged").is_err());
        stage(root, &["kept.txt".to_string(), "new file.txt".to_string()]).unwrap();
        let hash = commit(root, "feat: 加上第二行\n\n說明").unwrap();
        assert!(!hash.is_empty());
        assert!(super::status(root).unwrap().files.is_empty());
    }

    #[test]
    fn unsafe_paths_and_folders_are_refused() {
        let dir = repo();
        let root = dir.path().to_str().unwrap();
        for bad in [
            "--output=/tmp/x",
            "../outside",
            "/etc/passwd",
            "\\Windows\\win.ini",
            "",
        ] {
            assert!(stage(root, &[bad.to_string()]).is_err(), "{bad}");
            assert!(diff(root, bad, false).is_err(), "{bad}");
        }
        assert!(status("relative/folder").is_err());
        let plain = tempfile::tempdir().unwrap();
        assert!(status(plain.path().to_str().unwrap()).is_err());
    }

    #[test]
    fn renames_keep_their_original_path() {
        let raw = b"## main...origin/main [ahead 1]\0R  new.txt\0old.txt\0 M other.txt\0";
        let (branch, files, _) = parse_status(raw);
        assert_eq!(branch.as_deref(), Some("main"));
        assert_eq!(files[0].path, "new.txt");
        assert_eq!(files[0].original_path.as_deref(), Some("old.txt"));
        assert_eq!(files[1].unstaged, "M");
    }
}
