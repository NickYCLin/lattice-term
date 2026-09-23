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
