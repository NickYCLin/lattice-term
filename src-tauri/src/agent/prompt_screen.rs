//! Conservative evidence for a foreground CLI that has not reported readiness.
//! This is a rendered live screen, never a search in output history.
use std::time::{Duration, Instant};

pub(super) const QUIET: Duration = Duration::from_secs(2);
const MAX_ROWS: u16 = 120;
const MAX_COLS: u16 = 300;

pub(super) struct PromptScreen {
    parser: vt100::Parser,
    pending: Vec<u8>,
    invalid: bool,
    last_output: Instant,
    saw_output: bool,
    awaiting_clear: bool,
    synchronized: bool,
    size_supported: bool,
    codex_idle: bool,
    /// Latest report was `done`: a finished turn back at the composer. It is
    /// composer evidence only, never a native-command (`idle`) receipt.
    codex_turn_done: bool,
    codex_idle_at: Option<Instant>,
    review_menu_at: Option<Instant>,
}

impl PromptScreen {
    pub(super) fn new(rows: u16, cols: u16) -> Self {
        Self {
            parser: vt100::Parser::new(
                rows.clamp(1, MAX_ROWS).try_into().unwrap(),
                cols.clamp(1, MAX_COLS).try_into().unwrap(),
                0,
            ),
            pending: Vec::new(),
            invalid: false,
            last_output: Instant::now(),
            saw_output: false,
            awaiting_clear: false,
            synchronized: false,
            size_supported: rows <= MAX_ROWS && cols <= MAX_COLS,
            codex_idle: false,
            codex_turn_done: false,
            codex_idle_at: None,
            review_menu_at: None,
        }
    }

    pub(super) fn feed(&mut self, bytes: &[u8], now: Instant) {
        if bytes.is_empty() {
            return;
        }
        self.last_output = now;
        self.saw_output = true;
        self.pending.extend_from_slice(bytes);
        let end = crate::agent_daemon::mcp::complete_terminal_prefix(&self.pending);
        for control in crate::agent_daemon::mcp::terminal_controls(&self.pending[..end]) {
            if control.starts_with(b"\x1b]7501;") {
                let report = codex_report(control);
                self.codex_idle = report == Some(b"state=idle:app=codex".as_slice());
                self.codex_turn_done = report == Some(b"state=done:app=codex".as_slice());
                self.codex_idle_at = self.codex_idle.then_some(now);
            }
            match control {
                b"\x1b[2J" | b"\x1bc" => self.awaiting_clear = false,
                b"\x1b[?2026h" => self.synchronized = true,
                b"\x1b[?2026l" => self.synchronized = false,
                _ if control.starts_with(b"\x1b[?")
                    && matches!(control.last(), Some(b'h' | b'l')) =>
                {
                    if control[3..control.len() - 1]
                        .split(|byte| *byte == b';')
                        .any(|mode| {
                            std::str::from_utf8(mode)
                                .ok()
                                .and_then(|mode| mode.parse::<u16>().ok())
                                == Some(2026)
                        })
                    {
                        self.synchronized = control.last() == Some(&b'h');
                    }
                }
                _ if [
                    b"\x1bP".as_slice(),
                    b"\x1b_",
                    b"\x1b^",
                    b"\x1bX",
                    b"\x1b]1337;",
                ]
                .iter()
                .any(|prefix| control.starts_with(prefix)) =>
                {
                    self.invalid = true
                }
                _ => {}
            }
        }
        if std::str::from_utf8(&self.pending[..end]).is_err() {
            self.invalid = true;
        }
        self.parser.process(&self.pending[..end]);
        let screen = self.parser.screen();
        if screen.hide_cursor() {
            let content = screen.contents();
            if content
                .lines()
                .any(|line| line.trim() == "Select a review preset")
                && content
                    .lines()
                    .any(|line| line.trim() == "enter select · esc back")
            {
                self.review_menu_at = Some(now);
            }
        }
        self.pending.drain(..end);
        if self.pending.len() > 4096 {
            self.invalid = true;
            self.pending.clear();
        }
    }

    pub(super) fn resize(&mut self, rows: u16, cols: u16) {
        // Width changes do not reproduce xterm reflow. Require a fresh full
        // screen after resize instead of trusting a reconstructed old prompt.
        self.parser.set_size(
            rows.clamp(1, MAX_ROWS).try_into().unwrap(),
            cols.clamp(1, MAX_COLS).try_into().unwrap(),
        );
        self.size_supported = rows <= MAX_ROWS && cols <= MAX_COLS;
        self.last_output = Instant::now();
        self.saw_output = false;
        self.awaiting_clear = true;
    }

