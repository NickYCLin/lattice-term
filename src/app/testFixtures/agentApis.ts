/**
 * Complete, inert implementations of the hook APIs the views take, for
 * render tests.  Every function resolves to something harmless; tests
 * override only the fields they care about.
 */
import { vi } from "vitest";
import type { ChatThread } from "../agentChat";
import { emptySessionSidebarLayout } from "../sessionSidebarLayout";
import type { AgentAutomationsApi } from "../useAgentAutomations";
import type { AgentChatApi } from "../useAgentChat";
import type {
  AgentApi,
  AgentDefinition,
  AgentSessionSummary,
} from "../useAgentSessions";
import type { RemoteApi } from "../useRemoteSessions";

export function fakeDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "codex",
    label: "OpenAI Codex",
    executable: "codex",
    adapterVersion: 1,
    resumeSupported: true,
    resumeLatestSupported: true,
    transcriptSupported: true,
    installed: true,
    installedPath: "/usr/local/bin/codex",
    consumerOauthDeprecated: false,
    account: { state: "signedIn", label: "me@example.com", method: "ChatGPT" },
    install: {
      executable: "npm",
      arguments: ["install", "-g", "@openai/codex"],
      displayCommand: "npm install -g @openai/codex",
      sourceUrl: "https://example.com/codex",
      available: true,
    },
    ...overrides,
  };
}

export function fakeSession(overrides: Partial<AgentSessionSummary> = {}): AgentSessionSummary {
  return {
    sessionId: "s1",
    groupId: "g1",
    groupLabel: "Codex",
    definitionId: "codex",
    label: "Codex",
    model: null,
    executable: "codex",
    launchArguments: [],
    workingDirectory: "/work",
    state: "idle",
    stateSource: "heuristic",
    processId: 100,
    tokenUsage: null,
    queuedPrompts: 0,
    capturedSessionId: null,
    ...overrides,
  };
}

export function fakeAgentApi(overrides: Partial<AgentApi> = {}): AgentApi {
  return {
    mode: "ready",
    error: null,
    catalog: [fakeDefinition()],
    defaultWorkingDirectory: "/work",
    sessions: [],
    lastClosed: null,
    workspaceName: "",
    startupInstructions: "",
    mcpLaunch: false,
    plans: [],
    planRecovery: null,
    refreshCatalog: vi.fn(async () => {}),
    launch: vi.fn(async () => fakeSession()),
    rename: vi.fn(async () => fakeSession()),
    savePlan: vi.fn(async () => {
      throw new Error("not in this test");
    }),
    renameWorkspace: vi.fn(async (name: string) => name),
    updateStartupInstructions: vi.fn(async (value: string) => value),
    updateMcpLaunch: vi.fn(async (enabled: boolean) => enabled),
    reorderPlans: vi.fn(async () => []),
    deletePlan: vi.fn(async () => true),
    restorePlans: vi.fn(async () => []),
    send: vi.fn(async () => {}),
    pasteClipboardImage: vi.fn(async () => null),
    exportTranscript: vi.fn(async () => null),
    importMemoryHandoff: vi.fn(async () => false),
    writeHandoffFile: vi.fn(async () => "/tmp/handoff.md"),
    broadcast: vi.fn(async () => []),
    enqueue: vi.fn(async () => 0),
    clearQueue: vi.fn(async () => 0),
    resize: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    clearLastClosed: vi.fn(),
    onData: vi.fn(() => () => {}),
    onClosed: vi.fn(() => () => {}),
    ...overrides,
  };
}

export function fakeRemoteApi(overrides: Partial<RemoteApi> = {}): RemoteApi {
  return {
    sessions: [],
    transfers: {},
    lastClosed: null,
    connect: vi.fn(async () => {
      throw new Error("not in this test");
    }),
    disconnect: vi.fn(async () => {}),
    input: vi.fn(async () => {}),
    terminalInput: vi.fn(async () => {}),
    terminalResize: vi.fn(async () => {}),
    onTerminalData: vi.fn(() => () => {}),
    listFiles: vi.fn(async () => ({ path: "/", entries: [] }) as never),
    readTextFile: vi.fn(async () => { throw new Error("not in this test"); }),
    saveTextFile: vi.fn(async () => { throw new Error("not in this test"); }),
    downloadFile: vi.fn(async () => {
      throw new Error("not in this test");
    }),
    uploadFile: vi.fn(async () => {}),
    cancelFileTransfer: vi.fn(async () => {}),
    dismissFileTransfer: vi.fn(async () => {}),
    clearLastClosed: vi.fn(),
    ...overrides,
  };
}

export function fakeThread(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: "t1",
    definitionId: "codex",
    title: "新對話",
    workingDirectory: "/work",
    permission: "ask",
    model: "",
    accountProfileId: null,
    nativeSessionId: null,
    reportedModel: null,
    handoff: null,
    items: [],
    createdAt: 1,
    updatedAt: 1,
    runningTurnId: null,
    automationId: null,
    unread: false,
    ...overrides,
  };
}

export function fakeChatApi(overrides: Partial<AgentChatApi> = {}): AgentChatApi {
  return {
    threads: [],
    activeThreadId: null,
    setActiveThreadId: vi.fn(),
    supported: ["claude", "codex", "gemini"],
    createThread: vi.fn(() => fakeThread()),
    importRecordedTurn: vi.fn(() => fakeThread({ unread: true })),
    markUnread: vi.fn(),
    updateThread: vi.fn(),
    handoffThread: vi.fn(),
    handoffThreadAccount: vi.fn(),
    removeThread: vi.fn(),
    send: vi.fn(async () => {}),
    enqueue: vi.fn(),
    steer: vi.fn(async () => {}),
    removeQueued: vi.fn(),
    resumeQueue: vi.fn(),
    stop: vi.fn(async () => {}),
    respond: vi.fn(async () => {}),
    models: {
      claude: { state: "idle" },
      codex: { state: "idle" },
      gemini: { state: "idle" },
    },
    loadModels: vi.fn(),
    layout: emptySessionSidebarLayout,
    createFolder: vi.fn(),
    renameFolder: vi.fn(),
    removeFolder: vi.fn(),
    moveNode: vi.fn(),
    toggleFolder: vi.fn(),
    ...overrides,
  };
}

export function fakeAutomationsApi(
  overrides: Partial<AgentAutomationsApi> = {},
): AgentAutomationsApi {
  return {
    automations: [],
    create: vi.fn(() => {
      throw new Error("not in this test");
    }),
    update: vi.fn(),
    setEnabled: vi.fn(),
    remove: vi.fn(),
    runNow: vi.fn(),
    unreadCount: 0,
    ...overrides,
  };
}

/** A `localStorage` stand-in for tests that render code reading it. */
export function installFakeStorage(seed: Record<string, string> = {}): () => void {
  const values = new Map(Object.entries(seed));
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
  const globals = globalThis as { localStorage?: Storage };
  const previous = globals.localStorage;
  globals.localStorage = storage as Storage;
  return () => {
    if (previous === undefined) delete globals.localStorage;
    else globals.localStorage = previous;
  };
}
