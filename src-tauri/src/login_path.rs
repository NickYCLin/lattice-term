//! A macOS app started from the Dock or Finder gets launchd's bare PATH
//! (`/usr/bin:/bin:/usr/sbin:/sbin`), not the one the user's shell builds
//! from `.zprofile` and `.zshrc`. Homebrew, nvm and npm-global folders are
//! then invisible, so no CLI is detected and npm installs cannot start.
//! Ask the login shell for its PATH once at startup and put it in front.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

const START: &str = "__LATTICETERM_PATH_START__";
const END: &str = "__LATTICETERM_PATH_END__";

/// Merges the login shell's PATH and common tool folders into this process.
/// Children (the agent daemon, CLIs, npm) inherit the result.
pub fn adopt_login_shell_path() {
    #[cfg(target_os = "macos")]
    {
        let current = std::env::var_os("PATH").unwrap_or_default();
        let shell_path = std::env::var_os("SHELL")
            .map(PathBuf::from)
            .filter(|shell| shell.is_absolute() && shell.is_file())
            .and_then(|shell| read_shell_path(&shell));
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let merged = merge_paths(
            shell_path.as_deref(),
            &current,
            &well_known_directories(home.as_deref()),
        );
        if merged != current {
            std::env::set_var("PATH", merged);
        }
    }
}

#[cfg(unix)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn read_shell_path(shell: &Path) -> Option<OsString> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let mut child = Command::new(shell)
        .args([
            "-i",
            "-l",
            "-c",
            &format!("printf '%s%s%s' '{START}' \"$PATH\" '{END}'"),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut output = String::new();
    child.stdout.take()?.read_to_string(&mut output).ok()?;
    extract_marked_path(&output).map(OsString::from)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn well_known_directories(home: Option<&Path>) -> Vec<PathBuf> {
    let mut directories = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/opt/homebrew/sbin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(home) = home {
        for relative in [
            ".local/bin",
            ".npm-global/bin",
            ".volta/bin",
            ".bun/bin",
            ".cargo/bin",
        ] {
            directories.push(home.join(relative));
        }
    }
    directories.retain(|directory| directory.is_dir());
    directories
}

/// Shell start-up files may print banners; keep only the marked value.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn extract_marked_path(output: &str) -> Option<&str> {
    let start = output.rfind(START)? + START.len();
    let length = output[start..].find(END)?;
    let value = output[start..start + length].trim();
    (!value.is_empty()).then_some(value)
}

/// Shell PATH first, then what the process already had, then the fallbacks.
/// Relative entries are dropped and duplicates keep their first position.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn merge_paths(
    shell: Option<&std::ffi::OsStr>,
    current: &std::ffi::OsStr,
    extra: &[PathBuf],
) -> OsString {
    let mut seen = std::collections::HashSet::new();
    let entries: Vec<PathBuf> = shell
        .into_iter()
        .flat_map(std::env::split_paths)
        .chain(std::env::split_paths(current))
        .chain(extra.iter().cloned())
        .filter(|entry| entry.is_absolute())
        .filter(|entry| seen.insert(entry.clone()))
        .collect();
    std::env::join_paths(entries).unwrap_or_else(|_| current.to_os_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn keeps_only_the_marked_path_after_a_shell_banner() {
        let output = format!("Welcome!\n{START}/opt/homebrew/bin:/usr/bin{END}");
        assert_eq!(
            extract_marked_path(&output),
            Some("/opt/homebrew/bin:/usr/bin")
        );
        assert_eq!(extract_marked_path("no markers"), None);
        assert_eq!(extract_marked_path(&format!("{START}{END}")), None);
    }

    #[test]
    fn puts_the_shell_path_first_without_duplicates_or_relative_entries() {
        let merged = merge_paths(
            Some(OsStr::new("/Users/a/.nvm/bin:/usr/bin:relative")),
            OsStr::new("/usr/bin:/bin"),
            &[PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/bin")],
        );
        assert_eq!(
            merged,
            OsString::from("/Users/a/.nvm/bin:/usr/bin:/bin:/opt/homebrew/bin")
        );
    }

    #[cfg(unix)]
    #[test]
    fn reads_the_path_a_shell_reports() {
        let path = read_shell_path(Path::new("/bin/sh")).expect("shell PATH");
        assert!(!path.is_empty());
    }

    #[test]
    fn keeps_the_current_path_when_the_shell_gives_nothing() {
        let merged = merge_paths(None, OsStr::new("/usr/bin:/bin"), &[]);
        assert_eq!(merged, OsString::from("/usr/bin:/bin"));
    }
}
