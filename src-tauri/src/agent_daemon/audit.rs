//! Desktop-only, bounded MCP operation history. Never retain request bodies,
//! request IDs, raw errors, terminal output, credentials or launch arguments.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::Path;

#[path = "audit_store.rs"]
mod store;
pub use store::FlushHandle;

pub const HISTORY_LIMIT: usize = 256;

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
            client: client
                .chars()
                .filter(|c| !c.is_control())
                .take(128)
                .collect(),
            action,
            outcome,
            session_id,
            target_id,
        });
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
