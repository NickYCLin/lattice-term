import { describe, expect, it } from "vitest";
import { agentSessionSidebarMemberNodeId } from "./agentSessionPresentation";
import {
  agentWorkspaceProjectNodeId,
  chatWorkspaceMirrorRows,
} from "./chatWorkspaceMirror";
import type { SessionSidebarLayout } from "./sessionSidebarLayout";
import { fakeDefinition, fakeSession } from "./testFixtures/agentApis";

describe("chat workspace mirror", () => {
  it("keeps the Work Sessions folder, project and session hierarchy", () => {
    const session = fakeSession({
      sessionId: "runtime-1",
      groupId: "group-1",
      label: "OpenAI Codex",
      workingDirectory: "D:\\project\\LatticeTerm",
      model: "gpt-5.6-sol",
      state: "done",
    });
    const projectNodeId = agentWorkspaceProjectNodeId(
      session.workingDirectory,
    );
    const sessionNodeId = agentSessionSidebarMemberNodeId(
      session.groupId,
      [session],
      0,
    );
    const layout: SessionSidebarLayout = {
      version: 1,
      folders: [{ id: "folder:client", name: "客戶專案" }],
      placements: {
        "folder:client": { parentId: null, order: 0 },
        [projectNodeId]: { parentId: "folder:client", order: 0 },
        [sessionNodeId]: { parentId: projectNodeId, order: 0 },
      },
      collapsedFolderIds: [],
    };

    const rows = chatWorkspaceMirrorRows(
      layout,
      [session],
      [fakeDefinition()],
      "一般對話",
    );

    expect(rows.map(({ kind, label, depth }) => ({ kind, label, depth }))).toEqual([
      { kind: "folder", label: "客戶專案", depth: 0 },
      { kind: "project", label: "LatticeTerm", depth: 1 },
      { kind: "session", label: "Codex · OpenAI Codex", depth: 2 },
    ]);
    expect(rows[2]).toMatchObject({
      sessionId: "runtime-1",
      detail: "gpt-5.6-sol",
      status: "done",
    });
  });

  it("can collapse a mirrored branch without changing the saved layout", () => {
    const session = fakeSession();
    const projectNodeId = agentWorkspaceProjectNodeId(
      session.workingDirectory,
    );
    const layout: SessionSidebarLayout = {
      version: 1,
      folders: [],
      placements: {},
      collapsedFolderIds: [],
    };

    const rows = chatWorkspaceMirrorRows(
      layout,
      [session],
      [fakeDefinition()],
      "一般對話",
      new Set([projectNodeId]),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "project",
      nodeId: projectNodeId,
      collapsed: true,
    });
    expect(layout).toEqual({
      version: 1,
      folders: [],
      placements: {},
      collapsedFolderIds: [],
    });
  });
});
