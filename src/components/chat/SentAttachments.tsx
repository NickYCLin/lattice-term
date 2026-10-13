import { useEffect, useState } from "react";
import type { ChatAttachment } from "../../app/agentChat";
import { displayPath } from "../../app/displayPath";
import { useI18n } from "../../i18n/context";
import { FileIcon, ImageFileIcon } from "../icons";
import { ChatImagePreview } from "./ChatImagePreview";

export function SentAttachments({ attachments, workingDirectory, threadId }: {
  attachments: readonly ChatAttachment[];
  workingDirectory: string;
  threadId?: string;
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<ChatAttachment | null>(null);
  useEffect(() => setSelected(null), [threadId, workingDirectory]);
  if (attachments.length === 0) return null;
  return <>
    <div className="chat-attachments chat-attachments--sent">
      {attachments.map(attachment => attachment.isImage
        ? <button type="button" className="chat-attachment chat-attachment--preview" key={attachment.path}
          title={displayPath(attachment.path)} aria-label={t("chat.images.preview", { name: attachment.name })}
          onClick={() => setSelected(attachment)}><ImageFileIcon size={14} /><span>{attachment.name}</span></button>
        : <span className="chat-attachment" key={attachment.path} title={displayPath(attachment.path)}>
          <FileIcon size={14} /><span>{attachment.name}</span></span>)}
    </div>
    {selected && <ChatImagePreview key={selected.preview ?? selected.path} path={selected.preview ?? selected.path}
      name={selected.name} workingDirectory={workingDirectory} threadId={threadId} onClose={() => setSelected(null)} />}
  </>;
}
