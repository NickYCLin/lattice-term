import { useEffect, useState, type ReactNode } from "react";
import { copyTextToClipboard } from "../../app/clipboardText";
import { useI18n } from "../../i18n/context";

export function ChatCodeBlock({ language, text }: { language: string; text: string }) {
  const { t } = useI18n();
  const [highlighted, setHighlighted] = useState<{ text: string; language: string; content: ReactNode } | null>(null);
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  useEffect(() => {
    let cancelled = false;
    if (language && text.length <= 65536) {
      void import("./highlightCode").then(({ highlightCode }) => {
        if (!cancelled) setHighlighted({ text, language, content: highlightCode(text, language) });
      }).catch(() => { /* Plain text remains usable if the optional chunk cannot load. */ });
    }
    return () => { cancelled = true; };
  }, [text, language]);
  useEffect(() => { setCopied("idle"); }, [text]);
  useEffect(() => {
    if (copied !== "done") return;
    const timer = setTimeout(() => setCopied("idle"), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return <div className="chat-code">
    <div className="chat-code__toolbar">
      <span>{language || t("chat.markdown.code")}</span>
      <button type="button" className="button button--ghost button--sm" onClick={() => {
        void copyTextToClipboard(text).then(() => setCopied("done"), () => setCopied("failed"));
      }}>{t(copied === "done" ? "chat.markdown.copied" : "chat.markdown.copy")}</button>
    </div>
    {copied === "failed" && <p role="alert">{t("chat.markdown.copyFailed")}</p>}
    <pre data-language={language || undefined}><code>{highlighted?.text === text && highlighted.language === language ? highlighted.content : text}</code></pre>
  </div>;
}
