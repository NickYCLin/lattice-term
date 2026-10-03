import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import { dismissNativeConversation, loadDismissedNativeConversations, MAX_DISMISSED_NATIVE } from "./nativeConversationDismissals";
import { useNativeConversations, useSerialNativeRead } from "./useNativeConversations";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

let listeners: Map<string, Set<(event: { key: string | null }) => void>>;
beforeEach(() => {
  vi.useFakeTimers();
  listeners = new Map();
  vi.stubGlobal("addEventListener", (type: string, listener: (event: { key: string | null }) => void) => {
    listeners.set(type, (listeners.get(type) ?? new Set()).add(listener));
  });
  vi.stubGlobal("removeEventListener", (type: string, listener: (event: { key: string | null }) => void) => { listeners.get(type)?.delete(listener); });
  vi.stubGlobal("dispatchEvent", () => { listeners.forEach(set => set.forEach(listener => listener({ key: null }))); return true; });
  vi.stubGlobal("localStorage", memoryStorage());
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

const entry = (nativeSessionId: string) => ({
  definitionId: "codex", profileId: null, nativeSessionId, title: nativeSessionId, workingDirectory: "/work", resumable: true, updatedAt: 1,
});

it("hides archives by default and resets pagination without accepting a stale archive reply", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let archiveReply!: (value: unknown) => void;
  invoke.mockImplementation((_command, args) => args.includeArchived
    ? new Promise(done => { archiveReply = done; })
    : Promise.resolve({ entries: [], hasMore: true, incomplete: false }));
  let api!: ReturnType<typeof useNativeConversations>;
  function Probe() { api = useNativeConversations(true); return null; }
  try {
    await act(async () => { root.render(<Probe />); });
    expect(api.includeArchived).toBe(false);
    await act(async () => { api.loadMore(); });
    expect(api.limit).toBe(200);
    await act(async () => { api.setIncludeArchived(true); });
    expect(api.limit).toBe(100);
    expect(invoke).toHaveBeenLastCalledWith("agent_chat_local_history_page", { profiles: [], limit: 100, includeArchived: true });
    await act(async () => { api.setIncludeArchived(false); });
    await act(async () => { archiveReply({ entries: [{ archived: true }], hasMore: false, incomplete: false }); });
    expect(api.entries).toEqual([]);
    expect(api.includeArchived).toBe(false);
  } finally { await act(async () => { root.unmount(); }); }
});

it("drops a deleted conversation from the synced list and keeps it out on later reads", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  invoke.mockResolvedValue({ entries: [entry("kept"), entry("deleted")], hasMore: false, incomplete: false });
  let api!: ReturnType<typeof useNativeConversations>;
  function Probe() { api = useNativeConversations(true); return null; }
  try {
    await act(async () => { root.render(<Probe />); });
    expect(api.entries.map(item => item.nativeSessionId)).toEqual(["kept", "deleted"]);
    await act(async () => { dismissNativeConversation(entry("deleted")); });
    expect(api.entries.map(item => item.nativeSessionId)).toEqual(["kept"]);
    await act(async () => { api.refresh(); });
    expect(api.entries.map(item => item.nativeSessionId)).toEqual(["kept"]);
  } finally { await act(async () => { root.unmount(); }); }
});

it("keeps dismissals per account and bounded", () => {
  const storage = memoryStorage();
  dismissNativeConversation({ definitionId: "claude", profileId: "work", nativeSessionId: "same" }, storage);
  dismissNativeConversation({ definitionId: "claude", profileId: "work", nativeSessionId: "same" }, storage);
  const dismissed = loadDismissedNativeConversations(storage);
  expect(dismissed.size).toBe(1);
  expect(dismissed.has(JSON.stringify(["claude", null, "same"]))).toBe(false);
  const full = Array.from({ length: MAX_DISMISSED_NATIVE }, (_, index) => JSON.stringify(["gemini", null, String(index)]));
  storage.setItem("latticeterm.nativeConversationDismissed.v1", JSON.stringify(full));
  dismissNativeConversation({ definitionId: "gemini", profileId: null, nativeSessionId: "newest" }, storage);
  const bounded = loadDismissedNativeConversations(storage);
  expect(bounded.size).toBe(MAX_DISMISSED_NATIVE);
  expect(bounded.has(full[0])).toBe(false);
  expect(bounded.has(JSON.stringify(["gemini", null, "newest"]))).toBe(true);
  expect(loadDismissedNativeConversations({ getItem: () => "not json" }).size).toBe(0);
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
