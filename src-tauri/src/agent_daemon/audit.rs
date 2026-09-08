//! Desktop-only, bounded MCP write history. Never retain request bodies,
//! request IDs, raw errors, terminal output, credentials or launch arguments.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

pub const HISTORY_LIMIT: usize = 256;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Launch,
    Prompt,
    Queue,
    ClearQueue,
    Stop,
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
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: u64,
    pub at: u64,
    pub client: String,
    pub action: Action,
    pub outcome: Outcome,
    /// Only a known registry session ID, not arbitrary caller input.
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub entries: Vec<Entry>,
    pub discarded: u64,
    pub limit: usize,
}

#[derive(Default)]
pub struct History {
    entries: VecDeque<Entry>,
    next: u64,
    discarded: u64,
}

impl History {
    pub fn record(
        &mut self,
        client: &str,
        action: Action,
        outcome: Outcome,
        session_id: Option<String>,
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
        });
    }

    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            entries: self.entries.iter().rev().cloned().collect(),
            discarded: self.discarded,
            limit: HISTORY_LIMIT,
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
