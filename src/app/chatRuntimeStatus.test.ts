import { expect, it } from "vitest";
import { applyChatEvent, beginTurn, boundThreadForStorage, createThread, type ChatEvent, type ChatItem } from "./agentChat";
import { currentRuntimeStatus } from "./chatRuntimeStatus";
const start = () => beginTurn({ ...createThread({ definitionId: "codex", model: "", permission: "ask", workingDirectory: "/synthetic" }, "chat", 1), nativeSessionId: "native" }, "test", "turn", 2);
const apply = (thread: ReturnType<typeof start>, event: ChatEvent, turnId = "turn") => applyChatEvent(thread, { threadId: "chat", turnId, event }, 3);
it("streams command output into one bounded tool card and replaces it with the final official result", () => {
  let thread = apply(start(), { kind: "toolStarted", itemId: "cmd", name: "command", summary: "npm test" });
  thread = apply(thread, { kind: "toolOutputDelta", itemId: "cmd", delta: "first\n" });
  thread = apply(thread, { kind: "toolOutputDelta", itemId: "cmd", delta: "second\n" });
  expect(thread.items.filter(item => item.type === "tool")).toHaveLength(1);
  expect(thread.items[thread.items.length - 1]).toMatchObject({ output: "first\nsecond\n", done: false });
  thread = apply(thread, { kind: "toolOutputDelta", itemId: "cmd", delta: "x".repeat(100000) });
  expect((thread.items[thread.items.length - 1] as Extract<ChatItem, { type: "tool" }>).output?.length).toBe(65536);
  thread = apply(thread, { kind: "toolFinished", itemId: "cmd", name: null, summary: null, output: "final output", isError: false });
  expect(thread.items[thread.items.length - 1]).toMatchObject({ output: "final output", done: true });
});
it("keeps reasoning parts ordered and uses the final summary without duplication", () => {
  let thread = apply(start(), { kind: "reasoningDelta", itemId: "reason", delta: "raw", part: 0, summary: false });
  thread = apply(thread, { kind: "reasoningDelta", itemId: "reason", delta: "second", part: 1, summary: true });
  thread = apply(thread, { kind: "reasoningDelta", itemId: "reason", delta: "first", part: 0, summary: true });
  expect(thread.items[thread.items.length - 1]).toMatchObject({ text: "first\nsecond" });
  const saved = boundThreadForStorage(thread).items.slice(-1)[0];
  expect(saved).not.toHaveProperty("parts");
  thread = apply(thread, { kind: "reasoning", itemId: "reason", text: "official final summary" });
  expect(thread.items[thread.items.length - 1]).toMatchObject({ text: "official final summary" });
  expect(thread.items.filter(item => item.type === "reasoning")).toHaveLength(1);
});
it("keeps live usage bound to the exact native account/model/directory and does not restore it as current", () => {
  let thread = apply(start(), { kind: "contextUsage", tokensUsed: 120, contextWindow: 200000 });
  thread = apply(thread, { kind: "rateLimits", windows: [{ key: "main", label: "Codex", usedPercent: 25, windowMinutes: 300, resetsAt: null }] });
  expect(currentRuntimeStatus(thread)).toMatchObject({ contextUsage: { tokensUsed: 120, contextWindow: 200000 } });
  expect(currentRuntimeStatus({ ...thread, accountProfileId: "different" })).toBeUndefined();
  expect(currentRuntimeStatus({ ...thread, model: "different" })).toBeUndefined();
  expect(boundThreadForStorage(thread)).not.toHaveProperty("runtimeStatus");
  expect(apply(thread, { kind: "contextUsage", tokensUsed: 999, contextWindow: 200000 }, "old-turn")).toBe(thread);
  expect(apply(thread, { kind: "contextUsage", tokensUsed: -1, contextWindow: null })).toBe(thread);
  thread = apply(thread, { kind: "contextCompacted" });
  expect(currentRuntimeStatus(thread)?.contextUsage).toBeUndefined();
  expect(currentRuntimeStatus(thread)?.rateLimits).toHaveLength(1);
});
it("updates one actual plan and Goal rather than inferring progress from completed turns", () => {
  let thread = apply(start(), { kind: "planUpdated", explanation: null, steps: [{ text: "build", status: "pending" }] });
  thread = apply(thread, { kind: "planUpdated", explanation: null, steps: [{ text: "build", status: "inProgress" }] });
  expect(thread.items.filter(item => item.type === "plan")).toHaveLength(1);
  thread = apply(thread, { kind: "goalUpdated", goal: { objective: "finish", status: "active", tokensUsed: 10, tokenBudget: 100, timeUsedSeconds: 2 } });
  thread = apply(thread, { kind: "finished", nativeSessionId: "native", usage: null, costUsd: null, durationMs: 10, error: null });
  expect(thread.items.find(item => item.type === "plan")).toMatchObject({ steps: [{ status: "inProgress" }] });
  expect(thread.items.find(item => item.type === "goal")).toMatchObject({ goal: { status: "active" } });
});
it("native maintenance operations never replace an older user message's turn boundary", () => {
  let thread = apply(start(), { kind: "nativeTurnId", nativeTurnId: "native-1" });
  expect(thread.items.find(item => item.type === "user")).toMatchObject({ nativeTurnId: "native-1" });
  thread = apply(thread, { kind: "text", itemId: "reply", text: "reply" });
  expect(thread.items.slice(-1)[0]).toMatchObject({ nativeTurnId: "native-1" });
  thread = apply({ ...thread, activeOperation: "compact" }, { kind: "nativeTurnId", nativeTurnId: "compaction-2" });
  expect(thread.items.find(item => item.type === "user")).toMatchObject({ nativeTurnId: "native-1" });
});
