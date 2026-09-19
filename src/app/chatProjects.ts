/** Conversation folders as projects: the folders chats run in, most recent first. */

export interface ChatProject {
  directory: string;
  name: string;
  threads: number;
  updatedAt: number;
}

export function projectName(directory: string): string {
  const trimmed = directory.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || directory;
}

export function chatProjects(
  threads: readonly { workingDirectory: string; updatedAt: number; shelvedAt?: number | null }[],
): ChatProject[] {
  const byDirectory = new Map<string, ChatProject>();
  for (const thread of threads) {
    const raw = thread.workingDirectory.trim();
    // "/work/a/" and "/work/a" are the same project.
    const directory = raw.replace(/[\\/]+$/, "") || raw;
    if (!directory || thread.shelvedAt) continue;
    const project = byDirectory.get(directory) ?? {
      directory,
      name: projectName(directory),
      threads: 0,
      updatedAt: 0,
    };
    project.threads += 1;
    project.updatedAt = Math.max(project.updatedAt, thread.updatedAt);
    byDirectory.set(directory, project);
  }
  return [...byDirectory.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}
