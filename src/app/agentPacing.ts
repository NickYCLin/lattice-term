/** How many agents may work at once before queued prompts wait their turn. */

const MAX_ACTIVE_SESSIONS_KEY = "latticeterm.agentMaxActive.v1";

/** Mirrors the backend's session ceiling; a larger limit could never bind. */
export const MAX_ACTIVE_SESSIONS_CEILING = 32;

/** Choices offered in the picker; `null` means no limit. */
export const ACTIVE_SESSION_LIMIT_CHOICES: readonly (number | null)[] = [
  null,
  1,
  2,
  3,
  4,
  6,
  8,
];

export function normalizeActiveSessionLimit(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value >= 1 && value <= MAX_ACTIVE_SESSIONS_CEILING ? value : null;
}

export function loadActiveSessionLimit(): number | null {
  try {
    const raw = localStorage.getItem(MAX_ACTIVE_SESSIONS_KEY);
    return raw ? normalizeActiveSessionLimit(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function saveActiveSessionLimit(limit: number | null): void {
  try {
    if (limit === null) localStorage.removeItem(MAX_ACTIVE_SESSIONS_KEY);
    else localStorage.setItem(MAX_ACTIVE_SESSIONS_KEY, JSON.stringify(limit));
  } catch {
    // Remembering the limit is a convenience; the backend keeps it until quit.
  }
}

/**
 * Sessions this one could follow. Background sessions and window sessions
 * live in different registries, so a chain never crosses between them, and
 * a session that already follows this one would close a loop.
 */
export function queueDependencyCandidates<
  T extends { sessionId: string; detached?: boolean; waitsFor?: string | null },
>(sessions: readonly T[], sessionId: string): T[] {
  const self = sessions.find((session) => session.sessionId === sessionId);
  if (!self) return [];
  const follows = new Map(
    sessions.map((session) => [session.sessionId, session.waitsFor ?? null]),
  );
  const reaches = (from: string): boolean => {
    let current: string | null = from;
    for (let step = 0; current && step < sessions.length; step += 1) {
      if (current === sessionId) return true;
      current = follows.get(current) ?? null;
    }
    return false;
  };
  return sessions.filter(
    (session) =>
      session.sessionId !== sessionId &&
      Boolean(session.detached) === Boolean(self.detached) &&
      !reaches(session.sessionId),
  );
}
