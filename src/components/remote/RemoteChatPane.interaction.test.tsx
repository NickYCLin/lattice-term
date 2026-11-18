import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { allNodes, installHostDom, props } from "../agents/testFixtures/interactionDom";
import { RemoteChatPane } from "./RemoteChatPane";

const { invoke, readImage } = vi.hoisted(() => ({ invoke: vi.fn(), readImage: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./remoteImage", () => ({ readRemoteImage: readImage }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetAllMocks(); });

it("follows new messages only while the reader is near the bottom", async () => {
  vi.useFakeTimers();
  const host = installHostDom();
  const root = createRoot(host as unknown as Element);
  const thread = { id: "thread", title: "Example", agent: "codex", directory: "/work", runningTurnId: null, updatedAt: 1 };
  invoke.mockImplementation(async (_command, { request }) => ({ id: request.id, error: null, value: request.operation.kind === "list" ? [thread] : { thread, items: [], before: null } }));
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><RemoteChatPane sessionId="host" hidden={false} /></I18nProvider>));
    await act(async () => props(allNodes(host).find(node => node.tagName === "BUTTON" && node.textContent.includes("Example"))!).onClick());
    const messagesNode = allNodes(host).find(node => node.attributes.class === "remote-chat-messages")!;
    const messages = messagesNode as unknown as { scrollTop: number; scrollHeight: number; clientHeight: number };
    messages.scrollHeight = 1000; messages.clientHeight = 200; messages.scrollTop = 800;
    await act(async () => props(messagesNode).onScroll({ currentTarget: messages }));
    messages.scrollHeight = 1200;
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    expect(messages.scrollTop).toBe(1200);
    messages.scrollTop = 300;
    await act(async () => props(messagesNode).onScroll({ currentTarget: messages }));
    messages.scrollHeight = 1400;
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    expect(messages.scrollTop).toBe(300);
  } finally { await act(async () => root.unmount()); }
});

it.each(["resolve", "reject"])("stops an image upload when the conversation is hidden (%s) and retains the draft", async outcome => {
  vi.useFakeTimers();
  const host = installHostDom();
  const root = createRoot(host as unknown as Element);
  const thread = { id: "thread", title: "Example", agent: "codex", directory: "/work", runningTurnId: null, updatedAt: 1 };
  let finish!: () => void;
  const operations: string[] = [];
  invoke.mockImplementation(async (_command, { request }) => {
    const operation = request.operation;
    operations.push(operation.kind);
    if (operation.kind === "attach") await new Promise<void>((resolve, reject) => { finish = outcome === "resolve" ? resolve : () => reject(new Error("disconnected")); });
    return { id: request.id, error: null, value: operation.kind === "list" ? [thread] : operation.kind === "read" ? { thread, items: [], before: null } : null };
  });
  readImage.mockResolvedValue({ key: "image", preview: "", data: "A".repeat(20000), bytes: 15000 });
  const render = (hidden: boolean) => root.render(<I18nProvider locale="zh-TW"><RemoteChatPane sessionId="host" hidden={hidden} /></I18nProvider>);
  try {
    await act(async () => render(false));
    await act(async () => props(allNodes(host).find(node => node.tagName === "BUTTON" && node.textContent.includes("Example"))!).onClick());
    await act(async () => props(allNodes(host).find(node => node.tagName === "TEXTAREA")!).onChange({ target: { value: "hello" } }));
    await act(async () => props(allNodes(host).find(node => node.tagName === "INPUT" && props(node).type === "file")!).onChange({ target: { files: [{}], value: "image.png" } }));
    await act(async () => props(allNodes(host).find(node => node.tagName === "FORM")!).onSubmit({ preventDefault() {} }));
    expect(operations.filter(kind => kind === "attach")).toHaveLength(1);
    expect(props(allNodes(host).find(node => node.tagName === "BUTTON" && node.textContent === "返回清單")!).disabled).toBe(true);
    await act(async () => render(true));
    await act(async () => finish());
    await act(async () => render(false));
    expect(operations.filter(kind => kind === "attach")).toHaveLength(1);
    expect(operations).not.toContain("send");
    expect(host.textContent).toContain("圖片訊息尚未送出");
    expect(props(allNodes(host).find(node => node.tagName === "TEXTAREA")!).value).toBe("hello");
    expect(allNodes(host).some(node => node.tagName === "IMG")).toBe(true);
  } finally { await act(async () => root.unmount()); }
});

