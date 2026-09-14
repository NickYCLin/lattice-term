/** Persistent, non-secret organization for the live-session sidebar. */

export const SESSION_SIDEBAR_LAYOUT_KEY = "latticeterm.sessionSidebar.v1";

// The shared tree can contain both legacy sidebars at their previous limits.
const MAX_FOLDERS = 128;
const MAX_NODES = 1024;
const MAX_ID_BYTES = 1024;
const MAX_FOLDER_NAME_BYTES = 80;

export interface SessionSidebarFolder {
  id: string;
  name: string;
}

export interface SessionSidebarPlacement {
  parentId: string | null;
  order: number;
}

export interface SessionSidebarLayout {
  version: 1;
  folders: SessionSidebarFolder[];
  placements: Record<string, SessionSidebarPlacement>;
  collapsedFolderIds: string[];
}

export interface LiveSessionSidebarNode {
  id: string;
  defaultParentId: string | null;
}

export interface SessionSidebarStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export const emptySessionSidebarLayout: SessionSidebarLayout = {
  version: 1,
  folders: [],
  placements: {},
  collapsedFolderIds: [],
};

function safeText(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (
    !trimmed ||
    new TextEncoder().encode(trimmed).length > maxBytes ||
    Array.from(trimmed).some((character) => /[\u0000-\u001f\u007f]/.test(character))
  ) {
    return null;
  }
  return trimmed;
}

function safeId(value: unknown): string | null {
  return safeText(value, MAX_ID_BYTES);
}

export function sanitizeSessionSidebarLayout(
  value: unknown,
): SessionSidebarLayout | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    !Array.isArray(record.folders) ||
    !record.placements ||
    typeof record.placements !== "object" ||
    Array.isArray(record.placements) ||
    !Array.isArray(record.collapsedFolderIds) ||
    record.folders.length > MAX_FOLDERS ||
    Object.keys(record.placements as object).length > MAX_NODES
  ) {
    return null;
  }

  const folders: SessionSidebarFolder[] = [];
  const folderIds = new Set<string>();
  for (const candidate of record.folders) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return null;
    }
    const folder = candidate as Record<string, unknown>;
    const id = safeId(folder.id);
    const name = safeText(folder.name, MAX_FOLDER_NAME_BYTES);
    if (!id?.startsWith("folder:") || !name || folderIds.has(id)) return null;
    folderIds.add(id);
    folders.push({ id, name });
  }

  const placements: Record<string, SessionSidebarPlacement> = {};
  for (const [rawId, candidate] of Object.entries(
    record.placements as Record<string, unknown>,
  )) {
    const id = safeId(rawId);
    if (!id || !candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return null;
    }
    const placement = candidate as Record<string, unknown>;
    const parentId = placement.parentId === null ? null : safeId(placement.parentId);
    const order = Number(placement.order);
    if (
      (placement.parentId !== null && !parentId) ||
      !Number.isSafeInteger(order) ||
      order < 0 ||
      order > MAX_NODES
    ) {
      return null;
    }
    placements[id] = { parentId, order };
  }

  const collapsedFolderIds = record.collapsedFolderIds.map(safeId);
  if (collapsedFolderIds.some((id) => !id)) return null;

  return {
    version: 1,
    folders,
    placements,
    // The field name is retained for v1 compatibility, but project branches
    // are collapsible too. Reconciliation below removes projects that no
    // longer exist in the live workspace.
    collapsedFolderIds: [...new Set(collapsedFolderIds as string[])].filter(
      (id) => folderIds.has(id) || id.startsWith("project:"),
    ),
  };
}

export function loadSessionSidebarLayout(
  storage: Pick<SessionSidebarStorage, "getItem">,
  key: string = SESSION_SIDEBAR_LAYOUT_KEY,
): SessionSidebarLayout {
  try {
    const raw = storage.getItem(key);
    if (!raw) return emptySessionSidebarLayout;
    return sanitizeSessionSidebarLayout(JSON.parse(raw)) ?? emptySessionSidebarLayout;
  } catch {
    return emptySessionSidebarLayout;
  }
}

