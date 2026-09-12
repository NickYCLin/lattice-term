use super::*;
use crate::command_protocol::{CommandShell, MAX_COMMAND_CHUNK, MAX_COMMAND_OUTPUT};
use base64::Engine;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use windows_sys::Win32::System::JobObjects::*;

struct Job(OwnedHandle);
impl Job {
    fn attach(child: &Child) -> Result<Self, String> {
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err("Cannot create the command process job.".into());
        }
        let owned = unsafe { OwnedHandle::from_raw_handle(handle) };
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            )
        };
        let process = child
            .raw_handle()
            .ok_or("The command process has already exited.")?;
        if configured == 0 || unsafe { AssignProcessToJobObject(handle, process) } == 0 {
            return Err("Cannot contain the command process tree.".into());
        }
        Ok(Self(owned))
    }
    fn terminate(&self) {
        unsafe {
            TerminateJobObject(self.0.as_raw_handle(), 1);
        }
    }
}

// This fixed bootstrap cannot execute user code until its stdin is supplied.
// The parent assigns the process to a kill-on-close Job before sending JSON.
// No user text or paths become PowerShell source or outer command arguments.
const BOOTSTRAP: &str = r#"$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';$utf8=New-Object System.Text.UTF8Encoding($false);[Console]::InputEncoding=$utf8;[Console]::OutputEncoding=$utf8;$OutputEncoding=$utf8;try{$text=[Console]::In.ReadToEnd();if(!$text){exit 125};$r=ConvertFrom-Json $text;if($r.file){$p=New-Object System.Diagnostics.ProcessStartInfo;$p.FileName=[Environment]::SystemDirectory+'\cmd.exe';$p.Arguments='/d /s /c ""'+$r.file+'""';$p.UseShellExecute=$false;$p.CreateNoWindow=$true;$p.RedirectStandardInput=$true;$p.RedirectStandardOutput=$true;$p.RedirectStandardError=$true;$c=[Diagnostics.Process]::Start($p);$c.StandardInput.Close();$a=$c.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput());$b=$c.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError());$c.WaitForExit();$a.GetAwaiter().GetResult();$b.GetAwaiter().GetResult();$code=$c.ExitCode;$c.Dispose();exit $code};$global:LASTEXITCODE=0;& ([ScriptBlock]::Create($r.command));$ok=$?;$code=$LASTEXITCODE;if($code){exit $code};if(!$ok){exit 1};exit 0}catch{[Console]::Error.WriteLine($_.ToString());exit 1}"#;

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
    if *cancel.borrow() {
        return Ok((CommandEnd::Cancelled, None));
    }
    let directory = if directory.trim().is_empty() {
        PathBuf::from(
            std::env::var_os("USERPROFILE").ok_or("The host home directory is unavailable.")?,
        )
    } else {
        PathBuf::from(directory)
    };
    if !directory.is_absolute()
        || !matches!(directory.components().next(), Some(std::path::Component::Prefix(prefix)) if matches!(prefix.kind(), std::path::Prefix::Disk(_)))
    {
        return Err("The command directory must be an absolute local drive path.".into());
    }
    let directory = directory
        .canonicalize()
        .map_err(|_| "The command directory is unavailable.")?;
    if !directory.is_dir() {
        return Err("The command directory is not a folder.".into());
    }
    let mut script = None;
    let payload = match shell {
        CommandShell::Cmd => {
            use std::io::Write;
            let mut file = tempfile::Builder::new()
                .prefix("lattice-command-")
                .suffix(".cmd")
                .tempfile()
                .map_err(|_| "Cannot create the owned command script.")?;
            write!(
                file,
                "@echo off\r\nchcp 65001 >nul\r\n{command}\r\nexit /b %errorlevel%\r\n"
            )
            .map_err(|_| "Cannot write the owned command script.")?;
            file.flush()
                .map_err(|_| "Cannot flush the owned command script.")?;
            let payload = serde_json::json!({"file":file.path()});
            script = Some(file);
            payload
        }
        CommandShell::PowerShell => serde_json::json!({"command":command}),
    };
    let encoded = base64::engine::general_purpose::STANDARD.encode(
        BOOTSTRAP
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    let windows = PathBuf::from(
        std::env::var_os("SystemRoot").ok_or("The Windows system directory is unavailable.")?,
    );
    let mut child = Command::new(windows.join("System32/WindowsPowerShell/v1.0/powershell.exe"))
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-OutputFormat",
            "Text",
            "-EncodedCommand",
            &encoded,
        ])
        .current_dir(&directory)
        .creation_flags(0x08000000)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "Cannot start Windows PowerShell.")?;
    let job = Job::attach(&child)?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or("Command stdout is unavailable.")?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or("Command stderr is unavailable.")?;
    let mut input = child.stdin.take().ok_or("Command stdin is unavailable.")?;
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
    let payload = serde_json::to_vec(&payload).map_err(|_| "Cannot encode the command.")?;
    tokio::select! {
        biased;
        _ = cancel.changed() => return Ok((CommandEnd::Cancelled, None)),
        result = tokio::time::timeout(Duration::from_secs(5), input.write_all(&payload)) => {
            result.map_err(|_| "Command startup timed out.")?.map_err(|_| "Command input closed.")?;
        }
    }
    drop(input);
    let mut out = [0; MAX_COMMAND_CHUNK];
    let mut err = [0; MAX_COMMAND_CHUNK];
    let mut out_eof = false;
    let mut err_eof = false;
    let mut exit = None;
    let mut total = 0;
    let mut deadline =
        tokio::time::Instant::now() + Duration::from_secs(u64::from(timeout_seconds));
    let reason = loop {
        if exit.is_some() && out_eof && err_eof {
            break CommandEnd::Exited;
        }
        let chunk = tokio::select! {
            biased;
            _ = cancel.changed() => break CommandEnd::Cancelled,
            _ = tokio::time::sleep_until(deadline) => break if exit.is_some() { CommandEnd::Exited } else { CommandEnd::TimedOut },
            result = stdout.read(&mut out), if !out_eof => {
                let n = result.map_err(|_| "Cannot read command stdout.")?;
                if n == 0 { out_eof = true; continue; }
                (false, &out[..n])
            },
            result = stderr.read(&mut err), if !err_eof => {
                let n = result.map_err(|_| "Cannot read command stderr.")?;
                if n == 0 { err_eof = true; continue; }
                (true, &err[..n])
            },
            result = child.wait(), if exit.is_none() => {
                exit = Some(result.map_err(|_| "Cannot wait for the command.")?.code());
                job.terminate(); // Also close descendants' inherited output handles.
                deadline = tokio::time::Instant::now() + Duration::from_secs(2);
                continue;
            },
        };
        let remaining = MAX_COMMAND_OUTPUT.saturating_sub(total);
        let n = chunk.1.len().min(remaining);
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
    job.terminate();
    if exit.is_none() {
        let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
    }
    drop(script);
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
    async fn result(
        rx: &mut mpsc::Receiver<RemoteMessage>,
    ) -> (CommandEnd, Option<i32>, String, String) {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        loop {
            let event = tokio::time::timeout(Duration::from_secs(20), rx.recv())
                .await
                .unwrap()
                .unwrap();
            match event {
                RemoteMessage::CommandEvent(CommandEvent::Output {
                    stderr: error,
                    bytes,
                    ..
                }) => {
                    if error {
                        stderr.extend(bytes);
                    } else {
                        stdout.extend(bytes);
                    }
                }
                RemoteMessage::CommandEvent(CommandEvent::Finished {
                    reason,
                    exit_code,
                    detail,
                    ..
                }) => {
                    assert!(detail.is_empty(), "{detail}");
                    return (
                        reason,
                        exit_code,
                        String::from_utf8(stdout).unwrap(),
                        String::from_utf8(stderr).unwrap(),
                    );
                }
                _ => {}
            }
        }
    }
    fn request(
        id: u32,
        shell: CommandShell,
        command: &str,
        directory: &std::path::Path,
        timeout_seconds: u16,
    ) -> CommandRequest {
        CommandRequest::Run {
            id,
            shell,
            command: command.into(),
            directory: directory.to_string_lossy().into_owned(),
            timeout_seconds,
        }
    }
    #[tokio::test]
    async fn windows_commands_preserve_unicode_stderr_exit_codes_and_do_not_replay() {
        let temp = tempfile::Builder::new()
            .prefix("commands 中文 &'")
            .tempdir()
            .unwrap();
        for (shell, command) in [
            (CommandShell::Cmd, "echo 中文🦀\r\necho stderr-test 1>&2\r\necho once>>count.txt\r\nexit /b 7"),
            (CommandShell::PowerShell, "Write-Output '中文🦀';[Console]::Error.WriteLine('stderr-test');Add-Content count.txt once;exit 7"),
        ] {
            let count = temp.path().join("count.txt");
            let _ = std::fs::remove_file(&count);
            let (tx, mut rx) = mpsc::channel(32);
            let mut commands = Commands::new(true, tx, Arc::new(Semaphore::new(1)));
            let request = request(1, shell, command, temp.path(), 15);
            assert!(commands.handle(request.clone()).await);
            assert!(commands.handle(request.clone()).await);
            let (end, code, out, err) = result(&mut rx).await;
            assert_eq!((end, code), (CommandEnd::Exited, Some(7)));
            assert!(out.contains("中文🦀"), "{out:?}");
            assert!(err.contains("stderr-test"), "{err:?}");
            assert!(!err.contains("#< CLIXML"), "{err:?}");
            assert!(!err.contains("<Objs"), "{err:?}");
            assert_eq!(std::fs::read_to_string(&count).unwrap().lines().count(), 1);
            assert!(commands.handle(request).await);
            assert!(tokio::time::timeout(Duration::from_millis(200), rx.recv()).await.is_err());
            commands.shutdown().await;
        }
    }
    #[tokio::test]
    async fn windows_commands_enforce_timeout_output_limit_and_cancel_owned_descendants() {
        let temp = tempfile::tempdir().unwrap();
        let (tx, mut rx) = mpsc::channel(32);
        let mut commands = Commands::new(true, tx, Arc::new(Semaphore::new(1)));
        assert!(
            commands
                .handle(request(
                    1,
                    CommandShell::PowerShell,
                    "Start-Sleep 30",
                    temp.path(),
                    1
                ))
                .await
        );
        assert_eq!(result(&mut rx).await.0, CommandEnd::TimedOut);
        commands.shutdown().await;
        assert!(
            commands
                .handle(request(
                    2,
                    CommandShell::PowerShell,
                    "[Console]::Write(('x' * 600000))",
                    temp.path(),
                    15
                ))
                .await
        );
        let limited = result(&mut rx).await;
        assert_eq!(limited.0, CommandEnd::OutputLimit);
        assert_eq!(limited.2.len() + limited.3.len(), MAX_COMMAND_OUTPUT);
        commands.shutdown().await;
        assert!(commands.handle(request(3, CommandShell::PowerShell,
            "$p=Start-Process powershell.exe -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep 60' -PassThru;$p.Id | Set-Content child.txt;Start-Sleep 60", temp.path(), 30)).await);
        let child_file = temp.path().join("child.txt");
        for _ in 0..200 {
            if child_file.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let pid = std::fs::read_to_string(&child_file)
            .unwrap()
            .trim()
            .parse::<u32>()
            .unwrap();
        // Hold the exact child handle before cancellation, avoiding PID reuse.
        use windows_sys::Win32::System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
        };
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        assert!(!handle.is_null());
        let owned = unsafe { OwnedHandle::from_raw_handle(handle) };
        assert!(commands.handle(CommandRequest::Cancel { id: 3 }).await);
        assert_eq!(result(&mut rx).await.0, CommandEnd::Cancelled);
        assert_eq!(
            unsafe { WaitForSingleObject(owned.as_raw_handle(), 5000) },
            0
        );
        commands.shutdown().await;
    }
}
