//! Explicit local editor action; never interpret a project path as shell text.
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn project_directory(directory: &str) -> Result<PathBuf, String> {
    if directory.is_empty()
        || directory.len() > 4096
        || directory.chars().any(char::is_control)
        || !Path::new(directory).is_absolute()
    {
        return Err("chat.editor.invalidDirectory".into());
    }
    Path::new(directory)
        .canonicalize()
        .ok()
        .filter(|path| path.is_dir())
        .ok_or_else(|| "chat.editor.invalidDirectory".into())
}

fn executable() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        // Invoke Code.exe directly, never the code.cmd batch wrapper.
        crate::agent::find_executable("Code.exe").or_else(|| {
            [
                std::env::var_os("LOCALAPPDATA")
                    .map(|root| PathBuf::from(root).join("Programs/Microsoft VS Code/Code.exe")),
                std::env::var_os("ProgramFiles")
                    .map(|root| PathBuf::from(root).join("Microsoft VS Code/Code.exe")),
            ]
            .into_iter()
            .flatten()
            .find(|path| path.is_file())
        })
    }
    #[cfg(not(windows))]
    {
        crate::agent::find_executable("code").or_else(|| {
            let path = PathBuf::from(
                "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
            );
            (cfg!(target_os = "macos") && path.is_file()).then_some(path)
        })
    }
}

fn command(executable: &Path, directory: &Path) -> Command {
    let mut command = Command::new(executable);
    command
        .arg("--reuse-window")
        .arg("--")
        .arg(directory)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

pub fn open(directory: &str) -> Result<(), String> {
    let directory = project_directory(directory)?;
    if cfg!(any(target_os = "ios", target_os = "android")) {
        return Err("chat.editor.unsupported".into());
    }
    let executable = executable().ok_or("chat.editor.unavailable")?;
    let mut child = command(&executable, &directory)
        .spawn()
        .map_err(|_| "chat.editor.failed")?;
    // A GUI may outlive LatticeTerm. Reap its launcher without blocking IPC.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_existing_absolute_directories_can_be_opened() {
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(
            project_directory(temp.path().to_str().unwrap()).unwrap(),
            temp.path().canonicalize().unwrap()
        );
        let file = temp.path().join("file");
        std::fs::write(&file, b"fixture").unwrap();
        for path in ["", "relative", "/missing\nfolder", file.to_str().unwrap()] {
            assert_eq!(
                project_directory(path).unwrap_err(),
                "chat.editor.invalidDirectory"
            );
        }
    }
    #[test]
    fn project_names_are_one_literal_argument_after_the_option_separator() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("--project space & '$HOME'");
        std::fs::create_dir(&directory).unwrap();
        let directory = project_directory(directory.to_str().unwrap()).unwrap();
        let command = command(Path::new("synthetic-editor"), &directory);
        assert_eq!(command.get_program(), "synthetic-editor");
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            vec![
                std::ffi::OsStr::new("--reuse-window"),
                std::ffi::OsStr::new("--"),
                directory.as_os_str()
            ]
        );
    }
}
