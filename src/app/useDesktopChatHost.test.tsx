import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import { fakeChatApi, fakeThread } from "./testFixtures/agentApis";
import { desktopChatAccess as access } from "./desktopChat";
import { useDesktopChatHost } from "./useDesktopChatHost";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("./nativeRuntime", () => ({ hasDesktopBackend: () => true }));
vi.mock("./chatAccountProfiles", () => ({ loadChatAccountProfiles: () => [] }));
let event: (event: { payload: string }) => void;
const dispose = vi.fn();
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("localStorage", {});
  access.reset(null); access.pending.clear(); access.drafts.clear();
  listen.mockImplementation(async (_name, callback) => { event = callback; return dispose; });
  invoke.mockImplementation(async (name, args) => {
    if (name === "mcp_chat_open") return "runtime";
    if (name === "mcp_chat_heartbeat") return ["target"];
    if (name === "mcp_chat_share") return args.request.read || args.request.control ? { id: "target" } : null;
    if (name === "mcp_chat_claim") return { id: "request", targetId: "target", threadId: "original", action: { kind: "send", text: "fixture", requestId: "once" } };
    return null;
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); access.reset(null); });

it("registers without sharing, then sends only to an explicitly shared original thread", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  const thread = fakeThread({ id: "original" }); const send = vi.fn(async () => {});
  const chat = fakeChatApi({ threads: [thread], send });
  function Probe() { useDesktopChatHost(chat); return null; }
  try {
    await act(async () => { root.render(<Probe />); });
    expect(access.grants.size).toBe(0);
    expect(invoke.mock.calls.some(([name]) => name === "mcp_chat_share")).toBe(false);
    await act(async () => { await access.share(thread, true, true); });
    await act(async () => { event({ payload: "request" }); });
    expect(send).toHaveBeenCalledExactlyOnceWith("original", "fixture", [], null);
    expect(invoke).toHaveBeenCalledWith("mcp_chat_reply", { nonce: "runtime", id: "request", value: { threadId: "original", accepted: true }, error: null });
  } finally { await act(async () => { root.unmount(); }); }
  expect(access.grants.size).toBe(0);
  expect(dispose).toHaveBeenCalled();
  expect(invoke).toHaveBeenCalledWith("mcp_chat_close", { nonce: "runtime" });
});

it("rechecks local revocation after an asynchronous backend claim", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  const thread = fakeThread({ id: "original" }); const send = vi.fn();
  const chat = fakeChatApi({ threads: [thread], send });
  function Probe() { useDesktopChatHost(chat); return null; }
  let release!: (request: unknown) => void;
  try {
    await act(async () => { root.render(<Probe />); await Promise.resolve(); });
    await act(async () => { await access.share(thread, true, true); });
    const usual = invoke.getMockImplementation()!;
    invoke.mockImplementation((name, args) => name === "mcp_chat_claim" ? new Promise(resolve => { release = resolve; }) : usual(name, args));
    await act(async () => { event({ payload: "request" }); });
    await act(async () => { await access.share(thread, false, false); });
    await act(async () => { release({ id: "request", targetId: "target", threadId: "original", action: { kind: "send", text: "must not send", requestId: "once" } }); });
    expect(send).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("mcp_chat_reply", expect.objectContaining({ error: expect.stringContaining("Sharing ended") }));
  } finally { await act(async () => { root.unmount(); }); }
});

it("fails closed when the runtime heartbeat stops", async () => {
  const root = createRoot(installFakeDom() as unknown as Element);
  const thread = fakeThread({ id: "original" }); const chat = fakeChatApi({ threads: [thread] });
  function Probe() { useDesktopChatHost(chat); return null; }
  try {
    await act(async () => { root.render(<Probe />); });
    await act(async () => { await access.share(thread, true, true); });
    invoke.mockRejectedValueOnce(new Error("disconnected"));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(access.nonce).toBeNull(); expect(access.grants.size).toBe(0);
  } finally { await act(async () => { root.unmount(); }); }
});
