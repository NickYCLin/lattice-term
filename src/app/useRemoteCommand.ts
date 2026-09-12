import { useCallback, useEffect, useState } from "react";

export interface RemoteCommandView {
  sessionId: string;
  id: number;
  revision: number;
  shell: "cmd" | "powerShell";
  command: string;
  directory: string;
  state: "starting" | "running" | "cancelling" | "exited" | "cancelled" | "timedOut" | "outputLimit" | "failed";
  stdout: string;
  stderr: string;
  exitCode: number | null;
  detail: string;
}
export interface RemoteCommandInput {
  shell: RemoteCommandView["shell"];
  command: string;
  directory: string;
  timeoutSeconds: number;
}
export function newerCommand(current: RemoteCommandView | null, next: RemoteCommandView): RemoteCommandView {
  if (!current || current.sessionId !== next.sessionId || next.id > current.id ||
    (next.id === current.id && next.revision > current.revision)) return next;
  return current;
}
export function commandActive(view: RemoteCommandView | null): boolean {
  return !!view && ["starting", "running", "cancelling"].includes(view.state);
}
export function useRemoteCommand(sessionId: string) {
  const [view, setView] = useState<RemoteCommandView | null>(null);
  const [ready, setReady] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const merge = useCallback((next: RemoteCommandView) => {
    if (next.sessionId === sessionId) setView(current => newerCommand(current, next));
  }, [sessionId]);
  const refresh = useCallback(async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const next = await invoke<RemoteCommandView | null>("remote_command_state", { sessionId });
    if (next) merge(next);
  }, [merge, sessionId]);
  useEffect(() => {
    let stopped = false;
    let dispose: (() => void) | undefined;
    setView(null);
    setReady(false);
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        dispose = await listen<RemoteCommandView>("remote://command", event => {
          if (!stopped) merge(event.payload);
        });
        if (stopped) { dispose(); return; }
        await refresh();
        if (!stopped) setReady(true);
      } catch (error) { if (!stopped) setProblem(String(error)); }
    })();
    return () => { stopped = true; dispose?.(); };
  }, [merge, refresh]);
  const start = useCallback(async (request: RemoteCommandInput) => {
    setProblem(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      merge(await invoke<RemoteCommandView>("remote_command_start", { sessionId, request }));
    } catch (error) { setProblem(String(error)); await refresh().catch(() => undefined); }
  }, [merge, refresh, sessionId]);
  const cancel = useCallback(async (id: number) => {
    setProblem(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("remote_command_cancel", { sessionId, id });
      await refresh();
    } catch (error) { setProblem(String(error)); }
  }, [refresh, sessionId]);
  return { view, ready, problem, start, cancel };
}
