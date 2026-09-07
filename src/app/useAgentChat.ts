/**
 * Chat threads with an agent CLI, kept in the WebView and driven by the
 * Rust chat runner.
 *
 * Threads persist in browser storage so a conversation can be picked up
 * after a restart: the CLI's own session id is what makes that work, and
 * the messages shown are a bounded local copy. A running turn never
 * survives a reload, because its process belonged to the window that went.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatCompletionTracker } from "./chatCompletion";
import { playNotificationSound, type NotificationSoundChoice } from "./notificationSounds";
import {
  applyChatEvent,
  beginTurn,
  createThread,
  decideApproval,
  failTurn,
  handoffThreadAccount,
  handoffThread,
  changeThreadDirectory,
  selectThreadModel,
  promptForTurn,
  loadStoredThreads,
  saveStoredThreads,
  type ChatDefinitionId,
  type ChatAttachment,
  type ChatEvent,
  type ChatEventEnvelope,
  type ChatModelChoice,
  type ChatModelList,
  type ChatPermission,
  type ChatThread,
} from "./agentChat";
import { hasDesktopBackend } from "./nativeRuntime";
import {
  CHAT_SIDEBAR_LAYOUT_KEY,
  chatFolderNodeId,
  chatThreadNodeId,
  reconcileChatLayout,
} from "./chatThreadLayout";
import {
  createSessionSidebarFolder,
  emptySessionSidebarLayout,
  expandSessionSidebarAncestors,
  loadSessionSidebarLayout,
  moveSessionSidebarNode,
  removeSessionSidebarFolder,
  renameSessionSidebarFolder,
  saveSessionSidebarLayout,
  toggleSessionSidebarFolder,
  type SessionSidebarLayout,
} from "./sessionSidebarLayout";

async function core() {
  return import("@tauri-apps/api/core");
}

async function events() {
  return import("@tauri-apps/api/event");
}

const EVENT_CHAT = "agent-chat://event";
const SAVE_DELAY_MS = 400;
const FALLBACK_SUPPORTED: ChatDefinitionId[] = ["claude", "codex", "gemini"];

export interface ChatThreadSettings {
  browserEnabled?: boolean;
  definitionId: ChatDefinitionId;
  workingDirectory: string;
  permission: ChatPermission;
  model: string;
  accountProfileId?: string | null;
}

export interface ChatThreadCreation extends ChatThreadSettings {
  title?: string;
  automationId?: string;
  /** False keeps the current thread in front, for runs started by a schedule. */
  activate?: boolean;
}

export interface AgentChatApi {
  threads: ChatThread[];
  activeThreadId: string | null;
  setActiveThreadId: (id: string | null) => void;
  /** CLIs the backend can drive in chat mode. */
  supported: readonly ChatDefinitionId[];
  createThread: (settings: ChatThreadCreation) => ChatThread;
  /**
   * A turn that already happened elsewhere (the background service ran an
   * automation): the thread is created and the recorded events are folded
   * in through the same reducer a live turn uses, then marked unread.
   */
  importRecordedTurn: (
    settings: ChatThreadCreation,
    turnId: string,
    prompt: string,
    events: readonly ChatEvent[],
    startedAt: number,
  ) => ChatThread;
  /** Flags a thread as having news the user has not seen. */
  markUnread: (id: string, unread: boolean) => void;
  updateThread: (id: string, patch: Partial<ChatThreadSettings>) => void;
  /** Starts a new native conversation with another CLI and carries safe context. */
  handoffThread: (id: string, definitionId: ChatDefinitionId, model: string) => void;
  handoffThreadAccount: (id: string, accountProfileId: string | null) => void;
  removeThread: (id: string) => void;
  send: (
    id: string,
    prompt: string,
    attachments?: readonly ChatAttachment[],
    profileConfigPath?: string | null,
  ) => Promise<void>;
  stop: (id: string) => Promise<void>;
  /** Answers an approval card; rejects with the reason when it cannot. */
  respond: (id: string, requestId: string, allow: boolean, message?: string) => Promise<void>;
  /** The models a CLI offers, fetched once per session on first request. */
  models: Record<ChatDefinitionId, ChatModelList>;
  loadModels: (definitionId: ChatDefinitionId) => void;
  /** Folders and ordering of the thread list. */
  layout: SessionSidebarLayout;
  createFolder: (name: string, parentId: string | null) => void;
  renameFolder: (folderId: string, name: string) => void;
  removeFolder: (folderId: string) => void;
  moveNode: (nodeId: string, parentId: string | null, beforeNodeId: string | null) => void;
  toggleFolder: (folderId: string) => void;
}

