import type { ChatAccountProfile } from "./chatAccountProfiles";
import { displayPath } from "./displayPath";
import type { AgentDefinition, AgentSessionSummary } from "./useAgentSessions";
import type { SavedAgentSession, SavedWorkspaceSession } from "./workspaceSessionPersistence";

export interface LocalConversation {
  definitionId: "codex" | "claude";
  profileId: string | null;
  nativeSessionId: string;
  workingDirectory: string;
  resumable: boolean;
  title: string;
  updatedAt: number;
}

function pathKey(path: string | null | undefined) {
  const plain = displayPath(path ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(plain) || plain.startsWith("//") ? plain.toLowerCase() : plain;
}

function savedLabel(text: string): string {
  let label = "";
  for (const character of text.replace(/[\u0000-\u001f\u007f]/g, " ").trim()) {
    if (new TextEncoder().encode(label + character).length > 80) break;
    label += character;
  }
  return label;
}

function conversationGroupKey(entry: LocalConversation): string {
  return `native:${entry.definitionId}:${entry.profileId ?? "default"}:${entry.nativeSessionId}`;
}

export function conversationSession(
  entry: LocalConversation,
  profiles: readonly ChatAccountProfile[],
  sessions: readonly AgentSessionSummary[],
) {
  const profile = entry.profileId === null ? null : profiles.find(profile =>
    profile.id === entry.profileId && profile.definitionId === entry.definitionId);
  if (entry.profileId !== null && !profile) return undefined;
  return sessions.find(session => session.definitionId === entry.definitionId &&
    (session.capturedSessionId === entry.nativeSessionId ||
      (session.capturedSessionId === null && session.groupId === conversationGroupKey(entry))) &&
    pathKey(session.profileConfigPath) === pathKey(profile?.configDirectory));
}

export function localConversationLaunchIntents(
  entries: readonly LocalConversation[],
  profiles: readonly ChatAccountProfile[],
  catalog: readonly AgentDefinition[],
  live: readonly AgentSessionSummary[],
  pending: readonly SavedWorkspaceSession[],
): SavedAgentSession[] {
  const result: SavedAgentSession[] = [];
  for (const entry of entries) {
    const definition = catalog.find(item => item.id === entry.definitionId);
    const profile = entry.profileId === null ? null : profiles.find(item =>
      item.id === entry.profileId && item.definitionId === entry.definitionId);
    if (!definition || (entry.profileId !== null && !profile) ||
      conversationSession(entry, profiles, live)) continue;
    const config = profile?.configDirectory;
    if ([...pending, ...result].some(item => item.kind === "agent" &&
      item.definitionId === entry.definitionId && item.resumeSessionId === entry.nativeSessionId &&
      pathKey(item.profileConfigPath) === pathKey(config))) continue;
    // Stable identity before a process exists also prevents duplicate imports
    // while its native conversation id is still being captured.
    const groupKey = conversationGroupKey(entry);
    result.push({
      kind: "agent", groupKey, groupLabel: savedLabel(entry.title) || definition.label,
      definitionId: entry.definitionId, label: definition.label,
      executable: definition.installedPath || definition.executable,
      launchArguments: [], workingDirectory: displayPath(entry.workingDirectory),
      resumeSessionId: entry.nativeSessionId,
      ...(config ? { profileConfigPath: config } : {}),
    });
  }
  return result;
}
