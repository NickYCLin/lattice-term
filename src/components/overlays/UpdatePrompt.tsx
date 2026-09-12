/**
 * Startup update prompt.
 *
 * Surfaces a newer release the moment the app finds one, instead of leaving it
 * buried in Settings. The prompt drives the same download/install/relaunch flow
 * as the Settings panel, but foregrounds it so the user actually sees it.
 */

import { useEffect, useRef } from "react";
import { useI18n } from "../../i18n/context";
import type { AppUpdater } from "../../app/useAppUpdater";
import { ReleaseNotes } from "../common/ReleaseNotes";
import { RefreshIcon } from "../icons";
import { useModalFocus } from "./modalFocus";

export function UpdatePrompt({
  updater,
  onDismiss,
}: {
  updater: AppUpdater;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const primaryRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // While an install is running a dismissal would strand the flow, so the
  // scrim and Escape only close the prompt when it is safe to walk away.
  const busy =
    updater.status === "downloading" || updater.status === "installing";
  const dismissable = !busy;

  useModalFocus({
    dialogRef,
    getInitialFocus: () => primaryRef.current,
    onEscape: onDismiss,
    escapeDisabled: !dismissable,
  });

  useEffect(() => {
    const primary = primaryRef.current;
    if (primary && !primary.disabled) primary.focus();
    else dialogRef.current?.focus();
  }, [updater.status]);

  return (
    <div
      className="scrim scrim--center"
      role="presentation"
      onMouseDown={dismissable ? onDismiss : undefined}
    >
      <div
        ref={dialogRef}
        className="dialog dialog--wide"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="update-prompt-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog__icon dialog__icon--inline" aria-hidden="true">
          <RefreshIcon size={18} />
        </div>
        <h2 className="dialog__title" id="update-prompt-title">
          {t("update.prompt.title")}
        </h2>

        <div className="dialog__body update-prompt__meta">
          <span className="update-prompt__versions">
            {t("update.prompt.versions", {
              current: updater.currentVersion,
              version: updater.availableVersion ?? "",
            })}
          </span>
        </div>

        {updater.status === "available" && updater.releaseNotes && (
          <div className="update-prompt__notes">
            <strong>{t("settings.updater.releaseNotes")}</strong>
            <div className="update-prompt__notes-body">
              <ReleaseNotes body={updater.releaseNotes} />
            </div>
          </div>
        )}

        {(updater.status === "downloading" ||
          updater.status === "installing") && (
          <div className="update-prompt__progress">
            <div className="update-prompt__track">
              <div
                className="update-prompt__fill"
                style={{
                  width: `${updater.status === "installing" ? 100 : updater.progressPercent}%`,
                }}
              />
            </div>
            <span className="update-prompt__progress-label">
              {updater.status === "installing"
                ? t("settings.updater.installing")
                : t("settings.updater.downloading", {
                    percent: updater.progressPercent,
                  })}
            </span>
          </div>
        )}

        {updater.status === "downloaded" && (
          <p className="dialog__body">{t("settings.updater.downloaded")}</p>
        )}

        {updater.status === "error" && updater.error && (
          <p className="dialog__body update-prompt__error">
            {t("settings.updater.error", { error: updater.error })}
          </p>
        )}

        <p className="update-prompt__hint">
          {t("settings.updater.autoRestartHint")}
        </p>

        <div className="dialog__actions">
          {updater.status === "downloaded" ? (
            <>
              <button
                type="button"
                className="button button--ghost"
                onClick={onDismiss}
              >
                {t("update.prompt.later")}
              </button>
              <button
                type="button"
                ref={primaryRef}
                className="button button--primary"
                onClick={() => void updater.relaunchApp()}
              >
                {t("settings.updater.relaunch")}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="button button--ghost"
                disabled={!dismissable}
                onClick={onDismiss}
              >
                {t("update.prompt.later")}
              </button>
              <button
                type="button"
                ref={primaryRef}
                className="button button--primary"
                disabled={busy}
                onClick={() => void updater.downloadAndInstall()}
              >
                {busy
                  ? t("settings.updater.installing")
                  : updater.status === "error"
                    ? t("update.prompt.retry")
                    : t("update.prompt.updateNow")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
