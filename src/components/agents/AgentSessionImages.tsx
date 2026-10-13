import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n/context";
import { ChatImagePreview } from "../chat/ChatImagePreview";
import { CloseIcon, ImageFileIcon } from "../icons";
import { useModalFocus } from "../overlays/modalFocus";

export interface SessionImagesSnapshot {
  paths: string[];
  truncated: boolean;
  historyAvailable: boolean;
}

const PAGE_SIZE = 9;

function SessionImageTile({ path, sessionId, onSelect }: {
  path: string;
  sessionId: string;
  onSelect: (path: string, url: string | null) => void;
}) {
  const { t } = useI18n();
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const name = path.split(/[\/]/).pop() ?? path;
  useEffect(() => {
    let cancelled = false;
    void invoke<string | null>("chat_image_preview", { path, workingDirectory: "", threadId: sessionId })
      .catch(() => null).then(next => {
        if (!cancelled) { setUrl(next); setLoading(false); }
      });
    return () => { cancelled = true; };
  }, [path, sessionId]);
  return <button type="button" className="agent-session-images__tile"
    aria-label={t("chat.images.preview", { name })} onClick={() => onSelect(path, url)}>
    {loading ? <span role="status">{t("common.loading")}</span>
      : url ? <img src={url} alt={name} onError={() => setUrl(null)} />
        : <span>{t("chat.images.unavailable")}</span>}
    <span title={name}>{name}</span>
  </button>;
}

function SessionImageGallery({ sessionId, revision, onClose }: {
  sessionId: string;
  revision: number;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [snapshot, setSnapshot] = useState<SessionImagesSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<{ path: string; url: string | null } | null>(null);
  useModalFocus({ dialogRef, onEscape: onClose });
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null); setSnapshot(null); setPage(0); setSelected(null);
    void invoke<SessionImagesSnapshot>("agent_session_images_snapshot", { sessionId }).then(next => {
      if (!cancelled) setSnapshot(next);
    }).catch(reason => {
      if (!cancelled) setError(String(reason));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, revision, refresh]);
  const pages = Math.max(1, Math.ceil((snapshot?.paths.length ?? 0) / PAGE_SIZE));
  return createPortal(<div className="scrim scrim--center agent-session-images" onMouseDown={event => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <div ref={dialogRef} className="agent-session-images__dialog" role="dialog" aria-modal="true"
      aria-label={t("agents.images.title")} tabIndex={-1}>
      <header><h2>{t("agents.images.title")}</h2>
        <button type="button" className="button button--quiet" disabled={loading}
          onClick={() => setRefresh(value => value + 1)}>{t("agents.images.refresh")}</button>
        <button type="button" className="icon-button" aria-label={t("common.close")} onClick={onClose}><CloseIcon /></button>
      </header>
      <div className="agent-session-images__content">
        <p>{t("agents.images.hint")}</p>
        {loading ? <p role="status">{t("agents.images.loading")}</p>
          : error ? <div role="alert"><p>{t("agents.images.failed")}</p><pre>{error}</pre></div>
            : snapshot && <>
              {!snapshot.historyAvailable && <p role="status">{t("agents.images.waiting")}</p>}
              {snapshot.truncated && <p role="status">{t("agents.images.limited")}</p>}
              {snapshot.paths.length === 0 ? <p>{t("agents.images.empty")}</p>
                : <div className="agent-session-images__grid">
                  {snapshot.paths.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(path =>
                    <SessionImageTile key={path} path={path} sessionId={sessionId}
                      onSelect={(path, url) => setSelected({ path, url })} />)}
                </div>}
              {pages > 1 && <nav aria-label={t("agents.images.pages")}>
                <button type="button" className="button" disabled={page === 0}
                  onClick={() => setPage(value => value - 1)}>{t("agents.images.previous")}</button>
                <span>{page + 1} / {pages}</span>
                <button type="button" className="button" disabled={page + 1 >= pages}
                  onClick={() => setPage(value => value + 1)}>{t("agents.images.next")}</button>
              </nav>}
            </>}
      </div>
    </div>
    {selected && <ChatImagePreview path={selected.path} name={selected.path.split(/[\/]/).pop() ?? selected.path}
      workingDirectory="" threadId={sessionId} initialUrl={selected.url ?? undefined} onClose={() => setSelected(null)} />}
  </div>, document.body);
}

export function AgentSessionImages({ sessionId, active, revision }: {
  sessionId: string;
  active: boolean;
  revision: number;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  useEffect(() => { if (!active) setOpen(false); }, [active]);
  return <div className="agent-session-images__toolbar">
    <button type="button" className="button button--quiet" onClick={() => setOpen(true)}>
      <ImageFileIcon size={16} />{t("agents.images.title")}
    </button>
    {open && active && <SessionImageGallery key={sessionId} sessionId={sessionId} revision={revision} onClose={() => setOpen(false)} />}
  </div>;
}
