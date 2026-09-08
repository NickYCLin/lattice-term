import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAgentDaemon } from "./useAgentDaemon";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./nativeRuntime", () => ({ hasDesktopBackend: () => true }));

// This hook renders no DOM. A minimal host keeps the test on the real React
// effect/state path without adding a browser dependency to the test suite.
function installDom() {
  const document: Record<string, unknown> = {
    nodeType: 9,
    addEventListener() {},
    removeEventListener() {},
    activeElement: null,
  };
  const node = () => ({
    nodeType: 1,
    nodeName: "DIV",
    tagName: "DIV",
    ownerDocument: document,
    style: {},
    childNodes: [],
    firstChild: null,
    textContent: "",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    appendChild() {},
    removeChild() {},
    insertBefore() {},
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    removeAttribute() {},
  });
  document.createElement = node;
  document.createTextNode = (text: string) => ({ nodeType: 3, textContent: text });
  document.documentElement = node();
  document.body = node();
  document.defaultView = globalThis;
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", globalThis);
  for (const name of ["HTMLElement", "Element", "Node", "HTMLIFrameElement", "Event", "Text", "Comment"]) {
    vi.stubGlobal(name, class {});
  }
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return node() as unknown as Element;
}

type Shared = { sessionId: string; control: boolean; readOutput?: boolean; activity?: null };
type Backend = { mcpOutputScopes?: boolean; shared: Shared[] };
type Api = ReturnType<typeof useAgentDaemon>;
let root: Root | undefined;

async function mount(backend: Backend): Promise<() => Api> {
  invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "agent_daemon_status") {
      return { running: true, mcpNeedsRestart: false, sessions: 1, mcp: null, ...structuredClone(backend) };
    }
    if (command === "agent_mcp_share") {
      const sessionId = args?.sessionId as string;
      const current = backend.shared.find((entry) => entry.sessionId === sessionId);
      backend.shared = backend.shared.filter((entry) => entry.sessionId !== sessionId);
      if (args?.shared) {
        backend.shared.push({ sessionId, control: false, ...current, readOutput: args.readOutput as boolean });
      }
      return structuredClone(backend.shared);
    }
    if (command === "agent_mcp_control") {
      backend.shared = backend.shared.map((entry) => entry.sessionId === args?.sessionId
        ? { ...entry, control: args.control as boolean } : entry);
      return structuredClone(backend.shared);
    }
    throw new Error(`Unexpected fixture command: ${command}`);
  });
  let api: Api | undefined;
  function Probe() {
    api = useAgentDaemon(1);
    return null;
  }
  const element = installDom();
  const { createRoot } = await import("react-dom/client");
  root = createRoot(element);
  await act(async () => { root?.render(<Probe />); });
  await act(async () => { await api?.refresh(); });
  return () => {
    if (!api) throw new Error("Hook did not mount");
    return api;
  };
}

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = undefined;
  vi.unstubAllGlobals();
  invoke.mockReset();
});

describe("MCP content permission negotiation", () => {
  it("creates a new metadata-only share in one request", async () => {
    const current = await mount({ mcpOutputScopes: true, shared: [] });
    await act(async () => { await current().share("agent-bg-session-1", true); });
    expect(invoke).toHaveBeenCalledWith("agent_mcp_share", {
      sessionId: "agent-bg-session-1", shared: true, readOutput: false,
    });
    expect(current().status.shared).toEqual([
      { sessionId: "agent-bg-session-1", control: false, readOutput: false },
    ]);
    expect(invoke.mock.calls.filter(([command]) => command === "agent_mcp_share")).toHaveLength(1);
  });

  it("changes content access without withdrawing the independent control grant", async () => {
    const current = await mount({ mcpOutputScopes: true, shared: [
      { sessionId: "agent-bg-session-1", control: true, readOutput: false, activity: null },
    ] });
    for (const readOutput of [true, false]) {
      await act(async () => { await current().share("agent-bg-session-1", true, readOutput); });
      expect(invoke).toHaveBeenCalledWith("agent_mcp_share", {
        sessionId: "agent-bg-session-1", shared: true, readOutput,
      });
      expect(current().status.shared[0]).toMatchObject({ control: true, readOutput, activity: null });
    }
    expect(invoke.mock.calls.some(([command]) => command === "agent_mcp_control")).toBe(false);
    await act(async () => { await current().control("agent-bg-session-1", false); });
    expect(current().status.shared[0]).toMatchObject({ control: false, readOutput: false });
  });

  it.each([undefined, false])("does not send output scopes to an old daemon (%s), but still revokes", async (mcpOutputScopes) => {
    const current = await mount({ mcpOutputScopes, shared: [{ sessionId: "agent-bg-session-1", control: true }] });
    expect(current().status.mcpOutputScopes).toBe(false);
    expect(current().status.shared[0].readOutput).toBe(true);
    await expect(current().share("agent-bg-session-2", true)).rejects.toThrow("Restart");
    await expect(current().share("agent-bg-session-1", true, false)).rejects.toThrow("Restart");
    expect(invoke.mock.calls.some(([command]) => command === "agent_mcp_share")).toBe(false);
    await act(async () => { await current().share("agent-bg-session-1", false); });
    expect(invoke).toHaveBeenCalledWith("agent_mcp_share", { sessionId: "agent-bg-session-1", shared: false });
    expect(current().status.shared).toEqual([]);
    expect(invoke.mock.calls.some(([command]) => command === "agent_daemon_stop")).toBe(false);
  });
});
