import { act, StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { RemoteCliPane } from "./RemoteCliPane";
import type { RemoteApi, RemoteSessionSummary } from "../../app/useRemoteSessions";
import type { RemoteCliOperation } from "../../app/remoteCli";
const { invoke, rendered } = vi.hoisted(() => ({ invoke: vi.fn(), rendered: { text: "", remote: null as RemoteApi | null } }));
vi.mock("./RemoteTerminalView", () => ({ RemoteTerminalView: ({ session, remote }: { session: RemoteSessionSummary; remote: RemoteApi }) => {
  rendered.remote = remote;
  useEffect(() => remote.onTerminalData(session.sessionId, bytes => { rendered.text += new TextDecoder().decode(bytes); }), [session.sessionId]);
  return <div>Test terminal</div>;
} }));
const IMAGE = "A".repeat(16 * 1024) + "QUJD";
vi.mock("./remoteImage", () => ({ readRemoteImage: async () => ({ key: "image", preview: "", data: IMAGE, bytes: IMAGE.length / 4 * 3 }) }));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.clearAllMocks(); });
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
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  getAttributeNames() { return Object.keys(this.attributes); }
  setAttributeNS(_namespace: string, name: string, value: string) { this.setAttribute(name, value); }
  removeAttribute(name: string) { delete this.attributes[name]; }
  addEventListener() {}
  removeEventListener() {}
  focus() {}
}

function allNodes(node: HostNode): HostNode[] {
  return [node, ...node.childNodes.flatMap(allNodes)];
}

it("finds working sessions first in a large list and combines status with project search", async () => {
  vi.useFakeTimers();
  await import("@tauri-apps/api/core");
  const document: Record<string, unknown> = { nodeType:9, activeElement:null, addEventListener() {}, removeEventListener() {} };
  document.createElement = (name:string) => new HostNode(name.toUpperCase(), document);
  document.createElementNS = (_namespace:string, name:string) => new HostNode(name.toUpperCase(), document);
  document.createTextNode = (text:string) => { const node = new HostNode("#text", document); node.nodeType=3; node.textContent=text; return node; };
  const container = new HostNode("DIV", document);
  document.body=container; document.documentElement=container;
  const window = { __TAURI_INTERNALS__:{ invoke }, document, HTMLIFrameElement:class {}, localStorage:{ getItem:() => null }, setInterval, clearInterval };
  document.defaultView=window;
  vi.stubGlobal("window", window); vi.stubGlobal("document", document);
  vi.stubGlobal("HTMLElement", HostNode); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const items = Array.from({length:30}, (_, index) => ({ id:`idle-${index}`, label:"Codex", groupLabel:`Idle ${index}`, agent:"codex", state:"idle", detached:false }));
  items.push({ id:"active", label:"Codex", groupLabel:"Portal", agent:"codex", state:"working", detached:false });
  invoke.mockImplementation(async (_command, { request }) => ({ id:request.id, value:items.map(item => ({...item})), error:null }));
  const root = createRoot(container as unknown as Element);
  const reactProps = (node:HostNode) => (node as unknown as Record<string, {onClick:()=>void; onChange:(event:unknown)=>void}>)[Object.keys(node).find(key => key.startsWith("__reactProps$"))!];
  const cards = () => allNodes(container).filter(node => node.attributes.class?.split(" ").includes("remote-cli-card"));
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><RemoteCliPane session={{sessionId:"connection",cli:true} as RemoteSessionSummary} theme="dark" /></I18nProvider>));
    for (let attempt=0; attempt<10 && cards().length===0; attempt++) await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(cards().length).toBe(31);
    expect(cards()[0].textContent).toContain("Portal");
    const working = allNodes(container).find(node => node.attributes["aria-pressed"] !== undefined && node.textContent.startsWith("執行中"))!;
    await act(async () => reactProps(working).onClick());
    expect(cards().length).toBe(1);
    const search = allNodes(container).find(node => node.tagName==="INPUT")!;
    await act(async () => reactProps(search).onChange({currentTarget:{value:"missing"}}));
    expect(cards().length).toBe(0);
    expect(container.textContent).toContain("沒有符合的工作階段");
    await act(async () => reactProps(search).onChange({currentTarget:{value:"portal"}}));
    expect(cards().length).toBe(1);
    items[30].state="done";
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(cards().length).toBe(0);
    expect(invoke.mock.calls.every(([, args]) => args.request.operation.kind === "cliList")).toBe(true);
  } finally { await act(async () => root.unmount()); }
});


