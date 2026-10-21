import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { RemoteApi, RemoteFileTransfer, RemoteSessionSummary } from "../../app/useRemoteSessions";
import { allNodes, installHostDom, props } from "./testFixtures/interactionDom";
import { AgentRemoteDelivery } from "./AgentRemoteDelivery";

vi.mock("../files/FileDropZone", () => ({ FileDropZone: ({ children }: { children: ReactNode }) => children }));
vi.mock("../overlays/ConfirmDialog", () => ({ ConfirmDialog: ({ onConfirm }: { onConfirm: () => void }) => <button onClick={onConfirm}>confirm-delivery</button> }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

const session = { sessionId: "first", fileTransfer: true, agentName: "First", fileRootLabel: "Shared" } as RemoteSessionSummary;
const file = { name: "sample.txt", size: 1 } as File;

async function setup(listFiles = vi.fn().mockResolvedValue({ path: "/", entries: [] })) {
  const host = installHostDom();
  const root = createRoot(host as unknown as Element);
  const remote = { sessions: [session], transfers: {}, listFiles, uploadFile: vi.fn().mockResolvedValue(undefined), cancelFileTransfer: vi.fn() } as unknown as RemoteApi;
  const render = async () => { await act(async () => root.render(<I18nProvider locale="en"><AgentRemoteDelivery remote={{ ...remote }} /></I18nProvider>)); };
  await render();
  await act(async () => props(allNodes(host).find(node => node.tagName === "INPUT" && props(node).type === "file")!).onChange({ currentTarget: { files: [file] } }));
  const review = () => props(allNodes(host).find(node => node.tagName === "BUTTON" && String(props(node).className).includes("agents-delivery__submit"))!).onClick();
  const confirm = () => props(allNodes(host).find(node => node.tagName === "BUTTON" && node.textContent === "confirm-delivery")!).onClick;
  return { host, root, remote, render, review, confirm };
}

it("does not present a late review after the target disconnects", async () => {
  let finish!: (value: { path: string; entries: [] }) => void;
  const state = await setup(vi.fn(() => new Promise(resolve => { finish = resolve; })));
  try {
    await act(async () => state.review());
    state.remote.sessions = [];
    await state.render();
    await act(async () => finish({ path: "/", entries: [] }));
    expect(state.host.textContent).not.toContain("confirm-delivery");
  } finally { await act(async () => state.root.unmount()); }
});

it("rejects an already-open confirmation when its target disconnects", async () => {
  const state = await setup();
  try {
    await act(async () => state.review());
    const confirm = state.confirm();
    state.remote.sessions = [];
    await state.render();
    expect(state.host.textContent).not.toContain("confirm-delivery");
    await act(async () => confirm());
    expect(state.remote.uploadFile).not.toHaveBeenCalled();
  } finally { await act(async () => state.root.unmount()); }
});

it("starts only one target review for synchronous repeated clicks", async () => {
  let finish!: (value: { path: string; entries: [] }) => void;
  const state = await setup(vi.fn(() => new Promise(resolve => { finish = resolve; })));
  try {
    await act(async () => { state.review(); state.review(); });
    expect(state.remote.listFiles).toHaveBeenCalledTimes(1);
    await act(async () => finish({ path: "/", entries: [] }));
  } finally { await act(async () => state.root.unmount()); }
});

it("lets a new target review proceed without an old response unlocking it", async () => {
  let finishOld!: (value: { path: string; entries: [] }) => void;
  let finishNew!: (value: { path: string; entries: [] }) => void;
  const listFiles = vi.fn()
    .mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve; }));
  const state = await setup(listFiles);
  try {
    await act(async () => state.review());
    state.remote.sessions = [{ ...session, sessionId: "second" }];
    await state.render();
    await act(async () => state.review());
    expect(listFiles.mock.calls.map(call => call[0])).toEqual(["first", "second"]);
    await act(async () => finishOld({ path: "/old", entries: [] }));
    expect(state.host.textContent).not.toContain("confirm-delivery");
    await act(async () => state.review());
    expect(listFiles).toHaveBeenCalledTimes(2);
    await act(async () => finishNew({ path: "/new", entries: [] }));
    await act(async () => state.confirm()());
    expect(state.remote.uploadFile).toHaveBeenCalledWith("second", "/new", file, false, expect.any(Function));
  } finally { await act(async () => state.root.unmount()); }
});

it("starts only one upload for synchronous repeated confirmations", async () => {
  const state = await setup();
  try {
    await act(async () => state.review());
    const confirm = state.confirm();
    await act(async () => { confirm(); confirm(); });
    expect(state.remote.uploadFile).toHaveBeenCalledTimes(1);
  } finally { await act(async () => state.root.unmount()); }
});

it("does not send an old confirmation after unmounting", async () => {
  const state = await setup();
  let unmounted = false;
  try {
    await act(async () => state.review());
    const confirm = state.confirm();
    await act(async () => state.root.unmount());
    unmounted = true;
    await act(async () => confirm());
    expect(state.remote.uploadFile).not.toHaveBeenCalled();
  } finally { if (!unmounted) await act(async () => state.root.unmount()); }
});

it("ignores a late cancellation failure from an earlier upload", async () => {
  const state = await setup();
  let finishUpload!: () => void;
  let rejectCancel!: (reason: Error) => void;
  vi.mocked(state.remote.uploadFile).mockImplementation(async (_sessionId, _parent, _file, _overwrite, onStarted) => {
    onStarted?.({ transferId: "transfer", name: file.name, state: "running", bytesDone: 0, totalBytes: 1 } as RemoteFileTransfer);
    await new Promise<void>(resolve => { finishUpload = resolve; });
  });
  vi.mocked(state.remote.cancelFileTransfer).mockImplementation(() => new Promise<void>((_resolve, reject) => { rejectCancel = reject; }));
  try {
    await act(async () => state.review());
    await act(async () => state.confirm()());
    const cancel = props(allNodes(state.host).find(node => node.tagName === "BUTTON" && node.textContent === "Cancel transfer")!).onClick;
    await act(async () => { cancel(); cancel(); });
    expect(state.remote.cancelFileTransfer).toHaveBeenCalledTimes(1);
    await act(async () => finishUpload());
    await act(async () => props(allNodes(state.host).find(node => node.tagName === "INPUT" && props(node).type === "file")!).onChange({ currentTarget: { files: [file] } }));
    await act(async () => state.review());
    await act(async () => state.confirm()());
    await act(async () => rejectCancel(new Error("earlier cancellation failed")));
    expect(state.host.textContent).not.toContain("earlier cancellation failed");
    const input = allNodes(state.host).find(node => node.tagName === "INPUT" && props(node).type === "file")!;
    expect(props(input).disabled).toBe(true);
    await act(async () => finishUpload());
    expect(props(input).disabled).toBe(false);
  } finally { await act(async () => { finishUpload?.(); state.root.unmount(); }); }
});
