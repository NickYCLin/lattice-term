//! Bounded commands over the existing encrypted Remote channel, not a UI PTY.
use super::{cancelled, valid_command, ServiceError};
use crate::remote::{command_cancel_checked, command_start_checked, RemoteRegistry};
use crate::remote_commands::CommandInput;
use lattice_remote::command_protocol::CommandShell;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::sync::watch;

pub(super) fn validate(command: &str, directory: &str) -> Result<(), ServiceError> {
    valid_command(command)?;
    if directory.len() > 4096 || directory.chars().any(char::is_control) {
        return Err(ServiceError::invalid());
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn execute(
    registry: &RemoteRegistry,
    session_id: &str,
    generation: u64,
    shell: CommandShell,
    command: &str,
    directory: &str,
    operation_id: &str,
    mut revoked: watch::Receiver<bool>,
    mut cancel: watch::Receiver<bool>,
) -> Result<Value, ServiceError> {
    if *revoked.borrow() || *cancel.borrow() {
        return Err(ServiceError::denied());
    }
    let started = command_start_checked(
        registry,
        session_id,
        CommandInput {
            shell,
            command: command.into(),
            directory: directory.into(),
            timeout_seconds: 60,
        },
        Some(generation),
    )
    .await
    .map_err(|_| {
        ServiceError::new(
            "unknown_outcome",
            "The Remote command could not be confirmed. Inspect the operation before retrying.",
        )
    })?;
    let deadline = tokio::time::sleep(Duration::from_secs(65));
    tokio::pin!(deadline);
    loop {
        // Never read another connection's output, even if its session ID is reused.
        if registry.command_generation(session_id) != Some(generation) {
            return Err(ServiceError::reconnected());
        }
        let view = registry
            .command_state(session_id)
            .map_err(|_| ServiceError::unavailable())?
            .filter(|view| view.id == started.id)
            .ok_or_else(|| {
                ServiceError::new(
                    "unknown_outcome",
                    "The Remote command output is no longer retained.",
                )
            })?;
        if !view.active() {
            return Ok(json!({
                "operationId": operation_id,
                "state": view.state,
                "stdout": view.stdout,
                "stderr": view.stderr,
                "exitStatus": view.exit_code,
                "remoteCommandExitReported": view.state == "exited",
                "remoteProcessTerminationConfirmed": false,
                "untrusted": true
            }));
        }
        let end = tokio::select! {
            biased;
            _ = cancelled(&mut revoked) => Some("revoked"),
            _ = cancelled(&mut cancel) => Some("cancelled"),
            _ = &mut deadline => Some("timedOut"),
            _ = tokio::time::sleep(Duration::from_millis(50)) => None,
        };
        if let Some(state) = end {
            let _ =
                command_cancel_checked(registry, session_id, started.id, Some(generation)).await;
            if state == "revoked" {
                return Err(ServiceError::denied());
            }
            return Ok(json!({
                "operationId": operation_id, "state": state,
                "stdout": view.stdout, "stderr": view.stderr,
                "exitStatus": null, "remoteCommandExitReported": false,
                "remoteProcessTerminationConfirmed": false, "untrusted": true
            }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn commands_and_directories_are_bounded_and_keep_literal_text() {
        assert!(validate("Get-Location", r"C:\work space").is_ok());
        assert!(validate("", "").is_err());
        assert!(validate("echo one\necho two", "").is_err());
        assert!(validate("echo ok", "C:\\work\nother").is_err());
        assert!(validate(&"x".repeat(4097), "").is_err());
        assert!(validate("echo ok", &"x".repeat(4097)).is_err());
    }
}
