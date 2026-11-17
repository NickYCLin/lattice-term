use crate::mcp_desktop::{DesktopAgentAction as Action, DesktopOperation as Op, DesktopService};

struct ForegroundFixture {
    service: Arc<DesktopService>,
    registry: Arc<AgentRegistry>,
    sink: Arc<dyn AgentSink>,
    collector: Arc<TestSink>,
    id: String,
}
impl ForegroundFixture {
    fn new() -> Self {
        Self::with_resume(false)
    }
    fn with_resume(resumed: bool) -> Self {
        let collector = Arc::new(TestSink::default());
        let sink: Arc<dyn AgentSink> = collector.clone();
        let registry = Arc::new(AgentRegistry::new());
        let session = launch_cat_with_restore(&sink, &registry, "Existing proxy conversation", resumed);
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
        Self { service, registry, sink, collector, id:session.session_id }
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

impl ForegroundFixture {
    fn unreported_prompt(&self) {
        let entry = self.registry.get(&self.id).unwrap();
        { let mut summary = entry.summary.lock().unwrap();
          summary.state = AgentLifecycle::Idle;
          summary.state_source = AgentStateSource::Heuristic; }
        self.registry.record_output(&self.id, "\x1b[2J\x1b[H\x1b[?2004h\x1b[?25h› ".as_bytes()).unwrap();
        entry.prompt_screen.lock().unwrap().settle_for_test();
        *entry.last_output_at.lock().unwrap() = Instant::now() - prompt_screen::QUIET;
    }
}

#[tokio::test]
async fn resumed_history_work_markers_do_not_poison_the_first_ready_prompt() {
    let f = ForegroundFixture::with_resume(true);
    let target = f.share(true, true).await;
    f.unreported_prompt();
    let entry = f.registry.get(&f.id).unwrap();
    assert!(entry.resumed_history);
    // The PTY replays an earlier turn, then redraws an empty live composer.
    let history = b"\x1b[2J\x1b[HWorking (12s \xe2\x80\xa2 esc to interrupt)";
    f.registry.record_output(&f.id, history).unwrap();
    let state = heuristic_state_from_output(&mut entry.completion_gate.lock().unwrap(), history, false).unwrap();
    assert_eq!(state, AgentLifecycle::Working);
    f.registry.update_state_from_output(&f.id, state);
    entry.prompt_screen.lock().unwrap().settle_for_test();
    *entry.last_output_at.lock().unwrap() = Instant::now() - prompt_screen::QUIET;
    assert!(f.call(&target, Action::Prompt { mode: crate::mcp_desktop::DesktopPromptMode::Now, text:"not during replay".into(), request_id:"replay".into() }).await.is_err());
    f.registry.record_output(&f.id, "\x1b[2J\x1b[H\x1b[?2004h\x1b[?25h› ".as_bytes()).unwrap();
    assert_eq!(f.call(&target, Action::State {}).await.unwrap()["promptReadiness"]["ready"], false);
    entry.prompt_screen.lock().unwrap().settle_for_test();
    *entry.last_output_at.lock().unwrap() = Instant::now() - prompt_screen::QUIET;
    assert_eq!(f.call(&target, Action::State {}).await.unwrap()["promptReadiness"]["ready"], true);
    assert_eq!(f.call(&target, Action::State {}).await.unwrap()["promptReadiness"]["basis"], "stable_empty_resumed_terminal_prompt");
    let prompt = Action::Prompt { mode: crate::mcp_desktop::DesktopPromptMode::Now, text:"new turn after resume".into(), request_id:"resumed-once".into() };
    assert_eq!(f.call(&target, prompt.clone()).await.unwrap()["sentImmediately"], true);
    assert_eq!(f.call(&target, prompt).await.unwrap()["duplicate"], true);
    f.unreported_prompt();
    assert!(f.registry.mcp_prompt_blockers(&f.id).unwrap().contains(&"terminal_turn_unconfirmed"));
}

#[tokio::test]
async fn resumed_history_idle_watchdog_and_attention_guesses_can_settle_without_a_new_turn() {
    for state in [AgentLifecycle::Idle, AgentLifecycle::NeedsAttention] {
        let f = ForegroundFixture::with_resume(true);
        let target = f.share(true, true).await;
        f.unreported_prompt();
        // Reproduce the reader's historical Working marker and a later
        // watchdog Idle or historical approval question; neither is input.
        f.registry.update_state_from_output(&f.id, AgentLifecycle::Working);
        f.registry.update_state_from_output(&f.id, state);
        assert_eq!(f.call(&target, Action::State {}).await.unwrap()["promptReadiness"]["ready"], true);
    }
}

#[tokio::test]
async fn resumed_first_prompt_still_requires_a_safe_live_screen_and_no_real_turn() {
    for case in ["working", "approval", "draft", "unknown", "official", "submitted", "startup", "fresh"] {
        let f = ForegroundFixture::with_resume(case != "fresh");
        let target = f.share(true, true).await;
        f.unreported_prompt();
        let entry = f.registry.get(&f.id).unwrap();
        f.registry.update_state_from_output(&f.id, AgentLifecycle::Working);
        match case {
            "working" => { f.registry.record_output(&f.id, "\x1b[2J\x1b[HWorking (12s • esc to interrupt)\r\n› ".as_bytes()).unwrap(); },
            "approval" => { f.registry.approvals.open(&f.id, approval::ApprovalAsk { tool_name:"fixture".into(), summary:"approval pending".into() }, "pending".into()).unwrap(); },
            "draft" => { f.registry.record_output(&f.id, "\x1b[2J\x1b[H› unsent text".as_bytes()).unwrap(); },
            "unknown" => { f.registry.record_output(&f.id, b"\x1b[2J\x1b[Hunknown").unwrap(); },
            "official" => { f.registry.update_state(&f.id, AgentLifecycle::Working, AgentStateSource::Integration); },
            "submitted" => {
                record_sent_input(f.sink.as_ref(), &f.registry, &f.id, &entry, b"real work\r");
                // Even a clean prompt and heuristic Idle cannot confirm it.
                f.unreported_prompt();
            },
            "startup" => entry.input.lock().unwrap().startup_seed_pending = true,
            "fresh" => {},
            _ => unreachable!(),
        }
        entry.prompt_screen.lock().unwrap().settle_for_test();
        *entry.last_output_at.lock().unwrap() = Instant::now() - prompt_screen::QUIET;
        assert_eq!(f.call(&target, Action::State {}).await.unwrap()["promptReadiness"]["ready"], false, "{case}");
        assert!(f.call(&target, Action::Prompt { mode: crate::mcp_desktop::DesktopPromptMode::Now, text:"must not send".into(), request_id:format!("resume-blocked-{case}") }).await.is_err(), "{case}");
    }
}

#[tokio::test]
async fn unreported_idle_desktop_prompt_sends_once_without_releasing_background_queue_rules() {
    let f = ForegroundFixture::new();
    let target = f.share(true, true).await;
    f.unreported_prompt();
    let state = f.call(&target, Action::State {}).await.unwrap();
    assert_eq!(state["promptReadiness"]["ready"], true);
    assert_eq!(state["promptReadiness"]["basis"], "stable_empty_terminal_prompt");
    assert!(mcp_prompt(f.sink.as_ref(), &f.registry, &f.id, "background still needs integration", true).is_err());
    let prompt = Action::Prompt { mode: crate::mcp_desktop::DesktopPromptMode::Now, text:"one foreground prompt".into(), request_id:"unreported-once".into() };
    assert_eq!(f.call(&target, prompt.clone()).await.unwrap()["sentImmediately"], true);
    assert_eq!(f.call(&target, prompt).await.unwrap()["duplicate"], true);
    assert!(f.call(&target, Action::Prompt { mode: crate::mcp_desktop::DesktopPromptMode::Now, text:"changed".into(), request_id:"unreported-once".into() }).await.is_err());
    // Even if a watchdog later calls this idle, quiet cannot finish a turn.
    f.unreported_prompt();
    assert!(f.registry.mcp_prompt_blockers(&f.id).unwrap().contains(&"terminal_turn_unconfirmed"));
}

#[tokio::test]
async fn unreported_desktop_rejects_work_approval_drafts_unknown_and_unsettled_screens() {
    for case in ["working", "attention", "approval", "draft", "paste", "escape", "startup", "unknown", "output", "resize", "queue"] {
        let f = ForegroundFixture::new();
        let target = f.share(true, true).await;
        f.unreported_prompt();
        let entry = f.registry.get(&f.id).unwrap();
        match case {
            "working" => entry.summary.lock().unwrap().state = AgentLifecycle::Working,
            "attention" => entry.summary.lock().unwrap().state = AgentLifecycle::NeedsAttention,
            "approval" => { f.registry.approvals.open(&f.id, approval::ApprovalAsk { tool_name:"fixture".into(), summary:"approval pending".into() }, "pending".into()).unwrap(); },
            "draft" => entry.input.lock().unwrap().desktop_editing = true,
            "paste" => entry.input.lock().unwrap().desktop_paste = true,
            "escape" => entry.input.lock().unwrap().desktop_escape = vec![27],
            "startup" => entry.input.lock().unwrap().startup_seed_pending = true,
            "unknown" => { f.registry.record_output(&f.id, b"\x1b[2J\x1b[Hunknown").unwrap(); entry.prompt_screen.lock().unwrap().settle_for_test(); },
            "output" => { f.registry.record_output(&f.id, b"\x1b[0m").unwrap(); },
            "resize" => resize(&f.registry, &f.id, 81, 24).unwrap(),
            "queue" => entry.queued_prompts.lock().unwrap().push_back(QueuedPrompt { id:"waiting".into(), delivery_error:None, bytes:b"queued\r".to_vec(), mcp_grant_epoch:current_mcp_grant(&entry) }),
            _ => unreachable!(),
        }
        let state = f.call(&target, Action::State {}).await.unwrap();
        assert_eq!(state["promptReadiness"]["ready"], false, "{case}");
        assert!(f.call(&target, Action::Prompt { mode: crate::mcp_desktop::DesktopPromptMode::Now, text:"must not send".into(), request_id:format!("blocked-{case}") }).await.is_err(), "{case}");
    }
}

#[tokio::test]
async fn desktop_rechecks_terminal_after_state_and_preserves_official_ready_behavior() {
    let f = ForegroundFixture::new();
    let target = f.share(true, true).await;
    f.unreported_prompt();
    assert_eq!(f.call(&target, Action::State {}).await.unwrap()["promptReadiness"]["ready"], true);
    f.registry.record_output(&f.id, b"\r\npermission required").unwrap();
    assert!(f.call(&target, Action::Prompt { mode: crate::mcp_desktop::DesktopPromptMode::Now, text:"stale snapshot".into(), request_id:"stale-state".into() }).await.is_err());
    f.registry.update_state(&f.id, AgentLifecycle::Done, AgentStateSource::Integration);
    assert_eq!(f.call(&target, Action::State {}).await.unwrap()["promptReadiness"]["basis"], "official_integration");
    assert_eq!(f.call(&target, Action::Prompt { mode: crate::mcp_desktop::DesktopPromptMode::Now, text:"officially ready".into(), request_id:"official".into() }).await.unwrap()["sentImmediately"], true);
}

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
    assert!(f.call(&target, Action::Prompt { mode: crate::mcp_desktop::DesktopPromptMode::Now,text:"read only cannot send".into(),request_id:"denied".into()}).await.is_err());
    assert_eq!(f.registry.list().len(),1);
    assert_eq!(f.registry.session_summary(&f.id).unwrap().process_id,pid);
}

#[tokio::test(flavor="multi_thread", worker_threads=2)]
async fn desktop_mcp_prompt_is_ready_checked_and_deduplicated() {
    let f = ForegroundFixture::new();
    let target = f.share(true,true).await;
    f.registry.update_state(&f.id,AgentLifecycle::Working,AgentStateSource::Integration);
    assert!(f.call(&target,Action::Prompt { mode: crate::mcp_desktop::DesktopPromptMode::Now,text:"busy".into(),request_id:"busy".into()}).await.is_err());
    f.registry.update_state(&f.id,AgentLifecycle::Idle,AgentStateSource::Heuristic);
    assert!(f.call(&target,Action::Prompt { mode: crate::mcp_desktop::DesktopPromptMode::Now,text:"heuristic".into(),request_id:"heuristic".into()}).await.is_err());
    f.registry.update_state(&f.id,AgentLifecycle::Idle,AgentStateSource::Integration);
    f.registry.get(&f.id).unwrap().input.lock().unwrap().desktop_editing = true;
    assert!(f.call(&target,Action::Prompt { mode: crate::mcp_desktop::DesktopPromptMode::Now,text:"unfinished input".into(),request_id:"editing".into()}).await.is_err());
    f.registry.get(&f.id).unwrap().input.lock().unwrap().desktop_editing = false;
    let action = Action::Prompt { mode: crate::mcp_desktop::DesktopPromptMode::Now,text:"single authorised prompt".into(),request_id:"one-prompt".into()};
    let sent = f.call(&target,action.clone()).await.unwrap();
    assert_eq!(sent["sentImmediately"],true);
    let replay = f.call(&target,action).await.unwrap();
    assert_eq!(replay["duplicate"],true);
    assert!(f.call(&target,Action::Prompt { mode: crate::mcp_desktop::DesktopPromptMode::Now,text:"different prompt".into(),request_id:"one-prompt".into()}).await.is_err());
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

#[test]
fn passive_mouse_motion_preserves_drafts_without_creating_an_edit() {
    let mut input = AgentInputControl::default();
    for report in [b"\x1b[<35;10;20M".as_slice(), b"\x1b[<63;1;999999M"] {
        assert!(is_passive_mouse_motion(report));
        for byte in report { observe_desktop_input(&mut input, &[*byte]); }
        assert!(!input.desktop_busy());
        assert_eq!(input.last_input_kind,Some("mouse_hover"));
    }
    observe_desktop_input(&mut input,b"unfinished draft");
    observe_desktop_input(&mut input,b"\x1b[<35;10;20M");
    assert!(input.desktop_busy());
    observe_desktop_input(&mut input,b"\r");
    observe_desktop_input(&mut input,b"\x1b[<35;10;20M");
    assert!(!input.desktop_busy());
    for report in [b"\x1b[<0;10;20M".as_slice(),b"\x1b[<32;10;20M",b"\x1b[<64;10;20M",b"\x1b[<35;10;20m",b"\x1b[<35;0;20M",b"\x1b[<35;10;20;1M"] {
        assert!(!is_passive_mouse_motion(report));
        let mut input=AgentInputControl::default();
        observe_desktop_input(&mut input,report);
        assert!(input.desktop_busy());
    }
}

#[tokio::test]
async fn project_background_first_prompt_uses_the_same_screen_gate_and_never_guesses_turn_completion() {
    for send_now in [true, false] {
        let f = ForegroundFixture::new();
        f.share(true, true).await;
        f.unreported_prompt();
        let entry = f.registry.get(&f.id).unwrap();
        *entry.last_output_at.lock().unwrap() = Instant::now();
        assert!(mcp_project_prompt(f.sink.as_ref(), &f.registry, &f.id, "startup must not queue", send_now).is_err());
        assert!(entry.queued_prompts.lock().unwrap().is_empty());
        f.unreported_prompt();
        assert_eq!(mcp_project_prompt(f.sink.as_ref(), &f.registry, &f.id, "first project message", send_now).unwrap(), 0);
        f.unreported_prompt();
        assert!(mcp_project_prompt(f.sink.as_ref(), &f.registry, &f.id, "unconfirmed next turn", true).is_err());
        assert!(f.registry.mcp_prompt_blockers(&f.id).unwrap().contains(&"terminal_turn_unconfirmed"));
    }
}

#[tokio::test(flavor="multi_thread", worker_threads=2)]
async fn desktop_composer_sends_once_from_the_real_codex_0169_resumed_screen() {
    let f = ForegroundFixture::with_resume(true);
    f.unreported_prompt();
    let entry = f.registry.get(&f.id).unwrap();
    *entry.prompt_screen.lock().unwrap() = prompt_screen::PromptScreen::new(30, 120);
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/codex-0169-resumed-idle.json"
    )).unwrap();
    f.registry.record_output(&f.id, fixture["output"].as_str().unwrap().as_bytes()).unwrap();
    entry.prompt_screen.lock().unwrap().settle_for_test();
    *entry.last_output_at.lock().unwrap() = Instant::now() - prompt_screen::QUIET;
    // An actual pending approval still blocks the user's send, despite idle
    // and the otherwise recognizable main composer. The draft stays upstream.
    f.registry.approvals.open(&f.id, approval::ApprovalAsk {
        tool_name:"fixture".into(), summary:"pending".into()
    }, "approval".into()).unwrap();
    assert_eq!(enqueue(f.sink.as_ref(), &f.registry, &f.id, &encode(b"must stay draft\r")).unwrap_err(), DESKTOP_PROMPT_NOT_READY);
    assert!(f.registry.approvals.take(&f.id, "approval").is_some());
    assert_eq!(enqueue(f.sink.as_ref(), &f.registry, &f.id, &encode(b"synthetic desktop delivery\r")).unwrap(), 0);
    assert!(entry.terminal_turn_started.load(Ordering::Acquire));
    assert_eq!(f.registry.session_summary(&f.id).unwrap().state, AgentLifecycle::Working);
    assert!(entry.queued_prompts.lock().unwrap().is_empty());
}

