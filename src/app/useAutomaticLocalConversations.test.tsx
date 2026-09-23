import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import { fakeAgentApi, fakeDefinition } from "./testFixtures/agentApis";
import { AUTO_LOCAL_CONVERSATIONS_KEY, useAutomaticLocalConversations } from "./useAutomaticLocalConversations";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

it("waits for restoration and opt-in, persists the entire batch before any launch, and stops on save failure", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  const agents = fakeAgentApi({ catalog: [fakeDefinition()], mode: "ready" });
  const order: string[] = [];
  const queue = vi.fn(() => { order.push("save"); });
  const retry = vi.fn(async () => { order.push("launch"); });
  invoke.mockResolvedValue([
    { definitionId: "codex", nativeSessionId: "one", profileId: null, title: "One", workingDirectory: "/work", resumable: true },
    { definitionId: "codex", nativeSessionId: "two", profileId: null, title: "Two", workingDirectory: "/work", resumable: true },
  ]);
  let api!: ReturnType<typeof useAutomaticLocalConversations>;
  function Probe({ ready }: { ready: boolean }) { api = useAutomaticLocalConversations(agents, ready, [], queue, retry); return null; }
  try {
    await act(async () => { root.render(<StrictMode><Probe ready={false} /></StrictMode>); });
    await act(async () => { api.setAutoOpen(true); });
    expect(values.get(AUTO_LOCAL_CONVERSATIONS_KEY)).toBe("true");
    expect(invoke).not.toHaveBeenCalled();
    await act(async () => { root.render(<StrictMode><Probe ready /></StrictMode>); });
    expect(order).toEqual(["save", "launch", "launch"]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("agent_chat_local_history", { profiles: [], all: true });
    await act(async () => { api.setAutoOpen(false); });
    queue.mockImplementation(() => { throw new Error("Storage full"); });
    await act(async () => { api.setAutoOpen(true); });
    expect(api.error).toBe("Storage full");
    expect(retry).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => { root.unmount(); });
    vi.unstubAllGlobals(); vi.clearAllMocks();
  }
});
