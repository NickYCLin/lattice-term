//! Local default MCP can bring up the desktop, without focusing an open window.
use super::*;

pub(super) fn is_default_directory(
    requested: Option<&std::path::Path>,
    default: Option<&std::path::Path>,
) -> bool {
    match (requested, default) {
        (None, Some(_)) => true,
        (Some(requested), Some(default)) => {
            super::super::installation_key(requested) == super::super::installation_key(default)
        }
        _ => false,
    }
}

impl McpServer {
    pub(super) async fn prepare_desktop(
        &self,
        connection: &Arc<Connection>,
    ) -> Result<(), ToolError> {
        if !self.auto_start {
            return Ok(());
        }
        let _guard = self.desktop_start.lock().await;
        // Do not launch a second GUI process when a desktop already owns the
        // bridge. Recheck on each entry so closing and reopening it also works.
        let presence = connection
            .request(Request::DesktopCall {
                operation: crate::mcp_desktop::DesktopOperation::ListSavedConnections,
            })
            .await;
        if !matches!(presence, Err(error) if error.contains("open LatticeTerm to read the connection book"))
        {
            return Ok(());
        }
        spawn_desktop().map_err(|_| {
            ToolError::Failed(
                "Could not start LatticeTerm. Open the desktop and retry this tool.".into(),
            )
        })?;
        // Probe only a read. Never replay a connection attempt or other write.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let result = tokio::time::timeout_at(
                deadline,
                connection.request(Request::DesktopCall {
                    operation: crate::mcp_desktop::DesktopOperation::ListSavedConnections,
                }),
            )
            .await;
            match result {
                Ok(Err(error))
                    if error.contains("open LatticeTerm to read the connection book") =>
                {
                    if tokio::time::Instant::now() >= deadline {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
                // An authorization error also confirms the desktop is ready.
                Ok(_) => return Ok(()),
                Err(_) => break,
            }
        }
        Err(ToolError::Failed(
            "LatticeTerm is starting. Retry the same tool once its window is ready.".into(),
        ))
    }
}

fn spawn_desktop() -> std::io::Result<()> {
    let mut command = std::process::Command::new(std::env::current_exe()?);
    command
        .arg("--mcp-desktop")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: only async-signal-safe setsid runs between fork and exec.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    let mut child = command.spawn()?;
    std::thread::Builder::new()
        .name("mcp-desktop-reaper".into())
        .spawn(move || {
            let _ = child.wait();
        })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_default_paths_autostart_but_custom_data_stays_passive() {
        let default = std::path::Path::new("default-data");
        assert!(is_default_directory(None, Some(default)));
        assert!(is_default_directory(Some(default), Some(default)));
        assert!(!is_default_directory(
            Some(std::path::Path::new("isolated-data")),
            Some(default)
        ));
        assert!(!is_default_directory(None, None));
        #[cfg(windows)]
        assert!(is_default_directory(
            Some(std::path::Path::new(r"C:\Test\App\")),
            Some(std::path::Path::new("c:/test/app")),
        ));
    }

    #[tokio::test]
    async fn library_and_workspace_adapters_never_start_processes() {
        let data = tempfile::tempdir().unwrap();
        let local = McpServer::new(DaemonPaths::new(data.path()));
        assert!(local.attached().await.is_none());
        assert!(!local.start_attempted.load(Ordering::Relaxed));
        let scoped = McpServer::workspace(DaemonPaths::new(data.path()), "/approved".into());
        assert!(scoped.attached().await.is_none());
        assert!(!scoped.start_attempted.load(Ordering::Relaxed));
        assert!(!scoped.auto_start);
    }
}
