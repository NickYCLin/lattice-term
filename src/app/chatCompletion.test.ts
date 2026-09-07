import { describe, expect, it } from "vitest";
import { ChatCompletionTracker } from "./chatCompletion";
import type { ChatEventEnvelope } from "./agentChat";

const finished = (
  threadId = "a",
  turnId = "one",
  error: string | null = null,
): ChatEventEnvelope => ({
  threadId,
  turnId,
  event: {
    kind: "finished",
    error,
    nativeSessionId: null,
    usage: null,
    costUsd: null,
    durationMs: null,
  },
});
describe("chat completion cues", () => {
  it("plays once for a live successful turn, including very fast replies", () => {
    const tracker = new ChatCompletionTracker();
    tracker.start("a", "one");
    expect(tracker.accept(finished())).toBe(true);
    expect(tracker.accept(finished())).toBe(false);
  });
  it("ignores restored, failed and manually stopped turns", () => {
    const tracker = new ChatCompletionTracker();
    expect(tracker.accept(finished())).toBe(false);
    tracker.start("a", "one");
    expect(tracker.accept(finished("a", "one", "failed"))).toBe(false);
    tracker.start("a", "two");
    tracker.cancel("a");
    expect(tracker.accept(finished("a", "two"))).toBe(false);
  });
  it("keeps simultaneous threads separate and ignores late old events", () => {
    const tracker = new ChatCompletionTracker();
    tracker.start("a", "two");
    tracker.start("b", "one");
    expect(tracker.accept(finished())).toBe(false);
    expect(tracker.accept(finished("b"))).toBe(true);
    expect(tracker.accept(finished("a", "two"))).toBe(true);
  });
});
