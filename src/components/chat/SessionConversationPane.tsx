import { NativeRecordView, NativeHistoryAccess } from "./NativeRecordView";
import { presentAgentSessionGroup } from "../../app/agentSessionPresentation";
import { ApprovalActions } from "./ApprovalActions";
import { invoke } from "@tauri-apps/api/core";
import type { SessionConversationMessage } from "../../app/useSessionConversation";
import { SessionMessage } from "./SessionMessage";
import { useSessionConversationActions } from "./SessionConversationActions";
import { SessionToolCard } from "./SessionToolCard";
import { sessionToolRows, toolHasProtectedContent } from "../../app/toolPresentation";
import { ReadableToolCard } from "./ReadableToolCard";
import { ConversationTimeline } from "./ConversationTimeline";
import { PlanProgress, GoalProgress } from "./PlanProgress";
import { ChatArtifact } from "./ChatArtifact";
import { approvalShortcut } from "../../app/approvalShortcut";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from "react";
import type { ChatAttachment } from "../../app/agentChat";
import {
  CHAT_ATTACHMENT_LIMIT, mergeAttachmentPaths,
  sessionPromptWithAttachments, splitSessionAttachments,
} from "../../app/chatAttachments";
import { useFileDrop } from "../../app/fileDrop";
import { spokenSessionReply } from "../../app/sessionVoice";
import { ConversationComposerFrame, ComposerAttachments } from "./ConversationComposer";
import { ComposerVoiceControls } from "./ComposerVoiceControls";
import { ConversationIdentity, ConversationMessage } from "./ConversationPresentation";
import { Callout } from "../common/Callout";
import { useSessionConversation } from "../../app/useSessionConversation";
import { useSessionPromptQueue } from "../../app/useSessionPromptQueue";
import { SessionPromptQueue } from "./SessionPromptQueue";
import { sessionSubmissionsNotQueued } from "../../app/sessionSubmittedPrompts";
import { useConversationDraft } from "../../app/useConversationDraft";
import { SESSION_PROMPT_NOT_READY, sessionNeedsReadyConfirmation } from "../../app/sessionConversationReadiness";
import { usePromptReadiness } from "../../app/usePromptReadiness";
import { SessionPromptReadinessNotice } from "./SessionPromptReadinessNotice";
import type { AgentApi, AgentLifecycle, AgentSessionSummary } from "../../app/useAgentSessions";
import { useI18n } from "../../i18n/context";
import type { MessageKey } from "../../i18n/messages/zh-TW";
import {
  AlertIcon, CheckIcon, CloseIcon, FileIcon, ImageFileIcon, RefreshIcon, ShieldIcon, TerminalIcon,
} from "../icons";
import { readStoredPreferences } from "../../app/preferences";
import { shouldSubmitChatInput } from "../../app/chatInputPreferences";
import { ChatStatus } from "./ChatStatus";
import { useComposerAssistance } from "./ComposerAssistance";
import { shouldRecallPrompt } from "../../app/composerAssistance";
import { displayPath } from "../../app/displayPath";
import { imageFileName } from "../../app/chatImages";
import { switchesModelInPlace } from "../../app/sessionModelSwitch";
import { SessionModelPicker } from "./SessionModelPicker";
import { useChatClipboardFallback } from "../../app/chatClipboard";
import { SentAttachments } from "./SentAttachments";
import { keepChatAttachmentPreviews } from "../../app/chatAttachmentPreviews";
import { ConversationReadProgress } from "./ConversationReadProgress";
import { useChatScroll } from "../../app/useChatScroll";