it("lists existing CLIs, replays output and sends ordered input in StrictMode", async () => {
  vi.useFakeTimers();
  await import("@tauri-apps/api/core");
  const document: Record<string, unknown> = { nodeType: 9, activeElement: null, addEventListener() {}, removeEventListener() {} };
  document.createElement = (name: string) => new HostNode(name.toUpperCase(), document);
  document.createElementNS = (_namespace: string, name: string) => new HostNode(name.toUpperCase(), document);
  document.createTextNode = (text: string) => { const node = new HostNode("#text", document); node.nodeType = 3; node.textContent = text; return node; };
  const container = new HostNode("DIV", document);
  document.body = container; document.documentElement = container;
  const window = { __TAURI_INTERNALS__: { invoke }, document, HTMLIFrameElement: class {}, localStorage: { getItem: () => null }, setInterval, clearInterval };
  document.defaultView = window;
  vi.stubGlobal("window", window); vi.stubGlobal("document", document);
  vi.stubGlobal("HTMLElement", HostNode); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  const root = createRoot(container as unknown as Element);
  const operations: RemoteCliOperation[] = [];
  invoke.mockImplementation(async (_command, { request }) => {
    const op: RemoteCliOperation = request.operation; operations.push(op);
    let value: unknown = null;
    if (op.kind === "cliList") value = [{ id: "opaque", label: "Codex", groupLabel: "Existing CLI", agent: "codex", detached: true }];
    if (op.kind === "cliAttach") value = { received: op.offset + op.data.length / 4 * 3, done: op.offset + op.data.length / 4 * 3 === op.total };
    if (op.kind === "cliRead") value = { sessionId: "opaque", cursor: op.cursor, nextCursor: 3, endOffset: 3, base64: op.cursor === 0 ? "YWJj" : "", truncated: false };
    return { id: request.id, value, error: null };
  });
  const click = async (text: string) => {
    const node = allNodes(container).find(node => node.tagName === "BUTTON" && node.textContent.includes(text))!;
    const key = Object.keys(node).find(name => name.startsWith("__reactProps$"))!;
    await act(async () => { (node as unknown as Record<string, { onClick: () => void }>)[key].onClick(); });
  };
  const render = async (active: boolean) => {
    await act(async () => { root.render(<StrictMode><I18nProvider locale="zh-TW"><RemoteCliPane session={{ sessionId: "connection", cli: true } as RemoteSessionSummary} theme="dark" active={active} /></I18nProvider></StrictMode>); });
  };
  try {
    await render(true);
    for (let attempt = 0; attempt < 10 && !container.textContent.includes("Existing CLI"); attempt++) { await act(async () => { await vi.advanceTimersByTimeAsync(10); }); }
    expect(container.textContent).toContain("Existing CLI");
    expect(container.textContent).toContain("背景工作階段");
    expect(container.textContent).toContain("還是舊版");
    await click("Existing CLI");
    for (let attempt = 0; attempt < 10 && !container.textContent.includes("已接上原本的助理"); attempt++) { await act(async () => { await vi.advanceTimersByTimeAsync(10); }); }
    expect(container.textContent).toContain("已接上原本的助理");
    expect(rendered.text).toBe("abc");
    await act(async () => { await rendered.remote!.terminalInput("opaque", "中文\r"); await vi.advanceTimersByTimeAsync(35); });
    expect(operations.filter(op => op.kind === "cliInput")).toEqual([{ kind: "cliInput", sessionId: "opaque", data: "中文\r" }]);
    await act(async () => { await rendered.remote!.terminalInput("opaque", "look at this "); });
    const picker = allNodes(container).find(node => node.tagName === "INPUT")!;
    const pickerProps = Object.keys(picker).find(name => name.startsWith("__reactProps$"))!;
    await act(async () => {
      (picker as unknown as Record<string, { onChange: (event: unknown) => void }>)[pickerProps].onChange({ target: { files: [{}], value: "photo.png" } });
      await vi.advanceTimersByTimeAsync(10);
    });
    const sent = operations.filter(op => op.kind === "cliInput" || op.kind === "cliAttach");
    expect(sent.slice(1).map(op => op.kind === "cliAttach" ? [op.offset, op.data.length, op.total, op.bracketed] : op.data)).toEqual(["look at this ", [0, 16 * 1024, 12291, false], [12288, 4, 12291, false]]);
    expect(new Set(sent.flatMap(op => op.kind === "cliAttach" ? [op.uploadId] : [])).size).toBe(1);
    await act(async () => { await rendered.remote!.terminalInput("opaque", "cancel pending"); });
    await render(false);
    const hiddenCount = operations.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(operations).toHaveLength(hiddenCount);
    expect(operations.filter(op => op.kind === "cliInput")).toHaveLength(2);
    await render(true);
    for (let attempt = 0; attempt < 10 && !container.textContent.includes("已接上原本的助理"); attempt++) { await act(async () => { await vi.advanceTimersByTimeAsync(10); }); }
    expect(container.textContent).toContain("已接上原本的助理");
    await click("返回清單");
    const count = operations.filter(op => op.kind === "cliRead").length;
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(operations.filter(op => op.kind === "cliRead")).toHaveLength(count);
    await render(false);
    const listCount = operations.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(operations).toHaveLength(listCount);
  } finally { await act(async () => { root.unmount(); }); }
});
