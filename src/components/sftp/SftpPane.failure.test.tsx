import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { SftpPane } from "./SftpPane";
import { useFileDrop } from "../../app/fileDrop";
import type { SftpApi, SftpSessionSummary } from "../../app/useSftpSessions";
import { allNodes, installHostDom, props } from "../agents/testFixtures/interactionDom";

vi.mock("../../app/fileDrop", () => ({ useFileDrop: vi.fn(() => ({ dragging: false })) }));
vi.mock("../files/RemoteTextEditorProvider", () => ({ useRemoteTextEditor: () => ({ active: false, open: vi.fn() }) }));
vi.mock("../overlays/useAppDialogs", () => ({ useAppDialogs: () => ({ confirm: vi.fn(), prompt: vi.fn(), dialogs: null }) }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it.each([
  ["selected", true], ["browser-drop", true], ["native-drop", true],
  ["selected", false], ["browser-drop", false], ["native-drop", false],
] as const)("runs the %s upload batch only while its pane stays open (close: %s)", async (route, close) => {
  const host = installHostDom();
  const root = createRoot(host as unknown as Element);
  let finishUpload!: () => void;
  const upload = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { finishUpload = resolve; }))
    .mockResolvedValue(undefined);
  const list = vi.fn().mockResolvedValue({ path: "/uploads", entries: [] });
  const sftp = { list, transfers: {}, uploadStream: upload, uploadPath: upload } as unknown as SftpApi;
  let unmounted = false;
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><SftpPane session={{ sessionId: "batch", currentPath: "/uploads" } as SftpSessionSummary} sftp={sftp} active /></I18nProvider>));
    const files = [{ name: "first.txt", size: 1 }, { name: "second.txt", size: 1 }];
    await act(async () => {
      const calls = vi.mocked(useFileDrop).mock.calls;
      const options = calls[calls.length - 1][0];
      if (route === "native-drop") void options.onPaths(["/local/first.txt", "/local/second.txt"]);
      else if (route === "browser-drop") void options.onFiles!(files as File[]);
      else {
        const input = allNodes(host).find((node) => node.tagName === "INPUT" && props(node).type === "file")!;
        props(input).onChange({ currentTarget: { files } });
      }
    });
    expect(upload).toHaveBeenCalledTimes(1);
    if (close) {
      await act(async () => root.unmount());
      unmounted = true;
    }
    await act(async () => { finishUpload(); });
    expect(upload).toHaveBeenCalledTimes(close ? 1 : 2);
    expect(list).toHaveBeenCalledTimes(close || route === "native-drop" ? 1 : 3);
  } finally {
    await act(async () => { finishUpload?.(); if (!unmounted) root.unmount(); });
  }
});

it("disables both drop routes while a selected upload is writing and restores them afterwards", async () => {
  const host = installHostDom();
  const root = createRoot(host as unknown as Element);
  let finishUpload!: () => void;
  const uploadStream = vi.fn(() => new Promise<void>(resolve => { finishUpload = resolve; }));
  const sftp = { list: vi.fn().mockResolvedValue({ path: "/uploads", entries: [] }), transfers: {}, uploadStream } as unknown as SftpApi;
  const dropDisabled = () => {
    const calls = vi.mocked(useFileDrop).mock.calls;
    return calls[calls.length - 1][0].disabled;
  };
  let uploading: Promise<void> | undefined;
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><SftpPane session={{ sessionId: "upload-session", currentPath: "/uploads" } as SftpSessionSummary} sftp={sftp} active /></I18nProvider>));
    expect(dropDisabled()).toBe(false);
    const input = allNodes(host).find(node => node.tagName === "INPUT" && props(node).type === "file")!;
    await act(async () => {
      uploading = props(input).onChange({ currentTarget: { files: [{ name: "report.txt", size: 1 }] } });
    });
    expect(uploadStream).toHaveBeenCalledTimes(1);
    expect(dropDisabled()).toBe(true);
    await act(async () => { finishUpload(); await uploading; });
    expect(dropDisabled()).toBe(false);
  } finally {
    await act(async () => { finishUpload?.(); await uploading; root.unmount(); });
  }
});

it("keeps failed listing unknown, disables writes and supports refresh and parent recovery", async () => {
  const host = installHostDom();
  const root = createRoot(host as unknown as Element);
  const list = vi.fn().mockResolvedValueOnce({ path: "/known-empty", entries: [] })
    .mockRejectedValueOnce(new Error("Synthetic listing unavailable"))
    .mockRejectedValueOnce(new Error("Synthetic retry unavailable"))
    .mockResolvedValueOnce({ path: "/unread", entries: [] });
  const sftp = { list, transfers: {} } as unknown as SftpApi;
  const session = { sessionId: "synthetic", currentPath: "/known-empty" } as SftpSessionSummary;
  const button = (text: string) => allNodes(host).find(node => node.tagName === "BUTTON" && node.textContent.includes(text))!;
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><SftpPane session={session} sftp={sftp} /></I18nProvider>));
    expect(host.textContent).toContain("這個資料夾目前是空的");
    const input = allNodes(host).find(node => node.tagName === "INPUT")!;
    await act(async () => props(input).onChange({ currentTarget: { value: "/unread/destination" } }));
    await act(async () => props(allNodes(host).find(node => node.tagName === "FORM")!).onSubmit({ preventDefault() {} }));
    expect(list).toHaveBeenLastCalledWith("synthetic", "/unread/destination");
    expect(host.textContent).toContain("Synthetic listing unavailable");
    expect(host.textContent).not.toContain("這個資料夾目前是空的");
    expect(props(button("上傳")).disabled).toBe(true);
    expect(props(button("新增資料夾")).disabled).toBe(true);
    await act(async () => props(button("重新整理")).onClick());
    expect(list).toHaveBeenLastCalledWith("synthetic", "/unread/destination");
    expect(host.textContent).toContain("Synthetic retry unavailable");
    await act(async () => props(button("上一層")).onClick());
    expect(list).toHaveBeenLastCalledWith("synthetic", "/unread");
    expect(host.textContent).toContain("這個資料夾目前是空的");
    expect(props(button("上傳")).disabled).toBe(false);
  } finally { await act(async () => root.unmount()); }
});

it("coalesces repeated opens and ignores old session results after reconnect", async () => {
  const host = installHostDom();
  const root = createRoot(host as unknown as Element);
  let finishFirst!: (value: unknown) => void;
  const list = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }))
    .mockResolvedValue({ path: "/second", entries: [] });
  const sftp = { list, transfers: {} } as unknown as SftpApi;
  const render = (sessionId: string, currentPath: string) => root.render(<I18nProvider locale="zh-TW">
    <SftpPane session={{ sessionId, currentPath } as SftpSessionSummary} sftp={sftp} /></I18nProvider>);
  try {
    await act(async () => render("first", "/first"));
    const form = allNodes(host).find(node => node.tagName === "FORM")!;
    await act(async () => { props(form).onSubmit({ preventDefault() {} }); props(form).onSubmit({ preventDefault() {} }); });
    expect(list).toHaveBeenCalledTimes(1);
    await act(async () => render("second", "/second"));
    expect(allNodes(host).find(node => node.tagName === "INPUT")!.value).toBe("/second");
    await act(async () => finishFirst({ path: "/first", entries: [] }));
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith("second", "/second");
    expect(allNodes(host).find(node => node.tagName === "INPUT")!.value).toBe("/second");
  } finally { await act(async () => root.unmount()); }
});
