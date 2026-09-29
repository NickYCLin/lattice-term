import { useEffect, useRef, useState } from "react";
import { REMOTE_ATTACHMENT_BYTES, REMOTE_ATTACHMENT_CHUNK, remoteThreadActivity, remoteThreadCard, type RemoteActivity, type RemoteChatOperation, type RemoteChatResponse, type RemoteChatThread, type RemoteChatPage } from "../../app/remoteChat";
import { CloseIcon, ImageFileIcon, PlusIcon, RefreshIcon } from "../icons";
import { useI18n } from "../../i18n/context";
import "./RemoteChatPane.css";

interface PickedImage { key: string; preview: string; data: string; bytes: number }
const MAX_IMAGES = 4;
/** Screenshots are shrunk to a readable JPEG so they upload quickly over the relay. */
async function readImage(file: File): Promise<PickedImage> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Cannot read the image.");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const url = canvas.toDataURL("image/jpeg", 0.82);
  const data = url.slice(url.indexOf(",") + 1);
  const bytes = Math.floor(data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
  if (bytes > REMOTE_ATTACHMENT_BYTES) throw new Error("The image is too large.");
  return { key: crypto.randomUUID(), preview: url, data, bytes };
}

export function RemoteChatPane({ sessionId, hidden }: { sessionId: string; hidden: boolean }) {
  const { t } = useI18n();
  const [threads, setThreads] = useState<RemoteChatThread[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState<RemoteChatPage | null>(null);
  const [before, setBefore] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [images, setImages] = useState<PickedImage[]>([]);
  const [uploading, setUploading] = useState<{ index: number; percent: number } | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const alive = useRef(true);
  const serial = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function request(operation: RemoteChatOperation) {
    const { invoke } = await import("@tauri-apps/api/core");
    const response = await invoke<RemoteChatResponse>("remote_chat_request", { sessionId, request: { id: crypto.randomUUID(), operation } });
    if (response.error) throw new Error(response.error);
    return response.value;
  }
  useEffect(() => {
    if (hidden) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const version = ++serial.current;
    async function poll() {
      try {
        const result = await request(selected ? { kind: "read", threadId: selected, before } : { kind: "list" });
        if (stopped || serial.current !== version) return;
        if (selected) setPage(result as RemoteChatPage); else setThreads(result as RemoteChatThread[]);
      } catch (error) { if (!stopped) setProblem(String(error)); }
      if (!stopped) timer = setTimeout(() => { void poll(); }, 1200);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
    // The transport belongs to this mounted session; request has no mutable dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, hidden, selected, before, refresh]);
  useEffect(() => { setImages([]); }, [selected]);
  async function pick(files: FileList | null) {
    const chosen = Array.from(files ?? []).slice(0, MAX_IMAGES - images.length);
    if (!chosen.length) return;
    setProblem(null);
    try {
      const read = await Promise.all(chosen.map(readImage));
      if (alive.current) setImages(value => [...value, ...read].slice(0, MAX_IMAGES));
    } catch { if (alive.current) setProblem(t("remote.chat.imageUnreadable")); }
  }
  /** Uploads every picked image in pieces, then sends them with the message. */
  async function sendWithImages(threadId: string, text: string) {
    if (busy || hidden) return;
    setBusy(true); setProblem(null);
    const ids: string[] = [];
    try {
      for (const [index, image] of images.entries()) {
        const uploadId = crypto.randomUUID();
        for (let start = 0; start < image.data.length; start += REMOTE_ATTACHMENT_CHUNK) {
          const operation: RemoteChatOperation = { kind: "attach", threadId, uploadId, offset: start / 4 * 3, total: image.bytes, data: image.data.slice(start, start + REMOTE_ATTACHMENT_CHUNK) };
          // One retry: the host ignores a piece it already stored.
          await request(operation).catch(() => request(operation));
          if (!alive.current) return;
          setUploading({ index, percent: Math.min(100, Math.round((start + REMOTE_ATTACHMENT_CHUNK) / image.data.length * 100)) });
        }
        ids.push(uploadId);
      }
    } catch {
      if (alive.current) { setProblem(t("remote.chat.imageFailed")); setUploading(null); setBusy(false); }
      return;
    }
    setUploading(null); setBusy(false);
    if (await act({ kind: "send", threadId, text, attachments: ids }) && alive.current) setImages([]);
  }
  async function act(operation: RemoteChatOperation): Promise<boolean> {
    if (busy || hidden) return false;
    setBusy(true); setProblem(null);
    try {
      const result = await request(operation);
      if (!alive.current) return false;
      if (operation.kind === "send" || operation.kind === "steer") setDrafts(value => value[operation.threadId] === operation.text ? { ...value, [operation.threadId]: "" } : value);
      if (operation.kind === "create") { setSelected((result as RemoteChatThread).id); setPage(null); }
      setBefore(null); setRefresh(value => value + 1);
      return true;
    } catch (error) { if (alive.current) setProblem(String(error)); return false; }
    finally { if (alive.current) setBusy(false); }
  }
  const draft = selected ? drafts[selected] ?? "" : "";
  const current = page?.thread.id === selected ? page : null;
  const heading = current ? remoteThreadCard(current.thread, t("remote.chat.untitled"), t("terminal.model.pending")) : null;
  return <section className="remote-chat-pane" hidden={hidden} aria-label={t("remote.chat.title")}>
    <header className="remote-pane-header">
      {selected ? <button className="button button--secondary button--sm" onClick={() => { setSelected(null); setPage(null); setBefore(null); setProblem(null); }}>{t("remote.chat.sessions")}</button> : <strong>{t("remote.chat.title")}</strong>}
      {selected && current && <button className="button button--secondary button--sm remote-pane-header__new" disabled={busy} title={t("remote.chat.new")} aria-label={t("remote.chat.new")} onClick={() => { void act({ kind: "create", templateId: selected }); }}><PlusIcon size={14} />{t("remote.chat.newShort")}</button>}
      <button className="button button--secondary button--sm remote-pane-header__icon" aria-label={t("remote.chat.refresh")} title={t("remote.chat.refresh")} onClick={() => { setProblem(null); setBefore(null); setRefresh(value => value + 1); }}><RefreshIcon size={15} /></button>
    </header>
    {problem && <p role="alert">{problem}</p>}
    {!selected ? <div className="remote-chat-list">
      <p className="muted">{t("remote.chat.hint")}</p>
      {threads.length === 0 && <p>{t("remote.chat.empty")}</p>}
      {threads.map(thread => {
        const card = remoteThreadCard(thread, t("remote.chat.untitled"), t("terminal.model.pending"));
        return <button className="remote-chat-thread" key={thread.id} onClick={() => { setSelected(thread.id); setPage(null); setBefore(null); setProblem(null); }}>
          <strong className="remote-chat-thread__title">{card.title}</strong>{card.detail && <span>{card.detail}</span>}
          {thread.directory && <span className="remote-card-path">{t("remote.cli.folder", { path: thread.directory })}</span>}
          <span className="remote-card-meta"><ActivityPill activity={remoteThreadActivity(thread)} />{card.place && <small>{card.place}</small>}</span>
        </button>;
      })}
    </div> : current ? <>
      <div className="remote-chat-heading"><strong>{heading!.title}</strong><small>{heading!.detail}</small>{current.thread.directory && <small className="remote-chat-heading__path">{t("remote.cli.folder", { path: current.thread.directory })}</small>}</div>
      <div className="remote-chat-messages" aria-label={t("remote.chat.messages")}>
        {current.before && <button className="button button--secondary button--sm remote-chat-page" onClick={() => setBefore(current.before)}>{t("remote.chat.older")}</button>}
        {before && <button className="button button--secondary button--sm remote-chat-page" onClick={() => setBefore(null)}>{t("remote.chat.latest")}</button>}
        {current.items.map(item => <article className={`remote-chat-message remote-chat-message--${item.type}`} key={item.id}>
          <small>{t(`remote.chat.item.${item.type}`)}</small><pre>{item.text}</pre>
          {item.truncated && <small>{t("remote.chat.truncated")}</small>}
          {item.pending && item.requestId && current.thread.runningTurnId && !item.truncated && <div className="remote-chat-actions">
            {[false, true].map(allow => <button key={String(allow)} className={allow ? "button button--primary button--sm" : "button button--secondary button--sm"} disabled={busy} onClick={() => { void act({ kind: "respond", threadId: selected, turnId: current.thread.runningTurnId!, requestId: item.requestId!, allow }); }}>{allow ? t("remote.chat.approve") : t("remote.chat.deny")}</button>)}
          </div>}
        </article>)}
      </div>
      <form className="remote-chat-composer" onSubmit={event => {
        event.preventDefault();
        if ((!draft.trim() && !images.length) || busy || hidden || new TextEncoder().encode(draft).length > 16384) return;
        if (current.thread.runningTurnId) {
          if (current.thread.canSteer && draft.trim()) void act({ kind: "steer", threadId: selected, turnId: current.thread.runningTurnId, text: draft });
        } else if (images.length) void sendWithImages(selected, draft);
        else void act({ kind: "send", threadId: selected, text: draft });
      }}>
        {images.length > 0 && <ul className="remote-chat-images" aria-label={t("remote.chat.images")}>
          {images.map((image, index) => <li key={image.key}>
            <img src={image.preview} alt={t("remote.chat.imageLabel", { index: index + 1 })} />
            <button type="button" disabled={busy} aria-label={t("remote.chat.removeImage")} title={t("remote.chat.removeImage")} onClick={() => setImages(value => value.filter(item => item.key !== image.key))}><CloseIcon size={12} /></button>
          </li>)}
        </ul>}
        {uploading && <p role="status" className="muted remote-chat-uploading">{t("remote.chat.uploading", { current: uploading.index + 1, count: images.length, percent: uploading.percent })}</p>}
        <textarea className="input" aria-label={t("remote.chat.message")} placeholder={t("remote.chat.message")} rows={2} maxLength={16384} value={draft} onChange={e => setDrafts(value => ({ ...value, [selected]: e.target.value }))} />
        <div className="remote-chat-actions"><span role="status" className="remote-chat-status"><ActivityPill activity={remoteThreadActivity(current.thread)} /></span>
          <input ref={picker} type="file" accept="image/*" multiple hidden onChange={event => { void pick(event.target.files); event.target.value = ""; }} />
          {!current.thread.runningTurnId && <button type="button" className="button button--secondary button--sm remote-chat-attach" disabled={busy || images.length >= MAX_IMAGES} title={t("remote.chat.attachImage")} onClick={() => picker.current?.click()}><ImageFileIcon size={15} />{t("remote.chat.attachImage")}</button>}
          {current.thread.runningTurnId && <button type="button" className="button button--secondary button--sm" disabled={busy} onClick={() => { void act({ kind: "stop", threadId: selected, turnId: current.thread.runningTurnId! }); }}>{t("remote.chat.stop")}</button>}
          {(!current.thread.runningTurnId || current.thread.canSteer) && <button type="submit" className="button button--primary button--sm" disabled={busy || (!draft.trim() && (current.thread.runningTurnId !== null || !images.length)) || new TextEncoder().encode(draft).length > 16384}>{current.thread.runningTurnId ? t("chat.steer.send") : t("remote.chat.send")}</button>}
        </div>
      </form>
    </> : <p role="status">{t("remote.chat.loading")}</p>}
  </section>;
}

function ActivityPill({ activity }: { activity: RemoteActivity }) {
  const { t } = useI18n();
  const label = activity === "needsAttention" ? t("remote.chat.awaitingApproval") : activity === "working" ? t("remote.chat.running") : t("remote.chat.idle");
  return <span className={`remote-cli-state remote-cli-state--${activity}`}>{label}</span>;
}
