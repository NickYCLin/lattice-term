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
  querySelector(selector: string) {
    const field = selector.match(/^\[data-field="([^"]+)"\]$/)?.[1];
    return allNodes(this).find(node => node.attributes["data-field"] === field) ?? null;
  }
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

it("allows either host field alone and saves both addresses with their own ports", async () => {
  for (const primaryHost of ["", "lan.example"]) {
    const container = installHostDom();
    const root = createRoot(container as unknown as Element);
    const save = vi.fn();
    try {
      const profile = { ...source, hostname: primaryHost };
      await act(async () => root.render(<I18nProvider locale="zh-TW"><ConnectionDrawer profile={profile} profiles={[profile]}
        supportedProtocols={["ssh"]} mobile={false} onSave={save} onClose={vi.fn()} /></I18nProvider>));
      const field = (name: string) => allNodes(container).find(node => node.attributes["data-field"] === name)!;
      await act(async () => props(field("additional-hostname")).onChange({ currentTarget: { value: "wan.example" } }));
      await act(async () => props(field("additional-port")).onChange({ currentTarget: { value: "2222" } }));
      const form = allNodes(container).find(node => node.tagName === "FORM")!;
      await act(async () => props(form).onSubmit({ preventDefault() {} }));
      expect(save).toHaveBeenCalledTimes(1);
      if (primaryHost) {
        expect(save.mock.calls[0][0]).toMatchObject({ hostname: primaryHost, port: 22 });
        expect(save.mock.calls[0][4]).toMatchObject({ hostname: "wan.example", port: 2222 });
        expect(save.mock.calls[0][4].id).not.toBe(source.id);
      } else {
        expect(save.mock.calls[0][0]).toMatchObject({ hostname: "wan.example", port: 2222 });
        expect(save.mock.calls[0][4]).toBeUndefined();
      }
    } finally { await act(async () => root.unmount()); }
  }
});

it("keeps invalid extra addresses and unsaved changes in the drawer", async () => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  const save = vi.fn();
  const close = vi.fn();
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><ConnectionDrawer profile={source} profiles={[source]}
      supportedProtocols={["ssh"]} mobile={false} onSave={save} onClose={close} /></I18nProvider>));
    const host = allNodes(container).find(node => node.attributes["data-field"] === "additional-hostname")!;
    await act(async () => props(host).onChange({ currentTarget: { value: "https://bad.example" } }));
    const form = allNodes(container).find(node => node.tagName === "FORM")!;
    await act(async () => props(form).onSubmit({ preventDefault() {} }));
    expect(save).not.toHaveBeenCalled();
    expect(props(host)["aria-invalid"]).toBe(true);
    const closeButton = allNodes(container).find(node => node.tagName === "BUTTON" && props(node)["aria-label"] === "關閉")!;
    await act(async () => props(closeButton).onClick());
    expect(close).not.toHaveBeenCalled();
    expect(container.textContent).toContain("放棄修改");
  } finally { await act(async () => root.unmount()); }
});

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
    expect(container.textContent).toContain("SFTP · fixture@fixture.invalid:2223");
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

it("preserves the original protocol until the user chooses whether to add or replace", async () => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  const add = vi.fn();
  const save = vi.fn();
  const original = { ...source, port: 2222 };
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><ConnectionDrawer profile={original} profiles={[original]}
      supportedProtocols={["ssh", "rdp"]} mobile={false} onSave={save} onClose={vi.fn()} onAddRoute={add} /></I18nProvider>));
    const clickText = async (text: string) => {
      const button = allNodes(container).find(node => node.tagName === "BUTTON" && node.textContent === text)!;
      expect(button).toBeDefined();
      await act(async () => props(button).onClick());
    };
    const chooseRdp = async () => {
      const button = allNodes(container).find(node => node.tagName === "BUTTON" && props(node)?.role === "radio" && node.textContent.includes("RDP"))!;
      await act(async () => props(button).onClick());
    };
    await chooseRdp();
    expect(container.textContent).toContain("要另外新增 RDP");
    const form = allNodes(container).find(node => node.tagName === "FORM")!;
    await act(async () => props(form).onSubmit({ preventDefault() {} }));
    expect(save).not.toHaveBeenCalled();
    await clickText("取消");
    expect(allNodes(container).find(node => props(node)?.role === "radio" && props(node)["aria-checked"])!.textContent).toContain("SSH");
    await chooseRdp();
    await clickText("另外新增連線");
    expect(add).toHaveBeenCalledExactlyOnceWith(source.id, "rdp");
    expect(save).not.toHaveBeenCalled();
    await clickText("變更目前連線");
    await act(async () => props(form).onSubmit({ preventDefault() {} }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toMatchObject({ protocol: "rdp", port: 2222 });
    expect(save.mock.calls[0][2]).toBe(source.id);
  } finally { await act(async () => root.unmount()); }
});

it("opens a requested route with its own default port and a fresh record identity", async () => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  const save = vi.fn();
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><ConnectionDrawer profile={null} routeSource={{ ...source, port: 2222 }} routeProtocol="rdp" profiles={[source]}
      supportedProtocols={["ssh", "rdp"]} mobile={false} onSave={save} onClose={vi.fn()} /></I18nProvider>));
    const form = allNodes(container).find(node => node.tagName === "FORM")!;
    await act(async () => props(form).onSubmit({ preventDefault() {} }));
    expect(save.mock.calls[0][0]).toMatchObject({ protocol: "rdp", port: 3389, machineId: source.id });
    expect(save.mock.calls[0][2]).not.toBe(source.id);
  } finally { await act(async () => root.unmount()); }
});
