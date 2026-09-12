/** User-controlled lifecycle for sharing this device through Lattice Remote. */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  reconcileSingletonSnapshot,
  snapshotSessionIds,
} from "./sessionSnapshot";

export interface RemoteHostStatus {
  hostId: string;
  address: string;
  pairingCode: string;
  /** Zero means the code stays valid while sharing is on. */
  expiresAt: number;
  viewOnly: boolean;
  fileTransfer: boolean;
  commands?: boolean;
  fileRoot?: string;
  state: "waiting" | "pairing" | "streaming" | "reconnecting";
  peer?: string;
  attemptsRemaining: number;
  /** Relay mode: the permanent nine-digit device ID viewers dial. */
  deviceId?: string | null;
  relay?: string | null;
  /** True when the agent keeps serving sessions until stopped. */
  persistent: boolean;
}

export interface RemoteHostStartRequest {
  bindAddress: string;
  port: number;
  fps: number;
  /** Let the paired viewer control this machine. Defaults to view-only. */
  allowInput: boolean;
  allowCommands?: boolean;
  /** Independently authorises access to one shared folder. */
  allowFiles: boolean;
  /** Empty selects the current user's home folder in the native backend. */
  fileRoot: string;
  /** "direct" listens locally; "relay" registers the device ID on a relay. */
  mode: "direct" | "relay";
  relayAddress: string;
  /** Optional fixed pairing code for relay mode; empty generates one. */
  pairingCode: string;
}

export interface RemoteHostApi {
  /** Permanent public ID used for relay connections, available before sharing starts. */
  deviceId: string | null;
  deviceIdError: string | null;
  /**
   * Reads the relay device ID, creating the identity file on first use.
   * Call this only once the user has chosen relay sharing: the file holds a
   * registration token and a Noise private key, so opening the application
   * must not mint one for someone who never uses Lattice Remote.
   */
  ensureDeviceId: () => Promise<void>;
  status: RemoteHostStatus | null;
  closedReason: string | null;
  start: (request: RemoteHostStartRequest) => Promise<RemoteHostStatus>;
  stop: () => Promise<void>;
  clearClosedReason: () => void;
}

async function core() {
  return import("@tauri-apps/api/core");
}

export function useRemoteHost(): RemoteHostApi {
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [deviceIdError, setDeviceIdError] = useState<string | null>(null);
  const [status, setStatus] = useState<RemoteHostStatus | null>(null);
  const [closedReason, setClosedReason] = useState<string | null>(null);
  const intentionalStops = useRef(new Set<string>());
  const statusRevision = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const disposers: Array<() => void> = [];
    let hydrating = true;
    const closedDuringHydration = new Set<string>();
    const hydrationRevision = statusRevision.current;

    function keep(dispose: () => void): boolean {
      if (cancelled) {
        dispose();
        return false;
      }
      disposers.push(dispose);
      return true;
    }

    async function initialize() {
      try {
        const [{ invoke }, { listen }] = await Promise.all([
          core(),
          import("@tauri-apps/api/event"),
        ]);
        const stopStatus = await listen<RemoteHostStatus>(
          "remote-host://status",
          (event) => {
            statusRevision.current += 1;
            if (event.payload.deviceId) {
              setDeviceId(event.payload.deviceId);
              setDeviceIdError(null);
            }
            setStatus(event.payload);
          },
        );
        if (!keep(stopStatus)) return;

        const stopClosed = await listen<{ hostId: string; reason: string }>(
          "remote-host://closed",
          (event) => {
            if (hydrating) closedDuringHydration.add(event.payload.hostId);
            statusRevision.current += 1;
            setStatus((current) =>
              current?.hostId === event.payload.hostId ? null : current,
            );
            if (!intentionalStops.current.delete(event.payload.hostId)) {
              setClosedReason(event.payload.reason);
            }
          },
        );
        if (!keep(stopClosed)) return;

        const current = await invoke<RemoteHostStatus | null>(
          "remote_host_status",
        );
        if (!cancelled) {
          const closedSnapshot = snapshotSessionIds(closedDuringHydration);
          setStatus((latest) => {
            if (statusRevision.current === hydrationRevision) return current;
            return reconcileSingletonSnapshot(
              latest,
              current,
              (entry) => entry.hostId,
              closedSnapshot,
            );
          });
          hydrating = false;
          closedDuringHydration.clear();
        }
      } catch {
        hydrating = false;
        closedDuringHydration.clear();
        // Browser preview has no native Agent process.
      }
    }

    void initialize();
    return () => {
      cancelled = true;
      for (const dispose of disposers) dispose();
    };
  }, []);

  const start = useCallback(async (request: RemoteHostStartRequest) => {
    const { invoke } = await core();
    setClosedReason(null);
    const started = await invoke<RemoteHostStatus>("remote_host_start", {
      request,
    });
    statusRevision.current += 1;
    if (started.deviceId) {
      setDeviceId(started.deviceId);
      setDeviceIdError(null);
    }
    setStatus(started);
    return started;
  }, []);

  const stop = useCallback(async () => {
    const { invoke } = await core();
    const hostId = status?.hostId;
    if (hostId) intentionalStops.current.add(hostId);
    try {
      await invoke("remote_host_stop");
      statusRevision.current += 1;
      setStatus(null);
    } catch (reason) {
      if (hostId) intentionalStops.current.delete(hostId);
      throw reason;
    }
  }, [status?.hostId]);

  const deviceIdRequest = useRef<Promise<void> | null>(null);
  const ensureDeviceId = useCallback(async () => {
    if (deviceIdRequest.current) return deviceIdRequest.current;
    const request = (async () => {
      try {
        const { invoke } = await core();
        const permanentDeviceId = await invoke<string>("remote_host_device_id");
        setDeviceId(permanentDeviceId);
        setDeviceIdError(null);
      } catch (reason) {
        // A failed read may be transient, so let the next attempt retry.
        deviceIdRequest.current = null;
        setDeviceIdError(
          reason instanceof Error ? reason.message : String(reason),
        );
      }
    })();
    deviceIdRequest.current = request;
    return request;
  }, []);

  const clearClosedReason = useCallback(() => setClosedReason(null), []);

  return {
    deviceId,
    deviceIdError,
    ensureDeviceId,
    status,
    closedReason,
    start,
    stop,
    clearClosedReason,
  };
}
