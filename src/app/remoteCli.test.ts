import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteCliChannel, type RemoteCliOperation } from "./remoteCli";
afterEach(() => vi.useRealTimers());
describe("remote CLI input", () => {
  it("batches keystrokes, preserves Unicode and sends input before resize", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (_op: RemoteCliOperation) => {});
    const channel = new RemoteCliChannel("one", request, vi.fn());
    channel.input("中"); channel.input("🙂\r"); channel.resize(80, 24);
    await vi.runAllTimersAsync();
    expect(request.mock.calls.map(([op]) => op)).toEqual([{ kind: "cliInput", sessionId: "one", data: "中🙂\r" }, { kind: "cliResize", sessionId: "one", cols: 80, rows: 24 }]);
    channel.input("🙂".repeat(5000));
    await vi.runAllTimersAsync();
    const chunks = request.mock.calls.slice(2).map(([op]) => (op as { data: string }).data);
    expect(chunks.join("")).toBe("🙂".repeat(5000));
    expect(chunks.every(chunk => new TextEncoder().encode(chunk).length <= 16000)).toBe(true);
  });
  it("stops later writes after an uncertain input and never retries it", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => { throw new Error("timeout"); });
    const error = vi.fn();
    const channel = new RemoteCliChannel("one", request, error);
    channel.input("command\r"); channel.resize(90, 30);
    await vi.runAllTimersAsync();
    channel.input("do not send"); await vi.runAllTimersAsync();
    expect(request).toHaveBeenCalledTimes(1); expect(error).toHaveBeenCalledTimes(1);
  });
  it("drops pending input on switching away, including StrictMode restart", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => {});
    const channel = new RemoteCliChannel("old", request, vi.fn());
    channel.input("stale"); channel.flush(); channel.input("also stale"); channel.stop(); channel.resume();
    channel.input("new"); await vi.runAllTimersAsync();
    expect(request).toHaveBeenCalledExactlyOnceWith({ kind: "cliInput", sessionId: "old", data: "new" });
  });
});