#[tokio::test(flavor="multi_thread", worker_threads=2)]
async fn desktop_send_ignores_a_quoted_working_log_only_on_a_verified_resumed_main_composer() {
    let f = ForegroundFixture::with_resume(true);
    f.unreported_prompt();
    let entry = f.registry.get(&f.id).unwrap();
    *entry.prompt_screen.lock().unwrap() = prompt_screen::PromptScreen::new(30, 120);
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/codex-0169-resumed-idle.json"
    )).unwrap();
    let output = format!("{}\x1b[4;1HPrevious log: Working (12s - esc to interrupt)\x1b[K\x1b[22;3H", fixture["output"].as_str().unwrap());
    f.registry.record_output(&f.id, output.as_bytes()).unwrap();
    f.registry.update_state_with_origin(&f.id, AgentLifecycle::Working, AgentStateSource::Heuristic, true);
    entry.prompt_screen.lock().unwrap().settle_for_test();
    *entry.last_output_at.lock().unwrap() = Instant::now() - prompt_screen::QUIET;
    assert_eq!(enqueue(f.sink.as_ref(), &f.registry, &f.id, &encode(b"new desktop prompt\r")).unwrap(), 0);
    assert!(entry.queued_prompts.lock().unwrap().is_empty());
    assert!(entry.terminal_turn_started.load(Ordering::Acquire));
    assert!(enqueue(f.sink.as_ref(), &f.registry, &f.id, &encode(b"do not infer completion\r")).unwrap() > 0);
}

