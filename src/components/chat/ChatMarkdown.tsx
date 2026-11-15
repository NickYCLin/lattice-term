import { Children, isValidElement, useId, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownLinkKind, stripAgentMetadata } from "../../app/chatMarkdown";
import { hasDesktopBackend } from "../../app/nativeRuntime";
import { ChatCodeBlock } from "./ChatCodeBlock";

async function openExternal(url: string) {
  if (hasDesktopBackend()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else window.open(url, "_blank", "noopener,noreferrer");
}

export function ChatMarkdown({ source, onOpenFile }: { source: string; onOpenFile?: (path: string) => void }) {
  const id = useId();
  return <div className="chat-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml
    remarkRehypeOptions={{ clobberPrefix: `message-${id}-` }}
    urlTransform={url => markdownLinkKind(url) ? url : ""}
    components={{
      h1: ({ children }) => <h4>{children}</h4>,
      h2: ({ children }) => <h5>{children}</h5>,
      h3: ({ children }) => <h6>{children}</h6>,
      a: ({ href, children, title }) => {
        const kind = href ? markdownLinkKind(href) : null;
        if (kind === "file") return onOpenFile
          ? <button type="button" className="chat-markdown__file" title={title ?? href} onClick={() => onOpenFile(href!)}>{children}</button>
          : <span title={title ?? href}>{children}</span>;
        if (!kind) return <span>{children}</span>;
        return <a href={href} title={title} target={kind === "external" ? "_blank" : undefined} rel="noopener noreferrer"
          onClick={event => {
            if (kind === "external") { event.preventDefault(); void openExternal(href!).catch(() => {}); }
          }}>{children}</a>;
      },
      // File images are rendered by the conversation's scoped image preview.
      // Rendering Markdown must not load remote tracking images in the background.
      img: () => null,
      table: ({ children }) => <div className="chat-markdown__table"><table>{children}</table></div>,
      pre: ({ children }) => {
        const code = Children.toArray(children)[0];
        if (!isValidElement<{ children?: ReactNode; className?: string }>(code)) return <pre>{children}</pre>;
        const language = /(?:^|\s)language-(\S+)/.exec(code.props.className ?? "")?.[1] ?? "";
        const text = String(code.props.children ?? "").replace(/\n$/, "");
        return <ChatCodeBlock language={language} text={text} />;
      },
    }}>{stripAgentMetadata(source)}</Markdown></div>;
}
