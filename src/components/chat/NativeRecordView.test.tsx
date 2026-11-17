import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { NativeHistoryReader, NativeRecordView } from "./NativeRecordView";
import type { NativeRecord, NativeRecordPage } from "../../app/nativeRecords";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../../app/nativeRuntime", () => ({ hasDesktopBackend: () => true }));
vi.mock("../overlays/modalFocus", () => ({ useModalFocus: () => {} }));
const record = (
  kind: NativeRecord["kind"],
  extra: Partial<NativeRecord> = {},
): NativeRecord => ({
  id: "fake",
  turnId: "turn",
  kind,
  text: "public",
  isError: false,
  unreadable: false,
  ...extra,
});
const page = (id: string, before: number | null): NativeRecordPage => ({
  turns: [{ id: "turn", items: [record("assistant", { id, text: id })] }],
  previousCursor:
    before === null
      ? null
      : { before, length: 100, modified: "1000000000000000000" },
  truncated: before !== null,
  warnings: [],
});
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
  constructor(
    readonly tagName: string,
    document: Record<string, unknown>,
  ) {
    this.ownerDocument = document;
  }
  get nodeName() {
    return this.tagName;
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get textContent(): string {
    return (
      this.text + this.childNodes.map((child) => child.textContent).join("")
    );
  }
  set textContent(value: string) {
    this.text = value;
    this.childNodes = [];
  }
  appendChild(child: HostNode) {
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }
  removeChild(child: HostNode) {
    this.childNodes = this.childNodes.filter((node) => node !== child);
    child.parentNode = null;
    return child;
  }
  insertBefore(child: HostNode, before: HostNode) {
    this.childNodes.splice(this.childNodes.indexOf(before), 0, child);
    child.parentNode = this;
    return child;
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  setAttributeNS(_namespace: string, name: string, value: string) {
    this.setAttribute(name, value);
  }
  removeAttribute(name: string) {
    delete this.attributes[name];
  }
  addEventListener() {}
  removeEventListener() {}
  focus() {}
}

function allNodes(node: HostNode): HostNode[] {
  return [node, ...node.childNodes.flatMap(allNodes)];
}

function onClick(node: HostNode): () => void {
  const key = Object.keys(node).find((name) =>
    name.startsWith("__reactProps$"),
  )!;
  return (node as unknown as Record<string, { onClick: () => void }>)[key]
    .onClick;
}

function installHostDom() {
  const document: Record<string, unknown> = {
    nodeType: 9,
    activeElement: null,
    addEventListener() {},
    removeEventListener() {},
  };
  document.createElement = (name: string) =>
    new HostNode(name.toUpperCase(), document);
  document.createElementNS = (_namespace: string, name: string) =>
    new HostNode(name.toUpperCase(), document);
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
    document,
    HTMLIFrameElement: class {},
    addEventListener() {},
    removeEventListener() {},
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
  };
  document.defaultView = window;
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("HTMLElement", HostNode);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return container;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  invoke.mockReset();
});

it("keeps public reasoning collapsed, encrypted reasoning unreadable and diffs visible", () => {
  const render = (item: NativeRecord) =>
    renderToStaticMarkup(
      <I18nProvider locale="zh-TW">
        <NativeRecordView item={item} threadId="owner" directory="/synthetic" />
      </I18nProvider>,
    );
  const reasoning = render(record("reasoning"));
  expect(reasoning).toContain("推理摘要");
  expect(reasoning).not.toContain(" open=");
  expect(
    render(record("reasoning", { unreadable: true, text: "MUST_NOT_RENDER" })),
  ).not.toContain("MUST_NOT_RENDER");
  const diff = render(
    record("fileChange", {
      name: "fake.txt",
      text: "--- a/fake.txt\n+++ b/fake.txt\n+after",
    }),
  );
  expect(diff).toContain("after");
  expect(diff).toContain("chat-diff__line");
  const sub = render(record("subagent", { name: "child" }));
  expect(sub).toContain("child");
  expect(invoke).not.toHaveBeenCalled();
});
it("loads earlier pages in order and stops at the beginning without touching native files", async () => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  invoke
    .mockResolvedValueOnce(page("latest", 1))
    .mockResolvedValueOnce(page("earlier", null));
  try {
    await act(async () =>
      root.render(
        <I18nProvider locale="zh-TW">
          <NativeHistoryReader threadId="owner" directory="/synthetic" />
        </I18nProvider>,
      ),
    );
    expect(container.textContent).toContain("latest");
    const earlier = allNodes(container).find(
      (node) => node.tagName === "BUTTON" && node.textContent.includes("更早"),
    )!;
    await act(async () => onClick(earlier)());
    expect(container.textContent).toContain("earlier");
    expect(container.textContent).not.toContain("latest");
    expect(invoke).toHaveBeenLastCalledWith(
      "native_conversation_page",
      expect.objectContaining({
        threadId: "owner",
        cursor: { before: 1, length: 100, modified: "1000000000000000000" },
      }),
    );
    expect(earlier.attributes.disabled).toBeDefined();
  } finally {
    await act(async () => root.unmount());
  }
});
it("ignores a page that finishes after the conversation changes", async () => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  let finish!: (value: NativeRecordPage) => void;
  invoke
    .mockImplementationOnce(
      () =>
        new Promise<NativeRecordPage>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(page("new conversation", null));
  try {
    await act(async () =>
      root.render(
        <I18nProvider locale="zh-TW">
          <NativeHistoryReader threadId="old" directory="/synthetic" />
        </I18nProvider>,
      ),
    );
    await act(async () =>
      root.render(
        <I18nProvider locale="zh-TW">
          <NativeHistoryReader threadId="new" directory="/synthetic" />
        </I18nProvider>,
      ),
    );
    await act(async () => finish(page("stale private answer", null)));
    expect(container.textContent).not.toContain("stale private");
    expect(container.textContent).toContain("new conversation");
  } finally {
    await act(async () => root.unmount());
  }
});
it("opens image pixels through the exact native item and revalidates in the lightbox", async () => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  invoke.mockResolvedValue("data:image/png;base64,fixture");
  try {
    await act(async () =>
      root.render(
        <I18nProvider locale="zh-TW">
          <NativeRecordView
            item={record("image", { id: "record-1:0" })}
            threadId="owner"
            directory="/synthetic"
          />
        </I18nProvider>,
      ),
    );
    expect(
      allNodes(container).find((node) => node.tagName === "IMG")?.attributes
        .src,
    ).toContain("data:image/png");
    expect(invoke).toHaveBeenCalledWith("native_conversation_image", {
      threadId: "owner",
      workingDirectory: "/synthetic",
      conversation: null,
      agentId: null,
      imageId: "record-1:0",
    });
    invoke.mockRejectedValue("chat.images.missing");
    await act(async () =>
      onClick(allNodes(container).find((node) => node.tagName === "BUTTON")!)(),
    );
    expect(container.textContent).toContain("圖片檔案已移動或刪除");
  } finally {
    await act(async () => root.unmount());
  }
});

