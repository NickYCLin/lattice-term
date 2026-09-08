/** Lattice Remote sessions and their latest encrypted-stream frame. */

import { useCallback, useEffect, useRef, useState } from "react";
import type { RemoteTextDocument } from "../domain/remoteText";
import {
  reconcileSessionSnapshot,
  SessionConnectRaceGuard,
  SessionEventReadinessGate,
  snapshotSessionIds,
  type SessionClosedNotice,
} from "./sessionSnapshot";

export {
  SessionConnectRaceGuard as RemoteConnectRaceGuard,
  SessionEventReadinessGate as RemoteEventReadinessGate,
} from "./sessionSnapshot";

export interface RemoteFrame {
  frameId: number;
  width: number;
  height: number;
  dataUrl: string;
}

export interface RemoteSessionSummary {
  sessionId: string;
  profileId: string;
  host: string;
  port: number;
  /** True when the session reached the host by device ID over a relay. */
  viaRelay: boolean;
  agentName: string;
  width: number;
  height: number;
  viewOnly: boolean;
  fileTransfer: boolean;
  /** Absent/false for older hosts: never send them editor protocol messages. */
  fileEdit?: boolean;
  fileRootLabel: string;
  /** True when the agent shares a shell (headless host) instead of a display. */
  terminal: boolean;
  frame: RemoteFrame | null;
}

export interface RemoteFileEntry {
  name: string;
  path: string;
  kind: "directory" | "file" | "symlink" | "other";
  size: number;
  modifiedAt: number | null;
}

export interface RemoteDirectory {
  path: string;
  entries: RemoteFileEntry[];
}

export interface RemoteFileTransfer {
  transferId: string;
  sessionId: string;
  kind: "download" | "upload";
  name: string;
  remotePath: string;
  localPath: string | null;
  bytesDone: number;
  totalBytes: number | null;
  state: "running" | "done" | "error" | "cancelled";
  detail: string | null;
}

export interface RemoteConnectRequest {
  profileId: string;
  hostname: string;
  port: number;
  /** One-call secret passed to one IPC call and never retained here. */
  pairingCode: string;
  useSavedPairingCode?: boolean;
  rememberPairingCode?: boolean;
  /** Explicit compatibility mode for an already trusted, old eight-digit host. */
  legacyPairing?: boolean;
  /** When set, the backend dials this nine-digit ID through the relay. */
  deviceId?: string;
  relayAddress?: string;
}

export type RemoteConnectOutcome =
  | ({ outcome: "connected" } & Omit<RemoteSessionSummary, "frame">)
  | { outcome: "failed"; stage: string; detail: string };

/** One control action sent to an interactive (non view-only) session. */
export type RemoteInput =
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

export interface RemoteTerminalDataEvent {
  sessionId: string;
  offset: number;
  base64: string;
}

export interface RemoteTerminalSnapshot {
  sessionId: string;
  startOffset: number;
  endOffset: number;
  base64: string;
}

export interface RemoteTerminalOutputChunk {
  offset: number;
  bytes: Uint8Array;
}

export interface RemoteApi {
  sessions: RemoteSessionSummary[];
  transfers: Record<string, RemoteFileTransfer>;
  lastClosed: SessionClosedNotice | null;
  connect: (request: RemoteConnectRequest) => Promise<RemoteConnectOutcome>;
  disconnect: (sessionId: string) => Promise<void>;
  input: (sessionId: string, request: RemoteInput) => Promise<void>;
  terminalInput: (sessionId: string, data: string) => Promise<void>;
  terminalResize: (
    sessionId: string,
    cols: number,
    rows: number,
  ) => Promise<void>;
  /** Registers one terminal output consumer and synchronously flushes its tail. */
  onTerminalData: (
    sessionId: string,
    handler: (bytes: Uint8Array) => void,
  ) => () => void;
  listFiles: (sessionId: string, path: string) => Promise<RemoteDirectory>;
  readTextFile: (sessionId: string, path: string) => Promise<RemoteTextDocument>;
  saveTextFile: (sessionId: string, path: string, content: string, revision: string) => Promise<RemoteTextDocument>;
  downloadFile: (sessionId: string, path: string) => Promise<RemoteFileTransfer>;
  uploadFile: (
    sessionId: string,
    parent: string,
    file: File,
    overwrite: boolean,
    onStarted?: (transfer: RemoteFileTransfer) => void,
  ) => Promise<void>;
  cancelFileTransfer: (sessionId: string, transferId: string) => Promise<void>;
  dismissFileTransfer: (sessionId: string, transferId: string) => Promise<void>;
  clearLastClosed: () => void;
}

