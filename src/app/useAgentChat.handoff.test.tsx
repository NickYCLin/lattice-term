import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import { useAgentChat, type AgentChatApi } from "./useAgentChat";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("./notificationSounds", () => ({ playCompletionSound: async () => "disabled" }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

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
    id = chat.createThread({ definitionId: "codex", model: "", permission: "full", workingDirectory: "" }).id;
  });
  return { get chat() { return chat; }, id, root };
}

it("marks terminal ownership only after launch succeeds and blocks chat writes meanwhile", async () => {
  const runtime = await setup();
  let finishLaunch!: () => void;
  const launched = new Promise<void>(resolve => { finishLaunch = resolve; });
  const launch = vi.fn(() => launched);
  let handoff!: Promise<void>;
  try {
    await act(async () => { handoff = runtime.chat.continueInSession(runtime.id, launch); });
    expect(launch).toHaveBeenCalledOnce();
    expect(runtime.chat.getThread(runtime.id)!.continuedInSession).not.toBe(true);
    await act(async () => {
      await expect(runtime.chat.send(runtime.id, "must stay a draft")).rejects.toThrow("terminal");
      await expect(runtime.chat.continueInSession(runtime.id, launch)).rejects.toThrow("terminal");
    });
    expect(runtime.chat.getThread(runtime.id)!.items).toEqual([]);
    await act(async () => { runtime.chat.enqueue(runtime.id, "queued during handoff", []); });
    expect(invoke.mock.calls.filter(([command]) => command === "agent_chat_send")).toHaveLength(0);
    await act(async () => { finishLaunch(); await handoff; });
    expect(runtime.chat.getThread(runtime.id)!.continuedInSession).toBe(true);
    expect(runtime.chat.getThread(runtime.id)!.pendingInputs).toHaveLength(1);
    expect(runtime.chat.getThread(runtime.id)!.items).toEqual([]);
    await expect(runtime.chat.send(runtime.id, "still held")).rejects.toThrow("terminal");
  } finally { finishLaunch(); await act(async () => { runtime.root.unmount(); }); }
});

it("leaves a failed launch retryable without marking the transcript for reading", async () => {
  const runtime = await setup();
  const launch = vi.fn(async () => { throw new Error("launch failed"); });
  try {
    await act(async () => {
      await expect(runtime.chat.continueInSession(runtime.id, launch)).rejects.toThrow("launch failed");
    });
    expect(runtime.chat.getThread(runtime.id)!.continuedInSession).not.toBe(true);
    await act(async () => { await runtime.chat.continueInSession(runtime.id, async () => {}); });
    expect(runtime.chat.getThread(runtime.id)!.continuedInSession).toBe(true);
  } finally { await act(async () => { runtime.root.unmount(); }); }
});

it("does not launch if closing the chat process fails", async () => {
  const runtime = await setup();
  invoke.mockImplementation(async command => {
    if (command === "agent_chat_close") throw new Error("close failed");
  });
  const launch = vi.fn(async () => {});
  try {
    await act(async () => {
      await expect(runtime.chat.continueInSession(runtime.id, launch)).rejects.toThrow("close failed");
    });
    expect(launch).not.toHaveBeenCalled();
    expect(runtime.chat.getThread(runtime.id)!.continuedInSession).not.toBe(true);
  } finally { await act(async () => { runtime.root.unmount(); }); }
});

it("still hands an already running terminal the conversation without a launch callback", async () => {
  const runtime = await setup();
  try {
    await act(async () => { await runtime.chat.continueInSession(runtime.id); });
    expect(runtime.chat.getThread(runtime.id)!.continuedInSession).toBe(true);
  } finally { await act(async () => { runtime.root.unmount(); }); }
});

it("blocks writes before the chat process has finished closing", async () => {
  const runtime = await setup();
  let finishClose!: () => void;
  const closed = new Promise<void>(resolve => { finishClose = resolve; });
  invoke.mockImplementation(command => command === "agent_chat_close" ? closed : Promise.resolve());
  const launch = vi.fn(async () => {});
  let handoff!: Promise<void>;
  try {
    await act(async () => { handoff = runtime.chat.continueInSession(runtime.id, launch); });
    expect(launch).not.toHaveBeenCalled();
    await expect(runtime.chat.send(runtime.id, "do not reopen")).rejects.toThrow("terminal");
    await act(async () => { finishClose(); await handoff; });
    expect(launch).toHaveBeenCalledOnce();
  } finally { finishClose(); await act(async () => { runtime.root.unmount(); }); }
});

it("resumes queued chat input when terminal launch fails", async () => {
  const runtime = await setup();
  let failLaunch!: (reason: Error) => void;
  const launched = new Promise<void>((_resolve, reject) => { failLaunch = reject; });
  let failure!: Promise<unknown>;
  try {
    await act(async () => {
      failure = runtime.chat.continueInSession(runtime.id, () => launched).catch(reason => reason);
    });
    await act(async () => { runtime.chat.enqueue(runtime.id, "resume in chat", []); });
    expect(runtime.chat.getThread(runtime.id)!.items).toEqual([]);
    await act(async () => { failLaunch(new Error("launch failed")); await failure; });
    expect(runtime.chat.getThread(runtime.id)!.continuedInSession).not.toBe(true);
    expect(runtime.chat.getThread(runtime.id)!.pendingInputs).toHaveLength(0);
    expect(runtime.chat.getThread(runtime.id)!.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "user", text: "resume in chat" }),
    ]));
    expect(invoke.mock.calls.filter(([command]) => command === "agent_chat_send")).toHaveLength(1);
  } finally { await act(async () => { runtime.root.unmount(); }); }
});
