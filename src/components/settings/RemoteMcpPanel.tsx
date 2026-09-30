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
interface TrustedConnection { profileId: string; label: string }

/**
 * What an external AI tool can reach right now. Every connection the person
 * opens is offered automatically, so this only reports; taking one back means
 * disconnecting it, or using the remote window yourself to pause input.
 */
export function RemoteMcpPanel({ available }: { available: boolean }) {
  const { t } = useI18n();
  const [targets, setTargets] = useState<Target[]>([]);
  const [quiet, setQuiet] = useState<QuietWindow[]>([]);
  const [trusted, setTrusted] = useState<TrustedConnection[]>([]);
  const [trustAll, setTrustAll] = useState(false);
  const [allowRemote, setAllowRemote] = useState(false);
  // On by default, so the box matches what the service already answers
  // before the desktop has replied.
  const [book, setBook] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!available) return;
    const { invoke } = await import("@tauri-apps/api/core");
    const [next, quietWindows, bookShared, trustedConnections, everyConnection, remoteAllowed] = await Promise.all([
      invoke<Target[]>("mcp_remote_targets"),
      invoke<QuietWindow[]>("mcp_remote_quiet_commands"),
      invoke<boolean>("mcp_connection_book_shared"),
      invoke<TrustedConnection[]>("mcp_remote_trusted_commands"),
      invoke<boolean>("mcp_remote_trust_all"),
      invoke<boolean>("mcp_remote_auto_allow"),
    ]);
    setTrustAll(everyConnection === true);
    setAllowRemote(remoteAllowed === true);
    setTargets(next);
    setQuiet(quietWindows);
    setTrusted(trustedConnections);
    setBook(bookShared === true);
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

  const stopTrusting = async (profileId: string) => {
    setError("");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      setTrusted(await invoke<TrustedConnection[]>("mcp_remote_trusted_clear", { profileId }));
    } catch (reason) { setError(String(reason)); }
  };

  // Naming the saved connections is its own choice, separate from what any
  // open session already allows.
  const shareBook = async (shared: boolean) => {
    setBusy(true);
    setError("");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      setBook(await invoke<boolean>("mcp_connection_book_share", { shared }));
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };

  const shareTrustAll = async (trusted: boolean) => {
    setBusy(true);
    setError("");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      setTrustAll(await invoke<boolean>("mcp_remote_trust_all_set", { trusted }));
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
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

  const shareRemote = async (allowed: boolean) => {
    setBusy(true);
    setError("");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      setAllowRemote(await invoke<boolean>("mcp_remote_auto_allow_set", { allowed }));
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };

  return <section className="panel glass mcp-remote" aria-label={t("settings.mcpRemote.title")}>
    <header className="panel__head"><div><h2 className="panel__title">{t("settings.mcpRemote.title")}</h2>
      <p className="panel__hint">{t("settings.mcpRemote.hint")}</p></div></header>
    <div className="mcp-remote__body">
      <p>{t("settings.mcpRemote.boundary")}</p>
      {available && <label className="checkbox mcp-remote__book">
        <input type="checkbox" checked={book} disabled={busy}
          onChange={(event) => void shareBook(event.currentTarget.checked)} />
        <span className="checkbox__box" aria-hidden="true">✓</span>
        <span className="mcp-remote__book-text"><strong>{t("settings.mcpRemote.book")}</strong>
          <span>{t("settings.mcpRemote.book.hint")}</span></span>
      </label>}
      {available && <label className="checkbox mcp-remote__book">
        <input type="checkbox" checked={trustAll} disabled={busy}
          onChange={(event) => void shareTrustAll(event.currentTarget.checked)} />
        <span className="checkbox__box" aria-hidden="true">✓</span>
        <span className="mcp-remote__book-text"><strong>{t("settings.mcpRemote.trustAll")}</strong>
          <span>{t("settings.mcpRemote.trustAll.hint")}</span></span>
      </label>}
      {available && <label className="checkbox mcp-remote__book">
        <input type="checkbox" checked={allowRemote} disabled={busy}
          onChange={(event) => void shareRemote(event.currentTarget.checked)} />
        <span className="checkbox__box" aria-hidden="true">✓</span>
        <span className="mcp-remote__book-text"><strong>{t("settings.mcpRemote.autoAllow")}</strong>
          <span>{t("settings.mcpRemote.autoAllow.hint")}</span></span>
      </label>}
      {error && <p role="alert">{error}</p>}
      {available && trusted.length > 0 && <div className="mcp-remote__trusted">
        <strong>{t("settings.mcpRemote.trustedTitle")}</strong>
        <p>{t("settings.mcpRemote.trustedHint")}</p>
        {trusted.map((connection) => <div className="setting" key={connection.profileId}>
          <div className="setting__text"><strong>{connection.label || connection.profileId}</strong></div>
          <button type="button" className="button button--ghost button--sm"
            onClick={() => void stopTrusting(connection.profileId)}>{t("settings.mcpRemote.quietClear")}</button>
        </div>)}
      </div>}
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
