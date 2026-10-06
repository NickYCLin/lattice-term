//! Answering a CLI's permission prompt from the chat page.
//!
//! Claude Code runs its `PermissionRequest` hook alongside the terminal
//! dialog, and whichever answers first applies. The hook asks LatticeTerm and
//! waits; the chat page offers the same choice. Answering in the terminal, a
//! later lifecycle report, or the session ending withdraws the question, so
//! the hook exits with no decision and the terminal's answer stands.
//!
//! Codex instead holds its dialog until a `PermissionRequest` hook returns,
//! so a waiting hook would freeze the terminal. Its dialog names its own keys
//! (`y` to proceed, Esc to cancel); the chat page presses them for the user
//! while that dialog is still on screen.

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
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
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

/// The keys a terminal dialog itself offers for each answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct AnswerKeys {
    pub allow: &'static [u8],
    pub deny: &'static [u8],
}

/// Codex: "1. Yes, proceed (y)" and "No, and tell Codex what to do differently (esc)".
pub(super) const CODEX_KEYS: AnswerKeys = AnswerKeys {
    allow: b"y",
    deny: b"\x1b",
};

pub(super) struct PendingApproval {
    request: AgentApprovalRequest,
    /// Present when answering means pressing a key in the terminal.
    keys: Option<AnswerKeys>,
    decision: Mutex<Option<ApprovalDecision>>,
    changed: Condvar,
}

impl PendingApproval {
    pub(super) fn request_id(&self) -> &str {
        &self.request.request_id
    }

    pub(super) fn keys(&self) -> Option<AnswerKeys> {
        self.keys
    }

    pub(super) fn settle(&self, decision: ApprovalDecision) {
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
        self.open_with(session_id, ask, request_id, None)
    }

    /// A dialog answered by pressing its keys. The same dialog redrawn while
    /// it is open is not a second question.
    pub(super) fn open_keyed(
        &self,
        session_id: &str,
        ask: ApprovalAsk,
        request_id: String,
        keys: AnswerKeys,
    ) -> bool {
        if self.current(session_id).is_some() {
            return false;
        }
        self.open_with(session_id, ask, request_id, Some(keys))
            .is_ok()
    }

    fn open_with(
        &self,
        session_id: &str,
        ask: ApprovalAsk,
        request_id: String,
        keys: Option<AnswerKeys>,
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
            keys,
            decision: Mutex::new(None),
            changed: Condvar::new(),
        });
        pending.insert(session_id.to_string(), Arc::clone(&entry));
        Ok(entry)
    }

    /// Removes the named question so exactly one answer reaches the CLI.
    pub(super) fn take(&self, session_id: &str, request_id: &str) -> Option<Arc<PendingApproval>> {
        let mut pending = self.pending.lock().ok()?;
        if pending.get(session_id)?.request.request_id != request_id {
            return None;
        }
        pending.remove(session_id)
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

/// Keys that answer a selection dialog in the terminal: Enter, a lone Esc,
/// a digit or one of Codex's letter shortcuts. Focus reports, mouse motion
/// and arrows do not.
pub(super) fn answers_terminal_prompt(bytes: &[u8]) -> bool {
    bytes == b"\x1b"
        || bytes.contains(&b'\r')
        || (bytes.len() == 1
            && (bytes[0].is_ascii_digit() || matches!(bytes[0], b'y' | b'p' | b'n')))
}

/// What a Codex dialog on screen means for the chat page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum CodexPrompt {
    Opened(ApprovalAsk),
    Closed,
}

const CODEX_QUESTIONS: [(&str, &str); 2] = [
    ("Would you like to run the following command?", "Bash"),
    ("Would you like to make the following edits?", "apply_patch"),
];
/// Codex prints "✔ You approved codex to run …" or "✗ You canceled the
/// request to run …", and may redraw its options between "You" and the rest.
const CODEX_CLOSED: [&str; 3] = [
    "approved codex to",
    "canceled the request to",
    "denied codex",
];
const CODEX_WINDOW_CHARS: usize = 8192;

/// Watches Codex's output for its approval dialog. Codex draws with cursor
/// moves rather than spaces, so text is compared with whitespace removed.
#[derive(Default)]
pub(super) struct CodexPromptScan {
    window: String,
    open: bool,
    /// An escape sequence or character a read split; finished by the next.
    carry: Vec<u8>,
}

