//! Desktop-only, bounded MCP operation history. Never retain request bodies,
//! request IDs, raw errors, terminal output, credentials or launch arguments.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::Path;

#[path = "audit_store.rs"]
mod store;
pub use store::FlushHandle;

pub const HISTORY_LIMIT: usize = 256;
/// Repeated reads of the same session by the same client fold into one
/// entry for this long. Polling a session's output is one activity, not
/// two hundred, and the history must not lose the rest of the record to it.
const READ_FOLD_WINDOW: u64 = 5 * 60 * 1000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Launch,
    Prompt,
    Queue,
    ClearQueue,
    Stop,
    RemoteMetrics,
    RemoteList,
    RemoteExec,
    RemoteUpload,
    RemoteDownload,
    RemoteCancel,
    RemoteStatus,
    Grant,
    Revoke,
    /// Terminal output handed to a client. The content is never recorded.
    Read,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    Accepted,
    Replayed,
    Failed,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub id: u64,
    pub at: u64,
    pub client: String,
    pub action: Action,
    pub outcome: Outcome,
    /// Only a known registry session ID, not arbitrary caller input.
    pub session_id: Option<String>,
    /// Only a bridge-known opaque target ID, never a host or path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    /// How many folded operations this entry stands for, when more than
    /// one; `at` is then the latest and `first_at` the earliest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeated: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub entries: Vec<Entry>,
    pub discarded: u64,
    pub limit: usize,
    #[serde(default)]
    pub persistence: PersistenceState,
    #[serde(default)]
    pub persisted_through_id: Option<u64>,
    #[serde(default)]
    pub persistence_reason: Option<PersistenceReason>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PersistenceState {
    #[default]
    MemoryOnly,
    Pending,
    Ready,
    Unavailable,
}

/// Deliberately fixed codes: an OS error may contain a private path.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PersistenceReason {
    UnsafePath,
    InvalidData,
    ExternalChange,
    IoFailure,
    Busy,
    WorkerStopped,
}

#[derive(Default)]
pub struct History {
    entries: VecDeque<Entry>,
    next: u64,
    discarded: u64,
    persistence: Option<store::Worker>,
    unavailable: Option<PersistenceReason>,
}

impl History {
    /// Capture the current metadata boundary without holding the history lock
    /// during disk I/O. Flush this handle only after releasing that lock.
    pub fn flush_handle(&self) -> Option<FlushHandle> {
        self.persistence
            .as_ref()
            .map(|worker| worker.flush_handle(self.next))
    }

    /// Call only after the daemon exclusively binds its transport. A history
    /// failure must never prevent ordinary CLI sessions from starting.
    pub fn open(data_dir: &Path) -> Self {
        match store::Worker::open(data_dir) {
            Ok((disk, worker)) => Self {
                entries: disk.entries.into(),
                next: disk.next,
                discarded: disk.discarded,
                persistence: Some(worker),
                unavailable: None,
            },
            Err(reason) => Self {
                unavailable: Some(reason),
                ..Self::default()
            },
        }
    }

    pub fn record(
        &mut self,
        client: &str,
        action: Action,
        outcome: Outcome,
        session_id: Option<String>,
        at: u64,
    ) {
        self.record_inner(client, action, outcome, session_id, None, at);
    }

    /// Reading a session's output, folded per client and session so a
    /// polling client cannot push everything else out of a bounded history.
    pub fn record_read(&mut self, client: &str, session_id: &str, outcome: Outcome, at: u64) {
        let client = sanitize_client(client);
        let folded = self.entries.iter_mut().rev().find(|entry| {
            entry.action == Action::Read
                && entry.outcome == outcome
                && entry.client == client
                && entry.session_id.as_deref() == Some(session_id)
        });
        if let Some(entry) = folded.filter(|entry| at.saturating_sub(entry.at) <= READ_FOLD_WINDOW)
        {
            entry.first_at.get_or_insert(entry.at);
            entry.at = at.max(entry.at);
            entry.repeated = Some(entry.repeated.unwrap_or(1).saturating_add(1));
            self.persist();
            return;
        }
        self.record_inner(
            &client,
            Action::Read,
            outcome,
            Some(session_id.to_string()),
            None,
            at,
        );
    }

    pub fn record_target(
        &mut self,
        client: &str,
        action: Action,
        outcome: Outcome,
        target_id: Option<String>,
        at: u64,
    ) {
        self.record_inner(client, action, outcome, None, target_id, at);
    }

    fn record_inner(
        &mut self,
        client: &str,
        action: Action,
        outcome: Outcome,
        session_id: Option<String>,
        target_id: Option<String>,
        at: u64,
    ) {
        self.next = self.next.saturating_add(1);
        if self.entries.len() == HISTORY_LIMIT {
            self.entries.pop_front();
            self.discarded = self.discarded.saturating_add(1);
        }
        self.entries.push_back(Entry {
            id: self.next,
            at,
            client: sanitize_client(client),
            action,
            outcome,
            session_id,
            target_id,
            repeated: None,
            first_at: None,
        });
        self.persist();
    }

