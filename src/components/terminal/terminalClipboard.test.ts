import { afterEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { attachTerminalClipboard } from "./terminalClipboard";

function fakeTerminal(selection: string | null) {
  const listeners: Record<string, (event: Event) => void> = {};
  const listenerOptions: Record<string, boolean | AddEventListenerOptions | undefined> = {};
  let keyEventHandler: ((event: KeyboardEvent) => boolean) | undefined;
  const terminal = {
    attachCustomKeyEventHandler: (
      handler: (event: KeyboardEvent) => boolean,
    ) => {
      keyEventHandler = handler;
    },
    element: {
      addEventListener: (
        type: string,
        handler: (event: Event) => void,
        options?: boolean | AddEventListenerOptions,
      ) => {
        listeners[type] = handler;
        listenerOptions[type] = options;
      },
    },
    hasSelection: () => selection !== null,
    getSelection: () => selection ?? "",
    clearSelection: vi.fn(),
    paste: vi.fn(),
  };
  return {
    terminal: terminal as unknown as Terminal,
    mock: terminal,
    listeners,
    listenerOptions,
    keyEventHandler: () => keyEventHandler,
  };
}

function fakeContextMenuEvent(): Event {
  return {
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn(),
  } as unknown as Event;
}

function fakePasteKeyEvent(): KeyboardEvent {
  return {
    type: "keydown",
    key: "v",
    ctrlKey: true,
    altKey: false,
    metaKey: false,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent;
}

function fakeCopyKeyEvent(): KeyboardEvent {
  return {
    type: "keydown",
    key: "C",
    ctrlKey: true,
    shiftKey: true,
    altKey: false,
    metaKey: false,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("terminal right-click", () => {
  it("routes only a trusted single Escape key to explicit cancellation", () => {
    const onEscape = vi.fn();
    const { terminal, keyEventHandler } = fakeTerminal(null);
    attachTerminalClipboard(terminal, { onEscape });
    const event = {
      type: "keydown", key: "Escape", isTrusted: true, repeat: false,
      ctrlKey: false, altKey: false, metaKey: false, shiftKey: false,
      isComposing: false, preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    expect(keyEventHandler()!(event)).toBe(false);
    expect(onEscape).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    for (const change of [
      { isTrusted: false }, { repeat: true }, { ctrlKey: true },
      { altKey: true }, { metaKey: true }, { shiftKey: true },
      { isComposing: true }, { type: "keyup" }, { key: "ArrowUp" },
    ]) {
      expect(keyEventHandler()!({ ...event, ...change } as KeyboardEvent)).toBe(true);
    }
    expect(onEscape).toHaveBeenCalledOnce();
    attachTerminalClipboard(terminal, { onEscape, shouldProcessKeyEvent: () => false });
    expect(keyEventHandler()!(event)).toBe(false);
    expect(onEscape).toHaveBeenCalledOnce();
    attachTerminalClipboard(terminal);
    expect(keyEventHandler()!(event)).toBe(true);
  });

  it("copies and drops the selection when one exists", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { terminal, mock, listeners } = fakeTerminal("cli answer");
    attachTerminalClipboard(terminal);

    const event = fakeContextMenuEvent();
    listeners.contextmenu(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith("cli answer");
    expect(mock.clearSelection).toHaveBeenCalled();
    expect(mock.paste).not.toHaveBeenCalled();
  });

  it("uses the native writer when WebKitGTK denies clipboard writes", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    const writeTextFallback = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { terminal, listeners } = fakeTerminal("native copy");
    attachTerminalClipboard(terminal, { writeTextFallback });

    listeners.contextmenu(fakeContextMenuEvent());

    await vi.waitFor(() =>
      expect(writeTextFallback).toHaveBeenCalledWith("native copy"),
    );
  });

  it("never pastes the clipboard when no selection exists", async () => {
    const readText = vi.fn().mockResolvedValue("pasted text");
    vi.stubGlobal("navigator", { clipboard: { readText } });
    const onImagePaste = vi.fn();
    const { terminal, mock, listeners, listenerOptions } = fakeTerminal(null);
    attachTerminalClipboard(terminal, { onImagePaste });

    const event = fakeContextMenuEvent();
    listeners.contextmenu(event);
    await Promise.resolve();
    expect(readText).not.toHaveBeenCalled();
    expect(mock.paste).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(listenerOptions.contextmenu).toBe(true);
    expect(onImagePaste).not.toHaveBeenCalled();
  });
});

describe("terminal Ctrl+V", () => {
  it("asks the backend for an image when WebKitGTK reports empty text", async () => {
    const readText = vi.fn().mockResolvedValue("");
    vi.stubGlobal("navigator", { clipboard: { readText } });
    const onImagePaste = vi.fn();
    const { terminal, mock, keyEventHandler } = fakeTerminal(null);
    attachTerminalClipboard(terminal, { onImagePaste });

    const event = fakePasteKeyEvent();
    expect(keyEventHandler()?.(event)).toBe(false);
    expect(event.preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(onImagePaste).toHaveBeenCalledOnce());
    expect(mock.paste).not.toHaveBeenCalled();
  });

  it("supports the conventional Linux Ctrl+Shift+C shortcut", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    const writeTextFallback = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { terminal, keyEventHandler } = fakeTerminal("selected output");
    attachTerminalClipboard(terminal, { writeTextFallback });

    const event = fakeCopyKeyEvent();
    expect(keyEventHandler()?.(event)).toBe(false);
    expect(event.preventDefault).toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(writeTextFallback).toHaveBeenCalledWith("selected output"),
    );
  });
});
