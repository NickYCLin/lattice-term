import { useRef } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useI18n } from "../../i18n/context";
import type { useCliUpdates } from "../../app/useCliUpdates";
import { useModalFocus } from "./modalFocus";

export function CliUpdatePrompt({
  updates,
}: {
  updates: ReturnType<typeof useCliUpdates>;
}) {
  const { t, tag } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const isUpdating = updates.updating !== null;

  useModalFocus({
    dialogRef,
    getInitialFocus: () => closeRef.current,
    onEscape: isUpdating ? undefined : updates.dismiss,
    escapeDisabled: isUpdating,
  });

  const hasUpdatable = updates.items.some(
    (item) => item.status === "available" && item.updatable !== false,
  );

  return (
    <div
      className="scrim scrim--center"
      role="presentation"
      onMouseDown={isUpdating ? undefined : updates.dismiss}
    >
      <div
        ref={dialogRef}
        className="dialog dialog--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cli-update-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="cli-update-title" className="dialog__title">
          {t("cliUpdates.title")}
        </h2>
        <p className="dialog__body">{t("cliUpdates.hint")}</p>
        <div className="update-prompt__notes" aria-live="polite">
          {updates.error && <p role="alert">{t("cliUpdates.error")}</p>}
          {updates.updated.length > 0 && (
            <p role="status">
              {t("cliUpdates.updated", {
                names: updates.updated.join(/^(zh|ja)/.test(tag) ? "、" : ", "),
              })}
            </p>
          )}
          {updates.updateError && (
            <p role="alert" className="tone-danger" style={{ whiteSpace: "pre-line" }}>
              {updates.updateError}
            </p>
          )}
          {updates.items.map((item) => {
            const isUpdatingThis =
              updates.updating === item.id || updates.updating === "all";
            const canDirectUpdate =
              item.status === "available" && item.updatable !== false;
            return (
              <p key={item.id}>
                <strong>{item.label}</strong>
                {" · "}
                {item.currentVersion && (
                  <span>
                    {item.currentVersion} → {item.latestVersion ?? "?"} ·{" "}
                  </span>
                )}
                {t(`cliUpdates.${item.status}`)}{" "}
                {canDirectUpdate && (
                  <button
                    type="button"
                    className="button button--primary button--sm"
                    disabled={updates.busy || isUpdating}
                    onClick={() => void updates.updateCli(item.id)}
                  >
                    {isUpdatingThis
                      ? t("cliUpdates.updating")
                      : t("cliUpdates.update")}
                  </button>
                )}{" "}
                {item.status !== "current" && (
                  <button
                    type="button"
                    className="button button--secondary button--sm"
                    onClick={() =>
                      void openUrl(item.sourceUrl).catch(() => {
                        /* The URL remains visible below. */
                      })
                    }
                  >
                    {t("cliUpdates.instructions")}
                  </button>
                )}
                {item.status !== "current" && (
                  <small style={{ display: "block", overflowWrap: "anywhere" }}>
                    {item.sourceUrl}
                  </small>
                )}
              </p>
            );
          })}
        </div>
        <div className="dialog__actions">
          {hasUpdatable && (
            <button
              type="button"
              className="button button--primary"
              disabled={updates.busy || isUpdating}
              onClick={() => void updates.updateAll()}
            >
              {updates.updating === "all"
                ? t("cliUpdates.updating")
                : t("cliUpdates.updateAll")}
            </button>
          )}
          <button
            type="button"
            className="button button--secondary"
            disabled={updates.busy || isUpdating}
            onClick={() => void updates.check()}
          >
            {t(updates.busy ? "cliUpdates.checking" : "cliUpdates.recheck")}
          </button>
          <button
            ref={closeRef}
            type="button"
            className={`button ${hasUpdatable ? "button--secondary" : "button--primary"}`}
            disabled={isUpdating}
            onClick={updates.dismiss}
          >
            {t("cliUpdates.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
