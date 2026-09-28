import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSessionConversation } from "../../app/useSessionConversation";
import type { AgentApi, AgentLifecycle, AgentSessionSummary } from "../../app/useAgentSessions";
import { useI18n } from "../../i18n/context";
import type { MessageKey } from "../../i18n/messages/zh-TW";
import { ChatMarkdown } from "./ChatMarkdown";

const stateLabel: Record<AgentLifecycle, MessageKey> = {
  working: "agents.state.working",
  needsAttention: "agents.state.needsAttention",
  idle: "agents.state.idle",
  done: "agents.state.done",
};

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
  const supported = session.definitionId === "codex" || session.definitionId === "claude";
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
          : conversation.readError ? <p role="status">{t("sessionChat.readError")}</p>
          : conversation.messages.length === 0 ? <p>{t("sessionChat.waiting")}</p> : null}
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
    <form className="chat-composer" onSubmit={async (event) => {
      event.preventDefault();
      const submitted = draft;
      if (await conversation.send(submitted)) setDraft(current => current === submitted ? "" : current);
    }}>
      {session.closedReason && <p role="status">{t("sessionChat.closed")}</p>}
      {conversation.sendError && <p role="alert">{conversation.sendError}</p>}
      {conversation.queued !== null && !working && <p role="status">{t("sessionChat.accepted")}</p>}
      <label className="chat-composer__box">
        <textarea className="chat-composer__input" value={draft}
          aria-label={t("sessionChat.input")}
          disabled={Boolean(session.closedReason) || conversation.sending}
          placeholder={t("sessionChat.input")} onChange={event => setDraft(event.target.value)} />
      </label>
      <div className="chat-composer__row">
        <p className="chat-composer__hint">{t("sessionChat.approval")}</p>
        <button type="submit" className="button button--primary"
          disabled={!draft.trim() || Boolean(session.closedReason) || conversation.sending}>
          {t(conversation.sending ? "sessionChat.sending" : "sessionChat.send")}
        </button>
      </div>
    </form>
  </>;
}
