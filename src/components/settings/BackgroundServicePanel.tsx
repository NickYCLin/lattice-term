import { useEffect, useState } from "react";
import { useI18n } from "../../i18n/context";

/**
 * Whether the background service starts at login, so scheduled chats keep
 * running after a reboot even before anyone opens the window.
 */
export function BackgroundServicePanel({ available }: { available: boolean }) {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<boolean>("agent_daemon_autostart_enabled"))
      .then((value) => {
        if (!cancelled) setEnabled(value);
      })
      .catch(() => {
        if (!cancelled) setEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, [available]);

  const change = async (next: boolean) => {
    setBusy(true);
    setError("");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("agent_daemon_set_autostart", { enabled: next });
      setEnabled(next);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel glass glass--sheen" aria-label={t("settings.backgroundService.title")}>
      <header className="panel__head">
        <div>
          <h2 className="panel__title">{t("settings.backgroundService.title")}</h2>
          <p className="panel__hint">{t("settings.backgroundService.hint")}</p>
        </div>
      </header>
      <div className="setting">
        <div className="setting__text">
          <strong className="setting__title">{t("settings.backgroundService.login")}</strong>
          <p className="setting__description">{t("settings.backgroundService.loginHint")}</p>
          {error && (
            <p className="setting__description field__error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="segmented" role="radiogroup" aria-label={t("settings.backgroundService.login")}>
          {([true, false] as const).map((value) => (
            <button
              type="button"
              key={String(value)}
              role="radio"
              aria-checked={enabled === value}
              className={`segmented__option${enabled === value ? " is-selected" : ""}`}
              disabled={!available || busy || enabled === null}
              onClick={() => {
                if (enabled !== value) void change(value);
              }}
            >
              {t(value ? "settings.backgroundService.on" : "settings.backgroundService.off")}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
