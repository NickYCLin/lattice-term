import { useId, useRef, useState } from "react";
import { connectionTarget, type MachineCard } from "../../domain/connection";
import { useI18n } from "../../i18n/context";
import { ConfirmDialog } from "../overlays/ConfirmDialog";

export function ConnectionMergeDialog({ name, candidates, onMerge, onClose }: {
  name: string;
  candidates: MachineCard[];
  onMerge: (id: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const selectId = useId();
  const [targetId, setTargetId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const target = candidates.find((card) => card.profile.id === targetId);

  async function merge() {
    if (!target || saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      const failure = await onMerge(target.profile.id);
      if (failure) setError(failure);
      else onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  return (
    <ConfirmDialog title={t("connections.merge.title", { name })}
      body={t("connections.merge.hint")}
      confirmLabel={t("connections.merge.action")} cancelLabel={t("common.cancel")}
      tone="default" busy={busy} confirmDisabled={!target}
      onConfirm={() => void merge()} onCancel={onClose}>
      <div className="field">
        <label className="field__label" htmlFor={selectId}>{t("inspector.machine.pick")}</label>
        <select id={selectId} className="input" value={targetId} disabled={busy}
          onChange={(event) => { setTargetId(event.currentTarget.value); setError(null); }}>
          <option value="">{t("inspector.machine.pick")}</option>
          {candidates.map((card) => <option key={card.profile.id} value={card.profile.id}>
            {card.profile.name} · {connectionTarget(card.profile)} · {t("row.routeCount", { count: card.linked.length + 1 })}
          </option>)}
        </select>
      </div>
      {target && <ul className="connection-merge__routes">
        {[target.profile, ...target.linked].map((profile) => <li key={profile.id}>
          {profile.name} · <span className="mono">{connectionTarget(profile)}</span>
        </li>)}
      </ul>}
      {error && <p role="alert">{t("inspector.machine.failed", { error })}</p>}
    </ConfirmDialog>
  );
}
