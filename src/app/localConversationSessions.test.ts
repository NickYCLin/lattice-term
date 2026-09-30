import { expect, it } from "vitest";
import { conversationSession, nativeConversationProxy, localConversationLaunchIntents, type LocalConversation } from "./localConversationSessions";
import { cliProxyLaunchArguments } from "./cliProxyApi";
import { fakeDefinition, fakeSession } from "./testFixtures/agentApis";
import { sanitizeWorkspaceSessionSnapshot } from "./workspaceSessionPersistence";

const entry: LocalConversation = {
  definitionId: "codex", profileId: null, nativeSessionId: "native",
  workingDirectory: "/work", title: "修正工作區".repeat(30), updatedAt: 1, resumable: true,
};

it("restores proxy routing only from a known identity or an explicit connection choice", () => {
  const proxy = { id: "work", label: "Work", baseUrl: "http://127.0.0.1:8317" };
  const legacy = { ...entry, modelProvider: `latticeterm_cliproxyapi_${"a".repeat(32)}` };
  expect(localConversationLaunchIntents([legacy], [], [fakeDefinition()], [], [], [proxy])).toEqual([]);
  const restored = localConversationLaunchIntents([legacy], [], [fakeDefinition()], [], [], [proxy], proxy)[0];
  expect(restored.launchArguments).toEqual(cliProxyLaunchArguments(proxy.baseUrl, proxy.id));
  expect(restored.resumeSessionId).toBe(entry.nativeSessionId);
  const current = { ...entry, modelProvider: `latticeterm_cliproxyapi_v2_work_${"a".repeat(32)}` };
  expect(nativeConversationProxy(current, [proxy])).toEqual(proxy);
  expect(localConversationLaunchIntents([current], [], [fakeDefinition()], [], [], [proxy])).toHaveLength(1);
  expect(localConversationLaunchIntents([current], [], [fakeDefinition()], [], [], [])).toEqual([]);
});

it("deduplicates native IDs per account, preserves unreadable directories and round-trips Chinese titles", () => {
  const profiles = [{ id: "other", definitionId: "codex" as const, name: "Other", configDirectory: "C:\\other" }];
  const live = [fakeSession({ capturedSessionId: "native" })];
  expect(conversationSession(entry, profiles, live)?.sessionId).toBe("s1");
  const intents = localConversationLaunchIntents([
    entry, { ...entry, profileId: "other", resumable: false }, { ...entry, profileId: "other" },
  ], profiles, [fakeDefinition()], live, []);
  expect(intents).toHaveLength(1);
  expect(intents[0].profileConfigPath).toBe("C:\\other");
  expect(sanitizeWorkspaceSessionSnapshot({ version: 1, sessions: intents, active: null })?.sessions).toEqual(intents);
  expect(localConversationLaunchIntents([{ ...entry, profileId: "other" }], profiles, [fakeDefinition()], live, intents)).toEqual([]);
});

it("does not substitute the default account when a profile is missing", () => {
  expect(localConversationLaunchIntents([{ ...entry, profileId: "removed" }], [], [fakeDefinition()], [], [])).toEqual([]);
  expect(localConversationLaunchIntents([{ ...entry, archived: true }], [], [fakeDefinition()], [], [])).toEqual([]);
});

it("allows an explicit retry after exit without automatically relaunching failed sessions", () => {
  const closed = fakeSession({ capturedSessionId: entry.nativeSessionId, closedReason: "Exit 1" });
  expect(conversationSession(entry, [], [closed], true)).toBeUndefined();
  expect(localConversationLaunchIntents([entry], [], [fakeDefinition()], [closed], [])).toEqual([]);
  const active = fakeSession({ sessionId: "retry", capturedSessionId: entry.nativeSessionId });
  expect(conversationSession(entry, [], [closed, active], true)?.sessionId).toBe("retry");
});

it("does not open a second CLI while the resumed session is still capturing its native ID", () => {
  const intent = localConversationLaunchIntents([entry], [], [fakeDefinition()], [], [])[0];
  expect(conversationSession(entry, [], [fakeSession({ groupId: intent.groupKey, capturedSessionId: null })])?.sessionId).toBe("s1");
  expect(conversationSession(entry, [], [fakeSession({ groupId: intent.groupKey, capturedSessionId: "different-conversation" })])).toBeUndefined();
  expect(localConversationLaunchIntents([entry], [], [fakeDefinition()],
    [fakeSession({ groupId: intent.groupKey, capturedSessionId: null })], [])).toEqual([]);
});
