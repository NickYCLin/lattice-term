import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { RdpConnectFlow } from "./RdpConnectFlow";
import type { RdpApi } from "../../app/useRdpSessions";
import type { ConnectionProfile } from "../../domain/connection";

const { connect, remove } = vi.hoisted(() => ({ connect: vi.fn(), remove: vi.fn() }));
vi.mock("../../app/useSavedCredential", () => ({ useSavedCredential: () => ({
  state: { mode: "saved", provider: "System credential store", detail: null }, remove,
}) }));
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


afterEach(() => { vi.unstubAllGlobals(); connect.mockReset(); remove.mockReset(); });
const profile: ConnectionProfile = { id: "rdp-fixture", name: "測試主機", protocol: "rdp",
  hostname: "host.example.test", port: 3389, username: "tester", environment: "unassigned",
  group: "", tags: [], favorite: false };
function reactProps(node: HostNode): Record<string, unknown> {
  const key = Object.keys(node).find(name => name.startsWith("__reactProps$"))!;
  return (node as unknown as Record<string, Record<string, unknown>>)[key];
}
async function submit(container: HostNode) {
  const form = allNodes(container).find(node => node.tagName === "FORM")!;
  await act(async () => (reactProps(form).onSubmit as (event: unknown) => void)({ preventDefault() {} }));
}

it("explains an expired saved password and updates it only when the person opts in", async () => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  const connected = vi.fn();
  connect.mockResolvedValueOnce({ outcome: "failed", stage: "connect", detail: "[CredSSP] STATUS_PASSWORD_EXPIRED [0xc0000071]" });
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><RdpConnectFlow profile={profile}
      rdp={{ connect } as unknown as RdpApi} onConnected={connected} onCancel={vi.fn()} /></I18nProvider>));
    expect(allNodes(container).some(node => node.attributes.id === "rdp-password")).toBe(false);
    await submit(container);
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ useSavedPassword: true, password: "", rememberPassword: false }));
    expect(container.textContent).toContain("密碼已到期");
    expect(container.textContent).toContain("0xc0000071");
    expect(remove).not.toHaveBeenCalled();
    const input = allNodes(container).find(node => node.attributes.id === "rdp-password")!;
    expect(input).toBeDefined();
    expect(container.textContent).toContain("更新已儲存的密碼");
    await act(async () => (reactProps(input).onChange as (event: unknown) => void)({ currentTarget: { value: "fixture-new-password" } }));
    const checkbox = allNodes(container).find(node => node.tagName === "INPUT" && node.parentNode?.textContent.includes("更新已儲存的密碼"))!;
    expect(reactProps(checkbox).checked).toBe(false);
    await act(async () => (reactProps(checkbox).onChange as (event: unknown) => void)({ currentTarget: { checked: true } }));
    connect.mockResolvedValueOnce({ outcome: "connected", sessionId: "new-rdp-session" });
    await submit(container);
    expect(connect).toHaveBeenLastCalledWith(expect.objectContaining({ useSavedPassword: false, password: "fixture-new-password", rememberPassword: true }));
    expect(connected).toHaveBeenCalledWith("new-rdp-session");
    expect(remove).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});
it("keeps the saved credential selected when TLS or the network fails", async () => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  connect.mockResolvedValueOnce({ outcome: "failed", stage: "connect", detail: "TLS certificate validation failed" });
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><RdpConnectFlow profile={profile}
      rdp={{ connect } as unknown as RdpApi} onConnected={vi.fn()} onCancel={vi.fn()} /></I18nProvider>));
    await submit(container);
    expect(allNodes(container).some(node => node.attributes.id === "rdp-password")).toBe(false);
    expect(container.textContent).not.toContain("密碼已到期");
    expect(container.textContent).toContain("TLS certificate validation failed");
    expect(remove).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});
