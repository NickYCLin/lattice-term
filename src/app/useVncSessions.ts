/** Native VNC sessions rendered by the embedded Canvas pane. */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  reconcileSessionSnapshot,
  SessionConnectRaceGuard,
  SessionEventReadinessGate,
  snapshotSessionIds,
  type SessionClosedNotice,
} from "./sessionSnapshot";

export interface VncFrame {
  frameId: number;
  width: number;
  height: number;
  dataUrl: string;
}

export interface VncSessionSummary {
  sessionId: string;
  profileId: string;
  host: string;
  port: number;
  width: number;
  height: number;
  interactive: boolean;
  frame: VncFrame | null;
}

export interface VncConnectRequest {
  profileId: string;
  hostname: string;
  port: number;
  password: string;
  useSavedPassword: boolean;
  rememberPassword: boolean;
}

export type VncConnectOutcome =
  | ({ outcome: "connected" } & Omit<VncSessionSummary, "frame">)
  | { outcome: "authFailed" }
  | { outcome: "failed"; stage: string; detail: string };

/** VNC keyboards speak X11 keysyms, not scancodes. */
export type VncInput =
  | { kind: "mouseMove"; x: number; y: number }
  | { kind: "mouseButton"; button: number; pressed: boolean }
  | { kind: "wheel"; horizontal: boolean; units: number }
  | { kind: "key"; keysym: number; pressed: boolean }
  | { kind: "releaseAll" };

interface FrameEvent {
  sessionId: string;
  frameId: number;
  width: number;
  height: number;
  mimeType: string;
  base64: string;
}

export interface VncApi {
  sessions: VncSessionSummary[];
  lastClosed: SessionClosedNotice | null;
  connect: (request: VncConnectRequest) => Promise<VncConnectOutcome>;
  input: (sessionId: string, request: VncInput) => Promise<void>;
  disconnect: (sessionId: string) => Promise<void>;
  clearLastClosed: () => void;
}

async function core() {
  return import("@tauri-apps/api/core");
}

