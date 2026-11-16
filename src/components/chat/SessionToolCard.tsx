import { useState } from "react";
import { useI18n } from "../../i18n/context";
import type { SessionConversationMessage } from "../../app/useSessionConversation";
import { ChatMarkdown } from "./ChatMarkdown";

/** Native call/result pair; updates keep the same details element and scroll position. */
export function SessionToolCard({ message, result, onOpenFile }: {
  message: SessionConversationMessage;
  result?: SessionConversationMessage;
  onOpenFile?: (path: string) => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  if (!message.tool) return null;
  const reasoning = message.tool.kind === "reasoning";
  return <details className={`chat-card ${reasoning ? "chat-card--reasoning" : "chat-card--tool"}`} onToggle={event => { if (event.target === event.currentTarget) setExpanded(event.currentTarget.open); }}>
    <summary className="chat-card__head">
      <span className="chat-card__label">{reasoning ? t("chat.reasoning") : message.tool.name || t("chat.tools.title")}</span>
      {!reasoning && <span className="chat-card__summary">{message.text.split("\n")[0]?.slice(0, 160)}</span>}
    </summary>
    {expanded && <div className="chat-card__body"><ChatMarkdown source={message.text} onOpenFile={onOpenFile} />
      {result && <ChatMarkdown source={result.text} onOpenFile={onOpenFile} />}
    </div>}
  </details>;
}