it("sends uploaded images once and clears the completed draft", async () => {
  vi.useFakeTimers();
  const host = installHostDom();
  const root = createRoot(host as unknown as Element);
  const thread = { id: "thread", title: "Example", agent: "codex", directory: "/work", runningTurnId: null, updatedAt: 1 };
  const operations: Array<{ kind: string; text?: string; attachments?: string[] }> = [];
  invoke.mockImplementation(async (_command, { request }) => {
    operations.push(request.operation);
    return { id: request.id, error: null, value: request.operation.kind === "list" ? [thread] : request.operation.kind === "read" ? { thread, items: [], before: null } : null };
  });
  readImage.mockResolvedValue({ key: "image", preview: "", data: "QUJD", bytes: 3 });
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><RemoteChatPane sessionId="host" hidden={false} /></I18nProvider>));
    await act(async () => props(allNodes(host).find(node => node.tagName === "BUTTON" && node.textContent.includes("Example"))!).onClick());
    await act(async () => props(allNodes(host).find(node => node.tagName === "TEXTAREA")!).onChange({ target: { value: "hello" } }));
    await act(async () => props(allNodes(host).find(node => node.tagName === "INPUT" && props(node).type === "file")!).onChange({ target: { files: [{}], value: "image.png" } }));
    await act(async () => props(allNodes(host).find(node => node.tagName === "FORM")!).onSubmit({ preventDefault() {} }));
    const sends = operations.filter(operation => operation.kind === "send");
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ text: "hello", attachments: [expect.any(String)] });
    expect(props(allNodes(host).find(node => node.tagName === "TEXTAREA")!).value).toBe("");
    expect(allNodes(host).some(node => node.tagName === "IMG")).toBe(false);
  } finally { await act(async () => root.unmount()); }
});

it("routes every chat header action and image picker without stealing pointer focus", async () => {
  vi.useFakeTimers();
  const host = installHostDom(), root = createRoot(host as unknown as Element);
  const original = { id: "header-thread", title: "Header fixture", agent: "codex", directory: "/synthetic", runningTurnId: null, updatedAt: 1 };
  const copy = { ...original, id: "header-copy" };
  const operations: Array<Record<string, any>> = [];
  invoke.mockImplementation(async (_command, { request }) => {
    const op = request.operation; operations.push(op);
    return { id: request.id, error: null, value: op.kind === "list" ? [original] : op.kind === "create" ? copy : { thread: op.threadId === copy.id ? copy : original, items: [], before: null } };
  });
  const buttons = () => allNodes(host).filter(n => n.tagName === "BUTTON");
  const protect = (button: ReturnType<typeof buttons>[number], parent: ReturnType<typeof buttons>[number]) => {
    const preventDefault = vi.fn(); props(parent).onPointerDown({ target: { closest: () => button }, preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
  };
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><RemoteChatPane sessionId="synthetic-host" hidden={false} /></I18nProvider>));
    await act(async () => props(buttons().find(n => n.textContent.includes(original.title))!).onClick());
    const header = () => allNodes(host).find(n => props(n)?.className === "remote-pane-header")!;
    expect(allNodes(header()).filter(n => n.tagName === "BUTTON")).toHaveLength(3);
    const area = allNodes(host).find(n => n.tagName === "TEXTAREA")!;
    Object.assign(document, { activeElement: area });
    await act(async () => props(area).onChange({ target: { value: "unsent fixture draft" } }));
    const refresh = buttons().find(n => props(n)["aria-label"] === "重新整理")!;
    protect(refresh, header()); const reads = operations.filter(op => op.kind === "read").length;
    await act(async () => props(refresh).onClick());
    expect(operations.filter(op => op.kind === "read").length).toBeGreaterThan(reads);
    expect(allNodes(host).find(n => n.tagName === "TEXTAREA")).toBe(area);
    expect(document.activeElement).toBe(area); expect(props(area).value).toBe("unsent fixture draft");
    const image = buttons().find(n => props(n)["aria-label"] === "圖片")!;
    const picker = allNodes(host).find(n => n.tagName === "INPUT" && props(n).type === "file")!;
    const choose = vi.fn(); Object.assign(picker, { click: choose });
    protect(image, allNodes(host).find(n => props(n)?.className === "remote-chat-card__toolbar")!);
    await act(async () => props(image).onClick()); expect(choose).toHaveBeenCalledOnce();
    const create = buttons().find(n => props(n)["aria-label"] === "以相同設定開新對話")!;
    protect(create, header()); await act(async () => props(create).onClick());
    expect(operations).toContainEqual({ kind: "create", templateId: original.id });
    const back = allNodes(header()).find(n => n.tagName === "BUTTON" && n.textContent === "返回清單")!;
    protect(back, header()); await act(async () => props(back).onClick());
    expect(host.textContent).toContain(original.title);
    expect(allNodes(host).some(n => n.tagName === "TEXTAREA")).toBe(false);
    expect(operations.some(op => op.kind === "send" || op.kind === "steer")).toBe(false);
  } finally { await act(async () => root.unmount()); }
});
