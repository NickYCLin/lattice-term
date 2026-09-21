/**
 * The shell view of a terminal-mode Lattice Remote session.
 *
 * xterm.js owns the screen; this component only moves bytes. Keystrokes go to
 * the backend command, the app-wide Remote hook replays and streams raw PTY
 * bytes, and the agent is told whenever the pane changes size.
 */

import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { RemoteApi, RemoteSessionSummary } from "../../app/useRemoteSessions";
import { TerminalImeFallback } from "../terminal/terminalImeFallback";
import { TerminalImePresentation } from "../terminal/terminalImePresentation";
import {
  TERMINAL_LETTER_SPACING,
  terminalFontFamily,
  terminalTheme,
} from "../terminal/terminalTheme";
import {
  attachTerminalClipboard,
  type TerminalClipboardOptions,
} from "../terminal/terminalClipboard";
import { nativeTerminalClipboard } from "../terminal/nativeTerminalClipboard";
import type { ThemeId } from "../../app/themes";

export function remoteTerminalClipboardOptions(
  shouldProcessKeyEvent: NonNullable<
    TerminalClipboardOptions["shouldProcessKeyEvent"]
  >,
): TerminalClipboardOptions {
  return {
    ...nativeTerminalClipboard,
    shouldProcessKeyEvent,
  };
}

export function attachRemoteTerminalOutput(
  remote: Pick<RemoteApi, "onTerminalData">,
  sessionId: string,
  terminal: Pick<Terminal, "write">,
): () => void {
  return remote.onTerminalData(sessionId, (bytes) => terminal.write(bytes));
}

export function RemoteTerminalView({
  session,
  remote,
  theme,
}: {
  session: RemoteSessionSummary;
  remote: RemoteApi;
  /** Only used to re-theme the terminal when the palette changes. */
  theme: ThemeId;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const remoteRef = useRef(remote);
  remoteRef.current = remote;
  const sessionId = session.sessionId;
  const viewOnly = session.viewOnly;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const terminal = new Terminal({
      fontFamily: terminalFontFamily(),
      fontSize: 13,
      letterSpacing: TERMINAL_LETTER_SPACING,
      lineHeight: 1.2,
      cursorBlink: false,
      scrollback: 5000,
      minimumContrastRatio: 4.5,
      disableStdin: viewOnly,
      theme: terminalTheme(),
    });

    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    termRef.current = terminal;
    const textarea = terminal.textarea;
    const imePresentation = new TerminalImePresentation(terminal, textarea);

    let resizeFrame: number | null = null;
    let reportedSize = "";
    const fitAndReport = () => {
      resizeFrame = null;
      if (host.clientWidth <= 0 || host.clientHeight <= 0) return;
      try {
        fit.fit();
        const size = `${terminal.cols}x${terminal.rows}`;
        if (size === reportedSize) return;
        reportedSize = size;
        void remoteRef.current
          .terminalResize(sessionId, terminal.cols, terminal.rows)
          .catch(() => {
          // The far side kept its old size. Forget this one so the next fit
          // reports again, instead of leaving a full-screen CLI painting
          // against a width and height the terminal no longer has.
          if (reportedSize === size) reportedSize = "";
        });
      } catch {
        // A pane with no layout yet is measured once it becomes visible.
      }
    };
    const scheduleFit = () => {
      if (resizeFrame !== null) return;
      resizeFrame = requestAnimationFrame(fitAndReport);
    };
    fitAndReport();

    attachTerminalClipboard(
      terminal,
      remoteTerminalClipboardOptions(() =>
        imePresentation.shouldProcessTerminalKeyEvent(),
      ),
    );

    const sendInput = (data: string) => {
      if (viewOnly) return;
      void remoteRef.current.terminalInput(sessionId, data).catch(() => {});
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

    const stopData = attachRemoteTerminalOutput(
      remoteRef.current,
      sessionId,
      terminal,
    );

    const observer = new ResizeObserver(scheduleFit);
    observer.observe(host);

    terminal.focus();

    return () => {
      stopData();
      observer.disconnect();
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      textarea?.removeEventListener("input", handleInput);
      imePresentation.dispose();
      imeFallback.dispose();
      typed.dispose();
      terminal.dispose();
      termRef.current = null;
    };
  }, [sessionId, viewOnly]);

  // Re-colour in place rather than rebuilding, so scrollback survives a theme
  // change mid-session.
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = terminalTheme();
    }
  }, [theme]);

  return <div className="terminal-pane remote-terminal" ref={hostRef} />;
}