#[tokio::test(flavor="multi_thread", worker_threads=2)]
async fn native_refresh_preserves_nonblocking_control_rejection() {
    let f = ForegroundFixture::new();
    let entry = f.registry.get(&f.id).unwrap();
    let input = entry.input.lock().unwrap();
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let worker = {
        let (registry, sink, id) = (f.registry.clone(), f.sink.clone(), f.id.clone());
        std::thread::spawn(move || {
            let refreshed = registry.refresh_native_command(&id);
            let rejected = mcp_prompt(sink.as_ref(), &registry, &id, "synthetic unauthorized probe", true);
            tx.send((refreshed, rejected)).unwrap();
        })
    };
    let observed = rx.recv_timeout(Duration::from_secs(1));
    // Always release before asserting, so a regression fails rather than hangs.
    drop(input);
    worker.join().unwrap();
    let (refreshed, result) = observed.expect("readiness refresh waited behind terminal input");
    assert!(!refreshed);
    assert_eq!(result.unwrap_err(), MCP_NOT_CONTROLLED);
}

#[tokio::test(flavor="multi_thread", worker_threads=2)]
async fn native_refresh_preserves_the_original_mcp_grant_before_waiting() {
    let f = ForegroundFixture::new();
    set_mcp_control(f.sink.as_ref(), &f.registry, &f.id, true).unwrap();
    let entry = f.registry.get(&f.id).unwrap();
    let input = entry.input.lock().unwrap();
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
    let (resume_tx, resume_rx) = std::sync::mpsc::channel();
    let worker = {
        let (registry, sink, id) = (f.registry.clone(), f.sink.clone(), f.id.clone());
        std::thread::spawn(move || mcp_prompt_with_grant_observer(
            sink.as_ref(), &registry, &id, "synthetic stale grant probe", true, || {
                ready_tx.send(()).unwrap();
                resume_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            },
        ))
    };
    let snapshotted = ready_rx.recv_timeout(Duration::from_secs(1));
    set_mcp_control(f.sink.as_ref(), &f.registry, &f.id, false).unwrap();
    set_mcp_control(f.sink.as_ref(), &f.registry, &f.id, true).unwrap();
    resume_tx.send(()).unwrap();
    drop(input);
    let result = worker.join().unwrap();
    snapshotted.expect("grant was not captured before waiting on terminal input");
    assert_eq!(result.unwrap_err(), MCP_GRANT_CHANGED);
}

