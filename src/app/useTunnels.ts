/**
 * SSH Tunnels management hook.
 *
 * Persists user tunnel configurations, provides CRUD operations, and manages
 * live tunnel runtime execution (start/stop/stats) via Tauri IPC.
 *
 * The backend reports failures with a stable `code:detail` prefix
 * (`credential:`, `trust:`, `auth:`, `bind:`, `connect:`, `forward:`); the
 * view maps the code to a translated message and keeps the detail for context.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createTunnelFromDraft,
  validateTunnelDraft,
  type TunnelConfig,
  type TunnelDraft,
  type TunnelStats,
  type TunnelStatus,
  type TunnelValidationError,
} from "../domain/tunnel";
import type { ConnectionProfile } from "../domain/connection";
import { DESKTOP_BACKEND_UNAVAILABLE } from "./nativeRuntime";
import { readTunnelStore, TUNNELS_STORAGE_KEY } from "./tunnelPersistence";

export interface LiveTunnelState extends TunnelStats {
  status: TunnelStatus;
}

export interface TunnelActionResult {
  success: boolean;
  error?: string;
}

type TunnelCommandInvoker = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

export function tunnelRequiresStopBeforeDelete(
  status: TunnelStatus | undefined,
): boolean {
  return status === "active" || status === "starting";
}

export function tunnelStopFailure(reason: unknown): TunnelActionResult {
  const detail = reason instanceof Error ? reason.message : String(reason);
  return { success: false, error: "stop:" + detail };
}

export function tunnelStateAfterStopFailure(
  current: LiveTunnelState | undefined,
  error: string,
): LiveTunnelState {
  return {
    status: current?.status ?? "error",
    bytesUploaded: current?.bytesUploaded ?? 0,
    bytesDownloaded: current?.bytesDownloaded ?? 0,
    activeConnections: current?.activeConnections ?? 0,
    startedAt: current?.startedAt,
    lastError: error,
  };
}

export async function requestTunnelStop(
  id: string,
  invoke: TunnelCommandInvoker,
): Promise<TunnelActionResult> {
  try {
    await invoke("tunnel_stop", { tunnelId: id });
    return { success: true };
  } catch (reason) {
    return tunnelStopFailure(reason);
  }
}

export interface UseTunnelsResult {
  storageError: boolean;
  tunnels: TunnelConfig[];
  states: Record<string, LiveTunnelState>;
  addTunnel: (draft: TunnelDraft) => { success: boolean; errors?: TunnelValidationError[]; tunnel?: TunnelConfig };
  updateTunnel: (id: string, draft: TunnelDraft) => { success: boolean; errors?: TunnelValidationError[]; tunnel?: TunnelConfig };
  deleteTunnel: (id: string) => Promise<TunnelActionResult>;
  duplicateTunnel: (id: string) => void;
  startTunnel: (id: string) => Promise<{ success: boolean; error?: string }>;
  stopTunnel: (id: string) => Promise<TunnelActionResult>;
  startAll: () => Promise<void>;
  stopAll: () => Promise<void>;
}

export function useTunnels(
  profiles: ConnectionProfile[],
  onActivity: ((type: string, detail: string) => void) | undefined,
  backendAvailable: boolean,
): UseTunnelsResult {
  const [initialStore] = useState(readTunnelStore);
  const { storageError } = initialStore;
  const [tunnels, setTunnels] = useState<TunnelConfig[]>(initialStore.tunnels);

  const [states, setStates] = useState<Record<string, LiveTunnelState>>({});
  const autoStartAttempted = useRef(new Set<string>());

  // Persist to storage
  useEffect(() => {
    if (storageError) return;
    try {
      localStorage.setItem(TUNNELS_STORAGE_KEY, JSON.stringify(tunnels));
    } catch {
      // Ignore
    }
  }, [storageError, tunnels]);

  // Poll live status from the backend. Only fields the backend owns are
  // overwritten, so an error recorded at start time survives until the next
  // successful start of that tunnel.
  useEffect(() => {
    if (!backendAvailable) return;

    let cancelled = false;

    async function poll() {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const list = await invoke<
          {
            tunnel_id: string;
            status: TunnelStatus;
            bytes_uploaded: number;
            bytes_downloaded: number;
            active_connections: number;
            started_at?: number;
            last_error?: string;
          }[]
        >("tunnel_list");

        if (!cancelled && Array.isArray(list)) {
          setStates((prev) => {
            const next = { ...prev };
            for (const item of list) {
              next[item.tunnel_id] = {
                status: item.status,
                bytesUploaded: item.bytes_uploaded,
                bytesDownloaded: item.bytes_downloaded,
                activeConnections: item.active_connections,
                startedAt: item.started_at ? item.started_at * 1000 : undefined,
                lastError: item.last_error ?? prev[item.tunnel_id]?.lastError,
              };
            }
            return next;
          });
        }
      } catch {
        // Outside Tauri desktop or IPC not ready
      }
    }

    const interval = setInterval(() => {
      void poll();
    }, 2000);

    void poll();

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [backendAvailable]);

  const addTunnel = useCallback(
    (draft: TunnelDraft) => {
      if (storageError) return { success: false };
      const errors = validateTunnelDraft(draft);
      if (errors.length > 0) {
        return { success: false, errors };
      }

      const created = createTunnelFromDraft(draft);
      setTunnels((prev) => [created, ...prev]);
      onActivity?.("tunnel_create", created.name);
      return { success: true, tunnel: created };
    },
    [onActivity, storageError],
  );

  const updateTunnel = useCallback(
    (id: string, draft: TunnelDraft) => {
      const errors = validateTunnelDraft(draft);
      if (errors.length > 0) {
        return { success: false, errors };
      }

      const existing = tunnels.find((t) => t.id === id);
      if (!existing) {
        return { success: false };
      }

      // Editing changes the settings, not the history: the original creation
      // time survives the update.
      const updated: TunnelConfig = {
        ...createTunnelFromDraft(draft, id),
        createdAt: existing.createdAt,
      };
      setTunnels((prev) => prev.map((t) => (t.id === id ? updated : t)));
      onActivity?.("tunnel_update", updated.name);
      return { success: true, tunnel: updated };
    },
    [tunnels, onActivity],
  );

  const duplicateTunnel = useCallback(
    (id: string) => {
      const target = tunnels.find((t) => t.id === id);
      if (!target) return;

      const duplicated: TunnelConfig = {
        ...target,
        id: `tunnel-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        name: `${target.name} (Copy)`,
        autoStart: false,
        localPort: target.localPort < 65535 ? target.localPort + 1 : target.localPort,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      setTunnels((prev) => [duplicated, ...prev]);
      onActivity?.("tunnel_duplicate", duplicated.name);
    },
    [tunnels, onActivity],
  );

  const markError = useCallback((id: string, error: string) => {
    setStates((prev) => ({
      ...prev,
      [id]: {
        status: "error",
        bytesUploaded: prev[id]?.bytesUploaded ?? 0,
        bytesDownloaded: prev[id]?.bytesDownloaded ?? 0,
        activeConnections: 0,
        lastError: error,
      },
    }));
  }, []);

  const markStopError = useCallback((id: string, error: string) => {
    setStates((prev) => ({
      ...prev,
      [id]: tunnelStateAfterStopFailure(prev[id], error),
    }));
  }, []);

  const startTunnel = useCallback(
    async (id: string): Promise<{ success: boolean; error?: string }> => {
      const target = tunnels.find((t) => t.id === id);
      if (!target) return { success: false, error: "connect:tunnel not found" };
      if (!backendAvailable) {
        markError(id, DESKTOP_BACKEND_UNAVAILABLE);
        return { success: false, error: DESKTOP_BACKEND_UNAVAILABLE };
      }

      const profile = profiles.find((p) => p.id === target.profileId);
      if (!profile || profile.protocol !== "ssh") {
        // Starting through a guessed gateway would silently forward through
        // the wrong machine; a missing profile is an error, not a default.
        const error = "profile:the SSH gateway profile is missing or is not an SSH profile";
        markError(id, error);
        return { success: false, error };
      }

      setStates((prev) => ({
        ...prev,
        [id]: {
          status: "starting",
          bytesUploaded: prev[id]?.bytesUploaded ?? 0,
          bytesDownloaded: prev[id]?.bytesDownloaded ?? 0,
          activeConnections: 0,
        },
      }));

      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("tunnel_start", {
          request: {
            tunnel_id: target.id,
            tunnel_type: target.type,
            profile_id: profile.id,
            local_host: target.localHost,
            local_port: target.localPort,
            remote_host: target.remoteHost,
            remote_port: target.remotePort,
          },
        });

        setStates((prev) => ({
          ...prev,
          [id]: {
            status: "active",
            bytesUploaded: 0,
            bytesDownloaded: 0,
            activeConnections: 0,
            startedAt: Date.now(),
          },
        }));
        onActivity?.("tunnel_start", target.name);
        return { success: true };
      } catch (raised) {
        // A tunnel that failed to start is a failure the user must see —
        // pretending it is active would leave them debugging a dead port.
        const error = typeof raised === "string" ? raised : String(raised);
        markError(id, error);
        onActivity?.("tunnel_error", `${target.name}: ${error}`);
        return { success: false, error };
      }
    },
    [tunnels, profiles, backendAvailable, onActivity, markError],
  );

  // Start opted-in tunnels once per application lifetime. Waiting until at
  // least one profile exists avoids consuming the attempt while profile state
  // is still being restored during startup.
  useEffect(() => {
    if (!backendAvailable || profiles.length === 0) return;
    for (const tunnel of tunnels) {
      if (!tunnel.autoStart || autoStartAttempted.current.has(tunnel.id)) continue;
      autoStartAttempted.current.add(tunnel.id);
      void startTunnel(tunnel.id);
    }
  }, [backendAvailable, profiles.length, startTunnel, tunnels]);

  const stopTunnel = useCallback(
    async (id: string): Promise<TunnelActionResult> => {
      const target = tunnels.find((t) => t.id === id);
      if (!target) {
        return tunnelStopFailure(new Error("tunnel not found"));
      }
      if (!backendAvailable) {
        const outcome = { success: false, error: DESKTOP_BACKEND_UNAVAILABLE };
        markStopError(id, DESKTOP_BACKEND_UNAVAILABLE);
        return outcome;
      }

      let outcome: TunnelActionResult;
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        outcome = await requestTunnelStop(id, (command, args) =>
          invoke(command, args),
        );
      } catch (reason) {
        outcome = tunnelStopFailure(reason);
      }

      if (!outcome.success) {
        const error = outcome.error ?? "stop:unknown error";
        markStopError(id, error);
        onActivity?.("tunnel_error", target.name + ": " + error);
        return outcome;
      }

      setStates((prev) => ({
        ...prev,
        [id]: {
          ...prev[id],
          status: "stopped",
          activeConnections: 0,
          lastError: undefined,
        },
      }));

      onActivity?.("tunnel_stop", target.name);
      return { success: true };
    },
    [backendAvailable, markStopError, tunnels, onActivity],
  );

  const deleteTunnel = useCallback(
    async (id: string): Promise<TunnelActionResult> => {
      const target = tunnels.find((t) => t.id === id);
      if (!target) {
        return { success: false, error: "delete:tunnel not found" };
      }

      if (tunnelRequiresStopBeforeDelete(states[id]?.status)) {
        const stopped = await stopTunnel(id);
        if (!stopped.success) return stopped;
      }

      setTunnels((prev) => prev.filter((t) => t.id !== id));
      setStates((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      onActivity?.("tunnel_delete", target.name);
      return { success: true };
    },
    [onActivity, states, stopTunnel, tunnels],
  );

  const startAll = useCallback(async () => {
    for (const t of tunnels) {
      if (states[t.id]?.status !== "active") {
        await startTunnel(t.id);
      }
    }
  }, [tunnels, states, startTunnel]);

  const stopAll = useCallback(async () => {
    for (const t of tunnels) {
      if (states[t.id]?.status === "active") {
        await stopTunnel(t.id);
      }
    }
  }, [tunnels, states, stopTunnel]);

  return {
    storageError,
    tunnels,
    states,
    addTunnel,
    updateTunnel,
    deleteTunnel,
    duplicateTunnel,
    startTunnel,
    stopTunnel,
    startAll,
    stopAll,
  };
}
