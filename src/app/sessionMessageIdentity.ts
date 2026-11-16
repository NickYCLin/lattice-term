import { maskNativeValue } from "./nativeRecords";
import type { SessionConversationMessage } from "./useSessionConversation";

export interface SessionMessageState {
  messages: SessionConversationMessage[];
  nextId: number;
}

export const initialSessionMessages: SessionMessageState = { messages: [], nextId: 0 };

function identity(message: SessionConversationMessage): string {
  if (message.record) return message.record.id;
  if (message.tool) return JSON.stringify(["tool", message.tool.callId, message.tool.kind]);
  if (message.nativeMessageId) return JSON.stringify([message.role, message.nativeMessageId]);
  return JSON.stringify([message.role, message.nativeTurnId ?? null, message.text]);
}

/** Preserve DOM identity as the CLI's bounded history window moves forward. */
export function sessionMessageReducer(state: SessionMessageState, action:
  | { kind: "reset" }
  | { kind: "snapshot"; messages: SessionConversationMessage[] },
): SessionMessageState {
  if (action.kind === "reset") return { messages: [], nextId: state.nextId };
  const previous = state.messages;
  const retain = (old: SessionConversationMessage, next: SessionConversationMessage) =>
    JSON.stringify(old.record) === JSON.stringify(next.record) && old.role === next.role && old.text === next.text && old.nativeMessageId === next.nativeMessageId
      && old.nativeTurnId === next.nativeTurnId && old.tool?.kind === next.tool?.kind
      && old.tool?.callId === next.tool?.callId && (old.tool?.name ?? null) === (next.tool?.name ?? null)
      ? old : { ...next, renderId: old.renderId };
  const incoming = maskNativeValue(action.messages);
  const oldKeys = previous.map(identity);
  const newKeys = incoming.map(identity);
  const rows: (SessionConversationMessage | undefined)[] = Array(incoming.length);
  let start = 0;
  while (start < previous.length && start < incoming.length && oldKeys[start] === newKeys[start]) {
    rows[start] = retain(previous[start], incoming[start]);
    start += 1;
  }
  if (start === previous.length && start === incoming.length && rows.every((row, index) => row === previous[index])) return state;

  let oldEnd = previous.length;
  let newEnd = incoming.length;
  while (oldEnd > start && newEnd > start && oldKeys[oldEnd - 1] === newKeys[newEnd - 1]) {
    --newEnd; --oldEnd;
    rows[newEnd] = retain(previous[oldEnd], incoming[newEnd]);
  }

  // At most 300 transcript rows arrive from the backend. Matching the common
  // subsequence also handles repeated text without duplicate React keys.
  const oldCount = oldEnd - start;
  const newCount = newEnd - start;
  const width = newCount + 1;
  const lengths = new Uint16Array((oldCount + 1) * width);
  for (let i = oldCount - 1; i >= 0; i -= 1) {
    for (let j = newCount - 1; j >= 0; j -= 1) {
      lengths[i * width + j] = oldKeys[start + i] === newKeys[start + j]
        ? 1 + lengths[(i + 1) * width + j + 1]
        : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    }
  }
  for (let i = 0, j = 0; i < oldCount && j < newCount;) {
    if (oldKeys[start + i] === newKeys[start + j]) {
      rows[start + j] = retain(previous[start + i], incoming[start + j]);
      i += 1;
      j += 1;
    } else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) i += 1;
    else j += 1;
  }
  let nextId = state.nextId;
  const messages = incoming.map((message, index) => rows[index] ?? { ...message, renderId: nextId++ });
  return { messages, nextId };
}
