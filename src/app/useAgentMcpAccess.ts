import { useCallback, useEffect, useRef, useState } from "react";
import { AgentMcpPreferences, mcpPreferenceMatches, type AgentMcpPreference } from "./agentMcpPreferences";
import { hasDesktopBackend } from "./nativeRuntime";
import { useAgentDaemon, type McpAccess } from "./useAgentDaemon";
import type { AgentSessionSummary } from "./useAgentSessions";

export function useAgentMcpAccess(sessions: readonly AgentSessionSummary[], ready: boolean) {
  const daemon = useAgentDaemon(sessions.length);
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [retryRevision, setRetryRevision] = useState(0);
  const preferences = useRef<AgentMcpPreferences | null>(null);
  const storageError = useRef<string | null>(null);
  const loaded = useRef(false);
  const current = useRef({ sessions, daemon });
  current.current = { sessions, daemon };
  const attempted = useRef(new Set<string>());
  const adopted = useRef(new Set<string>());
  const revisions = useRef(new Map<string, number>());
  const queue = useRef(Promise.resolve());
  const alive = useRef(false);

  useEffect(() => {
    alive.current = true;
    if (!loaded.current && hasDesktopBackend()) {
      loaded.current = true;
      try { preferences.current = new AgentMcpPreferences(window.localStorage); }
      catch (reason) { storageError.current = String(reason); }
    }
    return () => { alive.current = false; };
  }, []);

  const applyAccess = useCallback((session: AgentSessionSummary, access: McpAccess, readOutput: boolean, revision: number, preference?: AgentMcpPreference) => {
    const sessionId = session.sessionId;
    const operation = queue.current.catch(() => {}).then(async () => {
      if (!alive.current || revisions.current.get(sessionId) !== revision) return;
      if (access !== "off") {
        const live = current.current.sessions.find(entry => entry.sessionId === sessionId);
        if (!live || live.closedReason || preference && !mcpPreferenceMatches(preference, live)) return;
      }
      setPending(previous => new Set(previous).add(sessionId));
      try {
        if (access === "off") await current.current.daemon.share(sessionId, false);
        else {
          await current.current.daemon.share(sessionId, true, readOutput);
          if (!alive.current || revisions.current.get(sessionId) !== revision) return;
          if (access === "full" || current.current.daemon.status.shared.some(entry => entry.sessionId === sessionId && entry.control)) {
            await current.current.daemon.control(sessionId, access === "full");
          }
        }
        if (alive.current && revisions.current.get(sessionId) === revision) setFailures(previous => {
          const next = { ...previous }; delete next[sessionId]; return next;
        });
      } catch (reason) {
        if (alive.current && revisions.current.get(sessionId) === revision) setFailures(previous => ({ ...previous, [sessionId]: String(reason) }));
        throw reason;
      } finally {
        if (alive.current) setPending(previous => { const next = new Set(previous); next.delete(sessionId); return next; });
      }
    });
    queue.current = operation.catch(() => {});
    return operation;
  }, []);

  const setAccess = useCallback(async (sessionId: string, access: McpAccess) => {
    const session = current.current.sessions.find(entry => entry.sessionId === sessionId);
    if (!session) throw new Error("The session is no longer available.");
    const revision = (revisions.current.get(sessionId) ?? 0) + 1;
    revisions.current.set(sessionId, revision);
    attempted.current.add(sessionId);
    adopted.current.add(sessionId);
    let persistenceFailure: unknown;
    try {
      if (!preferences.current) throw new Error(storageError.current ?? "Cannot save MCP sharing choices.");
      preferences.current.remember(session, access);
    } catch (reason) { persistenceFailure = reason; }
    if (persistenceFailure) {
      preferences.current = null;
      storageError.current = String(persistenceFailure);
      if (access !== "off") throw persistenceFailure;
    }
    await applyAccess(session, access, true, revision);
    if (persistenceFailure) throw new Error("MCP access was revoked, but the saved sharing choice could not be removed: " + String(persistenceFailure));
  }, [applyAccess]);

  const retry = useCallback((sessionId: string) => {
    attempted.current.delete(sessionId);
    setRetryRevision(value => value + 1);
  }, []);

  useEffect(() => {
    if (!ready || !daemon.status.mcpOutputScopes || !preferences.current) return;
    const store = preferences.current;
    for (const session of sessions) {
      if (session.closedReason) continue;
      try {
        const shared = daemon.status.shared.find(entry => entry.sessionId === session.sessionId);
        if (!adopted.current.has(session.sessionId)) {
          adopted.current.add(session.sessionId);
          if (shared) store.adopt(session, shared);
        }
        store.updateIdentity(session);
        const entry = store.find(session);
        if (!entry || attempted.current.has(session.sessionId)) continue;
        attempted.current.add(session.sessionId);
        if (shared && shared.control === (entry.access === "full") && shared.readOutput === entry.readOutput) continue;
        const revision = revisions.current.get(session.sessionId) ?? 0;
        revisions.current.set(session.sessionId, revision);
        void applyAccess(session, entry.access, entry.readOutput, revision, entry).catch(() => {});
      } catch (reason) {
        setFailures(previous => ({ ...previous, [session.sessionId]: String(reason) }));
      }
    }
  }, [sessions, ready, daemon.status.shared, daemon.status.mcpOutputScopes, retryRevision, applyAccess]);

  return { daemon, setAccess, pending, failures, retry };
}

export type AgentMcpAccessApi = ReturnType<typeof useAgentMcpAccess>;
