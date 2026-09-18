import { useCallback, useEffect, useState } from "react";
import {
  CLI_PROXY_DEFAULT_BASE_URL,
  cliProxyMessageKey,
  cliProxyModelLabel,
  cliProxyStatusCode,
  loadCliProxySettings,
  saveCliProxySettings,
} from "../../app/cliProxyApi";
import { useCliProxyModels } from "../../app/useCliProxyApi";
import { useI18n } from "../../i18n/context";

interface Probe { healthy: boolean; status: number }

/**
 * Where a person tells LatticeTerm about the CLIProxyAPI server they run.
 * The saved key is write-only here: the desktop side keeps it and reports
 * only whether one exists, so it never comes back into this page.
 */
export function CliProxyApiPanel({ available }: { available: boolean }) {
  const { t } = useI18n();
  const [baseUrl, setBaseUrl] = useState("");
  const [savedBaseUrl, setSavedBaseUrl] = useState("");
  const [key, setKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const models = useCliProxyModels({ baseUrl: savedBaseUrl }, available);

  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    const stored = loadCliProxySettings(localStorage).baseUrl;
    setBaseUrl(stored);
    setSavedBaseUrl(stored);
  }, []);

  const refreshKey = useCallback(async () => {
    if (!available) return;
    const { invoke } = await import("@tauri-apps/api/core");
    setHasKey(await invoke<boolean>("cliproxy_key_exists"));
  }, [available]);
  useEffect(() => { void refreshKey().catch(() => {}); }, [refreshKey]);

  /** Desktop refusals are message keys; anything else is shown as it came. */
  const explain = (reason: unknown) => {
    const messageKey = cliProxyMessageKey(reason);
    if (messageKey) return t(messageKey);
    const status = cliProxyStatusCode(reason);
    if (status !== null) return t("cliproxy.models.status", { status });
    return String(reason);
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try { await action(); } catch (reason) { setError(explain(reason)); } finally { setBusy(false); }
  };

  const save = () => run(async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    // The desktop decides what a usable address is; storing the raw text only
    // after it accepts one keeps the saved value and the bound key in step.
    const result = await invoke<Probe>("cliproxy_probe", { baseUrl });
    saveCliProxySettings(localStorage, { baseUrl });
    setSavedBaseUrl(baseUrl.trim());
    setProbe(result);
    await refreshKey();
  });

  const saveKey = () => run(async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("cliproxy_save_key", { baseUrl: savedBaseUrl || baseUrl, key });
    setKey("");
    await refreshKey();
    models.reload();
  });

  const forgetKey = () => run(async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke<boolean>("cliproxy_forget_key");
    await refreshKey();
    models.reload();
  });

  const clear = () => run(async () => {
    saveCliProxySettings(localStorage, { baseUrl: "" });
    setBaseUrl("");
    setSavedBaseUrl("");
    setProbe(null);
  });

  return <section className="panel glass" aria-label={t("settings.cliProxy.title")}>
    <header className="panel__head"><div>
      <h2 className="panel__title">{t("settings.cliProxy.title")}</h2>
      <p className="panel__hint">{t("settings.cliProxy.hint")}</p>
    </div></header>
    <div className="setting__text">
      <p>{t("settings.cliProxy.boundary")}</p>
      {!available ? <p>{t("settings.cliProxy.desktopOnly")}</p> : <>
        {error && <p role="alert">{error}</p>}
        <label className="field"><span className="field__label">{t("settings.cliProxy.address")}</span>
          <input className="input mono" value={baseUrl} disabled={busy} maxLength={256} autoComplete="off"
            spellCheck={false} placeholder={CLI_PROXY_DEFAULT_BASE_URL}
            onChange={(event) => setBaseUrl(event.currentTarget.value)} />
          <span className="field__hint">{t("settings.cliProxy.addressHint")}</span></label>
        <div>
          <button type="button" className="button button--primary" disabled={busy || !baseUrl.trim()} onClick={save}>
            {t("settings.cliProxy.test")}</button>
          {savedBaseUrl && <button type="button" className="button button--ghost" disabled={busy} onClick={clear}>
            {t("settings.cliProxy.clear")}</button>}
        </div>
        {probe && <p>{probe.healthy
          ? t("settings.cliProxy.reachable")
          : t("settings.cliProxy.unreachable", { status: probe.status })}</p>}

        <label className="field"><span className="field__label">{t("settings.cliProxy.key")}</span>
          <input className="input" type="password" value={key} disabled={busy || !savedBaseUrl} maxLength={512}
            autoComplete="off" spellCheck={false} onChange={(event) => setKey(event.currentTarget.value)} />
          <span className="field__hint">{t("settings.cliProxy.keyHint")}</span></label>
        <p>{hasKey ? t("settings.cliProxy.keySaved") : t("settings.cliProxy.keyMissing")}</p>
        <div>
          <button type="button" className="button" disabled={busy || !savedBaseUrl || !key.trim()} onClick={saveKey}>
            {t("settings.cliProxy.keySave")}</button>
          {hasKey && <button type="button" className="button button--danger" disabled={busy} onClick={forgetKey}>
            {t("settings.cliProxy.keyForget")}</button>}
        </div>

        {savedBaseUrl && <>
          <h3 className="field__label">{t("settings.cliProxy.models")}</h3>
          {models.state === "loading" && <p>{t("settings.cliProxy.modelsLoading")}</p>}
          {models.state === "unavailable" && <p role="alert">{explain(models.reason)}</p>}
          {models.state === "ready" && <>
            <p>{t("settings.cliProxy.modelsReady", { count: models.models.length })}</p>
            <p className="mono">{models.models.slice(0, 6).map(cliProxyModelLabel).join("、")}</p>
          </>}
          <div><button type="button" className="button button--ghost" disabled={busy} onClick={models.reload}>
            {t("settings.cliProxy.modelsReload")}</button></div>
        </>}
      </>}
    </div>
  </section>;
}
