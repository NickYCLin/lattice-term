import { loadRelayAddress } from "./remoteRelay";
import type { RemoteHostStartRequest } from "./useRemoteHost";
const KEY = "latticeterm.remote.hostSettings.v1";
export function loadRemoteHostSettings(storage: Storage): RemoteHostStartRequest {
  const relay = loadRelayAddress(storage);
  // A share nobody has configured yet opens everything to whoever pairs, the
  // way the product is meant to be used; the pairing code is what keeps it
  // private. Picking "only look" or single items is remembered from then on,
  // and a configuration saved earlier is read as it was written.
  // cmd and PowerShell sharing only exists on a Windows host; asking for it
  // anywhere else is refused outright, which would stop sharing from starting
  // at all. The dialog offers the switch only on Windows for the same reason.
  const defaults: RemoteHostStartRequest = { bindAddress: "", port: 44900, fps: 5, allowInput: true, allowFiles: true, allowCommands: false, allowChat: true, allowCli: true, fleet: { directory: "", read: true, control: true, launch: true }, fileRoot: "", mode: relay ? "relay" : "direct", relayAddress: relay, pairingCode: "", useSavedPairingCode: false, rememberPairingCode: false };
  try {
    const value = JSON.parse(storage.getItem(KEY) ?? "null") as Partial<RemoteHostStartRequest> | null;
    if (!value || typeof value !== "object") return defaults;
    return { ...defaults,
      bindAddress: typeof value.bindAddress === "string" && value.bindAddress.length < 128 ? value.bindAddress : defaults.bindAddress,
      port: Number.isInteger(value.port) && value.port! > 0 && value.port! <= 65535 ? value.port! : defaults.port,
      fps: Number.isInteger(value.fps) && value.fps! >= 1 && value.fps! <= 10 ? value.fps! : defaults.fps,
      allowInput: value.allowInput === true, allowFiles: value.allowFiles === true, allowCommands: value.allowCommands === true, allowChat: value.allowChat === true, allowCli: value.allowCli === true,
      // Fleet authority is never written down; a configured share starts it
      // off again, and only a share nobody has set up offers it by default.
      fleet: null,
      fileRoot: typeof value.fileRoot === "string" && value.fileRoot.length <= 4096 ? value.fileRoot : "",
      mode: value.mode === "direct" || value.mode === "relay" ? value.mode : defaults.mode,
      relayAddress: typeof value.relayAddress === "string" && value.relayAddress.length < 2048 ? value.relayAddress : relay,
      pairingCode: "",
      useSavedPairingCode: value.mode === "relay" && value.useSavedPairingCode === true,
      rememberPairingCode: false,
    };
  } catch { return defaults; }
}
export function saveRemoteHostSettings(storage: Storage, request: RemoteHostStartRequest): void {
  // Pairing passwords and one-shot save intent never enter browser storage.
  // Only the non-secret instruction to ask the native credential store is kept.
  const { pairingCode: _secret, rememberPairingCode: _oneShot, fleet: _fleetGrant, ...settings } = request;
  storage.setItem(KEY, JSON.stringify({
    ...settings,
    useSavedPairingCode:
      settings.mode === "relay" && settings.useSavedPairingCode === true,
  }));
}

export function clearRemoteHostSettings(storage: Storage): void {
  storage.removeItem(KEY);
}
