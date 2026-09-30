import { describe, expect, it } from "vitest";
import { agentSessionSidebarMemberNodeId } from "./agentSessionPresentation";
import { savedAgentSidebarItems } from "./savedSidebarItems";
import type { SavedAgentSession } from "./workspaceSessionPersistence";

function saved(overrides: Partial<SavedAgentSession>): SavedAgentSession {
  return {
    kind: "agent", groupKey: "project:a", groupLabel: "修登入頁",
    definitionId: "codex", label: "Codex", executable: "codex", launchArguments: [],
    workingDirectory: "/home/me/work", resumeSessionId: "a",
    ...overrides,
  };
}

describe("savedAgentSidebarItems", () => {
  it("keeps bulk-imported history out of the sidebar without changing saved records", () => {
    const legacy = Array.from({ length: 300 }, (_, index) => saved({ groupKey: `native:codex:default:${index}` }));
    const background = saved({ groupKey: "native:codex:default:background", detached: true });
    const pending = [...legacy, background, saved({})];
    const before = JSON.stringify(pending);
    const result = savedAgentSidebarItems(pending, path => path, () => "");
    expect(result.byId.size).toBe(2);
    expect([...result.byId.values()]).toContain(background);
    expect(JSON.stringify(pending)).toBe(before);
  });
  it("puts unstarted conversations in their project folder", () => {
    const first = saved({});
    const second = saved({ groupKey: "project:b", groupLabel: "", definitionId: "claude", label: "Claude Code", workingDirectory: "/home/me/tools", resumeSessionId: "b" });
    const { byProject, byId } = savedAgentSidebarItems(
      [first, second, { kind: "ssh", profileId: "p" } as never],
      (path) => `local:${path}`,
      (assistant) => `${assistant} · 尚未啟動`,
    );
    const work = byProject.get("local:/home/me/work") ?? [];
    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({ label: "修登入頁", detail: "Codex · 尚未啟動", status: "saved", kind: "agent" });
    expect(byProject.get("local:/home/me/tools")?.[0]?.label).toBe("Claude Code");
    expect(byId.get(work[0]!.sessionId)).toBe(first);
    expect(byId.size).toBe(2);
  });

  it("keeps the node id the conversation will have once started", () => {
    const entry = saved({});
    const { byProject } = savedAgentSidebarItems([entry], (path) => path, () => "");
    const expected = agentSessionSidebarMemberNodeId(entry.groupKey, [{ ...entry, sessionId: entry.groupKey }], 0);
    expect(byProject.get(entry.workingDirectory)?.[0]?.nodeId).toBe(expected);
    expect(byProject.get(entry.workingDirectory)?.[0]?.sessionId).toBe(`saved:${expected}`);
  });
});
