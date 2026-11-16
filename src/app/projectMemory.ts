import { invoke } from "@tauri-apps/api/core";
export type MemoryScope = "project" | "user";
export type MemoryKind = "user" | "feedback" | "project" | "reference";
export interface MemorySource {
  kind: "manual" | "cli" | "conversation";
  cli: string | null;
  conversationId: string | null;
  path: string | null;
}
export interface MemoryDraft {
  id: string | null;
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  source: MemorySource;
  pinned: boolean;
}
export interface MemoryEntry extends MemoryDraft {
  id: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
  blocked: boolean;
}
export interface MemorySnapshot {
  projectDirectory: string | null;
  storage: "project" | "app";
  revision: string;
  entries: MemoryEntry[];
  outputBytes: number;
  maxOutputBytes: number;
  files: {
    cli: string;
    fileName: string;
    state: "synced" | "needsSync" | "manualReview";
    reason: string | null;
  }[];
  warnings: string[];
}
export interface MemoryCandidate {
  id: string;
  kind: MemoryKind;
  content: string;
  source: MemorySource;
  blocked: boolean;
}
export interface MemoryImport {
  revision: string;
  candidates: MemoryCandidate[];
  warnings: string[];
}
export type MemoryAction =
  | { kind: "upsert"; draft: MemoryDraft }
  | { kind: "delete"; id: string; scope: MemoryScope }
  | { kind: "storage"; location: "project" | "app" }
  | { kind: "sync" }
  | { kind: "ignore"; confirmed: boolean }
  | {
      kind: "import";
      ids: string[];
      scope: MemoryScope;
      definitionId: string;
      configDirectory: string | null;
      previewRevision: string;
    };
export const MEMORY_CHANGED = "latticeterm:project-memory-changed";
export const memoryDraft = (
  directory: string,
  content = "",
  source?: MemorySource,
): MemoryDraft => ({
  id: null,
  scope: directory ? "project" : "user",
  kind: "project",
  content,
  pinned: false,
  source: source ?? {
    kind: "manual",
    cli: null,
    conversationId: null,
    path: null,
  },
});
export const inspectMemory = (directory: string) =>
  invoke<MemorySnapshot>("project_memory_inspect", {
    projectDirectory: directory || null,
  });
export const previewMemory = (
  directory: string,
  definitionId: string,
  configDirectory: string | null,
) =>
  invoke<MemoryImport>("project_memory_import", {
    projectDirectory: directory || null,
    definitionId,
    configDirectory,
  });
export async function mutateMemory(
  directory: string,
  revision: string,
  action: MemoryAction,
) {
  const value = await invoke<MemorySnapshot>("project_memory_mutate", {
    projectDirectory: directory || null,
    expectedRevision: revision,
    action,
  });
  window.dispatchEvent(new Event(MEMORY_CHANGED));
  return value;
}
export const memoryBytes = (content: string) =>
  new TextEncoder().encode(content).length;
