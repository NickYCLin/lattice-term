/**
 * Chat projection of the shared session/chat tree: named folders that nest,
 * a placement per node, and a shared collapsed set.
 * Threads are the leaves; a thread that the layout has never seen lands at
 * the top level in discovery order.
 */

import {
  reconcileSessionSidebarLayout,
  sessionSidebarChildren,
  type SessionSidebarLayout,
} from "./sessionSidebarLayout";
import type { ChatThread } from "./agentChat";

/** Legacy migration source; new edits use sharedSidebarLayout. */
export const CHAT_SIDEBAR_LAYOUT_KEY = "latticeterm.chatSidebar.v1";

export function chatThreadNodeId(threadId: string): string {
  return `thread:${threadId}`;
}

export function chatFolderNodeId(id: string = crypto.randomUUID()): string {
  return `folder:${id}`;
}

/** Drops placements of threads that no longer exist and seats new ones. */
export function reconcileChatLayout(
  layout: SessionSidebarLayout,
  threads: readonly ChatThread[],
): SessionSidebarLayout {
  return reconcileSessionSidebarLayout(
    layout,
    [
      ...Object.entries(layout.placements)
        .filter(([id]) => !id.startsWith("thread:") && !id.startsWith("folder:"))
        .map(([id, placement]) => ({ id, defaultParentId: placement.parentId })),
      ...threads.map((thread) => ({ id: chatThreadNodeId(thread.id), defaultParentId: null })),
    ],
  );
}

export type ChatSidebarRow =
  | { kind: "folder"; nodeId: string; name: string; depth: number; collapsed: boolean; empty: boolean }
  | { kind: "thread"; nodeId: string; thread: ChatThread; depth: number };

/**
 * The rows the sidebar shows, top to bottom, with collapsed branches left
 * out. Depth is how far to indent.
 */
export function chatSidebarRows(
  layout: SessionSidebarLayout,
  threads: readonly ChatThread[],
): ChatSidebarRow[] {
  const threadsByNode = new Map(threads.map((thread) => [chatThreadNodeId(thread.id), thread]));
  const folderNames = new Map(layout.folders.map((folder) => [folder.id, folder.name]));
  const collapsed = new Set(layout.collapsedFolderIds);
  const rows: ChatSidebarRow[] = [];

  const walk = (parentId: string | null, depth: number) => {
    for (const nodeId of sessionSidebarChildren(layout, parentId)) {
      const name = folderNames.get(nodeId);
      if (name !== undefined) {
        const isCollapsed = collapsed.has(nodeId);
        rows.push({
          kind: "folder",
          nodeId,
          name,
          depth,
          collapsed: isCollapsed,
          empty: sessionSidebarChildren(layout, nodeId).length === 0,
        });
        if (!isCollapsed) walk(nodeId, depth + 1);
        continue;
      }
      const thread = threadsByNode.get(nodeId);
      if (thread) rows.push({ kind: "thread", nodeId, thread, depth });
      else walk(nodeId, depth); // Project containers are transparent in the chat tree.
    }
  };
  walk(null, 0);
  return rows;
}
