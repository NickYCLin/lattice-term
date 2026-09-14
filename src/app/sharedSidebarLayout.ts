import { useSyncExternalStore } from "react";
import {
  emptySessionSidebarLayout,
  loadSessionSidebarLayout,
  reconcileSessionSidebarLayout,
  sanitizeSessionSidebarLayout,
  SESSION_SIDEBAR_LAYOUT_KEY,
  type LiveSessionSidebarNode,
  type SessionSidebarLayout,
} from "./sessionSidebarLayout";

export const SHARED_SIDEBAR_LAYOUT_KEY = "latticeterm.sharedSidebar.v1";
const LEGACY_CHAT_KEY = "latticeterm.chatSidebar.v1";
const listeners = new Set<() => void>();

/** Keep both legacy trees, including same-name folders and conflicting IDs. */
export function migrateSidebarLayouts(sessions: SessionSidebarLayout, chat: SessionSidebarLayout): SessionSidebarLayout {
  const ids = new Set(Object.keys(sessions.placements).concat(sessions.folders.map(folder => folder.id)));
  const remap = new Map<string, string>();
  for (const folder of chat.folders) {
    let id = folder.id;
    let suffix = 0;
    while (ids.has(id)) id = `folder:chat-import-${suffix++}`;
    ids.add(id);
    remap.set(folder.id, id);
  }
  const map = (id: string) => remap.get(id) ?? id;
  return {
    version: 1,
    folders: [...sessions.folders, ...chat.folders.map(folder => ({ ...folder, id: map(folder.id) }))],
    placements: {
      ...sessions.placements,
      ...Object.fromEntries(Object.entries(chat.placements).map(([id, placement]) => [map(id), {
        ...placement, parentId: placement.parentId ? map(placement.parentId) : null,
      }])),
    },
    collapsedFolderIds: [...new Set([...sessions.collapsedFolderIds, ...chat.collapsedFolderIds.map(map)])],
  };
}

let signature: string | undefined;
let snapshot = emptySessionSidebarLayout;
export function readSharedSidebarLayout(): SessionSidebarLayout {
  if (typeof localStorage === "undefined") return snapshot;
  try {
    const raw = localStorage.getItem(SHARED_SIDEBAR_LAYOUT_KEY);
    const nextSignature = raw ?? JSON.stringify([
      localStorage.getItem(SESSION_SIDEBAR_LAYOUT_KEY), localStorage.getItem(LEGACY_CHAT_KEY),
    ]);
    if (nextSignature !== signature) {
      snapshot = raw
        ? sanitizeSessionSidebarLayout(JSON.parse(raw)) ?? emptySessionSidebarLayout
        : migrateSidebarLayouts(loadSessionSidebarLayout(localStorage), loadSessionSidebarLayout(localStorage, LEGACY_CHAT_KEY));
      signature = nextSignature;
    }
  } catch { /* Keep the last readable layout if storage becomes unavailable. */ }
  return snapshot;
}

export function updateSharedSidebarLayout(update: SessionSidebarLayout | ((current: SessionSidebarLayout) => SessionSidebarLayout)) {
  const current = readSharedSidebarLayout();
  const next = typeof update === "function" ? update(current) : update;
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  const serialized = JSON.stringify(next);
  // Storage failure must not interrupt a running conversation. Keep edits
  // shared in memory while leaving the last durable copy untouched.
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(SHARED_SIDEBAR_LAYOUT_KEY, serialized);
    signature = serialized;
  } catch { /* Same-window updates remain available until the app closes. */ }
  snapshot = next;
  listeners.forEach(notify => notify());
}
export function subscribeSharedSidebarLayout(notify: () => void) {
  listeners.add(notify);
  if (typeof window !== "undefined") window.addEventListener?.("storage", notify);
  return () => {
    listeners.delete(notify);
    if (typeof window !== "undefined") window.removeEventListener?.("storage", notify);
  };
}
export function useSharedSidebarLayout() {
  return [useSyncExternalStore(subscribeSharedSidebarLayout, readSharedSidebarLayout, readSharedSidebarLayout), updateSharedSidebarLayout] as const;
}

/** A view can prune its own deleted leaves, never the other view's contents. */
export function reconcileSharedSessionLayout(layout: SessionSidebarLayout, live: readonly LiveSessionSidebarNode[], restored: readonly LiveSessionSidebarNode[] = []) {
  const threads = Object.entries(layout.placements)
    .filter(([id]) => id.startsWith("thread:"))
    .map(([id, placement]) => ({ id, defaultParentId: placement.parentId }));
  return reconcileSessionSidebarLayout(layout, live, [...restored, ...threads]);
}
