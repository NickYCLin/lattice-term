import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { allNodes, installHostDom, props } from "../components/agents/testFixtures/interactionDom";
import { fakeAgentApi, fakeAutomationsApi, fakeChatApi, fakeDefinition, fakeSession, fakeThread, installFakeStorage } from "../app/testFixtures/agentApis";
import { NativeHistoryContext, type NativeHistory } from "../app/useNativeConversations";
import { CONVERSATION_NAMES_KEY } from "../app/conversationNames";
import { I18nProvider } from "../i18n";
import { ChatView } from "./ChatView";

vi.mock("../components/overlays/modalFocus", () => ({ useModalFocus: () => {} }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("renames each kind of sidebar entry and keeps names after remounting", async () => {
  const cleanup = installFakeStorage();
  let host = installHostDom();
  let root = createRoot(host as unknown as Element);
  const thread = fakeThread({ title: "Original thread" });
  const session = fakeSession({ groupLabel: "Original session", capturedSessionId: "live-native" });
  const agents = fakeAgentApi({ catalog: [fakeDefinition()], sessions: [session] });
  const chat = fakeChatApi({ threads: [thread], activeThreadId: null });
  const history = { entries: [{ definitionId: "codex", profileId: null, nativeSessionId: "saved-native", title: "Original history",
    workingDirectory: "/synthetic", resumable: true, updatedAt: 1 }], profiles: [], profileKey: "[]" } as unknown as NativeHistory;
  const render = () => root.render(<I18nProvider locale="zh-TW"><NativeHistoryContext.Provider value={history}>
    <ChatView agents={agents} chat={chat} automations={fakeAutomationsApi()} onOpenSession={() => {}} />
  </NativeHistoryContext.Provider></I18nProvider>);
  try {
    await act(async () => render());
    for (const [original, name] of [["Original thread", "我的對話"], ["Original session · Codex", "執行中的任務"], ["Original history", "保存的紀錄"]]) {
      const button = allNodes(host).find(node => props(node)?.["aria-label"] === `重新命名：${original}`)!;
      expect(button, JSON.stringify({ original, labels: allNodes(host).map(node => props(node)?.["aria-label"]).filter(Boolean) })).toBeDefined();
      await act(async () => props(button).onClick({ stopPropagation() {} }));
      const input = allNodes(host).find(node => props(node)?.id === "text-prompt-value")!;
      await act(async () => props(input).onChange({ currentTarget: { value: name } }));
      await act(async () => props(allNodes(host).find(node => node.tagName === "FORM" && props(node)?.role === "dialog")!).onSubmit({ preventDefault() {} }));
      expect(host.textContent).toContain(name);
    }
    expect(thread.title).toBe("Original thread");
    expect(agents.launch).not.toHaveBeenCalled();
    expect(agents.rename).not.toHaveBeenCalled();
    expect(localStorage.getItem(CONVERSATION_NAMES_KEY)).toContain("保存的紀錄");
    await act(async () => root.unmount());
    host = installHostDom(); root = createRoot(host as unknown as Element);
    await act(async () => render());
    for (const name of ["我的對話", "執行中的任務", "保存的紀錄"]) expect(host.textContent).toContain(name);
  } finally { await act(async () => root.unmount()); cleanup(); }
});
