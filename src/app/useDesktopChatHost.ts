import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { hasDesktopBackend } from "./nativeRuntime";
import { loadChatAccountProfiles } from "./chatAccountProfiles";
import { desktopChatAccess as access, chatIdentity, performDesktopChat, type DesktopChatRequest } from "./desktopChat";
import type { AgentChatApi } from "./useAgentChat";

export function useDesktopChatHost(chat: AgentChatApi) {
  const current = useRef(chat);
  current.current = chat;
  useEffect(() => {
    if (!hasDesktopBackend()) return;
    let stopped = false;
    let nonce: string | null = null;
    let dispose: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let queue = Promise.resolve();
    async function heartbeat() {
      if (stopped || !nonce) return;
      try {
        const ids = await invoke<string[]>("mcp_chat_heartbeat", { nonce });
        if (stopped) return;
        const profiles = loadChatAccountProfiles(localStorage);
        for (const [id, grant] of access.grants) {
          const thread = current.current.getThread(id);
          if (!ids.includes(grant.targetId) || !thread || chatIdentity(thread, profiles) !== grant.identity) {
            access.grants.delete(id); access.notify();
            await invoke("mcp_chat_share", { request: { nonce, threadId: id, label: "Chat", read: false, control: false } });
          }
        }
        timer = setTimeout(() => { void heartbeat(); }, 5000);
      } catch { access.reset(null); }
    }
    void (async () => {
      dispose = await listen<string>("mcp-chat://request", ({ payload }) => {
        queue = queue.then(async () => {
          if (stopped || !nonce || access.nonce !== nonce) return;
          const request = await invoke<DesktopChatRequest>("mcp_chat_claim", { nonce, id: payload });
          if (stopped || access.nonce !== nonce) return;
          let value: unknown = null;
          let error: string | null = null;
          try { value = await performDesktopChat(current.current, loadChatAccountProfiles(localStorage), request, access.grants.get(request.threadId), access.drafts.has(request.threadId)); }
          catch (problem) { error = problem instanceof Error ? problem.message.slice(0, 250) : "The conversation could not be accessed."; }
          if (!stopped) await invoke("mcp_chat_reply", { nonce, id: request.id, value, error });
        }).catch(() => undefined);
      });
      if (stopped) { dispose(); return; }
      nonce = await invoke<string>("mcp_chat_open");
      if (stopped) { await invoke("mcp_chat_close", { nonce }); return; }
      access.reset(nonce);
      await heartbeat();
    })().catch(() => { if (!stopped) access.reset(null); });
    return () => {
      stopped = true; dispose?.(); clearTimeout(timer);
      if (nonce) { if (access.nonce === nonce) access.reset(null); void invoke("mcp_chat_close", { nonce }).catch(() => undefined); }
    };
  }, []);
}
