use super::queue_wakeup_tests::QueueFixture;

struct ChatFixture(QueueFixture);

impl std::ops::Deref for ChatFixture {
    type Target = QueueFixture;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl ChatFixture {
    fn with_resume(resumed: bool) -> Self {
        Self(QueueFixture::with_resume(resumed))
    }

    fn unreported_prompt(&self) {
        self.unreported_prompt_for("codex");
    }

    fn unreported_prompt_for(&self, definition: &str) {
        let entry = self.registry.get(&self.id).unwrap();
        {
            let mut summary = entry.summary.lock().unwrap();
            summary.definition_id = definition.into();
            summary.state = AgentLifecycle::Idle;
            summary.state_source = AgentStateSource::Heuristic;
        }
        let marker = if definition == "claude" {
            "❯ "
        } else {
            "› "
        };
        let screen = format!("\x1b[2J\x1b[H\x1b[?2004h\x1b[?25h{marker}");
        self.registry
            .record_output(&self.id, screen.as_bytes())
            .unwrap();
        entry.prompt_screen.lock().unwrap().settle_for_test();
        *entry.last_output_at.lock().unwrap() = Instant::now() - prompt_screen::QUIET;
    }
}

#[test]
fn desktop_chat_first_prompt_does_not_wait_for_a_turn_that_never_started() {
    for definition in ["codex", "claude"] {
        for resumed in [false, true] {
            let f = ChatFixture::with_resume(resumed);
            f.unreported_prompt_for(definition);
            if resumed {
                f.registry
                    .update_state_from_output(&f.id, AgentLifecycle::Working);
            }
            let depth = enqueue(
                f.sink.as_ref(),
                &f.registry,
                &f.id,
                &encode(b"\x1b[200~first chat prompt\x1b[201~\r"),
            )
            .unwrap();
            assert_eq!(
                depth, 0,
                "first prompt must reach the empty live composer, resumed={resumed}"
            );
            assert_eq!(
                *f.writes.lock().unwrap(),
                b"\x1b[200~first chat prompt\x1b[201~\r"
            );
            assert_eq!(
                f.registry.session_summary(&f.id).unwrap().state,
                AgentLifecycle::Working
            );
            assert!(f
                .registry
                .get(&f.id)
                .unwrap()
                .terminal_turn_started
                .load(Ordering::Acquire));
        }
    }
}

#[test]
fn desktop_chat_unconfirmed_first_prompt_is_rejected_instead_of_stranded() {
    let f = ChatFixture::with_resume(true);
    f.unreported_prompt();
    f.registry
        .update_state_from_output(&f.id, AgentLifecycle::Working);
    f.registry
        .record_output(&f.id, b"\x1b[2J\x1b[Hunknown startup screen")
        .unwrap();
    assert_eq!(
        enqueue(
            f.sink.as_ref(),
            &f.registry,
            &f.id,
            &encode(b"keep my draft\r")
        )
        .unwrap_err(),
        DESKTOP_PROMPT_NOT_READY
    );
    assert!(queued_prompt_views(&f.registry, &f.id).unwrap().is_empty());
}

#[test]
fn desktop_chat_first_prompt_preserves_foreground_gates_and_existing_queue() {
    for case in [
        "draft",
        "paste",
        "escape",
        "startup",
        "approval",
        "output",
        "queue",
        "limit",
        "dependency",
    ] {
        let f = ChatFixture::with_resume(true);
        f.unreported_prompt();
        let entry = f.registry.get(&f.id).unwrap();
        match case {
            "draft" => entry.input.lock().unwrap().desktop_editing = true,
            "paste" => entry.input.lock().unwrap().desktop_paste = true,
            "escape" => entry.input.lock().unwrap().desktop_escape = vec![27],
            "startup" => entry.input.lock().unwrap().startup_seed_pending = true,
            "approval" => {
                f.registry
                    .approvals
                    .open(
                        &f.id,
                        approval::ApprovalAsk {
                            tool_name: "fixture".into(),
                            summary: "approval pending".into(),
                        },
                        "pending".into(),
                    )
                    .unwrap();
            }
            "output" => {
                f.registry.record_output(&f.id, b"\x1b[0m").unwrap();
            }
            "queue" => entry
                .queued_prompts
                .lock()
                .unwrap()
                .push_back(QueuedPrompt {
                    id: "existing".into(),
                    delivery_error: Some("unknown result".into()),
                    bytes: b"existing\r".to_vec(),
                    mcp_grant_epoch: None,
                }),
            "limit" | "dependency" => {
                let other = launch(
                    f.sink.clone(),
                    f.registry.clone(),
                    AgentLaunchRequest {
                        definition_id: "custom".into(),
                        label: "Blocking fixture".into(),
                        executable: if cfg!(windows) { "cmd.exe" } else { "/bin/cat" }.into(),
                        arguments: if cfg!(windows) {
                            vec!["/d".into(), "/q".into()]
                        } else {
                            Vec::new()
                        },
                        resume_session_id: None,
                        group_id: None,
                        seed_input: None,
                        restore_existing_session: false,
                        profile_config_path: None,
                        sandbox: false,
                        detached: false,
                        working_directory: std::env::current_dir().unwrap().display().to_string(),
                        cols: 80,
                        rows: 24,
                    },
                )
                .unwrap();
                f.registry
                    .get(&other.session_id)
                    .unwrap()
                    .integrated_completion
                    .store(true, Ordering::Release);
                f.registry.update_state(
                    &other.session_id,
                    AgentLifecycle::Working,
                    AgentStateSource::Integration,
                );
                if case == "limit" {
                    f.registry.set_max_active_sessions(Some(1)).unwrap();
                } else {
                    f.registry
                        .set_queue_dependency(&f.id, Some(&other.session_id))
                        .unwrap();
                }
            }
            _ => unreachable!(),
        }
        assert_eq!(
            enqueue(
                f.sink.as_ref(),
                &f.registry,
                &f.id,
                &encode(b"must not send\r")
            )
            .unwrap_err(),
            DESKTOP_PROMPT_NOT_READY,
            "{case}"
        );
        let queue = queued_prompt_views(&f.registry, &f.id).unwrap();
        assert_eq!(queue.len(), usize::from(case == "queue"), "{case}");
        if case == "queue" {
            assert_eq!(queue[0].text, "existing");
            assert_eq!(queue[0].delivery_error.as_deref(), Some("unknown result"));
        }
        assert!(
            !entry.terminal_turn_started.load(Ordering::Acquire),
            "{case}"
        );
    }
}

#[test]
fn desktop_chat_subsequent_queue_still_requires_official_completion() {
    let f = ChatFixture::with_resume(true);
    f.unreported_prompt();
    assert_eq!(
        enqueue(f.sink.as_ref(), &f.registry, &f.id, &encode(b"first\r")).unwrap(),
        0
    );
    assert_eq!(
        enqueue(f.sink.as_ref(), &f.registry, &f.id, &encode(b"second\r")).unwrap(),
        1
    );
    f.unreported_prompt();
    deliver_next_queued(f.sink.as_ref(), &f.registry, &f.id);
    assert_eq!(queued_prompt_views(&f.registry, &f.id).unwrap().len(), 1);
    f.registry
        .update_state(&f.id, AgentLifecycle::Done, AgentStateSource::Integration);
    deliver_next_queued(f.sink.as_ref(), &f.registry, &f.id);
    assert!(queued_prompt_views(&f.registry, &f.id).unwrap().is_empty());
}
