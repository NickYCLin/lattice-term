import { describe, expect, it, vi } from "vitest";
import type {
  AgentDefinition,
  AgentSessionSummary,
} from "./useAgentSessions";
import {
  agentRelocationContinuity,
  relocateAgentSessionGroup,
  summarizeAgentRelocation,
} from "./agentSessionRelocation";

function definition(
  overrides: Partial<AgentDefinition> = {},
): AgentDefinition {
  return {
    id: "codex",
    label: "OpenAI Codex",
    executable: "codex",
    adapterVersion: 1,
    resumeSupported: true,
    resumeLatestSupported: true,
    transcriptSupported: true,
    installed: true,
    installedPath: "C:\\bin\\codex.exe",
    consumerOauthDeprecated: false,
    account: {
      state: "signedIn",
      label: "user@example.com",
      method: "oauth",
    },
    install: {
      executable: null,
      arguments: [],
      displayCommand: "",
      sourceUrl: "https://example.com",
      available: false,
    },
    ...overrides,
  };
}

function session(
  overrides: Partial<AgentSessionSummary> = {},
): AgentSessionSummary {
  return {
    sessionId: "agent-old-1",
    groupId: "group-1",
    groupLabel: "LatticeTerm",
    definitionId: "codex",
    label: "OpenAI Codex",
    model: "gpt-5.6-sol",
    executable: "C:\\bin\\codex.exe",
    launchArguments: [],
    workingDirectory: "D:\\old",
    state: "idle",
    stateSource: "heuristic",
    processId: 123,
    tokenUsage: null,
    queuedPrompts: 0,
    capturedSessionId: "native-session-1",
    ...overrides,
  };
}

