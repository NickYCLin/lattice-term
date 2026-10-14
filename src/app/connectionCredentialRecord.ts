import type { ConnectionProfile } from "../domain/connection";

export interface ConnectionCredentialDraft {
  secret: string | null;
  allowMcpRead: boolean;
}

export interface ConnectionCredentialStatus {
  saved: boolean;
  allowMcpRead: boolean;
  detail?: string | null;
}

export function supportsCredentialRecord(profile: ConnectionProfile): boolean {
  return profile.protocol !== "lattice" || Boolean(profile.deviceId);
}

export function sameCredentialTarget(left: ConnectionProfile | null, right: ConnectionProfile): boolean {
  return Boolean(left && left.protocol === right.protocol && left.hostname === right.hostname && left.port === right.port && left.username === right.username && left.deviceId === right.deviceId && left.relayAddress === right.relayAddress);
}

export async function readConnectionCredentialStatus(profileId: string) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ConnectionCredentialStatus>("connection_credential_status", { profileId });
}

export async function readConnectionCredential(profileId: string) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("connection_credential_read", { profileId });
}

export async function persistConnectionRecord(profile: ConnectionProfile, credential?: ConnectionCredentialDraft, linkedProfileId?: string) {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("save_connection_record", { profile, credential: credential ?? null, linkedProfileId: linkedProfileId ?? null });
}
