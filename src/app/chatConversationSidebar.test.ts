import { describe, expect, it } from "vitest";
import { chatConversationSidebar, nativeConversationNodeId } from "./chatConversationSidebar";
import type { ChatAccountProfile } from "./chatAccountProfiles";
import { chatSidebarLayout, chatSidebarRows, chatThreadNodeId } from "./chatThreadLayout";
import type { LocalConversation } from "./localConversationSessions";
import { createSessionSidebarFolder, emptySessionSidebarLayout, moveSessionSidebarNode, toggleSessionSidebarFolder } from "./sessionSidebarLayout";
import { fakeDefinition, fakeSession, fakeThread } from "./testFixtures/agentApis";

function conversation(overrides: Partial<LocalConversation> = {}): LocalConversation {
  return { definitionId: "codex", profileId: null, nativeSessionId: "native-1", title: "修正側欄", workingDirectory: "/work", resumable: true, updatedAt: 1, ...overrides };
}

const profiles: ChatAccountProfile[] = [
  { id: "personal", definitionId: "codex", name: "個人", configDirectory: "D:/profiles/personal" },
  { id: "work", definitionId: "codex", name: "工作", configDirectory: "D:/profiles/work" },
];

function sidebar(overrides: Partial<Parameters<typeof chatConversationSidebar>[0]> = {}) {
  return chatConversationSidebar({ sessions: [], definitions: [fakeDefinition()], threads: [], history: [], profiles,
    generalProjectLabel: "一般對話", projectFilter: null, ...overrides });
}

function rows(result: ReturnType<typeof sidebar>) {
  const layout = chatSidebarLayout(emptySessionSidebarLayout, result.listedThreads, result.workspace.nodes);
  return chatSidebarRows(layout, result.listedThreads, result.workspace);
}

