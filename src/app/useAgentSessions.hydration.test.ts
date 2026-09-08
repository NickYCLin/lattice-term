import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSession } from "./testFixtures/agentApis";
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
