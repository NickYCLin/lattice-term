import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDefinition, fakeSession } from "./testFixtures/agentApis";
import { useAgentSessions } from "./useAgentSessions";

// A small hook host keeps state and effects across renders without requiring
// a browser. The native commands and events remain independently controlled,
// so these tests exercise the startup/permission races seen by the real hook.
const host = vi.hoisted(() => ({
  state: [] as unknown[],
  refs: [] as { current: unknown }[],
  stateIndex: 0,
  refIndex: 0,
  mounted: false,
  effects: [] as (() => void | (() => void))[],
  cleanup: [] as (() => void)[],
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
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
  useEffect: (effect: () => void | (() => void)) => {
    if (!host.mounted) host.effects.push(effect);
  },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: host.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, callback: (event: { payload: unknown }) => void) => {
    host.listeners.set(name, callback);
    return () => host.listeners.delete(name);
  },
}));

function render() {
  host.stateIndex = 0;
  host.refIndex = 0;
  const result = useAgentSessions();
  if (!host.mounted) {
    host.mounted = true;
    for (const effect of host.effects) {
      const cleanup = effect();
      if (cleanup) host.cleanup.push(cleanup);
    }
  }
  return result;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Agent Fleet hydration and MCP permissions", () => {
  let persistedLaunch = true;
  beforeEach(() => {
    persistedLaunch = true;
    host.state = [];
    host.refs = [];
    host.effects = [];
    host.cleanup = [];
    host.listeners.clear();
    host.mounted = false;
    host.invoke.mockReset();
    host.invoke.mockImplementation(async (command) => {
      switch (command) {
        case "agent_catalog":
        case "agent_sessions":
        case "agent_output_snapshots": return [];
        case "agent_default_working_directory": return "/workspace";
        case "agent_mcp_plans_sync": return persistedLaunch;
        case "agent_plan_snapshot": return {
          workspaceName: "Workspace",
          startupInstructions: "Saved instructions",
          mcpLaunch: persistedLaunch,
          plans: [],
          recovery: null,
        };
        default: throw new Error(`Unexpected command ${command}`);
      }
    });
  });

  it.each(["success", "failure"])("ignores an older catalog refresh finishing with %s", async outcome => {
    render();
    await vi.waitFor(() => expect(render().mode).toBe("ready"));
    const older = deferred<ReturnType<typeof fakeDefinition>[]>();
    const newest = fakeDefinition({ installed: true, label: "Newly installed" });
    const originalInvoke = host.invoke.getMockImplementation()!;
    let catalogCalls = 0;
    host.invoke.mockImplementation(async (command, args) => {
      if (command === "agent_catalog") {
        if (++catalogCalls === 1) {
          await older.promise;
          if (outcome === "failure") throw new Error("Old catalog failed");
          return [];
        }
        return [newest];
      }
      return originalInvoke(command, args);
    });
    const pending = render().refreshCatalog();
    await vi.waitFor(() => expect(catalogCalls).toBe(1));
    await render().refreshCatalog();
    older.resolve([]);
    await pending;
    expect(render().catalog).toEqual([newest]);
    expect(render().mode).toBe("ready");
    expect(render().error).toBeNull();
  });

  it("keeps a newer catalog while still restoring sessions from startup", async () => {
    const startupCatalog = deferred<ReturnType<typeof fakeDefinition>[]>();
    const newest = fakeDefinition({ label: "Refreshed catalog" });
    const session = fakeSession();
    const originalInvoke = host.invoke.getMockImplementation()!;
    let catalogCalls = 0;
    host.invoke.mockImplementation(async (command, args) => {
      if (command === "agent_catalog") return ++catalogCalls === 1 ? startupCatalog.promise : [newest];
      if (command === "agent_sessions") return [session];
      return originalInvoke(command, args);
    });
    render();
    await vi.waitFor(() => expect(catalogCalls).toBe(1));
    await render().refreshCatalog();
    startupCatalog.resolve([]);
    await vi.waitFor(() => expect(render().sessions).toHaveLength(1));
    expect(render().catalog).toEqual([newest]);
    expect(render().sessions[0].sessionId).toBe(session.sessionId);
  });

  it("still reflects a withdrawn MCP grant when startup overlaps a catalog refresh", async () => {
    const sync = deferred<void>();
    const newest = fakeDefinition({ label: "Refreshed catalog" });
    const originalInvoke = host.invoke.getMockImplementation()!;
    host.invoke.mockImplementation(async (command, args) => {
      if (command === "agent_catalog") return [newest];
      if (command === "agent_mcp_plans_sync") {
        await sync.promise;
        persistedLaunch = false;
        throw new Error("MCP launch sync failed");
      }
      return originalInvoke(command, args);
    });
    render();
    await vi.waitFor(() => expect(host.invoke).toHaveBeenCalledWith("agent_mcp_plans_sync"));
    await render().refreshCatalog();
    expect(render().mcpLaunch).toBe(true);
    sync.resolve();
    await vi.waitFor(() => expect(render().mcpLaunch).toBe(false));
    expect(render().catalog).toEqual([newest]);
    expect(render().error).toBe("MCP launch sync failed");
  });

  it("ignores a catalog refresh that finishes after unmount", async () => {
    render();
    await vi.waitFor(() => expect(render().mode).toBe("ready"));
    const catalog = deferred<ReturnType<typeof fakeDefinition>[]>();
    const originalInvoke = host.invoke.getMockImplementation()!;
    host.invoke.mockImplementation((command, args) =>
      command === "agent_catalog" ? catalog.promise : originalInvoke(command, args));
    host.invoke.mockClear();
    const pending = render().refreshCatalog();
    await vi.waitFor(() => expect(host.invoke).toHaveBeenCalledWith("agent_catalog"));
    for (const cleanup of host.cleanup) cleanup();
    host.cleanup = [];
    const before = [...host.state];
    catalog.resolve([fakeDefinition()]);
    await pending;
    expect(host.state).toEqual(before);
  });

  it.each(["before", "after"])("retains a model-switch session when its close event arrives %s the reply", async timing => {
    render();
    await vi.waitFor(() => expect(render().mode).toBe("ready"));
    const original = fakeSession({ capturedSessionId: "native-fixture" });
    host.listeners.get("agent://launched")!({ payload: original });
    render();
    const close = () => host.listeners.get("agent://closed")!({ payload: { sessionId: original.sessionId, reason: "Exit 0" } });
    const originalInvoke = host.invoke.getMockImplementation()!;
    host.invoke.mockImplementation(async (command, args) => {
      if (command === "agent_disconnect") {
        if (timing === "before") close();
        return;
      }
      return originalInvoke(command, args);
    });
    await render().disconnect(original.sessionId, { retainSession: true });
    if (timing === "after") close();
    expect(render().sessions).toHaveLength(1);
    expect(render().sessions[0].closedReason).toBeTruthy();
    expect(render().lastClosed).toBeNull();
    await render().disconnect(original.sessionId);
    expect(render().sessions).toEqual([]);
  });

  it("releases Codex ownership before a model relaunch without waiting for a React render", async () => {
    render();
    await vi.waitFor(() => expect(render().mode).toBe("ready"));
    const original = fakeSession({ capturedSessionId: "native-fixture" });
    host.listeners.get("agent://launched")!({ payload: original });
    const api = render();
    const originalInvoke = host.invoke.getMockImplementation()!;
    host.invoke.mockImplementation(async (command, args) => {
      if (command === "agent_disconnect") return;
      if (command === "agent_launch") return { ...original, sessionId: "replacement", model: "fixture-new" };
      return originalInvoke(command, args);
    });
    await api.disconnect(original.sessionId, { retainSession: true });
    const next = await api.launch({ definitionId: "codex", label: "Fixture", executable: "codex",
      arguments: ["--model", "fixture-new"], resumeSessionId: "native-fixture",
      workingDirectory: "/work", cols: 120, rows: 32 });
    expect(next.sessionId).toBe("replacement");
    expect(render().sessions.map(session => session.sessionId)).toEqual([original.sessionId, "replacement"]);
  });

  it("keeps UTF-8 characters intact when terminal events split their bytes", async () => {
    render();
    await vi.waitFor(() => expect(render().mode).toBe("ready"));
    const tail = vi.fn();
    const stop = render().onOutputTail("s1", tail);
    const bytes = new TextEncoder().encode("處理中");
    for (let offset = 0; offset < bytes.length; offset++) {
      host.listeners.get("agent://data")!({ payload: {
        sessionId: "s1", offset, base64: btoa(String.fromCharCode(bytes[offset])),
      } });
    }
    expect(tail).toHaveBeenLastCalledWith("處理中");
    stop();
  });

  it("observes output without consuming terminal replay and keeps startup errors after exit", async () => {
    render();
    await vi.waitFor(() => expect(render().mode).toBe("ready"));
    const session = fakeSession();
    host.listeners.get("agent://launched")!({ payload: session });
    render();
    const tail = vi.fn();
    const stop = render().onOutputTail(session.sessionId, tail);
    const message = "Error: saved provider not found\r\n";
    host.listeners.get("agent://data")!({ payload: {
      sessionId: session.sessionId, offset: 0, base64: btoa(message),
    } });
    expect(tail).toHaveBeenLastCalledWith(message);
    const terminal = vi.fn();
    const stopTerminal = render().onData(session.sessionId, terminal);
    expect(new TextDecoder().decode(terminal.mock.calls[0][0])).toBe(message);
    host.listeners.get("agent://closed")!({ payload: { sessionId: session.sessionId, reason: "Exit 1" } });
    const reopened = vi.fn();
    const stopReopened = render().onOutputTail(session.sessionId, reopened);
    expect(reopened).toHaveBeenLastCalledWith(message);
    stop(); stopTerminal(); stopReopened();
  });

  afterEach(() => {
    host.cleanup.forEach((cleanup) => cleanup());
  });

  it("loads the persisted launch grant and synchronizes without opening the Fleet page", async () => {
    render();
    await vi.waitFor(() => expect(render().mode).toBe("ready"));
    expect(render().mcpLaunch).toBe(true);
    expect(host.invoke).toHaveBeenCalledWith("agent_mcp_plans_sync");
    persistedLaunch = false;
    await render().refreshCatalog();
    expect(render().mcpLaunch).toBe(false);
  });

  it("shows the withdrawn saved grant and the startup sync error", async () => {
    const original = host.invoke.getMockImplementation()!;
    host.invoke.mockImplementation(async (command, args) => {
      if (command === "agent_mcp_plans_sync") {
        persistedLaunch = false;
        throw new Error("MCP launch sync failed");
      }
      return original(command, args);
    });
    render();
    await vi.waitFor(() => expect(render().mode).toBe("ready"));
    expect(render().mcpLaunch).toBe(false);
    expect(render().error).toBe("MCP launch sync failed");
  });

  it("retains launches after the session snapshot while excluding already closed launches", async () => {
    const catalog = deferred<unknown[]>();
    const original = host.invoke.getMockImplementation()!;
    host.invoke.mockImplementation((command, args) =>
      command === "agent_catalog" ? catalog.promise : original(command, args),
    );
    render();
    await vi.waitFor(() => expect(host.invoke).toHaveBeenCalledWith("agent_sessions"));
    const launched = fakeSession({ sessionId: "agent-bg-late", detached: true });
    const closed = fakeSession({ sessionId: "agent-bg-closed", detached: true });
    host.listeners.get("agent://launched")!({ payload: launched });
    host.listeners.get("agent://launched")!({ payload: closed });
    host.listeners.get("agent://closed")!({ payload: { sessionId: closed.sessionId, reason: "Exited" } });
    catalog.resolve([]);
    await vi.waitFor(() => expect(render().mode).toBe("ready"));
    expect(render().sessions.map((session) => session.sessionId)).toEqual([launched.sessionId]);
  });

  it("refreshes saved permissions after an enable fails instead of retaining a stale checkbox", async () => {
    render();
    await vi.waitFor(() => expect(render().mode).toBe("ready"));
    const original = host.invoke.getMockImplementation()!;
    host.invoke.mockImplementation(async (command, args) => {
      if (command === "agent_workspace_mcp_launch_update") {
        persistedLaunch = false;
        throw new Error("MCP launch sync failed");
      }
      return original(command, args);
    });
    await expect(render().updateMcpLaunch(true)).rejects.toThrow("MCP launch sync failed");
    expect(render().mcpLaunch).toBe(false);
  });
});