#[tokio::test(flavor="multi_thread", worker_threads=2)]
async fn native_refresh_preserves_desktop_input_ticket_before_waiting() {
    let f = ForegroundFixture::new();
    let entry = f.registry.get(&f.id).unwrap();
    let input = entry.input.lock().unwrap();
    let before = entry.desktop_input_ticket.load(Ordering::Acquire);
    let worker = {
        let (registry, sink, id) = (f.registry.clone(), f.sink.clone(), f.id.clone());
        std::thread::spawn(move || enqueue(sink.as_ref(), &registry, &id, &encode(b"synthetic ticket probe\r")))
    };
    let deadline = Instant::now() + Duration::from_secs(1);
    while entry.desktop_input_ticket.load(Ordering::Acquire) == before && Instant::now() < deadline {
        std::thread::yield_now();
    }
    let reserved = entry.desktop_input_ticket.load(Ordering::Acquire) > before;
    drop(input);
    assert!(worker.join().unwrap().is_ok());
    assert!(reserved, "desktop intent waited behind readiness refresh before reserving its ticket");
}


fn queued_action(text: &str, request_id: &str) -> Action {
    Action::Prompt {
        text: text.into(), request_id: request_id.into(),
        mode: crate::mcp_desktop::DesktopPromptMode::Queue,
    }
}

