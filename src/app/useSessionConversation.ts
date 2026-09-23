import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import type { AgentApi } from "./useAgentSessions";

export interface SessionConversationMessage {
  role: "user" | "assistant";
  text: string;
}

/** One reader and the existing prompt queue, both addressed to the same PTY. */
export function useSessionConversation(sessionId: string, agents: AgentApi) {
  const [messages, setMessages] = useState<SessionConversationMessage[]>([]);
  const [readError, setReadError] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [queued, setQueued] = useState<number | null>(null);
  const sendingRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    setMessages([]);
    setReadError(false);
    async function read() {
      try {
        const next = await invoke<SessionConversationMessage[]>("agent_session_conversation", { sessionId });
        if (!disposed) { setMessages(next); setReadError(false); }
      } catch {
        if (!disposed) setReadError(true);
      } finally {
        // Schedule after completion so slow disk reads never overlap.
        if (!disposed) timer = setTimeout(() => void read(), 2000);
      }
    }
    void read();
    return () => { disposed = true; clearTimeout(timer); };
  }, [sessionId]);

  async function send(text: string): Promise<boolean> {
    if (!text.trim() || sendingRef.current) return false;
    sendingRef.current = true;
    setSending(true);
    setSendError(null);
    setQueued(null);
    try {
      const count = await agents.enqueue(sessionId, text);
      setQueued(count);
      return true;
    } catch (reason) {
      setSendError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }
  return { messages, readError, sendError, sending, queued, send };
}
