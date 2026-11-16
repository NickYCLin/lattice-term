import { useRef, useState } from "react";
import type { ConnectionImportPlan } from "../../domain/export";
import type { Workspace } from "../../app/useWorkspace";
import { useI18n } from "../../i18n/context";
import { ConfirmDialog } from "../overlays/ConfirmDialog";

export function ConnectionImportPreview({ plan, issues, onConfirm, onClose, onSaved }: {
  plan: ConnectionImportPlan;
  issues: string;
  onConfirm: Workspace["importProfiles"];
  onClose: () => void;
  onSaved: (result: Awaited<ReturnType<Workspace["importProfiles"]>>) => void;
}) {
  const { t } = useI18n();
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function confirm() {
    if (lock.current || plan.conflicts.length) return;
    lock.current = true; setBusy(true); setError(null);
    try {
      const result = await onConfirm(plan);
      if (result.error) {
        setError(result.error === "transfer.import.changed" ? t("transfer.import.changed")
          : result.error === "transfer.import.busy" ? t("transfer.import.busy")
            : t("transfer.import.persistFailedBody", { error: result.error }));
      } else onSaved(result);
    } catch (reason) { setError(t("transfer.import.persistFailedBody", { error: String(reason) })); }
    finally { lock.current = false; setBusy(false); }
  }
  return <ConfirmDialog tone="default" title={t("transfer.import.preview")}
    body={t("transfer.import.summary", { added: plan.addedCount, overwritten: plan.overwrittenCount })}
    confirmLabel={t("transfer.import.confirm")} cancelLabel={t("common.cancel")}
    busy={busy} confirmDisabled={plan.conflicts.length > 0} onConfirm={() => { void confirm(); }}
    onCancel={() => { if (!lock.current) onClose(); }}>
    <p className="dialog__body">{t("transfer.import.previewHint")}</p>
    {!!issues && <p role="status" className="dialog__body">{issues}</p>}
    {!!plan.conflicts.length && <p role="alert" className="field__error">{t("transfer.import.conflict")}</p>}
    <ul className="connection-import__changes">{plan.changes.map(({ kind, profile }) => <li key={profile.id}>
      <strong>{t(kind === "added" ? "transfer.import.added" : "transfer.import.overwritten")}</strong> · {profile.name}
    </li>)}</ul>
    {plan.routeChanges.length > 0 && <section aria-label={t("transfer.import.routeChanges")}>
      <h3>{t("transfer.import.routeChanges")}</h3>
      <ul className="connection-import__changes">{plan.routeChanges.map(change => {
        const action = change.field === "jumpProfileId"
          ? !change.after ? "transfer.import.jumpCleared" : !change.before ? "transfer.import.jumpSet" : "transfer.import.jumpChanged"
          : !change.after ? "transfer.import.retireCleared" : !change.before ? "transfer.import.retireSet" : "transfer.import.retireChanged";
        const before = plan.original.find(profile => profile.id === change.before)?.name ?? change.before ?? t("transfer.import.routeNone");
        const after = plan.next.find(profile => profile.id === change.after)?.name ?? change.after ?? t("transfer.import.routeNone");
        return <li key={`${change.profileId}:${change.field}`}><strong>{change.name} · {t(action)}</strong>：{before} → {after}</li>;
      })}</ul>
    </section>}
    {plan.routeWarnings.length > 0 && <section role="alert" aria-label={t("transfer.import.routeWarnings")}>
      <h3>{t("transfer.import.routeWarnings")}</h3><p>{t("transfer.import.routeWarningsHint")}</p>
      <ul>{plan.routeWarnings.map(warning => <li key={`${warning.profileId}:${warning.field}`}>
        {warning.name} · {t(warning.field === "jumpProfileId" ? "transfer.import.jumpCleared" : "transfer.import.retireCleared")} ({warning.reference})
      </li>)}</ul>
    </section>}
    {error && <p role="alert" className="field__error">{error}</p>}
  </ConfirmDialog>;
}
