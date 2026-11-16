import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { allNodes, installHostDom, props } from "../components/agents/testFixtures/interactionDom";
import { fakeAgentApi, fakeAutomationsApi, installFakeStorage } from "../app/testFixtures/agentApis";
import type { ChatEvent, ChatEventEnvelope } from "../app/agentChat";
import { useAgentChat, type AgentChatApi } from "../app/useAgentChat";
import { I18nProvider } from "../i18n";
import { ChatView } from "./ChatView";
const { invoke, bridge } = vi.hoisted(() => ({ invoke: vi.fn(), bridge: { listener: null as null | ((event: { payload: ChatEventEnvelope }) => void) } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async (name: string, callback: typeof bridge.listener) => {
  if (name === "agent-chat://event") bridge.listener = callback;
  return () => {};
} }));
vi.mock("../components/overlays/modalFocus", () => ({ useModalFocus: () => {} }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); bridge.listener = null; });

it("commits each incoming output delta before any timer, later delta or completion and preserves its card", async () => {
  vi.useFakeTimers();
  const cleanup = installFakeStorage();
  const host = installHostDom();
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
  Object.assign(window, { __TAURI_INTERNALS__: { invoke } });
  invoke.mockImplementation(async command => command === "agent_chat_supported" ? ["codex"] : undefined);
  const root = createRoot(host as unknown as Element);
  let chat!: AgentChatApi;
  function Probe() {
    chat = useAgentChat();
    return <I18nProvider locale="zh-TW"><ChatView chat={chat} agents={fakeAgentApi()}
      automations={fakeAutomationsApi()} onOpenSession={() => {}} /></I18nProvider>;
  }
  try {
    await act(async () => root.render(<Probe />));
    let id = "";
    await act(async () => {
      id = chat.createThread({ definitionId: "codex", model: "", permission: "ask", workingDirectory: "/synthetic" }).id;
      await chat.send(id, "print one line per second");
    });
    expect(chat.getThread(id)!.runningTurnId, JSON.stringify(chat.getThread(id))).not.toBeNull();
    const emit = async (event: ChatEvent) => act(async () => {
      bridge.listener!({ payload: { threadId: id, turnId: chat.getThread(id)!.runningTurnId!, event } });
    });
    await emit({ kind: "toolStarted", itemId: "cmd", name: "command", summary: "five lines" });
    const card = allNodes(host).find(node => node.tagName === "SECTION" && String(props(node)?.className).includes("chat-card--tool"))!;
    const scroll = allNodes(host).find(node => props(node)?.className === "chat-messages")!;
    let height = 1000;
    let top = 0;
    Object.defineProperties(scroll, {
      scrollHeight: { configurable: true, get: () => height },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, height - 200)); } },
    });
    const geometry = scroll as unknown as { scrollTop: number; scrollHeight: number };
    const started = Date.now();
    for (let line = 1; line <= 5; line++) {
      height += 20;
      // No advancing timers: one event must render without waiting for a
      // debounce, a subsequent event, toolFinished or a storage flush.
      await emit({ kind: "toolOutputDelta", itemId: "cmd", delta: `${line}\n` });
      const cards = allNodes(host).filter(node => node.tagName === "SECTION" && String(props(node)?.className).includes("chat-card--tool"));
      expect(cards).toEqual([card]);
      expect(String(props(card).className)).toContain("is-running");
      const output = allNodes(card).find(node => node.tagName === "PRE")!;
      expect(output.textContent).toBe(Array.from({ length: line }, (_, i) => `${i + 1}\n`).join(""));
      expect(chat.getThread(id)!.runningTurnId).not.toBeNull();
      expect(Date.now()).toBe(started);
      expect(geometry.scrollTop).toBe(line <= 2 ? height - 200 : 0);
      if (line === 2) {
        props(scroll).onWheel({ deltaY: -1, currentTarget: scroll });
        geometry.scrollTop = 0;
      }
    }
    await emit({ kind: "toolFinished", itemId: "cmd", name: "command", summary: null,
      output: "1\n2\n3\n4\n5\n", isError: false });
    expect(allNodes(card).find(node => node.tagName === "PRE")!.textContent).toBe("1\n2\n3");
    const expandOutput = allNodes(card).find(node => node.tagName === "BUTTON" && node.textContent === "展開完整輸出")!;
    await act(async () => props(expandOutput).onClick());
    expect(allNodes(card).find(node => node.tagName === "PRE")!.textContent).toBe("1\n2\n3\n4\n5\n");
    expect(host.textContent).not.toContain("1\n2\n3\n4\n5\n1\n");
  } finally { await act(async () => root.unmount()); cleanup(); }
});
