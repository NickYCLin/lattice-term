import { useCallback, useEffect, useState } from "react";
import {
  CLI_PROXY_LEGACY_SETTINGS_KEY,
  CLI_PROXY_SETTINGS_CHANGED,
  CLI_PROXY_SETTINGS_KEY,
  emptyCliProxySettings,
  loadCliProxySettings,
  type CliProxyEndpoint,
  type CliProxyModel,
  type CliProxySettings,
} from "./cliProxyApi";
import { hasDesktopBackend } from "./nativeRuntime";

export type CliProxyModelList =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; models: readonly CliProxyModel[] }
  | { state: "unavailable"; reason: string };

/** One list per configured proxy, keyed by the proxy's identifier. */
export type CliProxyModelLists = Readonly<Record<string, CliProxyModelList>>;

export function useCliProxySettings(): CliProxySettings {
  const read = () => (typeof localStorage === "undefined" ? emptyCliProxySettings : loadCliProxySettings(localStorage));
  const [settings, setSettings] = useState(read);
  useEffect(() => {
    const refresh = () => setSettings(read());
    const storage = (event: StorageEvent) => {
      if (event.key === null || event.key === CLI_PROXY_SETTINGS_KEY || event.key === CLI_PROXY_LEGACY_SETTINGS_KEY) refresh();
    };
    window.addEventListener(CLI_PROXY_SETTINGS_CHANGED, refresh);
    window.addEventListener("storage", storage);
    return () => {
      window.removeEventListener(CLI_PROXY_SETTINGS_CHANGED, refresh);
      window.removeEventListener("storage", storage);
    };
  }, []);
  return settings;
}

/** Each proxy answers for itself: the identifier picks the stored key, and a
 * proxy that is down must not hide the models the others still offer. */
async function askProxy(id: string, baseUrl: string): Promise<CliProxyModel[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<CliProxyModel[]>("cliproxy_models", { proxyId: id, baseUrl });
}

/**
 * The proxy is asked once per address. A failure is reported rather than
 * retried in a render loop; `reload` is the deliberate second attempt, and it
 * is what the settings panel calls after the key or the address changes.
 */
export function useCliProxyModels(endpoint: CliProxyEndpoint | null, enabled = true): CliProxyModelList & { reload: () => void } {
  const [list, setList] = useState<CliProxyModelList>({ state: "idle" });
  const [attempt, setAttempt] = useState(0);
  const id = endpoint?.id ?? "";
  const baseUrl = endpoint?.baseUrl.trim() ?? "";
  const reload = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);
  useEffect(() => {
    window.addEventListener(CLI_PROXY_SETTINGS_CHANGED, reload);
    return () => window.removeEventListener(CLI_PROXY_SETTINGS_CHANGED, reload);
  }, [reload]);
  useEffect(() => {
    if (!enabled || !hasDesktopBackend() || !id || !baseUrl) {
      setList({ state: "idle" });
      return;
    }
    let current = true;
    setList({ state: "loading" });
    askProxy(id, baseUrl)
      .then((models) => { if (current) setList({ state: "ready", models }); })
      .catch((reason: unknown) => { if (current) setList({ state: "unavailable", reason: String(reason) }); });
    return () => { current = false; };
  }, [enabled, id, baseUrl, attempt]);
  return { ...list, reload };
}

/** The pickers need every configured proxy at once, so one slow or missing
 * proxy leaves the rest selectable. */
export function useCliProxyModelLists(settings: CliProxySettings, enabled = true): { lists: CliProxyModelLists; reload: () => void } {
  const [lists, setLists] = useState<Record<string, CliProxyModelList>>({});
  const [attempt, setAttempt] = useState(0);
  const signature = JSON.stringify(settings.proxies.map((endpoint) => [endpoint.id, endpoint.baseUrl.trim()]));
  const reload = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);
  useEffect(() => {
    window.addEventListener(CLI_PROXY_SETTINGS_CHANGED, reload);
    return () => window.removeEventListener(CLI_PROXY_SETTINGS_CHANGED, reload);
  }, [reload]);
  useEffect(() => {
    const proxies = (JSON.parse(signature) as [string, string][]).filter(([id, baseUrl]) => id && baseUrl);
    if (!enabled || !hasDesktopBackend() || proxies.length === 0) {
      setLists({});
      return;
    }
    let current = true;
    setLists(Object.fromEntries(proxies.map(([id]) => [id, { state: "loading" } as CliProxyModelList])));
    for (const [id, baseUrl] of proxies) {
      askProxy(id, baseUrl)
        .then((models) => {
          if (current) setLists((previous) => ({ ...previous, [id]: { state: "ready", models } }));
        })
        .catch((reason: unknown) => {
          if (current) setLists((previous) => ({ ...previous, [id]: { state: "unavailable", reason: String(reason) } }));
        });
    }
    return () => { current = false; };
  }, [enabled, signature, attempt]);
  return { lists, reload };
}
