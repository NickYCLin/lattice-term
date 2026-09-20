/** The desktop's own view of a remote Fleet workspace the user shared. */

export interface FleetTarget {
  id: string;
  label: string;
  backend: string;
  connected: boolean;
  scopes: { fleetObserve?: boolean; fleetRead?: boolean; fleetControl?: boolean; fleetLaunch?: boolean };
}

export interface FleetSession {
  sessionId: string;
  access: "metadata" | "read" | "control" | string;
  readOutput: boolean;
  label: string;
  groupLabel?: string;
  definitionId: string;
  model?: string | null;
  state: string;
  stateSource?: string;
  queuedPrompts?: number;
}

export interface FleetPlan {
  planId: string;
  label: string;
}

export type FleetAction =
  | { kind: "listSessions" }
  | { kind: "listPlans" }
  | { kind: "readOutput"; sessionId: string; cursor: number; maxBytes?: number }
  | { kind: "launch"; planId: string; requestId: string }
  | { kind: "send"; sessionId: string; text: string; mode: "queue" | "now"; requestId: string }
  | { kind: "cancel"; sessionId: string; scope: "turn" | "session"; requestId: string }
  | { kind: "waitState"; sessionId: string; timeoutMs?: number };

async function run(targetId: string, action: FleetAction): Promise<Record<string, unknown>> {
  const { invoke } = await import("@tauri-apps/api/core");
  const reply = await invoke<{ result?: Record<string, unknown> }>("remote_fleet_action", { targetId, action });
  return reply.result ?? {};
}

export async function listFleetTargets(): Promise<FleetTarget[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  const targets = await invoke<FleetTarget[]>("mcp_remote_targets");
  return targets.filter((target) => target.scopes.fleetObserve);
}

export async function listFleetSessions(targetId: string): Promise<FleetSession[]> {
  const result = await run(targetId, { kind: "listSessions" });
  return Array.isArray(result.sessions) ? (result.sessions as FleetSession[]) : [];
}

export async function listFleetPlans(targetId: string): Promise<FleetPlan[]> {
  const result = await run(targetId, { kind: "listPlans" });
  return Array.isArray(result.plans) ? (result.plans as FleetPlan[]) : [];
}

export async function readFleetOutput(
  targetId: string,
  sessionId: string,
  cursor: number,
): Promise<{ text: string; nextCursor: number; hasMore: boolean }> {
  const result = await run(targetId, { kind: "readOutput", sessionId, cursor, maxBytes: 16384 });
  return {
    text: typeof result.text === "string" ? result.text : "",
    nextCursor: typeof result.nextCursor === "number" ? result.nextCursor : cursor,
    hasMore: result.hasMore === true,
  };
}

export const sendFleetPrompt = (targetId: string, sessionId: string, text: string) =>
  run(targetId, { kind: "send", sessionId, text, mode: "queue", requestId: crypto.randomUUID() });

export const cancelFleetTurn = (targetId: string, sessionId: string) =>
  run(targetId, { kind: "cancel", sessionId, scope: "turn", requestId: crypto.randomUUID() });

/** Starts a saved item and reports the session it became. */
export async function launchFleetPlan(
  targetId: string,
  planId: string,
): Promise<{ session: FleetSession | null; duplicate: boolean }> {
  const result = await run(targetId, { kind: "launch", planId, requestId: crypto.randomUUID() });
  const session = result.session && typeof result.session === "object" ? (result.session as FleetSession) : null;
  return { session, duplicate: result.duplicate === true };
}

/** Waits for a remote session to change state, or says it did not. */
export async function waitFleetState(
  targetId: string,
  sessionId: string,
  timeoutMs = 5000,
): Promise<{ state: string; closed: boolean }> {
  const result = await run(targetId, { kind: "waitState", sessionId, timeoutMs });
  return {
    state: typeof result.state === "string" ? result.state : "",
    closed: result.outcome === "closed" || result.outcome === "revoked",
  };
}

/** Keeps the tail of a growing log without letting it take unbounded memory. */
export function appendBounded(current: string, next: string, limit = 200_000): string {
  const joined = current + next;
  return joined.length > limit ? joined.slice(joined.length - limit) : joined;
}
