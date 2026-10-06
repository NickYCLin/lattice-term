//! Answering a CLI's permission prompt from the chat page.
//!
//! Claude Code runs its `PermissionRequest` hook alongside the terminal
//! dialog, and whichever answers first applies. The hook asks LatticeTerm and
//! waits; the chat page offers the same choice. Answering in the terminal, a
//! later lifecycle report, or the session ending withdraws the question, so
//! the hook exits with no decision and the terminal's answer stands.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

/// Claude Code cancels a command hook after 600 seconds; answer before that.
pub(super) const WAIT: Duration = Duration::from_secs(590);
/// One question per session at most; this bounds the waiting reporter threads.
const MAX_PENDING: usize = 16;
const MAX_TOOL_NAME_CHARS: usize = 120;
const MAX_SUMMARY_CHARS: usize = 600;

/// What the hook reports: the tool and a readable line about what it does.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ApprovalAsk {
    pub tool_name: String,
    pub summary: String,
}

/// A question the chat page can answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentApprovalRequest {
    pub request_id: String,
    pub tool_name: String,
    pub summary: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalDecision {
    Allow,
    Deny,
    /// Answered elsewhere, superseded or timed out: the hook stays silent.
    Withdrawn,
}

impl ApprovalDecision {
    pub(super) fn response_line(self) -> &'static [u8] {
        match self {
            Self::Allow => b"allow\n",
            Self::Deny => b"deny\n",
            Self::Withdrawn => b"none\n",
        }
    }

    pub(super) fn from_response(response: &str) -> Self {
        match response.trim() {
            "allow" => Self::Allow,
            "deny" => Self::Deny,
            _ => Self::Withdrawn,
        }
    }

    /// The hook's stdout for Claude Code; `None` leaves the dialog to decide.
    pub(super) fn claude_hook_output(self) -> Option<String> {
        let decision = match self {
            Self::Allow => serde_json::json!({ "behavior": "allow" }),
            Self::Deny => serde_json::json!({
                "behavior": "deny",
                "message": "The user declined this on the LatticeTerm chat page.",
            }),
            Self::Withdrawn => return None,
        };
        Some(
            serde_json::json!({
                "hookSpecificOutput": {
                    "hookEventName": "PermissionRequest",
                    "decision": decision,
                }
            })
            .to_string(),
        )
    }
}

pub(super) struct PendingApproval {
    request: AgentApprovalRequest,
    decision: Mutex<Option<ApprovalDecision>>,
    changed: Condvar,
}

impl PendingApproval {
    pub(super) fn request_id(&self) -> &str {
        &self.request.request_id
    }

    fn settle(&self, decision: ApprovalDecision) {
        if let Ok(mut current) = self.decision.lock() {
            current.get_or_insert(decision);
            self.changed.notify_all();
        }
    }

    pub(super) fn wait(&self, timeout: Duration) -> ApprovalDecision {
        let Ok(current) = self.decision.lock() else {
            return ApprovalDecision::Withdrawn;
        };
        self.changed
            .wait_timeout_while(current, timeout, |decision| decision.is_none())
            .ok()
            .and_then(|(decision, _)| *decision)
            .unwrap_or(ApprovalDecision::Withdrawn)
    }
}

#[derive(Default)]
pub(super) struct Approvals {
    pending: Mutex<HashMap<String, Arc<PendingApproval>>>,
}

impl Approvals {
    pub(super) fn open(
        &self,
        session_id: &str,
        ask: ApprovalAsk,
        request_id: String,
    ) -> Result<Arc<PendingApproval>, String> {
        let mut pending = self.pending.lock().map_err(|error| error.to_string())?;
        // A newer question replaces the older one; its hook stops waiting.
        if let Some(previous) = pending.remove(session_id) {
            previous.settle(ApprovalDecision::Withdrawn);
        }
        if pending.len() >= MAX_PENDING {
            return Err("Too many permission prompts are waiting.".to_string());
        }
        let entry = Arc::new(PendingApproval {
            request: AgentApprovalRequest {
                request_id,
                tool_name: bounded(&ask.tool_name, MAX_TOOL_NAME_CHARS),
                summary: bounded(&ask.summary, MAX_SUMMARY_CHARS),
            },
            decision: Mutex::new(None),
            changed: Condvar::new(),
        });
        pending.insert(session_id.to_string(), Arc::clone(&entry));
        Ok(entry)
    }

    pub(super) fn current(&self, session_id: &str) -> Option<AgentApprovalRequest> {
        let pending = self.pending.lock().ok()?;
        pending.get(session_id).map(|entry| entry.request.clone())
    }

    /// Settles the session's question, or only the named one. `true` when a
    /// question was waiting.
    pub(super) fn settle(
        &self,
        session_id: &str,
        request_id: Option<&str>,
        decision: ApprovalDecision,
    ) -> bool {
        let Ok(mut pending) = self.pending.lock() else {
            return false;
        };
        let matches = pending
            .get(session_id)
            .is_some_and(|entry| request_id.is_none_or(|id| entry.request.request_id == id));
        if !matches {
            return false;
        }
        if let Some(entry) = pending.remove(session_id) {
            entry.settle(decision);
        }
        true
    }
}