    pub(super) fn codex_plan_mode(&self) -> bool {
        self.parser
            .screen()
            .rows(0, self.parser.screen().size().1.get())
            .any(|line| {
                let line = line.trim();
                is_codex_plan_footer(line)
                    || line
                        .strip_prefix("← for agents · ? for shortcuts")
                        .is_some_and(|rest| is_codex_plan_footer(rest.trim()))
            })
    }
    // This proves screen shape only. The caller must also require a NEW sealed
    // compaction record from this exact thread before releasing input.
    pub(super) fn codex_compact_screen_ready_after(&self, after: Instant, now: Instant) -> bool {
        self.last_output > after && self.blocker_with_receipt("codex", now, true).is_none()
    }
    pub(super) fn codex_plan_ready_after(&self, after: Instant, now: Instant) -> bool {
        self.codex_idle
            && self.last_output > after
            && self.codex_plan_mode()
            && self.blocker("codex", now).is_none()
    }

    pub(super) fn codex_review_ready_after(&self, after: Instant, now: Instant) -> bool {
        self.codex_idle
            && self
                .review_menu_at
                .is_some_and(|menu| menu > after && self.last_output > menu)
            && self.blocker("codex", now).is_none()
    }

    pub(super) fn codex_ready_after(&self, after: Instant, now: Instant) -> bool {
        self.codex_idle_at.is_some_and(|at| at > after) && self.blocker("codex", now).is_none()
    }

    pub(super) fn blocker(&self, definition: &str, now: Instant) -> Option<&'static str> {
        self.blocker_with_receipt(definition, now, false)
    }
    fn blocker_with_receipt(
        &self,
        definition: &str,
        now: Instant,
        compaction_receipt_required: bool,
    ) -> Option<&'static str> {
        if !matches!(definition, "codex" | "claude" | "gemini") {
            return Some("terminal_profile_unsupported");
        }
        if self.invalid
            || !self.size_supported
            || self.awaiting_clear
            || self.synchronized
            || !self.saw_output
            || !self.pending.is_empty()
        {
            return Some("terminal_screen_unknown");
        }
        if now.saturating_duration_since(self.last_output) < QUIET {
            return Some("terminal_output_unsettled");
        }
        let screen = self.parser.screen();
        if !screen.bracketed_paste() || screen.hide_cursor() {
            return Some("terminal_prompt_unconfirmed");
        }
        let rows: Vec<_> = screen.rows(0, screen.size().1.get()).collect();
        // Rebuild the screen text like `contents()`, leaving out only the
        // exact Codex start-up header line that names its permission mode.
        let mut text = String::new();
        for (index, line) in rows.iter().enumerate() {
            if !(definition == "codex" && is_codex_permission_header(screen, &rows, index)) {
                text.push_str(line);
            }
            if !u16::try_from(index).is_ok_and(|row| screen.row_wrapped(row)) {
                text.push('\n');
            }
        }
        let (row, col) = screen.cursor_position();
        let Some(line) = rows.get(usize::from(row)) else {
            return Some("terminal_screen_unknown");
        };
        let marker = match definition {
            "codex" => '›',
            "claude" => '❯',
            _ => '>',
        };
        let empty = line.trim() == marker.to_string();
        let placeholder = definition == "codex"
            && line.strip_prefix("› ").is_some_and(|text| {
                matches!(
                    text.trim(),
                    "Write tests for @filename"
                        | "Implement {feature}"
                        | "Find and fix a bug in @filename"
                        | "Explain this codebase"
                        | "Summarize recent commits"
                        | "Improve documentation in @filename"
                        | "Run /review on my current changes"
                        | "Ask Codex to do anything"
                ) && (2..screen.size().1.get()).all(|column| {
                    screen
                        .cell(row, column)
                        .is_some_and(|cell| cell.contents().trim().is_empty() || cell.dim())
                })
            });
        // Cursor position and dimmed, exact placeholders distinguish an empty
        // composer from real text; all unknown placeholders stay rejected.
        // Codex 0.169 renders old turns above its main composer. Words in
        // those turns are not live dialogs. Require all three independent
        // surfaces: native idle, the exact dimmed main-composer placeholder,
        // and its model/status plus shortcut footer. Idle alone also occurs
        // in selection menus, which must never authorize Enter.
        let native_main_composer = definition == "codex"
            && (self.codex_idle || self.codex_turn_done || compaction_receipt_required)
            && placeholder
            && rows
                .iter()
                .skip(usize::from(row) + 1)
                .any(|line| is_codex_shortcut_footer(line.trim()))
            && rows
                .iter()
                .skip(usize::from(row) + 1)
                .any(|line| !line.trim().starts_with('⚠') && is_codex_status_line(line.trim()));
        let text = text.to_lowercase();
        // With a verified idle main composer, old quoted status text higher
        // in history is not a live activity footer. Still reject a current or
        // wrapped working banner in the four rows immediately above it.
        let working = if native_main_composer {
            rows[..usize::from(row)]
                .iter()
                .rev()
                .take(4)
                .any(|line| super::has_explicit_working_status(&line.to_lowercase()))
        } else {
            super::has_explicit_working_status(&text)
        };
        if working
            || (!native_main_composer
                && (super::has_attention_marker(&text)
                    || super::has_actionable_attention_prompt(&text)
                    || [
                        "esc to",
                        "ctrl+c to",
                        "shift+tab",
                        "select an",
                        "select a ",
                        "would you like",
                        "do you trust",
                        "permission",
                        "approve",
                        "approval",
                        "1. ",
                        "1) ",
                        "working",
                        "thinking",
                        "正在",
                        "核准",
                        "選擇",
                    ]
                    .iter()
                    .any(|marker| text.contains(marker))))
        {
            return Some("terminal_dialog_or_work");
        }
        if !(empty || placeholder)
            || col != 2
            || !line.starts_with(marker)
            || screen.row_wrapped(row)
        {
            return Some("terminal_input_not_empty");
        }
        // A menu or continuation below the cursor cannot be mistaken for the
        // main composer. Only the exact known shortcut footer and, for Codex,
        // its model/directory status line are permitted.
        if rows.iter().skip(usize::from(row) + 1).any(|line| {
            let line = line.trim();
            let percentage = line.strip_prefix("? for shortcuts").unwrap_or(line).trim();
            !matches!(line, "" | "? for shortcuts")
                && !percentage
                    .strip_suffix("% context left")
                    .is_some_and(|number| number.parse::<u8>().is_ok_and(|number| number <= 100))
                && !(definition == "codex"
                    && (is_codex_status_line(line)
                        || is_codex_shortcut_footer(line)
                        || is_codex_plan_footer(line)))
        }) {
            return Some("terminal_screen_unknown");
        }
        None
    }

    #[cfg(test)]
    pub(super) fn settle_for_test(&mut self) {
        self.last_output = Instant::now() - QUIET;
    }
}

