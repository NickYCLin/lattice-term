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
