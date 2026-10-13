/**
 * SSH sessions, from the interface's side.
 *
 * The backend refuses to open a session for a host it does not already trust,
 * so `connect` can finish in several ways and each one needs a different
 * response from the user. That is why it resolves to a typed outcome rather
 * than throwing: an unknown fingerprint is a question, not a failure.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { HostKeyRecord } from "../domain/security";
import {
  createSessionClosedNotice,
  SessionConnectRaceGuard,
  SessionEventReadinessGate,
  reconcileSessionSnapshot,
  snapshotSessionIds,
  type SessionClosedNotice,
} from "./sessionSnapshot";

export type { HostKeyRecord } from "../domain/security";

export type ConnectOutcome =
  | { outcome: "connected"; sessionId: string }
  | {
      outcome: "hostUnknown";
      host: string;
      port: number;
      algorithm: string;
      fingerprint: string;
    }
  | {
      outcome: "hostChanged";
      host: string;
      port: number;
      algorithm: string;
      receivedFingerprint: string;
      expected: HostKeyRecord;
    }
  | { outcome: "authFailed" }
  | { outcome: "failed"; stage: string; detail: string };

export interface SessionSummary {
  sessionId: string;
  profileId: string;
  host: string;
  port: number;
  username: string;
}

/** Secrets here are held only for one call; nothing is written to disk. */
export type SshAuth =
  | { kind: "password"; password: string }
  | { kind: "privateKey"; path: string; passphrase?: string };

export interface ConnectRequest {
  profileId: string;
  hostname: string;
  port: number;
  username: string;
  auth: SshAuth;
  useSavedPassword: boolean;
  rememberPassword: boolean;
  cols: number;
  rows: number;
}

/** Base64 keeps arbitrary terminal bytes intact across the IPC boundary. */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function core() {
  return import("@tauri-apps/api/core");
}

const MAX_PENDING_OUTPUT_BYTES = 256 * 1024;

export interface SshApi {
  sessions: SessionSummary[];
  hydrated: boolean;
  lastClosed: SessionClosedNotice | null;
  connect: (request: ConnectRequest) => Promise<ConnectOutcome>;
  send: (sessionId: string, data: string) => Promise<void>;
  resize: (sessionId: string, cols: number, rows: number) => Promise<void>;
  disconnect: (sessionId: string) => Promise<void>;
  clearLastClosed: () => void;
  trustHost: (
    host: string,
    port: number,
    algorithm: string,
    fingerprint: string,
  ) => Promise<HostKeyRecord>;
  /** OpenSSH default key files that exist on this machine, best first. */
  defaultKeys: () => Promise<string[]>;
  /** Registers a listener for one session's output. Returns an unsubscribe. */
  onData: (sessionId: string, handler: (bytes: Uint8Array) => void) => () => void;
  onClosed: (
    sessionId: string,
    handler: (reason: string) => void,
  ) => () => void;
}

