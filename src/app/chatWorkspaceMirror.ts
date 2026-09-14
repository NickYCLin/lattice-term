/** Read-only projection of live Agent sessions into the conversation sidebar. */

import { displayPath } from "./displayPath";
import {
  agentSessionSidebarMemberNodeId,
  presentAgentSessionGroup,
} from "./agentSessionPresentation";
import {
  reconcileSessionSidebarLayout,
  sessionSidebarChildren,
  type SessionSidebarLayout,
} from "./sessionSidebarLayout";
import {
  agentGroupSidebarStatus,
  type SessionSidebarStatus,
} from "./sessionStatus";
import type { AgentDefinition, AgentSessionSummary } from "./useAgentSessions";

export type ChatWorkspaceMirrorRow =
  | {
      kind: "folder" | "project";
      nodeId: string;
      label: string;
      depth: number;
      collapsed: boolean;
      hasChildren: boolean;
    }
  | {
      kind: "session";
      nodeId: string;
      sessionId: string;
      label: string;
      detail: string | null;
      depth: number;
      status: SessionSidebarStatus;
    };

export function agentWorkspaceProjectNodeId(workingDirectory: string): string {
  return `project:local:${displayPath(workingDirectory).toLocaleLowerCase()}`;
}

function directoryName(path: string, fallback: string): string {
  const plain = displayPath(path).replace(/[\\/]+$/, "");
  if (!plain) return fallback;
  const segments = plain.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? fallback;
}

/**
 * Uses the same stable project, folder and session node ids as Work Sessions.
 * It never writes the workspace layout, so merely opening Conversations cannot
 * rearrange or discard session data that belongs to another connection type.
 */
export function chatWorkspaceMirrorRows(
  savedLayout: SessionSidebarLayout,
  sessions: readonly AgentSessionSummary[],
  definitions: readonly Pick<AgentDefinition, "id" | "label">[],
  generalProjectLabel: string,
  collapsedNodeIds: ReadonlySet<string> = new Set(
    savedLayout.collapsedFolderIds,
  ),
): ChatWorkspaceMirrorRow[] {
  const groups: { groupId: string; members: AgentSessionSummary[] }[] = [];
  const groupIndex = new Map<string, number>();
  for (const session of sessions) {
    const groupId = session.groupId || session.sessionId;
    const existing = groupIndex.get(groupId);
    if (existing === undefined) {
      groupIndex.set(groupId, groups.length);
      groups.push({ groupId, members: [session] });
    } else {
      groups[existing].members.push(session);
    }
  }

  const projects = new Map<
    string,
    { label: string; sessionNodeIds: string[] }
  >();
  const sessionRows = new Map<
    string,
    Omit<Extract<ChatWorkspaceMirrorRow, { kind: "session" }>, "depth">
  >();
  for (const group of groups) {
    const workingDirectory = group.members[0]?.workingDirectory ?? "";
    const projectNodeId = agentWorkspaceProjectNodeId(workingDirectory);
    const project = projects.get(projectNodeId) ?? {
      label: directoryName(workingDirectory, generalProjectLabel),
      sessionNodeIds: [],
    };
    const presentation = presentAgentSessionGroup(
      group.members,
      definitions,
      group.members[0].sessionId,
    );
    group.members.forEach((member, memberIndex) => {
      const nodeId = agentSessionSidebarMemberNodeId(
        group.groupId,
        group.members,
        memberIndex,
      );
      const definitionLabel =
        definitions.find((definition) => definition.id === member.definitionId)
          ?.label ?? member.definitionId;
      const memberLabel = member.label.trim() || definitionLabel;
      sessionRows.set(nodeId, {
        kind: "session",
        nodeId,
        sessionId: member.sessionId,
        label: presentation.hasCustomGroupLabel
          ? `${presentation.groupLabel} · ${memberLabel}`
          : memberLabel,
        detail: member.model,
        status: agentGroupSidebarStatus([member]),
      });
      project.sessionNodeIds.push(nodeId);
    });
    projects.set(projectNodeId, project);
  }

  const liveNodes = [
    ...[...projects.keys()].map((id) => ({ id, defaultParentId: null })),
    ...[...projects.entries()].flatMap(([projectId, project]) =>
      project.sessionNodeIds.map((id) => ({ id, defaultParentId: projectId })),
    ),
  ];
  const layout = reconcileSessionSidebarLayout(savedLayout, liveNodes);
  const folders = new Map(layout.folders.map((folder) => [folder.id, folder.name]));
  const rows: ChatWorkspaceMirrorRow[] = [];

  const walk = (parentId: string | null, depth: number) => {
    for (const nodeId of sessionSidebarChildren(layout, parentId)) {
      const folderName = folders.get(nodeId);
      const project = projects.get(nodeId);
      if (folderName !== undefined || project) {
        const children = sessionSidebarChildren(layout, nodeId);
        const collapsed = collapsedNodeIds.has(nodeId);
        rows.push({
          kind: folderName !== undefined ? "folder" : "project",
          nodeId,
          label: folderName ?? project!.label,
          depth,
          collapsed,
          hasChildren: children.length > 0,
        });
        if (!collapsed) walk(nodeId, depth + 1);
        continue;
      }
      const session = sessionRows.get(nodeId);
      if (session) rows.push({ ...session, depth });
    }
  };
  walk(null, 0);
  return rows;
}
