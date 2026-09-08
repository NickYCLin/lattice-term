import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../i18n/context";
import "./RemoteMcpPanel.css";

type Scope = "metrics" | "list" | "exec" | "upload" | "download";
type Scopes = Record<Scope, boolean>;
const scopesOff: Scopes = { metrics: false, list: false, exec: false, upload: false, download: false };
interface Session { sessionId: string; host: string; backend: "ssh" | "sftp" }
interface Target { id: string; label: string; backend: string; scopes: Scopes; connected: boolean }

export function RemoteMcpPanel({ available }: { available: boolean }) {
  const { t } = useI18n();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [targets, setTargets] = useState<Target[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<Scopes>({ ...scopesOff });
  const [command, setCommand] = useState("");
  const [remoteRoot, setRemoteRoot] = useState("");
  const [localRoot, setLocalRoot] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selected = sessions.find((session) => session.sessionId === sessionId);
  const fileScope = scopes.list || scopes.upload || scopes.download;
  const transferScope = scopes.upload || scopes.download;

  const refresh = useCallback(async () => {
    if (!available) return;
    const { invoke } = await import("@tauri-apps/api/core");
    const [ssh, sftp, next] = await Promise.all([
      invoke<Omit<Session, "backend">[]>("ssh_sessions"),
      invoke<Omit<Session, "backend">[]>("sftp_sessions"),
      invoke<Target[]>("mcp_remote_targets"),
    ]);
    setSessions([...ssh.map((s) => ({ ...s, backend: "ssh" as const })), ...sftp.map((s) => ({ ...s, backend: "sftp" as const }))]);
    setTargets(next);
  }, [available]);

  useEffect(() => {
    const update = () => { void refresh().catch(() => setError(t("settings.mcpRemote.refreshFailed"))); };
    update();
    if (!available) return;
    const timer = setInterval(update, 10_000);
    return () => clearInterval(timer);
  }, [available, refresh, t]);

  const grant = async () => {
    if (!selected || busy) return;
    setBusy(true); setError("");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      setTargets(await invoke<Target[]>("mcp_remote_grant", { request: {
        sessionId, backend: selected.backend, label: label.trim(), scopes,
        execPlans: scopes.exec ? [{ id: "command", label: t("settings.mcpRemote.plan"), command, timeoutMs: 30_000 }] : [],
        roots: fileScope ? [{ id: "files", label: t("settings.mcpRemote.root"), remotePath: remoteRoot, localPath: transferScope ? localRoot : null }] : [],
      } }));
      setScopes({ ...scopesOff }); setAcknowledged(false); setCommand("");
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  const revoke = async (targetId: string) => {
    setBusy(true); setError("");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      setTargets(await invoke<Target[]>("mcp_remote_revoke", { targetId }));
    } catch (reason) { setError(String(reason)); await refresh().catch(() => {}); }
    finally { setBusy(false); }
  };
  const canGrant = !!selected && !!label.trim() && Object.values(scopes).some(Boolean) && acknowledged
    && (!scopes.exec || !!command.trim()) && (!fileScope || !!remoteRoot.trim()) && (!transferScope || !!localRoot.trim());

  return <section className="panel glass mcp-remote" aria-label={t("settings.mcpRemote.title")}>
    <header className="panel__head"><div><h2 className="panel__title">{t("settings.mcpRemote.title")}</h2>
      <p className="panel__hint">{t("settings.mcpRemote.hint")}</p></div></header>
    <div className="mcp-remote__body">
      <p>{t("settings.mcpRemote.boundary")}</p>
      {error && <p role="alert">{error}</p>}
      {targets.map((target) => <div className="setting" key={target.id}>
        <div className="setting__text"><strong>{target.label}</strong>
          <p className="mono">{target.id}</p>
          <p>{(Object.keys(scopesOff) as Scope[]).filter((scope) => target.scopes[scope]).map((scope) => t(`settings.mcpRemote.scope.${scope}`)).join(" · ")}</p>
          {!target.connected && <p>{t("settings.mcpRemote.offline")}</p>}
        </div>
        <button type="button" className="button button--danger" disabled={busy} onClick={() => void revoke(target.id)}>{t("settings.mcpRemote.revoke")}</button>
      </div>)}
      {!available ? <p>{t("settings.mcpRemote.desktopOnly")}</p> : sessions.length === 0 ? <p>{t("settings.mcpRemote.connectFirst")}</p> :
        <form className="mcp-remote__form" onSubmit={(event) => { event.preventDefault(); if (canGrant) void grant(); }}>
          <label className="field"><span className="field__label">{t("settings.mcpRemote.connection")}</span>
            <select className="input" value={sessionId} disabled={busy} onChange={(e) => { setSessionId(e.target.value); setScopes({ ...scopesOff }); setAcknowledged(false); }}>
              <option value="">{t("settings.mcpRemote.choose")}</option>
              {sessions.map((s) => <option key={s.sessionId} value={s.sessionId}>{s.backend.toUpperCase()} · {s.host}</option>)}
            </select></label>
          <label className="field"><span className="field__label">{t("settings.mcpRemote.label")}</span>
            <input className="input" value={label} maxLength={128} disabled={busy} onChange={(e) => setLabel(e.target.value)} autoComplete="off" /></label>
          <fieldset disabled={busy || !selected} className="mcp-remote__scopes"><legend>{t("settings.mcpRemote.scopes")}</legend>
            {(Object.keys(scopesOff) as Scope[]).map((scope) => <label key={scope}>
              <input type="checkbox" checked={scopes[scope]} disabled={selected?.backend === "sftp" ? scope === "metrics" || scope === "exec" : scope === "list" || scope === "upload" || scope === "download"}
                onChange={(e) => { setScopes((current) => ({ ...current, [scope]: e.target.checked })); setAcknowledged(false); }} /> {t(`settings.mcpRemote.scope.${scope}`)}
            </label>)}
          </fieldset>
          {scopes.exec && <label className="field"><span className="field__label">{t("settings.mcpRemote.command")}</span>
            <textarea className="input mono" value={command} maxLength={8192} rows={3} disabled={busy} onChange={(e) => { setCommand(e.target.value); setAcknowledged(false); }} />
            <span className="setting__description">{t("settings.mcpRemote.commandHint")}</span></label>}
          {fileScope && <label className="field"><span className="field__label">{t("settings.mcpRemote.remoteRoot")}</span>
            <input className="input mono" value={remoteRoot} disabled={busy} onChange={(e) => { setRemoteRoot(e.target.value); setAcknowledged(false); }} />
            <span className="setting__description">{t("settings.mcpRemote.pathHint")}</span></label>}
          {transferScope && <label className="field"><span className="field__label">{t("settings.mcpRemote.localRoot")}</span>
            <input className="input mono" value={localRoot} disabled={busy} onChange={(e) => { setLocalRoot(e.target.value); setAcknowledged(false); }} /></label>}
          <label><input type="checkbox" checked={acknowledged} disabled={busy} onChange={(e) => setAcknowledged(e.target.checked)} /> {t("settings.mcpRemote.acknowledge")}</label>
          <div><button type="submit" className="button button--primary" disabled={busy || !canGrant}>{t("settings.mcpRemote.grant")}</button></div>
        </form>}
    </div>
  </section>;
}
