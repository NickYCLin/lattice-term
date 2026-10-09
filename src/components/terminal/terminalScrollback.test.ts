import { describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { attachTerminalScrollback } from "./terminalScrollback";

function fakeTerminal() {
  const events: Record<string, () => void> = {};
  const parsedDispose = vi.fn();
  const resizedDispose = vi.fn();
  const classes = new Set<string>();
  const terminal = {
    element: {
      classList: {
        toggle: (name: string, enabled: boolean) =>
          enabled ? classes.add(name) : classes.delete(name),
        remove: (name: string) => classes.delete(name),
      },
    },
    options: { scrollbar: { showScrollbar: true } },
    buffer: { active: { baseY: 0 } },
    onWriteParsed: (callback: () => void) => {
      events.parsed = callback;
      return { dispose: parsedDispose };
    },
    onResize: (callback: () => void) => {
      events.resized = callback;
      return { dispose: resizedDispose };
    },
  };
  return { terminal, events, classes, parsedDispose, resizedDispose };
}

describe("terminal scrollback visibility", () => {
  it("keeps the scrollbar visible only when the active buffer has history", () => {
    const { terminal, events, classes } = fakeTerminal();
    attachTerminalScrollback(terminal as unknown as Terminal);
    expect(classes.has("has-scrollback")).toBe(false);
    terminal.buffer.active.baseY = 40;
    events.parsed();
    expect(classes.has("has-scrollback")).toBe(true);
    terminal.buffer.active = { baseY: 0 };
    events.parsed();
    expect(classes.has("has-scrollback")).toBe(false);
  });

  it("updates after resizing and respects an explicitly hidden scrollbar", () => {
    const { terminal, events, classes } = fakeTerminal();
    terminal.buffer.active.baseY = 20;
    attachTerminalScrollback(terminal as unknown as Terminal);
    expect(classes.has("has-scrollback")).toBe(true);
    terminal.buffer.active.baseY = 0;
    events.resized();
    expect(classes.has("has-scrollback")).toBe(false);
    terminal.options.scrollbar.showScrollbar = false;
    terminal.buffer.active.baseY = 20;
    events.parsed();
    expect(classes.has("has-scrollback")).toBe(false);
  });

  it("disposes listeners and removes the visibility marker", () => {
    const { terminal, classes, parsedDispose, resizedDispose } = fakeTerminal();
    terminal.buffer.active.baseY = 20;
    const dispose = attachTerminalScrollback(terminal as unknown as Terminal);
    dispose();
    expect(parsedDispose).toHaveBeenCalledOnce();
    expect(resizedDispose).toHaveBeenCalledOnce();
    expect(classes.has("has-scrollback")).toBe(false);
  });
});
