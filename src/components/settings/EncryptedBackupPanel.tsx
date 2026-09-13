import { FileDropZone } from "../files/FileDropZone";
import { readSelectedText, localFileError, type UploadFile } from "../../app/localFiles";
import { useRef, useState } from "react";
import type { Preferences } from "../../app/preferences";
import {
  applyRestoredLocalStorage,
  backupPasswordIsValid,
  BACKUP_EXTENSION,
  exportEncryptedBackup,
  restoreEncryptedBackup,
  type EncryptedBackupRestore,
} from "../../app/encryptedBackup";
import { useI18n } from "../../i18n/context";
import { Callout } from "../common/Callout";
import { ConfirmDialog } from "../overlays/ConfirmDialog";

interface EncryptedBackupPanelProps {
  preferences: Preferences;
  backendAvailable: boolean;
  platform?: string;
  vaultUnlocked: boolean;
  onRestored: (
    result: EncryptedBackupRestore,
    preferences: Preferences,
  ) => Promise<void>;
}

type Notice = { tone: "info" | "danger"; message: string } | null;

export function EncryptedBackupPanel({
  preferences,
  backendAvailable,
  platform,
  vaultUnlocked,
  onRestored,
}: EncryptedBackupPanelProps) {
  const { t } = useI18n();
  const fileRef = useRef<HTMLInputElement>(null);
  const [exportPassword, setExportPassword] = useState("");
  const [exportConfirmation, setExportConfirmation] = useState("");
  const [restorePassword, setRestorePassword] = useState("");
  const [selectedFile, setSelectedFile] = useState<UploadFile | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [busy, setBusy] = useState<"export" | "restore" | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  const exportReady =
    backendAvailable &&
    !vaultUnlocked &&
    !busy &&
    backupPasswordIsValid(exportPassword) &&
    exportPassword === exportConfirmation;
  const restoreReady =
    backendAvailable &&
    !vaultUnlocked &&
    !busy &&
    backupPasswordIsValid(restorePassword) &&
    selectedFile !== null;

  async function runExport() {
    if (!exportReady) return;
    setBusy("export");
    setNotice(null);
    try {
      const result = await exportEncryptedBackup(exportPassword, preferences, platform);
      setNotice({
        tone: "info",
        message: result.delivery.destination === "ios-documents"
          ? t("transfer.export.iosSaved", { filename: result.delivery.filename })
          : t("settings.backup.exported", { count: result.appFileCount }),
      });
      setExportPassword("");
      setExportConfirmation("");
    } catch (reason) {
      setNotice({
        tone: "danger",
        message: t("settings.backup.failed", { error: localFileError(reason, t) }),
      });
    } finally {
      setBusy(null);
    }
  }

  async function runRestore() {
    if (!restoreReady || !selectedFile) return;
    setConfirmRestore(false);
    setBusy("restore");
    setNotice(null);
    try {
      const contents = await readSelectedText(selectedFile, 28 * 1024 * 1024);
      const result = await restoreEncryptedBackup(contents, restorePassword);
      const restoredPreferences = applyRestoredLocalStorage(
        window.localStorage,
        result.localStorage,
      );
      await onRestored(result, restoredPreferences);
      setNotice({
        tone: "info",
        message: t("settings.backup.restored", {
          profiles: result.profileCount,
          hosts: result.trustedHostCount,
          plans: result.agentPlanCount,
        }),
      });
      setRestorePassword("");
      setSelectedFile(null);
      if (fileRef.current) fileRef.current.value = "";
    } catch (reason) {
      setNotice({
        tone: "danger",
        message: t("settings.backup.failed", { error: localFileError(reason, t) }),
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="setting-list">
      <div className="setting">
        <div className="setting__text">
          <strong className="setting__title">{t("settings.security.backup")}</strong>
          <p className="setting__description">
            {t("settings.security.backupDetail")}
          </p>
        </div>
      </div>

      {!backendAvailable && (
        <Callout tone="info" title={t("settings.backup.desktopOnly.title")}>
          {t("settings.backup.desktopOnly.body")}
        </Callout>
      )}

      <Callout tone="security" title={t("settings.backup.scope.title")}>
        {t("settings.backup.scope.body")}
      </Callout>

      {vaultUnlocked && (
        <Callout tone="warn" title={t("settings.backup.vaultUnlocked.title")}>
          {t("settings.backup.vaultUnlocked.body")}
        </Callout>
      )}

      {notice && (
        <Callout
          tone={notice.tone === "danger" ? "danger" : "info"}
          title={
            notice.tone === "danger"
              ? t("settings.backup.errorTitle")
              : t("settings.backup.doneTitle")
          }
        >
          {notice.message}
        </Callout>
      )}

      <div className="setting">
        <div className="setting__text">
          <strong className="setting__title">{t("settings.backup.export.title")}</strong>
          <p className="setting__description">
            {t("settings.backup.export.body")}
          </p>
        </div>
        <div className="dialog__stack">
          <label className="field">
            <span className="field__label">{t("settings.backup.password")}</span>
            <input
              className="input"
              type="password"
              disabled={!backendAvailable}
              autoComplete="new-password"
              value={exportPassword}
              onChange={(event) => setExportPassword(event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field__label">
              {t("settings.backup.passwordConfirm")}
            </span>
            <input
              className="input"
              type="password"
              disabled={!backendAvailable}
              autoComplete="new-password"
              value={exportConfirmation}
              onChange={(event) => setExportConfirmation(event.target.value)}
            />
          </label>
          {exportPassword && !backupPasswordIsValid(exportPassword) && (
            <span className="field__error">{t("settings.backup.passwordHint")}</span>
          )}
          {exportConfirmation && exportPassword !== exportConfirmation && (
            <span className="field__error">{t("settings.backup.passwordMismatch")}</span>
          )}
          <button
            type="button"
            className="button button--secondary"
            disabled={!exportReady}
            onClick={() => void runExport()}
          >
            {busy === "export"
              ? t("settings.backup.exporting")
              : t("settings.backup.export.action")}
          </button>
        </div>
      </div>

      <div className="setting">
        <div className="setting__text">
          <strong className="setting__title">{t("settings.backup.restore.title")}</strong>
          <p className="setting__description">
            {t("settings.backup.restore.body")}
          </p>
        </div>
        <div className="dialog__stack">
          <div className="field">
            <span className="field__label">{t("settings.backup.file")}</span>
            <input
              ref={fileRef}
              id="encrypted-backup-file"
              className="visually-hidden"
              type="file"
              accept={BACKUP_EXTENSION}
              disabled={!backendAvailable || busy !== null || confirmRestore}
              onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
            />
            <FileDropZone disabled={!backendAvailable || busy !== null || confirmRestore} onSelect={setSelectedFile}>
            <div className="backup-file-picker">
              <button
                type="button"
                className="button button--secondary"
                disabled={!backendAvailable || busy !== null || confirmRestore}
                onClick={() => fileRef.current?.click()}
              >
                {t("settings.backup.fileChoose")}
              </button>
              <span className="backup-file-picker__name mono" title={selectedFile?.name}>
                {selectedFile?.name ?? t("settings.backup.fileNone")}
              </span>
            </div>
            </FileDropZone>
          </div>
          <label className="field">
            <span className="field__label">{t("settings.backup.password")}</span>
            <input
              className="input"
              type="password"
              disabled={!backendAvailable}
              autoComplete="current-password"
              value={restorePassword}
              onChange={(event) => setRestorePassword(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="button button--danger"
            disabled={!restoreReady}
            onClick={() => setConfirmRestore(true)}
          >
            {busy === "restore"
              ? t("settings.backup.restoring")
              : t("settings.backup.restore.action")}
          </button>
        </div>
      </div>

      {confirmRestore && (
        <ConfirmDialog
          title={t("settings.backup.confirm.title")}
          body={t("settings.backup.confirm.body", {
            file: selectedFile?.name ?? "",
          })}
          confirmLabel={t("settings.backup.confirm.action")}
          cancelLabel={t("common.cancel")}
          tone="danger"
          onConfirm={() => void runRestore()}
          onCancel={() => setConfirmRestore(false)}
        />
      )}
    </div>
  );
}
