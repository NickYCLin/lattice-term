import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useChatAccountProfiles } from "./useChatAccountProfiles";
import type { LocalConversation } from "./localConversationSessions";

export const NATIVE_HISTORY_REFRESH_MS = 10_000;
export const NATIVE_MESSAGE_REFRESH_MS = 2_000;
export const NATIVE_HISTORY_PAGE_SIZE = 100;
export const NATIVE_HISTORY_MAX = 50_000;

export function nativeConversationKey(entry: Pick<LocalConversation, "definitionId" | "profileId" | "nativeSessionId">) {
  return JSON.stringify([entry.definitionId, entry.profileId, entry.nativeSessionId]);
}

/** A single reader, with explicit retries and stale-response protection. Never starts a CLI. */
export function useSerialNativeRead<T>(key: string, enabled: boolean, interval: number, read: () => Promise<T>) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [valueKey, setValueKey] = useState(key);
  const reader = useRef(read);
  reader.current = read;
  const request = useRef<() => void>(() => {});
  const refresh = useCallback(() => request.current(), []);
  useEffect(() => {
    let disposed = false;
    let running = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setValueKey(key); setValue(null); setError(null); setUpdatedAt(null); setBusy(false);
    async function run() {
      if (disposed || !enabled) return;
      if (running) { pending = true; return; }
      clearTimeout(timer);
      running = true; setBusy(true);
      try {
        const next = await reader.current();
        if (!disposed) { setValue(next); setError(null); setUpdatedAt(Date.now()); }
      } catch (reason) {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        running = false;
        if (!disposed) {
          setBusy(false);
          timer = setTimeout(() => void run(), pending ? 0 : interval);
          pending = false;
        }
      }
    }
    request.current = () => { void run(); };
    void run();
    return () => { disposed = true; clearTimeout(timer); request.current = () => {}; };
  }, [key, enabled, interval]);
  const current = enabled && valueKey === key;
  return { value: current ? value : null, error: current ? error : null,
    busy: enabled && (!current || busy), updatedAt: current ? updatedAt : null, refresh };
}

export interface NativeHistoryPage { entries: LocalConversation[]; hasMore: boolean; incomplete: boolean }
export interface NativeMessageSnapshot { messages: { role: "user" | "assistant"; text: string }[]; truncated: boolean }

export function useNativeConversations(enabled: boolean) {
  const profiles = useChatAccountProfiles();
  const profileKey = JSON.stringify(profiles.map(({ id, definitionId, configDirectory }) => ({ profileId: id, definitionId, configDirectory })));
  const [limit, setLimit] = useState(NATIVE_HISTORY_PAGE_SIZE);
  const result = useSerialNativeRead(profileKey, enabled, NATIVE_HISTORY_REFRESH_MS,
    () => invoke<NativeHistoryPage>("agent_chat_local_history_page", { profiles: JSON.parse(profileKey), limit }));
  const previousLimit = useRef(limit);
  useEffect(() => {
    if (previousLimit.current !== limit) { previousLimit.current = limit; result.refresh(); }
  }, [limit, result.refresh]);
  return {
    ...result, profiles, profileKey, limit,
    entries: result.value?.entries ?? [],
    hasMore: result.value?.hasMore === true && limit < NATIVE_HISTORY_MAX,
    incomplete: result.value?.incomplete === true,
    loadMore: () => setLimit(current => Math.min(NATIVE_HISTORY_MAX, current + NATIVE_HISTORY_PAGE_SIZE)),
  };
}

export function useNativeConversationMessages(entry: LocalConversation | null, profileKey: string) {
  const key = entry ? nativeConversationKey(entry) : "none";
  return useSerialNativeRead(`${profileKey}:${key}`, entry !== null, NATIVE_MESSAGE_REFRESH_MS, () =>
    invoke<NativeMessageSnapshot>("agent_chat_local_history_snapshot", {
      definitionId: entry!.definitionId, nativeSessionId: entry!.nativeSessionId,
      profileId: entry!.profileId, profiles: JSON.parse(profileKey),
    }));
}

export type NativeHistory = ReturnType<typeof useNativeConversations>;
export const NativeHistoryContext = createContext<(NativeHistory & { open: (entry: LocalConversation) => void }) | null>(null);
export const useNativeHistory = () => useContext(NativeHistoryContext);
