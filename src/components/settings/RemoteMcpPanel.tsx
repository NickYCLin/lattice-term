import { useCallback, useEffect, useState } from "react";
import type { ConnectionProfile } from "../../domain/connection";
import { useI18n } from "../../i18n/context";
import { remoteScopesOff, type RemoteScope, type RemoteScopes } from "../../app/mcpRemoteScopes";
import "./RemoteMcpPanel.css";

type Backend = "ssh" | "sftp" | "rdp" | "vnc" | "remote";
export interface McpConnectionSession { sessionId: string; profileId: string; host: string; backend: Backend; fleet?: boolean; screen?: boolean }

export function savedProfilesNotConnected(profiles: ConnectionProfile[], sessions: McpConnectionSession[]): ConnectionProfile[] {
  return profiles.filter((profile) => !sessions.some((session) => session.profileId === profile.id));
}

interface Target { id: string; label: string; backend: string; scopes: RemoteScopes; connected: boolean }
interface QuietWindow { targetId: string; secondsLeft: number }

/**
 * What an external AI tool can reach right now. Every connection the person
 * opens is offered automatically, so this only reports; taking one back means
 * disconnecting it, or using the remote window yourself to pause input.
 */
export function RemoteMcpPanel({ available }: { available: boolean }) {
  const { t } = useI18n();
  const [targets, setTargets] = useState<Target[]>([]);
  const [quiet, setQuiet] = useState<QuietWindow[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!available) return;
    const { invoke } = await import("@tauri-apps/api/core");
    const [next, quietWindows] = await Promise.all([
      invoke<Target[]>("mcp_remote_targets"),
      invoke<QuietWindow[]>("mcp_remote_quiet_commands"),
    ]);
    setTargets(next);
    setQuiet(quietWindows);
  }, [available]);

  useEffect(() => {
    const update = () => { void refresh().catch(() => setError(t("settings.mcpRemote.refreshFailed"))); };
    update();
    if (!available) return;
    const timer = setInterval(update, 10_000);
    return () => clearInterval(timer);
  }, [available, refresh, t]);

  const stopQuiet = async (targetId: string) => {
    const { invoke } = await import("@tauri-apps/api/core");
    setQuiet(await invoke<QuietWindow[]>("mcp_remote_quiet_clear", { targetId }));
  };

  const pause = async (targetId: string) => {
    setBusy(true);
    setError("");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      setTargets(await invoke<Target[]>("mcp_remote_revoke", { targetId }));
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };

  return <section className="panel glass mcp-remote" aria-label={t("settings.mcpRemote.title")}>
    <header className="panel__head"><div><h2 className="panel__title">{t("settings.mcpRemote.title")}</h2>
      <p className="panel__hint">{t("settings.mcpRemote.hint")}</p></div></header>
    <div className="mcp-remote__body">
      <p>{t("settings.mcpRemote.boundary")}</p>
      {error && <p role="alert">{error}</p>}
      {!available ? <p>{t("settings.mcpRemote.desktopOnly")}</p>
        : targets.length === 0 ? <p>{t("settings.mcpRemote.none")}</p>
          : targets.map((target) => <div className="setting" key={target.id}>
            <div className="setting__text"><strong>{target.label}</strong>
              <p className="mono">{target.id}</p>
              <p>{(Object.keys(remoteScopesOff) as RemoteScope[]).filter((scope) => target.scopes[scope]).map((scope) => t(`settings.mcpRemote.scope.${scope}`)).join(" · ")}</p>
              {!target.connected && <p>{t("settings.mcpRemote.offline")}</p>}
              {quiet.filter((window) => window.targetId === target.id).map((window) => <p key={window.targetId}>
                {t("settings.mcpRemote.quietActive", { minutes: Math.max(1, Math.ceil(window.secondsLeft / 60)) })}
                <button type="button" className="button button--ghost" disabled={busy} onClick={() => void stopQuiet(target.id)}>
                  {t("settings.mcpRemote.quietClear")}</button>
              </p>)}
            </div>
            <button type="button" className="button button--danger" disabled={busy} onClick={() => void pause(target.id)}>{t("settings.mcpRemote.pause")}</button>
          </div>)}
    </div>
  </section>;
}
