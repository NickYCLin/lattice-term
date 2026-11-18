import type { AgentLaunchRequest, AgentSessionSummary } from "./useAgentSessions";

/** Backend reason used when the user submitted /exit or /quit. */
export const USER_EXITED_REASON = "User exited";

export function agentSessionHasEnded(
  session: Partial<
    Pick<AgentSessionSummary, "closedReason" | "processId" | "writerReleased">
  >,
): boolean {
  return Boolean(session.closedReason) ||
    (session.processId == null && Boolean(session.writerReleased));
}

export function agentSessionEndedByUser(
  session: Pick<AgentSessionSummary, "closedReason">,
): boolean {
  return session.closedReason === USER_EXITED_REASON;
}

/** Resume the same native conversation in the same working directory. */
export function resumeAgentSessionRequest(
  session: AgentSessionSummary,
): AgentLaunchRequest | null {
  const resumeSessionId = session.capturedSessionId?.trim();
  if (!resumeSessionId) return null;
  return {
    definitionId: session.definitionId,
    label: session.label,
    executable: session.executable,
    arguments: session.launchArguments,
    resumeSessionId,
    groupId: session.groupId,
    seedInput: null,
    restoreExistingSession: true,
    profileConfigPath: session.profileConfigPath,
    sandbox: session.sandboxed,
    detached: session.detached,
    workingDirectory: session.workingDirectory,
    cols: 120,
    rows: 32,
  };
}
