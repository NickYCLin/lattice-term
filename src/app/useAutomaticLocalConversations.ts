import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { loadChatAccountProfiles } from "./chatAccountProfiles";
import { localConversationLaunchIntents, type LocalConversation } from "./localConversationSessions";
import type { AgentApi } from "./useAgentSessions";
import type { SavedAgentSession, SavedWorkspaceSession } from "./workspaceSessionPersistence";

export const AUTO_LOCAL_CONVERSATIONS_KEY = "latticeterm.autoLocalConversations.v1";

export function useAutomaticLocalConversations(
  agents: AgentApi,
  ready: boolean,
  pending: readonly SavedWorkspaceSession[],
  queue: (entries: readonly SavedAgentSession[]) => void,
  retry: (entry: SavedAgentSession) => Promise<void>,
) {
  const [enabled, setEnabled] = useState(() => {
    try { return window.localStorage.getItem(AUTO_LOCAL_CONVERSATIONS_KEY) === "true"; }
    catch { return false; }
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef({ agents, pending, queue, retry });
  latest.current = { agents, pending, queue, retry };
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const running = useRef(false);
  const scanned = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!enabled || !ready || agents.mode !== "ready" || running.current || scanned.current) return;
    running.current = true;
    scanned.current = true;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const profiles = loadChatAccountProfiles(window.localStorage);
        const entries = await invoke<LocalConversation[]>("agent_chat_local_history", {
          profiles: profiles.map(({ id, definitionId, configDirectory }) => ({ profileId: id, definitionId, configDirectory })),
          all: true,
        });
        if (!enabledRef.current || !mounted.current) return;
        const state = latest.current;
        const intents = localConversationLaunchIntents(entries, profiles,
          state.agents.catalog, state.agents.sessions, state.pending);
        // Store every intent before starting any process. Capacity, missing
        // paths, and CLI failures leave the item available in Recovery.
        state.queue(intents);
        for (const intent of intents) {
          if (!enabledRef.current || !mounted.current) break;
          await latest.current.retry(intent);
        }
      } catch (reason) {
        if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        running.current = false;
        if (mounted.current) setBusy(false);
      }
    })();
  }, [enabled, ready, agents.mode, busy]);

  function setAutoOpen(value: boolean) {
    try {
      window.localStorage.setItem(AUTO_LOCAL_CONVERSATIONS_KEY, String(value));
      enabledRef.current = value;
      scanned.current = false;
      setEnabled(value);
      setError(null);
    } catch (reason) { setError(String(reason)); }
  }
  return { enabled, busy, error, setAutoOpen };
}
