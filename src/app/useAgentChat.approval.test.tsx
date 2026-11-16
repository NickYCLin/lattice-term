import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import type { ChatEvent, ChatEventEnvelope } from "./agentChat";
import { useAgentChat, type AgentChatApi } from "./useAgentChat";

const { invoke, events } = vi.hoisted(() => ({
  invoke: vi.fn(),
  events: { listener: null as ((event: { payload: ChatEventEnvelope }) => void) | null },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async (name: string, listener: typeof events.listener) => {
  if (name === "agent-chat://event") events.listener = listener;
  return () => {};
} }));
vi.mock("./notificationSounds", () => ({ playCompletionSound: async () => "disabled" }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); events.listener = null; });

async function setup() {
  const container = installFakeDom();
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  invoke.mockImplementation(async command => command === "agent_chat_supported" ? ["codex"] : undefined);
  let chat!: AgentChatApi;
  function Probe() { chat = useAgentChat(); return null; }
  const root = createRoot(container as unknown as Element);
  await act(async () => { root.render(<Probe />); });
  let id = "";
  await act(async () => {
    id = chat.createThread({ definitionId: "codex", model: "", permission: "ask", workingDirectory: "" }).id;
    await chat.send(id, "fixture prompt");
  });
  const emit = async (event: ChatEvent) => {
    const turnId = chat.getThread(id)!.runningTurnId!;
    await act(async () => { events.listener!({ payload: { threadId: id, turnId, event } }); });
  };
  const approve = (requestId = "request") => emit({ kind: "approvalRequested", requestId, toolUseId: null,
    name: "Bash", summary: "fixture command", input: "{}" });
  await approve();
  return { get chat() { return chat; }, id, root, emit, approve };
}

it("sends one answer for repeated clicks and pins it to the active turn", async () => {
  const runtime = await setup();
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  invoke.mockImplementation(command => command === "agent_chat_respond" ? pending : Promise.resolve());
  let first!: Promise<void>;
  let second!: Promise<void>;
  try {
    const turnId = runtime.chat.getThread(runtime.id)!.runningTurnId;
    let settled = false;
    await act(async () => {
      first = runtime.chat.respond(runtime.id, "request", true);
      second = runtime.chat.respond(runtime.id, "request", false);
      void second.then(() => { settled = true; });
    });
    expect(settled).toBe(false);
    await act(async () => { finish(); await Promise.all([first, second]); });
    const calls = invoke.mock.calls.filter(([command]) => command === "agent_chat_respond");
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({ allow: true, expectedTurnId: turnId });
    expect(runtime.chat.getThread(runtime.id)!.items.find(item => item.type === "approval")).toMatchObject({ decision: "allowed" });
  } finally { await act(async () => { finish(); await Promise.allSettled([first, second]); runtime.root.unmount(); }); }
});

it("does not apply a late answer to a reused request id in a newer turn", async () => {
  const runtime = await setup();
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  invoke.mockImplementation(command => command === "agent_chat_respond" ? pending : Promise.resolve());
  try {
    let answer!: Promise<void>;
    await act(async () => { answer = runtime.chat.respond(runtime.id, "request", true); });
    await runtime.emit({ kind: "finished", nativeSessionId: null, usage: null, costUsd: null, durationMs: 1, error: null });
    await act(async () => { await runtime.chat.send(runtime.id, "next turn"); });
    await runtime.approve();
    await act(async () => { finish(); await answer; });
    const approvals = runtime.chat.getThread(runtime.id)!.items.filter(item => item.type === "approval");
    expect(approvals[approvals.length - 1]).toMatchObject({ decision: "pending" });
  } finally { finish(); await act(async () => { runtime.root.unmount(); }); }
});

it("rejects an outdated turn before contacting the backend", async () => {
  const runtime = await setup();
  try {
    await act(async () => {
      await expect(runtime.chat.respond(runtime.id, "request", true, undefined, "outdated-turn")).rejects.toThrow("turn changed");
    });
    expect(invoke.mock.calls.filter(([command]) => command === "agent_chat_respond")).toHaveLength(0);
  } finally { await act(async () => { runtime.root.unmount(); }); }
});