#[test]
fn desktop_mcp_prompt_mode_defaults_to_now_and_rejects_unknown_modes() {
    let default = serde_json::json!({"kind":"prompt","text":"hello","requestId":"mode-test"});
    let action: Action = serde_json::from_value(default.clone()).unwrap();
    assert_eq!(serde_json::to_value(action).unwrap()["mode"], "now");
    for mode in ["now", "queue"] {
        let mut value = default.clone(); value["mode"] = mode.into();
        assert!(serde_json::from_value::<Action>(value).is_ok());
    }
    for mode in [serde_json::json!("interrupt"), serde_json::Value::Null] {
        let mut value = default.clone(); value["mode"] = mode;
        assert!(serde_json::from_value::<Action>(value).is_err());
    }
}

#[tokio::test(flavor="multi_thread", worker_threads=2)]
async fn desktop_mcp_queue_waits_for_official_completion_and_delivers_in_order() {
    let f = ForegroundFixture::new();
    let target = f.share(true, true).await;
    f.registry.update_state(&f.id, AgentLifecycle::Working, AgentStateSource::Integration);
    let first = queued_action("queued-mcp-first", "queue-first");
    let accepted = f.call(&target, first.clone()).await.unwrap();
    assert_eq!(accepted["queued"], 1);
    assert_eq!(accepted["sentImmediately"], false);
    assert_eq!(f.call(&target, first).await.unwrap()["duplicate"], true);
    assert!(f.call(&target, queued_action("changed", "queue-first")).await.is_err());
    let mut changed_mode = queued_action("queued-mcp-first", "queue-first");
    if let Action::Prompt { mode, .. } = &mut changed_mode { *mode = crate::mcp_desktop::DesktopPromptMode::Now; }
    assert!(f.call(&target, changed_mode).await.is_err());
    assert_eq!(f.call(&target, queued_action("queued-mcp-second", "queue-second")).await.unwrap()["queued"], 2);
    assert_eq!(f.call(&target, Action::State {}).await.unwrap()["queuedPrompts"], 2);
    for state in [AgentLifecycle::Idle, AgentLifecycle::Done] {
        f.registry.update_state(&f.id, state, AgentStateSource::Heuristic);
        deliver_next_queued(f.sink.as_ref(), &f.registry, &f.id);
        assert_eq!(f.registry.session_summary(&f.id).unwrap().queued_prompts, 2);
    }
    assert!(!received_within(&f.collector, &f.id, "queued-mcp-first", Duration::from_millis(100)));
    f.registry.update_state(&f.id, AgentLifecycle::Done, AgentStateSource::Integration);
    deliver_next_queued(f.sink.as_ref(), &f.registry, &f.id);
    assert!(received_within(&f.collector, &f.id, "queued-mcp-first", Duration::from_secs(3)));
    assert_eq!(f.call(&target, Action::State {}).await.unwrap()["queuedPrompts"], 1);
    deliver_next_queued(f.sink.as_ref(), &f.registry, &f.id);
    assert!(!received_within(&f.collector, &f.id, "queued-mcp-second", Duration::from_millis(100)));
    f.registry.update_state(&f.id, AgentLifecycle::Idle, AgentStateSource::Integration);
    deliver_next_queued(f.sink.as_ref(), &f.registry, &f.id);
    assert!(received_within(&f.collector, &f.id, "queued-mcp-second", Duration::from_secs(3)));
    assert_eq!(f.call(&target, Action::State {}).await.unwrap()["queuedPrompts"], 0);
}

