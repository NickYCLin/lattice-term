//! Bounded, metadata-only file suggestions scoped to the chosen project.
use serde::Serialize;
use std::collections::VecDeque;
use std::path::Path;

const MAX_VISITED: usize = 20_000;
const MAX_RESULTS: usize = 250;
const MAX_DEPTH: usize = 16;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub path: String,
    pub absolute_path: String,
}
#[derive(Debug, Serialize)]
pub struct ProjectFiles {
    pub files: Vec<ProjectFile>,
    pub truncated: bool,
}

pub fn search(directory: &str, query: &str) -> Result<ProjectFiles, String> {
    if query.len() > 256 || query.chars().any(char::is_control) {
        return Err("The file query is too long or contains control characters.".into());
    }
    let directory = Path::new(directory);
    if !directory.is_absolute() {
        return Err("Choose an absolute project directory before mentioning files.".into());
    }
    let root = directory
        .canonicalize()
        .map_err(|e| format!("Cannot open project: {e}"))?;
    if !root.is_dir() {
        return Err("The project path is not a directory.".into());
    }
    let query = query.replace('\\', "/").to_lowercase();
    let prefix = query.rsplit_once('/').map(|(parent, _)| parent);
    let mut queue = VecDeque::from([(root.clone(), 0usize)]);
    let mut files = Vec::new();
    let mut visited = 0;
    let mut truncated = false;
    'scan: while let Some((directory, depth)) = queue.pop_front() {
        let entries = match std::fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if directory == root => return Err(format!("Cannot list project: {error}")),
            Err(_) => {
                truncated = true;
                continue;
            }
        };
        for entry in entries {
            visited += 1;
            if visited > MAX_VISITED {
                truncated = true;
                break 'scan;
            }
            let Ok(entry) = entry else {
                truncated = true;
                continue;
            };
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            // Do not traverse symlinks or junctions into another project.
            if kind.is_symlink() {
                continue;
            }
            let Ok(relative) = path.strip_prefix(&root) else {
                continue;
            };
            let Some(relative) = relative.to_str() else {
                continue;
            };
            if relative.len() > 1024 || relative.chars().any(char::is_control) {
                continue;
            }
            let relative = relative.replace('\\', "/");
            let normalized = relative.to_lowercase();
            if kind.is_dir() {
                let name = entry.file_name();
                if matches!(
                    name.to_str(),
                    Some(
                        ".git"
                            | "node_modules"
                            | "target"
                            | "dist"
                            | ".cache"
                            | ".venv"
                            | "venv"
                            | "__pycache__"
                    )
                ) {
                    continue;
                }
                if let Some(prefix) = prefix {
                    if !format!("{normalized}/").starts_with(&format!("{prefix}/"))
                        && !format!("{prefix}/").starts_with(&format!("{normalized}/"))
                    {
                        continue;
                    }
                }
                if depth >= MAX_DEPTH {
                    truncated = true;
                    continue;
                }
                if let Ok(canonical) = path.canonicalize() {
                    if canonical.starts_with(&root) {
                        queue.push_back((canonical, depth + 1));
                    }
                }
            } else if kind.is_file() && normalized.contains(&query) {
                // Canonicalize every selected candidate as a second boundary
                // check; never return a path outside the project.
                let Ok(canonical) = path.canonicalize() else {
                    continue;
                };
                if !canonical.starts_with(&root) {
                    continue;
                }
                files.push(ProjectFile {
                    path: relative,
                    absolute_path: canonical.to_string_lossy().into_owned(),
                });
                if files.len() >= MAX_RESULTS {
                    truncated = true;
                    break 'scan;
                }
            }
        }
    }
    files.sort_by(|a, b| {
        a.path
            .to_lowercase()
            .cmp(&b.path.to_lowercase())
            .then(a.path.cmp(&b.path))
    });
    Ok(ProjectFiles { files, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn finds_scoped_files_without_reading_contents_or_scanning_build_outputs() {
        let root = tempfile::tempdir().unwrap();
        for directory in [
            "src/app",
            "node_modules/package",
            ".git/objects",
            "target/debug",
        ] {
            std::fs::create_dir_all(root.path().join(directory)).unwrap();
        }
        for name in [
            "src/app/main.ts",
            "src/app/a b.ts",
            "README.md",
            "node_modules/package/main.ts",
            ".git/objects/main.ts",
            "target/debug/main.ts",
        ] {
            std::fs::write(root.path().join(name), "unchanged").unwrap();
        }
        let result = search(root.path().to_str().unwrap(), "SRC/APP/").unwrap();
        assert_eq!(
            result
                .files
                .iter()
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>(),
            ["src/app/a b.ts", "src/app/main.ts"]
        );
        assert!(!result.truncated);
        assert_eq!(
            search(root.path().to_str().unwrap(), "main.ts")
                .unwrap()
                .files
                .len(),
            1
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join("src/app/main.ts")).unwrap(),
            "unchanged"
        );
    }
    #[test]
    fn rejects_relative_roots_and_invalid_queries_and_bounds_results() {
        assert!(search("relative", "").is_err());
        let root = tempfile::tempdir().unwrap();
        assert!(search(root.path().to_str().unwrap(), "line\nbreak").is_err());
        for i in 0..MAX_RESULTS + 1 {
            std::fs::write(root.path().join(format!("{i}.txt")), "").unwrap();
        }
        let result = search(root.path().to_str().unwrap(), "").unwrap();
        assert_eq!(result.files.len(), MAX_RESULTS);
        assert!(result.truncated);
    }
    #[cfg(unix)]
    #[test]
    fn does_not_follow_external_file_or_directory_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("private.txt"), "fixture").unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("external")).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("private.txt"),
            root.path().join("link.txt"),
        )
        .unwrap();
        assert!(search(root.path().to_str().unwrap(), "")
            .unwrap()
            .files
            .is_empty());
    }
}
