import type { AgentSessionSummary } from "./useAgentSessions";
import type { AgentSharedSession, McpAccess } from "./useAgentDaemon";

export const AGENT_MCP_PREFERENCES_KEY = "latticeterm.agentMcpPreferences.v1";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
export interface AgentMcpPreference {
  sessionId: string;
  groupId: string;
  definitionId: string;
  executable: string;
  workingDirectory: string;
  profileConfigPath: string | null;
  sandboxed: boolean;
  nativeSessionId: string | null;
  access: Exclude<McpAccess, "off">;
  readOutput: boolean;
}

function identityMatches(entry: AgentMcpPreference, session: AgentSessionSummary): boolean {
  return entry.groupId === (session.groupId || session.sessionId) &&
    entry.definitionId === session.definitionId && entry.executable === session.executable &&
    entry.workingDirectory === session.workingDirectory &&
    entry.profileConfigPath === (session.profileConfigPath ?? null) &&
    entry.sandboxed === (session.sandboxed === true);
}

export function mcpPreferenceMatches(entry: AgentMcpPreference, session: AgentSessionSummary): boolean {
  if (session.closedReason || !identityMatches(entry, session)) return false;
  if (entry.sessionId === session.sessionId) {
    return !entry.nativeSessionId || !session.capturedSessionId || entry.nativeSessionId === session.capturedSessionId;
  }
  return session.restoreExistingSession === true && !!entry.nativeSessionId &&
    entry.nativeSessionId === session.capturedSessionId;
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value);
}

function validEntry(value: unknown): value is AgentMcpPreference {
  if (!value || typeof value !== "object") return false;
  const entry = value as AgentMcpPreference;
  return [entry.sessionId, entry.groupId, entry.definitionId, entry.executable, entry.workingDirectory].every(validText) &&
    (entry.profileConfigPath === null || validText(entry.profileConfigPath)) &&
    (entry.nativeSessionId === null || validText(entry.nativeSessionId)) &&
    typeof entry.sandboxed === "boolean" && typeof entry.readOutput === "boolean" &&
    (entry.access === "view" || entry.access === "full");
}

export class AgentMcpPreferences {
  private entries: AgentMcpPreference[];
  private expected: string | null;
  constructor(private storage: Storage) {
    const raw = storage.getItem(AGENT_MCP_PREFERENCES_KEY);
    this.expected = raw;
    if (!raw) { this.entries = []; return; }
    if (raw.length > 1024 * 1024) throw new Error("Saved MCP sharing choices exceed the size limit.");
    const record = JSON.parse(raw);
    if (record.version !== 1 || !Array.isArray(record.entries) || record.entries.length > 1024 || !record.entries.every(validEntry)) {
      throw new Error("Cannot read saved MCP sharing choices.");
    }
    this.entries = record.entries.map((entry: AgentMcpPreference) => ({
      sessionId: entry.sessionId, groupId: entry.groupId, definitionId: entry.definitionId,
      executable: entry.executable, workingDirectory: entry.workingDirectory,
      profileConfigPath: entry.profileConfigPath, sandboxed: entry.sandboxed,
      nativeSessionId: entry.nativeSessionId, access: entry.access, readOutput: entry.readOutput,
    }));
  }

  find(session: AgentSessionSummary): AgentMcpPreference | undefined {
    return this.entries.find(entry => mcpPreferenceMatches(entry, session));
  }

  remember(session: AgentSessionSummary, access: McpAccess, readOutput = true): void {
    const previous = this.entries;
    const remaining = previous.filter(entry => !(identityMatches(entry, session) &&
      (entry.sessionId === session.sessionId || session.restoreExistingSession === true && !!entry.nativeSessionId && entry.nativeSessionId === session.capturedSessionId)));
    if (access !== "off") remaining.push({
      sessionId: session.sessionId, groupId: session.groupId || session.sessionId,
      definitionId: session.definitionId, executable: session.executable,
      workingDirectory: session.workingDirectory, profileConfigPath: session.profileConfigPath ?? null,
      sandboxed: session.sandboxed === true, nativeSessionId: session.capturedSessionId,
      access, readOutput,
    });
    if (remaining.length > 1024) throw new Error("Too many saved MCP sharing choices.");
    const content = JSON.stringify({ version: 1, entries: remaining });
    if (content.length > 1024 * 1024) throw new Error("Saved MCP sharing choices exceed the size limit.");
    if (this.storage.getItem(AGENT_MCP_PREFERENCES_KEY) !== this.expected) throw new Error("MCP sharing choices were changed in another window.");
    this.storage.setItem(AGENT_MCP_PREFERENCES_KEY, content);
    this.expected = content;
    this.entries = remaining;
  }

  updateIdentity(session: AgentSessionSummary): void {
    const entry = this.find(session);
    if (entry && (entry.sessionId !== session.sessionId || entry.nativeSessionId !== session.capturedSessionId && !!session.capturedSessionId)) {
      this.remember(session, entry.access, entry.readOutput);
    }
  }

  adopt(session: AgentSessionSummary, shared: AgentSharedSession): void {
    if (!this.find(session)) this.remember(session, shared.control ? "full" : "view", shared.readOutput);
  }
}
