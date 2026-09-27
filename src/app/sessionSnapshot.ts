export interface SessionIdentity {
  sessionId: string;
}

export interface SessionClosedNotice extends SessionIdentity {
  label: string;
  reason: string;
  at: number;
  /** LatticeTerm is bringing this connection back by itself. */
  reconnecting?: boolean;
  /** Every automatic attempt ran out; the person has to reconnect by hand. */
  reconnectFailed?: boolean;
}

interface SessionEventReadinessAttempt {
  ready: () => void;
  fail: () => void;
}

interface SessionEventReadinessCycle {
  promise: Promise<boolean>;
  settle: (ready: boolean) => void;
}

function sessionEventReadinessCycle(): SessionEventReadinessCycle {
  let settled = false;
  let resolveCycle: (ready: boolean) => void = () => {};
  const promise = new Promise<boolean>((resolve) => {
    resolveCycle = resolve;
  });
  return {
    promise,
    settle: (ready) => {
      if (settled) return;
      settled = true;
      resolveCycle(ready);
    },
  };
}

/**
 * Gates native connects on the app-wide lifecycle listeners. A React
 * StrictMode cleanup can fail one generation and immediately replace it;
 * existing waiters follow the replacement rather than slipping through the
 * listener gap or hanging forever.
 */
export class SessionEventReadinessGate {
  private current = sessionEventReadinessCycle();

  begin(): SessionEventReadinessAttempt {
    const previous = this.current;
    const cycle = sessionEventReadinessCycle();
    this.current = cycle;
    previous.settle(false);
    return {
      ready: () => {
        if (this.current === cycle) cycle.settle(true);
        else cycle.settle(false);
      },
      fail: () => {
        if (this.current !== cycle) {
          cycle.settle(false);
          return;
        }
        const failed = sessionEventReadinessCycle();
        this.current = failed;
        cycle.settle(false);
        failed.settle(false);
      },
    };
  }

  async wait(): Promise<boolean> {
    for (;;) {
      const cycle = this.current;
      const ready = await cycle.promise;
      if (this.current !== cycle) continue;
      return ready;
    }
  }
}

export interface SessionConnectAttempt {
  finish: () => ReadonlyMap<string, string>;
  cancel: () => void;
}

/** Keeps exact close events for every in-flight connect response. */
export class SessionConnectRaceGuard {
  private readonly attempts = new Set<Map<string, string>>();

  begin(): SessionConnectAttempt {
    const closed = new Map<string, string>();
    this.attempts.add(closed);
    let finished = false;
    const settle = () => {
      if (finished) return false;
      finished = true;
      this.attempts.delete(closed);
      return true;
    };
    return {
      finish: () => {
        if (!settle()) return new Map();
        return new Map(closed);
      },
      cancel: () => {
        settle();
      },
    };
  }

  observeClosed(sessionId: string, reason: string): void {
    for (const attempt of this.attempts) attempt.set(sessionId, reason);
  }
}

/**
 * Copies event ids before a React functional updater captures them. React may
 * execute that updater after the hydration buffers have already been cleared.
 */
export function snapshotSessionIds(
  sessionIds: ReadonlySet<string>,
): ReadonlySet<string> {
  return new Set(sessionIds);
}

/** Copies hydration event payloads before a deferred updater captures them. */
export function snapshotHydrationMap<K, V>(
  entries: ReadonlyMap<K, V>,
): ReadonlyMap<K, V> {
  return new Map(entries);
}

/**
 * Returns whether a closed pane owns the currently visible workspace tab.
 * Background terminal panes remain mounted, so their close callbacks must not
 * clear the user's selection while another session is active.
 */
export function shouldClearSessionSelection(
  activeSessionId: string,
  closedSessionId: string,
): boolean {
  return activeSessionId === closedSessionId;
}

/** Exit code 0 is a completed local process, not a dropped connection. */
export function isSuccessfulProcessExit(reason: string): boolean {
  return /Process exited:\s*ExitStatus\s*\{\s*code:\s*0(?:,|\s*})/i.test(
    reason,
  );
}

/**
 * Builds the durable notice shown after a session pane has already unmounted.
 * The id fallback matters during initial hydration, where a close event can
 * arrive before the matching backend snapshot.
 */
export function createSessionClosedNotice<T extends SessionIdentity>(
  sessions: readonly T[],
  sessionId: string,
  reason: string,
  label: (session: T) => string,
  at = Date.now(),
): SessionClosedNotice {
  const session = sessions.find((entry) => entry.sessionId === sessionId);
  return {
    sessionId,
    label: session ? label(session) : sessionId,
    reason,
    at,
  };
}

/**
 * Reconciles a backend snapshot with events or connections that landed while
 * the snapshot request was in flight. Current entries win so a newer frame or
 * local connection is never replaced by an older snapshot, while sessions
 * observed closing during hydration cannot be resurrected.
 */
export function reconcileSessionSnapshot<T extends SessionIdentity>(
  current: T[],
  snapshot: T[],
  closedSessionIds: ReadonlySet<string> = new Set(),
): T[] {
  const reconciled = new Map<string, T>();

  for (const session of snapshot) {
    if (!closedSessionIds.has(session.sessionId)) {
      reconciled.set(session.sessionId, session);
    }
  }
  for (const session of current) {
    if (!closedSessionIds.has(session.sessionId)) {
      reconciled.set(session.sessionId, session);
    }
  }

  return [...reconciled.values()];
}

/**
 * Reconciles a singleton backend snapshot with status events or local actions
 * that completed while the snapshot request was in flight. A current value is
 * newer than the snapshot, while a close event must prevent the matching
 * snapshot value from being restored.
 */
export function reconcileSingletonSnapshot<T>(
  current: T | null,
  snapshot: T | null,
  identity: (value: T) => string,
  closedSessionIds: ReadonlySet<string> = new Set(),
): T | null {
  if (current && !closedSessionIds.has(identity(current))) return current;
  if (snapshot && !closedSessionIds.has(identity(snapshot))) return snapshot;
  return null;
}
