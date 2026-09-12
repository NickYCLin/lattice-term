/** User-controlled lifecycle for sharing this device through Lattice Remote. */

import { loadRemoteHostSettings, saveRemoteHostSettings } from "./remoteHostSettings";
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
  chat?: boolean;
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
  allowChat?: boolean;
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
  configuring?: boolean;
  configuration?: RemoteHostStartRequest;
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

export function useRemoteHost(autoStandby = false): RemoteHostApi {
  const [hydrated, setHydrated] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [configuration, setConfiguration] = useState(() => loadRemoteHostSettings(window.localStorage));
  const startPending = useRef(false);
  const currentStatus = useRef<RemoteHostStatus | null>(null);
  const retryAt = useRef(0);
  const [retryGeneration, advanceRetry] = useState(0);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [deviceIdError, setDeviceIdError] = useState<string | null>(null);
  const [status, setStatus] = useState<RemoteHostStatus | null>(null);
  const [closedReason, setClosedReason] = useState<string | null>(null);
  currentStatus.current = status;
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
      } finally { if (!cancelled) setHydrated(true); }
    }

    void initialize();
    return () => {
      cancelled = true;
      for (const dispose of disposers) dispose();
    };
  }, []);

  const start = useCallback(async (request: RemoteHostStartRequest) => {
    if (startPending.current) throw new Error("Sharing settings are being applied.");
    startPending.current = true; setConfiguring(true); setClosedReason(null);
    const previousId = currentStatus.current?.hostId;
    if (previousId) intentionalStops.current.add(previousId);
    try {
      const { invoke } = await core();
      const started = await invoke<RemoteHostStatus>("remote_host_configure", { request: { ...request, pairingCode: request.pairingCode || currentStatus.current?.pairingCode || "" } });
      statusRevision.current += 1;
      if (started.deviceId) { setDeviceId(started.deviceId); setDeviceIdError(null); }
      setStatus(started); currentStatus.current = started;
      setConfiguration({ ...request, pairingCode: "" });
      try { saveRemoteHostSettings(window.localStorage, request); }
      catch { setClosedReason("Sharing is ready, but its settings could not be saved for the next launch."); }
      return started;
    } catch (error) {
      retryAt.current = Date.now() + 30_000;
      advanceRetry(value => value + 1);
      setClosedReason(String(error));
      throw error;
    } finally {
      if (previousId) intentionalStops.current.delete(previousId);
      startPending.current = false; setConfiguring(false);
    }
  }, []);

  useEffect(() => {
    if (!autoStandby || !hydrated || status || configuring) return;
    const timer = setTimeout(() => {
      if (!startPending.current && !currentStatus.current) void start(configuration).catch(() => undefined);
    }, Math.max(0, retryAt.current - Date.now()));
    return () => clearTimeout(timer);
  }, [autoStandby, hydrated, status, configuring, configuration, start, retryGeneration]);

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
    configuring,
    configuration,
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
