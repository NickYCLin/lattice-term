import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { useFileDrop } from "../../app/fileDrop";
import { droppedUpload } from "../../app/localFiles";
import type { RemoteApi, RemoteSessionSummary } from "../../app/useRemoteSessions";
import { allNodes, installHostDom, props } from "../agents/testFixtures/interactionDom";
import { RemoteFilesPane } from "./RemoteFilesPane";

const { confirm, openEditor } = vi.hoisted(() => ({ confirm: vi.fn(), openEditor: vi.fn() }));
vi.mock("../../app/fileDrop", () => ({ useFileDrop: vi.fn(() => ({ dragging: false })) }));
vi.mock("../../app/localFiles", async importOriginal => ({ ...await importOriginal<typeof import("../../app/localFiles")>(), droppedUpload: vi.fn() }));
vi.mock("../files/RemoteTextEditorProvider", () => ({ useRemoteTextEditor: () => ({ active: false, open: openEditor }) }));
vi.mock("../overlays/useAppDialogs", () => ({ useAppDialogs: () => ({ confirm, dialogs: null }) }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

const files = [{ name: "first.txt", size: 1 }, { name: "second.txt", size: 1 }] as File[];
const session = { sessionId: "first", fileRootLabel: "Shared", fileEdit: true } as RemoteSessionSummary;

it.each(["selected", "browser-drop", "native-drop"])("stops the %s batch when its pane closes", async route => {
  const host = installHostDom();
  const root = createRoot(host as unknown as Element);
  let finish!: () => void;
  const uploadFile = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue(undefined);
  const listFiles = vi.fn().mockResolvedValue({ path: "/uploads", entries: [] });
  const remote = { listFiles, uploadFile, transfers: {} } as unknown as RemoteApi;
  vi.mocked(droppedUpload).mockImplementation(async path => ({ name: path.slice(path.lastIndexOf("/") + 1), size: 1, nativePath: path }));
  let unmounted = false;
  try {
    await act(async () => root.render(<I18nProvider locale="en"><RemoteFilesPane session={session} remote={remote} /></I18nProvider>));
    await act(async () => {
      const options = vi.mocked(useFileDrop).mock.lastCall![0];
      if (route === "native-drop") void options.onPaths(["/local/first.txt", "/local/second.txt"]);
      else if (route === "browser-drop") void options.onFiles!(files);
      else props(allNodes(host).find(node => node.tagName === "INPUT" && props(node).type === "file")!).onChange({ currentTarget: { files } });
    });
    expect(uploadFile).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    unmounted = true;
    await act(async () => finish());
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(listFiles).toHaveBeenCalledTimes(1);
    if (route === "native-drop") expect(droppedUpload).toHaveBeenCalledTimes(1);
  } finally { await act(async () => { finish?.(); if (!unmounted) root.unmount(); }); }
});

it("does not refresh the old session when an upload finishes after switching sessions", async () => {
  const host = installHostDom();
  const root = createRoot(host as unknown as Element);
  let finish!: () => void;
  const uploadFile = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const listFiles = vi.fn(async (sessionId: string) => ({ path: "/" + sessionId, entries: [] }));
  const remote = { listFiles, uploadFile, transfers: {} } as unknown as RemoteApi;
  const render = (sessionId: string) => root.render(<I18nProvider locale="en"><RemoteFilesPane session={{ ...session, sessionId }} remote={remote} /></I18nProvider>);
  try {
    await act(async () => render("first"));
    await act(async () => { void vi.mocked(useFileDrop).mock.lastCall![0].onFiles!([files[0]]); });
    await act(async () => render("second"));
    await act(async () => finish());
    expect(listFiles.mock.calls.map(call => call[0])).toEqual(["first", "second"]);
    expect(allNodes(host).find(node => node.tagName === "INPUT" && props(node).type !== "file")!.value).toBe("/second");
  } finally { await act(async () => { finish?.(); root.unmount(); }); }
});

it("does not upload native files whose metadata arrives after closing", async () => {
  const host = installHostDom();
  const root = createRoot(host as unknown as Element);
  let resolveFile!: (file: { name: string; size: number; nativePath: string }) => void;
  vi.mocked(droppedUpload).mockImplementation(() => new Promise(resolve => { resolveFile = resolve; }));
  const uploadFile = vi.fn();
  const remote = { listFiles: vi.fn().mockResolvedValue({ path: "/uploads", entries: [] }), uploadFile, transfers: {} } as unknown as RemoteApi;
  let unmounted = false;
  try {
    await act(async () => root.render(<I18nProvider locale="en"><RemoteFilesPane session={session} remote={remote} /></I18nProvider>));
    await act(async () => { void vi.mocked(useFileDrop).mock.lastCall![0].onPaths(["/local/first.txt"]); });
    await act(async () => root.unmount());
    unmounted = true;
    await act(async () => resolveFile({ name: "first.txt", size: 1, nativePath: "/local/first.txt" }));
    expect(uploadFile).not.toHaveBeenCalled();
  } finally { await act(async () => { if (!unmounted) root.unmount(); }); }
});

it("keeps the new session batch locked when an old upload fails", async () => {
  const host = installHostDom();
  const root = createRoot(host as unknown as Element);
  let rejectOld!: (reason: Error) => void;
  let finishNew!: () => void;
  const uploadFile = vi.fn()
    .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectOld = reject; }))
    .mockImplementationOnce(() => new Promise<void>(resolve => { finishNew = resolve; }));
  const remote = { listFiles: vi.fn(async (sessionId: string) => ({ path: "/" + sessionId, entries: [] })), uploadFile, transfers: {} } as unknown as RemoteApi;
  const render = (sessionId: string) => root.render(<I18nProvider locale="en"><RemoteFilesPane session={{ ...session, sessionId }} remote={remote} /></I18nProvider>);
  try {
    await act(async () => render("first"));
    await act(async () => { void vi.mocked(useFileDrop).mock.lastCall![0].onFiles!([files[0]]); });
    await act(async () => render("second"));
    await act(async () => { void vi.mocked(useFileDrop).mock.lastCall![0].onFiles!([files[1]]); });
    expect(uploadFile.mock.calls.map(call => call[0])).toEqual(["first", "second"]);
    await act(async () => rejectOld(new Error("old upload failed")));
    expect(vi.mocked(useFileDrop).mock.lastCall![0].disabled).toBe(true);
    expect(host.textContent).not.toContain("old upload failed");
    await act(async () => { void vi.mocked(useFileDrop).mock.lastCall![0].onFiles!([files[0]]); });
    expect(uploadFile).toHaveBeenCalledTimes(2);
    await act(async () => finishNew());
    expect(vi.mocked(useFileDrop).mock.lastCall![0].disabled).toBe(false);
  } finally { await act(async () => { finishNew?.(); root.unmount(); }); }
});

