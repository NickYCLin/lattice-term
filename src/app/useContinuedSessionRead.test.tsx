import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { fakeThread } from "./testFixtures/agentApis";
import { useContinuedSessionRead } from "./useContinuedSessionRead";
import type { ChatThread } from "./agentChat";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

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

let mountedRoot: Root | undefined;
async function mount(initialThread = fakeThread({ id: "one", nativeSessionId: "native-one", continuedInSession: true })) {
  let selected: ChatThread | null = initialThread;
  let live = false;
  let read: ReturnType<typeof useContinuedSessionRead>;
  const update = vi.fn();
  function Probe() { read = useContinuedSessionRead(selected, live, [], update, "終端新增的訊息", "缺少原生對話識別碼"); return null; }
  const { createRoot } = await import("react-dom/client");
  mountedRoot = createRoot(installDom());
  await act(async () => { mountedRoot!.render(<Probe />); });
  return { current: () => read!, update,
    rerender: async (thread: ChatThread | null, hasLive = false) => { selected = thread; live = hasLive; await act(async () => { mountedRoot!.render(<Probe />); }); } };
}
afterEach(async () => {
  await act(async () => { mountedRoot?.unmount(); }); mountedRoot = undefined;
  vi.unstubAllGlobals(); invoke.mockReset();
});

it("explains a missing conversation identity without guessing another session", async () => {
  const probe = await mount(fakeThread({ continuedInSession: true, nativeSessionId: null }));
  expect(probe.current()).toMatchObject({ loading: false, error: "缺少原生對話識別碼" });
  expect(invoke).not.toHaveBeenCalled();
  expect(probe.update).not.toHaveBeenCalled();
});

it("exposes loading before a terminal conversation has finished reading", async () => {
  let release!: (value: unknown) => void;
  invoke.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const probe = await mount();
  expect(probe.current()).toMatchObject({ loading: true, error: null });
  expect(invoke).toHaveBeenCalledWith("agent_chat_local_history_snapshot", { definitionId: "codex", nativeSessionId: "native-one", profileId: null, profiles: [] });
  await act(async () => { release({ messages: [{ role: "user", text: "terminal prompt" }] }); });
  expect(probe.current()).toMatchObject({ loading: false, error: null });
  expect(probe.update).toHaveBeenCalledWith("one", expect.any(Function));
});

it("keeps a failed read visible until an explicit retry", async () => {
  invoke.mockRejectedValueOnce(new Error("transcript busy")).mockResolvedValue({ messages: [] });
  const probe = await mount();
  expect(probe.current()).toMatchObject({ loading: false, error: "Error: transcript busy" });
  expect(probe.update).not.toHaveBeenCalled();
  await act(async () => { probe.current().refresh(); });
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(probe.current()).toMatchObject({ loading: false, error: null });
});

it("does not append an old read after switching conversations", async () => {
  const releases: Array<(value: unknown) => void> = [];
  invoke.mockImplementation(() => new Promise(resolve => { releases.push(resolve); }));
  const probe = await mount();
  await probe.rerender(fakeThread({ id: "two", nativeSessionId: "native-two", continuedInSession: true }));
  await act(async () => { releases[0]({ messages: [] }); });
  expect(probe.update).not.toHaveBeenCalled();
  expect(probe.current().loading).toBe(true);
  await act(async () => { releases[1]({ messages: [] }); });
  expect(probe.update).toHaveBeenCalledWith("two", expect.any(Function));
});

it("does not read a conversation while its terminal session is still attached", async () => {
  invoke.mockResolvedValue({ messages: [] });
  const thread = fakeThread({ continuedInSession: true, nativeSessionId: "native-one" });
  const probe = await mount(fakeThread());
  invoke.mockClear();
  await probe.rerender(thread, true);
  expect(probe.current()).toBeNull();
  expect(invoke).not.toHaveBeenCalled();
});
