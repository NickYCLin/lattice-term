import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { allNodes, installHostDom, props } from "../components/agents/testFixtures/interactionDom";
import { fakeAgentApi, fakeAutomationsApi, fakeChatApi, fakeThread, installFakeStorage } from "../app/testFixtures/agentApis";
import { I18nProvider } from "../i18n";
import { ChatView } from "./ChatView";
vi.mock("../components/overlays/modalFocus", () => ({ useModalFocus: () => {} }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([
  ["command", true], ["Bash", true], ["mcp__test_server__read_item", true], ["file_change", true], ["permissions", true],
  ["command", false], ["mcp_tool", false],
] as const)("offers native session capability for %s (%s)", async (name, canAllowSession) => {
  const cleanup = installFakeStorage();
  const host = installHostDom();
  const root = createRoot(host as unknown as Element);
  const respond = vi.fn(async () => {});
  const thread = fakeThread({ runningTurnId: "turn-approval", items: [{ id: "turn-approval:approval:request", type: "approval",
    requestId: "request", name, summary: "ls -la", input: "{}", decision: "pending", canAllowSession }] });
  const chat = fakeChatApi({ threads: [thread], activeThreadId: thread.id, respond });
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><ChatView agents={fakeAgentApi()} chat={chat}
      automations={fakeAutomationsApi()} onOpenSession={() => {}} /></I18nProvider>));
    const button = allNodes(host).find(node => node.tagName === "BUTTON" && node.textContent === "本工作階段都允許");
    if (canAllowSession) {
      expect(button).toBeDefined();
      await act(async () => props(button!).onClick());
      expect(respond).toHaveBeenCalledWith(thread.id, "request", true, undefined, "turn-approval", true);
      const card = allNodes(host).find(node => props(node)?.["aria-label"] === "需要你的核准")
        ?? allNodes(host).find(node => String(props(node)?.className).includes("chat-card--approval"));
      expect(card).toBeDefined();
      respond.mockClear();
      await act(async () => props(card!).onKeyDown({ key: "Enter", shiftKey: true, target: card, currentTarget: card, preventDefault() {}, stopPropagation() {} }));
      expect(respond).toHaveBeenCalledWith(thread.id, "request", true, undefined, "turn-approval", true);
      const actions = allNodes(host).filter(node => node.tagName === "BUTTON" && ["允許", "本工作階段都允許", "拒絕"].includes(node.textContent));
      expect(actions.map(node => node.textContent)).toEqual(["允許", "本工作階段都允許", "拒絕"]);
    } else {
      expect(button).toBeUndefined();
      const card = allNodes(host).find(node => String(props(node)?.className).includes("chat-card--approval"))!;
      expect(props(card).title).toContain(name === "mcp_tool" ? "MCP" : "CLI");
      await act(async () => props(card).onKeyDown({ key: "Enter", shiftKey: true, target: card, currentTarget: card, preventDefault() {}, stopPropagation() {} }));
      expect(respond).not.toHaveBeenCalled();
    }
  } finally { await act(async () => root.unmount()); cleanup(); }
});
