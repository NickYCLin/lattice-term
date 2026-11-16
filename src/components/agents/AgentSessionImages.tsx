import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n/context";
import { imageFileName, orderedImagePaths } from "../../app/chatImages";
import { ChatImagePreview } from "../chat/ChatImagePreview";
import type { TerminalImageReference } from "../terminal/terminalImageLinks";
import { CloseIcon, ImageFileIcon } from "../icons";
import { useModalFocus } from "../overlays/modalFocus";

export interface SessionImagesSnapshot {
  paths: string[];
  truncated: boolean;
  historyAvailable: boolean;
  prompts?: { text: string; paths: (string | null)[] }[];
  observed?: { tool: string; stepId?: string | null; at: string | null; paths: string[]; localReference: boolean }[];
}

function promptText(text: string): string {
  return text.replace(/\[LatticeTerm attachments:[\s\S]*/, "").replace(/<image[^>]*>[\s\S]*?<\/image>/g, "")
    .replace(/\[Image #\d+\]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export function resolveSessionImageReference(snapshot: SessionImagesSnapshot | null, reference?: TerminalImageReference) {
  if (!snapshot || !reference?.index || !Number.isSafeInteger(reference.index) || reference.index < 1 || snapshot.truncated) return null;
  const prompts = snapshot.prompts ?? [];
  const context = promptText(reference.context);
  const matching = prompts.filter(prompt => {
    const text = promptText(prompt.text).slice(0, 120);
    return text.length >= 3 && context.includes(text);
  });
  const candidates = matching.length ? matching : prompts.length === 1 ? prompts : [];
  if (candidates.length !== 1) return null;
  const prompt = candidates[0];
  const path = prompt.paths[reference.index - 1];
  if (!path) return null;
  return { path, images: prompt.paths.flatMap((path, index) => path ? [{ path, number: index + 1 }] : []) };
}

const PAGE_SIZE = 9;

function SessionImageTile({ path, sessionId, number, current, focusRevision, onSelect }: {
  path: string;
  sessionId: string;
  number: number;
  current: boolean;
  focusRevision: number;
  onSelect: (path: string, url: string | null) => void;
}) {
  const { t } = useI18n();
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const name = imageFileName(path);
  const tileRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (current) { tileRef.current?.focus({ preventScroll: true }); tileRef.current?.scrollIntoView?.({ block: "nearest" }); }
  }, [current, focusRevision]);
  useEffect(() => {
    let cancelled = false;
    void invoke<string | null>("chat_image_preview", { path, workingDirectory: "", threadId: sessionId })
      .catch(() => null).then(next => {
        if (!cancelled) { setUrl(next); setLoading(false); }
      });
    return () => { cancelled = true; };
  }, [path, sessionId]);
  return <button ref={tileRef} type="button" className="agent-session-images__tile"
    aria-current={current ? "true" : undefined}
    aria-label={t("chat.images.preview", { name })} onClick={() => onSelect(path, url)}>
    <span className="agent-session-images__number">#{number}</span>
    {loading ? <span role="status">{t("common.loading")}</span>
      : url ? <img src={url} alt={name} onError={() => setUrl(null)} />
        : <span>{t("chat.images.unavailable")}</span>}
    <span title={name}>{name}</span>
  </button>;
}

function SessionImageGallery({ sessionId, revision, reference, focusRevision, onClose }: {
  sessionId: string;
  revision: number;
  reference?: TerminalImageReference;
  focusRevision: number;
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
  const resolved = resolveSessionImageReference(snapshot, reference);
  const images = resolved?.images ?? orderedImagePaths([
    ...(snapshot?.paths ?? []), ...(snapshot?.observed?.flatMap(image => image.paths) ?? []),
  ]).map((path, index) => ({ path, number: index + 1 }));
  const target = resolved ? images.findIndex(image => image.number === reference?.index) : -1;
  useEffect(() => {
    setPage(target >= 0 ? Math.floor(target / PAGE_SIZE) : 0);
    setSelected(null);
  }, [snapshot, reference, focusRevision, target]);
  const pages = Math.max(1, Math.ceil(images.length / PAGE_SIZE));
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
              {reference?.index && !resolved && <p role="status">{t("agents.images.unmatched")}</p>}
              {images.length === 0 ? <p>{t("agents.images.empty")}</p>
                : <div className="agent-session-images__grid">
                  {images.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(({ path, number }, offset) =>
                    <SessionImageTile key={`${path}:${number}`} path={path} sessionId={sessionId} number={number}
                      current={target === page * PAGE_SIZE + offset} focusRevision={focusRevision}
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
    {selected && <ChatImagePreview path={selected.path} name={imageFileName(selected.path)}
      workingDirectory="" threadId={sessionId} initialUrl={selected.url ?? undefined} onClose={() => setSelected(null)} />}
  </div>, document.body);
}

export function AgentSessionImages({ sessionId, active, revision, openRevision = 0, reference }: {
  sessionId: string;
  active: boolean;
  revision: number;
  openRevision?: number;
  reference?: TerminalImageReference;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [requested, setRequested] = useState<TerminalImageReference>();
  const lastOpenRevision = useRef(openRevision);
  useEffect(() => {
    if (lastOpenRevision.current !== openRevision && active) { setRequested(reference); setOpen(true); }
    lastOpenRevision.current = openRevision;
  }, [openRevision, active, reference]);
  useEffect(() => { if (!active) setOpen(false); }, [active]);
  return <div className="agent-session-images__toolbar">
    <button type="button" className="button button--quiet" title={t("agents.images.marker")} onClick={() => { setRequested(undefined); setOpen(true); }}>
      <ImageFileIcon size={16} />{t("agents.images.title")}
    </button>
    {open && active && <SessionImageGallery key={sessionId} sessionId={sessionId} revision={revision} reference={requested} focusRevision={openRevision} onClose={() => setOpen(false)} />}
  </div>;
}
