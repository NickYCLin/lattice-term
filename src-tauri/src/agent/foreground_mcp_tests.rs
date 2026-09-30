use crate::mcp_desktop::{DesktopAgentAction as Action, DesktopOperation as Op, DesktopService};

struct ForegroundFixture {
    service: Arc<DesktopService>,
    registry: Arc<AgentRegistry>,
    sink: Arc<dyn AgentSink>,
    id: String,
}
impl ForegroundFixture {
    fn new() -> Self {
        let sink: Arc<dyn AgentSink> = Arc::new(TestSink::default());
        let registry = Arc::new(AgentRegistry::new());
        let session = launch_cat(&sink, &registry, "Existing proxy conversation");
        let entry = registry.get(&session.session_id).unwrap();
        {
            let mut summary = entry.summary.lock().unwrap();
            summary.definition_id = "codex".into();
            summary.model = Some("claude-opus-5-5".into());
            summary.captured_session_id = Some("00000000-0000-4000-8000-000000000001".into());
            summary.launch_arguments = vec!["-c".into(), "model_provider=latticeterm_cliproxyapi".into(),
                "-c".into(), "model_providers.latticeterm_cliproxyapi.base_url=\"http://localhost:8317/v1\"".into(),
                "-c".into(), "model_reasoning_effort=\"medium\"".into()];
        }
        entry.output.lock().unwrap().append("existing history 繁中\n".as_bytes());
        registry.update_state(&session.session_id, AgentLifecycle::Idle, AgentStateSource::Integration);
        let service = Arc::new(DesktopService::new(Arc::new(crate::ssh::SshRegistry::new()), Arc::new(crate::sftp::SftpRegistry::new()))
            .with_foreground_agents(registry.clone(), sink.clone()));
        Self { service, registry, sink, id:session.session_id }
    }
    async fn share(&self, read: bool, control: bool) -> String {
        self.service.share_foreground(&self.id, true, read, control).await.unwrap();
        self.service.targets().into_iter().find(|t|t.connected).unwrap().id
    }
    async fn call(&self, target: &str, action: Action) -> Result<serde_json::Value, crate::mcp_desktop::ServiceError> {
        self.service.execute("foreground-test", Op::DesktopAgent { target_id:target.into(), action }).await
    }
}
impl Drop for ForegroundFixture { fn drop(&mut self) { self.registry.stop_all(); } }

#[tokio::test(flavor="multi_thread", worker_threads=2)]
async fn desktop_mcp_shares_original_identity_and_separates_read_from_control() {
    let f = ForegroundFixture::new();
    assert!(f.service.targets().is_empty());
    assert!(f.call("unshared", Action::State {}).await.is_err());
    let pid = f.registry.session_summary(&f.id).unwrap().process_id;
    let target = f.share(false, false).await;
    let state = f.call(&target, Action::State {}).await.unwrap();
    assert_eq!(state["sessionId"], f.id);
    assert_eq!(state["source"], "desktop");
    assert_eq!(state["model"], "claude-opus-5-5");
    assert_eq!(state["configuration"]["provider"]["kind"], "cliProxyApi");
    assert_eq!(state["configuration"]["launchEffort"], "medium");
    assert_eq!(state["configuration"]["currentEffortVerified"], false);
    assert!(!state.to_string().contains("8317"));
    assert!(f.call(&target, Action::Read {cursor:0,max_bytes:1024}).await.is_err());
    let target = f.share(true, false).await;
    let read = f.call(&target, Action::Read {cursor:0,max_bytes:1024}).await.unwrap();
    assert!(read["text"].as_str().unwrap().contains("existing history 繁中"));
    assert!(f.call(&target, Action::Prompt {text:"read only cannot send".into(),request_id:"denied".into()}).await.is_err());
    assert_eq!(f.registry.list().len(),1);
    assert_eq!(f.registry.session_summary(&f.id).unwrap().process_id,pid);
}

