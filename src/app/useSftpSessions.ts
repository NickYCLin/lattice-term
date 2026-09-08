import { useCallback, useEffect, useRef, useState } from "react";
import type { HostKeyRecord } from "../domain/security";
import type { RemoteTextDocument } from "../domain/remoteText";
import { reconcileSessionSnapshot } from "./sessionSnapshot";

export const SFTP_MAX_TRANSFER_BYTES = 32 * 1024 * 1024;

export interface SftpSessionSummary {
  sessionId: string;
  profileId: string;
  host: string;
  port: number;
  username: string;
  currentPath: string;
}

export interface SftpEntry {
  name: string;
  path: string;
  kind: "directory" | "file" | "symlink" | "other";
  size: number;
  modifiedAt: number | null;
  permissions: string;
}

export interface SftpDirectory {
  path: string;
  entries: SftpEntry[];
}

/** One queued transfer, as reported by the streaming engine. */
export interface SftpTransfer {
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

/** Upload chunk size: large enough to move fast, bounded enough for memory. */
const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;

export interface SftpConnectRequest {
  profileId: string;
  hostname: string;
  port: number;
  username: string;
  auth: { kind: "password"; password: string };
  useSavedPassword: boolean;
  rememberPassword: boolean;
}

export type SftpConnectOutcome =
  | { outcome: "connected"; session: SftpSessionSummary }
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

async function core() {
  return import("@tauri-apps/api/core");
}

export function encodeSftpPayload(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function decodeSftpPayload(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

type SftpInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

const MAX_RECENTLY_REMOVED_IDS = 1_024;

function rememberRemovedId(ids: Set<string>, id: string) {
  ids.add(id);
  if (ids.size <= MAX_RECENTLY_REMOVED_IDS) return;
  const oldest = ids.values().next().value;
  if (oldest !== undefined) ids.delete(oldest);
}

/**
 * Snapshot reconciliation for the transfer queue. Event state wins over an
 * older snapshot, while acknowledged dismissals act as bounded tombstones so
 * neither a snapshot nor a delayed progress event can bring a row back.
 */
export function reconcileSftpTransferSnapshot(
  current: Record<string, SftpTransfer>,
  snapshot: SftpTransfer[],
  dismissedTransferIds: ReadonlySet<string> = new Set(),
): Record<string, SftpTransfer> {
  const reconciled: Record<string, SftpTransfer> = {};
  for (const transfer of snapshot) {
    if (!dismissedTransferIds.has(transfer.transferId)) {
      reconciled[transfer.transferId] = reconcileSftpTransferUpdate(
        reconciled[transfer.transferId],
        transfer,
      );
    }
  }
  for (const transfer of Object.values(current)) {
    if (!dismissedTransferIds.has(transfer.transferId)) {
      reconciled[transfer.transferId] = reconcileSftpTransferUpdate(
        reconciled[transfer.transferId],
        transfer,
      );
    }
  }
  return reconciled;
}

/**
 * Merges one asynchronous transfer update without letting a late initial
 * response rewind a newer progress event or revive a completed transfer.
 */
export function reconcileSftpTransferUpdate(
  current: SftpTransfer | undefined,
  candidate: SftpTransfer,
): SftpTransfer {
  if (!current) return candidate;

  const currentEnded = current.state !== "running";
  const candidateEnded = candidate.state !== "running";
  if (currentEnded !== candidateEnded) {
    return currentEnded ? current : candidate;
  }
  if (!currentEnded && candidate.bytesDone < current.bytesDone) {
    return current;
  }
  return candidate;
}

/** Calls the backend first; the interface only removes an acknowledged row. */
export async function dismissSftpTransfer(
  transferId: string,
  invoke: SftpInvoke,
  onDismissed: (transferId: string) => void,
): Promise<void> {
  await invoke("sftp_transfer_dismiss", { transferId });
  onDismissed(transferId);
}

/**
 * Feeds one browser file stream into an already-created backend transfer.
 * Any local read or IPC failure explicitly cancels the backend transfer so a
 * remote staging file cannot keep running after the WebView has stopped.
 */
export async function streamSftpUpload(
  file: Pick<File, "stream">,
  transferId: string,
  invoke: SftpInvoke,
): Promise<void> {
  const reader = file.stream().getReader();
  let pending = new Uint8Array(0);

  async function sendChunk(bytes: Uint8Array) {
    await invoke("sftp_upload_chunk", {
      transferId,
      data: encodeSftpPayload(bytes),
    });
  }

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
      while (pending.length >= UPLOAD_CHUNK_BYTES) {
        await sendChunk(pending.subarray(0, UPLOAD_CHUNK_BYTES));
        pending = pending.slice(UPLOAD_CHUNK_BYTES);
      }
    }
    if (pending.length > 0) {
      await sendChunk(pending);
    }
    await invoke("sftp_upload_finish", { transferId });
  } catch (reason) {
    try {
      await reader.cancel(reason);
    } catch {
      // The backend cancellation below is the authoritative cleanup path.
    }

    let cleanupProblem: unknown = null;
    try {
      await invoke("sftp_transfer_cancel", { transferId });
    } catch (cleanupReason) {
      cleanupProblem = cleanupReason;
    }

    const message = reason instanceof Error ? reason.message : String(reason);
    if (message.trim().toLowerCase() === "cancelled" && cleanupProblem === null) {
      return;
    }
    if (cleanupProblem !== null) {
      const cleanupMessage =
        cleanupProblem instanceof Error
          ? cleanupProblem.message
          : String(cleanupProblem);
      throw new Error(`${message}; transfer cleanup failed: ${cleanupMessage}`);
    }
    throw reason;
  } finally {
    reader.releaseLock();
  }
}

export interface SftpApi {
  sessions: SftpSessionSummary[];
  connect: (request: SftpConnectRequest) => Promise<SftpConnectOutcome>;
  /** Opens a browser on an existing SSH session — no second login. */
  attachToSsh: (sshSessionId: string) => Promise<SftpConnectOutcome>;
  disconnect: (sessionId: string) => Promise<void>;
  list: (sessionId: string, path: string) => Promise<SftpDirectory>;
  createDirectory: (
    sessionId: string,
    parent: string,
    name: string,
  ) => Promise<void>;
  rename: (sessionId: string, path: string, newName: string) => Promise<void>;
  remove: (
    sessionId: string,
    path: string,
    directory: boolean,
  ) => Promise<void>;
  readFile: (sessionId: string, path: string) => Promise<Uint8Array>;
  readTextFile: (sessionId: string, path: string) => Promise<RemoteTextDocument>;
  saveTextFile: (sessionId: string, path: string, content: string, revision: string, acknowledgeAccessChange?: boolean) => Promise<RemoteTextDocument>;
  writeFile: (
    sessionId: string,
    parent: string,
    file: File,
    overwrite: boolean,
  ) => Promise<void>;
  /** Live transfer queue, keyed by transfer id. */
  transfers: Record<string, SftpTransfer>;
  /** Streams a remote file into the OS download folder. */
  downloadToDisk: (sessionId: string, remotePath: string) => Promise<SftpTransfer>;
  /** Streams a local file to the remote side in bounded chunks. */
  uploadStream: (
    sessionId: string,
    parent: string,
    file: File,
    overwrite: boolean,
  ) => Promise<void>;
  /** Streams a dropped local file (by OS path) to the remote side. */
  uploadPath: (
    sessionId: string,
    parent: string,
    localPath: string,
    overwrite: boolean,
  ) => Promise<SftpTransfer>;
  cancelTransfer: (transferId: string) => Promise<void>;
  dismissTransfer: (transferId: string) => Promise<void>;
  trustHost: (
    host: string,
    port: number,
    algorithm: string,
    fingerprint: string,
  ) => Promise<HostKeyRecord>;
}

export function useSftpSessions(): SftpApi {
  const [sessions, setSessions] = useState<SftpSessionSummary[]>([]);
  const [transfers, setTransfers] = useState<Record<string, SftpTransfer>>({});
  const disconnectedSessionIds = useRef(new Set<string>());
  const dismissedTransferIds = useRef(new Set<string>());

  // One listener carries every transfer's progress; a snapshot fetch fills in
  // whatever moved before this view mounted.
  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | null = null;

    void (async () => {
      try {
        const [{ invoke }, { listen }] = await Promise.all([
          core(),
          import("@tauri-apps/api/event"),
        ]);

        // Listen first so a progress event that races with the snapshots wins.
        const unlisten = await listen<SftpTransfer>("sftp://transfer", (event) => {
          if (dismissedTransferIds.current.has(event.payload.transferId)) return;
          setTransfers((current) => ({
            ...current,
            [event.payload.transferId]: reconcileSftpTransferUpdate(
              current[event.payload.transferId],
              event.payload,
            ),
          }));
        });
        if (cancelled) {
          unlisten();
          return;
        }
        stop = unlisten;

        const [existingTransfers, existingSessions] = await Promise.all([
          invoke<SftpTransfer[]>("sftp_transfers"),
          invoke<SftpSessionSummary[]>("sftp_sessions"),
        ]);
        if (!cancelled) {
          setTransfers((current) =>
            reconcileSftpTransferSnapshot(
              current,
              existingTransfers,
              dismissedTransferIds.current,
            ),
          );
          setSessions((current) =>
            reconcileSessionSnapshot(
              current,
              existingSessions,
              disconnectedSessionIds.current,
            ),
          );
        }
      } catch {
        // Outside the desktop shell there are no transfers to watch.
      }
    })();

    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  const connect = useCallback(
    async (request: SftpConnectRequest): Promise<SftpConnectOutcome> => {
      try {
        const { invoke } = await core();
        const outcome = await invoke<SftpConnectOutcome>("sftp_connect", {
          request,
        });
        if (outcome.outcome === "connected") {
          setSessions((current) => [...current, outcome.session]);
        }
        return outcome;
      } catch (reason) {
        return {
          outcome: "failed",
          stage: "invoke",
          detail: reason instanceof Error ? reason.message : String(reason),
        };
      }
    },
    [],
  );

  const attachToSsh = useCallback(
    async (sshSessionId: string): Promise<SftpConnectOutcome> => {
      try {
        const { invoke } = await core();
        const outcome = await invoke<SftpConnectOutcome>("sftp_attach_ssh", {
          sshSessionId,
        });
        if (outcome.outcome === "connected") {
          setSessions((current) => [...current, outcome.session]);
        }
        return outcome;
      } catch (reason) {
        return {
          outcome: "failed",
          stage: "invoke",
          detail: reason instanceof Error ? reason.message : String(reason),
        };
      }
    },
    [],
  );

  const disconnect = useCallback(async (sessionId: string) => {
    try {
      const { invoke } = await core();
      await invoke("sftp_disconnect", { sessionId });
    } finally {
      rememberRemovedId(disconnectedSessionIds.current, sessionId);
      setSessions((current) =>
        current.filter((session) => session.sessionId !== sessionId),
      );
    }
  }, []);

  const list = useCallback(async (sessionId: string, path: string) => {
    const { invoke } = await core();
    return invoke<SftpDirectory>("sftp_list", { sessionId, path });
  }, []);

  const createDirectory = useCallback(
    async (sessionId: string, parent: string, name: string) => {
      const { invoke } = await core();
      await invoke("sftp_create_directory", { sessionId, parent, name });
    },
    [],
  );

  const rename = useCallback(
    async (sessionId: string, path: string, newName: string) => {
      const { invoke } = await core();
      await invoke("sftp_rename", { sessionId, path, newName });
    },
    [],
  );

  const remove = useCallback(
    async (sessionId: string, path: string, directory: boolean) => {
      const { invoke } = await core();
      await invoke("sftp_remove", { sessionId, path, directory });
    },
    [],
  );

  const readFile = useCallback(async (sessionId: string, path: string) => {
    const { invoke } = await core();
    return decodeSftpPayload(
      await invoke<string>("sftp_read_file", { sessionId, path }),
    );
  }, []);

  const readTextFile = useCallback(async (sessionId: string, path: string) => {
    const { invoke } = await core();
    return invoke<RemoteTextDocument>("sftp_read_text_file", { sessionId, path });
  }, []);

  const saveTextFile = useCallback(async (sessionId: string, path: string, content: string, revision: string, acknowledgeAccessChange = false) => {
    const { invoke } = await core();
    return invoke<RemoteTextDocument>("sftp_save_text_file", { sessionId, path, content, revision, acknowledgeAccessChange });
  }, []);

  const writeFile = useCallback(
    async (
      sessionId: string,
      parent: string,
      file: File,
      overwrite: boolean,
    ) => {
      if (file.size > SFTP_MAX_TRANSFER_BYTES) {
        throw new Error(
          `Files larger than ${SFTP_MAX_TRANSFER_BYTES / 1024 / 1024} MiB are not supported.`,
        );
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { invoke } = await core();
      await invoke("sftp_write_file", {
        sessionId,
        parent,
        name: file.name,
        data: encodeSftpPayload(bytes),
        overwrite,
      });
    },
    [],
  );

  const downloadToDisk = useCallback(
    async (sessionId: string, remotePath: string) => {
      const { invoke } = await core();
      const transfer = await invoke<SftpTransfer>("sftp_download_start", {
        sessionId,
        remotePath,
      });
      setTransfers((current) => ({
        ...current,
        [transfer.transferId]: reconcileSftpTransferUpdate(
          current[transfer.transferId],
          transfer,
        ),
      }));
      return transfer;
    },
    [],
  );

  const uploadStream = useCallback(
    async (
      sessionId: string,
      parent: string,
      file: File,
      overwrite: boolean,
    ) => {
      const { invoke } = await core();
      const transfer = await invoke<SftpTransfer>("sftp_upload_begin", {
        plan: {
          sessionId,
          parent,
          name: file.name,
          totalBytes: file.size,
          overwrite,
        },
      });
      setTransfers((current) => ({
        ...current,
        [transfer.transferId]: reconcileSftpTransferUpdate(
          current[transfer.transferId],
          transfer,
        ),
      }));
      await streamSftpUpload(file, transfer.transferId, invoke);
    },
    [],
  );

  const uploadPath = useCallback(
    async (
      sessionId: string,
      parent: string,
      localPath: string,
      overwrite: boolean,
    ) => {
      const { invoke } = await core();
      const transfer = await invoke<SftpTransfer>("sftp_upload_path", {
        sessionId,
        parent,
        localPath,
        overwrite,
      });
      setTransfers((current) => ({
        ...current,
        [transfer.transferId]: reconcileSftpTransferUpdate(
          current[transfer.transferId],
          transfer,
        ),
      }));
      return transfer;
    },
    [],
  );

  const cancelTransfer = useCallback(async (transferId: string) => {
    const { invoke } = await core();
    await invoke("sftp_transfer_cancel", { transferId });
  }, []);

  const dismissTransfer = useCallback(async (transferId: string) => {
    const { invoke } = await core();
    await dismissSftpTransfer(transferId, invoke, (dismissedId) => {
      rememberRemovedId(dismissedTransferIds.current, dismissedId);
      setTransfers((current) => {
        const next = { ...current };
        delete next[dismissedId];
        return next;
      });
    });
  }, []);

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

  return {
    sessions,
    connect,
    attachToSsh,
    disconnect,
    list,
    createDirectory,
    rename,
    remove,
    readFile,
    readTextFile,
    saveTextFile,
    writeFile,
    transfers,
    downloadToDisk,
    uploadStream,
    uploadPath,
    cancelTransfer,
    dismissTransfer,
    trustHost,
  };
}
