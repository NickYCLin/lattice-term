import { describe, expect, it } from "vitest";
import {
  createThread,
  delegationPrompt,
  delegationResult,
  delegationState,
  loadStoredThreads,
  noteDelegationFinished,
  saveStoredThreads,
} from "./agentChat";

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


describe("a subtask that runs on another machine", () => {
  const remote = {
    targetId: "target-1",
    targetLabel: "工作站",
    planId: "plan-1",
    sessionId: "agent-9",
    cursor: 128,
  };

  it("is stored and read back whole, and forgotten when incomplete", () => {
    const storage = new Map<string, string>();
    const store: Storage = {
      get length() { return storage.size; },
      clear: () => storage.clear(),
      key: (index) => [...storage.keys()][index] ?? null,
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, value); },
      removeItem: (key) => { storage.delete(key); },
    };
    const thread = { ...createThread({ definitionId: "codex", workingDirectory: "", permission: "ask", model: "" }), remote };
    saveStoredThreads(store, [thread]);
    expect(loadStoredThreads(store)[0].remote).toEqual(remote);

    for (const broken of [{ ...remote, sessionId: "" }, { ...remote, planId: undefined }, "not an object"]) {
      saveStoredThreads(store, [{ ...thread, remote: broken as never }]);
      expect(loadStoredThreads(store)[0].remote).toBeNull();
    }
  });

  it("reports its state and result the same way a local subtask does", () => {
    const child = {
      ...createThread({ definitionId: "codex", workingDirectory: "", permission: "ask", model: "" }),
      title: "↳ 跑測試",
      remote,
      runningTurnId: "turn-1",
      items: [{ type: "user" as const, id: "u1", text: "跑測試", at: 0 }],
    };
    expect(delegationState(child)).toBe("running");

    const finished = {
      ...child,
      runningTurnId: null,
      items: [
        ...child.items,
        { type: "text" as const, id: "t1", text: "全部通過" },
        { type: "turnEnd" as const, id: "turn-1", usage: null, costUsd: null, durationMs: null, error: null },
      ],
    };
    expect(delegationState(finished)).toBe("done");
    expect(delegationResult(finished)).toContain("全部通過");
  });
});
