import type { SessionConversationMessage } from "./useSessionConversation";

export interface SessionSubmittedPrompt {
  id: number;
  text: string;
  occurrence: number;
}

const empty: SessionSubmittedPrompt[] = [];
const receipts = new Map<string, SessionSubmittedPrompt[]>();
const snapshots = new Map<string, SessionConversationMessage[]>();
const listeners = new Set<() => void>();
let nextId = 0;
const normalize = (text: string) => text.replace(/\r\n?/g, "\n").trimEnd();

export function sessionSubmittedPrompts(sessionId: string): SessionSubmittedPrompt[] {
  return receipts.get(sessionId) ?? empty;
}

export function subscribeSessionSubmissions(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function update(sessionId: string, prompts: SessionSubmittedPrompt[]) {
  if (prompts.length > 0) receipts.set(sessionId, prompts);
  else { receipts.delete(sessionId); snapshots.delete(sessionId); }
  for (const listener of listeners) listener();
}

export function recordSessionSubmission(sessionId: string, text: string, messages: SessionConversationMessage[]) {
  snapshots.set(sessionId, messages);
  const pending = sessionSubmittedPrompts(sessionId);
  const existing = messages.filter(message => message.role === "user" && normalize(message.text) === normalize(text)).length;
  const occurrence = Math.max(existing, ...pending.filter(prompt => normalize(prompt.text) === normalize(text)).map(prompt => prompt.occurrence)) + 1;
  update(sessionId, [...pending, { id: ++nextId, text, occurrence }]);
}

export function reconcileSessionSubmissions(sessionId: string, messages: SessionConversationMessage[]) {
  const pending = sessionSubmittedPrompts(sessionId);
  if (pending.length === 0) return;
  snapshots.set(sessionId, messages);
  const remaining = pending.filter(prompt => messages.filter(message => message.role === "user"
    && normalize(message.text) === normalize(prompt.text)).length < prompt.occurrence);
  if (remaining.length !== pending.length) update(sessionId, remaining);
}

export function replaceSessionSubmission(sessionId: string, previous: string, text: string | null) {
  const pending = sessionSubmittedPrompts(sessionId);
  const index = pending.findIndex(prompt => normalize(prompt.text) === normalize(previous));
  if (index < 0) return;
  const next = [...pending];
  if (text === null) next.splice(index, 1);
  else {
    const existing = (snapshots.get(sessionId) ?? []).filter(message => message.role === "user"
      && normalize(message.text) === normalize(text)).length;
    const occurrence = Math.max(existing, ...pending.filter((prompt, position) => position !== index
      && normalize(prompt.text) === normalize(text)).map(prompt => prompt.occurrence)) + 1;
    next[index] = { ...next[index], text, occurrence };
  }
  update(sessionId, next);
}

export function sessionSubmissionsNotQueued(submitted: SessionSubmittedPrompt[], queued: readonly { text: string }[]) {
  return submitted.filter((prompt, index) => {
    const remaining = submitted.slice(index).filter(candidate => normalize(candidate.text) === normalize(prompt.text)).length;
    const queuedCount = queued.filter(candidate => normalize(candidate.text) === normalize(prompt.text)).length;
    return remaining > queuedCount;
  });
}
