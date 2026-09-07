import type { AgentSessionSummary } from "./useAgentSessions";
import type { SessionSummary as SshSessionSummary } from "./useSshSessions";

export const WORKSPACE_SESSIONS_KEY = "latticeterm.workspaceSessions.v1";
const MAX_RESTORABLE_SESSIONS = 64;

export interface SavedAgentSession {
  kind: "agent";
  groupKey: string;
  groupLabel: string;
  definitionId: string;
  label: string;
  executable: string;
  launchArguments: string[];
  workingDirectory: string;
  resumeSessionId: string | null;
  /** Local-only account root. Portable exports must not include this field. */
  profileConfigPath?: string;
  /** Relaunch inside the file-scope sandbox. */
  sandbox?: boolean;
}

export interface SavedSshSession {
  kind: "ssh";
  profileId: string;
}

export type SavedWorkspaceSession = SavedAgentSession | SavedSshSession;

export type SavedActiveSession =
  | { kind: "agent"; groupKey: string; definitionId: string; profileConfigPath?: string }
  | { kind: "ssh"; profileId: string }
  | null;

export interface WorkspaceSessionSnapshot {
  version: 1;
  sessions: SavedWorkspaceSession[];
  active: SavedActiveSession;
}

export interface StorageReaderWriter {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

function safeText(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    new TextEncoder().encode(trimmed).length > maxBytes ||
    Array.from(trimmed).some((character) => /[\u0000-\u001f\u007f]/.test(character))
  ) {
    return null;
  }
  return trimmed;
}

function optionalResumeId(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  return safeText(value, 512) ?? undefined;
}

function safeArgument(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).length > 4096 ||
    Array.from(value).some((character) => /[\u0000-\u001f\u007f]/.test(character))
  ) {
    return null;
  }
  return value;
}

export function sanitizeWorkspaceSessionSnapshot(
  value: unknown,
): WorkspaceSessionSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.sessions)) return null;
  if (record.sessions.length > MAX_RESTORABLE_SESSIONS) return null;

  const sessions: SavedWorkspaceSession[] = [];
  for (const candidate of record.sessions) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return null;
    }
    const entry = candidate as Record<string, unknown>;
    if (entry.kind === "ssh") {
      const profileId = safeText(entry.profileId, 256);
      if (!profileId) return null;
      sessions.push({ kind: "ssh", profileId });
      continue;
    }
    if (entry.kind !== "agent") return null;
    const groupKey = safeText(entry.groupKey, 256);
    const groupLabel = safeText(entry.groupLabel, 80);
    const definitionId = safeText(entry.definitionId, 64);
    const label = safeText(entry.label, 80);
    const executable = safeText(entry.executable, 4096);
    // A corrupted argument list must not silently relaunch the CLI with
    // different arguments than the user saved.
    const launchArguments =
      entry.launchArguments === undefined
        ? []
        : Array.isArray(entry.launchArguments)
          ? entry.launchArguments.map(safeArgument)
          : [null];
    const workingDirectory = safeText(entry.workingDirectory, 4096);
    const resumeSessionId = optionalResumeId(entry.resumeSessionId);
    const profileConfigPath = entry.profileConfigPath == null ? null : safeText(entry.profileConfigPath, 4096);
    if (entry.profileConfigPath != null && !profileConfigPath) return null;
    if (
      !groupKey ||
      !groupLabel ||
      !definitionId ||
      !label ||
      !executable ||
      launchArguments.some((argument) => argument === null) ||
      launchArguments.length > 64 ||
      !workingDirectory ||
      resumeSessionId === undefined
    ) {
      return null;
    }
    sessions.push({
      kind: "agent",
      groupKey,
      groupLabel,
      definitionId,
      label,
      executable,
      launchArguments: launchArguments as string[],
      workingDirectory,
      resumeSessionId,
      ...(profileConfigPath ? { profileConfigPath } : {}),
      ...(entry.sandbox === true ? { sandbox: true } : {}),
    });
  }

  let active: SavedActiveSession = null;
  if (record.active !== null && record.active !== undefined) {
    if (
      typeof record.active !== "object" ||
      Array.isArray(record.active)
    ) {
      return null;
    }
    const candidate = record.active as Record<string, unknown>;
    if (candidate.kind === "ssh") {
      const profileId = safeText(candidate.profileId, 256);
      if (!profileId) return null;
      active = { kind: "ssh", profileId };
    } else if (candidate.kind === "agent") {
      const groupKey = safeText(candidate.groupKey, 256);
      const definitionId = safeText(candidate.definitionId, 64);
      if (!groupKey || !definitionId) return null;
      const profileConfigPath = candidate.profileConfigPath == null ? null : safeText(candidate.profileConfigPath, 4096);
      if (candidate.profileConfigPath != null && !profileConfigPath) return null;
      active = { kind: "agent", groupKey, definitionId, ...(profileConfigPath ? { profileConfigPath } : {}) };
    } else {
      return null;
    }
  }

  return { version: 1, sessions, active };
}

