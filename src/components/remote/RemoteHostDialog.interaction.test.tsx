import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { RemoteHostApi } from "../../app/useRemoteHost";
import { RemoteHostDialog } from "./RemoteHostDialog";

vi.mock("../overlays/modalFocus", () => ({ useModalFocus: () => {} }));

// React host tree, following the editor interaction tests. Native activation
// runs after the click handler and sees the button's post-render form/type.
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

interface Activation { defaultPrevented: boolean; preventDefault(): void }
interface Props {
  type?: string;
  onClick?: (event: Activation) => void;
  onSubmit?: (event: Activation) => Promise<void>;
  onChange?: (event: { currentTarget: { checked: boolean } }) => void;
}
function props(node: HostNode): Props {
  const key = Object.keys(node).find(name => name.startsWith("__reactProps$"))!;
  return (node as unknown as Record<string, Props>)[key];
}
afterEach(() => { vi.unstubAllGlobals(); });

it("opens permissions without immediately submitting the newly rendered save action", async () => {
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
  const host: RemoteHostApi = {
    deviceId: null, deviceIdError: null, ensureDeviceId: vi.fn(async () => {}),
    status: { hostId: "owned-test", address: "127.0.0.1:44900", pairingCode: "", expiresAt: 0, viewOnly: true, fileTransfer: false, state: "waiting", attemptsRemaining: 5, persistent: true },
    closedReason: null, start: vi.fn(async () => host.status!), stop: vi.fn(async () => {}), clearClosedReason: vi.fn(),
  };
  const root = createRoot(container as unknown as Element);
  const find = (tag: string, text = "") => allNodes(container).find(node => node.tagName === tag && node.textContent.includes(text));
  try {
    await act(async () => { root.render(<I18nProvider locale="zh-TW"><RemoteHostDialog host={host} platform="windows" sensitiveClipboardClear="off" onClose={vi.fn()} /></I18nProvider>); });
    const edit = find("BUTTON", "連線與權限設定")!;
    const activation: Activation = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    await act(async () => { props(edit).onClick!(activation); });
    // The old DOM node became type=submit during the click. A browser then
    // submitted immediately, restarting sharing and hiding its permissions.
    if (!activation.defaultPrevented && edit.parentNode && props(edit).type === "submit") {
      await act(async () => { await props(find("FORM")!).onSubmit!(activation); });
    }
    expect(host.start).not.toHaveBeenCalled();
    const grant = find("LABEL", "分享對話並允許操作")!;
    expect(grant).toBeDefined();
    const input = allNodes(grant).find(node => node.tagName === "INPUT")!;
    await act(async () => { props(input).onChange!({ currentTarget: { checked: true } }); });
    expect(host.start).not.toHaveBeenCalled();
    expect(props(find("BUTTON", "儲存設定")!).type).toBe("submit");
    await act(async () => { await props(find("FORM")!).onSubmit!({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }); });
    expect(host.start).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ allowChat: true, allowInput: false, allowCommands: false }));
    expect(find("FORM")).toBeUndefined();
  } finally { await act(async () => { root.unmount(); }); }
});