describe("conversation sidebar identity", () => {
  it("retains the legacy drive-root sidebar ID while filtering absolute paths", () => {
    const result = sidebar({ history: [conversation({ workingDirectory: "C:\\" })], projectFilter: "c:/" });
    expect([...result.workspace.projects.keys()]).toEqual(["project:local:C:"]);
    expect(result.workspace.nodes.find(node => node.id === nativeConversationNodeId(conversation()))?.defaultParentId)
      .toBe("project:local:C:");
  });
  it("shows a running native conversation once under one project", () => {
    const result = sidebar({ sessions: [fakeSession({ capturedSessionId: "native-1" })],
      threads: [fakeThread({ nativeSessionId: "native-1" })], history: [conversation()] });
    expect(rows(result).map(row => row.kind)).toEqual(["project", "session"]);
    expect([...result.workspace.sessions.values()][0].label).toBe("修正側欄");
    expect(result.listedThreads).toEqual([]);
    expect(result.workspace.nativeConversations.size).toBe(0);
  });

  it("uses the imported title when history has not loaded yet", () => {
    const result = sidebar({ sessions: [fakeSession({ capturedSessionId: "native-1" })],
      threads: [fakeThread({ nativeSessionId: "native-1", title: "處理佇列" })] });
    expect([...result.workspace.sessions.values()][0].label).toBe("處理佇列");
  });

  it("preserves custom group labels", () => {
    const result = sidebar({ sessions: [fakeSession({ capturedSessionId: "native-1", groupLabel: "我的工作" })], history: [conversation()] });
    expect([...result.workspace.sessions.values()][0].label).toBe("我的工作 · Codex");
  });

  it("recognizes automatic group labels regardless of case", () => {
    const result = sidebar({ sessions: [fakeSession({ capturedSessionId: "native-1", groupLabel: " openai codex " })], history: [conversation()] });
    expect([...result.workspace.sessions.values()][0].label).toBe("修正側欄");
  });

  it("does not overwrite a custom group with multiple CLI members", () => {
    const result = sidebar({ sessions: [fakeSession({ capturedSessionId: "native-1", groupLabel: "部署" }),
      fakeSession({ sessionId: "claude-runtime", definitionId: "claude", label: "Claude", groupLabel: "部署" })], history: [conversation()] });
    expect([...result.workspace.sessions.values()].map(leaf => leaf.label)).toEqual(["部署 · Codex", "部署 · Claude"]);
  });

  it("keeps different native IDs, CLIs and accounts even with matching titles", () => {
    const result = sidebar({ sessions: [fakeSession({ capturedSessionId: "native-1" })], history: [conversation(),
      conversation({ nativeSessionId: "native-2" }), conversation({ definitionId: "claude" }),
      conversation({ profileId: "personal" }), conversation({ profileId: "work" })] });
    expect(rows(result).filter(row => row.kind === "project")).toHaveLength(1);
    expect(rows(result).filter(row => row.kind === "native")).toHaveLength(4);
  });

  it("matches a named account by its Windows configuration path", () => {
    const result = sidebar({ sessions: [fakeSession({ capturedSessionId: "native-1", profileConfigPath: "d:\\profiles\\PERSONAL\\" })],
      history: [conversation({ profileId: "personal" }), conversation()] });
    expect([...result.workspace.nativeConversations.values()].map(entry => entry.profileId)).toEqual([null]);
  });

  it("does not guess missing or wrong-CLI profiles", () => {
    const result = sidebar({ sessions: [fakeSession({ capturedSessionId: "native-1" })], history: [conversation({ profileId: "missing" }),
      conversation({ definitionId: "claude", profileId: "personal" })] });
    expect(result.workspace.nativeConversations.size).toBe(2);
  });

  it("keeps remote threads separate from local sessions and history with the same ID", () => {
    const remote = fakeThread({ nativeSessionId: "native-1",
      remote: { targetId: "remote-host", targetLabel: "遠端", planId: "plan", sessionId: "remote-session", cursor: 0 } });
    const live = sidebar({ sessions: [fakeSession({ capturedSessionId: "native-1" })], threads: [remote], history: [conversation()] });
    expect(live.listedThreads).toEqual([remote]);
    expect(rows(live).map(row => row.kind)).toEqual(["project", "session", "thread"]);
    const idle = sidebar({ threads: [remote], history: [conversation()] });
    expect(idle.workspace.nativeConversations.size).toBe(1);
    expect(idle.listedThreads).toEqual([remote]);
  });

  it("does not merge a session whose native ID has not been captured", () => {
    const result = sidebar({ sessions: [fakeSession({ label: "修正側欄" })], history: [conversation()] });
    expect(rows(result).map(row => row.kind)).toEqual(["project", "session", "native"]);
  });

  it("deduplicates history only by exact CLI, account and native ID", () => {
    const result = sidebar({ history: [conversation(), conversation(), conversation({ profileId: "personal" })] });
    expect(result.workspace.nativeConversations.size).toBe(2);
  });

  it("does not resurface shelved threads or archived history", () => {
    const result = sidebar({ threads: [fakeThread({ nativeSessionId: "native-1", shelvedAt: 5 })],
      history: [conversation(), conversation({ nativeSessionId: "archived", archived: true })] });
    expect(rows(result)).toEqual([]);
  });

  it("replaces a known closed session with history but keeps unknown failures", () => {
    const result = sidebar({ sessions: [fakeSession({ capturedSessionId: "native-1", closedReason: "processExit" }),
      fakeSession({ sessionId: "failed", groupId: "failed", closedReason: "processExit" })], history: [conversation()] });
    expect([...result.workspace.sessions.values()].map(leaf => leaf.sessionId)).toEqual(["failed"]);
    expect(result.workspace.nativeConversations.size).toBe(1);
  });

  it("groups Windows slash, case and trailing-slash variations together", () => {
    const result = sidebar({ sessions: [fakeSession({ workingDirectory: "D:\\project\\App" })],
      threads: [fakeThread({ workingDirectory: "d:/PROJECT/App/" })], history: [conversation({ workingDirectory: "D:/project/app" })] });
    expect(rows(result).filter(row => row.kind === "project")).toHaveLength(1);
    expect(rows(result).map(row => row.kind)).toEqual(["project", "session", "native", "thread"]);
  });

  it("keeps POSIX project paths case-sensitive", () => {
    const result = sidebar({ history: [conversation({ workingDirectory: "/work/App" }),
      conversation({ nativeSessionId: "native-2", workingDirectory: "/work/app" })] });
    expect(rows(result).filter(row => row.kind === "project")).toHaveLength(2);
  });

  it("does not collide with a legacy live project ID when POSIX paths differ in case", () => {
    for (const [liveDirectory, historyDirectory] of [["/work/App", "/work/app"], ["/work/app", "/work/App"]]) {
      const result = sidebar({ sessions: [fakeSession({ workingDirectory: liveDirectory })],
        history: [conversation({ workingDirectory: historyDirectory }),
          conversation({ nativeSessionId: "same-project", workingDirectory: liveDirectory })] });
      expect(rows(result).filter(row => row.kind === "project")).toHaveLength(2);
      const historyNodes = result.workspace.nodes.filter(node => node.id.startsWith("native:"));
      expect(historyNodes[0].defaultParentId).not.toBe(historyNodes[1].defaultParentId);
    }
  });

  it("applies the same project filter to all conversation sources", () => {
    const result = sidebar({ projectFilter: "d:/project/app/", sessions: [fakeSession({ workingDirectory: "D:\\project\\App" }),
      fakeSession({ sessionId: "other", groupId: "other", workingDirectory: "/other" })],
      threads: [fakeThread({ workingDirectory: "/other" })], history: [conversation({ workingDirectory: "/other" }),
      conversation({ nativeSessionId: "filtered", workingDirectory: "D:/project/APP" })] });
    expect(rows(result).map(row => row.kind)).toEqual(["project", "session", "native"]);
  });
});

