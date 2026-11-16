import { useRef, useState } from "react";
import { findProtocol, type ConnectionProfile } from "../../domain/connection";
import { jumpGateways, legacyJumpCandidates } from "../../app/jumpRoutes";
import type { Workspace } from "../../app/useWorkspace";
import { useI18n } from "../../i18n/context";
import { useModalFocus } from "../overlays/modalFocus";

export function JumpMigrationDialog({ profiles, onMerge, onClose }: {
  profiles: ConnectionProfile[]; onMerge: Workspace["migrateJumpProfile"]; onClose: () => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [ports, setPorts] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState("");
  useModalFocus({ dialogRef, onEscape: () => { if (!lock.current) onClose(); } });
  async function apply(legacyId: string, targetId?: string, gatewayId?: string, targetPort?: number) {
    if (lock.current || targetId && !gatewayId) return;
    lock.current = true; setBusy(true); setError("");
    try { const failure = await (targetPort === undefined ? onMerge(legacyId, targetId, gatewayId) : onMerge(legacyId, targetId, gatewayId, targetPort)); if (failure) setError(t("jump.migration.failed")); }
    catch { setError(t("jump.migration.failed")); }
    finally { lock.current = false; setBusy(false); }
  }
  const candidates = legacyJumpCandidates(profiles);
  const retained = profiles.filter(profile => profile.retiredTo);
  return <div className="scrim scrim--center" role="presentation" onMouseDown={() => { if (!lock.current) onClose(); }}>
    <div className="dialog jump-migration" role="dialog" aria-modal="true" aria-labelledby="jump-migration-title" ref={dialogRef} tabIndex={-1} onMouseDown={event => event.stopPropagation()}>
      <h2 id="jump-migration-title">{t("jump.migration.title")}</h2><p>{t("jump.migration.hint")}</p>
      <ul className="jump-migration__list">{candidates.map(({ legacy, target }) => <li key={legacy.id}>
        <p><strong>{legacy.name}</strong> ({legacy.hostname}:{legacy.port}) → <strong>{target.name}</strong> ({target.hostname}:{target.port})</p>
        <label><span>{t("jump.setting")}</span><select className="select" value={selected[legacy.id] ?? ""} disabled={busy} onChange={event => setSelected(current => ({ ...current, [legacy.id]: event.target.value }))}>
          <option value="">{t("jump.choose")}</option>{jumpGateways(profiles, target.id).filter(gateway => gateway.id !== legacy.id).map(gateway => <option key={gateway.id} value={gateway.id}>{gateway.name}</option>)}
        </select></label>
        {legacy.protocol !== target.protocol && <label className="field"><span>{t("jump.migration.newRoute", { protocol: findProtocol(legacy.protocol).acronym, host: target.hostname })}</span>
          <input className="input" type="number" min={1} max={65535} value={ports[legacy.id] ?? findProtocol(legacy.protocol).defaultPort} disabled={busy} onChange={event => setPorts(current => ({ ...current, [legacy.id]: Number(event.target.value) }))} />
        </label>}
        <button className="button button--primary" type="button" disabled={busy || !selected[legacy.id] || legacy.protocol !== target.protocol && (!Number.isInteger(ports[legacy.id] ?? findProtocol(legacy.protocol).defaultPort) || (ports[legacy.id] ?? findProtocol(legacy.protocol).defaultPort) < 1 || (ports[legacy.id] ?? findProtocol(legacy.protocol).defaultPort) > 65535)} onClick={() => { void apply(legacy.id, target.id, selected[legacy.id], legacy.protocol !== target.protocol ? ports[legacy.id] ?? findProtocol(legacy.protocol).defaultPort : undefined); }}>{t("jump.migration.confirm")}</button>
      </li>)}</ul>
      {!candidates.length && <p>{t("jump.migration.none")}</p>}
      {!!retained.length && <><h3>{t("jump.migration.retained")}</h3><ul>{retained.map(legacy => <li key={legacy.id}>{legacy.name} · {legacy.hostname}:{legacy.port} <button className="button button--secondary" type="button" disabled={busy} onClick={() => { void apply(legacy.id); }}>{t("jump.migration.restore")}</button></li>)}</ul></>}
      {error && <p role="alert">{error}</p>}
      <div className="dialog__actions"><button className="button button--secondary" type="button" disabled={busy} onClick={onClose}>{t("common.close")}</button></div>
    </div>
  </div>;
}
