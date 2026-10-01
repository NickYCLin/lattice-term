import { useEffect, useState } from "react";

/** Identity of one conversation in a CLI's own store, per account. */
export function nativeConversationKey(entry: { definitionId: string; profileId: string | null; nativeSessionId: string }) {
  return JSON.stringify([entry.definitionId, entry.profileId, entry.nativeSessionId]);
}

const STORAGE_KEY = "latticeterm.nativeConversationDismissed.v1";
const CHANGED = "latticeterm:native-conversation-dismissed";
export const MAX_DISMISSED_NATIVE = 5_000;

export function loadDismissedNativeConversations(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): Set<string> {
  try {
    const parsed = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : []);
  } catch {
    return new Set();
  }
}

/**
 * Some CLIs keep no deletable store (Gemini, Antigravity), and a Codex
 * archive can fail. Remembering the removal keeps a deleted conversation
 * from coming back with the next sync.
 */
export function dismissNativeConversation(
  entry: { definitionId: string; profileId: string | null; nativeSessionId: string },
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = globalThis.localStorage,
) {
  if (!entry.nativeSessionId || !storage) return;
  const keys = [...loadDismissedNativeConversations(storage)];
  const key = nativeConversationKey(entry);
  if (keys.includes(key)) return;
  keys.push(key);
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(keys.slice(-MAX_DISMISSED_NATIVE)));
  } catch {
    return;
  }
  globalThis.dispatchEvent?.(new Event(CHANGED));
}

export function useDismissedNativeConversations(): ReadonlySet<string> {
  const [keys, setKeys] = useState(() => loadDismissedNativeConversations());
  useEffect(() => {
    const reload = () => setKeys(loadDismissedNativeConversations());
    globalThis.addEventListener?.(CHANGED, reload);
    return () => globalThis.removeEventListener?.(CHANGED, reload);
  }, []);
  return keys;
}