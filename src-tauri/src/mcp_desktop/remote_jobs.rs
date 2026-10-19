//! Bounded commands over the existing encrypted Remote channel, not a UI PTY.
use super::{cancelled, valid_command, ServiceError};
use crate::remote::{
    command_cancel_checked, command_start_checked, CommandStartError, RemoteRegistry,
};
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

fn start_error(error: CommandStartError) -> ServiceError {
    match error {
        CommandStartError::Busy => ServiceError::new(
            "busy",
            "A Remote command is still running. This command was not sent. Wait for the active operation to finish before submitting a new request.",
        ),
        CommandStartError::NotConnected | CommandStartError::ConnectionChanged => ServiceError::new(
            "needs_user_action",
            "The Remote connection is unavailable or changed. This command was not sent. Call list_authorized_connections for its current targetId.",
        ),
        CommandStartError::ShellNotAllowed => ServiceError::new(
            "not_authorized",
            "The host has not allowed this command shell. This command was not sent.",
        ),
        CommandStartError::ReconnectRequired | CommandStartError::StateUnavailable(_) => ServiceError::new(
            "not_ready",
            "The Remote connection cannot accept another command. This command was not sent. Reconnect and verify the connection in LatticeTerm.",
        ),
        CommandStartError::InvalidRequest(_) => ServiceError::new(
            "invalid_request",
            "The Remote command payload is invalid. This command was not sent.",
        ),
        CommandStartError::UnknownOutcome(_) => ServiceError::new(
            "unknown_outcome",
            "The Remote command could not be confirmed. Inspect the operation before retrying.",
        ),
    }
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
    .map_err(start_error)?;
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
    fn start_failures_distinguish_rejection_from_uncertain_delivery() {
        for (failure, code) in [
            (CommandStartError::Busy, "busy"),
            (CommandStartError::NotConnected, "needs_user_action"),
            (CommandStartError::ConnectionChanged, "needs_user_action"),
            (CommandStartError::ShellNotAllowed, "not_authorized"),
            (CommandStartError::ReconnectRequired, "not_ready"),
            (
                CommandStartError::InvalidRequest("fixture".into()),
                "invalid_request",
            ),
            (
                CommandStartError::StateUnavailable("fixture".into()),
                "not_ready",
            ),
        ] {
            let error = start_error(failure);
            assert_eq!(error.code, code);
            assert!(error.message.contains("not sent"));
        }
        let error = start_error(CommandStartError::UnknownOutcome("fixture".into()));
        assert_eq!(error.code, "unknown_outcome");
        assert!(!error.message.contains("not sent"));
        assert!(error.message.contains("Inspect the operation"));
    }

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
