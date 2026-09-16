/** User-controlled lifecycle for sharing this device through Lattice Remote. */

import {
  clearRemoteHostSettings,
  loadRemoteHostSettings,
  saveRemoteHostSettings,
} from "./remoteHostSettings";
import { useCallback, useEffect, useRef, useState } from "react";
import { snapshotSessionIds } from "./sessionSnapshot";

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
  cli?: boolean;
  fleet?: boolean;
  fileRoot?: string;
  state: "waiting" | "pairing" | "streaming" | "reconnecting";
  peer?: string;
  /** Number of authenticated viewers; absent when an older sidecar is used. */
  activeSessions?: number;
  attemptsRemaining: number;
  /** Relay mode: the permanent nine-digit device ID viewers dial. */
  deviceId?: string | null;
  relay?: string | null;
  /** True when the agent keeps serving sessions until stopped. */
  persistent: boolean;
  /** The relay password is in native secure storage; plaintext is redacted. */
  savedPairingCode: boolean;
}

export interface RemoteHostStartRequest {
  bindAddress: string;
  port: number;
  fps: number;
  /** Let the paired viewer control this machine. Defaults to view-only. */
  allowInput: boolean;
  allowCommands?: boolean;
  allowChat?: boolean;
  allowCli?: boolean;
  /** Granted afresh when sharing starts; not inherited from pairing or CLI access. */
  fleet?: { directory: string; read: boolean; control: boolean; launch: boolean } | null;
  /** Independently authorises access to one shared folder. */
  allowFiles: boolean;
  /** Empty selects the current user's home folder in the native backend. */
  fileRoot: string;
  /** "direct" listens locally; "relay" registers the device ID on a relay. */
  mode: "direct" | "relay";
  relayAddress: string;
  /** Optional fixed pairing code for relay mode; empty generates one. */
  pairingCode: string;
  /** Ask the native backend to load the host password from secure storage. */
  useSavedPairingCode: boolean;
  /** Save this supplied host password after the Agent is ready. */
  rememberPairingCode: boolean;
}

interface RemoteHostForgetResult {
  cleanupWarning: string | null;
  cleanupPending: boolean;
}

function redactRevokedPairingCode(
  status: RemoteHostStatus,
  unsavedHostIds: ReadonlySet<string>,
): RemoteHostStatus;
function redactRevokedPairingCode(
  status: RemoteHostStatus | null,
  unsavedHostIds: ReadonlySet<string>,
): RemoteHostStatus | null;
function redactRevokedPairingCode(
  status: RemoteHostStatus | null,
  unsavedHostIds: ReadonlySet<string>,
): RemoteHostStatus | null {
  if (!status || !unsavedHostIds.has(status.hostId)) return status;
  return {
    ...status,
    pairingCode: "",
    savedPairingCode: false,
  };
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
  removeSavedPairingCode: () => Promise<void>;
  retrySavedPairingCodeCleanup: () => Promise<void>;
  stop: () => Promise<void>;
  clearClosedReason: () => void;
}

async function core() {
  return import("@tauri-apps/api/core");
}

