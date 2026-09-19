import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { ThemeId } from "../../app/themes";
import { useI18n } from "../../i18n/context";
import { TerminalImeFallback } from "./terminalImeFallback";
import { TerminalImePresentation } from "./terminalImePresentation";
import {
  TERMINAL_LETTER_SPACING,
  terminalFontFamily,
  terminalTheme,
} from "./terminalTheme";
import { attachTerminalClipboard } from "./terminalClipboard";
import { nativeTerminalClipboard } from "./nativeTerminalClipboard";

/** The byte stream behind one terminal: an agent PTY or a plain local shell. */
export interface PtyTerminalIo {
  send: (data: string) => Promise<void>;
  resize: (cols: number, rows: number) => Promise<void>;
  onData: (handler: (bytes: Uint8Array) => void) => () => void;
  onClosed: (handler: (reason: string) => void) => () => void;
  /** Why it already ended, when it ended before this view mounted. */
  closedReason?: () => string | null | undefined;
  /** Saves a clipboard image somewhere the program can read, returning its path. */
  pasteImage?: () => Promise<string | null>;
}

export function PtyTerminal({
  ioKey,
  io,
  theme,
  inputFailedText,
  className = "",
}: {
  /** Changing this starts over with a fresh xterm for another PTY. */
  ioKey: string;
  io: PtyTerminalIo;
  theme: ThemeId;
  inputFailedText: string;
  className?: string;
}) {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const ioRef = useRef(io);
  const errorRef = useRef(inputFailedText);
  ioRef.current = io;
  errorRef.current = inputFailedText;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const terminal = new Terminal({
      fontFamily: terminalFontFamily(),
      fontSize: 13,
      letterSpacing: TERMINAL_LETTER_SPACING,
      lineHeight: 1.2,
      // A steady cursor avoids the distracting full-pane repaint/flicker that
      // becomes especially noticeable with several mounted Agent sessions.
      cursorBlink: false,
      scrollback: 10000,
      // Force a readable contrast so no CLI can paint text that blends into
      // the dark background (e.g. black-on-black input).
      minimumContrastRatio: 4.5,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;
    const textarea = terminal.textarea;
    const imePresentation = new TerminalImePresentation(
      terminal,
      textarea,
    );

    let resizeFrame: number | null = null;
    let reportedSize = "";
    const fitAndReport = () => {
      resizeFrame = null;
      // This pane stays mounted while another app view or sibling CLI is
      // visible. Fitting a display:none host would collapse the PTY to 2x1 and
      // make full-screen CLIs redraw twice when the pane returns.
      if (host.clientWidth <= 0 || host.clientHeight <= 0) return;
      try {
        fit.fit();
        const size = `${terminal.cols}x${terminal.rows}`;
        if (size === reportedSize) return;
        reportedSize = size;
        void ioRef.current.resize(terminal.cols, terminal.rows).catch(() => {});
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
      // The agent runs locally, so an image on the clipboard can be written to
      // a temp file and its path pasted in — the shape CLIs like Claude Code
      // and Gemini accept for attaching an image.
      onImagePaste: () => {
        const paste = ioRef.current.pasteImage;
        if (!paste) return;
        void (async () => {
          try {
            const path = await paste();
            if (path) terminal.paste(path);
          } catch {
            // No image delivered; leave the prompt untouched.
          }
        })();
      },
    });

    let inputReported = false;
    const sendInput = (data: string) => {
      void ioRef.current.send(data).catch(() => {
        if (inputReported) return;
        inputReported = true;
        terminal.write(`\r\n\x1b[31m${errorRef.current}\x1b[0m\r\n`);
      });
    };
    const imeFallback = new TerminalImeFallback(sendInput);
    const typed = terminal.onData((data) => {
      const input = imeFallback.recordTerminalData(data);
      if (input) sendInput(input);
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
    const stopData = ioRef.current.onData((bytes) => {
      terminal.write(bytes);
    });
    const showClosed = (reason: string) => {
      terminal.options.disableStdin = true;
      terminal.write(
        `\r\n\x1b[2m— ${t("terminal.closed", { reason })} —\x1b[0m\r\n`,
      );
    };
    const initialClosedReason = ioRef.current.closedReason?.();
    if (initialClosedReason) showClosed(initialClosedReason);
    const stopClosed = ioRef.current.onClosed(showClosed);

    const observer = new ResizeObserver(scheduleFit);
    observer.observe(host);
    terminal.focus();

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
      terminalRef.current = null;
    };
  }, [ioKey]);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = terminalTheme();
    }
  }, [theme]);

  return <div className={`terminal-pane ${className}`.trim()} ref={hostRef} />;
}
