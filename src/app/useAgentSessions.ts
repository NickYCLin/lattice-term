import { useCallback, useEffect, useRef, useState } from "react";
import {
  createSessionClosedNotice,
  reconcileSessionSnapshot,
  snapshotHydrationMap,
  snapshotSessionIds,
  type SessionClosedNotice,
} from "./sessionSnapshot";

export type AgentLifecycle = "working" | "needsAttention" | "idle" | "done";
export type AgentStateSource = "heuristic" | "integration";
export type AgentBackendMode = "loading" | "ready" | "unavailable";

export interface AgentDefinition {
  id: string;
  label: string;
  executable: string;
  adapterVersion: number;
  resumeSupported: boolean;
  /** Saved launch items can continue the latest context without storing an id. */
  resumeLatestSupported: boolean;
  /** Whether this CLI's conversation can be read for a handoff to another CLI. */
  transcriptSupported: boolean;
  installed: boolean;
  installedPath: string | null;
  /** Google consumer OAuth moved from Gemini CLI to Antigravity CLI. */
  consumerOauthDeprecated: boolean;
  account: AgentAccountInfo;
  install: AgentInstallDefinition;
}

/**
 * Presents Google's personal-account CLI as one Antigravity item while
 * keeping Gemini visible for API-key, Vertex, and enterprise setups.
 */
export function agentCatalogForDisplay(
  catalog: readonly AgentDefinition[],
): AgentDefinition[] {
  const antigravity = catalog.find((definition) => definition.id === "antigravity");
  const gemini = catalog.find((definition) => definition.id === "gemini");
  if (!antigravity || !gemini || !gemini.consumerOauthDeprecated) {
    return [...catalog];
  }

  return catalog
    .filter((definition) => definition.id !== "gemini")
    .map((definition) => {
      if (definition.id !== "antigravity") return definition;
      const detectedGeminiAccount =
        definition.account.state !== "signedIn" &&
        gemini.account.state === "signedIn"
          ? {
              ...gemini.account,
              method: `${gemini.account.method ?? "Google"} · Gemini CLI`,
            }
          : definition.account;
      return {
        ...definition,
        account: detectedGeminiAccount,
        consumerOauthDeprecated: true,
      };
    });
}

export interface AgentAccountInfo {
  state: "signedIn" | "signedOut" | "unknown" | "unsupported";
  /** Email/account label only. Authentication tokens never enter the WebView. */
  label: string | null;
  method: string | null;
}

export interface AgentInstallDefinition {
  executable: string | null;
  arguments: string[];
  displayCommand: string;
  sourceUrl: string;
  available: boolean;
}

export interface AgentTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  apiCalls: number;
}

export interface AgentSessionSummary {
  sessionId: string;
  /** CLIs sharing one tab carry the same groupId; defaults to sessionId. */
  groupId: string;
  /** User-facing tab name shared by every CLI in this group. */
  groupLabel: string;
  definitionId: string;
  /** Local account root; never part of a portable workspace export. */
  profileConfigPath?: string | null;
  /** CLI name; independent from the user-facing tab name. */
  label: string;
  /** Model announced by the CLI or explicitly supplied through --model. */
  model: string | null;
  executable: string;
  /** Original CLI arguments, retained so a safe relaunch can preserve options. */
  launchArguments: string[];
  /** True when this process was recreated from the persisted workspace. */
  restoreExistingSession?: boolean;
  workingDirectory: string;
  state: AgentLifecycle;
  stateSource: AgentStateSource;
  processId: number | null;
  /** Trusted cumulative token buckets supplied by a semantic adapter. */
  tokenUsage: AgentTokenUsage | null;
  /** Prompts waiting for this session to finish its current turn. */
  queuedPrompts: number;
  /** The CLI's own session id, once its output announced one. */
  capturedSessionId: string | null;
  /** Runs inside the file-scope sandbox. */
  sandboxed?: boolean;
  /** Owned by the background service: survives closing the window. */
  detached?: boolean;
  /** Frontend-only close state retained so terminal output does not disappear. */
  closedReason?: string | null;
}

export interface AgentLaunchRequest {
  definitionId: string;
  label: string;
  executable: string;
  arguments: string[];
  resumeSessionId: string | null;
  /** Join an existing tab's CLI group; omit to start a new tab. */
  groupId?: string | null;
  /** A handoff brief pasted in once the CLI is interactive; omit for none. */
  seedInput?: string | null;
  /** Relaunches saved work and must not inject the new-session instructions. */
  restoreExistingSession?: boolean;
  /** Local config root for a Codex/Claude account profile. */
  profileConfigPath?: string | null;
  /** Confine writes to the working directory and the CLI's own state. */
  sandbox?: boolean;
  /** Hand the session to the background service so it outlives the window. */
  detached?: boolean;
  workingDirectory: string;
  cols: number;
  rows: number;
}

export interface AgentMemoryHandoffRequest {
  targetDefinitionId: string;
  workingDirectory: string;
  sourceLabel: string;
  transcript: string;
}

export type AgentLaunchPlanDraft = Omit<
  AgentLaunchRequest,
  "cols" | "rows" | "restoreExistingSession" | "profileConfigPath"
> & {
  /** Free-text memo, e.g. which project this plan is for. "" means none. */
  note: string;
};

export interface AgentLaunchPlan extends AgentLaunchPlanDraft {
  id: string;
}

export interface AgentPlanRecovery {
  reason: string;
  backupPath: string;
}

interface AgentPlanSnapshot {
  workspaceName: string;
  startupInstructions: string;
  /** MCP clients may start the saved plans marked "keep in the background". */
  mcpLaunch?: boolean;
  plans: AgentLaunchPlan[];
  recovery: AgentPlanRecovery | null;
}