#[tokio::test(flavor="multi_thread", worker_threads=2)]
async fn desktop_mcp_queue_preserves_human_draft_and_existing_queue() {
    let f = ForegroundFixture::new();
    let target = f.share(true, true).await;
    let entry = f.registry.get(&f.id).unwrap();
    entry.input.lock().unwrap().desktop_editing = true;
    assert_eq!(f.call(&target, queued_action("after-human-first", "draft-first")).await.unwrap()["queued"], 1);
    assert_eq!(f.call(&target, queued_action("after-human-second", "draft-second")).await.unwrap()["queued"], 2);
    deliver_next_queued(f.sink.as_ref(), &f.registry, &f.id);
    assert_eq!(f.registry.session_summary(&f.id).unwrap().queued_prompts, 2);
    assert!(entry.input.lock().unwrap().desktop_editing);
    assert!(!received_within(&f.collector, &f.id, "after-human-first", Duration::from_millis(100)));
    entry.input.lock().unwrap().desktop_editing = false;
    f.registry.update_state(&f.id, AgentLifecycle::Done, AgentStateSource::Integration);
    deliver_next_queued(f.sink.as_ref(), &f.registry, &f.id);
    assert!(received_within(&f.collector, &f.id, "after-human-first", Duration::from_secs(3)));
    assert_eq!(f.registry.session_summary(&f.id).unwrap().queued_prompts, 1);
}

#[tokio::test(flavor="multi_thread", worker_threads=2)]
async fn desktop_mcp_queue_requires_control_and_revocation_prevents_delivery() {
    let f = ForegroundFixture::new();
    let target = f.share(true, false).await;
    for mode in [crate::mcp_desktop::DesktopPromptMode::Now, crate::mcp_desktop::DesktopPromptMode::Queue] {
        let denied = f.call(&target, Action::Prompt {text:"denied".into(), request_id:"denied-mode".into(),mode}).await.unwrap_err();
        assert_eq!(denied.code, "not_authorized");
        assert!(denied.message.contains("已共享，但未開啟控制"));
        assert!(denied.message.contains("MCP 權限"));
        assert!(denied.message.contains("完全開放"));
    }
    assert_eq!(f.registry.session_summary(&f.id).unwrap().queued_prompts, 0);
    let target = f.share(true, true).await;
    f.registry.update_state(&f.id, AgentLifecycle::Working, AgentStateSource::Integration);
    let prompt = queued_action("revoked-must-not-send", "revoke-queued");
    assert_eq!(f.call(&target, prompt.clone()).await.unwrap()["queued"], 1);
    f.service.revoke(&target).unwrap();
    let replacement = f.share(true, true).await;
    assert!(f.call(&target, prompt).await.is_err());
    f.registry.update_state(&f.id, AgentLifecycle::Done, AgentStateSource::Integration);
    deliver_next_queued(f.sink.as_ref(), &f.registry, &f.id);
    assert_eq!(f.call(&replacement, Action::State {}).await.unwrap()["queuedPrompts"], 0);
    assert!(!received_within(&f.collector, &f.id, "revoked-must-not-send", Duration::from_millis(200)));
}

#[tokio::test(flavor="multi_thread", worker_threads=2)]
async fn desktop_mcp_queue_sends_immediately_only_when_officially_ready() {
    let f = ForegroundFixture::new();
    let target = f.share(true, true).await;
    let result = f.call(&target, queued_action("ready-queue-prompt", "ready-queue")).await.unwrap();
    assert_eq!(result["sentImmediately"], true);
    assert_eq!(result["queued"], 0);
    assert!(received_within(&f.collector, &f.id, "ready-queue-prompt", Duration::from_secs(3)));
}

