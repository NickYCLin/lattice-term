import { describe, expect, it } from "vitest";
import { findRunningCodexResumeSession, type AgentLaunchRequest } from "./useAgentSessions";
import { fakeSession } from "./testFixtures/agentApis";

const request: AgentLaunchRequest = {
  definitionId: "codex", label: "Codex", executable: "codex",
  arguments: [], resumeSessionId: "native-test",
  workingDirectory: "/work/new", cols: 120, rows: 32,
};

describe("Codex resume ownership", () => {
  it.each(["working", "idle", "needsAttention", "done"] as const)
    ("reuses the same account and native conversation while %s", state => {
      const owner = fakeSession({ capturedSessionId: "native-test", state,
        workingDirectory: "/work/original", model: "original-model" });
      expect(findRunningCodexResumeSession([owner], request)).toBe(owner);
      expect(owner.model).toBe("original-model");
    });

  it("does not reuse another account, conversation, or assistant", () => {
    const sessions = [
      fakeSession({ capturedSessionId: "native-test", profileConfigPath: "/profiles/other" }),
      fakeSession({ capturedSessionId: "other-native" }),
      fakeSession({ definitionId: "claude", capturedSessionId: "native-test" }),
    ];
    expect(findRunningCodexResumeSession(sessions, request)).toBeUndefined();
  });

  it("matches an explicit account without borrowing the default account", () => {
    const defaultOwner = fakeSession({ capturedSessionId: "native-test" });
    const profileOwner = fakeSession({ capturedSessionId: "native-test", profileConfigPath: "/profiles/selected" });
    expect(findRunningCodexResumeSession([defaultOwner, profileOwner],
      { ...request, profileConfigPath: "/profiles/selected" })).toBe(profileOwner);
  });

  it("allows restarting a closed session", () => {
    const closed = fakeSession({ capturedSessionId: "native-test", closedReason: "Process exited" });
    expect(findRunningCodexResumeSession([closed], request)).toBeUndefined();
  });

  it("normalizes surrounding native identity whitespace", () => {
    const owner = fakeSession({ capturedSessionId: " native-test " });
    expect(findRunningCodexResumeSession([owner], { ...request, resumeSessionId: " native-test " })).toBe(owner);
  });

  it("does not guess ownership for fresh launches or other CLIs", () => {
    const owner = fakeSession({ capturedSessionId: "native-test" });
    expect(findRunningCodexResumeSession([owner], { ...request, resumeSessionId: null })).toBeUndefined();
    expect(findRunningCodexResumeSession([owner], { ...request, definitionId: "claude" })).toBeUndefined();
    expect(findRunningCodexResumeSession([owner], { ...request, resumeSessionId: " " })).toBeUndefined();
  });
});