describe("Agent session folder relocation", () => {
  it("describes native resume, transcript handoff and unsupported custom commands", () => {
    const definitions = [definition()];
    expect(agentRelocationContinuity(session(), definitions)).toBe("native");
    expect(
      agentRelocationContinuity(
        session({ capturedSessionId: null }),
        definitions,
      ),
    ).toBe("handoff");
    expect(
      agentRelocationContinuity(
        session({ definitionId: "custom", capturedSessionId: null }),
        definitions,
      ),
    ).toBe("unsupported");
    expect(
      summarizeAgentRelocation(
        [session(), session({ sessionId: "agent-old-2", capturedSessionId: null })],
        definitions,
      ),
    ).toEqual({ native: 1, handoff: 1, restart: 0, unsupported: 0 });
  });

  it("restarts the group in the new folder before closing the old sessions", async () => {
    const members = [
      session({ profileConfigPath: "/profiles/b" }),
      session({
        sessionId: "agent-old-2",
        definitionId: "claude",
        label: "Claude Code",
        launchArguments: ["--model", "sonnet"],
        capturedSessionId: null,
      }),
    ];
    const definitions = [
      definition(),
      definition({
        id: "claude",
        label: "Claude Code",
        executable: "claude",
        resumeLatestSupported: false,
      }),
    ];
    const order: string[] = [];
    const launch = vi.fn(async (request) => {
      order.push(`launch:${request.definitionId}`);
      return session({
        sessionId: `agent-new-${request.definitionId}`,
        definitionId: request.definitionId,
        label: request.label,
        workingDirectory: request.workingDirectory,
        capturedSessionId: request.resumeSessionId,
      });
    });
    const disconnect = vi.fn(async (sessionId: string) => {
      order.push(`disconnect:${sessionId}`);
    });
    const exportTranscript = vi.fn(async () => "Earlier Claude conversation");

    const outcome = await relocateAgentSessionGroup({
      sessions: members,
      definitions,
      activeSessionId: "agent-old-2",
      workingDirectory: "D:\\new",
      formatHandoff: (transcript) => `handoff:${transcript}`,
      api: { launch, disconnect, exportTranscript },
    });

    expect(launch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        groupId: "group-1",
        label: "OpenAI Codex",
        resumeSessionId: "native-session-1",
        seedInput: null,
        restoreExistingSession: true,
        profileConfigPath: "/profiles/b",
        workingDirectory: "D:\\new",
      }),
    );
    expect(launch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        arguments: ["--model", "sonnet"],
        resumeSessionId: null,
        seedInput: "handoff:Earlier Claude conversation",
        workingDirectory: "D:\\new",
      }),
    );
    expect(order.slice(0, 2)).toEqual(["launch:codex", "launch:claude"]);
    expect(outcome.selectedSessionId).toBe("agent-new-claude");
    expect(outcome.closeFailures).toEqual([]);
  });

  it.each([
    ["an export error", new Error("History is unreadable")],
    ["a missing transcript", null],
    ["an empty transcript", ""],
    ["a whitespace-only transcript", "  \n\t"],
  ])(
    "keeps every original session when a handoff has %s",
    async (_label, transcriptResult) => {
      const members = [
        session(),
        session({
          sessionId: "agent-old-2",
          definitionId: "claude",
          label: "Claude Code",
          capturedSessionId: null,
        }),
      ];
      const launch = vi.fn();
      const disconnect = vi.fn();
      const exportTranscript =
        transcriptResult instanceof Error
          ? vi.fn().mockRejectedValue(transcriptResult)
          : vi.fn().mockResolvedValue(transcriptResult);

      await expect(
        relocateAgentSessionGroup({
          sessions: members,
          definitions: [definition(), definition({ id: "claude" })],
          activeSessionId: "agent-old-1",
          workingDirectory: "D:\\new",
          formatHandoff: (transcript) => `handoff:${transcript}`,
          api: { launch, disconnect, exportTranscript },
        }),
      ).rejects.toThrow(
        transcriptResult instanceof Error
          ? "History is unreadable"
          : "No conversation history could be exported for Claude Code.",
      );

      expect(exportTranscript).toHaveBeenCalledOnce();
      expect(exportTranscript).toHaveBeenCalledWith("agent-old-2");
      expect(launch).not.toHaveBeenCalled();
      expect(disconnect).not.toHaveBeenCalled();
    },
  );

  it("rolls back replacements when a later CLI cannot start", async () => {
    const members = [
      session(),
      session({ sessionId: "agent-old-2", definitionId: "claude" }),
    ];
    const launch = vi
      .fn()
      .mockResolvedValueOnce(session({ sessionId: "agent-new-1" }))
      .mockRejectedValueOnce(new Error("Claude could not start"));
    const disconnect = vi.fn().mockResolvedValue(undefined);

    await expect(
      relocateAgentSessionGroup({
        sessions: members,
        definitions: [definition(), definition({ id: "claude" })],
        activeSessionId: "agent-old-1",
        workingDirectory: "D:\\new",
        formatHandoff: (transcript) => transcript,
        api: {
          launch,
          disconnect,
          exportTranscript: vi.fn().mockResolvedValue(null),
        },
      }),
    ).rejects.toThrow("Claude could not start");

    expect(disconnect).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledWith("agent-new-1");
    expect(disconnect).not.toHaveBeenCalledWith("agent-old-1");
    expect(disconnect).not.toHaveBeenCalledWith("agent-old-2");
  });

  it("reports old sessions that remain after replacements are ready", async () => {
    const members = [
      session(),
      session({ sessionId: "agent-old-2", capturedSessionId: "native-session-2" }),
    ];
    const launch = vi
      .fn()
      .mockResolvedValueOnce(session({ sessionId: "agent-new-1" }))
      .mockResolvedValueOnce(session({ sessionId: "agent-new-2" }));
    const disconnect = vi.fn(async (sessionId: string) => {
      if (sessionId === "agent-old-1") {
        throw new Error("Still running");
      }
    });

    const outcome = await relocateAgentSessionGroup({
      sessions: members,
      definitions: [definition()],
      activeSessionId: "agent-old-1",
      workingDirectory: "D:\\new",
      formatHandoff: (transcript) => transcript,
      api: {
        launch,
        disconnect,
        exportTranscript: vi.fn().mockResolvedValue(null),
      },
    });

    expect(outcome.selectedSessionId).toBe("agent-new-1");
    expect(outcome.closeFailures).toEqual(["agent-old-1"]);
    expect(disconnect).toHaveBeenCalledWith("agent-old-2");
  });
});
