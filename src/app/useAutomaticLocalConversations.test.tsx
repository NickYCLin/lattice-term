import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import { fakeAgentApi, fakeDefinition } from "./testFixtures/agentApis";
import { AUTO_LOCAL_CONVERSATIONS_KEY, useAutomaticLocalConversations } from "./useAutomaticLocalConversations";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

it("imports hundreds of conversations without launching CLIs and reports save failures", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  const agents = fakeAgentApi({ catalog: [fakeDefinition()], mode: "ready" });
  const order: string[] = [];
  const queue = vi.fn((_entries: readonly unknown[]) => { order.push("save"); });
  invoke.mockResolvedValue(Array.from({ length: 300 }, (_, index) => ({
    definitionId: "codex", nativeSessionId: `native-${index}`, profileId: null,
    title: `Conversation ${index}`, workingDirectory: "/work", resumable: true,
  })));
  let api!: ReturnType<typeof useAutomaticLocalConversations>;
  function Probe({ ready }: { ready: boolean }) { api = useAutomaticLocalConversations(agents, ready, [], queue); return null; }
  try {
    await act(async () => { root.render(<StrictMode><Probe ready={false} /></StrictMode>); });
    await act(async () => { api.setAutoOpen(true); });
    expect(values.get(AUTO_LOCAL_CONVERSATIONS_KEY)).toBe("true");
    expect(invoke).not.toHaveBeenCalled();
    await act(async () => { root.render(<StrictMode><Probe ready /></StrictMode>); });
    expect(order).toEqual(["save"]);
    expect(queue.mock.calls[0][0]).toHaveLength(300);
    expect(agents.launch).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("agent_chat_local_history", { profiles: [], all: true });
    await act(async () => { api.setAutoOpen(false); });
    queue.mockImplementation(() => { throw new Error("Storage full"); });
    await act(async () => { api.setAutoOpen(true); });
    expect(api.error).toBe("Storage full");
    expect(agents.launch).not.toHaveBeenCalled();
  } finally {
    await act(async () => { root.unmount(); });
    vi.unstubAllGlobals(); vi.clearAllMocks();
  }
});
