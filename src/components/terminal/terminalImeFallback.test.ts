import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalImeFallback } from "./terminalImeFallback";

describe("TerminalImeFallback", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers committed WebKit text when xterm emits no data", () => {
    vi.useFakeTimers();
    const delivered: string[] = [];
    // These cases exercise the WebKit-only repair path, so force it on
    // regardless of the UA the test runner reports.
    const fallback = new TerminalImeFallback(
      (data) => delivered.push(data),
      undefined,
      undefined,
      undefined,
      true,
    );

    fallback.recordInput("中文", "insertText");
    vi.advanceTimersByTime(31);
    expect(delivered).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(delivered).toEqual(["中文"]);
  });

  it("does not duplicate data xterm emitted before the input event", () => {
    vi.useFakeTimers();
    const delivered: string[] = [];
    // These cases exercise the WebKit-only repair path, so force it on
    // regardless of the UA the test runner reports.
    const fallback = new TerminalImeFallback(
      (data) => delivered.push(data),
      undefined,
      undefined,
      undefined,
      true,
    );

    expect(fallback.recordTerminalData("中")).toBe("中");
    fallback.recordInput("中", "insertText");
    vi.runAllTimers();

    expect(delivered).toEqual([]);
  });

  it("does not duplicate delayed composition data from xterm", () => {
    vi.useFakeTimers();
    const delivered: string[] = [];
    // These cases exercise the WebKit-only repair path, so force it on
    // regardless of the UA the test runner reports.
    const fallback = new TerminalImeFallback(
      (data) => delivered.push(data),
      undefined,
      undefined,
      undefined,
      true,
    );

    fallback.recordInput("中文", "insertFromComposition");
    expect(fallback.recordTerminalData("中文")).toBe("中文");
    vi.runAllTimers();

    expect(delivered).toEqual([]);
  });

  it("suppresses xterm data that arrives after the WebKit fallback", () => {
    vi.useFakeTimers();
    const delivered: string[] = [];
    const fallback = new TerminalImeFallback(
      (data) => delivered.push(data),
      undefined,
      undefined,
      undefined,
      true,
    );

    fallback.recordInput("中文", "insertFromComposition");
    vi.advanceTimersByTime(32);

    expect(delivered).toEqual(["中文"]);
    expect(fallback.recordTerminalData("中文")).toBeNull();
    expect(delivered).toEqual(["中文"]);
  });

  it("keeps repeated identical WebKit input one-for-one", () => {
    vi.useFakeTimers();
    const delivered: string[] = [];
    const fallback = new TerminalImeFallback(
      (data) => delivered.push(data),
      undefined,
      undefined,
      undefined,
      true,
    );

    fallback.recordInput("a", "insertText");
    fallback.recordInput("a", "insertText");
    vi.advanceTimersByTime(32);

    expect(delivered).toEqual(["a", "a"]);
    expect(fallback.recordTerminalData("a")).toBeNull();
    expect(fallback.recordTerminalData("a")).toBeNull();
    expect(delivered).toEqual(["a", "a"]);
  });

  it("stops suppressing unmatched data after the late-event window", () => {
    vi.useFakeTimers();
    const delivered: string[] = [];
    const fallback = new TerminalImeFallback(
      (data) => delivered.push(data),
      undefined,
      undefined,
      undefined,
      true,
    );

    fallback.recordInput("a", "insertText");
    vi.advanceTimersByTime(32);
    vi.advanceTimersByTime(250);

    expect(fallback.recordTerminalData("a")).toBe("a");
  });

  it("ignores unfinished composition updates", () => {
    vi.useFakeTimers();
    const delivered: string[] = [];
    // These cases exercise the WebKit-only repair path, so force it on
    // regardless of the UA the test runner reports.
    const fallback = new TerminalImeFallback(
      (data) => delivered.push(data),
      undefined,
      undefined,
      undefined,
      true,
    );

    fallback.recordInput("ㄓ", "insertCompositionText");
    fallback.recordInput("zh", "insertText", true);
    vi.runAllTimers();

    expect(delivered).toEqual([]);
  });

  it("stays inert on engines that do not need the fallback", () => {
    vi.useFakeTimers();
    const delivered: string[] = [];
    const fallback = new TerminalImeFallback(
      (data) => delivered.push(data),
      undefined,
      undefined,
      undefined,
      false,
    );

    // A committed input with no matching onData would normally be repaired,
    // but a Chromium/Gecko onData is authoritative so the fallback must not
    // schedule a second send.
    fallback.recordInput("中文", "insertText");
    expect(fallback.recordTerminalData("中文")).toBe("中文");
    vi.runAllTimers();

    expect(delivered).toEqual([]);
  });

  it("cancels pending fallbacks on dispose", () => {
    vi.useFakeTimers();
    const delivered: string[] = [];
    // These cases exercise the WebKit-only repair path, so force it on
    // regardless of the UA the test runner reports.
    const fallback = new TerminalImeFallback(
      (data) => delivered.push(data),
      undefined,
      undefined,
      undefined,
      true,
    );

    fallback.recordInput("中文", "insertText");
    fallback.dispose();
    vi.runAllTimers();

    expect(delivered).toEqual([]);
  });

  it("recognizes a split composition followed by its selection space", () => {
    vi.useFakeTimers();
    const delivered: string[] = [];
    const fallback = new TerminalImeFallback(
      (data) => delivered.push(data),
      undefined,
      undefined,
      undefined,
      true,
    );

    expect(fallback.recordTerminalData("看起來")).toBe("看起來");
    expect(fallback.recordTerminalData(" ")).toBe(" ");
    fallback.recordInput("看起來", "insertFromComposition");
    vi.runAllTimers();

    expect(delivered).toEqual([]);
  });

  it("suppresses a late composition even when xterm splits it", () => {
    vi.useFakeTimers();
    const delivered: string[] = [];
    const fallback = new TerminalImeFallback(
      (data) => delivered.push(data),
      undefined,
      undefined,
      undefined,
      true,
    );

    fallback.recordInput("中文", "insertFromComposition");
    vi.advanceTimersByTime(32);

    expect(delivered).toEqual(["中文"]);
    expect(fallback.recordTerminalData("中")).toBeNull();
    expect(fallback.recordTerminalData("文")).toBeNull();
    expect(fallback.recordTerminalData(" ")).toBe(" ");
  });

  it("keeps a selection space bundled after a late composition", () => {
    vi.useFakeTimers();
    const delivered: string[] = [];
    const fallback = new TerminalImeFallback(
      (data) => delivered.push(data),
      undefined,
      undefined,
      undefined,
      true,
    );

    fallback.recordInput("中文", "insertFromComposition");
    vi.advanceTimersByTime(32);

    expect(fallback.recordTerminalData("中文 ")).toBe(" ");
    expect(delivered).toEqual(["中文"]);
  });

  it("only repairs the missing suffix after partial xterm data", () => {
    vi.useFakeTimers();
    const delivered: string[] = [];
    const fallback = new TerminalImeFallback(
      (data) => delivered.push(data),
      undefined,
      undefined,
      undefined,
      true,
    );

    fallback.recordInput("中文", "insertFromComposition");
    expect(fallback.recordTerminalData("中")).toBe("中");
    vi.advanceTimersByTime(32);

    expect(delivered).toEqual(["文"]);
    expect(fallback.recordTerminalData("中文")).toBeNull();
  });
});


it("keeps the Window receiver for fallback scheduling and cancellation", () => {
  vi.useFakeTimers();
  const schedule = globalThis.setTimeout;
  const cancel = globalThis.clearTimeout;
  const sent: string[] = [];
  const fallback = new TerminalImeFallback(data => sent.push(data), undefined, undefined, undefined, true);
  vi.stubGlobal("setTimeout", function (this: unknown, ...args: Parameters<typeof setTimeout>) {
    expect(this).toBe(globalThis);
    return schedule(...args);
  });
  vi.stubGlobal("clearTimeout", function (this: unknown, timer: ReturnType<typeof setTimeout>) {
    expect(this).toBe(globalThis);
    cancel(timer);
  });
  try {
    fallback.recordInput("中文", "insertText");
    fallback.flushPending();
    expect(sent).toEqual(["中文"]);
    fallback.recordInput("測試", "insertText");
    fallback.dispose();
    vi.runAllTimers();
    expect(sent).toEqual(["中文"]);
  } finally {
    fallback.dispose();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
