//! Fixed /bin/sh, independent cwd and owned process group for each command.
use super::*;
use crate::command_protocol::{CommandShell, MAX_COMMAND_CHUNK, MAX_COMMAND_OUTPUT};
use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

struct ProcessGroup(i32);
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        // Only the group created for this command; never the terminal's group.
        unsafe {
            libc::kill(-self.0, libc::SIGKILL);
        }
    }
}

async fn execute(
    request: CommandRequest,
    cancel: &mut watch::Receiver<bool>,
    outgoing: &mpsc::Sender<RemoteMessage>,
) -> Result<(CommandEnd, Option<i32>), String> {
    let CommandRequest::Run {
        id,
        shell,
        command,
        directory,
        timeout_seconds,
    } = request
    else {
        unreachable!()
    };
    if shell != CommandShell::Posix {
        return Err("This host only supports POSIX /bin/sh.".into());
    }
    if *cancel.borrow() {
        return Ok((CommandEnd::Cancelled, None));
    }
    let directory = if directory.is_empty() {
        PathBuf::from(std::env::var_os("HOME").ok_or("The host home directory is unavailable.")?)
    } else {
        PathBuf::from(directory)
    };
    if !directory.is_absolute() {
        return Err("The command directory must be absolute.".into());
    }
    let directory = directory
        .canonicalize()
        .map_err(|_| "The command directory is unavailable.")?;
    if !directory.is_dir() {
        return Err("The command directory is not a folder.".into());
    }
    // User text is passed once as the shell's command argument. The directory
    // never becomes shell source. No login/profile startup or interactive stdin.
    let mut child = Command::new("/bin/sh")
        .args(["-c", &command])
        .current_dir(&directory)
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "Cannot start /bin/sh.")?;
    let group = ProcessGroup(child.id().ok_or("The command already exited.")? as i32);
    let mut stdout = child
        .stdout
        .take()
        .ok_or("Command stdout is unavailable.")?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or("Command stderr is unavailable.")?;
    if !send(
        outgoing,
        CommandEvent::Started {
            id,
            directory: directory.to_string_lossy().into_owned(),
        },
    )
    .await
    {
        return Err("The viewer disconnected.".into());
    }
    let mut out = [0; MAX_COMMAND_CHUNK];
    let mut err = [0; MAX_COMMAND_CHUNK];
    let (mut out_eof, mut err_eof, mut exit, mut total) = (false, false, None, 0);
    let deadline = tokio::time::sleep(Duration::from_secs(u64::from(timeout_seconds)));
    tokio::pin!(deadline);
    let reason = loop {
        if exit.is_some() && out_eof && err_eof {
            break CommandEnd::Exited;
        }
        let chunk = tokio::select! {
            biased;
            _ = cancel.changed() => break CommandEnd::Cancelled,
            _ = &mut deadline => break CommandEnd::TimedOut,
            result = stdout.read(&mut out), if !out_eof => {
                let n = result.map_err(|_| "Cannot read command stdout.")?;
                if n == 0 { out_eof = true; continue; } (false, &out[..n])
            },
            result = stderr.read(&mut err), if !err_eof => {
                let n = result.map_err(|_| "Cannot read command stderr.")?;
                if n == 0 { err_eof = true; continue; } (true, &err[..n])
            },
            result = child.wait(), if exit.is_none() => {
                exit = Some(result.map_err(|_| "Cannot wait for the command.")?.code());
                // Reap inherited pipe holders as well as the direct shell.
                unsafe { libc::kill(-group.0, libc::SIGKILL); }
                continue;
            },
        };
        let n = chunk.1.len().min(MAX_COMMAND_OUTPUT - total);
        if n > 0
            && !send(
                outgoing,
                CommandEvent::Output {
                    id,
                    stderr: chunk.0,
                    bytes: chunk.1[..n].to_vec(),
                },
            )
            .await
        {
            return Err("The viewer disconnected.".into());
        }
        total += n;
        if total >= MAX_COMMAND_OUTPUT {
            break CommandEnd::OutputLimit;
        }
    };
    drop(group);
    if exit.is_none() {
        let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
    }
    Ok((reason, exit.flatten()))
}

