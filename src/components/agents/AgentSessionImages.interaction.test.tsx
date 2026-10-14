import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { AgentSessionImages, type SessionImagesSnapshot } from "./AgentSessionImages";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
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


afterEach(() => { vi.unstubAllGlobals(); invoke.mockReset(); });
const renderImages = (sessionId = "owner", active = true) => <I18nProvider locale="zh-TW">
  <AgentSessionImages key={sessionId} sessionId={sessionId} active={active} revision={0} />
</I18nProvider>;

it("opens through a terminal marker revision, closes and reopens without reusing a previous session", async () => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  invoke.mockResolvedValue({ paths: [], truncated: false, historyAvailable: false });
  const render = (sessionId: string, revision: number, active = true) => <I18nProvider locale="zh-TW">
    <AgentSessionImages key={sessionId} sessionId={sessionId} active={active} revision={0} openRevision={revision} />
  </I18nProvider>;
  try {
    await act(async () => root.render(render("first", 0)));
    expect(invoke).not.toHaveBeenCalled();
    await act(async () => root.render(render("first", 1)));
    expect(invoke).toHaveBeenCalledExactlyOnceWith("agent_session_images_snapshot", { sessionId: "first" });
    await act(async () => onClick(allNodes(container).find(node => node.attributes["aria-label"] === "關閉")!)());
    expect(allNodes(container).filter(node => node.attributes.role === "dialog")).toHaveLength(0);
    await act(async () => root.render(render("first", 2)));
    expect(invoke).toHaveBeenCalledTimes(2);
    await act(async () => root.render(render("second", 2)));
    expect(allNodes(container).filter(node => node.attributes.role === "dialog")).toHaveLength(0);
    await act(async () => root.render(render("second", 3)));
    expect(invoke).toHaveBeenLastCalledWith("agent_session_images_snapshot", { sessionId: "second" });
    await act(async () => root.render(render("second", 4, false)));
    expect(allNodes(container).filter(node => node.attributes.role === "dialog")).toHaveLength(0);
  } finally { await act(async () => root.unmount()); }
});

it("loads only on opening and opens the exact thumbnail without guessing image numbers", async () => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  const url = "data:image/png;base64,fixture";
  invoke.mockImplementation(async command => command === "agent_session_images_snapshot"
    ? { paths: ["/cache/agent-image-fixture.png"], truncated: false, historyAvailable: true } : url);
  try {
    await act(async () => root.render(renderImages()));
    expect(invoke).not.toHaveBeenCalled();
    await act(async () => onClick(allNodes(container).find(node => node.textContent === "圖片附件" && node.tagName === "BUTTON")!)());
    expect(invoke).toHaveBeenCalledWith("agent_session_images_snapshot", { sessionId: "owner" });
    expect(invoke).toHaveBeenCalledWith("chat_image_preview", { path: "/cache/agent-image-fixture.png", workingDirectory: "", threadId: "owner" });
    await act(async () => onClick(allNodes(container).find(node => node.attributes.class === "agent-session-images__tile")!)());
    expect(allNodes(container).filter(node => node.attributes.role === "dialog")).toHaveLength(2);
    expect(allNodes(container).filter(node => node.tagName === "IMG").every(node => node.attributes.src === url)).toBe(true);
    await act(async () => root.render(renderImages("other")));
    expect(allNodes(container).some(node => node.attributes.role === "dialog")).toBe(false);
    expect(invoke.mock.calls.filter(([command]) => command === "agent_session_images_snapshot")).toHaveLength(1);
  } finally { await act(async () => root.unmount()); }
});

it("does not show a delayed snapshot after switching away and reloads on re-entry", async () => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  let resolve!: (snapshot: SessionImagesSnapshot) => void;
  invoke.mockImplementationOnce(() => new Promise<SessionImagesSnapshot>(done => { resolve = done; }));
  try {
    await act(async () => root.render(renderImages()));
    await act(async () => onClick(allNodes(container).find(node => node.tagName === "BUTTON")!)());
    expect(container.textContent).toContain("正在讀取");
    await act(async () => root.render(renderImages("owner", false)));
    await act(async () => resolve({ paths: ["stale.png"], truncated: false, historyAvailable: true }));
    expect(container.textContent).not.toContain("stale.png");
    invoke.mockResolvedValue({ paths: [], truncated: false, historyAvailable: false });
    await act(async () => root.render(renderImages()));
    await act(async () => onClick(allNodes(container).find(node => node.tagName === "BUTTON")!)());
    expect(container.textContent).toContain("尚未讀到原生對話紀錄");
    expect(container.textContent).toContain("尚未找到可查看的圖片");
    expect(invoke.mock.calls.filter(([command]) => command === "agent_session_images_snapshot")).toHaveLength(2);
  } finally { await act(async () => root.unmount()); }
});

it("reports errors and reloads instead of silently showing an empty gallery", async () => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  invoke.mockRejectedValueOnce("read denied");
  try {
    await act(async () => root.render(renderImages()));
    await act(async () => onClick(allNodes(container).find(node => node.tagName === "BUTTON")!)());
    expect(container.textContent).toContain("圖片讀取失敗");
    expect(container.textContent).toContain("read denied");
    invoke.mockResolvedValue({ paths: [], truncated: true, historyAvailable: true });
    await act(async () => onClick(allNodes(container).find(node => node.tagName === "BUTTON" && node.textContent === "重新讀取")!)());
    expect(container.textContent).toContain("不是完整圖片紀錄");
    expect(container.textContent).not.toContain("read denied");
  } finally { await act(async () => root.unmount()); }
});

it("loads one page of thumbnails and reports unavailable pictures", async () => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  invoke.mockImplementation(async command => command === "agent_session_images_snapshot"
    ? { paths: Array.from({ length: 12 }, (_, index) => "/cache/clipboard-" + index + ".png"), truncated: false, historyAvailable: true }
    : null);
  try {
    await act(async () => root.render(renderImages()));
    await act(async () => onClick(allNodes(container).find(node => node.tagName === "BUTTON")!)());
    expect(invoke.mock.calls.filter(([command]) => command === "chat_image_preview")).toHaveLength(9);
    expect(container.textContent).toContain("無法載入圖片");
    await act(async () => onClick(allNodes(container).find(node => node.tagName === "BUTTON" && node.textContent === "下一頁")!)());
    expect(invoke.mock.calls.filter(([command]) => command === "chat_image_preview")).toHaveLength(12);
    expect(allNodes(container).filter(node => node.attributes.class === "agent-session-images__tile")).toHaveLength(3);
  } finally { await act(async () => root.unmount()); }
});
