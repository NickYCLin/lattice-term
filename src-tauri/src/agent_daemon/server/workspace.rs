//! A connection may narrow existing MCP grants to one canonical workspace.
//! This is a routing boundary, not an OS sandbox for the user's CLI.
use super::*;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

pub(super) const DENIED: &str =
    "not_authorized: this session or launch plan is outside the approved workspace";

pub(super) struct Workspace {
    root: PathBuf,
    observed: Mutex<HashSet<String>>,
}
impl Workspace {
    pub fn new(directory: &str) -> Result<Self, String> {
        #[cfg(windows)]
        if !crate::mcp_desktop::valid_windows_workspace_path(directory) {
            return Err(DENIED.into());
        }
        let path = Path::new(directory);
        if directory.len() > 4096 || directory.chars().any(char::is_control) || !path.is_absolute()
        {
            return Err(DENIED.into());
        }
        let root = path.canonicalize().map_err(|_| DENIED)?;
        if !root.is_dir() || root.parent().is_none() {
            return Err(DENIED.into());
        }
        Ok(Self {
            root,
            observed: Mutex::new(HashSet::new()),
        })
    }
    pub fn client_identity(&self, client: &str) -> String {
        let mut hash = Sha256::new();
        hash.update(self.root.as_os_str().as_encoded_bytes());
        hash.update([0]);
        hash.update(client.as_bytes());
        let digest = hash.finalize();
        let suffix: String = digest[..12]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        format!(
            "{} [workspace-{suffix}]",
            client.chars().take(48).collect::<String>()
        )
    }
    pub fn contains(&self, directory: &str) -> bool {
        #[cfg(windows)]
        if !crate::mcp_desktop::valid_windows_workspace_path(
            directory.strip_prefix(r"\\?\").unwrap_or(directory),
        ) {
            return false;
        }
        // Replacing the approved root with a symlink cannot broaden a live grant.
        self.root.canonicalize().ok().as_ref() == Some(&self.root)
            && Path::new(directory)
                .canonicalize()
                .ok()
                .is_some_and(|path| path.starts_with(&self.root))
    }
    fn remember(&self, id: &str) -> bool {
        let Ok(mut observed) = self.observed.lock() else {
            return false;
        };
        if observed.contains(id) {
            return true;
        }
        if observed.len() >= 4096 {
            return false;
        }
        observed.insert(id.to_owned());
        true
    }
    pub fn allows_frame(&self, line: &str) -> bool {
        let Ok(frame) = serde_json::from_str::<Frame>(line) else {
            return false;
        };
        match frame {
            Frame::Event { payload, .. } => payload["sessionId"]
                .as_str()
                .is_some_and(|id| self.observed.lock().is_ok_and(|known| known.contains(id))),
            _ => true,
        }
    }
}

pub(super) fn allows_session(context: &Context, summary: &AgentSessionSummary) -> bool {
    context.workspace.as_ref().is_none_or(|scope| {
        scope.contains(&summary.working_directory) && scope.remember(&summary.session_id)
    })
}

pub(super) fn authorize_plan(context: &Context, plan: &McpPlan) -> Result<(), String> {
    if context.workspace.as_ref().is_none_or(|scope| {
        scope.contains(&plan.working_directory) && scope.contains(&plan.request.working_directory)
    }) {
        Ok(())
    } else {
        Err(DENIED.into())
    }
}

pub(super) fn authorize(context: &Context, request: &Request) -> Result<(), String> {
    if context.workspace.is_none() {
        return Ok(());
    }
    match request {
        // Missing sessions can only replay a matching cached termination;
        // a fresh request still fails require_control in the shared handler.
        // The handshake binds the deduplication client to this canonical root.
        Request::Cancel {
            session_id,
            scope: super::super::CancelScope::Session,
            ..
        } if context.registry.session_summary(session_id).is_none() => Ok(()),
        Request::Sessions | Request::Plans => Ok(()),
        Request::Observe { session_id, .. }
        | Request::Prompt { session_id, .. }
        | Request::Cancel { session_id, .. } => {
            if context
                .registry
                .session_summary(session_id)
                .is_some_and(|s| allows_session(context, &s))
            {
                Ok(())
            } else {
                Err(DENIED.into())
            }
        }
        Request::LaunchPlan { plan_id, .. } => {
            let plan = context.sink.plan(plan_id).ok_or(DENIED)?;
            authorize_plan(context, &plan)
        }
        _ => Err(DENIED.into()),
    }
}

pub(super) fn plans_view(context: &Context, client: &str) -> Value {
    let mut value = context.sink.plans_view(&context.registry, client);
    if context.workspace.is_some() {
        if let Some(plans) = value["plans"].as_array_mut() {
            plans.retain(|view| {
                view["planId"]
                    .as_str()
                    .and_then(|id| context.sink.plan(id))
                    .is_some_and(|plan| authorize_plan(context, &plan).is_ok())
            });
        }
        // Limits are global, but counts for other workspaces are not disclosed.
        if let Some(object) = value.as_object_mut() {
            object.remove("launchedTotal");
            object.remove("launchedByYou");
        }
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_workspace_rejects_siblings_and_only_reports_observed_events() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        let sibling = temp.path().join("project-other");
        std::fs::create_dir(&project).unwrap();
        std::fs::create_dir(&sibling).unwrap();
        let scope = Workspace::new(project.to_str().unwrap()).unwrap();
        assert!(scope.contains(project.to_str().unwrap()));
        assert!(!scope.contains(sibling.to_str().unwrap()));
        let event = r#"{"kind":"event","name":"state","payload":{"sessionId":"one"}}"#;
        assert!(!scope.allows_frame(event));
        assert!(scope.remember("one"));
        assert!(scope.allows_frame(event));
        assert!(Workspace::new("relative").is_err());
    }
    #[cfg(windows)]
    #[test]
    fn windows_workspace_rejects_network_roots_and_junction_escapes() {
        assert!(Workspace::new(r"\\host\share\work").is_err());
        assert!(Workspace::new(r"C:\").is_err());
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("approved");
        let outside = temp.path().join("private");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&outside).unwrap();
        let scope = Workspace::new(root.to_str().unwrap()).unwrap();
        assert!(scope.contains(root.to_str().unwrap()));
        let upper = root.to_string_lossy().to_uppercase();
        if Path::new(&upper).exists() {
            assert!(scope.contains(&upper));
        }
        let link = root.join("junction");
        let output = std::process::Command::new(std::env::var_os("ComSpec").unwrap())
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .output()
            .unwrap();
        assert!(output.status.success(), "owned junction fixture failed");
        assert!(!scope.contains(link.to_str().unwrap()));
        assert!(!scope.contains(outside.to_str().unwrap()));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_and_replaced_root_cannot_broaden_scope() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        let outside = temp.path().join("outside");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&outside).unwrap();
        let scope = Workspace::new(root.to_str().unwrap()).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("escape")).unwrap();
        assert!(!scope.contains(root.join("escape").to_str().unwrap()));
        std::fs::rename(&root, temp.path().join("old")).unwrap();
        std::os::unix::fs::symlink(&outside, &root).unwrap();
        assert!(!scope.contains(root.to_str().unwrap()));
    }
    #[cfg(unix)]
    #[test]
    fn multiple_real_ptys_remain_independent_and_outside_workspaces_are_denied() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("approved");
        let outside = temp.path().join("private");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&outside).unwrap();
        let sink = Arc::new(DaemonSink::default());
        let registry = AgentRegistry::with_local_reporter_prefixed(
            Arc::clone(&sink) as Arc<dyn AgentSink>,
            SESSION_ID_PREFIX,
        )
        .unwrap();
        struct Stop(Arc<AgentRegistry>);
        impl Drop for Stop {
            fn drop(&mut self) {
                self.0.stop_all();
            }
        }
        let _stop = Stop(Arc::clone(&registry));
        let context = Context {
            workspace: Some(Arc::new(Workspace::new(root.to_str().unwrap()).unwrap())),
            registry: Arc::clone(&registry),
            sink: Arc::clone(&sink),
            scheduler: Arc::new(Scheduler::open(temp.path())),
            chat: Arc::new(AgentChatRegistry::new()),
            token: String::new(),
            shutdown: Arc::new(Notify::new()),
            log: Arc::new(Logger::silent()),
        };
        let plan = |id: &str, path: &Path| -> McpPlan {
            serde_json::from_value(json!({
            "planId":id,"label":id,"note":"","definitionId":"custom","workingDirectory":path,"sandbox":false,
            "request":{"definitionId":"custom","label":id,"executable":"/bin/cat","workingDirectory":path,"cols":80,"rows":24}
        })).unwrap()
        };
        sink.plans_replace(
            true,
            vec![
                plan("first", &root),
                plan("second", &root),
                plan("outside", &outside),
            ],
        );
        let call = |body| dispatch_as(&context, ClientRole::Observer, "scoped-test", body);
        let launch = |id: &str| Request::LaunchPlan {
            plan_id: id.into(),
            request_id: format!("launch-{id}"),
        };
        assert_eq!(
            call(Request::Plans).unwrap()["plans"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert!(call(launch("outside"))
            .unwrap_err()
            .starts_with("not_authorized:"));
        let first = call(launch("first")).unwrap()["sessionId"]
            .as_str()
            .unwrap()
            .to_owned();
        let second = call(launch("second")).unwrap()["sessionId"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_ne!(first, second);
        let mut unscoped = context.clone();
        unscoped.workspace = None;
        let private = dispatch_as(&unscoped, ClientRole::Observer, "owner", launch("outside"))
            .unwrap()["sessionId"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(
            call(Request::Sessions).unwrap().as_array().unwrap().len(),
            2
        );
        assert!(call(Request::Observe {
            session_id: private.clone(),
            cursor: 0,
            max_bytes: 256
        })
        .is_err());
        assert!(call(Request::Observe {
            session_id: first.clone(),
            cursor: 0,
            max_bytes: 256
        })
        .is_ok());
        sink.set_shared_output(&second, true, Some(false));
        assert!(call(Request::Observe {
            session_id: second.clone(),
            cursor: 0,
            max_bytes: 256
        })
        .is_err());
        let stop = || Request::Cancel {
            session_id: first.clone(),
            scope: super::super::super::CancelScope::Session,
            request_id: "stop-first".into(),
        };
        assert!(call(stop()).is_ok());
        assert_eq!(call(stop()).unwrap()["duplicate"], true);
        assert!(registry.session_summary(&first).is_none());
        assert!(registry.session_summary(&second).is_some());
        assert!(registry.session_summary(&private).is_some());
        assert_ne!(
            context
                .workspace
                .as_ref()
                .unwrap()
                .client_identity("same client"),
            Workspace::new(outside.to_str().unwrap())
                .unwrap()
                .client_identity("same client")
        );
    }
}
