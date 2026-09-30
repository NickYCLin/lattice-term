import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { visibleTerminalText, type AgentApi } from "./useAgentSessions";

export interface SessionConversationMessage {
  role: "user" | "assistant";
  text: string;
}

/** One reader and the existing prompt queue, both addressed to the same PTY. */
export function useSessionConversation(sessionId: string, agents: AgentApi) {
  const [messages, setMessages] = useState<SessionConversationMessage[]>([]);
  const [readError, setReadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [slow, setSlow] = useState(false);
  const [output, setOutput] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [queued, setQueued] = useState<number | null>(null);
  const sendingRef = useRef(false);

  const { onOutputTail } = agents;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let latest = "";
    setOutput("");
    const unsubscribe = onOutputTail(sessionId, text => {
      latest = text;
      timer ??= setTimeout(() => {
        timer = undefined;
        setOutput(visibleTerminalText(latest).replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
      }, 100);
    });
    return () => { unsubscribe(); clearTimeout(timer); };
  }, [sessionId, onOutputTail]);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    setMessages([]);
    setReadError(null);
    setLoading(true);
    setSlow(false);
    const slowTimer = setTimeout(() => { if (!disposed) setSlow(true); }, 8000);
    async function read() {
      try {
        const next = await invoke<SessionConversationMessage[]>("agent_session_conversation", { sessionId });
        if (!disposed) { setMessages(next); setReadError(null); }
      } catch (reason) {
        if (!disposed) setReadError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (!disposed) { setLoading(false); setSlow(false); clearTimeout(slowTimer); }
        // Schedule after completion so slow disk reads never overlap.
        if (!disposed) timer = setTimeout(() => void read(), 2000);
      }
    }
    void read();
    return () => { disposed = true; clearTimeout(timer); clearTimeout(slowTimer); };
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
  const acknowledge = useCallback(() => setQueued(null), []);
  return { messages, readError, loading, slow, output, sendError, sending, queued, send, acknowledge };
}