export function useRemoteHost(autoStandby = false): RemoteHostApi {
  const [hydrated, setHydrated] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [configuration, setConfiguration] = useState(() =>
    loadRemoteHostSettings(window.localStorage),
  );
  const configurationRef = useRef(configuration);
  configurationRef.current = configuration;
  const startPending = useRef(false);
  const pendingReplacementHostId = useRef<string | null>(null);
  const currentStatus = useRef<RemoteHostStatus | null>(null);
  const retryAt = useRef(0);
  const [retryGeneration, advanceRetry] = useState(0);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [deviceIdError, setDeviceIdError] = useState<string | null>(null);
  const [status, setStatus] = useState<RemoteHostStatus | null>(null);
  const [closedReason, setClosedReason] = useState<string | null>(null);
  currentStatus.current = status;
  const intentionalStops = useRef(new Set<string>());
  // A replaced Agent can already have WebView events queued when its native
  // record is retired. Never let those old host IDs overwrite the successor.
  const retiredHostIds = useRef(new Set<string>());
  // Native password revocation is monotonic for one process-unique host ID.
  // A status frame queued before the reset must not restore its saved badge.
  const unsavedHostIds = useRef(new Set<string>());
  const statusRevision = useRef(0);

  const disableSavedPairingCodeReuse = useCallback(() => {
    const current = configurationRef.current;
    if (!current.useSavedPairingCode) return;
    const nextConfiguration = {
      ...current,
      pairingCode: "",
      useSavedPairingCode: false,
      rememberPairingCode: false,
    };
    configurationRef.current = nextConfiguration;
    setConfiguration(nextConfiguration);
    try {
      saveRemoteHostSettings(window.localStorage, nextConfiguration);
    } catch {
      try {
        clearRemoteHostSettings(window.localStorage);
      } catch {
        setClosedReason(
          "Password reuse was disabled, but standby settings could not be updated on disk.",
        );
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const disposers: Array<() => void> = [];
    let hydrating = true;
    const closedDuringHydration = new Set<string>();

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
        // A missed status can be recovered by the snapshot below. Credential
        // revocation has no representation when there is no active host, so
        // install its listener before the other lifecycle streams.
        const stopCredentialReset = await listen<{
          hostId?: string | null;
        } | null>("remote-host://credential-reset", (event) => {
          const reportedHostId = event.payload?.hostId ?? null;
          const hostId = reportedHostId ?? currentStatus.current?.hostId ?? null;
          if (hostId) {
            unsavedHostIds.current.add(hostId);
            const replacementHostId = pendingReplacementHostId.current;
            const activeHostId = currentStatus.current?.hostId ?? null;
            const belongsToRetiredGeneration =
              reportedHostId === hostId &&
              retiredHostIds.current.has(hostId) &&
              ((replacementHostId !== null && replacementHostId !== hostId) ||
                (activeHostId !== null && activeHostId !== hostId));
            if (belongsToRetiredGeneration) return;
            if (currentStatus.current?.hostId === hostId) {
              statusRevision.current += 1;
              const unsaved = {
                ...currentStatus.current,
                pairingCode: "",
                savedPairingCode: false,
              };
              currentStatus.current = unsaved;
              setStatus(unsaved);
            }
          }
          disableSavedPairingCodeReuse();
        });
        if (!keep(stopCredentialReset)) return;

        const stopClosed = await listen<{ hostId: string; reason: string }>(
          "remote-host://closed",
          (event) => {
            if (hydrating) closedDuringHydration.add(event.payload.hostId);
            const alreadyRetired = retiredHostIds.current.has(
              event.payload.hostId,
            );
            // A status event can already be queued behind this close event in
            // the WebView. Host IDs are process-lifetime unique, so retire it
            // immediately even when native configuration later rejects.
            retiredHostIds.current.add(event.payload.hostId);
            if (alreadyRetired) {
              intentionalStops.current.delete(event.payload.hostId);
              if (currentStatus.current?.hostId === event.payload.hostId) {
                currentStatus.current = null;
                setStatus((current) =>
                  current?.hostId === event.payload.hostId ? null : current,
                );
              }
              return;
            }
            statusRevision.current += 1;
            if (currentStatus.current?.hostId === event.payload.hostId) {
              currentStatus.current = null;
            }
            setStatus((current) =>
              current?.hostId === event.payload.hostId ? null : current,
            );
            if (!intentionalStops.current.delete(event.payload.hostId)) {
              setClosedReason(event.payload.reason);
            }
          },
        );
        if (!keep(stopClosed)) return;

        const stopStatus = await listen<RemoteHostStatus>(
          "remote-host://status",
          (event) => {
            if (retiredHostIds.current.has(event.payload.hostId)) return;
            const payload = redactRevokedPairingCode(
              event.payload,
              unsavedHostIds.current,
            );
            statusRevision.current += 1;
            currentStatus.current = payload;
            if (!payload.savedPairingCode) {
              disableSavedPairingCodeReuse();
            }
            if (payload.deviceId) {
              setDeviceId(payload.deviceId);
              setDeviceIdError(null);
            }
            setStatus(payload);
          },
        );
        if (!keep(stopStatus)) return;

        // Events delivered while listeners were being installed are already
        // reflected in the native snapshot requested after this revision.
        const hydrationRevision = statusRevision.current;
        const current = await invoke<RemoteHostStatus | null>(
          "remote_host_status",
        );
        if (!cancelled) {
          const closedSnapshot = snapshotSessionIds(closedDuringHydration);
          // Once any live event or local confirmation changes the revision,
          // currentStatus is authoritative even when it is null. Falling
          // back to the older snapshot would resurrect a stopped/forgotten
          // host after a newer null confirmation.
          const rawCandidate =
            statusRevision.current === hydrationRevision
              ? current
              : currentStatus.current;
          const candidate = redactRevokedPairingCode(
            rawCandidate,
            unsavedHostIds.current,
          );
          const reconciled =
            candidate && !closedSnapshot.has(candidate.hostId)
              ? candidate
              : null;
          currentStatus.current = reconciled;
          if (reconciled && !reconciled.savedPairingCode) {
            disableSavedPairingCodeReuse();
          }
          if (reconciled?.deviceId) {
            setDeviceId(reconciled.deviceId);
            setDeviceIdError(null);
          }
          setStatus(reconciled);
          hydrating = false;
          closedDuringHydration.clear();
        }
      } catch {
        hydrating = false;
        closedDuringHydration.clear();
        // Browser preview has no native Agent process.
      } finally {
        if (!cancelled) setHydrated(true);
      }
    }

    void initialize();
    return () => {
      cancelled = true;
      for (const dispose of disposers) dispose();
    };
  }, [disableSavedPairingCodeReuse]);

  const start = useCallback(async (request: RemoteHostStartRequest) => {
    if (startPending.current)
      throw new Error("Sharing settings are being applied.");
    startPending.current = true;
    setConfiguring(true);
    setClosedReason(null);
    pendingReplacementHostId.current = null;
    const previousId = currentStatus.current?.hostId;
    if (previousId) intentionalStops.current.add(previousId);
    try {
      const { invoke } = await core();
      const started = await invoke<RemoteHostStatus>("remote_host_configure", {
        request: {
          ...request,
          pairingCode: request.useSavedPairingCode
            ? ""
            : request.pairingCode ||
              (request.rememberPairingCode
                ? ""
                : currentStatus.current?.pairingCode || ""),
        },
      });
      pendingReplacementHostId.current = started.hostId;
      if (previousId) retiredHostIds.current.add(previousId);
      const snapshotRevision = statusRevision.current;
      let confirmationWarning: string | null = null;
      let confirmed: RemoteHostStatus | null;
      try {
        confirmed = await invoke<RemoteHostStatus | null>("remote_host_status");
      } catch (error) {
        confirmed = started;
        confirmationWarning = `Sharing started, but its active status could not be refreshed: ${error instanceof Error ? error.message : String(error)}`;
      }
      const rawActive =
        statusRevision.current === snapshotRevision
          ? confirmed
          : currentStatus.current;
      const active = redactRevokedPairingCode(
        rawActive,
        unsavedHostIds.current,
      );
      if (
        retiredHostIds.current.has(started.hostId) ||
        !active ||
        active.hostId !== started.hostId
      ) {
        throw new Error(
          "Sharing stopped before its status could be confirmed.",
        );
      }
      if (statusRevision.current === snapshotRevision) {
        // Invalidate any initial status snapshot that was requested before
        // this locally confirmed start completed.
        statusRevision.current += 1;
        currentStatus.current = active;
        setStatus(active);
      }
      if (active.deviceId) {
        setDeviceId(active.deviceId);
        setDeviceIdError(null);
      }
      const nextConfiguration = {
        ...request,
        fleet: null,
        pairingCode: "",
        useSavedPairingCode: active.savedPairingCode === true,
        rememberPairingCode: false,
      };
      configurationRef.current = nextConfiguration;
      setConfiguration(nextConfiguration);
      const warnings: string[] = [];
      if (confirmationWarning) warnings.push(confirmationWarning);
      try {
        saveRemoteHostSettings(window.localStorage, nextConfiguration);
      } catch {
        warnings.push(
          "Sharing is ready, but its settings could not be saved for the next launch.",
        );
      }
      if (warnings.length > 0) setClosedReason(warnings.join(" "));
      return active;
    } catch (error) {
      retryAt.current = Date.now() + 30_000;
      advanceRetry((value) => value + 1);
      setClosedReason(String(error));
      throw error;
    } finally {
      if (previousId) intentionalStops.current.delete(previousId);
      pendingReplacementHostId.current = null;
      startPending.current = false;
      setConfiguring(false);
    }
  }, []);

  useEffect(() => {
    if (!autoStandby || !hydrated || status || configuring) return;
    const timer = setTimeout(
      () => {
        if (!startPending.current && !currentStatus.current)
          void start(configuration).catch(() => undefined);
      },
      Math.max(0, retryAt.current - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [
    autoStandby,
    hydrated,
    status,
    configuring,
    configuration,
    start,
    retryGeneration,
  ]);

  const stop = useCallback(async () => {
    const { invoke } = await core();
    const hostId = status?.hostId;
    if (hostId) intentionalStops.current.add(hostId);
    try {
      await invoke("remote_host_stop");
      if (hostId) retiredHostIds.current.add(hostId);
      statusRevision.current += 1;
      setStatus(null);
      currentStatus.current = null;
    } catch (reason) {
      if (hostId) intentionalStops.current.delete(hostId);
      throw reason;
    }
  }, [status?.hostId]);

  const removeSavedPairingCode = useCallback(async () => {
    if (startPending.current)
      throw new Error("Sharing settings are being applied.");
    startPending.current = true;
    setConfiguring(true);
    setClosedReason(null);
    const nextConfiguration = {
      ...configuration,
      pairingCode: "",
      useSavedPairingCode: false,
      rememberPairingCode: false,
    };
    configurationRef.current = nextConfiguration;
    setConfiguration(nextConfiguration);
    let settingsPersisted = true;
    let settingsReset = false;
    const revokedHostId = currentStatus.current?.hostId ?? null;
    try {
      saveRemoteHostSettings(window.localStorage, nextConfiguration);
    } catch {
      try {
        clearRemoteHostSettings(window.localStorage);
        settingsReset = true;
      } catch {
        settingsPersisted = false;
      }
    }
    try {
      const { invoke } = await core();
      let result: RemoteHostForgetResult;
      try {
        result = await invoke<RemoteHostForgetResult>(
          "remote_host_forget_pairing_code",
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const message = settingsPersisted
          ? `Standby password reuse was turned off, but native secure storage could not disable the saved host password: ${detail}`
          : `Neither standby settings nor native secure storage could disable the saved host password: ${detail}`;
        setClosedReason(message);
        throw new Error(message);
      }

      if (revokedHostId) {
        unsavedHostIds.current.add(revokedHostId);
        if (currentStatus.current?.hostId === revokedHostId) {
          statusRevision.current += 1;
          const unsaved = redactRevokedPairingCode(
            currentStatus.current,
            unsavedHostIds.current,
          );
          currentStatus.current = unsaved;
          setStatus(unsaved);
        }
      }

      const warnings: string[] = [];
      const snapshotRevision = statusRevision.current;
      try {
        const confirmed = redactRevokedPairingCode(
          await invoke<RemoteHostStatus | null>("remote_host_status"),
          unsavedHostIds.current,
        );
        if (statusRevision.current === snapshotRevision) {
          statusRevision.current += 1;
          currentStatus.current = confirmed;
          setStatus(confirmed);
        }
      } catch (error) {
        if (statusRevision.current === snapshotRevision) {
          const fallback = currentStatus.current
            ? {
                ...currentStatus.current,
                pairingCode: "",
                savedPairingCode: false,
              }
            : null;
          statusRevision.current += 1;
          currentStatus.current = fallback;
          setStatus(fallback);
        }
        warnings.push(
          `Password reuse was disabled, but the active sharing status could not be refreshed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!settingsPersisted) {
        warnings.push(
          "The saved host password was deleted, but standby settings could not be updated. A stale saved-password request may fail closed on the next launch.",
        );
      } else if (settingsReset) {
        warnings.push(
          "The saved host password was deleted. Standby settings had to be reset because they could not be updated in place.",
        );
      }
      if (result.cleanupWarning) {
        warnings.push(
          `Automatic password reuse was disabled, but secure-storage cleanup is still pending: ${result.cleanupWarning}`,
        );
      } else if (result.cleanupPending) {
        warnings.push(
          "Automatic password reuse was disabled, but secure-storage cleanup is still pending.",
        );
      }
      if (warnings.length > 0) setClosedReason(warnings.join(" "));
    } finally {
      startPending.current = false;
      setConfiguring(false);
    }
  }, [configuration]);

  const retrySavedPairingCodeCleanup = useCallback(async () => {
    if (startPending.current) {
      throw new Error("Sharing settings are being applied.");
    }
    startPending.current = true;
    setConfiguring(true);
    setClosedReason(null);
    try {
      const { invoke } = await core();
      const result = await invoke<RemoteHostForgetResult>(
        "remote_host_retry_pairing_code_cleanup",
      );
      if (result.cleanupWarning) {
        const message = `Secure-storage cleanup is still pending: ${result.cleanupWarning}`;
        setClosedReason(message);
        throw new Error(message);
      }
      if (result.cleanupPending) {
        const message = "Secure-storage cleanup is still pending.";
        setClosedReason(message);
        throw new Error(message);
      }
    } finally {
      startPending.current = false;
      setConfiguring(false);
    }
  }, []);

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
    removeSavedPairingCode,
    retrySavedPairingCodeCleanup,
    stop,
    clearClosedReason,
  };
}
