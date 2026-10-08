import type { AgentSessionSummary } from "./useAgentSessions";

export const SESSION_PROMPT_NOT_READY = "session-prompt-not-ready";

export function sessionNeedsReadyConfirmation(session: AgentSessionSummary): boolean {
  return !session.closedReason && session.stateSource === "heuristic"
    && (session.state === "idle" || session.state === "done");
}
