import { useI18n } from "../../i18n/context";

/** Shared ordering and shortcuts for standalone and existing-session cards. */
export function ApprovalActions({ canAllowSession = false, allowOnce = true, disabled = false, unsupportedReason, onAnswer }: {
  canAllowSession?: boolean;
  allowOnce?: boolean;
  disabled?: boolean;
  unsupportedReason: string;
  onAnswer: (allow: boolean, forSession?: boolean) => void;
}) {
  const { t } = useI18n();
  return <>
    {allowOnce && <button type="button" className="button button--primary button--sm" disabled={disabled}
      aria-keyshortcuts="Enter" title={canAllowSession ? t("chat.approval.allowShortcut") : unsupportedReason}
      onClick={() => onAnswer(true)}>{t("chat.approval.allow")}</button>}
    {canAllowSession && <button type="button" className="button button--secondary button--sm" disabled={disabled}
      aria-keyshortcuts="Shift+Enter" title={`${t("chat.approval.sessionHint")} ${t("chat.approval.sessionShortcut")}`}
      onClick={() => onAnswer(true, true)}>{t("chat.approval.allowSession")}</button>}
    <button type="button" className="button button--secondary button--sm" disabled={disabled}
      aria-keyshortcuts="Escape" title={t("chat.approval.denyShortcut")}
      onClick={() => onAnswer(false)}>{t("chat.approval.deny")}</button>
  </>;
}
