import { describe, expect, it } from "vitest";
import { CONVERSATION_NAMES_KEY, conversationDisplayName, conversationNameTargets, readConversationNames, saveConversationName } from "./conversationNames";
import { fakeSession, fakeThread } from "./testFixtures/agentApis";

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

describe("conversation display names", () => {
  it("persists trimmed names and retains writes made by another window", () => {
    const store = storage();
    saveConversationName(["first"], "  第一個名稱  ", store);
    const other = readConversationNames(store);
    other.set("another-window", "其他視窗的名稱");
    store.setItem(CONVERSATION_NAMES_KEY, JSON.stringify([...other]));
    saveConversationName(["second"], "第二個名稱", store);
    expect([...readConversationNames(store)]).toEqual([
      ["first", "第一個名稱"], ["another-window", "其他視窗的名稱"], ["second", "第二個名稱"],
    ]);
  });

  it("does not replace malformed data or report success after a failed write", () => {
    const store = storage();
    for (const raw of ["broken", "{}", '[["same","one"],["same","two"]]']) {
      store.setItem(CONVERSATION_NAMES_KEY, raw);
      expect(() => saveConversationName(["new"], "新名稱", store)).toThrow();
      expect(store.getItem(CONVERSATION_NAMES_KEY)).toBe(raw);
    }
    store.setItem(CONVERSATION_NAMES_KEY, '[["kept","原名稱"]]');
    expect(() => saveConversationName(["kept"], "新名稱", { getItem: store.getItem, setItem: () => { throw new Error("quota"); } })).toThrow("quota");
    expect(readConversationNames(store).get("kept")).toBe("原名稱");
    expect(() => saveConversationName(["kept"], " \n ", store)).toThrow();
  });

  it("shares names across a thread, its session and history without crossing accounts", () => {
    const profiles = [{ id: "a", definitionId: "codex" as const, name: "Account A", configDirectory: "/synthetic/a" },
      { id: "b", definitionId: "codex" as const, name: "Account B", configDirectory: "/synthetic/b" }];
    const thread = fakeThread({ id: "thread", accountProfileId: "a", nativeSessionId: "native" });
    const session = fakeSession({ groupId: "group-a", capturedSessionId: "native", profileConfigPath: "/synthetic/a" });
    const other = fakeSession({ groupId: "group-b", capturedSessionId: "native", profileConfigPath: "/synthetic/b" });
    const targets = conversationNameTargets([thread], [session, other], profiles);
    const store = storage();
    const saved = saveConversationName(targets.session(session), "修正輸入框", store);
    const entry = { definitionId: "codex" as const, profileId: "a", nativeSessionId: "native", title: "native title", workingDirectory: "/work", resumable: true, updatedAt: 1 };
    expect(conversationDisplayName(saved, targets.thread(thread), thread.title)).toBe("修正輸入框");
    expect(conversationDisplayName(saved, targets.native(entry), entry.title)).toBe("修正輸入框");
    expect(conversationDisplayName(saved, targets.session(other), "other account")).toBe("other account");
    expect(conversationDisplayName(saved, targets.native({ ...entry, profileId: "b" }), "other history")).toBe("other history");
    const restored = conversationNameTargets([], [], profiles);
    expect(conversationDisplayName(readConversationNames(store), restored.native(entry), entry.title)).toBe("修正輸入框");
  });

  it("keeps a name when a session later reports its native conversation id", () => {
    const session = fakeSession({ capturedSessionId: null, groupId: "early-group" });
    const initial = conversationNameTargets([], [session], []);
    const names = saveConversationName(initial.session(session), "準備中的任務", storage());
    const reported = { ...session, capturedSessionId: "now-known" };
    const targets = conversationNameTargets([], [reported], []);
    expect(conversationDisplayName(names, targets.session(reported), reported.label)).toBe("準備中的任務");
  });
});
