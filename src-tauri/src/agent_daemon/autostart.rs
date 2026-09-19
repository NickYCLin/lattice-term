//! Starting the background service when the user logs in.
//!
//! The daemon already persists chat automations and stays up while any are
//! enabled, but it only exists once LatticeTerm has been opened: after a
//! reboot nobody runs the schedules until the window comes back. Registering
//! `lattice-term agent-daemon` with the platform's per-user login mechanism
//! closes that gap. A daemon started this way with nothing to own exits after
//! the usual idle period, so the entry costs nothing when it is not needed.
//!
//! Each platform gets exactly one entry named after the application
//! identifier, and only an entry carrying LatticeTerm's own marker is ever
//! replaced or removed.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

const ENTRY_NAME: &str = "io.github.nickyclin.latticeterm.agent-daemon";
/// Proves an entry was written by LatticeTerm before it is touched.
#[cfg(any(target_os = "linux", target_os = "macos"))]
const MARKER: &str = "X-LatticeTerm-Autostart=agent-daemon";

/// The program and arguments the login entry runs. Inside an AppImage the
/// running executable lives on a mount that disappears with the window, so
/// the AppImage file itself is what has to be started.
fn command_line(data_dir: &Path) -> Result<(PathBuf, Vec<OsString>), String> {
    let program = std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .or_else(|| std::env::current_exe().ok())
        .ok_or_else(|| "Cannot locate the LatticeTerm executable.".to_string())?;
    Ok((
        program,
        vec![
            OsString::from("agent-daemon"),
            OsString::from("--data-dir"),
            data_dir.as_os_str().to_owned(),
        ],
    ))
}

/// Whether the login entry is present and was written by LatticeTerm.
pub fn enabled() -> bool {
    platform::read().is_some_and(|content| platform::is_ours(&content))
}

/// Adds or removes the login entry.
pub fn set(data_dir: &Path, enable: bool) -> Result<(), String> {
    if enable {
        let (program, args) = command_line(data_dir)?;
        platform::write(&program, &args)
    } else {
        match platform::read() {
            Some(content) if platform::is_ours(&content) => platform::remove(),
            // Someone else's entry under our name is left alone.
            Some(_) => Err(
                "The login entry was not written by LatticeTerm; leave it or remove it yourself."
                    .to_string(),
            ),
            None => Ok(()),
        }
    }
}

