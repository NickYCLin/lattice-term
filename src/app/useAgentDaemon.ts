/**
 * The background service that keeps detached Agent Fleet sessions alive
 * after the window closes.  The interface only needs to know whether it is
 * running, how many sessions it holds, and how to end it on request.
 */
import { useCallback, useEffect, useState } from "react";
import { hasDesktopBackend } from "./nativeRuntime";

export interface AgentMcpLaunch {
  command: string;
  args: string[];
}

export interface AgentMcpActivity {
  client: string;
  action: string;
  /** Unix milliseconds. */
  at: number;
}

export interface AgentSharedSession {
  sessionId: string;
  /** Terminal contents are a separate grant; legacy shares already allowed them. */
  readOutput: boolean;
  /** MCP clients may prompt and end it, not only read it. */
  control: boolean;
  /** The last thing an MCP client did to it. */
  activity?: AgentMcpActivity | null;
}

export interface AgentMcpHistory {
  entries: {
    id: number;
    at: number;
    client: string;
    action: "launch" | "prompt" | "queue" | "clearQueue" | "stop" | "remoteMetrics" | "remoteList" | "remoteExec" | "remoteUpload" | "remoteDownload" | "remoteCancel" | "remoteStatus" | "grant" | "revoke";
    outcome: "accepted" | "replayed" | "failed" | "unknown";
    sessionId: string | null;
    targetId?: string | null;
  }[];
  discarded: number;
  limit: number;
  /** Missing on older background services: never imply their history is saved. */
  persistence?: "memoryOnly" | "pending" | "ready" | "unavailable";
  persistedThroughId?: number | null;
  persistenceReason?: "unsafePath" | "invalidData" | "externalChange" | "ioFailure" | "busy" | "workerStopped" | null;
}

export interface AgentDaemonStatus {
  running: boolean;
  mcpNeedsRestart: boolean;
  /** A missing capability is never treated as metadata-only support. */
  mcpOutputScopes: boolean;
  sessions: number;
  /** Background sessions the user shared with MCP observers, with grants. */
  shared: AgentSharedSession[];
  /** How an MCP client starts the adapter for this installation. */
  mcp: AgentMcpLaunch | null;
  /** null means unavailable, not a verified empty history. */
  history: AgentMcpHistory | null;
}

const POLL_MS = 10_000;

export const EMPTY_DAEMON_STATUS: AgentDaemonStatus = {
  running: false,
  mcpNeedsRestart: false,
  mcpOutputScopes: false,
  sessions: 0,
  shared: [],
  mcp: null,
  history: null,
};

export function useAgentDaemon(sessionsHint: number): {
  status: AgentDaemonStatus;
  refresh: () => Promise<void>;
  stop: () => Promise<boolean>;
  share: (sessionId: string, shared: boolean, readOutput?: boolean) => Promise<void>;
  control: (sessionId: string, control: boolean) => Promise<void>;
} {
  const [status, setStatus] = useState<AgentDaemonStatus>(EMPTY_DAEMON_STATUS);

  const refresh = useCallback(async () => {
    if (!hasDesktopBackend()) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const next = await invoke<AgentDaemonStatus>("agent_daemon_status");
      setStatus({
        ...next,
        mcpNeedsRestart: next.mcpNeedsRestart ?? false,
        mcpOutputScopes: next.mcpOutputScopes === true,
        shared: (next.shared ?? []).map(normalizeSharedSession),
        mcp: next.mcp ?? null,
        history: next.history ?? null,
      });
    } catch {
      setStatus(EMPTY_DAEMON_STATUS);
    }
  }, []);

  // Re-read whenever the session list changes shape, and on a slow tick so
  // a daemon that exited by itself stops being shown as running.
  useEffect(() => {
    void refresh();
  }, [refresh, sessionsHint]);
  useEffect(() => {
    if (!hasDesktopBackend()) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const stop = useCallback(async () => {
    if (!hasDesktopBackend()) return false;
    const { invoke } = await import("@tauri-apps/api/core");
    const stopped = await invoke<boolean>("agent_daemon_stop");
    await refresh();
    return stopped;
  }, [refresh]);

  // Sharing and control live in the background service, so the answer is
  // its list.
  const share = useCallback(async (sessionId: string, shared: boolean, readOutput = false) => {
    if (!hasDesktopBackend()) return;
    if (shared && !status.mcpOutputScopes) {
      throw new Error("Restart the background service after existing work finishes to set separate output permissions.");
    }
    const { invoke } = await import("@tauri-apps/api/core");
    const next = await invoke<AgentSharedSession[]>("agent_mcp_share", {
      sessionId,
      shared,
      ...(shared ? { readOutput } : {}),
    });
    setStatus((current) => ({ ...current, shared: next.map(normalizeSharedSession) }));
  }, [status.mcpOutputScopes]);

  const control = useCallback(async (sessionId: string, control: boolean) => {
    if (!hasDesktopBackend()) return;
    const { invoke } = await import("@tauri-apps/api/core");
    const next = await invoke<AgentSharedSession[]>("agent_mcp_control", {
      sessionId,
      control,
    });
    setStatus((current) => ({ ...current, shared: next.map(normalizeSharedSession) }));
  }, []);

  return { status, refresh, stop, share, control };
}

function normalizeSharedSession(entry: AgentSharedSession): AgentSharedSession {
  return { ...entry, readOutput: entry.readOutput ?? true };
}