it("answers a different prompt while another answer is still pending", async () => {
  const runtime = await setup();
  await runtime.approve("other-request");
  let finish!: () => void;
  let first!: Promise<void>;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  invoke.mockImplementation((command, args) => command === "agent_chat_respond" && args.requestId === "request"
    ? pending : Promise.resolve());
  try {
    await act(async () => { first = runtime.chat.respond(runtime.id, "request", true); });
    await act(async () => { await runtime.chat.respond(runtime.id, "other-request", false); });
    expect(runtime.chat.getThread(runtime.id)!.items.filter(item => item.type === "approval")).toMatchObject([
      { decision: "pending" }, { decision: "denied" },
    ]);
    await act(async () => { finish(); await first; });
  } finally { await act(async () => { finish(); await first; runtime.root.unmount(); }); }
});

it("keeps an answered prompt from being submitted again", async () => {
  const runtime = await setup();
  try {
    await act(async () => { await runtime.chat.respond(runtime.id, "request", true); });
    await act(async () => {
      await expect(runtime.chat.respond(runtime.id, "request", false)).rejects.toThrow("no longer waiting");
    });
    expect(invoke.mock.calls.filter(([command]) => command === "agent_chat_respond")).toHaveLength(1);
  } finally { await act(async () => { runtime.root.unmount(); }); }
});

it("releases a failed answer for retry without blocking a different request", async () => {
  const runtime = await setup();
  await runtime.approve("other-request");
  let attempts = 0;
  invoke.mockImplementation((command, args) => {
    if (command === "agent_chat_respond" && args.requestId === "request" && ++attempts === 1) return Promise.reject(new Error("temporary failure"));
    return Promise.resolve();
  });
  try {
    await act(async () => { await expect(runtime.chat.respond(runtime.id, "request", true)).rejects.toThrow("temporary failure"); });
    await act(async () => {
      await Promise.all([runtime.chat.respond(runtime.id, "request", false), runtime.chat.respond(runtime.id, "other-request", true)]);
    });
    expect(attempts).toBe(2);
    expect(runtime.chat.getThread(runtime.id)!.items.filter(item => item.type === "approval")).toMatchObject([
      { decision: "denied" }, { decision: "allowed" },
    ]);
  } finally { await act(async () => { runtime.root.unmount(); }); }
});

it("offers session scope only when the native request reports it and records it after acknowledgment", async () => {
  const runtime = await setup();
  try {
    await expect(runtime.chat.respond(runtime.id, "request", true, undefined, undefined, true)).rejects.toThrow("session scope");
    await runtime.emit({ kind: "approvalRequested", requestId: "session", toolUseId: null, name: "command", summary: "npm test", input: "{}", canAllowSession: true });
    await act(async () => { await runtime.chat.respond(runtime.id, "session", true, undefined, undefined, true); });
    expect(invoke.mock.calls.find(([command]) => command === "agent_chat_respond")?.[1]).toMatchObject({ requestId: "session", allow: true, allowForSession: true });
    expect(runtime.chat.getThread(runtime.id)!.items.find(item => item.type === "approval" && item.requestId === "session")).toMatchObject({ decision: "allowed", allowedForSession: true });
  } finally { await act(async () => { runtime.root.unmount(); }); }
});

const commandApproval = (requestId: string, command = "ls -la"): ChatEvent => ({
  kind: "approvalRequested", requestId, toolUseId: null, name: "command", summary: command,
  input: JSON.stringify({ command, cwd: "/isolated/work", permissions: null, approvalContext: { command, cwd: "/isolated/work" } }), canAllowSession: true,
});

