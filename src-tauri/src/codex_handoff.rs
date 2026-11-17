//! Read-only lock-holder discovery. Never reads environ, fd contents or prints argv.
use serde::Serialize;
use std::path::Path;
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Holder {
    pub kind: &'static str,
    pub pid: u32,
}
pub(crate) fn holders(proc_root: &Path, home: &Path, thread: &str, own: &[u32]) -> Vec<Holder> {
    if thread.is_empty() || !thread.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-') {
        return Vec::new();
    }
    let home = home.canonicalize().unwrap_or_else(|_| home.to_path_buf());
    let lock = home
        .join("thread-writer-locks")
        .join(format!("{thread}.lock"));
    let Ok(entries) = std::fs::read_dir(proc_root) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let root = entry.path();
        let owns_lock = std::fs::read_dir(root.join("fd")).ok().is_some_and(|fds| {
            fds.flatten()
                .any(|fd| std::fs::read_link(fd.path()).ok().as_ref() == Some(&lock))
        });
        if !owns_lock {
            continue;
        }
        let exe = std::fs::read_link(root.join("exe")).unwrap_or_default();
        let kind = classify(&exe, pid, own);
        found.push(Holder { kind, pid });
    }
    found.sort_by_key(|h| h.pid);
    found
}
fn classify(exe: &Path, pid: u32, own: &[u32]) -> &'static str {
    if exe == Path::new("/usr/lib/chatgpt/resources/codex") {
        "codex_desktop"
    } else if own.contains(&pid) {
        "latticeterm"
    } else {
        "unknown"
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recognizes_only_the_exact_thread_namespace_and_reports_no_private_argv() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let root = temp.path().join("proc");
        for (pid, exe, id) in [
            (10, "/usr/lib/chatgpt/resources/codex", "aa-bb"),
            (11, "/synthetic/codex", "aa-bb"),
            (12, "/synthetic/codex", "cc-dd"),
        ] {
            let proc = root.join(pid.to_string());
            std::fs::create_dir_all(proc.join("fd")).unwrap();
            #[cfg(unix)]
            {
                std::os::unix::fs::symlink(exe, proc.join("exe")).unwrap();
                std::os::unix::fs::symlink(
                    home.join("thread-writer-locks").join(format!("{id}.lock")),
                    proc.join("fd/3"),
                )
                .unwrap();
            }
        }
        #[cfg(unix)]
        assert_eq!(
            holders(&root, &home, "aa-bb", &[11]),
            vec![
                Holder {
                    kind: "codex_desktop",
                    pid: 10
                },
                Holder {
                    kind: "latticeterm",
                    pid: 11
                }
            ]
        );
        assert!(holders(&root, &home, "../private", &[]).is_empty());
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WriterProbe {
    pub holder: Option<Holder>,
    pub available: bool,
}
pub(crate) fn probe(home: &Path, thread: &str) -> WriterProbe {
    let mut result = WriterProbe {
        holder: holders(Path::new("/proc"), home, thread, &[])
            .into_iter()
            .next(),
        available: false,
    };
    if thread.is_empty()
        || !thread.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-')
        || !home.is_dir()
    {
        return result;
    }
    match std::fs::File::open(
        home.join("thread-writer-locks")
            .join(format!("{thread}.lock")),
    ) {
        Ok(file) => {
            result.available = file.try_lock().is_ok();
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            result.available = true;
        }
        Err(_) => {}
    }
    result
}

#[cfg(test)]
mod probe_tests {
    use super::*;
    #[test]
    fn probe_does_not_create_or_modify_lock_files_and_refuses_a_held_lock() {
        let dir = tempfile::tempdir().unwrap();
        assert!(probe(dir.path(), "aa-bb").available);
        assert!(!dir.path().join("thread-writer-locks").exists());
        std::fs::create_dir(dir.path().join("thread-writer-locks")).unwrap();
        let path = dir.path().join("thread-writer-locks/aa-bb.lock");
        std::fs::write(&path, b"synthetic").unwrap();
        let file = std::fs::File::open(&path).unwrap();
        file.try_lock().unwrap();
        assert!(!probe(dir.path(), "aa-bb").available);
        drop(file);
        assert!(probe(dir.path(), "aa-bb").available);
        assert_eq!(std::fs::read(path).unwrap(), b"synthetic");
        assert!(!probe(dir.path(), "../../invalid").available);
    }
}
