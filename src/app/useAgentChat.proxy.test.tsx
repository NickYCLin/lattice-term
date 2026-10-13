import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import { CLI_PROXY_SETTINGS_KEY } from "./cliProxyApi";
import type { AgentChatApi } from "./useAgentChat";
import type { ChatEventEnvelope } from "./agentChat";

const events = vi.hoisted(() => ({ listener: null as ((event: { payload: ChatEventEnvelope }) => void) | null }));

const invoke = vi.fn(async (command: string, _args?: unknown) => command === "agent_chat_supported" ? ["codex"] : undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: [string, unknown?]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async (name: string, listener: (event: { payload: ChatEventEnvelope }) => void) => {
  if (name === "agent-chat://event") events.listener = listener;
  return () => {};
} }));
vi.mock("./notificationSounds", () => ({ playCompletionSound: async () => "disabled" }));
afterEach(() => vi.unstubAllGlobals());

it("sends the saved address only for proxy turns and preserves the choice across settings edits", async () => {
  const root = installFakeDom();
  const values = new Map([[CLI_PROXY_SETTINGS_KEY, JSON.stringify({ proxies: [
    { id: "default", label: "", baseUrl: "http://localhost:8317" },
    { id: "7f3a91", label: "備援", baseUrl: "http://localhost:8319" },
  ] })]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  const { createRoot } = await import("react-dom/client");
  const { useAgentChat } = await import("./useAgentChat");
  let chat!: AgentChatApi;
  function Runtime() { chat = useAgentChat(); return null; }
  const mounted = createRoot(root as unknown as Element);
  try {
    await act(async () => mounted.render(<Runtime />));
    let id = "";
    await act(async () => {
      id = chat.createThread({ definitionId: "codex", provider: "cliproxyapi", proxyId: "default", model: "proxy-model", permission: "ask", workingDirectory: "" }).id;
    });
    await act(async () => chat.updateThread(id, { permission: "readOnly" }));
    expect(chat.getThread(id)?.provider).toBe("cliproxyapi");
    await act(async () => chat.send(id, "hello proxy"));
    expect(invoke).toHaveBeenCalledWith("agent_chat_proxy_send", { history: [], request: expect.objectContaining({
      cliProxyBaseUrl: "http://localhost:8317", cliProxyId: "default", model: "proxy-model", nativeSessionId: null,
    }) });
    // A second proxy is a different account, so its own address has to go out.
    let spareId = "";
    await act(async () => {
      spareId = chat.createThread({ definitionId: "codex", provider: "cliproxyapi", proxyId: "7f3a91", model: "proxy-model", permission: "ask", workingDirectory: "" }).id;
      await chat.send(spareId, "hello spare");
    });
    expect(invoke).toHaveBeenLastCalledWith("agent_chat_proxy_send", { history: [], request: expect.objectContaining({
      cliProxyBaseUrl: "http://localhost:8319", cliProxyId: "7f3a91",
    }) });
    let nativeId = "";
    await act(async () => {
      nativeId = chat.createThread({ definitionId: "codex", model: "", permission: "ask", workingDirectory: "" }).id;
      await chat.send(nativeId, "hello native");
    });
    expect(invoke).toHaveBeenLastCalledWith("agent_chat_send", { request: expect.objectContaining({ cliProxyBaseUrl: null, cliProxyId: null }) });
    const sends = invoke.mock.calls.filter(([name]) => name === "agent_chat_send" || name === "agent_chat_proxy_send");
    expect(JSON.stringify(sends)).not.toContain("apiKey");
    const attachments = [{ path: "C:/fixture/photo.png", name: "photo.png", isImage: true }, { path: "C:/fixture/notes.txt", name: "notes.txt", isImage: false }];
    let childId = "";
    await act(async () => {
      childId = chat.delegate(id, "codex", "比較這兩份附件", false, attachments)!.id;
    });
    expect(chat.getThread(childId)).toMatchObject({ provider: "cliproxyapi", proxyId: "default", model: "proxy-model", delegatedFrom: id });
    expect(invoke).toHaveBeenCalledWith("agent_chat_proxy_send", { history: [], request: expect.objectContaining({ threadId: childId, attachments: attachments.map(({ path }) => ({ path })) }) });
    expect(chat.getThread(id)?.items.filter(item => item.type === "user").length).toBe(1);
    const turnId = chat.getThread(id)!.runningTurnId!;
    await act(async () => {
      events.listener!({ payload: { threadId: id, turnId, event: { kind: "text", itemId: "reply", text: "first reply" } } });
      events.listener!({ payload: { threadId: id, turnId, event: { kind: "finished", nativeSessionId: null, usage: null, costUsd: null, durationMs: 10, error: null } } });
    });
    await act(async () => chat.send(id, "follow-up", attachments));
    expect(invoke).toHaveBeenCalledWith("agent_chat_proxy_send", { history: [
      { role: "user", text: "hello proxy", attachments: [] },
      { role: "assistant", text: "first reply", attachments: [] },
    ], request: expect.objectContaining({ prompt: "follow-up", attachments: attachments.map(({ path }) => ({ path })) }) });
    await act(async () => { chat.removeThread(childId); });
    await act(async () => { chat.removeThread(id); chat.removeThread(spareId); chat.removeThread(nativeId); });
  } finally {
    await act(async () => mounted.unmount());
  }
});
