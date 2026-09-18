/** Live Agent sessions projected as leaves of the conversation sidebar tree. */

import { displayPath } from "./displayPath";
import {
  agentSessionSidebarMemberNodeId,
  presentAgentSessionGroup,
} from "./agentSessionPresentation";
import type { LiveSessionSidebarNode } from "./sessionSidebarLayout";
import {
  agentGroupSidebarStatus,
  type SessionSidebarStatus,
} from "./sessionStatus";
import type { AgentDefinition, AgentSessionSummary } from "./useAgentSessions";

export interface ChatWorkspaceSession {
  nodeId: string;
  sessionId: string;
  label: string;
  detail: string | null;
  status: SessionSidebarStatus;
}

export interface ChatWorkspaceProjection {
  /** Projects come first so their sessions can be seated underneath them. */
  nodes: LiveSessionSidebarNode[];
  projects: Map<string, string>;
  sessions: Map<string, ChatWorkspaceSession>;
}

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
 * Uses the same stable project, folder and session node ids as Work Sessions,
 * so a session keeps the place a person gave it whichever page they are on.
 */
export function chatWorkspaceProjection(
  sessions: readonly AgentSessionSummary[],
  definitions: readonly Pick<AgentDefinition, "id" | "label">[],
  generalProjectLabel: string,
): ChatWorkspaceProjection {
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

  const projects = new Map<string, string>();
  const projectMembers = new Map<string, string[]>();
  const sessionLeaves = new Map<string, ChatWorkspaceSession>();
  for (const group of groups) {
    const workingDirectory = group.members[0]?.workingDirectory ?? "";
    const projectNodeId = agentWorkspaceProjectNodeId(workingDirectory);
    if (!projects.has(projectNodeId)) {
      projects.set(projectNodeId, directoryName(workingDirectory, generalProjectLabel));
      projectMembers.set(projectNodeId, []);
    }
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
      sessionLeaves.set(nodeId, {
        nodeId,
        sessionId: member.sessionId,
        label: presentation.hasCustomGroupLabel
          ? `${presentation.groupLabel} · ${memberLabel}`
          : memberLabel,
        detail: member.model,
        status: agentGroupSidebarStatus([member]),
      });
      projectMembers.get(projectNodeId)!.push(nodeId);
    });
  }

  return {
    nodes: [
      ...[...projects.keys()].map((id) => ({ id, defaultParentId: null })),
      ...[...projectMembers.entries()].flatMap(([projectId, members]) =>
        members.map((id) => ({ id, defaultParentId: projectId })),
      ),
    ],
    projects,
    sessions: sessionLeaves,
  };
}