export function loadWorkspaceSessionSnapshot(
  storage: StorageReaderWriter,
): WorkspaceSessionSnapshot | null {
  try {
    const raw = storage.getItem(WORKSPACE_SESSIONS_KEY);
    if (!raw) return null;
    return sanitizeWorkspaceSessionSnapshot(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Returns each saved local Agent directory once, keeping the first spelling
 * that was written. Windows paths compare case-insensitively and either slash
 * may appear after a CLI or WebView upgrade, so neither difference should
 * create a second project row.
 */
export function savedAgentWorkingDirectories(
  sessions: readonly SavedWorkspaceSession[],
): string[] {
  const seen = new Set<string>();
  const directories: string[] = [];
  for (const session of sessions) {
    if (session.kind !== "agent") continue;
    const identity = session.workingDirectory
      .replace(/[\\/]+/g, "/")
      .replace(/\/+$/, "")
      .toLocaleLowerCase();
    if (seen.has(identity)) continue;
    seen.add(identity);
    directories.push(session.workingDirectory);
  }
  return directories;
}

export function saveWorkspaceSessionSnapshot(
  storage: StorageReaderWriter,
  snapshot: WorkspaceSessionSnapshot,
) {
  storage.setItem(WORKSPACE_SESSIONS_KEY, JSON.stringify(snapshot));
}

/**
 * Keeps a snapshot inside the size the reader accepts. Writing more entries
 * than `sanitizeWorkspaceSessionSnapshot` allows would make the next start
 * discard the whole workspace instead of restoring most of it, so the surplus
 * is dropped here and the active pointer follows what survived.
 */
function boundedSnapshot(
  sessions: readonly SavedWorkspaceSession[],
  active: SavedActiveSession,
): WorkspaceSessionSnapshot {
  const kept = sessions.slice(0, MAX_RESTORABLE_SESSIONS);
  const keptActive =
    active &&
    kept.some((session) =>
      active.kind === "agent"
        ? session.kind === "agent" &&
          session.groupKey === active.groupKey &&
          session.definitionId === active.definitionId &&
          session.profileConfigPath === active.profileConfigPath
        : session.kind === "ssh" && session.profileId === active.profileId,
    )
      ? active
      : null;
  return { version: 1, sessions: kept, active: keptActive };
}

function sameSavedSession(
  left: SavedWorkspaceSession,
  right: SavedWorkspaceSession,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "ssh" && right.kind === "ssh") {
    return left.profileId === right.profileId;
  }
  return (
    left.kind === "agent" &&
    right.kind === "agent" &&
    left.groupKey === right.groupKey &&
    left.definitionId === right.definitionId &&
    left.profileConfigPath === right.profileConfigPath &&
    left.executable === right.executable &&
    left.workingDirectory === right.workingDirectory
  );
}

/**
 * Keep entries whose automatic restoration failed. Otherwise a transient CLI,
 * directory, or credential error would replace the only restorable snapshot
 * with an empty workspace on the next render.
 */
export function preserveUnrestoredWorkspaceSessions(
  live: WorkspaceSessionSnapshot,
  unrestored: readonly SavedWorkspaceSession[],
  previousActive: SavedActiveSession,
): WorkspaceSessionSnapshot {
  const sessions = [...live.sessions];
  for (const saved of unrestored) {
    if (!sessions.some((current) => sameSavedSession(current, saved))) {
      sessions.push(saved);
    }
  }
  // Live sessions are listed first, so a snapshot at the size limit keeps the
  // ones still open in preference to entries that already failed to restore.
  return boundedSnapshot(sessions, live.active ?? previousActive);
}

export function snapshotLiveWorkspaceSessions(
  agents: readonly AgentSessionSummary[],
  ssh: readonly SshSessionSummary[],
  activeSessionId: string | null,
): WorkspaceSessionSnapshot {
  // A CLI may finish before the user closes its tab. When its adapter captured
  // the CLI's native conversation id, it is still safe to reopen with the
  // provider's resume flow after an application restart. An automatic restore
  // that exits must also remain recoverable: otherwise one provider-specific
  // startup failure silently deletes that tab and its sidebar placement. The
  // user can still remove it explicitly by closing the tab.
  // A detached session lives on in the background service and is attached
  // again on the next start; saving it too would launch a duplicate.
  const restorableAgents = agents.filter(
    (session) =>
      !session.detached &&
      (!session.closedReason ||
      session.restoreExistingSession === true ||
      (session.capturedSessionId !== null &&
        /\bcode:\s*0\b/.test(session.closedReason))),
  );
  const activeAgent = restorableAgents.find(
    (session) => session.sessionId === activeSessionId,
  );
  const activeSsh = ssh.find((session) => session.sessionId === activeSessionId);
  const sessions: SavedWorkspaceSession[] = restorableAgents.map((session) => ({
    kind: "agent",
    groupKey: session.groupId || session.sessionId,
    groupLabel: session.groupLabel,
    definitionId: session.definitionId,
    label: session.label,
    executable: session.executable,
    launchArguments: session.launchArguments,
    workingDirectory: session.workingDirectory,
    resumeSessionId: session.capturedSessionId,
    ...(session.profileConfigPath ? { profileConfigPath: session.profileConfigPath } : {}),
    ...(session.sandboxed ? { sandbox: true } : {}),
  }));
  const seenProfiles = new Set<string>();
  for (const session of ssh) {
    // Reconnecting the same saved profile more than once only creates
    // indistinguishable duplicate tabs and can multiply login prompts.
    if (seenProfiles.has(session.profileId)) continue;
    seenProfiles.add(session.profileId);
    sessions.push({ kind: "ssh", profileId: session.profileId });
  }
  const active: SavedActiveSession = activeAgent
    ? {
        kind: "agent",
        groupKey: activeAgent.groupId || activeAgent.sessionId,
        definitionId: activeAgent.definitionId,
        ...(activeAgent.profileConfigPath ? { profileConfigPath: activeAgent.profileConfigPath } : {}),
      }
    : activeSsh
      ? { kind: "ssh", profileId: activeSsh.profileId }
      : null;
  return boundedSnapshot(sessions, active);
}

export function agentFreshLaunchArguments(session: SavedAgentSession): string[] {
  const arguments_ = session.launchArguments;
  if (
    session.definitionId === "codex" &&
    arguments_[0] === "resume" &&
    arguments_[1] === "--last"
  ) {
    return arguments_.slice(2);
  }
  if (
    (session.definitionId === "claude" ||
      session.definitionId === "antigravity" ||
      session.definitionId === "cursor") &&
    arguments_[0] === "--continue"
  ) {
    return arguments_.slice(1);
  }
  return [...arguments_];
}

export function agentRestoreArguments(session: SavedAgentSession): string[] {
  if (session.resumeSessionId) return [];
  const launchArguments = agentFreshLaunchArguments(session);
  // Claude's --continue resumes the most recent conversation in this working
  // directory and still accepts ordinary startup flags such as --model.
  // Putting it first avoids silently turning a restored Claude tab into a
  // fresh conversation just because the user picked a model.
  if (session.definitionId === "claude") {
    return ["--continue", ...launchArguments];
  }
  if (launchArguments.length > 0) return launchArguments;
  if (session.definitionId === "codex") return ["resume", "--last"];
  if (
    session.definitionId === "antigravity" ||
    session.definitionId === "cursor"
  ) {
    return ["--continue"];
  }
  return [];
}
