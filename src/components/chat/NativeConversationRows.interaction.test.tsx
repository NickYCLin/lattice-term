import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { fakeChatApi } from "../../app/testFixtures/agentApis";
import type { LocalConversation } from "../../app/localConversationSessions";
import { NativeHistoryContext, type NativeHistory } from "../../app/useNativeConversations";
import { I18nProvider } from "../../i18n";
import { NativeConversationRows } from "./NativeConversationRows";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../../app/useCliProxyApi", () => ({ useCliProxySettings: () => ({ proxies: [] }) }));

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

afterEach(() => {
  vi.unstubAllGlobals();
  invoke.mockReset();
});

it("shows a Cursor conversation in place without turning it into a thread", async () => {
  const container = installHostDom();
  const entry: LocalConversation = {
    definitionId: "cursor", profileId: null, nativeSessionId: "cursor-1", title: "Cursor 的對話",
    workingDirectory: "D:/work/app", resumable: false, updatedAt: 1,
  };
  const history = {
    entries: [entry], profiles: [], profileKey: "[]", hasMore: false, busy: false, error: null,
  } as unknown as NativeHistory;
  invoke.mockResolvedValue({
    messages: [{ role: "user", text: "幫我看這段" }, { role: "assistant", text: "這段沒問題" }],
    truncated: false,
  });
  const chat = fakeChatApi();
  const opened = vi.fn();
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(
    <NativeHistoryContext.Provider value={history}>
      <I18nProvider locale="zh-TW">
        <NativeConversationRows chat={chat} projectFilter={null} onOpened={opened} />
      </I18nProvider>
    </NativeHistoryContext.Provider>,
  ));
  const button = () => allNodes(container).find(node => node.tagName === "BUTTON")!;
  expect(button().textContent).toContain("Cursor Agent");
  expect(String(button().attributes["aria-expanded"])).toBe("false");

  await act(async () => onClick(button())());
  expect(invoke).toHaveBeenCalledWith("agent_chat_local_history_snapshot", expect.objectContaining({
    definitionId: "cursor", nativeSessionId: "cursor-1",
  }));
  expect(container.textContent).toContain("幫我看這段");
  expect(container.textContent).toContain("這段沒問題");
  expect(String(button().attributes["aria-expanded"])).toBe("true");
  expect(chat.importNativeConversation).not.toHaveBeenCalled();
  expect(opened).not.toHaveBeenCalled();

  await act(async () => onClick(button())());
  expect(container.textContent).not.toContain("幫我看這段");
  expect(String(button().attributes["aria-expanded"])).toBe("false");
  expect(invoke).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
});
