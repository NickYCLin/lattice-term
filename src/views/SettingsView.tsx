/**
 * Settings.
 *
 * Active preferences and local-data security tools take effect immediately.
 */

import { useEffect, useState } from "react";
import mobileDownloadQr from "../assets/mobile-download-qr.svg";
import type {
  DensityChoice,
  MotionChoice,
  Preferences,
  VaultAutoLockChoice,
} from "../app/preferences";
import { themeCatalog } from "../app/themes";
import type { RuntimeState } from "../app/useRuntimeSummary";
import type { StorageState } from "../app/useStorageStatus";
import { useI18n } from "../i18n/context";
import { displayPath } from "../app/displayPath";
import { localeCatalog, type Locale } from "../i18n/catalog";
import type { MessageKey } from "../i18n/context";
import { Chip } from "../components/common/Badge";
import { Callout } from "../components/common/Callout";
import { CheckIcon, PlayIcon } from "../components/icons";
import { useAppUpdater, type AppUpdater } from "../app/useAppUpdater";
import { canUseInAppUpdater } from "../app/platformCapabilities";
import { APP_VERSION } from "../app/version";
import type { EncryptedBackupRestore } from "../app/encryptedBackup";
import { EncryptedBackupPanel } from "../components/settings/EncryptedBackupPanel";
import { ChangelogPanel } from "../components/settings/ChangelogPanel";
import { PrivacyNotice } from "../components/settings/PrivacyNotice";
import {
  clearSensitiveClipboard,
  type SensitiveClipboardClearOutcome,
} from "../app/sensitiveClipboard";
import {
  notificationSoundChoices,
  playNotificationSound,
  type NotificationSoundChoice,
} from "../app/notificationSounds";
import { moveRadioGroupFocus } from "../components/overlays/radioNavigation";

interface Choice<T> {
  value: T;
  labelKey: MessageKey;
}

const densityChoices: Choice<DensityChoice>[] = [
  { value: "comfortable", labelKey: "settings.density.comfortable" },
  { value: "compact", labelKey: "settings.density.compact" },
];

const motionChoices: Choice<MotionChoice>[] = [
  { value: "full", labelKey: "settings.motion.full" },
  { value: "system", labelKey: "settings.motion.system" },
  { value: "reduced", labelKey: "settings.motion.reduced" },
];

const notificationSoundKeys: Record<NotificationSoundChoice, MessageKey> = {
  off: "settings.notifications.sound.off",
  clear: "settings.notifications.sound.clear",
  gentle: "settings.notifications.sound.gentle",
  double: "settings.notifications.sound.double",
  wood: "settings.notifications.sound.wood",
};

const vaultAutoLockChoices: Choice<VaultAutoLockChoice>[] = [
  { value: "off", labelKey: "settings.security.autoLock.off" },
  { value: "5", labelKey: "settings.security.autoLock.5min" },
  { value: "15", labelKey: "settings.security.autoLock.15min" },
  { value: "30", labelKey: "settings.security.autoLock.30min" },
  { value: "60", labelKey: "settings.security.autoLock.60min" },
];

type ToggleChoice = "enabled" | "disabled";

const backgroundLockChoices: Choice<ToggleChoice>[] = [
  { value: "enabled", labelKey: "settings.security.background.enabled" },
  { value: "disabled", labelKey: "settings.security.background.disabled" },
];

const clipboardClearChoices: Choice<Preferences["sensitiveClipboardClear"]>[] = [
  { value: "off", labelKey: "settings.security.clipboard.off" },
  { value: "15", labelKey: "settings.security.clipboard.15sec" },
  { value: "30", labelKey: "settings.security.clipboard.30sec" },
  { value: "60", labelKey: "settings.security.clipboard.60sec" },
  { value: "120", labelKey: "settings.security.clipboard.120sec" },
];

const clipboardOutcomeKeys: Record<
  SensitiveClipboardClearOutcome,
  MessageKey
