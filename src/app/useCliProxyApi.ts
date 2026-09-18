import { useCallback, useEffect, useState } from "react";
import {
  CLI_PROXY_SETTINGS_CHANGED,
  CLI_PROXY_SETTINGS_KEY,
  cliProxyConfigured,
  loadCliProxySettings,
  type CliProxyModel,
  type CliProxySettings,
} from "./cliProxyApi";
import { hasDesktopBackend } from "./nativeRuntime";

export type CliProxyModelList =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; models: readonly CliProxyModel[] }
  | { state: "unavailable"; reason: string };

export function useCliProxySettings(): CliProxySettings {
  const read = () => (typeof localStorage === "undefined" ? { baseUrl: "" } : loadCliProxySettings(localStorage));
  const [settings, setSettings] = useState(read);
  useEffect(() => {
    const refresh = () => setSettings(read());
    const storage = (event: StorageEvent) => {
      if (event.key === null || event.key === CLI_PROXY_SETTINGS_KEY) refresh();
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

/**
 * The proxy is asked once per address. A failure is reported rather than
 * retried in a render loop; `reload` is the deliberate second attempt, and it
 * is what the settings panel calls after the key or the address changes.
 */
export function useCliProxyModels(settings: CliProxySettings, enabled = true): CliProxyModelList & { reload: () => void } {
  const [list, setList] = useState<CliProxyModelList>({ state: "idle" });
  const [attempt, setAttempt] = useState(0);
  const baseUrl = settings.baseUrl.trim();
  const reload = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);
  useEffect(() => {
    window.addEventListener(CLI_PROXY_SETTINGS_CHANGED, reload);
    return () => window.removeEventListener(CLI_PROXY_SETTINGS_CHANGED, reload);
  }, [reload]);
  useEffect(() => {
    if (!enabled || !hasDesktopBackend() || !cliProxyConfigured({ baseUrl })) {
      setList({ state: "idle" });
      return;
    }
    let current = true;
    setList({ state: "loading" });
    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<CliProxyModel[]>("cliproxy_models", { baseUrl }))
      .then((models) => { if (current) setList({ state: "ready", models }); })
      .catch((reason: unknown) => { if (current) setList({ state: "unavailable", reason: String(reason) }); });
    return () => { current = false; };
  }, [enabled, baseUrl, attempt]);
  return { ...list, reload };
}