export function saveSessionSidebarLayout(
  storage: Pick<SessionSidebarStorage, "setItem">,
  layout: SessionSidebarLayout,
  key: string = SESSION_SIDEBAR_LAYOUT_KEY,
) {
  storage.setItem(key, JSON.stringify(layout));
}

function wouldCreateCycle(
  placements: Record<string, SessionSidebarPlacement>,
  nodeId: string,
  parentId: string | null,
): boolean {
  let cursor = parentId;
  const visited = new Set<string>();
  while (cursor) {
    if (cursor === nodeId) return true;
    if (visited.has(cursor)) return true;
    visited.add(cursor);
    cursor = placements[cursor]?.parentId ?? null;
  }
  return false;
}

function reindexPlacements(
  placements: Record<string, SessionSidebarPlacement>,
): Record<string, SessionSidebarPlacement> {
  const result = Object.fromEntries(
    Object.entries(placements).map(([id, placement]) => [id, { ...placement }]),
  );
  const parents = new Set<string | null>(
    Object.values(result).map((placement) => placement.parentId),
  );
  for (const parentId of parents) {
    Object.entries(result)
      .filter(([, placement]) => placement.parentId === parentId)
      .sort(
        ([leftId, left], [rightId, right]) =>
          left.order - right.order || leftId.localeCompare(rightId),
      )
      .forEach(([id], order) => {
        result[id].order = order;
      });
  }
  return result;
}

/**
 * Reconciles saved organization with live projects/sessions. Restored nodes
 * retain their saved placement while their CLI process is being recreated, so
 * asynchronous startup cannot flatten the sidebar before they appear.
 */
export function reconcileSessionSidebarLayout(
  layout: SessionSidebarLayout,
  liveNodes: readonly LiveSessionSidebarNode[],
  restoredNodes: readonly LiveSessionSidebarNode[] = [],
): SessionSidebarLayout {
  const folderIds = new Set(layout.folders.map((folder) => folder.id));
  // A restored session can take time to start, especially when several CLIs
  // resume in sequence. Keep its stable sidebar identity until the live
  // session replaces it; live data wins if the two disagree.
  const nodesById = new Map<string, LiveSessionSidebarNode>();
  for (const node of restoredNodes) nodesById.set(node.id, node);
  for (const node of liveNodes) nodesById.set(node.id, node);
  const knownNodes = [...nodesById.values()];
  const knownIds = new Set([
    ...folderIds,
    ...knownNodes.map((node) => node.id),
  ]);
  const placements: Record<string, SessionSidebarPlacement> = {};

  for (const id of knownIds) {
    const saved = layout.placements[id];
    const fallback = nodesById.get(id)?.defaultParentId ?? null;
    // `null` is a deliberate top-level placement. Nullish coalescing would
    // mistake it for a missing value and put the node back under its default
    // project every time the layout is reconciled.
    const parentId = saved ? saved.parentId : fallback;
    placements[id] = {
      parentId: parentId && knownIds.has(parentId) && parentId !== id ? parentId : null,
      order: saved?.order ?? MAX_NODES,
    };
  }

  // A malformed or stale parent chain must never hide the affected node.
  for (const id of knownIds) {
    if (wouldCreateCycle(placements, id, placements[id].parentId)) {
      placements[id].parentId = null;
    }
  }

  // Preserve the discovery order for newly seen projects and sessions.
  const nextOrder = new Map<string | null, number>();
  for (const placement of Object.values(placements)) {
    if (placement.order < MAX_NODES) {
      nextOrder.set(
        placement.parentId,
        Math.max(nextOrder.get(placement.parentId) ?? 0, placement.order + 1),
      );
    }
  }
  for (const node of knownNodes) {
    if (layout.placements[node.id]) continue;
    const placement = placements[node.id];
    placement.order = nextOrder.get(placement.parentId) ?? 0;
    nextOrder.set(placement.parentId, placement.order + 1);
  }
  for (const folder of layout.folders) {
    if (layout.placements[folder.id]) continue;
    const placement = placements[folder.id];
    placement.order = nextOrder.get(placement.parentId) ?? 0;
    nextOrder.set(placement.parentId, placement.order + 1);
  }

  const projectIds = new Set(
    knownNodes
      .map((node) => node.id)
      .filter((id) => id.startsWith("project:")),
  );

  return {
    version: 1,
    folders: [...layout.folders],
    placements: reindexPlacements(placements),
    collapsedFolderIds: layout.collapsedFolderIds.filter(
      (id) => folderIds.has(id) || projectIds.has(id),
    ),
  };
}

