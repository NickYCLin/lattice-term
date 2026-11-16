import { BackgroundHistoryPicker } from "../components/chat/BackgroundHistoryPicker";
import { CompactionNotice } from "../components/chat/CompactionNotice";
import { MemorySaveButton } from "../components/chat/MemorySaveButton";
import { NativeRecordView, NativeHistoryAccess } from "../components/chat/NativeRecordView";
import { ComposerPermissionMenu } from "../components/chat/ComposerPermissionMenu";
import { recordRecentProject } from "../app/recentProjects";
import { chatToolRows, presentTool, toolHasProtectedContent, type ToolPresentation } from "../app/toolPresentation";
import { ConversationTimeline } from "../components/chat/ConversationTimeline";
import { ReadableToolCard } from "../components/chat/ReadableToolCard";
import { readStoredPreferences } from "../app/preferences";
import { ChatImageConversationContext } from "../app/chatImagePreview";
import { accountModelTargetKey } from "../app/accountModels";
import { mergeDirectoryProjectLayout } from "../app/projectDirectoryLayout";
import { useProjectDirectoryIdentity } from "../app/useProjectDirectoryIdentity";
import { ApprovalActions } from "../components/chat/ApprovalActions";
import { cliProxyIdFromArguments } from "../app/cliProxyApi";
import type { SessionConversationMessage } from "../app/useSessionConversation";
import { EditIcon } from "../components/icons";
import { ChatTools } from "../components/chat/ChatTools";
import { ChatArtifact } from "../components/chat/ChatArtifact";
import { searchConversation, useConversationPins, conversationLink } from "../app/conversationNavigation";
import { ChatWorktree } from "../components/chat/ChatWorktree";
import { approvalShortcut } from "../app/approvalShortcut";
import type { NativeChatAction } from "../app/chatNativeActions";
import { ChatMcpAccess } from "../components/chat/ChatMcpAccess";
import { ChatArchiveStatus } from "../components/chat/ChatArchiveStatus";
import { ChatProjectDefaultsConflict, loadChatProjectDefaults, projectDefaultsUnavailable } from "../app/chatProjectDefaults";
import { useChatClipboardFallback } from "../app/chatClipboard";
import { conversationDraftHasInput, useConversationDraft } from "../app/useConversationDraft";
import { desktopChatAccess } from "../app/desktopChat";
import { useNativeConversationList } from "../components/chat/NativeConversationRows";
import { ConversationReadProgress } from "../components/chat/ConversationReadProgress";
import { useNativeHistory } from "../app/useNativeConversations";
import { useFileDrop } from "../app/fileDrop";
import { SessionConversationPane } from "../components/chat/SessionConversationPane";
import { QueuedPromptEditor } from "../components/chat/QueuedPromptEditor";
import { ConversationIdentity, ConversationListIdentity, ConversationMessage, ConversationMetadata } from "../components/chat/ConversationPresentation";
import { ConversationInfo } from "../components/chat/ConversationInfo";
import { useChatScroll } from "../app/useChatScroll";
import { conversationLabels } from "../app/conversationLabels";
import { cliProxyLabel } from "../app/cliProxyApi";
import { ConversationComposerFrame, ComposerAttachments, ComposerPopover } from "../components/chat/ConversationComposer";
import { ComposerVoiceControls } from "../components/chat/ComposerVoiceControls";
import { liveSessionForThread, sessionLaunchForThread } from "../app/chatSessionHandoff";
import { useContinuedSessionRead } from "../app/useContinuedSessionRead";
/**
 * Chat mode: talk to a local agent CLI in a message thread.
 *
 * The CLI still does the work, with its own login, model access and tool
 * permissions; this view only changes how the conversation looks. People
 * who would rather not drive a terminal get a composer, streamed replies,
 * and a card per tool call instead of scrolling terminal output.
 */

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ClipboardEvent,
} from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { CHAT_ATTACHMENT_LIMIT, mergeAttachmentPaths, splitSessionAttachments } from "../app/chatAttachments";
import { keepChatAttachmentPreviews } from "../app/chatAttachmentPreviews";
import {
  defaultPermission,
  effortChoices,
  delegationResult,
  supportsBrowser,
  formatTokens,
  permissionsFor,
  threadIsFresh,
  mentionsInPrompt,
  type ChatDefinitionId,
  type ChatItem,
  type ChatPermission,
  type ChatThread,
} from "../app/agentChat";
import type { AgentChatApi } from "../app/useAgentChat";
import type { AgentAutomationsApi } from "../app/useAgentAutomations";
import { AutomationPane, describeSchedule } from "../components/chat/AutomationPane";
import type { AgentApi, AgentDefinition, AgentSessionSummary } from "../app/useAgentSessions";
import { displayPath } from "../app/displayPath";
import { imageFileName } from "../app/chatImages";
import {
  profilesFor,
  type ChatAccountProfile,
} from "../app/chatAccountProfiles";
import { useAccountProfileStatus } from "../app/useAccountProfileStatus";
import { accountModelKey, accountModelSourceKey, accountModelOptions, accountModelTargets, cliProxyAgentFor, hasChatModels, validCliProxyModel, type AccountModelSelection } from "../app/accountModels";
import { useAccountModels } from "../app/useAccountModels";
import { useChatAccountProfiles } from "../app/useChatAccountProfiles";
import { useI18n } from "../i18n/context";
import { ChatQueueError } from "../app/chatInputQueue";
import { chatConversationSidebar } from "../app/chatConversationSidebar";
import { chatSidebarLayout as baseChatSidebarLayout } from "../app/chatThreadLayout";
import { moveSessionSidebarNode } from "../app/sessionSidebarLayout";
import { useSharedSidebarLayout } from "../app/sharedSidebarLayout";
import type { MessageKey } from "../i18n/messages/zh-TW";
import { Callout, EmptyState } from "../components/common/Callout";
import { ConfirmDialog } from "../components/overlays/ConfirmDialog";
import { useAppDialogs } from "../components/overlays/useAppDialogs";
import { conversationDisplayName, conversationNameTargets, useConversationNames } from "../app/conversationNames";
import { preferChatSteer, shouldSubmitChatInput } from "../app/chatInputPreferences";
import { PlanProgress, GoalProgress } from "../components/chat/PlanProgress";
import { currentRuntimeStatus } from "../app/chatRuntimeStatus";
import { ChatStatus } from "../components/chat/ChatStatus";
import { useComposerAssistance } from "../components/chat/ComposerAssistance";
import { shouldRecallPrompt } from "../app/composerAssistance";
import { ChatMarkdown } from "../components/chat/ChatMarkdown";
import { AccountModelField } from "../components/agents/AccountModelField";
import { findCliProxy } from "../app/cliProxyApi";
import { useCliProxyModelLists, useCliProxySettings } from "../app/useCliProxyApi";
import { ChatThreadTree } from "../components/chat/ChatThreadTree";
import { ChatInstructions } from "../components/chat/ChatInstructions";
import { ChatMcpServers } from "../components/chat/ChatMcpServers";
import { ChatSkillPicker } from "../components/chat/ChatSkillPicker";
import { ChatImagePreviews } from "../components/chat/ChatImagePreviews";
import { SentAttachments } from "../components/chat/SentAttachments";
import { ChatDelegations } from "../components/chat/ChatDelegations";
import { chatProjectKey } from "../app/chatProjects";
import { OpenEditorButton } from "../components/chat/OpenEditorButton";
import { ChatTerminalPanel } from "../components/chat/ChatTerminalPanel";
import { ChatChangesPanel } from "../components/chat/ChatChangesPanel";
import type { ThemeId } from "../app/themes";
import { McpElicitation, parseElicitation } from "../components/chat/McpElicitation";
import { SidebarStorageNotice } from "../components/sessions/SidebarStorageNotice";
import { ChatQuestions } from "../components/chat/ChatQuestions";
import {
  AgentIcon,
  ChatIcon,
  CodeFileIcon,
  TerminalIcon,
  CloseIcon,
  DuplicateIcon,
  FileIcon,
  ClockIcon,
  FolderIcon,
  ImageFileIcon,
  PlusIcon,
  StopIcon,
} from "../components/icons";

const permissionLabelKey: Record<ChatPermission, MessageKey> = {
  ask: "chat.permission.ask",
  readOnly: "chat.permission.readOnly",
  workspaceWrite: "chat.permission.workspaceWrite",
  full: "chat.permission.full",
};

const permissionHintKey: Record<ChatPermission, MessageKey> = {
  ask: "chat.permission.ask.hint",
  readOnly: "chat.permission.readOnly.hint",
  workspaceWrite: "chat.permission.workspaceWrite.hint",
  full: "chat.permission.full.hint",
};

function directoryName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

