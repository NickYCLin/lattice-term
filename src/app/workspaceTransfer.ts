import {
  sanitizeSessionSidebarLayout,
  type SessionSidebarLayout,
} from "./sessionSidebarLayout";
import type { AgentSessionSummary } from "./useAgentSessions";

export const WORKSPACE_TRANSFER_FORMAT = "latticeterm-workspace";
export const MAX_WORKSPACE_TRANSFER_BYTES = 1024 * 1024;
const MAX_ITEMS = 64;
const MAX_ARGUMENTS = 64;

export class WorkspaceExportError extends Error {
  constructor() { super("Workspace export does not meet the import limits"); }
}

/** Shared folders are portable; chat identities are local to their conversations. */
function portableSidebar(sidebar: SessionSidebarLayout): SessionSidebarLayout {
  const placements = Object.fromEntries(Object.entries(sidebar.placements)
    .filter(([id]) => !id.startsWith("thread:"))
    .map(([id, placement]) => {
      let parentId = placement.parentId;
      const visited = new Set<string>();
      while (parentId?.startsWith("thread:")) {
        if (visited.has(parentId)) { parentId = null; break; }
        visited.add(parentId);
        parentId = sidebar.placements[parentId]?.parentId ?? null;
      }
      return [id, { ...placement, parentId }];
    }));
  return { ...sidebar, placements, collapsedFolderIds: sidebar.collapsedFolderIds.filter(id => !id.startsWith("thread:")) };
}

export interface PortableWorkspaceItem {
  groupKey: string;
  groupLabel: string;
  definitionId: string;
  label: string;
  executable: string;
  launchArguments: string[];
  workingDirectory: string;
}

export interface WorkspaceTransferFile {
  format: typeof WORKSPACE_TRANSFER_FORMAT;
  version: 1;
  exportedAt: string;
  items: PortableWorkspaceItem[];
  sidebar: SessionSidebarLayout;
}

function safeText(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (
    !trimmed ||
    new TextEncoder().encode(trimmed).length > maxBytes ||
    Array.from(trimmed).some((character) =>
      /[\u0000-\u001f\u007f]/.test(character),
    )
  ) {
    return null;
  }
  return trimmed;
}

function safeArgument(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).length > 4096 ||
    Array.from(value).some((character) =>
      /[\u0000-\u001f\u007f]/.test(character),
    )
  ) {
    return null;
  }
  return value;
}

export function createWorkspaceTransferFile(
  sessions: readonly AgentSessionSummary[],
  sidebar: SessionSidebarLayout,
  exportedAt = new Date().toISOString(),
): WorkspaceTransferFile {
  return {
    format: WORKSPACE_TRANSFER_FORMAT,
    version: 1,
    exportedAt,
    items: sessions.map((session) => ({
      groupKey: session.groupId || session.sessionId,
      groupLabel: session.groupLabel,
      definitionId: session.definitionId,
      label: session.label,
      executable: session.executable,
      launchArguments: [...session.launchArguments],
      workingDirectory: session.workingDirectory,
    })),
    sidebar: portableSidebar(sidebar),
  };
}

export function serializeWorkspaceTransfer(
  sessions: readonly AgentSessionSummary[],
  sidebar: SessionSidebarLayout,
  exportedAt?: string,
): string {
  const encoded = JSON.stringify(
    createWorkspaceTransferFile(sessions, sidebar, exportedAt),
    null,
    2,
  );
  if (!parseWorkspaceTransfer(encoded)) throw new WorkspaceExportError();
  return encoded;
}

export function parseWorkspaceTransfer(text: string): WorkspaceTransferFile | null {
  if (new TextEncoder().encode(text).length > MAX_WORKSPACE_TRANSFER_BYTES) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.format !== WORKSPACE_TRANSFER_FORMAT ||
    record.version !== 1 ||
    !safeText(record.exportedAt, 64) ||
    !Array.isArray(record.items) ||
    record.items.length > MAX_ITEMS
  ) {
    return null;
  }

  const items: PortableWorkspaceItem[] = [];
  for (const candidate of record.items) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return null;
    }
    const item = candidate as Record<string, unknown>;
    const groupKey = safeText(item.groupKey, 256);
    const groupLabel = safeText(item.groupLabel, 80);
    const definitionId = safeText(item.definitionId, 64);
    const label = safeText(item.label, 80);
    const executable = safeText(item.executable, 4096);
    const workingDirectory = safeText(item.workingDirectory, 4096);
    if (!Array.isArray(item.launchArguments)) return null;
    const launchArguments = item.launchArguments.map(safeArgument);
    if (
      !groupKey ||
      !groupLabel ||
      !definitionId ||
      !label ||
      !executable ||
      !workingDirectory ||
      launchArguments.length > MAX_ARGUMENTS ||
      launchArguments.some((argument) => argument === null)
    ) {
      return null;
    }
    items.push({
      groupKey,
      groupLabel,
      definitionId,
      label,
      executable,
      launchArguments: launchArguments as string[],
      workingDirectory,
    });
  }

  const sidebar = sanitizeSessionSidebarLayout(record.sidebar);
  if (!sidebar) return null;
  return {
    format: WORKSPACE_TRANSFER_FORMAT,
    version: 1,
    exportedAt: record.exportedAt as string,
    items,
    sidebar: portableSidebar(sidebar),
  };
}