> = {
  cleared: "settings.security.clipboard.cleared",
  nothing: "settings.security.clipboard.nothing",
  preserved: "settings.security.clipboard.preserved",
  unavailable: "settings.security.clipboard.unavailable",
};
function SegmentedSetting<T extends string>({
  title,
  description,
  choices,
  value,
  onChange,
}: {
  title: string;
  description: string;
  choices: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="setting">
      <div className="setting__text">
        <strong className="setting__title">{title}</strong>
        <p className="setting__description">{description}</p>
      </div>
      <div className="segmented" role="radiogroup" aria-label={title}>
        {choices.map((choice, index) => (
          <button
            type="button"
            key={choice.value}
            role="radio"
            aria-checked={value === choice.value}
            tabIndex={value === choice.value ? 0 : -1}
            className={`segmented__option${
              value === choice.value ? " is-selected" : ""
            }`}
            onClick={() => onChange(choice.value)}
            onKeyDown={(event) =>
              moveRadioGroupFocus(event, index, (nextIndex) =>
                onChange(choices[nextIndex].value),
              )
            }
          >
            {choice.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function SettingsView({
  preferences,
  onChange,
  runtime,
  storage,
  vaultUnlocked,
  onBackupRestored,
  updater: injectedUpdater,
}: {
  preferences: Preferences;
  onChange: (patch: Partial<Preferences>) => void;
  runtime: RuntimeState;
  storage: StorageState;
  vaultUnlocked: boolean;
  onBackupRestored: (
    result: EncryptedBackupRestore,
    restoredPreferences: Preferences,
  ) => Promise<void>;
  /** Shared with the app-level startup prompt so both reflect one check. */
  updater?: AppUpdater;
}) {
  const { t } = useI18n();
  const { summary, host } = runtime;
  const desktopBackendAvailable = host === "tauri";
  const inAppUpdaterAvailable = canUseInAppUpdater(host, summary?.platform);
  const usesAppleUpdates = host === "tauri" && summary?.platform === "ios";
  // A local instance keeps the panel working when rendered standalone; the
  // app passes its own so the panel and the startup prompt stay in sync.
  const localUpdater = useAppUpdater(summary?.version);
  const updater = injectedUpdater ?? localUpdater;
  const [clipboardBusy, setClipboardBusy] = useState(false);
  const [clipboardNotice, setClipboardNotice] =
    useState<MessageKey | null>(null);
  const [notificationPreview, setNotificationPreview] = useState<
    "idle" | "playing" | "unavailable"
  >("idle");
  const [systemPrefersReducedMotion, setSystemPrefersReducedMotion] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true,
  );

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const updateMotionPreference = () =>
      setSystemPrefersReducedMotion(query.matches);
    updateMotionPreference();
    query.addEventListener("change", updateMotionPreference);
    return () => query.removeEventListener("change", updateMotionPreference);
  }, []);

  const motionHintKey: MessageKey =
    preferences.motion === "full"
      ? "settings.motionHint.full"
      : preferences.motion === "reduced"
      ? "settings.motionHint.reduced"
      : systemPrefersReducedMotion
        ? "settings.motionHint.systemReduced"
        : "settings.motionHint.systemActive";

  const [motionPreview, setMotionPreview] = useState(0);

  return (
    <div className="stack">
      <section className="panel glass glass--sheen">
        <header className="panel__head">
          <div>
            <h2 className="panel__title">{t("settings.appearance")}</h2>
            <p className="panel__hint">{t("settings.appearanceHint")}</p>
          </div>
        </header>

        <div className="setting">
          <div className="setting__text">
            <strong className="setting__title">{t("settings.theme")}</strong>
            <p className="setting__description">{t("settings.themeHint")}</p>
          </div>
        </div>

        <div className="theme-grid" role="radiogroup" aria-label={t("settings.theme")}>
          {themeCatalog.map((theme, index) => {
            const selected = preferences.theme === theme.id;
            return (
              <button
                type="button"
                key={theme.id}
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                className={`theme-option${selected ? " is-selected" : ""}`}
                onClick={() => onChange({ theme: theme.id })}
                onKeyDown={(event) =>
                  moveRadioGroupFocus(event, index, (nextIndex) =>
                    onChange({ theme: themeCatalog[nextIndex].id }),
                  )
                }
              >
                <span className="theme-option__previews" aria-hidden="true">
                  {(theme.id === "system" ? ["dark", "light"] : [theme.id]).map((id) => (
                    <span className="theme-option__preview" data-theme={id} key={id}>
                      <span className="theme-option__rail"><i /><i /><i /></span>
                      <span className="theme-option__page">
                        <span className="theme-option__toolbar"><i /><i /></span>
                        <span className="theme-option__bubble" />
                        <span className="theme-option__lines"><i /><i /><i /></span>
                        <span className="theme-option__composer"><i /></span>
                      </span>
                    </span>
                  ))}
                </span>
                <span className="theme-option__label">
                  {t(theme.labelKey)}
                  {selected && (
                    <span className="theme-option__check">
                      <CheckIcon size={14} />
                    </span>
                  )}
                </span>
                <span className="theme-option__hint">{t(theme.hintKey)}</span>
              </button>
            );
          })}
        </div>

        <div className="setting-list">
          <SegmentedSetting
            title={t("settings.language")}
            description={t("settings.languageHint")}
            choices={localeCatalog.map((entry) => ({
              value: entry.id,
              label: entry.label,
            }))}
            value={preferences.locale}
            onChange={(locale: Locale) => onChange({ locale })}
          />
          <SegmentedSetting
            title={t("settings.density")}
            description={t("settings.densityHint")}
            choices={densityChoices.map((choice) => ({
              value: choice.value,
              label: t(choice.labelKey),
            }))}
            value={preferences.density}
            onChange={(density) => onChange({ density })}
          />
          <SegmentedSetting
            title={t("settings.motion")}
            description={t(motionHintKey)}
            choices={motionChoices.map((choice) => ({
              value: choice.value,
              label: t(choice.labelKey),
            }))}
            value={preferences.motion}
            onChange={(motion) => onChange({ motion })}
          />
          <div className="motion-preview">
            <div className="motion-preview__demo" key={`${preferences.motion}-${motionPreview}`} aria-hidden="true">
              <span className="motion-preview__menu"><i /><i /><i /></span>
              <span className="motion-preview__message"><i /><i /></span>
              <span className="motion-preview__done"><CheckIcon size={14} /></span>
            </div>
            <div className="motion-preview__text">
              <strong>{t("settings.motion.previewTitle")}</strong>
              <small>{t("settings.motion.previewHint")}</small>
            </div>
            <button type="button" className="button button--secondary button--sm" onClick={() => setMotionPreview((value) => value + 1)}>
              <PlayIcon size={13} />{t("settings.motion.preview")}
            </button>
          </div>
        </div>
      </section>

      <section className="panel glass glass--sheen">
        <header className="panel__head">
          <div>
            <h2 className="panel__title">{t("settings.notifications")}</h2>
            <p className="panel__hint">{t("settings.notificationsHint")}</p>
          </div>
        </header>
        <div className="setting-list">
          <SegmentedSetting
            title={t("settings.notifications.agentSound")}
            description={t("settings.notifications.agentSoundHint")}
            choices={notificationSoundChoices.map((sound) => ({
              value: sound,
              label: t(notificationSoundKeys[sound]),
            }))}
            value={preferences.agentCompletionSound}
            onChange={(agentCompletionSound) => {
              onChange({ agentCompletionSound });
              if (agentCompletionSound === "off") {
                setNotificationPreview("idle");
                return;
              }
              setNotificationPreview("playing");
              void playNotificationSound(agentCompletionSound).then((result) => {
                setNotificationPreview(
                  result === "unavailable" ? "unavailable" : "idle",
                );
              });
            }}
          />
          <div className="setting-notification-preview">
            <button
              type="button"
              className="button button--ghost button--sm"
              disabled={
                preferences.agentCompletionSound === "off" ||
                notificationPreview === "playing"
              }
              onClick={() => {
                setNotificationPreview("playing");
                void playNotificationSound(
                  preferences.agentCompletionSound,
                ).then((result) => {
                  setNotificationPreview(
                    result === "unavailable" ? "unavailable" : "idle",
                  );
                });
              }}
            >
              <PlayIcon size={13} />
              {t(
                notificationPreview === "playing"
                  ? "settings.notifications.previewing"
                  : "settings.notifications.preview",
              )}
            </button>
            {notificationPreview === "unavailable" && (
              <small className="is-danger" role="status">
                {t("settings.notifications.previewUnavailable")}
              </small>
            )}
          </div>
        </div>
      </section>

      <section className="panel glass glass--sheen">
        <header className="panel__head">
          <div>
            <h2 className="panel__title">{t("settings.storage")}</h2>
            <p className="panel__hint">{t("settings.storageHint")}</p>
          </div>
        </header>

        {storage.status?.recoveredReason && (
          <Callout tone="warn" title={t("settings.storage.recovered.title")}>
            {t("settings.storage.recovered.body", {
              path: displayPath(storage.status.recoveredBackupPath ?? ""),
              reason: storage.status.recoveredReason,
            })}
          </Callout>
        )}

        <dl className="field-list">
          <div className="field-row">
            <dt className="field-row__label">
              {t("settings.storage.location")}
            </dt>
            <dd className="field-row__value mono">
              {storage.mode === "persistent"
                ? storage.status?.path
                : storage.mode === "browser"
                  ? t("settings.storage.browser")
                  : t("common.detecting")}
            </dd>
          </div>
          {storage.mode === "persistent" && (
            <div className="field-row">
              <dt className="field-row__label">{t("nav.connections")}</dt>
              <dd className="field-row__value">
                {t("settings.storage.saved", {
                  count: storage.status?.profileCount ?? 0,
                })}
              </dd>
            </div>
          )}
        </dl>
      </section>

      <section className="panel glass glass--sheen">
        <header className="panel__head">
          <div>
            <h2 className="panel__title">{t("settings.security")}</h2>
            <p className="panel__hint">
              {host === "tauri"
                ? t("settings.securityHint")
                : host === "browser"
                  ? t("settings.security.browserHint")
                  : t("common.detecting")}
            </p>
          </div>
        </header>

        {desktopBackendAvailable ? (
          <Callout tone="security" title={t("settings.security.title")}>
            {t("settings.security.body")}
          </Callout>
        ) : host === "browser" ? (
          <Callout tone="info" title={t("settings.security.browser.title")}>
            {t("settings.security.browser.body")}
          </Callout>
        ) : null}

        <div className="setting-list">
          <SegmentedSetting
            title={t("settings.security.autoLock")}
            description={t("settings.security.autoLockDetail")}
            choices={vaultAutoLockChoices.map((choice) => ({
              value: choice.value,
              label: t(choice.labelKey),
            }))}
            value={preferences.vaultAutoLock}
            onChange={(vaultAutoLock) => onChange({ vaultAutoLock })}
          />
          <SegmentedSetting
            title={t("settings.security.background")}
            description={t("settings.security.backgroundDetail")}
            choices={backgroundLockChoices.map((choice) => ({
              value: choice.value,
              label: t(choice.labelKey),
            }))}
            value={
              preferences.vaultLockOnBackground ? "enabled" : "disabled"
            }
            onChange={(choice) =>
              onChange({ vaultLockOnBackground: choice === "enabled" })
            }
          />
          <SegmentedSetting
            title={t("settings.security.clipboard")}
            description={t("settings.security.clipboardDetail")}
            choices={clipboardClearChoices.map((choice) => ({
              value: choice.value,
              label: t(choice.labelKey),
            }))}
            value={preferences.sensitiveClipboardClear}
            onChange={(sensitiveClipboardClear) =>
              onChange({ sensitiveClipboardClear })
            }
          />
          <div className="setting">
            <div className="setting__text">
              <strong className="setting__title">
                {t("settings.security.clipboard.clearNow")}
              </strong>
              <p className="setting__description">
                {t("settings.security.clipboard.clearNowDetail")}
              </p>
              {clipboardNotice && (
                <p className="setting__description" aria-live="polite">
                  {t(clipboardNotice)}
                </p>
              )}
            </div>
            <button
              type="button"
              className="button button--secondary"
              disabled={clipboardBusy}
              onClick={() => {
                setClipboardBusy(true);
                setClipboardNotice(null);
                void clearSensitiveClipboard()
                  .then((outcome) => {
                    setClipboardNotice(clipboardOutcomeKeys[outcome]);
                  })
                  .finally(() => setClipboardBusy(false));
              }}
            >
              {clipboardBusy
                ? t("settings.security.clipboard.clearing")
                : t("settings.security.clipboard.clearAction")}
            </button>
          </div>
        </div>

        <EncryptedBackupPanel
          preferences={preferences}
          backendAvailable={desktopBackendAvailable}
          platform={runtime.summary?.platform}
          vaultUnlocked={vaultUnlocked}
          onRestored={onBackupRestored}
        />
      </section>

      <section className="panel glass glass--sheen">
        <header className="panel__head">
          <div>
            <h2 className="panel__title">{t("settings.about")}</h2>
            <p className="panel__hint">{t("settings.aboutHint")}</p>
          </div>
        </header>

        <dl className="field-list">
          <div className="field-row">
            <dt className="field-row__label">
              {t("settings.about.application")}
            </dt>
            <dd className="field-row__value">
              {summary?.appName ?? t("common.appName")}
            </dd>
          </div>
          <div className="field-row">
            <dt className="field-row__label">{t("settings.about.version")}</dt>
            <dd className="field-row__value mono">{summary?.version ?? "—"}</dd>
          </div>
          <div className="field-row">
            <dt className="field-row__label">{t("settings.about.runtime")}</dt>
            <dd className="field-row__value">
              {host === "tauri"
                ? t("settings.about.runtime.tauri")
                : host === "browser"
                  ? t("settings.about.runtime.browser")
                  : t("common.detecting")}
            </dd>
          </div>
          <div className="field-row">
            <dt className="field-row__label">
              {t("settings.about.credentialStore")}
            </dt>
            <dd className="field-row__value">
              {summary?.credentialStorageReady ? (
                <Chip tone="ok">{t("settings.about.credentialStore.ready")}</Chip>
              ) : (
                <Chip tone="planned">
                  {t("settings.about.credentialStore.pending")}
                </Chip>
              )}
            </dd>
          </div>
          <div className="field-row">
            <dt className="field-row__label">{t("settings.about.license")}</dt>
            <dd className="field-row__value">Mozilla Public License 2.0</dd>
          </div>
        </dl>
      </section>

      <section className="panel glass glass--sheen">
        <header className="panel__head">
          <div>
            <h2 className="panel__title">{t("settings.updater")}</h2>
            <p className="panel__hint">
              {t(usesAppleUpdates ? "settings.updater.iosHint" : "settings.updaterHint")}
            </p>
          </div>
        </header>

        <dl className="field-list">
          <div className="field-row">
            <dt className="field-row__label">{t("settings.updater.status")}</dt>
            <dd className="field-row__value">
              {host === "unknown" && (
                <Chip tone="info">{t("common.detecting")}</Chip>
              )}
              {host !== "unknown" && !inAppUpdaterAvailable && (
                <Chip tone="planned">
                  {t(usesAppleUpdates ? "settings.updater.iosChannel" : "settings.updater.desktopOnly")}
                </Chip>
              )}
              {inAppUpdaterAvailable && updater.status === "checking" && (
                <Chip tone="info">{t("settings.updater.checking")}</Chip>
              )}
              {inAppUpdaterAvailable && updater.status === "up-to-date" && (
                <Chip tone="ok">{t("settings.updater.upToDate")}</Chip>
              )}
              {inAppUpdaterAvailable && updater.status === "available" && (
                <Chip tone="warn">
                  {t("settings.updater.available", {
                    version: updater.availableVersion ?? "",
                  })}
                </Chip>
              )}
              {inAppUpdaterAvailable && updater.status === "downloading" && (
                <Chip tone="info">
                  {t("settings.updater.downloading", {
                    percent: updater.progressPercent,
                  })}
                </Chip>
              )}
              {inAppUpdaterAvailable && updater.status === "installing" && (
                <Chip tone="info">{t("settings.updater.installing")}</Chip>
              )}
              {inAppUpdaterAvailable && updater.status === "downloaded" && (
                <Chip tone="ok">{t("settings.updater.downloaded")}</Chip>
              )}
              {inAppUpdaterAvailable && updater.status === "error" && (
                <Chip tone="danger">
                  {t("settings.updater.error", { error: updater.error ?? "" })}
                </Chip>
              )}
              {inAppUpdaterAvailable && updater.status === "idle" && (
                <span className="text-muted">—</span>
              )}
            </dd>
          </div>
        </dl>

        {inAppUpdaterAvailable && (
          <SegmentedSetting
            title={t("settings.updater.autoCheck")}
            description={t("settings.updater.autoCheckHint")}
            choices={[
              { value: "enabled", label: t("settings.updater.autoCheck.on") },
              { value: "disabled", label: t("settings.updater.autoCheck.off") },
            ]}
            value={preferences.checkUpdatesOnLaunch ? "enabled" : "disabled"}
            onChange={(choice) =>
              onChange({ checkUpdatesOnLaunch: choice === "enabled" })
            }
          />
        )}

        {inAppUpdaterAvailable && updater.status === "available" && (
          <div className="stack" style={{ gap: "var(--space-3)", marginTop: "var(--space-4)" }}>
            <Callout
              tone="info"
              title={t("settings.updater.available", {
                version: updater.availableVersion ?? "",
              })}
            >
              {updater.releaseNotes ? (
                <div>
                  <strong>{t("settings.updater.releaseNotes")}：</strong>
                  <p style={{ marginTop: "var(--space-2)", whiteSpace: "pre-wrap" }}>
                    {updater.releaseNotes}
                  </p>
                </div>
              ) : null}
            </Callout>

            <button
              type="button"
              className="button button--primary"
              onClick={() => void updater.downloadAndInstall()}
            >
              {t("settings.updater.download")}
            </button>
            <p className="text-muted" style={{ margin: 0, fontSize: "var(--text-sm)" }}>
              {t("settings.updater.autoRestartHint")}
            </p>
          </div>
        )}

        {inAppUpdaterAvailable && updater.status === "downloaded" && (
          <div className="stack" style={{ gap: "var(--space-3)", marginTop: "var(--space-4)" }}>
            <Callout tone="info" title={t("settings.updater.downloaded")}>
              <p>{t("settings.updater.relaunch")}</p>
              {updater.error && (
                <p>
                  {t("settings.updater.relaunchError", {
                    error: updater.error,
                  })}
                </p>
              )}
            </Callout>

            <button
              type="button"
              className="button button--primary"
              onClick={() => void updater.relaunchApp()}
            >
              {t("settings.updater.relaunch")}
            </button>
          </div>
        )}

        {inAppUpdaterAvailable &&
          updater.status !== "available" &&
          updater.status !== "downloaded" &&
          updater.status !== "installing" && (
          <div style={{ marginTop: "var(--space-4)" }}>
            <button
              type="button"
              className="button button--ghost"
              disabled={
                updater.status === "checking" ||
                updater.status === "downloading"
              }
              onClick={() => {
                void updater.checkForUpdates();
              }}
            >
              {updater.status === "checking"
                ? t("settings.updater.checking")
                : t("settings.updater.check")}
            </button>
          </div>
        )}

        <ChangelogPanel currentVersion={summary?.version ?? APP_VERSION} />
      </section>

      {usesAppleUpdates && <PrivacyNotice />}

      <section className="panel glass glass--sheen">
        <header className="panel__head">
          <div>
            <h2 className="panel__title">{t("settings.mobile")}</h2>
            <p className="panel__hint">{t("settings.mobileHint")}</p>
          </div>
        </header>

        <div className="mobile-download">
          <div className="mobile-download__qr">
            <img
              src={mobileDownloadQr}
              alt={t("settings.mobile.qrAlt")}
              width={168}
              height={168}
            />
          </div>
          <div className="mobile-download__body">
            <p className="mobile-download__lead">{t("settings.mobile.scan")}</p>
            <ul className="mobile-download__list">
              <li>{t("settings.mobile.android")}</li>
              <li>{t("settings.mobile.ios")}</li>
            </ul>
            <a
              className="mobile-download__link mono"
              href="https://nickyclin.github.io/lattice-term/"
              target="_blank"
              rel="noreferrer"
            >
              nickyclin.github.io/lattice-term
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}
