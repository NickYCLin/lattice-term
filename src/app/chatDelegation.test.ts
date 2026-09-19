import { describe, expect, it } from "vitest";
import { createThread, delegationPrompt, delegationResult, delegationState, noteDelegationFinished } from "./agentChat";

const turnEnd = (error: string | null) => ({
  type: "turnEnd" as const,
  id: "e",
  usage: null,
  costUsd: null,
  durationMs: null,
  error,
});

describe("delegated subtasks", () => {
  it("reads the subtask's state from its own conversation", () => {
    expect(delegationState({ runningTurnId: "t", items: [] })).toBe("running");
    expect(delegationState({ runningTurnId: null, items: [] })).toBe("waiting");
    expect(delegationState({ runningTurnId: null, items: [turnEnd(null)] })).toBe("done");
    expect(delegationState({ runningTurnId: null, items: [turnEnd("boom")] })).toBe("failed");
  });

  it("brings back the final answer marked as a subtask result, and retries the first ask", () => {
    const items = [
      { type: "user" as const, id: "u", text: "Write the README" },
      { type: "text" as const, id: "a", text: "Draft one" },
      { type: "text" as const, id: "b", text: "Final README" },
      turnEnd(null),
    ];
    const result = delegationResult({ title: '↳ Write "README"', items: items as never });
    expect(result).toContain("Final README");
    expect(result).not.toContain("Draft one");
    expect(result.startsWith('<subtask-result title="↳ Write \'README\'">')).toBe(true);
    expect(delegationPrompt({ items: items as never })).toBe("Write the README");
    expect(delegationResult({ title: "x", items: [] })).toBe("");
  });
});

describe("subtask notes", () => {
  it("adds one note per finished subtask turn to the asking conversation", () => {
    const parent = createThread({ definitionId: "claude", workingDirectory: "/w", permission: "readOnly", model: "" }, "p", 1);
    const once = noteDelegationFinished(parent, "child", "turn-1", false);
    expect(once.items).toEqual([{ type: "delegation", id: "delegation:child:turn-1", childId: "child", failed: false }]);
    expect(noteDelegationFinished(once, "child", "turn-1", false)).toBe(once);
    expect(noteDelegationFinished(once, "child", "turn-2", true).items).toHaveLength(2);
  });
});

