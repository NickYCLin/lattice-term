import { displayPath } from "./displayPath";
import { nativeConversationKey } from "./nativeConversationDismissals";

/** Conversation folders as projects: the folders chats run in, most recent first. */

export interface ChatProject {
  directory: string;
  name: string;
  threads: number;
  updatedAt: number;
}

/**
 * One key per folder: "/work/a/" and "/work/a" match, and so does a path
 * that Windows reported with its internal verbatim prefix.
 */
export function chatProjectKey(directory: string): string {
  const plain = displayPath(directory.trim());
  return plain.replace(/[\\/]+$/, "") || plain;
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
    const directory = chatProjectKey(thread.workingDirectory);
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

/**
 * Folders that so far only hold a CLI's own conversations are projects too,
 * so a project first used in Codex Desktop is listed before anything in it
 * has been opened here. CLI history records time in seconds.
 */
export function chatProjectsWithHistory(
  threads: readonly {
    workingDirectory: string;
    updatedAt: number;
    shelvedAt?: number | null;
    definitionId: string;
    accountProfileId?: string | null;
    nativeSessionId?: string | null;
  }[],
  history: readonly {
    definitionId: string;
    profileId: string | null;
    nativeSessionId: string;
    workingDirectory: string;
    updatedAt: number;
    archived?: boolean;
  }[],
): ChatProject[] {
  const opened = new Set(threads.flatMap((thread) => thread.nativeSessionId ? [nativeConversationKey({
    definitionId: thread.definitionId, profileId: thread.accountProfileId ?? null, nativeSessionId: thread.nativeSessionId,
  })] : []));
  const native = history
    .filter((entry) => !entry.archived && !opened.has(nativeConversationKey(entry)))
    .map((entry) => ({ workingDirectory: entry.workingDirectory, updatedAt: entry.updatedAt * 1000 }));
  return chatProjects([...threads, ...native]);
}
