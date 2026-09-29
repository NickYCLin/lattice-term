import { useEffect, useRef, useState } from "react";
import { remoteThreadActivity, remoteThreadCard, type RemoteActivity, type RemoteChatOperation, type RemoteChatResponse, type RemoteChatThread, type RemoteChatPage } from "../../app/remoteChat";
import { PlusIcon, RefreshIcon } from "../icons";
import { useI18n } from "../../i18n/context";
import "./RemoteChatPane.css";

export function RemoteChatPane({ sessionId, hidden }: { sessionId: string; hidden: boolean }) {
  const { t } = useI18n();
  const [threads, setThreads] = useState<RemoteChatThread[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState<RemoteChatPage | null>(null);
  const [before, setBefore] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
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
  async function act(operation: RemoteChatOperation) {
    if (busy || hidden) return;
    setBusy(true); setProblem(null);
    try {
      const result = await request(operation);
      if (!alive.current) return;
      if (operation.kind === "send" || operation.kind === "steer") setDrafts(value => value[operation.threadId] === operation.text ? { ...value, [operation.threadId]: "" } : value);
      if (operation.kind === "create") { setSelected((result as RemoteChatThread).id); setPage(null); }
      setBefore(null); setRefresh(value => value + 1);
    } catch (error) { if (alive.current) setProblem(String(error)); }
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
          <strong className="remote-chat-thread__title">{card.title}</strong><span>{card.detail}</span>
          <span className="remote-card-meta"><ActivityPill activity={remoteThreadActivity(thread)} />{card.place && <small>{card.place}</small>}</span>
        </button>;
      })}
    </div> : current ? <>
      <div className="remote-chat-heading"><strong>{heading!.title}</strong><small>{heading!.detail}</small>{heading!.place && <small className="remote-chat-heading__path" title={current.thread.directory}>{heading!.place}</small>}</div>
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
        if (!draft.trim() || busy || hidden || new TextEncoder().encode(draft).length > 16384) return;
        if (current.thread.runningTurnId) {
          if (current.thread.canSteer) void act({ kind: "steer", threadId: selected, turnId: current.thread.runningTurnId, text: draft });
        } else void act({ kind: "send", threadId: selected, text: draft });
      }}>
        <textarea className="input" aria-label={t("remote.chat.message")} placeholder={t("remote.chat.message")} rows={2} maxLength={16384} value={draft} onChange={e => setDrafts(value => ({ ...value, [selected]: e.target.value }))} />
        <div className="remote-chat-actions"><span role="status" className="remote-chat-status"><ActivityPill activity={remoteThreadActivity(current.thread)} /></span>
          {current.thread.runningTurnId && <button type="button" className="button button--secondary button--sm" disabled={busy} onClick={() => { void act({ kind: "stop", threadId: selected, turnId: current.thread.runningTurnId! }); }}>{t("remote.chat.stop")}</button>}
          {(!current.thread.runningTurnId || current.thread.canSteer) && <button type="submit" className="button button--primary button--sm" disabled={busy || !draft.trim() || new TextEncoder().encode(draft).length > 16384}>{current.thread.runningTurnId ? t("chat.steer.send") : t("remote.chat.send")}</button>}
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
