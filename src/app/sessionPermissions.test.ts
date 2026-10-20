import { describe, expect, it } from "vitest";
import { sessionPermissionArguments, restoredSessionPermissionArguments, sessionPermissions } from "./sessionPermissions";
import { agentRestoreArguments, type SavedAgentSession } from "./workspaceSessionPersistence";

describe("terminal permission arguments", () => {
  it.each(["codex", "claude", "gemini", "custom", "cursor"])("keeps %s defaults unchanged", definitionId => {
    expect(sessionPermissionArguments(definitionId, "default")).toEqual([]);
  });
  it.each([
    ["codex", "ask", ["--ask-for-approval", "on-request", "--sandbox", "workspace-write"]],
    ["codex", "readOnly", ["--ask-for-approval", "on-request", "--sandbox", "read-only"]],
    ["codex", "workspaceWrite", ["--ask-for-approval", "on-request", "--sandbox", "workspace-write"]],
    ["codex", "full", ["--ask-for-approval", "never", "--sandbox", "danger-full-access"]],
    ["claude", "ask", ["--permission-mode", "manual"]],
    ["claude", "readOnly", ["--permission-mode", "plan"]],
    ["claude", "workspaceWrite", ["--permission-mode", "acceptEdits"]],
    ["claude", "full", ["--permission-mode", "bypassPermissions"]],
    ["gemini", "ask", ["--approval-mode", "default"]],
    ["gemini", "readOnly", ["--approval-mode", "plan"]],
    ["gemini", "workspaceWrite", ["--approval-mode", "auto_edit"]],
    ["gemini", "full", ["--approval-mode", "yolo"]],
  ] as const)("maps %s %s and preserves it on native restore", (definitionId, permission, expected) => {
    const arguments_ = sessionPermissionArguments(definitionId, permission);
    expect(arguments_).toEqual(expected);
    expect(restoredSessionPermissionArguments(definitionId, ["--model", "fixture", ...arguments_])).toEqual(expected);
    expect(agentRestoreArguments({ definitionId, resumeSessionId: "native-fixture",
      launchArguments: ["--model", "fixture", ...arguments_] } as SavedAgentSession)).toEqual(expected);
  });
  it.each(sessionPermissions)("does not invent flags for unsupported CLIs: %s", permission => {
    expect(sessionPermissionArguments("custom", permission)).toEqual([]);
    expect(restoredSessionPermissionArguments("custom", ["--sandbox", "anything"])).toEqual([]);
  });
});
