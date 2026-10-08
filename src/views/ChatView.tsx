import { ChatMcpAccess } from "../components/chat/ChatMcpAccess";
import { useChatClipboardFallback } from "../app/chatClipboard";
import { conversationDraftHasInput, useConversationDraft } from "../app/useConversationDraft";
import { desktopChatAccess } from "../app/desktopChat";
import { NativeConversationRows } from "../components/chat/NativeConversationRows";
import { useNativeHistory } from "../app/useNativeConversations";
import { PathDropZone } from "../components/files/PathDropZone";
import { useFileDrop } from "../app/fileDrop";
import { SessionConversationPane } from "../components/chat/SessionConversationPane";
import { ConversationIdentity, ConversationListIdentity, ConversationMessage } from "../components/chat/ConversationPresentation";
import { ConversationComposerFrame, ComposerAttachments, ComposerPopover } from "../components/chat/ConversationComposer";
import { ComposerVoiceControls } from "../components/chat/ComposerVoiceControls";
import { useFittingTabs } from "../components/chat/useFittingTabs";
import { appendSessionTurns, liveSessionForThread, sessionLaunchForThread } from "../app/chatSessionHandoff";
import type { NativeMessageSnapshot } from "../app/useNativeConversations";
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
import { CHAT_ATTACHMENT_LIMIT } from "../app/chatAttachments";
import {
  defaultPermission,
  effortChoices,
  toolOutputCount,
  delegationResult,
  supportsBrowser,
  looksLikeDiff,
  formatTokens,
  permissionsFor,
  threadIsFresh,
  mentionsInPrompt,
  type ChatDefinitionId,
  type ChatAttachment,
  type ChatItem,
  type ChatPermission,
  type ChatThread,
} from "../app/agentChat";
import type { AgentChatApi } from "../app/useAgentChat";
import type { AgentAutomationsApi } from "../app/useAgentAutomations";
import { AutomationPane, describeSchedule } from "../components/chat/AutomationPane";
import type { AgentApi, AgentDefinition } from "../app/useAgentSessions";
import { displayPath } from "../app/displayPath";
import { hasDesktopBackend } from "../app/nativeRuntime";
import {
  profileCapable,
  profilesFor,
  type ChatAccountProfile,
} from "../app/chatAccountProfiles";
import { useAccountProfileStatus } from "../app/useAccountProfileStatus";
import { accountModelKey, accountModelSourceKey, accountModelOptions, accountModelTargets, cliProxyAgentFor, hasChatModels, validCliProxyModel, type AccountModelSelection } from "../app/accountModels";
import { useAccountModels } from "../app/useAccountModels";
import { useChatAccountProfiles } from "../app/useChatAccountProfiles";
import { useI18n } from "../i18n/context";
import { ChatQueueError } from "../app/chatInputQueue";
import { chatWorkspaceProjection } from "../app/chatWorkspaceNodes";
import { chatSidebarLayout } from "../app/chatThreadLayout";
import { moveSessionSidebarNode } from "../app/sessionSidebarLayout";
import { useSharedSidebarLayout } from "../app/sharedSidebarLayout";
import type { MessageKey } from "../i18n/messages/zh-TW";
import { Callout, EmptyState } from "../components/common/Callout";
import { ConfirmDialog } from "../components/overlays/ConfirmDialog";
import { ChatMarkdown } from "../components/chat/ChatMarkdown";
import { AccountModelField } from "../components/agents/AccountModelField";
import { findCliProxy } from "../app/cliProxyApi";
import { useCliProxyModelLists, useCliProxySettings } from "../app/useCliProxyApi";
import { ChatThreadTree } from "../components/chat/ChatThreadTree";
import { ChatWebSources } from "../components/chat/ChatWebSources";
import { ChatInstructions } from "../components/chat/ChatInstructions";
import { ChatMcpServers } from "../components/chat/ChatMcpServers";
import { ChatSkillPicker } from "../components/chat/ChatSkillPicker";
import { ChatImagePreviews, ChatImageStrip } from "../components/chat/ChatImagePreviews";
import { ChatDelegations } from "../components/chat/ChatDelegations";
import { chatProjectKey, chatProjectsWithHistory, projectName } from "../app/chatProjects";
import { ChatTerminalPanel } from "../components/chat/ChatTerminalPanel";
import { ChatChangesPanel } from "../components/chat/ChatChangesPanel";
import type { ThemeId } from "../app/themes";
import { McpElicitation, parseElicitation } from "../components/chat/McpElicitation";
import { webSources } from "../app/chatWebSources";
import { diffLineKind } from "../app/gitChanges";
import { SidebarStorageNotice } from "../components/sessions/SidebarStorageNotice";
import { ChatQuestions } from "../components/chat/ChatQuestions";
import {
  AgentIcon,
  AlertIcon,
  ShieldIcon,
  ArchiveFileIcon,
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
  SettingsIcon,
  StopIcon,
  TrashIcon,
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
  onSelectWorkspaceSession,
}: {
  agents: AgentApi;
  chat: AgentChatApi;
  automations: AgentAutomationsApi;
  onOpenSession: (sessionId: string) => void;
  theme?: ThemeId;
  workspaceSessionId?: string | null;
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
  const [mode, setMode] = useState<"threads" | "projects" | "automations">("threads");
  const modeTabs = useFittingTabs<HTMLDivElement>();
  // A project picked in the projects tab narrows the conversation list to it.
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [selectedAutomationId, setSelectedAutomationId] = useState<string | null>(null);
  const [composingAutomation, setComposingAutomation] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [sessionSidebarLayout, setSharedLayout] = useSharedSidebarLayout();
  const accountProfiles = useChatAccountProfiles();
  // Conversations and running sessions share one tree, so a folder holds the
  // work rather than one kind of row.
  const workspace = useMemo(
    () =>
      chatWorkspaceProjection(
        agents.sessions,
        agents.catalog,
        t("terminal.projects.generalChat"),
      ),
    [agents.catalog, agents.sessions, t],
  );
  // Shelved threads leave the tree and wait in their own list below it.
  const nativeHistory = useNativeHistory();
  const projects = useMemo(() => chatProjectsWithHistory(chat.threads, nativeHistory?.entries ?? []),
    [chat.threads, nativeHistory?.entries]);
  // While a terminal session runs a thread's conversation, that session is
  // the one entry for it; two entries would invite two writers.
  const listedThreads = useMemo(
    () =>
      chat.threads.filter(
        (thread) =>
          !thread.shelvedAt &&
          !liveSessionForThread(thread, agents.sessions) &&
          (projectFilter === null || chatProjectKey(thread.workingDirectory) === projectFilter),
      ),
    [agents.sessions, chat.threads, projectFilter],
  );
  const shelvedThreads = useMemo(
    () =>
      chat.threads
        .filter((thread) => thread.shelvedAt)
        .sort((a, b) => (b.shelvedAt ?? 0) - (a.shelvedAt ?? 0)),
    [chat.threads],
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
  const active = chat.threads.find((thread) => thread.id === chat.activeThreadId) ?? null;
  const activeLiveSession = active ? liveSessionForThread(active, agents.sessions) : undefined;
  const shownSession = selectedSession ?? activeLiveSession;
  const { proxies } = useCliProxySettings();
  const [handoffProblem, setHandoffProblem] = useState<string | null>(null);
  const handingOff = useRef(false);

  async function continueInSession(thread: ChatThread) {
    if (handingOff.current) return;
    handingOff.current = true;
    setHandoffProblem(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const directory = thread.workingDirectory ||
        await invoke<string>("agent_chat_general_directory", { threadId: thread.id });
      const request = sessionLaunchForThread(thread, directory, agents.catalog, accountProfiles, proxies);
      if (!request) throw new Error(t("chat.continueInSession.unavailable"));
      await chat.continueInSession(thread.id);
      const launched = await agents.launch(request);
      if (launched.closedReason) throw new Error(launched.closedReason);
      try {
        await agents.rename(launched.sessionId, thread.title || request.label);
      } catch {
        // The terminal is already running the conversation.
      }
      onOpenSession(launched.sessionId);
    } catch (reason) {
      setHandoffProblem(t("chat.continueInSession.failed", {
        detail: reason instanceof Error ? reason.message : String(reason),
      }));
    } finally {
      handingOff.current = false;
    }
  }

  // Once the terminal is done, read back what was said there.
  const catchingUp = useRef(new Set<string>());
  useEffect(() => {
    if (!active?.continuedInSession || !active.nativeSessionId || activeLiveSession ||
      catchingUp.current.has(active.id)) return;
    const thread = active;
    catchingUp.current.add(thread.id);
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const snapshot = await invoke<NativeMessageSnapshot>("agent_chat_local_history_snapshot", {
          definitionId: thread.definitionId,
          nativeSessionId: thread.nativeSessionId,
          profileId: thread.accountProfileId,
          profiles: accountProfiles.map(({ id, definitionId, configDirectory }) =>
            ({ profileId: id, definitionId, configDirectory })),
        });
        chat.updateThreadFromSession(thread.id, (current) =>
          appendSessionTurns(current, snapshot, t("chat.continuedInSession.notice")));
      } catch {
        // Try again the next time the thread is opened.
      } finally {
        catchingUp.current.delete(thread.id);
      }
    })();
  }, [accountProfiles, active, activeLiveSession, chat, t]);

  function startThread(workingDirectory = "") {
    setSelectedSessionId(null);
    // Keep the assistant choice; selecting a project is optional for each chat.
    // Inside a project, its own latest conversation is the better guide:
    // projects tend to keep one assistant, model and permission.
    const normalized = workingDirectory.replace(/[\\/]+$/, "") || workingDirectory;
    const inProject = normalized
      ? chat.threads
          .filter(
            (thread) => (thread.workingDirectory.replace(/[\\/]+$/, "") || thread.workingDirectory) === normalized,
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
        : (installed[0] ?? chat.supported[0] ?? "claude");
    chat.createThread({
      definitionId,
      workingDirectory,
      permission:
        previous && permissionsFor(definitionId).includes(previous.permission)
          ? previous.permission
          : defaultPermission(definitionId),
      model: previous?.definitionId === definitionId ? previous.model : "",
      provider: previous?.definitionId === definitionId ? previous.provider : undefined,
      accountProfileId: previous?.definitionId === definitionId ? previous.accountProfileId : null,
    });
  }

  function startAutomation() {
    setSelectedAutomationId(null);
    setComposingAutomation(true);
    setMode("automations");
  }

  function openThread(threadId: string) {
    setMode("threads");
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

  return (
    <section className="chat-view" aria-label={t("chat.title")}>
      <aside className="chat-threads">
        <div className="chat-threads__header">
          <div ref={modeTabs.ref} className={`chat-mode${modeTabs.compact ? " is-compact" : ""}`} role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "threads"}
              className={`chat-mode__tab${mode === "threads" ? " is-active" : ""}`}
              onClick={() => setMode("threads")}
              title={t("chat.title")}
            >
              <ChatIcon />
              <span className="chat-mode__label">{t("chat.title")}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "projects"}
              className={`chat-mode__tab${mode === "projects" ? " is-active" : ""}`}
              onClick={() => setMode("projects")}
              title={t("chat.projects")}
            >
              <FolderIcon />
              <span className="chat-mode__label">{t("chat.projects")}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "automations"}
              className={`chat-mode__tab${mode === "automations" ? " is-active" : ""}`}
              onClick={() => setMode("automations")}
              title={t("automation.title")}
            >
              <ClockIcon />
              <span className="chat-mode__label">{t("automation.title")}</span>
              {automations.unreadCount > 0 && (
                <span className="chat-mode__badge" aria-label={t("automation.unread", { count: automations.unreadCount })}>
                  {automations.unreadCount}
                </span>
              )}
            </button>
          </div>
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
              onClick={mode === "automations" ? startAutomation : () => startThread(projectFilter ?? "")}
              disabled={agents.mode !== "ready"}
              aria-label={mode === "automations" ? t("automation.new") : t("chat.new")}
              title={mode === "automations" ? t("automation.new") : t("chat.new")}
            >
              <PlusIcon />
            </button>
          </div>
        </div>
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
            {projectFilter !== null && (
              <div className="chat-project-filter">
                <FolderIcon />
                <span title={projectFilter}>{projectName(projectFilter)}</span>
                <button
                  type="button"
                  className="chat-tree__action"
                  onClick={() => setProjectFilter(null)}
                  aria-label={t("chat.projects.clear")}
                  title={t("chat.projects.clear")}
                >
                  <CloseIcon />
                </button>
              </div>
            )}
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
                      {cliLabel(thread.definitionId)}
                      {thread.model ? ` · ${thread.model}` : ""}
                      {thread.workingDirectory
                        ? ` · ${directoryName(thread.workingDirectory)}`
                        : ""}
                  </ConversationListIdentity>
                  {thread.runningTurnId ? (
                    <span className="chat-thread__dot" aria-label={t("chat.running")} />
                  ) : thread.unread ? (
                    <span className="chat-thread__dot chat-thread__dot--unread" aria-label={t("automation.unread.one")} />
                  ) : null}
                </div>
              )}
            />
            <NativeConversationRows chat={chat} projectFilter={projectFilter} onOpened={() => setSelectedSessionId(null)} />
            {chat.layout.folders.length > 0 && (
              <p className="chat-threads__hint">{t("chat.folder.dragHint")}</p>
            )}
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
        ) : mode === "projects" ? (
          <ul className="chat-threads__list chat-projects">
            {projects.length === 0 && <li className="chat-threads__hint">{t("chat.projects.none")}</li>}
            {projects.map((project) => (
              <li key={project.directory}>
                <button
                  type="button"
                  className={`chat-thread${projectFilter === project.directory ? " is-active" : ""}`}
                  title={displayPath(project.directory)}
                  onClick={() => {
                    setProjectFilter(project.directory);
                    setMode("threads");
                  }}
                >
                  <span>
                    <span className="chat-thread__title">{project.name}</span>
                    <span className="chat-thread__meta">
                      {t("chat.projects.count", { count: project.threads })} · {displayPath(project.directory)}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="chat-tree__action"
                  aria-label={t("chat.projects.newChat", { name: project.name })}
                  title={t("chat.projects.newChat", { name: project.name })}
                  onClick={() => {
                    setProjectFilter(project.directory);
                    setMode("threads");
                    startThread(project.directory);
                  }}
                >
                  <PlusIcon />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <ul className="chat-threads__list">
            {automations.automations.map((automation) => (
              <li key={automation.id}>
                <button
                  type="button"
                  className={`chat-thread${automation.id === selectedAutomationId && !composingAutomation ? " is-active" : ""}`}
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
        {mode === "automations" && agents.mode !== "unavailable" ? (
          composingAutomation || selectedAutomationId ? (
            <AutomationPane
              automations={automations}
              selectedId={selectedAutomationId}
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
            agents={agents} onOpenTerminal={() => onOpenSession(shownSession.sessionId)}
            onSessionReplaced={setSelectedSessionId} />
        ) : selectedSessionId ? (
          <EmptyState icon={<ChatIcon />} title={t("sessionChat.closed")}
            description={t("sessionChat.chooseAnother")} />
        ) : installed.length === 0 && agents.mode === "ready" && !active?.archived ? (
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
                onClick={() => startThread(projectFilter ?? "")}
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
            onDelete={() => setPendingDelete(active)}
            continueInSession={sessionLaunchForThread(active, active.workingDirectory || "general",
              agents.catalog, accountProfiles, proxies) && !active.archived
              ? () => void continueInSession(active) : undefined}
            handoffProblem={handoffProblem}
          />
        )}
      </div>

      {pendingDelete && (
        <ConfirmDialog
          title={t("chat.delete.confirm.title", {
            title: pendingDelete.title || t("chat.untitled"),
          })}
          body={t("chat.delete.confirm.body")}
          confirmLabel={t("chat.delete.confirm.action")}
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
    </section>
  );
}

function ThreadPane({
  thread,
  chat,
  installed,
  definitions,
  cliLabel,
  tag,
  accountProfiles,
  theme,
  onDelete,
  continueInSession,
  handoffProblem,
}: {
  thread: ChatThread;
  chat: AgentChatApi;
  installed: readonly ChatDefinitionId[];
  definitions: readonly AgentDefinition[];
  cliLabel: (id: ChatDefinitionId) => string;
  tag: string;
  accountProfiles: readonly ChatAccountProfile[];
  theme: ThemeId;
  onDelete: () => void;
  /** Present when the conversation can go on in a terminal session. */
  continueInSession?: () => void;
  handoffProblem?: string | null;
}) {
  const { t } = useI18n();
  const { draft, setDraft, attachments, setAttachments, picks, setPicks,
    pasting: pastingImage, setPasting: setPastingImage, steering, setSteering,
    addAttachmentPaths, readDraft } = useConversationDraft("thread", thread.id);
  const [notice, setNotice] = useState<string | null>(null);
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
  const [delegating, setDelegating] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedToBottom = useRef(true);
  const running = thread.runningTurnId !== null;
  const pendingInputs = thread.pendingInputs ?? [];
  const settingsLocked = running || pendingInputs.length > 0;
  const cliInstalled = installed.includes(thread.definitionId);
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
  }, pickerValue, cliProxySettings.proxies);
  const selectedOption = modelOptions.find((option) => accountModelKey(option) === accountModelKey(pickerValue));
  const activeProfileMissing = thread.accountProfileId !== null && activeProfile === null;
  const activeProfileSignedOut = selectedOption?.disabled === true;
  const canSend =
    !steering &&
    !pastingImage &&
    !activeProfileMissing &&
    !activeProfileSignedOut &&
    (!thread.provider || (findCliProxy(cliProxySettings, thread.proxyId) !== null && validCliProxyModel(thread.model))) &&
    cliInstalled &&
    (draft.trim() !== "" || attachments.length > 0);
  const assistant = cliLabel(thread.definitionId);

  // Follow the reply as it streams, unless the reader scrolled up to look
  // at something earlier.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node && pinnedToBottom.current) node.scrollTop = node.scrollHeight;
  }, [thread.items]);

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
    void keepImagePreviews(next.filter(file => file.isImage && !file.preview && paths.includes(file.path)));
    return true;
  }

  /** Thumbnails need the picture inside a folder the preview may read. */
  async function keepImagePreviews(images: readonly ChatAttachment[]) {
    if (images.length === 0 || !hasDesktopBackend()) return;
    const { invoke } = await import("@tauri-apps/api/core");
    for (const image of images) {
      const preview = await invoke<string | null>("agent_chat_keep_image_preview", {
        threadId: thread.id,
        path: image.path,
      }).catch(() => null);
      if (!preview) continue;
      setAttachments(current => current.map(file => file.path === image.path ? { ...file, preview } : file));
    }
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

  function onScroll() {
    const node = scrollRef.current;
    if (!node) return;
    pinnedToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
  }

  async function chooseDirectory() {
    setNotice(null);
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t("chat.directory.choose"),
      });
      if (typeof selected === "string") {
        chat.updateThread(thread.id, { workingDirectory: selected });
      }
    } catch (reason) {
      setNotice(
        t("chat.directory.chooseFailed", {
          detail: reason instanceof Error ? reason.message : String(reason),
        }),
      );
    }
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!canSend || steeringRef.current || pastingImageRef.current) return;
    const prompt = draft;
    const mentions = mentionsInPrompt(prompt, picks);
    if (running || pendingInputs.length > 0) {
      try {
        chat.enqueue(thread.id, prompt, attachments, activeProfile?.configDirectory ?? null, mentions);
      } catch (reason) {
        setNotice(reason instanceof ChatQueueError ? t(`chat.queue.${reason.code}`) : reason instanceof Error ? reason.message : String(reason));
        return;
      }
    } else {
      void chat.send(thread.id, prompt, attachments, activeProfile?.configDirectory ?? null, undefined, mentions);
    }
    setDraft("");
    setAttachments([]);
    setPicks([]);
    pinnedToBottom.current = true;
    setSettingsOpen(false);
    setNotice(null);
  }

  async function steer() {
    if (!canSend || steeringRef.current || pastingImageRef.current || !running || thread.definitionId !== "codex") return;
    steeringRef.current = true;
    setSteering(true);
    setNotice(null);
    try {
      await chat.steer(thread.id, draft, attachments, undefined, mentionsInPrompt(draft, picks));
      setDraft("");
      setAttachments([]);
      setPicks([]);
      pinnedToBottom.current = true;
    } catch (reason) {
      setNotice(t("chat.steer.failed", { detail: reason instanceof Error ? reason.message : String(reason) }));
    } finally {
      steeringRef.current = false;
      setSteering(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    clipboard.onKeyDown(event.nativeEvent);
    // Enter while an input method is composing picks a candidate; it must
    // not send half a sentence.
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  }

  async function answer(requestId: string, allow: boolean, message?: string) {
    setNotice(null);
    try {
      await chat.respond(thread.id, requestId, allow, message);
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
      await chat.stop(thread.id);
    } catch (reason) {
      setNotice(
        t("chat.stop.failed", {
          detail: reason instanceof Error ? reason.message : String(reason),
        }),
      );
    }
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

  const modelLabel = selectedOption?.label ?? (activeProfileMissing ? t("accountModel.missing") : thread.model || t("chat.model.default"));
  const composerModelLabel = activeProfileMissing ? t("accountModel.missing")
    : thread.model || thread.reportedModel || selectedOption?.modelLabel || t("chat.model.default");
  const latestReply = [...thread.items].reverse().find((item): item is Extract<ChatItem, { type: "text" }> => item.type === "text");

  return (
    <>
      <header className="chat-header">
        <div className="chat-header__title">
          <ConversationIdentity assistant={assistant} title={thread.title || t("chat.untitled")}>
                {!thread.archived && <button
                  type="button"
                  className="chat-chip"
                  onClick={() => setSettingsOpen((current) => !current)}
                  aria-expanded={settingsOpen}
                  aria-controls={`chat-settings-${thread.id}`}
                >
                  <SettingsIcon />
                  {modelLabel}
                </button>}
                {!thread.archived && <span className="chat-chip" title={displayPath(thread.workingDirectory)}>
                  <FolderIcon />
                  {thread.workingDirectory
                    ? directoryName(thread.workingDirectory)
                    : t("chat.directory.none")}
                </span>}
                {thread.archived ? <span className="chat-chip">{t("history.archive")}</span> : <span className="chat-chip">{t(permissionLabelKey[thread.permission])}</span>}
          </ConversationIdentity>
          <div className="chat-composer__actions">
            {!thread.archived && <button
              type="button"
              className="button button--ghost button--sm"
              onClick={() => setSettingsOpen((current) => !current)}
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
            {continueInSession && (
              <button
                type="button"
                className="button button--ghost button--sm"
                onClick={continueInSession}
                disabled={running || pendingInputs.length > 0}
                title={t("chat.continueInSession.hint")}
              >
                {t("chat.continueInSession")}
              </button>
            )}
            <button
              type="button"
              className="button button--ghost button--sm"
              onClick={() => chat.shelveThread(thread.id, !thread.shelvedAt)}
              aria-label={t(thread.shelvedAt ? "chat.unshelve" : "chat.shelve")}
              title={t(thread.shelvedAt ? "chat.unshelve" : "chat.shelve")}
            >
              <ArchiveFileIcon />
            </button>
            <button
              type="button"
              className="button button--ghost button--danger button--sm"
              onClick={onDelete}
              aria-label={t("chat.delete")}
              title={t("chat.delete")}
            >
              <TrashIcon />
            </button>
          </div>
        </div>
        {settingsOpen && !thread.archived && (
          <div className="chat-settings" id={`chat-settings-${thread.id}`}>
            <AccountModelField
              options={modelOptions}
              value={pickerValue}
              disabled={settingsLocked}
              allowCliProxyApi
              proxyModels={cliProxyModels}
              onReloadProxyModels={reloadCliProxyModels}
              onChange={changeModel}
            />
            {(activeProfileSignedOut || activeProfileMissing) && (
              <p className="field__hint chat-settings__warning" role="status">
                {t(activeProfileMissing ? "accountModel.missing" : "chat.accountProfile.notSignedIn")}
              </p>
            )}
            {(() => {
              if (thread.provider) return null;
              const efforts = effortChoices(thread.definitionId, thread.model, chat.models[thread.definitionId]);
              if (efforts.length === 0) return null;
              return (
                <label className="field">
                  <span className="field__label">{t("chat.effort")}</span>
                  <select
                    className="select"
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
            <div className="field field--grow">
              <span className="field__label">{t("chat.directory")}</span>
              <PathDropZone kind="directory" disabled={settingsLocked} onSelect={path => chat.updateThread(thread.id, { workingDirectory: path })}>
              <div className="chat-directory">
                <button
                  type="button"
                  className="button button--secondary button--sm"
                  onClick={chooseDirectory}
                  disabled={settingsLocked}
                >
                  <FolderIcon />
                  {t("chat.directory.choose")}
                </button>
                {thread.workingDirectory && (
                  <button type="button" className="button button--ghost button--sm" disabled={settingsLocked}
                    onClick={() => chat.updateThread(thread.id, { workingDirectory: "" })}>
                    {t("chat.directory.clear")}
                  </button>
                )}
                <span className="chat-directory__path" title={displayPath(thread.workingDirectory)}>
                  {thread.workingDirectory
                    ? displayPath(thread.workingDirectory)
                    : t("chat.directory.none")}
                </span>
              </div>
              </PathDropZone>
            </div>
            <label className="field">
              <span className="field__label">{t("chat.permission")}</span>
              <select
                className="select"
                value={thread.permission}
                disabled={settingsLocked}
                onChange={(event) =>
                  chat.updateThread(thread.id, {
                    permission: event.target.value as ChatPermission,
                  })
                }
              >
                {permissionsFor(thread.definitionId).map((permission) => (
                  <option key={permission} value={permission}>
                    {t(permissionLabelKey[permission])}
                  </option>
                ))}
              </select>
            </label>
            {supportsBrowser(thread.definitionId) && (
              <label className="checkbox chat-settings__browser">
                <input type="checkbox" checked={thread.browserEnabled === true} disabled={settingsLocked}
                  onChange={(event) => chat.updateThread(thread.id, { browserEnabled: event.target.checked })} />
                <span className="checkbox__box" aria-hidden="true">✓</span>
                <span><strong>{t("chat.browser")}</strong><small>{t("chat.browser.hint")}</small></span>
              </label>
            )}
            <p className="chat-settings__hint">
              {t(permissionHintKey[thread.permission])}
              {profileCapable(thread.definitionId) ? ` ${t("chat.accountProfile.hint")}` : ""}
            </p>
            <ChatMcpAccess thread={thread} />
            {(thread.definitionId === "claude" ||
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
        {thread.permission === "full" && !thread.archived && (
          <Callout tone="warn">{t("chat.permission.full.hint")}</Callout>
        )}
        {thread.handoff && (
          <Callout tone="info">
            {t("chat.handoff.pending", { assistant })}
          </Callout>
        )}
        {!cliInstalled && !thread.archived && (
          <Callout tone="warn">
            {t("chat.notInstalled", { cli: cliLabel(thread.definitionId) })}
          </Callout>
        )}
        {notice && <Callout tone="danger">{notice}</Callout>}
        {handoffProblem && <Callout tone="danger">{handoffProblem}</Callout>}
      </header>

      <div className="chat-messages" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-messages__inner">
          {thread.nativeHistorySource && !thread.runningTurnId && <p role="status">{t("history.textOnly")} · {t("history.stateUnknown")}</p>}
          {thread.nativeHistoryArchived && <p role="status">{t("history.nativeArchivedHint")}</p>}
          {thread.historyTruncated && <p role="status">{t("history.truncated")}</p>}
          {thread.nativeSyncPending && !thread.runningTurnId && <p role="status">{t("history.syncPending")}</p>}
          {thread.items.length === 0 && (
            <div className="chat-welcome">
              <span className="chat-avatar chat-avatar--lg" aria-hidden="true">
                {assistant.slice(0, 1)}
              </span>
              <h3>{t("chat.welcome.title", { assistant })}</h3>
              <p>
                {thread.workingDirectory
                  ? t("chat.welcome.body", { directory: directoryName(thread.workingDirectory) })
                  : t("chat.welcome.chooseDirectory")}
              </p>
            </div>
          )}
          {thread.items.map((item, index) => (
            <ChatItemView
              key={item.id}
              item={item}
              assistant={cliLabel(item.type !== "user" && item.type !== "notice" && item.type !== "turnEnd" && item.type !== "delegation"
                ? item.assistantDefinitionId ?? thread.definitionId
                : thread.definitionId)}
              streaming={running && index === thread.items.length - 1}
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
              onBranch={
                running && index === thread.items.length - 1
                  ? undefined
                  : () => chat.branchThread(thread.id, item.id, t("chat.branch.suffix"))
              }
            />
          ))}
          {running && thread.items[thread.items.length - 1]?.type === "user" && (
            <div className="chat-msg chat-msg--assistant">
              <span className="chat-avatar" aria-hidden="true">
                {assistant.slice(0, 1)}
              </span>
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
          assistants={definitions.map((definition) => definition.id as ChatDefinitionId)}
          cliLabel={cliLabel}
          composing={delegating}
          onCloseComposer={() => setDelegating(false)}
          onInsert={(text) => setDraft((current) => (current ? `${current}\n\n${text}` : text))}
        />
      )}
      {changesOpen && !thread.archived && thread.workingDirectory && (
        <ChatChangesPanel
          workingDirectory={thread.workingDirectory}
          busy={running}
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
        <ConversationComposerFrame workingDirectory={thread.workingDirectory}>
          <div ref={composerDropRef} className={`chat-composer__box session-composer__box${running ? " is-busy" : ""}${draggingFiles ? " is-file-dragging" : ""}`}>
            {attachments.length > 0 && (
              <div className="chat-attachments" aria-label={t("chat.attachment.selected")}>
                {attachments.map((attachment) => (
                  <span className="chat-attachment" key={attachment.path} title={displayPath(attachment.path)}>
                    {attachment.isImage ? <ImageFileIcon size={14} /> : <FileIcon size={14} />}
                    <span>{attachment.name}</span>
                    <button
                      type="button"
                      className="chat-attachment__remove"
                      onClick={() =>
                        setAttachments((current) =>
                          current.filter((candidate) => candidate.path !== attachment.path),
                        )
                      }
                      aria-label={t("chat.attachment.remove", { name: attachment.name })}
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
                  <button type="button" className="button button--ghost button--sm"
                    disabled={steering || pastingImage}
                    onClick={() => {
                      if (!addAttachments(input.attachments.map(file => file.path))) return;
                      setDraft(current => current ? `${current}\n\n${input.prompt}` : input.prompt);
                      chat.removeQueued(thread.id, input.id);
                    }}>{t("chat.queue.edit")}</button>
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
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              aria-label={t("chat.composer.label")}
              aria-keyshortcuts="Enter"
              rows={2}
            />
            <div className="session-composer__toolbar">
              <ComposerAttachments disabled={steering || pastingImage} onChoose={kind => { void chooseAttachments(kind); }}>
                <ChatSkillPicker
                  definitionId={thread.definitionId}
                  workingDirectory={thread.workingDirectory}
                  profileConfigPath={activeProfile?.configDirectory ?? null}
                  disabled={steering}
                  onPick={(text, pick) => {
                    setDraft((current) => (current && !current.endsWith(" ") ? `${current} ${text}` : `${current}${text}`));
                    if (pick) setPicks((current) => [...current.filter((entry) => entry.path !== pick.path), pick]);
                  }}
                />
              </ComposerAttachments>
              <span className={`session-composer__access${thread.permission === "full" ? "" : " is-sandboxed"}`} title={t(permissionHintKey[thread.permission])}>
                {thread.permission === "full" ? <AlertIcon size={14} /> : <ShieldIcon size={14} />}
                {t(permissionLabelKey[thread.permission])}
              </span>
              <ComposerPopover model label={composerModelLabel} disabled={settingsLocked}
                open={modelPickerOpen} onOpenChange={setModelPickerOpen}>
                <AccountModelField options={modelOptions} value={pickerValue} disabled={settingsLocked}
                  allowCliProxyApi proxyModels={cliProxyModels} onReloadProxyModels={reloadCliProxyModels}
                  onChange={changeModel} />
              </ComposerPopover>
              {running && thread.definitionId === "codex" && (
                <button type="button" className="button button--secondary button--sm"
                  disabled={!canSend} title={t("chat.steer.hint")}
                  onClick={() => void steer()}>{t(steering ? "chat.steer.sending" : "chat.steer.send")}</button>
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
                sendLabel={t(running || pendingInputs.length > 0 ? "chat.queue.add" : "chat.send")}
                replyVersion={latestReply ? `${latestReply.id}:${latestReply.text}` : ""} replyText={latestReply?.text ?? ""}
                onText={text => setDraft(current => current.trim() ? `${current.trimEnd()} ${text}` : text)}
                onSubmit={submit} onNotice={setNotice} />
            </div>
          </div>
        </ConversationComposerFrame>
      </form>}
    </>
  );
}

function ChatItemView({
  item,
  assistant,
  streaming,
  tag,
  onAnswer,
  onBranch,
  workingDirectory = "",
  threadId,
  subtask,
}: {
  item: ChatItem;
  assistant: string;
  streaming: boolean;
  tag: string;
  onAnswer: (requestId: string, allow: boolean, message?: string) => Promise<void>;
  /** Starts a new conversation that ends at this message. */
  onBranch?: () => void;
  /** Where images a reply mentions may be previewed from. */
  workingDirectory?: string;
  /** Lets pasted pictures and tool screenshots be shown from the chat's folder. */
  threadId?: string;
  /** Resolves a delegated subtask for its "finished" note. */
  subtask?: (childId: string) => { title: string; result: string; open: () => void; bringBack: () => void } | null;
}) {
  const { t } = useI18n();
  const branchButton = onBranch && (
    <button
      type="button"
      className="chat-msg__branch"
      onClick={onBranch}
      aria-label={t("chat.branch")}
      title={t("chat.branch")}
    >
      <DuplicateIcon size={13} />
    </button>
  );
  switch (item.type) {
    case "user":
      return (
        <ConversationMessage role="user" assistant={assistant} actions={branchButton}>
            {item.text && <div>{item.text}</div>}
            {item.attachments && item.attachments.length > 0 && (
              <div className="chat-attachments chat-attachments--sent">
                {item.attachments.map((attachment) => (
                  <span className="chat-attachment" key={attachment.path} title={displayPath(attachment.path)}>
                    {attachment.isImage ? <ImageFileIcon size={14} /> : <FileIcon size={14} />}
                    <span>{attachment.name}</span>
                  </span>
                ))}
              </div>
            )}
            {item.attachments?.some((attachment) => attachment.isImage) && (
              <ChatImageStrip
                paths={item.attachments.filter((attachment) => attachment.isImage).map((attachment) => attachment.preview ?? attachment.path)}
                workingDirectory={workingDirectory}
                threadId={threadId}
                captions={false}
              />
            )}
        </ConversationMessage>
      );
    case "text":
      return (
        <ConversationMessage role="assistant" assistant={assistant} actions={!streaming && branchButton}>
            <div className={streaming ? "chat-cursor" : undefined}>
              <ChatMarkdown source={item.text} />
            </div>
            {!streaming && workingDirectory && (
              <ChatImagePreviews text={item.text} workingDirectory={workingDirectory} />
            )}
        </ConversationMessage>
      );
    case "reasoning":
      return (
        <details className="chat-card chat-card--reasoning">
          <summary>
            <span className="chat-card__label">{t("chat.reasoning")}</span>
          </summary>
          <p className="chat-card__text">{item.text}</p>
        </details>
      );
    case "tool":
      return (
        <>
          <details
            className={`chat-card chat-card--tool${item.isError ? " is-error" : ""}${!item.done ? " is-running" : ""}`}
            open={item.isError || undefined}
          >
            <summary>
              <span className="chat-card__label">{item.name}</span>
              <code className="chat-card__summary" title={item.summary}>
                {item.summary}
              </code>
              {(() => {
                const counted = item.done && !item.isError ? toolOutputCount(item.name, item.output) : null;
                return counted ? (
                  <span className="chat-chip">
                    {t(counted.kind === "lines" ? "chat.tool.lines" : "chat.tool.results", { count: counted.count })}
                  </span>
                ) : null;
              })()}
              {item.meta?.exitCode !== undefined && (
                <span className={`chat-chip chat-chip--${item.meta.exitCode === 0 ? "ok" : "danger"}`}>
                  {t("chat.tool.exitCode", { code: item.meta.exitCode })}
                </span>
              )}
              {item.meta?.durationMs !== undefined && (
                <span className="chat-chip">
                  {t("chat.turn.duration", {
                    seconds: new Intl.NumberFormat(tag, { maximumFractionDigits: 1 }).format(item.meta.durationMs / 1000),
                  })}
                </span>
              )}
              <span className="chat-card__state">
                {!item.done ? t("chat.tool.running") : item.isError ? t("chat.tool.failed") : ""}
              </span>
            </summary>
            {item.output && looksLikeDiff(item.output) ? (
              <pre className="chat-card__output chat-card__output--diff">
                {item.output.split("\n").map((line, index) => (
                  <span key={index} className={`chat-diff__line is-${diffLineKind(line)}`}>
                    {line}
                    {"\n"}
                  </span>
                ))}
              </pre>
            ) : (
              item.output && <pre className="chat-card__output">{item.output}</pre>
            )}
          </details>
          {item.images && item.images.length > 0 && (
            <ChatImageStrip paths={item.images} workingDirectory={workingDirectory} threadId={threadId} captions={false} />
          )}
          {item.done && !item.isError && (
            <ChatWebSources sources={webSources(item.name, item.output)} />
          )}
        </>
      );
    case "approval": {
      const elicitation =
        item.name === "mcp_form" || item.name === "mcp_url" ? parseElicitation(item.input) : null;
      return (
        <div
          className={`chat-card chat-card--approval chat-approval--${item.decision}`}
          role="group"
          aria-label={t("chat.approval.title")}
        >
          <div className="chat-card__head">
            <span className="chat-card__label">{item.name}</span>
            <code className="chat-card__summary" title={item.summary}>
              {item.summary}
            </code>
            <span className="chat-card__state">
              {item.decision === "pending"
                ? t("chat.approval.title")
                : t(`chat.approval.${item.decision}` as MessageKey)}
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
              {item.name !== "unsupported_input" &&
                item.name !== "mcp_form" &&
                item.name !== "mcp_url" && (
                <button
                  type="button"
                  className="button button--primary button--sm"
                  onClick={() => onAnswer(item.requestId, true)}
                >
                  {t("chat.approval.allow")}
                </button>
              )}
              <button
                type="button"
                className="button button--secondary button--sm"
                onClick={() => onAnswer(item.requestId, false)}
              >
                {t("chat.approval.deny")}
              </button>
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
