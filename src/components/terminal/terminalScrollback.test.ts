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
      dataset: {} as Record<string, string>,
      querySelector: vi.fn((_selector: string): unknown => null),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      classList: {
        toggle: (name: string, enabled: boolean) =>
          enabled ? classes.add(name) : classes.delete(name),
        remove: (name: string) => classes.delete(name),
      },
    },
    options: { scrollbar: { showScrollbar: true } },
    rows: 20,
    cols: 80,
    scrollLines: vi.fn(),
    buffer: { active: { baseY: 0, type: "normal" as "normal" | "alternate" }, onBufferChange: (callback: () => void) => {
      events.bufferChanged = callback;
      return { dispose: vi.fn() };
    } },
    onScroll: (callback: () => void) => { events.scrolled = callback; return { dispose: vi.fn() }; },
    onRender: (callback: () => void) => { events.rendered = callback; return { dispose: vi.fn() }; },
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
  it("exposes only buffer geometry and clears it on disposal without changing modes", () => {
    const { terminal, events } = fakeTerminal();
    const dispose = attachTerminalScrollback(terminal as unknown as Terminal);
    expect(terminal.element.dataset).toEqual({ terminalBuffer: "normal", terminalHistoryRows: "0", terminalRows: "20", terminalCols: "80" });
    terminal.buffer.active.baseY = 40;
    events.parsed();
    expect(terminal.element.dataset.terminalHistoryRows).toBe("40");
    terminal.buffer.active = { baseY: 0, type: "alternate" };
    events.bufferChanged();
    expect(terminal.element.dataset.terminalBuffer).toBe("alternate");
    expect(terminal.element.dataset.terminalHistoryRows).toBe("0");
    expect(terminal.buffer.active.type).toBe("alternate");
    dispose();
    expect(terminal.element.dataset).toEqual({});
  });
  it("refits after font metrics make the screen overlap the scrollbar", () => {
    const { terminal, events } = fakeTerminal();
    terminal.element.querySelector.mockImplementation(selector => ({ getBoundingClientRect: () =>
      selector === ".xterm-screen" ? { right: 600 } : { left: 580, width: 14 } }) as never);
    const refit = vi.fn();
    const dispose = attachTerminalScrollback(terminal as unknown as Terminal, refit);
    events.rendered();
    expect(refit).toHaveBeenCalledOnce();
    dispose();
  });

  it("updates the visibility marker when the active buffer changes or scrolls", () => {
    const { terminal, events, classes } = fakeTerminal();
    const dispose = attachTerminalScrollback(terminal as unknown as Terminal);
    expect(classes.has("has-scrollbar")).toBe(true);
    terminal.buffer.active.baseY = 10;
    events.bufferChanged();
    expect(classes.has("has-scrollback")).toBe(true);
    terminal.buffer.active.baseY = 0;
    events.scrolled();
    expect(classes.has("has-scrollback")).toBe(false);
    dispose();
    expect(classes.has("has-scrollbar")).toBe(false);
  });
  it("keeps the scrollbar visible only when the active buffer has history", () => {
    const { terminal, events, classes } = fakeTerminal();
    attachTerminalScrollback(terminal as unknown as Terminal);
    expect(classes.has("has-scrollback")).toBe(false);
    terminal.buffer.active.baseY = 40;
    events.parsed();
    expect(classes.has("has-scrollback")).toBe(true);
    terminal.buffer.active = { baseY: 0, type: "alternate" };
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

describe("local terminal history wheel", () => {
  function setup(preferHistoryWheel = true) {
    const { terminal, events } = fakeTerminal();
    terminal.buffer.active.baseY = 100;
    terminal.element.querySelector.mockReturnValue({ getBoundingClientRect: () => ({ height: 240 }) });
    const dispose = attachTerminalScrollback(terminal as unknown as Terminal, undefined, preferHistoryWheel);
    const onWheel = terminal.element.addEventListener.mock.calls[0][1] as (event: WheelEvent) => void;
    const wheel = (overrides: Partial<WheelEvent> = {}) => {
      const event = { deltaY: -24, deltaMode: 0, altKey: false, ctrlKey: false, shiftKey: false,
        preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), ...overrides };
      onWheel(event as unknown as WheelEvent);
      return event;
    };
    return { terminal, events, dispose, wheel };
  }

  it("handles history in capture phase before the CLI mouse protocol", () => {
    const { terminal, dispose, wheel } = setup();
    const event = wheel();
    expect(terminal.element.addEventListener).toHaveBeenCalledWith("wheel", expect.any(Function),
      { capture: true, passive: false });
    expect(terminal.scrollLines).toHaveBeenCalledWith(-2);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
    dispose();
    expect(terminal.element.removeEventListener).toHaveBeenCalledWith("wheel", expect.any(Function), true);
  });

  it.each([{ deltaMode: 1, deltaY: -3, lines: -3 }, { deltaMode: 2, deltaY: 1, lines: 20 },
    { shiftKey: true, lines: -10 }])("normalizes wheel units and fast scrolling: %j", ({ lines, ...event }) => {
    const { terminal, wheel } = setup();
    wheel(event);
    expect(terminal.scrollLines).toHaveBeenCalledWith(lines);
  });

  it("accumulates trackpad fractions without forwarding input and resets on direction changes", () => {
    const { terminal, wheel } = setup();
    wheel({ deltaY: -5 });
    wheel({ deltaY: -5 });
    expect(terminal.scrollLines).not.toHaveBeenCalled();
    wheel({ deltaY: -5 });
    expect(terminal.scrollLines).toHaveBeenCalledWith(-1);
    wheel({ deltaY: 12 });
    expect(terminal.scrollLines).toHaveBeenLastCalledWith(1);
  });

  it.each([{ altKey: true }, { ctrlKey: true }, { deltaY: 0 }])("keeps modified and horizontal wheels unchanged: %j", overrides => {
    const { terminal, wheel } = setup();
    const event = wheel(overrides);
    expect(terminal.scrollLines).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("does not intercept SSH, alternate buffers or terminals without history", () => {
    const remote = setup(false);
    expect(remote.wheel().preventDefault).not.toHaveBeenCalled();
    const { terminal, wheel } = setup();
    terminal.buffer.active.type = "alternate";
    expect(wheel().preventDefault).not.toHaveBeenCalled();
    terminal.buffer.active.type = "normal";
    terminal.buffer.active.baseY = 0;
    expect(wheel().preventDefault).not.toHaveBeenCalled();
    expect(terminal.scrollLines).not.toHaveBeenCalled();
  });

  it("clears partial wheel movement when the buffer changes", () => {
    const { terminal, events, wheel } = setup();
    wheel({ deltaY: -10 });
    terminal.buffer.active.type = "alternate";
    events.bufferChanged();
    terminal.buffer.active.type = "normal";
    wheel({ deltaY: -5 });
    expect(terminal.scrollLines).not.toHaveBeenCalled();
  });
});
