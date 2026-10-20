import { useMemo, useRef, useState } from "react";
import { useCredentialDeleteGuard } from "../../app/useSavedCredential";
import { connectionTarget, findProtocol, type ConnectionProfile } from "../../domain/connection";
import { useI18n } from "../../i18n/context";
import { ConfirmDialog } from "../overlays/ConfirmDialog";

export function ConnectionDeleteDialog({ profiles, onRemove, onClose, onOpenVault }: {
  profiles: ConnectionProfile[];
  onRemove: (id: string) => Promise<void>;
  onClose: () => void;
  onOpenVault: () => void;
}) {
  const { t } = useI18n();
  const [selection, setSelection] = useState(profiles[0]?.id ?? "");
  const [removed, setRemoved] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const removing = useRef(false);
  const remaining = useMemo(() => profiles.filter((profile) => !removed.includes(profile.id)), [profiles, removed]);
  const targets = useMemo(() => selection === "" ? remaining : remaining.filter((profile) => profile.id === selection), [remaining, selection]);
  const guard = useCredentialDeleteGuard(targets);
  const wholeCard = selection === "";
  const label = (profile: ConnectionProfile) =>
    `${findProtocol(profile.protocol).acronym} · ${profile.name} · ${connectionTarget(profile)}`;
  const name = targets[0] ? label(targets[0]) : profiles[0]?.name ?? "";

  async function confirm() {
    if (removing.current || guard.mode === "loading" || guard.mode === "unavailable" || error || targets.length === 0) return;
    if (guard.mode === "saved") {
      onOpenVault();
      return;
    }
    removing.current = true;
    setBusy(true);
    const completed = [...removed];
    try {
      for (const profile of targets) {
        await onRemove(profile.id);
        completed.push(profile.id);
      }
      onClose();
    } catch (reason) {
      setRemoved(completed);
      setError(t("confirm.delete.partial", {
        count: completed.length,
        detail: reason instanceof Error ? reason.message : String(reason),
      }));
    } finally {
      removing.current = false;
      setBusy(false);
    }
  }

  return (
    <ConfirmDialog
      title={guard.mode === "saved"
        ? wholeCard ? t("confirm.delete.cardCredentialTitle") : t("confirm.delete.credential.title", { name })
        : wholeCard
          ? t("confirm.delete.cardTitle", { name: profiles[0]?.name ?? "" })
          : t("confirm.delete.routeTitle")}
      body={error ?? (guard.mode === "saved"
        ? t(wholeCard ? "confirm.delete.cardCredentialBody" : "confirm.delete.credential.body", { provider: guard.provider })
        : guard.mode === "unavailable"
          ? t("confirm.delete.credential.unavailable.body", { detail: guard.detail })
          : guard.mode === "loading"
            ? t("confirm.delete.credential.loading")
            : wholeCard
              ? t("confirm.delete.cardBody", { count: targets.length })
              : t("confirm.delete.routeBody"))}
      confirmLabel={guard.mode === "saved"
        ? t("confirm.delete.credential.openVault")
        : guard.mode === "loading"
          ? t("confirm.delete.credential.checking")
          : guard.mode === "unavailable" || error
            ? t("confirm.delete.credential.blocked")
            : wholeCard
              ? t("confirm.delete.cardAction")
              : t("confirm.delete.routeAction")}
      cancelLabel={t("common.cancel")}
      confirmDisabled={guard.mode === "loading" || guard.mode === "unavailable" || error !== null || targets.length === 0}
      busy={busy}
      tone={guard.mode === "saved" ? "default" : "danger"}
      onConfirm={() => { void confirm(); }}
      onCancel={() => { if (!removing.current) onClose(); }}
    >
      {profiles.length > 1 && (
        <label className="field">
          <span className="field__label">{t("confirm.delete.scope")}</span>
          <select className="select" value={selection} disabled={busy} onChange={(event) => {
            setSelection(event.target.value);
            setError(null);
          }}>
            {remaining.map((profile) => <option key={profile.id} value={profile.id}>{label(profile)}</option>)}
            <option value="">{t("confirm.delete.card", { count: remaining.length })}</option>
          </select>
        </label>
      )}
      <ul className="connection-delete__targets">
        {targets.map((profile) => <li key={profile.id}>{label(profile)}</li>)}
      </ul>
    </ConfirmDialog>
  );
}
