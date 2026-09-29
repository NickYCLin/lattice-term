import { agentSessionSidebarMemberNodeId } from "./agentSessionPresentation";
import type { SessionSidebarSessionItem } from "../components/sessions/SessionProjectSidebar";
import type { SavedAgentSession, SavedWorkspaceSession } from "./workspaceSessionPersistence";

const SAVED_PREFIX = "saved:";

/**
 * Sidebar rows for conversations kept but not started (over the concurrent
 * limit, a failed start, or an imported history), grouped by project so a
 * restored folder is never shown empty. Node ids are the ones each keeps
 * once it starts, so a row stays where the user put it.
 */
export function savedAgentSidebarItems(
  pending: readonly SavedWorkspaceSession[],
  projectIdFor: (workingDirectory: string) => string,
  detail: (assistant: string) => string,
) {
  const byProject = new Map<string, SessionSidebarSessionItem[]>();
  const byId = new Map<string, SavedAgentSession>();
  const groups = new Map<string, SavedAgentSession[]>();
  for (const entry of pending) {
    if (entry.kind !== "agent") continue;
    const group = groups.get(entry.groupKey) ?? [];
    group.push(entry);
    groups.set(entry.groupKey, group);
  }
  for (const [groupKey, members] of groups) {
    const identities = members.map((member) => ({ ...member, sessionId: groupKey }));
    members.forEach((member, memberIndex) => {
      const nodeId = agentSessionSidebarMemberNodeId(groupKey, identities, memberIndex);
      const sessionId = `${SAVED_PREFIX}${nodeId}`;
      byId.set(sessionId, member);
      const projectId = projectIdFor(member.workingDirectory);
      const items = byProject.get(projectId) ?? [];
      items.push({
        nodeId,
        sessionId,
        label: member.groupLabel || member.label,
        detail: detail(member.label),
        kind: "agent",
        searchText: [member.groupLabel, member.label, member.definitionId].join(" "),
        status: "saved",
      });
      byProject.set(projectId, items);
    });
  }
  return { byProject, byId };
}