export function useSshSessions(): SshApi {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [lastClosed, setLastClosed] = useState<SessionClosedNotice | null>(null);
  const dataHandlers = useRef(new Map<string, Set<(bytes: Uint8Array) => void>>());
  const closeHandlers = useRef(new Map<string, Set<(reason: string) => void>>());
  const pendingOutput = useRef(new Map<string, Uint8Array[]>());
  const pendingBytes = useRef(new Map<string, number>());
  const sessionsRef = useRef(sessions);
  const intentionalDisconnects = useRef(new Set<string>());
  const connectRaceGuard = useRef(new SessionConnectRaceGuard());
  const eventReadiness = useRef(new SessionEventReadinessGate());
  sessionsRef.current = sessions;

  // One listener pair for the whole app, fanned out by session id: a terminal
  // pane mounting must not cost another IPC subscription.
  useEffect(() => {
    const readinessAttempt = eventReadiness.current.begin();
    const disposers: Array<() => void> = [];
    let cancelled = false;
    let hydrating = true;
    let listenersReady = false;
    const closedDuringHydration = new Set<string>();

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

        // Subscribe to closure first: a snapshot that races with a close event
        // must not bring the already-closed session back.
        const stopClosed = await listen<{ sessionId: string; reason: string }>(
          "ssh://closed",
          (event) => {
            const sessionId = event.payload.sessionId;
            connectRaceGuard.current.observeClosed(sessionId, event.payload.reason);
            if (hydrating) closedDuringHydration.add(sessionId);
            const intentional = intentionalDisconnects.current.delete(sessionId);
            if (!intentional) {
              setLastClosed(
                createSessionClosedNotice(
                  sessionsRef.current,
                  sessionId,
                  event.payload.reason,
                  (session) => session.username + "@" + session.host,
                ),
              );
            }
            const handlers = closeHandlers.current.get(sessionId);
            if (handlers) {
              for (const handler of handlers) handler(event.payload.reason);
            }
            pendingOutput.current.delete(sessionId);
            pendingBytes.current.delete(sessionId);
            sessionsRef.current = sessionsRef.current.filter(session => session.sessionId !== sessionId);
            setSessions((current) =>
              current.filter((session) => session.sessionId !== sessionId),
            );
          },
        );
        if (!keep(stopClosed)) return;

        const stopData = await listen<{ sessionId: string; base64: string }>(
          "ssh://data",
          (event) => {
            const sessionId = event.payload.sessionId;
            const bytes = fromBase64(event.payload.base64);
            const handlers = dataHandlers.current.get(sessionId);
            if (handlers?.size) {
              for (const handler of handlers) handler(bytes);
              return;
            }

            if (bytes.length >= MAX_PENDING_OUTPUT_BYTES) {
              const tail = bytes.slice(bytes.length - MAX_PENDING_OUTPUT_BYTES);
              pendingOutput.current.set(sessionId, [tail]);
              pendingBytes.current.set(sessionId, tail.length);
              return;
            }

            const chunks = pendingOutput.current.get(sessionId) ?? [];
            let total = pendingBytes.current.get(sessionId) ?? 0;
            chunks.push(bytes);
            total += bytes.length;
            while (total > MAX_PENDING_OUTPUT_BYTES && chunks.length > 1) {
              total -= chunks.shift()?.length ?? 0;
            }
            pendingOutput.current.set(sessionId, chunks);
            pendingBytes.current.set(sessionId, total);
          },
        );
        if (!keep(stopData)) return;
        readinessAttempt.ready();
        listenersReady = true;

        const existing = await invoke<SessionSummary[]>("ssh_sessions");
        if (!cancelled) {
          const closedSnapshot = snapshotSessionIds(closedDuringHydration);
          setSessions((current) =>
            reconcileSessionSnapshot(current, existing, closedSnapshot),
          );
          hydrating = false;
          closedDuringHydration.clear();
          setHydrated(true);
        }
      } catch {
        if (!listenersReady) readinessAttempt.fail();
        hydrating = false;
        closedDuringHydration.clear();
        if (!cancelled) setHydrated(true);
        // Browser preview: there is no backend to listen to.
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
    async (request: ConnectRequest): Promise<ConnectOutcome> => {
      if (!(await eventReadiness.current.wait())) {
        return { outcome: "failed", stage: "events", detail: "SSH event listeners are unavailable." };
      }
      const attempt = connectRaceGuard.current.begin();
      try {
        const { invoke } = await core();
        const outcome = await invoke<ConnectOutcome>("ssh_connect", { request });

        if (outcome.outcome === "connected") {
          const summary = { sessionId: outcome.sessionId, profileId: request.profileId,
            host: request.hostname, port: request.port, username: request.username };
          const closed = attempt.finish();
          if (closed.has(outcome.sessionId)) {
            const reason = closed.get(outcome.sessionId) || "SSH connection closed during startup";
            setLastClosed(createSessionClosedNotice([summary], summary.sessionId, reason,
              session => session.username + "@" + session.host));
            return { outcome: "failed", stage: "channel", detail: reason };
          }
          sessionsRef.current = [...sessionsRef.current.filter(session => session.sessionId !== summary.sessionId), summary];
          setSessions(current => [...current.filter(session => session.sessionId !== summary.sessionId), summary]);
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

  const send = useCallback(async (sessionId: string, data: string) => {
    const { invoke } = await core();
    await invoke("ssh_send", { sessionId, data: toBase64(data) });
  }, []);

  const resize = useCallback(
    async (sessionId: string, cols: number, rows: number) => {
      const { invoke } = await core();
      await invoke("ssh_resize", { sessionId, cols, rows });
    },
    [],
  );

  const disconnect = useCallback(async (sessionId: string) => {
    intentionalDisconnects.current.add(sessionId);
    try {
      const { invoke } = await core();
      await invoke("ssh_disconnect", { sessionId });
      setSessions((current) =>
        current.filter((session) => session.sessionId !== sessionId),
      );
    } catch (reason) {
      intentionalDisconnects.current.delete(sessionId);
      throw reason;
    }
  }, []);

  const clearLastClosed = useCallback(() => setLastClosed(null), []);

  const trustHost = useCallback(
    async (
      host: string,
      port: number,
      algorithm: string,
      fingerprint: string,
    ) => {
      const { invoke } = await core();
      return invoke<HostKeyRecord>("ssh_trust_host", {
        host,
        port,
        algorithm,
        fingerprint,
      });
    },
    [],
  );

  const defaultKeys = useCallback(async () => {
    const { invoke } = await core();
    return invoke<string[]>("ssh_default_keys");
  }, []);

  const onData = useCallback(
    (sessionId: string, handler: (bytes: Uint8Array) => void) => {
      const set = dataHandlers.current.get(sessionId) ?? new Set();
      set.add(handler);
      dataHandlers.current.set(sessionId, set);
      const pending = pendingOutput.current.get(sessionId);
      pendingOutput.current.delete(sessionId);
      pendingBytes.current.delete(sessionId);
      if (pending) {
        for (const bytes of pending) handler(bytes);
      }

      return () => {
        set.delete(handler);
        if (set.size === 0) dataHandlers.current.delete(sessionId);
      };
    },
    [],
  );

  const onClosed = useCallback(
    (sessionId: string, handler: (reason: string) => void) => {
      const set = closeHandlers.current.get(sessionId) ?? new Set();
      set.add(handler);
      closeHandlers.current.set(sessionId, set);

      return () => {
        set.delete(handler);
        if (set.size === 0) closeHandlers.current.delete(sessionId);
      };
    },
    [],
  );

  return {
    sessions,
    hydrated,
    lastClosed,
    connect,
    send,
    resize,
    disconnect,
    clearLastClosed,
    trustHost,
    defaultKeys,
    onData,
    onClosed,
  };
}
