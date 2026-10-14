import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { ConnectionDrawer } from "./ConnectionDrawer";
import { createConnectionProfile, emptyDraft, type ConnectionDraft } from "../../domain/connection";

vi.mock("./modalFocus", () => ({ useModalFocus: () => {} }));
vi.mock("../../app/useConnectionCredentialDraft", () => ({ useConnectionCredentialDraft: () => ({
  native: false, dirty: false, loading: false, secret: "", saved: false, allowMcpRead: false,
  setSecret() {}, setAllowMcpRead() {}, reveal() {},
}) }));

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



function props(node: HostNode): Record<string, any> {
  const key = Object.keys(node).find(name => name.startsWith("__reactProps$"))!;
  return (node as unknown as Record<string, Record<string, any>>)[key];
}
const source = createConnectionProfile({ ...emptyDraft(), name: "合成主機", hostname: "fixture.invalid", username: "fixture" }, "source");
const route = { ...source, id: "route", protocol: "sftp" as const, machineId: "source", port: 2223 };
const linkedSource = { ...source, machineId: "source" };
afterEach(() => vi.unstubAllGlobals());

it("creates a separate route, prevents repeat submissions, and leaves a failed save open for retry", async () => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  let rejectSave!: (reason: Error) => void;
  const save = vi.fn((_draft: ConnectionDraft, _connect: boolean, _id: string) => new Promise<void>((_resolve, reject) => { rejectSave = reject; }));
  const close = vi.fn();
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><ConnectionDrawer profile={null} routeSource={source} profiles={[source]}
      supportedProtocols={["ssh", "sftp", "rdp", "vnc", "lattice"]} mobile={false} onSave={save} onClose={close} /></I18nProvider>));
    expect(container.textContent).toContain("同主機連線方式");
    const form = allNodes(container).find(node => node.tagName === "FORM")!;
    await act(async () => {
      props(form).onSubmit({ preventDefault() {} });
      props(form).onSubmit({ preventDefault() {} });
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toMatchObject({ protocol: "sftp", hostname: source.hostname, machineId: source.id });
    expect(save.mock.calls[0][2]).not.toBe(source.id);
    await act(async () => rejectSave(new Error("合成儲存失敗")));
    expect(container.textContent).toContain("合成儲存失敗");
    expect(close).not.toHaveBeenCalled();
    await act(async () => props(form).onSubmit({ preventDefault() {} }));
    expect(save).toHaveBeenCalledTimes(2);
    await act(async () => rejectSave(new Error("合成重試失敗")));
  } finally { await act(async () => root.unmount()); }
});

it("keeps edits when backing out of route navigation and discards only after confirmation", async () => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  const open = vi.fn();
  const add = vi.fn();
  const close = vi.fn();
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><ConnectionDrawer profile={linkedSource} profiles={[linkedSource, route]}
      supportedProtocols={["ssh", "sftp"]} mobile={false} onSave={vi.fn()} onClose={close} onOpenRoute={open} onAddRoute={add} /></I18nProvider>));
    const name = allNodes(container).find(node => node.attributes["data-field"] === "name")!;
    await act(async () => props(name).onChange({ currentTarget: { value: "未儲存名稱" } }));
    const clickText = async (text: string) => {
      const button = allNodes(container).find(node => node.tagName === "BUTTON" && node.textContent.includes(text))!;
      expect(button).toBeDefined();
      await act(async () => props(button).onClick());
    };
    await clickText("SFTP ·");
    expect(open).not.toHaveBeenCalled();
    await clickText("繼續編輯");
    expect(props(name).value).toBe("未儲存名稱");
    await clickText("新增連線方式");
    await clickText("放棄修改");
    expect(add).toHaveBeenCalledExactlyOnceWith(source.id);
    expect(open).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});

