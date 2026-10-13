import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { hasDesktopBackend } from "../../app/nativeRuntime";
import { displayPath } from "../../app/displayPath";
import { useI18n } from "../../i18n/context";
import { useModalFocus } from "../overlays/modalFocus";
import { CloseIcon } from "../icons";

export function ChatImagePreview({ path, name, workingDirectory, threadId, initialUrl, onClose }: {
  path: string;
  name: string;
  workingDirectory: string;
  threadId?: string;
  initialUrl?: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState(initialUrl ?? null);
  const [loading, setLoading] = useState(!initialUrl);
  useModalFocus({ dialogRef, onEscape: onClose });
  useEffect(() => {
    let cancelled = false;
    setUrl(initialUrl ?? null);
    setLoading(!initialUrl);
    if (initialUrl) return;
    if (!hasDesktopBackend()) { setLoading(false); return; }
    void import("@tauri-apps/api/core").then(({ invoke }) => invoke<string | null>("chat_image_preview", {
      path, workingDirectory, threadId: threadId ?? null,
    })).catch(() => null).then(next => {
      if (!cancelled) { setUrl(next); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [path, workingDirectory, threadId, initialUrl]);
  return createPortal(<div className="scrim scrim--center chat-image-preview" onMouseDown={event => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <div ref={dialogRef} className="chat-image-preview__dialog" role="dialog" aria-modal="true"
      aria-label={t("chat.images.preview", { name })} tabIndex={-1}>
      <header>
        <span title={displayPath(path)}>{name}</span>
        <button type="button" className="icon-button" aria-label={t("common.close")} onClick={onClose}><CloseIcon /></button>
      </header>
      <div className="chat-image-preview__content">
        {loading ? <p role="status">{t("common.loading")}</p>
          : url ? <img src={url} alt={name} onError={() => setUrl(null)} />
            : <p role="alert">{t("chat.images.unavailable")}</p>}
      </div>
    </div>
  </div>, document.body);
}
