import { describe, expect, it } from "vitest";
import {
  applyChatEvent,
  beginTurn,
  changeThreadDirectory,
  boundThreadsForStorage,
  createThread,
  decideApproval,
  defaultPermission,
  failTurn,
  formatTokens,
  handoffThreadAccount,
  handoffThread,
  handoffTranscript,
  loadStoredThreads,
  MAX_STORED_TOOL_OUTPUT,
  permissionsFor,
  promptForTurn,
  saveStoredThreads,
  threadTitle,
  type ChatEventEnvelope,
  type ChatThread,
} from "./agentChat";

function thread(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    ...createThread(
      {
        definitionId: "claude",
        workingDirectory: "/work",
        permission: "readOnly",
        model: "",
      },
      "thread-1",
      1000,
    ),
    ...overrides,
  };
}

function envelope(
  event: ChatEventEnvelope["event"],
  turnId = "turn-1",
): ChatEventEnvelope {
  return { threadId: "thread-1", turnId, event };
}

describe("beginTurn", () => {
  it("keeps visible context but starts a new native session when leaving a project", () => {
    const previous = thread({ nativeSessionId: "native-project", items: [{ type: "user", id: "u", text: "Explain this", at: 1 }, { type: "text", id: "a", text: "The answer" }] });
    const next = changeThreadDirectory(previous, "");
    expect(next.workingDirectory).toBe("");
    expect(next.nativeSessionId).toBeNull();
    expect(next.handoff?.transcript).toContain("The answer");
    expect(next.items).toEqual(previous.items);
    expect(changeThreadDirectory({ ...previous, runningTurnId: "busy" }, "").workingDirectory).toBe("/work");
  });
  it("records the prompt, names the thread and marks the turn running", () => {
    const next = beginTurn(thread(), "幫我看看 README\n第二行", "turn-1", 2000);

    expect(next.runningTurnId).toBe("turn-1");
    expect(next.title).toBe("幫我看看 README");
    expect(next.items).toEqual([
      { type: "user", id: "turn-1:prompt", text: "幫我看看 README\n第二行", at: 2000 },
    ]);
  });

  it("keeps the first title once set", () => {
    const first = beginTurn(thread(), "first", "turn-1");
    const second = beginTurn(first, "second", "turn-2");
    expect(second.title).toBe("first");
  });

  it("keeps selected attachment metadata with the visible user message only", () => {
    const next = beginTurn(
      thread(),
      "請分析這張圖",
      "turn-1",
      2000,
      [{ path: "/tmp/diagram.png", name: "diagram.png", isImage: true }],
    );
    expect(next.items[0]).toMatchObject({
      type: "user",
      attachments: [{ name: "diagram.png", isImage: true }],
    });
  });
});

