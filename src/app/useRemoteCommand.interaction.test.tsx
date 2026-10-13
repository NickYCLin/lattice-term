import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import { useRemoteCommand, type RemoteCommandView } from "./useRemoteCommand";

const { invoke, listeners } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: RemoteCommandView }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (event: { payload: RemoteCommandView }) => void) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  },
}));
afterEach(() => { vi.resetAllMocks(); listeners.clear(); });

function result(sessionId: string): RemoteCommandView {
  return { sessionId, id: 1, revision: 1, shell: "posix", command: "fixture", directory: "",
    state: "exited", stdout: sessionId, stderr: "", exitCode: 0, detail: "" };
}

it("does not show a previous connection's delayed snapshot in the current connection", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let resolveOld!: (view: RemoteCommandView) => void;
  invoke.mockImplementation(async (_command: string, args: { sessionId: string }) =>
    args.sessionId === "old" ? new Promise<RemoteCommandView>(resolve => { resolveOld = resolve; }) : result(args.sessionId));
  let api!: ReturnType<typeof useRemoteCommand>;
  function Probe({ id }: { id: string }) { api = useRemoteCommand(id); return null; }
  try {
    await act(async () => root.render(<Probe id="old" />));
    await act(async () => root.render(<Probe id="new" />));
    expect(api.view?.sessionId).toBe("new");
    await act(async () => resolveOld(result("old")));
    expect(api.view?.sessionId).toBe("new");
  } finally { await act(async () => root.unmount()); }
});

it("clears an old connection error when switching to a healthy connection", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  invoke.mockImplementation(async (_command: string, args: { sessionId: string }) => {
    if (args.sessionId === "old") throw new Error("fixture read failure");
    return result(args.sessionId);
  });
  let api!: ReturnType<typeof useRemoteCommand>;
  function Probe({ id }: { id: string }) { api = useRemoteCommand(id); return null; }
  try {
    await act(async () => root.render(<Probe id="old" />));
    expect(api.problem).toContain("fixture read failure");
    await act(async () => root.render(<Probe id="new" />));
    expect(api.ready).toBe(true);
    expect(api.problem).toBeNull();
  } finally { await act(async () => root.unmount()); }
});

it.each(["remote_command_start", "remote_command_cancel"])("ignores a delayed %s failure after changing connections", async command => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let rejectOld!: (reason: Error) => void;
  invoke.mockImplementation(async (name: string, args: { sessionId: string }) =>
    name === command ? new Promise((_, reject) => { rejectOld = reject; }) : result(args.sessionId));
  let api!: ReturnType<typeof useRemoteCommand>;
  function Probe({ id }: { id: string }) { api = useRemoteCommand(id); return null; }
  try {
    await act(async () => root.render(<Probe id="old" />));
    let operation!: Promise<void>;
    await act(async () => {
      operation = command === "remote_command_start"
        ? api.start({ shell: "posix", command: "fixture", directory: "", timeoutSeconds: 10 })
        : api.cancel(1);
    });
    await act(async () => root.render(<Probe id="new" />));
    await act(async () => { rejectOld(new Error("old command failed")); await operation; });
    expect(api.problem).toBeNull();
    expect(api.view?.sessionId).toBe("new");
    expect(invoke.mock.calls.filter(([name]) => name === "remote_command_state")).toHaveLength(2);
  } finally { await act(async () => root.unmount()); }
});

it("rejects the first visit's snapshot when returning to the same connection", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  let resolveFirst!: (view: RemoteCommandView) => void;
  let first = true;
  invoke.mockImplementation(async (_command: string, args: { sessionId: string }) => {
    if (first) {
      first = false;
      return new Promise<RemoteCommandView>(resolve => { resolveFirst = resolve; });
    }
    return result(args.sessionId);
  });
  let api!: ReturnType<typeof useRemoteCommand>;
  function Probe({ id }: { id: string }) { api = useRemoteCommand(id); return null; }
  try {
    await act(async () => root.render(<Probe id="same" />));
    await act(async () => root.render(<Probe id="other" />));
    await act(async () => root.render(<Probe id="same" />));
    await act(async () => resolveFirst({ ...result("same"), id: 99, stdout: "stale" }));
    expect(api.view?.stdout).toBe("same");
  } finally { await act(async () => root.unmount()); }
});
