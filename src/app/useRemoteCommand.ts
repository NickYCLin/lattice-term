import { useCallback, useEffect, useRef, useState } from "react";

export interface RemoteCommandView {
  sessionId: string;
  id: number;
  revision: number;
  shell: "cmd" | "powerShell" | "posix";
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
  const activeSession = useRef(sessionId);
  activeSession.current = sessionId;
  const generation = useRef(0);
  const currentRequest = useCallback((revision: number) =>
    activeSession.current === sessionId && generation.current === revision, [sessionId]);
  const merge = useCallback((next: RemoteCommandView, revision: number) => {
    if (currentRequest(revision) && next.sessionId === sessionId) setView(current => newerCommand(current, next));
  }, [currentRequest, sessionId]);
  const refresh = useCallback(async () => {
    const revision = generation.current;
    const { invoke } = await import("@tauri-apps/api/core");
    if (!currentRequest(revision)) return;
    const next = await invoke<RemoteCommandView | null>("remote_command_state", { sessionId });
    if (next) merge(next, revision);
  }, [currentRequest, merge, sessionId]);
  useEffect(() => {
    const revision = ++generation.current;
    let stopped = false;
    let dispose: (() => void) | undefined;
    setView(null);
    setReady(false);
    setProblem(null);
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        dispose = await listen<RemoteCommandView>("remote://command", event => {
          if (!stopped) merge(event.payload, revision);
        });
        if (stopped) { dispose(); return; }
        await refresh();
        if (!stopped) setReady(true);
      } catch (error) { if (!stopped) setProblem(String(error)); }
    })();
    return () => { stopped = true; generation.current += 1; dispose?.(); };
  }, [merge, refresh]);
  const start = useCallback(async (request: RemoteCommandInput) => {
    const revision = generation.current;
    setProblem(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      if (!currentRequest(revision)) return;
      merge(await invoke<RemoteCommandView>("remote_command_start", { sessionId, request }), revision);
    } catch (error) {
      if (currentRequest(revision)) { setProblem(String(error)); await refresh().catch(() => undefined); }
    }
  }, [currentRequest, merge, refresh, sessionId]);
  const cancel = useCallback(async (id: number) => {
    const revision = generation.current;
    setProblem(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      if (!currentRequest(revision)) return;
      await invoke("remote_command_cancel", { sessionId, id });
      if (currentRequest(revision)) await refresh();
    } catch (error) { if (currentRequest(revision)) setProblem(String(error)); }
  }, [currentRequest, refresh, sessionId]);
  return { view, ready, problem, start, cancel };
}
