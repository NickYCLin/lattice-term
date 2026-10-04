import { useEffect, useSyncExternalStore } from "react";
import type { StorageReaderWriter } from "./workspaceSessionPersistence";

export const LOCAL_PROJECTS_KEY = "latticeterm.localProjects.v1";

export function projectDirectoryKey(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase() : normalized;
}

export function parseLocalProjects(raw: string | null): string[] {
  if (raw === null) return [];
  const value = JSON.parse(raw);
  if (value?.version !== 1 || !Array.isArray(value.directories) ||
    value.directories.length > 1024 ||
    !value.directories.every((path: unknown) => typeof path === "string" &&
      path.length > 0 && path.length <= 4096 &&
      !/[\u0000-\u001f\u007f]/.test(path))) {
    throw new Error("Invalid project catalog");
  }
  return value.directories;
}

export function updateLocalProjects(
  storage: StorageReaderWriter,
  add: readonly string[],
  remove?: string,
): string[] {
  const raw = storage.getItem(LOCAL_PROJECTS_KEY);
  const current = parseLocalProjects(raw);
  const byKey = new Map(current.map(path => [projectDirectoryKey(path), path]));
  for (const path of add) {
    const key = projectDirectoryKey(path);
    if (!byKey.has(key)) byKey.set(key, path);
  }
  if (remove !== undefined) byKey.delete(projectDirectoryKey(remove));
  const directories = [...byKey.values()];
  const next = JSON.stringify({ version: 1, directories });
  parseLocalProjects(next);
  if (storage.getItem(LOCAL_PROJECTS_KEY) !== raw) throw new Error("Project catalog changed");
  if (next !== raw) storage.setItem(LOCAL_PROJECTS_KEY, next);
  return directories;
}

export const DORMANT_PROJECT_CLEANUP_KEY = "latticeterm.localProjects.dormantCleanup.v1";

/**
 * Older builds added folders of imported-history shortcuts to the catalog.
 * Those shortcuts are no longer restored, so drop folders that only they
 * referenced. Runs once; folders with any other saved session are kept.
 */
export function pruneDormantProjectDirectories(
  storage: StorageReaderWriter,
  dormant: readonly string[],
  kept: readonly string[],
): boolean {
  if (storage.getItem(DORMANT_PROJECT_CLEANUP_KEY) !== null) return false;
  const keep = new Set(kept.map(projectDirectoryKey));
  const drop = new Set(dormant.map(projectDirectoryKey).filter(key => !keep.has(key)));
  const raw = storage.getItem(LOCAL_PROJECTS_KEY);
  const current = parseLocalProjects(raw);
  const directories = current.filter(path => !drop.has(projectDirectoryKey(path)));
  if (directories.length !== current.length) {
    storage.setItem(LOCAL_PROJECTS_KEY, JSON.stringify({ version: 1, directories }));
  }
  storage.setItem(DORMANT_PROJECT_CLEANUP_KEY, "1");
  return directories.length !== current.length;
}

const listeners = new Set<() => void>();
let rawCache: string | null | undefined;
let snapshot: { directories: string[]; error: boolean } = { directories: [], error: false };
function read() {
  try {
    const raw = window.localStorage.getItem(LOCAL_PROJECTS_KEY);
    if (raw !== rawCache) {
      snapshot = { directories: parseLocalProjects(raw), error: false };
      rawCache = raw;
    }
  } catch {
    if (!snapshot.error) snapshot = { ...snapshot, error: true };
  }
  return snapshot;
}
function notify() { listeners.forEach(listener => listener()); }
function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => { listeners.delete(listener); window.removeEventListener("storage", listener); };
}
export function useLocalProjects(observed: readonly string[]) {
  const value = useSyncExternalStore(subscribe, read, () => snapshot);
  const signature = JSON.stringify(observed);
  useEffect(() => {
    try {
      updateLocalProjects(window.localStorage, JSON.parse(signature));
      rawCache = undefined;
      notify();
    } catch {
      snapshot = { ...snapshot, error: true };
      notify();
    }
  }, [signature]);
  return {
    ...value,
    remove(path: string) {
      updateLocalProjects(window.localStorage, [], path);
      rawCache = undefined;
      notify();
    },
  };
}
