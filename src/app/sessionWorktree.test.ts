import { expect, it } from "vitest";
import { sessionWorktreeRequest } from "./sessionWorktree";
import { fakeSession } from "./testFixtures/agentApis";

it("starts a fresh tree with the same account and model, without replaying resume flags", () => {
  const request = sessionWorktreeRequest(fakeSession({ capturedSessionId: "old-native", profileConfigPath: "/synthetic/profile",
    launchArguments: ["--model", "native-model", "-c", "model_provider=managed", "-C", "/old", "resume", "old-native", "--add-dir", "/other"] }), "/new-tree", null);
  expect(request).toMatchObject({ arguments: ["--model", "native-model", "-c", "model_provider=managed"],
    workingDirectory: "/new-tree", profileConfigPath: "/synthetic/profile", resumeSessionId: null, seedInput: null, restoreExistingSession: false });
});
it("preserves Claude's safe mode while discarding the old native resume target", () => {
  expect(sessionWorktreeRequest(fakeSession({ definitionId: "claude", launchArguments: ["--safe-mode", "--model=sonnet", "--resume", "old-native", "--fork-session"] }), "/new", "explicit handoff")).toMatchObject({ arguments: ["--safe-mode", "--model=sonnet"], seedInput: "explicit handoff" });
});
it.each([{ args: ["original prompt"] }, { args: ["--unknown", "value"] }, { args: ["--model"] }])("rejects unsafe or incomplete source arguments %j", ({ args }) => {
  expect(() => sessionWorktreeRequest(fakeSession({ launchArguments: args }), "/new", null)).toThrow();
});
