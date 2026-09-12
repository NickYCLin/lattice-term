/** The mobile projection deliberately excludes native session IDs and account paths. */
import type { ChatItem, ChatThread } from "./agentChat";
import type { AgentChatApi } from "./useAgentChat";
import type { ChatAccountProfile } from "./chatAccountProfiles";
export type RemoteChatOperation =
  | { kind: "list" }
  | { kind: "read"; threadId: string; before: string | null }
  | { kind: "send"; threadId: string; text: string }
  | { kind: "stop"; threadId: string; turnId: string }
  | { kind: "respond"; threadId: string; turnId: string; requestId: string; allow: boolean }
  | { kind: "create"; templateId: string };
export interface RemoteChatRequest { id: string; operation: RemoteChatOperation }
export interface RemoteChatResponse { id: string; value: unknown; error: string | null }
export interface RemoteChatThread { id: string; title: string; agent: string; directory: string; runningTurnId: string | null; updatedAt: number }
export interface RemoteChatItem { id: string; type: ChatItem["type"]; text: string; requestId?: string; pending?: boolean; truncated: boolean }
export interface RemoteChatPage { thread: RemoteChatThread; items: RemoteChatItem[]; before: string | null }
const encoder = new TextEncoder();
function clip(text: string, bytes: number) {
  if (encoder.encode(text).length <= bytes) return text;
  return new TextDecoder().decode(encoder.encode(text).slice(0, bytes)) + "…";
}
export function remoteThread(thread: ChatThread): RemoteChatThread {
  return { id: thread.id, title: clip(thread.title, 200), agent: thread.definitionId, directory: clip(thread.workingDirectory, 600), runningTurnId: thread.runningTurnId, updatedAt: thread.updatedAt };
}
function remoteItem(item: ChatItem): RemoteChatItem {
  let text: string;
  if (item.type === "tool") text = `${item.name}\n${item.summary}\n${item.output ?? ""}`;
  else if (item.type === "approval") text = `${item.name}\n${item.summary}\n${item.input}`;
  else if (item.type === "turnEnd") text = item.error ?? "";
  else text = item.text;
  const bounded = clip(text, 8000);
  return { id: item.id, type: item.type, text: bounded, truncated: bounded !== text, ...(item.type === "approval" ? { requestId: item.requestId, pending: item.decision === "pending" } : {}) };
}
export function remotePage(thread: ChatThread, before: string | null): RemoteChatPage {
  const end = before === null ? thread.items.length : thread.items.findIndex(item => item.id === before);
  if (end < 0) throw new Error("The conversation changed. Refresh before loading earlier messages.");
  const items: RemoteChatItem[] = [];
  let index = end;
  let size = 0;
  while (index > 0 && items.length < 40) {
    const next = remoteItem(thread.items[index - 1]);
    const bytes = encoder.encode(JSON.stringify(next)).length;
    if (size + bytes > 40 * 1024) break;
    items.unshift(next); size += bytes; index -= 1;
  }
  return { thread: remoteThread(thread), items, before: index > 0 ? items[0]?.id ?? null : null };
}
export async function performRemoteChat(chat: AgentChatApi, profiles: readonly ChatAccountProfile[], operation: RemoteChatOperation): Promise<unknown> {
  if (operation.kind === "list") return chat.threads.slice(0, 50).map(remoteThread);
  const id = operation.kind === "create" ? operation.templateId : operation.threadId;
  const thread = chat.getThread(id);
  if (!thread) throw new Error("The conversation is no longer available.");
  if (operation.kind === "read") return remotePage(thread, operation.before);
  if (operation.kind === "create") {
    return remoteThread(chat.createThread({ definitionId: thread.definitionId, workingDirectory: thread.workingDirectory, permission: thread.permission, model: thread.model, accountProfileId: thread.accountProfileId, browserEnabled: thread.browserEnabled, activate: false }));
  }
  if (operation.kind === "send") {
    if (thread.runningTurnId || thread.pendingInputs?.length) throw new Error("This conversation is busy. Wait for its current work or stop it first.");
    if (!operation.text.trim() || encoder.encode(operation.text).length > 16384) throw new Error("The message must contain 1–16384 UTF-8 bytes.");
    const profile = profiles.find(profile => profile.id === thread.accountProfileId && profile.definitionId === thread.definitionId);
    if (thread.accountProfileId && !profile) throw new Error("Select the conversation's account again on the host.");
    await chat.send(thread.id, operation.text, [], profile?.configDirectory ?? null);
  } else {
    if (!thread.runningTurnId || thread.runningTurnId !== operation.turnId) throw new Error("The active turn changed. Refresh before operating it.");
    if (operation.kind === "stop") await chat.stop(thread.id, operation.turnId);
    else {
      const approval = thread.items.find(item => item.type === "approval" && item.requestId === operation.requestId && item.decision === "pending");
      if (!approval || remoteItem(approval).truncated) throw new Error("Review this approval on the host.");
      await chat.respond(thread.id, operation.requestId, operation.allow, undefined, operation.turnId);
    }
  }
  return null;
}
