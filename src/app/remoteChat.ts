/** The mobile projection deliberately excludes native session IDs and account paths. */
import type { ChatAttachment, ChatItem, ChatThread } from "./agentChat";
import type { AgentChatApi } from "./useAgentChat";
import type { ChatAccountProfile } from "./chatAccountProfiles";
import { agentDisplayName } from "./agentNames";
import { CLI_PROXY_NAME } from "./cliProxyApi";
import type { RemoteCard } from "./remoteCli";
export type RemoteChatOperation =
  | { kind: "list" }
  | { kind: "read"; threadId: string; before: string | null }
  | { kind: "send"; threadId: string; text: string; attachments?: string[] }
  | { kind: "attach"; threadId: string; uploadId: string; offset: number; total: number; data: string }
  | { kind: "steer"; threadId: string; turnId: string; text: string }
  | { kind: "stop"; threadId: string; turnId: string }
  | { kind: "respond"; threadId: string; turnId: string; requestId: string; allow: boolean }
  | { kind: "create"; templateId: string };
export interface RemoteChatRequest { id: string; operation: RemoteChatOperation }
export interface RemoteChatResponse { id: string; value: unknown; error: string | null }
export interface RemoteChatThread { id: string; title: string; agent: string; directory: string; runningTurnId: string | null; updatedAt: number; canSteer?: boolean; awaitingApproval?: boolean; model?: string; proxy?: boolean }
export type RemoteActivity = "working" | "needsAttention" | "idle";
export function remoteThreadActivity(thread: RemoteChatThread): RemoteActivity {
  return thread.awaitingApproval ? "needsAttention" : thread.runningTurnId ? "working" : "idle";
}
/** Last folder of a host path; the full path stays in the conversation view. */
export function remoteProjectName(directory: string): string {
  return directory.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
}
export function remoteThreadCard(thread: RemoteChatThread, untitled: string, defaultModel: string): RemoteCard {
  const name = agentDisplayName(thread.agent);
  const model = thread.model === undefined ? "" : thread.model.trim() || defaultModel;
  return {
    title: thread.title.trim() || untitled,
    detail: [thread.proxy ? CLI_PROXY_NAME : name, model].filter(Boolean).join(" · "),
    place: [remoteProjectName(thread.directory), thread.proxy ? name : ""].filter(Boolean).join(" · "),
  };
}
export interface RemoteChatItem { id: string; type: Exclude<ChatItem["type"], "delegation">; text: string; requestId?: string; pending?: boolean; truncated: boolean }
export interface RemoteChatPage { thread: RemoteChatThread; items: RemoteChatItem[]; before: string | null }
const encoder = new TextEncoder();
function clip(text: string, bytes: number) {
  if (encoder.encode(text).length <= bytes) return text;
  return new TextDecoder().decode(encoder.encode(text).slice(0, bytes)) + "…";
}
function clipForJson(text: string, bytes: number): string {
  let budget = bytes;
  let result = clip(text, budget);
  while (encoder.encode(JSON.stringify(result)).length > bytes) {
    budget = Math.floor(budget / 2);
    result = clip(text, budget);
  }
  return result;
}
export function remoteThread(thread: ChatThread): RemoteChatThread {
  return { id: thread.id, title: clipForJson(thread.title, 200), agent: thread.definitionId, directory: clipForJson(thread.workingDirectory, 600), runningTurnId: thread.runningTurnId, updatedAt: thread.updatedAt, model: clipForJson(thread.model ?? "", 64), proxy: thread.provider === "cliproxyapi",
    canSteer: thread.definitionId === "codex" && !!thread.runningTurnId && !thread.pendingInputs?.length && !thread.items.some(item => item.type === "approval" && item.decision === "pending"),
    awaitingApproval: !!thread.runningTurnId && thread.items.some(item => item.type === "approval" && item.decision === "pending"),
  };
}
function remoteItem(item: ChatItem): RemoteChatItem {
  // A subtask note only means something next to the local subtask list.
  if (item.type === "delegation") {
    return { id: item.id, type: "notice", text: item.failed ? "Subtask failed." : "Subtask finished.", truncated: false };
  }
  let text: string;
  if (item.type === "tool") text = `${item.name}\n${item.summary}\n${item.output ?? ""}`;
  else if (item.type === "approval") text = `${item.name}\n${item.summary}\n${item.input}`;
  else if (item.type === "turnEnd") text = item.error ?? "";
  else text = item.text;
  let bounded = clip(text, 8000);
  // JSON escapes control bytes as six characters. Keep even those messages
  // small enough that a single item can always advance the page cursor.
  if (encoder.encode(JSON.stringify(bounded)).length > 32 * 1024) bounded = clip(text, 4000);
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
/** Base64 characters per upload request; mirrors `MAX_ATTACHMENT_CHUNK`. */
export const REMOTE_ATTACHMENT_CHUNK = 16 * 1024;
export const REMOTE_ATTACHMENT_BYTES = 8 * 1024 * 1024;
type StageImage = (threadId: string, base64: string) => Promise<string>;
/**
 * Images a phone uploads piece by piece before sending a message. Finished
 * uploads wait for that message; stale or oversized ones are dropped.
 */
export class RemoteUploads {
  private readonly partial = new Map<string, { threadId: string; total: number; parts: string[]; received: number; at: number }>();
  private readonly ready = new Map<string, { threadId: string; path: string; at: number }>();
  constructor(private readonly stage: StageImage, private readonly now: () => number = Date.now) {}
  private prune() {
    const cutoff = this.now() - 10 * 60_000;
    for (const [id, entry] of this.partial) if (entry.at < cutoff) this.partial.delete(id);
    for (const [id, entry] of this.ready) if (entry.at < cutoff) this.ready.delete(id);
  }
  async add(operation: Extract<RemoteChatOperation, { kind: "attach" }>): Promise<{ received: number; done: boolean }> {
    this.prune();
    if (this.ready.get(operation.uploadId)?.threadId === operation.threadId) return { received: operation.total, done: true };
    let entry = this.partial.get(operation.uploadId);
    if (!entry) {
      if (operation.offset !== 0 || operation.total > REMOTE_ATTACHMENT_BYTES) throw new Error("Start the image upload again.");
      if (this.partial.size >= 4) throw new Error("Too many images are uploading. Try again shortly.");
      entry = { threadId: operation.threadId, total: operation.total, parts: [], received: 0, at: this.now() };
      this.partial.set(operation.uploadId, entry);
    }
    if (entry.threadId !== operation.threadId || entry.total !== operation.total) throw new Error("Start the image upload again.");
    const size = Math.floor(operation.data.length / 4) * 3 - (operation.data.endsWith("==") ? 2 : operation.data.endsWith("=") ? 1 : 0);
    // A retried piece that already arrived is acknowledged without appending it twice.
    if (operation.offset + size <= entry.received) return { received: entry.received, done: false };
    if (operation.offset !== entry.received || entry.received + size > entry.total) throw new Error("Start the image upload again.");
    entry.parts.push(operation.data); entry.received += size; entry.at = this.now();
    if (entry.received < entry.total) return { received: entry.received, done: false };
    this.partial.delete(operation.uploadId);
    const path = await this.stage(operation.threadId, entry.parts.join(""));
    this.ready.set(operation.uploadId, { threadId: operation.threadId, path, at: this.now() });
    return { received: entry.total, done: true };
  }
  take(threadId: string, ids: readonly string[]): ChatAttachment[] {
    this.prune();
    const found = ids.map(id => this.ready.get(id));
    if (found.some(entry => !entry || entry.threadId !== threadId)) throw new Error("An image is no longer available. Attach it again.");
    ids.forEach(id => this.ready.delete(id));
    return found.map(entry => ({ path: entry!.path, name: entry!.path.split(/[\\/]/).pop() ?? "image", isImage: true }));
  }
}
const defaultUploads = new RemoteUploads(async (threadId, data) => {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("agent_chat_stage_remote_image", { threadId, data });
});
export async function performRemoteChat(chat: AgentChatApi, profiles: readonly ChatAccountProfile[], operation: RemoteChatOperation, uploads: RemoteUploads = defaultUploads): Promise<unknown> {
  if (operation.kind === "list") return chat.threads.slice(0, 50).map(remoteThread);
  const id = operation.kind === "create" ? operation.templateId : operation.threadId;
  const thread = chat.getThread(id);
  if (!thread) throw new Error("The conversation is no longer available.");
  if (operation.kind === "read") return remotePage(thread, operation.before);
  if (operation.kind === "attach") return uploads.add(operation);
  if (operation.kind === "steer") {
    if (thread.runningTurnId !== operation.turnId || !remoteThread(thread).canSteer) throw new Error("The active turn changed or is waiting for approval. Refresh before sending instructions.");
    if (!operation.text.trim() || encoder.encode(operation.text).length > 16384 || operation.text.includes("\0")) throw new Error("The message must contain 1–16384 UTF-8 bytes without NUL.");
    await chat.steer(thread.id, operation.text, [], operation.turnId);
    return null;
  }
  if (operation.kind === "create") {
    return remoteThread(chat.createThread({ definitionId: thread.definitionId, workingDirectory: thread.workingDirectory, permission: thread.permission, model: thread.model, accountProfileId: thread.accountProfileId, browserEnabled: thread.browserEnabled, activate: false }));
  }
  if (operation.kind === "send") {
    if (thread.runningTurnId || thread.pendingInputs?.length) throw new Error("This conversation is busy. Wait for its current work or stop it first.");
    const ids = operation.attachments ?? [];
    if ((!operation.text.trim() && ids.length === 0) || encoder.encode(operation.text).length > 16384) throw new Error("The message must contain 1–16384 UTF-8 bytes.");
    const profile = profiles.find(profile => profile.id === thread.accountProfileId && profile.definitionId === thread.definitionId);
    if (thread.accountProfileId && !profile) throw new Error("Select the conversation's account again on the host.");
    await chat.send(thread.id, operation.text, uploads.take(thread.id, ids), profile?.configDirectory ?? null);
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
