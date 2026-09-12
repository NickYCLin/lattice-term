//! Workspace-scoped MCP over a dedicated channel on an already trusted SSH
//! transport. Never sends keystrokes to the user's SSH terminal or forwards
//! arbitrary tool names, executable arguments, credentials, or desktop RPCs.
use super::*;
use crate::ssh::{ChannelCloseGuard, TrustingHandler};
use russh::{client, ChannelMsg, ChannelReadHalf};

const MAX_REPLY: usize = 384 * 1024;
const MAX_MESSAGES: usize = 64;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FleetWorkspace {
    pub executable: String,
    pub data_directory: String,
    pub directory: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum FleetAction {
    ListSessions {},
    ListPlans {},
    ReadOutput {
        session_id: String,
        #[serde(default)]
        cursor: u64,
        #[serde(default = "read_limit")]
        max_bytes: u32,
    },
    WaitState {
        session_id: String,
        #[serde(default = "wait_limit")]
        timeout_ms: u32,
    },
    Launch {
        plan_id: String,
        request_id: String,
    },
    Send {
        session_id: String,
        text: String,
        #[serde(default = "queue_mode")]
        mode: String,
        request_id: String,
    },
    Cancel {
        session_id: String,
        scope: String,
        request_id: String,
    },
}
fn read_limit() -> u32 {
    8192
}
fn wait_limit() -> u32 {
    5000
}
fn queue_mode() -> String {
    "queue".into()
}
impl FleetAction {
    pub(super) fn scope(&self) -> Scope {
        match self {
            Self::ListSessions {} | Self::ListPlans {} | Self::WaitState { .. } => {
                Scope::FleetObserve
            }
            Self::ReadOutput { .. } => Scope::FleetRead,
            Self::Launch { .. } => Scope::FleetLaunch,
            Self::Send { .. } | Self::Cancel { .. } => Scope::FleetControl,
        }
    }
    pub(super) fn request_id(&self) -> Option<&str> {
        match self {
            Self::Launch { request_id, .. }
            | Self::Send { request_id, .. }
            | Self::Cancel { request_id, .. } => Some(request_id),
            _ => None,
        }
    }
    pub(super) fn validate(&self) -> Result<(), ServiceError> {
        match self {
            Self::ReadOutput {
                session_id,
                max_bytes,
                ..
            } => {
                valid_id(session_id)?;
                if !(1..=32768).contains(max_bytes) {
                    return Err(ServiceError::invalid());
                }
            }
            Self::WaitState {
                session_id,
                timeout_ms,
            } => {
                valid_id(session_id)?;
                if *timeout_ms > 5000 {
                    return Err(ServiceError::invalid());
                }
            }
            Self::Launch { plan_id, .. } => valid_id(plan_id)?,
            Self::Send {
                session_id,
                text,
                mode,
                ..
            } => {
                valid_id(session_id)?;
                if text.trim().is_empty()
                    || text.len() > 32768
                    || text.chars().count() > 8192
                    || !matches!(mode.as_str(), "now" | "queue")
                {
                    return Err(ServiceError::invalid());
                }
            }
            Self::Cancel {
                session_id, scope, ..
            } => {
                valid_id(session_id)?;
                if !matches!(scope.as_str(), "turn" | "queue" | "session") {
                    return Err(ServiceError::invalid());
                }
            }
            _ => {}
        }
        if let Some(id) = self.request_id() {
            valid_id(id)?;
        }
        Ok(())
    }
    fn tool(&self) -> (&'static str, Value) {
        match self {
            Self::ListSessions {} => ("list_agent_sessions", json!({})),
            Self::ListPlans {} => ("list_launch_plans", json!({})),
            Self::ReadOutput {
                session_id,
                cursor,
                max_bytes,
            } => (
                "read_agent_output",
                json!({"sessionId":session_id,"cursor":cursor,"maxBytes":max_bytes,"stripControlSequences":true}),
            ),
            Self::WaitState {
                session_id,
                timeout_ms,
            } => (
                "wait_agent_state",
                json!({"sessionId":session_id,"timeoutMs":timeout_ms}),
            ),
            Self::Launch {
                plan_id,
                request_id,
            } => (
                "launch_agent",
                json!({"planId":plan_id,"requestId":request_id}),
            ),
            Self::Send {
                session_id,
                text,
                mode,
                request_id,
            } => (
                "send_agent_prompt",
                json!({"sessionId":session_id,"text":text,"mode":mode,"requestId":request_id}),
            ),
            Self::Cancel {
                session_id,
                scope,
                request_id,
            } => (
                "cancel_agent_task",
                json!({"sessionId":session_id,"scope":scope,"requestId":request_id}),
            ),
        }
    }
}

pub(super) fn validate_grant(request: &GrantRequest) -> Result<(), ServiceError> {
    let scopes = &request.scopes;
    let enabled =
        scopes.fleet_observe || scopes.fleet_read || scopes.fleet_control || scopes.fleet_launch;
    if !enabled && request.fleet.is_none() {
        return Ok(());
    }
    let config = request.fleet.as_ref().ok_or_else(ServiceError::invalid)?;
    if !enabled
        || !scopes.fleet_observe
        || request.backend != Backend::Ssh
        || scopes.metrics
        || scopes.list
        || scopes.exec
        || scopes.upload
        || scopes.download
        || scopes.screen
        || scopes.input
        || !request.roots.is_empty()
        || !request.exec_plans.is_empty()
    {
        return Err(ServiceError::invalid());
    }
    for path in [
        &config.executable,
        &config.data_directory,
        &config.directory,
    ] {
        if !path.starts_with('/')
            || path.len() > 4096
            || path.chars().any(char::is_control)
            || path.split('/').any(|part| part == "..")
            || path == "/"
        {
            return Err(ServiceError::invalid());
        }
    }
    Ok(())
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
pub(super) fn command(config: &FleetWorkspace) -> String {
    format!(
        "exec {} mcp --data-dir {} --workspace-directory {}",
        quote(&config.executable),
        quote(&config.data_directory),
        quote(&config.directory)
    )
}
fn unknown() -> ServiceError {
    ServiceError::new("unknown_outcome", "The remote workspace did not confirm the outcome. Inspect sessions and the original request ID; do not retry with a new ID.")
}
fn protocol_error() -> ServiceError {
    ServiceError::new(
        "unsupported",
        "The remote MCP adapter did not provide a valid bounded workspace response.",
    )
}

struct Replies {
    pending: Vec<u8>,
    received: usize,
    messages: usize,
}
impl Replies {
    async fn read(
        &mut self,
        reader: &mut ChannelReadHalf,
        expected_id: u64,
    ) -> Result<Value, ServiceError> {
        loop {
            if let Some(end) = self.pending.iter().position(|b| *b == b'\n') {
                let line: Vec<_> = self.pending.drain(..=end).collect();
                self.messages += 1;
                if self.messages > MAX_MESSAGES {
                    return Err(protocol_error());
                }
                let value: Value = serde_json::from_slice(&line).map_err(|_| protocol_error())?;
                if value["jsonrpc"] != "2.0" {
                    return Err(protocol_error());
                }
                if value["id"].as_u64() == Some(expected_id) {
                    if value.get("error").is_some() {
                        return Err(protocol_error());
                    }
                    return value.get("result").cloned().ok_or_else(protocol_error);
                }
                // No remote requests are executed or acknowledged. Only bounded
                // notifications may precede the expected response.
                if value.get("id").is_some() {
                    return Err(protocol_error());
                }
                continue;
            }
            match reader.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    self.received = self.received.saturating_add(data.len());
                    if self.received > MAX_REPLY {
                        return Err(protocol_error());
                    }
                    self.pending.extend_from_slice(&data);
                }
                Some(ChannelMsg::ExtendedData { data, .. }) => {
                    // Never expose diagnostic paths, shell startup output or
                    // account material. Stderr still counts against the budget.
                    self.received = self.received.saturating_add(data.len());
                    if self.received > MAX_REPLY {
                        return Err(protocol_error());
                    }
                }
                Some(ChannelMsg::Success) => {}
                Some(
                    ChannelMsg::Eof
                    | ChannelMsg::Close
                    | ChannelMsg::Failure
                    | ChannelMsg::OpenFailure(_),
                )
                | None => return Err(unknown()),
                Some(_) => {}
            }
        }
    }
}
async fn send(
    writer: &russh::ChannelWriteHalf<client::Msg>,
    value: Value,
) -> Result<(), ServiceError> {
    let mut bytes = serde_json::to_vec(&value).map_err(|_| ServiceError::invalid())?;
    bytes.push(b'\n');
    writer.data(&bytes[..]).await.map_err(|_| unknown())
}
fn structured(result: Value) -> Result<Value, ServiceError> {
    let value = result
        .get("structuredContent")
        .cloned()
        .ok_or_else(protocol_error)?;
    if result["isError"] == true {
        let code = value["code"]
            .as_str()
            .filter(|code| crate::agent_daemon::error_code::ALL.contains(code))
            .unwrap_or("failed");
        return Err(ServiceError::new(code, "The remote workspace refused the operation; review its session state and explicit grants."));
    }
    Ok(value)
}

