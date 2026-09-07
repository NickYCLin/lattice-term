import { describe, expect, it } from "vitest";
import {
  agentFreshLaunchArguments,
  agentRestoreArguments,
  loadWorkspaceSessionSnapshot,
  preserveUnrestoredWorkspaceSessions,
  savedAgentWorkingDirectories,
  saveWorkspaceSessionSnapshot,
  sanitizeWorkspaceSessionSnapshot,
  snapshotLiveWorkspaceSessions,
  WORKSPACE_SESSIONS_KEY,
  type StorageReaderWriter,
} from "./workspaceSessionPersistence";

function storage(): StorageReaderWriter & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "agent-live-1",
    groupId: "project-group-1",
    groupLabel: "LatticeTerm",
    definitionId: "codex",
    label: "OpenAI Codex",
    model: null,
    executable: "C:\\tools\\codex.cmd",
    launchArguments: [],
    restoreExistingSession: false,
    workingDirectory: "D:\\project\\LatticeTerm",
    state: "working" as const,
    stateSource: "heuristic" as const,
    processId: 42,
    tokenUsage: null,
    queuedPrompts: 0,
    capturedSessionId: "native-chat-1",
    ...overrides,
  };
}

describe("workspace session persistence", () => {
  it("preserves both accounts, the selected account, and a failed account restore", () => {
    const a = agent({ profileConfigPath: "/profiles/a" });
    const b = agent({ sessionId: "b", profileConfigPath: "/profiles/b", capturedSessionId: "native-b" });
    const snapshot = snapshotLiveWorkspaceSessions([a, b], [], "b");
    const target = storage();
    saveWorkspaceSessionSnapshot(target, snapshot);
    expect(loadWorkspaceSessionSnapshot(target)).toEqual(snapshot);
    expect(snapshot.active).toMatchObject({ profileConfigPath: "/profiles/b" });
    const live = snapshotLiveWorkspaceSessions([a], [], null);
    const merged = preserveUnrestoredWorkspaceSessions(live, [snapshot.sessions[1]], snapshot.active);
    expect(merged.sessions).toHaveLength(2);
    expect(merged.active).toEqual(snapshot.active);
    const damaged = { ...snapshot, sessions: [{ ...snapshot.sessions[1], profileConfigPath: "\u0000" }] };
    expect(sanitizeWorkspaceSessionSnapshot(damaged)).toBeNull();
  });

  it("stores only restorable agent metadata and SSH profile IDs", () => {
    const snapshot = snapshotLiveWorkspaceSessions(
      [agent()],
      [
        {
          sessionId: "ssh-live-1",
          profileId: "profile-1",
          host: "private.example",
          port: 22,
          username: "operator",
        },
      ],
      "agent-live-1",
    );
    const encoded = JSON.stringify(snapshot);

    expect(snapshot.sessions).toEqual([
      expect.objectContaining({
        kind: "agent",
        groupLabel: "LatticeTerm",
        launchArguments: [],
        resumeSessionId: "native-chat-1",
      }),
      { kind: "ssh", profileId: "profile-1" },
    ]);
    for (const secretField of ["password", "passphrase", "token", "terminalOutput"]) {
      expect(encoded).not.toContain(secretField);
    }
    expect(encoded).not.toContain("private.example");
  });

  it("round trips a valid snapshot", () => {
    const target = storage();
    const snapshot = snapshotLiveWorkspaceSessions([agent()], [], "agent-live-1");

    saveWorkspaceSessionSnapshot(target, snapshot);

    expect(loadWorkspaceSessionSnapshot(target)).toEqual(snapshot);
    expect(target.values.has(WORKSPACE_SESSIONS_KEY)).toBe(true);
  });

  it("keeps saved Agent directories available when no CLI process restored", () => {
    const first = snapshotLiveWorkspaceSessions(
      [
        agent({ workingDirectory: "D:\\project\\LatticeTerm" }),
        agent({
          sessionId: "agent-live-2",
          groupId: "project-group-2",
          definitionId: "claude",
          workingDirectory: "d:/PROJECT/LatticeTerm/",
        }),
      ],
      [],
      null,
    );

    expect(
      savedAgentWorkingDirectories([
        ...first.sessions,
        { kind: "ssh", profileId: "server" },
      ]),
    ).toEqual(["D:\\project\\LatticeTerm"]);
  });

  it("keeps an exited CLI when its native conversation can be resumed", () => {
    const snapshot = snapshotLiveWorkspaceSessions(
      [
        agent({
          state: "done",
          processId: null,
          closedReason: "Process exited: ExitStatus { code: 0, signal: None }",
          capturedSessionId: "native-chat-finished",
        }),
      ],
      [],
      "agent-live-1",
    );

    expect(snapshot.sessions).toEqual([
      expect.objectContaining({
        kind: "agent",
        resumeSessionId: "native-chat-finished",
      }),
    ]);
    expect(snapshot.active).toEqual({
      kind: "agent",
      groupKey: "project-group-1",
      definitionId: "codex",
    });
  });

  it("does not save a failed native resume for another restart", () => {
    const snapshot = snapshotLiveWorkspaceSessions(
      [
        agent({
          state: "done",
          processId: null,
          closedReason: "Process exited: ExitStatus { code: 1, signal: None }",
          capturedSessionId: "expired-native-chat",
        }),
      ],
      [],
      "agent-live-1",
    );

    expect(snapshot.sessions).toEqual([]);
    expect(snapshot.active).toBeNull();
  });

  it("does not reopen an exited CLI with no native conversation id", () => {
    const snapshot = snapshotLiveWorkspaceSessions(
      [
        agent({
          state: "done",
          processId: null,
          closedReason: "Process exited: ExitStatus { code: 0, signal: None }",
          capturedSessionId: null,
        }),
      ],
      [],
      "agent-live-1",
    );

    expect(snapshot.sessions).toEqual([]);
    expect(snapshot.active).toBeNull();
  });

  it("keeps a failed automatic restore until the user closes its tab", () => {
    const snapshot = snapshotLiveWorkspaceSessions(
      [
        agent({
          state: "done",
          processId: null,
          closedReason: "Process exited: ExitStatus { code: 1, signal: None }",
          capturedSessionId: null,
          restoreExistingSession: true,
        }),
      ],
      [],
      "agent-live-1",
    );

    expect(snapshot.sessions).toEqual([
      expect.objectContaining({
        kind: "agent",
        definitionId: "codex",
        resumeSessionId: null,
      }),
    ]);
    expect(snapshot.active).toEqual({
      kind: "agent",
      groupKey: "project-group-1",
      definitionId: "codex",
    });
  });

  it("keeps sessions whose automatic restoration did not succeed", () => {
    const live = snapshotLiveWorkspaceSessions(
      [agent({ sessionId: "agent-new", groupId: "group-new" })],
      [],
      null,
    );
    const unresolved = snapshotLiveWorkspaceSessions(
      [agent({ sessionId: "agent-old", groupId: "group-old" })],
      [],
      "agent-old",
    );

    const merged = preserveUnrestoredWorkspaceSessions(
      live,
      unresolved.sessions,
      unresolved.active,
    );

    expect(merged.sessions).toHaveLength(2);
    expect(merged.active).toEqual({
      kind: "agent",
      groupKey: "group-old",
      definitionId: "codex",
    });
  });

  it("fails closed for malformed or oversized state", () => {
    expect(sanitizeWorkspaceSessionSnapshot({ version: 1, sessions: "bad" })).toBeNull();
    expect(
      sanitizeWorkspaceSessionSnapshot({
        version: 1,
        sessions: Array.from({ length: 65 }, () => ({
          kind: "ssh",
          profileId: "profile",
        })),
      }),
    ).toBeNull();
  });

  it("uses the verified latest-session flags only when no native id exists", () => {
    const codex = snapshotLiveWorkspaceSessions(
      [agent({ capturedSessionId: null })],
      [],
      null,
    ).sessions[0];
    const antigravity = snapshotLiveWorkspaceSessions(
      [
        agent({
          definitionId: "antigravity",
          capturedSessionId: null,
        }),
      ],
      [],
      null,
    ).sessions[0];
    const claude = snapshotLiveWorkspaceSessions(
      [
        agent({
          definitionId: "claude",
          capturedSessionId: null,
          launchArguments: ["--model", "sonnet"],
        }),
      ],
      [],
      null,
    ).sessions[0];
    const cursor = snapshotLiveWorkspaceSessions(
      [agent({ definitionId: "cursor", capturedSessionId: null })],
      [],
      null,
    ).sessions[0];

    expect(codex.kind === "agent" && agentRestoreArguments(codex)).toEqual([
      "resume",
      "--last",
    ]);
    expect(
      antigravity.kind === "agent" && agentRestoreArguments(antigravity),
    ).toEqual(["--continue"]);
    expect(claude.kind === "agent" && agentRestoreArguments(claude)).toEqual([
      "--continue",
      "--model",
      "sonnet",
    ]);
    expect(cursor.kind === "agent" && agentRestoreArguments(cursor)).toEqual([
      "--continue",
    ]);
  });

  it("does not accumulate continuation flags in restored launch metadata", () => {
    const codex = sanitizeWorkspaceSessionSnapshot({
      version: 1,
      sessions: [
        {
          kind: "agent",
          groupKey: "group-codex",
          groupLabel: "OpenAI Codex",
          definitionId: "codex",
          label: "OpenAI Codex",
          executable: "C:\\tools\\codex.cmd",
          launchArguments: ["resume", "--last"],
          workingDirectory: "D:\\project",
          resumeSessionId: null,
        },
      ],
      active: null,
    })?.sessions[0];

    expect(codex?.kind).toBe("agent");
    if (!codex || codex.kind !== "agent") return;
    expect(agentFreshLaunchArguments(codex)).toEqual([]);
    expect(agentRestoreArguments(codex)).toEqual(["resume", "--last"]);
  });

  it("never writes more entries than a later start will accept", () => {
    const agents = Array.from({ length: 40 }, (_, index) =>
      agent({
        sessionId: `agent-${index}`,
        groupId: `group-${index}`,
        capturedSessionId: `native-${index}`,
      }),
    );
    const unrestored = Array.from({ length: 40 }, (_, index) => ({
      kind: "ssh" as const,
      profileId: `profile-${index}`,
    }));

    const snapshot = preserveUnrestoredWorkspaceSessions(
      snapshotLiveWorkspaceSessions(agents, [], "agent-3"),
      unrestored,
      null,
    );

    expect(snapshot.sessions).toHaveLength(64);
    // Sessions still open outrank entries that already failed to restore.
    expect(
      snapshot.sessions.filter((session) => session.kind === "agent"),
    ).toHaveLength(40);
    expect(snapshot.active).toEqual({
      kind: "agent",
      groupKey: "group-3",
      definitionId: "codex",
    });
    // The reader must accept exactly what the writer produced.
    expect(sanitizeWorkspaceSessionSnapshot(snapshot)).toEqual(snapshot);
  });

  it("drops an active pointer that did not survive the size limit", () => {
    const agents = Array.from({ length: 70 }, (_, index) =>
      agent({
        sessionId: `agent-${index}`,
        groupId: `group-${index}`,
        capturedSessionId: `native-${index}`,
      }),
    );

    const snapshot = snapshotLiveWorkspaceSessions(agents, [], "agent-69");

    expect(snapshot.sessions).toHaveLength(64);
    expect(snapshot.active).toBeNull();
    expect(sanitizeWorkspaceSessionSnapshot(snapshot)).toEqual(snapshot);
  });

  it("rejects a snapshot whose argument list is not an array", () => {
    expect(
      sanitizeWorkspaceSessionSnapshot({
        version: 1,
        sessions: [
          {
            kind: "agent",
            groupKey: "group",
            groupLabel: "LatticeTerm",
            definitionId: "codex",
            label: "OpenAI Codex",
            executable: "/usr/bin/codex",
            launchArguments: "--model gpt-5.6-sol",
            workingDirectory: "/workspace",
            resumeSessionId: null,
          },
        ],
        active: null,
      }),
    ).toBeNull();
  });

  it("preserves explicit CLI arguments when no native session id exists", () => {
    const saved = snapshotLiveWorkspaceSessions(
      [
        agent({
          capturedSessionId: null,
          launchArguments: ["--model", "gpt-5.6-sol"],
        }),
      ],
      [],
      null,
    ).sessions[0];

    expect(saved.kind === "agent" && agentRestoreArguments(saved)).toEqual([
      "--model",
      "gpt-5.6-sol",
    ]);
  });
});