fn write_codex_turn_rollout(profile: &Path, id: &str, complete: bool) {
    let sessions = profile.join("sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    let mut rows = vec![
        serde_json::json!({"type":"session_meta","payload":{"id":id,"cwd":"/synthetic","source":"cli"}}),
        serde_json::json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}),
    ];
    if complete {
        rows.push(serde_json::json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"t1"}}));
    }
    std::fs::write(
        sessions.join(format!("rollout-{id}.jsonl")),
        rows.iter().map(|row| format!("{row}\n")).collect::<String>(),
    )
    .unwrap();
}

#[tokio::test]
async fn official_integration_idle_clears_an_unconfirmed_terminal_turn() {
    let f = ForegroundFixture::new();
    let target = f.share(true, true).await;
    f.registry.update_state(&f.id, AgentLifecycle::Working, AgentStateSource::Integration);
    let entry = f.registry.get(&f.id).unwrap();
    assert!(entry.terminal_turn_started.load(Ordering::Acquire));
    assert!(f.registry.mcp_prompt_blockers(&f.id).unwrap().contains(&"lifecycle_not_ready"));
    f.registry.update_state(&f.id, AgentLifecycle::Idle, AgentStateSource::Integration);
    assert!(!entry.terminal_turn_started.load(Ordering::Acquire));
    let state = f.call(&target, Action::State {}).await.unwrap();
    assert_eq!(state["promptReadiness"]["ready"], true);
}

#[tokio::test]
async fn completed_native_rollout_recovers_an_idle_unconfirmed_session() {
    let f = ForegroundFixture::new();
    let target = f.share(true, true).await;
    let profile = tempfile::tempdir().unwrap();
    let entry = f.registry.get(&f.id).unwrap();
    let native_id = {
        let mut summary = entry.summary.lock().unwrap();
        summary.profile_config_path = Some(profile.path().display().to_string());
        summary.working_directory = "/synthetic".into();
        summary.captured_session_id.clone().unwrap()
    };
    write_codex_turn_rollout(profile.path(), &native_id, true);
    f.registry.update_state(&f.id, AgentLifecycle::Working, AgentStateSource::Integration);
    f.unreported_prompt();
    let state = f.call(&target, Action::State {}).await.unwrap();
    assert_eq!(state["promptReadiness"]["ready"], true, "{state}");
    assert_eq!(state["promptReadiness"]["basis"], "completed_native_turn");
    assert!(!entry.terminal_turn_started.load(Ordering::Acquire));
    let reconciled = f.call(&target, Action::Reconcile {}).await.unwrap();
    assert_eq!(reconciled["promptReadiness"]["ready"], true);
}

#[tokio::test]
async fn open_native_turn_and_desktop_edits_are_not_reconciled() {
    let f = ForegroundFixture::new();
    let target = f.share(true, true).await;
    let profile = tempfile::tempdir().unwrap();
    let entry = f.registry.get(&f.id).unwrap();
    let native_id = {
        let mut summary = entry.summary.lock().unwrap();
        summary.profile_config_path = Some(profile.path().display().to_string());
        summary.working_directory = "/synthetic".into();
        summary.captured_session_id.clone().unwrap()
    };
    write_codex_turn_rollout(profile.path(), &native_id, false);
    f.registry.update_state(&f.id, AgentLifecycle::Working, AgentStateSource::Integration);
    f.unreported_prompt();
    let blocked = f.call(&target, Action::State {}).await.unwrap();
    assert_eq!(blocked["promptReadiness"]["ready"], false);
    assert!(blocked["promptReadiness"]["blockers"].as_array().unwrap().iter().any(|value| value == "terminal_turn_unconfirmed"));
    let refused = f.call(&target, Action::Reconcile {}).await.unwrap();
    assert_eq!(refused["reconciled"], false);
    assert_eq!(refused["promptReadiness"]["ready"], false);
    write_codex_turn_rollout(profile.path(), &native_id, true);
    entry.input.lock().unwrap().desktop_editing = true;
    let editing = f.call(&target, Action::Reconcile {}).await.unwrap();
    assert_eq!(editing["reconciled"], false);
    assert!(editing["promptReadiness"]["blockers"].as_array().unwrap().iter().any(|value| value == "desktop_editing"));
    assert!(entry.terminal_turn_started.load(Ordering::Acquire));
}

#[tokio::test]
async fn heuristic_idle_without_a_completed_rollout_stays_unconfirmed() {
    let f = ForegroundFixture::new();
    let target = f.share(true, true).await;
    f.registry.update_state(&f.id, AgentLifecycle::Working, AgentStateSource::Integration);
    f.unreported_prompt();
    let state = f.call(&target, Action::State {}).await.unwrap();
    assert_eq!(state["promptReadiness"]["ready"], false);
    assert!(state["promptReadiness"]["blockers"].as_array().unwrap().iter().any(|value| value == "integration_not_reported"));
    assert!(state["promptReadiness"]["blockers"].as_array().unwrap().iter().any(|value| value == "terminal_turn_unconfirmed"));
    assert!(f.registry.get(&f.id).unwrap().terminal_turn_started.load(Ordering::Acquire));
}

