//! Independently authorised, bounded one-shot commands on the sharing host.
use serde::{Deserialize, Serialize};

pub const MAX_COMMAND_BYTES: usize = 16 * 1024;
pub const MAX_COMMAND_OUTPUT: usize = 512 * 1024;
pub const MAX_COMMAND_CHUNK: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CommandShell {
    Cmd,
    PowerShell,
}
impl CommandShell {
    pub fn flag(self) -> u8 {
        match self {
            Self::Cmd => 1,
            Self::PowerShell => 2,
        }
    }
    pub fn from_flags(flags: u8) -> Vec<Self> {
        [Self::Cmd, Self::PowerShell]
            .into_iter()
            .filter(|s| flags & s.flag() != 0)
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CommandRequest {
    Run {
        id: u32,
        shell: CommandShell,
        command: String,
        directory: String,
        timeout_seconds: u16,
    },
    Cancel {
        id: u32,
    },
}
impl CommandRequest {
    pub fn id(&self) -> u32 {
        match self {
            Self::Run { id, .. } | Self::Cancel { id } => *id,
        }
    }
    pub fn valid(&self) -> bool {
        self.id() != 0
            && match self {
                Self::Cancel { .. } => true,
                Self::Run {
                    command,
                    directory,
                    timeout_seconds,
                    ..
                } => {
                    !command.trim().is_empty()
                        && command.len() <= MAX_COMMAND_BYTES
                        && !command.contains('\0')
                        && directory.len() <= 4096
                        && !directory.chars().any(char::is_control)
                        && (1..=300).contains(timeout_seconds)
                }
            }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CommandEnd {
    Exited,
    Cancelled,
    TimedOut,
    OutputLimit,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CommandEvent {
    Started {
        id: u32,
        directory: String,
    },
    Output {
        id: u32,
        stderr: bool,
        bytes: Vec<u8>,
    },
    Finished {
        id: u32,
        reason: CommandEnd,
        exit_code: Option<i32>,
        detail: String,
    },
}
impl CommandEvent {
    pub fn id(&self) -> u32 {
        match self {
            Self::Started { id, .. } | Self::Output { id, .. } | Self::Finished { id, .. } => *id,
        }
    }
    pub fn valid(&self) -> bool {
        self.id() != 0
            && match self {
                Self::Started { directory, .. } => directory.len() <= 4096,
                Self::Output { bytes, .. } => !bytes.is_empty() && bytes.len() <= MAX_COMMAND_CHUNK,
                Self::Finished { detail, .. } => detail.len() <= 2048,
            }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::RemoteMessage;
    #[test]
    fn commands_round_trip_and_reject_unbounded_or_ambiguous_inputs() {
        let request = CommandRequest::Run {
            id: 4,
            shell: CommandShell::PowerShell,
            command: "Write-Output '中文'".into(),
            directory: "C:\\work".into(),
            timeout_seconds: 30,
        };
        let message = RemoteMessage::CommandRequest(request.clone());
        assert_eq!(
            RemoteMessage::decode(&message.encode().unwrap()).unwrap(),
            message
        );
        let event = RemoteMessage::CommandEvent(CommandEvent::Output {
            id: 4,
            stderr: true,
            bytes: vec![0xf0, 0x9f],
        });
        assert_eq!(
            RemoteMessage::decode(&event.encode().unwrap()).unwrap(),
            event
        );
        for invalid in [
            CommandRequest::Cancel { id: 0 },
            CommandRequest::Run {
                id: 1,
                shell: CommandShell::Cmd,
                command: "x".repeat(MAX_COMMAND_BYTES + 1),
                directory: String::new(),
                timeout_seconds: 30,
            },
            CommandRequest::Run {
                id: 1,
                shell: CommandShell::Cmd,
                command: "echo x".into(),
                directory: String::new(),
                timeout_seconds: 0,
            },
        ] {
            assert!(RemoteMessage::CommandRequest(invalid).encode().is_err());
        }
        assert!(RemoteMessage::CommandEvent(CommandEvent::Output {
            id: 1,
            stderr: false,
            bytes: vec![0; MAX_COMMAND_CHUNK + 1]
        })
        .encode()
        .is_err());
        let mut unknown = vec![12];
        unknown.extend_from_slice(br#"{"kind":"cancel","id":1,"extra":true}"#);
        assert!(RemoteMessage::decode(&unknown).is_err());
    }
}
