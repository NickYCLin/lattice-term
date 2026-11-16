import { projectDirectoryKey, disambiguateProjectLabels, type ProjectDirectoryKey } from "./projectDirectory";
import type { ChatThread } from "./agentChat";
import { presentAgentSessionGroup } from "./agentSessionPresentation";
import type { ChatAccountProfile } from "./chatAccountProfiles";
import type { CliProxyEndpoint } from "./cliProxyApi";
import { projectName } from "./chatProjects";
import { chatSidebarLayout, chatThreadNodeId } from "./chatThreadLayout";
import type { SessionSidebarLayout } from "./sessionSidebarLayout";
import { agentWorkspaceProjectNodeId, chatWorkspaceProjection } from "./chatWorkspaceNodes";
import { displayPath } from "./displayPath";
import { conversationLabels } from "./conversationLabels";
import type { LocalConversation } from "./localConversationSessions";
import { nativeConversationKey } from "./nativeConversationDismissals";
import { nativeConversationIdentity } from "./nativeConversationIdentity";
import type { AgentDefinition, AgentSessionSummary } from "./useAgentSessions";

export function nativeConversationNodeId(entry: { definitionId: string; profileId: string | null; nativeSessionId: string }) {
  return "native:" + nativeConversationKey(entry);
}

export function reconcileProjectChatLayout(layout: SessionSidebarLayout, threads: readonly ChatThread[]): SessionSidebarLayout {
  const { workspace } = chatConversationSidebar({
    sessions: [], definitions: [], threads: threads.map(thread => thread.shelvedAt ? { ...thread, shelvedAt: null } : thread),
    history: [], profiles: [], generalProjectLabel: "", projectFilter: null,
  });
  return chatSidebarLayout(layout, threads, workspace.nodes);
}

export function chatConversationSidebar({ sessions, definitions, threads, history, profiles, proxies = [], generalProjectLabel, projectFilter, directoryKey = projectDirectoryKey }: {
  sessions: readonly AgentSessionSummary[];
  definitions: readonly Pick<AgentDefinition, "id" | "label">[];
  threads: readonly ChatThread[];
  history: readonly LocalConversation[];
  profiles: readonly ChatAccountProfile[];
  proxies?: readonly CliProxyEndpoint[];
  generalProjectLabel: string;
  projectFilter: string | null;
  directoryKey?: ProjectDirectoryKey;
}) {
  const { conversation: conversationIdentity, session: sessionIdentity } = nativeConversationIdentity(profiles);
  const references = threads.flatMap(thread => !thread.remote && thread.nativeSessionId ? [{
    definitionId: thread.definitionId, profileId: thread.accountProfileId ?? null,
    nativeSessionId: thread.nativeSessionId, title: thread.title,
    modelProvider: thread.reportedProvider,
  }] : []);
  const known = new Set(references.map(nativeConversationKey));
  const visibleHistory = history.filter(entry => !entry.archived);
  const knownSessions = new Set([...references, ...visibleHistory].map(conversationIdentity).filter(identity => identity !== null));
  const matchesFilter = (directory: string) => projectFilter === null || directoryKey(directory) === directoryKey(projectFilter);
  const visibleSessions = sessions.filter(session => matchesFilter(session.workingDirectory) &&
    (!session.closedReason || !knownSessions.has(sessionIdentity(session) ?? "")));
  const sessionsByIdentity = new Map<string, AgentSessionSummary>();
  const groupMembers = new Map<string, AgentSessionSummary[]>();
  for (const session of visibleSessions) {
    const identity = sessionIdentity(session);
    if (identity) sessionsByIdentity.set(identity, session);
    const groupId = session.groupId || session.sessionId;
    const members = groupMembers.get(groupId) ?? [];
    members.push(session);
    groupMembers.set(groupId, members);
  }
  const workspace = chatWorkspaceProjection(visibleSessions, definitions, generalProjectLabel, proxies, directoryKey);
  const leavesBySession = new Map([...workspace.sessions.values()].map(leaf => [leaf.sessionId, leaf]));
  const projectIds = new Map<string, string>();
  for (const members of groupMembers.values()) {
    const directory = members[0].workingDirectory;
    projectIds.set(directoryKey(directory), agentWorkspaceProjectNodeId(directory, directoryKey));
  }
  const projectFor = (directory: string) => {
    const key = directoryKey(directory);
    const existing = projectIds.get(key);
    if (existing) return existing;
    const nodeId = agentWorkspaceProjectNodeId(directory, directoryKey);
    projectIds.set(key, nodeId);
    workspace.projects.set(nodeId, projectName(displayPath(directory)) || generalProjectLabel);
    workspace.nodes.push({ id: nodeId, defaultParentId: null });
    return nodeId;
  };
  const titledSessions = new Set<string>();
  for (const entry of [...visibleHistory, ...references]) {
    const held = sessionsByIdentity.get(conversationIdentity(entry) ?? "");
    if (!held) continue;
    const leaf = leavesBySession.get(held.sessionId);
    if (leaf?.metadata && !leaf.metadata.provider && entry.modelProvider) {
      leaf.metadata = { ...leaf.metadata, provider: conversationLabels({ definitionId: held.definitionId,
        provider: entry.modelProvider, endpoint: leaf.metadata.endpoint }).provider };
    }
    if (!entry.title.trim()) continue;
    const members = groupMembers.get(held.groupId || held.sessionId)!;
    const presentation = presentAgentSessionGroup(members, definitions, held.sessionId);
    if (leaf && !presentation.hasCustomGroupLabel && !titledSessions.has(held.sessionId)) {
      leaf.label = entry.title;
      titledSessions.add(held.sessionId);
    }
  }
  const nativeConversations = new Map<string, LocalConversation>();
  for (const entry of visibleHistory) {
    if (!matchesFilter(entry.workingDirectory) || known.has(nativeConversationKey(entry)) ||
      sessionsByIdentity.has(conversationIdentity(entry) ?? "")) continue;
    const nodeId = nativeConversationNodeId(entry);
    if (nativeConversations.has(nodeId)) continue;
    nativeConversations.set(nodeId, entry);
    workspace.nodes.push({ id: nodeId, defaultParentId: projectFor(entry.workingDirectory) });
  }
  const listedThreads = threads.filter(thread => !thread.shelvedAt && matchesFilter(thread.workingDirectory) &&
    (thread.remote || !thread.nativeSessionId || !sessionsByIdentity.has(conversationIdentity({
      definitionId: thread.definitionId, profileId: thread.accountProfileId ?? null, nativeSessionId: thread.nativeSessionId,
    }) ?? "")));
  for (const thread of listedThreads) {
    if (thread.workingDirectory) workspace.nodes.push({ id: chatThreadNodeId(thread.id), defaultParentId: projectFor(thread.workingDirectory) });
  }
  const labels = disambiguateProjectLabels([...projectIds].map(([directory, id]) => ({id, label:workspace.projects.get(id) ?? "", workingDirectory:directory})));
  for (const project of labels) workspace.projects.set(project.id, project.label);
  return { workspace: { ...workspace, nativeConversations }, listedThreads };
}