fn intersect_scopes(value: &mut Value, scopes: &Scopes) {
    fn session(value: &mut Value, scopes: &Scopes) {
        let readable = scopes.fleet_read && value["readOutput"] == true;
        let control = scopes.fleet_control && value["access"] == "control";
        value["readOutput"] = json!(readable);
        value["access"] = json!(if control {
            "control"
        } else if readable {
            "read"
        } else {
            "metadata"
        });
    }
    if let Some(sessions) = value["sessions"].as_array_mut() {
        for item in sessions {
            session(item, scopes);
        }
    }
    if value.get("session").is_some_and(Value::is_object) {
        session(&mut value["session"], scopes);
    }
    if let Some(enabled) = value.get_mut("enabled") {
        *enabled = json!(*enabled == true && scopes.fleet_launch);
    }
}

pub(super) async fn execute(
    handle: Arc<client::Handle<TrustingHandler>>,
    config: &FleetWorkspace,
    client: &str,
    target: &str,
    action: &FleetAction,
    scopes: &Scopes,
) -> Result<Value, ServiceError> {
    action.validate()?;
    let work = async {
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|_| ServiceError::unavailable())?;
        let (mut reader, writer) = channel.split();
        let closing = ChannelCloseGuard::new(writer);
        let writer = closing.writer();
        writer
            .exec(true, command(config))
            .await
            .map_err(|_| unknown())?;
        let mut replies = Replies {
            pending: Vec::new(),
            received: 0,
            messages: 0,
        };
        // A stable identity keeps remote deduplication and per-client launch
        // limits across new SSH channels. Never forwards the local daemon token.
        let identity = sha256(format!("{target}\0{client}").as_bytes());
        send(writer, json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":format!("lattice-fleet-{}",&identity[..32]),"version":"1"}}})).await?;
        let initialized = replies.read(&mut reader, 1).await?;
        if initialized["protocolVersion"] != "2025-06-18" {
            return Err(protocol_error());
        }
        send(
            writer,
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        )
        .await?;
        send(writer, json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_capabilities","arguments":{}}})).await?;
        let capabilities = structured(replies.read(&mut reader, 2).await?)?;
        if capabilities["workspaceScope"] != true
            || capabilities["workspaceScoped"] != true
            || capabilities["daemonRunning"] != true
        {
            return Err(ServiceError::new("needs_user_action", "Start and authorize the remote workspace in an updated LatticeTerm background service."));
        }
        let (tool, arguments) = action.tool();
        send(writer, json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":tool,"arguments":arguments}})).await?;
        // Once dispatched, a broken or malformed reply cannot prove that a
        // write did not run. Preserve an unknown outcome for reconciliation.
        let response = replies.read(&mut reader, 3).await.map_err(|error| {
            if action.request_id().is_some() {
                unknown()
            } else {
                error
            }
        })?;
        let mut result = structured(response).map_err(|error| {
            if action.request_id().is_some() && error.code == "unsupported" {
                unknown()
            } else {
                error
            }
        })?;
        intersect_scopes(&mut result, scopes);
        // Closing this adapter channel never terminates its daemon-owned PTYs.
        Ok(json!({"workspaceId":target,"source":"remoteFleet","untrusted":true,"result":result}))
    };
    tokio::time::timeout(Duration::from_secs(12), work)
        .await
        .map_err(|_| unknown())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn command_quotes_every_user_approved_path_without_shell_expansion() {
        let c = FleetWorkspace {
            executable: "/opt/a'$(whoami)/lattice-term".into(),
            data_directory: "/tmp/data space".into(),
            directory: "/workspace/demo".into(),
        };
        assert_eq!(command(&c), "exec '/opt/a'\\''$(whoami)/lattice-term' mcp --data-dir '/tmp/data space' --workspace-directory '/workspace/demo'");
    }
    #[test]
    fn only_bounded_agent_operations_are_accepted() {
        assert!(
            serde_json::from_value::<FleetAction>(json!({"kind":"sshExec","command":"id"}))
                .is_err()
        );
        assert!(serde_json::from_value::<FleetAction>(
            json!({"kind":"listSessions","directory":"/"})
        )
        .is_err());
        assert!(FleetAction::WaitState {
            session_id: "daemon-1".into(),
            timeout_ms: 6000
        }
        .validate()
        .is_err());
        let prompt = |text| FleetAction::Send {
            session_id: "daemon-1".into(),
            text,
            mode: "now".into(),
            request_id: "bounded-prompt".into(),
        };
        assert!(prompt("中".repeat(8192)).validate().is_ok());
        assert!(prompt("中".repeat(8193)).validate().is_err());
        assert!(FleetAction::ReadOutput {
            session_id: "daemon-1".into(),
            cursor: 0,
            max_bytes: 32769
        }
        .validate()
        .is_err());
    }
    #[test]
    fn remote_permissions_are_intersected_with_the_local_workspace_grant() {
        let mut value = json!({"sessions":[{"access":"control","readOutput":true}],"enabled":true});
        intersect_scopes(
            &mut value,
            &Scopes {
                fleet_observe: true,
                ..Default::default()
            },
        );
        assert_eq!(value["sessions"][0]["access"], "metadata");
        assert_eq!(value["sessions"][0]["readOutput"], false);
        assert_eq!(value["enabled"], false);
    }
}
