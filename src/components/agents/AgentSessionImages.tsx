import { imagePreviewProblem, type ImageProblem } from "../../app/chatImagePreview";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/context";
import { imageFileName, orderedImagePaths } from "../../app/chatImages";
import { ChatImagePreview } from "../chat/ChatImagePreview";
import type { TerminalImageReference } from "../terminal/terminalImageLinks";
import { ImageFileIcon } from "../icons";

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

function SessionImageTile({ path, sessionId, number, current, onSelect }: {
  path: string;
  sessionId: string;
  number: number;
  current: boolean;
  onSelect: (url: string | null) => void;
}) {
  const { t } = useI18n();
  const [url, setUrl] = useState<string | null>(null);
  const [problem, setProblem] = useState<ImageProblem>("chat.images.unavailable");
  const [loading, setLoading] = useState(true);
  const tileRef = useRef<HTMLButtonElement>(null);
  const name = imageFileName(path);
  useEffect(() => {
    if (current) tileRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [current]);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void invoke<string | null>("chat_image_preview", { path, workingDirectory: "", threadId: sessionId })
        .catch(error => { if (!cancelled) setProblem(imagePreviewProblem(error)); return null; }).then(next => { if (!cancelled) { setUrl(next); setLoading(false); } });
    };
    let observer: IntersectionObserver | undefined;
    if (typeof IntersectionObserver === "undefined") load();
    else {
      observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); load(); }
      });
      if (tileRef.current) observer.observe(tileRef.current);
    }
    return () => { cancelled = true; observer?.disconnect(); };
  }, [path, sessionId]);
  return <button ref={tileRef} type="button" className="agent-session-images__tile"
    aria-current={current ? "true" : undefined}
    aria-label={t("chat.images.preview", { name })} title={name}
    onClick={event => { event.currentTarget.focus({ preventScroll: true }); onSelect(url); }}>
    <span className="agent-session-images__number">#{number}</span>
    {loading ? <span role="status">{t("common.loading")}</span>
      : url ? <img src={url} alt={name} onError={() => setUrl(null)} />
        : <span>{t(problem)}</span>}
  </button>;
}

export function AgentSessionImages({ sessionId, active, revision, openRevision = 0, reference }: {
  sessionId: string;
  active: boolean;
  revision: number;
  openRevision?: number;
  reference?: TerminalImageReference;
}) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<SessionImagesSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [requested, setRequested] = useState<TerminalImageReference>();
  const [current, setCurrent] = useState<number | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [initialUrl, setInitialUrl] = useState<string | undefined>();
  const lastOpenRevision = useRef(openRevision);
  useEffect(() => {
    if (!active) { setSnapshot(null); setViewerOpen(false); setCurrent(null); setRequested(undefined); return; }
    let cancelled = false;
    setLoading(true); setError(null); setViewerOpen(false);
    void invoke<SessionImagesSnapshot>("agent_session_images_snapshot", { sessionId }).then(next => {
      if (cancelled) return;
      setSnapshot(next);
      const wantsOpen = lastOpenRevision.current !== openRevision;
      lastOpenRevision.current = openRevision;
      if (wantsOpen) {
        setRequested(reference);
        const resolved = resolveSessionImageReference(next, reference);
        const index = resolved?.images.findIndex(image => image.number === reference?.index) ?? -1;
        setCurrent(index >= 0 ? index : null); setInitialUrl(undefined); setViewerOpen(index >= 0);
      } else { setCurrent(null); }
    }).catch(reason => { if (!cancelled) setError(String(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // A marker request is identified by its revision, not by object identity.
  }, [sessionId, active, revision, refresh, openRevision]);
  const resolved = resolveSessionImageReference(snapshot, requested);
  const images = resolved?.images ?? orderedImagePaths([
    ...(snapshot?.paths ?? []), ...(snapshot?.observed?.flatMap(image => image.paths) ?? []),
  ]).map((path, index) => ({ path, number: index + 1 }));
  const selected = current === null ? undefined : images[current];
  const move = (offset: number) => {
    setInitialUrl(undefined);
    setCurrent(index => index === null ? null : Math.max(0, Math.min(images.length - 1, index + offset)));
  };
  if (!active) return null;
  return <section className="agent-session-images__toolbar" aria-label={t("agents.images.title")}>
    <header><span><ImageFileIcon size={16} />{t("agents.images.title")} · {images.length}</span>
      {resolved && <button type="button" className="button button--quiet" onClick={() => {
        setRequested(undefined); setViewerOpen(false); setCurrent(null);
      }}>{t("agents.images.all")}</button>}
      <button type="button" className="button button--quiet" disabled={loading}
        onClick={() => setRefresh(value => value + 1)}>{t("agents.images.refresh")}</button>
    </header>
    {loading && <span role="status">{t("agents.images.loading")}</span>}
    {error && <div role="alert">{t("agents.images.failed")}<pre>{error}</pre></div>}
    {snapshot && <>
      {!snapshot.historyAvailable && <p role="status">{t("agents.images.waiting")}</p>}
      {snapshot.truncated && <p role="status">{t("agents.images.limited")}</p>}
      {requested?.index && !resolved && <p role="status">{t("agents.images.unmatched")}</p>}
      {!images.length && !loading && <p>{t("agents.images.empty")}</p>}
      {!!images.length && <div className="agent-session-images__strip" aria-label={t("agents.images.title")}>
        {images.map(({ path, number }, index) => <SessionImageTile key={`${path}:${number}`} path={path}
          sessionId={sessionId} number={number} current={index === current} onSelect={url => {
            setCurrent(index); setInitialUrl(url ?? undefined); setViewerOpen(true);
          }} />)}
      </div>}
    </>}
    {viewerOpen && selected && <ChatImagePreview path={selected.path} name={imageFileName(selected.path)}
      workingDirectory="" threadId={sessionId} initialUrl={initialUrl}
      navigation={{ index: current!, total: images.length, onPrevious: () => move(-1), onNext: () => move(1) }}
      onClose={() => setViewerOpen(false)} />}
  </section>;
}
