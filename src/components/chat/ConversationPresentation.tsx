import type { ReactNode } from "react";
import { AgentIcon } from "../icons";
import { useI18n } from "../../i18n/context";
import type { ConversationLabels } from "../../app/conversationLabels";

export function ConversationMetadata({ labels }: { labels: ConversationLabels }) {
  const { t } = useI18n();
  const text = [`${t("conversation.meta.provider")}: ${labels.provider ?? t("conversation.meta.unknown")}`,
    labels.source, `${t("conversation.meta.model")}: ${labels.model ?? t("conversation.meta.unknown")}`,
    labels.endpoint && `${t("conversation.meta.connection")}: ${labels.endpoint}`,
    labels.account && `${t("conversation.meta.account")}: ${labels.account}`,
    labels.project && `${t("conversation.meta.project")}: ${labels.project}`].filter(Boolean).join(" · ");
  return <span title={text}>{text}</span>;
}

export function ConversationListIdentity({ title, children }: { title: string; children: ReactNode }) {
  return <span className="chat-thread__identity">
    <AgentIcon size={13} />
    <span className="chat-thread__details">
      <span className="chat-thread__title">{title}</span>
      <span className="chat-thread__meta">{children}</span>
    </span>
  </span>;
}

export function ConversationIdentity({ assistant, title, children }: {
  assistant: string;
  title: string;
  children: ReactNode;
}) {
  return <div className="chat-header__identity">
    <span className="chat-avatar" aria-hidden="true">{assistant.slice(0, 1)}</span>
    <div className="chat-header__details">
      <h2>{title}</h2>
      <div className="chat-chips">{children}</div>
    </div>
  </div>;
}

export function ConversationMessage({ role, assistant, children, actions }: {
  role: "user" | "assistant";
  assistant: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return <div className={`chat-msg chat-msg--${role}`}>
    {role === "assistant" && <span className="chat-avatar" aria-hidden="true">
      {assistant.slice(0, 1)}
    </span>}
    <div className={role === "user" ? "chat-bubble" : "chat-msg__body"}>
      {role === "assistant" && <span className="chat-msg__name">{assistant}</span>}
      {children}
    </div>
    {actions}
  </div>;
}
