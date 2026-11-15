//! The working-tree view behind a conversation: what changed, the diff of
//! one file, staging, and a commit.
//!
//! Everything runs the user's own `git` with explicit arguments and no
//! shell. Paths come back from `git status` and are checked again before
//! they reach another command: relative, inside the repository, never an
//! option. Publishing explicitly pulls before a normal push; history is never rewritten.

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
        .arg("--literal-pathspecs")
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

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PatchAction {
    Stage,
    Unstage,
    Restore,
}

/// Apply a server-derived patch only when the displayed diff is still current.
/// Restoration keeps a recovery patch in git's private metadata directory.
pub fn patch(
    directory: &str,
    path: &str,
    staged: bool,
    expected: &str,
    hunk: Option<usize>,
    action: PatchAction,
) -> Result<String, String> {
    let root = repository_root(directory)?;
    checked_path(path)?;
    let current = diff(directory, path, staged)?;
    if current.truncated || current.text != expected || expected.is_empty() {
        return Err("變更已更新，請重新讀取後再操作。".into());
    }
    if matches!(action, PatchAction::Unstage) != staged
        || matches!(action, PatchAction::Restore) && staged
    {
        return Err("請在正確的暫存區操作。".into());
    }
    // Renames, binary files and untracked files require a file-level workflow.
    if expected.contains("rename from ")
        || expected.contains("GIT binary patch")
        || expected.contains("Binary files ")
        || expected.contains("new file mode ")
        || expected.contains("deleted file mode ")
    {
        return Err("這個檔案需要先使用 Git 處理新增、刪除或二進位變更。".into());
    }
    let lines: Vec<&str> = expected.split_inclusive('\n').collect();
    let starts: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, line)| line.starts_with("@@ "))
        .map(|(i, _)| i)
        .collect();
    if starts.is_empty() {
        return Err("沒有可操作的文字區段。".into());
    }
    let patch = if let Some(index) = hunk {
        let start = *starts.get(index).ok_or("這個區段不存在。")?;
        let end = starts.get(index + 1).copied().unwrap_or(lines.len());
        lines[..starts[0]]
            .iter()
            .chain(lines[start..end].iter())
            .copied()
            .collect::<String>()
    } else {
        expected.to_string()
    };
    let mut recovery = String::new();
    if matches!(action, PatchAction::Restore) {
        let mut command = git(&root);
        command.args(["rev-parse", "--absolute-git-dir"]);
        let output = run(command)?;
        if !output.status.success() {
            return Err(failure(&output));
        }
        let metadata = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
        let mut file = tempfile::Builder::new()
            .prefix("latticeterm-recovery-")
            .suffix(".patch")
            .tempfile_in(metadata)
            .map_err(|e| e.to_string())?;
        file.write_all(patch.as_bytes())
            .and_then(|_| file.as_file().sync_all())
            .map_err(|e| e.to_string())?;
        let (_, backup) = file.keep().map_err(|e| e.to_string())?;
        recovery = backup.display().to_string();
    }
    let mut command = git(&root);
    command.args(["apply", "--whitespace=nowarn"]);
    if matches!(action, PatchAction::Stage | PatchAction::Unstage) {
        command.arg("--cached");
    }
    if matches!(action, PatchAction::Unstage | PatchAction::Restore) {
        command.arg("--reverse");
    }
    command
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    child
        .stdin
        .take()
        .ok_or("Git stdin unavailable")?
        .write_all(patch.as_bytes())
        .map_err(|e| e.to_string())?;
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "{}{}",
            failure(&output),
            if recovery.is_empty() {
                String::new()
            } else {
                format!("\n復原 patch：{recovery}")
            }
        ));
    }
    Ok(recovery)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchView {
    pub name: String,
    pub revision: String,
}
pub fn branches(directory: &str) -> Result<Vec<BranchView>, String> {
    let root = repository_root(directory)?;
    let mut command = git(&root);
    command.args([
        "for-each-ref",
        "--format=%(refname:short)%09%(objectname)",
        "refs/heads/",
        "refs/remotes/",
    ]);
    let output = run(command)?;
    if !output.status.success() {
        return Err(failure(&output));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .take(1000)
        .filter_map(|line| {
            line.split_once('\t').map(|(name, revision)| BranchView {
                name: name.into(),
                revision: revision.into(),
            })
        })
        .collect())
}
fn checked_revision(value: &str) -> Result<&str, String> {
    if (value.len() == 40 || value.len() == 64) && value.bytes().all(|c| c.is_ascii_hexdigit()) {
        Ok(value)
    } else {
        Err("請重新選取分支版本。".into())
    }
}
pub fn comparison(directory: &str, revision: &str, path: Option<&str>) -> Result<GitDiff, String> {
    let root = repository_root(directory)?;
    let mut command = git(&root);
    command.args([
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        checked_revision(revision)?,
        "--",
    ]);
    if let Some(path) = path {
        command.arg(checked_path(path)?);
    }
    let output = run(command)?;
    if !output.status.success() {
        return Err(failure(&output));
    }
    Ok(bounded(&output.stdout))
}
/// Snapshot the work tree through an isolated index, without changing the user's index.
pub fn checkpoint(directory: &str) -> Result<String, String> {
    let root = repository_root(directory)?;
    if status(directory)?.truncated {
        return Err("工作目錄太大，未建立上一輪快照。".into());
    }
    let temporary = tempfile::tempdir().map_err(|e| e.to_string())?;
    let index = temporary.path().join("index");
    for args in [
        ["read-tree", "HEAD"].as_slice(),
        ["add", "-A", "--", "."].as_slice(),
    ] {
        let mut command = git(&root);
        command.env("GIT_INDEX_FILE", &index).args(args);
        let output = run(command)?;
        if !output.status.success() {
            return Err(failure(&output));
        }
    }
    let mut command = git(&root);
    command.env("GIT_INDEX_FILE", &index).arg("write-tree");
    let output = run(command)?;
    if !output.status.success() {
        return Err(failure(&output));
    }
    let revision = String::from_utf8_lossy(&output.stdout).trim().to_string();
    checked_revision(&revision)?;
    let mut command = git(&root);
    command.args([
        "update-ref",
        &format!("refs/latticeterm/checkpoints/{revision}"),
        &revision,
    ]);
    let output = run(command)?;
    if !output.status.success() {
        return Err(failure(&output));
    }
    Ok(revision)
}

