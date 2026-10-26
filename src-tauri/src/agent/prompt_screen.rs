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

    pub(super) fn blocker(&self, definition: &str, now: Instant) -> Option<&'static str> {
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
        let text = screen.contents().to_lowercase();
        if super::has_explicit_working_status(&text)
            || super::has_attention_marker(&text)
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
            .any(|marker| text.contains(marker))
        {
            return Some("terminal_dialog_or_work");
        }
        let (row, col) = screen.cursor_position();
        let rows: Vec<_> = screen.rows(0, screen.size().1.get()).collect();
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
                ) && (2..screen.size().1.get()).all(|column| {
                    screen
                        .cell(row, column)
                        .is_some_and(|cell| cell.contents().trim().is_empty() || cell.dim())
                })
            });
        // Cursor position and dimmed, exact placeholders distinguish an empty
        // composer from real text; all unknown placeholders stay rejected.
        if !(empty || placeholder)
            || col != 2
            || !line.starts_with(marker)
            || screen.row_wrapped(row)
        {
            return Some("terminal_input_not_empty");
        }
        // A menu or continuation below the cursor cannot be mistaken for the
        // main composer. Only the exact known shortcut footer is permitted.
        if rows.iter().skip(usize::from(row) + 1).any(|line| {
            let line = line.trim();
            let percentage = line.strip_prefix("? for shortcuts").unwrap_or(line).trim();
            !matches!(line, "" | "? for shortcuts")
                && !percentage
                    .strip_suffix("% context left")
                    .is_some_and(|number| number.parse::<u8>().is_ok_and(|number| number <= 100))
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
}