export interface AgentStateEvent {
  sessionId: string;
  state: AgentLifecycle;
  source: AgentStateSource;
}

export interface AgentModelEvent {
  sessionId: string;
  model: string;
}

export interface AgentUsageEvent {
  sessionId: string;
  tokenUsage: AgentTokenUsage;
}

export interface AgentQueueEvent {
  sessionId: string;
  queuedPrompts: number;
}

export interface AgentOutputEvent {
  sessionId: string;
  offset: number;
  base64: string;
}

export interface AgentOutputSnapshot {
  sessionId: string;
  startOffset: number;
  endOffset: number;
  base64: string;
}

export interface AgentOutputChunk {
  offset: number;
  bytes: Uint8Array;
}

export interface AgentBroadcastOutcome {
  sessionId: string;
  delivered: boolean;
  error: string | null;
}

export interface AgentRestoreOutcome {
  planId: string;
  label: string;
  session: AgentSessionSummary | null;
  error: string | null;
}

export function applyAgentStateEvent(
  sessions: AgentSessionSummary[],
  event: AgentStateEvent,
): AgentSessionSummary[] {
  return sessions.map((session) =>
    session.sessionId === event.sessionId
      ? { ...session, state: event.state, stateSource: event.source }
      : session,
  );
}

export function applyAgentUsageEvent(
  sessions: AgentSessionSummary[],
  event: AgentUsageEvent,
): AgentSessionSummary[] {
  return sessions.map((session) =>
    session.sessionId === event.sessionId
      ? { ...session, tokenUsage: event.tokenUsage }
      : session,
  );
}

export function applyAgentQueueEvent(
  sessions: AgentSessionSummary[],
  event: AgentQueueEvent,
): AgentSessionSummary[] {
  return sessions.map((session) =>
    session.sessionId === event.sessionId
      ? { ...session, queuedPrompts: event.queuedPrompts }
      : session,
  );
}

export function markAgentSessionClosed(
  sessions: AgentSessionSummary[],
  sessionId: string,
  reason: string,
): AgentSessionSummary[] {
  return sessions.map((session) =>
    session.sessionId === sessionId
      ? {
          ...session,
          state: "done",
          processId: null,
          closedReason: reason,
        }
      : session,
  );
}

const FALLBACK_CATALOG_SOURCE: [string, string, string, boolean][] = [
  ["codex", "OpenAI Codex", "codex", true],
  ["claude", "Claude Code", "claude", true],
  ["gemini", "Gemini CLI", "gemini", true],
  ["antigravity", "Google Antigravity CLI", "agy", false],
  ["opencode", "OpenCode", "opencode", false],
  ["copilot", "GitHub Copilot CLI", "copilot", false],
  ["hermes", "Hermes Agent", "hermes", true],
  ["cursor", "Cursor Agent", "agent", true],
  ["aider", "Aider", "aider", false],
  ["qwen", "Qwen Code", "qwen", false],
  ["kimi", "Kimi Code CLI", "kimi", false],
  ["droid", "Factory Droid", "droid", false],
  ["grok", "Grok CLI", "grok", false],
];

const FALLBACK_CATALOG: AgentDefinition[] = FALLBACK_CATALOG_SOURCE.map(
  ([id, label, executable, resumeSupported]) => ({
    id,
    label,
    executable,
    adapterVersion: 1,
    resumeSupported,
    resumeLatestSupported:
      id === "codex" || id === "antigravity" || id === "cursor",
    transcriptSupported:
      id === "codex" ||
      id === "claude" ||
      id === "gemini" ||
      id === "antigravity",
    installed: false,
    installedPath: null,
    consumerOauthDeprecated: id === "gemini",
    account: { state: "unsupported", label: null, method: null },
    install: {
      executable: null,
      arguments: [],
      displayCommand: "",
      sourceUrl: "",
      available: false,
    },
  }),
);

const MAX_PENDING_OUTPUT = 256 * 1024;
export const MAX_AGENT_BROADCAST_TARGETS = 32;
export const MAX_SAVED_AGENT_PLANS = 32;
export const CLAUDE_SAFE_MODE_STARTUP_WINDOW_MS = 15_000;

function claudeCustomizationsAreAlreadyDisabled(
  launchArguments: string[],
): boolean {
  return launchArguments.some(
    (argument) => argument.trim() === "--safe-mode" || argument.trim() === "--bare",
  );
}

/**
 * A failing user Hook must not make LatticeTerm's Claude terminal unusable.
 * The first launch keeps every user customization. Only a non-zero startup
 * exit gets one recovery attempt in Claude's documented safe mode.
 */
export function claudeSafeModeFallbackRequest(
  request: AgentLaunchRequest,
  session: AgentSessionSummary,
  closedReason: string,
  launchedAt: number,
  closedAt: number,
): AgentLaunchRequest | null {
  if (
    request.definitionId !== "claude" ||
    session.definitionId !== "claude" ||
    closedAt - launchedAt > CLAUDE_SAFE_MODE_STARTUP_WINDOW_MS ||
    !/\bcode:\s*[1-9]\d*/i.test(closedReason) ||
    claudeCustomizationsAreAlreadyDisabled(request.arguments)
  ) {
    return null;
  }

  return {
    ...request,
    // Surface the degradation instead of silently hiding the fact that custom
    // Hook, plugin, and MCP configuration is not active in this fallback.
    label: `${session.label}（安全模式）`,
    executable: session.executable,
    groupId: session.groupId,
    arguments: ["--safe-mode", ...request.arguments],
  };
}

interface ClaudeStartupFallbackCandidate {
  request: AgentLaunchRequest;
  launchedAt: number;
}

