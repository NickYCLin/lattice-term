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
