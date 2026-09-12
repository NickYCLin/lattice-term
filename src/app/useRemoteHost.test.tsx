import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { installFakeDom } from "./testFixtures/hookDom";
import { useRemoteHost, type RemoteHostApi, type RemoteHostStatus } from "./useRemoteHost";
import { loadRemoteHostSettings, saveRemoteHostSettings } from "./remoteHostSettings";
const backend = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Map<string, (event: { payload: unknown }) => void>() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: backend.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async (name: string, listener: (event: { payload: unknown }) => void) => { backend.listeners.set(name, listener); return () => backend.listeners.delete(name); } }));
function storage(): Storage {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); }, clear: () => values.clear(), key: index => [...values.keys()][index] ?? null, get length() { return values.size; } };
}
const ready: RemoteHostStatus = { hostId: "host", address: "127.0.0.1:44900", pairingCode: "test-memory-only", expiresAt: 0, viewOnly: true, fileTransfer: false, state: "waiting", attemptsRemaining: 5, persistent: true };
afterEach(() => { vi.useRealTimers(); backend.invoke.mockReset(); backend.listeners.clear(); });
describe("automatic Remote standby", () => {
  it("persists explicit grants but never a pairing password", () => {
    const store = storage();
    const request = { ...loadRemoteHostSettings(store), allowChat: true, allowInput: true, pairingCode: "secret-not-to-store" };
    saveRemoteHostSettings(store, request);
    expect(store.getItem(store.key(0)!)).not.toContain("secret-not-to-store");
    expect(loadRemoteHostSettings(store)).toMatchObject({ allowChat: true, allowInput: true, allowFiles: false, pairingCode: "" });
  });
  it("starts once after hydration and resumes standby after the engine ends", async () => {
    vi.useFakeTimers();
    const container = installFakeDom();
    const store = storage();
    Object.defineProperty(globalThis, "localStorage", { value: store, configurable: true });
    backend.invoke.mockImplementation(async (command: string) => command === "remote_host_status" ? null : ready);
    let api: RemoteHostApi | undefined;
    function Harness() { api = useRemoteHost(true); return null; }
    const root = createRoot(container as unknown as Element);
    await act(async () => { root.render(<Harness />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(backend.invoke.mock.calls.filter(call => call[0] === "remote_host_configure")).toHaveLength(1);
    expect(api?.status?.hostId).toBe("host");
    expect(backend.invoke.mock.calls.find(call => call[0] === "remote_host_configure")?.[1].request.bindAddress).toBe("");
    await act(async () => { backend.listeners.get("remote-host://closed")?.({ payload: { hostId: "host", reason: "peer left" } }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(backend.invoke.mock.calls.filter(call => call[0] === "remote_host_configure")).toHaveLength(2);
    await act(async () => { root.unmount(); });
  });
  it("backs off repeated startup failures instead of spawning in a tight loop", async () => {
    vi.useFakeTimers();
    const container = installFakeDom();
    Object.defineProperty(globalThis, "localStorage", { value: storage(), configurable: true });
    backend.invoke.mockImplementation(async (command: string) => { if (command === "remote_host_status") return null; throw new Error("engine unavailable"); });
    function Harness() { useRemoteHost(true); return null; }
    const root = createRoot(container as unknown as Element);
    await act(async () => { root.render(<Harness />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(backend.invoke.mock.calls.filter(call => call[0] === "remote_host_configure")).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(29998); });
    expect(backend.invoke.mock.calls.filter(call => call[0] === "remote_host_configure")).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(3); });
    expect(backend.invoke.mock.calls.filter(call => call[0] === "remote_host_configure")).toHaveLength(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(backend.invoke.mock.calls.filter(call => call[0] === "remote_host_configure")).toHaveLength(3);
    await act(async () => { root.unmount(); });
  });
  it("keeps mobile/viewer-only startup passive", async () => {
    const container = installFakeDom();
    Object.defineProperty(globalThis, "localStorage", { value: storage(), configurable: true });
    backend.invoke.mockResolvedValue(null);
    function Harness() { useRemoteHost(false); return null; }
    const root = createRoot(container as unknown as Element);
    await act(async () => { root.render(<Harness />); });
    expect(backend.invoke.mock.calls.filter(call => call[0] === "remote_host_configure")).toHaveLength(0);
    await act(async () => { root.unmount(); });
  });
});
