import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { AgentSessionImages, resolveSessionImageReference, type SessionImagesSnapshot } from "./AgentSessionImages";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../../app/nativeRuntime", () => ({ hasDesktopBackend: () => true }));

class HostNode {
  nodeType = 1;
  namespaceURI = "http://www.w3.org/1999/xhtml";
  childNodes: HostNode[] = [];
  parentNode: HostNode | null = null;
  style = {};
  disabled = false;
  hidden = false;
  get tabIndex() { return Number(this.attributes.tabindex ?? (this.tagName === "BUTTON" ? 0 : -1)); }
  get isConnected(): boolean { return this === this.ownerDocument.body || Boolean(this.parentNode?.isConnected); }
  closest() { return null; }
  querySelectorAll(selector: string) { return allNodes(this).filter(node => node !== this && (selector.includes("aria-modal") ? node.attributes["aria-modal"] === "true" : node.tagName === "BUTTON" && !node.disabled)); }
  attributes: Record<string, string> = {};
  value = "";
  defaultValue = "";
  ownerDocument: Record<string, unknown>;
  private text = "";
  constructor(readonly tagName: string, document: Record<string, unknown>) {
    this.ownerDocument = document;
  }
  get nodeName() { return this.tagName; }
  get nodeValue() { return this.text; }
  set nodeValue(value: string) { this.text = value; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get textContent(): string { return this.text + this.childNodes.map((child) => child.textContent).join(""); }
  set textContent(value: string) { this.text = value; this.childNodes = []; }
  appendChild(child: HostNode) { this.childNodes.push(child); child.parentNode = this; return child; }
  removeChild(child: HostNode) { this.childNodes = this.childNodes.filter((node) => node !== child); child.parentNode = null; return child; }
  insertBefore(child: HostNode, before: HostNode) { this.childNodes.splice(this.childNodes.indexOf(before), 0, child); child.parentNode = this; return child; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; if (name === "disabled") this.disabled = true; }
  setAttributeNS(_namespace: string, name: string, value: string) { this.setAttribute(name, value); }
  removeAttribute(name: string) { delete this.attributes[name]; if (name === "disabled") this.disabled = false; }
  addEventListener() {}
  removeEventListener() {}
  focus = vi.fn(() => { this.ownerDocument.activeElement = this; });
  scrollIntoView = vi.fn();
}

function allNodes(node: HostNode): HostNode[] {
  return [node, ...node.childNodes.flatMap(allNodes)];
}

function onClick(node: HostNode): () => void {
  const key = Object.keys(node).find(name => name.startsWith("__reactProps$"))!;
  return (node as unknown as Record<string, { onClick: () => void }>)[key].onClick;
}

function installHostDom() {
  const listeners = new Set<(event: unknown) => void>();
  const document: Record<string, unknown> = { nodeType: 9, activeElement: null,
    addEventListener(type: string, handler: (event: unknown) => void) { if (type === "keydown") listeners.add(handler); },
    removeEventListener(type: string, handler: (event: unknown) => void) { if (type === "keydown") listeners.delete(handler); },
    dispatchKey(event: unknown) { for (const listener of listeners) listener(event); },
  };
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
  document.querySelectorAll = (selector: string) => {
    const nodes = container.querySelectorAll(selector);
    return Object.assign(nodes, { item: (index: number) => nodes[index] });
  };
  const window = {
    document, HTMLIFrameElement: class {}, addEventListener() {}, removeEventListener() {},
    setInterval, clearInterval, setTimeout, clearTimeout,
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
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

function props(node: HostNode): Record<string, unknown> {
  const key = Object.keys(node).find(name => name.startsWith("__reactProps$"))!;
  return (node as unknown as Record<string, Record<string, unknown>>)[key];
}
function tiles(host: HostNode) { return allNodes(host).filter(node => node.attributes.class === "agent-session-images__tile"); }
function dialog(host: HostNode) { return allNodes(host).find(node => node.attributes.role === "dialog"); }
async function clickTile(node: HostNode) {
  await act(async () => (props(node).onClick as (event: unknown) => void)({ currentTarget: node }));
}
async function key(host: HostNode, value: string) {
  const event = { key: value, nativeEvent: { isComposing: false }, preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn() };
  await act(async () => {
    (host.ownerDocument.dispatchKey as (event: unknown) => void)(event);
  });
}
const paths = ["/cache/a.png", "/cache/b.png", "/cache/c.png"];
function fixture(extra: Partial<SessionImagesSnapshot> = {}) {
  invoke.mockImplementation(async command => command === "agent_session_images_snapshot"
    ? { paths, truncated: false, historyAvailable: true, ...extra } : "data:image/png;base64,fixture");
}

it("defaults to one thumbnail strip with a count and no expanded dialog or pagination", async () => {
  const host = installHostDom(); const root = createRoot(host as unknown as Element);
  fixture({ paths: Array.from({ length: 12 }, (_, i) => `/cache/${i}.png`) });
  try {
    await act(async () => root.render(renderImages()));
    expect(tiles(host)).toHaveLength(12);
    expect(host.textContent).toContain("圖片附件 · 12");
    expect(dialog(host)).toBeUndefined();
    expect(host.textContent).not.toContain("下一頁");
    expect(tiles(host).map(node => node.textContent)).toEqual(Array.from({ length: 12 }, (_, i) => `#${i + 1}`));
  } finally { await act(async () => root.unmount()); }
});

it("switches by arrows and buttons, updates the highlighted thumbnail, and returns focus on Escape", async () => {
  const host = installHostDom(); const root = createRoot(host as unknown as Element); fixture();
  try {
    await act(async () => root.render(renderImages()));
    const trigger = tiles(host)[1];
    await clickTile(trigger);
    expect(dialog(host)).toBeDefined();
    expect(host.textContent).toContain("第 2／共 3 張");
    expect(tiles(host)[1].attributes["aria-current"]).toBe("true");
    await key(host, "ArrowRight");
    expect(host.textContent).toContain("第 3／共 3 張");
    expect(tiles(host)[2].attributes["aria-current"]).toBe("true");
    expect(tiles(host)[2].scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
    const next = allNodes(host).find(node => node.tagName === "BUTTON" && node.textContent === "下一張")!;
    expect(next.disabled).toBe(true);
    await key(host, "ArrowRight");
    expect(host.textContent).toContain("第 3／共 3 張");
    await key(host, "ArrowLeft");
    expect(host.textContent).toContain("第 2／共 3 張");
    await act(async () => onClick(allNodes(host).find(node => node.tagName === "BUTTON" && node.textContent === "上一張")!)());
    expect(host.textContent).toContain("第 1／共 3 張");
    await key(host, "Escape");
    expect(dialog(host)).toBeUndefined();
    expect(host.ownerDocument.activeElement).toBe(trigger);
    expect(tiles(host)[0].attributes["aria-current"]).toBe("true");
  } finally { await act(async () => root.unmount()); }
});

it("opens a numbered terminal marker directly in the lightbox using its prompt, not cache order", async () => {
  const host = installHostDom(); const root = createRoot(host as unknown as Element);
  fixture({ paths: [...paths].reverse(), prompts: [{ text: "target prompt", paths }] });
  const render = (openRevision: number, index: number) => <I18nProvider locale="zh-TW">
    <AgentSessionImages sessionId="owner" active revision={0} openRevision={openRevision}
      reference={{ index, context: "target prompt [Image #2]" }} />
  </I18nProvider>;
  try {
    await act(async () => root.render(render(0, 2)));
    expect(dialog(host)).toBeUndefined();
    await act(async () => root.render(render(1, 2)));
    expect(dialog(host)).toBeDefined();
    expect(host.textContent).toContain("第 2／共 3 張");
    expect(tiles(host)[1].attributes["aria-label"]).toContain("b.png");
    expect(tiles(host)[1].attributes["aria-current"]).toBe("true");
    await key(host, "Escape");
    await act(async () => root.render(render(2, 1)));
    expect(host.textContent).toContain("第 1／共 3 張");
  } finally { await act(async () => root.unmount()); }
});

it("restores a terminal trigger rather than moving keyboard focus to the strip", async () => {
  const host = installHostDom(); const root = createRoot(host as unknown as Element);
  fixture({ prompts: [{ text: "target prompt", paths }] });
  const render = (openRevision: number) => <I18nProvider locale="zh-TW"><AgentSessionImages sessionId="owner" active revision={0}
    openRevision={openRevision} reference={{ index: 1, context: "target prompt" }} /></I18nProvider>;
  try {
    await act(async () => root.render(render(0)));
    const trigger = new HostNode("TEXTAREA", host.ownerDocument); host.appendChild(trigger); trigger.focus();
    await act(async () => root.render(render(1)));
    await key(host, "ArrowRight");
    await key(host, "Escape");
    expect(host.ownerDocument.activeElement).toBe(trigger);
  } finally { await act(async () => root.unmount()); }
});

it("keeps ambiguous markers in the compact all-image strip with an explanation", async () => {
  const host = installHostDom(); const root = createRoot(host as unknown as Element);
  fixture({ prompts: [{ text: "same prompt", paths: [paths[0]] }, { text: "same prompt", paths: [paths[1]] }] });
  const render = (openRevision: number) => <I18nProvider locale="zh-TW"><AgentSessionImages sessionId="owner" active revision={0}
    openRevision={openRevision} reference={{ index: 1, context: "same prompt" }} /></I18nProvider>;
  try {
    await act(async () => root.render(render(0)));
    await act(async () => root.render(render(1)));
    expect(host.textContent).toContain("無法唯一對應"); expect(tiles(host)).toHaveLength(3);
    expect(dialog(host)).toBeUndefined();
    expect(tiles(host).some(node => node.attributes["aria-current"])).toBe(false);
    await clickTile(tiles(host)[2]); expect(host.textContent).toContain("第 3／共 3 張");
  } finally { await act(async () => root.unmount()); }
});

it("merges observed pictures without paths or tool metadata and handles unavailable previews", async () => {
  const host = installHostDom(); const root = createRoot(host as unknown as Element);
  invoke.mockImplementation(async command => command === "agent_session_images_snapshot"
    ? { paths: [paths[0]], truncated: false, historyAvailable: true, observed: [
      { tool: "private-tool", stepId: "private-step", at: "private-time", paths: [paths[0], paths[1]], localReference: false },
    ] } : null);
  try {
    await act(async () => root.render(renderImages()));
    expect(tiles(host)).toHaveLength(2);
    expect(host.textContent).not.toMatch(/cache|private/);
    expect(host.textContent).toContain("無法載入圖片");
    await clickTile(tiles(host)[0]); expect(dialog(host)).toBeDefined();
    await key(host, "ArrowRight"); expect(host.textContent).toContain("第 2／共 2 張");
  } finally { await act(async () => root.unmount()); }
});

it("ignores a delayed snapshot when inactive and reloads on re-entry", async () => {
  const host = installHostDom(); const root = createRoot(host as unknown as Element);
  let resolve!: (snapshot: SessionImagesSnapshot) => void;
  invoke.mockImplementationOnce(() => new Promise<SessionImagesSnapshot>(done => { resolve = done; }));
  try {
    await act(async () => root.render(renderImages()));
    await act(async () => root.render(renderImages("owner", false)));
    await act(async () => resolve({ paths, truncated: false, historyAvailable: true }));
    expect(tiles(host)).toHaveLength(0);
    fixture(); await act(async () => root.render(renderImages()));
    expect(tiles(host)).toHaveLength(3);
    await clickTile(tiles(host)[0]);
    await act(async () => root.render(renderImages("other", false)));
    expect(dialog(host)).toBeUndefined();
  } finally { await act(async () => root.unmount()); }
});

it("reports errors and reloads with bounded-history information", async () => {
  const host = installHostDom(); const root = createRoot(host as unknown as Element);
  invoke.mockRejectedValueOnce("read denied");
  try {
    await act(async () => root.render(renderImages()));
    expect(host.textContent).toContain("圖片讀取失敗");
    fixture({ paths: [], truncated: true, historyAvailable: false });
    await act(async () => onClick(allNodes(host).find(node => node.tagName === "BUTTON" && node.textContent === "重新讀取")!)());
    expect(host.textContent).toContain("不是完整圖片紀錄");
    expect(host.textContent).toContain("尚未找到可查看的圖片");
    expect(host.textContent).not.toContain("read denied");
  } finally { await act(async () => root.unmount()); }
});

it.each([
  { paths: [null, "/cache/b.png"], index: 1, truncated: false },
  { paths: ["/cache/a.png"], index: 2, truncated: false },
  { paths: ["/cache/a.png"], index: 1, truncated: true },
])("does not guess missing slots, out-of-range markers or truncated history: %j", ({ paths, index, truncated }) => {
  expect(resolveSessionImageReference({ paths: [], historyAvailable: true, truncated,
    prompts: [{ text: "prompt", paths }] }, { index, context: "prompt" })).toBeNull();
});

it("loads thumbnail pixels only when they enter the visible strip", async () => {
  const observers: { callback: (entries: { isIntersecting: boolean }[]) => void; disconnect: ReturnType<typeof vi.fn> }[] = [];
  vi.stubGlobal("IntersectionObserver", class {
    disconnect = vi.fn();
    constructor(readonly callback: (entries: { isIntersecting: boolean }[]) => void) { observers.push(this); }
    observe() {}
  });
  const host = installHostDom(); const root = createRoot(host as unknown as Element); fixture();
  try {
    await act(async () => root.render(renderImages()));
    expect(tiles(host)).toHaveLength(3);
    expect(invoke.mock.calls.filter(([command]) => command === "chat_image_preview")).toHaveLength(0);
    await act(async () => observers[1].callback([{ isIntersecting: true }]));
    expect(invoke).toHaveBeenCalledWith("chat_image_preview", { path: paths[1], workingDirectory: "", threadId: "owner" });
    expect(invoke.mock.calls.filter(([command]) => command === "chat_image_preview")).toHaveLength(1);
    expect(observers[1].disconnect).toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});

it("returns focus after the close button or backdrop and keeps the single-image controls bounded", async () => {
  const host = installHostDom(); const root = createRoot(host as unknown as Element); fixture({ paths: [paths[0]] });
  try {
    await act(async () => root.render(renderImages()));
    const trigger = tiles(host)[0];
    await clickTile(trigger);
    expect(host.textContent).toContain("第 1／共 1 張");
    for (const name of ["上一張", "下一張"]) {
      expect(allNodes(host).find(node => node.tagName === "BUTTON" && node.textContent === name)!.disabled).toBe(true);
    }
    await act(async () => onClick(allNodes(host).find(node => node.attributes["aria-label"] === "關閉")!)());
    expect(dialog(host)).toBeUndefined(); expect(host.ownerDocument.activeElement).toBe(trigger);
    await clickTile(trigger);
    const backdrop = allNodes(host).find(node => node.attributes.class?.includes("chat-image-preview") && node.attributes.class.includes("scrim"))!;
    await act(async () => (props(backdrop).onMouseDown as (event: unknown) => void)({ target: backdrop, currentTarget: backdrop }));
    expect(dialog(host)).toBeUndefined(); expect(host.ownerDocument.activeElement).toBe(trigger);
  } finally { await act(async () => root.unmount()); }
});

it("loads old-folder attachments after a PTY session is restored with a new runtime id", async () => {
  const host = installHostDom(); const root = createRoot(host as unknown as Element);
  const path = "/synthetic/chat-workspaces/agent-session-old/agent-image-0123456789abcdef0123456789abcdef.png";
  fixture({ paths: [path] });
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><AgentSessionImages sessionId="new-runtime" active revision={0} /></I18nProvider>));
    expect(tiles(host)).toHaveLength(1);
    expect(allNodes(host).find(node => node.tagName === "IMG")?.attributes.src).toContain("data:image/png");
    await clickTile(tiles(host)[0]);
    expect(dialog(host)).toBeDefined();
    expect(invoke).toHaveBeenCalledWith("chat_image_preview", { path, workingDirectory: "", threadId: "new-runtime" });
    invoke.mockImplementation(async command => {
      if (command === "agent_session_images_snapshot") return { paths: [path], truncated: false, historyAvailable: true };
      throw "chat.images.missing";
    });
    await act(async () => root.render(<I18nProvider locale="zh-TW"><AgentSessionImages sessionId="next-runtime" active revision={0} /></I18nProvider>));
    expect(host.textContent).toContain("圖片檔案已移動或刪除。");
    await clickTile(tiles(host)[0]);
    expect(dialog(host)?.textContent).toContain("圖片檔案已移動或刪除。");
  } finally { await act(async () => root.unmount()); }
});
