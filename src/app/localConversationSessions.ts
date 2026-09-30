import type { ChatAccountProfile } from "./chatAccountProfiles";
import { displayPath } from "./displayPath";
import type { AgentDefinition, AgentSessionSummary } from "./useAgentSessions";
import type { SavedAgentSession, SavedWorkspaceSession } from "./workspaceSessionPersistence";
import { cliProxyLaunchArguments, type CliProxyEndpoint } from "./cliProxyApi";

export interface LocalConversation {
  definitionId: "codex" | "claude";
  profileId: string | null;
  nativeSessionId: string;
  workingDirectory: string;
  resumable: boolean;
  title: string;
  updatedAt: number;
  modelProvider?: string | null;
  archived?: boolean;
  titleSource?: "nativeIndex" | "firstMessage";
}

export function isProxyConversation(entry: LocalConversation): boolean {
  return entry.definitionId === "codex" && /^latticeterm_cliproxyapi(?:_[a-z0-9_]+)?$/.test(entry.modelProvider ?? "");
}

export function nativeConversationProxy(entry: LocalConversation, proxies: readonly CliProxyEndpoint[]) {
  const id = /^latticeterm_cliproxyapi_v2_([a-z0-9]{1,32})_[a-f0-9]{32}$/.exec(entry.modelProvider ?? "")?.[1];
  return id ? proxies.find(proxy => proxy.id === id) : undefined;
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
  liveOnly = false,
) {
  const profile = entry.profileId === null ? null : profiles.find(profile =>
    profile.id === entry.profileId && profile.definitionId === entry.definitionId);
  if (entry.profileId !== null && !profile) return undefined;
  return sessions.find(session => (!liveOnly || !session.closedReason) && session.definitionId === entry.definitionId &&
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
  proxies: readonly CliProxyEndpoint[] = [],
  selectedProxy?: CliProxyEndpoint,
): SavedAgentSession[] {
  const result: SavedAgentSession[] = [];
  for (const entry of entries) {
    if (entry.archived || !entry.resumable) continue;
    const proxy = isProxyConversation(entry) ? selectedProxy ?? nativeConversationProxy(entry, proxies) : undefined;
    // Old random provider names contain no routing information. Let the user
    // choose rather than sending history to a guessed endpoint.
    if (isProxyConversation(entry) && !proxy) continue;
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
      launchArguments: proxy ? cliProxyLaunchArguments(proxy.baseUrl, proxy.id) : [],
      workingDirectory: displayPath(entry.workingDirectory),
      resumeSessionId: entry.nativeSessionId,
      ...(config ? { profileConfigPath: config } : {}),
    });
  }
  return result;
}
