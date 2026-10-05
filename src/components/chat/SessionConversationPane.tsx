import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useSessionConversation } from "../../app/useSessionConversation";
import type { AgentApi, AgentLifecycle, AgentSessionSummary } from "../../app/useAgentSessions";
import { useI18n } from "../../i18n/context";
import type { MessageKey } from "../../i18n/messages/zh-TW";
import { AlertIcon, DesktopIcon, FolderIcon, SendIcon, ShieldIcon } from "../icons";
import { ChatMarkdown } from "./ChatMarkdown";

const stateLabel: Record<AgentLifecycle, MessageKey> = {
  working: "agents.state.working",
  needsAttention: "agents.state.needsAttention",
  idle: "agents.state.idle",
  done: "agents.state.done",
};

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function SessionConversationPane({ session, agents, onOpenTerminal }: {
  session: AgentSessionSummary;
  agents: AgentApi;
  onOpenTerminal: () => void;
}) {
  const { t } = useI18n();
  const conversation = useSessionConversation(session.sessionId, agents);
  const [draft, setDraft] = useState("");
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
  const canSend = Boolean(draft.trim()) && !blocked;
  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!canSend) return;
    const submitted = draft;
    if (await conversation.send(submitted)) setDraft(current => current === submitted ? "" : current);
  }
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
      <button type="button" className="button button--secondary" onClick={onOpenTerminal}>
        {t("sessionChat.terminal")}
      </button>
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
              : conversation.loading ? "common.loading" : "sessionChat.waiting",
          )}</p> : null}
        {session.closedReason && <p className="session-chat__diagnostic" role="status">{session.closedReason}</p>}
        <details className="session-chat__output" open={conversation.messages.length === 0 || working || attention || Boolean(session.closedReason)}>
          <summary>{t("sessionChat.output")}</summary>
          <p>{t("sessionChat.outputHint")}</p>
          <pre ref={outputRef} aria-label={t("sessionChat.output")} onScroll={event => {
            const node = event.currentTarget;
            outputPinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
          }}>{conversation.output || t("sessionChat.noOutput")}</pre>
        </details>
        {conversation.messages.map((message, index) => (
          <div key={index} className={`chat-msg chat-msg--${message.role}`}>
            <div className={message.role === "user" ? "chat-bubble" : "chat-msg__body"}>
              <span className="chat-msg__name">{t(message.role === "user" ? "history.user" : "history.assistant")}</span>
              {message.role === "user" ? message.text : <ChatMarkdown source={message.text} />}
            </div>
          </div>
        ))}
        {working && (
          <p className="session-chat__activity" role="status">
            <span className="session-chat__pulse" aria-hidden="true" />
            {session.queuedPrompts > 0
              ? t("sessionChat.workingQueued", { count: session.queuedPrompts })
              : t("sessionChat.working")}
          </p>
        )}
        {attention && (
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
      {conversation.queued !== null && !working && <p role="status">{t("sessionChat.accepted")}</p>}
      <div className="session-composer__frame">
        <div className="session-composer__context">
          <span className="session-composer__place" title={session.workingDirectory}>
            <FolderIcon size={14} />
            <span>{folderName(session.workingDirectory)}</span>
          </span>
          <span className="session-composer__place">
            <DesktopIcon size={14} />
            <span>{t("chat.delegate.machine.local")}</span>
          </span>
        </div>
        <div className="chat-composer__box session-composer__box">
          <textarea className="chat-composer__input" value={draft} rows={2}
            aria-label={t("sessionChat.input")}
            aria-keyshortcuts="Enter"
            disabled={blocked}
            placeholder={t("sessionChat.placeholder")}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={onKeyDown} />
          <div className="session-composer__toolbar">
            <span className={`session-composer__access${session.sandboxed ? " is-sandboxed" : ""}`} title={accessHint}>
              {session.sandboxed ? <ShieldIcon size={14} /> : <AlertIcon size={14} />}
              {t(session.sandboxed ? "sessionChat.access.sandboxed" : "sessionChat.access.full")}
            </span>
            <span className="session-composer__model" title={t("sessionChat.model")}>
              {session.model || session.label}
            </span>
            <button type="submit" className="chat-send" disabled={!canSend}
              aria-label={t(conversation.sending ? "sessionChat.sending" : "sessionChat.send")}
              title={t(conversation.sending ? "sessionChat.sending" : "sessionChat.send")}>
              <SendIcon />
            </button>
          </div>
        </div>
      </div>
    </form>
  </>;
}
