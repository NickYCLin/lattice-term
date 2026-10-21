import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createThread, type ChatThread, type NativeHistoryMessage } from "./agentChat";
import { installFakeDom } from "./testFixtures/hookDom";
import { NativeHistoryContext, type NativeHistory, NATIVE_MESSAGE_REFRESH_MS } from "./useNativeConversations";
import { useAgentChat, type AgentChatApi } from "./useAgentChat";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("./notificationSounds", () => ({ playCompletionSound: async () => "disabled" }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("opens an empty history mirror immediately, blocks sending until read and retries in place", async () => {
  vi.useFakeTimers();
  const container = installFakeDom();
  vi.stubGlobal("addEventListener", () => {});
  vi.stubGlobal("removeEventListener", () => {});
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } });
  let finish!: (value: unknown) => void;
  let fail!: (reason: Error) => void;
  invoke.mockImplementation(command => command === "agent_chat_local_history_snapshot"
    ? new Promise((resolve, reject) => { finish = resolve; fail = reject; })
    : Promise.resolve(command === "agent_chat_supported" ? ["codex"] : undefined));
  const history = { entries: [], profileKey: "[]" } as unknown as NativeHistory;
  let chat!: AgentChatApi;
  function Probe() { chat = useAgentChat(); return null; }
  const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<NativeHistoryContext.Provider value={history}><Probe /></NativeHistoryContext.Provider>));
    let thread!: ChatThread;
    await act(async () => { thread = chat.importNativeConversation({ definitionId: "codex", nativeSessionId: "native",
      workingDirectory: "/work", title: "Slow conversation", accountProfileId: null, messages: [] }); });
    expect(chat.activeThreadId).toBe(thread.id);
    expect(chat.nativeRead).toMatchObject({ threadId: thread.id, ready: false, loading: true });
    await expect(chat.send(thread.id, "not yet")).rejects.toThrow("Read the conversation history");
    expect(invoke.mock.calls.some(([command]) => command === "agent_chat_send")).toBe(false);
    await act(async () => { fail(new Error("disk busy")); });
    expect(chat.nativeRead).toMatchObject({ ready: false, loading: false, error: "disk busy" });
    await act(async () => chat.nativeRead!.refresh());
    await act(async () => { finish({ messages: [{ role: "user", text: "old question" }, { role: "assistant", text: "old reply" }], truncated: false }); });
    expect(chat.nativeRead).toMatchObject({ ready: true, loading: false, error: null });
    expect(chat.getThread(thread.id)?.items).toHaveLength(2);
    await act(async () => { chat.importNativeConversation({ definitionId: "codex", nativeSessionId: "native",
      workingDirectory: "/work", title: "Slow conversation", accountProfileId: null, messages: [] }); });
    expect(chat.getThread(thread.id)?.items).toHaveLength(2);
    const changedHistory = { ...history, profileKey: JSON.stringify([{ profileId: "other", definitionId: "codex", configDirectory: "/another" }]) };
    await act(async () => root.render(<NativeHistoryContext.Provider value={changedHistory}><Probe /></NativeHistoryContext.Provider>));
    expect(chat.nativeRead).toMatchObject({ ready: false, loading: true });
    await expect(chat.send(thread.id, "wait for the new config")).rejects.toThrow("Read the conversation history");
    expect(chat.getThread(thread.id)?.items).toHaveLength(2);
  } finally { await act(async () => root.unmount()); }
});

it.each(["claude", "codex", "gemini", "antigravity"] as const)("polls %s native conversations and appends external replies without launching a CLI", async definitionId => {
  vi.useFakeTimers();
  const container = installFakeDom();
  vi.stubGlobal("addEventListener", () => {});
  vi.stubGlobal("removeEventListener", () => {});
  const thread: ChatThread = { ...createThread({ definitionId, model: "", permission: "ask", workingDirectory: "/work" }),
    nativeSessionId: "native", items: [
      { type: "user", id: "local:user", text: "local question", at: 1 },
      { type: "tool", id: "local:tool", name: "read", summary: "local tool", output: "keep this", isError: false, done: true },
      { type: "text", id: "local:answer", text: "local reply" },
    ] };
  const values = new Map([["latticeterm.agentChat.v1", JSON.stringify([thread])]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
  let messages: NativeHistoryMessage[] = [
    { role: "user", text: "local question" }, { role: "assistant", text: "local reply" },
    { role: "user", text: "native question" }, { role: "assistant", text: "native reply" },
  ];
  invoke.mockImplementation(async command => command === "agent_chat_local_history_snapshot"
    ? { messages, truncated: false, archived: false }
    : command === "agent_chat_supported" ? [definitionId] : undefined);
  const history = { entries: [{ definitionId, profileId: null, nativeSessionId: "native",
    title: thread.title, workingDirectory: "/work", updatedAt: 1, resumable: true }], profileKey: "[]" } as unknown as NativeHistory;
  let chat!: AgentChatApi;
  function Probe() { chat = useAgentChat(); return null; }
  const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<NativeHistoryContext.Provider value={history}><Probe /></NativeHistoryContext.Provider>));
    expect(chat.getThread(thread.id)?.items.slice(0, 3)).toEqual(thread.items);
    expect(chat.getThread(thread.id)?.items.slice(3)).toMatchObject([{ type: "user", text: "native question" }, { type: "text", text: "native reply" }]);
    expect(invoke).toHaveBeenCalledWith("agent_chat_local_history_snapshot", {
      definitionId, nativeSessionId: "native", profileId: null, profiles: [],
    });
    messages = [...messages, { role: "user", text: "another native question" }, { role: "assistant", text: "another native reply" }];
    await act(async () => { await vi.advanceTimersByTimeAsync(NATIVE_MESSAGE_REFRESH_MS); });
    const next = chat.getThread(thread.id)!;
    expect(next.items).toHaveLength(7);
    await act(async () => { await vi.advanceTimersByTimeAsync(NATIVE_MESSAGE_REFRESH_MS); });
    expect(chat.getThread(thread.id)).toBe(next);
    expect(invoke.mock.calls.some(([command]) => command === "agent_chat_send" || command === "agent_launch")).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});
