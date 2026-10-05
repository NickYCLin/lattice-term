import { useEffect, useMemo, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import type { RemoteApi, RemoteSessionSummary } from "../../app/useRemoteSessions";
import type { ThemeId } from "../../app/themes";
import { RemoteCliChannel, remoteCliCard, requestRemoteCli, type RemoteCliOperation, type RemoteCliOutput, type RemoteCliSession } from "../../app/remoteCli";
import { REMOTE_ATTACHMENT_CHUNK } from "../../app/remoteChat";
import { displayPath } from "../../app/displayPath";
import { ImageFileIcon, KeyboardIcon, RefreshIcon } from "../icons";
import { useI18n } from "../../i18n/context";
import { RemoteTerminalView } from "./RemoteTerminalView";
import { readRemoteImage, type PickedImage } from "./remoteImage";
import "./RemoteCliPane.css";

const CLI_STATES = ["working", "needsAttention", "idle", "done"] as const;
type CliState = (typeof CLI_STATES)[number];
function isCliState(state: string): state is CliState {
  return (CLI_STATES as readonly string[]).includes(state);
}

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
    <header className="remote-pane-header">
      {selected ? <button className="button button--secondary button--sm" onClick={() => setSelected(null)}>{t("remote.cli.back")}</button> : <strong>{t("remote.cli.title")}</strong>}
      <button className="button button--secondary button--sm remote-pane-header__icon" aria-label={t("remote.chat.refresh")} title={t("remote.chat.refresh")} onClick={() => { setProblem(false); refresh(value => value + 1); }}><RefreshIcon size={15} /></button>
    </header>
    {!session.cli ? <p>{t("remote.cli.disabled")}</p> : selected ? active && <RemoteCliTerminal key={`${selected.id}-${generation}`} connection={session} selected={selected} theme={theme} /> : <>
      <p className="muted">{t("remote.cli.hint")}</p>
      {problem && <p role="alert">{t("remote.cli.error")}</p>}
      {!problem && <p role="status">{!loaded ? t("remote.cli.loading") : sessions.length === 0 ? t("remote.cli.empty") : ""}</p>}
      {sessions.length > 0 && sessions.every(item => item.directory === undefined && item.project === undefined) && <p className="remote-host-outdated">{t("remote.cli.hostOutdated")}</p>}
      <div className="remote-chat-list">{sessions.map(item => {
        const card = remoteCliCard(item, t("terminal.model.pending"));
        return <button key={item.id} className="remote-chat-thread" onClick={() => setSelected(item)}>
          <strong>{card.title}</strong>{card.detail && <span>{card.detail}</span>}
          {(item.directory || item.project) && <span className="remote-card-path">{t("remote.cli.folder", { path: displayPath(item.directory || item.project || "") })}</span>}
          <span className="remote-card-meta">
            {isCliState(item.state) && <span className={`remote-cli-state remote-cli-state--${item.state}`}>{t(`agents.state.${item.state}`)}</span>}
            <small>{[card.place, item.detached ? t("remote.cli.background") : t("remote.cli.desktop")].filter(Boolean).join(" · ")}</small>
          </span>
        </button>;
      })}</div>
    </>}
  </section>;
}

