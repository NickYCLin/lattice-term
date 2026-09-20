import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { installFakeDom } from "./testFixtures/hookDom";
import {
  useRemoteHost,
  type RemoteHostApi,
  type RemoteHostStartRequest,
  type RemoteHostStatus,
} from "./useRemoteHost";
import {
  loadRemoteHostSettings,
  saveRemoteHostSettings,
} from "./remoteHostSettings";
const backend = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  afterListen: undefined as ((name: string) => void) | undefined,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: backend.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (
    name: string,
    listener: (event: { payload: unknown }) => void,
  ) => {
    backend.listeners.set(name, listener);
    backend.afterListen?.(name);
    return () => backend.listeners.delete(name);
  },
}));
function storage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}
type ForgetResult = { cleanupWarning: string | null; cleanupPending: boolean };
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}
function hookContainer(): Element {
  installFakeDom();
  const fakeDocument = globalThis.document as unknown as {
    createElement: (name: string) => Record<string, unknown>;
  };
  const container = fakeDocument.createElement("div");
  container.ownerDocument = fakeDocument;
  return container as unknown as Element;
}
function relayRequest(
  store: Storage,
  overrides: Partial<RemoteHostStartRequest> = {},
): RemoteHostStartRequest {
  return {
    ...loadRemoteHostSettings(store),
    mode: "relay",
    relayAddress: "wss://relay.example.test",
    ...overrides,
  };
}
const ready: RemoteHostStatus = {
  hostId: "host",
  address: "127.0.0.1:44900",
  pairingCode: "test-memory-only",
  expiresAt: 0,
  viewOnly: true,
  fileTransfer: false,
  state: "waiting",
  attemptsRemaining: 5,
  persistent: true,
  savedPairingCode: false,
};
afterEach(() => {
  vi.useRealTimers();
  backend.invoke.mockReset();
  backend.listeners.clear();
  backend.afterListen = undefined;
});
describe("automatic Remote standby", () => {
  it("persists explicit grants but never a pairing password", () => {
    const store = storage();
    const request = {
      ...loadRemoteHostSettings(store),
      allowChat: true,
      allowCli: true,
      allowInput: true,
      // Turning one grant off is what has to survive: the saved answer wins
      // over the wide-open default a never-configured share starts from.
      allowFiles: false,
      pairingCode: "secret-not-to-store",
      rememberPairingCode: true,
    };
    saveRemoteHostSettings(store, request);
    expect(store.getItem(store.key(0)!)).not.toContain("secret-not-to-store");
    expect(store.getItem(store.key(0)!)).not.toContain("rememberPairingCode");
    expect(loadRemoteHostSettings(store)).toMatchObject({
      allowChat: true,
      allowCli: true,
      allowInput: true,
      allowFiles: false,
      pairingCode: "",
      useSavedPairingCode: false,
      rememberPairingCode: false,
    });

    saveRemoteHostSettings(store, {
      ...request,
      mode: "relay",
      useSavedPairingCode: true,
    });
    expect(loadRemoteHostSettings(store).useSavedPairingCode).toBe(true);
  });
  it("uses the native saved password for automatic relay standby", async () => {
    vi.useFakeTimers();
    const container = hookContainer();
    const store = storage();
    const saved = {
      ...loadRemoteHostSettings(store),
      mode: "relay" as const,
      relayAddress: "wss://relay.example.test",
      useSavedPairingCode: true,
    };
    saveRemoteHostSettings(store, saved);
    Object.defineProperty(globalThis, "localStorage", {
      value: store,
      configurable: true,
    });
    const confirmed = { ...ready, pairingCode: "", savedPairingCode: true };
    let current: RemoteHostStatus | null = null;
    backend.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_host_status") return current;
      if (command === "remote_host_configure") {
        current = confirmed;
        return confirmed;
      }
      throw new Error(`unexpected command: ${command}`);
    });
    function Harness() {
      useRemoteHost(true);
      return null;
    }
    const root = createRoot(container as unknown as Element);
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    const request = backend.invoke.mock.calls.find(
      (call) => call[0] === "remote_host_configure",
    )?.[1].request;
    expect(request).toMatchObject({
      mode: "relay",
      pairingCode: "",
      useSavedPairingCode: true,
      rememberPairingCode: false,
    });
    await act(async () => {
      root.unmount();
    });
  });
  it("promotes a newly remembered password to saved standby without persisting plaintext", async () => {
    const container = hookContainer();
    const store = storage();
    Object.defineProperty(globalThis, "localStorage", {
      value: store,
      configurable: true,
    });
    const started = { ...ready, hostId: "remembered-host" };
    const confirmed = {
      ...started,
      pairingCode: "",
      state: "streaming" as const,
      savedPairingCode: true,
    };
    let statusReads = 0;
    backend.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_host_status") {
        statusReads += 1;
        return statusReads === 1 ? null : confirmed;
      }
      if (command === "remote_host_configure") return started;
      throw new Error(`unexpected command: ${command}`);
    });
    let api: RemoteHostApi | undefined;
    function Harness() {
      api = useRemoteHost(false);
      return null;
    }
    const root = createRoot(container as unknown as Element);
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {});
    let result: RemoteHostStatus | undefined;
    await act(async () => {
      result = await api!.start(
        relayRequest(store, {
          pairingCode: "sentinel-secret",
          rememberPairingCode: true,
        }),
      );
    });
    expect(result).toEqual(confirmed);
    expect(api?.status).toEqual(confirmed);
    expect(statusReads).toBe(2);
    const raw = store.getItem(store.key(0)!)!;
    expect(raw).not.toContain("sentinel-secret");
    expect(raw).not.toContain("rememberPairingCode");
    expect(loadRemoteHostSettings(store).useSavedPairingCode).toBe(true);
    await act(async () => {
      root.unmount();
    });
  });
  it("keeps a confirmed start when the initial hydration snapshot finishes later", async () => {
    const container = hookContainer();
    const store = storage();
    Object.defineProperty(globalThis, "localStorage", {
      value: store,
      configurable: true,
    });
    const initialSnapshot = deferred<RemoteHostStatus | null>();
    const confirmed = {
      ...ready,
      hostId: "started-during-hydration",
      pairingCode: "",
      savedPairingCode: true,
    };
    let statusReads = 0;
    backend.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_host_status") {
        statusReads += 1;
        return statusReads === 1 ? initialSnapshot.promise : confirmed;
      }
      if (command === "remote_host_configure") return confirmed;
      throw new Error(`unexpected command: ${command}`);
    });
    let api: RemoteHostApi | undefined;
    function Harness() {
      api = useRemoteHost(false);
      return null;
    }
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {
      await vi.waitFor(() => expect(statusReads).toBe(1));
    });

    await act(async () => {
      await api!.start(relayRequest(store));
    });
    expect(api?.status).toEqual(confirmed);

    await act(async () => {
      initialSnapshot.resolve(null);
      await initialSnapshot.promise;
    });
    expect(api?.status).toEqual(confirmed);
    expect(
      backend.invoke.mock.calls.filter(
        (call) => call[0] === "remote_host_configure",
      ),
    ).toHaveLength(1);
    await act(async () => {
      root.unmount();
    });
  });
  it("installs revocation and close listeners before status events", async () => {
    const container = hookContainer();
    const store = storage();
    Object.defineProperty(globalThis, "localStorage", {
      value: store,
      configurable: true,
    });
    const initialSnapshot = deferred<RemoteHostStatus | null>();
    const transient = { ...ready, hostId: "closed-during-listener-setup" };
    const listenerOrder: string[] = [];
    backend.afterListen = (name) => {
      listenerOrder.push(name);
      if (name !== "remote-host://status") return;
      backend.listeners.get("remote-host://status")?.({ payload: transient });
      backend.listeners.get("remote-host://closed")?.({
        payload: {
          hostId: transient.hostId,
          reason: "closed while listeners were being installed",
        },
      });
    };
    backend.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_host_status") return initialSnapshot.promise;
      throw new Error(`unexpected command: ${command}`);
    });
    let api: RemoteHostApi | undefined;
    function Harness() {
      api = useRemoteHost(false);
      return null;
    }
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(api?.closedReason).toBe(
          "closed while listeners were being installed",
        ),
      );
      initialSnapshot.resolve(null);
      await initialSnapshot.promise;
    });

    expect(listenerOrder.slice(0, 3)).toEqual([
      "remote-host://credential-reset",
      "remote-host://closed",
      "remote-host://status",
    ]);
    expect(api?.status).toBeNull();
    await act(async () => {
      root.unmount();
    });
  });
  it("lets the hydration snapshot supersede a setup-window status event", async () => {
    const container = hookContainer();
    const store = storage();
    Object.defineProperty(globalThis, "localStorage", {
      value: store,
      configurable: true,
    });
    const initialSnapshot = deferred<RemoteHostStatus | null>();
    const transient = { ...ready, hostId: "stale-setup-status" };
    backend.afterListen = (name) => {
      if (name === "remote-host://status") {
        backend.listeners.get(name)?.({ payload: transient });
      }
    };
    backend.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_host_status") return initialSnapshot.promise;
      throw new Error(`unexpected command: ${command}`);
    });
    let api: RemoteHostApi | undefined;
    function Harness() {
      api = useRemoteHost(false);
      return null;
    }
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {
      await vi.waitFor(() => expect(api?.status).toEqual(transient));
      initialSnapshot.resolve(null);
      await initialSnapshot.promise;
    });
    await act(async () => {
      await vi.waitFor(() => expect(api?.status).toBeNull());
    });
    await act(async () => {
      root.unmount();
    });
  });
  it("redacts a hydration snapshot revoked while its read is pending", async () => {
    const container = hookContainer();
    const store = storage();
    saveRemoteHostSettings(
      store,
      relayRequest(store, { useSavedPairingCode: true }),
    );
    Object.defineProperty(globalThis, "localStorage", {
      value: store,
      configurable: true,
    });
    const initialSnapshot = deferred<RemoteHostStatus | null>();
    const stale = {
      ...ready,
      hostId: "revoked-pending-snapshot",
      pairingCode: "stale-snapshot-password",
      savedPairingCode: true,
    };
    backend.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_host_status") return initialSnapshot.promise;
      throw new Error(`unexpected command: ${command}`);
    });
    let api: RemoteHostApi | undefined;
    function Harness() {
      api = useRemoteHost(false);
      return null;
    }
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(backend.invoke).toHaveBeenCalledWith("remote_host_status"),
      );
      backend.listeners.get("remote-host://credential-reset")?.({
        payload: { hostId: stale.hostId },
      });
      initialSnapshot.resolve(stale);
      await initialSnapshot.promise;
    });

    expect(api?.status).toMatchObject({
      hostId: stale.hostId,
      pairingCode: "",
      savedPairingCode: false,
    });
    expect(api?.configuration?.useSavedPairingCode).toBe(false);
    expect(loadRemoteHostSettings(store).useSavedPairingCode).toBe(false);
    await act(async () => {
      root.unmount();
    });
  });
  it("applies credential and device-id side effects from initial hydration", async () => {
    const container = hookContainer();
    const store = storage();
    saveRemoteHostSettings(
      store,
      relayRequest(store, {
        useSavedPairingCode: true,
      }),
    );
    Object.defineProperty(globalThis, "localStorage", {
      value: store,
      configurable: true,
    });
    const hydratedStatus = {
      ...ready,
      hostId: "hydrated-host",
      deviceId: "987654321",
      savedPairingCode: false,
    };
    backend.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_host_status") return hydratedStatus;
      throw new Error(`unexpected command: ${command}`);
    });
    let api: RemoteHostApi | undefined;
    function Harness() {
      api = useRemoteHost(false);
      return null;
    }
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {
      await vi.waitFor(() => expect(api?.status).toEqual(hydratedStatus));
    });

    expect(api?.deviceId).toBe("987654321");
    expect(api?.configuration?.useSavedPairingCode).toBe(false);
    expect(loadRemoteHostSettings(store).useSavedPairingCode).toBe(false);
    await act(async () => {
      root.unmount();
    });
  });
  it("rejects a start whose returned host is no longer active at confirmation", async () => {
    const container = hookContainer();
    const store = storage();
    Object.defineProperty(globalThis, "localStorage", {
      value: store,
      configurable: true,
    });
    const started = { ...ready, hostId: "already-closed" };
    let statusReads = 0;
    backend.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_host_status") {
        statusReads += 1;
        return null;
      }
      if (command === "remote_host_configure") return started;
      throw new Error(`unexpected command: ${command}`);
    });
    let api: RemoteHostApi | undefined;
    function Harness() {
      api = useRemoteHost(false);
      return null;
    }
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {});

    await act(async () => {
      await expect(api!.start(relayRequest(store))).rejects.toThrow(
        "Sharing stopped before its status could be confirmed.",
      );
    });
    expect(statusReads).toBe(2);
    expect(api?.status).toBeNull();
    expect(api?.closedReason).toContain(
      "Sharing stopped before its status could be confirmed.",
    );
    await act(async () => {
      root.unmount();
    });
  });
  it("keeps a started host active when its confirmation command fails", async () => {
    const container = hookContainer();
    const store = storage();
    Object.defineProperty(globalThis, "localStorage", {
      value: store,
      configurable: true,
    });
    const started = {
      ...ready,
      hostId: "confirmed-command-failed",
      pairingCode: "",
      savedPairingCode: true,
    };
    let statusReads = 0;
    backend.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_host_status") {
        statusReads += 1;
        if (statusReads === 1) return null;
        throw new Error("status bridge temporarily unavailable");
      }
      if (command === "remote_host_configure") return started;
      throw new Error(`unexpected command: ${command}`);
    });
    let api: RemoteHostApi | undefined;
    function Harness() {
      api = useRemoteHost(false);
      return null;
    }
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {});

    let result: RemoteHostStatus | undefined;
    await act(async () => {
      result = await api!.start(relayRequest(store));
    });

    expect(result).toEqual(started);
    expect(api?.status).toEqual(started);
    expect(api?.closedReason).toContain(
      "status bridge temporarily unavailable",
    );
    expect(
      backend.invoke.mock.calls.filter(
        (call) => call[0] === "remote_host_configure",
      ),
    ).toHaveLength(1);
    await act(async () => {
      root.unmount();
    });
  });
  it("keeps a configure result unsaved after concurrent revocation", async () => {
    const container = hookContainer();
    const store = storage();
    Object.defineProperty(globalThis, "localStorage", {
      value: store,
      configurable: true,
    });
    const started = {
      ...ready,
      hostId: "revoked-before-configure-resolved",
      pairingCode: "stale-returned-password",
      savedPairingCode: true,
    };
    let statusReads = 0;
    backend.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_host_status") {
        statusReads += 1;
        if (statusReads === 1) return null;
        throw new Error("status bridge unavailable after revocation");
      }
      if (command === "remote_host_configure") {
        backend.listeners.get("remote-host://credential-reset")?.({
          payload: { hostId: started.hostId },
        });
        return started;
      }
      throw new Error(`unexpected command: ${command}`);
    });
    let api: RemoteHostApi | undefined;
    function Harness() {
      api = useRemoteHost(false);
      return null;
    }
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {});

    let result: RemoteHostStatus | undefined;
    await act(async () => {
      result = await api!.start(
        relayRequest(store, {
          pairingCode: "new-password",
          rememberPairingCode: true,
        }),
      );
    });

    expect(result).toMatchObject({
      hostId: started.hostId,
      pairingCode: "",
      savedPairingCode: false,
    });
    expect(api?.status).toEqual(result);
    expect(api?.configuration?.useSavedPairingCode).toBe(false);
    expect(loadRemoteHostSettings(store).useSavedPairingCode).toBe(false);
    expect(api?.closedReason).toContain(
      "status bridge unavailable after revocation",
    );
    await act(async () => {
      root.unmount();
    });
  });
  it("does not revive a host that closes before configure resolves", async () => {
    const container = hookContainer();
    const store = storage();
    Object.defineProperty(globalThis, "localStorage", {
      value: store,
      configurable: true,
    });
    const started = {
      ...ready,
      hostId: "closed-before-configure-resolved",
      pairingCode: "",
      savedPairingCode: true,
    };
    let statusReads = 0;
    backend.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_host_status") {
        statusReads += 1;
        if (statusReads === 1) return null;
        throw new Error("status bridge unavailable after close");
      }
      if (command === "remote_host_configure") {
        backend.listeners.get("remote-host://closed")?.({
          payload: { hostId: started.hostId, reason: "agent exited early" },
        });
        return started;
      }
      throw new Error(`unexpected command: ${command}`);
    });
    let api: RemoteHostApi | undefined;
    function Harness() {
      api = useRemoteHost(false);
      return null;
    }
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {});

    await act(async () => {
      await expect(api!.start(relayRequest(store))).rejects.toThrow(
        "Sharing stopped before its status could be confirmed.",
      );
    });
    expect(api?.status).toBeNull();
    expect(api?.closedReason).toContain(
      "Sharing stopped before its status could be confirmed.",
    );
    await act(async () => {
      root.unmount();
    });
  });
  it("keeps a newer status event when start confirmation returns a stale snapshot", async () => {
    const container = hookContainer();
    const store = storage();
    Object.defineProperty(globalThis, "localStorage", {
      value: store,
      configurable: true,
    });
    const started = { ...ready, hostId: "racing-host", savedPairingCode: true };
    const stale = { ...started, state: "waiting" as const };
    const newer = {
      ...started,
      pairingCode: "",
      state: "streaming" as const,
      savedPairingCode: false,
    };
    const confirmation = deferred<RemoteHostStatus | null>();
    let statusReads = 0;
    backend.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_host_status") {
        statusReads += 1;
        return statusReads === 1 ? null : confirmation.promise;
      }
      if (command === "remote_host_configure") return started;
      throw new Error(`unexpected command: ${command}`);
    });
    let api: RemoteHostApi | undefined;
    function Harness() {
      api = useRemoteHost(false);
      return null;
    }
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {});

    let startRequest!: Promise<RemoteHostStatus>;
    act(() => {
      startRequest = api!.start(relayRequest(store));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(statusReads).toBe(2);
    let result: RemoteHostStatus | undefined;
    await act(async () => {
      backend.listeners.get("remote-host://status")?.({ payload: newer });
      confirmation.resolve(stale);
      result = await startRequest;
    });
    expect(result).toEqual(newer);
    expect(api?.status).toEqual(newer);
    expect(api?.configuration?.useSavedPairingCode).toBe(false);
    expect(loadRemoteHostSettings(store).useSavedPairingCode).toBe(false);
    await act(async () => {
      root.unmount();
    });
  });
  it("ignores delayed status, reset, and close events from the replaced host", async () => {
    const container = hookContainer();
    const store = storage();
    Object.defineProperty(globalThis, "localStorage", {
      value: store,
      configurable: true,
    });
    const previous = {
      ...ready,
      hostId: "previous-host",
      pairingCode: "",
      savedPairingCode: true,
    };
    const started = {
      ...previous,
      hostId: "replacement-host",
    };
    const confirmation = deferred<RemoteHostStatus | null>();
    let statusReads = 0;
    backend.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_host_status") {
        statusReads += 1;
        return statusReads === 1 ? previous : confirmation.promise;
      }
      if (command === "remote_host_configure") return started;
      throw new Error(`unexpected command: ${command}`);
    });
    let api: RemoteHostApi | undefined;
    function Harness() {
      api = useRemoteHost(false);
      return null;
    }
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {
      await vi.waitFor(() => expect(api?.status?.hostId).toBe(previous.hostId));
    });

    let startRequest!: Promise<RemoteHostStatus>;
    act(() => {
      startRequest = api!.start(
        relayRequest(store, { useSavedPairingCode: true }),
      );
    });
    await act(async () => {
      await vi.waitFor(() => expect(statusReads).toBe(2));
    });

    let result: RemoteHostStatus | undefined;
    await act(async () => {
      backend.listeners.get("remote-host://credential-reset")?.({
        payload: { hostId: previous.hostId },
      });
      backend.listeners.get("remote-host://status")?.({
        payload: { ...previous, savedPairingCode: false },
      });
      backend.listeners.get("remote-host://closed")?.({
        payload: { hostId: previous.hostId, reason: "old watcher exited" },
      });
      confirmation.resolve(started);
      result = await startRequest;
    });

    expect(result).toEqual(started);
    expect(api?.status).toEqual(started);
    expect(api?.configuration?.useSavedPairingCode).toBe(true);
    expect(loadRemoteHostSettings(store).useSavedPairingCode).toBe(true);
    expect(api?.closedReason).toBeNull();
    await act(async () => {
      root.unmount();
    });
  });
  it("does not let an old credential reset disable a saved replacement", async () => {
    const container = hookContainer();
    const store = storage();
    Object.defineProperty(globalThis, "localStorage", {
      value: store,
      configurable: true,
    });
    const previous = {
      ...ready,
      hostId: "previous-saved-host",
      pairingCode: "",
      savedPairingCode: true,
    };
    const replacement = {
      ...previous,
      hostId: "newer-saved-host",
    };
    let statusReads = 0;
    backend.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_host_status") {
        statusReads += 1;
        return statusReads === 1 ? previous : replacement;
      }
      if (command === "remote_host_configure") return replacement;
      throw new Error(`unexpected command: ${command}`);
    });
    let api: RemoteHostApi | undefined;
    function Harness() {
      api = useRemoteHost(false);
      return null;
    }
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {
      await vi.waitFor(() => expect(api?.status).toEqual(previous));
      await api!.start(
        relayRequest(store, { useSavedPairingCode: true }),
      );
    });

    await act(async () => {
      backend.listeners.get("remote-host://credential-reset")?.({
        payload: { hostId: previous.hostId },
      });
    });

    expect(api?.status).toEqual(replacement);
    expect(api?.configuration?.useSavedPairingCode).toBe(true);
    expect(loadRemoteHostSettings(store).useSavedPairingCode).toBe(true);
    await act(async () => {
      root.unmount();
    });
  });
  it("does not resurrect a closed host when reconfiguration later rejects", async () => {
    const container = hookContainer();
    const store = storage();
    saveRemoteHostSettings(
      store,
      relayRequest(store, {
        useSavedPairingCode: true,
      }),
    );
    Object.defineProperty(globalThis, "localStorage", {
      value: store,
      configurable: true,
    });
    const previous = {
      ...ready,
      hostId: "closed-before-reconfigure-error",
      pairingCode: "",
      savedPairingCode: true,
    };
    const reconfiguration = deferred<RemoteHostStatus>();
    backend.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_host_status") return previous;
      if (command === "remote_host_configure") return reconfiguration.promise;
      throw new Error(`unexpected command: ${command}`);
    });
    let api: RemoteHostApi | undefined;
    function Harness() {
      api = useRemoteHost(false);
      return null;
    }
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {
      await vi.waitFor(() => expect(api?.status?.hostId).toBe(previous.hostId));
    });

    let startRequest!: Promise<RemoteHostStatus>;
    act(() => {
      startRequest = api!.start(
        relayRequest(store, { useSavedPairingCode: true }),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      backend.listeners.get("remote-host://closed")?.({
        payload: { hostId: previous.hostId, reason: "replaced" },
      });
      backend.listeners.get("remote-host://status")?.({
        payload: { ...previous, savedPairingCode: false },
      });
      reconfiguration.reject(new Error("replacement failed after stop"));
      await expect(startRequest).rejects.toThrow(
        "replacement failed after stop",
      );
    });

    expect(api?.status).toBeNull();
    expect(api?.configuration?.useSavedPairingCode).toBe(true);
    expect(loadRemoteHostSettings(store).useSavedPairingCode).toBe(true);
    await act(async () => {
      root.unmount();
    });
  });
  it("forgets the native host password and confirms the active status", async () => {
    const container = hookContainer();
    const store = storage();
    saveRemoteHostSettings(store, {
      ...loadRemoteHostSettings(store),
      mode: "relay",
      relayAddress: "wss://relay.example.test",
      useSavedPairingCode: true,
    });
    Object.defineProperty(globalThis, "localStorage", {
      value: store,
      configurable: true,
    });
    const active = { ...ready, pairingCode: "", savedPairingCode: true };
    const forgotten = { ...active, savedPairingCode: false };
    let statusReads = 0;
    backend.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_host_status") {
        statusReads += 1;
        return statusReads === 1 ? active : forgotten;
      }
      if (command === "remote_host_forget_pairing_code") {
        return {
          cleanupWarning: null,
          cleanupPending: false,
        } satisfies ForgetResult;
      }
      throw new Error(`unexpected command: ${command}`);
    });
    let api: RemoteHostApi | undefined;
    function Harness() {
      api = useRemoteHost(false);
      return null;
    }
    const root = createRoot(container as unknown as Element);
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {});
    expect(api?.status?.savedPairingCode).toBe(true);
    await act(async () => {
      await api!.removeSavedPairingCode();
    });
    expect(backend.invoke).toHaveBeenCalledWith(
      "remote_host_forget_pairing_code",
    );
    expect(statusReads).toBe(2);
    expect(api?.status).toEqual(forgotten);
    expect(api?.configuration).toMatchObject({
      pairingCode: "",
      useSavedPairingCode: false,
      rememberPairingCode: false,
    });
    expect(loadRemoteHostSettings(store).useSavedPairingCode).toBe(false);
    await act(async () => {
      root.unmount();
    });
  });
  it("keeps queued same-host status events unsaved after deletion succeeds", async () => {
    const container = hookContainer();
    const store = storage();
    saveRemoteHostSettings(
      store,
      relayRequest(store, {
        useSavedPairingCode: true,
      }),
    );
    Object.defineProperty(globalThis, "localStorage", {
      value: store,
      configurable: true,
    });
    const active = {
      ...ready,
      hostId: "deleted-without-reset-event",
      pairingCode: "",
      savedPairingCode: true,
    };
    const confirmation = deferred<RemoteHostStatus | null>();
    let statusReads = 0;
    backend.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_host_status") {
        statusReads += 1;
        return statusReads === 1 ? active : confirmation.promise;
      }
      if (command === "remote_host_forget_pairing_code") {
        return {
          cleanupWarning: null,
          cleanupPending: false,
        } satisfies ForgetResult;
      }
      throw new Error(`unexpected command: ${command}`);
    });
    let api: RemoteHostApi | undefined;
    function Harness() {
      api = useRemoteHost(false);
      return null;
    }
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {
      await vi.waitFor(() => expect(api?.status).toEqual(active));
    });

    let forgetRequest!: Promise<void>;
    act(() => {
      forgetRequest = api!.removeSavedPairingCode();
    });
    await act(async () => {
      await vi.waitFor(() => expect(statusReads).toBe(2));
      backend.listeners.get("remote-host://status")?.({ payload: active });
      confirmation.resolve(active);
      await forgetRequest;
    });

    expect(api?.status).toMatchObject({
      hostId: active.hostId,
      pairingCode: "",
      savedPairingCode: false,
    });
    expect(api?.configuration?.useSavedPairingCode).toBe(false);
    expect(loadRemoteHostSettings(store).useSavedPairingCode).toBe(false);
    await act(async () => {
      root.unmount();
    });
  });
  it("does not restore a pre-forget hydration snapshot after native revocation", async () => {
    const container = hookContainer();
    const store = storage();
    saveRemoteHostSettings(
      store,
      relayRequest(store, {
        useSavedPairingCode: true,
      }),
    );
    Object.defineProperty(globalThis, "localStorage", {
      value: store,
      configurable: true,
    });
    const initialSnapshot = deferred<RemoteHostStatus | null>();
    const stale = {
      ...ready,
      hostId: "pre-forget-snapshot",
      pairingCode: "",
      savedPairingCode: true,
    };
    let statusReads = 0;
    backend.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_host_status") {
        statusReads += 1;
        return statusReads === 1 ? initialSnapshot.promise : null;
      }
      if (command === "remote_host_forget_pairing_code") {
        return {
          cleanupWarning: null,
          cleanupPending: false,
        } satisfies ForgetResult;
      }
      throw new Error(`unexpected command: ${command}`);
    });
    let api: RemoteHostApi | undefined;
    function Harness() {
      api = useRemoteHost(false);
      return null;
    }
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {
      await vi.waitFor(() => expect(statusReads).toBe(1));
    });

    await act(async () => {
      await api!.removeSavedPairingCode();
    });
    expect(api?.status).toBeNull();
    await act(async () => {
      initialSnapshot.resolve(stale);
      await initialSnapshot.promise;
    });

    expect(api?.status).toBeNull();
    expect(api?.configuration?.useSavedPairingCode).toBe(false);
    expect(loadRemoteHostSettings(store).useSavedPairingCode).toBe(false);
    await act(async () => {
      root.unmount();
    });
  });
  it("surfaces a pending secure-storage cleanup warning after forget", async () => {
    const container = hookContainer();
    const store = storage();
    saveRemoteHostSettings(
      store,
      relayRequest(store, { useSavedPairingCode: true }),
    );
    Object.defineProperty(globalThis, "localStorage", {
      value: store,
      configurable: true,
    });
    const active = { ...ready, pairingCode: "", savedPairingCode: true };
    const forgotten = { ...active, savedPairingCode: false };
    let statusReads = 0;
    backend.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_host_status") {
        statusReads += 1;
        return statusReads === 1 ? active : forgotten;
      }
      if (command === "remote_host_forget_pairing_code") {
        return {
          cleanupWarning: "encrypted vault is locked",
          cleanupPending: true,
        } satisfies ForgetResult;
      }
      throw new Error(`unexpected command: ${command}`);
    });
    let api: RemoteHostApi | undefined;
    function Harness() {
      api = useRemoteHost(false);
      return null;
    }
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {});

    await act(async () => {
      await api!.removeSavedPairingCode();
    });
    expect(api?.status).toEqual(forgotten);
    expect(api?.closedReason).toContain(
      "secure-storage cleanup is still pending: encrypted vault is locked",
    );
    expect(api?.configuration?.useSavedPairingCode).toBe(false);
    await act(async () => {
      root.unmount();
    });
  });
  it("fails the active saved-password badge closed when status refresh fails", async () => {
    const container = hookContainer();
    const store = storage();
    saveRemoteHostSettings(
      store,
      relayRequest(store, { useSavedPairingCode: true }),
    );
    Object.defineProperty(globalThis, "localStorage", {
      value: store,
      configurable: true,
    });
    const active = {
      ...ready,
      pairingCode: "stale-memory-password",
      savedPairingCode: true,
    };
    let statusReads = 0;
    backend.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_host_status") {
        statusReads += 1;
        if (statusReads === 1) return active;
        throw new Error("status bridge unavailable");
      }
      if (command === "remote_host_forget_pairing_code") {
        return {
          cleanupWarning: null,
          cleanupPending: false,
        } satisfies ForgetResult;
      }
      throw new Error(`unexpected command: ${command}`);
    });
    let api: RemoteHostApi | undefined;
    function Harness() {
      api = useRemoteHost(false);
      return null;
    }
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {});

    await act(async () => {
      await api!.removeSavedPairingCode();
    });
    expect(api?.status).toMatchObject({
      hostId: active.hostId,
      pairingCode: "",
      savedPairingCode: false,
    });
    expect(api?.configuration?.useSavedPairingCode).toBe(false);
    expect(api?.closedReason).toContain(
      "active sharing status could not be refreshed: status bridge unavailable",
    );
    await act(async () => {
      root.unmount();
    });
  });
  it("does not resurrect a host closed during forget status confirmation", async () => {
    const container = hookContainer();
    const store = storage();
    saveRemoteHostSettings(
      store,
      relayRequest(store, { useSavedPairingCode: true }),
    );
    Object.defineProperty(globalThis, "localStorage", {
      value: store,
      configurable: true,
    });
    const active = { ...ready, pairingCode: "", savedPairingCode: true };
    const confirmation = deferred<RemoteHostStatus | null>();
    let statusReads = 0;
    backend.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_host_status") {
        statusReads += 1;
        return statusReads === 1 ? active : confirmation.promise;
      }
      if (command === "remote_host_forget_pairing_code") {
        return {
          cleanupWarning: null,
          cleanupPending: false,
        } satisfies ForgetResult;
      }
      throw new Error(`unexpected command: ${command}`);
    });
    let api: RemoteHostApi | undefined;
    function Harness() {
      api = useRemoteHost(false);
      return null;
    }
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {});

    let forgetRequest!: Promise<void>;
    act(() => {
      forgetRequest = api!.removeSavedPairingCode();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(statusReads).toBe(2);
    await act(async () => {
      backend.listeners.get("remote-host://closed")?.({
        payload: {
          hostId: active.hostId,
          reason: "restored backup stopped sharing",
        },
      });
      confirmation.resolve(active);
      await forgetRequest;
    });
    expect(api?.status).toBeNull();
    expect(api?.configuration?.useSavedPairingCode).toBe(false);
    expect(api?.closedReason).toBe("restored backup stopped sharing");
    await act(async () => {
      root.unmount();
    });
  });
  it("keeps delete configuring and rejects a concurrent settings start", async () => {
    const container = hookContainer();
    const store = storage();
    saveRemoteHostSettings(store, {
      ...loadRemoteHostSettings(store),
      mode: "relay",
      relayAddress: "wss://relay.example.test",
      useSavedPairingCode: true,
    });
    Object.defineProperty(globalThis, "localStorage", {
      value: store,
      configurable: true,
    });
    const deleting = deferred<ForgetResult>();
    backend.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_host_status") return null;
      if (command === "remote_host_forget_pairing_code")
        return deleting.promise;
      if (command === "remote_host_configure") return ready;
      throw new Error(`unexpected command: ${command}`);
    });
    let api: RemoteHostApi | undefined;
    function Harness() {
      api = useRemoteHost(false);
      return null;
    }
    const root = createRoot(container as unknown as Element);
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {});

    let deleteRequest!: Promise<void>;
    act(() => {
      deleteRequest = api!.removeSavedPairingCode();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(api?.configuring).toBe(true);
    await expect(api!.start(loadRemoteHostSettings(store))).rejects.toThrow(
      "Sharing settings are being applied.",
    );
    expect(
      backend.invoke.mock.calls.filter(
        (call) => call[0] === "remote_host_configure",
      ),
    ).toHaveLength(0);

    await act(async () => {
      deleting.resolve({ cleanupWarning: null, cleanupPending: false });
      await deleteRequest;
    });
    expect(api?.configuring).toBe(false);
    expect(api?.configuration?.useSavedPairingCode).toBe(false);
    await act(async () => {
      root.unmount();
    });
  });
  it("keeps automatic reuse disabled when native credential deletion fails", async () => {
    const container = hookContainer();
    const store = storage();
    saveRemoteHostSettings(store, {
      ...loadRemoteHostSettings(store),
      mode: "relay",
      relayAddress: "wss://relay.example.test",
      useSavedPairingCode: true,
    });
    Object.defineProperty(globalThis, "localStorage", {
      value: store,
      configurable: true,
    });
    backend.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_host_status") return null;
      if (command === "remote_host_forget_pairing_code") {
        throw new Error("vault is locked");
      }
      throw new Error(`unexpected command: ${command}`);
    });
    let api: RemoteHostApi | undefined;
    function Harness() {
      api = useRemoteHost(false);
      return null;
    }
    const root = createRoot(container as unknown as Element);
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {});

    await act(async () => {
      await expect(api!.removeSavedPairingCode()).rejects.toThrow(
        "Standby password reuse was turned off",
      );
    });
    expect(api?.configuration?.useSavedPairingCode).toBe(false);
    expect(loadRemoteHostSettings(store).useSavedPairingCode).toBe(false);
    expect(api?.closedReason).toContain(
      "could not disable the saved host password",
    );
    expect(api?.configuring).toBe(false);
    await act(async () => {
      root.unmount();
    });
  });
  it("retries pending secure-storage cleanup through the dedicated command", async () => {
    const container = hookContainer();
    const store = storage();
    Object.defineProperty(globalThis, "localStorage", {
      value: store,
      configurable: true,
    });
    backend.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_host_status") return null;
      if (command === "remote_host_retry_pairing_code_cleanup") {
        return {
          cleanupWarning: null,
          cleanupPending: false,
        } satisfies ForgetResult;
      }
      throw new Error(`unexpected command: ${command}`);
    });
    let api: RemoteHostApi | undefined;
    function Harness() {
      api = useRemoteHost(false);
      return null;
    }
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {});

    await act(async () => {
      await api!.retrySavedPairingCodeCleanup();
    });
    expect(backend.invoke).toHaveBeenCalledWith(
      "remote_host_retry_pairing_code_cleanup",
    );
    expect(api?.closedReason).toBeNull();
    expect(api?.configuring).toBe(false);
    await act(async () => {
      root.unmount();
    });
  });
  it("keeps cleanup pending and exposes the retry failure detail", async () => {
    const container = hookContainer();
    const store = storage();
    Object.defineProperty(globalThis, "localStorage", {
      value: store,
      configurable: true,
    });
    backend.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_host_status") return null;
      if (command === "remote_host_retry_pairing_code_cleanup") {
        return {
          cleanupWarning: "unlock the previous keyring",
          cleanupPending: true,
        } satisfies ForgetResult;
      }
      throw new Error(`unexpected command: ${command}`);
    });
    let api: RemoteHostApi | undefined;
    function Harness() {
      api = useRemoteHost(false);
      return null;
    }
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {});

    await act(async () => {
      await expect(api!.retrySavedPairingCodeCleanup()).rejects.toThrow(
        "Secure-storage cleanup is still pending: unlock the previous keyring",
      );
    });
    expect(api?.closedReason).toContain("unlock the previous keyring");
    expect(api?.configuring).toBe(false);
    await act(async () => {
      root.unmount();
    });
  });
  it("disables saved-password standby on a credential reset with no active host", async () => {
    const container = hookContainer();
    const store = storage();
    saveRemoteHostSettings(
      store,
      relayRequest(store, { useSavedPairingCode: true }),
    );
    Object.defineProperty(globalThis, "localStorage", {
      value: store,
      configurable: true,
    });
    backend.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_host_status") return null;
      throw new Error(`unexpected command: ${command}`);
    });
    let api: RemoteHostApi | undefined;
    function Harness() {
      api = useRemoteHost(false);
      return null;
    }
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {});
    expect(api?.status).toBeNull();
    expect(api?.configuration?.useSavedPairingCode).toBe(true);

    await act(async () => {
      backend.listeners.get("remote-host://credential-reset")?.({
        payload: null,
      });
    });
    expect(api?.status).toBeNull();
    expect(api?.configuration).toMatchObject({
      pairingCode: "",
      useSavedPairingCode: false,
      rememberPairingCode: false,
    });
    expect(loadRemoteHostSettings(store).useSavedPairingCode).toBe(false);
    await act(async () => {
      root.unmount();
    });
  });
  it("keeps a revoked host unsaved when an older status event arrives later", async () => {
    const container = hookContainer();
    const store = storage();
    saveRemoteHostSettings(
      store,
      relayRequest(store, {
        useSavedPairingCode: true,
      }),
    );
    Object.defineProperty(globalThis, "localStorage", {
      value: store,
      configurable: true,
    });
    const active = {
      ...ready,
      hostId: "revoked-active-host",
      pairingCode: "",
      savedPairingCode: true,
    };
    backend.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_host_status") return active;
      throw new Error(`unexpected command: ${command}`);
    });
    let api: RemoteHostApi | undefined;
    function Harness() {
      api = useRemoteHost(false);
      return null;
    }
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {
      await vi.waitFor(() => expect(api?.status).toEqual(active));
    });

    await act(async () => {
      backend.listeners.get("remote-host://credential-reset")?.({
        payload: { hostId: active.hostId },
      });
      backend.listeners.get("remote-host://status")?.({ payload: active });
    });

    expect(api?.status).toMatchObject({
      hostId: active.hostId,
      pairingCode: "",
      savedPairingCode: false,
    });
    expect(api?.configuration?.useSavedPairingCode).toBe(false);
    await act(async () => {
      root.unmount();
    });
  });
  it("starts once after hydration and resumes standby after the engine ends", async () => {
    vi.useFakeTimers();
    const container = hookContainer();
    const store = storage();
    Object.defineProperty(globalThis, "localStorage", {
      value: store,
      configurable: true,
    });
    let current: RemoteHostStatus | null = null;
    backend.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_host_status") return current;
      if (command === "remote_host_configure") {
        current = ready;
        return ready;
      }
      throw new Error(`unexpected command: ${command}`);
    });
    let api: RemoteHostApi | undefined;
    function Harness() {
      api = useRemoteHost(true);
      return null;
    }
    const root = createRoot(container as unknown as Element);
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(
      backend.invoke.mock.calls.filter(
        (call) => call[0] === "remote_host_configure",
      ),
    ).toHaveLength(1);
    expect(api?.status?.hostId).toBe("host");
    expect(
      backend.invoke.mock.calls.find(
        (call) => call[0] === "remote_host_configure",
      )?.[1].request.bindAddress,
    ).toBe("");
    await act(async () => {
      current = null;
      backend.listeners.get("remote-host://closed")?.({
        payload: { hostId: "host", reason: "peer left" },
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(
      backend.invoke.mock.calls.filter(
        (call) => call[0] === "remote_host_configure",
      ),
    ).toHaveLength(2);
    await act(async () => {
      root.unmount();
    });
  });
  it("backs off repeated startup failures instead of spawning in a tight loop", async () => {
    vi.useFakeTimers();
    const container = hookContainer();
    Object.defineProperty(globalThis, "localStorage", {
      value: storage(),
      configurable: true,
    });
    backend.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_host_status") return null;
      throw new Error("engine unavailable");
    });
    function Harness() {
      useRemoteHost(true);
      return null;
    }
    const root = createRoot(container as unknown as Element);
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(
      backend.invoke.mock.calls.filter(
        (call) => call[0] === "remote_host_configure",
      ),
    ).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(29998);
    });
    expect(
      backend.invoke.mock.calls.filter(
        (call) => call[0] === "remote_host_configure",
      ),
    ).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3);
    });
    expect(
      backend.invoke.mock.calls.filter(
        (call) => call[0] === "remote_host_configure",
      ),
    ).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(
      backend.invoke.mock.calls.filter(
        (call) => call[0] === "remote_host_configure",
      ),
    ).toHaveLength(3);
    await act(async () => {
      root.unmount();
    });
  });
  it("keeps mobile/viewer-only startup passive", async () => {
    const container = hookContainer();
    Object.defineProperty(globalThis, "localStorage", {
      value: storage(),
      configurable: true,
    });
    backend.invoke.mockResolvedValue(null);
    function Harness() {
      useRemoteHost(false);
      return null;
    }
    const root = createRoot(container as unknown as Element);
    await act(async () => {
      root.render(<Harness />);
    });
    expect(
      backend.invoke.mock.calls.filter(
        (call) => call[0] === "remote_host_configure",
      ),
    ).toHaveLength(0);
    await act(async () => {
      root.unmount();
    });
  });
});
