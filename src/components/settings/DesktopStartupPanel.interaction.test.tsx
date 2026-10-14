import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { DesktopStartupPanel } from "./DesktopStartupPanel";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

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
  setAttribute(name: string, value: string) { this.attributes[name] = String(value); }
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

let mountedRoot: Root | undefined;
function props(node: HostNode) {
  const key = Object.keys(node).find(name => name.startsWith("__reactProps$"))!;
  return (node as unknown as Record<string, { disabled: boolean; onClick: () => void }>)[key];
}
function controls(container: HostNode) { return allNodes(container).filter(node => node.attributes.role === "radio"); }
async function mount(available = true) {
  const container = installHostDom();
  mountedRoot = createRoot(container as unknown as HTMLElement);
  const render = (next: boolean) => mountedRoot!.render(<I18nProvider locale="zh-TW"><DesktopStartupPanel available={next} /></I18nProvider>);
  await act(async () => { render(available); });
  return { container, render };
}
afterEach(async () => {
  await act(async () => { mountedRoot?.unmount(); });
  mountedRoot = undefined; vi.unstubAllGlobals(); invoke.mockReset();
});

it("reads the system state and confirms changes without writing to the background service", async () => {
  let enabled = true;
  let release!: () => void;
  invoke.mockImplementation(async (command, args) => {
    if (command === "desktop_autostart_enabled") return enabled;
    if (command === "desktop_set_autostart") {
      await new Promise<void>(resolve => { release = resolve; }); enabled = args.enabled; return;
    }
    throw new Error(command);
  });
  const { container } = await mount();
  const panel = allNodes(container).find(node => node.tagName === "SECTION")!;
  expect(panel.attributes.class).toBe("panel glass glass--sheen");
  expect(allNodes(panel).find(node => node.tagName === "HEADER")?.attributes.class).toBe("panel__head");
  expect(allNodes(panel).find(node => node.tagName === "H2")?.attributes.class).toBe("panel__title");
  expect(controls(container)[0].attributes["aria-checked"]).toBe("true");
  await act(async () => { onClick(controls(container)[1])(); onClick(controls(container)[1])(); });
  expect(controls(container).every(node => props(node).disabled)).toBe(true);
  expect(invoke.mock.calls.filter(([command]) => command === "desktop_set_autostart")).toHaveLength(1);
  await act(async () => { release(); });
  expect(controls(container)[1].attributes["aria-checked"]).toBe("true");
  expect(invoke.mock.calls.every(([command]) => command.startsWith("desktop_"))).toBe(true);
});

it("keeps an unreadable setting unknown and lets the user retry reading", async () => {
  invoke.mockRejectedValueOnce(new Error("registry unavailable")).mockResolvedValue(false);
  const { container } = await mount();
  expect(container.textContent).toContain("registry unavailable");
  expect(controls(container).every(node => props(node).disabled && node.attributes["aria-checked"] === "false")).toBe(true);
  const retry = allNodes(container).find(node => node.tagName === "BUTTON" && node.textContent === "重試")!;
  await act(async () => { onClick(retry)(); });
  expect(controls(container)[1].attributes["aria-checked"]).toBe("true");
  expect(invoke.mock.calls.every(([command]) => command === "desktop_autostart_enabled")).toBe(true);
});

it("keeps the confirmed state when a write is refused", async () => {
  invoke.mockImplementation(async command => {
    if (command === "desktop_autostart_enabled") return false;
    throw new Error("entry changed by another program");
  });
  const { container } = await mount();
  await act(async () => { onClick(controls(container)[0])(); });
  expect(controls(container)[1].attributes["aria-checked"]).toBe("true");
  expect(container.textContent).toContain("entry changed by another program");
});

it("ignores a late reply after the desktop backend becomes unavailable", async () => {
  let release!: (value: boolean) => void;
  invoke.mockImplementation(() => new Promise<boolean>(resolve => { release = resolve; }));
  const { container, render } = await mount();
  await act(async () => { render(false); release(true); });
  expect(controls(container).every(node => props(node).disabled && node.attributes["aria-checked"] === "false")).toBe(true);
  expect(invoke).toHaveBeenCalledTimes(1);
});
