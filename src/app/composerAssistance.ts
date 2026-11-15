export type SlashCommandId = "model" | "plan" | "review" | "compact" | "fork" | "status";
export const slashCommandIds: readonly SlashCommandId[] = ["model", "plan", "review", "compact", "fork", "status"];
export interface ProjectFile { path: string; absolutePath: string }
export interface ProjectFileResult { files: ProjectFile[]; truncated: boolean }
export interface ComposerToken { kind: "command" | "file"; query: string; start: number; end: number }

export function composerToken(text: string, caret: number): ComposerToken | null {
  const prefix = text.slice(0, caret);
  if (/^\/[a-z]*$/i.test(prefix)) return { kind: "command", query: prefix.slice(1).toLowerCase(), start: 0, end: caret };
  const match = /(?:^|\s)@([^\s@"]*)$/.exec(prefix);
  return match ? { kind: "file", query: match[1], start: caret - match[1].length - 1, end: caret } : null;
}
export function insertProjectMention(text: string, token: ComposerToken, path: string): { text: string; caret: number } {
  const mention = "@" + (/\s|["\\]/.test(path) ? JSON.stringify(path) : path) + " ";
  return { text: text.slice(0, token.start) + mention + text.slice(token.end), caret: token.start + mention.length };
}
export function shouldRecallPrompt(event: { key: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; nativeEvent?: { isComposing?: boolean; keyCode?: number } }, draft: string, attachmentCount: number): boolean {
  return event.key === "ArrowUp" && !draft && attachmentCount === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
    && !event.nativeEvent?.isComposing && event.nativeEvent?.keyCode !== 229;
}
export async function searchProjectFiles(workingDirectory: string, query: string): Promise<ProjectFileResult> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("chat_project_files", { workingDirectory, query });
}
