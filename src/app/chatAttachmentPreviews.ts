import type { ChatAttachment } from "./agentChat";
import { hasDesktopBackend } from "./nativeRuntime";

export async function keepChatAttachmentPreviews(threadId: string, attachments: readonly ChatAttachment[]): Promise<ChatAttachment[]> {
  if (!hasDesktopBackend() || !attachments.some(file => file.isImage && !file.preview)) return [...attachments];
  const { invoke } = await import("@tauri-apps/api/core");
  return Promise.all(attachments.map(async file => {
    if (!file.isImage || file.preview) return file;
    const preview = await invoke<string | null>("agent_chat_keep_image_preview", { threadId, path: file.path });
    return preview ? { ...file, preview } : file;
  }));
}
