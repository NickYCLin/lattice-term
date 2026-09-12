import { useEffect, useRef, useState } from "react";
import type { RemoteChatOperation, RemoteChatResponse, RemoteChatThread, RemoteChatPage } from "../../app/remoteChat";
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
    if (busy) return;
    setBusy(true); setProblem(null);
    try {
      const result = await request(operation);
      if (!alive.current) return;
      if (operation.kind === "send") setDrafts(value => value[operation.threadId] === operation.text ? { ...value, [operation.threadId]: "" } : value);
      if (operation.kind === "create") { setSelected((result as RemoteChatThread).id); setPage(null); }
      setBefore(null); setRefresh(value => value + 1);
    } catch (error) { if (alive.current) setProblem(String(error)); }
    finally { if (alive.current) setBusy(false); }
  }
  const draft = selected ? drafts[selected] ?? "" : "";
  const current = page?.thread.id === selected ? page : null;
  return <section className="remote-chat-pane" hidden={hidden} aria-label={t("remote.chat.title")}>
    <header><strong>{t("remote.chat.title")}</strong>
      {selected && <button className="button button--ghost" onClick={() => { setSelected(null); setPage(null); setBefore(null); setProblem(null); }}>{t("remote.chat.sessions")}</button>}
      <button className="button button--ghost" onClick={() => { setProblem(null); setBefore(null); setRefresh(value => value + 1); }}>{t("remote.chat.refresh")}</button>
    </header>
    {problem && <p role="alert">{problem}</p>}
    {!selected ? <div className="remote-chat-list">
      <p className="muted">{t("remote.chat.hint")}</p>
      {threads.length === 0 && <p>{t("remote.chat.empty")}</p>}
      {threads.map(thread => <button className="remote-chat-thread" key={thread.id} onClick={() => { setSelected(thread.id); setPage(null); setBefore(null); setProblem(null); }}>
        <strong>{thread.title || t("remote.chat.untitled")}</strong><span>{thread.agent} · {thread.runningTurnId ? t("remote.chat.running") : t("remote.chat.idle")}</span><small>{thread.directory}</small>
      </button>)}
    </div> : current ? <>
      <div className="remote-chat-heading"><strong>{current.thread.title || t("remote.chat.untitled")}</strong><small>{current.thread.agent} · {current.thread.directory}</small>
        <button className="button button--ghost" disabled={busy} onClick={() => { void act({ kind: "create", templateId: selected }); }}>{t("remote.chat.new")}</button>
      </div>
      <div className="remote-chat-messages" aria-label={t("remote.chat.messages")}>
        {current.before && <button className="button button--ghost" onClick={() => setBefore(current.before)}>{t("remote.chat.older")}</button>}
        {before && <button className="button button--ghost" onClick={() => setBefore(null)}>{t("remote.chat.latest")}</button>}
        {current.items.map(item => <article className={`remote-chat-message remote-chat-message--${item.type}`} key={item.id}>
          <small>{t(`remote.chat.item.${item.type}`)}</small><pre>{item.text}</pre>
          {item.truncated && <small>{t("remote.chat.truncated")}</small>}
          {item.pending && item.requestId && current.thread.runningTurnId && !item.truncated && <div className="remote-chat-actions">
            {[false, true].map(allow => <button key={String(allow)} className="button button--ghost" disabled={busy} onClick={() => { void act({ kind: "respond", threadId: selected, turnId: current.thread.runningTurnId!, requestId: item.requestId!, allow }); }}>{allow ? t("remote.chat.approve") : t("remote.chat.deny")}</button>)}
          </div>}
        </article>)}
      </div>
      <form className="remote-chat-composer" onSubmit={event => { event.preventDefault(); if (draft.trim() && !busy && !current.thread.runningTurnId && new TextEncoder().encode(draft).length <= 16384) void act({ kind: "send", threadId: selected, text: draft }); }}>
        <label className="field">{t("remote.chat.message")}<textarea className="input" rows={3} maxLength={16384} value={draft} onChange={e => setDrafts(value => ({ ...value, [selected]: e.target.value }))} /></label>
        <div className="remote-chat-actions"><span role="status">{current.thread.runningTurnId ? t("remote.chat.running") : t("remote.chat.idle")}</span>
          {current.thread.runningTurnId ? <button type="button" className="button button--ghost" disabled={busy} onClick={() => { void act({ kind: "stop", threadId: selected, turnId: current.thread.runningTurnId! }); }}>{t("remote.chat.stop")}</button> : <button type="submit" className="button button--primary" disabled={busy || !draft.trim() || new TextEncoder().encode(draft).length > 16384}>{t("remote.chat.send")}</button>}
        </div>
      </form>
    </> : <p role="status">{t("remote.chat.loading")}</p>}
  </section>;
}