export function useAgentChat(completionSound: NotificationSoundChoice = "off"): AgentChatApi {
  const completionTracker = useRef(new ChatCompletionTracker());
  const soundRef = useRef(completionSound);
  soundRef.current = completionSound;
  const [threads, setThreads] = useState<ChatThread[]>(() =>
    typeof localStorage === "undefined" ? [] : loadStoredThreads(localStorage),
  );
  const [activeThreadId, setActiveThreadId] = useState<string | null>(
    () => threads[0]?.id ?? null,
  );
  const [supported, setSupported] = useState<ChatDefinitionId[]>(FALLBACK_SUPPORTED);
  const [models, setModels] = useState<Record<ChatDefinitionId, ChatModelList>>({
    claude: { state: "idle" },
    codex: { state: "idle" },
    gemini: { state: "idle" },
  });
  const modelsRef = useRef(models);
  modelsRef.current = models;
  const [storedLayout, setStoredLayout] = useState<SessionSidebarLayout>(() =>
    typeof localStorage === "undefined"
      ? emptySessionSidebarLayout
      : loadSessionSidebarLayout(localStorage, CHAT_SIDEBAR_LAYOUT_KEY),
  );
  // What the sidebar renders: the saved organisation fitted to the threads
  // that exist right now.
  const layout = useMemo(() => reconcileChatLayout(storedLayout, threads), [storedLayout, threads]);

  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    try {
      saveSessionSidebarLayout(localStorage, layout, CHAT_SIDEBAR_LAYOUT_KEY);
    } catch {
      // Folders are a convenience; losing them costs no conversation.
    }
  }, [layout]);
  const threadsRef = useRef(threads);
  threadsRef.current = threads;

  // Persist a little after the last change so a streaming reply does not
  // rewrite storage on every token.
  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    const timer = setTimeout(() => saveStoredThreads(localStorage, threads), SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [threads]);

  useEffect(() => {
    if (!hasDesktopBackend()) return;
    let disposed = false;
    let stop: (() => void) | null = null;

    (async () => {
      const [{ invoke }, { listen }] = await Promise.all([core(), events()]);
      invoke<string[]>("agent_chat_supported")
        .then((ids) => {
          if (disposed) return;
          const known = ids.filter(
            (id): id is ChatDefinitionId =>
              id === "claude" || id === "codex" || id === "gemini",
          );
          if (known.length > 0) setSupported(known);
        })
        .catch(() => {
          // An older backend without chat mode: the fallback list stands and
          // sending reports the real reason.
        });
      const unlisten = await listen<ChatEventEnvelope>(EVENT_CHAT, (event) => {
        const envelope = event.payload;
        if (completionTracker.current.accept(envelope)) {
          void playNotificationSound(soundRef.current);
        }
        setThreads((current) =>
          current.map((thread) =>
            thread.id === envelope.threadId ? applyChatEvent(thread, envelope) : thread,
          ),
        );
      });
      if (disposed) unlisten();
      else stop = unlisten;
    })().catch(() => {
      // Without the event bridge a turn can still be started; its reply
      // would simply never arrive, and the send error explains why.
    });

    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  const create = useCallback((settings: ChatThreadCreation) => {
    const thread = createThread(settings);
    // The ref is what `send` consults, and a caller that creates a thread
    // and sends into it in the same tick (an automation firing) runs before
    // React has rendered the new state. Keep the ref current now.
    threadsRef.current = [thread, ...threadsRef.current];
    setThreads((current) => [thread, ...current]);
    if (settings.activate !== false) setActiveThreadId(thread.id);
    return thread;
  }, []);

  const importRecordedTurn = useCallback(
    (
      settings: ChatThreadCreation,
      turnId: string,
      prompt: string,
      events: readonly ChatEvent[],
      startedAt: number,
    ) => {
      let thread = beginTurn(createThread({ ...settings }), prompt, turnId, startedAt, []);
      for (const event of events) {
        thread = applyChatEvent(thread, { threadId: thread.id, turnId, event }, startedAt);
      }
      thread = { ...thread, runningTurnId: null, unread: true };
      threadsRef.current = [thread, ...threadsRef.current];
      setThreads((current) => [thread, ...current]);
      return thread;
    },
    [],
  );

  const markUnread = useCallback((id: string, unread: boolean) => {
    setThreads((current) =>
      current.map((thread) =>
        thread.id === id && thread.unread !== unread ? { ...thread, unread } : thread,
      ),
    );
  }, []);

  // Opening a thread is reading it, and it must be visible: a thread inside
  // a collapsed folder unfolds its way to the top.
  const activate = useCallback(
    (id: string | null) => {
      setActiveThreadId(id);
      if (id) {
        markUnread(id, false);
        setStoredLayout((current) =>
          expandSessionSidebarAncestors(
            reconcileChatLayout(current, threadsRef.current),
            chatThreadNodeId(id),
          ),
        );
      }
    },
    [markUnread],
  );

  const createFolder = useCallback((name: string, parentId: string | null) => {
    setStoredLayout((current) =>
      createSessionSidebarFolder(
        reconcileChatLayout(current, threadsRef.current),
        { id: chatFolderNodeId(), name },
        parentId,
      ),
    );
  }, []);

  const renameFolder = useCallback((folderId: string, name: string) => {
    setStoredLayout((current) => renameSessionSidebarFolder(current, folderId, name));
  }, []);

  const removeFolder = useCallback((folderId: string) => {
    setStoredLayout((current) =>
      removeSessionSidebarFolder(reconcileChatLayout(current, threadsRef.current), folderId),
    );
  }, []);

  const moveNode = useCallback(
    (nodeId: string, parentId: string | null, beforeNodeId: string | null) => {
      setStoredLayout((current) =>
        moveSessionSidebarNode(
          reconcileChatLayout(current, threadsRef.current),
          nodeId,
          parentId,
          beforeNodeId,
        ),
      );
    },
    [],
  );

  const toggleFolder = useCallback((folderId: string) => {
    setStoredLayout((current) => toggleSessionSidebarFolder(current, folderId));
  }, []);

  const update = useCallback((id: string, patch: Partial<ChatThreadSettings>) => {
    setThreads((current) =>
      current.map((thread) => {
        if (thread.id !== id || thread.runningTurnId) return thread;
        const next = selectThreadModel(thread, {
          definitionId: patch.definitionId ?? thread.definitionId,
          accountProfileId: patch.accountProfileId === undefined
            ? (patch.definitionId && patch.definitionId !== thread.definitionId ? null : thread.accountProfileId)
            : patch.accountProfileId,
          model: patch.model ?? thread.model,
        });
        return {
          ...changeThreadDirectory(next, patch.workingDirectory ?? next.workingDirectory),
          browserEnabled: next.definitionId === "codex" && (patch.browserEnabled ?? next.browserEnabled) === true,
          permission: patch.permission ?? next.permission,
        };
      }),
    );
  }, []);

  const handoff = useCallback((id: string, definitionId: ChatDefinitionId, model: string) => {
    setThreads((current) =>
      current.map((thread) =>
        thread.id === id ? handoffThread(thread, definitionId, model) : thread,
      ),
    );
  }, []);

  const handoffAccount = useCallback((id: string, accountProfileId: string | null) => {
    setThreads((current) =>
      current.map((thread) =>
        thread.id === id ? handoffThreadAccount(thread, accountProfileId) : thread,
      ),
    );
  }, []);

  const remove = useCallback((id: string) => {
    completionTracker.current.cancel(id);
    // A Codex thread keeps a server alive between turns; closing the thread
    // must end it whether or not a turn is running.
    if (hasDesktopBackend()) {
      core()
        .then(({ invoke }) => invoke("agent_chat_close", { threadId: id }))
        .catch(() => {});
    }
    setThreads((current) => current.filter((thread) => thread.id !== id));
    setActiveThreadId((current) => {
      if (current !== id) return current;
      const remaining = threadsRef.current.filter((thread) => thread.id !== id);
      return remaining[0]?.id ?? null;
    });
  }, []);

  const send = useCallback(async (
    id: string,
    prompt: string,
    attachments: readonly ChatAttachment[] = [],
    profileConfigPath: string | null = null,
  ) => {
    const thread = threadsRef.current.find((entry) => entry.id === id);
    if (!thread || thread.runningTurnId) return;
    const turnId = crypto.randomUUID();
    completionTracker.current.start(id, turnId);
    const visiblePrompt = prompt.trim() ? prompt : "Please inspect the attached files.";
    setThreads((current) =>
      current.map((entry) =>
        entry.id === id ? beginTurn(entry, prompt, turnId, Date.now(), attachments) : entry,
      ),
    );
    try {
      const { invoke } = await core();
      await invoke("agent_chat_send", {
        request: {
          threadId: thread.id,
          turnId,
          definitionId: thread.definitionId,
          workingDirectory: thread.workingDirectory,
          browserEnabled: thread.definitionId === "codex" && thread.browserEnabled === true,
          prompt: promptForTurn(thread, visiblePrompt),
          permission: thread.permission,
          model: thread.model.trim() || null,
          profileConfigPath,
          nativeSessionId: thread.nativeSessionId,
          attachments: attachments.map(({ path }) => ({ path })),
        },
      });
    } catch (reason) {
      completionTracker.current.cancel(id);
      const message = reason instanceof Error ? reason.message : String(reason);
      setThreads((current) =>
        current.map((entry) => (entry.id === id ? failTurn(entry, turnId, message) : entry)),
      );
    }
  }, []);

  const respond = useCallback(async (id: string, requestId: string, allow: boolean, message?: string) => {
    const { invoke } = await core();
    await invoke("agent_chat_respond", { threadId: id, requestId, allow, message: message ?? null });
    setThreads((current) =>
      current.map((entry) =>
        entry.id === id
          ? decideApproval(entry, requestId, allow ? "allowed" : "denied")
          : entry,
      ),
    );
  }, []);

  const loadModels = useCallback((definitionId: ChatDefinitionId) => {
    if (modelsRef.current[definitionId].state !== "idle") return;
    if (!hasDesktopBackend()) {
      setModels((current) => ({
        ...current,
        [definitionId]: { state: "unavailable", reason: "browser" },
      }));
      return;
    }
    setModels((current) => ({ ...current, [definitionId]: { state: "loading" } }));
    core()
      .then(({ invoke }) => invoke<ChatModelChoice[]>("agent_chat_models", { definitionId }))
      .then((list) => {
        setModels((current) => ({
          ...current,
          [definitionId]:
            list.length > 0
              ? { state: "ready", models: list }
              : { state: "unavailable", reason: "empty" },
        }));
      })
      .catch((reason) => {
        setModels((current) => ({
          ...current,
          [definitionId]: {
            state: "unavailable",
            reason: reason instanceof Error ? reason.message : String(reason),
          },
        }));
      });
  }, []);

  const stopTurn = useCallback(async (id: string) => {
    completionTracker.current.cancel(id);
    const { invoke } = await core();
    await invoke<boolean>("agent_chat_stop", { threadId: id });
  }, []);

  return useMemo(
    () => ({
      threads,
      activeThreadId,
      setActiveThreadId: activate,
      supported,
      createThread: create,
      importRecordedTurn,
      markUnread,
      updateThread: update,
      handoffThread: handoff,
      handoffThreadAccount: handoffAccount,
      removeThread: remove,
      send,
      stop: stopTurn,
      respond,
      models,
      loadModels,
      layout,
      createFolder,
      renameFolder,
      removeFolder,
      moveNode,
      toggleFolder,
    }),
    [
      threads,
      activeThreadId,
      activate,
      supported,
      create,
      importRecordedTurn,
      markUnread,
      update,
      handoff,
      handoffAccount,
      remove,
      send,
      stopTurn,
      respond,
      models,
      loadModels,
      layout,
      createFolder,
      renameFolder,
      removeFolder,
      moveNode,
      toggleFolder,
    ],
  );
}