export function ChatView({
  agents,
  chat,
  automations,
  onOpenSession,
  theme = "dark",
  workspaceSessionId = null,
  mode = "threads",
  onOpenConversation,
  onSelectWorkspaceSession,
}: {
  agents: AgentApi;
  chat: AgentChatApi;
  automations: AgentAutomationsApi;
  onOpenSession: (sessionId: string) => void;
  theme?: ThemeId;
  workspaceSessionId?: string | null;
  mode?: "threads" | "automations";
  onOpenConversation?: () => void;
  onSelectWorkspaceSession?: (id: string | null) => void;
}) {
  const { t, tag } = useI18n();
  const [pendingDelete, setPendingDelete] = useState<ChatThread | null>(null);
  const [localSessionId, setLocalSessionId] = useState<string | null>(null);
  const selectedSessionId = onSelectWorkspaceSession ? workspaceSessionId : localSessionId;
  function setSelectedSessionId(id: string | null) {
    setLocalSessionId(id);
    onSelectWorkspaceSession?.(id);
  }
  const selectedSession = agents.sessions.find(session => session.sessionId === selectedSessionId);
  function selectThread(id: string | null) {
    setSelectedSessionId(null);
    chat.setActiveThreadId(id);
  }
  const [projectNotice, setProjectNotice] = useState<string | null>(null);
  const [selectedAutomationId, setSelectedAutomationId] = useState<string | null>(null);
  const shownAutomationId = automations.automations.find(entry => entry.id === selectedAutomationId)?.id
    ?? automations.automations[0]?.id ?? null;
  const [composingAutomation, setComposingAutomation] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [sessionSidebarLayout, setSharedLayout] = useSharedSidebarLayout();
  const accountProfiles = useChatAccountProfiles();
  const { pins } = useConversationPins();
  const [sideSessionId, setSideSessionId] = useState<string | null>(null);
  const sideSession = agents.sessions.find(session => session.sessionId === sideSessionId && !session.closedReason);
  const [sideThreadId, setSideThreadId] = useState<string | null>(null);
  const sideThread = chat.threads.find(thread => thread.id === sideThreadId);
  useEffect(() => {
    if (mode !== "threads") return;
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey) || !/^[1-9]$/.test(event.key)) return;
      const targets = [...agents.sessions.filter(session => !session.closedReason).map(session => ({ kind: "session" as const, id: session.sessionId })),
        ...chat.threads.filter(thread => !thread.shelvedAt && !agents.sessions.some(session => session.capturedSessionId && session.capturedSessionId === thread.nativeSessionId)).map(thread => ({ kind: "chat" as const, id: thread.id }))];
      const target = targets[Number(event.key) - 1];
      if (target) { event.preventDefault(); if (target.kind === "session") setSelectedSessionId(target.id); else { chat.setActiveThreadId(target.id); setSelectedSessionId(null); } }
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, [chat.threads, agents.sessions, mode]);

  const { proxies } = useCliProxySettings();
  // Conversations and running sessions share one tree, so a folder holds the
  // work rather than one kind of row.
  const nativeHistory = useNativeHistory();
  const projectIdentity = useProjectDirectoryIdentity([
    ...agents.sessions.map(session => session.workingDirectory), ...chat.threads.filter(thread => !thread.remote).map(thread => thread.workingDirectory),
    ...(nativeHistory?.entries ?? []).map(entry => entry.workingDirectory),
  ]);
  const chatSidebarLayout = (...args: Parameters<typeof baseChatSidebarLayout>) => baseChatSidebarLayout(
    mergeDirectoryProjectLayout(args[0], args[2] ?? [], projectIdentity.key, [
      ...agents.sessions.map(session => session.workingDirectory), ...chat.threads.filter(thread => !thread.remote).map(thread => thread.workingDirectory),
      ...(nativeHistory?.entries ?? []).map(entry => entry.workingDirectory),
    ]), args[1], args[2]);
  const names = useConversationNames();
  const dialogs = useAppDialogs();
  const [renameError, setRenameError] = useState<string | null>(null);
  const nameTargets = useMemo(() => conversationNameTargets(chat.threads, agents.sessions, nativeHistory?.profiles ?? accountProfiles),
    [chat.threads, agents.sessions, nativeHistory?.profiles, accountProfiles]);
  const namedThreads = useMemo(() => chat.threads.map(thread => ({ ...thread,
    title: conversationDisplayName(names.names, nameTargets.thread(thread), thread.title) })), [chat.threads, names.names, nameTargets]);
  const namedHistory = useMemo(() => (nativeHistory?.entries ?? []).map(entry => ({ ...entry,
    title: conversationDisplayName(names.names, nameTargets.native(entry), entry.title) })), [nativeHistory?.entries, names.names, nameTargets]);
  async function renameConversation(keys: readonly string[], current: string) {
    const name = await dialogs.prompt({ title: t("chat.rename"), label: t("chat.rename.name"), initialValue: current,
      confirmLabel: t("common.save"), cancelLabel: t("common.cancel") });
    if (name === null) return;
    try { names.save(keys, name); setRenameError(null); }
    catch { setRenameError(t("chat.rename.failed")); }
  }
  const { workspace, listedThreads } = useMemo(
    () => {
      const projection = chatConversationSidebar({ directoryKey: projectIdentity.key, sessions: agents.sessions, definitions: agents.catalog, threads: namedThreads,
        history: namedHistory, profiles: nativeHistory?.profiles ?? accountProfiles,
        proxies, generalProjectLabel: t("terminal.projects.generalChat"), projectFilter: null });
      const sessions = new Map(agents.sessions.map(session => [session.sessionId, session]));
      for (const leaf of projection.workspace.sessions.values()) {
        const session = sessions.get(leaf.sessionId);
        if (session) leaf.label = conversationDisplayName(names.names, nameTargets.session(session), leaf.label);
      }
      return projection;
    },
    [agents.catalog, agents.sessions, namedThreads, namedHistory, nativeHistory?.profiles, accountProfiles, proxies, t, names.names, nameTargets, projectIdentity],
  );
  const nativeConversations = useNativeConversationList({ chat, projectFilter: null,
    onBeforeOpen: () => setSharedLayout(current => chatSidebarLayout(current, chat.threads, workspace.nodes)),
    onOpened: () => setSelectedSessionId(null),
  });
  // Shelved threads leave the tree and wait in their own list below it.
  const shelvedThreads = useMemo(
    () =>
      namedThreads
        .filter((thread) => thread.shelvedAt)
        .sort((a, b) => (b.shelvedAt ?? 0) - (a.shelvedAt ?? 0)),
    [namedThreads],
  );
  const sidebarLayout = useMemo(
    () => chatSidebarLayout(sessionSidebarLayout, listedThreads, workspace.nodes),
    [listedThreads, sessionSidebarLayout, workspace.nodes],
  );

  function moveSidebarNode(nodeId: string, parentId: string | null, beforeNodeId: string | null) {
    setSharedLayout((current) =>
      moveSessionSidebarNode(
        chatSidebarLayout(current, chat.threads, workspace.nodes),
        nodeId,
        parentId,
        beforeNodeId,
      ),
    );
  }

  const cliLabel = (id: ChatDefinitionId) =>
    agents.catalog.find((definition) => definition.id === id)?.label ?? id;
  const installed = chat.supported.filter(
    (id) => agents.catalog.find((definition) => definition.id === id)?.installed,
  );
  const active = namedThreads.find((thread) => thread.id === chat.activeThreadId) ?? null;
  const activeLiveSession = active ? liveSessionForThread(active, agents.sessions, accountProfiles) : undefined;
  const shownSession = selectedSession ?? activeLiveSession;
  async function forkSession(session: AgentSessionSummary, messages: readonly SessionConversationMessage[], throughIndex?: number, editedText?: string) {
    if (session.sandboxed) throw new Error("這個來源使用外層沙盒，尚無法完整沿用其限制，沒有建立分支。");
    if (!session.capturedSessionId || !["codex", "claude"].includes(session.definitionId) || session.state === "working" || session.queuedPrompts || session.closedReason) throw new Error("請先等來源工作階段完成目前回合。");
    const profile = session.profileConfigPath ? accountProfiles.find(profile => profile.definitionId === session.definitionId && profile.configDirectory === session.profileConfigPath) : null;
    if (session.profileConfigPath && !profile) throw new Error("找不到來源帳號設定，沒有改用其他帳號建立分支。");
    const proxyId = cliProxyIdFromArguments(session.launchArguments);
    const sourceMessages = messages.filter(message => message.tool?.kind !== "reasoning").map(message => ({
      role: message.role, text: message.text, nativeTurnId: message.nativeTurnId, nativeMessageId: message.nativeMessageId,
      tool: message.tool ? { callId: message.tool.callId, name: message.tool.name, kind: message.tool.kind as "call" | "result" } : undefined }));
    const source = chat.importNativeConversation({ definitionId: session.definitionId as ChatDefinitionId, nativeSessionId: session.capturedSessionId,
      workingDirectory: session.workingDirectory, title: session.label, accountProfileId: profile?.id ?? null, messages: sourceMessages, sessionSource: true, model: session.model ?? "",
      ...(proxyId ? { provider: "cliproxyapi" as const, proxyId } : {}) });
    // A passive mirror stays held by the existing PTY; it cannot start another writer.
    if (!source.continuedInSession) await chat.continueInSession(source.id);
    const selected = throughIndex === undefined ? undefined : messages[throughIndex];
    const textRows = messages.filter(message => !message.tool);
    const textIndex = selected ? textRows.indexOf(selected) : textRows.length - 1;
    const sourceRows = source.items.filter(item => item.type === "user" || item.type === "text");
    const through = sourceRows[textIndex];
    if (!through) throw new Error("這則訊息尚未取得可核對的原生歷史。");
    const branch = await chat.nativeFork(source.id, t("chat.branch.suffix"), through.id, editedText !== undefined, session.sessionId);
    if (!branch) return;
    if (editedText !== undefined && selected) {
      const attachmentText = splitSessionAttachments(selected.text);
      const files = mergeAttachmentPaths([], attachmentText.paths) ?? [];
      await chat.send(branch.id, editedText, files, profile?.configDirectory ?? null);
    }
    setSelectedSessionId(null);
  }

  const [handoffProblem, setHandoffProblem] = useState<string | null>(null);
  const handingOff = useRef(false);
  const [handingOffThreadId, setHandingOffThreadId] = useState<string | null>(null);

  async function continueInSession(thread: ChatThread) {
    if (handingOff.current) return;
    handingOff.current = true;
    setHandingOffThreadId(thread.id);
    setHandoffProblem(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const directory = thread.workingDirectory ||
        await invoke<string>("agent_chat_general_directory", { threadId: thread.id });
      const request = sessionLaunchForThread(thread, directory, agents.catalog, accountProfiles, proxies);
      if (!request) throw new Error(t("chat.continueInSession.unavailable"));
      let sessionId = "";
      await chat.continueInSession(thread.id, async () => {
        const launched = await agents.launch(request);
        if (launched.closedReason) throw new Error(launched.closedReason);
        sessionId = launched.sessionId;
      });
      if (!sessionId) return;
      try {
        await agents.rename(sessionId, thread.title || request.label);
      } catch {
        // The terminal is already running the conversation.
      }
      onOpenSession(sessionId);
    } catch (reason) {
      setHandoffProblem(t("chat.continueInSession.failed", {
        detail: reason instanceof Error ? reason.message : String(reason),
      }));
    } finally {
      handingOff.current = false;
      setHandingOffThreadId(null);
    }
  }

  const sessionRead = useContinuedSessionRead(active, Boolean(activeLiveSession), accountProfiles,
    chat.updateThreadFromSession, t("chat.continuedInSession.notice"), t("history.sessionMissing"));
  function startThread(workingDirectory = "") {
    if (workingDirectory) {
      try {
        const defaults = loadChatProjectDefaults(localStorage, workingDirectory);
        if (defaults) {
          const unavailable = projectDefaultsUnavailable(defaults, { installed, proxies, profiles: accountProfiles });
          if (unavailable) {
            setProjectNotice(t(`chat.projects.defaults.${unavailable}`));
            return;
          }
          setSelectedSessionId(null);
          setProjectNotice(null);
          chat.createThread({ ...defaults, workingDirectory });
          return;
        }
      } catch (error) {
        setProjectNotice(t(error instanceof ChatProjectDefaultsConflict ? "chat.projects.defaults.conflict" : "chat.projects.defaults.error"));
        return;
      }
    }
    setSelectedSessionId(null);
    // Keep the assistant choice; selecting a project is optional for each chat.
    // Inside a project, its own latest conversation is the better guide:
    // projects tend to keep one assistant, model and permission.
    const normalized = chatProjectKey(workingDirectory);
    const inProject = normalized
      ? chat.threads
          .filter(
            (thread) => !thread.remote && !thread.archived && chatProjectKey(thread.workingDirectory) === normalized,
          )
          .reduce<ChatThread | undefined>(
            (latest, thread) => (!latest || thread.updatedAt > latest.updatedAt ? thread : latest),
            undefined,
          )
      : undefined;
    const previous = inProject ?? chat.threads[0];
    const definitionId =
      previous && installed.includes(previous.definitionId)
        ? previous.definitionId
        : (installed[0] ?? (proxies.length > 0 ? "codex" : chat.supported[0] ?? "claude"));
    chat.createThread({
      definitionId,
      workingDirectory,
      permission:
        previous && permissionsFor(definitionId).includes(previous.permission)
          ? previous.permission
          : defaultPermission(definitionId),
      model: previous?.definitionId === definitionId && (installed.length > 0 || previous.provider === "cliproxyapi") ? previous.model : "",
      provider: proxies.length > 0 && installed.length === 0 ? "cliproxyapi" : previous?.definitionId === definitionId ? previous.provider : undefined,
      proxyId: previous?.definitionId === definitionId && previous.provider === "cliproxyapi"
        && proxies.some(proxy => proxy.id === previous.proxyId) ? previous.proxyId : proxies[0]?.id,
      accountProfileId: installed.length > 0 && previous?.definitionId === definitionId ? previous.accountProfileId : null,
    });
  }

  function startAutomation() {
    setSelectedAutomationId(null);
    setComposingAutomation(true);
  }

  function openThread(threadId: string) {
    onOpenConversation?.();
    selectThread(threadId);
  }

  const previous = chat.threads[0];
  const automationDefaults = {
    definitionId:
      previous && installed.includes(previous.definitionId)
        ? previous.definitionId
        : (installed[0] ?? "claude"),
    workingDirectory: previous?.workingDirectory ?? "",
  };

  const archiveStatus = <ChatArchiveStatus error={chat.removal?.error} pending={chat.removal?.pending}
    receipt={chat.archivedReceipt} onRetry={() => {
      if (!chat.removal) return;
      const thread = chat.getThread(chat.removal.id);
      const profile = accountProfiles.find(profile => profile.id === thread?.accountProfileId);
      void chat.removeThread(chat.removal.id, profile?.configDirectory ?? null);
    }} onRestore={() => void chat.undoArchive()} />;

  return (
    <section className="chat-view" aria-label={t(mode === "automations" ? "automation.title" : "chat.title")}>
      <aside className="chat-threads">
        {archiveStatus}
        {renameError && <Callout tone="warn">{renameError}</Callout>}
        <div className="chat-threads__header">
          <div className="chat-composer__actions">
            {mode === "threads" && (
              <button
                type="button"
                className="button button--ghost button--sm"
                onClick={() => {
                  setNewFolderOpen((current) => !current);
                  setNewFolderName("");
                }}
                aria-label={t("chat.folder.new")}
                title={t("chat.folder.new")}
                aria-expanded={newFolderOpen}
              >
                <FolderIcon />
              </button>
            )}
            <button
              type="button"
              className="button button--primary button--sm"
              onClick={mode === "automations" ? startAutomation : () => startThread()}
              disabled={agents.mode !== "ready"}
              aria-label={mode === "automations" ? t("automation.new") : t("chat.new")}
              title={mode === "automations" ? t("automation.new") : t("chat.new")}
            >
              <PlusIcon />
            </button>
          </div>
        </div>
        {mode === "threads" && pins.some(id => namedThreads.some(thread => thread.id === id) || agents.sessions.some(session => `session:${session.sessionId}` === id)) && <nav className="chat-pins" aria-label={t("chat.nav.pinned")}>
          <h4>{t("chat.nav.pinned")}</h4>{pins.map(id => {
            const session = agents.sessions.find(session => `session:${session.sessionId}` === id);
            if (session) return <button key={id} type="button" className="button button--ghost button--sm" onClick={() => setSelectedSessionId(session.sessionId)}>{conversationDisplayName(names.names, nameTargets.session(session), session.label)}</button>;
            const thread = namedThreads.find(thread => thread.id === id); return thread && <button key={id} type="button" className="button button--ghost button--sm" onClick={() => { chat.setActiveThreadId(id); setSelectedSessionId(null); }}>{thread.title || t("chat.untitled")}</button>;
          })}
        </nav>}
        {mode === "threads" && newFolderOpen && (
          <form
            className="chat-folder-form"
            onSubmit={(event) => {
              event.preventDefault();
              const name = newFolderName.trim();
              if (name) chat.createFolder(name, null);
              setNewFolderOpen(false);
              setNewFolderName("");
            }}
          >
            <input
              className="input"
              autoFocus
              value={newFolderName}
              placeholder={t("chat.folder.name.placeholder")}
              aria-label={t("chat.folder.name.placeholder")}
              onChange={(event) => setNewFolderName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setNewFolderOpen(false);
              }}
            />
            <button type="submit" className="button button--primary button--sm">
              {t("chat.folder.create")}
            </button>
          </form>
        )}
        {mode === "threads" ? (
          <div className="chat-threads__list">
            {projectNotice && <Callout tone="warn">{projectNotice}</Callout>}
            <SidebarStorageNotice />
            <ChatThreadTree
              layout={sidebarLayout}
              threads={listedThreads}
              workspace={workspace}
              activeThreadId={selectedSessionId ? null : chat.activeThreadId}
              activeSessionId={selectedSessionId}
              onSelectThread={selectThread}
              onOpenSession={setSelectedSessionId}
              onRemoveThread={setPendingDelete}
              onShelveThread={(thread) => chat.shelveThread(thread.id, true)}
              onToggleFolder={chat.toggleFolder}
              onRenameFolder={chat.renameFolder}
              onRemoveFolder={chat.removeFolder}
              onCreateFolder={chat.createFolder}
              onRenameThread={thread => { void renameConversation(nameTargets.thread(thread), thread.title); }}
              onRenameSession={(id, name) => {
                const session = agents.sessions.find(entry => entry.sessionId === id);
                if (session) void renameConversation(nameTargets.session(session), name);
              }}
              onRenameNative={entry => { void renameConversation(nameTargets.native(entry), entry.title); }}
              onMoveNode={moveSidebarNode}
              renderThread={(thread, active) => (
                <div
                  className={`chat-thread${active ? " is-active" : ""}${thread.unread ? " is-unread" : ""}`}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      selectThread(thread.id);
                    }
                  }}
                >
                  <ConversationListIdentity title={thread.title || t("chat.untitled")}>
                      {thread.automationId ? `${t("automation.badge")} · ` : ""}
                      <ConversationMetadata compact at={thread.updatedAt} labels={conversationLabels({ definitionId: thread.definitionId,
                        provider: thread.reportedProvider,
                        directApi: thread.provider === "cliproxyapi" && !thread.nativeSessionId,
                        model: thread.reportedModel ?? thread.model, workingDirectory: thread.workingDirectory,
                        endpoint: thread.provider ? (() => { const proxy = proxies.find(entry => entry.id === thread.proxyId); return proxy ? cliProxyLabel(proxy) : "CLIProxyAPI"; })() : null,
                        account: accountProfiles.find(entry => entry.id === thread.accountProfileId)?.name })} />
                  </ConversationListIdentity>
                  {thread.runningTurnId ? (
                    <span className="chat-thread__dot" aria-label={t("chat.running")} />
                  ) : thread.unread ? (
                    <span className="chat-thread__dot chat-thread__dot--unread" aria-label={t("automation.unread.one")} />
                  ) : null}
                </div>
              )}
              renderNativeConversation={nativeConversations.renderEntry}
            />
            {nativeConversations.footer}
            {shelvedThreads.length > 0 && (
              <details className="chat-shelf">
                <summary>{t("chat.shelf.title", { count: shelvedThreads.length })}</summary>
                <ul>
                  {shelvedThreads.map((thread) => (
                    <li key={thread.id}>
                      <button
                        type="button"
                        className={`chat-thread${thread.id === chat.activeThreadId ? " is-active" : ""}`}
                        onClick={() => selectThread(thread.id)}
                      >
                        <span className="chat-thread__title">{thread.title || t("chat.untitled")}</span>
                      </button>
                      <button
                        type="button"
                        className="button button--ghost button--sm"
                        onClick={() => chat.shelveThread(thread.id, false)}
                      >
                        {t("chat.unshelve")}
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        ) : (
          <ul className="chat-threads__list">
            {automations.automations.map((automation) => (
              <li key={automation.id}>
                <button
                  type="button"
                  className={`chat-thread${automation.id === shownAutomationId && !composingAutomation ? " is-active" : ""}`}
                  onClick={() => {
                    setComposingAutomation(false);
                    setSelectedAutomationId(automation.id);
                  }}
                >
                  <span>
                    <span className="chat-thread__title">{automation.name}</span>
                    <br />
                    <span className="chat-thread__meta">
                      {automation.enabled
                        ? describeSchedule(automation.schedule, t, automations.automations)
                        : t("automation.paused")}
                    </span>
                  </span>
                  {automation.runs[0]?.outcome === "running" && (
                    <span className="chat-thread__dot" aria-label={t("automation.running")} />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <div className="chat-main">
        <CompactionNotice />
        {(chat.removal?.error || chat.archivedReceipt) && <div className="chat-archive-status--mobile">{archiveStatus}</div>}
        {mode === "automations" && agents.mode !== "unavailable" ? (
          composingAutomation || shownAutomationId ? (
            <AutomationPane
              key={composingAutomation ? "new" : shownAutomationId}
              automations={automations}
              selectedId={composingAutomation ? null : shownAutomationId}
              editing={composingAutomation}
              defaults={automationDefaults}
              installed={installed}
              cliLabel={cliLabel}
              onSelect={setSelectedAutomationId}
              onDoneEditing={() => setComposingAutomation(false)}
              onOpenThread={openThread}
              models={chat.models}
              loadModels={chat.loadModels}
            />
          ) : (
            <EmptyState
              icon={<ClockIcon />}
              title={t("automation.empty.title")}
              description={t("automation.empty.body")}
              actions={
                <button
                  type="button"
                  className="button button--primary"
                  onClick={startAutomation}
                  disabled={agents.mode !== "ready" || installed.length === 0}
                >
                  <PlusIcon />
                  {t("automation.new")}
                </button>
              }
            />
          )
        ) : agents.mode === "unavailable" ? (
          <div className="chat-header">
            <Callout tone="warn" title={t("desktopBackend.required.title")}>
              {t("desktopBackend.required.body")}
            </Callout>
          </div>
        ) : shownSession ? (
          <SessionConversationPane key={shownSession.sessionId} session={shownSession}
            displayName={conversationDisplayName(names.names, nameTargets.session(shownSession), "") || undefined}
            conversationTitle={[...workspace.sessions.values()].find(leaf => leaf.sessionId === shownSession.sessionId)?.label}
            accountLabel={accountProfiles.find(profile => profile.definitionId === shownSession.definitionId && profile.configDirectory === shownSession.profileConfigPath)?.name}
            agents={agents} onOpenTerminal={() => onOpenSession(shownSession.sessionId)}
            onSessionReplaced={setSelectedSessionId} onSideChat={() => { setSideThreadId(null); setSideSessionId(shownSession.sessionId); }}
            onFork={(messages, index, edited) => forkSession(shownSession, messages, index, edited)} />
        ) : selectedSessionId ? (
          <EmptyState icon={<ChatIcon />} title={t("sessionChat.closed")}
            description={t("sessionChat.chooseAnother")} />
        ) : installed.length === 0 && proxies.length === 0 && agents.mode === "ready" && !active?.archived ? (
          <EmptyState
            icon={<ChatIcon />}
            title={t("chat.none.title")}
            description={t("chat.none.body")}
          />
        ) : !active ? (
          <EmptyState
            icon={<ChatIcon />}
            title={t("chat.empty.title")}
            description={t("chat.empty.body")}
            actions={
              <button
                type="button"
                className="button button--primary"
                onClick={() => startThread()}
                disabled={agents.mode !== "ready"}
              >
                <PlusIcon />
                {t("chat.new")}
              </button>
            }
          />
        ) : (
          <ThreadPane
            key={active.id}
            thread={active}
            chat={chat}
            installed={installed}
            definitions={agents.catalog.filter((definition) => chat.supported.some((id) => id === definition.id) && definition.installed)}
            cliLabel={cliLabel}
            tag={tag}
            accountProfiles={accountProfiles}
            theme={theme}
            onSideChat={() => { const side = chat.createThread({ definitionId: active.definitionId, workingDirectory: active.workingDirectory, model: active.model, permission: active.permission, accountProfileId: active.accountProfileId, provider: active.provider, proxyId: active.proxyId, activate: false }); setSideThreadId(side.id); }}
            continueInSession={sessionLaunchForThread(active, active.workingDirectory || "general",
              agents.catalog, accountProfiles, proxies) && !active.archived
              ? () => void continueInSession(active) : undefined}
            handoffProblem={handoffProblem}
            handoffPending={handingOffThreadId === active.id}
            sessionRead={sessionRead}
          />
        )}
      </div>

      {sideSession && <aside className="chat-side-pane" aria-label={t("chat.nav.side")}>
        <button type="button" className="button button--ghost button--sm" onClick={() => setSideSessionId(null)}>{t("chat.nav.closeSide")}</button>
        {sideSession.sessionId === shownSession?.sessionId ? <p className="chat-notice">{t("chat.nav.selectMain")}</p> : <SessionConversationPane key={sideSession.sessionId} session={sideSession} agents={agents}
          displayName={conversationDisplayName(names.names, nameTargets.session(sideSession), "") || undefined}
            conversationTitle={[...workspace.sessions.values()].find(leaf => leaf.sessionId === sideSession.sessionId)?.label}
            accountLabel={accountProfiles.find(profile => profile.definitionId === sideSession.definitionId && profile.configDirectory === sideSession.profileConfigPath)?.name}
          onOpenTerminal={() => onOpenSession(sideSession.sessionId)} onSessionReplaced={setSideSessionId}
          onFork={(messages, index, edited) => forkSession(sideSession, messages, index, edited)} />}
      </aside>}
      {sideThread && <aside className="chat-side-pane" aria-label={t("chat.nav.side")}>
        <button type="button" className="button button--ghost button--sm" onClick={() => setSideThreadId(null)}>{t("chat.nav.closeSide")}</button>
        {!shownSession && sideThread.id === active?.id ? <p className="chat-notice">{t("chat.nav.selectMain")}</p> : <ThreadPane key={sideThread.id} thread={sideThread} chat={chat} installed={installed} definitions={agents.catalog.filter(definition => chat.supported.some(id => id === definition.id) && definition.installed)} cliLabel={cliLabel} tag={tag} accountProfiles={accountProfiles} theme={theme} />}
      </aside>}
      {pendingDelete && (
        <ConfirmDialog
          title={t("chat.delete.confirm.title", {
            title: pendingDelete.title || t("chat.untitled"),
          })}
          body={t(pendingDelete.definitionId === "codex" && pendingDelete.nativeSessionId && !pendingDelete.remote && !pendingDelete.archived ? "chat.archive.confirm.body" : "chat.delete.confirm.body")}
          confirmLabel={t(pendingDelete.definitionId === "codex" && pendingDelete.nativeSessionId && !pendingDelete.remote && !pendingDelete.archived ? "chat.archive.confirm.action" : "chat.delete.confirm.action")}
          cancelLabel={t("common.cancel")}
          tone="danger"
          onConfirm={() => {
            const profileConfigPath = pendingDelete.accountProfileId
              ? accountProfiles.find((p) => p.id === pendingDelete.accountProfileId)?.configDirectory ?? null
              : null;
            chat.removeThread(pendingDelete.id, profileConfigPath);
            setPendingDelete(null);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
      {dialogs.dialogs}
    </section>
  );
}

export function ThreadPane({
  thread,
  chat,
  installed,
  definitions,
  cliLabel,
  tag,
  accountProfiles,
  theme,
  onSideChat,
  continueInSession,
  handoffProblem,
  handoffPending,
  sessionRead,
}: {
  thread: ChatThread;
  chat: AgentChatApi;
  installed: readonly ChatDefinitionId[];
  definitions: readonly AgentDefinition[];
  cliLabel: (id: ChatDefinitionId) => string;
  tag: string;
  accountProfiles: readonly ChatAccountProfile[];
  theme: ThemeId;
  onSideChat?: () => void;
  /** Present when the conversation can go on in a terminal session. */
  continueInSession?: () => void;
  handoffProblem?: string | null;
  handoffPending?: boolean;
  sessionRead?: { loading: boolean; error: string | null; refresh: () => void } | null;
}) {
  const { t } = useI18n();
  const projectHistory = useNativeHistory();
  const recentProjects = useMemo(() => [...chat.threads.filter(thread => !thread.remote).map(thread => ({ path:thread.workingDirectory, at:thread.updatedAt })),
    ...(projectHistory?.entries ?? []).map(entry => ({ path:entry.workingDirectory, at:entry.updatedAt*1000 }))], [chat.threads, projectHistory?.entries]);
  function changeDirectory(path: string) { if (settingsLocked) return; recordRecentProject(path); chat.updateThread(thread.id, { workingDirectory:path }); }
  const { draft, setDraft, attachments, setAttachments, picks, setPicks,
    pasting: pastingImage, setPasting: setPastingImage, steering, setSteering,
    addAttachmentPaths, readDraft } = useConversationDraft("thread", thread.id);
  const [notice, setNotice] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [repositoryBusy, setRepositoryBusy] = useState(false);
  const pastingImageRef = useRef(false);
  pastingImageRef.current = pastingImage;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const composerDropRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const steeringRef = useRef(false);
  steeringRef.current = steering;
  useLayoutEffect(() => {
    if (draft.length || attachments.length || pastingImage || steering) desktopChatAccess.drafts.add(thread.id);
    else desktopChatAccess.drafts.delete(thread.id);
    return () => {
      if (!conversationDraftHasInput("thread", thread.id)) desktopChatAccess.drafts.delete(thread.id);
    };
  }, [thread.id, draft, attachments, pastingImage, steering]);
  const fresh = threadIsFresh(thread);
  const [settingsOpen, setSettingsOpen] = useState(fresh);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const { pins, toggle: togglePin } = useConversationPins();
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState(""); const [searchIndex, setSearchIndex] = useState(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchMatches = useMemo(() => searchConversation(thread.items, search), [thread.items, search]);
  const matchedItem = searchMatches[searchIndex % Math.max(1, searchMatches.length)];
  const toolRows = useMemo(() => chatToolRows(thread.items), [thread.items]);
  const [worktreeOpen, setWorktreeOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);

  const runtimeStatus = currentRuntimeStatus(thread);
  const latestPlan = thread.items.slice().reverse().find(item => item.type === "plan");
  const latestGoal = thread.items.slice().reverse().find(item => item.type === "goal");
  const [delegating, setDelegating] = useState(false);
  const { ref: scrollRef, onScroll, onWheel, followBottom } = useChatScroll();
  useEffect(() => { if (matchedItem) { const item = [...(scrollRef.current?.querySelectorAll<HTMLElement>("[data-chat-item]") ?? [])].find(node => node.dataset.chatItem === matchedItem); item?.scrollIntoView({ block: "center", behavior: "auto" }); } }, [matchedItem, scrollRef]);
  useEffect(() => { if (searchOpen) searchInput.current?.focus(); }, [searchOpen]);

  const running = thread.runningTurnId !== null;
  const pendingInputs = thread.pendingInputs ?? [];
  const nativeRead = chat.nativeRead?.threadId === thread.id ? chat.nativeRead : null;
  const awaitingHistory = Boolean(thread.nativeHistorySource && nativeRead && !nativeRead.ready) || Boolean(thread.continuedInSession) || Boolean(handoffPending);
  const settingsLocked = repositoryBusy || Boolean(thread.pendingOperation) || running || pendingInputs.length > 0 || awaitingHistory || pastingImage || steering;
  const directProxy = thread.provider === "cliproxyapi" && !thread.nativeSessionId;
  const cliInstalled = directProxy || installed.includes(thread.definitionId);
  const availableProfiles = profilesFor(accountProfiles, thread.definitionId);
  const activeProfile = availableProfiles.find((profile) => profile.id === thread.accountProfileId) ?? null;
  const { statuses: profileStatuses } = useAccountProfileStatus(accountProfiles);
  const modelTargets = accountModelTargets(definitions, accountProfiles, profileStatuses, t("accountModel.defaultAccount"), thread.accountProfileId);
  const accountModels = useAccountModels(modelTargets, settingsOpen || modelPickerOpen);
  const cliProxySettings = useCliProxySettings();
  const { lists: cliProxyModels, reload: reloadCliProxyModels } = useCliProxyModelLists(cliProxySettings, settingsOpen || modelPickerOpen);
  // The picker lists each proxy once under Codex; which CLI then answers
  // follows the chosen model, so the picker compares against that entry.
  const pickerValue = thread.provider ? { ...thread, definitionId: "codex" } : thread;
  const modelOptions = accountModelOptions(modelTargets, accountModels, {
    defaultModel: t("chat.model.default"), loading: t("chat.model.loading"), signedOut: t("agents.account.signedOut"),
  }, pickerValue, cliProxySettings.proxies, true);
  const selectedOption = modelOptions.find((option) => accountModelKey(option) === accountModelKey(pickerValue));
  const activeProfileMissing = !directProxy && thread.accountProfileId !== null && activeProfile === null;
  const activeProfileSignedOut = !directProxy && selectedOption?.disabled === true;
  const canSend =
    !thread.pendingOperation && !awaitingHistory &&
    !steering &&
    !pastingImage &&
    !activeProfileMissing &&
    !activeProfileSignedOut &&
    (!thread.provider || (findCliProxy(cliProxySettings, thread.proxyId) !== null && validCliProxyModel(thread.model))) &&
    cliInstalled &&
    (draft.trim() !== "" || attachments.length > 0);
  const assistant = directProxy ? "CLIProxyAPI" : cliLabel(thread.definitionId);

  useEffect(() => {
    setNotice(null);
  }, [thread.id]);

  function addAttachments(paths: readonly string[]): boolean {
    if (steeringRef.current) return false;
    const next = addAttachmentPaths(paths);
    if (!next) {
      if (mounted.current) setNotice(t("chat.attachment.limit", { count: CHAT_ATTACHMENT_LIMIT }));
      return false;
    }
    return true;
  }

  async function pasteImage(silent = false) {
    if (pastingImageRef.current || steeringRef.current) return;
    if (readDraft().attachments.length >= CHAT_ATTACHMENT_LIMIT) {
      setNotice(t("chat.attachment.limit", { count: CHAT_ATTACHMENT_LIMIT })); return;
    }
    pastingImageRef.current = true;
    setPastingImage(true);
    setNotice(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      // Files copied in a file manager come first: their clipboard entry can
      // also carry an icon image that is not what the user meant to paste.
      const files = await invoke<string[]>("agent_chat_paste_files");
      if (files.length > 0) {
        addAttachments(files);
        return;
      }
      const path = await invoke<string | null>("agent_chat_paste_image", { threadId: thread.id });
      if (path) addAttachments([path]);
      else if (mounted.current && !silent) setNotice(t("chat.attachment.clipboardEmpty"));
    } catch (reason) {
      if (mounted.current && !silent) setNotice(t("chat.attachment.failed", { detail: reason instanceof Error ? reason.message : String(reason) }));
    } finally {
      pastingImageRef.current = false;
      setPastingImage(false);
    }
  }

  const clipboard = useChatClipboardFallback(thread.id, () => { void pasteImage(true); });
  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) { clipboard.onPaste(event); }

  async function chooseAttachments(kind: "image" | "file") {
    setNotice(null);
    try {
      const selected = await open({
        multiple: true,
        title: t(kind === "image" ? "chat.attachment.images" : "chat.attachment.files"),
        ...(kind === "image"
          ? { filters: [{ name: t("chat.attachment.images"), extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }] }
          : {}),
      });
      if (typeof selected === "string") addAttachments([selected]);
      else if (Array.isArray(selected)) addAttachments(selected);
    } catch (reason) {
      setNotice(
        t("chat.attachment.failed", {
          detail: reason instanceof Error ? reason.message : String(reason),
        }),
      );
    }
  }

  const { dragging: draggingFiles } = useFileDrop({
    ref: composerDropRef,
    onPaths: paths => { addAttachments(paths); },
    onError: reason => setNotice(t("chat.attachment.failed", { detail: reason instanceof Error ? reason.message : String(reason) })),
  });

  async function chooseDirectory() {
    setNotice(null);
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t("chat.directory.choose"),
      });
      if (typeof selected === "string") {
        changeDirectory(selected);
      }
    } catch (reason) {
      setNotice(
        t("chat.directory.chooseFailed", {
          detail: reason instanceof Error ? reason.message : String(reason),
        }),
      );
    }
  }

  async function submit(event?: FormEvent, delivery?: "queue") {
    event?.preventDefault();
    if (!canSend || steeringRef.current || pastingImageRef.current) return;
    if (delivery !== "queue" && preferChatSteer(thread)) { await steer(); return; }
    const prompt = draft;
    const files = attachments;
    const selectedPicks = picks;
    const mentions = mentionsInPrompt(prompt, picks);
    pastingImageRef.current = true;
    setPastingImage(true);
    try {
      const saved = await keepChatAttachmentPreviews(thread.id, files);
      const current = chat.getThread(thread.id);
      if (!current) return;
      if (current.runningTurnId || (current.pendingInputs?.length ?? 0) > 0) {
        chat.enqueue(thread.id, prompt, saved, activeProfile?.configDirectory ?? null, mentions);
      } else {
        await chat.send(thread.id, prompt, saved, activeProfile?.configDirectory ?? null, undefined, mentions);
      }
      setDraft(current => current === prompt ? "" : current);
      setAttachments(current => current === files ? [] : current);
      setPicks(current => current === selectedPicks ? [] : current);
      followBottom();
      if (mounted.current) { setSettingsOpen(false); setNotice(null); }
    } catch (reason) {
      if (mounted.current) setNotice(reason instanceof ChatQueueError ? t(`chat.queue.${reason.code}`) : reason instanceof Error ? reason.message : String(reason));
    } finally {
      pastingImageRef.current = false;
      setPastingImage(false);
    }
  }

  async function steer() {
    if (!canSend || steeringRef.current || pastingImageRef.current || !running || thread.definitionId !== "codex") return;
    steeringRef.current = true;
    setSteering(true);
    setNotice(null);
    const submitted = draft;
    const files = attachments;
    const selectedPicks = picks;
    try {
      const saved = await keepChatAttachmentPreviews(thread.id, files);
      await chat.steer(thread.id, submitted, saved, thread.runningTurnId ?? undefined, mentionsInPrompt(submitted, selectedPicks));
      setDraft(current => current === submitted ? "" : current);
      setAttachments(current => current === files ? [] : current);
      setPicks(current => current === selectedPicks ? [] : current);
      followBottom();
    } catch (reason) {
      setNotice(t("chat.steer.failed", { detail: reason instanceof Error ? reason.message : String(reason) }));
    } finally {
      steeringRef.current = false;
      setSteering(false);
    }
  }

  async function runNativeCommand(action: NativeChatAction) {
    setNotice(null);
    try { await chat.send(thread.id, "", [], activeProfile?.configDirectory ?? null, undefined, [], action); }
    catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)); }
  }
  const nativeCodex = thread.definitionId === "codex" && !directProxy && !settingsLocked;
  const assistance = useComposerAssistance({ draft, onText: setDraft, inputRef,
    workingDirectory: thread.workingDirectory, filesEnabled: !directProxy,
    onFile: () => true,
    commands: {
      model: !settingsLocked ? () => setModelPickerOpen(true) : undefined,
      status: () => setStatusOpen(true),
      plan: !directProxy && !settingsLocked && (thread.definitionId === "codex" || thread.definitionId === "claude")
        ? () => chat.updateThread(thread.id, { planMode: !thread.planMode }) : undefined,
      review: nativeCodex ? () => { void runNativeCommand({ kind: "review", target: { type: "uncommittedChanges" } }); } : undefined,
      compact: nativeCodex && thread.nativeSessionId ? () => { void runNativeCommand({ kind: "compact" }); } : undefined,
      fork: !settingsLocked && !directProxy && ["codex", "claude"].includes(thread.definitionId) && thread.nativeSessionId ? () => {
        void chat.nativeFork(thread.id, t("chat.branch.suffix")).catch(reason => setNotice(reason instanceof Error ? reason.message : String(reason)));
      } : undefined,
    },
  });
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    clipboard.onKeyDown(event.nativeEvent);
    if (assistance.keyDown(event)) return;
    if (shouldRecallPrompt(event, draft, attachments.length)) {
      const previous = thread.items.slice().reverse().find(item => item.type === "user");
      if (previous?.type === "user") {
        event.preventDefault(); setDraft(previous.text); setAttachments(previous.attachments ?? []);
        assistance.select(previous.text.length); return;
      }
    }
    // Enter while an input method is composing picks a candidate; it must
    // not send half a sentence.
    if (!shouldSubmitChatInput(event)) return;
    event.preventDefault();
    submit();
  }

  async function answer(requestId: string, allow: boolean, message?: string, allowForSession = false) {
    setNotice(null);
    try {
      if (allowForSession) await chat.respond(thread.id, requestId, allow, message, thread.runningTurnId ?? undefined, true);
      else await chat.respond(thread.id, requestId, allow, message, thread.runningTurnId ?? undefined);
    } catch (reason) {
      setNotice(
        t("chat.approval.failed", {
          detail: reason instanceof Error ? reason.message : String(reason),
        }),
      );
    }
  }

  async function stop() {
    try {
      await chat.stop(thread.id, thread.runningTurnId ?? undefined);
    } catch (reason) {
      setNotice(
        t("chat.stop.failed", {
          detail: reason instanceof Error ? reason.message : String(reason),
        }),
      );
    }
  }

  function changePermission(permission: ChatPermission) {
    if (settingsLocked || directProxy || !permissionsFor(thread.definitionId).includes(permission)) return;
    chat.updateThread(thread.id, { permission });
  }

  function changeModel({ definitionId, accountProfileId, model, provider, proxyId }: AccountModelSelection) {
    if (settingsLocked) return;
    const agent = provider ? cliProxyAgentFor(model, installed) : definitionId;
    if (!hasChatModels(agent)) return;
    chat.updateThread(thread.id, {
      definitionId: agent,
      accountProfileId: provider && agent !== "codex" ? null : accountProfileId,
      model, provider, proxyId,
    });
    if (accountModelSourceKey(pickerValue) === accountModelSourceKey({ definitionId, accountProfileId, model, provider, proxyId })) {
      setModelPickerOpen(false);
    }
  }

  const composerModelLabel = activeProfileMissing ? t("accountModel.missing")
    : thread.model || thread.reportedModel || selectedOption?.modelLabel || t("chat.model.default");
  const latestReply = [...thread.items].reverse().find((item): item is Extract<ChatItem, { type: "text" }> => item.type === "text");

  return (
    <ChatImageConversationContext.Provider value={thread.nativeSessionId && !activeProfileMissing ? {
      definitionId: thread.definitionId, nativeSessionId: thread.nativeSessionId,
      profileConfigPath: activeProfile?.configDirectory ?? null,
    } : null}>
    <div className="chat-thread-pane" onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f" && !event.nativeEvent.isComposing) { event.preventDefault(); setSearchOpen(true); } }}>
      <header className="chat-header">
        <div className="chat-header__title">
          <ConversationIdentity assistant={assistant} title={thread.title || t("chat.untitled")}>
                {thread.archived && <span className="chat-chip">{t("history.archive")}</span>}
          </ConversationIdentity>
          <div className="chat-composer__actions">
            <details className="chat-header__menu" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.currentTarget.open = false; } }}>
              <summary className="button button--ghost button--sm" aria-label={t("chat.nav.more")}>⋯</summary>
              <div onClick={event => { if ((event.target as HTMLElement).closest("button")) { const menu = event.currentTarget.closest("details"); if (menu) menu.open = false; } }}>
            {!thread.remote && <button type="button" className="button button--ghost button--sm" aria-expanded={toolsOpen} onClick={() => setToolsOpen(value => !value)}>{t("chat.tools.title")}</button>}
            <button type="button" className="button button--ghost button--sm" aria-pressed={pins.includes(thread.id)} onClick={() => { try { togglePin(thread.id); } catch (reason) { setNotice(String(reason)); } }}>{t(pins.includes(thread.id) ? "chat.nav.unpin" : "chat.nav.pin")}</button>
            <button type="button" className="button button--ghost button--sm" onClick={() => setSearchOpen(value => !value)}>{t("chat.nav.search")}</button>
            {onSideChat && <button type="button" className="button button--ghost button--sm" onClick={onSideChat}>{t("chat.nav.side")}</button>}
            <button type="button" className="button button--ghost button--sm" onClick={() => { void import("../app/clipboardText").then(module => module.copyTextToClipboard(conversationLink(thread.id))).then(() => setStatusMessage(t("chat.nav.copied"))).catch(reason => setNotice(String(reason))); }}>{t("chat.nav.link")}</button>
            {thread.workingDirectory && !thread.remote && <button type="button" className="button button--ghost button--sm" onClick={() => setWorktreeOpen(value => !value)}>{t("chat.worktree.title")}</button>}
              </div>
            </details>
            {thread.handoff && <ConversationInfo key={thread.id} label={t("chat.handoff.info")}>
              {t("chat.handoff.pending", { assistant })}
            </ConversationInfo>}
            {!thread.archived && !directProxy && <button
              type="button"
              className="button button--ghost button--sm"
              onClick={() => setSettingsOpen((current) => !current)}
              aria-controls={`chat-settings-${thread.id}`}
              aria-expanded={settingsOpen}
            >
              {settingsOpen ? t("chat.settings.hide") : t("chat.settings")}
            </button>}
            {!thread.archived && (
              <button
                type="button"
                className={`button button--ghost button--sm${delegating ? " is-active" : ""}`}
                onClick={() => setDelegating((current) => !current)}
                aria-pressed={delegating}
                aria-label={t("chat.delegate.title")}
                title={t("chat.delegate.title")}
              >
                <AgentIcon />
              </button>
            )}
            {!thread.archived && <OpenEditorButton directory={thread.workingDirectory} />}
            {!thread.archived && thread.workingDirectory && (
              <button
                type="button"
                className={`button button--ghost button--sm${changesOpen ? " is-active" : ""}`}
                onClick={() => setChangesOpen((current) => !current)}
                aria-pressed={changesOpen}
                aria-label={t("chat.changes")}
                title={t("chat.changes")}
              >
                <CodeFileIcon />
              </button>
            )}
            {!thread.archived && (
              <button
                type="button"
                className={`button button--ghost button--sm${terminalOpen ? " is-active" : ""}`}
                onClick={() => setTerminalOpen((current) => !current)}
                aria-pressed={terminalOpen}
                aria-label={t("chat.terminal")}
                title={t("chat.terminal")}
              >
                <TerminalIcon />
              </button>
            )}
            {continueInSession && !directProxy && (
              <button
                type="button"
                className="button button--ghost button--sm"
                onClick={continueInSession}
                disabled={running || pendingInputs.length > 0 || awaitingHistory}
                title={t("chat.continueInSession.hint")}
              >
                {t("chat.continueInSession")}
              </button>
            )}
          </div>
        </div>
        {searchOpen && <form className="chat-search" onSubmit={event => { event.preventDefault(); setSearchIndex(index => index + 1); }}>
          <input ref={searchInput} className="input" value={search} onChange={event => { setSearch(event.target.value); setSearchIndex(0); }} onKeyDown={event => { if (event.key === "Escape") { setSearchOpen(false); setSearch(""); } }} aria-label={t("chat.nav.search")} />
          <span role="status">{searchMatches.length ? searchIndex % searchMatches.length + 1 : 0} / {searchMatches.length}</span>
          <button className="button button--ghost button--sm" type="button" disabled={!searchMatches.length} onClick={() => setSearchIndex(index => (index + searchMatches.length - 1) % searchMatches.length)}>↑</button>
          <button className="button button--ghost button--sm" disabled={!searchMatches.length}>↓</button>
          <button type="button" className="button button--ghost button--sm" onClick={() => { setSearchOpen(false); setSearch(""); }}>{t("common.cancel")}</button>
        </form>}
        {worktreeOpen && <ChatWorktree directory={thread.workingDirectory} busy={settingsLocked} onOpen={(directory, handoff) => {
          if (settingsLocked) return;
          if (handoff && thread.items.length) { const next = chat.branchThread(thread.id, thread.items[thread.items.length - 1].id, t("chat.worktree.suffix")); if (next) chat.updateThread(next.id, { workingDirectory: directory }); }
          else chat.createThread({ definitionId: thread.definitionId, model: thread.model, permission: thread.permission, accountProfileId: thread.accountProfileId, provider: thread.provider, proxyId: thread.proxyId, browserEnabled: thread.browserEnabled, workingDirectory: directory });
        }} />}
        {settingsOpen && !thread.archived && !directProxy && (
          <div className="chat-settings" id={`chat-settings-${thread.id}`}>
            {!directProxy && supportsBrowser(thread.definitionId) && (
              <label className="checkbox chat-settings__browser">
                <input type="checkbox" checked={thread.browserEnabled === true} disabled={settingsLocked}
                  onChange={(event) => chat.updateThread(thread.id, { browserEnabled: event.target.checked })} />
                <span className="checkbox__box" aria-hidden="true">✓</span>
                <span><strong>{t("chat.browser")}</strong><small>{t("chat.browser.hint")}</small></span>
              </label>
            )}
            {!directProxy && <ChatMcpAccess thread={thread} />}
            {!directProxy && (thread.definitionId === "claude" ||
              thread.definitionId === "codex" ||
              thread.definitionId === "gemini") && (
              <>
                <ChatInstructions
                  definitionId={thread.definitionId}
                  workingDirectory={thread.workingDirectory}
                  configDirectory={activeProfile?.configDirectory ?? null}
                />
                <ChatMcpServers
                  definitionId={thread.definitionId}
                  workingDirectory={thread.workingDirectory}
                  configDirectory={activeProfile?.configDirectory ?? null}
                />
              </>
            )}
          </div>
        )}
        {!cliInstalled && !thread.archived && (
          <Callout tone="warn">
            {t("chat.notInstalled", { cli: cliLabel(thread.definitionId) })}
          </Callout>
        )}
        {thread.pendingOperation && <p role="status">{t("chat.nativeOperation.running")}</p>}
        {thread.planMode && <span className="chat-chip">{t("chat.plan.mode")}</span>}
        {running && thread.activeOperation && <p role="status">{t(thread.activeOperation === "compact" ? "chat.compact.running" : "chat.review.running")}</p>}
        {notice && <Callout tone="danger">{notice}</Callout>}
        {statusMessage && <p className="chat-settings__hint" role="status">{statusMessage}</p>}
        {handoffProblem && <Callout tone="danger">{handoffProblem}</Callout>}
      </header>

      {latestPlan?.type === "plan" && <PlanProgress compact steps={latestPlan.steps} explanation={latestPlan.explanation} />}
      {latestGoal?.type === "goal" && <GoalProgress goal={latestGoal.goal} compact />}
      {statusOpen && <ChatStatus model={thread.model} directory={thread.workingDirectory} context={runtimeStatus?.contextUsage} rateLimits={runtimeStatus?.rateLimits}
        state={t(running ? "agents.state.working" : "agents.state.idle")} onClose={() => setStatusOpen(false)} />}
      <div className="chat-messages" ref={scrollRef} onScroll={onScroll} onWheel={onWheel}>
        <div className="chat-messages__inner">
          {nativeRead && <ConversationReadProgress loading={nativeRead.loading} error={nativeRead.error} onRetry={nativeRead.refresh} />}
          {sessionRead && <ConversationReadProgress loading={sessionRead.loading} error={sessionRead.error} onRetry={sessionRead.refresh} />}
          {thread.nativeHistorySource && !thread.runningTurnId && <p role="status">{t("native.readOnly")} · {t("history.stateUnknown")}</p>}
          {thread.nativeHistoryArchived && <p role="status">{t("history.nativeArchivedHint")}</p>}
          {thread.nativeSessionId && <NativeHistoryAccess threadId={thread.id} directory={thread.workingDirectory} />}
          {thread.historyTruncated && <p role="status">{t("history.truncated")}</p>}
          {thread.nativeSyncPending && !thread.runningTurnId && <p role="status">{t("history.syncPending")}</p>}
          {thread.items.length === 0 && !nativeRead?.loading && !nativeRead?.error && !sessionRead?.loading && !sessionRead?.error && (
            <div className="chat-welcome">
              <h3>{t("chat.welcome.title", { assistant })}</h3>
              <p>
                {thread.workingDirectory
                  ? t("chat.welcome.body", { directory: directoryName(thread.workingDirectory) })
                  : t("chat.welcome.chooseDirectory")}
              </p>
            </div>
          )}
          <ConversationTimeline collapseDefault={readStoredPreferences().chatCollapseCompletedTurns} latestFinished={false} match={matchedItem}
            rows={toolRows.map(row => {
              const item = row.value, index = thread.items.indexOf(item);
              return { id: row.id, aliases: row.aliases, user: item.type === "user",
                process: row.tool ? !toolHasProtectedContent(row.tool) : row.commentary || item.type === "reasoning" || item.type === "plan" || item.type === "goal",
                exploration: row.tool && !toolHasProtectedContent(row.tool) ? row.tool.exploration : undefined,
                steps: row.tool?.commands.length || 1, endsTurn: item.type === "turnEnd" && !running,
                durationMs: item.type === "turnEnd" ? item.durationMs : undefined,
                node: <div key={item.id} data-chat-item={row.aliases.includes(matchedItem ?? "") ? matchedItem : item.id} className={row.aliases.includes(matchedItem ?? "") ? "chat-search__match" : undefined}><ChatItemView
              key={item.id}
              item={item}
              presentation={row.tool} forceOpen={row.aliases.includes(matchedItem ?? "")}
              assistant={cliLabel(item.type !== "user" && item.type !== "notice" && item.type !== "turnEnd" && item.type !== "delegation"
                ? item.assistantDefinitionId ?? thread.definitionId
                : thread.definitionId)}
              streaming={running && (item.type === "reasoning" ? item.id.startsWith(`${thread.runningTurnId}:`) : index === thread.items.length - 1)}
              tag={tag}
              onAnswer={answer}
              workingDirectory={thread.workingDirectory}
              threadId={thread.id}
              subtask={(childId) => {
                const child = chat.getThread(childId);
                if (!child) return null;
                const result = delegationResult(child);
                return {
                  title: child.title,
                  result,
                  open: () => chat.setActiveThreadId(child.id),
                  bringBack: () => setDraft((current) => (current ? `${current}\n\n${result}` : result)),
                };
              }}
              onBranch={!settingsLocked && thread.nativeSessionId && (thread.definitionId === "codex"
                  ? (item.type === "user" || item.type === "text") && Boolean(item.nativeTurnId)
                  : thread.definitionId === "claude" && item.type === "text" && Boolean(item.nativeMessageId))
                ? () => { void chat.nativeFork(thread.id, t("chat.branch.suffix"), item.id).catch(reason => setNotice(String(reason))); } : undefined}
              onEdit={!settingsLocked && thread.nativeSessionId && item.type === "user" && (thread.definitionId === "codex" ? Boolean(item.nativeTurnId) : thread.definitionId === "claude" && (index === 0 || thread.items.slice(0, index).some(entry => entry.type === "text" && entry.nativeMessageId)))
                ? async text => {
                  const fork = await chat.nativeFork(thread.id, t("chat.branch.suffix"), item.id, true);
                  if (fork) await chat.send(fork.id, text, item.attachments ?? [], activeProfile?.configDirectory ?? null);
                } : undefined}
            /></div> };
          })} />
          {running && thread.items[thread.items.length - 1]?.type === "user" && (
            <div className="chat-msg chat-msg--assistant">
              <div className="chat-msg__body">
                <p className="chat-notice chat-cursor">{t("chat.running")}</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {!thread.archived && (
        <ChatDelegations
          thread={thread}
          chat={chat}
          assistants={Array.from(new Set([...definitions.map((definition) => definition.id as ChatDefinitionId), ...(directProxy ? [thread.definitionId] : [])]))}
          cliLabel={id => directProxy && id === thread.definitionId ? "CLIProxyAPI" : cliLabel(id)}
          composing={delegating}
          onCloseComposer={() => setDelegating(false)}
          onInsert={(text) => setDraft((current) => (current ? `${current}\n\n${text}` : text))}
        />
      )}
      {toolsOpen && <ChatTools key={thread.id} threadId={thread.id} directory={thread.workingDirectory} busy={running || Boolean(thread.pendingOperation)} assistantTools={!directProxy && ["codex", "claude"].includes(thread.definitionId)} browserEnabled={thread.browserEnabled === true} onClose={() => setToolsOpen(false)} />}
      {changesOpen && !thread.archived && thread.workingDirectory && (
        <ChatChangesPanel
          workingDirectory={thread.workingDirectory}
          busy={running}
          onWorking={setRepositoryBusy}
          checkpoint={thread.lastTurnCheckpoint}
          onReview={nativeCodex ? () => { void runNativeCommand({ kind: "review", target: { type: "uncommittedChanges" } }); } : undefined}
          onQuote={(text) => setDraft((current) => (current ? `${current}\n\n${text}` : text))}
          onClose={() => setChangesOpen(false)}
        />
      )}
      {terminalOpen && !thread.archived && (
        <ChatTerminalPanel
          workingDirectory={thread.workingDirectory}
          theme={theme}
          onClose={() => setTerminalOpen(false)}
        />
      )}

      {thread.archived ? <p className="chat-composer dialog__body">{t("history.archiveHint")}</p> : <form className="chat-composer session-composer" onSubmit={submit}>
        <ConversationComposerFrame workingDirectory={thread.workingDirectory} directoryControls={{
          disabled: settingsLocked, onChoose: () => { void chooseDirectory(); }, candidates:recentProjects,
          onChange: changeDirectory,
        }}>
          <div ref={composerDropRef} className={`chat-composer__box session-composer__box${running ? " is-busy" : ""}${draggingFiles ? " is-file-dragging" : ""}`}>
            {assistance.menu}
            {(activeProfileSignedOut || activeProfileMissing) && <p className="field__hint chat-settings__warning" role="status">
              {t(activeProfileMissing ? "accountModel.missing" : "chat.accountProfile.notSignedIn")}
            </p>}
            {attachments.length > 0 && (
              <div className="chat-attachments" aria-label={t("chat.attachment.selected")}>
                {attachments.map((attachment) => (
                  <span className="chat-attachment" key={attachment.path} title={attachment.isImage ? undefined : displayPath(attachment.path)}>
                    {attachment.isImage ? <ImageFileIcon size={14} /> : <FileIcon size={14} />}
                    <span>{attachment.isImage ? imageFileName(attachment.name) : attachment.name}</span>
                    <button
                      type="button"
                      className="chat-attachment__remove"
                      onClick={() =>
                        setAttachments((current) =>
                          current.filter((candidate) => candidate.path !== attachment.path),
                        )
                      }
                      aria-label={t("chat.attachment.remove", { name: attachment.isImage ? imageFileName(attachment.name) : attachment.name })}
                      disabled={steering}
                    >
                      <CloseIcon size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {pendingInputs.length > 0 && (
              <section className="chat-queue" aria-label={t("chat.queue.title")}>
                {thread.queueProblem === "storage" && <p role="alert">{t("chat.queue.saveFailed")}</p>}
                <div className="chat-queue__header">
                  <strong>{t("chat.queue.title")} ({pendingInputs.length})</strong>
                  <span>{t(thread.queuePaused ? "chat.queue.paused" : "chat.queue.hint")}</span>
                  {thread.queuePaused && <button type="button" className="button button--secondary button--sm"
                    disabled={running || !cliInstalled || activeProfileMissing || activeProfileSignedOut}
                    onClick={() => chat.resumeQueue(thread.id)}>{t("chat.queue.resume")}</button>}
                </div>
                <ol>{pendingInputs.map(input => <li key={input.id}>
                  <span>{input.prompt || t("chat.attachment.files")}
                    {input.attachments.length > 0 && <small>{input.attachments.map(file => file.name).join(", ")}</small>}
                  </span>
                  <QueuedPromptEditor draftId={thread.id + ":" + input.id} text={input.prompt}
                    disabled={steering || pastingImage}
                    onSave={async text => chat.editQueued(thread.id, input, text)} />
                  <button type="button" className="icon-button icon-button--sm"
                    aria-label={t("chat.queue.remove")} title={t("chat.queue.remove")}
                    onClick={() => chat.removeQueued(thread.id, input.id)}><CloseIcon size={12} /></button>
                </li>)}</ol>
              </section>
            )}
            <textarea
              ref={inputRef}
              className="chat-composer__input"
              value={draft}
              readOnly={steering}
              placeholder={t("sessionChat.placeholder")}
              onChange={(event) => { setDraft(event.target.value); assistance.select(event.target.selectionStart); }}
              onSelect={event => assistance.select(event.currentTarget.selectionStart)}
              {...assistance.inputProps}
              onBlur={assistance.dismiss} onFocus={assistance.reopen}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              aria-label={t("chat.composer.label")}
              aria-keyshortcuts="Enter"
              rows={2}
            />
            <div className="session-composer__toolbar">
              <BackgroundHistoryPicker disabled={steering} onAttach={report=>{chat.createThread({definitionId:thread.definitionId,workingDirectory:thread.workingDirectory,permission:thread.permission,model:thread.model,accountProfileId:thread.accountProfileId,provider:thread.provider,proxyId:thread.proxyId,browserEnabled:thread.browserEnabled,title:t("memory.backgroundThread"),handoff:{sourceDefinitionId:"background",transcript:report.text}});}}/>
              <ComposerAttachments disabled={steering || pastingImage} onChoose={kind => { void chooseAttachments(kind); }}>
                <ChatSkillPicker
                  definitionId={thread.definitionId}
                  workingDirectory={thread.workingDirectory}
                  profileConfigPath={activeProfile?.configDirectory ?? null}
                  disabled={steering || directProxy}
                  onPick={(text, pick) => {
                    setDraft((current) => (current && !current.endsWith(" ") ? `${current} ${text}` : `${current}${text}`));
                    if (pick) setPicks((current) => [...current.filter((entry) => entry.path !== pick.path), pick]);
                  }}
                />
              </ComposerAttachments>
              {!directProxy && <ComposerPermissionMenu value={thread.permission} disabled={settingsLocked} onChange={changePermission}
                options={permissionsFor(thread.definitionId).map(value => ({ value, label:t(permissionLabelKey[value]), description:t(permissionHintKey[value]) }))} />}
              <ComposerPopover model label={composerModelLabel} disabled={settingsLocked}
                open={modelPickerOpen} onOpenChange={setModelPickerOpen}>
                <AccountModelField options={modelOptions} value={pickerValue} disabled={settingsLocked}
                  allowCliProxyApi proxyModels={cliProxyModels} onReloadProxyModels={reloadCliProxyModels}
                  onChange={changeModel} />
                {(() => {
                  if (thread.provider) return null;
                  const efforts = effortChoices(thread.definitionId, thread.model,
                    accountModels[accountModelTargetKey({ definitionId: thread.definitionId, configDirectory: activeProfile?.configDirectory ?? null })]
                      ?? (thread.accountProfileId === null ? chat.models[thread.definitionId] : undefined));
                  if (efforts.length === 0) return null;
                  return (
                    <label className="field">
                      <span className="field__label">{t("chat.effort")}</span>
                      <select
                        className="select"
                        aria-label={t("chat.effort")}
                        value={thread.effort ?? ""}
                        disabled={settingsLocked}
                        onChange={(event) => chat.updateThread(thread.id, { effort: event.target.value || null })}
                      >
                        <option value="">{t("chat.effort.default")}</option>
                        {efforts.map((effort) => (
                          <option key={effort.value} value={effort.value} title={effort.description ?? undefined}>
                            {effort.value}
                            {effort.description ? ` — ${effort.description}` : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                  );
                })()}
              </ComposerPopover>
              {running && !directProxy && thread.definitionId === "codex" && (
                <button type="button" className="button button--secondary button--sm"
                  disabled={!canSend} title={t(preferChatSteer(thread) ? "chat.queue.hint" : "chat.steer.hint")}
                  onClick={() => { if (preferChatSteer(thread)) void submit(undefined, "queue"); else void steer(); }}>{t(steering ? "chat.steer.sending" : preferChatSteer(thread) ? "chat.queue.add" : "chat.steer.send")}</button>
              )}
              {running && (
                <button
                  type="button"
                  className="button button--secondary button--sm"
                  onClick={stop}
                >
                  <StopIcon />
                  {t("chat.stop")}
                </button>
              )}
              <ComposerVoiceControls inputRef={inputRef} draft={draft}
                hasContent={Boolean(draft.trim()) || attachments.length > 0}
                blocked={steering || pastingImage || !cliInstalled || activeProfileMissing || activeProfileSignedOut}
                working={running || pendingInputs.length > 0} sending={steering} canSend={canSend}
                sendLabel={t(preferChatSteer(thread) ? "chat.steer.send" : running || pendingInputs.length > 0 ? "chat.queue.add" : "chat.send")}
                replyVersion={latestReply ? `${latestReply.id}:${latestReply.text}` : ""} replyText={latestReply?.text ?? ""}
                onText={text => setDraft(current => current.trim() ? `${current.trimEnd()} ${text}` : text)}
                onSubmit={submit} onNotice={setNotice} />
            </div>
          </div>
        </ConversationComposerFrame>
      </form>}
    </div>
    </ChatImageConversationContext.Provider>
  );
}

function ChatItemView({
  item,
  presentation,
  forceOpen,
  assistant,
  streaming,
  tag,
  onAnswer,
  onBranch,
  onEdit,
  workingDirectory = "",
  threadId,
  subtask,
}: {
  item: ChatItem;
  presentation?: ToolPresentation;
  forceOpen?: boolean;
  assistant: string;
  streaming: boolean;
  tag: string;
  onAnswer: (requestId: string, allow: boolean, message?: string, allowForSession?: boolean) => Promise<void>;
  /** Starts a new conversation that ends at this message. */
  onBranch?: () => void;
  onEdit?: (text: string) => Promise<void>;
  /** Where images a reply mentions may be previewed from. */
  workingDirectory?: string;
  /** Lets pasted pictures and tool screenshots be shown from the chat's folder. */
  threadId?: string;
  /** Resolves a delegated subtask for its "finished" note. */
  subtask?: (childId: string) => { title: string; result: string; open: () => void; bringBack: () => void } | null;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState("");
  const [editError, setEditError] = useState("");
  const [artifactPath, setArtifactPath] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const branchButton = <span className="chat-msg__actionGroup">{(item.type === "user" || item.type === "text") && <MemorySaveButton text={item.type === "user" ? splitSessionAttachments(item.text).text : item.text} directory={workingDirectory} cli={assistant} conversationId={threadId ? `${threadId}#${item.id}` : null} />}{onEdit && <button type="button" className="chat-msg__branch" aria-label={t("chat.message.edit")}
    onClick={() => { setEdited(item.type === "user" ? item.text : ""); setEditing(true); }} title={t("chat.message.edit")}><EditIcon size={13} /></button>}{onBranch && (
    <button type="button" className="chat-msg__branch" onClick={onBranch} aria-label={t("chat.branch")} title={t("chat.branch")}><DuplicateIcon size={13} /></button>
  )}</span>;
  switch (item.type) {
    case "native": return <NativeRecordView item={item.record} threadId={threadId ?? ""} directory={workingDirectory} forceOpen={forceOpen} />;
    case "user": {
      const sent = splitSessionAttachments(item.text);
      const files = item.attachments?.length ? item.attachments : mergeAttachmentPaths([], sent.paths) ?? [];
      return (
        <ConversationMessage role="user" assistant={assistant} actions={branchButton}>
            {editing ? <form onSubmit={event => { event.preventDefault(); if (!edited.trim() || savingEdit) return;
              setSavingEdit(true); setEditError(""); void onEdit?.(edited).then(() => setEditing(false)).catch(reason => setEditError(String(reason))).finally(() => setSavingEdit(false)); }}>
              <textarea className="input" value={edited} onChange={event => setEdited(event.target.value)} disabled={savingEdit} aria-label={t("chat.message.edit")} />
              <p className="chat-settings__hint">{t("chat.message.editHint")}</p>
              {editError && <p role="alert">{editError}</p>}
              <button type="submit" className="button button--primary button--sm" disabled={savingEdit || !edited.trim()}>{t("chat.message.rerun")}</button>
              <button type="button" className="button button--ghost button--sm" disabled={savingEdit} onClick={() => setEditing(false)}>{t("common.cancel")}</button>
            </form> : sent.text && <div>{sent.text}</div>}
            <SentAttachments attachments={files} workingDirectory={workingDirectory ?? ""} threadId={threadId} />
        </ConversationMessage>
      );
    }
    case "text":
      return (
        <ConversationMessage role="assistant" assistant={assistant} actions={!streaming && branchButton}>
            <div className={streaming ? "chat-cursor" : undefined}>
              <ChatMarkdown source={item.text} onOpenFile={workingDirectory || threadId ? setArtifactPath : undefined} />
              {artifactPath && <ChatArtifact directory={workingDirectory} path={artifactPath} threadId={threadId} onClose={() => setArtifactPath(null)} />}
            </div>
            {!streaming && (workingDirectory || threadId) && (
              <ChatImagePreviews text={item.text} workingDirectory={workingDirectory} threadId={threadId} />
            )}
        </ConversationMessage>
      );
    case "plan": return <PlanProgress steps={item.steps} explanation={item.explanation} />;
    case "goal": return item.goal ? <GoalProgress goal={item.goal} /> : null;
    case "reasoning":
      return (
        <details className="chat-card chat-card--reasoning" open={forceOpen || streaming || undefined}>
          <summary>
            <span className="chat-card__label">{t("chat.reasoning")}</span>
          </summary>
          <p className="chat-card__text">{item.text}</p>
        </details>
      );
    case "tool": return <ReadableToolCard tool={presentation ?? presentTool({ ...item, input: item.summary, aliases: [item.id] })}
      forceOpen={forceOpen} directory={workingDirectory} threadId={threadId} />;
    case "approval": {
      const elicitation =
        item.name === "mcp_form" || item.name === "mcp_url" ? parseElicitation(item.input) : null;
      const unsupportedReason = t(item.name === "mcp_tool" ? "chat.approval.sessionUnsupportedMcp"
        : ["user_input", "unsupported_input", "mcp_form", "mcp_url"].includes(item.name)
          ? "chat.approval.sessionUnsupportedForm" : "chat.approval.sessionUnsupported");
      return (
        <div
          className={`chat-card chat-card--approval chat-approval--${item.decision}`}
          role="group"
          aria-label={t("chat.approval.title")}
          title={item.canAllowSession ? undefined : unsupportedReason}
          tabIndex={item.decision === "pending" && !["user_input", "unsupported_input", "mcp_form", "mcp_url"].includes(item.name) ? 0 : undefined}
          onKeyDown={event => {
            if (item.decision !== "pending" || ["user_input", "unsupported_input", "mcp_form", "mcp_url"].includes(item.name)) return;
            const decision = approvalShortcut(event, event.target === event.currentTarget, item.canAllowSession);
            if (decision) { event.preventDefault(); event.stopPropagation(); void onAnswer(item.requestId, decision !== "deny", undefined, decision === "session" ? true : undefined); }
          }}
        >
          <div className="chat-card__head">
            <span className="chat-card__label">{item.name}</span>
            <code className="chat-card__summary" title={item.summary}>
              {item.summary}
            </code>
            <span className="chat-card__state">
              {item.decision === "pending"
                ? t("chat.approval.title")
                : item.allowedForSession ? t("chat.approval.sessionAllowed") : t(`chat.approval.${item.decision}` as MessageKey)}
            </span>
          </div>
          {item.name === "user_input" && item.decision === "pending" && (
            <ChatQuestions
              input={item.input}
              onAnswer={(allow, message) => onAnswer(item.requestId, allow, message)}
            />
          )}
          {(item.name === "mcp_form" || item.name === "mcp_url") &&
            item.decision === "pending" &&
            (elicitation ? (
              <McpElicitation
                request={elicitation}
                onAnswer={(allow, message) => onAnswer(item.requestId, allow, message)}
              />
            ) : (
              <p className="chat-notice">{t("chat.question.unsupported")}</p>
            ))}
          {item.name === "unsupported_input" && item.decision === "pending" && (
            <p className="chat-notice">{t("chat.question.unsupported")}</p>
          )}
          {item.name !== "user_input" && item.input && item.input !== "null" && (
            <details className="chat-card__details">
              <summary>{t("chat.approval.input")}</summary>
              <pre className="chat-card__output">{item.input}</pre>
            </details>
          )}
          {item.decision === "pending" && item.name !== "user_input" && !elicitation && (
            <div className="chat-card__actions">
              <ApprovalActions canAllowSession={item.canAllowSession}
                allowOnce={!["unsupported_input", "mcp_form", "mcp_url"].includes(item.name)}
                unsupportedReason={unsupportedReason}
                onAnswer={(allow, forSession) => void onAnswer(item.requestId, allow, undefined, forSession)} />
            </div>
          )}
        </div>
      );
    }
    case "notice":
      return <p className="chat-notice">{item.text}</p>;
    case "delegation": {
      const child = subtask?.(item.childId) ?? null;
      return (
        <div className={`chat-delegation-note${item.failed ? " is-failed" : ""}`} role="status">
          <span>
            {t(item.failed ? "chat.delegate.noteFailed" : "chat.delegate.noteDone", {
              title: child?.title.replace(/^↳\s*/, "") ?? t("chat.delegate.noteGone"),
            })}
          </span>
          {child && (
            <>
              <button type="button" className="button button--ghost button--sm" onClick={child.open}>
                {t("chat.delegate.open")}
              </button>
              {!item.failed && child.result && (
                <button type="button" className="button button--secondary button--sm" onClick={child.bringBack}>
                  {t("chat.delegate.bringBack")}
                </button>
              )}
            </>
          )}
        </div>
      );
    }
    case "turnEnd":
      if (item.error) {
        // A headless turn cannot open the CLI's own login screen, so an
        // expired login surfaces as a bare error. Say what to do about it.
        const needsLogin =
          /authenticat|oauth|logged in|log in|login|unauthori[sz]ed|\b401\b/i.test(item.error);
        return (
          <Callout tone="danger" title={needsLogin ? t("chat.turn.needsLogin") : t("chat.turn.failed")}>
            {needsLogin && <p className="chat-callout__lead">{t("chat.turn.needsLogin.body", { assistant })}</p>}
            {item.error}
          </Callout>
        );
      }
      return (
        <p className="chat-turn">
          <span className="chat-turn__pill chat-turn__pill--ok">{t("chat.turn.done")}</span>
          {item.durationMs !== null && (
            <span className="chat-turn__pill">
              {t("chat.turn.duration", {
                seconds: new Intl.NumberFormat(tag, { maximumFractionDigits: 1 }).format(
                  item.durationMs / 1000,
                ),
              })}
            </span>
          )}
          {item.usage && (
            <span className="chat-turn__pill">
              {t("chat.turn.tokens", {
                input: formatTokens(item.usage.inputTokens + item.usage.cacheReadTokens),
                output: formatTokens(item.usage.outputTokens),
              })}
            </span>
          )}
          {item.costUsd !== null && (
            <span className="chat-turn__pill">
              {t("chat.turn.cost", {
                cost: new Intl.NumberFormat("en-US", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 4,
                }).format(item.costUsd),
              })}
            </span>
          )}
        </p>
      );
  }
}
