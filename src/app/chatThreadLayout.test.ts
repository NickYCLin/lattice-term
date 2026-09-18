import { describe, expect, it } from "vitest";
import { createThread, type ChatThread } from "./agentChat";
import {
  chatSidebarLayout,
  chatSidebarRows,
  chatThreadNodeId,
  reconcileChatLayout,
} from "./chatThreadLayout";
import { chatWorkspaceProjection } from "./chatWorkspaceNodes";
import { fakeDefinition, fakeSession } from "./testFixtures/agentApis";
import {
  createSessionSidebarFolder,
  emptySessionSidebarLayout,
  moveSessionSidebarNode,
  toggleSessionSidebarFolder,
} from "./sessionSidebarLayout";

function thread(id: string): ChatThread {
  return createThread(
    { definitionId: "claude", workingDirectory: "/w", permission: "ask", model: "" },
    id,
    1,
  );
}

describe("chat thread folders", () => {
  const threads = [thread("a"), thread("b"), thread("c")];

  it("seats new threads at the top level and forgets deleted ones", () => {
    const layout = reconcileChatLayout(emptySessionSidebarLayout, threads);
    expect(Object.keys(layout.placements).sort()).toEqual([
      "thread:a",
      "thread:b",
      "thread:c",
    ]);
    const fewer = reconcileChatLayout(layout, threads.slice(0, 1));
    expect(Object.keys(fewer.placements)).toEqual(["thread:a"]);
  });

  it("lists folders with their threads, indented, and hides collapsed branches", () => {
    let layout = reconcileChatLayout(emptySessionSidebarLayout, threads);
    layout = createSessionSidebarFolder(layout, { id: "folder:work", name: "工作" }, null);
    layout = moveSessionSidebarNode(layout, chatThreadNodeId("b"), "folder:work");

    const rows = chatSidebarRows(layout, threads);
    expect(rows.map((row) => [row.kind, row.nodeId, row.depth])).toEqual([
      ["thread", "thread:a", 0],
      ["thread", "thread:c", 0],
      ["folder", "folder:work", 0],
      ["thread", "thread:b", 1],
    ]);

    const collapsed = toggleSessionSidebarFolder(layout, "folder:work");
    const hidden = chatSidebarRows(collapsed, threads);
    expect(hidden.map((row) => row.nodeId)).toEqual(["thread:a", "thread:c", "folder:work"]);
    expect(hidden[2]).toMatchObject({ kind: "folder", collapsed: true, empty: false });
  });

  it("keeps a thread's folder across reconciliation", () => {
    let layout = reconcileChatLayout(emptySessionSidebarLayout, threads);
    layout = createSessionSidebarFolder(layout, { id: "folder:work", name: "工作" }, null);
    layout = moveSessionSidebarNode(layout, chatThreadNodeId("a"), "folder:work");
    const again = reconcileChatLayout(layout, [...threads, thread("d")]);
    expect(again.placements["thread:a"].parentId).toBe("folder:work");
    expect(again.placements["thread:d"].parentId).toBeNull();
  });
});

describe("conversations and sessions in one tree", () => {
  const threads = [thread("a")];
  const workspace = chatWorkspaceProjection(
    [fakeSession({ sessionId: "runtime-1", groupId: "group-1", workingDirectory: "/w/site" })],
    [fakeDefinition()],
    "一般對話",
  );
  const [projectNode, sessionNode] = workspace.nodes;

  it("lists a session and a conversation side by side under the same folder", () => {
    let layout = chatSidebarLayout(emptySessionSidebarLayout, threads, workspace.nodes);
    layout = createSessionSidebarFolder(layout, { id: "folder:work", name: "工作" }, null);
    layout = moveSessionSidebarNode(layout, projectNode.id, "folder:work");
    layout = moveSessionSidebarNode(layout, chatThreadNodeId("a"), "folder:work");

    const rows = chatSidebarRows(layout, threads, workspace);
    expect(rows.map((row) => [row.kind, row.nodeId, row.depth])).toEqual([
      ["folder", "folder:work", 0],
      ["project", projectNode.id, 1],
      ["session", sessionNode.id, 2],
      ["thread", "thread:a", 1],
    ]);
  });

  it("keeps a session's place when the conversation tree is reconciled again", () => {
    let layout = chatSidebarLayout(emptySessionSidebarLayout, threads, workspace.nodes);
    layout = createSessionSidebarFolder(layout, { id: "folder:work", name: "工作" }, null);
    layout = moveSessionSidebarNode(layout, sessionNode.id, "folder:work");
    // A conversation edit happens while no session is running.
    const later = reconcileChatLayout(layout, [...threads, thread("b")]);
    expect(later.placements[sessionNode.id].parentId).toBe("folder:work");
  });

  it("shows nothing for a project whose sessions have all ended", () => {
    const layout = chatSidebarLayout(emptySessionSidebarLayout, threads, workspace.nodes);
    const rows = chatSidebarRows(layout, threads, { projects: workspace.projects, sessions: new Map() });
    expect(rows.map((row) => row.kind)).toEqual(["thread"]);
  });
});