/**
 * Gives a restored session the same sidebar identity even when the backend
 * necessarily creates a new process/session id after an application restart.
 */
export function sessionSidebarSessionNodeId(
  kind: string,
  runtimeSessionId: string,
  persistentSessionId: string | null,
): string {
  return `session:${kind}:${persistentSessionId || runtimeSessionId}`;
}

export function sessionSidebarChildren(
  layout: SessionSidebarLayout,
  parentId: string | null,
): string[] {
  return Object.entries(layout.placements)
    .filter(([, placement]) => placement.parentId === parentId)
    .sort(
      ([leftId, left], [rightId, right]) =>
        left.order - right.order || leftId.localeCompare(rightId),
    )
    .map(([id]) => id);
}

export interface SessionSidebarDropPlacement {
  parentId: string | null;
  beforeNodeId: string | null;
}

/**
 * Resolves the layout destination for a pointer drop. Container rows receive
 * the node as a child; ordinary rows use their upper/lower half to insert the
 * node before or after the target without losing the surrounding order.
 */
export function sessionSidebarDropPlacement(
  layout: SessionSidebarLayout,
  sourceNodeId: string,
  targetNodeId: string,
  targetIsContainer: boolean,
  placeAfter: boolean,
): SessionSidebarDropPlacement | null {
  if (
    sourceNodeId === targetNodeId ||
    !layout.placements[sourceNodeId] ||
    !layout.placements[targetNodeId]
  ) {
    return null;
  }
  if (targetIsContainer) {
    return { parentId: targetNodeId, beforeNodeId: null };
  }

  const parentId = layout.placements[targetNodeId].parentId;
  const siblings = sessionSidebarChildren(layout, parentId).filter(
    (id) => id !== sourceNodeId,
  );
  const targetIndex = siblings.indexOf(targetNodeId);
  if (targetIndex < 0) return null;
  return {
    parentId,
    beforeNodeId: placeAfter ? siblings[targetIndex + 1] ?? null : targetNodeId,
  };
}

export function createSessionSidebarFolder(
  layout: SessionSidebarLayout,
  folder: SessionSidebarFolder,
  parentId: string | null,
): SessionSidebarLayout {
  const name = safeText(folder.name, MAX_FOLDER_NAME_BYTES);
  if (
    !folder.id.startsWith("folder:") ||
    !safeId(folder.id) ||
    !name ||
    layout.folders.length >= MAX_FOLDERS ||
    Object.keys(layout.placements).length >= MAX_NODES ||
    layout.placements[folder.id]
  ) {
    return layout;
  }
  const order = sessionSidebarChildren(layout, parentId).length;
  return {
    ...layout,
    folders: [...layout.folders, { id: folder.id, name }],
    placements: {
      ...layout.placements,
      [folder.id]: { parentId, order },
    },
  };
}

export function renameSessionSidebarFolder(
  layout: SessionSidebarLayout,
  folderId: string,
  name: string,
): SessionSidebarLayout {
  const safeName = safeText(name, MAX_FOLDER_NAME_BYTES);
  if (!safeName || !layout.folders.some((folder) => folder.id === folderId)) {
    return layout;
  }
  return {
    ...layout,
    folders: layout.folders.map((folder) =>
      folder.id === folderId ? { ...folder, name: safeName } : folder,
    ),
  };
}

