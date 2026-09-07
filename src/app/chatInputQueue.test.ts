import { describe, expect, it } from "vitest";
import { createThread, beginTurn, applyChatEvent, failTurn, loadStoredThreads, saveStoredThreads } from "./agentChat";
import { enqueueChatInput, restoreQueuedInputs, removeQueuedInput, MAX_QUEUED_CHAT_INPUTS } from "./chatInputQueue";

const makeThread = () => createThread({ definitionId: "codex", workingDirectory: "", permission: "ask", model: "" }, "thread-1", 0);
const input = (id: string) => ({ id, prompt: `Message ${id}`, attachments: [], profileConfigPath: null, createdAt: 1 });

describe("chat input queue", () => {
  it("keeps FIFO order, ignores duplicate IDs, and allows removing one message", () => {
    let thread = enqueueChatInput(makeThread(), input("one"));
    thread = enqueueChatInput(thread, input("two"));
    thread = enqueueChatInput(thread, input("one"));
    expect(thread.pendingInputs?.map(message => message.id)).toEqual(["one", "two"]);
    expect(removeQueuedInput(thread, "one").pendingInputs?.map(message => message.id)).toEqual(["two"]);
  });
  it("bounds stored input and rejects invalid entries without turning them into actions", () => {
    const entries = Array.from({length: 12}, (_, i) => input(`q-${i}`));
    expect(restoreQueuedInputs(entries)).toHaveLength(MAX_QUEUED_CHAT_INPUTS);
    expect(restoreQueuedInputs([input("one"), input("one"), { ...input("bad"), attachments: [null] },
      { ...input("big"), prompt: "a".repeat(65537) }, { ...input("unicode"), prompt: "訊".repeat(22000) },
      { ...input("path"), profileConfigPath: "a\nb" }])).toEqual([input("one")]);
    let thread = makeThread();
    for (const entry of entries.slice(0, MAX_QUEUED_CHAT_INPUTS)) thread = enqueueChatInput(thread, entry);
    expect(() => enqueueChatInput(thread, input("overflow"))).toThrow();
  });
  it("preserves queued text and attachments on reload but requires manual resume", () => {
    const queued = { ...input("photo"), attachments: [{ path: "/tmp/photo.png", name: "photo.png", isImage: true }] };
    const thread = enqueueChatInput(beginTurn(makeThread(), "first", "active"), queued);
    let value = "";
    const storage = { setItem: (_: string, text: string) => { value = text; }, removeItem: () => {}, getItem: () => value };
    saveStoredThreads(storage, [thread]);
    const restored = loadStoredThreads(storage)[0];
    expect(restored.pendingInputs).toEqual([queued]);
    expect(restored.queuePaused).toBe(true);
    expect(restored.runningTurnId).toBeNull();
    saveStoredThreads(storage, [makeThread()]);
    expect(loadStoredThreads(storage)[0].queuePaused).toBe(false);
  });
  it("pauses on errors and ignores stale completion events", () => {
    const thread = enqueueChatInput(beginTurn(makeThread(), "first", "active"), input("next"));
    expect(failTurn(thread, "active", "offline").queuePaused).toBe(true);
    const event = { kind: "finished" as const, error: "failed", nativeSessionId: null, usage: null, costUsd: null, durationMs: null };
    expect(applyChatEvent(thread, { threadId: thread.id, turnId: "active", event }).queuePaused).toBe(true);
    expect(applyChatEvent(thread, { threadId: thread.id, turnId: "stale", event })).toBe(thread);
  });
  it("does not erase stored conversations when the queue cannot fit the history budget", () => {
    let saved = "existing content";
    const thread = enqueueChatInput(makeThread(), input("queued"));
    thread.items = [{ type: "text", id: "huge", text: "x".repeat(5 * 1024 * 1024) }];
    const storage = { setItem: (_: string, value: string) => { saved = value; }, removeItem: () => { saved = ""; } };
    expect(saveStoredThreads(storage, [thread])).toBe(false);
    expect(saved).toBe("existing content");
    thread.pendingInputs = [];
    expect(saveStoredThreads(storage, [thread], [thread.id])).toBe(false);
    expect(saved).toBe("existing content");
  });
});