/// A line people can read before they allow it: the command, the file or
/// the address, and otherwise the tool's own input.
pub(super) fn summarize_tool_input(tool_input: Option<&serde_json::Value>) -> String {
    let Some(input) = tool_input else {
        return String::new();
    };
    for key in ["command", "file_path", "path", "url", "pattern", "query"] {
        if let Some(text) = input.get(key).and_then(serde_json::Value::as_str) {
            return bounded(text, MAX_SUMMARY_CHARS);
        }
    }
    bounded(&input.to_string(), MAX_SUMMARY_CHARS)
}

/// Keys that answer a selection dialog in the terminal: Enter, a lone Esc
/// or a digit. Focus reports, mouse motion and arrows do not.
pub(super) fn answers_terminal_prompt(bytes: &[u8]) -> bool {
    bytes == b"\x1b" || bytes.contains(&b'\r') || (bytes.len() == 1 && bytes[0].is_ascii_digit())
}

fn bounded(text: &str, limit: usize) -> String {
    let clean: String = text
        .chars()
        .map(|character| {
            if character == '\n' || character == '\t' {
                ' '
            } else {
                character
            }
        })
        .filter(|character| !character.is_control())
        .collect();
    if clean.chars().count() <= limit {
        return clean;
    }
    let mut cut: String = clean.chars().take(limit.saturating_sub(1)).collect();
    cut.push('…');
    cut
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ask(summary: &str) -> ApprovalAsk {
        ApprovalAsk {
            tool_name: "Bash".into(),
            summary: summary.into(),
        }
    }

    #[test]
    fn a_question_is_answered_once_and_a_newer_one_replaces_it() {
        let approvals = Approvals::default();
        let first = approvals.open("s1", ask("mkdir a"), "r1".into()).unwrap();
        let second = approvals.open("s1", ask("mkdir b"), "r2".into()).unwrap();
        assert_eq!(first.wait(Duration::ZERO), ApprovalDecision::Withdrawn);
        assert_eq!(approvals.current("s1").unwrap().summary, "mkdir b");

        // An answer for the replaced question changes nothing.
        assert!(!approvals.settle("s1", Some("r1"), ApprovalDecision::Allow));
        assert!(approvals.settle("s1", Some("r2"), ApprovalDecision::Allow));
        assert_eq!(second.wait(Duration::ZERO), ApprovalDecision::Allow);
        assert!(approvals.current("s1").is_none());
        assert!(!approvals.settle("s1", None, ApprovalDecision::Withdrawn));
    }

    #[test]
    fn waiting_ends_when_another_thread_answers() {
        let approvals = Arc::new(Approvals::default());
        let pending = approvals.open("s1", ask("rm x"), "r1".into()).unwrap();
        let answering = Arc::clone(&approvals);
        let answer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            answering.settle("s1", None, ApprovalDecision::Deny)
        });
        assert_eq!(pending.wait(Duration::from_secs(5)), ApprovalDecision::Deny);
        assert!(answer.join().unwrap());
    }

    #[test]
    fn hook_output_follows_the_documented_decision_shape() {
        let allow: serde_json::Value =
            serde_json::from_str(&ApprovalDecision::Allow.claude_hook_output().unwrap()).unwrap();
        assert_eq!(
            allow["hookSpecificOutput"]["hookEventName"],
            "PermissionRequest"
        );
        assert_eq!(allow["hookSpecificOutput"]["decision"]["behavior"], "allow");
        let deny: serde_json::Value =
            serde_json::from_str(&ApprovalDecision::Deny.claude_hook_output().unwrap()).unwrap();
        assert_eq!(deny["hookSpecificOutput"]["decision"]["behavior"], "deny");
        assert!(ApprovalDecision::Withdrawn.claude_hook_output().is_none());
        for decision in [
            ApprovalDecision::Allow,
            ApprovalDecision::Deny,
            ApprovalDecision::Withdrawn,
        ] {
            let line = std::str::from_utf8(decision.response_line()).unwrap();
            assert_eq!(ApprovalDecision::from_response(line), decision);
        }
    }

    #[test]
    fn summaries_show_what_the_tool_will_touch() {
        let command = serde_json::json!({ "command": "mkdir build\nrm -rf x", "description": "d" });
        assert_eq!(summarize_tool_input(Some(&command)), "mkdir build rm -rf x");
        let edit = serde_json::json!({ "file_path": "D:\\p\\a.rs", "old_string": "x" });
        assert_eq!(summarize_tool_input(Some(&edit)), "D:\\p\\a.rs");
        let long = serde_json::json!({ "command": "x".repeat(700) });
        assert_eq!(
            summarize_tool_input(Some(&long)).chars().count(),
            MAX_SUMMARY_CHARS
        );
    }

    #[test]
    fn only_answer_keys_count_as_answering_in_the_terminal() {
        assert!(answers_terminal_prompt(b"\r"));
        assert!(answers_terminal_prompt(b"\x1b"));
        assert!(answers_terminal_prompt(b"2"));
        assert!(!answers_terminal_prompt(b"\x1b[I"));
        assert!(!answers_terminal_prompt(b"\x1b[B"));
        assert!(!answers_terminal_prompt(b"ab"));
    }
}
