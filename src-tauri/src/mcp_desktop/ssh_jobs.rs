//! Noninteractive channels only: never paste shell commands into a user's PTY.

use super::{cancelled, ExecPlan, ServiceError};
use crate::ssh::{ChannelCloseGuard, TrustingHandler};
use russh::{client, ChannelMsg};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;

const OUTPUT_LIMIT: usize = 32 * 1024;

#[derive(Default)]
struct Output {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    stdout_truncated: bool,
    stderr_truncated: bool,
    exit_status: Option<u32>,
    exit_signal: Option<&'static str>,
}

impl Output {
    fn data(&mut self, bytes: &[u8], stderr: bool) {
        let remaining = OUTPUT_LIMIT.saturating_sub(self.stdout.len() + self.stderr.len());
        let take = bytes.len().min(remaining);
        if stderr {
            self.stderr.extend_from_slice(&bytes[..take]);
            self.stderr_truncated |= take != bytes.len();
        } else {
            self.stdout.extend_from_slice(&bytes[..take]);
            self.stdout_truncated |= take != bytes.len();
        }
    }

    fn result(&self, id: &str, state: &str) -> Value {
        json!({
            "operationId": id,
            "state": state,
            "stdout": String::from_utf8_lossy(&self.stdout),
            "stderr": String::from_utf8_lossy(&self.stderr),
            "stdoutTruncated": self.stdout_truncated,
            "stderrTruncated": self.stderr_truncated,
            "exitStatus": self.exit_status,
            "exitSignal": self.exit_signal,
            "remoteCommandExitReported": state == "exited",
            "remoteProcessTerminationConfirmed": false,
        })
    }

    fn end_state(&self) -> &'static str {
        if self.exit_status.is_some() || self.exit_signal.is_some() {
            "exited"
        } else {
            "unknown"
        }
    }
}

pub(super) async fn execute(
    handle: Arc<client::Handle<TrustingHandler>>,
    plan: &ExecPlan,
    operation_id: &str,
    mut revoked: watch::Receiver<bool>,
    mut cancel: watch::Receiver<bool>,
) -> Result<Value, ServiceError> {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(u64::from(plan.timeout_ms));
    let mut output = Output::default();
    let channel = tokio::select! {
        biased;
        _ = cancelled(&mut revoked) => return Err(ServiceError::denied()),
        _ = cancelled(&mut cancel) => return Ok(output.result(operation_id, "cancelled")),
        _ = tokio::time::sleep_until(deadline) => return Ok(output.result(operation_id, "timedOut")),
        channel = handle.channel_open_session() => channel.map_err(|_| ServiceError::unavailable())?,
    };
    let (mut reader, writer) = channel.split();
    let closing = ChannelCloseGuard::new(writer);
    let writer = closing.writer();
    tokio::select! {
        biased;
        _ = cancelled(&mut revoked) => return Err(ServiceError::denied()),
        _ = cancelled(&mut cancel) => return Ok(output.result(operation_id, "cancelled")),
        _ = tokio::time::sleep_until(deadline) => return Ok(output.result(operation_id, "timedOut")),
        sent = writer.exec(true, plan.command.clone()) => sent.map_err(|_| ServiceError::new("unknown_outcome", "The exec request could not be confirmed; inspect its status before retrying."))?,
    }
    let state = loop {
        tokio::select! {
            biased;
            _ = cancelled(&mut revoked) => return Err(ServiceError::denied()),
            _ = cancelled(&mut cancel) => break "cancelled",
            _ = tokio::time::sleep_until(deadline) => break "timedOut",
            message = reader.wait() => match message {
                Some(ChannelMsg::Data { data }) => output.data(&data, false),
                Some(ChannelMsg::ExtendedData { data, ext: 1 }) => output.data(&data, true),
                Some(ChannelMsg::ExitStatus { exit_status }) => output.exit_status = Some(exit_status),
                Some(ChannelMsg::ExitSignal { signal_name, .. }) => output.exit_signal = Some(signal_label(&signal_name)),
                // EOF is not an exit status. Servers can send the status later.
                Some(ChannelMsg::Eof) => {},
                Some(ChannelMsg::Close) | None => break output.end_state(),
                Some(ChannelMsg::Failure | ChannelMsg::OpenFailure(_)) => break "rejected",
                Some(_) => {},
            }
        }
    };
    // Dropping the guard closes this channel, never the SSH transport.
    Ok(output.result(operation_id, state))
}

fn signal_label(signal: &russh::Sig) -> &'static str {
    use russh::Sig;
    match signal {
        Sig::ABRT => "ABRT",
        Sig::ALRM => "ALRM",
        Sig::FPE => "FPE",
        Sig::HUP => "HUP",
        Sig::ILL => "ILL",
        Sig::INT => "INT",
        Sig::KILL => "KILL",
        Sig::PIPE => "PIPE",
        Sig::QUIT => "QUIT",
        Sig::SEGV => "SEGV",
        Sig::TERM => "TERM",
        Sig::USR1 => "USR1",
        // A server-controlled custom signal can contain arbitrary data.
        Sig::Custom(_) => "OTHER",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stdout_and_stderr_are_separate_but_share_one_memory_budget() {
        let mut output = Output::default();
        output.data(b"ok", false);
        output.data(b"warning", true);
        output.data(&vec![b'x'; OUTPUT_LIMIT], false);
        output.data(b"more", true);
        assert_eq!(output.stdout.len() + output.stderr.len(), OUTPUT_LIMIT);
        assert!(output.stdout_truncated && output.stderr_truncated);
        let result = output.result("operation", "timedOut");
        assert_eq!(result["stderr"], "warning");
        assert_eq!(result["remoteProcessTerminationConfirmed"], false);
        assert!(result["exitStatus"].is_null());
    }

    #[test]
    fn close_without_exit_status_is_unknown_not_success() {
        let mut output = Output::default();
        assert_eq!(output.end_state(), "unknown");
        output.exit_status = Some(7);
        let result = output.result("operation", output.end_state());
        assert_eq!(result["state"], "exited");
        assert_eq!(result["exitStatus"], 7);
        assert_eq!(
            signal_label(&russh::Sig::Custom("untrusted private data".into())),
            "OTHER"
        );
    }
}
