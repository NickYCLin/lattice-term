/**
 * The conversation sidebar tree: named folders that nest, a placement per
 * node, and a shared collapsed set. Conversations and live Agent sessions are
 * the leaves of the same tree, because a person filing work into a folder
 * means the folder, not the kind of thing that ended up in it. A node the
 * layout has never seen lands at the top level in discovery order.
 */

import {
  reconcileSessionSidebarLayout,
  sessionSidebarChildren,
  type LiveSessionSidebarNode,
  type SessionSidebarLayout,
} from "./sessionSidebarLayout";
import type { ChatWorkspaceSession } from "./chatWorkspaceNodes";
import type { ChatThread } from "./agentChat";
import type { LocalConversation } from "./localConversationSessions";
import { nativeConversationKey } from "./nativeConversationDismissals";

/** Legacy migration source; new edits use sharedSidebarLayout. */
export const CHAT_SIDEBAR_LAYOUT_KEY = "latticeterm.chatSidebar.v1";

export function chatThreadNodeId(threadId: string): string {
  return `thread:${threadId}`;
}

export function chatFolderNodeId(id: string = crypto.randomUUID()): string {
  return `folder:${id}`;
}

/**
 * Drops placements of threads that no longer exist and seats new ones.
 * Session and project placements are carried over untouched: the Work
 * Sessions page owns them, and a conversation edit must not discard the
 * arrangement of a session that simply is not running right now.
 */
export function chatSidebarLayout(
  layout: SessionSidebarLayout,
  threads: readonly ChatThread[],
  workspaceNodes: readonly LiveSessionSidebarNode[] = [],
): SessionSidebarLayout {
  const placements = { ...layout.placements };
  for (const thread of threads) {
    const nodeId = chatThreadNodeId(thread.id);
    if (!thread.nativeSessionId || thread.remote) continue;
    const nativeId = "native:" + nativeConversationKey({ definitionId: thread.definitionId,
      profileId: thread.accountProfileId ?? null, nativeSessionId: thread.nativeSessionId });
    if (!placements[nodeId] && placements[nativeId]) placements[nodeId] = placements[nativeId];
    delete placements[nativeId];
  }
  return reconcileSessionSidebarLayout(
    { ...layout, placements },
    [
      ...Object.entries(placements)
        .filter(([id]) => !id.startsWith("thread:") && !id.startsWith("folder:"))
        .map(([id, placement]) => ({ id, defaultParentId: placement.parentId })),
      // Live data wins over the carried-over copy of the same node.
      ...workspaceNodes,
      ...threads.map((thread) => ({ id: chatThreadNodeId(thread.id),
        defaultParentId: workspaceNodes.find(node => node.id === chatThreadNodeId(thread.id))?.defaultParentId ?? null })),
    ],
  );
}

export function reconcileChatLayout(
  layout: SessionSidebarLayout,
  threads: readonly ChatThread[],
): SessionSidebarLayout {
  return chatSidebarLayout(layout, threads);
}

interface ChatSidebarBranch {
  nodeId: string;
  name: string;
  depth: number;
  collapsed: boolean;
  empty: boolean;
}

export type ChatSidebarRow =
  | ({ kind: "folder" } & ChatSidebarBranch)
  | ({ kind: "project" } & ChatSidebarBranch)
  | { kind: "thread"; nodeId: string; thread: ChatThread; depth: number }
  | { kind: "native"; nodeId: string; conversation: LocalConversation; depth: number }
  | { kind: "session"; nodeId: string; session: ChatWorkspaceSession; depth: number };

export interface ChatSidebarWorkspace {
  projects: ReadonlyMap<string, string>;
  sessions: ReadonlyMap<string, ChatWorkspaceSession>;
  nativeConversations?: ReadonlyMap<string, LocalConversation>;
}

/**
 * The rows the sidebar shows, top to bottom, with collapsed branches left
 * out. Depth is how far to indent.
 */
export function chatSidebarRows(
  layout: SessionSidebarLayout,
  threads: readonly ChatThread[],
  workspace?: ChatSidebarWorkspace,
): ChatSidebarRow[] {
  const threadsByNode = new Map(threads.map((thread) => [chatThreadNodeId(thread.id), thread]));
  const folderNames = new Map(layout.folders.map((folder) => [folder.id, folder.name]));
  const collapsed = new Set(layout.collapsedFolderIds);
  const walk = (parentId: string | null, depth: number): ChatSidebarRow[] => {
    const rows: ChatSidebarRow[] = [];
    for (const nodeId of sessionSidebarChildren(layout, parentId)) {
      const isCollapsed = collapsed.has(nodeId);
      const folderName = folderNames.get(nodeId);
      if (folderName !== undefined) {
        const inside = walk(nodeId, depth + 1);
        rows.push({
          kind: "folder",
          nodeId,
          name: folderName,
          depth,
          collapsed: isCollapsed,
          empty: sessionSidebarChildren(layout, nodeId).length === 0,
        });
        if (!isCollapsed) rows.push(...inside);
        continue;
      }
      const projectName = workspace?.projects.get(nodeId);
      if (projectName !== undefined) {
        const inside = walk(nodeId, depth + 1);
        if (inside.length === 0) continue;
        rows.push({ kind: "project", nodeId, name: projectName, depth, collapsed: isCollapsed, empty: false });
        if (!isCollapsed) rows.push(...inside);
        continue;
      }
      const thread = threadsByNode.get(nodeId);
      if (thread) {
        rows.push({ kind: "thread", nodeId, thread, depth });
        continue;
      }
      const session = workspace?.sessions.get(nodeId);
      if (session) rows.push({ kind: "session", nodeId, session, depth });
      const conversation = workspace?.nativeConversations?.get(nodeId);
      if (conversation) rows.push({ kind: "native", nodeId, conversation, depth });
      // A node nobody can show — a stale project, or a session that stopped
      // — still lets whatever sits inside it through.
      if (!session && !conversation) rows.push(...walk(nodeId, depth));
    }
    return rows;
  };
  return walk(null, 0);
}
