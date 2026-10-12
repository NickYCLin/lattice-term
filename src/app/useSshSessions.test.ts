import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSshSessions, type ConnectRequest } from "./useSshSessions";

const host = vi.hoisted(() => ({
  state: [] as unknown[], refs: [] as { current: unknown }[], stateIndex: 0, refIndex: 0, mounted: false,
  effects: [] as (() => void | (() => void))[], cleanup: [] as (() => void)[],
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  listenFailure: false,
}));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const index = host.stateIndex++;
    if (!host.mounted) host.state[index] = initial;
    return [host.state[index], (value: unknown) => {
      host.state[index] = typeof value === "function" ? value(host.state[index]) : value;
    }];
  },
  useRef: (initial: unknown) => {
    const index = host.refIndex++;
    if (!host.mounted) host.refs[index] = { current: initial };
    return host.refs[index];
  },
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void)) => { if (!host.mounted) host.effects.push(effect); },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: host.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, callback: (event: { payload: unknown }) => void) => {
    if (host.listenFailure) throw new Error("Listener unavailable");
    host.listeners.set(name, callback);
    return () => host.listeners.delete(name);
  },
}));

function render() {
  host.stateIndex = 0;
  host.refIndex = 0;
  const result = useSshSessions();
  if (!host.mounted) {
    host.mounted = true;
    for (const effect of host.effects) {
      const cleanup = effect();
      if (cleanup) host.cleanup.push(cleanup);
    }
  }
  return result;
}
const request: ConnectRequest = { profileId: "host", hostname: "example.test", port: 22, username: "tester",
  auth: { kind: "password", password: "fixture-only" }, useSavedPassword: false, rememberPassword: false, cols: 80, rows: 24 };
function closed(reason: string) { host.listeners.get("ssh://closed")!({ payload: {sessionId: "session-3", reason} }); }

beforeEach(() => {
  host.state = []; host.refs = []; host.effects = []; host.cleanup = []; host.listeners.clear();
  host.mounted = false; host.listenFailure = false; host.invoke.mockReset();
  host.invoke.mockImplementation(async command => command === "ssh_sessions" ? [] : {outcome: "connected", sessionId: "session-3"});
});
afterEach(() => { for (const cleanup of host.cleanup) cleanup(); });

describe("SSH session lifecycle", () => {
  it("registers close events before starting a connection", async () => {
    host.invoke.mockImplementation(async command => {
      if (command === "ssh_connect") {
        expect(host.listeners.has("ssh://closed")).toBe(true);
        expect(host.listeners.has("ssh://data")).toBe(true);
        return {outcome: "connected", sessionId: "session-3"};
      }
      return [];
    });
    expect(await render().connect(request)).toEqual({outcome: "connected", sessionId: "session-3"});
  });

  it("does not resurrect a connection that closed before its response arrived", async () => {
    host.invoke.mockImplementation(async command => {
      if (command === "ssh_connect") {
        closed("SSH transport error: reset");
        return {outcome: "connected", sessionId: "session-3"};
      }
      return [];
    });
    const outcome = await render().connect(request);
    expect(outcome).toEqual({outcome: "failed", stage: "channel", detail: "SSH transport error: reset"});
    expect(render().sessions).toEqual([]);
    expect(render().lastClosed).toMatchObject({label: "tester@example.test", reason: "SSH transport error: reset"});
  });

  it("keeps the host label when close arrives before React renders the connected tab", async () => {
    const api = render();
    await api.connect(request);
    closed("exit status 0");
    expect(render().lastClosed).toMatchObject({label: "tester@example.test", reason: "exit status 0"});
    expect(render().sessions).toEqual([]);
  });

  it("does not warn when the user closes the session", async () => {
    host.invoke.mockImplementation(async command => {
      if (command === "ssh_disconnect") { closed("disconnected"); return; }
      if (command === "ssh_sessions") return [];
      return {outcome: "connected", sessionId: "session-3"};
    });
    await render().connect(request);
    await render().disconnect("session-3");
    expect(render().lastClosed).toBeNull();
    expect(render().sessions).toEqual([]);
  });

  it("fails without starting SSH when close events cannot be registered", async () => {
    host.listenFailure = true;
    expect(await render().connect(request)).toMatchObject({outcome: "failed", stage: "events"});
    expect(host.invoke).not.toHaveBeenCalledWith("ssh_connect", expect.anything());
  });
});
