import { useEffect, useMemo, useState } from "react";
import type { RemoteApi, RemoteSessionSummary } from "../../app/useRemoteSessions";
import type { ThemeId } from "../../app/themes";
import { RemoteCliChannel, requestRemoteCli, type RemoteCliOutput, type RemoteCliSession } from "../../app/remoteCli";
import { useI18n } from "../../i18n/context";
import { RemoteTerminalView } from "./RemoteTerminalView";
import "./RemoteCliPane.css";

export function RemoteCliPane({ session, theme, active = true }: { session: RemoteSessionSummary; theme: ThemeId; active?: boolean }) {
  const { t } = useI18n();
  const [sessions, setSessions] = useState<RemoteCliSession[]>([]);
  const [selected, setSelected] = useState<RemoteCliSession | null>(null);
  const [problem, setProblem] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [generation, refresh] = useState(0);
  useEffect(() => {
    if (!active || !session.cli || selected) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const items = await requestRemoteCli<RemoteCliSession[]>(session.sessionId, { kind: "cliList" });
        if (!stopped) { setSessions(items); setProblem(false); setLoaded(true); }
      } catch { if (!stopped) setProblem(true); }
      if (!stopped) timer = setTimeout(() => { void poll(); }, 2000);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [active, session.sessionId, session.cli, selected, generation]);
  return <section className="remote-cli-pane" aria-label={t("remote.cli.title")}>
    <header><strong>{t("remote.cli.title")}</strong>
      {selected && <button className="button button--ghost" onClick={() => setSelected(null)}>{t("remote.cli.back")}</button>}
      <button className="button button--ghost" onClick={() => { setProblem(false); refresh(value => value + 1); }}>{t("remote.chat.refresh")}</button>
    </header>
    {!session.cli ? <p>{t("remote.cli.disabled")}</p> : selected ? active && <RemoteCliTerminal key={`${selected.id}-${generation}`} connection={session} selected={selected} theme={theme} /> : <>
      <p className="muted">{t("remote.cli.hint")}</p>
      {problem && <p role="alert">{t("remote.cli.error")}</p>}
      {!problem && <p role="status">{!loaded ? t("remote.cli.loading") : sessions.length === 0 ? t("remote.cli.empty") : ""}</p>}
      <div className="remote-chat-list">{sessions.map(item => <button key={item.id} className="remote-chat-thread" onClick={() => setSelected(item)}>
        <strong>{item.groupLabel || item.label}</strong><span>{item.label} · {item.agent}</span><small>{item.detached ? t("remote.cli.background") : t("remote.cli.desktop")}</small>
      </button>)}</div>
    </>}
  </section>;
}

function RemoteCliTerminal({ connection, selected, theme }: { connection: RemoteSessionSummary; selected: RemoteCliSession; theme: ThemeId }) {
  const { t } = useI18n();
  const [problem, setProblem] = useState(false);
  const [ready, setReady] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const channel = useMemo(() => new RemoteCliChannel(selected.id, operation => requestRemoteCli(connection.sessionId, operation), () => setProblem(true)), [connection.sessionId, selected.id]);
  const remote = useMemo(() => ({
    terminalInput: async (_id: string, data: string) => { channel.input(data); },
    terminalResize: async (_id: string, cols: number, rows: number) => { channel.resize(cols, rows); },
    onTerminalData: (_id: string, listener: (bytes: Uint8Array) => void) => {
      channel.resume();
      let stopped = false, cursor = 0;
      let timer: ReturnType<typeof setTimeout>;
      async function poll() {
        try {
          const output = await requestRemoteCli<RemoteCliOutput>(connection.sessionId, { kind: "cliRead", sessionId: selected.id, cursor });
          if (stopped) return;
          if (output.sessionId !== selected.id || output.nextCursor < output.cursor || output.cursor < cursor && !output.truncated) throw new Error("Invalid terminal cursor");
          if (output.truncated) { listener(new TextEncoder().encode("\x1bc")); setTruncated(true); }
          const bytes = Uint8Array.from(atob(output.base64), char => char.charCodeAt(0));
          if (bytes.length) listener(bytes);
          cursor = output.nextCursor;
          if (cursor >= output.endOffset) setReady(true);
          timer = setTimeout(() => { void poll(); }, cursor < output.endOffset ? 0 : 200);
        } catch { if (!stopped) { channel.stop(); setProblem(true); } }
      }
      void poll();
      return () => { stopped = true; clearTimeout(timer); channel.stop(); };
    },
  }) as unknown as RemoteApi, [channel, connection.sessionId, selected.id]);
  // Keep the terminal mounted while initial output arrives, but intercept input
  // until caught up. Toggling viewOnly would rebuild xterm and restart replay.
  const gated = useMemo(() => ({ ...remote, terminalInput: async (id: string, data: string) => { if (ready && !problem) await remote.terminalInput(id, data); } }), [remote, ready, problem]);
  return <>
    <div><strong>{selected.groupLabel || selected.label}</strong> · {selected.label}</div>
    <p role={problem ? "alert" : "status"}>{problem ? t("remote.cli.error") : ready ? t("remote.cli.ready") : t("remote.cli.loading")}</p>
    {truncated && <p className="muted">{t("remote.cli.truncated")}</p>}
    <RemoteTerminalView session={{ ...connection, sessionId: selected.id, viewOnly: false, terminal: true }} remote={gated} theme={theme} />
    <div className="remote-cli-keys">{[["Esc", "\x1b"], ["Tab", "\t"], ["Ctrl+C", "\x03"], ["↑", "\x1b[A"], ["↓", "\x1b[B"], ["Enter", "\r"]].map(([label, value]) => <button className="button button--ghost" key={label} disabled={!ready || problem} onClick={() => channel.input(value)}>{label}</button>)}</div>
  </>;
}
