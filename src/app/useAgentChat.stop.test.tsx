import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import { useAgentChat, type AgentChatApi } from "./useAgentChat";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("./notificationSounds", () => ({ playCompletionSound: async () => "disabled" }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

async function setup(running = true) {
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
    if (running) await chat.send(id, "fixture prompt");
  });
  return { get chat() { return chat; }, id, root };
}

it("pins a stop without an explicit expected id to the current turn", async () => {
  const runtime = await setup();
  try {
    const turnId = runtime.chat.getThread(runtime.id)!.runningTurnId;
    await act(async () => { await runtime.chat.stop(runtime.id); });
    expect(invoke.mock.calls.filter(([command]) => command === "agent_chat_stop").map(([, args]) => args))
      .toEqual([{ threadId: runtime.id, expectedTurnId: turnId }]);
    expect(runtime.chat.getThread(runtime.id)!.queuePaused).toBe(true);
  } finally { await act(async () => { runtime.root.unmount(); }); }
});

it("rejects an outdated stop before pausing the newer turn queue", async () => {
  const runtime = await setup();
  try {
    const before = runtime.chat.getThread(runtime.id);
    await act(async () => {
      await expect(runtime.chat.stop(runtime.id, "outdated-turn")).rejects.toThrow("turn changed");
    });
    expect(runtime.chat.getThread(runtime.id)).toBe(before);
    expect(invoke.mock.calls.filter(([command]) => command === "agent_chat_stop")).toHaveLength(0);
  } finally { await act(async () => { runtime.root.unmount(); }); }
});

it("pauses an idle queue without sending an unscoped backend stop", async () => {
  const runtime = await setup(false);
  try {
    await act(async () => { await runtime.chat.stop(runtime.id); });
    expect(runtime.chat.getThread(runtime.id)!.queuePaused).toBe(true);
    expect(invoke.mock.calls.filter(([command]) => command === "agent_chat_stop")).toHaveLength(0);
  } finally { await act(async () => { runtime.root.unmount(); }); }
});

it("accepts the matching turn supplied by the caller", async () => {
  const runtime = await setup();
  try {
    const turnId = runtime.chat.getThread(runtime.id)!.runningTurnId!;
    await act(async () => { await runtime.chat.stop(runtime.id, turnId); });
    expect(invoke.mock.calls.filter(([command]) => command === "agent_chat_stop").map(([, args]) => args))
      .toEqual([{ threadId: runtime.id, expectedTurnId: turnId }]);
  } finally { await act(async () => { runtime.root.unmount(); }); }
});

it("ignores a removed conversation instead of sending a backend stop", async () => {
  const runtime = await setup();
  try {
    const before = runtime.chat.getThread(runtime.id);
    await act(async () => { await runtime.chat.stop("missing-thread"); });
    expect(runtime.chat.getThread(runtime.id)).toBe(before);
    expect(invoke.mock.calls.filter(([command]) => command === "agent_chat_stop")).toHaveLength(0);
  } finally { await act(async () => { runtime.root.unmount(); }); }
});
