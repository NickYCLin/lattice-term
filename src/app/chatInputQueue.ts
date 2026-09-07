import type { ChatAttachment, ChatThread } from "./agentChat";

export const MAX_QUEUED_CHAT_INPUTS = 8;
const MAX_QUEUED_PROMPT_LENGTH = 64 * 1024;

export class ChatQueueError extends Error {
  constructor(readonly code: "full" | "invalid" | "storage") { super(code); }
}

export interface QueuedChatInput {
  id: string;
  prompt: string;
  attachments: ChatAttachment[];
  profileConfigPath: string | null;
  createdAt: number;
}

function safePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f]/.test(value);
}

/** Stored queue entries are inert until the user explicitly resumes them. */
export function restoreQueuedInputs(value: unknown): QueuedChatInput[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.slice(0, MAX_QUEUED_CHAT_INPUTS).flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Partial<QueuedChatInput>;
    if (typeof item.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(item.id) || seen.has(item.id) ||
      typeof item.prompt !== "string" || new TextEncoder().encode(item.prompt).byteLength > MAX_QUEUED_PROMPT_LENGTH ||
      !Array.isArray(item.attachments) || item.attachments.length > 10 ||
      (item.profileConfigPath !== null && !safePath(item.profileConfigPath))) return [];
    if (!item.attachments.every(file => file && safePath(file.path) && typeof file.name === "string" &&
      file.name.length <= 512 && typeof file.isImage === "boolean")) return [];
    if (!item.prompt.trim() && item.attachments.length === 0) return [];
    seen.add(item.id);
    return [{ id: item.id, prompt: item.prompt, attachments: item.attachments.map(file => ({
      path: file.path, name: file.name, isImage: file.isImage,
    })), profileConfigPath: item.profileConfigPath ?? null,
      createdAt: typeof item.createdAt === "number" && Number.isFinite(item.createdAt) ? item.createdAt : 0 }];
  });
}

export function enqueueChatInput(thread: ChatThread, input: QueuedChatInput): ChatThread {
  const pending = thread.pendingInputs ?? [];
  if (pending.some(item => item.id === input.id)) return thread;
  if (pending.length >= MAX_QUEUED_CHAT_INPUTS) throw new ChatQueueError("full");
  if (restoreQueuedInputs([input]).length !== 1) throw new ChatQueueError("invalid");
  return { ...thread, pendingInputs: [...pending, input], updatedAt: input.createdAt };
}

export function removeQueuedInput(thread: ChatThread, id: string): ChatThread {
  return { ...thread, pendingInputs: (thread.pendingInputs ?? []).filter(item => item.id !== id) };
}
