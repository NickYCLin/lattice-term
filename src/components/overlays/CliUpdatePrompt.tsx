import { useRef } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useI18n } from "../../i18n/context";
import type { useCliUpdates } from "../../app/useCliUpdates";
import { useModalFocus } from "./modalFocus";

export function CliUpdatePrompt({ updates }: { updates: ReturnType<typeof useCliUpdates> }) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useModalFocus({ dialogRef, getInitialFocus: () => closeRef.current, onEscape: updates.dismiss });
  return (
    <div className="scrim scrim--center" role="presentation" onMouseDown={updates.dismiss}>
      <div ref={dialogRef} className="dialog dialog--wide" role="dialog" aria-modal="true"
        aria-labelledby="cli-update-title" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
        <h2 id="cli-update-title" className="dialog__title">{t("cliUpdates.title")}</h2>
        <p className="dialog__body">{t("cliUpdates.hint")}</p>
        <div className="update-prompt__notes" aria-live="polite">
          {updates.error && <p role="alert">{t("cliUpdates.error")}</p>}
          {updates.items.map((item) => (
            <p key={item.id}>
              <strong>{item.label}</strong>{" · "}
              {item.currentVersion && <span>{item.currentVersion} → {item.latestVersion ?? "?"} · </span>}
              {t(`cliUpdates.${item.status}`)}{" "}
              {item.status !== "current" && <button type="button" className="button button--secondary button--sm"
                onClick={() => void openUrl(item.sourceUrl).catch(() => { /* The URL remains visible below. */ })}>
                {t("cliUpdates.instructions")}
              </button>}
              {item.status !== "current" && <small style={{ display: "block", overflowWrap: "anywhere" }}>{item.sourceUrl}</small>}
            </p>
          ))}
        </div>
        <div className="dialog__actions">
          <button type="button" className="button button--secondary" disabled={updates.busy}
            onClick={() => void updates.check()}>{t(updates.busy ? "cliUpdates.checking" : "cliUpdates.recheck")}</button>
          <button ref={closeRef} type="button" className="button button--primary"
            onClick={updates.dismiss}>{t("cliUpdates.close")}</button>
        </div>
      </div>
    </div>
  );
}
