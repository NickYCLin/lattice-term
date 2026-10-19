struct QueueWriter(Arc<Mutex<Vec<u8>>>);

impl Write for QueueWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

struct QueueFixture {
    sink: Arc<TestSink>,
    registry: Arc<AgentRegistry>,
    id: String,
    writes: Arc<Mutex<Vec<u8>>>,
    _original_writer: Box<dyn Write + Send>,
}

impl QueueFixture {
    fn new() -> Self {
        let sink = Arc::new(TestSink::default());
        let registry = AgentRegistry::with_local_reporter(sink.clone()).unwrap();
        #[cfg(unix)]
        let (executable, arguments) = ("/bin/cat".into(), Vec::new());
        #[cfg(windows)]
        let (executable, arguments) = ("cmd.exe".into(), vec!["/d".into(), "/q".into()]);
        let session = launch(
            sink.clone(),
            registry.clone(),
            AgentLaunchRequest {
                definition_id: "custom".into(),
                label: "Queue wakeup fixture".into(),
                executable,
                arguments,
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
        let entry = registry.get(&session.session_id).unwrap();
        let writes = Arc::new(Mutex::new(Vec::new()));
        let original_writer = std::mem::replace(
            &mut *entry.writer.lock().unwrap(),
            Box::new(QueueWriter(writes.clone())),
        );
        let fixture = Self {
            sink,
            registry,
            id: session.session_id,
            writes,
            _original_writer: original_writer,
        };
        fixture.report(AgentLifecycle::Idle);
        fixture
    }

    fn report(&self, state: AgentLifecycle) {
        let (address, token) = self.registry.reporter_credentials(&self.id).unwrap();
        send_report_with_native_session(address, &self.id, &token, state, None).unwrap();
    }

    fn input(&self, bytes: &[u8]) {
        send_bytes(self.sink.as_ref(), &self.registry, &self.id, bytes).unwrap();
    }

    fn enqueue(&self) {
        assert_eq!(
            enqueue(
                self.sink.as_ref(),
                &self.registry,
                &self.id,
                &encode(b"queued-next\r")
            )
            .unwrap(),
            1
        );
    }

    fn depth(&self) -> usize {
        self.registry
            .session_summary(&self.id)
            .unwrap()
            .queued_prompts
    }
}

impl Drop for QueueFixture {
    fn drop(&mut self) {
        self.registry.stop_all();
    }
}

#[test]
fn completing_a_fragmented_terminal_reply_wakes_the_ready_queue() {
    let fixture = QueueFixture::new();
    fixture.input(b"\x1b[");
    fixture.enqueue();
    fixture.input(b"1;1R");
    assert_eq!(fixture.depth(), 0);
    assert_eq!(*fixture.writes.lock().unwrap(), b"\x1b[1;1Rqueued-next\r");
}

#[test]
fn finishing_a_reply_never_submits_over_a_human_draft() {
    let fixture = QueueFixture::new();
    fixture.input(b"unfinished draft\x1b[");
    fixture.enqueue();
    fixture.input(b"1;1R");
    assert_eq!(fixture.depth(), 1);
    assert_eq!(
        *fixture.writes.lock().unwrap(),
        b"unfinished draft\x1b[1;1R"
    );
}

#[test]
fn submitting_a_human_turn_keeps_the_next_prompt_queued() {
    let fixture = QueueFixture::new();
    fixture.input(b"human prompt");
    fixture.enqueue();
    fixture.input(b"\r");
    assert_eq!(fixture.depth(), 1);
    assert_eq!(
        fixture.registry.session_summary(&fixture.id).unwrap().state,
        AgentLifecycle::Working
    );
    fixture.report(AgentLifecycle::Done);
    assert_eq!(fixture.depth(), 0);
}

#[test]
fn repeated_official_readiness_wakes_a_previously_blocked_queue() {
    let fixture = QueueFixture::new();
    let entry = fixture.registry.get(&fixture.id).unwrap();
    entry.input.lock().unwrap().desktop_editing = true;
    fixture.enqueue();
    fixture.report(AgentLifecycle::Idle);
    assert_eq!(fixture.depth(), 1);
    entry.input.lock().unwrap().desktop_editing = false;
    fixture.report(AgentLifecycle::Idle);
    assert_eq!(fixture.depth(), 0);
    assert_eq!(*fixture.writes.lock().unwrap(), b"queued-next\r");
}

#[test]
fn finishing_a_reply_requires_official_readiness() {
    for (state, source) in [
        (AgentLifecycle::Idle, AgentStateSource::Heuristic),
        (AgentLifecycle::Done, AgentStateSource::Heuristic),
        (AgentLifecycle::Working, AgentStateSource::Integration),
        (
            AgentLifecycle::NeedsAttention,
            AgentStateSource::Integration,
        ),
    ] {
        let fixture = QueueFixture::new();
        let entry = fixture.registry.get(&fixture.id).unwrap();
        {
            let mut summary = entry.summary.lock().unwrap();
            summary.state = state;
            summary.state_source = source;
        }
        fixture.input(b"\x1b[");
        fixture.enqueue();
        fixture.input(b"1;1R");
        assert_eq!(fixture.depth(), 1);
        assert_eq!(*fixture.writes.lock().unwrap(), b"\x1b[1;1R");
    }
}

#[test]
fn wakeups_preserve_failed_deliveries_and_startup_holds() {
    for failed_delivery in [false, true] {
        let fixture = QueueFixture::new();
        let entry = fixture.registry.get(&fixture.id).unwrap();
        fixture.input(b"\x1b[");
        fixture.enqueue();
        if failed_delivery {
            entry
                .queued_prompts
                .lock()
                .unwrap()
                .front_mut()
                .unwrap()
                .delivery_error = Some("Unconfirmed fixture delivery".into());
        } else {
            entry.input.lock().unwrap().startup_seed_pending = true;
        }
        fixture.input(b"1;1R");
        fixture.report(AgentLifecycle::Idle);
        assert_eq!(fixture.depth(), 1);
        assert_eq!(*fixture.writes.lock().unwrap(), b"\x1b[1;1R");
    }
}
