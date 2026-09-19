/** The conversation folder's git working tree, through the desktop. */

export interface ChangedFile {
  path: string;
  /** Porcelain letters; empty when that side has no change. */
  staged: string;
  unstaged: string;
  originalPath: string | null;
}

export interface GitStatus {
  root: string;
  branch: string | null;
  files: ChangedFile[];
  truncated: boolean;
}

export interface GitDiff {
  text: string;
  truncated: boolean;
}

async function invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export const gitStatus = (workingDirectory: string) =>
  invoke<GitStatus>("git_changes_status", { workingDirectory });
export const gitDiff = (workingDirectory: string, path: string, staged: boolean) =>
  invoke<GitDiff>("git_changes_diff", { workingDirectory, path, staged });
export const gitStage = (workingDirectory: string, paths: string[]) =>
  invoke<void>("git_changes_stage", { workingDirectory, paths });
export const gitUnstage = (workingDirectory: string, paths: string[]) =>
  invoke<void>("git_changes_unstage", { workingDirectory, paths });
export const gitCommit = (workingDirectory: string, message: string) =>
  invoke<string>("git_changes_commit", { workingDirectory, message });

/** Untracked files show "?" on both sides; they are not staged yet. */
export function isStaged(file: ChangedFile): boolean {
  return file.staged !== "" && file.staged !== "?";
}

export function hasUnstagedChange(file: ChangedFile): boolean {
  return file.unstaged !== "";
}

export type DiffLineKind = "add" | "remove" | "hunk" | "meta" | "context";

export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file")) {
    return "meta";
  }
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  return "context";
}

/** Text for the message box that asks about one file's change. */
export function diffQuote(path: string, diff: string, maxChars = 12_000): string {
  const body = diff.length > maxChars ? `${diff.slice(0, maxChars)}\n…` : diff;
  return `\`${path}\`:\n\n\`\`\`diff\n${body.replace(/```/g, "``​`")}\n\`\`\``;
}
