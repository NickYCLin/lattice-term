import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { fakeChatApi } from "../../app/testFixtures/agentApis";
import type { LocalConversation } from "../../app/localConversationSessions";
import { NativeHistoryContext, type NativeHistory } from "../../app/useNativeConversations";
import { I18nProvider } from "../../i18n";
import { NativeConversationRows } from "./NativeConversationRows";
import { SentAttachments } from "./SentAttachments";
import { ConversationReadProgress } from "./ConversationReadProgress";
import { ChatThreadTree } from "./ChatThreadTree";
import { chatConversationSidebar, nativeConversationNodeId } from "../../app/chatConversationSidebar";
import { chatSidebarLayout } from "../../app/chatThreadLayout";
import { emptySessionSidebarLayout } from "../../app/sessionSidebarLayout";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

it("files native history without opening it on the drag-release click", async () => {
  const container = installHostDom();
  const listeners = new Map<string, (event: Partial<PointerEvent>) => void>();
  const hostDocument = container.ownerDocument;
  hostDocument.addEventListener = (name: string, listener: (event: Partial<PointerEvent>) => void) => listeners.set(name, listener);
  hostDocument.removeEventListener = (name: string) => listeners.delete(name);
  const entry: LocalConversation = { definitionId: "codex", profileId: null, nativeSessionId: "drag-native",
    title: "待分類的紀錄", workingDirectory: "/work", resumable: true, updatedAt: 1 };
  const projection = chatConversationSidebar({ sessions: [], definitions: [], threads: [], history: [entry], profiles: [],
    generalProjectLabel: "一般對話", projectFilter: null });
  const layout = chatSidebarLayout(emptySessionSidebarLayout, [], projection.workspace.nodes);
  const projectId = [...projection.workspace.projects.keys()][0];
  hostDocument.elementFromPoint = () => ({ closest: () => ({ dataset: { nodeId: projectId }, getBoundingClientRect: () => ({ top: 0, height: 100 }) }) });
  const moved = vi.fn();
  const opened = vi.fn();
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(<I18nProvider locale="zh-TW"><ChatThreadTree layout={layout} threads={[]}
    activeThreadId={null} workspace={projection.workspace} renderThread={() => null}
    renderNativeConversation={() => <button onClick={opened}>待分類的紀錄</button>}
    onSelectThread={() => {}} onRemoveThread={() => {}} onToggleFolder={() => {}} onRenameFolder={() => {}}
    onRemoveFolder={() => {}} onCreateFolder={() => {}} onMoveNode={moved} /> </I18nProvider>));
  const props = (node: HostNode): Record<string, (event: unknown) => void> => {
    const key = Object.keys(node).find(name => name.startsWith("__reactProps$"))!;
    return (node as unknown as Record<string, Record<string, (event: unknown) => void>>)[key];
  };
  const row = allNodes(container).find(node => node.attributes["data-node-id"] === nativeConversationNodeId(entry))!;
  const tree = allNodes(container).find(node => node.attributes.class === "chat-tree")!;
  await act(async () => props(row).onPointerDown({ pointerType: "mouse", button: 0, pointerId: 1, clientX: 0, clientY: 0,
    target: { closest: () => null } }));
  await act(async () => listeners.get("pointermove")!({ pointerId: 1, clientX: 20, clientY: 50, preventDefault: () => {} }));
  await act(async () => listeners.get("pointerup")!({ pointerId: 1 }));
  expect(moved).toHaveBeenCalledWith(nativeConversationNodeId(entry), projectId, null);
  const prevented = vi.fn();
  const stopped = vi.fn();
  props(tree).onClickCapture({ detail: 1, preventDefault: prevented, stopPropagation: stopped });
  expect(prevented).toHaveBeenCalledOnce();
  expect(stopped).toHaveBeenCalledOnce();
  expect(opened).not.toHaveBeenCalled();
  const keyboardPrevented = vi.fn();
  props(tree).onClickCapture({ detail: 0, preventDefault: keyboardPrevented, stopPropagation: vi.fn() });
  expect(keyboardPrevented).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../../app/useCliProxyApi", () => ({ useCliProxySettings: () => ({ proxies: [] }) }));
vi.mock("../../app/nativeRuntime", () => ({ hasDesktopBackend: () => true }));
vi.mock("../overlays/modalFocus", () => ({ useModalFocus: () => {} }));

class HostNode {
  nodeType = 1;
  namespaceURI = "http://www.w3.org/1999/xhtml";
  childNodes: HostNode[] = [];
  parentNode: HostNode | null = null;
  style = {};
  attributes: Record<string, string> = {};
  value = "";
  defaultValue = "";
  ownerDocument: Record<string, unknown>;
  private text = "";
  constructor(readonly tagName: string, document: Record<string, unknown>) {
    this.ownerDocument = document;
  }
  get nodeName() { return this.tagName; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get textContent(): string { return this.text + this.childNodes.map((child) => child.textContent).join(""); }
  set textContent(value: string) { this.text = value; this.childNodes = []; }
  appendChild(child: HostNode) { this.childNodes.push(child); child.parentNode = this; return child; }
  removeChild(child: HostNode) { this.childNodes = this.childNodes.filter((node) => node !== child); child.parentNode = null; return child; }
  insertBefore(child: HostNode, before: HostNode) { this.childNodes.splice(this.childNodes.indexOf(before), 0, child); child.parentNode = this; return child; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  setAttributeNS(_namespace: string, name: string, value: string) { this.setAttribute(name, value); }
  removeAttribute(name: string) { delete this.attributes[name]; }
  addEventListener() {}
  removeEventListener() {}
  focus() {}
}

function allNodes(node: HostNode): HostNode[] {
  return [node, ...node.childNodes.flatMap(allNodes)];
}

function onClick(node: HostNode): () => void {
  const key = Object.keys(node).find(name => name.startsWith("__reactProps$"))!;
  return (node as unknown as Record<string, { onClick: () => void }>)[key].onClick;
}

function installHostDom() {
  const document: Record<string, unknown> = { nodeType: 9, activeElement: null, addEventListener() {}, removeEventListener() {} };
  document.createElement = (name: string) => new HostNode(name.toUpperCase(), document);
  document.createElementNS = (_namespace: string, name: string) => new HostNode(name.toUpperCase(), document);
  document.createTextNode = (text: string) => {
    const node = new HostNode("#text", document);
    node.nodeType = 3;
    node.textContent = text;
    return node;
  };
  const container = new HostNode("DIV", document);
  document.body = container;
  document.documentElement = container;
  const window = {
    document, HTMLIFrameElement: class {}, addEventListener() {}, removeEventListener() {},
    setInterval, clearInterval, setTimeout, clearTimeout,
  };
  document.defaultView = window;
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("HTMLElement", HostNode);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return container;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  invoke.mockReset();
});

it("opens a native thread immediately without waiting for a snapshot in the list", async () => {
  const container = installHostDom();
  const entry: LocalConversation = { definitionId: "codex", profileId: null, nativeSessionId: "slow",
    title: "Large history", workingDirectory: "/work", resumable: true, updatedAt: 1 };
  const history = { entries: [entry], profiles: [], profileKey: "[]" } as unknown as NativeHistory;
  const chat = fakeChatApi();
  const opened = vi.fn();
  const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><NativeHistoryContext.Provider value={history}>
      <NativeConversationRows chat={chat} projectFilter={null} onOpened={opened} />
    </NativeHistoryContext.Provider></I18nProvider>));
    await act(async () => onClick(allNodes(container).find(node => node.tagName === "BUTTON")!)());
    expect(chat.importNativeConversation).toHaveBeenCalledWith(expect.objectContaining({ nativeSessionId: "slow", messages: [] }));
    expect(opened).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});

