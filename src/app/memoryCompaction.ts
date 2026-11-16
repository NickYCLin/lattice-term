import { invoke } from "@tauri-apps/api/core";
import { MEMORY_CHANGED, type MemoryScope } from "./projectMemory";
export interface CompactionPreferences {
  limitBytes: number;
  keepVersions: number;
  staleDays: number;
  aiEnabled: boolean;
  cli: "claude";
  configDirectory: string | null;
}
export interface CompactionSettings {
  preferences: CompactionPreferences;
  revision: string;
}
export interface MemoryVersion {
  id: string;
  scope: MemoryScope;
  createdAt: number;
  reason: "auto" | "restore";
}
export interface MemoryArchive {
  createdAt: number;
  reason: string;
  beforeText: string;
  afterText: string;
  warnings: string[];
}
export interface ContextItem {
  role: string;
  text: string;
  kind: string;
  name: string;
}
export interface ContextReport {
  id: string;
  createdAt: number;
  label: string;
  text: string;
  originalPath: string;
  sources?: string[];
  beforeBytes: number;
  afterBytes: number;
  compacted: boolean;
  warnings: string[];
}
export const COMPACTED = "latticeterm:auto-compacted";
export const compactionSettings = () =>
  invoke<CompactionSettings>("memory_compaction_settings", {
    preferences: null,
    expectedRevision: null,
  });
export async function saveCompactionSettings(value: CompactionSettings) {
  const result = await invoke<CompactionSettings>(
    "memory_compaction_settings",
    { preferences: value.preferences, expectedRevision: value.revision },
  );
  window.dispatchEvent(new Event(MEMORY_CHANGED));
  return result;
}
export async function structureContext(
  label: string,
  text: string,
  sourceItems?: ContextItem[],
) {
  const result = await invoke<ContextReport>("memory_structure_context", {
    label,
    text,
    ...(sourceItems?.length ? { sourceItems } : {}),
  });
  if (result.compacted)
    window.dispatchEvent(new CustomEvent(COMPACTED, { detail: result }));
  return result;
}
