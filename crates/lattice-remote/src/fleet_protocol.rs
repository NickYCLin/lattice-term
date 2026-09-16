//! Fleet uses the authenticated request lane, independently of chat and raw CLI access.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FleetRequest {
    pub version: u16,
    pub client: String,
    // The desktop deserializes this into the closed FleetAction enum before dispatch.
    pub action: serde_json::Value,
}

impl FleetRequest {
    pub fn valid(&self) -> bool {
        self.version == 1
            && self.client.len() == 64
            && self.client.bytes().all(|b| b.is_ascii_hexdigit())
            && self.action.is_object()
            && serde_json::to_vec(&self.action).is_ok_and(|v| v.len() <= 20 * 1024)
    }
    pub fn mutates(&self) -> bool {
        !matches!(
            self.action["kind"].as_str(),
            Some("listSessions" | "listPlans" | "readOutput" | "waitState")
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        chat_protocol::{ChatOperation, ChatRequest},
        RemoteHello, RemoteMessage, PROTOCOL_VERSION,
    };
    #[test]
    fn fleet_has_its_own_version_and_bounded_request_envelope() {
        let request = FleetRequest {
            version: 1,
            client: "a".repeat(64),
            action: serde_json::json!({"kind":"readOutput","sessionId":"one","cursor":0,"maxBytes":1024}),
        };
        assert!(request.valid());
        assert!(!request.mutates());
        let message = RemoteMessage::ChatRequest(ChatRequest {
            id: "request-one".into(),
            operation: ChatOperation::Fleet {
                request: request.clone(),
            },
        });
        assert_eq!(
            RemoteMessage::decode(&message.encode().unwrap()).unwrap(),
            message
        );
        let mut bad = request.clone();
        bad.version = 2;
        assert!(!bad.valid());
        bad = request.clone();
        bad.client = "other-client".into();
        assert!(!bad.valid());
        bad = request;
        bad.action = serde_json::json!({"kind":"send","text":"x".repeat(20*1024)});
        assert!(!bad.valid());
    }
    #[test]
    fn fleet_advertisement_does_not_enable_chat_cli_or_control() {
        let hello = RemoteHello {
            protocol_version: PROTOCOL_VERSION,
            agent_name: "fixture".into(),
            width: 80,
            height: 24,
            view_only: true,
            file_transfer: false,
            file_root_label: String::new(),
            terminal: true,
            file_edit: false,
            command_shells: 0,
            chat: false,
            cli: false,
            fleet: true,
        };
        let encoded = RemoteMessage::Hello(hello.clone()).encode().unwrap();
        assert_eq!(
            RemoteMessage::decode(&encoded).unwrap(),
            RemoteMessage::Hello(hello)
        );
        let RemoteMessage::Hello(legacy) =
            RemoteMessage::decode(&encoded[..encoded.len() - 1]).unwrap()
        else {
            panic!()
        };
        assert!(!legacy.fleet && !legacy.chat && !legacy.cli && legacy.view_only);
    }
}