export function removeSessionSidebarFolder(
  layout: SessionSidebarLayout,
  folderId: string,
): SessionSidebarLayout {
  if (!layout.folders.some((folder) => folder.id === folderId)) return layout;
  const parentId = layout.placements[folderId]?.parentId ?? null;
  const placements = Object.fromEntries(
    Object.entries(layout.placements)
      .filter(([id]) => id !== folderId)
      .map(([id, placement]) => [
        id,
        placement.parentId === folderId ? { ...placement, parentId } : { ...placement },
      ]),
  );
  return {
    version: 1,
    folders: layout.folders.filter((folder) => folder.id !== folderId),
    placements: reindexPlacements(placements),
    collapsedFolderIds: layout.collapsedFolderIds.filter((id) => id !== folderId),
  };
}

export function moveSessionSidebarNode(
  layout: SessionSidebarLayout,
  nodeId: string,
  parentId: string | null,
  beforeNodeId: string | null = null,
): SessionSidebarLayout {
  if (!layout.placements[nodeId]) return layout;
  if (parentId && !layout.placements[parentId]) return layout;
  if (beforeNodeId && !layout.placements[beforeNodeId]) return layout;
  if (wouldCreateCycle(layout.placements, nodeId, parentId)) return layout;

  const placements = Object.fromEntries(
    Object.entries(layout.placements).map(([id, placement]) => [id, { ...placement }]),
  );
  placements[nodeId].parentId = parentId;
  const siblings = sessionSidebarChildren(
    { ...layout, placements },
    parentId,
  ).filter((id) => id !== nodeId);
  const targetIndex = beforeNodeId ? siblings.indexOf(beforeNodeId) : -1;
  siblings.splice(targetIndex >= 0 ? targetIndex : siblings.length, 0, nodeId);
  siblings.forEach((id, order) => {
    placements[id].order = order;
  });

  return { ...layout, placements: reindexPlacements(placements) };
}

export function toggleSessionSidebarFolder(
  layout: SessionSidebarLayout,
  folderId: string,
): SessionSidebarLayout {
  const collapsed = new Set(layout.collapsedFolderIds);
  if (collapsed.has(folderId)) collapsed.delete(folderId);
  else collapsed.add(folderId);
  return { ...layout, collapsedFolderIds: [...collapsed] };
}

/**
 * Reveals a node by expanding every collapsed ancestor, custom folders and
 * project branches alike. A search hit or a drop into a collapsed branch must
 * never leave the affected row invisible.
 */
export function expandSessionSidebarAncestors(
  layout: SessionSidebarLayout,
  nodeId: string,
): SessionSidebarLayout {
  const ancestors = new Set<string>();
  const visited = new Set<string>([nodeId]);
  let cursor = layout.placements[nodeId]?.parentId ?? null;
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    ancestors.add(cursor);
    cursor = layout.placements[cursor]?.parentId ?? null;
  }
  const collapsedFolderIds = layout.collapsedFolderIds.filter(
    (id) => !ancestors.has(id),
  );
  return collapsedFolderIds.length === layout.collapsedFolderIds.length
    ? layout
    : { ...layout, collapsedFolderIds };
}

/**
 * Adds portable folders and placements without rearranging anything already
 * organized on this computer. Imported node ids fill only missing positions.
 */
export function mergeSessionSidebarLayouts(
  current: SessionSidebarLayout,
  incoming: SessionSidebarLayout,
): SessionSidebarLayout {
  const folders = [...current.folders];
  const folderIds = new Set(folders.map((folder) => folder.id));
  for (const folder of incoming.folders) {
    if (folderIds.has(folder.id) || folders.length >= MAX_FOLDERS) continue;
    folders.push(folder);
    folderIds.add(folder.id);
  }

  const placements = Object.fromEntries(
    Object.entries(current.placements).map(([id, placement]) => [
      id,
      { ...placement },
    ]),
  );
  for (const [id, placement] of Object.entries(incoming.placements)) {
    if (Object.keys(placements).length >= MAX_NODES) break;
    if (placements[id] || (id.startsWith("folder:") && !folderIds.has(id))) {
      continue;
    }
    placements[id] = { ...placement };
  }

  const merged = sanitizeSessionSidebarLayout({
    version: 1,
    folders,
    placements,
    collapsedFolderIds: [
      ...current.collapsedFolderIds,
      ...incoming.collapsedFolderIds,
    ],
  });
  return merged ?? current;
}