interface AgentLaunchAttempt {
  /** Finishes once and returns every lifecycle event observed during the request. */
  finish: () => AgentLaunchEventSnapshot;
  /** Finishes without consuming buffered events, e.g. after an invoke error. */
  cancel: () => void;
}

export interface AgentLaunchEventSnapshot {
  closed: ReadonlyMap<string, string>;
  states: ReadonlyMap<string, AgentStateEvent>;
  capturedSessionIds: ReadonlyMap<string, string>;
  models: ReadonlyMap<string, string>;
  usages: ReadonlyMap<string, AgentTokenUsage>;
}

interface MutableAgentLaunchEvents {
  closed: Map<string, string>;
  states: Map<string, AgentStateEvent>;
  capturedSessionIds: Map<string, string>;
  models: Map<string, string>;
  usages: Map<string, AgentTokenUsage>;
}

function emptyAgentLaunchEvents(): MutableAgentLaunchEvents {
  return {
    closed: new Map(),
    states: new Map(),
    capturedSessionIds: new Map(),
    models: new Map(),
    usages: new Map(),
  };
}

function cloneAgentLaunchEvents(
  events: MutableAgentLaunchEvents,
): AgentLaunchEventSnapshot {
  return {
    closed: new Map(events.closed),
    states: new Map(events.states),
    capturedSessionIds: new Map(events.capturedSessionIds),
    models: new Map(events.models),
    usages: new Map(events.usages),
  };
}

/**
 * Records lifecycle events that beat an in-flight launch or restore response.
 * Per-attempt maps keep concurrent operations isolated and bound to each request.
 */
export class AgentLaunchRaceGuard {
  private readonly activeAttempts = new Set<MutableAgentLaunchEvents>();

  hasPendingAttempt(): boolean {
    return this.activeAttempts.size > 0;
  }

  begin(): AgentLaunchAttempt {
    const eventsDuringAttempt = emptyAgentLaunchEvents();
    this.activeAttempts.add(eventsDuringAttempt);
    let finished = false;
    const settle = () => {
      if (finished) return false;
      finished = true;
      this.activeAttempts.delete(eventsDuringAttempt);
      return true;
    };
    return {
      finish: () => {
        if (!settle()) return emptyAgentLaunchEvents();
        return cloneAgentLaunchEvents(eventsDuringAttempt);
      },
      cancel: () => {
        settle();
      },
    };
  }

  observeClosed(sessionId: string, reason: string) {
    for (const attempt of this.activeAttempts) {
      attempt.closed.set(sessionId, reason);
    }
  }

  observeState(event: AgentStateEvent) {
    for (const attempt of this.activeAttempts) {
      attempt.states.set(event.sessionId, event);
    }
  }

  observeCaptured(sessionId: string, nativeSessionId: string) {
    for (const attempt of this.activeAttempts) {
      attempt.capturedSessionIds.set(sessionId, nativeSessionId);
    }
  }

  observeModel(event: AgentModelEvent) {
    for (const attempt of this.activeAttempts) {
      attempt.models.set(event.sessionId, event.model);
    }
  }

  observeUsage(event: AgentUsageEvent) {
    for (const attempt of this.activeAttempts) {
      attempt.usages.set(event.sessionId, event.tokenUsage);
    }
  }
}

function agentStartupExitMessage(label: string, reason: string): string {
  return `${label} exited during startup: ${reason}`;
}

export function applyAgentLaunchEvents(
  session: AgentSessionSummary,
  events: AgentLaunchEventSnapshot,
): AgentSessionSummary {
  const state = events.states.get(session.sessionId);
  const capturedSessionId = events.capturedSessionIds.get(session.sessionId);
  const model = events.models.get(session.sessionId);
  const tokenUsage = events.usages.get(session.sessionId);
  return {
    ...session,
    ...(state ? { state: state.state, stateSource: state.source } : {}),
    ...(capturedSessionId ? { capturedSessionId } : {}),
    ...(model ? { model } : {}),
    ...(tokenUsage ? { tokenUsage } : {}),
  };
}

export function applyAgentRestoreLaunchEvents(
  outcomes: AgentRestoreOutcome[],
  events: AgentLaunchEventSnapshot,
): AgentRestoreOutcome[] {
  return outcomes.map((outcome) => {
    const session = outcome.session;
    if (!session) return outcome;
    const sessionId = session.sessionId;
    if (events.closed.has(sessionId)) {
      return {
        ...outcome,
        session: null,
        error: agentStartupExitMessage(
          outcome.label,
          events.closed.get(sessionId) ?? "Process exited",
        ),
      };
    }
    return {
      ...outcome,
      session: applyAgentLaunchEvents(session, events),
    };
  });
}

async function core() {
  return import("@tauri-apps/api/core");
}

async function events() {
  return import("@tauri-apps/api/event");
}

