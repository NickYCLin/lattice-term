import { useEffect, useRef } from "react";
import type { AgentChatApi } from "./useAgentChat";
import { loadChatAccountProfiles } from "./chatAccountProfiles";
import type { RemoteHostStatus } from "./useRemoteHost";
import { performRemoteChat, type RemoteChatRequest } from "./remoteChat";
import { hasDesktopBackend } from "./nativeRuntime";

export function useRemoteChatHost(chat: AgentChatApi, host: RemoteHostStatus | null) {
  const current = useRef({ chat, host });
  current.current = { chat, host };
  useEffect(() => {
    if (!hasDesktopBackend()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let queue = Promise.resolve();
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const dispose = await listen<{ hostId: string; request: RemoteChatRequest }>("remote-host://chat", ({ payload }) => {
        queue = queue.then(async () => {
          const context = current.current;
          if (cancelled || !context.host?.chat || context.host.hostId !== payload.hostId) return;
          let value: unknown = null;
          let error: string | null = null;
          try { value = await performRemoteChat(context.chat, loadChatAccountProfiles(localStorage), payload.request.operation); }
          catch (problem) { error = String(problem).slice(0, 250); }
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("remote_chat_reply", { hostId: payload.hostId, response: { id: payload.request.id, value, error } });
        }).catch(() => undefined);
      });
      if (cancelled) dispose(); else unlisten = dispose;
    }).catch(() => undefined);
    return () => { cancelled = true; unlisten?.(); };
  }, []);
}
