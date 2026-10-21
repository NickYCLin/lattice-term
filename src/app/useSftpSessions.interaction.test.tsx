import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import { useSftpSessions, type SftpConnectOutcome, type SftpSessionSummary, type SftpTransfer } from "./useSftpSessions";

const { invoke, listeners } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: SftpTransfer }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (event: { payload: SftpTransfer }) => void) => {
    listeners.set(name, handler);
    return () => { listeners.delete(name); };
  },
}));

const session: SftpSessionSummary = {
  sessionId: "sftp-fixture", profileId: "fixture", host: "example.test", port: 22,
  username: "fixture", currentPath: "/files",
};
const transfer: SftpTransfer = {
  transferId: "transfer-fixture", sessionId: session.sessionId, kind: "download",
  name: "report.txt", remotePath: "/files/report.txt", localPath: null,
  bytesDone: 0, totalBytes: 1, state: "running", detail: null,
};
let root: ReturnType<typeof createRoot> | null = null;
let api: ReturnType<typeof useSftpSessions>;

function Probe() { api = useSftpSessions(); return null; }

beforeEach(() => {
  invoke.mockImplementation(async () => []);
});
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

it.each(["download", "upload"] as const)("does not revive a dismissed %s from a late start response", async kind => {
  await mount();
  let finish!: (value: SftpTransfer) => void;
  invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  let pending!: Promise<SftpTransfer>;
  await act(async () => {
    pending = kind === "download"
      ? api.downloadToDisk(session.sessionId, transfer.remotePath)
      : api.uploadPath(session.sessionId, "/files", "/local/report.txt", false);
    await vi.dynamicImportSettled();
  });
  await act(async () => listeners.get("sftp://transfer")!({ payload: { ...transfer, kind, state: "done", bytesDone: 1 } }));
  expect(api.transfers[transfer.transferId]?.state).toBe("done");
  await act(async () => { await api.dismissTransfer(transfer.transferId); });
  expect(api.transfers).toEqual({});
  await act(async () => { finish({ ...transfer, kind }); await pending; });
  expect(api.transfers).toEqual({});
});

it.each(["connect", "attach"] as const)("deduplicates %s responses already included in hydration", async route => {
  let finishSnapshot!: (value: SftpSessionSummary[]) => void;
  invoke.mockImplementation(async command => command === "sftp_sessions"
    ? new Promise(resolve => { finishSnapshot = resolve; }) : []);
  await mount();
  let finishConnection!: (value: SftpConnectOutcome) => void;
  invoke.mockImplementationOnce(() => new Promise(resolve => { finishConnection = resolve; }));
  let pending!: Promise<SftpConnectOutcome>;
  await act(async () => {
    pending = route === "attach" ? api.attachToSsh("ssh-fixture") : api.connect({
      profileId: "fixture", hostname: "example.test", port: 22, username: "fixture",
      auth: { kind: "password", password: "" }, useSavedPassword: true, rememberPassword: false,
    });
    await vi.dynamicImportSettled();
  });
  await act(async () => finishSnapshot([session]));
  expect(api.sessions).toEqual([session]);
  await act(async () => { finishConnection({ outcome: "connected", session }); await pending; });
  expect(api.sessions).toEqual([session]);
});
