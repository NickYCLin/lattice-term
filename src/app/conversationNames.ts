import { useCallback, useEffect, useState } from "react";
import type { ChatThread } from "./agentChat";
import type { ChatAccountProfile } from "./chatAccountProfiles";
import type { LocalConversation } from "./localConversationSessions";
import { nativeConversationIdentity } from "./nativeConversationIdentity";
import type { AgentSessionSummary } from "./useAgentSessions";

export const CONVERSATION_NAMES_KEY = "latticeterm.conversationNames.v1";
export const CONVERSATION_NAMES_CHANGED = "latticeterm:conversation-names-changed";
type NameStorage = Pick<Storage, "getItem" | "setItem">;

export function readConversationNames(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): Map<string, string> {
  const raw = storage?.getItem(CONVERSATION_NAMES_KEY);
  if (raw == null) return new Map();
  const entries: unknown = JSON.parse(raw);
  if (!Array.isArray(entries) || entries.length > 20_000 || !entries.every(entry =>
    Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && entry[0].length > 0 && entry[0].length <= 8192
    && typeof entry[1] === "string" && entry[1].trim().length > 0 && entry[1].length <= 255
    && !/[\u0000-\u001f\u007f]/.test(entry[1]))) throw new Error("chat.rename.storage");
  const names = new Map(entries as [string, string][]);
  if (names.size !== entries.length) throw new Error("chat.rename.storage");
  return names;
}

/** Read the latest map before every write, retaining other windows' names. */
export function saveConversationName(keys: readonly string[], value: string, storage: NameStorage | undefined = globalThis.localStorage) {
  const name = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!name || name.length > 255) throw new Error("chat.rename.invalid");
  if (!storage || !keys.length || keys.some(key => !key || key.length > 8192)) throw new Error("chat.rename.storage");
  const names = readConversationNames(storage);
  for (const key of keys) names.set(key, name);
  if (names.size > 20_000) throw new Error("chat.rename.storage");
  storage.setItem(CONVERSATION_NAMES_KEY, JSON.stringify([...names]));
  globalThis.window?.dispatchEvent?.(new Event(CONVERSATION_NAMES_CHANGED));
  return names;
}

function safeNames() {
  try { return readConversationNames(); } catch { return new Map<string, string>(); }
}

export function useConversationNames() {
  const [names, setNames] = useState(safeNames);
  useEffect(() => {
    const reload = () => setNames(safeNames());
    window.addEventListener("storage", reload);
    window.addEventListener(CONVERSATION_NAMES_CHANGED, reload);
    return () => {
      window.removeEventListener("storage", reload);
      window.removeEventListener(CONVERSATION_NAMES_CHANGED, reload);
    };
  }, []);
  const save = useCallback((keys: readonly string[], name: string) => {
    setNames(saveConversationName(keys, name));
  }, []);
  return { names, save };
}

/** Resolve every visible form of the same CLI conversation within its account. */
export function conversationNameTargets(threads: readonly ChatThread[], sessions: readonly AgentSessionSummary[], profiles: readonly ChatAccountProfile[]) {
  const identity = nativeConversationIdentity(profiles);
  const linked = new Map<string, Set<string>>();
  const threadKey = (thread: ChatThread) => JSON.stringify(["thread", thread.id]);
  const sessionKey = (session: AgentSessionSummary) => JSON.stringify(["sessionGroup", session.groupId || session.sessionId]);
  const threadIdentity = (thread: ChatThread) => !thread.remote && thread.nativeSessionId
    ? identity.conversation({ definitionId: thread.definitionId, profileId: thread.accountProfileId, nativeSessionId: thread.nativeSessionId }) : null;
  const add = (native: string | null, key: string) => {
    if (native === null) return;
    const keys = linked.get(native) ?? new Set<string>();
    keys.add(key); linked.set(native, keys);
  };
  for (const thread of threads) add(threadIdentity(thread), threadKey(thread));
  for (const session of sessions) add(identity.session(session), sessionKey(session));
  const keys = (native: string | null, own: string) => [...new Set([
    ...(native === null ? [] : ["native:" + native, ...(linked.get(native) ?? [])]), own,
  ])];
  return {
    thread: (thread: ChatThread) => keys(threadIdentity(thread), threadKey(thread)),
    session: (session: AgentSessionSummary) => keys(identity.session(session), sessionKey(session)),
    native: (entry: LocalConversation) => keys(identity.conversation(entry), JSON.stringify(["history", entry.definitionId, entry.profileId, entry.nativeSessionId])),
  };
}

export function conversationDisplayName(names: ReadonlyMap<string, string>, keys: readonly string[], fallback: string) {
  for (const key of keys) {
    const name = names.get(key);
    if (name) return name;
  }
  return fallback;
}
