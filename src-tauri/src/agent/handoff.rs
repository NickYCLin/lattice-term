//! Cooperative TUI writer parking. Never signals another process.
use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Phase {
    Held,
    Releasing,
    Released,
}
pub(super) struct Handoff {
    pub phase: Phase,
    pub request: AgentLaunchRequest,
    pub registry: Weak<AgentRegistry>,
    pub idle_since: Option<Instant>,
    pub foreground_until: Option<Instant>,
    pub timeout: Duration,
}
impl Handoff {
    pub fn resume_request(
        &self,
        summary: &AgentSessionSummary,
    ) -> Result<AgentLaunchRequest, String> {
        let mut request = self.request.clone();
        request.resume_session_id = Some(
            summary
                .captured_session_id
                .clone()
                .ok_or("Native conversation unavailable")?,
        );
        request.restore_existing_session = true;
        request.group_id = Some(summary.group_id.clone());
        request.label = summary.group_label.clone();
        request.seed_input = None;
        Ok(request)
    }
    pub fn new(mut request: AgentLaunchRequest, registry: &Arc<AgentRegistry>) -> Self {
        request.seed_input = None;
        Self {
            phase: Phase::Held,
            request,
            registry: Arc::downgrade(registry),
            idle_since: None,
            foreground_until: None,
            timeout: Duration::ZERO,
        }
    }
}
impl AgentRegistry {
    pub(crate) fn handoff_presence(&self, selected: Option<&str>, timeout_ms: u64) {
        let ids: Vec<_> = self.list().into_iter().map(|s| s.session_id).collect();
        for id in ids {
            if let Ok(entry) = self.get(&id) {
                if let Ok(mut h) = entry.handoff.lock() {
                    h.timeout = Duration::from_millis(timeout_ms.min(3_600_000));
                    if selected == Some(id.as_str()) {
                        h.foreground_until = Some(Instant::now() + Duration::from_secs(15));
                        h.idle_since = None;
                    } else {
                        h.foreground_until = None;
                    }
                }
            }
        }
    }
    pub(super) fn maybe_release_writer(&self, id: &str) {
        let Ok(entry) = self.get(id) else {
            return;
        };
        let Ok(input) = entry.input.try_lock() else {
            return;
        };
        let Ok(summary) = entry.summary.lock() else {
            return;
        };
        let Ok(mut h) = entry.handoff.try_lock() else {
            return;
        };
        let safe = self.id_prefix.is_none()
            && summary.definition_id == "codex"
            && !summary.detached
            && summary.captured_session_id.is_some()
            && h.phase == Phase::Held
            && matches!(summary.state, AgentLifecycle::Idle | AgentLifecycle::Done)
            && !entry.terminal_turn_started.load(Ordering::Acquire)
            && !input.desktop_busy()
            && !input.startup_seed_pending
            && self.approvals.current(id).is_none()
            && entry.queued_prompts.lock().is_ok_and(|q| q.is_empty())
            && entry
                .last_output_at
                .lock()
                .is_ok_and(|at| at.elapsed() >= prompt_screen::QUIET)
            && entry
                .prompt_screen
                .lock()
                .is_ok_and(|screen| screen.blocker("codex", Instant::now()).is_none());
        let foreground = h.foreground_until.is_some();
        if !safe || foreground || h.timeout.is_zero() {
            h.idle_since = None;
            return;
        }
        let now = Instant::now();
        let since = *h.idle_since.get_or_insert(now);
        if now.duration_since(since) < h.timeout {
            return;
        }
        if summary.state_source != AgentStateSource::Integration
            && !entry.turn_reconciled_from_rollout.load(Ordering::Acquire)
            && !summary.captured_session_id.as_ref().is_some_and(|native| {
                cached_native_turn_complete(&entry, &summary, native) == Some(true)
            })
        {
            return;
        }
        // Automatic /exit left a live conversation looking finished in the
        // sidebar while the visible terminal was dead. Writer parking must
        // never end a process the user did not ask to stop.
        h.idle_since = None;
    }
    pub(crate) fn resume_writer(&self, id: &str) -> Result<(), String> {
        let entry = self.get(id)?;
        let mut h = entry
            .handoff
            .lock()
            .map_err(|_| "Writer handoff unavailable")?;
        match h.phase {
            Phase::Held => return Ok(()),
            Phase::Releasing => return Err("writer_release_pending".into()),
            Phase::Released => {}
        }
        let summary = entry
            .summary
            .lock()
            .map_err(|_| "Writer state unavailable")?
            .clone();
        let request = h.resume_request(&summary)?;
        let sink = entry
            .state_sink
            .upgrade()
            .ok_or("Writer observer unavailable")?;
        let registry = h.registry.upgrade().ok_or("Writer registry unavailable")?;
        // Refuse to launch over a known writer; never send a prompt as a probe.
        if self.writer_holder(id).is_some() {
            return Err("thread_locked_by_other_writer".into());
        }
        h.phase = Phase::Releasing;
        let result = launch_reusing(
            sink.clone(),
            registry,
            request,
            None,
            None,
            Some(entry.clone()),
        );
        match result {
            Ok(summary) => {
                drop(h);
                sink.writer(&summary);
                let resumed = self.get(id)?;
                if !resumed.startup_gate.wait_until_ready(Instant::now()) {
                    return Err("Writer resume is not ready; no prompt sent".into());
                }
                // Wait for the live composer to settle, not just the process.
                let deadline = Instant::now() + Duration::from_secs(20);
                while Instant::now() < deadline {
                    if self
                        .mcp_prompt_blockers(id)
                        .is_ok_and(|v| v.iter().all(|r| *r == "control_not_granted"))
                    {
                        return Ok(());
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err("Writer resume is not ready; no prompt sent".into())
            }
            Err(error) => {
                h.phase = Phase::Released;
                Err(error)
            }
        }
    }
    pub(crate) fn writer_released(&self, id: &str) -> bool {
        self.get(id).is_ok_and(|entry| {
            entry
                .handoff
                .lock()
                .is_ok_and(|h| h.phase == Phase::Released)
        })
    }
    pub(crate) fn writer_holder(&self, id: &str) -> Option<crate::codex_handoff::Holder> {
        let summary = self.session_summary(id)?;
        if summary.definition_id != "codex" {
            return None;
        }
        let native = summary.captured_session_id?;
        let root = codex_resume_root(summary.profile_config_path.as_deref().map(Path::new))?;
        let own: Vec<u32> = self.list().iter().filter_map(|s| s.process_id).collect();
        crate::codex_handoff::holders(Path::new("/proc"), &root, &native, &own)
            .into_iter()
            .find(|holder| Some(holder.pid) != summary.process_id)
    }
}
