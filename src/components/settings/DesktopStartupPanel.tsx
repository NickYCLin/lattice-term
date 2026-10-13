import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/context";

export function DesktopStartupPanel({ available }: { available: boolean }) {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const revision = useRef(0);
  const pending = useRef(false);
  const read = useCallback(async () => {
    if (!available || pending.current) return;
    const currentRevision = ++revision.current;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const value = await invoke<boolean>("desktop_autostart_enabled");
      if (revision.current === currentRevision) setEnabled(value);
    } catch (reason) {
      if (revision.current === currentRevision) setError(String(reason));
    } finally {
      if (revision.current === currentRevision) { pending.current = false; setBusy(false); }
    }
  }, [available]);
  useEffect(() => {
    setEnabled(null);
    pending.current = false;
    void read();
    return () => { revision.current += 1; pending.current = false; };
  }, [read]);
  async function change(next: boolean) {
    if (!available || pending.current || enabled === null) return;
    const currentRevision = ++revision.current;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("desktop_set_autostart", { enabled: next });
      const value = await invoke<boolean>("desktop_autostart_enabled");
      if (revision.current === currentRevision) setEnabled(value);
    } catch (reason) {
      if (revision.current === currentRevision) setError(String(reason));
    } finally {
      if (revision.current === currentRevision) { pending.current = false; setBusy(false); }
    }
  }
  return <section className="settings-section">
    <h2 className="settings-section__title">{t("settings.desktopStartup.title")}</h2>
    <div className="setting">
      <div className="setting__text"><strong className="setting__title">{t("settings.desktopStartup.login")}</strong>
        <p className="setting__description">{t("settings.desktopStartup.hint")}</p>
        {error && <div className="setting__description field__error" role="alert">{error}
          <button type="button" className="button button--ghost button--sm" disabled={busy || !available} onClick={() => void read()}>{t("common.retry")}</button>
        </div>}
      </div>
      <div className="segmented" role="radiogroup" aria-label={t("settings.desktopStartup.login")} aria-busy={busy}>
        {([true, false] as const).map(value => <button key={String(value)} type="button" role="radio"
          aria-checked={enabled === value} className={"segmented__option" + (enabled === value ? " is-selected" : "")}
          disabled={!available || busy || enabled === null} onClick={() => void change(value)}>
          {t(value ? "settings.backgroundService.on" : "settings.backgroundService.off")}
        </button>)}
      </div>
    </div>
  </section>;
}