impl CodexPromptScan {
    pub(super) fn feed(&mut self, bytes: &[u8]) -> Option<CodexPrompt> {
        let mut joined = std::mem::take(&mut self.carry);
        joined.extend_from_slice(bytes);
        let complete = complete_prefix(&joined);
        self.carry = joined.split_off(complete);
        self.window
            .push_str(&screen_text(&String::from_utf8_lossy(&joined)));
        let length = self.window.chars().count();
        if length > CODEX_WINDOW_CHARS {
            self.window = self
                .window
                .chars()
                .skip(length - CODEX_WINDOW_CHARS)
                .collect();
        }
        let squashed = squash(&self.window);
        if self.open {
            if is_closed(&squashed) {
                self.open = false;
                self.window.clear();
                return Some(CodexPrompt::Closed);
            }
            return None;
        }
        let (question, tool_name) = CODEX_QUESTIONS
            .iter()
            .find(|(question, _)| squashed.contains(&squash(question)))?;
        let options = &squashed[squashed.find(&squash(question))?..];
        // Wait until the dialog has drawn the keys it is about to be sent.
        if !options.contains("Yes,proceed(y)") || !options.contains("(esc)") {
            return None;
        }
        let summary = codex_dialog_summary(&self.window, question);
        // Keep what came after the dialog in this read: it may already say
        // the dialog was answered, and then there is nothing to offer.
        // Only closing markers are looked for from here on, and those are
        // compared without whitespace, so keep the squashed text.
        let after = options
            .rfind("(esc)")
            .map_or("", |index| &options[index + "(esc)".len()..])
            .to_string();
        self.window = after;
        if is_closed(&squash(&self.window)) {
            self.window.clear();
            return None;
        }
        self.open = true;
        Some(CodexPrompt::Opened(ApprovalAsk {
            tool_name: (*tool_name).to_string(),
            summary,
        }))
    }
}

fn is_closed(squashed: &str) -> bool {
    CODEX_CLOSED
        .iter()
        .any(|marker| squashed.contains(&squash(marker)))
}

/// The command after "$", or otherwise what the dialog says before its options.
fn codex_dialog_summary(window: &str, question: &str) -> String {
    let words: Vec<&str> = window.split_whitespace().collect();
    let text = words.join(" ");
    let start = text
        .find(question)
        .map_or(0, |index| index + question.len());
    let body = &text[start..];
    let body = body.find("1. Yes").map_or(body, |end| &body[..end]);
    let body =
        body.trim_end_matches(|character: char| character == '›' || character.is_whitespace());
    let summary = body.rfind("$ ").map_or(body, |index| &body[index + 2..]);
    bounded(summary.trim(), MAX_SUMMARY_CHARS)
}

/// How much of a read can be decoded now: everything before an unfinished
/// escape sequence or a character cut between reads.
fn complete_prefix(bytes: &[u8]) -> usize {
    const LONGEST_HELD: usize = 256;
    let mut end = bytes.len();
    if let Some(escape) = bytes.iter().rposition(|byte| *byte == 0x1b) {
        let rest = &bytes[escape + 1..];
        let finished = match rest.first() {
            None => false,
            Some(b'[') => rest[1..].iter().any(|byte| (0x40..=0x7e).contains(byte)),
            Some(b']') => rest.contains(&0x07) || rest.windows(2).any(|pair| pair == b"\x1b\\"),
            Some(_) => true,
        };
        // A malformed sequence must not hold the rest of the output forever.
        if !finished && bytes.len() - escape <= LONGEST_HELD {
            end = escape;
        }
    }
    match std::str::from_utf8(&bytes[..end]) {
        Err(error) if error.error_len().is_none() => error.valid_up_to(),
        _ => end,
    }
}

/// Terminal output as readable text: each escape sequence becomes a space.
fn screen_text(raw: &str) -> String {
    let mut text = String::with_capacity(raw.len());
    let mut characters = raw.chars();
    while let Some(character) = characters.next() {
        if character != '\u{1b}' {
            text.push(character);
            continue;
        }
        match characters.next() {
            Some('[') => {
                for follower in characters.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&follower) {
                        break;
                    }
                }
            }
            Some(']') => {
                let mut previous = '\0';
                for follower in characters.by_ref() {
                    if follower == '\u{7}' || (previous == '\u{1b}' && follower == '\\') {
                        break;
                    }
                    previous = follower;
                }
            }
            _ => {}
        }
        text.push(' ');
    }
    text
}