export function encodeAgentPayload(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function decodeAgentPayload(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function reconcileAgentOutputSnapshot(
  snapshot: AgentOutputSnapshot | null,
  events: AgentOutputEvent[],
): AgentOutputChunk[] {
  const chunks: AgentOutputChunk[] = [];
  let cursor = 0;
  if (snapshot) {
    const bytes = decodeAgentPayload(snapshot.base64);
    if (bytes.length !== snapshot.endOffset - snapshot.startOffset) {
      throw new Error("Agent output snapshot offsets are inconsistent.");
    }
    if (bytes.length > 0) {
      chunks.push({ offset: snapshot.startOffset, bytes });
    }
    cursor = snapshot.endOffset;
  }

  const ordered = [...events].sort((left, right) => left.offset - right.offset);
  for (const event of ordered) {
    const bytes = decodeAgentPayload(event.base64);
    const endOffset = event.offset + bytes.length;
    if (endOffset <= cursor) continue;
    const freshOffset = Math.max(cursor, event.offset);
    const fresh = bytes.subarray(freshOffset - event.offset);
    if (fresh.length > 0) chunks.push({ offset: freshOffset, bytes: fresh });
    cursor = endOffset;
  }
  return chunks;
}

export function splitAgentArguments(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((argument) => argument.trim())
    .filter(Boolean);
}

export function buildAgentBroadcastPayload(value: string): string {
  if (!value.trim()) return "";
  const normalized = value.replace(/\r?\n/g, "\r").replace(/\r+$/, "");
  return `${normalized}\r`;
}

export function moveAgentLaunchPlan(
  plans: AgentLaunchPlan[],
  id: string,
  offset: -1 | 1,
): AgentLaunchPlan[] {
  const index = plans.findIndex((plan) => plan.id === id);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= plans.length) return plans;
  const next = [...plans];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export interface AgentApi {
  mode: AgentBackendMode;
  error: string | null;
  catalog: AgentDefinition[];
  defaultWorkingDirectory: string;
  sessions: AgentSessionSummary[];
  lastClosed: SessionClosedNotice | null;
  workspaceName: string;
  startupInstructions: string;
  /** Whether MCP clients may start saved background plans. */
  mcpLaunch: boolean;
  plans: AgentLaunchPlan[];
  planRecovery: AgentPlanRecovery | null;
  refreshCatalog: () => Promise<void>;
  launch: (request: AgentLaunchRequest) => Promise<AgentSessionSummary>;
  /** Renames a CLI group's tab label; persists so a reload keeps it. */
  rename: (sessionId: string, label: string) => Promise<AgentSessionSummary>;
  savePlan: (draft: AgentLaunchPlanDraft) => Promise<AgentLaunchPlan>;
  renameWorkspace: (name: string) => Promise<string>;
  updateStartupInstructions: (instructions: string) => Promise<string>;
  updateMcpLaunch: (enabled: boolean) => Promise<boolean>;
  reorderPlans: (orderedIds: string[]) => Promise<AgentLaunchPlan[]>;
  deletePlan: (id: string) => Promise<boolean>;
  restorePlans: (planIds: string[]) => Promise<AgentRestoreOutcome[]>;
  send: (sessionId: string, data: string) => Promise<void>;
  /** Writes a clipboard image to a temp file and returns its path, or null. */
  pasteClipboardImage: (sessionId: string) => Promise<string | null>;
  /** Reads a CLI's conversation as text for a handoff, or null if unavailable. */
  exportTranscript: (sessionId: string) => Promise<string | null>;
  /** Writes an opt-in handoff to a target's known memory format, if supported. */
  importMemoryHandoff: (request: AgentMemoryHandoffRequest) => Promise<boolean>;
  /** Writes the handoff brief to a private file and returns its path. */
  writeHandoffFile: (sourceLabel: string, transcript: string) => Promise<string>;
  broadcast: (
    sessionIds: string[],
    prompt: string,
  ) => Promise<AgentBroadcastOutcome[]>;
  /**
   * Lines a prompt up behind whatever the agent is already doing. Resolves
   * with how many prompts are waiting; zero means it was free and took it.
   */
  enqueue: (sessionId: string, prompt: string) => Promise<number>;
  /** Drops everything still waiting, resolving with how many went. */
  clearQueue: (sessionId: string) => Promise<number>;
  resize: (sessionId: string, cols: number, rows: number) => Promise<void>;
  disconnect: (sessionId: string) => Promise<void>;
  clearLastClosed: () => void;
  onData: (
    sessionId: string,
    handler: (bytes: Uint8Array) => void,
  ) => () => void;
  onClosed: (
    sessionId: string,
    handler: (reason: string) => void,
  ) => () => void;
}

export function useAgentSessions(): AgentApi {
  const [mode, setMode] = useState<AgentBackendMode>("loading");
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<AgentDefinition[]>(FALLBACK_CATALOG);
  const [defaultWorkingDirectory, setDefaultWorkingDirectory] = useState("");
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [lastClosed, setLastClosed] = useState<SessionClosedNotice | null>(null);
  const [workspaceName, setWorkspaceName] = useState("");
  const [startupInstructions, setStartupInstructions] = useState("");
  const [plans, setPlans] = useState<AgentLaunchPlan[]>([]);
  const [mcpLaunch, setMcpLaunch] = useState(false);
  const [planRecovery, setPlanRecovery] = useState<AgentPlanRecovery | null>(
    null,
  );
  const dataHandlers = useRef(
    new Map<string, Set<(bytes: Uint8Array) => void>>(),
  );
  const closeHandlers = useRef(
    new Map<string, Set<(reason: string) => void>>(),
  );
  const pendingOutput = useRef(new Map<string, Uint8Array[]>());
  const pendingBytes = useRef(new Map<string, number>());
  const outputOffsets = useRef(new Map<string, number>());
  const sessionsRef = useRef(sessions);
  const intentionalDisconnects = useRef(new Set<string>());
  const launchRaceGuard = useRef(new AgentLaunchRaceGuard());
  const claudeStartupFallbacks = useRef(
    new Map<string, ClaudeStartupFallbackCandidate>(),
  );
  const launchRef = useRef<
    ((request: AgentLaunchRequest) => Promise<AgentSessionSummary>) | null
  >(null);
  sessionsRef.current = sessions;

  const refreshCatalog = useCallback(async () => {
    try {
      const { invoke } = await core();
      const [definitions, directory, planSnapshot] = await Promise.all([
        invoke<AgentDefinition[]>("agent_catalog"),
        invoke<string>("agent_default_working_directory"),
        invoke<AgentPlanSnapshot>("agent_plan_snapshot"),
      ]);
      setCatalog(definitions);
      setDefaultWorkingDirectory(directory);
      setWorkspaceName(planSnapshot.workspaceName);
      setStartupInstructions(planSnapshot.startupInstructions);
      setMcpLaunch(planSnapshot.mcpLaunch === true);
      setPlans(planSnapshot.plans);
      setPlanRecovery(planSnapshot.recovery);
      setError(null);
      setMode("ready");
    } catch (reason) {
      setCatalog(FALLBACK_CATALOG);
      setError(reason instanceof Error ? reason.message : String(reason));
      setMode("unavailable");
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let hydrating = true;
    const cleanups: (() => void)[] = [];
    const closedDuringHydration = new Set<string>();
    const outputDuringHydration = new Map<string, AgentOutputEvent[]>();
    const stateDuringHydration = new Map<string, AgentStateEvent>();
    const captureDuringHydration = new Map<string, string>();
    const modelDuringHydration = new Map<string, string>();
    const usageDuringHydration = new Map<string, AgentTokenUsage>();

    function keep(cleanup: () => void): boolean {
      if (disposed) {
        cleanup();
        return false;
      }
      cleanups.push(cleanup);
      return true;
    }

    function deliverOutput(
      sessionId: string,
      offset: number,
      bytes: Uint8Array,
    ) {
      const endOffset = offset + bytes.length;
      const cursor = outputOffsets.current.get(sessionId) ?? offset;
      if (endOffset <= cursor) return;
      const fresh = bytes.subarray(Math.max(0, cursor - offset));
      if (fresh.length === 0) return;
      outputOffsets.current.set(sessionId, endOffset);

      const handlers = dataHandlers.current.get(sessionId);
      if (handlers?.size) {
        handlers.forEach((handler) => handler(fresh));
        return;
      }

      const chunks = pendingOutput.current.get(sessionId) ?? [];
      let total = pendingBytes.current.get(sessionId) ?? 0;
      chunks.push(fresh);
      total += fresh.length;
      while (total > MAX_PENDING_OUTPUT && chunks.length > 0) {
        const overflow = total - MAX_PENDING_OUTPUT;
        const first = chunks[0];
        if (first.length <= overflow) {
          chunks.shift();
          total -= first.length;
        } else {
          chunks[0] = first.subarray(overflow);
          total -= overflow;
        }
      }
      pendingOutput.current.set(sessionId, chunks);
      pendingBytes.current.set(sessionId, total);
    }

    async function subscribeAndHydrate() {
      try {
        const [{ invoke }, { listen }] = await Promise.all([core(), events()]);

        const stopClosed = await listen<{
          sessionId: string;
          reason: string;
        }>("agent://closed", (event) => {
          const sessionId = event.payload.sessionId;
          if (hydrating) closedDuringHydration.add(sessionId);
          launchRaceGuard.current.observeClosed(
            sessionId,
            event.payload.reason,
          );
          const intentional = intentionalDisconnects.current.delete(sessionId);
          const knownSession = sessionsRef.current.find(
            (session) => session.sessionId === sessionId,
          );
          const fallbackCandidate = claudeStartupFallbacks.current.get(sessionId);
          claudeStartupFallbacks.current.delete(sessionId);
          const pendingLaunch = launchRaceGuard.current.hasPendingAttempt();
          if (!intentional && !knownSession && !pendingLaunch) {
            setLastClosed(
              createSessionClosedNotice(
                sessionsRef.current,
                sessionId,
                event.payload.reason,
                (session) => session.label,
              ),
            );
          }
          if (!intentional && knownSession && fallbackCandidate) {
            const fallback = claudeSafeModeFallbackRequest(
              fallbackCandidate.request,
              knownSession,
              event.payload.reason,
              fallbackCandidate.launchedAt,
              Date.now(),
            );
            if (fallback) {
              const launchInSafeMode = launchRef.current;
              if (launchInSafeMode) {
                void launchInSafeMode(fallback).catch((reason) => {
                  setError(
                    `Claude Code 安全模式重啟失敗：${
                      reason instanceof Error ? reason.message : String(reason)
                    }`,
                  );
                });
              }
            }
          }
          setSessions((current) => {
            const next = intentional
              ? current.filter((session) => session.sessionId !== sessionId)
              : markAgentSessionClosed(current, sessionId, event.payload.reason);
            sessionsRef.current = next;
            return next;
          });
          outputDuringHydration.delete(sessionId);
          if (intentional || (!knownSession && !pendingLaunch)) {
            pendingOutput.current.delete(sessionId);
            pendingBytes.current.delete(sessionId);
            outputOffsets.current.delete(sessionId);
          }
          closeHandlers.current
            .get(sessionId)
            ?.forEach((handler) => handler(event.payload.reason));
        });
        if (!keep(stopClosed)) return;

        const stopData = await listen<AgentOutputEvent>(
          "agent://data",
          (event) => {
            const payload = event.payload;
            if (hydrating) {
              const queued = outputDuringHydration.get(payload.sessionId) ?? [];
              queued.push(payload);
              outputDuringHydration.set(payload.sessionId, queued);
              return;
            }
            deliverOutput(
              payload.sessionId,
              payload.offset,
              decodeAgentPayload(payload.base64),
            );
          },
        );
        if (!keep(stopData)) return;

        const stopState = await listen<AgentStateEvent>(
          "agent://state",
          (event) => {
            launchRaceGuard.current.observeState(event.payload);
            if (hydrating) {
              stateDuringHydration.set(event.payload.sessionId, event.payload);
              return;
            }
            setSessions((current) =>
              applyAgentStateEvent(current, event.payload),
            );
          },
        );
        if (!keep(stopState)) return;

        const stopCapture = await listen<{
          sessionId: string;
          nativeSessionId: string;
        }>("agent://capture", (event) => {
          launchRaceGuard.current.observeCaptured(
            event.payload.sessionId,
            event.payload.nativeSessionId,
          );
          if (hydrating) {
            captureDuringHydration.set(
              event.payload.sessionId,
              event.payload.nativeSessionId,
            );
            return;
          }
          setSessions((current) =>
            current.map((session) =>
              session.sessionId === event.payload.sessionId
                ? {
                    ...session,
                    capturedSessionId: event.payload.nativeSessionId,
                  }
                : session,
            ),
          );
        });
        if (!keep(stopCapture)) return;

        const stopModel = await listen<AgentModelEvent>(
          "agent://model",
          (event) => {
            launchRaceGuard.current.observeModel(event.payload);
            if (hydrating) {
              modelDuringHydration.set(event.payload.sessionId, event.payload.model);
              return;
            }
            setSessions((current) =>
              current.map((session) =>
                session.sessionId === event.payload.sessionId
                  ? { ...session, model: event.payload.model }
                  : session,
              ),
            );
          },
        );
        if (!keep(stopModel)) return;

        const stopUsage = await listen<AgentUsageEvent>(
          "agent://usage",
          (event) => {
            launchRaceGuard.current.observeUsage(event.payload);
            if (hydrating) {
              usageDuringHydration.set(
                event.payload.sessionId,
                event.payload.tokenUsage,
              );
              return;
            }
            setSessions((current) =>
              applyAgentUsageEvent(current, event.payload),
            );
          },
        );
        if (!keep(stopUsage)) return;

        // The depth also arrives on the session summary, so a queue event
        // missed during hydration corrects itself on the next snapshot.
        const stopQueue = await listen<AgentQueueEvent>(
          "agent://queue",
          (event) => {
            if (hydrating) return;
            setSessions((current) =>
              applyAgentQueueEvent(current, event.payload),
            );
          },
        );
        if (!keep(stopQueue)) return;

        // A session somebody else started through the background service
        // (an MCP client): show it like one of ours. During hydration the
        // snapshot that follows already includes it.
        const stopLaunched = await listen<AgentSessionSummary>(
          "agent://launched",
          (event) => {
            if (hydrating) return;
            const launched = { ...event.payload, detached: true };
            setSessions((current) => {
              if (current.some((session) => session.sessionId === launched.sessionId)) {
                return current;
              }
              const next = [...current, launched];
              sessionsRef.current = next;
              return next;
            });
          },
        );
        if (!keep(stopLaunched)) return;

        const [
          definitions,
          directory,
          existingSessions,
          planSnapshot,
          outputSnapshots,
        ] = await Promise.all([
          invoke<AgentDefinition[]>("agent_catalog"),
          invoke<string>("agent_default_working_directory"),
          invoke<AgentSessionSummary[]>("agent_sessions"),
          invoke<AgentPlanSnapshot>("agent_plan_snapshot"),
          invoke<AgentOutputSnapshot[]>("agent_output_snapshots"),
        ]);
        if (disposed) return;

        const closedSnapshot = snapshotSessionIds(closedDuringHydration);
        const stateSnapshot = snapshotHydrationMap(stateDuringHydration);
        const captureSnapshot = snapshotHydrationMap(captureDuringHydration);
        const modelSnapshot = snapshotHydrationMap(modelDuringHydration);
        const usageSnapshot = snapshotHydrationMap(usageDuringHydration);
        setSessions((current) => {
          let restored = reconcileSessionSnapshot(
            current,
            existingSessions,
            closedSnapshot,
          );
          for (const event of stateSnapshot.values()) {
            restored = applyAgentStateEvent(restored, event);
          }
          return restored.map((session) => {
            const capturedSessionId = captureSnapshot.get(session.sessionId);
            const model = modelSnapshot.get(session.sessionId);
            const tokenUsage = usageSnapshot.get(session.sessionId);
            return {
              ...session,
              ...(capturedSessionId ? { capturedSessionId } : {}),
              ...(model ? { model } : {}),
              ...(tokenUsage ? { tokenUsage } : {}),
            };
          });
        });

        const snapshotsBySession = new Map(
          outputSnapshots.map((snapshot) => [snapshot.sessionId, snapshot]),
        );
        for (const snapshot of outputSnapshots) {
          if (closedDuringHydration.has(snapshot.sessionId)) continue;
          for (const chunk of reconcileAgentOutputSnapshot(
            snapshot,
            outputDuringHydration.get(snapshot.sessionId) ?? [],
          )) {
            deliverOutput(snapshot.sessionId, chunk.offset, chunk.bytes);
          }
        }
        for (const [sessionId, queued] of outputDuringHydration) {
          if (
            closedDuringHydration.has(sessionId) ||
            snapshotsBySession.has(sessionId)
          ) {
            continue;
          }
          for (const chunk of reconcileAgentOutputSnapshot(null, queued)) {
            deliverOutput(sessionId, chunk.offset, chunk.bytes);
          }
        }

        hydrating = false;
        closedDuringHydration.clear();
        outputDuringHydration.clear();
        stateDuringHydration.clear();
        captureDuringHydration.clear();
        modelDuringHydration.clear();
        usageDuringHydration.clear();
        setCatalog(definitions);
        setDefaultWorkingDirectory(directory);
        setWorkspaceName(planSnapshot.workspaceName);
        setStartupInstructions(planSnapshot.startupInstructions);
        setPlans(planSnapshot.plans);
        setPlanRecovery(planSnapshot.recovery);
        setError(null);
        setMode("ready");
      } catch (reason) {
        hydrating = false;
        closedDuringHydration.clear();
        outputDuringHydration.clear();
        stateDuringHydration.clear();
        captureDuringHydration.clear();
        modelDuringHydration.clear();
        usageDuringHydration.clear();
        setCatalog(FALLBACK_CATALOG);
        setError(reason instanceof Error ? reason.message : String(reason));
        setMode("unavailable");
      }
    }

    void subscribeAndHydrate();
    return () => {
      disposed = true;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, []);

  const launch = useCallback(async (request: AgentLaunchRequest) => {
    const { invoke } = await core();
    const launchedAt = Date.now();
    const attempt = launchRaceGuard.current.begin();
    try {
      const session = await invoke<AgentSessionSummary>("agent_launch", {
        request,
      });
      const launchEvents = attempt.finish();
      const closedReason = launchEvents.closed.get(session.sessionId) ?? null;
      const settledSession = applyAgentLaunchEvents(session, launchEvents);
      if (closedReason !== null) {
        const closedSession = markAgentSessionClosed(
          [settledSession],
          session.sessionId,
          closedReason,
        )[0];
        setSessions((current) => {
          const next = [
            ...current.filter((entry) => entry.sessionId !== session.sessionId),
            closedSession,
          ];
          sessionsRef.current = next;
          return next;
        });
        setLastClosed((current) =>
          current?.sessionId === session.sessionId ? null : current,
        );
        const fallback = claudeSafeModeFallbackRequest(
          request,
          session,
          closedReason,
          launchedAt,
          Date.now(),
        );
        if (fallback) {
          return (await launchRef.current?.(fallback)) ?? closedSession;
        }
        return closedSession;
      }
      setSessions((current) => {
        const next = [
          ...current.filter((entry) => entry.sessionId !== session.sessionId),
          settledSession,
        ];
        sessionsRef.current = next;
        return next;
      });
      if (
        request.definitionId === "claude" &&
        !claudeCustomizationsAreAlreadyDisabled(request.arguments)
      ) {
        claudeStartupFallbacks.current.set(session.sessionId, {
          request,
          launchedAt,
        });
        window.setTimeout(() => {
          claudeStartupFallbacks.current.delete(session.sessionId);
        }, CLAUDE_SAFE_MODE_STARTUP_WINDOW_MS);
      }
      return settledSession;
    } finally {
      attempt.cancel();
    }
  }, []);
  launchRef.current = launch;

  const rename = useCallback(async (sessionId: string, label: string) => {
    const { invoke } = await core();
    const updated = await invoke<AgentSessionSummary>("agent_rename", {
      sessionId,
      label,
    });
    setSessions((current) =>
      current.map((session) =>
        session.groupId === updated.groupId
          ? { ...session, groupLabel: updated.groupLabel }
          : session,
      ),
    );
    return updated;
  }, []);

  const savePlan = useCallback(async (draft: AgentLaunchPlanDraft) => {
    const { invoke } = await core();
    const plan = await invoke<AgentLaunchPlan>("agent_plan_save", { draft });
    setPlans((current) => {
      const index = current.findIndex((existing) => existing.id === plan.id);
      if (index < 0) return [...current, plan];
      return current.map((existing) => (existing.id === plan.id ? plan : existing));
    });
    return plan;
  }, []);

  const renameWorkspace = useCallback(async (name: string) => {
    const { invoke } = await core();
    const saved = await invoke<string>("agent_workspace_rename", { name });
    setWorkspaceName(saved);
    return saved;
  }, []);

  const updateStartupInstructions = useCallback(async (instructions: string) => {
    const { invoke } = await core();
    const saved = await invoke<string>("agent_workspace_instructions_update", {
      instructions,
    });
    setStartupInstructions(saved);
    return saved;
  }, []);

  const updateMcpLaunch = useCallback(async (enabled: boolean) => {
    const { invoke } = await core();
    const saved = await invoke<boolean>("agent_workspace_mcp_launch_update", { enabled });
    setMcpLaunch(saved);
    return saved;
  }, []);

  const reorderPlans = useCallback(async (orderedIds: string[]) => {
    const { invoke } = await core();
    const reordered = await invoke<AgentLaunchPlan[]>("agent_plan_reorder", {
      orderedIds,
    });
    setPlans(reordered);
    return reordered;
  }, []);

  const deletePlan = useCallback(async (id: string) => {
    const { invoke } = await core();
    const deleted = await invoke<boolean>("agent_plan_delete", { id });
    if (deleted) {
      setPlans((current) => current.filter((plan) => plan.id !== id));
    }
    return deleted;
  }, []);

  const restorePlans = useCallback(async (planIds: string[]) => {
    const { invoke } = await core();
    const attempt = launchRaceGuard.current.begin();
    try {
      const outcomes = await invoke<AgentRestoreOutcome[]>("agent_plan_restore", {
        planIds,
      });
      const currentSessions =
        await invoke<AgentSessionSummary[]>("agent_sessions");
      const launchEvents = attempt.finish();
      const closedSessionIds = new Set(launchEvents.closed.keys());
      setSessions((current) =>
        reconcileSessionSnapshot(current, currentSessions, closedSessionIds).map(
          (session) => applyAgentLaunchEvents(session, launchEvents),
        ),
      );
      return applyAgentRestoreLaunchEvents(outcomes, launchEvents);
    } finally {
      attempt.cancel();
    }
  }, []);

  const send = useCallback(async (sessionId: string, data: string) => {
    if (
      sessionsRef.current.some(
        (session) => session.sessionId === sessionId && session.closedReason,
      )
    ) {
      throw new Error("This agent session has already ended.");
    }
    const { invoke } = await core();
    await invoke("agent_send", {
      sessionId,
      data: encodeAgentPayload(new TextEncoder().encode(data)),
    });
  }, []);

  const pasteClipboardImage = useCallback(
    async (sessionId: string): Promise<string | null> => {
      const { invoke } = await core();
      return invoke<string | null>("agent_paste_clipboard_image", {
        sessionId,
      });
    },
    [],
  );

  const exportTranscript = useCallback(
    async (sessionId: string): Promise<string | null> => {
      const { invoke } = await core();
      return invoke<string | null>("agent_export_transcript", { sessionId });
    },
    [],
  );

  const importMemoryHandoff = useCallback(
    async (request: AgentMemoryHandoffRequest): Promise<boolean> => {
      const { invoke } = await core();
      return invoke<boolean>("agent_import_memory_handoff", { ...request });
    },
    [],
  );

  const writeHandoffFile = useCallback(
    async (sourceLabel: string, transcript: string): Promise<string> => {
      const { invoke } = await core();
      return invoke<string>("agent_write_handoff_file", { sourceLabel, transcript });
    },
    [],
  );

  /**
   * Lines a prompt up behind whatever the agent is already doing.
   *
   * Resolves with how many prompts are waiting; zero means the agent was free
   * and took it at once.
   */
  const enqueue = useCallback(async (sessionId: string, prompt: string) => {
    // A queued prompt is submitted exactly as a broadcast one is, so the two
    // paths cannot disagree about line endings or trailing returns.
    const payload = buildAgentBroadcastPayload(prompt);
    if (!payload) throw new Error("A queued prompt is required.");
    const { invoke } = await core();
    return invoke<number>("agent_enqueue", {
      sessionId,
      data: encodeAgentPayload(new TextEncoder().encode(payload)),
    });
  }, []);

  const clearQueue = useCallback(async (sessionId: string) => {
    const { invoke } = await core();
    return invoke<number>("agent_clear_queue", { sessionId });
  }, []);

  const broadcast = useCallback(async (sessionIds: string[], prompt: string) => {
    const payload = buildAgentBroadcastPayload(prompt);
    if (!payload) throw new Error("A broadcast prompt is required.");
    const { invoke } = await core();
    return invoke<AgentBroadcastOutcome[]>("agent_broadcast", {
      sessionIds,
      data: encodeAgentPayload(new TextEncoder().encode(payload)),
    });
  }, []);

  const resize = useCallback(
    async (sessionId: string, cols: number, rows: number) => {
      if (
        sessionsRef.current.some(
          (session) => session.sessionId === sessionId && session.closedReason,
        )
      ) {
        return;
      }
      const { invoke } = await core();
      await invoke("agent_resize", { sessionId, cols, rows });
    },
    [],
  );

  const disconnect = useCallback(async (sessionId: string) => {
    const closed = sessionsRef.current.some(
      (session) => session.sessionId === sessionId && session.closedReason,
    );
    if (closed) {
      setSessions((current) => {
        const next = current.filter((session) => session.sessionId !== sessionId);
        sessionsRef.current = next;
        return next;
      });
      pendingOutput.current.delete(sessionId);
      pendingBytes.current.delete(sessionId);
      outputOffsets.current.delete(sessionId);
      dataHandlers.current.delete(sessionId);
      closeHandlers.current.delete(sessionId);
      return;
    }
    intentionalDisconnects.current.add(sessionId);
    try {
      const { invoke } = await core();
      await invoke("agent_disconnect", { sessionId });
      setSessions((current) =>
        current.filter((session) => session.sessionId !== sessionId),
      );
    } catch (reason) {
      intentionalDisconnects.current.delete(sessionId);
      throw reason;
    }
  }, []);

  const clearLastClosed = useCallback(() => setLastClosed(null), []);

  const onData = useCallback(
    (sessionId: string, handler: (bytes: Uint8Array) => void) => {
      const handlers = dataHandlers.current.get(sessionId) ?? new Set();
      handlers.add(handler);
      dataHandlers.current.set(sessionId, handlers);

      const pending = pendingOutput.current.get(sessionId);
      if (pending) {
        pending.forEach(handler);
        pendingOutput.current.delete(sessionId);
        pendingBytes.current.delete(sessionId);
      }

      return () => {
        handlers.delete(handler);
        if (handlers.size === 0) dataHandlers.current.delete(sessionId);
      };
    },
    [],
  );

  const onClosed = useCallback(
    (sessionId: string, handler: (reason: string) => void) => {
      const handlers = closeHandlers.current.get(sessionId) ?? new Set();
      handlers.add(handler);
      closeHandlers.current.set(sessionId, handlers);
      return () => {
        handlers.delete(handler);
        if (handlers.size === 0) closeHandlers.current.delete(sessionId);
      };
    },
    [],
  );

  return {
    mode,
    error,
    catalog,
    defaultWorkingDirectory,
    sessions,
    lastClosed,
    workspaceName,
    startupInstructions,
    mcpLaunch,
    plans,
    planRecovery,
    refreshCatalog,
    launch,
    rename,
    savePlan,
    renameWorkspace,
    updateStartupInstructions,
    updateMcpLaunch,
    reorderPlans,
    deletePlan,
    restorePlans,
    send,
    pasteClipboardImage,
    exportTranscript,
    importMemoryHandoff,
    writeHandoffFile,
    broadcast,
    enqueue,
    clearQueue,
    resize,
    disconnect,
    clearLastClosed,
    onData,
    onClosed,
  };
}
