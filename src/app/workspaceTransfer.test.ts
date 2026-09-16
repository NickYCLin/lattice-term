import { describe, expect, it } from "vitest";
import {
  emptySessionSidebarLayout,
  mergeSessionSidebarLayouts,
} from "./sessionSidebarLayout";
import {
  parseWorkspaceTransfer,
  serializeWorkspaceTransfer,
} from "./workspaceTransfer";
import type { AgentSessionSummary } from "./useAgentSessions";

function session(): AgentSessionSummary {
  return {
    sessionId: "agent-live-1",
    groupId: "group-portable-1",
    groupLabel: "後端重構",
    definitionId: "codex",
    label: "OpenAI Codex",
    model: "gpt-5.6-sol",
    executable: "C:\\tools\\codex.exe",
    launchArguments: ["--model", "gpt-5.6-sol"],
    workingDirectory: "D:\\project\\api",
    state: "idle",
    stateSource: "heuristic",
    processId: 42,
    tokenUsage: null,
    queuedPrompts: 0,
    capturedSessionId: "local-conversation-id",
    profileConfigPath: "/local-only/account-b",
  };
}

describe("workspace transfer", () => {
  it("refuses exports that exceed the import item limit", () => {
    const atLimit = serializeWorkspaceTransfer(Array.from({ length: 64 }, session), emptySessionSidebarLayout);
    expect(parseWorkspaceTransfer(atLimit)?.items).toHaveLength(64);
    expect(() => serializeWorkspaceTransfer(Array.from({ length: 65 }, session), emptySessionSidebarLayout)).toThrow();
  });

  it("refuses exports with unsupported arguments or an oversized file", () => {
    expect(() => serializeWorkspaceTransfer([{ ...session(), launchArguments: ["line\nbreak"] }], emptySessionSidebarLayout)).toThrow();
    const large = { ...session(), launchArguments: Array.from({ length: 64 }, () => "a".repeat(4096)) };
    expect(() => serializeWorkspaceTransfer(Array.from({ length: 5 }, () => large), emptySessionSidebarLayout)).toThrow();
  });

  it("does not transfer chat node IDs from the shared sidebar in either direction", () => {
    const sidebar = { ...emptySessionSidebarLayout, folders: [{ id: "folder:shared", name: "共用" }], placements: {
      "folder:shared": { parentId: null, order: 0 },
      "thread:private-chat": { parentId: "folder:shared", order: 0 },
      "session:agent:group-portable-1": { parentId: "folder:shared", order: 1 },
    } };
    const encoded = serializeWorkspaceTransfer([session()], sidebar);
    expect(encoded).not.toContain("thread:private-chat");
    expect(sidebar.placements["thread:private-chat"]).toBeDefined();
    const legacy = JSON.parse(encoded);
    legacy.sidebar = sidebar;
    const parsed = parseWorkspaceTransfer(JSON.stringify(legacy));
    expect(parsed?.sidebar.placements["thread:private-chat"]).toBeUndefined();
    expect(parsed?.sidebar.placements["session:agent:group-portable-1"].parentId).toBe("folder:shared");
  });
  it("round trips portable launch intent without conversation or process state", () => {
    const layout = {
      version: 1 as const,
      folders: [{ id: "folder:backend", name: "後端" }],
      placements: {
        "folder:backend": { parentId: null, order: 0 },
        "session:agent:group-portable-1": {
          parentId: "folder:backend",
          order: 0,
        },
      },
      collapsedFolderIds: [],
    };

    const encoded = serializeWorkspaceTransfer(
      [session()],
      layout,
      "2026-08-28T00:00:00.000Z",
    );
    const parsed = parseWorkspaceTransfer(encoded);

    expect(parsed?.items[0]).toEqual(
      expect.objectContaining({
        groupLabel: "後端重構",
        launchArguments: ["--model", "gpt-5.6-sol"],
        workingDirectory: "D:\\project\\api",
      }),
    );
    expect(parsed?.sidebar).toEqual(layout);
    expect(encoded).not.toContain("local-conversation-id");
    expect(encoded).not.toContain("processId");
    expect(encoded).not.toContain("profileConfigPath");
    expect(encoded).not.toContain("/local-only/account-b");
  });

  it("rejects malformed files and unsafe nested values", () => {
    expect(parseWorkspaceTransfer("not json")).toBeNull();
    expect(
      parseWorkspaceTransfer(
        JSON.stringify({
          format: "latticeterm-workspace",
          version: 1,
          exportedAt: "2026-08-28T00:00:00.000Z",
          items: [
            {
              groupKey: "group-1",
              groupLabel: "Work",
              definitionId: "codex",
              label: "Codex",
              executable: "codex",
              launchArguments: ["bad\nargument"],
              workingDirectory: "D:\\project",
            },
          ],
          sidebar: emptySessionSidebarLayout,
        }),
      ),
    ).toBeNull();
  });

  it("merges imported organization without moving existing nodes", () => {
    const current = {
      version: 1 as const,
      folders: [{ id: "folder:local", name: "本機" }],
      placements: {
        "folder:local": { parentId: null, order: 0 },
        "session:agent:existing": { parentId: "folder:local", order: 0 },
      },
      collapsedFolderIds: [],
    };
    const incoming = {
      version: 1 as const,
      folders: [{ id: "folder:imported", name: "匯入" }],
      placements: {
        "folder:imported": { parentId: null, order: 0 },
        "session:agent:existing": { parentId: "folder:imported", order: 0 },
        "session:agent:new": { parentId: "folder:imported", order: 1 },
      },
      collapsedFolderIds: ["folder:imported"],
    };

    const merged = mergeSessionSidebarLayouts(current, incoming);

    expect(merged.placements["session:agent:existing"].parentId).toBe(
      "folder:local",
    );
    expect(merged.placements["session:agent:new"].parentId).toBe(
      "folder:imported",
    );
    expect(merged.collapsedFolderIds).toContain("folder:imported");
  });
});
