import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import { useRemoteSessions, type RemoteFileTransfer } from "./useRemoteSessions";

const { invoke, listeners } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: RemoteFileTransfer }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (event: { payload: RemoteFileTransfer }) => void) => {
    listeners.set(name, handler);
    return () => { listeners.delete(name); };
  },
}));
const transfer: RemoteFileTransfer = {
  transferId: "transfer-fixture", sessionId: "remote-fixture", kind: "download",
  name: "report.txt", bytesDone: 1, totalBytes: 1, state: "done", detail: null,
  remotePath: "/report.txt", localPath: null,
};
let root: ReturnType<typeof createRoot> | null = null;
let api: ReturnType<typeof useRemoteSessions>;
function Probe() { api = useRemoteSessions(); return null; }
beforeEach(() => { invoke.mockImplementation(async () => []); });
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  listeners.clear();
  vi.resetAllMocks();
});
async function mount() {
  root = createRoot(installFakeDom() as unknown as Element);
  Object.assign(globalThis, { __TAURI_INTERNALS__: { invoke } });
  await act(async () => { root!.render(<Probe />); await vi.dynamicImportSettled(); });
}
async function completeAndDismiss() {
  await act(async () => listeners.get("remote://file-transfer")!({ payload: transfer }));
  await act(async () => api.dismissFileTransfer(transfer.sessionId, transfer.transferId));
  expect(api.transfers).toEqual({});
}
it("ignores late events after dismissing a transfer", async () => {
  await mount();
  await completeAndDismiss();
  await act(async () => listeners.get("remote://file-transfer")!({ payload: transfer }));
  expect(api.transfers).toEqual({});
});
it("ignores dismissed transfers in late hydration", async () => {
  let finish!: (value: RemoteFileTransfer[]) => void;
  invoke.mockImplementation(async command => command === "remote_file_transfers"
    ? new Promise(resolve => { finish = resolve; }) : []);
  await mount();
  await completeAndDismiss();
  await act(async () => finish([transfer]));
  expect(api.transfers).toEqual({});
});
it("ignores a dismissed download returned by a late start response", async () => {
  await mount();
  let finish!: (value: RemoteFileTransfer) => void;
  invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  let pending!: Promise<RemoteFileTransfer>;
  await act(async () => {
    pending = api.downloadFile(transfer.sessionId, "/report.txt");
    await vi.dynamicImportSettled();
  });
  await completeAndDismiss();
  await act(async () => { finish({ ...transfer, state: "running", bytesDone: 0 }); await pending; });
  expect(api.transfers).toEqual({});
});
it("keeps the transfer when backend dismissal fails", async () => {
  await mount();
  await act(async () => listeners.get("remote://file-transfer")!({ payload: transfer }));
  invoke.mockRejectedValueOnce(new Error("dismiss rejected"));
  await act(async () => {
    await expect(api.dismissFileTransfer(transfer.sessionId, transfer.transferId)).rejects.toThrow("dismiss rejected");
  });
  expect(api.transfers[transfer.transferId]).toEqual(transfer);
});