/// Body of one OSC 7501 report. Codex 0.169 reports `idle` when its composer
/// opens without a turn (start, resume) and `done` when a turn has just
/// finished; both leave the main composer waiting for input. `working`,
/// `blocked`, `clear` and other apps are never composer evidence.
fn codex_report(control: &[u8]) -> Option<&[u8]> {
    let body = control.strip_prefix(b"\x1b]7501;".as_slice())?;
    body.strip_suffix(b"\x1b\\".as_slice())
        .or_else(|| body.strip_suffix(b"\x07".as_slice()))
}

/// The exact unwrapped permission-mode line is safe only under a recognizable
/// Codex header. Its optional parenthesized suffix is not a version check;
/// approval prompts and other permission text continue to block.
fn is_codex_permission_header(screen: &vt100::Screen, rows: &[String], index: usize) -> bool {
    let wrapped = |index: usize| u16::try_from(index).map_or(true, |row| screen.row_wrapped(row));
    rows[index].trim() == "permissions: YOLO mode"
        && !wrapped(index)
        && (index == 0 || !wrapped(index - 1))
        && rows[index.saturating_sub(3)..index].iter().any(|line| {
            let line = line.trim();
            line == ">_ OpenAI Codex"
                || line
                    .strip_prefix(">_ OpenAI Codex (")
                    .is_some_and(|suffix| !suffix.is_empty() && suffix.ends_with(')'))
        })
}

/// Exact Codex 0.169 main-composer footer, with an optional warning count.
fn is_codex_shortcut_footer(line: &str) -> bool {
    line.strip_prefix("← for agents · ? for shortcuts")
        .is_some_and(|rest| {
            rest.trim().is_empty()
                || is_codex_plan_footer(rest.trim())
                || (rest.trim().starts_with('⚠') && is_codex_status_line(rest.trim()))
        })
}

fn is_codex_plan_footer(line: &str) -> bool {
    line.strip_prefix("Plan mode (shift+tab to cycle)")
        .is_some_and(|rest| {
            rest.is_empty()
                || rest.strip_prefix(" · ").is_some_and(|warning| {
                    warning.starts_with('⚠') && is_codex_status_line(warning)
                })
        })
}

