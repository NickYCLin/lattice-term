//! Bounded TCP streams carried only inside an authenticated Remote session.
//! Database passwords remain in the database protocol, never in this envelope.
use serde::{Deserialize, Serialize};

pub const CHUNK_BYTES: usize = 8192;
pub const MAX_STREAMS: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum TcpMessage {
    Open { id: u32, host: String, port: u16 },
    Opened { id: u32 },
    Data { id: u32, bytes: Vec<u8> },
    Eof { id: u32 },
    Close { id: u32 },
    Closed { id: u32 },
    Failed { id: u32 },
}

impl TcpMessage {
    pub fn id(&self) -> u32 {
        match self {
            Self::Open { id, .. }
            | Self::Opened { id }
            | Self::Data { id, .. }
            | Self::Eof { id }
            | Self::Close { id }
            | Self::Closed { id }
            | Self::Failed { id } => *id,
        }
    }

    pub fn valid(&self) -> bool {
        self.id() != 0
            && match self {
                Self::Open { host, port, .. } => {
                    !host.is_empty()
                        && host.len() <= 253
                        && *port != 0
                        && !host
                            .chars()
                            .any(|c| c.is_whitespace() || c.is_control() || "/\\@?#".contains(c))
                }
                Self::Data { bytes, .. } => !bytes.is_empty() && bytes.len() <= CHUNK_BYTES,
                _ => true,
            }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_targets_and_unbounded_payloads() {
        for host in ["", "db.invalid/path", "db\n.invalid", "user@db.invalid"] {
            assert!(!TcpMessage::Open {
                id: 1,
                host: host.into(),
                port: 1433
            }
            .valid());
        }
        assert!(!TcpMessage::Data {
            id: 1,
            bytes: vec![0; CHUNK_BYTES + 1]
        }
        .valid());
        assert!(!TcpMessage::Close { id: 0 }.valid());
        assert!(TcpMessage::Open {
            id: 1,
            host: "127.0.0.1".into(),
            port: 1433
        }
        .valid());
    }

    #[test]
    fn remote_envelope_roundtrips_tcp_without_version_gates() {
        for message in [
            TcpMessage::Open {
                id: 1,
                host: "db.internal".into(),
                port: 1433,
            },
            TcpMessage::Opened { id: 1 },
            TcpMessage::Data {
                id: 1,
                bytes: vec![0, 255, 1],
            },
            TcpMessage::Eof { id: 1 },
            TcpMessage::Close { id: 1 },
            TcpMessage::Closed { id: 1 },
            TcpMessage::Failed { id: 1 },
        ] {
            let message = crate::RemoteMessage::Tcp(message);
            assert_eq!(
                crate::RemoteMessage::decode(&message.encode().unwrap()).unwrap(),
                message
            );
        }
    }

    #[test]
    fn database_capability_is_an_optional_trailing_hello_field() {
        let mut hello = crate::RemoteHello {
            protocol_version: crate::PROTOCOL_VERSION,
            agent_name: "fixture".into(),
            width: 80,
            height: 24,
            view_only: true,
            file_transfer: false,
            file_root_label: String::new(),
            terminal: false,
            file_edit: false,
            command_shells: 0,
            chat: false,
            cli: false,
            fleet: false,
            stream_pause: false,
            database_forwarding: false,
        };
        let old = crate::RemoteMessage::Hello(hello.clone()).encode().unwrap();
        hello.database_forwarding = true;
        let new = crate::RemoteMessage::Hello(hello.clone()).encode().unwrap();
        assert_eq!(new.len(), old.len() + 8);
        assert_eq!(
            crate::RemoteMessage::decode(&new).unwrap(),
            crate::RemoteMessage::Hello(hello)
        );
        assert!(
            matches!(crate::RemoteMessage::decode(&old).unwrap(), crate::RemoteMessage::Hello(hello) if !hello.database_forwarding)
        );
    }
}