it("counts actual waiting time without inventing a percentage and cleans up its timer", async () => {
  vi.useFakeTimers();
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  const retry = vi.fn();
  const render = (loading: boolean, error: string | null = null) => <I18nProvider locale="zh-TW">
    <ConversationReadProgress loading={loading} error={error} onRetry={retry} />
  </I18nProvider>;
  try {
    await act(async () => root.render(render(true)));
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(container.textContent).toContain("已等待 9 秒");
    expect(container.textContent).toContain("無法估算剩餘時間");
    const progress = allNodes(container).find(node => node.attributes.role === "progressbar")!;
    expect(progress.attributes["aria-valuenow"]).toBeUndefined();
    await act(async () => root.render(render(false, "disk busy")));
    expect(allNodes(container).some(node => node.attributes.role === "progressbar")).toBe(false);
    await act(async () => onClick(allNodes(container).find(node => node.tagName === "BUTTON")!)());
    expect(retry).toHaveBeenCalledOnce();
    await act(async () => root.render(render(true)));
    expect(container.textContent).toContain("已等待 0 秒");
  } finally { await act(async () => root.unmount()); }
  expect(vi.getTimerCount()).toBe(0);
});

it("opens sent images in a dialog using the owning thread and reports missing files", async () => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  invoke.mockResolvedValue(null);
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><SentAttachments
      attachments={[{ isImage: true, name: "shot.png", path: "/work/shot.png" }, { isImage: false, name: "notes.txt", path: "/work/notes.txt" }]}
      workingDirectory="/work" threadId="owner" /></I18nProvider>));
    expect(allNodes(container).filter(node => node.tagName === "BUTTON")).toHaveLength(1);
    await act(async () => onClick(allNodes(container).find(node => node.tagName === "BUTTON")!)());
    expect(invoke).toHaveBeenCalledWith("chat_image_preview", { path: "/work/shot.png", workingDirectory: "/work", threadId: "owner" });
    expect(allNodes(container).some(node => node.attributes.role === "dialog")).toBe(true);
    expect(container.textContent).toContain("無法載入圖片");
    await act(async () => onClick(allNodes(container).find(node => node.attributes["aria-label"] === "關閉")!)());
    expect(allNodes(container).some(node => node.attributes.role === "dialog")).toBe(false);
  } finally { await act(async () => root.unmount()); }
});

