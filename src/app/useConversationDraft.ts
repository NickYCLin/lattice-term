import { useCallback, useMemo, useSyncExternalStore, type SetStateAction } from "react";
import type { ChatAttachment, ChatMention } from "./agentChat";
import { mergeAttachmentPaths } from "./chatAttachments";
import { desktopChatAccess } from "./desktopChat";

type DraftKind = "thread" | "session";
interface ConversationDraft {
  text: string;
  attachments: ChatAttachment[];
  picks: ChatMention[];
  pasting: boolean;
  steering: boolean;
}
interface DraftEntry {
  kind: DraftKind;
  id: string;
  active: boolean;
  value: ConversationDraft;
  listeners: Set<() => void>;
}
const drafts = new Map<string, DraftEntry>();

function emptyDraft(): ConversationDraft {
  return { text: "", attachments: [], picks: [], pasting: false, steering: false };
}

function hasInput(value: ConversationDraft): boolean {
  return Boolean(value.text.length || value.attachments.length || value.pasting || value.steering);
}

function entryFor(kind: DraftKind, id: string): DraftEntry {
  const key = kind + ":" + id;
  let entry = drafts.get(key);
  if (!entry) {
    entry = { kind, id, active: true, value: emptyDraft(), listeners: new Set() };
    drafts.set(key, entry);
  }
  return entry;
}

function update(entry: DraftEntry, value: ConversationDraft) {
  if (!entry.active) return;
  entry.value = value;
  if (entry.kind === "thread") {
    if (hasInput(value)) desktopChatAccess.drafts.add(entry.id);
    else desktopChatAccess.drafts.delete(entry.id);
  }
  entry.listeners.forEach(listener => listener());
}

export function conversationDraftHasInput(kind: DraftKind, id: string): boolean {
  const entry = drafts.get(kind + ":" + id);
  return Boolean(entry && hasInput(entry.value));
}

export function removeConversationDraft(kind: DraftKind, id: string) {
  const key = kind + ":" + id;
  const entry = drafts.get(key);
  if (!entry) return;
  entry.active = false;
  entry.value = emptyDraft();
  drafts.delete(key);
  if (kind === "thread") desktopChatAccess.drafts.delete(id);
  entry.listeners.forEach(listener => listener());
}

export function useConversationDraft(kind: DraftKind, id: string) {
  const entry = useMemo(() => entryFor(kind, id), [kind, id]);
  const subscribe = useCallback((listener: () => void) => {
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
  }, [entry]);
  const read = useCallback(() => entry.value, [entry]);
  const value = useSyncExternalStore(subscribe, read, read);
  const setField = useCallback(<Field extends keyof ConversationDraft>(field: Field, next: SetStateAction<ConversationDraft[Field]>) => {
    const current = entry.value[field];
    const result = typeof next === "function" ? next(current) : next;
    if (result !== current) update(entry, { ...entry.value, [field]: result });
  }, [entry]);
  const setDraft = useCallback((next: SetStateAction<string>) => setField("text", next), [setField]);
  const setAttachments = useCallback((next: SetStateAction<ChatAttachment[]>) => setField("attachments", next), [setField]);
  const setPicks = useCallback((next: SetStateAction<ChatMention[]>) => setField("picks", next), [setField]);
  const setPasting = useCallback((next: SetStateAction<boolean>) => setField("pasting", next), [setField]);
  const setSteering = useCallback((next: SetStateAction<boolean>) => setField("steering", next), [setField]);
  const addAttachmentPaths = useCallback((paths: readonly string[]) => {
    if (!entry.active) return null;
    const next = mergeAttachmentPaths(entry.value.attachments, paths);
    if (next) update(entry, { ...entry.value, attachments: next });
    return next;
  }, [entry]);
  return { draft: value.text, attachments: value.attachments, picks: value.picks,
    pasting: value.pasting, steering: value.steering,
    setDraft, setAttachments, setPicks, setPasting, setSteering, addAttachmentPaths, readDraft: read };
}