it("ignores overwrite approval after its pane closes", async () => {
  const host = installHostDom();
  const root = createRoot(host as unknown as Element);
  let approve!: (value: boolean) => void;
  confirm.mockImplementation(() => new Promise(resolve => { approve = resolve; }));
  const uploadFile = vi.fn();
  const remote = { listFiles: vi.fn().mockResolvedValue({ path: "/uploads", entries: [{ name: "first.txt", path: "/uploads/first.txt", kind: "file", size: 1, modifiedAt: null }] }), uploadFile, transfers: {} } as unknown as RemoteApi;
  let unmounted = false;
  try {
    await act(async () => root.render(<I18nProvider locale="en"><RemoteFilesPane session={session} remote={remote} /></I18nProvider>));
    await act(async () => { void vi.mocked(useFileDrop).mock.lastCall![0].onFiles!([files[0]]); });
    expect(confirm).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    unmounted = true;
    await act(async () => approve(true));
    expect(uploadFile).not.toHaveBeenCalled();
  } finally { await act(async () => { approve?.(false); if (!unmounted) root.unmount(); }); }
});

it("locks the batch while asking for overwrite and still uploads each selected file", async () => {
  const host = installHostDom();
  const root = createRoot(host as unknown as Element);
  let approve!: (value: boolean) => void;
  confirm.mockImplementation(() => new Promise(resolve => { approve = resolve; }));
  const uploadFile = vi.fn().mockResolvedValue(undefined);
  const remote = { listFiles: vi.fn().mockResolvedValue({ path: "/uploads", entries: [{ name: "first.txt", path: "/uploads/first.txt", kind: "file", size: 1, modifiedAt: null }] }), uploadFile, transfers: {} } as unknown as RemoteApi;
  try {
    await act(async () => root.render(<I18nProvider locale="en"><RemoteFilesPane session={session} remote={remote} /></I18nProvider>));
    const input = allNodes(host).find(node => node.tagName === "INPUT" && props(node).type === "file")!;
    await act(async () => props(input).onChange({ currentTarget: { files } }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(vi.mocked(useFileDrop).mock.lastCall![0].disabled).toBe(true);
    await act(async () => props(input).onChange({ currentTarget: { files: [files[1]] } }));
    expect(uploadFile).not.toHaveBeenCalled();
    await act(async () => approve(true));
    expect(uploadFile.mock.calls.map(call => call[2].name)).toEqual(["first.txt", "second.txt"]);
    expect(vi.mocked(useFileDrop).mock.lastCall![0].disabled).toBe(false);
  } finally { await act(async () => { approve?.(false); root.unmount(); }); }
});
