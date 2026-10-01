import { invoke } from "@tauri-apps/api/core";
import type { ChatThread } from "./agentChat";
import type { AgentChatApi } from "./useAgentChat";
import type { ChatAccountProfile } from "./chatAccountProfiles";
import { loadChatAccountProfiles } from "./chatAccountProfiles";
import { performRemoteChat, remoteThread } from "./remoteChat";

export type DesktopChatAction = { kind: "state" } | { kind: "read"; before?: string | null } | { kind: "send"; text: string; requestId: string };
export interface DesktopChatRequest { id: string; targetId: string; threadId: string; action: DesktopChatAction }
export interface ChatAccess { targetId: string; read: boolean; control: boolean; identity: string }
export function chatIdentity(thread: ChatThread, profiles: readonly ChatAccountProfile[]): string {
  const profile = profiles.find(p => p.id === thread.accountProfileId && p.definitionId === thread.definitionId);
  return JSON.stringify([thread.id, thread.definitionId, thread.provider, thread.proxyId, thread.model,
    thread.accountProfileId, profile?.configDirectory, thread.workingDirectory, thread.permission, thread.effort, thread.browserEnabled]);
}
export function chatBlockers(thread: ChatThread, draft: boolean): string[] {
  const result: string[] = [];
  if (thread.runningTurnId || thread.pendingInputs?.length) result.push("busy");
  if (thread.items.some(item => item.type === "approval" && item.decision === "pending")) result.push("approval");
  if (draft) result.push("draft");
  if (thread.archived || thread.nativeHistoryArchived || thread.shelvedAt) result.push("archived");
  return result;
}
export async function performDesktopChat(chat: AgentChatApi, profiles: readonly ChatAccountProfile[], request: DesktopChatRequest, access: ChatAccess | undefined, draft: boolean): Promise<unknown> {
  const thread = chat.getThread(request.threadId);
  if (!access || access.targetId !== request.targetId || !thread || access.identity !== chatIdentity(thread, profiles)) throw new Error("Sharing ended or this conversation's configuration changed. Share it again on the desktop.");
  const blockers = chatBlockers(thread, draft);
  if (request.action.kind === "state") return { thread: remoteThread(thread), read: access.read, control: access.control, promptReadiness: { ready: access.control && blockers.length === 0, blockers, snapshotOnly: true } };
  if (request.action.kind === "read") {
    if (!access.read) throw new Error("Reading this conversation is not authorized.");
    return performRemoteChat(chat, profiles, { kind: "read", threadId: thread.id, before: request.action.before ?? null });
  }
  if (!access.control) throw new Error("Sending to this conversation is not authorized.");
  if (blockers.length) throw new Error(`Cannot send: ${blockers.join(", ")}. Resolve this on the desktop.`);
  const text = request.action.text;
  if (!text.trim() || new TextEncoder().encode(text).length > 16384 || /[\x00-\x08\x0b-\x1f\x7f]/.test(text)) throw new Error("Invalid message.");
  const previousItems = new Set(thread.items.map(item => item.id));
  await performRemoteChat(chat, profiles, { kind: "send", threadId: thread.id, text });
  if (chat.getThread(thread.id)?.items.some(item => !previousItems.has(item.id) && item.type === "turnEnd" && item.error)) {
    throw new Error("The provider could not start the turn. Read the original conversation before trying again.");
  }
  return { threadId: thread.id, accepted: true };
}

/** Process-local grants and drafts; never serialized into saved conversations. */
export const desktopChatAccess = {
  nonce: null as string | null,
  grants: new Map<string, ChatAccess>(),
  drafts: new Set<string>(),
  pending: new Set<string>(),
  revision: 0,
  listeners: new Set<() => void>(),
  notify() { this.revision++; this.listeners.forEach(listener => listener()); },
  reset(nonce: string | null) { this.nonce = nonce; this.grants.clear(); this.notify(); },
  async share(thread: ChatThread, read: boolean, control: boolean) {
    const nonce = this.nonce;
    if (!nonce || this.pending.has(thread.id)) throw new Error("The chat sharing service is not ready.");
    this.pending.add(thread.id);
    this.grants.delete(thread.id); this.notify();
    try {
      const identity = chatIdentity(thread, loadChatAccountProfiles(localStorage));
      const grant = await invoke<{ id: string } | null>("mcp_chat_share", { request: { nonce, threadId: thread.id, label: thread.title.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 100) || "Chat", read, control } });
      if (this.nonce === nonce && grant) this.grants.set(thread.id, { targetId: grant.id, read, control, identity });
    } catch (error) {
      if (this.nonce === nonce) await invoke("mcp_chat_share", { request: { nonce, threadId: thread.id, label: "Chat", read: false, control: false } }).catch(() => undefined);
      throw error;
    } finally { this.pending.delete(thread.id); this.notify(); }
  },
};
