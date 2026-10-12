import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import { fakeAgentApi } from "./testFixtures/agentApis";
import { useSessionPromptQueue } from "./useSessionPromptQueue";
import type { AgentQueuedPrompt } from "./useAgentSessions";

it("does not read the queue of a closed session", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  const agents = fakeAgentApi();
  function Probe() { useSessionPromptQueue("closed", agents, false); return null; }
  try {
    await act(async () => root.render(<Probe />));
    expect(agents.readQueue).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});

it("reports backend save failures without resending the prompt", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  const prompt: AgentQueuedPrompt = { id: "one", text: "original", data: "expected", editable: true };
  const agents = fakeAgentApi({ readQueue: vi.fn().mockResolvedValue([prompt]),
    editQueuedPrompt: vi.fn().mockRejectedValue(new Error("connection unavailable")) });
  let api!: ReturnType<typeof useSessionPromptQueue>;
  function Probe() { api = useSessionPromptQueue("session", agents); return null; }
  try {
    await act(async () => root.render(<Probe />));
    await act(async () => { await expect(api.save(prompt, "edited")).rejects.toThrow("connection unavailable"); });
    expect(api.error).toBe("connection unavailable");
    expect(api.prompts).toEqual([prompt]);
    expect(agents.enqueue).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});

it("ignores stale queue reads and refuses to resurrect an already dispatched prompt", async () => {
  vi.useFakeTimers();
  const root = createRoot(installFakeDom() as unknown as Element);
  const prompt: AgentQueuedPrompt = { id: "one", text: "first\nsecond", data: "expected", editable: true };
  let finish!: (prompts: AgentQueuedPrompt[]) => void;
  const readQueue = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue([prompt]);
  const editQueuedPrompt = vi.fn().mockResolvedValue(false);
  const agents = fakeAgentApi({ readQueue, editQueuedPrompt });
  let api!: ReturnType<typeof useSessionPromptQueue>;
  function Probe({ id }: { id: string }) { api = useSessionPromptQueue(id, agents); return null; }
  try {
    await act(async () => root.render(<Probe id="first" />));
    await act(async () => root.render(<Probe id="second" />));
    await act(async () => finish([{ ...prompt, id: "stale" }]));
    expect(api.prompts).toEqual([prompt]);
    await act(async () => { expect(await api.save(prompt, "edited")).toBe(false); });
    expect(editQueuedPrompt).toHaveBeenCalledExactlyOnceWith("second", prompt, "edited");
    expect(api.error).toBe("queue-message-changed");
    expect(agents.enqueue).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    const reads = readQueue.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(readQueue).toHaveBeenCalledTimes(reads);
  } finally { vi.useRealTimers(); vi.clearAllMocks(); }
});
