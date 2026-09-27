import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import {
  useRemoteSessions,
  type RemoteConnectOutcome,
  type RemoteConnectRequest,
} from "./useRemoteSessions";

const { invoke, listeners } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  },
}));

const request: RemoteConnectRequest = {
  profileId: "mac",
  hostname: "",
  port: 0,
  pairingCode: "123456789",
  rememberPairingCode: true,
  deviceId: "008806370",
  relayAddress: "relay.example",
};

function connected(sessionId: string): RemoteConnectOutcome {
  return {
    outcome: "connected",
    sessionId,
    profileId: "mac",
    host: "relay.example",
    port: 0,
    viaRelay: true,
    agentName: "Mac",
    width: 0,
    height: 0,
    viewOnly: false,
    fileTransfer: false,
    fileRootLabel: "",
    terminal: false,
  };
}

let connects: Array<RemoteConnectOutcome> = [];
let connectRequests: RemoteConnectRequest[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  connects = [];
  connectRequests = [];
  invoke.mockImplementation(async (command: string, args?: { request?: RemoteConnectRequest }) => {
    if (command === "remote_connect") {
      connectRequests.push(args!.request!);
      return connects.shift() ?? { outcome: "failed", stage: "connect", detail: "unreachable" };
    }
    return [];
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  listeners.clear();
});

async function mount() {
  const root = createRoot(installFakeDom() as unknown as Element);
  const api = { current: null as unknown as ReturnType<typeof useRemoteSessions> };
  function Probe() {
    api.current = useRemoteSessions();
    return null;
  }
  await act(async () => { root.render(<Probe />); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  connects.push(connected("remote-1"));
  await act(async () => { await api.current.connect(request); });
  expect(api.current.sessions.map((session) => session.sessionId)).toEqual(["remote-1"]);
  return { root, api };
}

async function drop(sessionId: string) {
  await act(async () => {
    listeners.get("remote://closed")!({ payload: { sessionId, reason: "host restarted sharing" } });
  });
}

it("reconnects with the saved pairing code after the host drops the share", async () => {
  const { root, api } = await mount();
  await drop("remote-1");
  expect(api.current.lastClosed?.reconnecting).toBe(true);
  expect(api.current.sessions).toEqual([]);

  connects.push(connected("remote-2"));
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  expect(connectRequests[connectRequests.length - 1]).toMatchObject({
    pairingCode: "",
    useSavedPairingCode: true,
    rememberPairingCode: false,
    deviceId: "008806370",
  });
  expect(api.current.sessions.map((session) => session.sessionId)).toEqual(["remote-2"]);
  expect(api.current.lastClosed).toBeNull();

  // The replacement connection comes back again after a second drop.
  connects.push(connected("remote-3"));
  await drop("remote-2");
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  expect(api.current.sessions.map((session) => session.sessionId)).toEqual(["remote-3"]);
  await act(async () => { root.unmount(); });
});

it("stops trying once the person closes the reconnecting notice", async () => {
  const { root, api } = await mount();
  await drop("remote-1");
  await act(async () => { api.current.clearLastClosed(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(200_000); });
  expect(connectRequests).toHaveLength(1);
  expect(api.current.lastClosed).toBeNull();
  expect(api.current.sessions).toEqual([]);
  await act(async () => { root.unmount(); });
});

it("explains the last failure after every automatic attempt ran out", async () => {
  const { root, api } = await mount();
  await drop("remote-1");
  await act(async () => { await vi.advanceTimersByTimeAsync(200_000); });
  expect(connectRequests).toHaveLength(6);
  expect(api.current.lastClosed).toMatchObject({
    reconnecting: false,
    reconnectFailed: true,
    reason: "unreachable",
  });
  await act(async () => { root.unmount(); });
});

it("does not retry a session the person disconnected on purpose", async () => {
  const { root, api } = await mount();
  await act(async () => { await api.current.disconnect("remote-1"); });
  await drop("remote-1");
  await act(async () => { await vi.advanceTimersByTimeAsync(200_000); });
  expect(connectRequests).toHaveLength(1);
  expect(api.current.lastClosed).toBeNull();
  await act(async () => { root.unmount(); });
});
