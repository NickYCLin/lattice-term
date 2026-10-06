/**
 * One conversation, two ways to work in it: the chat page and a terminal
 * session both read and write the CLI's own transcript. Moving between them
 * resumes the same native conversation, and only one side runs it at a time.
 */
import type { ChatItem, ChatThread } from "./agentChat";
import type { ChatAccountProfile } from "./chatAccountProfiles";
import { cliProxyLaunchArguments, validCliProxyId, type CliProxyEndpoint, CLI_PROXY_DEFAULT_ID } from "./cliProxyApi";
import type { NativeMessageSnapshot } from "./useNativeConversations";
import type { AgentDefinition, AgentLaunchRequest, AgentSessionSummary } from "./useAgentSessions";

/** The running terminal session that holds this thread's conversation now. */
export function liveSessionForThread(
  thread: Pick<ChatThread, "definitionId" | "nativeSessionId">,
  sessions: readonly AgentSessionSummary[],
): AgentSessionSummary | undefined {
  if (!thread.nativeSessionId) return undefined;
  return sessions.find((session) =>
    !session.closedReason &&
    session.definitionId === thread.definitionId &&
    session.capturedSessionId === thread.nativeSessionId);
}

/**
 * Launch settings that resume a chat thread's conversation in a terminal,
 * with the same account and proxy. `null` when the CLI cannot resume by id
 * or the thread has no conversation yet.
 */
export function sessionLaunchForThread(
  thread: ChatThread,
  workingDirectory: string,
  definitions: readonly AgentDefinition[],
  profiles: readonly ChatAccountProfile[],
  proxies: readonly CliProxyEndpoint[],
): AgentLaunchRequest | null {
  const definition = definitions.find((entry) => entry.id === thread.definitionId);
  if (!thread.nativeSessionId || !definition?.installed || !definition.resumeSupported ||
    !workingDirectory || thread.remote) return null;
  const profile = thread.accountProfileId === null ? null
    : profiles.find((entry) => entry.id === thread.accountProfileId && entry.definitionId === thread.definitionId);
  if (thread.accountProfileId !== null && !profile) return null;
  let launchArguments: string[] = [];
  if (thread.provider === "cliproxyapi") {
    const wanted = thread.proxyId && validCliProxyId(thread.proxyId) ? thread.proxyId : CLI_PROXY_DEFAULT_ID;
    const endpoint = proxies.find((entry) => entry.id === wanted);
    // Never resume a proxied conversation against a different server.
    if (!endpoint) return null;
    launchArguments = cliProxyLaunchArguments(endpoint.baseUrl, endpoint.id);
    if (thread.model) launchArguments.push("--model", thread.model);
  }
  return {
    definitionId: definition.id,
    label: definition.label,
    executable: definition.installedPath || definition.executable,
    // A native resume restores the conversation's own model and settings.
    arguments: launchArguments,
    resumeSessionId: thread.nativeSessionId,
    groupId: null,
    seedInput: null,
    restoreExistingSession: true,
    profileConfigPath: profile?.configDirectory ?? null,
    workingDirectory,
    cols: 120,
    rows: 32,
  };
}

/**
 * Brings back what was said in the terminal. The transcript holds the whole
 * conversation; the thread already shows its first user turns, so only the
 * part after those is added, behind a notice saying where it came from.
 */
export function appendSessionTurns(
  thread: ChatThread,
  snapshot: Pick<NativeMessageSnapshot, "messages">,
  notice: string,
  now = Date.now(),
): ChatThread {
  const shown = thread.items.filter((item) => item.type === "user").length;
  let seen = 0;
  const start = snapshot.messages.findIndex((message) =>
    message.role === "user" && ++seen > shown);
  const settled = { ...thread, continuedInSession: false };
  if (start < 0) return settled;
  const stamp = `session:${now}`;
  const added: ChatItem[] = [
    { type: "notice", id: `${stamp}:notice`, text: notice },
    ...snapshot.messages.slice(start).map((message, index): ChatItem => message.role === "user"
      ? { type: "user", id: `${stamp}:${index}`, text: message.text, at: now }
      : { type: "text", id: `${stamp}:${index}`, text: message.text }),
  ];
  return { ...settled, items: [...thread.items, ...added], updatedAt: now };
}
