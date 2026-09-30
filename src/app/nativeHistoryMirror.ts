import type { ChatThread } from "./agentChat";
import type { LocalConversation } from "./localConversationSessions";
import type { NativeMessageSnapshot } from "./useNativeConversations";

export function isNativeHistoryMirror(thread: ChatThread) {
  return Boolean(thread.nativeSessionId && !thread.archived && (thread.nativeHistorySource ||
    (thread.items.length > 0 && thread.items.every(item => item.id.startsWith("history:") && (item.type === "user" || item.type === "text")))));
}

/** Update only imported text mirrors. Never replace a local turn, queued prompt or tool output. */
export function refreshNativeHistoryMirror(thread: ChatThread, entry: LocalConversation, snapshot: NativeMessageSnapshot): ChatThread {
  if (!isNativeHistoryMirror(thread) || thread.runningTurnId || thread.pendingInputs?.length ||
    thread.definitionId !== entry.definitionId || thread.nativeSessionId !== entry.nativeSessionId ||
    thread.accountProfileId !== entry.profileId) return thread;
  // Once a mirror has been continued locally it contains rich items; those stay authoritative.
  if (thread.items.some(item => !item.id.startsWith("history:"))) return thread;
  const items = snapshot.messages.map((message, index) => message.role === "user"
    ? { type: "user" as const, id: `history:${index}`, text: message.text, at: thread.createdAt }
    : { type: "text" as const, id: `history:${index}`, text: message.text });
  const sameText = items.length === thread.items.length && items.every((item, index) => {
    const old = thread.items[index];
    return old.type === item.type && "text" in old && old.text === item.text;
  });
  const archived = snapshot.archived ?? entry.archived === true;
  if (sameText && thread.title === entry.title && Boolean(thread.nativeHistoryArchived) === archived &&
    Boolean(thread.historyTruncated) === snapshot.truncated) return thread;
  return { ...thread, items: sameText ? thread.items : items, title: entry.title,
    nativeHistorySource: true, nativeHistoryArchived: archived, historyTruncated: snapshot.truncated };
}