pub(super) async fn run(
    request: CommandRequest,
    mut cancel: watch::Receiver<bool>,
    outgoing: mpsc::Sender<RemoteMessage>,
) -> bool {
    let id = request.id();
    let (reason, exit_code, detail) = match execute(request, &mut cancel, &outgoing).await {
        Ok((reason, code)) => (reason, code, String::new()),
        Err(detail) => (CommandEnd::Failed, None, detail),
    };
    send(
        &outgoing,
        CommandEvent::Finished {
            id,
            reason,
            exit_code,
            detail,
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(
        id: u32,
        command: &str,
        directory: &std::path::Path,
        timeout_seconds: u16,
    ) -> CommandRequest {
        CommandRequest::Run {
            id,
            shell: CommandShell::Posix,
            command: command.into(),
            directory: directory.to_string_lossy().into_owned(),
            timeout_seconds,
        }
    }
    async fn result(
        rx: &mut mpsc::Receiver<RemoteMessage>,
    ) -> (CommandEnd, Option<i32>, Vec<u8>, Vec<u8>) {
        tokio::time::timeout(Duration::from_secs(10), async {
            let (mut out, mut err) = (Vec::new(), Vec::new());
            loop {
                match rx.recv().await.unwrap() {
                    RemoteMessage::CommandEvent(CommandEvent::Output { stderr, bytes, .. }) => {
                        if stderr {
                            err.extend(bytes)
                        } else {
                            out.extend(bytes)
                        }
                    }
                    RemoteMessage::CommandEvent(CommandEvent::Finished {
                        reason,
                        exit_code,
                        ..
                    }) => return (reason, exit_code, out, err),
                    _ => {}
                }
            }
        })
        .await
        .unwrap()
    }
    #[tokio::test]
    async fn literal_directory_unicode_exit_and_deduplication() {
        let temp = tempfile::Builder::new()
            .prefix("commands 中文 ' $()")
            .tempdir()
            .unwrap();
        let (tx, mut rx) = mpsc::channel(32);
        let mut commands = Commands::new(true, tx, Arc::new(Semaphore::new(1)));
        let call = request(
            1,
            "printf '中文🦀'; printf error >&2; printf once >> count; exit 7",
            temp.path(),
            5,
        );
        assert!(commands.handle(call.clone()).await);
        assert!(commands.handle(call.clone()).await);
        let (end, code, out, err) = result(&mut rx).await;
        assert_eq!((end, code), (CommandEnd::Exited, Some(7)));
        assert_eq!(String::from_utf8(out).unwrap(), "中文🦀");
        assert_eq!(err, b"error");
        assert!(commands.handle(call).await);
        assert_eq!(
            std::fs::read_to_string(temp.path().join("count")).unwrap(),
            "once"
        );
        assert!(tokio::time::timeout(Duration::from_millis(30), rx.recv())
            .await
            .is_err());
        commands.shutdown().await;
    }
    #[tokio::test]
    async fn rejects_permission_wrong_shell_and_relative_directory() {
        let temp = tempfile::tempdir().unwrap();
        for (allowed, shell, directory) in [
            (false, CommandShell::Posix, temp.path()),
            (true, CommandShell::Cmd, temp.path()),
            (true, CommandShell::Posix, std::path::Path::new("relative")),
        ] {
            let (tx, mut rx) = mpsc::channel(8);
            let mut commands = Commands::new(allowed, tx, Arc::new(Semaphore::new(1)));
            let mut call = request(1, "touch forbidden", directory, 5);
            if let CommandRequest::Run { shell: s, .. } = &mut call {
                *s = shell;
            }
            assert!(commands.handle(call).await);
            assert_eq!(result(&mut rx).await.0, CommandEnd::Failed);
            assert!(!temp.path().join("forbidden").exists());
            commands.shutdown().await;
        }
    }
    #[tokio::test]
    async fn timeout_and_output_are_bounded() {
        let temp = tempfile::tempdir().unwrap();
        for (command, seconds, reason) in [
            ("sleep 30", 1, CommandEnd::TimedOut),
            ("yes output", 5, CommandEnd::OutputLimit),
        ] {
            let (tx, mut rx) = mpsc::channel(32);
            let mut commands = Commands::new(true, tx, Arc::new(Semaphore::new(1)));
            assert!(
                commands
                    .handle(request(1, command, temp.path(), seconds))
                    .await
            );
            let (end, _, out, err) = result(&mut rx).await;
            assert_eq!(end, reason);
            assert!(out.len() + err.len() <= MAX_COMMAND_OUTPUT);
            commands.shutdown().await;
        }
    }
    #[tokio::test]
    async fn cancel_and_disconnect_stop_owned_descendants() {
        for disconnect in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let (tx, mut rx) = mpsc::channel(32);
            let mut commands = Commands::new(true, tx, Arc::new(Semaphore::new(1)));
            assert!(
                commands
                    .handle(request(
                        1,
                        "(sleep 2; touch escaped) & wait",
                        temp.path(),
                        10
                    ))
                    .await
            );
            assert!(matches!(
                rx.recv().await,
                Some(RemoteMessage::CommandEvent(CommandEvent::Started { .. }))
            ));
            if disconnect {
                commands.shutdown().await;
            } else {
                assert!(commands.handle(CommandRequest::Cancel { id: 1 }).await);
            }
            assert_eq!(result(&mut rx).await.0, CommandEnd::Cancelled);
            tokio::time::sleep(Duration::from_millis(2100)).await;
            assert!(!temp.path().join("escaped").exists());
            commands.shutdown().await;
        }
    }
}