#[tokio::test]
async fn completed_native_rollout_recovers_a_heuristic_working_session() {
    let f = ForegroundFixture::new();
    let target = f.share(true, true).await;
    let profile = tempfile::tempdir().unwrap();
    let entry = f.registry.get(&f.id).unwrap();
    let native_id = {
        let mut summary = entry.summary.lock().unwrap();
        summary.profile_config_path = Some(profile.path().display().to_string());
        summary.working_directory = "/synthetic".into();
        summary.captured_session_id.clone().unwrap()
    };
    write_codex_turn_rollout(profile.path(), &native_id, true);
    f.registry.update_state(&f.id, AgentLifecycle::Working, AgentStateSource::Integration);
    f.registry
        .record_output(&f.id, "\x1b[2J\x1b[H\x1b[?2004h\x1b[?25h› ".as_bytes())
        .unwrap();
    {
        let mut summary = entry.summary.lock().unwrap();
        summary.state = AgentLifecycle::Working;
        summary.state_source = AgentStateSource::Heuristic;
    }
    entry.prompt_screen.lock().unwrap().settle_for_test();
    *entry.last_output_at.lock().unwrap() = Instant::now() - prompt_screen::QUIET;
    assert!(entry.terminal_turn_started.load(Ordering::Acquire));
    let state = f.call(&target, Action::State {}).await.unwrap();
    assert_eq!(state["state"], "idle", "{state}");
    assert_eq!(state["stateSource"], "heuristic");
    assert_eq!(state["promptReadiness"]["ready"], true, "{state}");
    assert_eq!(state["promptReadiness"]["basis"], "completed_native_turn");
    assert!(!entry.terminal_turn_started.load(Ordering::Acquire));
    let reconciled = f.call(&target, Action::Reconcile {}).await.unwrap();
    assert_eq!(reconciled["reconciled"], false);
    assert_eq!(reconciled["state"], "idle");
    assert_eq!(reconciled["promptReadiness"]["ready"], true);
}

#[tokio::test]
async fn open_native_turn_keeps_a_heuristic_working_session_unready() {
    let f = ForegroundFixture::new();
    let target = f.share(true, true).await;
    let profile = tempfile::tempdir().unwrap();
    let entry = f.registry.get(&f.id).unwrap();
    let native_id = {
        let mut summary = entry.summary.lock().unwrap();
        summary.profile_config_path = Some(profile.path().display().to_string());
        summary.working_directory = "/synthetic".into();
        summary.captured_session_id.clone().unwrap()
    };
    write_codex_turn_rollout(profile.path(), &native_id, false);
    f.registry.update_state(&f.id, AgentLifecycle::Working, AgentStateSource::Integration);
    {
        let mut summary = entry.summary.lock().unwrap();
        summary.state = AgentLifecycle::Working;
        summary.state_source = AgentStateSource::Heuristic;
    }
    let blocked = f.call(&target, Action::State {}).await.unwrap();
    assert_eq!(blocked["state"], "working", "{blocked}");
    assert_eq!(blocked["promptReadiness"]["ready"], false, "{blocked}");
    let blockers = blocked["promptReadiness"]["blockers"].as_array().unwrap();
    assert!(
        blockers.iter().any(|value| value == "lifecycle_not_ready" || value == "terminal_turn_unconfirmed"),
        "{blocked}"
    );
    let refused = f.call(&target, Action::Reconcile {}).await.unwrap();
    assert_eq!(refused["reconciled"], false);
    assert_eq!(refused["state"], "working");
    assert_eq!(refused["promptReadiness"]["ready"], false);
    assert!(entry.terminal_turn_started.load(Ordering::Acquire));
}

#[tokio::test]
async fn official_integration_working_is_not_settled_from_a_completed_rollout() {
    let f = ForegroundFixture::new();
    let target = f.share(true, true).await;
    let profile = tempfile::tempdir().unwrap();
    let entry = f.registry.get(&f.id).unwrap();
    let native_id = {
        let mut summary = entry.summary.lock().unwrap();
        summary.profile_config_path = Some(profile.path().display().to_string());
        summary.working_directory = "/synthetic".into();
        summary.captured_session_id.clone().unwrap()
    };
    write_codex_turn_rollout(profile.path(), &native_id, true);
    f.registry.update_state(&f.id, AgentLifecycle::Working, AgentStateSource::Integration);
    let blocked = f.call(&target, Action::State {}).await.unwrap();
    assert_eq!(blocked["state"], "working", "{blocked}");
    assert_eq!(blocked["stateSource"], "integration");
    assert_eq!(blocked["promptReadiness"]["ready"], false);
    let refused = f.call(&target, Action::Reconcile {}).await.unwrap();
    assert_eq!(refused["reconciled"], false);
    assert_eq!(refused["state"], "working");
    assert!(entry.terminal_turn_started.load(Ordering::Acquire));
}
