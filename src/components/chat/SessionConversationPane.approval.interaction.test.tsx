import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { allNodes, installHostDom, props } from "../agents/testFixtures/interactionDom";
import { fakeAgentApi, fakeSession, installFakeStorage } from "../../app/testFixtures/agentApis";
import { I18nProvider } from "../../i18n";
const { conversation } = vi.hoisted(() => ({ conversation: {
  messages: [], readError: null, loading: false, slow: false, output: "", sendError: null,
  sending: false, queued: null, send: vi.fn(), acknowledge: vi.fn(),
  approval: { requestId: "r1", toolName: "Bash", summary: "mkdir build", canAllowSession: false },
  answering: false, answerError: null, answer: vi.fn(),
} }));
vi.mock("../../app/useSessionConversation", () => ({ useSessionConversation: () => conversation }));
import { SessionConversationPane } from "./SessionConversationPane";
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });
it.each([true, false])("keeps terminal approval buttons and shortcuts consistent (%s)", async canAllowSession => {
  const cleanup = installFakeStorage();
  const host = installHostDom();
  const root = createRoot(host as unknown as Element);
  conversation.approval.canAllowSession = canAllowSession;
  const openTerminal = vi.fn();
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><SessionConversationPane session={fakeSession({ state: "needsAttention" })}
      agents={fakeAgentApi()} onOpenTerminal={openTerminal} onSessionReplaced={() => {}} /></I18nProvider>));
    const terminals = allNodes(host).filter(node => props(node)?.["aria-label"] === "終端機");
    expect(terminals).toHaveLength(1);
    await act(async () => props(terminals[0]).onClick());
    expect(openTerminal).toHaveBeenCalledOnce();
    const card = allNodes(host).find(node => String(props(node)?.className).includes("chat-card--approval"))!;
    const buttons = allNodes(host).filter(node => node.tagName === "BUTTON" && ["允許", "本工作階段都允許", "拒絕"].includes(node.textContent));
    expect(buttons.map(node => node.textContent)).toEqual(canAllowSession ? ["允許", "本工作階段都允許", "拒絕"] : ["允許", "拒絕"]);
    if (canAllowSession) {
      await act(async () => props(buttons[1]).onClick());
      expect(conversation.answer).toHaveBeenCalledWith(true, true);
      conversation.answer.mockClear();
    } else expect(props(card).title).toContain("未提供可驗證的工作階段決策");
    const key = async (key: string, shiftKey = false) => act(async () => props(card).onKeyDown({ key, shiftKey, target: card, currentTarget: card, preventDefault() {}, stopPropagation() {} }));
    await key("Enter", true);
    expect(conversation.answer.mock.calls).toEqual(canAllowSession ? [[true, true]] : []);
    conversation.answer.mockClear();
    await key("Enter"); await key("Escape");
    expect(conversation.answer.mock.calls).toEqual([[true, false], [false, false]]);
  } finally { await act(async () => root.unmount()); cleanup(); }
});
