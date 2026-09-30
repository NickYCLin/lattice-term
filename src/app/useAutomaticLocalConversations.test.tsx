import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import { fakeAgentApi } from "./testFixtures/agentApis";
import { AUTO_LOCAL_CONVERSATIONS_KEY, useAutomaticLocalConversations } from "./useAutomaticLocalConversations";
import { useSerialNativeRead, NATIVE_HISTORY_REFRESH_MS } from "./useNativeConversations";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("addEventListener", vi.fn()); vi.stubGlobal("removeEventListener", vi.fn());
  vi.stubGlobal("localStorage", { getItem: (key: string) => key === AUTO_LOCAL_CONVERSATIONS_KEY ? "true" : null });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("refreshes new and renamed/archived records without executing legacy auto-open intents", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  const agents = fakeAgentApi({ mode: "ready" });
  const queue = vi.fn(); const retry = vi.fn();
  const entry = { definitionId: "codex", profileId: null, nativeSessionId: "one", title: "Old", workingDirectory: "/work", resumable: true, updatedAt: 1 };
  invoke.mockResolvedValueOnce({ entries: [entry], hasMore: true, incomplete: false })
    .mockResolvedValue({ entries: [{ ...entry, title: "Renamed", archived: true }], hasMore: false, incomplete: false });
  let api!: ReturnType<typeof useAutomaticLocalConversations>;
  function Probe() { api = useAutomaticLocalConversations(agents, true, [], queue, retry); return null; }
  try {
    await act(async () => { root.render(<Probe />); });
    expect(api.entries[0].title).toBe("Old");
    await act(async () => { await vi.advanceTimersByTimeAsync(NATIVE_HISTORY_REFRESH_MS); });
    expect(api.entries[0]).toMatchObject({ title: "Renamed", archived: true });
    await act(async () => { api.loadMore(); });
    expect(invoke).toHaveBeenLastCalledWith("agent_chat_local_history_page", { profiles: [], limit: 200 });
    expect(queue).not.toHaveBeenCalled(); expect(retry).not.toHaveBeenCalled(); expect(agents.launch).not.toHaveBeenCalled();
    expect(invoke.mock.calls.every(([name]) => name === "agent_chat_local_history_page")).toBe(true);
  } finally { await act(async () => { root.unmount(); }); }
});

it("serializes refresh requests, retains content after an error and stops after unmount", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let resolve!: (value: string) => void;
  const read = vi.fn().mockImplementationOnce(() => new Promise<string>(done => { resolve = done; }))
    .mockRejectedValueOnce(new Error("disk busy")).mockResolvedValue("new");
  let api!: ReturnType<typeof useSerialNativeRead<string>>;
  function Probe() { api = useSerialNativeRead("account", true, 2000, read); return null; }
  try {
    await act(async () => { root.render(<Probe />); });
    await act(async () => { api.refresh(); api.refresh(); await vi.advanceTimersByTimeAsync(8000); });
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => { resolve("old"); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(read).toHaveBeenCalledTimes(2); expect(api.value).toBe("old"); expect(api.error).toBe("disk busy");
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(api.value).toBe("new"); expect(api.error).toBeNull();
    await act(async () => { root.unmount(); });
    const count = read.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(read).toHaveBeenCalledTimes(count);
  } finally { await act(async () => { root.unmount(); }); }
});

it("does not publish a stale account response after selection changes", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let finish!: (value: string) => void;
  let api!: ReturnType<typeof useSerialNativeRead<string>>;
  const first = () => new Promise<string>(done => { finish = done; });
  function Probe({ account }: { account: string }) { api = useSerialNativeRead(account, true, 2000, account === "first" ? first : async () => "second"); return null; }
  try {
    await act(async () => { root.render(<Probe account="first" />); });
    await act(async () => { root.render(<Probe account="second" />); });
    await act(async () => { finish("wrong account"); });
    expect(api.value).toBe("second");
  } finally { await act(async () => { root.unmount(); }); }
});
