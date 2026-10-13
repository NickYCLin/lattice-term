import { expect, it } from "vitest";
import { AgentMcpPreferences, AGENT_MCP_PREFERENCES_KEY, mcpPreferenceMatches } from "./agentMcpPreferences";
import { fakeSession } from "./testFixtures/agentApis";
import { createWorkspaceTransferFile } from "./workspaceTransfer";

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

it("persists separate output and control permissions and learns the native identity", () => {
  const disk = storage();
  const preferences = new AgentMcpPreferences(disk);
  const session = fakeSession();
  preferences.remember(session, "full", false);
  preferences.updateIdentity({ ...session, capturedSessionId: "native-1" });
  const restarted = new AgentMcpPreferences(disk);
  expect(restarted.find({ ...session, sessionId: "new", capturedSessionId: "native-1", restoreExistingSession: true }))
    .toMatchObject({ access: "full", readOutput: false, nativeSessionId: "native-1" });
});

it("does not guess the identity of a fresh replacement or another account", () => {
  const disk = storage();
  const preferences = new AgentMcpPreferences(disk);
  const original = fakeSession({ capturedSessionId: "native-1" });
  preferences.remember(original, "full");
  const resumed = { ...original, sessionId: "replacement", restoreExistingSession: true };
  expect(preferences.find(resumed)).toBeDefined();
  for (const change of [{ restoreExistingSession: false }, { capturedSessionId: null }, { capturedSessionId: "other" },
    { profileConfigPath: "/another/account" }, { definitionId: "claude" }, { executable: "other-codex" },
    { workingDirectory: "/another/project" }, { sandboxed: true }, { groupId: "other" }, { closedReason: "closed" }]) {
    expect(preferences.find({ ...resumed, ...change })).toBeUndefined();
  }
  preferences.remember(fakeSession(), "view");
  expect(preferences.find({ ...fakeSession(), sessionId: "fresh", restoreExistingSession: true })).toBeUndefined();
});

it("removes sharing on explicit off, including a closed session", () => {
  const disk = storage();
  const original = fakeSession({ capturedSessionId: "native-1" });
  const preferences = new AgentMcpPreferences(disk);
  preferences.remember(original, "view");
  preferences.remember({ ...original, closedReason: "closed" }, "off");
  expect(new AgentMcpPreferences(disk).find(original)).toBeUndefined();
});

it("does not overwrite changes from another window or lose the in-memory intent on a failed write", () => {
  const disk = storage();
  const preferences = new AgentMcpPreferences(disk);
  preferences.remember(fakeSession(), "view");
  const original = disk.getItem(AGENT_MCP_PREFERENCES_KEY)!;
  disk.setItem(AGENT_MCP_PREFERENCES_KEY, original + " ");
  expect(() => preferences.remember(fakeSession(), "full")).toThrow("another window");
  expect(preferences.find(fakeSession())?.access).toBe("view");
  expect(disk.getItem(AGENT_MCP_PREFERENCES_KEY)).toBe(original + " ");
});

it("rejects malformed sharing data and strips unknown fields", () => {
  const disk = storage();
  const preferences = new AgentMcpPreferences(disk);
  preferences.remember(fakeSession(), "view");
  const value = JSON.parse(disk.getItem(AGENT_MCP_PREFERENCES_KEY)!);
  value.entries[0].unexpected = "do not retain";
  disk.setItem(AGENT_MCP_PREFERENCES_KEY, JSON.stringify(value));
  const loaded = new AgentMcpPreferences(disk);
  loaded.remember(fakeSession(), "full");
  expect(disk.getItem(AGENT_MCP_PREFERENCES_KEY)).not.toContain("unexpected");
  for (const invalid of [null, {}, { version: 1, entries: [{ ...value.entries[0], readOutput: "true" }] },
    { version: 1, entries: [{ ...value.entries[0], access: "all" }] }]) {
    disk.setItem(AGENT_MCP_PREFERENCES_KEY, JSON.stringify(invalid));
    expect(() => new AgentMcpPreferences(disk)).toThrow();
  }
});

it("keeps MCP intent out of portable workspace exports", () => {
  const disk = storage();
  const session = fakeSession({ capturedSessionId: "native-1" });
  const preferences = new AgentMcpPreferences(disk);
  preferences.remember(session, "full");
  const portable = createWorkspaceTransferFile([session], { version: 1, folders: [], placements: {}, collapsedFolderIds: [] });
  expect(JSON.stringify(portable)).not.toMatch(/readOutput|access|McpPreference/);
  expect(mcpPreferenceMatches(preferences.find(session)!, session)).toBe(true);
});
