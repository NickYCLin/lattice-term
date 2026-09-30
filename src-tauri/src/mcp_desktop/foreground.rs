//! Sharing an existing desktop PTY never starts, resumes or replaces an agent.
//! All grants are process-local, off by default, and bound to its registry entry.
use super::*;
use crate::agent::{self, AgentRegistry, AgentSessionSummary, AgentSink};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DesktopAgentAction {
    State {},
    Read {
        #[serde(default)]
        cursor: u64,
        #[serde(default = "read_limit")]
        max_bytes: usize,
    },
    Prompt {
        text: String,
        request_id: String,
    },
}
fn read_limit() -> usize {
    16384
}
impl DesktopAgentAction {
    pub(super) fn scope(&self) -> Scope {
        match self {
            Self::State {} => Scope::FleetObserve,
            Self::Read { .. } => Scope::FleetRead,
            Self::Prompt { .. } => Scope::FleetControl,
        }
    }
    pub(super) fn request_id(&self) -> Option<&str> {
        match self {
            Self::Prompt { request_id, .. } => Some(request_id),
            _ => None,
        }
    }
    pub(super) fn validate(&self) -> Result<(), ServiceError> {
        match self {
            Self::Read { max_bytes, .. } if !(1..=65536).contains(max_bytes) => {
                Err(ServiceError::invalid())
            }
            Self::Prompt { text, request_id } => {
                valid_id(request_id)?;
                if text.trim().is_empty()
                    || text.chars().count() > 16000
                    || text
                        .chars()
                        .any(|c| c.is_control() && c != '\n' && c != '\t')
                {
                    return Err(ServiceError::invalid());
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }
}

pub(super) fn validate_grant(request: &GrantRequest) -> Result<(), ServiceError> {
    let s = &request.scopes;
    if !label(&request.label)
        || request.session_id.is_empty()
        || request.session_id.len() > 128
        || !s.fleet_observe
        || s.fleet_launch
        || s.metrics
        || s.list
        || s.exec
        || s.command
        || s.upload
        || s.download
        || s.screen
        || s.input
        || request.fleet.is_some()
        || !request.roots.is_empty()
        || !request.exec_plans.is_empty()
    {
        return Err(ServiceError::invalid());
    }
    Ok(())
}

/// These fields are derived from configuration, never from a display label.
/// A launch effort is deliberately not presented as a verified current effort.
fn launch_identity(summary: &AgentSessionSummary) -> Value {
    let provider_arguments: Vec<String> = summary
        .launch_arguments
        .windows(2)
        .filter(|pair| {
            (pair[0] == "-c" || pair[0] == "--config")
                && (pair[1].starts_with("model_provider=")
                    || pair[1].starts_with("model_providers."))
        })
        .flat_map(|pair| ["-c".to_owned(), pair[1].clone()])
        .collect();
    let proxy = if summary.definition_id == "codex" {
        crate::cliproxy::launch::base_from_arguments(&provider_arguments)
            .ok()
            .flatten()
    } else {
        None
    };
    let mut effort = None;
    for pair in summary.launch_arguments.windows(2) {
        if pair[0] == "-c" || pair[0] == "--config" {
            if let Ok(value) = pair[1].parse::<toml::Table>() {
                if let Some(v) = value
                    .get("model_reasoning_effort")
                    .and_then(toml::Value::as_str)
                {
                    if matches!(v, "none" | "minimal" | "low" | "medium" | "high" | "xhigh") {
                        effort = Some(v.to_owned());
                    }
                }
            }
        }
    }
    json!({"provider": proxy.as_ref().map(|p| json!({"kind":"cliProxyApi","id":p.id})),
        "launchEffort":effort,"configurationSource":"launchArguments",
        "currentEffortVerified":false})
}

impl DesktopService {
    pub fn with_foreground_agents(
        mut self,
        registry: Arc<AgentRegistry>,
        sink: Arc<dyn AgentSink>,
    ) -> Self {
        self.foreground = Some((registry, sink));
        self
    }

    pub fn foreground_shared(&self) -> Vec<crate::agent_daemon::SharedSession> {
        let Ok(state) = self.state.lock() else {
            return vec![];
        };
        state
            .grants
            .values()
            .filter(|g| g.view.backend == Backend::DesktopAgent && self.connected(g))
            .map(|g| crate::agent_daemon::SharedSession {
                session_id: g.session_id.clone(),
                read_output: g.view.scopes.fleet_read,
                control: g.view.scopes.fleet_control,
                activity: None,
            })
            .collect()
    }

    /// Called only by the person's desktop sharing controls, never by MCP.
    pub async fn share_foreground(
        &self,
        session_id: &str,
        shared: bool,
        read: bool,
        control: bool,
    ) -> Result<(), ServiceError> {
        let (registry, sink) = self
            .foreground
            .as_ref()
            .ok_or_else(ServiceError::unavailable)?;
        let previous: Vec<_> = self
            .state
            .lock()
            .map_err(|_| ServiceError::failed())?
            .grants
            .values()
            .filter(|g| g.view.backend == Backend::DesktopAgent && g.session_id == session_id)
            .map(|g| g.view.id.clone())
            .collect();
        // Replacing a grant gets a new target, invalidating cached reads and writes.
        for id in previous {
            self.revoke(&id)?;
        }
        if !shared {
            return Ok(());
        }
        let summary = registry
            .session_summary(session_id)
            .ok_or_else(ServiceError::unavailable)?;
        let view = self
            .grant(GrantRequest {
                session_id: session_id.into(),
                backend: Backend::DesktopAgent,
                label: summary.group_label,
                scopes: Scopes {
                    fleet_observe: true,
                    fleet_read: read,
                    fleet_control: control,
                    ..Scopes::default()
                },
                exec_plans: vec![],
                roots: vec![],
                fleet: None,
            })
            .await?;
        if let Err(error) = agent::set_mcp_control(sink.as_ref(), registry, session_id, control) {
            let _ = self.revoke(&view.id);
            return Err(ServiceError::new("failed", &error));
        }
        Ok(())
    }

    pub(super) async fn execute_desktop_agent(
        &self,
        grant: &Grant,
        action: &DesktopAgentAction,
    ) -> Result<Value, ServiceError> {
        let (registry, sink) = self
            .foreground
            .as_ref()
            .ok_or_else(ServiceError::unavailable)?;
        if !self.connected(grant) {
            return Err(ServiceError::unavailable());
        }
        let summary = registry
            .session_summary(&grant.session_id)
            .ok_or_else(ServiceError::unavailable)?;
        match action {
            DesktopAgentAction::State {} => {
                Ok(json!({"sessionId":summary.session_id,"source":"desktop",
                "conversationId":summary.captured_session_id,"label":summary.group_label,
                "definitionId":summary.definition_id,"model":summary.model,"workingDirectory":summary.working_directory,
                "state":summary.state,"stateSource":summary.state_source,"queuedPrompts":summary.queued_prompts,
                "configuration":launch_identity(&summary),"readOutput":grant.view.scopes.fleet_read,"control":grant.view.scopes.fleet_control}))
            }
            DesktopAgentAction::Read { cursor, max_bytes } => {
                let range = registry
                    .output_range(&grant.session_id, *cursor, max_bytes.saturating_add(4096))
                    .map_err(|_| ServiceError::unavailable())?;
                Ok(crate::agent_daemon::mcp::render_range(
                    range, true, *max_bytes,
                ))
            }
            DesktopAgentAction::Prompt { text, .. } => {
                let registry = Arc::clone(registry);
                let sink = Arc::clone(sink);
                let session_id = grant.session_id.clone();
                let text = text.clone();
                let revoked = grant.revoked.subscribe();
                let queued = tokio::task::spawn_blocking(move || {
                    if *revoked.borrow() { return Err(agent::MCP_GRANT_CHANGED.to_owned()); }
                    agent::mcp_prompt(sink.as_ref(), &registry, &session_id, &text, true)
                }).await.map_err(|_| ServiceError::new("unknown_outcome", "The prompt worker ended without confirming delivery; inspect output and reuse the same requestId."))?
                        .map_err(|error| {
                            let code = match error.as_str() {
                                agent::MCP_NOT_CONTROLLED | agent::MCP_GRANT_CHANGED => {
                                    "not_authorized"
                                }
                                agent::MCP_NOT_READY | agent::MCP_QUEUE_IN_ORDER => "not_ready",
                                agent::MCP_DRAFT_RECOVERY_ERROR => "unknown_outcome",
                                agent::MCP_INPUT_PROFILE_UNSUPPORTED => "unsupported",
                                agent::MCP_SESSION_GONE => "not_found",
                                _ => "failed",
                            };
                            ServiceError::new(code, &error)
                        })?;
                Ok(
                    json!({"sessionId":grant.session_id,"sentImmediately":queued == 0,"queued":queued,"duplicate":false}),
                )
            }
        }
    }
}
