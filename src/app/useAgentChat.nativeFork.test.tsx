import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createThread, type ChatItem } from "./agentChat";
import { useAgentChat, type AgentChatApi } from "./useAgentChat";
import { installFakeDom } from "./testFixtures/hookDom";
import { desktopChatAccess } from "./desktopChat";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("./notificationSounds", () => ({ playCompletionSound: async () => "disabled" }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); desktopChatAccess.reset(null); });
async function setup(accountProfileId: string | null = null, definitionId: "codex" | "claude" = "codex", items?: ChatItem[]) {
  const container = installFakeDom();
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
  const original = { ...createThread({ definitionId, model: "", permission: "ask", workingDirectory: "/synthetic", accountProfileId }, "source", 1),
    nativeSessionId: "native-source", items: items ?? [{ type: "user" as const, id: "prompt", text: "original", at: 1 }, { type: "text" as const, id: "reply", text: "source reply" }] };
  const values = new Map([["latticeterm.agentChat.v1", JSON.stringify([original])]]);
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  invoke.mockImplementation(async command => command === "agent_chat_supported" ? [definitionId] : undefined);
  let chat!: AgentChatApi;
  function Probe() { chat = useAgentChat(); return null; }
  const root = createRoot(container as unknown as Element);
  await act(async () => { root.render(<Probe />); });
  return { root, original, get chat() { return chat; } };
}
it("keeps the source unchanged and continues the confirmed native fork without a text-summary handoff", async () => {
  const runtime = await setup();
  let resolve!: (value: unknown) => void;
  const pending = new Promise<unknown>(done => { resolve = done; });
  const usual = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, args) => command === "agent_chat_fork" ? pending : usual(command, args));
  let operation!: ReturnType<AgentChatApi["nativeFork"]>;
  try {
    await act(async () => { operation = runtime.chat.nativeFork("source", "分支"); });
    expect(runtime.chat.getThread("source")?.pendingOperation).toBe("fork");
    await expect(runtime.chat.send("source", "must not send")).rejects.toThrow("operation");
    await expect(runtime.chat.removeThread("source")).rejects.toThrow("operation");
    await act(async () => { resolve({ nativeSessionId: "native-fork", model: "reported-model", provider: "source-adapter" }); await operation; });
    const fork = runtime.chat.threads.find(thread => thread.id !== "source")!;
    expect(fork).toMatchObject({ nativeSessionId: "native-fork", handoff: null, reportedProvider: "source-adapter" });
    expect(runtime.chat.getThread("source")).toMatchObject({ nativeSessionId: "native-source", items: runtime.original.items });
    expect(runtime.chat.getThread("source")?.pendingOperation).toBeUndefined();
    await act(async () => { await runtime.chat.send(fork.id, "continue"); });
    const sent = invoke.mock.calls.filter(([command]) => command === "agent_chat_send").slice(-1)[0][1];
    expect(sent.request.nativeSessionId).toBe("native-fork");
    expect(sent.request.prompt).toBe("continue");
    expect(desktopChatAccess.defaultShares.has(fork.id)).toBe(true);
  } finally { await act(async () => { runtime.root.unmount(); }); }
});
it("does not fall back to the default account when a source profile is missing", async () => {
  const runtime = await setup("removed-profile");
  try {
    await expect(runtime.chat.nativeFork("source", "分支")).rejects.toThrow("profile is missing");
    expect(invoke.mock.calls.some(([command]) => command === "agent_chat_fork")).toBe(false);
    expect(runtime.chat.threads).toHaveLength(1);
  } finally { await act(async () => { runtime.root.unmount(); }); }
});

