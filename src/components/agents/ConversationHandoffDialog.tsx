import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../overlays/ConfirmDialog";
import { useI18n } from "../../i18n/context";
import { validCliProxyModel, type AccountModelSelection } from "../../app/accountModels";
import type { AgentDefinition } from "../../app/useAgentSessions";
import type { ChatAccountProfile } from "../../app/chatAccountProfiles";
import { handoffSummary } from "../../app/handoffSummary";

export function ConversationHandoffDialog({ source, loadSummary, definitions, profiles, initialTarget, apiTargets = [], onConfirm, onCancel }: {
  source: string;
  loadSummary: () => Promise<string | null>;
  definitions: readonly AgentDefinition[];
  profiles: readonly ChatAccountProfile[];
  initialTarget?: AccountModelSelection;
  apiTargets?: readonly (AccountModelSelection & { label: string })[];
  onConfirm: (summary: string, target: AccountModelSelection) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [summary, setSummary] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const targets = definitions.filter(definition => definition.installed).flatMap(definition => [
    { definitionId: definition.id, accountProfileId: null, model: "", label: `${definition.label} · ${t("agents.account.default")}` },
    ...profiles.filter(profile => profile.definitionId === definition.id).map(profile => ({
      definitionId: definition.id, accountProfileId: profile.id, model: "", label: `${definition.label} · ${profile.name}`,
    })),
  ]);
  const [target, setTarget] = useState<AccountModelSelection | null>(initialTarget ?? targets[0] ?? null);
  useEffect(() => {
    let current = true;
    void loadSummary().then(text => {
      if (!current) return;
      setSummary(handoffSummary(text ?? ""));
      if (!text) setNotice(t("handoff.summary.missing"));
    }).catch(() => { if (current) setNotice(t("handoff.summary.missing")); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, []);
  async function submit() {
    if (submitting.current || !target || !summary.trim() || loading || (target.provider && !validCliProxyModel(target.model))) return;
    const reviewed = handoffSummary(summary.trim());
    if (reviewed !== summary.trim()) {
      setSummary(reviewed);
      setNotice(t("handoff.summary.redacted"));
      return;
    }
    submitting.current = true;
    setBusy(true);
    setNotice(null);
    try { await onConfirm(reviewed, target); }
    catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)); }
    finally { submitting.current = false; setBusy(false); }
  }
  const key = (value: AccountModelSelection) => `${value.definitionId}:${value.accountProfileId ?? ""}:${value.provider ?? ""}:${value.proxyId ?? ""}`;
  const availableTargets = [...targets, ...apiTargets];
  if (initialTarget?.provider && !availableTargets.some(value => key(value) === key(initialTarget))) {
    availableTargets.push({ ...initialTarget, label: `${initialTarget.definitionId} API · ${initialTarget.proxyId ?? ""}` });
  }
  return <ConfirmDialog title={t("handoff.summary.title")} body={t("handoff.summary.disclosure", { source })}
    dialogClassName="handoff-dialog"
    tone="default" confirmLabel={t("handoff.summary.confirm")} cancelLabel={t("common.cancel")}
    busy={busy} confirmDisabled={loading || !summary.trim() || !target || Boolean(target.provider && !validCliProxyModel(target.model))} onConfirm={() => void submit()} onCancel={onCancel}>
    {notice && <p role="alert">{notice}</p>}
    {loading && <p role="status">{t("common.loading")}</p>}
    <label className="field"><span>{t("handoff.summary.target")}</span><select className="select" disabled={busy}
      value={target ? key(target) : ""} onChange={event => setTarget(availableTargets.find(value => key(value) === event.currentTarget.value) ?? null)}>
      {availableTargets.map(value => <option key={key(value)} value={key(value)}>{value.label}</option>)}
    </select></label>
    <label className="field"><span>{t("conversation.meta.model")}</span><input className="input" disabled={busy}
      value={target?.model ?? ""} onChange={event => { const model = event.currentTarget.value; setTarget(value => value ? { ...value, model } : value); }} /></label>
    <label className="field"><span>{t("handoff.summary.edit")}</span><textarea className="input handoff-summary" rows={10}
      maxLength={16000} disabled={busy || loading} value={summary} onChange={event => setSummary(event.currentTarget.value)} /></label>
  </ConfirmDialog>;
}