/// Rewrites an existing entry so it follows the executable if the app was
/// moved or updated to a new path. Does nothing when the user never
/// enabled it.
pub fn refresh(data_dir: &Path) {
    if enabled() {
        let _ = set(data_dir, true);
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn write_private_atomically(path: &Path, content: &str) -> Result<(), String> {
    use std::io::Write;
    let parent = path
        .parent()
        .ok_or_else(|| "The login entry has no parent directory.".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("Cannot create {}: {error}", parent.display()))?;
    let mut file = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("Cannot write the login entry: {error}"))?;
    file.write_all(content.as_bytes())
        .and_then(|()| file.as_file().sync_all())
        .map_err(|error| format!("Cannot write the login entry: {error}"))?;
    file.persist(path)
        .map_err(|error| format!("Cannot save the login entry: {}", error.error))?;
    Ok(())
}

#[cfg(target_os = "linux")]
mod platform {
    use super::{write_private_atomically, ENTRY_NAME, MARKER};
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};

    fn entry_path() -> Option<PathBuf> {
        dirs::config_dir().map(|dir| dir.join("autostart").join(format!("{ENTRY_NAME}.desktop")))
    }

    pub fn read() -> Option<String> {
        std::fs::read_to_string(entry_path()?).ok()
    }

    pub fn is_ours(content: &str) -> bool {
        content.lines().any(|line| line.trim() == MARKER)
    }

    pub fn write(program: &Path, args: &[OsString]) -> Result<(), String> {
        let path =
            entry_path().ok_or_else(|| "Cannot find the autostart directory.".to_string())?;
        if let Some(existing) = read() {
            if !is_ours(&existing) {
                return Err("Another login entry already uses LatticeTerm's name.".to_string());
            }
        }
        write_private_atomically(&path, &desktop_entry(program, args)?)
    }

    pub fn remove() -> Result<(), String> {
        let Some(path) = entry_path() else {
            return Ok(());
        };
        match std::fs::remove_file(&path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                Err(format!("Cannot remove the login entry: {error}"))
            }
            _ => Ok(()),
        }
    }

    pub(super) fn desktop_entry(program: &Path, args: &[OsString]) -> Result<String, String> {
        let mut exec = Vec::with_capacity(args.len() + 1);
        exec.push(exec_argument(program.as_os_str())?);
        for arg in args {
            exec.push(exec_argument(arg)?);
        }
        Ok(format!(
            "[Desktop Entry]\nType=Application\nName=LatticeTerm background service\nExec={}\nTerminal=false\nNoDisplay=true\nX-GNOME-Autostart-enabled=true\n{MARKER}\n",
            exec.join(" ")
        ))
    }

    /// Quotes one `Exec` argument. The value is unescaped as a desktop-file
    /// string first and split by the quoting rules second, so a backslash
    /// has to survive both passes; `%` would otherwise start a field code.
    fn exec_argument(value: &std::ffi::OsStr) -> Result<String, String> {
        let value = value
            .to_str()
            .ok_or_else(|| "The LatticeTerm path is not valid text.".to_string())?;
        if value.chars().any(char::is_control) {
            return Err("The LatticeTerm path contains a control character.".to_string());
        }
        let mut quoted = String::with_capacity(value.len() + 2);
        quoted.push('"');
        for c in value.chars() {
            if matches!(c, '"' | '`' | '$' | '\\') {
                quoted.push('\\');
            }
            quoted.push(c);
        }
        quoted.push('"');
        Ok(quoted.replace('\\', "\\\\").replace('%', "%%"))
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{write_private_atomically, ENTRY_NAME, MARKER};
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};

    fn entry_path() -> Option<PathBuf> {
        dirs::home_dir().map(|home| {
            home.join("Library")
                .join("LaunchAgents")
                .join(format!("{ENTRY_NAME}.plist"))
        })
    }

    pub fn read() -> Option<String> {
        std::fs::read_to_string(entry_path()?).ok()
    }

    pub fn is_ours(content: &str) -> bool {
        content.contains(&format!("<!-- {MARKER} -->"))
    }

    pub fn write(program: &Path, args: &[OsString]) -> Result<(), String> {
        let path =
            entry_path().ok_or_else(|| "Cannot find the LaunchAgents directory.".to_string())?;
        if let Some(existing) = read() {
            if !is_ours(&existing) {
                return Err("Another login entry already uses LatticeTerm's name.".to_string());
            }
        }
        write_private_atomically(&path, &launch_agent(program, args)?)
    }

    pub fn remove() -> Result<(), String> {
        let Some(path) = entry_path() else {
            return Ok(());
        };
        match std::fs::remove_file(&path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                Err(format!("Cannot remove the login entry: {error}"))
            }
            _ => Ok(()),
        }
    }

    /// launchd starts it once at login; without `KeepAlive` a daemon that
    /// idles out stays gone until the next login or window.
    pub(super) fn launch_agent(program: &Path, args: &[OsString]) -> Result<String, String> {
        let mut arguments = String::new();
        for value in std::iter::once(program.as_os_str()).chain(args.iter().map(|a| a.as_os_str()))
        {
            let value = value
                .to_str()
                .ok_or_else(|| "The LatticeTerm path is not valid text.".to_string())?;
            arguments.push_str(&format!("    <string>{}</string>\n", xml_escape(value)));
        }
        Ok(format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<!-- {MARKER} -->\n<plist version=\"1.0\">\n<dict>\n  <key>Label</key>\n  <string>{ENTRY_NAME}</string>\n  <key>ProgramArguments</key>\n  <array>\n{arguments}  </array>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>ProcessType</key>\n  <string>Background</string>\n</dict>\n</plist>\n"
        ))
    }

    fn xml_escape(value: &str) -> String {
        value
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
    }
}