const REMOTE_UPLOAD_CHUNK_BYTES = 48 * 1024;
export const MAX_REMOTE_TERMINAL_PENDING_BYTES = 256 * 1024;
export const MAX_REMOTE_TERMINAL_PENDING_CHUNKS = 1024;
const MAX_REMOTE_TERMINAL_BASE64_BYTES =
  Math.ceil(MAX_REMOTE_TERMINAL_PENDING_BYTES / 3) * 4;
const MAX_REMOTE_TERMINAL_CLOSED_TOMBSTONES = 128;

type RemoteInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

function validateRemoteTerminalOffset(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Remote terminal ${label} is invalid.`);
  }
}

function decodeRemoteTerminalPayload(value: string): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length > MAX_REMOTE_TERMINAL_BASE64_BYTES
  ) {
    throw new Error("Remote terminal payload exceeds the safe size limit.");
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error("Remote terminal payload is not valid base64.");
  }
  if (binary.length > MAX_REMOTE_TERMINAL_PENDING_BYTES) {
    throw new Error("Remote terminal payload exceeds the safe size limit.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function terminalEventChunk(
  event: RemoteTerminalDataEvent,
): RemoteTerminalOutputChunk {
  validateRemoteTerminalOffset(event.offset, "offset");
  const bytes = decodeRemoteTerminalPayload(event.base64);
  if (!Number.isSafeInteger(event.offset + bytes.length)) {
    throw new Error("Remote terminal payload exceeds the offset range.");
  }
  return { offset: event.offset, bytes };
}

function terminalSnapshotChunk(
  snapshot: RemoteTerminalSnapshot,
): RemoteTerminalOutputChunk {
  validateRemoteTerminalOffset(snapshot.startOffset, "snapshot start offset");
  validateRemoteTerminalOffset(snapshot.endOffset, "snapshot end offset");
  if (snapshot.endOffset < snapshot.startOffset) {
    throw new Error("Remote terminal snapshot offsets are inconsistent.");
  }
  const bytes = decodeRemoteTerminalPayload(snapshot.base64);
  if (bytes.length !== snapshot.endOffset - snapshot.startOffset) {
    throw new Error("Remote terminal snapshot offsets are inconsistent.");
  }
  return { offset: snapshot.startOffset, bytes };
}

function reconcileRemoteTerminalChunks(
  chunks: readonly RemoteTerminalOutputChunk[],
): RemoteTerminalOutputChunk[] {
  const ordered = [...chunks]
    .filter((chunk) => chunk.bytes.length > 0)
    .sort(
      (left, right) =>
        left.offset - right.offset || right.bytes.length - left.bytes.length,
    );
  const reconciled: RemoteTerminalOutputChunk[] = [];
  let cursor: number | null = null;
  for (const chunk of ordered) {
    validateRemoteTerminalOffset(chunk.offset, "offset");
    const endOffset = chunk.offset + chunk.bytes.length;
    if (!Number.isSafeInteger(endOffset)) {
      throw new Error("Remote terminal payload exceeds the offset range.");
    }
    if (cursor !== null && endOffset <= cursor) continue;
    const freshOffset =
      cursor === null ? chunk.offset : Math.max(cursor, chunk.offset);
    const fresh = chunk.bytes.subarray(freshOffset - chunk.offset);
    if (fresh.length > 0) {
      reconciled.push({ offset: freshOffset, bytes: fresh });
      cursor = endOffset;
    }
  }
  return reconciled;
}

/** Orders and de-duplicates the backend snapshot and any live overlap by offset. */
export function reconcileRemoteTerminalOutput(
  snapshot: RemoteTerminalSnapshot | null,
  events: readonly RemoteTerminalDataEvent[],
): RemoteTerminalOutputChunk[] {
  const chunks = events.map(terminalEventChunk);
  if (snapshot) chunks.push(terminalSnapshotChunk(snapshot));
  return reconcileRemoteTerminalChunks(chunks);
}

interface RemoteTerminalStreamState {
  handlers: Set<(bytes: Uint8Array) => void>;
  history: RemoteTerminalOutputChunk[];
  historyBytes: number;
  cursor: number | null;
}

/**
 * Owns one app-wide Remote PTY stream. It listens before hydration, reconciles
 * the backend tail with racing events, then fans output out to mounted panes.
 */
export class RemoteTerminalOutputRouter {
  private hydrating = true;
  private readonly streams = new Map<string, RemoteTerminalStreamState>();
  private readonly hydrationEvents = new Map<
    string,
    RemoteTerminalOutputChunk[]
  >();
  private readonly hydrationBytes = new Map<string, number>();
  private readonly closedSessions = new Set<string>();

  constructor(
    private readonly maxPendingBytes = MAX_REMOTE_TERMINAL_PENDING_BYTES,
    private readonly maxPendingChunks = MAX_REMOTE_TERMINAL_PENDING_CHUNKS,
  ) {
    if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes < 1) {
      throw new Error("Remote terminal pending limit must be positive.");
    }
    if (!Number.isSafeInteger(maxPendingChunks) || maxPendingChunks < 1) {
      throw new Error("Remote terminal chunk limit must be positive.");
    }
  }

  observe(event: RemoteTerminalDataEvent): boolean {
    if (this.closedSessions.has(event.sessionId)) return false;
    let chunk: RemoteTerminalOutputChunk;
    try {
      chunk = terminalEventChunk(event);
    } catch {
      return false;
    }
    if (chunk.bytes.length === 0) return true;
    if (this.hydrating) {
      this.queueHydrationChunk(event.sessionId, chunk);
    } else {
      this.deliver(event.sessionId, chunk);
    }
    return true;
  }

  completeHydration(snapshots: readonly RemoteTerminalSnapshot[]): void {
    if (!this.hydrating) return;
    this.hydrating = false;
    const validSnapshots = new Map<string, RemoteTerminalSnapshot>();
    for (const snapshot of snapshots) {
      if (this.closedSessions.has(snapshot.sessionId)) continue;
      try {
        terminalSnapshotChunk(snapshot);
        validSnapshots.set(snapshot.sessionId, snapshot);
      } catch {
        // A malformed snapshot must not discard independently valid live data.
      }
    }

    const sessionIds = new Set([
      ...validSnapshots.keys(),
      ...this.hydrationEvents.keys(),
    ]);
    for (const sessionId of sessionIds) {
      if (this.closedSessions.has(sessionId)) continue;
      const snapshot = validSnapshots.get(sessionId);
      if (snapshot) this.replaySnapshot(snapshot);
      else this.rebuildHistory(sessionId, this.takeHydrationEvents(sessionId));
    }
    this.hydrationEvents.clear();
    this.hydrationBytes.clear();
  }

  /**
   * Rebuilds the bounded history from a point-in-time snapshot and any live
   * chunks that raced ahead of it. Existing offsets are retained so a snapshot
   * older than the live cursor can still fill the missing prefix for remounts.
   */
  replaySnapshot(snapshot: RemoteTerminalSnapshot): boolean {
    if (this.closedSessions.has(snapshot.sessionId)) return false;
    let snapshotChunk: RemoteTerminalOutputChunk;
    try {
      snapshotChunk = terminalSnapshotChunk(snapshot);
    } catch {
      return false;
    }
    this.rebuildHistory(snapshot.sessionId, [
      ...this.takeHydrationEvents(snapshot.sessionId),
      snapshotChunk,
    ]);
    return true;
  }

  open(sessionId: string): void {
    this.closedSessions.delete(sessionId);
  }

  close(sessionId: string): void {
    this.closedSessions.add(sessionId);
    while (
      this.closedSessions.size > MAX_REMOTE_TERMINAL_CLOSED_TOMBSTONES
    ) {
      const oldest = this.closedSessions.values().next().value as
        | string
        | undefined;
      if (oldest === undefined) break;
      this.closedSessions.delete(oldest);
    }
    this.streams.delete(sessionId);
    this.hydrationEvents.delete(sessionId);
    this.hydrationBytes.delete(sessionId);
  }

  onData(
    sessionId: string,
    handler: (bytes: Uint8Array) => void,
  ): () => void {
    const stream = this.stream(sessionId);
    for (const chunk of stream.history) handler(chunk.bytes);
    stream.handlers.add(handler);
    return () => {
      stream.handlers.delete(handler);
    };
  }

  private stream(sessionId: string): RemoteTerminalStreamState {
    const existing = this.streams.get(sessionId);
    if (existing) return existing;
    const stream: RemoteTerminalStreamState = {
      handlers: new Set(),
      history: [],
      historyBytes: 0,
      cursor: null,
    };
    this.streams.set(sessionId, stream);
    return stream;
  }

  private queueHydrationChunk(
    sessionId: string,
    chunk: RemoteTerminalOutputChunk,
  ): void {
    const chunks = this.hydrationEvents.get(sessionId) ?? [];
    let total = this.hydrationBytes.get(sessionId) ?? 0;
    const retained = chunk.bytes.slice();
    chunks.push({ offset: chunk.offset, bytes: retained });
    total += retained.length;
    while (chunks.length > this.maxPendingChunks) {
      total -= chunks.shift()?.bytes.length ?? 0;
    }
    while (total > this.maxPendingBytes && chunks.length > 0) {
      const overflow = total - this.maxPendingBytes;
      const first = chunks[0];
      if (first.bytes.length <= overflow) {
        chunks.shift();
        total -= first.bytes.length;
      } else {
        chunks[0] = {
          offset: first.offset + overflow,
          bytes: first.bytes.slice(overflow),
        };
        total -= overflow;
      }
    }
    this.hydrationEvents.set(sessionId, chunks);
    this.hydrationBytes.set(sessionId, total);
  }

  private takeHydrationEvents(
    sessionId: string,
  ): RemoteTerminalOutputChunk[] {
    const chunks = this.hydrationEvents.get(sessionId) ?? [];
    this.hydrationEvents.delete(sessionId);
    this.hydrationBytes.delete(sessionId);
    return chunks;
  }

  private rebuildHistory(
    sessionId: string,
    chunks: readonly RemoteTerminalOutputChunk[],
  ): void {
    if (chunks.length === 0 || this.closedSessions.has(sessionId)) return;
    const stream = this.stream(sessionId);
    const replay = reconcileRemoteTerminalChunks([
      ...stream.history,
      ...chunks,
    ]);
    const previousCursor = stream.cursor;
    stream.history = [];
    stream.historyBytes = 0;
    stream.cursor = null;
    for (const chunk of replay) {
      stream.cursor = chunk.offset + chunk.bytes.length;
      this.appendHistory(stream, chunk);
    }

    if (stream.handlers.size === 0) return;
    for (const chunk of replay) {
      const endOffset = chunk.offset + chunk.bytes.length;
      if (previousCursor !== null && endOffset <= previousCursor) continue;
      const freshOffset =
        previousCursor === null
          ? chunk.offset
          : Math.max(previousCursor, chunk.offset);
      const fresh = chunk.bytes.subarray(freshOffset - chunk.offset);
      if (fresh.length === 0) continue;
      for (const handler of stream.handlers) handler(fresh);
    }
  }

  private deliver(
    sessionId: string,
    chunk: RemoteTerminalOutputChunk,
  ): void {
    if (this.closedSessions.has(sessionId)) return;
    const stream = this.stream(sessionId);
    const endOffset = chunk.offset + chunk.bytes.length;
    const cursor = stream.cursor ?? chunk.offset;
    if (endOffset <= cursor) return;
    const fresh = chunk.bytes.subarray(Math.max(0, cursor - chunk.offset));
    if (fresh.length === 0) return;
    stream.cursor = endOffset;
    const freshOffset = endOffset - fresh.length;
    this.appendHistory(stream, { offset: freshOffset, bytes: fresh });
    for (const handler of stream.handlers) handler(fresh);
  }

  private appendHistory(
    stream: RemoteTerminalStreamState,
    chunk: RemoteTerminalOutputChunk,
  ): void {
    const retained = chunk.bytes.slice();
    stream.history.push({ offset: chunk.offset, bytes: retained });
    stream.historyBytes += retained.length;
    while (stream.history.length > this.maxPendingChunks) {
      stream.historyBytes -= stream.history.shift()?.bytes.length ?? 0;
    }
    while (
      stream.historyBytes > this.maxPendingBytes &&
      stream.history.length > 0
    ) {
      const overflow = stream.historyBytes - this.maxPendingBytes;
      const first = stream.history[0];
      if (first.bytes.length <= overflow) {
        stream.history.shift();
        stream.historyBytes -= first.bytes.length;
      } else {
        stream.history[0] = {
          offset: first.offset + overflow,
          bytes: first.bytes.slice(overflow),
        };
        stream.historyBytes -= overflow;
      }
    }
  }
}

export function settleRemoteConnectOutcome(
  outcome: RemoteConnectOutcome,
  closed: ReadonlyMap<string, string>,
): RemoteConnectOutcome {
  if (outcome.outcome !== "connected" || !closed.has(outcome.sessionId)) {
    return outcome;
  }
  const reason = closed.get(outcome.sessionId) || "Connection closed";
  return {
    outcome: "failed",
    stage: "startup",
    detail: `${outcome.agentName} closed during startup: ${reason}`,
  };
}

export function encodeRemoteFilePayload(bytes: Uint8Array): string {
  let binary = "";
  const slice = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += slice) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + slice));
  }
  return btoa(binary);
}

export function reconcileRemoteFileTransfer(
  current: RemoteFileTransfer | undefined,
  candidate: RemoteFileTransfer,
): RemoteFileTransfer {
  if (!current) return candidate;
  const currentEnded = current.state !== "running";
  const candidateEnded = candidate.state !== "running";
  if (currentEnded !== candidateEnded) return currentEnded ? current : candidate;
  if (!currentEnded && candidate.bytesDone < current.bytesDone) return current;
  return candidate;
}

export async function streamRemoteFileUpload(
  file: Pick<File, "stream">,
  sessionId: string,
  transferId: string,
  invoke: RemoteInvoke,
): Promise<void> {
  const reader = file.stream().getReader();
  let pending = new Uint8Array(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        const merged = new Uint8Array(pending.length + value.length);
        merged.set(pending);
        merged.set(value, pending.length);
        pending = merged;
      }
      while (pending.length >= REMOTE_UPLOAD_CHUNK_BYTES) {
        await invoke("remote_file_upload_chunk", {
          sessionId,
          transferId,
          data: encodeRemoteFilePayload(
            pending.subarray(0, REMOTE_UPLOAD_CHUNK_BYTES),
          ),
        });
        pending = pending.slice(REMOTE_UPLOAD_CHUNK_BYTES);
      }
    }
    if (pending.length > 0) {
      await invoke("remote_file_upload_chunk", {
        sessionId,
        transferId,
        data: encodeRemoteFilePayload(pending),
      });
    }
    await invoke("remote_file_upload_finish", { sessionId, transferId });
  } catch (reason) {
    try {
      await reader.cancel(reason);
    } catch {
      // The backend cancellation below owns authoritative remote cleanup.
    }
    try {
      await invoke("remote_file_transfer_cancel", { sessionId, transferId });
    } catch {
      // Preserve the original local read or transport error.
    }
    throw reason;
  } finally {
    reader.releaseLock();
  }
}

async function core() {
  return import("@tauri-apps/api/core");
}

export function useRemoteSessions(): RemoteApi {
  const [sessions, setSessions] = useState<RemoteSessionSummary[]>([]);
  const [transfers, setTransfers] = useState<
    Record<string, RemoteFileTransfer>
  >({});
  const [lastClosed, setLastClosed] = useState<SessionClosedNotice | null>(null);
  const sessionsRef = useRef(sessions);
  const intentionalDisconnects = useRef(new Set<string>());
  const terminalOutput = useRef<RemoteTerminalOutputRouter | null>(null);
  const connectRaceGuard = useRef(new SessionConnectRaceGuard());
  const eventReadiness = useRef(new SessionEventReadinessGate());
  if (!terminalOutput.current) {
    terminalOutput.current = new RemoteTerminalOutputRouter();
  }
  sessionsRef.current = sessions;

  useEffect(() => {
    const readinessAttempt = eventReadiness.current.begin();
    const disposers: Array<() => void> = [];
    let cancelled = false;
    let hydrating = true;
    let listenersReady = false;
    const closedDuringHydration = new Set<string>();
    const pendingFrames = new Map<string, RemoteFrame>();

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
          "remote://closed",
          (event) => {
            const sessionId = event.payload.sessionId;
            if (hydrating) closedDuringHydration.add(sessionId);
            connectRaceGuard.current.observeClosed(
              sessionId,
              event.payload.reason,
            );
            terminalOutput.current?.close(sessionId);
            pendingFrames.delete(sessionId);
            const intentional = intentionalDisconnects.current.delete(sessionId);
            if (!intentional) {
              const session = sessionsRef.current.find(
                (current) => current.sessionId === sessionId,
              );
              setLastClosed({
                sessionId,
                label: session?.agentName ?? sessionId,
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

        const stopTerminalData = await listen<RemoteTerminalDataEvent>(
          "remote://terminal-data",
          (event) => {
            terminalOutput.current?.observe(event.payload);
          },
        );
        if (!keep(stopTerminalData)) {
          readinessAttempt.fail();
          return;
        }

        const stopFrames = await listen<FrameEvent>("remote://frame", (event) => {
          const frame: RemoteFrame = {
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

        const stopTransfers = await listen<RemoteFileTransfer>(
          "remote://file-transfer",
          (event) => {
            setTransfers((current) => ({
              ...current,
              [event.payload.transferId]: reconcileRemoteFileTransfer(
                current[event.payload.transferId],
                event.payload,
              ),
            }));
          },
        );
        if (!keep(stopTransfers)) {
          readinessAttempt.fail();
          return;
        }

        readinessAttempt.ready();
        listenersReady = true;

        const [existing, existingTransfers, terminalSnapshots] =
          await Promise.all([
            invoke<Array<Omit<RemoteSessionSummary, "frame">>>(
              "remote_sessions",
            ),
            invoke<RemoteFileTransfer[]>("remote_file_transfers"),
            invoke<RemoteTerminalSnapshot[]>("remote_terminal_snapshots"),
          ]);
        if (!cancelled) {
          terminalOutput.current?.completeHydration(terminalSnapshots);
          const restored = existing.map<RemoteSessionSummary>((session) => {
            const frame = pendingFrames.get(session.sessionId) ?? null;
            return frame
              ? { ...session, width: frame.width, height: frame.height, frame }
              : { ...session, frame: null };
          });
          const closedSnapshot = snapshotSessionIds(closedDuringHydration);
          setSessions((current) =>
            reconcileSessionSnapshot(current, restored, closedSnapshot),
          );
          setTransfers((current) => {
            const next = { ...current };
            for (const transfer of existingTransfers) {
              next[transfer.transferId] = reconcileRemoteFileTransfer(
                next[transfer.transferId],
                transfer,
              );
            }
            return next;
          });
          hydrating = false;
          closedDuringHydration.clear();
          pendingFrames.clear();
        }
      } catch {
        if (!listenersReady) readinessAttempt.fail();
        if (!cancelled) terminalOutput.current?.completeHydration([]);
        hydrating = false;
        closedDuringHydration.clear();
        pendingFrames.clear();
        // Browser preview has no Tauri event source and intentionally stays empty.
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
    async (request: RemoteConnectRequest): Promise<RemoteConnectOutcome> => {
      if (!(await eventReadiness.current.wait())) {
        return {
          outcome: "failed",
          stage: "events",
          detail: "Lattice Remote event listeners are unavailable.",
        };
      }
      const attempt = connectRaceGuard.current.begin();
      try {
        const { invoke } = await core();
        const outcome = await invoke<RemoteConnectOutcome>("remote_connect", {
          request,
        });
        let startupSnapshot: RemoteTerminalSnapshot | null = null;
        if (outcome.outcome === "connected" && outcome.terminal) {
          try {
            const snapshots = await invoke<RemoteTerminalSnapshot[]>(
              "remote_terminal_snapshots",
            );
            startupSnapshot =
              snapshots.find(
                (snapshot) => snapshot.sessionId === outcome.sessionId,
              ) ?? null;
          } catch {
            // The live event stream remains usable when replay is unavailable.
          }
        }
        const closed = attempt.finish();
        const settled = settleRemoteConnectOutcome(outcome, closed);
        if (settled.outcome === "connected") {
          terminalOutput.current?.open(settled.sessionId);
          if (startupSnapshot) {
            terminalOutput.current?.replaySnapshot(startupSnapshot);
          }
          const { outcome: _outcome, ...summary } = settled;
          setSessions((current) => [
            ...current.filter(
              (session) => session.sessionId !== summary.sessionId,
            ),
            { ...summary, frame: null },
          ]);
        } else if (
          outcome.outcome === "connected" &&
          closed.has(outcome.sessionId)
        ) {
          setLastClosed((current) =>
            current?.sessionId === outcome.sessionId
              ? {
                  ...current,
                  label: outcome.agentName,
                  reason:
                    closed.get(outcome.sessionId) || "Connection closed",
                }
              : current,
          );
        }
        return settled;
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

  const disconnect = useCallback(async (sessionId: string) => {
    intentionalDisconnects.current.add(sessionId);
    try {
      const { invoke } = await core();
      await invoke("remote_disconnect", { sessionId });
    } catch (reason) {
      intentionalDisconnects.current.delete(sessionId);
      throw reason;
    } finally {
      terminalOutput.current?.close(sessionId);
      setSessions((current) =>
        current.filter((session) => session.sessionId !== sessionId),
      );
    }
  }, []);

  const input = useCallback(
    async (sessionId: string, request: RemoteInput) => {
      const { invoke } = await core();
      await invoke("remote_input", { sessionId, request });
    },
    [],
  );

  const terminalInput = useCallback(async (sessionId: string, data: string) => {
    const { invoke } = await core();
    await invoke("remote_terminal_input", { sessionId, data });
  }, []);

  const terminalResize = useCallback(
    async (sessionId: string, cols: number, rows: number) => {
      const { invoke } = await core();
      await invoke("remote_terminal_resize", { sessionId, cols, rows });
    },
    [],
  );

  const onTerminalData = useCallback(
    (sessionId: string, handler: (bytes: Uint8Array) => void) => {
      const router = terminalOutput.current;
      return router ? router.onData(sessionId, handler) : () => {};
    },
    [],
  );

  const listFiles = useCallback(async (sessionId: string, path: string) => {
    const { invoke } = await core();
    return invoke<RemoteDirectory>("remote_file_list", { sessionId, path });
  }, []);

  const downloadFile = useCallback(async (sessionId: string, path: string) => {
    const { invoke } = await core();
    const transfer = await invoke<RemoteFileTransfer>(
      "remote_file_download_start",
      { sessionId, path },
    );
    setTransfers((current) => ({
      ...current,
      [transfer.transferId]: reconcileRemoteFileTransfer(
        current[transfer.transferId],
        transfer,
      ),
    }));
    return transfer;
  }, []);

  const uploadFile = useCallback(
    async (
      sessionId: string,
      parent: string,
      file: File,
      overwrite: boolean,
      onStarted?: (transfer: RemoteFileTransfer) => void,
    ) => {
      const { invoke } = await core();
      const transfer = await invoke<RemoteFileTransfer>(
        "remote_file_upload_begin",
        {
          sessionId,
          parent,
          name: file.name,
          size: file.size,
          overwrite,
        },
      );
      setTransfers((current) => ({
        ...current,
        [transfer.transferId]: reconcileRemoteFileTransfer(
          current[transfer.transferId],
          transfer,
        ),
      }));
      onStarted?.(transfer);
      await streamRemoteFileUpload(
        file,
        sessionId,
        transfer.transferId,
        invoke as RemoteInvoke,
      );
    },
    [],
  );

  const cancelFileTransfer = useCallback(
    async (sessionId: string, transferId: string) => {
      const { invoke } = await core();
      await invoke("remote_file_transfer_cancel", { sessionId, transferId });
    },
    [],
  );

  const dismissFileTransfer = useCallback(
    async (sessionId: string, transferId: string) => {
      const { invoke } = await core();
      await invoke("remote_file_transfer_dismiss", { sessionId, transferId });
      setTransfers((current) => {
        const next = { ...current };
        delete next[transferId];
        return next;
      });
    },
    [],
  );

  const clearLastClosed = useCallback(() => setLastClosed(null), []);

  const readTextFile = useCallback(async (sessionId: string, path: string) => {
    const { invoke } = await core();
    return invoke<RemoteTextDocument>("remote_file_read_text", { sessionId, path });
  }, []);

  const saveTextFile = useCallback(async (sessionId: string, path: string, content: string, revision: string) => {
    const { invoke } = await core();
    return invoke<RemoteTextDocument>("remote_file_save_text", { sessionId, path, content, revision });
  }, []);

  return {
    sessions,
    transfers,
    lastClosed,
    connect,
    disconnect,
    input,
    terminalInput,
    terminalResize,
    onTerminalData,
    listFiles,
    readTextFile,
    saveTextFile,
    downloadFile,
    uploadFile,
    cancelFileTransfer,
    dismissFileTransfer,
    clearLastClosed,
  };
}