describe("conversation sidebar placement", () => {
  it("keeps a manually filed history row's folder and order after import", () => {
    const entry = conversation();
    const before = sidebar({ history: [entry, conversation({ nativeSessionId: "other" })] });
    let layout = chatSidebarLayout(emptySessionSidebarLayout, [], before.workspace.nodes);
    layout = createSessionSidebarFolder(layout, { id: "folder:work", name: "工作" }, null);
    layout = moveSessionSidebarNode(layout, nativeConversationNodeId(entry), "folder:work");
    const imported = fakeThread({ nativeSessionId: entry.nativeSessionId });
    const after = sidebar({ threads: [imported], history: [entry] });
    const next = chatSidebarLayout(layout, after.listedThreads, after.workspace.nodes);
    expect(next.placements[chatThreadNodeId(imported.id)]).toEqual(layout.placements[nativeConversationNodeId(entry)]);
    expect(chatSidebarRows(next, after.listedThreads, after.workspace).map(row => row.kind)).toEqual(["folder", "thread"]);
  });

  it("does not move an explicitly top-level thread into its project", () => {
    const thread = fakeThread();
    const previous = chatSidebarLayout(emptySessionSidebarLayout, [thread]);
    const result = sidebar({ threads: [thread], history: [conversation()] });
    const next = chatSidebarLayout(previous, result.listedThreads, result.workspace.nodes);
    expect(next.placements[chatThreadNodeId(thread.id)].parentId).toBeNull();
  });

  it("keeps an imported thread's own placement instead of copying history", () => {
    const entry = conversation();
    const thread = fakeThread({ nativeSessionId: entry.nativeSessionId });
    const before = sidebar({ history: [entry] });
    let layout = chatSidebarLayout(emptySessionSidebarLayout, [thread], before.workspace.nodes);
    layout = createSessionSidebarFolder(layout, { id: "folder:work", name: "工作" }, null);
    layout = moveSessionSidebarNode(layout, nativeConversationNodeId(entry), "folder:work");
    expect(chatSidebarLayout(layout, [thread]).placements[chatThreadNodeId(thread.id)].parentId).toBeNull();
  });

  it("collapses history, running sessions and threads together", () => {
    const result = sidebar({ sessions: [fakeSession()], threads: [fakeThread()], history: [conversation()] });
    const layout = chatSidebarLayout(emptySessionSidebarLayout, result.listedThreads, result.workspace.nodes);
    const projectId = [...result.workspace.projects.keys()][0];
    const collapsed = toggleSessionSidebarFolder(layout, projectId);
    expect(chatSidebarRows(collapsed, result.listedThreads, result.workspace).map(row => row.kind)).toEqual(["project"]);
    expect(chatSidebarRows(toggleSessionSidebarFolder(collapsed, projectId), result.listedThreads, result.workspace)).toHaveLength(4);
  });
});