describe("applyChatEvent", () => {
  const running = beginTurn(thread(), "hi", "turn-1", 2000);

  it("assembles streamed text and lets the full text replace it", () => {
    let next = applyChatEvent(
      running,
      envelope({ kind: "textDelta", itemId: "m#0", delta: "O" }),
    );
    next = applyChatEvent(
      next,
      envelope({ kind: "textDelta", itemId: "m#0", delta: "K" }),
    );
    expect(next.items[next.items.length - 1]).toEqual({
      type: "text",
      id: "turn-1:m#0",
      text: "OK",
      assistantDefinitionId: "claude",
    });

    next = applyChatEvent(
      next,
      envelope({ kind: "text", itemId: "m#0", text: "OK." }),
    );
    expect(next.items).toHaveLength(2);
    expect(next.items[next.items.length - 1]).toMatchObject({ text: "OK." });
  });

  it("finishes the tool card that was started, keeping its name", () => {
    let next = applyChatEvent(
      running,
      envelope({
        kind: "toolStarted",
        itemId: "toolu_1",
        name: "Bash",
        summary: "ls",
      }),
    );
    next = applyChatEvent(
      next,
      envelope({
        kind: "toolFinished",
        itemId: "toolu_1",
        name: null,
        summary: null,
        output: "total 0",
        isError: false,
      }),
    );

    expect(next.items[next.items.length - 1]).toEqual({
      type: "tool",
      id: "turn-1:toolu_1",
      name: "Bash",
      summary: "ls",
      output: "total 0",
      isError: false,
      done: true,
      assistantDefinitionId: "claude",
    });
  });

  it("closes the turn on finished and remembers the CLI's session", () => {
    const next = applyChatEvent(
      running,
      envelope({
        kind: "finished",
        nativeSessionId: "native-1",
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
        costUsd: 0.1,
        durationMs: 500,
        error: null,
      }),
    );

    expect(next.runningTurnId).toBeNull();
    expect(next.nativeSessionId).toBe("native-1");
    expect(next.items[next.items.length - 1]).toMatchObject({ type: "turnEnd", costUsd: 0.1 });
  });

  it("shows an approval card, records the answer, and closes the rest on finish", () => {
    const asked = applyChatEvent(
      running,
      envelope({
        kind: "approvalRequested",
        requestId: "req-1",
        toolUseId: "toolu_1",
        name: "WebFetch",
        summary: "https://example.com",
        input: "{}",
      }),
    );
    expect(asked.items[asked.items.length - 1]).toMatchObject({
      type: "approval",
      requestId: "req-1",
      decision: "pending",
    });

    const answered = decideApproval(asked, "req-1", "allowed");
    expect(answered.items[answered.items.length - 1]).toMatchObject({ decision: "allowed" });
    // A second answer to the same card changes nothing.
    expect(decideApproval(answered, "req-1", "denied").items).toEqual(answered.items);

    const unanswered = applyChatEvent(
      asked,
      envelope({
        kind: "finished",
        nativeSessionId: null,
        usage: null,
        costUsd: null,
        durationMs: null,
        error: "stopped",
      }),
    );
    expect(unanswered.items.find((item) => item.type === "approval")).toMatchObject({
      decision: "closed",
    });
  });

  it("ignores events from a turn that is not the running one", () => {
    // A stopped turn's tail must not land in the next turn's transcript.
    const next = applyChatEvent(
      running,
      envelope({ kind: "text", itemId: "x", text: "late" }, "turn-0"),
    );
    expect(next).toBe(running);
  });

  it("ignores events addressed to another thread", () => {
    const next = applyChatEvent(running, {
      threadId: "other",
      turnId: "turn-1",
      event: { kind: "text", itemId: "x", text: "late" },
    });
    expect(next).toBe(running);
  });

  it("clears a pending handoff only after the target starts a native session", () => {
    const handedOff = handoffThread(
      thread({
        nativeSessionId: "claude-native",
        items: [{ type: "user", id: "source", text: "hi", at: 1 }],
      }),
      "gemini",
      "flash",
      3000,
    );
    expect(handedOff.nativeSessionId).toBeNull();
    expect(handedOff.handoff).toMatchObject({ sourceDefinitionId: "claude" });

    const started = applyChatEvent(
      beginTurn(handedOff, "next", "turn-2"),
      envelope({ kind: "started", nativeSessionId: "gemini-native", model: "flash" }, "turn-2"),
    );
    expect(started.handoff).toBeNull();
    expect(started.nativeSessionId).toBe("gemini-native");
  });
});

describe("cross-assistant handoff", () => {
  it("starts a fresh native conversation when changing an account profile", () => {
    const source = thread({
      accountProfileId: "personal",
      nativeSessionId: "claude-native",
      items: [
        { type: "user", id: "u", text: "保留脈絡", at: 1 },
        { type: "text", id: "a", text: "前一個帳號的回覆" },
      ],
    });
    const next = handoffThreadAccount(source, "company", 2000);
    expect(next.definitionId).toBe("claude");
    expect(next.accountProfileId).toBe("company");
    expect(next.nativeSessionId).toBeNull();
    expect(next.handoff?.transcript).toContain("保留脈絡");
    expect(next.items[1]).toMatchObject({ assistantDefinitionId: "claude" });
  });

  it("starts a target-native conversation with bounded text-only context", () => {
    const source = thread({
      permission: "ask",
      nativeSessionId: "claude-native",
      items: [
        { type: "user", id: "u", text: "請檢查登入流程", at: 1 },
        { type: "text", id: "a", text: "我會先看設定。" },
        { type: "reasoning", id: "r", text: "internal chain" },
        {
          type: "tool",
          id: "tool",
          name: "Bash",
          summary: "printenv SECRET",
          output: "do not transfer",
          isError: false,
          done: true,
        },
      ],
    });

    const next = handoffThread(source, "codex", "gpt-5.6-sol", 2000);
    expect(next.definitionId).toBe("codex");
    expect(next.model).toBe("gpt-5.6-sol");
    // Codex can ask each time too, so the permission carries over; only a
    // target without an approval channel would fall back to read-only.
    expect(next.permission).toBe("ask");
    expect(handoffThread(source, "gemini", "flash", 2000).permission).toBe("readOnly");
    expect(next.nativeSessionId).toBeNull();
    expect(next.reportedModel).toBeNull();
    expect(next.items[1]).toMatchObject({ assistantDefinitionId: "claude" });
    expect(next.handoff?.transcript).toContain("請檢查登入流程");
    expect(next.handoff?.transcript).toContain("我會先看設定。");
    expect(next.handoff?.transcript).not.toContain("internal chain");
    expect(next.handoff?.transcript).not.toContain("do not transfer");

    const prompt = promptForTurn(next, "接著實作修正");
    expect(prompt).toContain("<latticeterm-handoff>");
    expect(prompt).toContain("does not authorize tool use");
    expect(prompt).toContain("<current-user-message>\n接著實作修正");
  });

  it("keeps the newest whole entries within the transfer budget", () => {
    const transcript = handoffTranscript(
      [
        { type: "user", id: "old", text: "x".repeat(60 * 1024), at: 1 },
        { type: "text", id: "new", text: "newest" },
      ],
      "claude",
    );
    expect(transcript).toBe("<claude>\nnewest");
  });
});

