import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useAgentMcpAccess } from "./useAgentMcpAccess";
import { AGENT_MCP_PREFERENCES_KEY } from "./agentMcpPreferences";
import { fakeSession, installFakeStorage } from "./testFixtures/agentApis";
import type { AgentSessionSummary } from "./useAgentSessions";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./nativeRuntime", () => ({ hasDesktopBackend: () => true }));

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

type Api = ReturnType<typeof useAgentMcpAccess>;
type Backend = { shared: { sessionId: string; readOutput: boolean; control: boolean }[]; failControl?: boolean };
let mountedRoot: Root | undefined;
let restoreStorage: (() => void) | undefined;

async function mount(backend: Backend, initialSessions: AgentSessionSummary[]) {
  let sessions = initialSessions;
  let api: Api;
  invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "agent_daemon_status") return { running: true, mcpNeedsRestart: false, mcpOutputScopes: true, sessions: 1, shared: structuredClone(backend.shared) };
    if (command === "agent_mcp_share") {
      const previous = backend.shared.find(entry => entry.sessionId === args?.sessionId);
      backend.shared = backend.shared.filter(entry => entry.sessionId !== args?.sessionId);
      if (args?.shared) backend.shared.push({ sessionId: args.sessionId as string, control: previous?.control ?? false, readOutput: args.readOutput as boolean });
      return backend.shared;
    }
    if (command === "agent_mcp_control") {
      if (backend.failControl) throw new Error("control unavailable");
      backend.shared = backend.shared.map(entry => entry.sessionId === args?.sessionId ? { ...entry, control: args.control as boolean } : entry);
      return backend.shared;
    }
    throw new Error(command);
  });
  function Probe() { api = useAgentMcpAccess(sessions, true); return null; }
  const element = installDom();
  const { createRoot } = await import("react-dom/client");
  mountedRoot = createRoot(element);
  await act(async () => { mountedRoot!.render(<Probe />); });
  await act(async () => { await api!.daemon.refresh(); });
  return {
    current: () => api!,
    rerender: async (next: AgentSessionSummary[]) => { sessions = next; await act(async () => { mountedRoot!.render(<Probe />); }); },
    unmount: async () => { await act(async () => { mountedRoot!.unmount(); }); mountedRoot = undefined; },
  };
}

afterEach(async () => {
  await act(async () => { mountedRoot?.unmount(); });
  mountedRoot = undefined;
  restoreStorage?.(); restoreStorage = undefined;
  vi.unstubAllGlobals(); invoke.mockReset();
});

it("restores a sharing choice after restart only when the native session matches", async () => {
  restoreStorage = installFakeStorage();
  const backend: Backend = { shared: [] };
  const original = fakeSession({ capturedSessionId: "native-1" });
  const first = await mount(backend, [original]);
  await act(async () => { await first.current().setAccess(original.sessionId, "full"); });
  await first.unmount();
  backend.shared = [];
  invoke.mockClear();
  const restored = { ...original, sessionId: "new-runtime", restoreExistingSession: true, capturedSessionId: null };
  const second = await mount(backend, [restored]);
  expect(invoke.mock.calls.some(([command]) => command === "agent_mcp_share")).toBe(false);
  await second.rerender([{ ...restored, capturedSessionId: "native-1" }]);
  await act(async () => { await vi.waitFor(() => expect(backend.shared).toEqual([{ sessionId: "new-runtime", readOutput: true, control: true }])); });
  backend.shared = [];
  invoke.mockClear();
  await act(async () => { await second.current().daemon.refresh(); });
  expect(invoke.mock.calls.some(([command]) => command === "agent_mcp_share")).toBe(false);
});

