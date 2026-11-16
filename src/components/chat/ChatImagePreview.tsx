import { ChatImageConversationContext, imagePreviewProblem, type ImageProblem } from "../../app/chatImagePreview";
import { useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { hasDesktopBackend } from "../../app/nativeRuntime";
import { imageFileName } from "../../app/chatImages";
import { useI18n } from "../../i18n/context";
import { useModalFocus } from "../overlays/modalFocus";
import { CloseIcon } from "../icons";

export function ChatImagePreview({ path, name, workingDirectory, threadId, initialUrl, navigation, onClose }: {
  path: string;
  name: string;
  workingDirectory: string;
  threadId?: string;
  initialUrl?: string;
  onClose: () => void;
  navigation?: { index: number; total: number; onPrevious: () => void; onNext: () => void };
}) {
  const { t } = useI18n();
  const conversationKey = JSON.stringify(useContext(ChatImageConversationContext));
  const [problem, setProblem] = useState<ImageProblem>("chat.images.unavailable");
  const imageName = imageFileName(name);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState(initialUrl ?? null);
  const [loading, setLoading] = useState(!initialUrl);
  useModalFocus({ dialogRef, onEscape: onClose });
  const navigationRef = useRef(navigation);
  navigationRef.current = navigation;
  const navigable = Boolean(navigation);
  useEffect(() => {
    if (!navigable) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const current = navigationRef.current;
      const dialogs = document.querySelectorAll('[aria-modal="true"]');
      if (!current || dialogs.item(dialogs.length - 1) !== dialogRef.current
        || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.key === "ArrowLeft" && current.index > 0) current.onPrevious();
        if (event.key === "ArrowRight" && current.index + 1 < current.total) current.onNext();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [navigable]);
  useEffect(() => {
    let cancelled = false;
    setUrl(initialUrl ?? null);
    setLoading(!initialUrl);
    setProblem("chat.images.unavailable");
    if (!hasDesktopBackend()) { setLoading(false); return; }
    void import("@tauri-apps/api/core").then(({ invoke }) => invoke<string | null>("chat_image_preview", {
      path, workingDirectory, threadId: threadId ?? null,
      ...(conversationKey !== "null" ? { nativeConversation: JSON.parse(conversationKey) } : {}),
    })).catch(error => { if (!cancelled) setProblem(imagePreviewProblem(error)); return null; }).then(next => {
      if (!cancelled) { setUrl(next); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [path, workingDirectory, threadId, initialUrl, conversationKey]);
  return createPortal(<div className="scrim scrim--center chat-image-preview" onMouseDown={event => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <div ref={dialogRef} className="chat-image-preview__dialog" role="dialog" aria-modal="true"
      aria-label={t("chat.images.preview", { name: imageName })} tabIndex={-1}>
      <header className={navigation ? "chat-image-preview__header--gallery" : undefined}>
        <span aria-live="polite">{navigation ? t("chat.images.position", { current: navigation.index + 1, total: navigation.total }) : t("chat.images.title")}</span>
        {navigation && <>
          <button type="button" className="button button--quiet" disabled={navigation.index === 0}
            onClick={navigation.onPrevious}>{t("chat.images.previous")}</button>
          <button type="button" className="button button--quiet" disabled={navigation.index + 1 >= navigation.total}
            onClick={navigation.onNext}>{t("chat.images.next")}</button>
        </>}
        <button type="button" className="icon-button" aria-label={t("common.close")} onClick={onClose}><CloseIcon /></button>
      </header>
      <div className="chat-image-preview__content">
        {loading ? <p role="status">{t("common.loading")}</p>
          : url ? <img src={url} alt={imageName} onError={() => setUrl(null)} />
            : <p role="alert">{t(problem)}</p>}
      </div>
    </div>
  </div>, document.body);
}
