import { useNativeConversations } from "./useNativeConversations";
import type { AgentApi } from "./useAgentSessions";
import type { SavedAgentSession, SavedWorkspaceSession } from "./workspaceSessionPersistence";

export const AUTO_LOCAL_CONVERSATIONS_KEY = "latticeterm.autoLocalConversations.v1";

/** Kept for callers migrating from auto-open. Sync must never execute saved launch intents. */
export function useAutomaticLocalConversations(
  agents: AgentApi, ready: boolean, _pending: readonly SavedWorkspaceSession[],
  _queue: (entries: readonly SavedAgentSession[]) => void, _retry?: (entry: SavedAgentSession) => Promise<unknown>,
) {
  return useNativeConversations(ready && agents.mode === "ready");
}
