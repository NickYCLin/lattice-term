import type { AgentSessionSummary } from "./useAgentSessions";
import type { SavedAgentSession, SavedWorkspaceSession } from "./workspaceSessionPersistence";

export function remainingWorkspaceSessions(
  failed: readonly SavedWorkspaceSession[], pending: readonly SavedWorkspaceSession[],
) {
  return failed.filter(saved => pending.includes(saved));
}

export function createWorkspaceSessionStartup() {
  const attempts = new Map<string, {
    promise: Promise<AgentSessionSummary>;
    settled: boolean;
  }>();
  let restoring = true;

  function start(saved: SavedAgentSession, launch: () => Promise<AgentSessionSummary>) {
    const key = JSON.stringify([
      saved.groupKey, saved.definitionId, saved.profileConfigPath ?? null,
      saved.executable, saved.workingDirectory, saved.resumeSessionId,
      saved.launchArguments, saved.sandbox === true, saved.detached === true,
    ]);
    const existing = attempts.get(key);
    if (existing) return existing.promise;
    const attempt = {
      settled: false,
      promise: Promise.resolve().then(launch).then(session => {
        attempt.settled = true;
        if (!restoring || session.closedReason) attempts.delete(key);
        return session;
      }, reason => {
        attempts.delete(key);
        throw reason;
      }),
    };
    attempts.set(key, attempt);
    return attempt.promise;
  }

  function completeRestoration() {
    restoring = false;
    for (const [key, attempt] of attempts) {
      if (attempt.settled) attempts.delete(key);
    }
  }

  return { start, completeRestoration };
}
