use super::*;
use crate::agent_project_launch::ProjectLaunchPolicy;

fn context(dir: &Path) -> Context {
    Context {
        workspace: None,
        registry: Arc::new(AgentRegistry::new()),
        sink: Arc::new(DaemonSink::default()),
        scheduler: Arc::new(Scheduler::open(dir)),
        chat: Arc::new(AgentChatRegistry::new()),
        token: "fixture".into(),
        shutdown: Arc::new(Notify::new()),
        log: Arc::new(Logger::silent()),
    }
}
fn grant(context: &Context, root: &Path) {
    dispatch(
        context,
        Request::McpPlansReplace {
            enabled: false,
            plans: vec![],
            project_policy: ProjectLaunchPolicy {
                enabled: true,
                roots: vec![root.display().to_string()],
                full_permissions: true,
            },
        },
    )
    .unwrap();
}
fn launch_request(root: &Path, id: &str) -> Request {
    Request::LaunchProject {
        working_directory: root.display().to_string(),
        cli: "codex".into(),
        plan_id: None,
        request_id: id.into(),
    }
}
fn fixture_launch(
    context: &Context,
    mut request: agent::AgentLaunchRequest,
) -> Result<AgentSessionSummary, String> {
    assert_eq!(
        request.arguments,
        [
            "--ask-for-approval",
            "never",
            "--sandbox",
            "danger-full-access"
        ]
    );
    assert!(!request.sandbox);
    assert!(!request.restore_existing_session);
    request.definition_id = "custom".into();
    request.label = "Project fixture".into();
    request.executable = "/bin/cat".into();
    request.arguments.clear();
    agent::launch_with_replay(
        context.sink.clone(),
        context.registry.clone(),
        request,
        None,
    )
}
#[test]
fn observers_cannot_configure_project_grants_or_start_without_a_grant() {
    let root = tempfile::tempdir().unwrap();
    let context = context(root.path());
    assert!(dispatch_as(
        &context,
        ClientRole::Observer,
        "client",
        launch_request(root.path(), "denied")
    )
    .is_err());
    assert!(dispatch_as(
        &context,
        ClientRole::Observer,
        "client",
        Request::McpPlansReplace {
            enabled: false,
            plans: vec![],
            project_policy: ProjectLaunchPolicy::default(),
        }
    )
    .is_err());
    grant(&context, root.path());
    let outside = tempfile::tempdir().unwrap();
    assert!(dispatch_as(
        &context,
        ClientRole::Observer,
        "client",
        launch_request(outside.path(), "outside")
    )
    .is_err());
    assert!(dispatch_as(
        &context,
        ClientRole::Observer,
        "client",
        launch_request(&root.path().join("../escape"), "traversal")
    )
    .is_err());
    assert_eq!(context.registry.list().len(), 0);
}
#[tokio::test]
async fn project_launch_replays_one_pty_preserves_permissions_and_records_redacted_metadata() {
    let root = tempfile::tempdir().unwrap();
    let context = context(root.path());
    grant(&context, root.path());
    let directory = root.path().display().to_string();
    let identity = json!(["projectLaunch", directory, "codex", null]);
    let launched = once(
        &context,
        "client",
        "one",
        &identity,
        || project_request(&context, &directory, "codex", None).map(|_| ()),
        || {
            launch_project_with(&context, "client", &directory, "codex", None, |request| {
                fixture_launch(&context, request)
            })
        },
        |_| Ok(()),
    )
    .unwrap();
    let id = launched["sessionId"].as_str().unwrap();
    assert!(context.sink.is_shared(id));
    assert!(context.sink.has_control(id));
    assert!(context.sink.output_access(id).is_ok());
    let replay = dispatch_as(
        &context,
        ClientRole::Observer,
        "client",
        launch_request(root.path(), "one"),
    )
    .unwrap();
    assert_eq!(replay["sessionId"], id);
    assert_eq!(replay["duplicate"], true);
    assert_eq!(context.registry.list().len(), 1);
    context.sink.set_shared_output(id, true, Some(false));
    assert_eq!(
        dispatch_as(
            &context,
            ClientRole::Observer,
            "client",
            launch_request(root.path(), "one")
        )
        .unwrap()["mcpReadOutput"],
        false
    );
    let changed = Request::LaunchProject {
        working_directory: directory.clone(),
        cli: "claude".into(),
        plan_id: None,
        request_id: "one".into(),
    };
    assert!(
        dispatch_as(&context, ClientRole::Observer, "client", changed)
            .unwrap_err()
            .contains("different operation")
    );
    let history = context.sink.history.lock().unwrap().snapshot();
    for action in [audit::Action::CreatePlan, audit::Action::Launch] {
        let entry = history
            .entries
            .iter()
            .find(|e| e.action == action && e.project_launch.is_some())
            .unwrap();
        assert!(entry.at > 0);
        assert_eq!(entry.client, "client");
        let metadata = entry.project_launch.as_ref().unwrap();
        assert_eq!(metadata.working_directory, directory);
        assert_eq!(metadata.cli, "codex");
        assert_eq!(metadata.permission, "full");
    }
    assert!(!serde_json::to_string(&history)
        .unwrap()
        .contains("--ask-for-approval"));
    // Revocation also rejects a previously cached successful response.
    dispatch(
        &context,
        Request::McpPlansReplace {
            enabled: false,
            plans: vec![],
            project_policy: Default::default(),
        },
    )
    .unwrap();
    assert!(dispatch_as(
        &context,
        ClientRole::Observer,
        "client",
        launch_request(root.path(), "one")
    )
    .is_err());
    context.registry.stop_all();
}
#[tokio::test]
async fn project_launch_enforces_both_shared_limits_before_spawning() {
    let root = tempfile::tempdir().unwrap();
    let context = context(root.path());
    grant(&context, root.path());
    let directory = root.path().to_str().unwrap();
    for client in ["first", "second"] {
        for _ in 0..MAX_LAUNCHED_PER_CLIENT {
            launch_project_with(&context, client, directory, "codex", None, |request| {
                fixture_launch(&context, request)
            })
            .unwrap();
        }
        assert!(
            launch_project_with(&context, client, directory, "codex", None, |_| panic!(
                "must not spawn over client ceiling"
            ))
            .unwrap_err()
            .contains(LAUNCH_LIMIT_REACHED)
        );
    }
    assert!(
        launch_project_with(&context, "third", directory, "codex", None, |_| panic!(
            "must not spawn over global ceiling"
        ))
        .unwrap_err()
        .contains(LAUNCH_LIMIT_REACHED)
    );
    context.registry.stop_all();
}
#[tokio::test]
async fn changing_project_grant_during_spawn_stops_the_new_session() {
    let root = tempfile::tempdir().unwrap();
    let context = context(root.path());
    grant(&context, root.path());
    assert!(launch_project_with(
        &context,
        "client",
        root.path().to_str().unwrap(),
        "codex",
        None,
        |request| {
            let summary = fixture_launch(&context, request)?;
            dispatch(
                &context,
                Request::McpPlansReplace {
                    enabled: false,
                    plans: vec![],
                    project_policy: Default::default(),
                },
            )?;
            Ok(summary)
        }
    )
    .is_err());
    assert!(context.registry.list().is_empty());
}
#[test]
fn failed_project_spawn_has_creation_and_failure_audit_without_raw_errors() {
    let root = tempfile::tempdir().unwrap();
    let context = context(root.path());
    grant(&context, root.path());
    assert!(launch_project_with(
        &context,
        "client",
        root.path().to_str().unwrap(),
        "gemini",
        None,
        |_| Err("private failure body".into())
    )
    .is_err());
    let history = context.sink.history.lock().unwrap().snapshot();
    assert_eq!(history.entries.len(), 2);
    assert_eq!(history.entries[0].outcome, audit::Outcome::Failed);
    assert!(history
        .entries
        .iter()
        .all(|entry| entry.project_launch.is_some()));
    assert!(!serde_json::to_string(&history)
        .unwrap()
        .contains("private failure body"));
}
