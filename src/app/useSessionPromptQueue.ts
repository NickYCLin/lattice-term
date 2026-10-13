import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentApi, AgentQueuedPrompt } from "./useAgentSessions";
import { replaceSessionSubmission } from "./sessionSubmittedPrompts";

export function useSessionPromptQueue(sessionId: string, agents: AgentApi, enabled = true) {
  const [prompts, setPrompts] = useState<AgentQueuedPrompt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const generation = useRef(0);
  const readRevision = useRef(0);
  const saving = useRef(false);
  const active = useRef(sessionId);
  active.current = sessionId;
  const { readQueue, editQueuedPrompt } = agents;
  const refresh = useCallback(async () => {
    if (!enabled) return;
    const revision = generation.current;
    const request = ++readRevision.current;
    try {
      const next = await readQueue(sessionId);
      if (active.current === sessionId && revision === generation.current && request === readRevision.current) {
        setPrompts(next);
        setError(null);
      }
    } catch (reason) {
      if (active.current === sessionId && revision === generation.current && request === readRevision.current) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    }
  }, [readQueue, sessionId, enabled]);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    generation.current += 1;
    setPrompts([]);
    setError(null);
    setEditing(false);
    async function poll() {
      await refresh();
      if (!disposed) timer = setTimeout(() => void poll(), 1000);
    }
    if (enabled) void poll();
    return () => { disposed = true; generation.current += 1; clearTimeout(timer); };
  }, [refresh, enabled]);

  const save = async (prompt: AgentQueuedPrompt, text: string | null): Promise<boolean> => {
    if (saving.current) return false;
    saving.current = true;
    const revision = ++generation.current;
    setEditing(true);
    try {
      const changed = await editQueuedPrompt(sessionId, prompt, text);
      if (changed) replaceSessionSubmission(sessionId, prompt.text, text);
      if (active.current === sessionId && revision === generation.current) {
        await refresh();
        if (!changed && active.current === sessionId && revision === generation.current) setError("queue-message-changed");
      }
      return changed;
    } catch (reason) {
      if (active.current === sessionId && revision === generation.current) setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    } finally {
      saving.current = false;
      if (active.current === sessionId && revision === generation.current) setEditing(false);
    }
  };
  return { prompts, error, editing, refresh, save };
}