    fn persist(&self) {
        if let Some(worker) = &self.persistence {
            worker.submit(store::DiskHistory::new(
                self.entries.iter().cloned().collect(),
                self.next,
                self.discarded,
            ));
        }
    }

    pub fn snapshot(&self) -> Snapshot {
        let (persistence, persisted_through_id, persistence_reason) =
            if let Some(worker) = &self.persistence {
                worker.status()
            } else if let Some(reason) = self.unavailable {
                (PersistenceState::Unavailable, None, Some(reason))
            } else {
                (PersistenceState::MemoryOnly, None, None)
            };
        Snapshot {
            entries: self.entries.iter().rev().cloned().collect(),
            discarded: self.discarded,
            limit: HISTORY_LIMIT,
            persistence,
            persisted_through_id,
            persistence_reason,
        }
    }
}

/// Client names are self-reported: bound them and keep control characters
/// out of anything the interface will show.
fn sanitize_client(client: &str) -> String {
    client
        .chars()
        .filter(|c| !c.is_control())
        .take(128)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_is_bounded_and_reports_discarded_entries() {
        let mut history = History::default();
        for at in 0..(HISTORY_LIMIT + 3) {
            history.record("client", Action::Prompt, Outcome::Accepted, None, at as u64);
        }
        let snapshot = history.snapshot();
        assert_eq!(snapshot.limit, HISTORY_LIMIT);
        assert_eq!(snapshot.entries.len(), HISTORY_LIMIT);
        assert_eq!(snapshot.discarded, 3);
        assert_eq!(snapshot.entries[0].id, (HISTORY_LIMIT + 3) as u64);
        assert_eq!(snapshot.entries.last().unwrap().id, 4);
    }

    #[test]
    fn repeated_reads_of_one_session_fold_into_a_single_counted_entry() {
        let mut history = History::default();
        history.record_read(
            "claude-code 2.1",
            "agent-bg-session-a",
            Outcome::Accepted,
            1_000,
        );
        for at in 1..50 {
            history.record_read(
                "claude-code 2.1",
                "agent-bg-session-a",
                Outcome::Accepted,
                1_000 + at * 1_000,
            );
        }
        // A different client, session or outcome is its own entry.
        history.record_read("codex 1.0", "agent-bg-session-a", Outcome::Accepted, 60_000);
        history.record_read(
            "claude-code 2.1",
            "agent-bg-session-b",
            Outcome::Accepted,
            60_000,
        );
        history.record_read(
            "claude-code 2.1",
            "agent-bg-session-a",
            Outcome::Failed,
            60_000,
        );

        let snapshot = history.snapshot();
        assert_eq!(snapshot.entries.len(), 4, "{:?}", snapshot.entries);
        let folded = snapshot
            .entries
            .iter()
            .find(|entry| {
                entry.client == "claude-code 2.1"
                    && entry.session_id.as_deref() == Some("agent-bg-session-a")
                    && entry.outcome == Outcome::Accepted
            })
            .unwrap();
        assert_eq!(folded.repeated, Some(50));
        assert_eq!(folded.first_at, Some(1_000));
        assert_eq!(folded.at, 50_000);
        assert_eq!(folded.action, Action::Read);

        // Once the window has passed, the next read starts a fresh entry.
        history.record_read(
            "claude-code 2.1",
            "agent-bg-session-a",
            Outcome::Accepted,
            50_000 + READ_FOLD_WINDOW + 1,
        );
        assert_eq!(history.snapshot().entries.len(), 5);
        // Folding never mints an id, so the stored sequence stays contiguous.
        let ids: Vec<u64> = history.entries.iter().map(|entry| entry.id).collect();
        assert_eq!(ids, (1..=5).collect::<Vec<_>>());
    }

    #[test]
    fn client_labels_are_bounded_and_cannot_inject_control_characters() {
        let mut history = History::default();
        history.record(
            &format!("\n\r\x1b{}", "測".repeat(300)),
            Action::Stop,
            Outcome::Unknown,
            Some("agent-bg-session-test".into()),
            1,
        );
        let snapshot = history.snapshot();
        assert_eq!(snapshot.entries[0].client, "測".repeat(128));
        assert_eq!(snapshot.entries[0].outcome, Outcome::Unknown);
        let value = serde_json::to_value(snapshot).unwrap();
        let entry = value["entries"][0].as_object().unwrap();
        assert_eq!(entry.len(), 6);
        for forbidden in [
            "text",
            "requestId",
            "error",
            "arguments",
            "workingDirectory",
        ] {
            assert!(!entry.contains_key(forbidden));
        }
    }
}
