import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { ChatTools } from "../components/chat/ChatTools";
import { allNodes, installHostDom, props } from "../components/agents/testFixtures/interactionDom";
import { fakeAgentApi, fakeAutomationsApi, fakeChatApi, fakeThread, installFakeStorage } from "../app/testFixtures/agentApis";
import { I18nProvider } from "../i18n";
import { ChatView } from "./ChatView";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null), convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("keeps browser controls usable during polling and ignores stale preview frames", async () => {
  const restore = installFakeStorage();
  const host = installHostDom();
  const root = createRoot(host as unknown as Element);
  vi.useFakeTimers();
  let finishPreview: (frame: unknown) => void = () => {};
  let previewCount = 0;
  const tabs = [{ id: "A", url: "https://example.com", title: "First page" }, { id: "B", url: "https://example.org", title: "Second page" }];
  vi.mocked(invoke).mockImplementation(async (name, args) => {
    if (name !== "chat_browser_action") return {};
    if (args && "args" in args && (args.args as { inputOnly?: boolean } | undefined)?.inputOnly) return null;
    if (args && "action" in args && args.action === "preview" && ++previewCount === 2) {
      return new Promise(resolve => { finishPreview = resolve; });
    }
    const tab = args && "action" in args && args.action === "activate_tab" ? tabs[0] : tabs[1];
    return { ...tab, tabId: tab.id, tabs, image: "frame", width: 1280, height: 800 };
  });
  const render = (busy: boolean) => root.render(<I18nProvider locale="zh-TW"><ChatTools threadId="t1" directory="" busy={busy} assistantTools browserEnabled onClose={() => {}} /></I18nProvider>);
  const tabButton = (title: string) => allNodes(host).find(node => node.tagName === "BUTTON" && node.textContent === title)!;
  try {
    await act(async () => render(true));
    expect(invoke).toHaveBeenCalledWith("chat_browser_action", expect.objectContaining({ action: "preview" }));
    expect(props(tabButton("Second page"))["aria-pressed"]).toBe(true);
    expect(props(tabButton("First page")).disabled).toBe(true);
    await act(async () => render(false));
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(previewCount).toBe(2);
    expect(props(tabButton("First page")).disabled).toBe(false);
    await act(async () => props(tabButton("First page")).onClick());
    expect(invoke).toHaveBeenCalledWith("chat_browser_action", { threadId: "t1", action: "activate_tab", args: { tabId: "A" } });
    expect(props(tabButton("First page"))["aria-pressed"]).toBe(true);
    await act(async () => finishPreview({ ...tabs[1], tabId: "B", tabs, image: "stale", width: 1280, height: 800 }));
    expect(props(tabButton("First page"))["aria-pressed"]).toBe(true);
    await act(async () => props(tabButton("放大預覽")).onClick());
    expect(props(tabButton("放大預覽"))["aria-pressed"]).toBe(true);
    const screen = allNodes(host).find(node => node.tagName === "IMG")!;
    const pressed = (key: string) => props(screen).onKeyDown({ key, nativeEvent: {}, preventDefault: vi.fn() });
    await act(async () => {
      pressed("A");
      pressed("b");
      pressed("Delete");
      props(screen).onPaste({ clipboardData: { getData: () => "測試" }, preventDefault: vi.fn() });
    });
    const inputs = vi.mocked(invoke).mock.calls.flatMap(([, args]) => {
      if (!args || !("args" in args) || !(args.args as { inputOnly?: boolean } | undefined)?.inputOnly) return [];
      return [["action" in args ? args.action : undefined, args.args]];
    });
    expect(inputs).toEqual([
      ["type", { tabId: "A", inputOnly: true, text: "A" }],
      ["type", { tabId: "A", inputOnly: true, text: "b" }],
      ["key", { tabId: "A", inputOnly: true, key: "Delete" }],
      ["type", { tabId: "A", inputOnly: true, text: "測試" }],
    ]);
    await act(async () => render(true));
    await act(async () => pressed("x"));
    expect(invoke).not.toHaveBeenCalledWith("chat_browser_action", expect.objectContaining({ args: expect.objectContaining({ text: "x" }) }));
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
    restore();
    vi.mocked(invoke).mockReset().mockResolvedValue(null);
  }
});

it("keeps one settings toggle and browser grant, sidebar archive, and the model slash shortcut", async () => {
  const restore = installFakeStorage();
  const host = installHostDom();
  const root = createRoot(host as unknown as Element);
  const thread = fakeThread();
  const chat = fakeChatApi({ threads: [thread], activeThreadId: thread.id });
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><ChatView agents={fakeAgentApi()} chat={chat}
      automations={fakeAutomationsApi()} onOpenSession={() => {}} /></I18nProvider>));
    const settings = () => allNodes(host).filter(node => props(node)?.["aria-controls"] === "chat-settings-t1");
    expect(settings()).toHaveLength(1);
    await act(async () => props(settings()[0]).onClick());
    expect(allNodes(host).some(node => props(node)?.className === "chat-settings")).toBe(false);
    await act(async () => props(settings()[0]).onClick());
    const tools = allNodes(host).find(node => node.tagName === "BUTTON" && node.textContent === "對話工具")!;
    await act(async () => props(tools).onClick());
    const toolsPanel = allNodes(host).find(node => props(node)?.className === "chat-tools")!;
    expect(toolsPanel).toBeDefined();
    expect(allNodes(toolsPanel).filter(node => props(node)?.type === "checkbox")).toHaveLength(0);
    const settingsPanel = allNodes(host).find(node => props(node)?.className === "chat-settings")!;
    expect(allNodes(settingsPanel).some(node => props(node)?.className === "checkbox chat-settings__browser")).toBe(true);
    const archive = allNodes(host).find(node => props(node)?.["aria-label"] === "封存：新對話")!;
    await act(async () => props(archive).onClick({ stopPropagation() {} }));
    expect(chat.shelveThread).toHaveBeenCalledWith(thread.id, true);
    const input = allNodes(host).find(node => node.tagName === "TEXTAREA")!;
    await act(async () => props(input).onFocus());
    await act(async () => props(input).onChange({ target: { value: "/model", selectionStart: 6 } }));
    await act(async () => props(input).onKeyDown({ key: "Enter", shiftKey: false, nativeEvent: { key: "Enter", isComposing: false }, preventDefault() {} }));
    expect(allNodes(host).some(node => props(node)?.role === "dialog")).toBe(true);
  } finally { await act(async () => root.unmount()); restore(); }
});