fn squash(text: &str) -> String {
    text.chars()
        .filter(|character| !character.is_whitespace())
        .collect()
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
    fn a_codex_dialog_opens_once_and_closes_on_its_own_answer() {
        let mut scan = CodexPromptScan::default();
        // Drawn with cursor moves between words, across several chunks.
        assert_eq!(
            scan.feed(b"Would\x1b[1Cyou like to run the following command?\r\n"),
            None
        );
        assert_eq!(
            scan.feed(b"Reason: read-only\r\n$ mkdir\x1b[1Cbuild\r\n"),
            None,
            "the keys are not drawn yet"
        );
        let opened = scan.feed(
            "\u{203a} 1. Yes, proceed (y)\r\n 2. Yes, and don't ask again (p)\r\n 3. No, and tell Codex what to do differently (esc)".as_bytes(),
        );
        assert_eq!(
            opened,
            Some(CodexPrompt::Opened(ApprovalAsk {
                tool_name: "Bash".into(),
                summary: "mkdir build".into(),
            }))
        );
        // A redraw of the same dialog is not a new question.
        assert_eq!(
            scan.feed(b"Would you like to run the following command? 1. Yes, proceed (y) (esc)"),
            None
        );
        assert_eq!(
            scan.feed("\u{2714} You approved codex to run mkdir build this time".as_bytes()),
            Some(CodexPrompt::Closed)
        );
        assert_eq!(scan.feed(b"Working"), None);
    }

    #[test]
    fn a_dialog_split_into_tiny_reads_is_still_recognized() {
        let screen = "Would\x1b[1Cyou like to run the following command?\r\n$ mkdir\x1b[38;5;2m build\x1b[0m\r\n\u{203a} 1. Yes, proceed (y)\r\n 3. No, and tell Codex what to do differently (esc)\r\n\u{2717} \x1b[1mYou\x1b[0m canceled the request to run mkdir build";
        for size in [1, 2, 3, 7] {
            let mut scan = CodexPromptScan::default();
            let events: Vec<_> = screen
                .as_bytes()
                .chunks(size)
                .filter_map(|chunk| scan.feed(chunk))
                .collect();
            assert_eq!(
                events,
                vec![
                    CodexPrompt::Opened(ApprovalAsk {
                        tool_name: "Bash".into(),
                        summary: "mkdir build".into(),
                    }),
                    CodexPrompt::Closed,
                ],
                "reads of {size} bytes"
            );
        }
    }

    #[test]
    fn a_dialog_already_answered_in_the_same_read_is_not_offered() {
        let mut scan = CodexPromptScan::default();
        assert_eq!(
            scan.feed(
                "Would you like to run the following command? $ mkdir build \u{203a} 1. Yes, proceed (y) 3. No (esc) \u{2717} You canceled the request to run mkdir build"
                    .as_bytes()
            ),
            None
        );
        // The next dialog is still recognized.
        assert!(matches!(
            scan.feed(b"Would you like to run the following command? $ ls 1. Yes, proceed (y) 3. No (esc)"),
            Some(CodexPrompt::Opened(_))
        ));
    }

    #[test]
    fn a_keyed_question_is_answered_by_taking_it() {
        let approvals = Approvals::default();
        assert!(approvals.open_keyed("s1", ask("mkdir a"), "r1".into(), CODEX_KEYS));
        assert!(!approvals.open_keyed("s1", ask("mkdir a"), "r2".into(), CODEX_KEYS));
        assert!(approvals.take("s1", "other").is_none());
        let taken = approvals.take("s1", "r1").unwrap();
        assert_eq!(taken.keys(), Some(CODEX_KEYS));
        assert!(approvals.take("s1", "r1").is_none());
        assert!(approvals.current("s1").is_none());
    }

    #[test]
    fn only_answer_keys_count_as_answering_in_the_terminal() {
        assert!(answers_terminal_prompt(b"y"));
        assert!(answers_terminal_prompt(b"\r"));
        assert!(answers_terminal_prompt(b"\x1b"));
        assert!(answers_terminal_prompt(b"2"));
        assert!(!answers_terminal_prompt(b"\x1b[I"));
        assert!(!answers_terminal_prompt(b"\x1b[B"));
        assert!(!answers_terminal_prompt(b"ab"));
    }
}