const stateLabel: Record<AgentLifecycle, MessageKey> = {
  working: "agents.state.working",
  needsAttention: "agents.state.needsAttention",
  idle: "agents.state.idle",
  done: "agents.state.done",
};

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function AttachmentChip({ attachment, onRemove, removeLabel }: {
  attachment: ChatAttachment;
  onRemove?: () => void;
  removeLabel?: string;
}) {
  return <span className="chat-attachment" title={attachment.isImage ? undefined : displayPath(attachment.path)}>
    {attachment.isImage ? <ImageFileIcon size={14} /> : <FileIcon size={14} />}
    <span>{attachment.isImage ? imageFileName(attachment.name) : attachment.name}</span>
    {onRemove && <button type="button" className="chat-attachment__remove" onClick={onRemove}
      aria-label={removeLabel} title={removeLabel}><CloseIcon size={12} /></button>}
  </span>;
}

export function SessionConversationPane({ session, agents, displayName, conversationTitle, accountLabel, onOpenTerminal, onSessionReplaced, onSideChat, onFork }: {
  session: AgentSessionSummary;
  agents: AgentApi;
  displayName?: string;
  conversationTitle?: string;
  accountLabel?: string;
  onOpenTerminal: () => void;
  /** The session was resumed under a new id, e.g. on another model. */
  onSessionReplaced: (sessionId: string) => void;
  onSideChat?: () => void;
  onFork?: (messages: readonly SessionConversationMessage[], throughIndex?: number, editedText?: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const conversation = useSessionConversation(session.sessionId, agents, false);
  const queue = useSessionPromptQueue(session.sessionId, agents, !session.closedReason);
  const { draft, setDraft, attachments, setAttachments, pasting, setPasting,
    addAttachmentPaths, readDraft } = useConversationDraft("session", session.sessionId);
  const [notice, setNotice] = useState<string | null>(null);
  const [forkWorking, setForkWorking] = useState(false);
  const forkLock = useRef(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const [artifact, setArtifact] = useState<string | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [modelOpenRequest, setModelOpenRequest] = useState(0);
  const pastingRef = useRef(false);
  pastingRef.current = pasting;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const { ref: messagesRef, onScroll, onWheel } = useChatScroll();
  const nativePending = conversation.nativeCommandPending === true;
  const live = !session.closedReason;
  const working = live && session.state === "working";
  const attention = live && session.state === "needsAttention";
  const unconfirmed = sessionNeedsReadyConfirmation(session);
  const readiness = usePromptReadiness(session.sessionId, live && unconfirmed);
  const waitingForReady = conversation.sendError === SESSION_PROMPT_NOT_READY;
  const queuedCount = Math.max(session.queuedPrompts, conversation.queued ?? 0);
  const { acknowledge } = conversation;
  useEffect(() => {
    acknowledge();
  }, [session.state, session.stateSource, session.queuedPrompts, acknowledge]);
  const supported = ["codex", "claude", "gemini", "qwen", "copilot", "grok", "kimi", "opencode"].includes(session.definitionId);
  const controls = useSessionConversationActions({ session, agents, messages: conversation.messages,
    busy: working || attention || nativePending || forkWorking || Boolean(session.closedReason), nativeTools: conversation.nativeTools === true,
    onCompose: setDraft, onNotice: setNotice, onOpen: onSessionReplaced,
    onSearch: () => setSearchOpen(value => !value), onSideChat });
  const blocked = Boolean(session.closedReason) || conversation.sending || controls.working || forkWorking;
  async function fork(index?: number, edited?: string) {
    if (!onFork || forkLock.current || blocked || working || attention || queuedCount > 0 || nativePending) throw new Error(t("chat.nativeOperation.running"));
    forkLock.current = true; setForkWorking(true);
    try { await onFork(conversation.messages, index, edited); }
    finally { forkLock.current = false; setForkWorking(false); }
  }
  const toolRows = useMemo(() => sessionToolRows(conversation.messages), [conversation.messages]);
  const matches = search.trim() ? toolRows.flatMap(row => {
    const alias = row.aliases.find(index => conversation.messages[Number(index)]?.text.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
    return alias === undefined ? [] : [Number(alias)];
  }) : [];
  const match = matches[searchIndex % Math.max(1, matches.length)];
  useEffect(() => { if (searchOpen) searchRef.current?.focus(); }, [searchOpen]);
  useEffect(() => {
    if (searchOpen && match !== undefined) messagesRef.current?.querySelector<HTMLElement>(`[data-session-message="${match}"]`)?.scrollIntoView({ block: "center", behavior: "auto" });
    // Follow explicit searches; ordinary transcript polling must not move the reader.
  }, [search, searchIndex, searchOpen]);
  const hasContent = Boolean(draft.trim()) || attachments.length > 0;
  const canSend = hasContent && !blocked && !nativePending;
  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!canSend || pastingRef.current) return;
    const submitted = draft;
    const files = attachments;
    pastingRef.current = true;
    setPasting(true);
    try {
      const saved = await keepChatAttachmentPreviews(session.sessionId, files);
      const delivered = saved.map(file => file.isImage && file.preview ? { ...file, path: file.preview } : file);
      if (await conversation.send(sessionPromptWithAttachments(submitted, delivered))) {
        setDraft(current => current === submitted ? "" : current);
        setAttachments(current => current === files ? [] : current);
        void queue.refresh();
      }
    } catch (reason) {
      if (mounted.current) setNotice(t("chat.attachment.failed", { detail: errorText(reason) }));
    } finally {
      pastingRef.current = false;
      setPasting(false);
    }
  }

  function addAttachments(paths: readonly string[]): boolean {
    const next = addAttachmentPaths(paths);
    if (!next) {
      if (mounted.current) setNotice(t("chat.attachment.limit", { count: CHAT_ATTACHMENT_LIMIT }));
      return false;
    }
    if (mounted.current) setNotice(null);
    return true;
  }
  async function chooseAttachments(kind: "image" | "file") {
    setNotice(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
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
      if (mounted.current) setNotice(t("chat.attachment.failed", { detail: errorText(reason) }));
    }
  }
  async function pasteAttachments(silent = false) {
    if (pastingRef.current) return;
    if (readDraft().attachments.length >= CHAT_ATTACHMENT_LIMIT) {
      setNotice(t("chat.attachment.limit", { count: CHAT_ATTACHMENT_LIMIT }));
      return;
    }
    pastingRef.current = true;
    setPasting(true);
    setNotice(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const files = await invoke<string[]>("agent_chat_paste_files");
      if (files.length > 0) {
        addAttachments(files);
        return;
      }
      const path = await invoke<string | null>("agent_chat_paste_image", { threadId: session.sessionId });
      if (path) addAttachments([path]);
      else if (mounted.current && !silent) setNotice(t("chat.attachment.clipboardEmpty"));
    } catch (reason) {
      if (mounted.current && !silent) setNotice(t("chat.attachment.failed", { detail: errorText(reason) }));
    } finally {
      pastingRef.current = false;
      setPasting(false);
    }
  }
  const clipboard = useChatClipboardFallback(session.sessionId, () => { void pasteAttachments(true); });
  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) { clipboard.onPaste(event); }
  const { dragging } = useFileDrop({
    ref: boxRef,
    disabled: blocked,
    onPaths: paths => { addAttachments(paths); },
    onError: reason => setNotice(t("chat.attachment.failed", { detail: errorText(reason) })),
  });
  async function nativeCommand(command: "plan" | "review" | "compact") {
    if (blocked || working || attention || queuedCount > 0 || nativePending || !session.capturedSessionId) return;
    try {
      await invoke("agent_session_prepare_command", { sessionId: session.sessionId, expectedNativeId: session.capturedSessionId, command });
      onOpenTerminal();
    } catch (reason) { setNotice(String(reason)); }
  }
  const assistance = useComposerAssistance({ draft, onText: setDraft, inputRef,
    workingDirectory: session.workingDirectory, filesEnabled: ["codex", "claude", "gemini"].includes(session.definitionId), onFile: () => true,
    commands: { model: () => setModelOpenRequest(value => value + 1), status: () => setStatusOpen(true),
      ...(!blocked && !nativePending && !working && !attention && queuedCount === 0 && session.definitionId === "codex" && session.capturedSessionId && !session.detached
        ? { plan: () => { void nativeCommand("plan"); }, review: () => { void nativeCommand("review"); }, compact: () => { void nativeCommand("compact"); } } : {}),
      ...(onFork && !working && !attention && !blocked && !nativePending && queuedCount === 0 ? { fork: () => { void fork().catch(reason => setNotice(String(reason))); } } : {}) },
  });
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    clipboard.onKeyDown(event.nativeEvent);
    if (assistance.keyDown(event)) return;
    if (shouldRecallPrompt(event, draft, attachments.length)) {
      const previous = conversation.messages.slice().reverse().find(message => message.role === "user" && !message.tool);
      if (previous) {
        const recalled = splitSessionAttachments(previous.text);
        event.preventDefault(); setDraft(recalled.text); setAttachments(mergeAttachmentPaths([], recalled.paths) ?? []);
        assistance.select(recalled.text.length); return;
      }
    }
    if (!shouldSubmitChatInput(event)) return;
    event.preventDefault();
    void submit();
  }
  const accessHint = `${t(session.sandboxed ? "agents.sandbox.hint" : "sessionChat.access.fullHint")}\n${t("sessionChat.approval")}`;
  const assistant = agents.catalog.find(definition => definition.id === session.definitionId)?.label || session.label;
  const group = presentAgentSessionGroup(agents.sessions.filter(member => (member.groupId || member.sessionId) === (session.groupId || session.sessionId)).length
    ? agents.sessions.filter(member => (member.groupId || member.sessionId) === (session.groupId || session.sessionId)) : [session], agents.catalog, session.sessionId);
  const explicitTitle = displayName?.trim();
  const firstPrompt = conversation.messages.find(message => message.role === "user" && !message.tool);
  const title = explicitTitle || (group.hasCustomGroupLabel ? group.groupLabel : null)
    || (conversationTitle && conversationTitle !== session.label && conversationTitle !== assistant ? conversationTitle : null)
    || (firstPrompt ? splitSessionAttachments(firstPrompt.text).text.trim().split("\n")[0] : "") || session.label || assistant;
  return <>
    <header className="chat-header">
      <div className="chat-header__title">
        <ConversationIdentity assistant={assistant} title={title}>
          {title !== assistant && <span className="chat-chip">{assistant}</span>}
          {accountLabel && <span className="chat-chip">{accountLabel}</span>}
          {session.model && <span className="chat-chip">{session.model}</span>}
          {live && !working && !nativePending && !attention && <span className={`session-chat__state is-${session.state}`}>
            {t(session.writerReleased ? "handoff.released" : unconfirmed ? "sessionChat.unconfirmed" : stateLabel[session.state] ?? "agents.state.idle")}
          </span>}
        </ConversationIdentity>
        <div className="chat-composer__actions">
          {controls.actions}
          <button type="button" className="button button--ghost button--sm" onClick={onOpenTerminal}
            aria-label={t("chat.terminal")} title={t("chat.terminal")}>
            <TerminalIcon />
          </button>
        </div>
      </div>
    </header>
    {searchOpen && <form className="chat-search" onSubmit={event => { event.preventDefault(); setSearchIndex(index => index + 1); }}>
      <input ref={searchRef} className="input" value={search} onChange={event => { setSearch(event.target.value); setSearchIndex(0); }} aria-label={t("chat.nav.search")} onKeyDown={event => { if (event.key === "Escape") { setSearchOpen(false); setSearch(""); } }} />
      <span role="status">{matches.length ? searchIndex % matches.length + 1 : 0} / {matches.length}</span>
      <button type="button" className="button button--ghost button--sm" disabled={!matches.length} onClick={() => setSearchIndex(index => (index + matches.length - 1) % matches.length)}>↑</button>
      <button className="button button--ghost button--sm" disabled={!matches.length}>↓</button>
      <button type="button" className="button button--ghost button--sm" onClick={() => { setSearchOpen(false); setSearch(""); }}>{t("common.cancel")}</button>
    </form>}
    {controls.panels}
    {statusOpen && <ChatStatus model={session.model || ""} directory={session.workingDirectory}
      context={conversation.progress?.contextUsage} rateLimits={conversation.progress?.rateLimits}
      state={t(stateLabel[session.state] ?? "agents.state.idle")} onClose={() => setStatusOpen(false)} />}
    {conversation.progress?.plan && <PlanProgress steps={conversation.progress.plan} compact />}
    {conversation.progress?.goal && <GoalProgress goal={conversation.progress.goal} compact />}
    {artifact && <ChatArtifact path={artifact} directory={session.workingDirectory} threadId={session.sessionId} onClose={() => setArtifact(null)} />}
    <div ref={messagesRef} className="chat-messages" onScroll={onScroll} onWheel={onWheel}>
      <div className="chat-messages__inner">
        {supported && <ConversationReadProgress loading={conversation.loading} error={conversation.readError} diagnostics={conversation.diagnostics} onRetry={conversation.refresh} />}
        {!supported ? <p>{t("sessionChat.unsupported")}</p>
          : !conversation.readError && conversation.messages.length === 0 ? <p role="status">{t(
            session.closedReason ? "sessionChat.closed"
              : conversation.slow ? "sessionChat.slow"
              : conversation.loading ? "common.loading"
              : conversation.availability === "waitingForIdentity" ? "sessionChat.waitingIdentity"
              : conversation.availability === "waitingForTranscript" ? "sessionChat.waitingTranscript"
              : "sessionChat.waiting",
          )}</p> : null}
        {conversation.truncated && <p role="status">{t("sessionChat.truncated")}</p>}
        {supported && session.definitionId === "codex" && !conversation.loading && !conversation.readError
          && conversation.availability === "waitingForIdentity" && <p>{t("sessionChat.codexIdentityHint")}</p>}
        {session.closedReason && <p className="session-chat__diagnostic" role="status">{session.closedReason}</p>}
        {session.capturedSessionId && <NativeHistoryAccess threadId={session.sessionId} directory={session.workingDirectory} />}
        <ConversationTimeline collapseDefault={readStoredPreferences().chatCollapseCompletedTurns}
          latestFinished={!working && !attention && !nativePending && !conversation.approval && session.state === "done" && session.stateSource === "integration"} match={match === undefined ? undefined : String(match)}
          rows={toolRows.map(row => {
          const message = row.value, index = conversation.messages.indexOf(message);
          const hit = match !== undefined && row.aliases.includes(String(match));
          const node = message.record && !["user","assistant","tool"].includes(message.record.kind)
            ? <div data-session-message={hit ? match : index} className={hit ? "chat-search__match" : undefined}><NativeRecordView item={message.record} threadId={session.sessionId} directory={session.workingDirectory} forceOpen={hit} /></div> : message.tool
            ? <div data-session-message={hit ? match : index} className={hit ? "chat-search__match" : undefined}>
              {row.tool ? <ReadableToolCard tool={row.tool} forceOpen={hit} directory={session.workingDirectory} threadId={session.sessionId} />
                : <SessionToolCard message={message} forceOpen={hit} onOpenFile={setArtifact} />}</div>
            : (() => {
          const canFork = onFork && !working && !attention && !blocked && !nativePending && queuedCount === 0;
          const hasBoundary = session.definitionId === "codex" ? Boolean(message.nativeTurnId) : Boolean(message.nativeMessageId);
          const canEdit = canFork && message.role === "user" && (session.definitionId === "codex" ? hasBoundary
            : !conversation.messages.slice(0, index).some(row => !row.tool && row.role === "user") || conversation.messages.slice(0, index).some(row => !row.tool && row.role === "assistant" && row.nativeMessageId));
          return <div key={message.renderId ?? index} data-session-message={index} className={index === match ? "chat-search__match" : undefined}><SessionMessage
            message={message} assistant={assistant} directory={session.workingDirectory} sessionId={session.sessionId} onOpenFile={setArtifact}
            onEdit={canEdit ? text => fork(index, text) : undefined}
            onBranch={canFork && hasBoundary && message.role === "assistant" ? () => { void fork(index).catch(reason => setNotice(String(reason))); } : undefined} />
          </div>;
          })();
          return { id: row.id, aliases: row.aliases, user: !message.tool && message.role === "user",
            process: row.tool ? !toolHasProtectedContent(row.tool) : Boolean(row.commentary || message.tool?.kind === "reasoning"),
            exploration: row.tool && !toolHasProtectedContent(row.tool) ? row.tool.exploration : undefined,
            steps: row.tool?.commands.length || 1, node };
        })} />
        {sessionSubmissionsNotQueued(conversation.submitted ?? [], queue.prompts).map(prompt => {
          const sent = splitSessionAttachments(prompt.text);
          const files = mergeAttachmentPaths([], sent.paths) ?? [];
          return <ConversationMessage key={`submitted-${prompt.id}`} role="user" assistant={assistant}>
            <div>{sent.text}</div>
            <SentAttachments attachments={files} workingDirectory={session.workingDirectory} threadId={session.sessionId} />
            <small className="session-chat__receipt">{t("sessionChat.awaitingTranscript")}</small>
          </ConversationMessage>;
        })}
        <SessionPromptQueue sessionId={session.sessionId} queue={queue} />
        {(working || nativePending) && (
          <p className="session-chat__activity" role="status">
            <span className="session-chat__spinner" aria-hidden="true">
              <RefreshIcon size={16} pulse={nativePending ? "pending" : "working"} pulseOnMount />
            </span>
            {nativePending ? t("sessionChat.nativePending") : session.queuedPrompts > 0
              ? t("sessionChat.workingQueued", { count: session.queuedPrompts })
              : t("sessionChat.working")}
          </p>
        )}
        {conversation.approval ? (
          <div className="chat-card chat-card--approval chat-approval--pending" role="group" tabIndex={0}
            aria-label={t("chat.approval.title")} title={conversation.approval.canAllowSession ? undefined : t("sessionChat.permission.sessionUnsupported")} onKeyDown={event => {
              if (conversation.answering) return;
              const decision = approvalShortcut(event, event.target === event.currentTarget, conversation.approval?.canAllowSession);
              if (decision) { event.preventDefault(); event.stopPropagation(); void conversation.answer(decision !== "deny", decision === "session"); }
            }}>
            <div className="chat-card__head">
              <span className="chat-card__label">{conversation.approval.toolName}</span>
              <code className="chat-card__summary" title={conversation.approval.summary}>
                {conversation.approval.summary}
              </code>
              <span className="chat-card__state">{t("chat.approval.title")}</span>
            </div>
            <p className="chat-notice">{t("sessionChat.permission.hint")}</p>
            <div className="chat-card__actions">
              <ApprovalActions canAllowSession={conversation.approval.canAllowSession} disabled={conversation.answering}
                unsupportedReason={t("sessionChat.permission.sessionUnsupported")}
                onAnswer={(allow, forSession) => void conversation.answer(allow, forSession)} />
            </div>
          </div>
        ) : attention && (
          <div className="session-chat__activity is-attention" role="status">
            <AlertIcon size={14} pulse={1} pulseOnMount />
            <span>{t("sessionChat.attention")}</span>
          </div>
        )}
      </div>
    </div>
    <form className="chat-composer session-composer" onSubmit={submit}>
      <div className="session-composer__notices">
        {conversation.sendError && conversation.sendError !== SESSION_PROMPT_NOT_READY && <p role="alert"><AlertIcon size={12} pulse={conversation.sendError} pulseOnMount />{conversation.sendError}</p>}
        {conversation.answerError && <p role="alert">{conversation.answerError === "answered-elsewhere"
          ? t("sessionChat.permission.gone")
          : t("sessionChat.permission.failed", { detail: conversation.answerError })}</p>}
        {waitingForReady && <Callout tone="warn">{t("sessionChat.notReady")}</Callout>}
        {unconfirmed && <SessionPromptReadinessNotice readiness={readiness.value} pending={readiness.pending} error={readiness.error} onReconcile={() => { void readiness.reconcile(); }} />}
        {queuedCount > 0 && <div role="status">
          <p>{t("sessionChat.queued", { count: queuedCount })}</p>
          {!working && session.stateSource === "heuristic" && <p>{t("sessionChat.queuedWaiting")}</p>}
        </div>}
        {conversation.queued === 0 && queuedCount === 0 && !working && !nativePending && !unconfirmed && <p role="status"><CheckIcon size={12} pulse={1} pulseOnMount />{t("sessionChat.accepted")}</p>}
        {notice && <p role="status">{notice}</p>}
      </div>
      <ConversationComposerFrame workingDirectory={session.workingDirectory}>
        <div ref={boxRef} className={`chat-composer__box session-composer__box${dragging ? " is-file-dragging" : ""}`}>
          {assistance.menu}
          {attachments.length > 0 && (
            <div className="chat-attachments" aria-label={t("chat.attachment.selected")}>
              {attachments.map(attachment => <AttachmentChip key={attachment.path} attachment={attachment}
                removeLabel={t("chat.attachment.remove", { name: attachment.name })}
                onRemove={() => setAttachments(current => current.filter(file => file.path !== attachment.path))} />)}
            </div>
          )}
          <textarea ref={inputRef} className="chat-composer__input" value={draft} rows={2}
            aria-label={t("sessionChat.input")}
            aria-keyshortcuts={readStoredPreferences().chatSubmitShortcut === "modifier-enter" ? "Control+Enter Meta+Enter" : "Enter"}
            disabled={blocked}
            placeholder={t("sessionChat.placeholder")}
            onChange={event => { setDraft(event.target.value); assistance.select(event.target.selectionStart); }}
            onSelect={event => assistance.select(event.currentTarget.selectionStart)}
            {...assistance.inputProps}
              onBlur={assistance.dismiss} onFocus={assistance.reopen}
            onPaste={onPaste}
            onKeyDown={onKeyDown} />
          <div className="session-composer__toolbar">
            <ComposerAttachments disabled={blocked || pasting} onChoose={kind => { void chooseAttachments(kind); }} />
            <span className={`session-composer__access${session.sandboxed ? " is-sandboxed" : ""}`} title={accessHint}>
              {session.sandboxed ? <ShieldIcon size={14} /> : <AlertIcon size={14} />}
              {t(session.sandboxed ? "sessionChat.access.sandboxed" : "sessionChat.access.full")}
            </span>
            <SessionModelPicker session={session} agents={agents} openRequest={modelOpenRequest}
              disabled={nativePending || unconfirmed || (working && !switchesModelInPlace(session))}
              onNotice={setNotice} onReplaced={onSessionReplaced} />
            <ComposerVoiceControls inputRef={inputRef} draft={draft} hasContent={hasContent}
              blocked={blocked || pasting} working={working} sending={conversation.sending} canSend={canSend}
              sendLabel={t(conversation.sending ? "sessionChat.sending" : "sessionChat.send")}
              replyVersion={String(conversation.messages.length)}
              replyText={spokenSessionReply(conversation.messages[conversation.messages.length - 1]) ?? ""}
              onText={text => setDraft(current => current.trim() ? `${current.trimEnd()} ${text}` : text)}
              onSubmit={() => { void submit(); }} onNotice={setNotice} />
          </div>
        </div>
      </ConversationComposerFrame>
    </form>
  </>;
}
