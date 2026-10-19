import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import { useTunnels } from "./useTunnels";
import { createConnectionProfile, emptyDraft } from "../domain/connection";
import type { TunnelConfig } from "../domain/tunnel";
import { TUNNELS_STORAGE_KEY } from "./tunnelPersistence";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); native.invoke.mockReset(); });

it.each(["null", "{}", "[null]", "[{}]", "", "not-json"])("preserves invalid stored tunnel data: %s", async raw => {
  const setItem = vi.fn();
  vi.stubGlobal("localStorage", { getItem: () => raw, setItem });
  const root = createRoot(installFakeDom() as unknown as Element);
  let api!: ReturnType<typeof useTunnels>;
  function Probe() { api = useTunnels([], undefined, false); return null; }
  try {
    await act(async () => root.render(<Probe />));
    expect(api.storageError).toBe(true);
    expect(api.tunnels).toEqual([]);
    await act(async () => {
      expect(api.addTunnel({ name: "New", type: "dynamic", profileId: "gateway",
        localHost: "127.0.0.1", localPort: 1080, remoteHost: "", remotePort: 0 }).success).toBe(false);
    });
    expect(setItem).not.toHaveBeenCalled();
    expect(api.tunnels).toEqual([]);
  } finally { await act(async () => root.unmount()); }
});

it("duplicates an auto-start tunnel without opening another listener", async () => {
  const profile = createConnectionProfile({ ...emptyDraft(), name: "Gateway", hostname: "gateway.example", username: "tester" }, "gateway");
  const original: TunnelConfig = {
    id: "original", name: "Database", type: "local", profileId: profile.id,
    localHost: "127.0.0.1", localPort: 5432, remoteHost: "localhost",
    remotePort: 5432, autoStart: true, createdAt: 1, updatedAt: 1,
  };
  vi.stubGlobal("localStorage", { getItem: () => JSON.stringify([original]), setItem: vi.fn() });
  native.invoke.mockImplementation(async command => command === "tunnel_list" ? [] : undefined);
  const root = createRoot(installFakeDom() as unknown as Element);
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke: native.invoke });
  let api!: ReturnType<typeof useTunnels>;
  function Probe() { api = useTunnels([profile], undefined, true); return null; }
  try {
    await act(async () => root.render(<Probe />));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(api.tunnels).toEqual([original]);
    expect(api.storageError).toBe(false);
    expect(localStorage.setItem).toHaveBeenCalledWith(TUNNELS_STORAGE_KEY, JSON.stringify([original]));
    expect(api.states[original.id]?.lastError).toBeUndefined();
    expect(native.invoke.mock.calls.filter(([command]) => command === "tunnel_start")).toHaveLength(1);
    await act(async () => api.duplicateTunnel(original.id));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    const duplicate = api.tunnels.find(tunnel => tunnel.id !== original.id)!;
    expect(duplicate.autoStart).toBe(false);
    expect(duplicate.localPort).toBe(5433);
    expect(api.tunnels.find(tunnel => tunnel.id === original.id)).toEqual(original);
    expect(native.invoke.mock.calls.filter(([command]) => command === "tunnel_start")).toHaveLength(1);
    await act(async () => { await api.startTunnel(duplicate.id); });
    expect(native.invoke.mock.calls.filter(([command]) => command === "tunnel_start")).toHaveLength(2);
  } finally { await act(async () => root.unmount()); }
});
