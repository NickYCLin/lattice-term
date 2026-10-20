export type SessionPermission = "default" | "ask" | "readOnly" | "workspaceWrite" | "full";

export const sessionPermissions: readonly SessionPermission[] = ["default", "ask", "readOnly", "workspaceWrite", "full"];

export function supportsSessionPermissions(definitionId: string): boolean {
  return ["codex", "claude", "gemini"].includes(definitionId);
}

export function sessionPermissionArguments(definitionId: string, permission: SessionPermission): string[] {
  if (permission === "default" || !supportsSessionPermissions(definitionId)) return [];
  if (definitionId === "codex") {
    return ["--ask-for-approval", permission === "full" ? "never" : "on-request",
      "--sandbox", permission === "full" ? "danger-full-access" : permission === "readOnly" ? "read-only" : "workspace-write"];
  }
  return [definitionId === "claude" ? "--permission-mode" : "--approval-mode",
    definitionId === "claude"
      ? ({ ask: "manual", readOnly: "plan", workspaceWrite: "acceptEdits", full: "bypassPermissions" } as const)[permission]
      : ({ ask: "default", readOnly: "plan", workspaceWrite: "auto_edit", full: "yolo" } as const)[permission]];
}

export function restoredSessionPermissionArguments(definitionId: string, arguments_: readonly string[]): string[] {
  if (!supportsSessionPermissions(definitionId)) return [];
  const flags = definitionId === "codex" ? ["--ask-for-approval", "--sandbox"]
    : [definitionId === "claude" ? "--permission-mode" : "--approval-mode"];
  const result: string[] = [];
  for (let index = 0; index < arguments_.length - 1; index += 1) {
    if (flags.includes(arguments_[index])) {
      result.push(arguments_[index], arguments_[index + 1]);
      index += 1;
    }
  }
  return result;
}
