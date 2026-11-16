import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { allNodes, installHostDom, props } from "../components/agents/testFixtures/interactionDom";
import { fakeAgentApi, fakeAutomationsApi, fakeChatApi, fakeThread, installFakeStorage } from "../app/testFixtures/agentApis";
import { I18nProvider } from "../i18n";
import { ChatView } from "./ChatView";
vi.mock("../components/overlays/modalFocus", () => ({ useModalFocus: () => {} }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([true, false])("offers session approval only with native capability (%s)", async canAllowSession => {
  const cleanup = installFakeStorage();
  const host = installHostDom();
  const root = createRoot(host as unknown as Element);
  const respond = vi.fn(async () => {});
  const thread = fakeThread({ runningTurnId: "turn-approval", items: [{ id: "turn-approval:approval:request", type: "approval",
    requestId: "request", name: "command", summary: "ls -la", input: "{}", decision: "pending", canAllowSession }] });
  const chat = fakeChatApi({ threads: [thread], activeThreadId: thread.id, respond });
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><ChatView agents={fakeAgentApi()} chat={chat}
      automations={fakeAutomationsApi()} onOpenSession={() => {}} /></I18nProvider>));
    const button = allNodes(host).find(node => node.tagName === "BUTTON" && node.textContent === "本工作階段都允許");
    if (canAllowSession) {
      expect(button).toBeDefined();
      await act(async () => props(button!).onClick());
      expect(respond).toHaveBeenCalledWith(thread.id, "request", true, undefined, "turn-approval", true);
    } else expect(button).toBeUndefined();
  } finally { await act(async () => root.unmount()); cleanup(); }
});