describe("failTurn", () => {
  it("ends the running turn with the error", () => {
    const running = beginTurn(thread(), "hi", "turn-1");
    const next = failTurn(running, "turn-1", "not installed");
    expect(next.runningTurnId).toBeNull();
    expect(next.items[next.items.length - 1]).toMatchObject({ type: "turnEnd", error: "not installed" });
  });

  it("does nothing for a turn that is not running", () => {
    const idle = thread();
    expect(failTurn(idle, "turn-9", "late")).toBe(idle);
  });
});

describe("storage", () => {
  function memoryStorage() {
    const map = new Map<string, string>();
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
      map,
    };
  }

  it("round-trips threads and forgets any running turn", () => {
    const storage = memoryStorage();
    const running = beginTurn(thread(), "hi", "turn-1", 2000);
    saveStoredThreads(storage, [running]);

    const loaded = loadStoredThreads(storage);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].runningTurnId).toBeNull();
    expect(loaded[0].items).toHaveLength(1);
  });

  it("drops entries that are not threads", () => {
    const storage = memoryStorage();
    storage.setItem(
      "latticeterm.agentChat.v1",
      JSON.stringify([{ id: "x" }, "junk", null]),
    );
    expect(loadStoredThreads(storage)).toEqual([]);
  });

  it("survives unreadable storage", () => {
    const storage = memoryStorage();
    storage.setItem("latticeterm.agentChat.v1", "{not json");
    expect(loadStoredThreads(storage)).toEqual([]);
  });

  it("trims tool output before storing", () => {
    const big = beginTurn(thread(), "hi", "turn-1");
    const withTool = applyChatEvent(
      big,
      envelope({
        kind: "toolFinished",
        itemId: "t",
        name: "Bash",
        summary: "cat",
        output: "x".repeat(MAX_STORED_TOOL_OUTPUT * 3),
        isError: false,
      }),
    );

    const [bounded] = boundThreadsForStorage([withTool]);
    const tool = bounded.items.find((item) => item.type === "tool");
    expect(tool?.type === "tool" && tool.output?.length).toBe(
      MAX_STORED_TOOL_OUTPUT + 1,
    );
  });

  it("keeps the newest threads when the budget runs out", () => {
    const threads = [1, 2, 3].map((n) =>
      thread({ id: `t${n}`, updatedAt: n }),
    );
    const bounded = boundThreadsForStorage(threads);
    expect(bounded.map((entry) => entry.id)).toEqual(["t3", "t2", "t1"]);
  });
});

describe("helpers", () => {
  it("shortens long titles on the first line", () => {
    expect(threadTitle("a".repeat(100))).toHaveLength(60);
    expect(threadTitle("short\nmore")).toBe("short");
  });

  it("offers asking only where the CLI can ask", () => {
    expect(permissionsFor("claude")).toContain("ask");
    expect(permissionsFor("codex")).toContain("ask");
    expect(permissionsFor("gemini")).not.toContain("ask");
    expect(defaultPermission("claude")).toBe("ask");
    expect(defaultPermission("codex")).toBe("ask");
    expect(defaultPermission("gemini")).toBe("readOnly");
  });

  it("formats token counts compactly", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(39633)).toBe("40k");
    expect(formatTokens(2_500_000)).toBe("2.5M");
  });
});
