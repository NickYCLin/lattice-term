import { hasDesktopBackend } from "./nativeRuntime";

/** An assistant conversation that also lives in the assistant's own store. */
export interface NativeConversationRef {
  definitionId: string;
  nativeSessionId: string;
  profileConfigPath?: string | null;
  workingDirectory?: string | null;
}

/** Only Codex and Claude Code keep conversations LatticeTerm can remove. */
export function syncsNativeConversation(definitionId: string): boolean {
  return definitionId === "codex" || definitionId === "claude";
}

/**
 * Removes the conversation from the assistant's own history so Codex Desktop
 * and the CLI stop listing it. Codex moves it to its archive; Claude Code
 * deletes the transcript.
 */
export async function removeNativeConversation(ref: NativeConversationRef): Promise<void> {
  if (!hasDesktopBackend() || !syncsNativeConversation(ref.definitionId)) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("agent_chat_delete_native_conversation", {
    definitionId: ref.definitionId,
    nativeSessionId: ref.nativeSessionId,
    profileConfigPath: ref.profileConfigPath ?? null,
    workingDirectory: ref.workingDirectory || null,
  });
}
