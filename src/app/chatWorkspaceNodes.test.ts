import { describe, expect, it } from "vitest";
import { agentSessionSidebarMemberNodeId } from "./agentSessionPresentation";
import {
  agentWorkspaceProjectNodeId,
  chatWorkspaceProjection,
} from "./chatWorkspaceNodes";
import { fakeDefinition, fakeSession } from "./testFixtures/agentApis";

describe("chat workspace projection", () => {
  it("names each session and seats it under the project it runs in", () => {
    const session = fakeSession({
      sessionId: "runtime-1",
      groupId: "group-1",
      label: "OpenAI Codex",
      workingDirectory: "D:\\project\\LatticeTerm",
      model: "gpt-5.6-sol",
      state: "done",
    });
    const projectNodeId = agentWorkspaceProjectNodeId(session.workingDirectory);
    const sessionNodeId = agentSessionSidebarMemberNodeId(session.groupId, [session], 0);

    const projection = chatWorkspaceProjection([session], [fakeDefinition()], "一般對話");

    expect(projection.projects.get(projectNodeId)).toBe("LatticeTerm");
    expect(projection.sessions.get(sessionNodeId)).toMatchObject({
      sessionId: "runtime-1",
      label: "Codex · OpenAI Codex",
      detail: "gpt-5.6-sol",
      status: "done",
    });
    // The project has to be seated before the sessions that point at it.
    expect(projection.nodes).toEqual([
      { id: projectNodeId, defaultParentId: null },
      { id: sessionNodeId, defaultParentId: projectNodeId },
    ]);
  });

  it("falls back to a general project when no directory was chosen", () => {
    const projection = chatWorkspaceProjection(
      [fakeSession({ workingDirectory: "" })],
      [fakeDefinition()],
      "一般對話",
    );
    expect([...projection.projects.values()]).toEqual(["一般對話"]);
  });
});
