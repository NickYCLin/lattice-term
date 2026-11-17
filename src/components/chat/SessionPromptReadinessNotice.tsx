import { Callout } from "../common/Callout";
import { useI18n } from "../../i18n/context";
import { PROMPT_STUCK_AFTER_MS, readinessReasonKey, type PromptReadiness } from "../../app/usePromptReadiness";

export function SessionPromptReadinessNotice({
  readiness,
  pending,
  error,
  onReconcile,
}: {
  readiness: PromptReadiness | null;
  pending?: boolean;
  error?: string | null;
  onReconcile: () => void;
}) {
  const { t } = useI18n();
  const blockers = readiness?.blockers ?? [];
  if ((!readiness || readiness.ready) && blockers.length === 0 && !error) return null;
  const stuckSeconds = Math.floor((readiness?.unconfirmedMs ?? 0) / 1000);
  const stuck = (readiness?.unconfirmedMs ?? 0) >= PROMPT_STUCK_AFTER_MS;
  return (
    <Callout
      tone="warn"
      title={t("sessionChat.unconfirmed")}
      actions={
        <button type="button" className="button button--ghost button--sm" disabled={pending} onClick={onReconcile}>
          {t("sessionChat.reconcile")}
        </button>
      }
    >
      {stuck && <p>{t("sessionChat.readinessStuck", { seconds: stuckSeconds })}</p>}
      {blockers.map(code => {
        const key = readinessReasonKey(code);
        return <p key={code}>{key ? t(key) : code}</p>;
      })}
      <p>{t("sessionChat.reconcileHint")}</p>
      {error && <p role="alert">{error}</p>}
    </Callout>
  );
}
