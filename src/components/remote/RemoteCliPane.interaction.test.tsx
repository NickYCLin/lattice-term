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
  setAttributeNS(_namespace: string, name: string, value: string) { this.setAttribute(name, value); }
  removeAttribute(name: string) { delete this.attributes[name]; }
  addEventListener() {}
  removeEventListener() {}
  focus() {}
}

function allNodes(node: HostNode): HostNode[] {
  return [node, ...node.childNodes.flatMap(allNodes)];
}


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
    await click("Existing CLI");
    for (let attempt = 0; attempt < 10 && !container.textContent.includes("已連接原本的 CLI"); attempt++) { await act(async () => { await vi.advanceTimersByTimeAsync(10); }); }
    expect(container.textContent).toContain("已連接原本的 CLI");
    expect(rendered.text).toBe("abc");
    await act(async () => { await rendered.remote!.terminalInput("opaque", "中文\r"); await vi.advanceTimersByTimeAsync(35); });
    expect(operations.filter(op => op.kind === "cliInput")).toEqual([{ kind: "cliInput", sessionId: "opaque", data: "中文\r" }]);
    await act(async () => { await rendered.remote!.terminalInput("opaque", "cancel pending"); });
    await render(false);
    const hiddenCount = operations.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(operations).toHaveLength(hiddenCount);
    expect(operations.filter(op => op.kind === "cliInput")).toHaveLength(1);
    await render(true);
    for (let attempt = 0; attempt < 10 && !container.textContent.includes("已連接原本的 CLI"); attempt++) { await act(async () => { await vi.advanceTimersByTimeAsync(10); }); }
    expect(container.textContent).toContain("已連接原本的 CLI");
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
