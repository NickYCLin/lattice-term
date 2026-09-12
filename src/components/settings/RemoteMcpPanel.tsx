import { useCallback, useEffect, useState } from "react";
import {
  addExecPlan,
  clampExecTimeout,
  execPlanRequests,
  DEFAULT_EXEC_TIMEOUT_SECONDS,
  MAX_EXEC_PLANS,
  MAX_EXEC_TIMEOUT_SECONDS,
  MIN_EXEC_TIMEOUT_SECONDS,
  removeExecPlan,
  type RemoteExecPlan,
} from "../../app/remoteExecPlans";
import { useI18n } from "../../i18n/context";
import "./RemoteMcpPanel.css";

type Scope = "metrics" | "list" | "exec" | "upload" | "download" | "screen" | "input";
type Scopes = Record<Scope, boolean>;
const scopesOff: Scopes = { metrics: false, list: false, exec: false, upload: false, download: false, screen: false, input: false };
type Backend = "ssh" | "sftp" | "rdp" | "vnc" | "remote";
const screenBackends: Backend[] = ["rdp", "vnc", "remote"];
interface Session { sessionId: string; host: string; backend: Backend }

interface Target { id: string; label: string; backend: string; scopes: Scopes; connected: boolean }

export function RemoteMcpPanel({ available }: { available: boolean }) {
  const { t } = useI18n();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [targets, setTargets] = useState<Target[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<Scopes>({ ...scopesOff });
  const [plans, setPlans] = useState<RemoteExecPlan[]>([]);
  const [command, setCommand] = useState("");
  const [commandLabel, setCommandLabel] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState(DEFAULT_EXEC_TIMEOUT_SECONDS);
  const [remoteRoot, setRemoteRoot] = useState("");
  const [localRoot, setLocalRoot] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selected = sessions.find((session) => session.sessionId === sessionId);
  const isScreen = !!selected && screenBackends.includes(selected.backend);
  const fileScope = scopes.list || scopes.upload || scopes.download;
  const transferScope = scopes.upload || scopes.download;

  const refresh = useCallback(async () => {
    if (!available) return;
    const { invoke } = await import("@tauri-apps/api/core");
    const [ssh, sftp, screens, next] = await Promise.all([
      invoke<Omit<Session, "backend">[]>("ssh_sessions"),
      invoke<Omit<Session, "backend">[]>("sftp_sessions"),
      invoke<Session[]>("mcp_screen_sessions"),
      invoke<Target[]>("mcp_remote_targets"),
    ]);
    setSessions([
      ...ssh.map((s) => ({ ...s, backend: "ssh" as const })),
      ...sftp.map((s) => ({ ...s, backend: "sftp" as const })),
      ...screens,
    ]);
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
        execPlans: scopes.exec ? execPlanRequests(plans) : [],
        roots: fileScope ? [{ id: "files", label: t("settings.mcpRemote.root"), remotePath: remoteRoot, localPath: transferScope ? localRoot : null }] : [],
      } }));
      setScopes({ ...scopesOff }); setAcknowledged(false); setPlans([]);
      setCommand(""); setCommandLabel(""); setTimeoutSeconds(DEFAULT_EXEC_TIMEOUT_SECONDS);
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
  const addPlan = () => {
    const next = addExecPlan(plans, { label: commandLabel, command, timeoutSeconds });
    if (next === plans) return;
    setPlans(next);
    setCommand(""); setCommandLabel(""); setTimeoutSeconds(DEFAULT_EXEC_TIMEOUT_SECONDS);
    setAcknowledged(false);
  };
  const removePlan = (id: string) => {
    setPlans((current) => removeExecPlan(current, id));
    setAcknowledged(false);
  };
  const canGrant = !!selected && !!label.trim() && Object.values(scopes).some(Boolean) && acknowledged
    && (!scopes.input || scopes.screen) && (!scopes.exec || plans.length > 0) && (!fileScope || !!remoteRoot.trim()) && (!transferScope || !!localRoot.trim());

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
              <input type="checkbox" checked={scopes[scope]} disabled={
                isScreen ? scope !== "screen" && scope !== "input"
                : scope === "screen" || scope === "input" ? true
                : selected?.backend === "sftp" ? scope === "metrics" || scope === "exec"
                : scope === "list" || scope === "upload" || scope === "download"}
                onChange={(e) => { setScopes((current) => ({ ...current, [scope]: e.target.checked, ...(scope === "input" && e.target.checked ? { screen: true } : {}), ...(scope === "screen" && !e.target.checked ? { input: false } : {}) })); setAcknowledged(false); }} /> {t(`settings.mcpRemote.scope.${scope}`)}
            </label>)}
          </fieldset>
          {scopes.input && <p className="setting__description">{t("settings.mcpRemote.inputHint")}</p>}
          {scopes.screen && <p className="setting__description">{t("settings.mcpRemote.screenHint")}</p>}
          {scopes.exec && <fieldset disabled={busy} className="mcp-remote__plans">
            <legend>{t("settings.mcpRemote.command")}</legend>
            <span className="setting__description">{t("settings.mcpRemote.commandHint")}</span>
            {plans.length > 0 && <ul className="mcp-remote__plan-list">
              {plans.map((plan) => <li key={plan.id}>
                <div><strong>{plan.label}</strong> <span className="mono">{plan.id}</span>
                  <span> · {t("settings.mcpRemote.timeoutValue", { seconds: plan.timeoutSeconds })}</span>
                  <p className="mono">{plan.command}</p></div>
                <button type="button" className="button button--ghost" onClick={() => removePlan(plan.id)}>
                  {t("settings.mcpRemote.removeCommand")}</button>
              </li>)}
            </ul>}
            {plans.length >= MAX_EXEC_PLANS ? <p>{t("settings.mcpRemote.commandLimit", { count: MAX_EXEC_PLANS })}</p> : <>
              <label className="field"><span className="field__label">{t("settings.mcpRemote.commandLabel")}</span>
                <input className="input" value={commandLabel} maxLength={128} onChange={(e) => setCommandLabel(e.target.value)} autoComplete="off" /></label>
              <label className="field"><span className="field__label">{t("settings.mcpRemote.commandText")}</span>
                <textarea className="input mono" value={command} maxLength={8192} rows={3} onChange={(e) => setCommand(e.target.value)} /></label>
              <label className="field"><span className="field__label">{t("settings.mcpRemote.timeout")}</span>
                <input className="input" type="number" min={MIN_EXEC_TIMEOUT_SECONDS} max={MAX_EXEC_TIMEOUT_SECONDS}
                  value={timeoutSeconds} onChange={(e) => setTimeoutSeconds(clampExecTimeout(Number(e.target.value)))} /></label>
              <div><button type="button" className="button" disabled={!command.trim() || !commandLabel.trim()} onClick={addPlan}>
                {t("settings.mcpRemote.addCommand")}</button></div>
            </>}
          </fieldset>}
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