#[tokio::test(flavor="multi_thread", worker_threads=2)]
async fn desktop_mcp_prompt_is_ready_checked_and_deduplicated() {
    let f = ForegroundFixture::new();
    let target = f.share(true,true).await;
    f.registry.update_state(&f.id,AgentLifecycle::Working,AgentStateSource::Integration);
    assert!(f.call(&target,Action::Prompt {text:"busy".into(),request_id:"busy".into()}).await.is_err());
    f.registry.update_state(&f.id,AgentLifecycle::Idle,AgentStateSource::Heuristic);
    assert!(f.call(&target,Action::Prompt {text:"heuristic".into(),request_id:"heuristic".into()}).await.is_err());
    f.registry.update_state(&f.id,AgentLifecycle::Idle,AgentStateSource::Integration);
    f.registry.get(&f.id).unwrap().input.lock().unwrap().desktop_editing = true;
    assert!(f.call(&target,Action::Prompt {text:"unfinished input".into(),request_id:"editing".into()}).await.is_err());
    f.registry.get(&f.id).unwrap().input.lock().unwrap().desktop_editing = false;
    let action = Action::Prompt {text:"single authorised prompt".into(),request_id:"one-prompt".into()};
    let sent = f.call(&target,action.clone()).await.unwrap();
    assert_eq!(sent["sentImmediately"],true);
    let replay = f.call(&target,action).await.unwrap();
    assert_eq!(replay["duplicate"],true);
    assert!(f.call(&target,Action::Prompt {text:"different prompt".into(),request_id:"one-prompt".into()}).await.is_err());
    assert_eq!(f.registry.list().len(),1);
}

#[tokio::test(flavor="multi_thread", worker_threads=2)]
async fn desktop_mcp_revoke_and_close_never_reuse_authority() {
    let f = ForegroundFixture::new();
    let original = f.share(true,true).await;
    f.service.revoke(&original).unwrap(); // also used when the desktop bridge disconnects
    assert!(mcp_prompt(f.sink.as_ref(), &f.registry, &f.id,"after revocation",true).is_err());
    assert!(f.call(&original,Action::Read {cursor:0,max_bytes:1024}).await.is_err());
    let replacement = f.share(true,false).await;
    assert_ne!(original,replacement);
    assert!(f.call(&original,Action::State {}).await.is_err());
    assert!(f.call(&replacement,Action::State {}).await.is_ok());
    disconnect(f.sink.as_ref(),&f.registry,&f.id).unwrap();
    assert!(f.call(&replacement,Action::Read {cursor:0,max_bytes:1024}).await.is_err());
    assert!(f.service.foreground_shared().is_empty());
    assert!(f.service.targets().iter().all(|t|!t.connected));
}

#[tokio::test]
async fn desktop_mcp_readiness_reports_exact_gates_without_clearing_them() {
    let f = ForegroundFixture::new();
    let target = f.share(true,true).await;
    let state = f.call(&target,Action::State {}).await.unwrap();
    assert_eq!(state["promptReadiness"]["ready"],true);
    let entry = f.registry.get(&f.id).unwrap();
    {
        let mut input = entry.input.lock().unwrap();
        input.desktop_editing = true;
        input.desktop_paste = true;
        input.desktop_escape = vec![27];
        input.startup_seed_pending = true;
    }
    let state = f.call(&target,Action::State {}).await.unwrap();
    assert_eq!(state["promptReadiness"]["blockers"],serde_json::json!([
        "desktop_editing","desktop_paste_incomplete","desktop_escape_incomplete","startup_seed_pending"
    ]));
    assert!(entry.input.lock().unwrap().desktop_busy());
    assert_eq!(mcp_prompt(f.sink.as_ref(),&f.registry,&f.id,"must remain blocked",true).unwrap_err(),MCP_NOT_READY);
    { let mut summary = entry.summary.lock().unwrap(); summary.state = AgentLifecycle::Working; summary.state_source = AgentStateSource::Heuristic; }
    assert!(f.registry.mcp_prompt_blockers(&f.id).unwrap().contains(&"integration_not_reported"));
    f.registry.update_state(&f.id,AgentLifecycle::Working,AgentStateSource::Integration);
    assert!(f.registry.mcp_prompt_blockers(&f.id).unwrap().contains(&"lifecycle_not_ready"));
}

#[test]
fn foreground_input_diagnostics_do_not_treat_keys_as_readiness() {
    let mut input = AgentInputControl::default();
    observe_desktop_input(&mut input, b"draft");
    assert!(input.desktop_busy());
    observe_desktop_input(&mut input, b"\x1b[I");
    assert_eq!(input.last_input_kind, Some("terminal_status_reply"));
    assert!(input.desktop_busy());
    observe_desktop_input(&mut input, b"\r");
    assert!(!input.desktop_busy());
    observe_desktop_input(&mut input, b"\x1b[13u");
    assert_eq!(input.last_input_kind, Some("extended_keyboard_event"));
    assert!(input.desktop_busy());
    observe_desktop_input(&mut input, b"\r");
    observe_desktop_input(&mut input, b"\x1b[<0;10;20M");
    assert_eq!(input.last_input_kind, Some("mouse_or_unknown_csi"));
    assert!(input.desktop_busy());
}
