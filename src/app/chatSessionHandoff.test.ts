import { describe, expect, it } from "vitest";
import { appendSessionTurns, liveSessionForThread, sessionLaunchForThread, threadsHeldBySessions } from "./chatSessionHandoff";
import { fakeDefinition, fakeSession, fakeThread } from "./testFixtures/agentApis";

const codex = fakeDefinition({ installed: true, resumeSupported: true, installedPath: "C:\\npm\\codex.cmd" });
const proxies = [{ id: "team", label: "", baseUrl: "http://10.0.0.5:8317" }];

describe("chat and terminal share one conversation", () => {
  it("resumes the thread's own conversation with its account and proxy", () => {
    const profile = { id: "work", definitionId: "codex" as const, name: "公司", configDirectory: "C:\\profiles\\work" };
    const native = sessionLaunchForThread(
      fakeThread({ nativeSessionId: "thread-1", accountProfileId: "work", model: "gpt-6" }),
      "D:\\project", [codex], [profile], proxies);
    expect(native).toMatchObject({
      definitionId: "codex", executable: "C:\\npm\\codex.cmd", resumeSessionId: "thread-1",
      arguments: [], profileConfigPath: "C:\\profiles\\work", workingDirectory: "D:\\project",
      restoreExistingSession: true, seedInput: null,
    });

    const proxied = sessionLaunchForThread(
      fakeThread({ nativeSessionId: "thread-2", provider: "cliproxyapi", proxyId: "team", model: "claude-opus-5-5" }),
      "D:\\project", [codex], [], proxies);
    expect(proxied?.arguments).toEqual([
      "-c", "model_provider=latticeterm_cliproxyapi_team",
      "-c", 'model_providers.latticeterm_cliproxyapi_team.base_url="http://10.0.0.5:8317/v1"',
      "--model", "claude-opus-5-5",
    ]);
  });

  it("refuses when the conversation, CLI, account or proxy cannot be matched", () => {
    const thread = fakeThread({ nativeSessionId: "thread-1" });
    expect(sessionLaunchForThread(fakeThread({ nativeSessionId: null }), "D:\\p", [codex], [], proxies)).toBeNull();
    expect(sessionLaunchForThread(thread, "", [codex], [], proxies)).toBeNull();
    expect(sessionLaunchForThread(thread, "D:\\p", [{ ...codex, resumeSupported: false }], [], proxies)).toBeNull();
    expect(sessionLaunchForThread({ ...thread, accountProfileId: "gone" }, "D:\\p", [codex], [], proxies)).toBeNull();
    expect(sessionLaunchForThread({ ...thread, provider: "cliproxyapi", proxyId: "gone" }, "D:\\p", [codex], [], proxies))
      .toBeNull();
  });

  it("finds the running terminal that holds the conversation", () => {
    const thread = fakeThread({ nativeSessionId: "thread-1" });
    const live = fakeSession({ definitionId: "codex", capturedSessionId: "thread-1" });
    expect(liveSessionForThread(thread, [live])).toBe(live);
    expect(liveSessionForThread(thread, [{ ...live, closedReason: "exited" }])).toBeUndefined();
    expect(liveSessionForThread(thread, [{ ...live, definitionId: "claude" }])).toBeUndefined();
    expect(liveSessionForThread({ ...thread, nativeSessionId: null }, [live])).toBeUndefined();
  });

  it("hands a conversation over once a terminal resumed it, but never cuts off a chat turn", () => {
    const live = fakeSession({ definitionId: "codex", capturedSessionId: "thread-1" });
    const idle = fakeThread({ id: "idle", nativeSessionId: "thread-1" });
    const busy = fakeThread({ id: "busy", nativeSessionId: "thread-1", runningTurnId: "turn" });
    const moved = fakeThread({ id: "moved", nativeSessionId: "thread-1", continuedInSession: true });
    const other = fakeThread({ id: "other", nativeSessionId: "thread-2" });
    expect(threadsHeldBySessions([idle, busy, moved, other], [live])).toEqual(["idle"]);
  });

  it("adds only what was said in the terminal, once", () => {
    const thread = fakeThread({
      continuedInSession: true,
      items: [
        { type: "user", id: "u1", text: "第一個問題", at: 1 },
        { type: "text", id: "a1", text: "第一個回答" },
      ],
    });
    const snapshot = { messages: [
      { role: "user" as const, text: "第一個問題" },
      { role: "assistant" as const, text: "第一個回答" },
      { role: "user" as const, text: "在終端機問的" },
      { role: "assistant" as const, text: "在終端機答的" },
    ] };
    const next = appendSessionTurns(thread, snapshot, "以下是在終端機繼續的內容", 5);
    expect(next.continuedInSession).toBe(false);
    expect(next.items.slice(2)).toEqual([
      { type: "notice", id: "session:5:notice", text: "以下是在終端機繼續的內容" },
      { type: "user", id: "session:5:0", text: "在終端機問的", at: 5 },
      { type: "text", id: "session:5:1", text: "在終端機答的" },
    ]);
    const unchanged = appendSessionTurns({ ...thread, items: next.items, continuedInSession: true },
      { messages: snapshot.messages }, "x", 6);
    expect(unchanged.items).toEqual(next.items);
    expect(unchanged.continuedInSession).toBe(false);
  });
});