it("automatically groups native conversations by project without importing them", async () => {
  const container = installHostDom();
  const entries: LocalConversation[] = [
    { definitionId: "codex", profileId: null, nativeSessionId: "a", title: "Alpha first", workingDirectory: "D:/work/Alpha", resumable: true, updatedAt: 3 },
    { definitionId: "claude", profileId: null, nativeSessionId: "b", title: "Beta chat", workingDirectory: "D:/work/Beta", resumable: true, updatedAt: 2 },
    { definitionId: "codex", profileId: null, nativeSessionId: "c", title: "Alpha second", workingDirectory: "D:/work/Alpha/", resumable: true, updatedAt: 1 },
  ];
  const history = { entries, profiles: [], profileKey: "[]", hasMore: false, busy: false, error: null } as unknown as NativeHistory;
  const chat = fakeChatApi();
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(<I18nProvider locale="zh-TW"><NativeHistoryContext.Provider value={history}>
    <NativeConversationRows chat={chat} projectFilter={null} onOpened={() => {}} />
  </NativeHistoryContext.Provider></I18nProvider>));
  const groups = allNodes(container).filter(node => node.tagName === "DETAILS");
  expect(groups).toHaveLength(2);
  expect(groups[0].textContent).toContain("Alpha first");
  expect(groups[0].textContent).toContain("Alpha second");
  expect(groups[1].textContent).toContain("Beta chat");
  expect(chat.importNativeConversation).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

it("shows a Cursor conversation in place without turning it into a thread", async () => {
  const container = installHostDom();
  const entry: LocalConversation = {
    definitionId: "cursor", profileId: null, nativeSessionId: "cursor-1", title: "Cursor 的對話",
    workingDirectory: "D:/work/app", resumable: false, updatedAt: 1,
  };
  const history = {
    entries: [entry], profiles: [], profileKey: "[]", hasMore: false, busy: false, error: null,
  } as unknown as NativeHistory;
  invoke.mockResolvedValue({
    messages: [{ role: "user", text: "幫我看這段" }, { role: "assistant", text: "這段沒問題" }],
    truncated: false,
  });
  const chat = fakeChatApi();
  const opened = vi.fn();
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(
    <NativeHistoryContext.Provider value={history}>
      <I18nProvider locale="zh-TW">
        <NativeConversationRows chat={chat} projectFilter={null} onOpened={opened} />
      </I18nProvider>
    </NativeHistoryContext.Provider>,
  ));
  const button = () => allNodes(container).find(node => node.tagName === "BUTTON")!;
  expect(button().textContent).toContain("Cursor Agent");
  expect(String(button().attributes["aria-expanded"])).toBe("false");

  await act(async () => onClick(button())());
  expect(invoke).toHaveBeenCalledWith("agent_chat_local_history_snapshot", expect.objectContaining({
    definitionId: "cursor", nativeSessionId: "cursor-1",
  }));
  expect(container.textContent).toContain("幫我看這段");
  expect(container.textContent).toContain("這段沒問題");
  expect(String(button().attributes["aria-expanded"])).toBe("true");
  expect(chat.importNativeConversation).not.toHaveBeenCalled();
  expect(opened).not.toHaveBeenCalled();

  await act(async () => onClick(button())());
  expect(container.textContent).not.toContain("幫我看這段");
  expect(String(button().attributes["aria-expanded"])).toBe("false");
  expect(invoke).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
});