it("reuses acknowledged session approval for the identical command across turns only", async () => {
  const runtime = await setup();
  try {
    await runtime.emit(commandApproval("session-first"));
    await act(async () => { await runtime.chat.respond(runtime.id, "session-first", true, undefined, undefined, true); });
    await runtime.emit({ kind: "finished", nativeSessionId: null, usage: null, costUsd: null, durationMs: 1, error: null });
    await act(async () => { await runtime.chat.send(runtime.id, "second turn"); });
    await runtime.emit(commandApproval("session-repeat"));
    expect(invoke.mock.calls.filter(([command]) => command === "agent_chat_respond").map(([,args]) => args)).toMatchObject([
      { requestId: "session-first", allowForSession: true }, { requestId: "session-repeat", allowForSession: true },
    ]);
    await runtime.emit(commandApproval("different-command", "pwd"));
    expect(runtime.chat.getThread(runtime.id)!.items.find(item => item.type === "approval" && item.requestId === "different-command")).toMatchObject({ decision: "pending" });
    const changedPermissions = commandApproval("extra-permission");
    if (changedPermissions.kind === "approvalRequested") {
      const input = JSON.parse(changedPermissions.input);
      input.approvalContext.additionalPermissions = { network: { enabled: true } };
      changedPermissions.input = JSON.stringify(input);
    }
    await runtime.emit(changedPermissions);
    expect(runtime.chat.getThread(runtime.id)!.items.find(item => item.type === "approval" && item.requestId === "extra-permission")).toMatchObject({ decision: "pending" });
    expect(invoke.mock.calls.filter(([command]) => command === "agent_chat_respond")).toHaveLength(2);
  } finally { await act(async () => runtime.root.unmount()); }
});

it("does not cache a failed session answer", async () => {
  const runtime = await setup();
  try {
    await runtime.emit(commandApproval("failed-session"));
    invoke.mockImplementation(async command => { if (command === "agent_chat_respond") throw new Error("not acknowledged"); });
    await expect(runtime.chat.respond(runtime.id, "failed-session", true, undefined, undefined, true)).rejects.toThrow("not acknowledged");
    await runtime.emit(commandApproval("next-request"));
    expect(invoke.mock.calls.filter(([command]) => command === "agent_chat_respond")).toHaveLength(1);
  } finally { await act(async () => runtime.root.unmount()); }
});

it.each([
  { permission: "readOnly" as const }, { accountProfileId: "another-profile" },
  { model: "another-model" }, { workingDirectory: "/other/work" },
])("clears session approval when configuration changes: %j", async patch => {
  const runtime = await setup();
  try {
    await runtime.emit(commandApproval("scope-first"));
    await act(async () => { await runtime.chat.respond(runtime.id, "scope-first", true, undefined, undefined, true); });
    await runtime.emit({ kind: "finished", nativeSessionId: null, usage: null, costUsd: null, durationMs: 1, error: null });
    await act(async () => { runtime.chat.updateThread(runtime.id, patch); await runtime.chat.send(runtime.id, "changed scope"); });
    await runtime.emit(commandApproval("changed-scope"));
    expect(invoke.mock.calls.filter(([command]) => command === "agent_chat_respond")).toHaveLength(1);
    expect(runtime.chat.getThread(runtime.id)!.items.find(item => item.type === "approval" && item.requestId === "changed-scope")).toMatchObject({ decision: "pending" });
  } finally { await act(async () => runtime.root.unmount()); }
});

it("never restores session approval from saved history", async () => {
  const runtime = await setup();
  let remounted = false;
  try {
    await runtime.emit(commandApproval("before-reload"));
    await act(async () => { await runtime.chat.respond(runtime.id, "before-reload", true, undefined, undefined, true); });
    await runtime.emit({ kind: "finished", nativeSessionId: null, usage: null, costUsd: null, durationMs: 1, error: null });
    await act(async () => runtime.root.unmount());
    remounted = true;
    const calls = invoke.mock.calls.filter(([command]) => command === "agent_chat_respond").length;
    const container = installFakeDom();
    let chat!: AgentChatApi;
    function Probe() { chat = useAgentChat(); return null; }
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<Probe />));
      await act(async () => { await chat.send(runtime.id, "after reload"); });
      await act(async () => events.listener!({ payload: { threadId: runtime.id, turnId: chat.getThread(runtime.id)!.runningTurnId!, event: commandApproval("after-reload") } }));
      expect(invoke.mock.calls.filter(([command]) => command === "agent_chat_respond")).toHaveLength(calls);
    } finally { await act(async () => root.unmount()); }
  } finally { if (!remounted) await act(async () => runtime.root.unmount()); }
});
