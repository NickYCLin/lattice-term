/**
 * The list of fixed commands a person approves for one remote MCP grant.
 *
 * Ids are ours rather than the label's: a caller runs a command by id, two
 * commands may reasonably carry the same name, and a label is free text.
 * Removing one renumbers the rest so the approved list stays the short,
 * readable sequence the person just checked.
 */

export interface RemoteExecPlan {
  id: string;
  label: string;
  command: string;
  timeoutSeconds: number;
}

/** The backend accepts 16; a list a person can still read is shorter. */
export const MAX_EXEC_PLANS = 8;
export const DEFAULT_EXEC_TIMEOUT_SECONDS = 30;
/** The backend's own bounds, in seconds. */
export const MIN_EXEC_TIMEOUT_SECONDS = 1;
export const MAX_EXEC_TIMEOUT_SECONDS = 60;

function renumber(plans: RemoteExecPlan[]): RemoteExecPlan[] {
  return plans.map((plan, index) => ({ ...plan, id: `command-${index + 1}` }));
}

export function clampExecTimeout(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_EXEC_TIMEOUT_SECONDS;
  return Math.min(
    MAX_EXEC_TIMEOUT_SECONDS,
    Math.max(MIN_EXEC_TIMEOUT_SECONDS, Math.round(seconds)),
  );
}

/** Adds one command, or returns the list unchanged when it cannot. */
export function addExecPlan(
  plans: RemoteExecPlan[],
  draft: { label: string; command: string; timeoutSeconds: number },
): RemoteExecPlan[] {
  const label = draft.label.trim();
  const command = draft.command.trim();
  if (!label || !command || plans.length >= MAX_EXEC_PLANS) return plans;
  return renumber([
    ...plans,
    {
      id: "pending",
      label,
      command,
      timeoutSeconds: clampExecTimeout(draft.timeoutSeconds),
    },
  ]);
}

export function removeExecPlan(plans: RemoteExecPlan[], id: string): RemoteExecPlan[] {
  const next = plans.filter((plan) => plan.id !== id);
  return next.length === plans.length ? plans : renumber(next);
}

/** What the backend's grant request expects. */
export function execPlanRequests(
  plans: RemoteExecPlan[],
): { id: string; label: string; command: string; timeoutMs: number }[] {
  return plans.map((plan) => ({
    id: plan.id,
    label: plan.label,
    command: plan.command,
    timeoutMs: plan.timeoutSeconds * 1000,
  }));
}