/// Codex 0.164 status line below the composer:
/// `<model> <effort> · <directory>[ · <thread>]`, optionally followed by
/// `⚠ N warning(s) · f2 to view`. The thread title is still covered by the
/// whole-screen dialog and work markers checked before this.
fn is_codex_status_line(line: &str) -> bool {
    let (status, warnings) = match line.split_once('⚠') {
        Some((status, warnings)) => (status, Some(warnings)),
        None => (line, None),
    };
    let warnings_ok = warnings.is_none_or(|warnings| {
        warnings
            .trim()
            .strip_suffix(" · f2 to view")
            .and_then(|count| {
                count
                    .strip_suffix(" warnings")
                    .or_else(|| count.strip_suffix(" warning"))
            })
            .is_some_and(|count| count.parse::<u16>().is_ok_and(|count| count > 0))
    });
    if !warnings_ok || (warnings.is_some() && !status.is_empty() && !status.ends_with(' ')) {
        return false;
    }
    let status = status.trim();
    if status.is_empty() {
        return warnings.is_some();
    }
    let mut segments = status.split(" · ");
    let model_ok = segments.next().is_some_and(|segment| {
        let mut words = segment.split(' ');
        let model = words.next().unwrap_or_default();
        let effort = words.next().unwrap_or_default();
        words.next().is_none()
            && !model.is_empty()
            && model
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
            && matches!(
                effort,
                "default" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
            )
    });
    model_ok
        && segments
            .next()
            .is_some_and(|directory| directory.starts_with('/') || directory.starts_with('~'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen(body: &str) -> PromptScreen {
        let mut screen = PromptScreen::new(24, 80);
        screen.feed(
            format!("\x1b[2J\x1b[H\x1b[?2004h\x1b[?25h{body}").as_bytes(),
            Instant::now(),
        );
        screen.settle_for_test();
        screen
    }

    fn codex_0169_fixture() -> PromptScreen {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/codex-0169-resumed-idle.json"
        ))
        .unwrap();
        let mut screen = PromptScreen::new(30, 120);
        screen.feed(
            fixture["output"].as_str().unwrap().as_bytes(),
            Instant::now(),
        );
        screen.settle_for_test();
        screen
    }

    #[test]
    fn real_0169_plan_and_review_cancel_have_verified_receipts_without_a_new_idle_event() {
        for (kind, raw) in [
            (
                "plan",
                include_str!("../../tests/fixtures/codex-0169-plan-mode.json"),
            ),
            (
                "review",
                include_str!("../../tests/fixtures/codex-0169-review-cancel.json"),
            ),
        ] {
            let fixture: serde_json::Value = serde_json::from_str(raw).unwrap();
            let now = Instant::now();
            let mut screen = PromptScreen::new(30, 120);
            screen.feed(
                fixture["before"].as_str().unwrap().as_bytes(),
                now - Duration::from_secs(10),
            );
            assert!(!screen.codex_plan_mode());
            let started = now - Duration::from_secs(5);
            if kind == "review" {
                screen.feed(
                    fixture["menu"].as_str().unwrap().as_bytes(),
                    now - Duration::from_secs(4),
                );
                screen.settle_for_test();
                assert!(
                    screen.review_menu_at.is_some(),
                    "{}",
                    screen.parser.screen().contents()
                );
                assert!(!screen.codex_review_ready_after(started, now));
            }
            screen.feed(
                fixture["after"].as_str().unwrap().as_bytes(),
                now - Duration::from_secs(3),
            );
            assert_eq!(
                screen.blocker("codex", now),
                None,
                "{}: {}",
                kind,
                screen.parser.screen().contents()
            );
            assert!(!screen.codex_ready_after(started, now));
            if kind == "plan" {
                assert!(screen.codex_plan_ready_after(started, now));
            } else {
                assert!(screen.codex_review_ready_after(started, now));
            }
            screen.feed(b"\x1b]7501;state=working:app=codex\x1b\\", now);
            screen.settle_for_test();
            assert!(!screen.codex_plan_ready_after(started, Instant::now()));
            assert!(!screen.codex_review_ready_after(started, Instant::now()));
        }
    }

    #[test]
    fn real_0169_compaction_returns_to_known_composer_without_emitting_another_idle_event() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/codex-0169-compacted-idle.json"
        ))
        .unwrap();
        let now = Instant::now();
        let mut screen = PromptScreen::new(30, 120);
        screen.feed(
            fixture["before"].as_str().unwrap().as_bytes(),
            now - Duration::from_secs(10),
        );
        let started = now - Duration::from_secs(5);
        screen.feed(
            fixture["after"].as_str().unwrap().as_bytes(),
            now - Duration::from_secs(3),
        );
        assert!(
            screen.codex_compact_screen_ready_after(started, now),
            "{}",
            screen.parser.screen().contents()
        );
        assert!(!screen.codex_ready_after(started, now));
    }

    #[test]
    fn native_idle_main_composer_accepts_real_0169_resumed_history() {
        let screen = codex_0169_fixture();
        assert_eq!(screen.blocker("codex", Instant::now()), None);
        for state in ["working", "blocked", "idle:app=other"] {
            let mut screen = codex_0169_fixture();
            let report = if state.contains(':') {
                format!("\x1b]7501;state={state}\x1b\\")
            } else {
                format!("\x1b]7501;state={state}:app=codex\x1b\\")
            };
            screen.feed(report.as_bytes(), Instant::now());
            screen.settle_for_test();
            assert!(screen.blocker("codex", Instant::now()).is_some(), "{state}");
        }
    }

    #[test]
    fn codex_0169_done_report_after_a_turn_counts_as_an_idle_main_composer() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/codex-0169-resumed-idle.json"
        ))
        .unwrap();
        let output = fixture["output"].as_str().unwrap();
        let history = "\x1b[4;1H1. approve the permission change; working notes\x1b[K\x1b[22;3H";
        for (report, ready) in [
            ("state=done:app=codex", true),
            ("state=idle:app=codex", true),
            ("state=clear", false),
            ("state=done:app=other", false),
            ("state=working:app=codex", false),
        ] {
            let mut screen = PromptScreen::new(30, 120);
            let body = output.replace("state=idle:app=codex", report);
            screen.feed(format!("{body}{history}").as_bytes(), Instant::now());
            screen.settle_for_test();
            let blocker = screen.blocker("codex", Instant::now());
            assert_eq!(blocker.is_none(), ready, "{report}: {blocker:?}");
        }
    }

    #[test]
    fn quoted_working_status_in_old_history_does_not_block_a_verified_idle_composer() {
        let mut screen = codex_0169_fixture();
        screen.feed(
            b"\x1b[4;1HPrevious log: Working (12s - esc to interrupt)\x1b[K\x1b[22;3H",
            Instant::now(),
        );
        screen.settle_for_test();
        assert_eq!(screen.blocker("codex", Instant::now()), None);
        screen.feed(
            b"\x1b[20;1HWorking (12s - esc to interrupt)\x1b[22;3H",
            Instant::now(),
        );
        screen.settle_for_test();
        assert_eq!(
            screen.blocker("codex", Instant::now()),
            Some("terminal_dialog_or_work")
        );
    }

    #[test]
    fn native_idle_does_not_authorize_menus_drafts_or_an_unknown_footer() {
        for redraw in [
            "\x1b[2J\x1b[HResume paused goal?\r\n› 1. Resume goal\r\n  2. Keep paused\x1b[2;3H",
            "\x1b[22;1H› human draft\x1b[K\x1b[22;3H",
            "\x1b[25;1H  unknown menu\x1b[K\x1b[22;3H",
            "\x1b[20;1HWorking (12s • esc to interrupt)\x1b[22;3H",
            "\x1b[22;3H\x1b[0mAsk Codex to do anything\x1b[22;3H",
        ] {
            let mut screen = codex_0169_fixture();
            screen.feed(redraw.as_bytes(), Instant::now());
            screen.settle_for_test();
            assert!(
                screen.blocker("codex", Instant::now()).is_some(),
                "{redraw:?}"
            );
        }
        for footer in [
            "← for agents · ? for shortcuts",
            "← for agents · ? for shortcuts  ⚠ 2 warnings · f2 to view",
        ] {
            assert!(is_codex_shortcut_footer(footer));
        }
        for footer in [
            "← for agents · ? for shortcuts approve?",
            "← for agents · ? for shortcuts ⚠ two warnings · f2 to view",
            "← for agents · ? for shortcuts ⚠ 1 warning · f3 to view",
        ] {
            assert!(!is_codex_shortcut_footer(footer));
        }
    }

    #[test]
    fn accepts_only_known_empty_composers_and_dimmed_placeholders() {
        for (definition, marker) in [("codex", "› "), ("claude", "❯ "), ("gemini", "> ")] {
            assert_eq!(screen(marker).blocker(definition, Instant::now()), None);
        }
        let placeholder = "› \x1b[2mWrite tests for @filename\x1b[0m\x1b[1;3H";
        assert_eq!(screen(placeholder).blocker("codex", Instant::now()), None);
        assert_eq!(
            screen("› \r\n? for shortcuts     100% context left\x1b[1;3H")
                .blocker("codex", Instant::now()),
            None
        );
        for body in [
            "› draft",
            "› draft\x1b[1;3H",
            "› Write tests for @filename\x1b[1;3H",
            "› \x1b[2munknown placeholder\x1b[1;3H",
            "shell $ ",
            "❯ ",
            "› \x1b[?25l",
            "› \x1b[?2004l",
        ] {
            assert!(
                screen(body).blocker("codex", Instant::now()).is_some(),
                "{body:?}"
            );
        }
    }

    #[test]
    fn rejects_work_dialogs_menus_and_unknown_lower_rows() {
        for body in [
            "Working (1s)\r\n› ",
            "Thinking\r\n› ",
            "Would you like to run a command?\r\n› ",
            "1. Yes\r\n› ",
            "› \r\nunknown menu\x1b[1;3H",
            "› \r\n1. continue\x1b[1;3H",
        ] {
            assert!(
                screen(body).blocker("codex", Instant::now()).is_some(),
                "{body:?}"
            );
        }
        // Old prompts in scrollback and a cleared prompt are not evidence.
        assert!(screen("› \x1b[2J\x1b[HRunning")
            .blocker("codex", Instant::now())
            .is_some());
    }

    #[test]
    fn requires_complete_stable_output_and_redraw_after_resize() {
        let mut s = screen("› ");
        s.feed(b"\x1b[", Instant::now());
        s.settle_for_test();
        assert_eq!(
            s.blocker("codex", Instant::now()),
            Some("terminal_screen_unknown")
        );
        s.feed(b"0m", Instant::now());
        assert_eq!(
            s.blocker("codex", Instant::now()),
            Some("terminal_output_unsettled")
        );
        s.settle_for_test();
        assert_eq!(s.blocker("codex", Instant::now()), None);
        s.resize(30, 100);
        s.feed("\x1b[?2004h› ".as_bytes(), Instant::now());
        s.settle_for_test();
        assert_eq!(
            s.blocker("codex", Instant::now()),
            Some("terminal_screen_unknown")
        );
        s.feed("\x1b[2J\x1b[H› ".as_bytes(), Instant::now());
        s.settle_for_test();
        assert_eq!(s.blocker("codex", Instant::now()), None);
        for bytes in [b"\x1bPunknown\x1b\\".as_slice(), b"\x1b[?2026h", b"\xff"] {
            let mut s = screen("› ");
            s.feed(bytes, Instant::now());
            s.settle_for_test();
            assert_eq!(
                s.blocker("codex", Instant::now()),
                Some("terminal_screen_unknown")
            );
        }
        let mut s = screen("› \x1b[?25;2026h");
        assert!(s.blocker("codex", Instant::now()).is_some());
        s.feed(b"\x1b[?2026l", Instant::now());
        s.settle_for_test();
        assert_eq!(s.blocker("codex", Instant::now()), None);
        s.resize(30, 100);
        s.feed(b"\x1b]0;fake clear [2J\x07", Instant::now());
        s.settle_for_test();
        assert_eq!(
            s.blocker("codex", Instant::now()),
            Some("terminal_screen_unknown")
        );
    }

    #[test]
    fn fragmented_utf8_and_terminal_controls_keep_the_same_screen() {
        let body = "\x1b[2J\x1b[H\x1b[?2004h\x1b[?25h› ";
        for split in 0..=body.len() {
            let mut s = PromptScreen::new(24, 80);
            s.feed(&body.as_bytes()[..split], Instant::now());
            s.feed(&body.as_bytes()[split..], Instant::now());
            s.settle_for_test();
            assert_eq!(s.blocker("codex", Instant::now()), None, "split {split}");
        }
        let mut s = PromptScreen::new(1000, 1000);
        s.feed("\x1b[?2004h› ".as_bytes(), Instant::now());
        s.settle_for_test();
        assert_eq!(
            s.blocker("codex", Instant::now()),
            Some("terminal_screen_unknown")
        );
        assert_eq!(s.parser.screen().size().0.get(), MAX_ROWS);
    }

    /// Bytes recorded from a fresh Codex 0.164 start-up redraw (100 columns),
    /// with the working directory replaced by a neutral path.
    const CODEX_0164_FRESH_IDLE: &str = "\x1b]7501;state=working:app=codex\x1b\\\x1b[?2026h\x1b[1;1H\x1b[J\x1b[1;24r\x1b[1;1H\x1bM\x1bM\x1bM\x1bM\x1bM\x1bM\x1bM\x1b[r\x1b[1;7r\x1b[1;1H\r\n\x1b[K\x1b[0m\r\n\x1b[K  >_ \x1b[1mOpenAI Codex\x1b[22m\x1b[2m\x1b[2m (v0.164.0)\x1b[0m\r\n\x1b[K     \x1b[2m/home/user/projects\x1b[0m\r\n\x1b[K\x1b[2m  permissions: \x1b[22m\x1b[1mYOLO mode\x1b[0m\r\n\x1b[K\x1b[0m\r\n\x1b[K  \x1b[1mTip:\x1b[22m Maximize usage with GPT-6.1 Sol. Try it on complex work for near-Astra performance at a lower\x1b[0m\r\n\x1b[K  cost.\x1b[0m\x1b[r\x1b[7;3H\x1b[?25l\x1b[8;2H\x1b[0m\x1b[K\x1b[9;2H\x1b[0m\x1b[K\x1b[10;27H\x1b[0m\x1b[K\x1b[11;2H\x1b[0m\x1b[K\x1b[12;56H\x1b[0m\x1b[K\x1b[8;1H \x1b[9;1H \x1b[10;1H\x1b[1m›\x1b[22m \x1b[2mAsk Codex to do anything\x1b[11;1H\x1b[22m \x1b[12;1H  gpt-test default · /home/user/projects · \x1b[1m←\x1b[22m for agents\x1b[0m\x1b[8;1H\x1b[0 q\x1b[8;1H \x1b[0m\x1b[10;3H\x1b[?25h\x1b[?2026l\x1b]0;projects\x07\x1b]7501;state=idle:app=codex\x1b\\\x1b[?2026h\x1b[0m\x1b[10;3H\x1b[?25h\x1b[?2026l";

    /// A resumed Codex 0.164 session as rendered in a desktop tab: start-up
    /// header, earlier transcript, the empty composer and the new status line.
    fn codex_0164_resumed(composer: &str, lower: &str) -> String {
        format!(
            "\r\n  >_ \x1b[1mOpenAI Codex\x1b[22m\x1b[2m (v0.164.0)\x1b[0m\r\n\
             \x20    \x1b[2m/home/user/project\x1b[0m\r\n\
             \x1b[2m  permissions: \x1b[22m\x1b[1mYOLO mode\x1b[0m\r\n\r\n\
             \x20 \x1b[1mTip:\x1b[22m Use the desktop app.\x1b[0m\r\n\r\n\
             \x1b[1m›\x1b[22m 1\r\n\r\n\
             • 目前只收到「1」，請說明要執行的工作。\r\n\r\n\
             \x20 Worked for 4s • Oct 23 at 3:28 PM\r\n\r\n\
             {composer}\r\n\r\n{lower}\x1b[14;3H"
        )
    }

    const CODEX_0164_COMPOSER: &str = "\x1b[1m›\x1b[22m \x1b[2mAsk Codex to do anything\x1b[22m";
    const CODEX_0164_STATUS: &str = "  GPT-6.1-Sol medium · /home/user/project · 整理提交流程                 ⚠ 2 warnings · f2 to view";

    fn wide_screen(body: &str) -> PromptScreen {
        let mut screen = PromptScreen::new(24, 100);
        screen.feed(
            format!("\x1b[2J\x1b[H\x1b[?2004h\x1b[?25h{body}").as_bytes(),
            Instant::now(),
        );
        screen.settle_for_test();
        screen
    }

    #[test]
    fn accepts_codex_0164_idle_header_placeholder_and_status_line() {
        assert_eq!(
            wide_screen(CODEX_0164_FRESH_IDLE).blocker("codex", Instant::now()),
            None
        );
        for status in [
            CODEX_0164_STATUS,
            "  gpt-6.1-sol medium · ~                                   ⚠ 1 warning · f2 to view",
            "  gpt-6.1-sol high · /home/user/project · 落實程式碼檢查與提交推送…",
            "  gpt-test default · /home/user/project · \x1b[1m←\x1b[22m for agents",
            "  gpt-6.1-sol medium · /home/user/project",
        ] {
            let body = codex_0164_resumed(CODEX_0164_COMPOSER, status);
            assert_eq!(
                wide_screen(&body).blocker("codex", Instant::now()),
                None,
                "{status:?}"
            );
        }
    }

    #[test]
    fn codex_idle_header_does_not_depend_on_version() {
        let fixture = codex_0164_resumed(CODEX_0164_COMPOSER, CODEX_0164_STATUS);
        for suffix in ["(v0.153.4)", "(v0.164.0)", "(v999.42.0)", ""] {
            let body = fixture.replace("(v0.164.0)", suffix);
            assert_eq!(
                wide_screen(&body).blocker("codex", Instant::now()),
                None,
                "header suffix: {suffix:?}"
            );
            let dialog = body.replace("Tip:", "Permission required: allow access? Tip:");
            assert_eq!(
                wide_screen(&dialog).blocker("codex", Instant::now()),
                Some("terminal_dialog_or_work"),
                "header suffix: {suffix:?}"
            );
        }
        let unrelated = fixture.replace("OpenAI Codex", "OpenAI Codex impostor");
        assert_eq!(
            wide_screen(&unrelated).blocker("codex", Instant::now()),
            Some("terminal_dialog_or_work")
        );
    }

    #[test]
    fn codex_0164_dialogs_drafts_menus_and_work_still_block() {
        let blocked = |composer: &str, lower: &str| {
            wide_screen(&codex_0164_resumed(composer, lower)).blocker("codex", Instant::now())
        };
        // Real text in the composer, including slash commands.
        assert_eq!(
            blocked("\x1b[1m›\x1b[22m fix the build", CODEX_0164_STATUS),
            Some("terminal_input_not_empty")
        );
        assert_eq!(
            blocked(
                "\x1b[1m›\x1b[22m Ask Codex to do anything",
                CODEX_0164_STATUS
            ),
            Some("terminal_input_not_empty")
        );
        assert!(blocked(
            "\x1b[1m›\x1b[22m /",
            "  /model    choose what model and reasoning effort to use\r\n  /review   review my current changes"
        )
        .is_some());
        // Option menus and unknown rows below the composer.
        for lower in [
            "  1. Yes, proceed\r\n  2. No, and tell Codex what to do differently",
            "  gpt-6.1-sol medium · not-a-directory",
            "  gpt-6.1-sol turbo · /home/user/project",
            "  gpt-6.1-sol medium /home/user/project",
            "  gpt-6.1-sol medium · /home/user/project · 整理⚠ 2 warnings · f2 to view",
            "  ⚠ two warnings · f2 to view",
            "  ⚠ 0 warnings · f2 to view",
            "  gpt-6.1-sol medium · /home/user/project   ⚠ 2 warnings · f3 to view",
            "  gpt-6.1-sol medium · /home/user/project\r\n  unknown menu",
        ] {
            let expected = if lower.contains("1. ") {
                "terminal_dialog_or_work"
            } else {
                "terminal_screen_unknown"
            };
            assert_eq!(
                blocked(CODEX_0164_COMPOSER, lower),
                Some(expected),
                "{lower:?}"
            );
        }
        // Approval dialogs, running turns and reasoning stay dialog/work.
        for screen_text in [
            "\x1b[2J\x1b[HWould you like to run the following command?\r\n\r\n  $ cargo test\r\n\r\n› 1. Yes, proceed (y)\r\n  2. No (esc)\x1b[5;3H",
            "\x1b[2J\x1b[H  >_ OpenAI Codex (v0.164.0)\r\n     /home/user/project\r\n  permissions: YOLO mode\r\n\r\nPermission required: allow network access?\r\n\r\n› \r\n\r\n  gpt-6.1-sol medium · /home/user/project\x1b[7;3H",
            "\x1b[2J\x1b[H• Working (12s • esc to interrupt)\r\n\r\n› \r\n\r\n  gpt-6.1-sol medium · /home/user/project\x1b[3;3H",
            "\x1b[2J\x1b[H• Thinking\r\n\r\n› \r\n\r\n  gpt-6.1-sol medium · /home/user/project\x1b[3;3H",
            "\x1b[2J\x1b[H  Select a model\r\n› 1. gpt-6.1-sol\r\n  2. gpt-test\x1b[2;3H",
        ] {
            assert_eq!(
                wide_screen(screen_text).blocker("codex", Instant::now()),
                Some("terminal_dialog_or_work"),
                "{screen_text:?}"
            );
        }
        // The header exemption is exact and only under the Codex header.
        for header in [
            "  permissions: YOLO mode — approve?",
            "  permissions: on-request",
            "  >_ OpenAI Codex (v0.164.0)\r\n  permissions: YOLO mode\r\n  permission required",
        ] {
            let body =
                format!("{header}\r\n\r\n› \x1b[2mAsk Codex to do anything\x1b[22m\x1b[5;3H");
            assert_eq!(
                wide_screen(&body).blocker("codex", Instant::now()),
                Some("terminal_dialog_or_work"),
                "{header:?}"
            );
        }
        assert_eq!(
            wide_screen("  permissions: YOLO mode\r\n\r\n› \x1b[3;3H")
                .blocker("codex", Instant::now()),
            Some("terminal_dialog_or_work")
        );
        // Codex-only allowances do not extend to other CLIs.
        assert!(wide_screen("❯ \r\n  gpt-6.1-sol medium · ~\x1b[1;3H")
            .blocker("claude", Instant::now())
            .is_some());
        assert!(wide_screen(
            "  >_ OpenAI Codex (v0.164.0)\r\n  permissions: YOLO mode\r\n❯ \x1b[3;3H"
        )
        .blocker("claude", Instant::now())
        .is_some());
    }
}
