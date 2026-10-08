import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from "react";
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
import { useConversationDraft } from "../../app/useConversationDraft";
import { SESSION_PROMPT_NOT_READY, sessionNeedsReadyConfirmation } from "../../app/sessionConversationReadiness";
import type { AgentApi, AgentLifecycle, AgentSessionSummary } from "../../app/useAgentSessions";
import { useI18n } from "../../i18n/context";
import type { MessageKey } from "../../i18n/messages/zh-TW";
import {
  AlertIcon, CloseIcon, FileIcon, FolderIcon, ImageFileIcon, ShieldIcon, TerminalIcon,
} from "../icons";
import { ChatMarkdown } from "./ChatMarkdown";
import { displayPath } from "../../app/displayPath";
import { switchesModelInPlace } from "../../app/sessionModelSwitch";
import { SessionModelPicker } from "./SessionModelPicker";
import { useChatClipboardFallback } from "../../app/chatClipboard";

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
  return <span className="chat-attachment" title={displayPath(attachment.path)}>
    {attachment.isImage ? <ImageFileIcon size={14} /> : <FileIcon size={14} />}
    <span>{attachment.name}</span>
    {onRemove && <button type="button" className="chat-attachment__remove" onClick={onRemove}
      aria-label={removeLabel} title={removeLabel}><CloseIcon size={12} /></button>}
  </span>;
}

