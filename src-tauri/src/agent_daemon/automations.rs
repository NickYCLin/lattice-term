//! Chat automations run by the daemon while no window is attached.
//!
//! The window stays the source of truth for the automation list: it pushes
//! the whole list whenever it changes and on every attach, and the daemon
//! keeps only what it needs to fire them — schedule, prompt, target — plus
//! the runtime marks (`nextRunAt`, `lastRunAt`, which ones are running).
//! While a window is attached the daemon stays quiet and the window runs
//! automations itself, streaming into its own chat; once the window is gone
//! the daemon takes over with the same due rules and the same concurrency
//! cap, records every event of each run to a file, and hands the records to
//! the next window, which folds them into ordinary unread chat threads.

use crate::agent_chat::{
    self, AgentChatRegistry, ChatEvent, ChatPermission, ChatSink, ChatTurnRequest,
};
use chrono::{Datelike, Local, NaiveTime, TimeZone, Timelike};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Runs allowed at once, the same cap the window applies.
const MAX_CONCURRENT_RUNS: usize = 2;
/// A run that has not finished by then is recorded as failed and dropped.
const RUN_DEADLINE: Duration = Duration::from_secs(2 * 60 * 60);
/// Events kept per run; text deltas past this are folded away first.
const MAX_RECORDED_EVENTS: usize = 4000;
const MAX_RECORDED_BYTES: usize = 4 * 1024 * 1024;
const STATE_FILE: &str = "state.json";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Schedule {
    Daily {
        /// Local wall-clock `HH:MM`.
        time: String,
        /// `Date.getDay()` numbers; empty means every day.
        #[serde(default)]
        weekdays: Vec<u32>,
    },
    Interval {
        every_minutes: u64,
    },
    After {
        automation_id: String,
        #[serde(default)]
        only_on_success: bool,
    },
}

/// The window's `Automation`, minus what only the window needs (its run
/// history and timestamps); unknown fields are ignored on the way in.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    pub id: String,
    pub name: String,
    pub instructions: String,
    pub definition_id: String,
    pub working_directory: String,
    pub permission: ChatPermission,
    #[serde(default)]
    pub model: String,
    pub schedule: Schedule,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub next_run_at: Option<i64>,
    #[serde(default)]
    pub last_run_at: Option<i64>,
}

/// What the window asks for on attach and after each tick.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationStatus {
    pub id: String,
    pub next_run_at: Option<i64>,
    pub last_run_at: Option<i64>,
    pub running: bool,
}

/// One background run, complete with every chat event, so the window can
/// replay it through the same reducer a live turn goes through.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub run_id: String,
    pub automation_id: String,
    pub automation_name: String,
    pub thread_id: String,
    pub turn_id: String,
    pub definition_id: String,
    pub working_directory: String,
    pub permission: ChatPermission,
    pub model: String,
    /// The prompt, so the window can show it as the user turn.
    #[serde(default)]
    pub instructions: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    /// `running`, `ok` or `error`.
    pub outcome: String,
    pub error: Option<String>,
    pub events: Vec<ChatEvent>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedState {
    automations: Vec<Automation>,
}

pub struct Scheduler {
    dir: PathBuf,
    state: Mutex<SchedulerState>,
}

#[derive(Default)]
struct SchedulerState {
    automations: Vec<Automation>,
    /// Automation id → run id, for runs the daemon itself started.
    running: HashMap<String, String>,
}

