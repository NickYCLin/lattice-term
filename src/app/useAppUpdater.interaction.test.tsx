import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useAppUpdater, type AppUpdater } from "./useAppUpdater";
const { check, install } = vi.hoisted(() => ({ check: vi.fn(), install: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check }));
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

it("deduplicates update checks and preserves an active installation", async () => {
  const document: Record<string, unknown> = { nodeType: 9, activeElement: null, addEventListener() {}, removeEventListener() {} };
  document.createElement = (name: string) => new HostNode(name.toUpperCase(), document);
  document.createElementNS = (_namespace: string, name: string) => new HostNode(name.toUpperCase(), document);
  document.createTextNode = (text: string) => { const node = new HostNode("#text", document); node.nodeType = 3; node.textContent = text; return node; };
  const container = new HostNode("DIV", document);
  document.body = container; document.documentElement = container;
  const window = { document, HTMLIFrameElement: class {}, localStorage: { getItem: () => null }, setInterval, clearInterval };
  document.defaultView = window;
  vi.stubGlobal("window", window); vi.stubGlobal("document", document);
  vi.stubGlobal("HTMLElement", HostNode); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  let api!: AppUpdater;
  function Probe() { api = useAppUpdater(); return <p>{api.status}</p>; }
  let resolveCheck!: (value: unknown) => void;
  let rejectInstall!: (reason: Error) => void;
  check.mockImplementation(() => new Promise(resolve => { resolveCheck = resolve; }));
  install.mockImplementation(() => new Promise((_resolve, reject) => { rejectInstall = reject; }));
  const root = createRoot(container as unknown as Element);
  try {
    await act(async () => { root.render(<Probe />); });
    await act(async () => { void api.checkForUpdates(); void api.checkForUpdates(); });
    expect(check).toHaveBeenCalledTimes(1);
    await act(async () => { resolveCheck({ version: "9.9.9", downloadAndInstall: install }); });
    expect(api.status).toBe("available");
    await act(async () => { void api.downloadAndInstall(); });
    await act(async () => { await api.checkForUpdates(); await api.downloadAndInstall(); });
    expect(check).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledTimes(1);
    expect(api.status).toBe("downloading");
    await act(async () => { rejectInstall(new Error("test download interrupted")); });
    expect(api.status).toBe("error");
    await act(async () => { void api.checkForUpdates(); });
    expect(check).toHaveBeenCalledTimes(2);
    await act(async () => { resolveCheck(null); });
    expect(api.status).toBe("up-to-date");
  } finally { await act(async () => { root.unmount(); }); vi.unstubAllGlobals(); vi.clearAllMocks(); }
});
