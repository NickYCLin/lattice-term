import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { recordSessionSubmission, reconcileSessionSubmissions, sessionSubmittedPrompts, subscribeSessionSubmissions } from "./sessionSubmittedPrompts";
import { MAX_AGENT_OUTPUT_TAIL, type AgentApi } from "./useAgentSessions";
import { renderTerminalPreview } from "./terminalPreview";
import { initialSessionMessages, sessionMessageReducer } from "./sessionMessageIdentity";

export interface SessionConversationMessage {
  record?:import("./nativeRecords").NativeRecord;
  nativeTurnId?: string;
  nativeMessageId?: string;
  role: "user" | "assistant";
  text: string;
  /** Local rendering identity; never sent to the CLI or persisted in its history. */
  renderId?: number;
  tool?: { callId: string; name: string | null; kind: "call" | "result" | "reasoning" };
}

export interface SessionConversationSnapshot {
  diagnostics?: import("./nativeReadDiagnostics").NativeReadDiagnostics;
  nativeCommandPending?: boolean;
  nativeTools?: boolean;
  progress?: { contextUsage: import("./chatRuntimeStatus").ContextUsage | null; rateLimits: import("./chatRuntimeStatus").RateLimitWindow[]; plan: import("./chatRuntimeStatus").PlanStep[]; goal: import("./chatRuntimeStatus").GoalState | null };
  availability: "waitingForIdentity" | "waitingForTranscript" | "ready";
  messages: SessionConversationMessage[];
  truncated: boolean;
}

/** A permission prompt the CLI shows in its terminal right now. */
export interface SessionApprovalRequest {
  requestId: string;
  toolName: string;
  summary: string;
  canAllowSession?: boolean;
}

