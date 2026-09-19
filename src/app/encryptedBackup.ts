import {
  sanitizePreferences,
  type Preferences,
} from "./preferences";
import { exportTextFile, type FileExportResult } from "./fileExport";
import { AUTOMATIONS_RESTORED_EVENT, AUTOMATIONS_STORAGE_KEY } from "./agentAutomations";

export const BACKUP_EXTENSION = ".latticeterm-backup";
export const BACKUP_LOCAL_STORAGE_KEYS = [
  "latticeterm.preferences.v2",
  "latticeterm.tunnels.v1",
  "latticeterm.authPrefs.v1",
  "latticeterm.agentAutomations.v1",
] as const;

/**
 * Settings that older backups could not contain. A backup without one says
 * nothing about it, so restoring keeps what this machine already has.
 */
const KEPT_WHEN_ABSENT: readonly string[] = [AUTOMATIONS_STORAGE_KEY];

const PREFERENCES_KEY = BACKUP_LOCAL_STORAGE_KEYS[0];
const MAX_BACKUP_FILE_BYTES = 28 * 1024 * 1024;
export const MIN_BACKUP_PASSWORD_CHARACTERS = 12;
const MAX_BACKUP_PASSWORD_BYTES = 1024;

export interface BackupStorageAdapter {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export interface EncryptedBackupExport {
  contents: string;
  createdAt: number;
  appFileCount: number;
  vaultIncluded: boolean;
}

export interface EncryptedBackupRestore {
  sourceCreatedAt: number;
  sourceAppVersion: string;
  profileCount: number;
  trustedHostCount: number;
  agentPlanCount: number;
  vaultIncluded: boolean;
  localStorage: Record<string, string>;
}

export function collectBackupLocalStorage(
  storage: BackupStorageAdapter,
  preferences: Preferences,
): Record<string, string> {
  const collected: Record<string, string> = {
    [PREFERENCES_KEY]: JSON.stringify(preferences),
  };
  for (const key of BACKUP_LOCAL_STORAGE_KEYS.slice(1)) {
    const value = storage.getItem(key);
    if (value !== null) collected[key] = value;
  }
  return collected;
}

export function backupPasswordIsValid(password: string): boolean {
  return (
    Array.from(password).length >= MIN_BACKUP_PASSWORD_CHARACTERS &&
    new TextEncoder().encode(password).length <= MAX_BACKUP_PASSWORD_BYTES
  );
}

export function applyRestoredLocalStorage(
  storage: BackupStorageAdapter,
  restored: Record<string, string>,
): Preferences {
  for (const key of Object.keys(restored)) {
    if (!(BACKUP_LOCAL_STORAGE_KEYS as readonly string[]).includes(key)) {
      throw new Error(`Backup returned an unsupported local setting: ${key}`);
    }
    JSON.parse(restored[key]);
  }

  const rawPreferences = restored[PREFERENCES_KEY];
  const decodedPreferences = rawPreferences ? JSON.parse(rawPreferences) : {};
  const restoredPreferences =
    decodedPreferences &&
    typeof decodedPreferences === "object" &&
    !Array.isArray(decodedPreferences)
      ? sanitizePreferences(decodedPreferences as Partial<Preferences>)
      : sanitizePreferences({});
  const previous = new Map(
    BACKUP_LOCAL_STORAGE_KEYS.map((key) => [key, storage.getItem(key)]),
  );

  try {
    // Write incoming values before removing leftovers, reducing the work that
    // must be rolled back if WebView storage is unexpectedly unavailable.
    for (const [key, value] of Object.entries(restored)) {
      storage.setItem(key, value);
    }
    for (const key of BACKUP_LOCAL_STORAGE_KEYS) {
      if (restored[key] === undefined && !KEPT_WHEN_ABSENT.includes(key)) {
        storage.removeItem(key);
      }
    }
  } catch (reason) {
    try {
      for (const [key, value] of previous) {
        if (value === null) storage.removeItem(key);
        else storage.setItem(key, value);
      }
    } catch (rollbackReason) {
      throw new Error(
        `Local settings could not be restored (${String(reason)}), and rollback also failed (${String(rollbackReason)}).`,
      );
    }
    throw reason;
  }

  if (
    restored[AUTOMATIONS_STORAGE_KEY] !== undefined &&
    typeof window !== "undefined" &&
    typeof window.dispatchEvent === "function"
  ) {
    window.dispatchEvent(new Event(AUTOMATIONS_RESTORED_EVENT));
  }
  return restoredPreferences;
}

export function encryptedBackupFilename(createdAtSeconds: number): string {
  const date = new Date(Math.max(0, createdAtSeconds) * 1_000);
  const timestamp = Number.isNaN(date.getTime())
    ? "unknown-date"
    : date.toISOString().replace(/[:.]/g, "-");
  return `LatticeTerm-${timestamp}${BACKUP_EXTENSION}`;
}

export async function exportEncryptedBackup(
  password: string,
  preferences: Preferences,
  platform?: string,
): Promise<EncryptedBackupExport & { delivery: FileExportResult }> {
  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<EncryptedBackupExport>("encrypted_backup_export", {
    password,
    localStorage: collectBackupLocalStorage(window.localStorage, preferences),
  });
  const delivery = await exportTextFile(
    result.contents,
    encryptedBackupFilename(result.createdAt),
    platform,
  );
  return { ...result, delivery };
}

export async function readEncryptedBackupFile(file: File): Promise<string> {
  if (file.size > MAX_BACKUP_FILE_BYTES) {
    throw new Error("The selected backup file is too large.");
  }
  const contents = await file.text();
  if (!contents.trim()) throw new Error("The selected backup file is empty.");
  return contents;
}

export async function restoreEncryptedBackup(
  contents: string,
  password: string,
): Promise<EncryptedBackupRestore> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<EncryptedBackupRestore>("encrypted_backup_restore", {
    contents,
    password,
  });
}
