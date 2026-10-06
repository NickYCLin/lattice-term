import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_AGENT_OUTPUT_TAIL, type AgentApi } from "./useAgentSessions";
import { renderTerminalPreview } from "./terminalPreview";

export interface SessionConversationMessage {
  role: "user" | "assistant";
  text: string;
  tool?: { callId: string; name: string | null; kind: "call" | "result" };
}

export interface SessionConversationSnapshot {
  availability: "waitingForIdentity" | "waitingForTranscript" | "ready";
  messages: SessionConversationMessage[];
  truncated: boolean;
}

/** A permission prompt the CLI shows in its terminal right now. */
export interface SessionApprovalRequest {
  requestId: string;
  toolName: string;
  summary: string;
}

/** One reader and the existing prompt queue, both addressed to the same PTY. */
export function useSessionConversation(sessionId: string, agents: AgentApi) {
  const nativeSessionId = agents.sessions.find(session => session.sessionId === sessionId)?.capturedSessionId ?? null;
  const inFlightReads = useRef(new Map<string, Promise<SessionConversationSnapshot>>());
  const [messages, setMessages] = useState<SessionConversationMessage[]>([]);
  const [availability, setAvailability] = useState<SessionConversationSnapshot["availability"]>("waitingForIdentity");
  const [truncated, setTruncated] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [slow, setSlow] = useState(false);
  const [output, setOutput] = useState("");
  const [outputError, setOutputError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [queued, setQueued] = useState<number | null>(null);
  const sendingRef = useRef(false);
  const [approval, setApproval] = useState<SessionApprovalRequest | null>(null);
  const [answering, setAnswering] = useState(false);
  const [answerError, setAnswerError] = useState<string | null>(null);

  // A prompt is short-lived and may be answered in the terminal at any
  // moment, so it is read more often than the transcript.
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    setApproval(null);
    async function read() {
      try {
        const next = await invoke<SessionApprovalRequest | null>("agent_session_approval", { sessionId });
        if (!disposed) setApproval((current) =>
          current?.requestId === next?.requestId ? current : next ?? null);
      } catch {
        if (!disposed) setApproval(null);
      } finally {
        if (!disposed) timer = setTimeout(() => void read(), 1000);
      }
    }
    void read();
    return () => { disposed = true; clearTimeout(timer); };
  }, [sessionId]);

  async function answer(allow: boolean): Promise<void> {
    if (!approval || answering) return;
    setAnswering(true);
    setAnswerError(null);
    try {
      const accepted = await invoke<boolean>("agent_answer_approval", {
        sessionId, requestId: approval.requestId, allow,
      });
      if (!accepted) setAnswerError("answered-elsewhere");
      setApproval(null);
    } catch (reason) {
      setAnswerError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAnswering(false);
    }
  }

  const { onOutputTail } = agents;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let latest = "";
    let revision = 0;
    let disposed = false;
    setOutput("");
    setOutputError(null);
    const unsubscribe = onOutputTail(sessionId, text => {
      latest = text;
      revision += 1;
      timer ??= setTimeout(() => {
        timer = undefined;
        const rendering = revision;
        void renderTerminalPreview(latest, latest.length >= MAX_AGENT_OUTPUT_TAIL).then(
          preview => {
            if (!disposed && rendering === revision) {
              setOutput(preview);
              setOutputError(null);
            }
          },
          reason => {
            if (!disposed && rendering === revision) {
              setOutputError(reason instanceof Error ? reason.message : String(reason));
            }
          },
        );
      }, 100);
    });
    return () => { disposed = true; unsubscribe(); clearTimeout(timer); };
  }, [sessionId, onOutputTail]);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    setMessages([]);
    setAvailability(nativeSessionId ? "waitingForTranscript" : "waitingForIdentity");
    setTruncated(false);
    setReadError(null);
    setLoading(true);
    setSlow(false);
    const slowTimer = setTimeout(() => { if (!disposed) setSlow(true); }, 8000);
    async function read() {
      try {
        const previous = inFlightReads.current.get(sessionId);
        if (previous) await previous.catch(() => undefined);
        if (disposed) return;
        const pending = invoke<SessionConversationSnapshot>("agent_session_conversation_snapshot", { sessionId });
        inFlightReads.current.set(sessionId, pending);
        const next = await pending.finally(() => {
          if (inFlightReads.current.get(sessionId) === pending) inFlightReads.current.delete(sessionId);
        });
        if (!disposed) {
          setMessages(next.messages);
          setAvailability(next.availability);
          setTruncated(next.truncated);
          setReadError(null);
        }
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
  }, [sessionId, nativeSessionId]);

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
  return {
    messages, availability, truncated, readError, loading, slow, output, outputError, sendError, sending, queued, send, acknowledge,
    approval, answering, answerError, answer,
  };
}
