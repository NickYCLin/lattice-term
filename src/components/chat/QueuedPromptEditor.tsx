import { useState } from "react";
import { conversationDraftHasInput, useConversationDraft } from "../../app/useConversationDraft";
import { useI18n } from "../../i18n/context";

export function QueuedPromptEditor({ draftId, text, disabled, onSave }: {
  draftId: string;
  text: string;
  disabled?: boolean;
  onSave: (text: string) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const { draft, setDraft, readDraft } = useConversationDraft("session", `queue:${draftId}`);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = () => { setOpen(false); setDraft(""); setError(null); };
  async function save() {
    if (saving || disabled || !draft.trim()) return;
    setSaving(true);
    setError(null);
    try {
      if (await onSave(draft)) {
        if (readDraft().text === draft) setDraft("");
        setOpen(false);
        setError(null);
      }
      else setError(t("sessionChat.queueChanged"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setSaving(false); }
  }
  if (!open) return <button type="button" className="button button--ghost button--sm" disabled={disabled}
    onClick={() => {
      if (!conversationDraftHasInput("session", `queue:${draftId}`)) setDraft(text);
      setOpen(true);
    }}>{t("sessionChat.queueEdit")}</button>;
  return <div className="chat-queue__editor">
    <textarea className="input" aria-label={t("sessionChat.queueEdit")} value={draft} rows={3} autoFocus
      disabled={saving || disabled} onChange={event => setDraft(event.target.value)}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape" && !saving) { event.preventDefault(); cancel(); }
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save(); }
      }} />
    {error && <p role="alert">{error}</p>}
    <div className="chat-queue__header">
      <button type="button" className="button button--primary button--sm" disabled={saving || disabled || !draft.trim()}
        onClick={() => void save()}>{t("common.save")}</button>
      <button type="button" className="button button--secondary button--sm" disabled={saving}
        onClick={cancel}>{t("common.cancel")}</button>
    </div>
  </div>;
}
