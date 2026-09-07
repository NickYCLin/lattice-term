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
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  defaultPermission,
  formatTokens,
  permissionsFor,
  threadIsFresh,
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
import {
  profileCapable,
  profilesFor,
  type ChatAccountProfile,
} from "../app/chatAccountProfiles";
import { useAccountProfileStatus } from "../app/useAccountProfileStatus";
import { accountModelKey, accountModelOptions, accountModelTargets, hasChatModels } from "../app/accountModels";
import { useAccountModels } from "../app/useAccountModels";
import { useChatAccountProfiles } from "../app/useChatAccountProfiles";
import { useI18n } from "../i18n/context";
import { ChatQueueError } from "../app/chatInputQueue";
import type { MessageKey } from "../i18n/messages/zh-TW";
import { Callout, EmptyState } from "../components/common/Callout";
import { ConfirmDialog } from "../components/overlays/ConfirmDialog";
import { ChatMarkdown } from "../components/chat/ChatMarkdown";
import { AccountModelField } from "../components/agents/AccountModelField";
import { ChatThreadTree } from "../components/chat/ChatThreadTree";
import { ChatQuestions } from "../components/chat/ChatQuestions";
import {
  ChatIcon,
  CloseIcon,
  FileIcon,
  ClockIcon,
  FolderIcon,
  ImageFileIcon,
  PlusIcon,
  SendIcon,
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

function attachmentName(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || path;
}

function isImageAttachment(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(path);
}

function attachmentsFromPaths(paths: readonly string[]): ChatAttachment[] {
  const seen = new Set<string>();
  return paths.flatMap((path) => {
    if (!path || seen.has(path)) return [];
    seen.add(path);
    return [{ path, name: attachmentName(path), isImage: isImageAttachment(path) }];
  });
}

export function ChatView({
  agents,
  chat,
  automations,
}: {
  agents: AgentApi;
  chat: AgentChatApi;
  automations: AgentAutomationsApi;
}) {
  const { t, tag } = useI18n();
  const [pendingDelete, setPendingDelete] = useState<ChatThread | null>(null);
  const [mode, setMode] = useState<"threads" | "automations">("threads");
  const [selectedAutomationId, setSelectedAutomationId] = useState<string | null>(null);
  const [composingAutomation, setComposingAutomation] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const accountProfiles = useChatAccountProfiles();

  const cliLabel = (id: ChatDefinitionId) =>
    agents.catalog.find((definition) => definition.id === id)?.label ?? id;
  const installed = chat.supported.filter(
    (id) => agents.catalog.find((definition) => definition.id === id)?.installed,
  );
  const active = chat.threads.find((thread) => thread.id === chat.activeThreadId) ?? null;

  function startThread() {
    // Keep the assistant choice; selecting a project is optional for each chat.
    const previous = chat.threads[0];
    const definitionId =
      previous && installed.includes(previous.definitionId)
        ? previous.definitionId
        : (installed[0] ?? chat.supported[0] ?? "claude");
    chat.createThread({
      definitionId,
      workingDirectory: "",
      permission:
        previous && permissionsFor(definitionId).includes(previous.permission)
          ? previous.permission
          : defaultPermission(definitionId),
      model: previous?.definitionId === definitionId ? previous.model : "",
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
    chat.setActiveThreadId(threadId);
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
          <div className="chat-mode" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "threads"}
              className={`chat-mode__tab${mode === "threads" ? " is-active" : ""}`}
              onClick={() => setMode("threads")}
            >
              <ChatIcon />
              {t("chat.title")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "automations"}
              className={`chat-mode__tab${mode === "automations" ? " is-active" : ""}`}
              onClick={() => setMode("automations")}
            >
              <ClockIcon />
              {t("automation.title")}
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
              onClick={mode === "threads" ? startThread : startAutomation}
              disabled={agents.mode !== "ready"}
              aria-label={mode === "threads" ? t("chat.new") : t("automation.new")}
              title={mode === "threads" ? t("chat.new") : t("automation.new")}
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
            <ChatThreadTree
              layout={chat.layout}
              threads={chat.threads}
              activeThreadId={chat.activeThreadId}
              onSelectThread={(id) => chat.setActiveThreadId(id)}
              onToggleFolder={chat.toggleFolder}
              onRenameFolder={chat.renameFolder}
              onRemoveFolder={chat.removeFolder}
              onCreateFolder={chat.createFolder}
              onMoveNode={chat.moveNode}
              renderThread={(thread, active) => (
                <div
                  className={`chat-thread${active ? " is-active" : ""}${thread.unread ? " is-unread" : ""}`}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      chat.setActiveThreadId(thread.id);
                    }
                  }}
                >
                  <span>
                    <span className="chat-thread__title">
                      {thread.title || t("chat.untitled")}
                    </span>
                    <span className="chat-thread__meta">
                      {thread.automationId ? `${t("automation.badge")} · ` : ""}
                      {cliLabel(thread.definitionId)}
                      {thread.workingDirectory
                        ? ` · ${directoryName(thread.workingDirectory)}`
                        : ""}
                    </span>
                  </span>
                  {thread.runningTurnId ? (
                    <span className="chat-thread__dot" aria-label={t("chat.running")} />
                  ) : thread.unread ? (
                    <span className="chat-thread__dot chat-thread__dot--unread" aria-label={t("automation.unread.one")} />
                  ) : null}
                </div>
              )}
            />
            {chat.layout.folders.length > 0 && (
              <p className="chat-threads__hint">{t("chat.folder.dragHint")}</p>
            )}
          </div>
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
        ) : installed.length === 0 && agents.mode === "ready" ? (
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
                onClick={startThread}
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
            onDelete={() => setPendingDelete(active)}
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
          tone="danger"
          onConfirm={() => {
            chat.removeThread(pendingDelete.id);
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
  onDelete,
}: {
  thread: ChatThread;
  chat: AgentChatApi;
  installed: readonly ChatDefinitionId[];
  definitions: readonly AgentDefinition[];
  cliLabel: (id: ChatDefinitionId) => string;
  tag: string;
  accountProfiles: readonly ChatAccountProfile[];
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [steering, setSteering] = useState(false);
  const steeringRef = useRef(false);
  const fresh = threadIsFresh(thread);
  const [settingsOpen, setSettingsOpen] = useState(fresh);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedToBottom = useRef(true);
  const running = thread.runningTurnId !== null;
  const pendingInputs = thread.pendingInputs ?? [];
  const settingsLocked = running || pendingInputs.length > 0;
  const cliInstalled = installed.includes(thread.definitionId);
  const availableProfiles = profilesFor(accountProfiles, thread.definitionId);
  const activeProfile = availableProfiles.find((profile) => profile.id === thread.accountProfileId) ?? null;
  const { statuses: profileStatuses } = useAccountProfileStatus(accountProfiles);
  const modelTargets = accountModelTargets(definitions, accountProfiles, profileStatuses, t("accountModel.defaultAccount"));
  const accountModels = useAccountModels(modelTargets, settingsOpen);
  const modelOptions = accountModelOptions(modelTargets, accountModels, {
    defaultModel: t("chat.model.default"), loading: t("chat.model.loading"), signedOut: t("agents.account.signedOut"),
  }, thread);
  const selectedOption = modelOptions.find((option) => accountModelKey(option) === accountModelKey(thread));
  const activeProfileMissing = thread.accountProfileId !== null && activeProfile === null;
  const activeProfileSignedOut = selectedOption?.disabled === true;
  const canSend =
    !steering &&
    !activeProfileMissing &&
    !activeProfileSignedOut &&
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
    setAttachments([]);
  }, [thread.id]);

  function addAttachments(paths: readonly string[]) {
    if (steeringRef.current) return;
    const added = attachmentsFromPaths(paths);
    if (added.length === 0) return;
    setAttachments((current) => {
      const existing = new Set(current.map((attachment) => attachment.path));
      return [...current, ...added.filter((attachment) => !existing.has(attachment.path))];
    });
  }

  async function chooseAttachments(kind: "image" | "file") {
    setNotice(null);
    try {
      const selected = await open({
        multiple: true,
        title: t(kind === "image" ? "chat.attachment.images" : "chat.attachment.files"),
        ...(kind === "image"
          ? { filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }] }
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

  // Tauri owns OS file drag-and-drop, so normal React drop events do not see
  // desktop paths. Bind only while this conversation pane is mounted.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const stop = await getCurrentWebviewWindow().onDragDropEvent((event) => {
          if (event.payload.type === "enter" || event.payload.type === "over") {
            setDraggingFiles(true);
          } else if (event.payload.type === "leave") {
            setDraggingFiles(false);
          } else if (event.payload.type === "drop") {
            setDraggingFiles(false);
            addAttachments(event.payload.paths);
          }
        });
        if (cancelled) stop();
        else unlisten = stop;
      } catch {
        // Browser previews have no native paths and cannot send a chat turn.
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
      setDraggingFiles(false);
    };
  }, [thread.id, running]);

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
    if (!canSend || steeringRef.current) return;
    const prompt = draft;
    if (running || pendingInputs.length > 0) {
      try {
        chat.enqueue(thread.id, prompt, attachments, activeProfile?.configDirectory ?? null);
      } catch (reason) {
        setNotice(reason instanceof ChatQueueError ? t(`chat.queue.${reason.code}`) : reason instanceof Error ? reason.message : String(reason));
        return;
      }
    } else {
      void chat.send(thread.id, prompt, attachments, activeProfile?.configDirectory ?? null);
    }
    setDraft("");
    setAttachments([]);
    pinnedToBottom.current = true;
    setSettingsOpen(false);
    setNotice(null);
  }

  async function steer() {
    if (!canSend || steeringRef.current || !running || thread.definitionId !== "codex") return;
    steeringRef.current = true;
    setSteering(true);
    setNotice(null);
    try {
      await chat.steer(thread.id, draft, attachments);
      setDraft("");
      setAttachments([]);
      pinnedToBottom.current = true;
    } catch (reason) {
      setNotice(t("chat.steer.failed", { detail: reason instanceof Error ? reason.message : String(reason) }));
    } finally {
      steeringRef.current = false;
      setSteering(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
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

  const modelLabel = selectedOption?.label ?? (activeProfileMissing ? t("accountModel.missing") : thread.model || t("chat.model.default"));

  return (
    <>
      <header className="chat-header">
        <div className="chat-header__title">
          <div className="chat-header__identity">
            <span className="chat-avatar" aria-hidden="true">
              {assistant.slice(0, 1)}
            </span>
            <div>
              <h2>{thread.title || t("chat.untitled")}</h2>
              <div className="chat-chips">
                <button
                  type="button"
                  className="chat-chip"
                  onClick={() => setSettingsOpen((current) => !current)}
                  aria-expanded={settingsOpen}
                  aria-controls={`chat-settings-${thread.id}`}
                >
                  <SettingsIcon />
                  {modelLabel}
                </button>
                <span className="chat-chip" title={thread.workingDirectory}>
                  <FolderIcon />
                  {thread.workingDirectory
                    ? directoryName(thread.workingDirectory)
                    : t("chat.directory.none")}
                </span>
                <span className="chat-chip">{t(permissionLabelKey[thread.permission])}</span>
              </div>
            </div>
          </div>
          <div className="chat-composer__actions">
            <button
              type="button"
              className="button button--ghost button--sm"
              onClick={() => setSettingsOpen((current) => !current)}
              aria-expanded={settingsOpen}
            >
              {settingsOpen ? t("chat.settings.hide") : t("chat.settings")}
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
        {settingsOpen && (
          <div className="chat-settings" id={`chat-settings-${thread.id}`}>
            <AccountModelField
              options={modelOptions}
              value={thread}
              disabled={settingsLocked}
              onChange={({ definitionId, accountProfileId, model }) => {
                if (hasChatModels(definitionId)) chat.updateThread(thread.id, { definitionId, accountProfileId, model });
              }}
            />
            {(activeProfileSignedOut || activeProfileMissing) && (
              <p className="field__hint chat-settings__warning" role="status">
                {t(activeProfileMissing ? "accountModel.missing" : "chat.accountProfile.notSignedIn")}
              </p>
            )}
            <div className="field field--grow">
              <span className="field__label">{t("chat.directory")}</span>
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
                <span className="chat-directory__path" title={thread.workingDirectory}>
                  {thread.workingDirectory
                    ? displayPath(thread.workingDirectory)
                    : t("chat.directory.none")}
                </span>
              </div>
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
            {thread.definitionId === "codex" && (
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
          </div>
        )}
        {thread.permission === "full" && (
          <Callout tone="warn">{t("chat.permission.full.hint")}</Callout>
        )}
        {thread.handoff && (
          <Callout tone="info">
            {t("chat.handoff.pending", { assistant })}
          </Callout>
        )}
        {!cliInstalled && (
          <Callout tone="warn">
            {t("chat.notInstalled", { cli: cliLabel(thread.definitionId) })}
          </Callout>
        )}
        {notice && <Callout tone="danger">{notice}</Callout>}
      </header>

      <div className="chat-messages" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-messages__inner">
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
              assistant={cliLabel(item.type !== "user" && item.type !== "notice" && item.type !== "turnEnd"
                ? item.assistantDefinitionId ?? thread.definitionId
                : thread.definitionId)}
              streaming={running && index === thread.items.length - 1}
              tag={tag}
              onAnswer={answer}
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

      <form className="chat-composer" onSubmit={submit}>
        <div className={`chat-composer__box${running ? " is-busy" : ""}${draggingFiles ? " is-file-dragging" : ""}`}>
          {attachments.length > 0 && (
            <div className="chat-attachments" aria-label={t("chat.attachment.selected")}>
              {attachments.map((attachment) => (
                <span className="chat-attachment" key={attachment.path} title={attachment.path}>
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
                  disabled={steering}
                  onClick={() => {
                    setDraft(current => current ? `${current}\n\n${input.prompt}` : input.prompt);
                    addAttachments(input.attachments.map(file => file.path));
                    chat.removeQueued(thread.id, input.id);
                  }}>{t("chat.queue.edit")}</button>
                <button type="button" className="icon-button icon-button--sm"
                  aria-label={t("chat.queue.remove")} title={t("chat.queue.remove")}
                  onClick={() => chat.removeQueued(thread.id, input.id)}><CloseIcon size={12} /></button>
              </li>)}</ol>
            </section>
          )}
          <textarea
            className="chat-composer__input"
            value={draft}
            readOnly={steering}
            placeholder={t("chat.composer.placeholder", { assistant })}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            aria-label={t("chat.composer.label")}
            rows={2}
          />
          <div className="chat-composer__row">
            <span className="chat-composer__hint">
              {running ? t("chat.queue.shortcut") : thread.nativeSessionId
                ? t("chat.composer.shortcut")
                : t("chat.storage.note")}
            </span>
            <div className="chat-composer__actions">
              <button
                type="button"
                className="button button--ghost button--sm"
                onClick={() => void chooseAttachments("image")}
                disabled={steering}
                title={t("chat.attachment.images")}
              >
                <ImageFileIcon />
                {t("chat.attachment.images")}
              </button>
              <button
                type="button"
                className="button button--ghost button--sm"
                onClick={() => void chooseAttachments("file")}
                disabled={steering}
                title={t("chat.attachment.files")}
              >
                <FileIcon />
                {t("chat.attachment.files")}
              </button>
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
              <button
                type="submit"
                className="chat-send"
                disabled={!canSend}
                aria-label={t(running || pendingInputs.length > 0 ? "chat.queue.add" : "chat.send")}
                title={t(running || pendingInputs.length > 0 ? "chat.queue.add" : "chat.send")}
              >
                <SendIcon />
              </button>
            </div>
          </div>
        </div>
      </form>
    </>
  );
}

function ChatItemView({
  item,
  assistant,
  streaming,
  tag,
  onAnswer,
}: {
  item: ChatItem;
  assistant: string;
  streaming: boolean;
  tag: string;
  onAnswer: (requestId: string, allow: boolean, message?: string) => Promise<void>;
}) {
  const { t } = useI18n();
  switch (item.type) {
    case "user":
      return (
        <div className="chat-msg chat-msg--user">
          <div className="chat-bubble">
            {item.text && <div>{item.text}</div>}
            {item.attachments && item.attachments.length > 0 && (
              <div className="chat-attachments chat-attachments--sent">
                {item.attachments.map((attachment) => (
                  <span className="chat-attachment" key={attachment.path} title={attachment.path}>
                    {attachment.isImage ? <ImageFileIcon size={14} /> : <FileIcon size={14} />}
                    <span>{attachment.name}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      );
    case "text":
      return (
        <div className="chat-msg chat-msg--assistant">
          <span className="chat-avatar" aria-hidden="true">
            {assistant.slice(0, 1)}
          </span>
          <div className="chat-msg__body">
            <span className="chat-msg__name">{assistant}</span>
            <div className={streaming ? "chat-cursor" : undefined}>
              <ChatMarkdown source={item.text} />
            </div>
          </div>
        </div>
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
        <details
          className={`chat-card chat-card--tool${item.isError ? " is-error" : ""}${!item.done ? " is-running" : ""}`}
          open={item.isError || undefined}
        >
          <summary>
            <span className="chat-card__label">{item.name}</span>
            <code className="chat-card__summary" title={item.summary}>
              {item.summary}
            </code>
            <span className="chat-card__state">
              {!item.done ? t("chat.tool.running") : item.isError ? t("chat.tool.failed") : ""}
            </span>
          </summary>
          {item.output && <pre className="chat-card__output">{item.output}</pre>}
        </details>
      );
    case "approval":
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
          {item.name === "unsupported_input" && item.decision === "pending" && (
            <p className="chat-notice">{t("chat.question.unsupported")}</p>
          )}
          {item.name !== "user_input" && item.input && item.input !== "null" && (
            <details className="chat-card__details">
              <summary>{t("chat.approval.input")}</summary>
              <pre className="chat-card__output">{item.input}</pre>
            </details>
          )}
          {item.decision === "pending" && item.name !== "user_input" && (
            <div className="chat-card__actions">
              {item.name !== "unsupported_input" && (
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
    case "notice":
      return <p className="chat-notice">{item.text}</p>;
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
