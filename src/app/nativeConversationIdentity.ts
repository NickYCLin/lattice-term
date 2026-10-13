import type { ChatAccountProfile } from "./chatAccountProfiles";
import { chatProjectKey } from "./chatProjects";
import type { AgentSessionSummary } from "./useAgentSessions";

export function conversationPathKey(path: string) {
  const plain = chatProjectKey(path);
  const normalized = plain.replace(/\\/g, "/");
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : plain;
}

export function nativeConversationIdentity(profiles: readonly ChatAccountProfile[]) {
  const profilePaths = new Map(profiles.map(profile => [JSON.stringify([profile.definitionId, profile.id]), conversationPathKey(profile.configDirectory)]));
  return {
    conversation(entry: { definitionId: string; profileId: string | null; nativeSessionId: string }) {
      const configPath = entry.profileId === null ? "" : profilePaths.get(JSON.stringify([entry.definitionId, entry.profileId]));
      return configPath === undefined || (entry.profileId !== null && !configPath)
        ? null : JSON.stringify([entry.definitionId, configPath, entry.nativeSessionId]);
    },
    session(session: Pick<AgentSessionSummary, "definitionId" | "capturedSessionId" | "profileConfigPath">) {
      return session.capturedSessionId
        ? JSON.stringify([session.definitionId, conversationPathKey(session.profileConfigPath ?? ""), session.capturedSessionId]) : null;
    },
  };
}
