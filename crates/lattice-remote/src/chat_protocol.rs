//! Explicitly granted access to conversations owned by the sharing desktop.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatRequest {
    pub id: String,
    pub operation: ChatOperation,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ChatOperation {
    List,
    CliList,
    CliRead {
        session_id: String,
        cursor: u64,
    },
    CliInput {
        session_id: String,
        data: String,
    },
    CliResize {
        session_id: String,
        cols: u32,
        rows: u32,
    },
    Read {
        thread_id: String,
        before: Option<String>,
    },
    Send {
        thread_id: String,
        text: String,
    },
    Stop {
        thread_id: String,
        turn_id: String,
    },
    Respond {
        thread_id: String,
        turn_id: String,
        request_id: String,
        allow: bool,
    },
    Create {
        template_id: String,
    },
}
impl ChatOperation {
    pub fn is_cli(&self) -> bool {
        matches!(
            self,
            Self::CliList | Self::CliRead { .. } | Self::CliInput { .. } | Self::CliResize { .. }
        )
    }
}
fn identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 160 && !value.chars().any(char::is_control)
}
impl ChatRequest {
    pub fn valid(&self) -> bool {
        if !identifier(&self.id) {
            return false;
        }
        match &self.operation {
            ChatOperation::List | ChatOperation::CliList => true,
            ChatOperation::CliRead { session_id, .. } => identifier(session_id),
            ChatOperation::CliInput { session_id, data } => {
                identifier(session_id) && !data.is_empty() && data.len() <= 16 * 1024
            }
            ChatOperation::CliResize {
                session_id,
                cols,
                rows,
            } => identifier(session_id) && (2..=500).contains(cols) && (2..=300).contains(rows),
            ChatOperation::Read { thread_id, before } => {
                identifier(thread_id) && before.as_deref().is_none_or(identifier)
            }
            ChatOperation::Send { thread_id, text } => {
                identifier(thread_id)
                    && !text.trim().is_empty()
                    && text.len() <= 16 * 1024
                    && !text.contains('\0')
            }
            ChatOperation::Stop { thread_id, turn_id } => {
                identifier(thread_id) && identifier(turn_id)
            }
            ChatOperation::Respond {
                thread_id,
                turn_id,
                request_id,
                ..
            } => identifier(thread_id) && identifier(turn_id) && identifier(request_id),
            ChatOperation::Create { template_id } => identifier(template_id),
        }
    }
    pub fn mutates(&self) -> bool {
        !matches!(
            self.operation,
            ChatOperation::List
                | ChatOperation::Read { .. }
                | ChatOperation::CliList
                | ChatOperation::CliRead { .. }
        )
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatResponse {
    pub id: String,
    pub value: serde_json::Value,
    pub error: Option<String>,
}
impl ChatResponse {
    pub fn failed(id: String, message: &str) -> Self {
        Self {
            id,
            value: serde_json::Value::Null,
            error: Some(message.to_owned()),
        }
    }
    pub fn valid(&self) -> bool {
        identifier(&self.id) && self.error.as_ref().is_none_or(|error| error.len() <= 1024)
    }
}

// Private, authenticated loopback pipe between the bundled Agent and desktop.
// The bearer is inherited in the child's environment, never a remote argument.
#[cfg(feature = "agent")]
pub async fn forward(request: ChatRequest) -> ChatResponse {
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpStream,
    };
    let id = request.id.clone();
    let result = tokio::time::timeout(std::time::Duration::from_secs(12), async {
        let address = std::env::var("LATTICE_CHAT_BRIDGE").map_err(|_| ())?;
        let address: std::net::SocketAddr = address.parse().map_err(|_| ())?;
        if !address.ip().is_loopback() {
            return Err(());
        }
        let token = std::env::var("LATTICE_CHAT_TOKEN").map_err(|_| ())?;
        let mut stream = TcpStream::connect(address).await.map_err(|_| ())?;
        let bytes = serde_json::to_vec(&serde_json::json!({"token": token, "request": request}))
            .map_err(|_| ())?;
        stream.write_u32(bytes.len() as u32).await.map_err(|_| ())?;
        stream.write_all(&bytes).await.map_err(|_| ())?;
        let size = stream.read_u32().await.map_err(|_| ())? as usize;
        if size > 60 * 1024 {
            return Err(());
        }
        let mut bytes = vec![0; size];
        stream.read_exact(&mut bytes).await.map_err(|_| ())?;
        let response: ChatResponse = serde_json::from_slice(&bytes).map_err(|_| ())?;
        if response.id != id || !response.valid() {
            return Err(());
        }
        Ok(response)
    })
    .await;
    match result {
        Ok(Ok(response)) => response,
        _ => ChatResponse::failed(
            id,
            "The sharing desktop did not respond. Refresh before sending again.",
        ),
    }
}
#[cfg(feature = "agent")]
pub fn bridge_available() -> bool {
    std::env::var("LATTICE_CHAT_BRIDGE")
        .ok()
        .and_then(|value| value.parse::<std::net::SocketAddr>().ok())
        .is_some_and(|address| address.ip().is_loopback())
        && std::env::var("LATTICE_CHAT_TOKEN").is_ok_and(|value| value.len() == 64)
}
#[cfg(feature = "agent")]
pub fn available() -> bool {
    bridge_available() && std::env::var("LATTICE_CHAT_ALLOWED").as_deref() != Ok("0")
}
#[cfg(feature = "agent")]
pub fn cli_available() -> bool {
    bridge_available() && std::env::var("LATTICE_CLI_ALLOWED").as_deref() == Ok("1")
}
#[cfg(feature = "agent")]
pub fn permits(operation: &ChatOperation) -> bool {
    if operation.is_cli() {
        cli_available()
    } else {
        available()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cli_messages_validate_bounds_and_classify_mutations() {
        for operation in [
            ChatOperation::CliList,
            ChatOperation::CliRead {
                session_id: "opaque".into(),
                cursor: 123,
            },
            ChatOperation::CliInput {
                session_id: "opaque".into(),
                data: "中文\r\u{1b}[A\u{3}".into(),
            },
            ChatOperation::CliResize {
                session_id: "opaque".into(),
                cols: 80,
                rows: 24,
            },
        ] {
            let request = ChatRequest {
                id: "r".into(),
                operation,
            };
            assert!(request.valid());
            assert!(request.operation.is_cli());
            let encoded = crate::RemoteMessage::ChatRequest(request.clone())
                .encode()
                .unwrap();
            assert_eq!(
                crate::RemoteMessage::decode(&encoded).unwrap(),
                crate::RemoteMessage::ChatRequest(request)
            );
        }
        for operation in [
            ChatOperation::CliInput {
                session_id: "x".into(),
                data: "x".repeat(16385),
            },
            ChatOperation::CliResize {
                session_id: "x".into(),
                cols: 501,
                rows: 24,
            },
            ChatOperation::CliRead {
                session_id: "".into(),
                cursor: 0,
            },
        ] {
            assert!(!ChatRequest {
                id: "r".into(),
                operation
            }
            .valid());
        }
        assert!(!ChatRequest {
            id: "r".into(),
            operation: ChatOperation::CliRead {
                session_id: "x".into(),
                cursor: 0
            }
        }
        .mutates());
        assert!(ChatRequest {
            id: "r".into(),
            operation: ChatOperation::CliInput {
                session_id: "x".into(),
                data: "a".into()
            }
        }
        .mutates());
    }
    #[test]
    fn requests_cannot_select_local_paths_or_permissions() {
        assert!(serde_json::from_value::<ChatRequest>(serde_json::json!({"id":"x", "operation":{"kind":"send","threadId":"a","text":"hello","profileConfigPath":"private"}})).is_err());
        assert!(!ChatRequest {
            id: "x".into(),
            operation: ChatOperation::Send {
                thread_id: "a".into(),
                text: "x".repeat(16385)
            }
        }
        .valid());
    }
}