export function SessionConversationPane({ session, agents, onOpenTerminal, onSessionReplaced }: {
  session: AgentSessionSummary;
  agents: AgentApi;
  onOpenTerminal: () => void;
  /** The session was resumed under a new id, e.g. on another model. */
  onSessionReplaced: (sessionId: string) => void;
}) {
  const { t } = useI18n();
  const conversation = useSessionConversation(session.sessionId, agents);
  const { draft, setDraft, attachments, setAttachments, pasting, setPasting,
    addAttachmentPaths, readDraft } = useConversationDraft("session", session.sessionId);
  const [notice, setNotice] = useState<string | null>(null);
  const pastingRef = useRef(false);
  pastingRef.current = pasting;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const messagesRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const outputRef = useRef<HTMLPreElement>(null);
  const outputPinned = useRef(true);
  const live = !session.closedReason;
  const working = live && session.state === "working";
  const attention = live && session.state === "needsAttention";
  const waitingForReady = sessionNeedsReadyConfirmation(session);
  const queuedCount = Math.max(session.queuedPrompts, conversation.queued ?? 0);
  const { acknowledge } = conversation;
  useEffect(() => {
    acknowledge();
  }, [session.state, session.stateSource, session.queuedPrompts, acknowledge]);
  useLayoutEffect(() => {
    const node = messagesRef.current;
    if (node && pinned.current) node.scrollTop = node.scrollHeight;
  }, [conversation.messages, working, attention]);
  useLayoutEffect(() => {
    const node = outputRef.current;
    if (node && outputPinned.current) node.scrollTop = node.scrollHeight;
  }, [conversation.output]);
  const supported = session.definitionId === "codex" || session.definitionId === "claude";
  const blocked = Boolean(session.closedReason) || conversation.sending;
  const hasContent = Boolean(draft.trim()) || attachments.length > 0;
  const canSend = hasContent && !blocked && !waitingForReady;
  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!canSend || pastingRef.current) return;
    const submitted = draft;
    const files = attachments;
    if (await conversation.send(sessionPromptWithAttachments(submitted, files))) {
      setDraft(current => current === submitted ? "" : current);
      setAttachments(current => current === files ? [] : current);
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
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    clipboard.onKeyDown(event.nativeEvent);
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  }
  const accessHint = `${t(session.sandboxed ? "agents.sandbox.hint" : "sessionChat.access.fullHint")}\n${t("sessionChat.approval")}`;
  const assistant = agents.catalog.find(definition => definition.id === session.definitionId)?.label || session.label;
  const directoryLabel = session.workingDirectory.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  return <>
    <header className="chat-header">
      <div className="chat-header__title">
        <ConversationIdentity assistant={assistant} title={session.label || assistant}>
          <span className="chat-chip">{assistant}{session.model ? ` · ${session.model}` : ""}</span>
          <span className="chat-chip" title={displayPath(session.workingDirectory)}>
            <FolderIcon />{directoryLabel || t("chat.directory.none")}
          </span>
          <span className="chat-chip" title={accessHint}>
            {t(session.sandboxed ? "sessionChat.access.sandboxed" : "sessionChat.access.full")}
          </span>
          {session.groupLabel && session.groupLabel !== session.label && <span className="chat-chip">
            {t("form.group")} · {session.groupLabel}
          </span>}
          {live && <span className={`session-chat__state is-${session.state}`}>
            {t(waitingForReady ? "sessionChat.unconfirmed" : stateLabel[session.state] ?? "agents.state.idle")}
          </span>}
        </ConversationIdentity>
        <div className="chat-composer__actions">
          <button type="button" className="button button--ghost button--sm" onClick={onOpenTerminal}
            aria-label={t("chat.terminal")} title={t("chat.terminal")}>
            <TerminalIcon />
          </button>
        </div>
      </div>
      <Callout tone="info">{t("sessionChat.shared")}</Callout>
    </header>
    <div ref={messagesRef} className="chat-messages" onScroll={event => {
      const node = event.currentTarget;
      pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
    }}>
      <div className="chat-messages__inner">
        {!supported ? <p>{t("sessionChat.unsupported")}</p>
          : conversation.readError ? <div role="status"><p>{t("sessionChat.readError")}</p><p className="session-chat__diagnostic">{conversation.readError}</p></div>
          : conversation.messages.length === 0 ? <p role="status">{t(
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
        {conversation.messages.map((message, index) => {
          if (message.tool) {
            const tool = message.tool;
            const name = tool.name ?? conversation.messages.slice(0, index).reverse()
              .find(candidate => candidate.tool?.kind === "call" && candidate.tool.callId === tool.callId)
              ?.tool?.name;
            return <details key={index} className="chat-card chat-card--tool">
              <summary>
                <span className="chat-card__label">{name ?? t("sessionChat.tool")}</span>
                <span className="chat-card__summary">{t(tool.kind === "call" ? "sessionChat.toolInput" : "sessionChat.toolOutput")}</span>
              </summary>
              <div className="chat-card__text"><code>{tool.callId}</code></div>
              <pre className="chat-card__output">{message.text}</pre>
            </details>;
          }
          const sent = message.role === "user" ? splitSessionAttachments(message.text) : null;
          const files = sent ? mergeAttachmentPaths([], sent.paths) ?? [] : [];
          return <ConversationMessage key={index} role={message.role} assistant={assistant}>
            {sent ? <div>{sent.text}</div> : <ChatMarkdown source={message.text} />}
            {files.length > 0 && <div className="chat-attachments chat-attachments--sent">
              {files.map(file => <AttachmentChip key={file.path} attachment={file} />)}
            </div>}
          </ConversationMessage>;
        })}
        <details className="session-chat__output" open={conversation.messages.length === 0}>
          <summary>{t("sessionChat.output")}</summary>
          <p>{t("sessionChat.outputHint")}</p>
          {conversation.outputError && <p className="session-chat__diagnostic" role="status">{conversation.outputError}</p>}
          <pre ref={outputRef} aria-label={t("sessionChat.output")} onScroll={event => {
            const node = event.currentTarget;
            outputPinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
          }}>{conversation.output || t("sessionChat.noOutput")}</pre>
        </details>
        {working && (
          <p className="session-chat__activity" role="status">
            <span className="session-chat__pulse" aria-hidden="true" />
            {session.queuedPrompts > 0
              ? t("sessionChat.workingQueued", { count: session.queuedPrompts })
              : t("sessionChat.working")}
          </p>
        )}
        {conversation.approval ? (
          <div className="chat-card chat-card--approval chat-approval--pending" role="group"
            aria-label={t("chat.approval.title")}>
            <div className="chat-card__head">
              <span className="chat-card__label">{conversation.approval.toolName}</span>
              <code className="chat-card__summary" title={conversation.approval.summary}>
                {conversation.approval.summary}
              </code>
              <span className="chat-card__state">{t("chat.approval.title")}</span>
            </div>
            <p className="chat-notice">{t("sessionChat.permission.hint")}</p>
            <div className="chat-card__actions">
              <button type="button" className="button button--primary button--sm"
                disabled={conversation.answering} onClick={() => void conversation.answer(true)}>
                {t("chat.approval.allow")}
              </button>
              <button type="button" className="button button--secondary button--sm"
                disabled={conversation.answering} onClick={() => void conversation.answer(false)}>
                {t("chat.approval.deny")}
              </button>
              <button type="button" className="button button--ghost button--sm" onClick={onOpenTerminal}>
                {t("sessionChat.terminal")}
              </button>
            </div>
          </div>
        ) : attention && (
          <div className="session-chat__activity is-attention" role="status">
            <span>{t("sessionChat.attention")}</span>
            <button type="button" className="button button--secondary" onClick={onOpenTerminal}>
              {t("sessionChat.terminal")}
            </button>
          </div>
        )}
      </div>
    </div>
    <form className="chat-composer session-composer" onSubmit={submit}>
      <div className="session-composer__notices">
        {session.closedReason && <p role="status">{t("sessionChat.closed")}</p>}
        {conversation.sendError && conversation.sendError !== SESSION_PROMPT_NOT_READY && <p role="alert">{conversation.sendError}</p>}
        {conversation.answerError && <p role="alert">{conversation.answerError === "answered-elsewhere"
          ? t("sessionChat.permission.gone")
          : t("sessionChat.permission.failed", { detail: conversation.answerError })}</p>}
        {waitingForReady && <Callout tone="warn" actions={
          <button type="button" className="button button--secondary button--sm" onClick={onOpenTerminal}>
            {t("sessionChat.terminal")}
          </button>
        }>{t("sessionChat.notReady")}</Callout>}
        {queuedCount > 0 && <div role="status">
          <p>{t("sessionChat.queued", { count: queuedCount })}</p>
          {!working && session.stateSource === "heuristic" && <p>{t("sessionChat.queuedWaiting")}</p>}
        </div>}
        {conversation.queued === 0 && queuedCount === 0 && !working && !waitingForReady && <p role="status">{t("sessionChat.accepted")}</p>}
        {notice && <p role="status">{notice}</p>}
      </div>
      <ConversationComposerFrame workingDirectory={session.workingDirectory}>
        <div ref={boxRef} className={`chat-composer__box session-composer__box${dragging ? " is-file-dragging" : ""}`}>
          {attachments.length > 0 && (
            <div className="chat-attachments" aria-label={t("chat.attachment.selected")}>
              {attachments.map(attachment => <AttachmentChip key={attachment.path} attachment={attachment}
                removeLabel={t("chat.attachment.remove", { name: attachment.name })}
                onRemove={() => setAttachments(current => current.filter(file => file.path !== attachment.path))} />)}
            </div>
          )}
          <textarea ref={inputRef} className="chat-composer__input" value={draft} rows={2}
            aria-label={t("sessionChat.input")}
            aria-keyshortcuts="Enter"
            disabled={blocked}
            placeholder={t("sessionChat.placeholder")}
            onChange={event => setDraft(event.target.value)}
            onPaste={onPaste}
            onKeyDown={onKeyDown} />
          <div className="session-composer__toolbar">
            <ComposerAttachments disabled={blocked || pasting} onChoose={kind => { void chooseAttachments(kind); }} />
            <span className={`session-composer__access${session.sandboxed ? " is-sandboxed" : ""}`} title={accessHint}>
              {session.sandboxed ? <ShieldIcon size={14} /> : <AlertIcon size={14} />}
              {t(session.sandboxed ? "sessionChat.access.sandboxed" : "sessionChat.access.full")}
            </span>
            <SessionModelPicker session={session} agents={agents}
              disabled={Boolean(session.closedReason) || waitingForReady || (working && !switchesModelInPlace(session))}
              onNotice={setNotice} onReplaced={onSessionReplaced} />
            <ComposerVoiceControls inputRef={inputRef} draft={draft} hasContent={hasContent}
              blocked={blocked || pasting || waitingForReady} working={working} sending={conversation.sending} canSend={canSend}
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
