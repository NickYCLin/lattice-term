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

it("polls locally created native conversations and appends external replies without launching a CLI", async () => {
  vi.useFakeTimers();
  const container = installFakeDom();
  vi.stubGlobal("addEventListener", () => {});
  vi.stubGlobal("removeEventListener", () => {});
  const thread: ChatThread = { ...createThread({ definitionId: "codex", model: "", permission: "ask", workingDirectory: "/work" }),
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
    : command === "agent_chat_supported" ? ["codex"] : undefined);
  const history = { entries: [{ definitionId: "codex", profileId: null, nativeSessionId: "native",
    title: thread.title, workingDirectory: "/work", updatedAt: 1, resumable: true }], profileKey: "[]" } as unknown as NativeHistory;
  let chat!: AgentChatApi;
  function Probe() { chat = useAgentChat(); return null; }
  const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<NativeHistoryContext.Provider value={history}><Probe /></NativeHistoryContext.Provider>));
    expect(chat.getThread(thread.id)?.items.slice(0, 3)).toEqual(thread.items);
    expect(chat.getThread(thread.id)?.items.slice(3)).toMatchObject([{ type: "user", text: "native question" }, { type: "text", text: "native reply" }]);
    expect(invoke).toHaveBeenCalledWith("agent_chat_local_history_snapshot", {
      definitionId: "codex", nativeSessionId: "native", profileId: null, profiles: [],
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