/// Pull must succeed before every push. No force and no implicit branch switch.
pub fn publish(directory: &str, open_pr: bool) -> Result<String, String> {
    let root = repository_root(directory)?;
    let status = status(directory)?;
    if !status.files.is_empty() || status.truncated {
        return Err("請先提交或保存工作目錄的變更。".into());
    }
    let mut command = git(&root);
    command.args(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    let output = run(command)?;
    if !output.status.success() {
        return Err("請先建立或切換到本機分支。".into());
    }
    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let mut command = git(&root);
    command.args([
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{upstream}",
    ]);
    let has_upstream = run(command)?.status.success();
    if has_upstream {
        let mut command = git(&root);
        command.args(["pull", "--ff-only"]);
        let output = run(command)?;
        if !output.status.success() {
            return Err(failure(&output));
        }
    } else {
        let mut command = git(&root);
        command.args(["fetch", "origin"]);
        let output = run(command)?;
        if !output.status.success() {
            return Err(failure(&output));
        }
        let remote_branch = format!("refs/remotes/origin/{branch}");
        let mut command = git(&root);
        command.args(["show-ref", "--verify", &remote_branch]);
        let pull_branch = if run(command)?.status.success() {
            branch.clone()
        } else {
            let mut command = git(&root);
            command.args(["ls-remote", "--symref", "origin", "HEAD"]);
            let output = run(command)?;
            if !output.status.success() {
                return Err(failure(&output));
            }
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .find_map(|line| {
                    line.strip_prefix("ref: refs/heads/")
                        .and_then(|line| line.strip_suffix("\tHEAD"))
                })
                .ok_or("遠端未提供預設分支，請先設定 upstream。")?
                .to_string()
        };
        let mut command = git(&root);
        command.args(["pull", "--ff-only", "origin", &pull_branch]);
        let output = run(command)?;
        if !output.status.success() {
            return Err(failure(&output));
        }
    }
    let mut command = git(&root);
    if has_upstream {
        command.arg("push");
    } else {
        command.args(["push", "--set-upstream", "origin", &branch]);
    }
    let output = run(command)?;
    if !output.status.success() {
        return Err(failure(&output));
    }
    if !open_pr {
        return Ok("已同步並推送目前分支。".into());
    }
    // gh uses existing credentials; it neither receives tokens nor guesses a PR body.
    let output = Command::new("gh")
        .current_dir(&root)
        .args(["pr", "create", "--fill"])
        .env("GH_PROMPT_DISABLED", "1")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!("已推送，但建立 PR 失敗：{}", failure(&output)));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().into())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    pub branch: Option<String>,
    pub current: bool,
}
pub fn worktrees(directory: &str) -> Result<Vec<Worktree>, String> {
    let root = repository_root(directory)?;
    let mut command = git(&root);
    command.args(["worktree", "list", "--porcelain", "-z"]);
    let output = run(command)?;
    if !output.status.success() {
        return Err(failure(&output));
    }
    let mut trees: Vec<Worktree> = Vec::new();
    for entry in output.stdout.split(|c| *c == 0) {
        let entry = String::from_utf8_lossy(entry);
        if let Some(path) = entry.strip_prefix("worktree ") {
            trees.push(Worktree {
                current: Path::new(path) == root,
                path: path.into(),
                branch: None,
            });
        }
        if let Some(branch) = entry.strip_prefix("branch ") {
            if let Some(last) = trees.last_mut() {
                last.branch = Some(branch.trim_start_matches("refs/heads/").into());
            }
        }
    }
    Ok(trees)
}
pub fn create_worktree(directory: &str, destination: &str, branch: &str) -> Result<String, String> {
    let root = repository_root(directory)?;
    let destination = Path::new(destination);
    if !destination.is_absolute()
        || destination.exists()
        || destination
            .components()
            .any(|c| matches!(c, Component::ParentDir))
        || destination.file_name().is_none()
    {
        return Err("請選擇尚不存在的絕對路徑。".into());
    }
    let parent = destination
        .parent()
        .ok_or("缺少上層資料夾。")?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if parent.starts_with(&root) {
        return Err("Worktree 請放在原專案外，避免互相讀取。".into());
    }
    if branch.is_empty()
        || branch.len() > 200
        || branch.starts_with('-')
        || branch.chars().any(char::is_control)
    {
        return Err("分支名稱無效。".into());
    }
    let mut command = git(&root);
    command.args(["check-ref-format", "--branch", branch]);
    let output = run(command)?;
    if !output.status.success() {
        return Err(failure(&output));
    }
    let destination = parent.join(destination.file_name().unwrap());
    let mut command = git(&root);
    command
        .args(["worktree", "add", "-b", branch, "--"])
        .arg(&destination)
        .arg("HEAD");
    let output = run(command)?;
    if !output.status.success() {
        return Err(failure(&output));
    }
    Ok(destination.display().to_string())
}
pub fn remove_worktree(directory: &str, destination: &str) -> Result<(), String> {
    let root = repository_root(directory)?;
    let path = Path::new(destination)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let trees = worktrees(directory)?;
    // First listed worktree is the main checkout and must never be removed.
    if path == root
        || trees
            .first()
            .is_some_and(|tree| Path::new(&tree.path) == path)
        || !trees.iter().any(|tree| Path::new(&tree.path) == path)
    {
        return Err("只能移除同一儲存庫的其他 worktree。".into());
    }
    let status = status(path.to_str().ok_or("Worktree 路徑無效。")?)?;
    if !status.files.is_empty() || status.truncated {
        return Err("Worktree 還有未提交變更，已保留。".into());
    }
    let mut command = git(&root);
    command.args(["worktree", "remove", "--"]).arg(path);
    let output = run(command)?;
    if !output.status.success() {
        return Err(failure(&output));
    }
    Ok(())
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
    #[test]
    fn patch_rejects_stale_content_and_restores_with_recovery() {
        let directory = repo();
        let root = directory.path().to_str().unwrap();
        std::fs::write(directory.path().join("kept.txt"), "changed\n").unwrap();
        let shown = diff(root, "kept.txt", false).unwrap();
        std::fs::write(directory.path().join("kept.txt"), "newer\n").unwrap();
        assert!(patch(
            root,
            "kept.txt",
            false,
            &shown.text,
            None,
            PatchAction::Restore
        )
        .is_err());
        assert_eq!(
            std::fs::read_to_string(directory.path().join("kept.txt")).unwrap(),
            "newer\n"
        );
        let current = diff(root, "kept.txt", false).unwrap();
        let backup = patch(
            root,
            "kept.txt",
            false,
            &current.text,
            None,
            PatchAction::Restore,
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(backup).unwrap(), current.text);
        assert_eq!(
            std::fs::read_to_string(directory.path().join("kept.txt")).unwrap(),
            "one\n"
        );
    }
    #[test]
    fn stages_one_hunk_and_checkpoint_does_not_change_index() {
        let directory = repo();
        let root = directory.path().to_str().unwrap();
        let original: String = (0..30).map(|i| format!("line {i}\n")).collect();
        std::fs::write(directory.path().join("kept.txt"), &original).unwrap();
        stage(root, &["kept.txt".into()]).unwrap();
        commit(root, "baseline").unwrap();
        std::fs::write(
            directory.path().join("kept.txt"),
            original
                .replace("line 1\n", "first\n")
                .replace("line 28\n", "last\n"),
        )
        .unwrap();
        let shown = diff(root, "kept.txt", false).unwrap();
        patch(
            root,
            "kept.txt",
            false,
            &shown.text,
            Some(0),
            PatchAction::Stage,
        )
        .unwrap();
        let staged = diff(root, "kept.txt", true).unwrap().text;
        assert!(staged.contains("+first"));
        assert!(!staged.contains("+last"));
        let snapshot = checkpoint(root).unwrap();
        assert_eq!(diff(root, "kept.txt", true).unwrap().text, staged);
        assert_eq!(comparison(root, &snapshot, None).unwrap().text, "");
        assert!(comparison(root, "HEAD; bad", None).is_err());
    }
    #[test]
    fn worktree_creation_preserves_existing_paths_and_refuses_dirty_removal() {
        let directory = repo();
        let root = directory.path().to_str().unwrap();
        let parent = tempfile::tempdir().unwrap();
        let target = parent.path().join("parallel");
        let path = create_worktree(root, target.to_str().unwrap(), "parallel-work").unwrap();
        assert!(worktrees(root)
            .unwrap()
            .iter()
            .any(|tree| tree.path == path));
        assert!(create_worktree(root, &path, "another").is_err());
        assert!(remove_worktree(root, root).is_err());
        std::fs::write(target.join("untracked.txt"), "keep").unwrap();
        assert!(remove_worktree(root, &path).is_err());
        assert!(target.join("untracked.txt").is_file());
        std::fs::remove_file(target.join("untracked.txt")).unwrap();
        remove_worktree(root, &path).unwrap();
        assert!(!target.exists());
        assert!(branches(root)
            .unwrap()
            .iter()
            .any(|branch| branch.name == "parallel-work"));
    }
    #[test]
    fn publishing_a_new_branch_pulls_the_actual_remote_default_before_setting_upstream() {
        let directory = repo();
        let root = directory.path().to_str().unwrap();
        let remote_parent = tempfile::tempdir().unwrap();
        let remote = remote_parent.path().join("remote.git");
        assert!(Command::new("git")
            .args(["init", "--bare", "-q", "-b", "main"])
            .arg(&remote)
            .status()
            .unwrap()
            .success());
        for args in [
            vec!["remote", "add", "origin", remote.to_str().unwrap()],
            vec!["push", "-u", "origin", "main"],
            vec!["switch", "-c", "new-work"],
        ] {
            let mut command = git(directory.path());
            command.args(args);
            assert!(run(command).unwrap().status.success());
        }
        std::fs::write(directory.path().join("kept.txt"), "updated\n").unwrap();
        stage(root, &["kept.txt".into()]).unwrap();
        commit(root, "work").unwrap();
        publish(root, false).unwrap();
        let mut command = git(directory.path());
        command.args(["rev-parse", "HEAD", "origin/new-work"]);
        let output = run(command).unwrap();
        let lines: Vec<_> = String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::to_string)
            .collect();
        assert_eq!(lines[0], lines[1]);
    }
}
