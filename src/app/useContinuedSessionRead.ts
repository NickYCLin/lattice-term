import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatThread } from "./agentChat";
import type { ChatAccountProfile } from "./chatAccountProfiles";
import type { AgentChatApi } from "./useAgentChat";
import type { NativeMessageSnapshot } from "./useNativeConversations";
import { appendSessionTurns } from "./chatSessionHandoff";

export function useContinuedSessionRead(thread: ChatThread | null, live: boolean,
  profiles: readonly ChatAccountProfile[], update: AgentChatApi["updateThreadFromSession"], notice: string, missingSession: string) {
  const [read, setRead] = useState<{ key: string; loading: boolean; error: string | null } | null>(null);
  const [retry, setRetry] = useState(0);
  const latest = useRef({ thread, profiles, update });
  latest.current = { thread, profiles, update };
  const key = thread?.continuedInSession && !live
    ? JSON.stringify([thread.id, thread.nativeSessionId, thread.accountProfileId,
      profiles.map(({ id, definitionId, configDirectory }) => [id, definitionId, configDirectory])]) : null;
  useEffect(() => {
    if (!key) return;
    const source = latest.current;
    const selected = source.thread!;
    if (!selected.nativeSessionId) {
      setRead({ key, loading: false, error: missingSession });
      return;
    }
    let cancelled = false;
    setRead({ key, loading: true, error: null });
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const snapshot = await invoke<NativeMessageSnapshot>("agent_chat_local_history_snapshot", {
          definitionId: selected.definitionId, nativeSessionId: selected.nativeSessionId,
          profileId: selected.accountProfileId,
          profiles: source.profiles.map(({ id, definitionId, configDirectory }) => ({ profileId: id, definitionId, configDirectory })),
        });
        if (cancelled) return;
        latest.current.update(selected.id, current => appendSessionTurns(current, snapshot, notice));
        setRead({ key, loading: false, error: null });
      } catch (reason) {
        if (!cancelled) setRead({ key, loading: false, error: String(reason) });
      }
    })();
    return () => { cancelled = true; };
  }, [key, retry, notice, missingSession]);
  const refresh = useCallback(() => setRetry(value => value + 1), []);
  return key ? { loading: read?.key === key ? read.loading : true, error: read?.key === key ? read.error : null, refresh } : null;
}
