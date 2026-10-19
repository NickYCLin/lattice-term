import { afterEach, expect, it, vi } from "vitest";
import { readTunnelStore } from "./tunnelPersistence";

afterEach(() => vi.unstubAllGlobals());

const tunnel = {
  id: "test", name: "Test", type: "dynamic", profileId: "gateway",
  localHost: "127.0.0.1", localPort: 1080, remoteHost: "", remotePort: 0,
  createdAt: 1, updatedAt: 1,
};

it.each([
  [{ ...tunnel, autoStart: "false" }],
  [{ ...tunnel, type: "unknown" }],
  [{ ...tunnel, localPort: 10.5 }],
  [{ ...tunnel, remotePort: "0" }],
  [{ ...tunnel, name: null }],
  [{ ...tunnel, id: "" }],
  [tunnel, tunnel],
])("rejects malformed tunnel entries without writing storage: %j", (...entries) => {
  const setItem = vi.fn();
  vi.stubGlobal("localStorage", { getItem: () => JSON.stringify(entries), setItem });
  expect(readTunnelStore()).toEqual({ tunnels: [], storageError: true });
  expect(setItem).not.toHaveBeenCalled();
});

it("blocks partial recovery when a sibling entry is invalid", () => {
  vi.stubGlobal("localStorage", { getItem: () => JSON.stringify([tunnel, null]) });
  expect(readTunnelStore()).toEqual({ tunnels: [], storageError: true });
});

it("preserves valid settings, including unknown fields", () => {
  const stored = { ...tunnel, extension: "kept" };
  vi.stubGlobal("localStorage", { getItem: () => JSON.stringify([stored]) });
  expect(readTunnelStore()).toEqual({ tunnels: [stored], storageError: false });
});

it("reports inaccessible storage without treating it as an empty store", () => {
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); } });
  expect(readTunnelStore()).toEqual({ tunnels: [], storageError: true });
});

it("allows new settings when nothing was saved", () => {
  vi.stubGlobal("localStorage", { getItem: () => null });
  expect(readTunnelStore()).toEqual({ tunnels: [], storageError: false });
});
