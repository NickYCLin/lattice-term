import { useEffect, useState } from "react";
import { useI18n } from "../../i18n/context";
import { defaultProjectLaunchPolicy, type ProjectLaunchPolicy } from "../../app/useAgentSessions";

export function ProjectLaunchSettings({ policy = defaultProjectLaunchPolicy, disabled, save, reportError }: {
  policy?: ProjectLaunchPolicy;
  disabled: boolean;
  save: (policy: ProjectLaunchPolicy) => Promise<ProjectLaunchPolicy>;
  reportError: (error: unknown) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(policy);
  const [roots, setRoots] = useState(policy.roots.join("\n"));
  const [busy, setBusy] = useState(false);
  useEffect(() => { setDraft(policy); setRoots(policy.roots.join("\n")); }, [policy]);
  const persist = (value: ProjectLaunchPolicy) => {
    setBusy(true);
    void save(value).then((saved) => { setDraft(saved); setRoots(saved.roots.join("\n")); })
      .catch(reportError).finally(() => setBusy(false));
  };
  return <fieldset disabled={disabled || busy}>
    <legend>{t("agents.mcp.project.title")}</legend>
    <p className="agents-field-hint">{t("agents.mcp.project.risk")}</p>
    <label><span>{t("agents.mcp.project.roots")}</span>
      <textarea value={roots} onChange={(e) => setRoots(e.currentTarget.value)} />
    </label>
    <label><span>{t("agents.mcp.project.permissions")}</span>
      <select value={draft.fullPermissions ? "full" : "saved"} onChange={(e) => setDraft({ ...draft, fullPermissions: e.currentTarget.value === "full" })}>
        <option value="full">{t("agents.mcp.project.full")}</option>
        <option value="saved">{t("agents.mcp.project.saved")}</option>
      </select>
    </label>
    <label><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.currentTarget.checked })} />{t("agents.mcp.project.enable")}</label>
    <button type="button" className="button button--secondary" onClick={() => persist({ ...draft, roots: roots.split("\n").map((root) => root.trim()).filter(Boolean) })}>{t("agents.mcp.project.save")}</button>
    {policy.enabled && <button type="button" className="button button--ghost" onClick={() => persist({ ...policy, enabled: false, roots: [] })}>{t("agents.mcp.project.revoke")}</button>}
  </fieldset>;
}
