import { expect, it } from "vitest";
import { conversationSession, localConversationLaunchIntents, type LocalConversation } from "./localConversationSessions";
import { fakeDefinition, fakeSession } from "./testFixtures/agentApis";
import { sanitizeWorkspaceSessionSnapshot } from "./workspaceSessionPersistence";

const entry: LocalConversation = {
  definitionId: "codex", profileId: null, nativeSessionId: "native",
  workingDirectory: "/work", title: "修正工作區".repeat(30), updatedAt: 1, resumable: true,
};

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
});

it("does not open a second CLI while the resumed session is still capturing its native ID", () => {
  const intent = localConversationLaunchIntents([entry], [], [fakeDefinition()], [], [])[0];
  expect(conversationSession(entry, [], [fakeSession({ groupId: intent.groupKey, capturedSessionId: null })])?.sessionId).toBe("s1");
  expect(conversationSession(entry, [], [fakeSession({ groupId: intent.groupKey, capturedSessionId: "different-conversation" })])).toBeUndefined();
  expect(localConversationLaunchIntents([entry], [], [fakeDefinition()],
    [fakeSession({ groupId: intent.groupKey, capturedSessionId: null })], [])).toEqual([]);
});
