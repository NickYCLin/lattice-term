import type { ChatAttachment } from "../../app/agentChat";
import { displayPath } from "../../app/displayPath";
import { FileIcon } from "../icons";
import { ChatImageStrip } from "./ChatImagePreviews";

export function SentAttachments({ attachments, workingDirectory, threadId }: {
  attachments: readonly ChatAttachment[];
  workingDirectory: string;
  threadId?: string;
}) {
  const files = attachments.filter(file => !file.isImage);
  if (attachments.length === 0) return null;
  return <>
    {files.length > 0 && <div className="chat-attachments chat-attachments--sent">
      {files.map(attachment => <span className="chat-attachment" key={attachment.path} title={displayPath(attachment.path)}>
        <FileIcon size={14} /><span>{attachment.name}</span></span>)}
    </div>}
    <ChatImageStrip paths={attachments.filter(file => file.isImage).map(file => file.preview ?? file.path)}
      workingDirectory={workingDirectory} threadId={threadId} captions={false} showUnavailable />
  </>;
}