#[cfg(windows)]
mod platform {
    //! `HKCU\...\Run` through `reg.exe`, which every Windows ships; the value
    //! is only ever LatticeTerm's own quoted command line.
    use std::ffi::OsString;
    use std::os::windows::process::CommandExt;
    use std::path::Path;
    use std::process::{Command, Stdio};

    const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    const VALUE_NAME: &str = "LatticeTerm background service";
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    fn reg(args: &[&str]) -> Option<std::process::Output> {
        Command::new("reg.exe")
            .args(args)
            .stdin(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()
    }

    pub fn read() -> Option<String> {
        let output = reg(&["query", RUN_KEY, "/v", VALUE_NAME])?;
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
    }

    /// A value under this exact name that runs `agent-daemon` is ours.
    pub fn is_ours(content: &str) -> bool {
        content.contains(" agent-daemon --data-dir ")
    }

    pub fn write(program: &Path, args: &[OsString]) -> Result<(), String> {
        let mut line = quote(program.as_os_str())?;
        for arg in args {
            line.push(' ');
            let arg = arg
                .to_str()
                .ok_or_else(|| "The LatticeTerm path is not valid text.".to_string())?;
            if arg.contains(' ') || arg.contains('\\') {
                line.push_str(&quote(arg.as_ref())?);
            } else {
                line.push_str(arg);
            }
        }
        let output = reg(&[
            "add", RUN_KEY, "/v", VALUE_NAME, "/t", "REG_SZ", "/d", &line, "/f",
        ])
        .ok_or_else(|| "Cannot run reg.exe.".to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!(
                "Cannot save the login entry: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ))
        }
    }

    pub fn remove() -> Result<(), String> {
        match reg(&["delete", RUN_KEY, "/v", VALUE_NAME, "/f"]) {
            Some(output) if output.status.success() => Ok(()),
            Some(output) => Err(format!(
                "Cannot remove the login entry: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )),
            None => Err("Cannot run reg.exe.".to_string()),
        }
    }

    /// Windows paths cannot contain `"`, so plain quoting is enough; a
    /// trailing backslash is doubled so it does not escape the closing quote.
    fn quote(value: &std::ffi::OsStr) -> Result<String, String> {
        let value = value
            .to_str()
            .ok_or_else(|| "The LatticeTerm path is not valid text.".to_string())?;
        if value.contains('"') {
            return Err("The LatticeTerm path contains a quote.".to_string());
        }
        let trailing = if value.ends_with('\\') { "\\" } else { "" };
        Ok(format!("\"{value}{trailing}\""))
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
mod platform {
    use std::ffi::OsString;
    use std::path::Path;

    pub fn read() -> Option<String> {
        None
    }

    pub fn is_ours(_content: &str) -> bool {
        false
    }

    pub fn write(_program: &Path, _args: &[OsString]) -> Result<(), String> {
        Err("Starting the background service at login is not available here.".to_string())
    }

    pub fn remove() -> Result<(), String> {
        Ok(())
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::platform::desktop_entry;
    use std::ffi::OsString;
    use std::path::Path;

    #[test]
    fn exec_line_survives_spaces_quotes_and_percent_signs() {
        let entry = desktop_entry(
            Path::new("/opt/Lattice Term/lattice-term"),
            &[
                OsString::from("agent-daemon"),
                OsString::from("--data-dir"),
                OsString::from(r#"/home/me/100% "odd" $dir\x"#),
            ],
        )
        .unwrap();
        let exec = entry
            .lines()
            .find_map(|line| line.strip_prefix("Exec="))
            .unwrap();
        assert_eq!(
            exec,
            r#""/opt/Lattice Term/lattice-term" "agent-daemon" "--data-dir" "/home/me/100%% \\"odd\\" \\$dir\\\\x""#
        );
        assert!(super::platform::is_ours(&entry));
    }

    #[test]
    fn exec_line_refuses_a_newline() {
        assert!(desktop_entry(Path::new("/opt/lattice-term"), &[OsString::from("a\nb")]).is_err());
    }
}
