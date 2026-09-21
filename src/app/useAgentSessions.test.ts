import { describe, expect, it } from "vitest";
import {
  AgentLaunchRaceGuard,
  applyAgentLaunchEvents,
  applyAgentRestoreLaunchEvents,
  applyAgentStateEvent,
  applyAgentQueueEvent,
  applyAgentUsageEvent,
  agentCatalogForDisplay,
  buildAgentBroadcastPayload,
  claudeSafeModeFallbackRequest,
  codexUpdateRestartRequest,
  decodeAgentPayload,
  encodeAgentPayload,
  markAgentSessionClosed,
  moveAgentLaunchPlan,
  reconcileAgentOutputSnapshot,
  splitAgentArguments,
  type AgentDefinition,
} from "./useAgentSessions";
import { reconcileSessionSnapshot } from "./sessionSnapshot";

describe("agent session transport", () => {
  it("does not resurrect a launch whose close event arrived first", () => {
    const guard = new AgentLaunchRaceGuard();
    const attempt = guard.begin();

    expect(guard.hasPendingAttempt()).toBe(true);

    guard.observeClosed("agent-fast", "Process exited: code 0");

    expect(attempt.finish().closed.get("agent-fast")).toBe(
      "Process exited: code 0",
    );
    expect(attempt.finish().closed.size).toBe(0);
    expect(guard.hasPendingAttempt()).toBe(false);
  });

  it("keeps concurrent launch tombstones until the matching attempt settles", () => {
    const guard = new AgentLaunchRaceGuard();
    const fast = guard.begin();
    const running = guard.begin();
    guard.observeClosed("agent-fast", "Process exited");

    expect(running.finish().closed.get("agent-running")).toBeUndefined();
    expect(fast.finish().closed.get("agent-fast")).toBe("Process exited");

    const later = guard.begin();
    expect(later.finish().closed.get("agent-fast")).toBeUndefined();
  });

  it("clears unrelated close events after a rejected launch settles", () => {
    const guard = new AgentLaunchRaceGuard();
    const rejected = guard.begin();
    guard.observeClosed("agent-unrelated", "Process exited");
    rejected.cancel();

    const later = guard.begin();
    expect(later.finish().closed.get("agent-unrelated")).toBeUndefined();
  });

  it("restarts a Claude startup failure once in safe mode", () => {
    const request = {
      definitionId: "claude",
      label: "Claude Code",
      executable: "claude",
      arguments: ["--model", "sonnet"],
      resumeSessionId: null,
      workingDirectory: "D:/project/demo",
      cols: 120,
      rows: 30,
    };
    const session = {
      sessionId: "agent-claude",
      groupId: "project-claude",
      groupLabel: "Project",
      definitionId: "claude",
      label: "Claude Code",
      model: "sonnet",
      executable: "C:/Users/nicklin/AppData/Roaming/npm/claude.cmd",
      launchArguments: request.arguments,
      workingDirectory: request.workingDirectory,
      state: "idle" as const,
      stateSource: "heuristic" as const,
      processId: 42,
      tokenUsage: null,
      queuedPrompts: 0,
      capturedSessionId: null,
    };

    expect(
      claudeSafeModeFallbackRequest(
        request,
        session,
        "Process exited: ExitStatus { code: 1, signal: None }",
        1_000,
        1_500,
      ),
    ).toMatchObject({
      label: "Claude Code（安全模式）",
      executable: session.executable,
      groupId: "project-claude",
      arguments: ["--safe-mode", "--model", "sonnet"],
    });

    expect(
      claudeSafeModeFallbackRequest(
        { ...request, arguments: ["--safe-mode"] },
        session,
        "Process exited: ExitStatus { code: 1, signal: None }",
        1_000,
        1_500,
      ),
    ).toBeNull();
    expect(
      claudeSafeModeFallbackRequest(
        request,
        session,
        "Process exited: ExitStatus { code: 0, signal: None }",
        1_000,
        1_500,
      ),
    ).toBeNull();
  });

  it("restarts Codex once after its updater exits successfully", () => {
    const request = {
      definitionId: "codex",
      label: "OpenAI Codex",
      executable: "codex",
      arguments: ["--model", "gpt-5.6-sol"],
      resumeSessionId: null,
      seedInput: "continue this task",
      profileConfigPath: "C:/profiles/work",
      sandbox: true,
      detached: false,
      workingDirectory: "D:/project/demo",
      cols: 120,
      rows: 30,
    };
    const session = {
      sessionId: "agent-codex",
      groupId: "project-codex",
      groupLabel: "Project",
      definitionId: "codex",
      profileConfigPath: "C:/profiles/work",
      label: "OpenAI Codex",
      model: "gpt-5.6-sol",
      executable: "C:/Users/nicklin/AppData/Roaming/npm/codex.cmd",
      launchArguments: request.arguments,
      workingDirectory: request.workingDirectory,
      state: "idle" as const,
      stateSource: "heuristic" as const,
      processId: 42,
      tokenUsage: null,
      queuedPrompts: 0,
      capturedSessionId: "native-codex-session",
      sandboxed: true,
      detached: false,
    };

    expect(
      codexUpdateRestartRequest(
        request,
        session,
        "Process exited: ExitStatus { code: 0, signal: None }",
        "Updating Codex via `npm install -g @openai/codex`...\r\n" +
          "\x1b[32mUpdate ran successfully! Please restart Codex.\x1b[0m",
      ),
    ).toMatchObject({
      groupId: "project-codex",
      resumeSessionId: "native-codex-session",
      seedInput: null,
      restoreExistingSession: true,
      profileConfigPath: "C:/profiles/work",
      sandbox: true,
    });
    expect(
      codexUpdateRestartRequest(
        request,
        { ...session, capturedSessionId: null },
        "Process exited: ExitStatus { code: 0, signal: None }",
        "Updating Codex via `npm install -g @openai/codex`...\n" +
          "Update ran successfully! Please restart Codex.",
      ),
    ).toMatchObject({
      resumeSessionId: null,
      seedInput: "continue this task",
      restoreExistingSession: undefined,
    });
  });

  it("does not trust updater text without a successful first Codex exit", () => {
    const request = {
      definitionId: "codex",
      label: "OpenAI Codex",
      executable: "codex",
      arguments: [],
      resumeSessionId: null,
      workingDirectory: "D:/project/demo",
      cols: 120,
      rows: 30,
    };
    const session = {
      sessionId: "agent-codex",
      groupId: "agent-codex",
      groupLabel: "OpenAI Codex",
      definitionId: "codex",
      label: "OpenAI Codex",
      model: null,
      executable: "codex",
      launchArguments: [],
      workingDirectory: request.workingDirectory,
      state: "idle" as const,
      stateSource: "heuristic" as const,
      processId: 42,
      tokenUsage: null,
      queuedPrompts: 0,
      capturedSessionId: null,
    };
    const output =
      "Updating Codex via `npm install -g @openai/codex`...\n" +
      "Update ran successfully! Please restart Codex.";

    expect(
      codexUpdateRestartRequest(
        request,
        session,
        "Process exited: ExitStatus { code: 1, signal: None }",
        output,
      ),
    ).toBeNull();
    expect(
      codexUpdateRestartRequest(request, session, "Process exited: code 0", output),
    ).toBeNull();
    expect(
      codexUpdateRestartRequest(
        request,
        session,
        "Process exited: ExitStatus { code: 0, signal: None }",
        "Update ran successfully! Please restart Codex.",
      ),
    ).toBeNull();
    expect(
      codexUpdateRestartRequest(
        request,
        session,
        "Process exited: ExitStatus { code: 0, signal: None }",
        output,
        true,
      ),
    ).toBeNull();
    expect(
      codexUpdateRestartRequest(
        { ...request, definitionId: "claude" },
        { ...session, definitionId: "claude" },
        "Process exited: ExitStatus { code: 0, signal: None }",
        output,
      ),
    ).toBeNull();
  });

  it("keeps restore snapshot tombstones isolated from direct launches", () => {
    const guard = new AgentLaunchRaceGuard();
    const direct = guard.begin();
    const restore = guard.begin();
    guard.observeClosed("agent-fast", "Process exited: code 0");

    expect(direct.finish().closed.get("agent-fast")).toBe(
      "Process exited: code 0",
    );
    const restoreEvents = restore.finish();
    expect(restoreEvents.closed.get("agent-fast")).toBe(
      "Process exited: code 0",
    );

    const fastSession = {
      sessionId: "agent-fast",
      groupId: "agent-fast",
      groupLabel: "Fast CLI",
      definitionId: "custom",
      label: "Fast CLI",
      model: null,
      executable: "/bin/true",
      launchArguments: [],
      workingDirectory: "/work",
      state: "working" as const,
      stateSource: "heuristic" as const,
      processId: 42,
      tokenUsage: null,
      queuedPrompts: 0,
      capturedSessionId: null,
    };
    const closedIds = new Set(restoreEvents.closed.keys());
    expect(reconcileSessionSnapshot([], [fastSession], closedIds)).toEqual([]);
    expect(
      applyAgentRestoreLaunchEvents(
        [
          {
            planId: "plan-fast",
            label: "Fast CLI",
            session: fastSession,
            error: null,
          },
        ],
        restoreEvents,
      ),
    ).toEqual([
      {
        planId: "plan-fast",
        label: "Fast CLI",
        session: null,
        error: "Fast CLI exited during startup: Process exited: code 0",
      },
    ]);
  });

  it("merges lifecycle metadata that arrives before a launch response", () => {
    const guard = new AgentLaunchRaceGuard();
    const attempt = guard.begin();
    const tokenUsage = {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      reasoningTokens: 3,
      totalTokens: 21,
      apiCalls: 1,
    };
    guard.observeState({
      sessionId: "agent-starting",
      state: "working",
      source: "heuristic",
    });
    guard.observeState({
      sessionId: "agent-starting",
      state: "done",
      source: "integration",
    });
    guard.observeCaptured("agent-starting", "native-session-id");
    guard.observeModel({ sessionId: "agent-starting", model: "gpt-5.6-sol" });
    guard.observeUsage({ sessionId: "agent-starting", tokenUsage });

    const events = attempt.finish();
    const initial = {
      sessionId: "agent-starting",
      groupId: "agent-starting",
      groupLabel: "Codex",
      definitionId: "codex",
      label: "Codex",
      model: null,
      executable: "/usr/bin/codex",
      launchArguments: [],
      workingDirectory: "/work",
      state: "working" as const,
      stateSource: "heuristic" as const,
      processId: 42,
      tokenUsage: null,
      queuedPrompts: 0,
      capturedSessionId: null,
    };
    const settled = applyAgentLaunchEvents(initial, events);

    expect(settled).toMatchObject({
      state: "done",
      stateSource: "integration",
      capturedSessionId: "native-session-id",
      model: "gpt-5.6-sol",
      tokenUsage,
    });
    expect(
      applyAgentRestoreLaunchEvents(
        [
          {
            planId: "plan-codex",
            label: "Codex",
            session: initial,
            error: null,
          },
        ],
        events,
      )[0].session,
    ).toEqual(settled);
  });

  it("shows Antigravity as Google's single consumer item with Gemini login data", () => {
    const base = {
      adapterVersion: 1,
      resumeSupported: false,
      resumeLatestSupported: false,
      transcriptSupported: false,
      installed: true,
      installedPath: "C:\\bin\\agent.exe",
      consumerOauthDeprecated: false,
      account: { state: "unsupported" as const, label: null, method: null },
      install: {
        executable: null,
        arguments: [],
        displayCommand: "",
        sourceUrl: "",
        available: false,
      },
    };
    const catalog: AgentDefinition[] = [
      {
        ...base,
        id: "gemini",
        label: "Gemini CLI",
        executable: "gemini",
        consumerOauthDeprecated: true,
        account: {
          state: "signedIn",
          label: "user@example.com",
          method: "Google",
        },
      },
      {
        ...base,
        id: "antigravity",
        label: "Google Antigravity CLI",
        executable: "agy",
        transcriptSupported: true,
      },
    ];

    const displayed = agentCatalogForDisplay(catalog);

    expect(displayed.map((definition) => definition.id)).toEqual([
      "antigravity",
    ]);
    expect(displayed[0]).toMatchObject({
      label: "Google Antigravity CLI",
      transcriptSupported: true,
      account: {
        state: "signedIn",
        label: "user@example.com",
        method: "Google · Gemini CLI",
      },
      consumerOauthDeprecated: true,
    });

    const apiKeyCatalog = catalog.map((definition) =>
      definition.id === "gemini"
        ? { ...definition, consumerOauthDeprecated: false }
        : definition,
    );
    expect(
      agentCatalogForDisplay(apiKeyCatalog).map((definition) => definition.id),
    ).toEqual(["gemini", "antigravity"]);
  });

  it("round-trips arbitrary PTY bytes", () => {
    const bytes = new Uint8Array([0, 10, 27, 128, 200, 255]);
    expect(decodeAgentPayload(encodeAgentPayload(bytes))).toEqual(bytes);
  });

  it("replays a snapshot once and trims overlapping live events by offset", () => {
    const bytes = (value: string) =>
      encodeAgentPayload(new TextEncoder().encode(value));
    const chunks = reconcileAgentOutputSnapshot(
      {
        sessionId: "agent-session-1",
        startOffset: 0,
        endOffset: 4,
        base64: bytes("abcd"),
      },
      [
        {
          sessionId: "agent-session-1",
          offset: 2,
          base64: bytes("cdef"),
        },
        {
          sessionId: "agent-session-1",
          offset: 6,
          base64: bytes("gh"),
        },
      ],
    );

    expect(chunks.map((chunk) => chunk.offset)).toEqual([0, 4, 6]);
    const replay = new Uint8Array(
      chunks.reduce((total, chunk) => total + chunk.bytes.length, 0),
    );
    let offset = 0;
    for (const chunk of chunks) {
      replay.set(chunk.bytes, offset);
      offset += chunk.bytes.length;
    }
    expect(new TextDecoder().decode(replay)).toBe("abcdefgh");
  });

  it("rejects inconsistent output snapshot offsets", () => {
    expect(() =>
      reconcileAgentOutputSnapshot(
        {
          sessionId: "agent-session-1",
          startOffset: 10,
          endOffset: 20,
          base64: encodeAgentPayload(new TextEncoder().encode("short")),
        },
        [],
      ),
    ).toThrow("offsets are inconsistent");
  });

  it("treats each non-empty line as one direct argument", () => {
    expect(splitAgentArguments("--model\ngpt-5\n\n--full-auto")).toEqual([
      "--model",
      "gpt-5",
      "--full-auto",
    ]);
  });

  it("submits one normalized broadcast payload without saving shell syntax", () => {
    expect(buildAgentBroadcastPayload("Review this change\nReturn risks\n")).toBe(
      "Review this change\rReturn risks\r",
    );
    expect(buildAgentBroadcastPayload("   ")).toBe("");
  });

  it("updates both semantic state and its trusted source", () => {
    const sessions = [
      {
        sessionId: "agent-session-1",
        groupId: "agent-session-1",
        groupLabel: "Payments",
        definitionId: "codex",
        label: "Codex",
        model: "gpt-5",
        executable: "/usr/bin/codex",
        launchArguments: [],
        workingDirectory: "/work",
        state: "working" as const,
        stateSource: "heuristic" as const,
        processId: 42,
        tokenUsage: null,
        queuedPrompts: 0,
        capturedSessionId: null,
      },
    ];

    expect(
      applyAgentStateEvent(sessions, {
        sessionId: "agent-session-1",
        state: "done",
        source: "integration",
      })[0],
    ).toMatchObject({ state: "done", stateSource: "integration" });

    const tokenUsage = {
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 40,
      cacheWriteTokens: 5,
      reasoningTokens: 12,
      totalTokens: 195,
      apiCalls: 1,
    };
    expect(
      applyAgentUsageEvent(sessions, {
        sessionId: "agent-session-1",
        tokenUsage,
      })[0].tokenUsage,
    ).toEqual(tokenUsage);

    const queued = applyAgentQueueEvent(sessions, {
      sessionId: "agent-session-1",
      queuedPrompts: 3,
    });
    expect(queued[0].queuedPrompts).toBe(3);
    // Only the named session moves, and the source array is left alone.
    expect(queued.slice(1).every((session) => session.queuedPrompts === 0)).toBe(
      true,
    );
    expect(sessions[0].queuedPrompts).toBe(0);

    // An event for a session that is gone changes nothing.
    expect(
      applyAgentQueueEvent(sessions, {
        sessionId: "agent-missing",
        queuedPrompts: 9,
      }),
    ).toEqual(sessions);
  });

  it("moves saved launch plans by one position without mutating the source", () => {
    const plans = ["one", "two", "three"].map((id) => ({
      id,
      definitionId: "custom",
      label: id,
      executable: id,
      arguments: [],
      resumeSessionId: null,
      note: "",
      workingDirectory: "/work",
    }));

    const moved = moveAgentLaunchPlan(plans, "two", -1);
    expect(moved.map((plan) => plan.id)).toEqual(["two", "one", "three"]);
    expect(plans.map((plan) => plan.id)).toEqual(["one", "two", "three"]);
    expect(moveAgentLaunchPlan(plans, "one", -1)).toBe(plans);
  });

  it("keeps an exited CLI visible with a read-only close reason", () => {
    const session = {
      sessionId: "agent-ended",
      groupId: "agent-ended",
      groupLabel: "OpenAI Codex",
      definitionId: "codex",
      label: "OpenAI Codex",
      model: "gpt-5.6-terra",
      executable: "codex",
      launchArguments: [],
      workingDirectory: "D:/project/demo",
      state: "idle" as const,
      stateSource: "heuristic" as const,
      processId: 42,
      tokenUsage: null,
      queuedPrompts: 0,
      capturedSessionId: null,
    };

    const result = markAgentSessionClosed(
      [session],
      session.sessionId,
      "Process exited: ExitStatus { code: 0, signal: None }",
    );

    expect(result[0]).toEqual({
      ...session,
      state: "done",
      processId: null,
      closedReason: "Process exited: ExitStatus { code: 0, signal: None }",
    });
  });
});
