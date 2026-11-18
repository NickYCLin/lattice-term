import { agentSessionHasEnded } from "./agentSessionResume";
import type { AgentSessionSummary } from "./useAgentSessions";

export type SessionSidebarStatus =
  | "working"
  | "attention"
  | "idle"
  | "done"
  | "ended"
  | "connected"
  /** Kept from an earlier run or an imported conversation; not started. */
  | "saved";

export function aggregateSessionSidebarStatus(
  statuses: readonly SessionSidebarStatus[],
): SessionSidebarStatus {
  if (statuses.some((status) => status === "attention")) return "attention";
  if (statuses.some((status) => status === "working")) return "working";
  if (statuses.some((status) => status === "ended")) return "ended";
  if (statuses.length > 0 && statuses.every((status) => status === "done")) {
    return "done";
  }
  if (statuses.some((status) => status === "idle")) return "idle";
  return "connected";
}

export function agentGroupSidebarStatus(
  members: readonly (Pick<AgentSessionSummary, "state"> &
    Partial<
      Pick<AgentSessionSummary, "closedReason" | "processId" | "writerReleased">
    >)[],
): SessionSidebarStatus {
  if (members.some((member) => member.state === "needsAttention" && !agentSessionHasEnded(member))) {
    return "attention";
  }
  if (members.some((member) => member.state === "working" && !agentSessionHasEnded(member))) {
    return "working";
  }
  if (members.some((member) => agentSessionHasEnded(member))) {
    return "ended";
  }
  if (members.length > 0 && members.every((member) => member.state === "done")) {
    return "done";
  }
  if (members.some((member) => member.state === "idle")) return "idle";
  return "connected";
}

export function anyAgentSessionJustCompleted(
  previous: ReadonlyMap<string, AgentSessionSummary["state"]> | null,
  current: readonly Pick<AgentSessionSummary, "sessionId" | "state" | "closedReason">[],
): boolean {
  if (!previous) return false;
  return current.some(
    (session) =>
      session.state === "done" && !session.closedReason &&
      previous.has(session.sessionId) && previous.get(session.sessionId) !== "done",
  );
}
