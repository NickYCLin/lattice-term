import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import { fakeAgentApi } from "./testFixtures/agentApis";
import { useSessionConversation, type SessionConversationMessage } from "./useSessionConversation";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

it("reads the selected session, rejects stale reads and sends only through that session's existing queue", async () => {
  vi.useFakeTimers();
  const root = createRoot(installFakeDom() as unknown as Element);
  let finish!: (value: SessionConversationMessage[]) => void;
  invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue([{ role: "assistant", text: "second session" }]);
  const enqueue = vi.fn().mockRejectedValueOnce(new Error("CLI is waiting for approval")).mockResolvedValue(0);
  const agents = fakeAgentApi({ enqueue });
  let api!: ReturnType<typeof useSessionConversation>;
  function Probe({ id }: { id: string }) { api = useSessionConversation(id, agents); return null; }
  try {
    await act(async () => { root.render(<Probe id="first" />); });
    await act(async () => { root.render(<Probe id="second" />); });
    await act(async () => { finish([{ role: "assistant", text: "stale" }]); });
    expect(api.messages[0].text).toBe("second session");
    await act(async () => { expect(await api.send("hello")).toBe(false); });
    expect(api.sendError).toContain("approval");
    await act(async () => { expect(await api.send("hello")).toBe(true); });
    expect(enqueue.mock.calls).toEqual([["second", "hello"], ["second", "hello"]]);
    expect(agents.launch).not.toHaveBeenCalled();
    expect(invoke.mock.calls.every(([command]) => command === "agent_session_conversation")).toBe(true);
    await act(async () => { root.unmount(); });
    const reads = invoke.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(invoke).toHaveBeenCalledTimes(reads);
  } finally { vi.useRealTimers(); vi.clearAllMocks(); }
});

it("shows live output during a slow transcript read and preserves the actual read error", async () => {
  vi.useFakeTimers();
  const root = createRoot(installFakeDom() as unknown as Element);
  let reject!: (error: Error) => void;
  let output!: (text: string) => void;
  const unsubscribe = vi.fn();
  const agents = fakeAgentApi({ onOutputTail: (_id, handler) => { output = handler; return unsubscribe; } });
  invoke.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
  let api!: ReturnType<typeof useSessionConversation>;
  function Probe() { api = useSessionConversation("selected", agents); return null; }
  try {
    await act(async () => { root.render(<Probe />); });
    await act(async () => { output("\x1b[31mWorking on files\x1b[0m"); await vi.advanceTimersByTimeAsync(8000); });
    expect(api.slow).toBe(true);
    expect(api.output).toBe("Working on files");
    expect(invoke).toHaveBeenCalledTimes(1);
    await act(async () => { reject(new Error("The account directory is unavailable.")); });
    expect(api.readError).toBe("The account directory is unavailable.");
    expect(api.loading).toBe(false);
    expect(api.output).toBe("Working on files");
    await act(async () => { root.unmount(); });
    expect(unsubscribe).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); vi.clearAllMocks(); }
});
