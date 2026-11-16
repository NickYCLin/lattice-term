import { createContext } from "react";

export interface ImageConversation {
  definitionId: string;
  nativeSessionId: string;
  profileConfigPath: string | null;
}

export const ChatImageConversationContext = createContext<ImageConversation | null>(null);

export type ImageProblem = "chat.images.missing" | "chat.images.denied" | "chat.images.unavailable";
export function imagePreviewProblem(error: unknown): ImageProblem {
  return error === "chat.images.missing" || error === "chat.images.denied" ? error : "chat.images.unavailable";
}
