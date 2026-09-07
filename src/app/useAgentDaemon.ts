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

export interface AgentDaemonStatus {
  running: boolean;
  sessions: number;
  /** Background session ids the user shared with MCP observers. */
  shared: string[];
  /** How an MCP client starts the read-only adapter for this installation. */
  mcp: AgentMcpLaunch | null;
}

const POLL_MS = 10_000;

export const EMPTY_DAEMON_STATUS: AgentDaemonStatus = {
  running: false,
  sessions: 0,
  shared: [],
  mcp: null,
};

export function useAgentDaemon(sessionsHint: number): {
  status: AgentDaemonStatus;
  refresh: () => Promise<void>;
  stop: () => Promise<boolean>;
  share: (sessionId: string, shared: boolean) => Promise<void>;
} {
  const [status, setStatus] = useState<AgentDaemonStatus>(EMPTY_DAEMON_STATUS);

  const refresh = useCallback(async () => {
    if (!hasDesktopBackend()) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const next = await invoke<AgentDaemonStatus>("agent_daemon_status");
      setStatus({ ...next, shared: next.shared ?? [], mcp: next.mcp ?? null });
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

  // Sharing lives in the background service, so the answer is its list.
  const share = useCallback(async (sessionId: string, shared: boolean) => {
    if (!hasDesktopBackend()) return;
    const { invoke } = await import("@tauri-apps/api/core");
    const next = await invoke<string[]>("agent_mcp_share", { sessionId, shared });
    setStatus((current) => ({ ...current, shared: next }));
  }, []);

  return { status, refresh, stop, share };
}