/// A run the scheduler decided to start; the caller executes it.
pub struct PlannedRun {
    pub record: RunRecord,
    pub instructions: String,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Port of the window's `nextRunAfter`: the first time the schedule fires
/// strictly after `after`, in local time, or `None` for a chained one.
pub fn next_run_after(schedule: &Schedule, after_ms: i64) -> Option<i64> {
    match schedule {
        Schedule::After { .. } => None,
        Schedule::Interval { every_minutes } => {
            Some(after_ms + (*every_minutes as i64).max(1) * 60_000)
        }
        Schedule::Daily { time, weekdays } => {
            let wall = NaiveTime::parse_from_str(time, "%H:%M")
                .unwrap_or_else(|_| NaiveTime::from_hms_opt(0, 0, 0).expect("midnight"));
            let after = Local
                .timestamp_millis_opt(after_ms)
                .single()
                .unwrap_or_else(Local::now);
            for offset in 0..=8i64 {
                let day = after.date_naive() + chrono::Duration::days(offset);
                let Some(candidate) = Local
                    .with_ymd_and_hms(
                        day.year(),
                        day.month(),
                        day.day(),
                        wall.hour(),
                        wall.minute(),
                        0,
                    )
                    .single()
                else {
                    continue;
                };
                let candidate_ms = candidate.timestamp_millis();
                if candidate_ms <= after_ms {
                    continue;
                }
                let weekday = candidate.weekday().num_days_from_sunday();
                if weekdays.is_empty() || weekdays.contains(&weekday) {
                    return Some(candidate_ms);
                }
            }
            Some(after_ms + 7 * 24 * 60 * 60_000)
        }
    }
}

impl Scheduler {
    /// Loads whatever the last daemon left in `<data_dir>/automations`.
    pub fn open(data_dir: &Path) -> Self {
        let dir = data_dir.join("automations");
        let _ = std::fs::create_dir_all(dir.join("runs"));
        let persisted: PersistedState = std::fs::read_to_string(dir.join(STATE_FILE))
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        Self {
            dir,
            state: Mutex::new(SchedulerState {
                automations: persisted.automations,
                running: HashMap::new(),
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, SchedulerState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn persist(&self, state: &SchedulerState) {
        let persisted = PersistedState {
            automations: state.automations.clone(),
        };
        if let Ok(raw) = serde_json::to_vec(&persisted) {
            let _ = write_private(&self.dir.join(STATE_FILE), &raw);
        }
    }

    /// The window's list, verbatim. Runtime marks come with it (the window
    /// merged the daemon's before sending), so they are taken as given;
    /// only what is running right now here is kept from the old list.
    pub fn replace(&self, automations: Vec<Value>) -> Vec<AutomationStatus> {
        let mut parsed: Vec<Automation> = automations
            .into_iter()
            .filter_map(|value| serde_json::from_value(value).ok())
            .collect();
        let mut state = self.lock();
        let known: HashSet<String> = parsed
            .iter()
            .map(|automation| automation.id.clone())
            .collect();
        state.running.retain(|id, _| known.contains(id));
        parsed.truncate(50);
        // Progress made here while the window was away must not be undone
        // by a window that has not merged it yet: newer marks stay.
        for incoming in &mut parsed {
            let Some(existing) = state
                .automations
                .iter()
                .find(|automation| automation.id == incoming.id)
            else {
                continue;
            };
            let daemon_is_newer =
                existing.last_run_at.unwrap_or(0) > incoming.last_run_at.unwrap_or(0);
            let chained_due = matches!(incoming.schedule, Schedule::After { .. })
                && incoming.next_run_at.is_none()
                && existing.next_run_at.is_some();
            if daemon_is_newer {
                incoming.last_run_at = existing.last_run_at;
                incoming.next_run_at = existing.next_run_at;
            } else if chained_due {
                incoming.next_run_at = existing.next_run_at;
            }
        }
        state.automations = parsed;
        self.persist(&state);
        Self::statuses(&state)
    }

    pub fn status(&self) -> Vec<AutomationStatus> {
        Self::statuses(&self.lock())
    }

    fn statuses(state: &SchedulerState) -> Vec<AutomationStatus> {
        state
            .automations
            .iter()
            .map(|automation| AutomationStatus {
                id: automation.id.clone(),
                next_run_at: automation.next_run_at,
                last_run_at: automation.last_run_at,
                running: state.running.contains_key(&automation.id),
            })
            .collect()
    }

    /// Whether the daemon has a reason to stay alive for automations.
    pub fn has_enabled(&self) -> bool {
        self.lock()
            .automations
            .iter()
            .any(|automation| automation.enabled)
    }

    pub fn running_count(&self) -> usize {
        self.lock().running.len()
    }

    /// Automations due now that the daemon should start itself: none while
    /// a window is attached (it runs them), otherwise oldest due first up
    /// to the cap. Each one returned is already marked running and moved
    /// past its planned time, exactly like the window's `beginAutomationRun`.
    pub fn due(&self, now: i64, attached: bool) -> Vec<PlannedRun> {
        if attached {
            return Vec::new();
        }
        let mut state = self.lock();
        let room = MAX_CONCURRENT_RUNS.saturating_sub(state.running.len());
        if room == 0 {
            return Vec::new();
        }
        let mut due: Vec<usize> = state
            .automations
            .iter()
            .enumerate()
            .filter(|(_, automation)| {
                automation.enabled
                    && automation.next_run_at.is_some_and(|at| at <= now)
                    && !state.running.contains_key(&automation.id)
            })
            .map(|(index, _)| index)
            .collect();
        due.sort_by_key(|index| state.automations[*index].next_run_at.unwrap_or(0));
        due.truncate(room);
        let mut planned = Vec::new();
        for index in due {
            let automation = &mut state.automations[index];
            automation.last_run_at = Some(now);
            automation.next_run_at = next_run_after(&automation.schedule, now);
            let Ok(token) = crate::agent::random_report_token() else {
                continue;
            };
            let run_id = format!("bg-run-{}", &token[..16]);
            let record = RunRecord {
                run_id: run_id.clone(),
                automation_id: automation.id.clone(),
                automation_name: automation.name.clone(),
                thread_id: format!("bg-thread-{}", &token[16..32]),
                turn_id: format!("bg-turn-{}", &token[32..]),
                definition_id: automation.definition_id.clone(),
                working_directory: automation.working_directory.clone(),
                permission: match automation.permission {
                    // Nobody is there to answer an approval card.
                    ChatPermission::Ask => ChatPermission::ReadOnly,
                    other => other,
                },
                model: automation.model.clone(),
                instructions: automation.instructions.clone(),
                started_at: now,
                finished_at: None,
                outcome: "running".to_string(),
                error: None,
                events: Vec::new(),
            };
            let id = automation.id.clone();
            let instructions = automation.instructions.clone();
            state.running.insert(id, run_id);
            planned.push(PlannedRun {
                record,
                instructions,
            });
        }
        if !planned.is_empty() {
            self.persist(&state);
        }
        planned
    }

    /// A run ended: clear its mark and, like the window's
    /// `triggerDependents`, make every automation chained after it due.
    pub fn finish(&self, automation_id: &str, ok: bool, now: i64) {
        let mut state = self.lock();
        state.running.remove(automation_id);
        for automation in &mut state.automations {
            let Schedule::After {
                automation_id: source,
                only_on_success,
            } = &automation.schedule
            else {
                continue;
            };
            if source != automation_id
                || !automation.enabled
                || (*only_on_success && !ok)
                || automation.next_run_at.is_some()
            {
                continue;
            }
            automation.next_run_at = Some(now);
        }
        self.persist(&state);
    }

    fn run_path(&self, run_id: &str) -> PathBuf {
        self.dir.join("runs").join(format!("{run_id}.json"))
    }

    pub fn save_record(&self, record: &RunRecord) {
        if let Ok(raw) = serde_json::to_vec(record) {
            let _ = write_private(&self.run_path(&record.run_id), &raw);
        }
    }

    /// Finished runs, oldest first, removed from disk as they are handed
    /// over: the window that takes them owns them from then on.
    pub fn take_runs(&self) -> Vec<RunRecord> {
        let Ok(entries) = std::fs::read_dir(self.dir.join("runs")) else {
            return Vec::new();
        };
        let mut records: Vec<(PathBuf, RunRecord)> = entries
            .flatten()
            .filter_map(|entry| {
                let path = entry.path();
                let raw = std::fs::read(&path).ok()?;
                let record: RunRecord = serde_json::from_slice(&raw).ok()?;
                (record.outcome != "running").then_some((path, record))
            })
            .collect();
        records.sort_by_key(|(_, record)| record.started_at);
        records
            .into_iter()
            .map(|(path, record)| {
                let _ = std::fs::remove_file(path);
                record
            })
            .collect()
    }
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let temp = path.with_extension("json.tmp");
    let mut file = options.open(&temp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    std::fs::rename(temp, path)
}

/// Collects a run's events and wakes the runner when the turn ends.
struct RecordingSink {
    record: Mutex<RunRecord>,
    bytes: Mutex<usize>,
    finished: tokio::sync::Notify,
}

impl RecordingSink {
    fn new(record: RunRecord) -> Self {
        Self {
            record: Mutex::new(record),
            bytes: Mutex::new(0),
            finished: tokio::sync::Notify::new(),
        }
    }
}

impl ChatSink for RecordingSink {
    fn event(&self, _thread_id: &str, turn_id: &str, event: ChatEvent) {
        let Ok(mut record) = self.record.lock() else {
            return;
        };
        if record.turn_id != turn_id {
            return;
        }
        let finished = matches!(event, ChatEvent::Finished { .. });
        let size = serde_json::to_vec(&event).map(|raw| raw.len()).unwrap_or(0);
        let mut bytes = self
            .bytes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let over = record.events.len() >= MAX_RECORDED_EVENTS || *bytes + size > MAX_RECORDED_BYTES;
        if over && !finished {
            // Keep the shape of the turn: drop streaming deltas first, and
            // if that is not enough, drop everything but the ending.
            if matches!(event, ChatEvent::TextDelta { .. }) {
                return;
            }
            let before = record.events.len();
            record
                .events
                .retain(|kept| !matches!(kept, ChatEvent::TextDelta { .. }));
            if record.events.len() == before {
                return;
            }
        }
        *bytes += size;
        if let ChatEvent::Finished { error, .. } = &event {
            record.finished_at = Some(now_ms());
            record.outcome = if error.is_some() { "error" } else { "ok" }.to_string();
            record.error = error.clone();
        }
        record.events.push(event);
        drop(bytes);
        drop(record);
        if finished {
            self.finished.notify_one();
        }
    }
}

/// Executes one planned run to its end and files the record.
pub async fn execute(
    scheduler: Arc<Scheduler>,
    chat: Arc<AgentChatRegistry>,
    planned: PlannedRun,
    log: impl Fn(&str),
) {
    let automation_id = planned.record.automation_id.clone();
    let request = ChatTurnRequest {
        browser_enabled: false,
        thread_id: planned.record.thread_id.clone(),
        turn_id: planned.record.turn_id.clone(),
        definition_id: planned.record.definition_id.clone(),
        working_directory: planned.record.working_directory.clone(),
        prompt: planned.instructions,
        permission: planned.record.permission,
        model: (!planned.record.model.is_empty()).then(|| planned.record.model.clone()),
        native_session_id: None,
        profile_config_path: None,
        attachments: Vec::new(),
    };
    let sink = Arc::new(RecordingSink::new(planned.record));
    log(&format!("automation {automation_id}: run starting"));
    let started = agent_chat::send(Arc::clone(&sink), Arc::clone(&chat), request).await;
    let mut record = match started {
        Ok(()) => {
            if tokio::time::timeout(RUN_DEADLINE, sink.finished.notified())
                .await
                .is_err()
            {
                let _ = chat.stop(
                    &sink
                        .record
                        .lock()
                        .map(|r| r.thread_id.clone())
                        .unwrap_or_default(),
                );
            }
            sink.record
                .lock()
                .map(|record| record.clone())
                .unwrap_or_else(|poisoned| poisoned.into_inner().clone())
        }
        Err(error) => {
            let mut record = sink
                .record
                .lock()
                .map(|record| record.clone())
                .unwrap_or_else(|poisoned| poisoned.into_inner().clone());
            record.error = Some(error);
            record
        }
    };
    if record.outcome == "running" {
        record.outcome = "error".to_string();
        record.finished_at = Some(now_ms());
        if record.error.is_none() {
            record.error = Some("The run did not finish in time.".to_string());
        }
    }
    let ok = record.outcome == "ok";
    scheduler.save_record(&record);
    scheduler.finish(&automation_id, ok, now_ms());
    log(&format!(
        "automation {automation_id}: run {} ({})",
        record.outcome, record.run_id
    ));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn automation(id: &str, schedule: Schedule, next: Option<i64>) -> Value {
        serde_json::json!({
            "id": id,
            "name": id,
            "instructions": "say hi",
            "definitionId": "codex",
            "workingDirectory": "/tmp",
            "permission": "ask",
            "model": "",
            "schedule": schedule,
            "enabled": true,
            "createdAt": 1,
            "updatedAt": 1,
            "nextRunAt": next,
            "lastRunAt": null,
            "runs": [],
        })
    }

    #[test]
    fn interval_and_chain_schedules_advance_like_the_window() {
        let interval = Schedule::Interval { every_minutes: 15 };
        assert_eq!(next_run_after(&interval, 1_000), Some(1_000 + 15 * 60_000));
        let chain = Schedule::After {
            automation_id: "a".into(),
            only_on_success: true,
        };
        assert_eq!(next_run_after(&chain, 1_000), None);
        let daily = Schedule::Daily {
            time: "09:30".into(),
            weekdays: vec![],
        };
        let now = now_ms();
        let next = next_run_after(&daily, now).unwrap();
        assert!(next > now && next - now <= 24 * 60 * 60_000);
        let at = Local.timestamp_millis_opt(next).single().unwrap();
        assert_eq!((at.hour(), at.minute()), (9, 30));
    }

    #[test]
    fn due_runs_respect_the_cap_and_only_fire_without_a_window() {
        let dir = tempfile::tempdir().unwrap();
        let scheduler = Scheduler::open(dir.path());
        scheduler.replace(vec![
            automation("a", Schedule::Interval { every_minutes: 15 }, Some(10)),
            automation("b", Schedule::Interval { every_minutes: 15 }, Some(20)),
            automation("c", Schedule::Interval { every_minutes: 15 }, Some(30)),
            automation(
                "d",
                Schedule::After {
                    automation_id: "a".into(),
                    only_on_success: false,
                },
                None,
            ),
        ]);
        assert!(scheduler.has_enabled());
        assert!(
            scheduler.due(1_000, true).is_empty(),
            "a window runs them itself"
        );

        let planned = scheduler.due(1_000, false);
        let ids: Vec<&str> = planned
            .iter()
            .map(|p| p.record.automation_id.as_str())
            .collect();
        assert_eq!(ids, vec!["a", "b"], "oldest due first, two at a time");
        assert_eq!(planned[0].record.permission, ChatPermission::ReadOnly);
        assert!(scheduler.due(1_000, false).is_empty(), "the cap is full");

        scheduler.finish("a", true, 2_000);
        let status = scheduler.status();
        let a = status.iter().find(|s| s.id == "a").unwrap();
        assert!(!a.running);
        assert_eq!(a.last_run_at, Some(1_000));
        assert_eq!(a.next_run_at, Some(1_000 + 15 * 60_000));
        let d = status.iter().find(|s| s.id == "d").unwrap();
        assert_eq!(d.next_run_at, Some(2_000), "the chained one became due");

        // A window that has not merged the daemon's progress yet sends
        // older marks; the daemon keeps what it advanced.
        let statuses = scheduler.replace(vec![
            automation("a", Schedule::Interval { every_minutes: 15 }, Some(10)),
            automation(
                "d",
                Schedule::After {
                    automation_id: "a".into(),
                    only_on_success: false,
                },
                None,
            ),
        ]);
        let a = statuses.iter().find(|s| s.id == "a").unwrap();
        assert_eq!(a.last_run_at, Some(1_000));
        assert_eq!(a.next_run_at, Some(1_000 + 15 * 60_000));
        let d = statuses.iter().find(|s| s.id == "d").unwrap();
        assert_eq!(d.next_run_at, Some(2_000));

        // The state survives a daemon restart; runs in flight do not.
        let reopened = Scheduler::open(dir.path());
        assert_eq!(reopened.status().len(), 2);
        assert_eq!(reopened.running_count(), 0);
    }

    #[test]
    fn finished_records_are_handed_over_once() {
        let dir = tempfile::tempdir().unwrap();
        let scheduler = Scheduler::open(dir.path());
        let record = RunRecord {
            run_id: "bg-run-1".into(),
            automation_id: "a".into(),
            automation_name: "a".into(),
            thread_id: "t".into(),
            turn_id: "u".into(),
            definition_id: "codex".into(),
            working_directory: "/tmp".into(),
            permission: ChatPermission::ReadOnly,
            model: String::new(),
            instructions: String::new(),
            started_at: 5,
            finished_at: Some(9),
            outcome: "ok".into(),
            error: None,
            events: vec![ChatEvent::Text {
                item_id: "1".into(),
                text: "hi".into(),
            }],
        };
        scheduler.save_record(&record);
        let mut unfinished = record.clone();
        unfinished.run_id = "bg-run-2".into();
        unfinished.outcome = "running".into();
        scheduler.save_record(&unfinished);

        let taken = scheduler.take_runs();
        assert_eq!(taken.len(), 1);
        assert_eq!(taken[0].run_id, "bg-run-1");
        assert!(scheduler.take_runs().is_empty(), "taken once");
    }

    #[test]
    fn the_recording_sink_bounds_what_it_keeps() {
        let record = RunRecord {
            run_id: "r".into(),
            automation_id: "a".into(),
            automation_name: "a".into(),
            thread_id: "t".into(),
            turn_id: "u".into(),
            definition_id: "codex".into(),
            working_directory: "/tmp".into(),
            permission: ChatPermission::ReadOnly,
            model: String::new(),
            instructions: String::new(),
            started_at: 0,
            finished_at: None,
            outcome: "running".into(),
            error: None,
            events: Vec::new(),
        };
        let sink = RecordingSink::new(record);
        for index in 0..(MAX_RECORDED_EVENTS + 10) {
            sink.event(
                "t",
                "u",
                ChatEvent::TextDelta {
                    item_id: "1".into(),
                    delta: format!("{index} "),
                },
            );
        }
        sink.event(
            "t",
            "other-turn",
            ChatEvent::Notice {
                message: "x".into(),
            },
        );
        sink.event(
            "t",
            "u",
            ChatEvent::Finished {
                native_session_id: None,
                usage: None,
                cost_usd: None,
                duration_ms: None,
                error: None,
            },
        );
        let record = sink.record.lock().unwrap();
        assert!(record.events.len() <= MAX_RECORDED_EVENTS + 1);
        assert_eq!(record.outcome, "ok");
        assert!(matches!(
            record.events.last(),
            Some(ChatEvent::Finished { .. })
        ));
    }
}
