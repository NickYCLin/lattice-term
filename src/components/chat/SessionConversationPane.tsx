import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from "react";
import type { ChatAttachment } from "../../app/agentChat";
import {
  CHAT_ATTACHMENT_LIMIT, mergeAttachmentPaths, pasteContainsFiles, pasteContainsImage,
  sessionPromptWithAttachments, splitSessionAttachments,
} from "../../app/chatAttachments";
import { useFileDrop } from "../../app/fileDrop";
import { speak, spokenSessionReply, speechSynthesisAvailable, stopSpeaking, useDictation } from "../../app/sessionVoice";
import { useSessionConversation } from "../../app/useSessionConversation";
import type { AgentApi, AgentLifecycle, AgentSessionSummary } from "../../app/useAgentSessions";
import { localeCatalog } from "../../i18n/catalog";
import { useI18n } from "../../i18n/context";
import type { MessageKey } from "../../i18n/messages/zh-TW";
import {
  AlertIcon, CloseIcon, DesktopIcon, FileIcon, FolderIcon, ImageFileIcon, MicIcon, PlusIcon, SendIcon,
  ShieldIcon, WaveformIcon,
} from "../icons";
import { ChatMarkdown } from "./ChatMarkdown";
import { displayPath } from "../../app/displayPath";
import { switchesModelInPlace } from "../../app/sessionModelSwitch";
import { SessionModelPicker } from "./SessionModelPicker";

const stateLabel: Record<AgentLifecycle, MessageKey> = {
  working: "agents.state.working",
  needsAttention: "agents.state.needsAttention",
  idle: "agents.state.idle",
  done: "agents.state.done",
};

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

