/**
 * Ctrl+C / Ctrl+V and right-click clipboard support for the terminal panes.
 *
 * xterm.js leaves Ctrl+C as an interrupt and has no Ctrl+V binding, which trips
 * up anyone used to a desktop terminal. This mirrors the Windows Terminal rules:
 * Ctrl+C copies when there is a selection and otherwise falls through to ^C,
 * Ctrl+V pastes, and right-click copies the selection. A right-click without a
 * selection deliberately does not paste: it is too easy to resend a command
 * from the clipboard accidentally, and some xterm builds also handle it.
 * Text is pasted straight in; an image on the clipboard is handed to the
 * optional image handler (agent terminals turn it into a file the CLI can
 * read — SSH panes have no local target, so they simply ignore it).
 *
 * Tip that full-screen CLIs make necessary: when a TUI captures the mouse,
 * plain dragging goes to the application — xterm still selects with Shift+drag.
 */

import type { Terminal } from "@xterm/xterm";

export interface TerminalClipboardOptions {
  /**
   * Native text read used when the WebView clipboard API is unavailable.
   * Linux WebKitGTK commonly rejects navigator.clipboard even for a key event.
   */
  readTextFallback?: () => Promise<string | null>;
  /** Native text write counterpart for copying a terminal selection. */
  writeTextFallback?: (text: string) => Promise<void>;
  /**
   * Called on Ctrl+V when the clipboard holds an image and no usable text.
   * Return value is ignored; the handler decides how to deliver the image.
   */
  onImagePaste?: () => void;
  /**
   * Gives an active IME first refusal over keyboard events. Returning false
   * keeps xterm from finalizing and forwarding unfinished composition text.
   */
  shouldProcessKeyEvent?: (event: KeyboardEvent) => boolean;
  onEscape?: () => void;
}

export function attachTerminalClipboard(
  terminal: Terminal,
  options: TerminalClipboardOptions = {},
): void {
  terminal.attachCustomKeyEventHandler((event) => {
    if (options.shouldProcessKeyEvent?.(event) === false) return false;
    if (event.type !== "keydown") return true;
    if (options.onEscape && event.key === "Escape" && event.isTrusted
      && !event.repeat && !event.isComposing && !event.ctrlKey
      && !event.altKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault();
      options.onEscape();
      return false;
    }
    // Leave anything with Alt/Meta, or plain keys, to xterm and the shell.
    if (!event.ctrlKey || event.altKey || event.metaKey) return true;

    const key = event.key.toLowerCase();

    if (key === "c" && terminal.hasSelection()) {
      const selection = terminal.getSelection();
      if (selection) {
        void writeClipboardText(selection, options.writeTextFallback);
      }
      event.preventDefault();
      return false;
    }

    if (key === "v") {
      event.preventDefault();
      void pasteFromClipboard(
        terminal,
        options.readTextFallback,
        options.onImagePaste,
      );
      return false;
    }

    return true;
  });

  // Callers attach after `terminal.open()`, so the element exists here.
  // Register in capture phase and stop the event before xterm's own handler.
  // This retains right-click copy while preventing a browser/xterm clipboard
  // paste from reaching the CLI (and, on some builds, reaching it twice).
  terminal.element?.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (terminal.hasSelection()) {
      const selection = terminal.getSelection();
      if (selection) {
        void writeClipboardText(selection, options.writeTextFallback);
      }
      // Dropping the highlight is the visible cue that the copy happened.
      terminal.clearSelection();
    }
  }, true);
}

async function writeClipboardText(
  text: string,
  writeTextFallback?: (text: string) => Promise<void>,
): Promise<void> {
  try {
    if (typeof navigator.clipboard?.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // WebKitGTK can expose this method while denying the operation.
  }

  try {
    await writeTextFallback?.(text);
  } catch {
    // A failed copy must not turn into terminal input or an unhandled promise.
  }
}

async function pasteFromClipboard(
  terminal: Terminal,
  readTextFallback?: () => Promise<string | null>,
  onImagePaste?: () => void,
): Promise<void> {
  // Prefer text. Reading structured items lets us tell an image-only clipboard
  // apart from a text one, so the image handler only fires when it should.
  try {
    if (typeof navigator.clipboard?.read === "function") {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        if (item.types.includes("text/plain")) {
          const blob = await item.getType("text/plain");
          const text = await blob.text();
          if (text) {
            terminal.paste(text);
            return;
          }
        }
      }
      const hasImage = items.some((item) =>
        item.types.some((type) => type.startsWith("image/")),
      );
      if (hasImage) {
        onImagePaste?.();
        return;
      }
    }
  } catch {
    // Structured read can be unavailable or blocked; fall back to text below.
  }

  try {
    if (typeof navigator.clipboard?.readText === "function") {
      const text = await navigator.clipboard.readText();
      if (text) {
        terminal.paste(text);
        return;
      }
    }
  } catch {
    // WebKitGTK can expose this method while denying the operation.
  }

  try {
    const text = await readTextFallback?.();
    if (text) {
      terminal.paste(text);
      return;
    }
  } catch {
    // Nothing usable on the native clipboard.
  }

  // Last resort for webviews with no structured clipboard read — WebKitGTK on
  // Linux is the one we ship on — where an image-only clipboard is
  // indistinguishable from an empty one. The handler asks the backend, which
  // reads the real system clipboard and does nothing when it holds no image.
  onImagePaste?.();
}