it("does not apply a saved share to a fresh fallback and keeps off after another restart", async () => {
  restoreStorage = installFakeStorage();
  const backend: Backend = { shared: [] };
  const session = fakeSession({ capturedSessionId: "native-1" });
  const first = await mount(backend, [session]);
  await act(async () => { await first.current().setAccess(session.sessionId, "view"); });
  await first.unmount(); backend.shared = []; invoke.mockClear();
  const fresh = await mount(backend, [{ ...session, sessionId: "fresh", restoreExistingSession: false }]);
  expect(invoke.mock.calls.some(([command]) => command === "agent_mcp_share")).toBe(false);
  await fresh.unmount();
  const original = await mount(backend, [session]);
  await act(async () => { await original.current().setAccess(session.sessionId, "off"); });
  await original.unmount(); invoke.mockClear();
  await mount(backend, [{ ...session, sessionId: "resumed", restoreExistingSession: true }]);
  expect(invoke.mock.calls.some(([command]) => command === "agent_mcp_share")).toBe(false);
  expect(backend.shared).toEqual([]);
});

it("reports a failed restore and retries without granting control implicitly", async () => {
  restoreStorage = installFakeStorage();
  const backend: Backend = { shared: [] };
  const session = fakeSession({ capturedSessionId: "native-1" });
  const first = await mount(backend, [session]);
  await act(async () => { await first.current().setAccess(session.sessionId, "full"); });
  await first.unmount(); backend.shared = []; backend.failControl = true;
  const second = await mount(backend, [{ ...session, sessionId: "resumed", restoreExistingSession: true }]);
  await act(async () => { await vi.waitFor(() => expect(second.current().failures.resumed).toContain("control unavailable")); });
  expect(backend.shared[0].control).toBe(false);
  backend.failControl = false;
  await act(async () => { second.current().retry("resumed"); });
  await act(async () => { await vi.waitFor(() => expect(backend.shared[0].control).toBe(true)); });
  expect(second.current().failures).toEqual({});
});

it("serializes a late restore and an explicit off without leaving a control grant", async () => {
  restoreStorage = installFakeStorage();
  const backend: Backend = { shared: [] };
  const session = fakeSession({ capturedSessionId: "native-1" });
  const first = await mount(backend, [session]);
  await act(async () => { await first.current().setAccess(session.sessionId, "full"); });
  await first.unmount(); backend.shared = [];
  const second = await mount(backend, [session]);
  let release!: () => void;
  const previousInvoke = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, args) => {
    if (command === "agent_mcp_share" && args.shared) await new Promise<void>(resolve => { release = resolve; });
    return previousInvoke(command, args);
  });
  let enabling!: Promise<void>;
  let disabling!: Promise<void>;
  await act(async () => {
    enabling = second.current().setAccess(session.sessionId, "full");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    disabling = second.current().setAccess(session.sessionId, "off");
    release();
    await Promise.all([enabling, disabling]);
  });
  expect(backend.shared).toEqual([]);
  expect(JSON.parse(localStorage.getItem(AGENT_MCP_PREFERENCES_KEY)!).entries).toEqual([]);
});

it("preserves metadata-only legacy grants and refuses automatic restore of corrupt preferences", async () => {
  restoreStorage = installFakeStorage();
  const backend: Backend = { shared: [{ sessionId: "s1", control: false, readOutput: false }] };
  const original = fakeSession({ capturedSessionId: "native-1" });
  const first = await mount(backend, [original]);
  expect(JSON.parse(localStorage.getItem(AGENT_MCP_PREFERENCES_KEY)!).entries[0]).toMatchObject({ access: "view", readOutput: false });
  await first.unmount(); backend.shared = [];
  const second = await mount(backend, [{ ...original, sessionId: "new", restoreExistingSession: true }]);
  expect(backend.shared).toEqual([{ sessionId: "new", control: false, readOutput: false }]);
  await second.unmount(); backend.shared = []; invoke.mockClear();
  localStorage.setItem(AGENT_MCP_PREFERENCES_KEY, "broken json");
  const corrupt = await mount(backend, [original]);
  expect(invoke.mock.calls.some(([command]) => command === "agent_mcp_share")).toBe(false);
  await expect(corrupt.current().setAccess(original.sessionId, "full")).rejects.toThrow();
});
