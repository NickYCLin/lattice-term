import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import { CLI_PROXY_SETTINGS_KEY } from "./cliProxyApi";
import type { AgentChatApi } from "./useAgentChat";

const invoke = vi.fn(async (command: string, _args?: unknown) => command === "agent_chat_supported" ? ["codex"] : undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: [string, unknown?]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("./notificationSounds", () => ({ playNotificationSound: async () => "disabled" }));
afterEach(() => vi.unstubAllGlobals());

it("sends the saved address only for proxy turns and preserves the choice across settings edits", async () => {
  const root = installFakeDom();
  const values = new Map([[CLI_PROXY_SETTINGS_KEY, JSON.stringify({ baseUrl: "http://localhost:8317" })]]);
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
      id = chat.createThread({ definitionId: "codex", provider: "cliproxyapi", model: "proxy-model", permission: "ask", workingDirectory: "" }).id;
    });
    await act(async () => chat.updateThread(id, { permission: "readOnly" }));
    expect(chat.getThread(id)?.provider).toBe("cliproxyapi");
    await act(async () => chat.send(id, "hello proxy"));
    expect(invoke).toHaveBeenCalledWith("agent_chat_send", { request: expect.objectContaining({
      cliProxyBaseUrl: "http://localhost:8317", model: "proxy-model", nativeSessionId: null,
    }) });
    let nativeId = "";
    await act(async () => {
      nativeId = chat.createThread({ definitionId: "codex", model: "", permission: "ask", workingDirectory: "" }).id;
      await chat.send(nativeId, "hello native");
    });
    expect(invoke).toHaveBeenLastCalledWith("agent_chat_send", { request: expect.objectContaining({ cliProxyBaseUrl: null }) });
    const sends = invoke.mock.calls.filter(([name]) => name === "agent_chat_send");
    expect(JSON.stringify(sends)).not.toContain("apiKey");
    await act(async () => { chat.removeThread(id); chat.removeThread(nativeId); });
  } finally {
    await act(async () => mounted.unmount());
  }
});
