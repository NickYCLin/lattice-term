import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import { useAgentChat, type AgentChatApi } from "./useAgentChat";
import type { ChatEventEnvelope } from "./agentChat";

const { invoke, events } = vi.hoisted(() => ({
  invoke: vi.fn(),
  events: { listener: null as ((event: { payload: ChatEventEnvelope }) => void) | null },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async (name: string, listener: (event: { payload: ChatEventEnvelope }) => void) => {
  if (name === "agent-chat://event") events.listener = listener;
  return () => {};
} }));
vi.mock("./notificationSounds", () => ({ playCompletionSound: async () => "disabled" }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); events.listener = null; });

it("does not send a stale turn when handoff compaction completes after the turn ended", async () => {
  const container = installFakeDom();
  vi.stubGlobal("addEventListener", () => {});
  vi.stubGlobal("removeEventListener", () => {});
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  let resolveSummary!: (value: unknown) => void;
  const summary = new Promise(resolve => { resolveSummary = resolve; });
  invoke.mockImplementation(async command => {
    if (command === "agent_chat_supported") return ["codex"];
    if (command === "agent_chat_models") return [];
    if (command === "memory_structure_context") return summary;
  });
  let chat!: AgentChatApi;
  function Probe() { chat = useAgentChat(); return null; }
  const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<Probe />));
    let id = "";
    await act(async () => {
      id = chat.createThread({ definitionId: "codex", model: "", permission: "ask", workingDirectory: "",
        handoff: { sourceDefinitionId: "claude", transcript: "Synthetic previous goal" } }).id;
    });
    let sending!: Promise<void>;
    await act(async () => { sending = chat.send(id, "Continue synthetic task"); });
    await vi.waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "memory_structure_context")).toBe(true));
    const turnId = chat.getThread(id)!.runningTurnId!;
    await act(async () => events.listener!({ payload: { threadId: id, turnId,
      event: { kind: "finished", nativeSessionId: null, usage: null, costUsd: null, durationMs: 1, error: null } } }));
    await act(async () => { resolveSummary({ text: "# 結構化交接摘要", compacted: false }); await sending; });
    expect(chat.getThread(id)?.runningTurnId).toBeNull();
    expect(invoke.mock.calls.some(([command]) => command === "agent_chat_send" || command === "agent_chat_proxy_send")).toBe(false);
  } finally { await act(async () => root.unmount()); }
});
