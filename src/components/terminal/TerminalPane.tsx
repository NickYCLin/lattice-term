/**
 * A live terminal bound to one SSH session.
 *
 * xterm.js owns the screen; this component only moves bytes. Input goes
 * straight to the session, output arrives as events, and the remote side is
 * told whenever the pane changes size so full-screen programs such as `top` or
 * an editor lay themselves out correctly.
 */

import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { SshApi } from "../../app/useSshSessions";
import { useI18n } from "../../i18n/context";
import type { ThemeId } from "../../app/themes";
import { TerminalImeFallback } from "./terminalImeFallback";
import { TerminalImePresentation } from "./terminalImePresentation";
import {
  TERMINAL_LETTER_SPACING,
  terminalFontFamily,
  terminalTheme,
} from "./terminalTheme";
import { attachTerminalClipboard } from "./terminalClipboard";
import { nativeTerminalClipboard } from "./nativeTerminalClipboard";
import { KeyboardIcon } from "../icons";

export function TerminalPane({
  sessionId,
  ssh,
  theme,
  onClosed,
  mobile = false,
}: {
  sessionId: string;
  ssh: SshApi;
  /** Only used to re-theme the terminal when the palette changes. */
  theme: ThemeId;
  onClosed: (reason: string) => void;
  mobile?: boolean;
}) {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  // Kept in refs so the terminal is created once per session, not on every
  // render that happens to change a callback identity.
  const sshRef = useRef(ssh);
  sshRef.current = ssh;
  // A sticky Ctrl for touch keyboards that have none: arm it, and the next
  // typed character is sent as its control code.
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const ctrlArmedRef = useRef(false);
  ctrlArmedRef.current = ctrlArmed;
  const closedRef = useRef(onClosed);
  closedRef.current = onClosed;
  const messageRef = useRef("");
  messageRef.current = t("terminal.inputFailed");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const terminal = new Terminal({
      fontFamily: terminalFontFamily(),
      fontSize: mobile ? 14 : 13,
      letterSpacing: TERMINAL_LETTER_SPACING,
      lineHeight: 1.2,
      // Keep the caret steady across SSH and Agent terminals. Multiple mounted
      // sessions otherwise blink independently and make the workspace flicker.
      cursorBlink: false,
      scrollback: 5000,
      // Force a readable contrast so no CLI can paint text that blends into
      // the dark background (e.g. black-on-black input).
      minimumContrastRatio: 4.5,
      theme: terminalTheme(),
    });

    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);

    termRef.current = terminal;
    fitRef.current = fit;
    const textarea = terminal.textarea;
    const imePresentation = new TerminalImePresentation(
      terminal,
      textarea,
    );

    let resizeFrame: number | null = null;
    let reportedSize = "";
    const fitAndReport = () => {
      resizeFrame = null;
      // Sessions stay mounted across view switches. Never resize a hidden PTY
      // to xterm's 2x1 minimum; doing so makes full-screen programs flash and
      // jump when the terminal becomes visible again.
      if (host.clientWidth <= 0 || host.clientHeight <= 0) return;
      try {
        fit.fit();
        const size = `${terminal.cols}x${terminal.rows}`;
        if (size === reportedSize) return;
        reportedSize = size;
        void sshRef.current
          .resize(sessionId, terminal.cols, terminal.rows)
          .catch(() => {});
      } catch {
        // A pane with no layout yet is measured once it becomes visible.
      }
    };
    const scheduleFit = () => {
      if (resizeFrame !== null) return;
      resizeFrame = requestAnimationFrame(fitAndReport);
    };
    fitAndReport();

    attachTerminalClipboard(terminal, {
      ...nativeTerminalClipboard,
      shouldProcessKeyEvent: () =>
        imePresentation.shouldProcessTerminalKeyEvent(),
    });

    // Silence here is what made a broken session look like a dead keyboard:
    // say so once, in the terminal itself, rather than dropping keystrokes.
    let inputReported = false;
    const sendInput = (rawData: string) => {
      let data = rawData;
      if (ctrlArmedRef.current && data.length === 1) {
        const code = data.toUpperCase().charCodeAt(0);
        if (code >= 64 && code <= 95) {
          data = String.fromCharCode(code - 64);
        }
        setCtrlArmed(false);
      }
      void sshRef.current.send(sessionId, data).catch(() => {
        if (inputReported) return;
        inputReported = true;
        terminal.write(`\r\n\x1b[31m${messageRef.current}\x1b[0m\r\n`);
      });
    };
    const imeFallback = new TerminalImeFallback(sendInput);
    const typed = terminal.onData((rawData) => {
      const data = imeFallback.recordTerminalData(rawData);
      if (data) sendInput(data);
    });
    const handleInput = (event: Event) => {
      const inputEvent = event as InputEvent;
      imeFallback.recordInput(
        inputEvent.data,
        inputEvent.inputType,
        inputEvent.isComposing,
      );
    };
    textarea?.addEventListener("input", handleInput);

    const stopData = sshRef.current.onData(sessionId, (bytes) => {
      terminal.write(bytes);
    });

    const stopClosed = sshRef.current.onClosed(sessionId, (reason) => {
      terminal.write(`\r\n\x1b[2m— ${reason} —\x1b[0m\r\n`);
      closedRef.current(reason);
    });

    // Tell the remote side the real size, coalescing layout changes into one
    // frame and reporting only when rows or columns actually changed.
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(host);

    // On a phone, let the user open the keyboard after seeing the prompt.
    if (!mobile) terminal.focus();

    return () => {
      observer.disconnect();
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      stopData();
      stopClosed();
      textarea?.removeEventListener("input", handleInput);
      imePresentation.dispose();
      imeFallback.dispose();
      typed.dispose();
      terminal.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId, mobile]);

  // Re-colour in place rather than rebuilding, so scrollback survives a theme
  // change mid-session.
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = terminalTheme();
    }
  }, [theme]);

  /** Sends bytes exactly as if they had been typed. */
  function tap(sequence: string) {
    termRef.current?.input(sequence);
    termRef.current?.focus();
  }

  const keybarKeys: Array<{ label: string; sequence: string }> = [
    { label: "Esc", sequence: "" },
    { label: "Tab", sequence: "	" },
    { label: "↑", sequence: "[A" },
    { label: "↓", sequence: "[B" },
    { label: "←", sequence: "[D" },
    { label: "→", sequence: "[C" },
    { label: "|", sequence: "|" },
    { label: "-", sequence: "-" },
    { label: "~", sequence: "~" },
  ];

  return (
    <div className="terminal-pane-wrap">
      <div className="terminal-pane" ref={hostRef} />
      {/* Touch helper row: keys a software keyboard hides or lacks. Hidden on
          fine-pointer desktops by the stylesheet. */}
      <div className="terminal-keybar" role="toolbar" aria-label={t("terminal.keybar.label")}
        onPointerDown={(event) => event.preventDefault()}>
        <button type="button" className="terminal-keybar__key terminal-keybar__keyboard"
          aria-label={t("terminal.keybar.keyboard")}
          onClick={() => {
            const terminal = termRef.current;
            if (terminal?.textarea === document.activeElement) terminal.blur();
            else terminal?.focus();
          }}>
          <KeyboardIcon size={18} />
        </button>
        <button
          type="button"
          className={`terminal-keybar__key${ctrlArmed ? " is-armed" : ""}`}
          aria-pressed={ctrlArmed}
          onClick={() => {
            setCtrlArmed((armed) => !armed);
            termRef.current?.focus();
          }}
        >
          {t("terminal.keybar.ctrl")}
        </button>
        <button type="button" className="terminal-keybar__key" onClick={() => tap("\r")}>
          Enter
        </button>
        {keybarKeys.map((key) => (
          <button
            key={key.label}
            type="button"
            className="terminal-keybar__key"
            onClick={() => tap(key.sequence)}
          >
            {key.label}
          </button>
        ))}
      </div>
    </div>
  );
}
