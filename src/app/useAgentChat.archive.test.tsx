import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import { NativeHistoryContext, type NativeHistory } from "./useNativeConversations";
import { useAgentChat, type AgentChatApi } from "./useAgentChat";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("./notificationSounds", () => ({ playCompletionSound: async () => "disabled" }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });


it("does not lose the local conversation when native archive fails", async () => {
  const container = installFakeDom();
  vi.stubGlobal("addEventListener", () => {});
  vi.stubGlobal("removeEventListener", () => {});
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  let allowArchive = false;
  let allowRestore = false;
  invoke.mockImplementation(async command => {
    if (command === "agent_chat_delete_native_conversation" && !allowArchive) throw new Error("Synthetic archive unavailable");
    if (command === "agent_chat_restore_codex_conversation" && !allowRestore) throw new Error("Synthetic restore unavailable");
    if (command === "agent_chat_local_history_snapshot") return { messages: [], truncated: false, archived: false };
    if (command === "agent_chat_supported") return ["codex"];
  });
  let chat!: AgentChatApi;
  function Probe() { chat = useAgentChat(); return null; }
  const root = createRoot(container as unknown as Element);
  const history = { entries: [], profileKey: "[]" } as unknown as NativeHistory;
  try {
    await act(async () => root.render(<NativeHistoryContext.Provider value={history}><Probe /></NativeHistoryContext.Provider>));
    let id = "";
    await act(async () => {
      id = chat.importNativeConversation({ definitionId: "codex", nativeSessionId: "synthetic-only",
        workingDirectory: "/fixture", title: "Synthetic archive failure", accountProfileId: null, messages: [] }).id;
    });
    await act(async () => chat.removeThread(id));
    expect(invoke.mock.calls.some(([command]) => command === "agent_chat_delete_native_conversation")).toBe(true);
    expect(chat.getThread(id)).toBeDefined();
    expect(chat.removal?.error).toContain("Synthetic archive unavailable");
    allowArchive = true;
    await act(async () => { void chat.removeThread(id); void chat.removeThread(id); });
    expect(invoke.mock.calls.filter(([command]) => command === "agent_chat_delete_native_conversation")).toHaveLength(2);
    expect(chat.getThread(id)).toBeUndefined();
    expect(values.get("latticeterm.nativeConversationDismissed.v1") ?? "").not.toContain("synthetic-only");
    expect(chat.archivedReceipt).not.toBeNull();
    await act(async () => chat.undoArchive());
    expect(chat.getThread(id)).toBeUndefined();
    expect(chat.archivedReceipt?.error).toContain("Synthetic restore unavailable");
    allowRestore = true;
    await act(async () => { void chat.undoArchive(); void chat.undoArchive(); });
    expect(invoke.mock.calls.filter(([command]) => command === "agent_chat_restore_codex_conversation")).toHaveLength(2);
    expect(chat.getThread(id)).toBeDefined();
    expect(chat.archivedReceipt).toBeNull();
  } finally { await act(async () => root.unmount()); }
});