/** One reader and the existing prompt queue, both addressed to the same PTY. */
export function useSessionConversation(sessionId: string, agents: AgentApi, readTerminalOutput = true) {
  const selectedSession = useRef(sessionId);
  selectedSession.current = sessionId;
  const submitted = useSyncExternalStore(subscribeSessionSubmissions,
    () => sessionSubmittedPrompts(sessionId), () => sessionSubmittedPrompts(sessionId));
  const nativeSessionId = agents.sessions.find(session => session.sessionId === sessionId)?.capturedSessionId ?? null;
  const inFlightReads = useRef(new Map<string, Promise<SessionConversationSnapshot>>());
  const [history, dispatchMessages] = useReducer(sessionMessageReducer, initialSessionMessages);
  const messages = history.messages;
  const [availability, setAvailability] = useState<SessionConversationSnapshot["availability"]>("waitingForIdentity");
  const [goal, setGoal] = useState<import("./chatRuntimeStatus").GoalState | null>(null);
  const [nativeTools, setNativeTools] = useState(false);
  const [nativeCommandPending, setNativeCommandPending] = useState(false);
  const [progress, setProgress] = useState<SessionConversationSnapshot["progress"]>();
  const [diagnostics, setDiagnostics] = useState<import("./nativeReadDiagnostics").NativeReadDiagnostics>();
  const readIdentity = useRef<string | null>(null);
  const [readRevision, setReadRevision] = useState(0);
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
  const answeringRef = useRef(false);
  const approvalRef = useRef<SessionApprovalRequest | null>(null);
  const approvalRevision = useRef(0);

  // A prompt is short-lived and may be answered in the terminal at any
  // moment, so it is read more often than the transcript.
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    approvalRef.current = null;
    setApproval(null);
    setAnswerError(null);
    async function read() {
      const revision = approvalRevision.current;
      try {
        const next = await invoke<SessionApprovalRequest | null>("agent_session_approval", { sessionId });
        if (!disposed && revision === approvalRevision.current) {
          if (approvalRef.current?.requestId !== next?.requestId) setAnswerError(null);
          approvalRef.current = next ?? null;
          setApproval((current) => current?.requestId === next?.requestId ? current : next ?? null);
        }
      } catch {
        if (!disposed && revision === approvalRevision.current) { approvalRef.current = null; setApproval(null); }
      } finally {
        if (!disposed) timer = setTimeout(() => void read(), 1000);
      }
    }
    void read();
    return () => { disposed = true; clearTimeout(timer); };
  }, [sessionId]);

  async function answer(allow: boolean, allowForSession = false): Promise<void> {
    if (!approval || answeringRef.current || approvalRef.current?.requestId !== approval.requestId) return;
    if (allowForSession && (!allow || !approval.canAllowSession)) { setAnswerError("This approval does not expose session scope."); return; }
    answeringRef.current = true;
    setAnswering(true);
    setAnswerError(null);
    const isCurrent = () => selectedSession.current === sessionId
      && approvalRef.current?.requestId === approval.requestId;
    try {
      const accepted = await invoke<boolean>("agent_answer_approval", {
        sessionId, requestId: approval.requestId, allow, ...(allowForSession ? { allowForSession: true } : {}),
      });
      if (isCurrent()) {
        approvalRevision.current += 1;
        if (!accepted) setAnswerError("answered-elsewhere");
        approvalRef.current = null;
        setApproval(null);
      }
    } catch (reason) {
      if (isCurrent()) setAnswerError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      answeringRef.current = false;
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
    if (!readTerminalOutput) return;
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
  }, [sessionId, onOutputTail, readTerminalOutput]);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const identity = JSON.stringify([sessionId, nativeSessionId]);
    if (readIdentity.current !== identity) {
      dispatchMessages({ kind: "reset" }); readIdentity.current = identity;
      setAvailability(nativeSessionId ? "waitingForTranscript" : "waitingForIdentity");
      setTruncated(false); setDiagnostics(undefined);
      setProgress(undefined);
      setNativeTools(false);
      setNativeCommandPending(false);
    }
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
          dispatchMessages({ kind: "snapshot", messages: next.messages });
          reconcileSessionSubmissions(sessionId, next.messages);
          setAvailability(next.availability);
          setTruncated(next.truncated); setDiagnostics(next.diagnostics);
          setProgress(next.progress);
          setNativeTools(next.nativeTools === true);
          setNativeCommandPending(next.nativeCommandPending === true);
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
  }, [sessionId, nativeSessionId, readRevision]);

  const definitionId = agents.sessions.find(session => session.sessionId === sessionId)?.definitionId;
  useEffect(() => {
    let disposed = false; let timer: ReturnType<typeof setTimeout> | undefined;
    setGoal(null);
    if (!nativeSessionId || definitionId !== "codex") return;
    async function readGoal() {
      try {
        const next = await invoke<import("./chatRuntimeStatus").GoalState | null>("agent_session_goal", { sessionId, expectedNativeId: nativeSessionId });
        if (!disposed) setGoal(next);
      } catch { if (!disposed) setGoal(null); }
      finally { if (!disposed) timer = setTimeout(() => { void readGoal(); }, 30000); }
    }
    void readGoal();
    return () => { disposed = true; if (timer) clearTimeout(timer); };
  }, [sessionId, nativeSessionId, definitionId]);

  async function send(text: string): Promise<boolean> {
    if (!text.trim() || sendingRef.current) return false;
    sendingRef.current = true;
    setSending(true);
    setSendError(null);
    setQueued(null);
    try {
      const count = await agents.enqueue(sessionId, text);
      recordSessionSubmission(sessionId, text, messages);
      if (selectedSession.current === sessionId) setQueued(count);
      return true;
    } catch (reason) {
      if (selectedSession.current === sessionId) setSendError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      sendingRef.current = false;
      if (selectedSession.current === sessionId) setSending(false);
    }
  }
  const acknowledge = useCallback(() => setQueued(null), []);
  return {
    diagnostics, refresh: () => setReadRevision(value => value + 1),
    messages, submitted, availability, nativeTools, nativeCommandPending, progress: progress ? { ...progress, goal } : goal ? { contextUsage: null, rateLimits: [], plan: [], goal } : undefined, truncated, readError, loading, slow, output, outputError, sendError, sending, queued, send, acknowledge,
    approval, answering, answerError, answer,
  };
}
