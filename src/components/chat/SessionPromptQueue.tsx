import { mergeAttachmentPaths, sessionPromptWithAttachments, splitSessionAttachments } from "../../app/chatAttachments";
import type { useSessionPromptQueue } from "../../app/useSessionPromptQueue";
import { useI18n } from "../../i18n/context";
import { CloseIcon } from "../icons";
import { QueuedPromptEditor } from "./QueuedPromptEditor";

export function SessionPromptQueue({ sessionId, queue }: {
  sessionId: string;
  queue: ReturnType<typeof useSessionPromptQueue>;
}) {
  const { t } = useI18n();
  if (queue.prompts.length === 0 && !queue.error) return null;
  return <section className="chat-queue session-prompt-queue" aria-label={t("chat.queue.title")}>
    {queue.error && <p role="alert">{queue.error === "queue-message-changed"
      ? t("sessionChat.queueChanged") : <>{t("sessionChat.queueReadError")} {queue.error}</>}</p>}
    {queue.prompts.length > 0 && <>
      <div className="chat-queue__header"><strong>{t("chat.queue.title")} ({queue.prompts.length})</strong>
        <span>{t("chat.queue.hint")}</span></div>
      <ol>{queue.prompts.map(prompt => {
        const sent = splitSessionAttachments(prompt.text);
        const files = mergeAttachmentPaths([], sent.paths) ?? [];
        return <li key={prompt.id}>
          <span>{sent.text}{files.length > 0 && <small>{files.map(file => file.name).join(", ")}</small>}
            {prompt.deliveryError && <small role="alert">{t("sessionChat.queueDeliveryError")} {prompt.deliveryError}</small>}
          </span>
          {prompt.editable ? <>
            <QueuedPromptEditor draftId={sessionId + ":" + prompt.id} text={sent.text} disabled={queue.editing || Boolean(prompt.deliveryError)}
              onSave={text => queue.save(prompt, sessionPromptWithAttachments(text, files))} />
            <button type="button" className="icon-button icon-button--sm" disabled={queue.editing}
              aria-label={t("chat.queue.remove")} title={t("chat.queue.remove")}
              onClick={() => void queue.save(prompt, null).catch(() => undefined)}><CloseIcon size={12} /></button>
          </> : <small>{t("sessionChat.queueExternal")}</small>}
        </li>;
      })}</ol>
    </>}
  </section>;
}
