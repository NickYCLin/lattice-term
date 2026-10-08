import type { ReactNode } from "react";

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
