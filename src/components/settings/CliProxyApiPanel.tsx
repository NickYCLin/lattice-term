import { useCallback, useEffect, useState } from "react";
import {
  CLI_PROXY_DEFAULT_BASE_URL,
  CLI_PROXY_LIMIT,
  CLI_PROXY_SETTINGS_CHANGED,
  cliProxyLabel,
  cliProxyMessageKey,
  cliProxyModelLabel,
  cliProxyStatusCode,
  loadCliProxySettings,
  newCliProxyId,
  saveCliProxySettings,
  type CliProxyEndpoint,
} from "../../app/cliProxyApi";
import { useCliProxyModels } from "../../app/useCliProxyApi";
import { useI18n } from "../../i18n/context";

interface Probe { healthy: boolean; status: number }

/** Desktop refusals are message keys; anything else is shown as it came. */
function useExplain() {
  const { t } = useI18n();
  return (reason: unknown) => {
    const messageKey = cliProxyMessageKey(reason);
    if (messageKey) return t(messageKey);
    const status = cliProxyStatusCode(reason);
    if (status !== null) return t("cliproxy.models.status", { status });
    return String(reason);
  };
}

/**
 * One configured proxy. The key belongs to this entry alone: the same server
 * can be reached with two keys, and removing an entry takes its key with it.
 */
function ProxyEntry({ endpoint, available, onChange, onRemove }: {
  endpoint: CliProxyEndpoint;
  available: boolean;
  onChange: (endpoint: CliProxyEndpoint) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const explain = useExplain();
  const [label, setLabel] = useState(endpoint.label);
  const [baseUrl, setBaseUrl] = useState(endpoint.baseUrl);
  const [savedBaseUrl, setSavedBaseUrl] = useState(endpoint.baseUrl);
  const [key, setKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const models = useCliProxyModels(savedBaseUrl ? { ...endpoint, baseUrl: savedBaseUrl } : null, available);

  const refreshKey = useCallback(async () => {
    if (!available) return;
    const { invoke } = await import("@tauri-apps/api/core");
    setHasKey(await invoke<boolean>("cliproxy_key_exists", { proxyId: endpoint.id }));
  }, [available, endpoint.id]);
  useEffect(() => { void refreshKey().catch(() => {}); }, [refreshKey]);

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
    onChange({ ...endpoint, label: label.trim(), baseUrl: baseUrl.trim() });
    setSavedBaseUrl(baseUrl.trim());
    setProbe(result);
    await refreshKey();
  });

  const saveKey = () => run(async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("cliproxy_save_key", { proxyId: endpoint.id, baseUrl: savedBaseUrl || baseUrl, key });
    setKey("");
    await refreshKey();
    window.dispatchEvent(new Event(CLI_PROXY_SETTINGS_CHANGED));
  });

  const forgetKey = () => run(async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke<boolean>("cliproxy_forget_key", { proxyId: endpoint.id });
    await refreshKey();
    window.dispatchEvent(new Event(CLI_PROXY_SETTINGS_CHANGED));
  });

  // The key would otherwise outlive the entry that explains what it unlocks.
  const remove = () => run(async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke<boolean>("cliproxy_forget_key", { proxyId: endpoint.id }).catch(() => false);
    onRemove();
  });

  return <div className="cli-proxy-entry">
    <div className="cli-proxy-entry__head">
      <strong className="truncate">{cliProxyLabel({ ...endpoint, label, baseUrl })}</strong>
      <button type="button" className="button button--ghost button--sm" disabled={busy} onClick={remove}>
        {t("settings.cliProxy.clear")}</button>
    </div>
    {error && <p role="alert">{error}</p>}
    <label className="field"><span className="field__label">{t("settings.cliProxy.name")}</span>
      <input className="input" value={label} disabled={busy} maxLength={64} autoComplete="off"
        onChange={(event) => setLabel(event.currentTarget.value)}
        onBlur={() => onChange({ ...endpoint, label: label.trim(), baseUrl: savedBaseUrl })} />
      <span className="field__hint">{t("settings.cliProxy.nameHint")}</span></label>
    <label className="field"><span className="field__label">{t("settings.cliProxy.address")}</span>
      <input className="input mono" value={baseUrl} disabled={busy} maxLength={256} autoComplete="off"
        spellCheck={false} placeholder={CLI_PROXY_DEFAULT_BASE_URL}
        onChange={(event) => setBaseUrl(event.currentTarget.value)} />
      <span className="field__hint">{t("settings.cliProxy.addressHint")}</span></label>
    <div>
      <button type="button" className="button button--primary" disabled={busy || !baseUrl.trim()} onClick={save}>
        {t("settings.cliProxy.test")}</button>
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
  </div>;
}

/** Read once while the page is being built: the list is small and the picker
 * elsewhere reads the same storage, so there is nothing to wait for. */
function savedProxies(): readonly CliProxyEndpoint[] {
  if (typeof localStorage === "undefined") return [];
  return loadCliProxySettings(localStorage).proxies;
}

/**
 * Where a person tells LatticeTerm about the CLIProxyAPI servers they run.
 * Saved keys are write-only here: the desktop side keeps them and reports
 * only whether one exists, so they never come back into this page.
 */
export function CliProxyApiPanel({ available }: { available: boolean }) {
  const { t } = useI18n();
  const [proxies, setProxies] = useState<readonly CliProxyEndpoint[]>(savedProxies);

  // Drafts without an address stay in the page; only accepted addresses are
  // written, so a half-typed entry never reaches a picker.
  const persist = (next: readonly CliProxyEndpoint[]) => {
    setProxies(next);
    if (typeof localStorage !== "undefined") saveCliProxySettings(localStorage, { proxies: next });
  };

  return <section className="panel glass" aria-label={t("settings.cliProxy.title")}>
    <header className="panel__head">
      <div>
        <h2 className="panel__title">{t("settings.cliProxy.title")}</h2>
        <p className="panel__hint">{t("settings.cliProxy.hint")}</p>
      </div>
      {available && <div className="panel__actions">
        <button type="button" className="button button--primary" disabled={proxies.length >= CLI_PROXY_LIMIT}
          onClick={() => persist([...proxies, { id: newCliProxyId(), label: "", baseUrl: "" }])}>
          {t("settings.cliProxy.add")}</button>
      </div>}
    </header>
    <div className="setting__text">
      <p>{t("settings.cliProxy.boundary")}</p>
      {!available ? <p>{t("settings.cliProxy.desktopOnly")}</p> : <>
        {proxies.length === 0 && <p>{t("settings.cliProxy.empty")}</p>}
        {proxies.map((endpoint) => (
          <ProxyEntry
            key={endpoint.id}
            endpoint={endpoint}
            available={available}
            onChange={(next) => persist(proxies.map((entry) => (entry.id === next.id ? next : entry)))}
            onRemove={() => persist(proxies.filter((entry) => entry.id !== endpoint.id))}
          />
        ))}
        <p className="field__hint">{t("settings.cliProxy.limit", { count: CLI_PROXY_LIMIT })}</p>
      </>}
    </div>
  </section>;
}
