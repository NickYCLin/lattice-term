import type { ChatAttachment } from "./agentChat";

export const CHAT_ATTACHMENT_LIMIT = 10;

/** Reject the whole addition if it would overflow, preserving the draft. */
export function mergeAttachmentPaths(current: readonly ChatAttachment[], paths: readonly string[]): ChatAttachment[] | null {
  const seen = new Set(current.map(file => file.path));
  const added = paths.flatMap(path => {
    if (!path || seen.has(path)) return [];
    seen.add(path);
    const parts = path.split(/[\\/]/).filter(Boolean);
    return [{ path, name: parts[parts.length - 1] || path,
      isImage: /\.(png|jpe?g|gif|webp|bmp)$/i.test(path) }];
  });
  if (current.length + added.length > CHAT_ATTACHMENT_LIMIT) return null;
  return [...current, ...added];
}

export function pasteContainsImage(items: ArrayLike<Pick<DataTransferItem, "kind" | "type">>): boolean {
  return Array.from(items).some(item => item.kind === "file" && item.type.startsWith("image/"));
}