const VOICE_SEND_DELAY_MS = 2500;

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
  const { t, locale } = useI18n();
  const speechLang = localeCatalog.find(entry => entry.id === locale)?.tag ?? locale;
  const conversation = useSessionConversation(session.sessionId, agents);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const [notice, setNotice] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [voiceActive, setVoiceActive] = useState(false);
  const voiceActiveRef = useRef(false);
  const spokenThrough = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; stopSpeaking(); }, []);
  const messagesRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const outputRef = useRef<HTMLPreElement>(null);
  const outputPinned = useRef(true);
  const live = !session.closedReason;
  const working = live && session.state === "working";
  const attention = live && session.state === "needsAttention";
  const { acknowledge } = conversation;
  useEffect(() => {
    acknowledge();
  }, [session.state, acknowledge]);
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
  const canSend = hasContent && !blocked;
  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!canSend) return;
    const submitted = draft;
    const files = attachments;
    if (await conversation.send(sessionPromptWithAttachments(submitted, files))) {
      setDraft(current => current === submitted ? "" : current);
      setAttachments(current => current === files ? [] : current);
    }
  }
  const submitRef = useRef(submit);
  submitRef.current = submit;

  function addAttachments(paths: readonly string[]): boolean {
    const next = mergeAttachmentPaths(attachmentsRef.current, paths);
    if (!next) {
      setNotice(t("chat.attachment.limit", { count: CHAT_ATTACHMENT_LIMIT }));
      return false;
    }
    attachmentsRef.current = next;
    setAttachments(next);
    setNotice(null);
    return true;
  }
  async function chooseAttachments(kind: "image" | "file") {
    setMenuOpen(false);
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
  async function pasteAttachments() {
    setMenuOpen(false);
    if (pasting) return;
    if (attachmentsRef.current.length >= CHAT_ATTACHMENT_LIMIT) {
      setNotice(t("chat.attachment.limit", { count: CHAT_ATTACHMENT_LIMIT }));
      return;
    }
    setPasting(true);
    setNotice(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const files = await invoke<string[]>("agent_chat_paste_files");
      if (!mounted.current) return;
      if (files.length > 0) {
        addAttachments(files);
        return;
      }
      const path = await invoke<string | null>("agent_chat_paste_image", { threadId: session.sessionId });
      if (!mounted.current) return;
      if (path) addAttachments([path]);
      else setNotice(t("chat.attachment.clipboardEmpty"));
    } catch (reason) {
      if (mounted.current) setNotice(t("chat.attachment.failed", { detail: errorText(reason) }));
    } finally {
      if (mounted.current) setPasting(false);
    }
  }
  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (!pasteContainsImage(event.clipboardData.items) && !pasteContainsFiles(event.clipboardData.items)) return;
    event.preventDefault();
    void pasteAttachments();
  }
  const { dragging } = useFileDrop({
    ref: boxRef,
    disabled: blocked,
    onPaths: paths => { addAttachments(paths); },
    onError: reason => setNotice(t("chat.attachment.failed", { detail: errorText(reason) })),
  });
  useEffect(() => {
    if (!menuOpen) return;
    function close(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    }
    function escape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [menuOpen]);

  const dictation = useDictation({
    lang: speechLang,
    onText: text => setDraft(current => current.trim() ? `${current.trimEnd()} ${text}` : text),
    onError: detail => setNotice(t("sessionChat.voice.failed", { detail })),
  });
  const voiceAvailable = dictation.mode !== null;
  function startDictation() {
    inputRef.current?.focus();
    void dictation.start();
  }
  function startVoice() {
    if (!voiceAvailable || blocked) return;
    voiceActiveRef.current = true;
    setVoiceActive(true);
    spokenThrough.current = conversation.messages.length;
    setNotice(t(dictation.mode === "system" ? "sessionChat.voice.startedSystem" : "sessionChat.voice.started"));
    startDictation();
  }
  function stopVoice() {
    voiceActiveRef.current = false;
    setVoiceActive(false);
    dictation.stop();
    stopSpeaking();
    setNotice(null);
  }
  useEffect(() => {
    if (!voiceActive || !draft.trim() || blocked) return;
    const timer = setTimeout(() => void submitRef.current(), VOICE_SEND_DELAY_MS);
    return () => clearTimeout(timer);
  }, [voiceActive, draft, blocked]);
  useEffect(() => {
    if (!voiceActive || working) return;
    const messages = conversation.messages;
    if (messages.length <= spokenThrough.current) return;
    const last = messages[messages.length - 1];
    spokenThrough.current = messages.length;
    const reply = spokenSessionReply(last);
    if (!reply) return;
    void speak(reply, speechLang).then(() => {
      if (voiceActiveRef.current && mounted.current && dictation.mode === "browser") void dictation.start();
    });
  }, [voiceActive, working, conversation.messages, speechLang, dictation]);
  const dictationTitle = !voiceAvailable ? t("sessionChat.dictation.unavailable")
    : dictation.mode === "system" ? t("sessionChat.dictation.system") : t("sessionChat.dictation");
  const voiceTitle = !voiceAvailable ? t("sessionChat.voice.unavailable")
    : speechSynthesisAvailable() ? t("sessionChat.voice.start") : t("sessionChat.voice.startSilent");
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  }
  const accessHint = `${t(session.sandboxed ? "agents.sandbox.hint" : "sessionChat.access.fullHint")}\n${t("sessionChat.approval")}`;
  return <>
    <header className="chat-header">
      <div className="session-chat__title">
        <h2>{session.groupLabel || session.label}</h2>
        {live && (
          <span className={`session-chat__state is-${session.state}`}>
            {t(stateLabel[session.state] ?? "agents.state.idle")}
          </span>
        )}
      </div>
      <p>{t("sessionChat.shared")}</p>
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
            return <details key={index} className="session-chat__tool">
              <summary>{name ?? t("sessionChat.tool")}
                <span>{t(tool.kind === "call" ? "sessionChat.toolInput" : "sessionChat.toolOutput")}</span>
              </summary>
              <code className="session-chat__tool-id">{tool.callId}</code>
              <pre>{message.text}</pre>
            </details>;
          }
          const sent = message.role === "user" ? splitSessionAttachments(message.text) : null;
          const files = sent ? mergeAttachmentPaths([], sent.paths) ?? [] : [];
          return <div key={index} className={`chat-msg chat-msg--${message.role}`}>
            <div className={message.role === "user" ? "chat-bubble" : "chat-msg__body"}>
              <span className="chat-msg__name">{t(message.role === "user" ? "history.user" : "history.assistant")}</span>
              {sent ? sent.text : <ChatMarkdown source={message.text} />}
              {files.length > 0 && <div className="chat-attachments chat-attachments--sent">
                {files.map(file => <AttachmentChip key={file.path} attachment={file} />)}
              </div>}
            </div>
          </div>;
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
      {session.closedReason && <p role="status">{t("sessionChat.closed")}</p>}
      {conversation.sendError && <p role="alert">{conversation.sendError}</p>}
      {conversation.answerError && <p role="alert">{conversation.answerError === "answered-elsewhere"
        ? t("sessionChat.permission.gone")
        : t("sessionChat.permission.failed", { detail: conversation.answerError })}</p>}
      {conversation.queued !== null && !working && <p role="status">{t("sessionChat.accepted")}</p>}
      {notice && <p role="status">{notice}</p>}
      <div className="session-composer__frame">
        <div className="session-composer__context">
          <span className="session-composer__place" title={displayPath(session.workingDirectory)}>
            <FolderIcon size={14} />
            <span>{folderName(session.workingDirectory)}</span>
          </span>
          <span className="session-composer__place">
            <DesktopIcon size={14} />
            <span>{t("chat.delegate.machine.local")}</span>
          </span>
        </div>
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
            <div ref={menuRef} className="session-composer__more">
              <button type="button" className="session-composer__icon" disabled={blocked}
                aria-haspopup="menu" aria-expanded={menuOpen}
                aria-label={t("sessionChat.more")} title={t("sessionChat.more")}
                onClick={() => setMenuOpen(open => !open)}>
                <PlusIcon />
              </button>
              {menuOpen && (
                <div className="session-composer__menu" role="menu">
                  <button type="button" role="menuitem" onClick={() => void chooseAttachments("image")}>
                    <ImageFileIcon size={14} />{t("chat.attachment.images")}
                  </button>
                  <button type="button" role="menuitem" onClick={() => void chooseAttachments("file")}>
                    <FileIcon size={14} />{t("chat.attachment.files")}
                  </button>
                  <button type="button" role="menuitem" title={t("chat.attachment.pasteHint")}
                    disabled={pasting} onClick={() => void pasteAttachments()}>
                    <PlusIcon size={14} />{t(pasting ? "chat.attachment.pasting" : "chat.attachment.paste")}
                  </button>
                </div>
              )}
            </div>
            <span className={`session-composer__access${session.sandboxed ? " is-sandboxed" : ""}`} title={accessHint}>
              {session.sandboxed ? <ShieldIcon size={14} /> : <AlertIcon size={14} />}
              {t(session.sandboxed ? "sessionChat.access.sandboxed" : "sessionChat.access.full")}
            </span>
            <SessionModelPicker session={session} agents={agents}
              disabled={Boolean(session.closedReason) || (working && !switchesModelInPlace(session))}
              onNotice={setNotice} onReplaced={onSessionReplaced} />
            <button type="button" className={`session-composer__icon${dictation.listening ? " is-active" : ""}`}
              disabled={!voiceAvailable || blocked} aria-label={dictationTitle} title={dictationTitle}
              aria-pressed={dictation.mode === "browser" ? dictation.listening : undefined}
              onClick={() => dictation.listening ? dictation.stop() : startDictation()}>
              <MicIcon />
            </button>
            {voiceActive ? (
              <button type="button" className="session-composer__voice is-active"
                aria-label={t("sessionChat.voice.stop")} title={t("sessionChat.voice.stop")} onClick={stopVoice}>
                <WaveformIcon />
              </button>
            ) : hasContent || conversation.sending ? (
              <button type="submit" className="chat-send" disabled={!canSend}
                aria-label={t(conversation.sending ? "sessionChat.sending" : "sessionChat.send")}
                title={t(conversation.sending ? "sessionChat.sending" : "sessionChat.send")}>
                <SendIcon />
              </button>
            ) : (
              <button type="button" className="session-composer__voice" disabled={!voiceAvailable || blocked}
                aria-label={voiceTitle} title={voiceTitle} onClick={startVoice}>
                <WaveformIcon />
              </button>
            )}
          </div>
        </div>
      </div>
    </form>
  </>;
}