it("recycles off-screen pages and keeps a route back to the latest snapshot", async () => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  let sequence = 0;
  invoke.mockImplementation(() =>
    Promise.resolve(page(`page-${sequence++}`, sequence)),
  );
  try {
    await act(async () =>
      root.render(
        <I18nProvider locale="zh-TW">
          <NativeHistoryReader threadId="owner" directory="/synthetic" />
        </I18nProvider>,
      ),
    );
    for (let index = 0; index < 7; index++) {
      await act(async () =>
        onClick(
          allNodes(container).find(
            (node) =>
              node.tagName === "BUTTON" && node.textContent.includes("更早"),
          )!,
        )(),
      );
    }
    expect(container.textContent).not.toContain("page-0");
    expect(container.textContent).not.toContain("page-1");
    expect(container.textContent).not.toContain("page-2");
    expect(container.textContent).toContain("page-7");
    expect(container.textContent).toContain("目前僅保留顯示中的一頁");
    await act(async () =>
      onClick(
        allNodes(container).find(
          (node) =>
            node.tagName === "BUTTON" && node.textContent.includes("最近紀錄"),
        )!,
      )(),
    );
    expect(container.textContent).not.toContain("page-7");
    expect(container.textContent).toContain("page-8");
  } finally {
    await act(async () => root.unmount());
  }
});

it("walks to the beginning and back through recycled pages using bidirectional cursors", async () => {
  const container=installHostDom();const root=createRoot(container as unknown as Element);
  invoke.mockImplementation((_command,args) => {
    const index=args.cursor?.after ?? args.cursor?.before ?? 9;
    return Promise.resolve({...page(`bounded-${index}`,index>0?index-1:null),
      nextCursor:index<9?{before:999,after:index+1,length:100,modified:"1000000000000000000"}:null});
  });
  const click=async(text:string)=>act(async()=>onClick(allNodes(container).find(node=>node.tagName==="BUTTON"&&node.textContent===text)!)());
  try {
    await act(async()=>root.render(<I18nProvider locale="zh-TW"><NativeHistoryReader threadId="owner" directory="/synthetic" /></I18nProvider>));
    for(let i=8;i>=0;i--){await click("載入更早內容");expect(container.textContent).toContain(`bounded-${i}`);expect(container.textContent).not.toContain(`bounded-${i+1}`);}
    expect(allNodes(container).find(node=>node.tagName==="BUTTON"&&node.textContent==="載入更早內容")!.attributes.disabled).toBeDefined();
    for(let i=1;i<=9;i++){await click("較新的紀錄");expect(container.textContent).toContain(`bounded-${i}`);expect(container.textContent).not.toContain(`bounded-${i-1}`);}
    expect(allNodes(container).find(node=>node.tagName==="BUTTON"&&node.textContent==="較新的紀錄")!.attributes.disabled).toBeDefined();
  } finally {await act(async()=>root.unmount());}
});
it("marks a clipped record while retaining its readable prefix",()=>{
  const html=renderToStaticMarkup(<I18nProvider locale="zh-TW"><NativeRecordView item={record("assistant",{text:"Synthetic readable prefix",truncated:true})} threadId="owner" directory="/synthetic" /></I18nProvider>);
  expect(html).toContain("Synthetic readable prefix");expect(html).toContain("此則內容過長，已截斷顯示");
});
