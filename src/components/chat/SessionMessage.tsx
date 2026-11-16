import { useState } from "react";
import type { SessionConversationMessage } from "../../app/useSessionConversation";
import { mergeAttachmentPaths, splitSessionAttachments } from "../../app/chatAttachments";
import { useI18n } from "../../i18n/context";
import { ConversationMessage } from "./ConversationPresentation";
import { ChatMarkdown } from "./ChatMarkdown";
import { SentAttachments } from "./SentAttachments";
import { DuplicateIcon, EditIcon } from "../icons";

export function SessionMessage({ message, assistant, directory, sessionId, onOpenFile, onBranch, onEdit }: {
  message: SessionConversationMessage; assistant: string; directory: string; sessionId: string;
  onOpenFile: (path: string) => void; onBranch?: () => void; onEdit?: (text: string) => Promise<void>;
}) {
  const { t } = useI18n(); const [editing, setEditing] = useState(false);
  const [text, setText] = useState(""); const [saving, setSaving] = useState(false); const [error, setError] = useState("");
  const sent = message.role === "user" ? splitSessionAttachments(message.text) : null;
  const files = sent ? mergeAttachmentPaths([], sent.paths) ?? [] : [];
  const actions = <span className="chat-msg__actionGroup">
    {onEdit && <button type="button" className="chat-msg__branch" aria-label={t("chat.message.edit")} title={t("chat.message.edit")} onClick={() => { setText(sent?.text ?? message.text); setError(""); setEditing(true); }}><EditIcon size={13} /></button>}
    {onBranch && <button type="button" className="chat-msg__branch" aria-label={t("chat.branch")} title={t("chat.branch")} onClick={onBranch}><DuplicateIcon size={13} /></button>}
  </span>;
  return <ConversationMessage role={message.role} assistant={assistant} actions={actions}>
    {editing ? <form onSubmit={event => { event.preventDefault(); if (!text.trim() || saving || !onEdit) return;
      setSaving(true); setError(""); void onEdit(text).then(() => setEditing(false)).catch(reason => setError(String(reason))).finally(() => setSaving(false)); }}>
      <textarea className="input" value={text} onChange={event => setText(event.target.value)} disabled={saving} aria-label={t("chat.message.edit")} />
      <p className="chat-settings__hint">{t("chat.message.editHint")}</p>
      {error && <p role="alert">{error}</p>}
      <button className="button button--primary button--sm" disabled={saving || !text.trim()}>{t("chat.message.rerun")}</button>
      <button type="button" className="button button--ghost button--sm" disabled={saving} onClick={() => setEditing(false)}>{t("common.cancel")}</button>
    </form> : sent ? <div>{sent.text}</div> : <ChatMarkdown source={message.text} onOpenFile={onOpenFile} />}
    <SentAttachments attachments={files} workingDirectory={directory} threadId={sessionId} />
  </ConversationMessage>;
}