export function useVncSessions(): VncApi {
  const [sessions, setSessions] = useState<VncSessionSummary[]>([]);
  const [lastClosed, setLastClosed] = useState<SessionClosedNotice | null>(null);
  const sessionsRef = useRef(sessions);
  const intentionalDisconnects = useRef(new Set<string>());
  const connectRaceGuard = useRef(new SessionConnectRaceGuard());
  const eventReadiness = useRef(new SessionEventReadinessGate());
  sessionsRef.current = sessions;

  useEffect(() => {
    const readinessAttempt = eventReadiness.current.begin();
    const disposers: Array<() => void> = [];
    let cancelled = false;
    let hydrating = true;
    let listenersReady = false;
    const closedDuringHydration = new Set<string>();
    const pendingFrames = new Map<string, VncFrame>();

    function keep(dispose: () => void): boolean {
      if (cancelled) {
        dispose();
        return false;
      }
      disposers.push(dispose);
      return true;
    }

    async function subscribe() {
      try {
        const [{ invoke }, { listen }] = await Promise.all([
          core(),
          import("@tauri-apps/api/event"),
        ]);

        const stopClosed = await listen<{ sessionId: string; reason: string }>(
          "vnc://closed",
          (event) => {
            const sessionId = event.payload.sessionId;
            connectRaceGuard.current.observeClosed(
              sessionId,
              event.payload.reason,
            );
            if (hydrating) closedDuringHydration.add(sessionId);
            pendingFrames.delete(sessionId);
            const intentional = intentionalDisconnects.current.delete(sessionId);
            if (!intentional) {
              const session = sessionsRef.current.find(
                (current) => current.sessionId === sessionId,
              );
              setLastClosed({
                sessionId,
                label: session
                  ? session.host + ":" + session.port
                  : sessionId,
                reason: event.payload.reason,
                at: Date.now(),
              });
            }
            setSessions((current) =>
              current.filter((session) => session.sessionId !== sessionId),
            );
          },
        );
        if (!keep(stopClosed)) {
          readinessAttempt.fail();
          return;
        }

        const stopFrames = await listen<FrameEvent>("vnc://frame", (event) => {
          const frame: VncFrame = {
            frameId: event.payload.frameId,
            width: event.payload.width,
            height: event.payload.height,
            dataUrl: `data:${event.payload.mimeType};base64,${event.payload.base64}`,
          };
          if (hydrating) pendingFrames.set(event.payload.sessionId, frame);
          setSessions((current) =>
            current.map((session) =>
              session.sessionId === event.payload.sessionId
                ? { ...session, width: frame.width, height: frame.height, frame }
                : session,
            ),
          );
        });
        if (!keep(stopFrames)) {
          readinessAttempt.fail();
          return;
        }

        readinessAttempt.ready();
        listenersReady = true;

        const existing =
          await invoke<Array<Omit<VncSessionSummary, "frame">>>("vnc_sessions");
        if (!cancelled) {
          const restored = existing.map<VncSessionSummary>((session) => {
            const frame = pendingFrames.get(session.sessionId) ?? null;
            return frame
              ? { ...session, width: frame.width, height: frame.height, frame }
              : { ...session, frame: null };
          });
          const closedSnapshot = snapshotSessionIds(closedDuringHydration);
          setSessions((current) =>
            reconcileSessionSnapshot(current, restored, closedSnapshot),
          );
          hydrating = false;
          closedDuringHydration.clear();
          pendingFrames.clear();
        }
      } catch {
        if (!listenersReady) readinessAttempt.fail();
        hydrating = false;
        closedDuringHydration.clear();
        pendingFrames.clear();
        // Browser preview intentionally has no native VNC event source.
      }
    }

    void subscribe();
    return () => {
      cancelled = true;
      readinessAttempt.fail();
      for (const dispose of disposers) dispose();
    };
  }, []);

  const connect = useCallback(
    async (request: VncConnectRequest): Promise<VncConnectOutcome> => {
      if (!(await eventReadiness.current.wait())) {
        return {
          outcome: "failed",
          stage: "events",
          detail: "VNC event listeners are unavailable.",
        };
      }
      const attempt = connectRaceGuard.current.begin();
      try {
        const { invoke } = await core();
        const outcome = await invoke<VncConnectOutcome>("vnc_connect", {
          request,
        });
        if (outcome.outcome === "connected") {
          const { outcome: _outcome, ...summary } = outcome;
          const closed = attempt.finish();
          if (closed.has(summary.sessionId)) {
            const reason = closed.get(summary.sessionId) || "Connection closed";
            setLastClosed((current) =>
              current?.sessionId === summary.sessionId
                ? {
                    ...current,
                    label: summary.host + ":" + summary.port,
                    reason,
                  }
                : current,
            );
            return {
              outcome: "failed",
              stage: "startup",
              detail: `${summary.host}:${summary.port} closed during startup: ${reason}`,
            };
          }
          setSessions((current) => [
            ...current.filter(
              (session) => session.sessionId !== summary.sessionId,
            ),
            { ...summary, frame: null },
          ]);
        }
        return outcome;
      } catch (error) {
        return {
          outcome: "failed",
          stage: "invoke",
          detail: error instanceof Error ? error.message : String(error),
        };
      } finally {
        attempt.cancel();
      }
    },
    [],
  );

  const input = useCallback(async (sessionId: string, request: VncInput) => {
    const { invoke } = await core();
    await invoke("vnc_input", { sessionId, request });
  }, []);

  const disconnect = useCallback(async (sessionId: string) => {
    intentionalDisconnects.current.add(sessionId);
    try {
      const { invoke } = await core();
      await invoke("vnc_disconnect", { sessionId });
      setSessions((current) =>
        current.filter((session) => session.sessionId !== sessionId),
      );
    } catch (reason) {
      intentionalDisconnects.current.delete(sessionId);
      throw reason;
    }
  }, []);

  const clearLastClosed = useCallback(() => setLastClosed(null), []);

  return {
    sessions,
    lastClosed,
    connect,
    input,
    disconnect,
    clearLastClosed,
  };
}
