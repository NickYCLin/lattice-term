//! Latest bounded command output belongs to one live Remote session only.
use lattice_remote::command_protocol::{
    CommandEnd, CommandEvent, CommandRequest, CommandShell, MAX_COMMAND_OUTPUT,
};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::time::Instant;

// Allow host startup, process cleanup and delivery after its execution budget.
const RESULT_GRACE: Duration = Duration::from_secs(15);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandInput {
    pub shell: CommandShell,
    pub command: String,
    pub directory: String,
    pub timeout_seconds: u16,
}
impl CommandInput {
    pub fn request(self, id: u32) -> CommandRequest {
        CommandRequest::Run {
            id,
            shell: self.shell,
            command: self.command,
            directory: self.directory,
            timeout_seconds: self.timeout_seconds,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandView {
    pub session_id: String,
    pub id: u32,
    pub revision: u32,
    pub shell: CommandShell,
    pub command: String,
    pub directory: String,
    pub state: String,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub detail: String,
    pub reconnect_required: bool,
}
impl CommandView {
    pub fn active(&self) -> bool {
        matches!(self.state.as_str(), "starting" | "running" | "cancelling")
    }
}
pub(crate) struct CommandState {
    pub view: CommandView,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    started: bool,
    result_deadline: Instant,
}
impl CommandState {
    pub fn new(session: &str, request: &CommandRequest) -> Self {
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
        Self {
            view: CommandView {
                session_id: session.into(),
                id: *id,
                revision: 0,
                shell: *shell,
                command: command.clone(),
                directory: directory.clone(),
                state: "starting".into(),
                stdout: String::new(),
                stderr: String::new(),
                exit_code: None,
                detail: String::new(),
                reconnect_required: false,
            },
            stdout: Vec::new(),
            stderr: Vec::new(),
            started: false,
            result_deadline: Instant::now()
                + Duration::from_secs(u64::from(*timeout_seconds))
                + RESULT_GRACE,
        }
    }
    pub fn reconcile_deadline(&mut self) {
        if self.view.active() && Instant::now() >= self.result_deadline {
            self.view.state = "failed".into();
            self.view.reconnect_required = true;
            self.view.detail = "The command result was not confirmed within its time limit. Process termination is not confirmed. Disconnect this Remote connection before reconnecting, then verify the previous outcome before retrying.".into();
            self.view.revision += 1;
        }
    }
    pub fn update(&mut self, event: CommandEvent) -> Result<CommandView, String> {
        if event.id() != self.view.id || (!self.view.active() && !self.view.reconnect_required) {
            return Err("Unexpected remote command event.".into());
        }
        match event {
            CommandEvent::Started { directory, .. } => {
                if self.started {
                    return Err("The command started twice.".into());
                }
                self.started = true;
                self.view.directory = directory;
                if self.view.state != "cancelling" && !self.view.reconnect_required {
                    self.view.state = "running".into();
                }
            }
            CommandEvent::Output { stderr, bytes, .. } => {
                if !self.started
                    || self.stdout.len() + self.stderr.len() + bytes.len() > MAX_COMMAND_OUTPUT
                {
                    return Err("The remote command output exceeded its boundary.".into());
                }
                let (buffer, text) = if stderr {
                    (&mut self.stderr, &mut self.view.stderr)
                } else {
                    (&mut self.stdout, &mut self.view.stdout)
                };
                buffer.extend(bytes);
                *text = String::from_utf8_lossy(buffer).into_owned();
            }
            CommandEvent::Finished {
                reason,
                exit_code,
                detail,
                ..
            } => {
                self.view.state = match reason {
                    CommandEnd::Exited => "exited",
                    CommandEnd::Cancelled => "cancelled",
                    CommandEnd::TimedOut => "timedOut",
                    CommandEnd::OutputLimit => "outputLimit",
                    CommandEnd::Failed => "failed",
                }
                .into();
                self.view.exit_code = exit_code;
                self.view.detail = detail;
                self.view.reconnect_required = false;
            }
        }
        self.view.revision += 1;
        Ok(self.view.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(start_paused = true)]
    async fn missing_results_quarantine_all_active_states_until_the_host_finishes() {
        for lifecycle in ["starting", "running", "cancelling"] {
            let mut state = fixture();
            state.view.state = lifecycle.into();
            tokio::time::advance(Duration::from_secs(20)).await;
            state.reconcile_deadline();
            assert_eq!(state.view.state, "failed");
            assert!(state.view.reconnect_required);
            let revision = state.view.revision;
            state.reconcile_deadline();
            assert_eq!(state.view.revision, revision);
            // Late startup/output is retained, but cannot establish completion.
            state
                .update(CommandEvent::Started {
                    id: 1,
                    directory: String::new(),
                })
                .unwrap();
            state
                .update(CommandEvent::Output {
                    id: 1,
                    stderr: false,
                    bytes: b"late".to_vec(),
                })
                .unwrap();
            assert_eq!(state.view.state, "failed");
            assert!(state.view.reconnect_required);
            assert_eq!(state.view.stdout, "late");
            state
                .update(CommandEvent::Finished {
                    id: 1,
                    reason: CommandEnd::Cancelled,
                    exit_code: None,
                    detail: String::new(),
                })
                .unwrap();
            assert!(!state.view.reconnect_required);
            assert_eq!(state.view.state, "cancelled");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn completed_commands_do_not_expire() {
        let mut state = fixture();
        state
            .update(CommandEvent::Finished {
                id: 1,
                reason: CommandEnd::Exited,
                exit_code: Some(7),
                detail: String::new(),
            })
            .unwrap();
        tokio::time::advance(Duration::from_secs(1000)).await;
        state.reconcile_deadline();
        assert_eq!(state.view.state, "exited");
        assert_eq!(state.view.exit_code, Some(7));
        assert!(!state.view.reconnect_required);
    }
    fn fixture() -> CommandState {
        CommandState::new(
            "session",
            &CommandRequest::Run {
                id: 1,
                shell: CommandShell::Cmd,
                command: "echo test".into(),
                directory: String::new(),
                timeout_seconds: 5,
            },
        )
    }
    #[test]
    fn command_output_preserves_split_unicode_and_rejects_unsolicited_events() {
        let mut state = fixture();
        assert!(state
            .update(CommandEvent::Output {
                id: 1,
                stderr: false,
                bytes: vec![1]
            })
            .is_err());
        state
            .update(CommandEvent::Started {
                id: 1,
                directory: "C:\\test".into(),
            })
            .unwrap();
        for byte in "中文🦀".as_bytes() {
            state
                .update(CommandEvent::Output {
                    id: 1,
                    stderr: false,
                    bytes: vec![*byte],
                })
                .unwrap();
        }
        assert_eq!(state.view.stdout, "中文🦀");
        assert!(state
            .update(CommandEvent::Output {
                id: 2,
                stderr: false,
                bytes: vec![1]
            })
            .is_err());
        state
            .update(CommandEvent::Finished {
                id: 1,
                reason: CommandEnd::Exited,
                exit_code: Some(7),
                detail: String::new(),
            })
            .unwrap();
        assert!(!state.view.active());
        assert!(state
            .update(CommandEvent::Started {
                id: 1,
                directory: String::new()
            })
            .is_err());
    }
    #[test]
    fn command_output_has_a_combined_stream_limit() {
        let mut state = fixture();
        state
            .update(CommandEvent::Started {
                id: 1,
                directory: String::new(),
            })
            .unwrap();
        state
            .update(CommandEvent::Output {
                id: 1,
                stderr: false,
                bytes: vec![b'x'; MAX_COMMAND_OUTPUT],
            })
            .unwrap();
        assert!(state
            .update(CommandEvent::Output {
                id: 1,
                stderr: true,
                bytes: vec![b'x']
            })
            .is_err());
    }
}
