//! Explicit host-lifetime access to existing desktop and daemon PTYs.
use crate::agent::{AgentRegistry, AgentSessionSummary};
use lattice_remote::chat_protocol::ChatOperation;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Manager};

// 100 summaries remain comfortably below the encrypted response limit.
fn label(value: &str) -> String {
    let mut output = String::new();
    for c in value.chars().filter(|c| !c.is_control()) {
        if output.len() + c.len_utf8() > 96 {
            break;
        }
        output.push(c);
    }
    output
}
pub struct Access {
    active: AtomicBool,
    revoked: tokio::sync::Notify,
    sessions: Mutex<HashMap<String, String>>,
}
impl Access {
    pub fn new(allowed: bool) -> Self {
        Self {
            active: AtomicBool::new(allowed),
            revoked: tokio::sync::Notify::new(),
            sessions: Mutex::new(HashMap::new()),
        }
    }
    pub fn allowed(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }
    pub fn revoke(&self) {
        self.active.store(false, Ordering::Release);
        self.revoked.notify_waiters();
    }
    fn check(&self) -> Result<(), String> {
        if self.allowed() {
            Ok(())
        } else {
            Err("CLI sharing is disabled. Enable it on the host and reconnect.".into())
        }
    }
    fn project(&self, sessions: Vec<AgentSessionSummary>) -> Result<Value, String> {
        self.check()?;
        let mut ids = self.sessions.lock().map_err(|e| e.to_string())?;
        ids.retain(|_, native| sessions.iter().any(|s| s.session_id == *native));
        let mut output = Vec::new();
        for session in sessions.into_iter().take(100) {
            let id = if let Some((id, _)) = ids
                .iter()
                .find(|(_, native)| **native == session.session_id)
            {
                id.clone()
            } else {
                let mut bytes = [0u8; 16];
                getrandom::fill(&mut bytes).map_err(|_| "Cannot identify the shared CLI.")?;
                let id: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
                ids.insert(id.clone(), session.session_id);
                id
            };
            // Do not disclose native IDs, executable arguments, account paths or PIDs.
            output.push(json!({"id": id, "label": label(&session.label), "groupLabel": label(&session.group_label), "agent": label(&session.definition_id), "state": session.state, "detached": session.detached}));
        }
        Ok(json!(output))
    }
    fn resolve(&self, id: &str) -> Result<String, String> {
        self.check()?;
        self.sessions
            .lock()
            .map_err(|e| e.to_string())?
            .get(id)
            .cloned()
            .ok_or_else(|| "The CLI is no longer available. Refresh the session list.".into())
    }
    pub async fn perform(
        &self,
        app: &AppHandle,
        operation: ChatOperation,
    ) -> Result<Value, String> {
        self.check()?;
        // Cancel a daemon attachment/read/write still waiting when sharing ends.
        // Bytes already sent to a PTY cannot be recalled.
        tokio::select! {
            biased;
            _ = self.revoked.notified() => Err("CLI sharing was revoked.".into()),
            result = self.perform_active(app, operation) => result,
        }
    }
    async fn perform_active(
        &self,
        app: &AppHandle,
        operation: ChatOperation,
    ) -> Result<Value, String> {
        self.check()?;
        let registry = app.state::<Arc<AgentRegistry>>();
        let daemon = app.state::<crate::AppDaemon>();
        if matches!(operation, ChatOperation::CliList) {
            let mut sessions = registry.list();
            sessions.extend(daemon.sessions().await);
            return self.project(sessions);
        }
        let remote_id = match &operation {
            ChatOperation::CliRead { session_id, .. }
            | ChatOperation::CliInput { session_id, .. }
            | ChatOperation::CliResize { session_id, .. } => session_id.clone(),
            _ => return Err("Not a CLI operation.".into()),
        };
        let native = self.resolve(&remote_id)?;
        let background = crate::agent_daemon::owns(&native);
        if !background {
            return self.perform_local(&registry, &crate::agent::EventSink(app.clone()), operation);
        }
        let result = match operation {
            ChatOperation::CliRead { cursor, .. } => {
                let value = daemon
                    .request(
                        false,
                        crate::agent_daemon::Request::Observe {
                            session_id: native,
                            cursor,
                            max_bytes: 24 * 1024,
                        },
                    )
                    .await?;
                let mut range: crate::agent::AgentOutputRange = serde_json::from_value(value)
                    .map_err(|_| "Cannot read the background CLI output.")?;
                range.session_id = remote_id;
                serde_json::to_value(range).map_err(|e| e.to_string())?
            }
            ChatOperation::CliInput { data, .. } => {
                use base64::Engine;
                self.check()?;
                daemon
                    .request(
                        false,
                        crate::agent_daemon::Request::Send {
                            session_id: native,
                            data: base64::engine::general_purpose::STANDARD.encode(data.as_bytes()),
                        },
                    )
                    .await?;
                Value::Null
            }
            ChatOperation::CliResize { cols, rows, .. } => {
                self.check()?;
                daemon
                    .request(
                        false,
                        crate::agent_daemon::Request::Resize {
                            session_id: native,
                            cols,
                            rows,
                        },
                    )
                    .await?;
                Value::Null
            }
            _ => return Err("Not a CLI operation.".into()),
        };
        self.check()?;
        Ok(result)
    }
    fn perform_local(
        &self,
        registry: &AgentRegistry,
        sink: &dyn crate::agent::AgentSink,
        operation: ChatOperation,
    ) -> Result<Value, String> {
        let id = match &operation {
            ChatOperation::CliRead { session_id, .. }
            | ChatOperation::CliInput { session_id, .. }
            | ChatOperation::CliResize { session_id, .. } => session_id,
            _ => return Err("Not a terminal operation.".into()),
        };
        let native = self.resolve(id)?;
        match &operation {
            ChatOperation::CliRead { cursor, .. } => {
                let mut range = registry.output_range(&native, *cursor, 24 * 1024)?;
                range.session_id = id.clone();
                serde_json::to_value(range).map_err(|e| e.to_string())
            }
            ChatOperation::CliInput { data, .. } => {
                use base64::Engine;
                crate::agent::send(
                    sink,
                    registry,
                    &native,
                    &base64::engine::general_purpose::STANDARD.encode(data.as_bytes()),
                )?;
                Ok(Value::Null)
            }
            ChatOperation::CliResize { cols, rows, .. } => {
                crate::agent::resize(registry, &native, *cols, *rows)?;
                Ok(Value::Null)
            }
            _ => unreachable!(),
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::agent::{self, AgentLifecycle, AgentSink, AgentStateSource, AgentTokenUsage};
    use base64::Engine;
    struct Sink;
    impl AgentSink for Sink {
        fn data(&self, _: &str, _: u64, _: &[u8]) {}
        fn state(&self, _: &str, _: AgentLifecycle, _: AgentStateSource) {}
        fn closed(&self, _: &str, _: &str) {}
        fn captured(&self, _: &str, _: &str) {}
        fn model(&self, _: &str, _: &str) {}
        fn usage(&self, _: &str, _: &AgentTokenUsage) {}
        fn queue(&self, _: &str, _: usize) {}
    }
    #[test]
    fn existing_pty_lists_reads_accepts_input_and_revokes_without_relaunch() {
        let registry = Arc::new(AgentRegistry::new());
        struct Cleanup(Arc<AgentRegistry>);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                self.0.stop_all();
            }
        }
        let _cleanup = Cleanup(registry.clone());
        let request = serde_json::from_value(json!({"definitionId":"custom", "label":"Existing test CLI", "executable":"/bin/cat", "workingDirectory":std::env::temp_dir(), "cols":80, "rows":24})).unwrap();
        let session = agent::launch(Arc::new(Sink), registry.clone(), request).unwrap();
        let denied = Access::new(false);
        assert!(denied.project(registry.list()).is_err());
        let access = Access::new(true);
        let list = access.project(registry.list()).unwrap();
        let id = list[0]["id"].as_str().unwrap().to_string();
        assert_ne!(id, session.session_id);
        let text = serde_json::to_string(&list).unwrap();
        for excluded in [
            "processId",
            "profileConfigPath",
            "executable",
            "launchArguments",
            "capturedSessionId",
            "workingDirectory",
        ] {
            assert!(!text.contains(excluded));
        }
        assert!(access.resolve(&session.session_id).is_err());
        assert_eq!(access.project(registry.list()).unwrap()[0]["id"], id);
        access
            .perform_local(
                &registry,
                &Sink,
                ChatOperation::CliResize {
                    session_id: id.clone(),
                    cols: 100,
                    rows: 30,
                },
            )
            .unwrap();
        access
            .perform_local(
                &registry,
                &Sink,
                ChatOperation::CliInput {
                    session_id: id.clone(),
                    data: "remote-cli-中文\r".into(),
                },
            )
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            let output = access
                .perform_local(
                    &registry,
                    &Sink,
                    ChatOperation::CliRead {
                        session_id: id.clone(),
                        cursor: 0,
                    },
                )
                .unwrap();
            assert_eq!(output["sessionId"], id);
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(output["base64"].as_str().unwrap())
                .unwrap();
            if String::from_utf8_lossy(&bytes).contains("remote-cli-中文") {
                let next = output["nextCursor"].as_u64().unwrap();
                let page = access
                    .perform_local(
                        &registry,
                        &Sink,
                        ChatOperation::CliRead {
                            session_id: id.clone(),
                            cursor: next,
                        },
                    )
                    .unwrap();
                assert_eq!(page["cursor"], next);
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "PTY did not receive input"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(registry.list()[0].process_id, session.process_id);
        access.revoke();
        assert!(access
            .perform_local(
                &registry,
                &Sink,
                ChatOperation::CliInput {
                    session_id: id.clone(),
                    data: "forbidden\r".into()
                }
            )
            .is_err());
        assert!(access.project(registry.list()).is_err());
        assert!(Access::new(true).resolve(&id).is_err());
        assert_eq!(registry.list()[0].process_id, session.process_id);
    }
}
