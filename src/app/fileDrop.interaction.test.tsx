import { act, StrictMode, useRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useFileDrop } from "./fileDrop";
const { listen } = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ onDragDropEvent: listen }) }));
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
  contains(other: HostNode | null): boolean { return !!other && (other === this || this.contains(other.parentNode)); }
}

it("invalidates late native events after a target unmounts and still binds in StrictMode", async () => {
  const document: Record<string, unknown> = { nodeType: 9, activeElement: null, addEventListener() {}, removeEventListener() {} };
  document.createElement = (name: string) => new HostNode(name.toUpperCase(), document);
  document.createElementNS = (_namespace: string, name: string) => new HostNode(name.toUpperCase(), document);
  document.createTextNode = (text: string) => { const node = new HostNode("#text", document); node.nodeType = 3; node.textContent = text; return node; };
  const container = new HostNode("DIV", document);
  document.body = container; document.documentElement = container;
  const window = { devicePixelRatio: 2, document, HTMLIFrameElement: class {}, localStorage: { getItem: () => null }, setInterval, clearInterval };
  document.defaultView = window;
  vi.stubGlobal("window", window); vi.stubGlobal("document", document);
  vi.stubGlobal("HTMLElement", HostNode); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  const hit = vi.fn(() => container.firstChild);
  document.elementFromPoint = hit;
  const callbacks: ((event: unknown) => void)[] = [];
  const disposers: ReturnType<typeof vi.fn>[] = [];
  listen.mockImplementation(async callback => { callbacks.push(callback); const stop = vi.fn(); disposers.push(stop); return stop; });
  const paths = vi.fn();
  function Probe() {
    const ref = useRef<HTMLDivElement>(null);
    useFileDrop({ ref, onPaths: paths, onError: error => { throw error; } });
    return <div ref={ref}>Drop</div>;
  }
  const root = createRoot(container as unknown as Element);
  const event = { payload: { type: "drop", paths: ["/tmp/test", "/tmp/test"], position: { x: 100, y: 80 } } };
  try {
    await act(async () => { root.render(<StrictMode><Probe /></StrictMode>); });
    const stale = callbacks[callbacks.length - 1];
    expect(stale).toBeTypeOf("function");
    await act(async () => { root.render(null); });
    await act(async () => { root.render(<StrictMode><Probe /></StrictMode>); });
    await act(async () => { stale(event); });
    expect(paths).not.toHaveBeenCalled();
    await act(async () => { callbacks[callbacks.length - 1](event); });
    expect(paths).toHaveBeenCalledExactlyOnceWith(["/tmp/test"]);
    expect(hit).toHaveBeenLastCalledWith(50, 40);
    expect(disposers.some(stop => stop.mock.calls.length)).toBe(true);
  } finally {
    await act(async () => { root.unmount(); });
    vi.unstubAllGlobals(); vi.clearAllMocks();
  }
});
