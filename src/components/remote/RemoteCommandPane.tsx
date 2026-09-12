import { useState } from "react";
import type { RemoteSessionSummary } from "../../app/useRemoteSessions";
import { commandActive, useRemoteCommand } from "../../app/useRemoteCommand";
import { useI18n } from "../../i18n/context";
import "./RemoteCommandPane.css";

export function RemoteCommandPane({ session, hidden }: { session: RemoteSessionSummary; hidden: boolean }) {
  const { t } = useI18n();
  const command = useRemoteCommand(session.sessionId);
  const [shell, setShell] = useState<"cmd" | "powerShell">((session.commandShells ?? 0) & 2 ? "powerShell" : "cmd");
  const [text, setText] = useState("");
  const [directory, setDirectory] = useState("");
  const [seconds, setSeconds] = useState(30);
  const [busy, setBusy] = useState(false);
  const active = commandActive(command.view);
  const tooLarge = new TextEncoder().encode(text).length > 16 * 1024;
  return <aside className="remote-workspace__files remote-command-pane" hidden={hidden} aria-label={t("remote.commands.title")}>
    <strong>{t("remote.commands.title")}</strong>
    <p className="muted">{t("remote.commands.hint")}</p>
    <form onSubmit={event => {
      event.preventDefault();
      if (!command.ready || busy || active || !text.trim() || tooLarge) return;
      setBusy(true);
      void command.start({ shell, command: text, directory, timeoutSeconds: seconds }).finally(() => setBusy(false));
    }}>
      <label className="field">{t("remote.commands.shell")}
        <select className="input" value={shell} disabled={busy || active} onChange={e => setShell(e.currentTarget.value as typeof shell)}>
          {!!((session.commandShells ?? 0) & 2) && <option value="powerShell">PowerShell</option>}
          {!!((session.commandShells ?? 0) & 1) && <option value="cmd">cmd</option>}
        </select>
      </label>
      <label className="field">{t("remote.commands.directory")}
        <input className="input mono" maxLength={4096} value={directory} disabled={busy || active} placeholder={t("remote.commands.home")} onChange={e => setDirectory(e.currentTarget.value)} />
      </label>
      <label className="field">{t("remote.commands.command")}
        <textarea className="input mono remote-command-input" maxLength={16384} rows={5} spellCheck={false} value={text} disabled={busy || active} placeholder={shell === "cmd" ? "whoami && dir" : "Get-Location; Get-Process | Select-Object -First 5"} onChange={e => setText(e.currentTarget.value)} />
      </label>
      <label className="field">{t("remote.commands.timeout")}
        <select className="input" value={seconds} disabled={busy || active} onChange={e => setSeconds(Number(e.currentTarget.value))}>
          {[30, 60, 300].map(value => <option key={value} value={value}>{value} {t("remote.commands.seconds")}</option>)}
        </select>
      </label>
      <div className="remote-command-actions">
        <button className="button button--primary" type="submit" disabled={!command.ready || busy || active || !text.trim() || tooLarge}>{t("remote.commands.run")}</button>
        {active && <button className="button button--ghost" type="button" disabled={busy} onClick={() => {
          if (!command.view) return;
          setBusy(true);
          void command.cancel(command.view.id).finally(() => setBusy(false));
        }}>{t("remote.commands.stop")}</button>}
      </div>
    </form>
    {tooLarge && <p role="alert">{t("remote.commands.tooLarge")}</p>}
    {command.problem && <p role="alert">{command.problem}</p>}
    {command.view && <section className="remote-command-result" aria-label={t("remote.commands.result")}>
      <div role="status">{t(`remote.commands.state.${command.view.state}`)}{command.view.exitCode !== null && ` · ${t("remote.commands.exitCode")}: ${command.view.exitCode}`}</div>
      <small className="mono">{command.view.directory}</small>
      <pre className="remote-command-submitted">{command.view.command}</pre>
      {command.view.detail && <p role="alert">{command.view.detail}</p>}
      <label>{t("remote.commands.stdout")}</label>
      <pre tabIndex={0} aria-label={t("remote.commands.stdout")}>{command.view.stdout || "—"}</pre>
      {!!command.view.stderr && <><label>{t("remote.commands.stderr")}</label><pre className="remote-command-stderr" tabIndex={0} aria-label={t("remote.commands.stderr")}>{command.view.stderr}</pre></>}
    </section>}
  </aside>;
}
