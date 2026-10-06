import { describe, expect, it } from "vitest";
import { cliProxyLaunchArguments } from "./cliProxyApi";
import { modelSwitchRequest, switchesModelInPlace, withModel } from "./sessionModelSwitch";
import type { AgentSessionSummary } from "./useAgentSessions";

function session(overrides: Partial<AgentSessionSummary> = {}): AgentSessionSummary {
  return {
    sessionId: "s1",
    groupId: "g1",
    groupLabel: "StoryVoice",
    definitionId: "codex",
    profileConfigPath: "/profiles/work",
    label: "OpenAI Codex",
    model: "gpt-6-astra",
    executable: "codex",
    launchArguments: ["--model", "gpt-6-astra"],
    workingDirectory: "/work/storyvoice",
    state: "idle",
    stateSource: "hook",
    processId: 1,
    tokenUsage: null,
    queuedPrompts: 0,
    capturedSessionId: "thread-1",
    sandboxed: true,
    detached: false,
    ...overrides,
  } as AgentSessionSummary;
}

describe("withModel", () => {
  it("replaces every spelling of an earlier model choice", () => {
    expect(withModel(["-c", "x=1", "-m", "old", "--model=older", "--model", "oldest"], "new"))
      .toEqual(["-c", "x=1", "--model", "new"]);
  });
});

describe("modelSwitchRequest", () => {
  it("resumes the same conversation in the same tab on the new model", () => {
    expect(modelSwitchRequest(session(), "gpt-6")).toMatchObject({
      definitionId: "codex",
      arguments: ["--model", "gpt-6"],
      resumeSessionId: "thread-1",
      groupId: "g1",
      restoreExistingSession: true,
      profileConfigPath: "/profiles/work",
      sandbox: true,
      detached: false,
      workingDirectory: "/work/storyvoice",
    });
  });

  it("keeps a proxy session's connection and drops only its old model", () => {
    const connection = cliProxyLaunchArguments("http://127.0.0.1:8317");
    const proxied = session({ launchArguments: [...connection, "--model", "gpt-6-astra"] });
    expect(modelSwitchRequest(proxied, "claude-opus-5-5")?.arguments)
      .toEqual([...connection, "--model", "claude-opus-5-5"]);
  });

  it("waits until the CLI has named its conversation", () => {
    expect(modelSwitchRequest(session({ capturedSessionId: null }), "gpt-6")).toBeNull();
  });
});

describe("switchesModelInPlace", () => {
  it("only Claude Code takes a model name inside the conversation", () => {
    expect(switchesModelInPlace({ definitionId: "claude" })).toBe(true);
    expect(switchesModelInPlace({ definitionId: "codex" })).toBe(false);
    expect(switchesModelInPlace({ definitionId: "gemini" })).toBe(false);
  });
});
