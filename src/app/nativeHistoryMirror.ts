import type { ChatItem, ChatThread, NativeHistoryMessage } from "./agentChat";
import { nativeHistoryItems } from "./agentChat";
import type { LocalConversation } from "./localConversationSessions";
import type { NativeMessageSnapshot } from "./useNativeConversations";

export function isNativeHistoryMirror(thread: ChatThread) {
  return Boolean(thread.nativeSessionId && !thread.archived && !thread.remote && !thread.continuedInSession);
}

function messageText(message: NativeHistoryMessage) {
  const text = message.text.replace(/\r\n/g, "\n").trim();
  const marker = "\n</latticeterm-handoff>\n\n<current-user-message>\n";
  const end = "\n</current-user-message>";
  const boundary = text.lastIndexOf(marker);
  return message.role === "user" && text.startsWith("<latticeterm-handoff>\n") && boundary >= 0 && text.endsWith(end)
    ? text.slice(boundary + marker.length, -end.length).trim() : text;
}

function sameMessage(left: NativeHistoryMessage, right: NativeHistoryMessage) {
  return left.role === right.role && messageText(left) === messageText(right);
}

export function nativeMessageTail(items: readonly ChatItem[], messages: readonly NativeHistoryMessage[]): number | null {
  const positions = messages.flatMap((message, index) => message.tool ? [] : [index]);
  const tail = textMessageTail(items, positions.map(index => messages[index]));
  return tail === null ? null : positions[tail - 1] + 1;
}

function textMessageTail(items: readonly ChatItem[], messages: readonly NativeHistoryMessage[]): number | null {
  const local = items.flatMap((item): NativeHistoryMessage[] => item.type === "user"
    ? [{ role: "user", text: item.text }]
    : item.type === "text" ? [{ role: "assistant", text: item.text }] : []);
  if (!local.length) return null;
  let bestCount = 0;
  let tail: number | null = null;
  let ambiguous = false;
  for (let end = 1; end <= messages.length; end++) {
    let count = 0;
    let hasUser = false;
    while (count < Math.min(local.length, end) && sameMessage(local[local.length - 1 - count], messages[end - 1 - count])) {
      hasUser ||= messages[end - 1 - count].role === "user";
      count++;
    }
    if (hasUser && count > bestCount && (count >= 2 || local.length === 1)) {
      bestCount = count;
      tail = end;
      ambiguous = false;
    } else if (count === bestCount && bestCount > 0 && hasUser) {
      ambiguous = true;
    }
  }
  if (tail !== null) return ambiguous ? null : tail;
  const lastUser = local.slice().reverse().find(message => message.role === "user");
  const lastMessage = local[local.length - 1];
  if (!lastUser || lastMessage.role !== "assistant") return null;
  const candidates: number[] = [];
  for (let start = 0; start < messages.length; start++) {
    if (!sameMessage(messages[start], lastUser)) continue;
    let end = start + 1;
    while (end < messages.length && messages[end].role !== "user") end++;
    if (end > start + 1 && sameMessage(messages[end - 1], lastMessage)) candidates.push(end);
  }
  return candidates.length === 1 ? candidates[0] : null;
}

export function refreshNativeHistoryMirror(thread: ChatThread, entry: LocalConversation, snapshot: NativeMessageSnapshot): ChatThread {
  if (!isNativeHistoryMirror(thread) || thread.runningTurnId || thread.pendingInputs?.length ||
    thread.definitionId !== entry.definitionId || thread.nativeSessionId !== entry.nativeSessionId ||
    thread.accountProfileId !== entry.profileId) return thread;
  const imported = thread.items.every(item => item.id.startsWith("history:") && (item.type === "user" || item.type === "text" || item.type === "tool"));
  const tail = imported ? 0 : nativeMessageTail(thread.items, snapshot.messages);
  if (!imported && tail === null) return thread.nativeSyncPending ? thread : { ...thread, nativeSyncPending: true };
  const added = tail === null ? [] : nativeHistoryItems(snapshot.messages.slice(tail), thread.createdAt,
    imported ? 0 : thread.items.reduce((offset, item) => item.id.startsWith("history:")
      && Number.isFinite(Number(item.id.slice(8)))
      ? Math.max(offset, Number(item.id.slice(8)) + 1) : offset, thread.items.length));
  const items = imported ? added : added.length ? [...thread.items] : thread.items;
  if (!imported) for (const item of added) {
    const existing = item.type === "tool" ? items.findIndex(old => old.id === item.id) : -1;
    const old = items[existing];
    if (existing >= 0 && old.type === "tool" && item.type === "tool") {
      items[existing] = { ...old, ...(item.summary ? { name: item.name, summary: item.summary } : {}),
        output: item.output ?? old.output };
    } else {
      items.push(item);
    }
  }
  const sameText = items === thread.items || items.length === thread.items.length && items.every((item, index) => {
    const old = thread.items[index];
    return JSON.stringify(old) === JSON.stringify(item);
  });
  const archived = snapshot.archived ?? entry.archived === true;
  if (sameText && !thread.nativeSyncPending && thread.title === entry.title && Boolean(thread.nativeHistoryArchived) === archived &&
    Boolean(thread.historyTruncated) === snapshot.truncated) return thread;
  return { ...thread, items: sameText ? thread.items : items, title: entry.title,
    nativeHistorySource: imported || thread.nativeHistorySource, nativeHistoryArchived: archived, historyTruncated: snapshot.truncated, nativeSyncPending: false };
}