const history: ChatItem[] = [
  { type: "user", id: "first", text: "first prompt", at: 1, nativeTurnId: "native-first" },
  { type: "text", id: "first-reply", text: "first answer", nativeTurnId: "native-first", nativeMessageId: "claude-first" },
  { type: "user", id: "second", text: "second prompt", at: 2, nativeTurnId: "native-second" },
  { type: "text", id: "second-reply", text: "second answer", nativeTurnId: "native-second", nativeMessageId: "claude-second" },
];
it("forks before an edited native turn while retaining the preceding history and source", async () => {
  const runtime = await setup(null, "codex", history);
  const usual = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, args) => command === "agent_chat_fork" ? Promise.resolve({ nativeSessionId: "edited-native", model: null, provider: "source" }) : usual(command, args));
  try {
    let fork!: Awaited<ReturnType<AgentChatApi["nativeFork"]>>;
    await act(async () => { fork = await runtime.chat.nativeFork("source", "修改", "second", true); });
    expect(invoke.mock.calls.find(([command]) => command === "agent_chat_fork")?.[1]).toMatchObject({ throughTurnId: "native-second", beforeTurn: true });
    expect(fork?.items).toMatchObject(history.slice(0, 2));
    expect(fork?.handoff).toBeNull();
    expect(runtime.chat.getThread("source")?.items).toEqual(history);
  } finally { await act(async () => runtime.root.unmount()); }
});
it("uses Claude's native fork and resume-message flags instead of a synthetic summary", async () => {
  const runtime = await setup(null, "claude", history);
  try {
    let fork!: Awaited<ReturnType<AgentChatApi["nativeFork"]>>;
    await act(async () => { fork = await runtime.chat.nativeFork("source", "修改", "second", true); });
    expect(fork?.items).toMatchObject(history.slice(0, 2));
    expect(fork?.nativeForkSource).toEqual({ sessionId: "native-source", resumeAt: "claude-first" });
    expect(fork?.handoff).toBeNull();
    await act(async () => { await runtime.chat.send(fork!.id, "edited second prompt"); });
    const request = invoke.mock.calls.find(([command]) => command === "agent_chat_send")?.[1].request;
    expect(request).toMatchObject({ nativeSessionId: "native-source", forkSession: true, resumeSessionAt: "claude-first", prompt: "edited second prompt" });
    expect(runtime.chat.getThread("source")?.items).toEqual(history);
  } finally { await act(async () => runtime.root.unmount()); }
});

it.each(["codex", "claude"] as const)("validates a %s PTY source, refreshes its passive mirror and keeps its policy and original writer", async definitionId => {
  const runtime = await setup(null, definitionId, history.slice(0, 2));
  const usual = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, args) => command === "agent_session_validate_fork_source" ? Promise.resolve("readOnly") : command === "agent_chat_fork" ? Promise.resolve({ nativeSessionId: "session-branch", model: null, provider: "source" }) : usual(command, args));
  try {
    await act(async () => { runtime.chat.importNativeConversation({ definitionId, nativeSessionId: "native-source", workingDirectory: "/synthetic", title: "source", accountProfileId: null,
      sessionSource: true, model: "source-model", messages: history.map(row => ({ role: row.type === "user" ? "user" : "assistant", text: "text" in row ? row.text : "", nativeTurnId: "nativeTurnId" in row ? row.nativeTurnId : undefined, nativeMessageId: "nativeMessageId" in row ? row.nativeMessageId : undefined })) }); });
    expect(runtime.chat.getThread("source")?.continuedInSession).toBe(true);
    expect(runtime.chat.getThread("source")?.items).toHaveLength(4);
    await expect(runtime.chat.nativeFork("source", "分支")).rejects.toThrow("idle");
    const boundary = runtime.chat.getThread("source")!.items[3].id;
    await act(async () => { await runtime.chat.nativeFork("source", "分支", boundary, false, "foreground-source"); });
    expect(invoke.mock.calls.find(([command]) => command === "agent_session_validate_fork_source")?.[1]).toMatchObject({ sessionId: "foreground-source", nativeId: "native-source", definitionId, workingDirectory: "/synthetic", profileConfigPath: null });
    if (definitionId === "codex") expect(invoke.mock.calls.find(([command]) => command === "agent_chat_fork")?.[1]).toMatchObject({ throughTurnId: "native-second" });
    else expect(runtime.chat.threads.find(thread => thread.id !== "source")?.nativeForkSource).toEqual({ sessionId: "native-source", resumeAt: "claude-second" });
    expect(runtime.chat.getThread("source")?.continuedInSession).toBe(true);
    expect(runtime.chat.threads.find(thread => thread.id !== "source")?.permission).toBe("readOnly");
    expect(invoke.mock.calls.some(([command]) => ["agent_close", "agent_launch", "agent_chat_send"].includes(command))).toBe(false);
  } finally { await act(async () => runtime.root.unmount()); }
});

it("does not fork or replay when the foreground source validation fails", async () => {
  const runtime = await setup(null, "codex", history);
  const usual = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, args) => command === "agent_session_validate_fork_source" ? Promise.reject(new Error("source busy")) : usual(command, args));
  try {
    await expect(runtime.chat.nativeFork("source", "分支", "second-reply", false, "foreground-source")).rejects.toThrow("source busy");
    expect(invoke.mock.calls.some(([command]) => ["agent_chat_fork", "agent_chat_send", "agent_launch"].includes(command))).toBe(false);
    expect(runtime.chat.threads).toHaveLength(1);
  } finally { await act(async () => runtime.root.unmount()); }
});

it("does not substitute full access when a PTY permission receipt is missing", async () => {
  const runtime = await setup(null, "codex", history);
  try {
    await expect(runtime.chat.nativeFork("source", "分支", "second-reply", false, "foreground-source")).rejects.toThrow("來源權限尚未確認");
    expect(invoke.mock.calls.some(([command]) => command === "agent_chat_fork")).toBe(false);
  } finally { await act(async () => runtime.root.unmount()); }
});