function RemoteCliTerminal({ connection, selected, theme }: { connection: RemoteSessionSummary; selected: RemoteCliSession; theme: ThemeId }) {
  const { t } = useI18n();
  const [problem, setProblem] = useState(false);
  const [ready, setReady] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const terminal = useRef<Terminal | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [image, setImage] = useState<{ state: "uploading"; percent: number } | { state: "sent" | "failed" | "unreadable" } | null>(null);
  const channel = useMemo(() => new RemoteCliChannel(selected.id, operation => requestRemoteCli(connection.sessionId, operation), () => setProblem(true)), [connection.sessionId, selected.id]);
  const remote = useMemo(() => ({
    terminalInput: async (_id: string, data: string) => { channel.input(data); },
    terminalResize: async (_id: string, cols: number, rows: number) => { channel.resize(cols, rows); },
    onTerminalData: (_id: string, listener: (bytes: Uint8Array) => void) => {
      channel.resume();
      let stopped = false, cursor = 0, polled = Date.now();
      let timer: ReturnType<typeof setTimeout>;
      async function poll() {
        try {
          if (Date.now() - polled > 3000) channel.reclaimSize();
          const output = await requestRemoteCli<RemoteCliOutput>(connection.sessionId, { kind: "cliRead", sessionId: selected.id, cursor });
          polled = Date.now();
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
  const card = remoteCliCard(selected, t("terminal.model.pending"));
  const gated = useMemo(() => ({ ...remote, terminalInput: async (id: string, data: string) => { if (ready && !problem) await remote.terminalInput(id, data); } }), [remote, ready, problem]);
  const uploading = image?.state === "uploading";
  async function sendImage(file: File) {
    let picked: PickedImage;
    try { picked = await readRemoteImage(file); } catch { setImage({ state: "unreadable" }); return; }
    setImage({ state: "uploading", percent: 0 });
    try {
      await channel.settle();
      const uploadId = crypto.randomUUID();
      const bracketed = terminal.current?.modes.bracketedPasteMode ?? false;
      for (let start = 0; start < picked.data.length; start += REMOTE_ATTACHMENT_CHUNK) {
        const operation: RemoteCliOperation = { kind: "cliAttach", sessionId: selected.id, uploadId, offset: start / 4 * 3, total: picked.bytes, data: picked.data.slice(start, start + REMOTE_ATTACHMENT_CHUNK), bracketed };
        // The host ignores a piece it already has, so one resend is safe.
        try { await requestRemoteCli(connection.sessionId, operation); }
        catch { await requestRemoteCli(connection.sessionId, operation); }
        setImage({ state: "uploading", percent: Math.min(100, Math.round((start + REMOTE_ATTACHMENT_CHUNK) / picked.data.length * 100)) });
      }
      setImage({ state: "sent" });
    } catch { setImage({ state: "failed" }); }
  }
  return <>
    <div className="remote-cli-heading"><strong>{card.title}</strong>{card.detail && <small>{card.detail}</small>}
      {(selected.directory || selected.project) && <small className="remote-cli-heading__path" title={displayPath(selected.directory || selected.project || "")}>{t("remote.cli.folder", { path: displayPath(selected.directory || selected.project || "") })}</small>}
    </div>
    <p className="muted" role={problem ? "alert" : "status"}>{problem ? t("remote.cli.error") : ready ? t("remote.cli.ready") : t("remote.cli.loading")}</p>
    {truncated && <p className="muted">{t("remote.cli.truncated")}</p>}
    {image && <p className={image.state === "failed" || image.state === "unreadable" ? "remote-cli-image remote-cli-image--problem" : "remote-cli-image muted"} role={image.state === "failed" || image.state === "unreadable" ? "alert" : "status"}>{
      image.state === "uploading" ? t("remote.cli.imageUploading", { percent: String(image.percent) })
        : image.state === "sent" ? t("remote.cli.imageSent")
        : image.state === "unreadable" ? t("remote.chat.imageUnreadable") : t("remote.cli.imageFailed")
    }</p>}
    <RemoteTerminalView session={{ ...connection, sessionId: selected.id, viewOnly: false, terminal: true }} remote={gated} theme={theme} terminalRef={terminal} />
    {/* Keep the software keyboard up while tapping helper keys. */}
    <div className="remote-cli-keys" role="toolbar" aria-label={t("remote.cli.keys")} onPointerDown={event => event.preventDefault()}>
      <button type="button" className="button button--primary button--sm remote-cli-keys__keyboard" disabled={!ready || problem} title={t("terminal.keybar.keyboard")} aria-label={t("terminal.keybar.keyboard")} onClick={() => {
        const current = terminal.current;
        if (current?.textarea && current.textarea === document.activeElement) current.blur(); else current?.focus();
      }}><KeyboardIcon size={18} /></button>
      <button type="button" className="button button--secondary button--sm" disabled={!ready || problem || uploading} title={t("remote.cli.image")} aria-label={t("remote.cli.image")} onClick={() => picker.current?.click()}><ImageFileIcon size={18} /></button>
      <input ref={picker} type="file" accept="image/*" hidden onChange={event => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) void sendImage(file);
      }} />
      {[["Esc", "\x1b"], ["Tab", "\t"], ["Ctrl+C", "\x03"], ["↑", "\x1b[A"], ["↓", "\x1b[B"], ["Enter", "\r"]].map(([label, value]) => <button type="button" className="button button--secondary button--sm" key={label} disabled={!ready || problem} onClick={() => channel.input(value)}>{label}</button>)}
    </div>
  </>;
}
