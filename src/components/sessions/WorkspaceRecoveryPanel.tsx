import { useState } from "react";
import "./workspaceRecovery.css";
import { useI18n } from "../../i18n/context";
import { projectDirectoryKey } from "../../app/localProjects";
import {
  readWorkspaceRecoverySnapshots,
  type SavedAgentSession,
  type SavedWorkspaceSession,
  type WorkspaceSessionSnapshot,
} from "../../app/workspaceSessionPersistence";

export interface WorkspaceRecoveryProps {
  localProjectDirectories?: readonly string[];
  projectStorageError?: boolean;
  onRemoveLocalProject?: (path: string) => void;
  onRetryWorkspaceSession?: (session: SavedAgentSession) => Promise<void>;
  onRecoverWorkspaceSnapshot?: (snapshot: WorkspaceSessionSnapshot) => void;
  retryingWorkspace?: boolean;
  workspaceRecoveryError?: boolean;
}

export function WorkspaceRecoveryPanel({
  localProjectDirectories = [], projectStorageError,
  onRemoveLocalProject, onRetryWorkspaceSession, onRecoverWorkspaceSnapshot,
  retryingWorkspace, workspaceRecoveryError, pending, occupied, ready,
}: WorkspaceRecoveryProps & {
  pending: readonly SavedWorkspaceSession[];
  occupied: readonly string[];
  ready: boolean;
}) {
  const { t } = useI18n();
  const [copies, setCopies] = useState<ReturnType<typeof readWorkspaceRecoverySnapshots>>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [remove, setRemove] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [imported, setImported] = useState(false);
  const saved = copies.find(copy => copy.index === selected)?.snapshot;
  const agents = pending.filter((entry): entry is SavedAgentSession => entry.kind === "agent");
  const preview = saved?.sessions.filter((entry): entry is SavedAgentSession => entry.kind === "agent") ?? [];
  return <details className="panel workspace-recovery">
    <summary>{t("workspace.recovery.title")}{agents.length > 0 ? ` (${agents.length})` : ""}</summary>
    <p className="field__hint">{t("workspace.recovery.hint")}</p>
    {(projectStorageError || workspaceRecoveryError || error) &&
      <p role="alert">{t("workspace.recovery.error")}</p>}
    {agents.map((entry, index) => <div className="workspace-recovery__row" key={`${entry.groupKey}:${index}`}>
      <span>{entry.groupLabel} · {entry.label}</span>
      <span className="mono">{entry.workingDirectory}</span>
      <button className="button button--secondary button--sm" disabled={!ready || retryingWorkspace || !onRetryWorkspaceSession}
        onClick={() => void onRetryWorkspaceSession?.(entry)}>{t("workspace.recovery.retry")}</button>
    </div>)}
    <h3>{t("workspace.projects.saved")}</h3>
    {localProjectDirectories.map(path => {
      const active = occupied.some(item => projectDirectoryKey(item) === projectDirectoryKey(path));
      return <div className="workspace-recovery__row" key={path}>
        <span className="mono">{path}</span>
        <button className="button button--secondary button--sm" disabled={!ready || active || retryingWorkspace || !onRemoveLocalProject}
          title={active ? t("workspace.projects.closeFirst") : undefined}
          onClick={() => setRemove(path)}>{t("workspace.projects.remove")}</button>
        {remove === path && <div role="group" aria-label={t("workspace.projects.confirm")}>
          <p>{t("workspace.projects.confirm")}</p>
          <button className="button button--secondary button--sm" onClick={() => setRemove(null)}>{t("common.cancel")}</button>
          <button className="button button--danger button--sm" disabled={active || !ready || retryingWorkspace} onClick={() => {
            try { onRemoveLocalProject?.(path); setRemove(null); setError(false); }
            catch { setError(true); }
          }}>{t("workspace.projects.remove")}</button>
        </div>}
      </div>;
    })}
    <button className="button button--secondary button--sm" onClick={() => {
      try {
        setCopies(readWorkspaceRecoverySnapshots(window.localStorage));
        setSelected(null); setError(false); setImported(false);
      } catch { setError(true); }
    }}>{t("workspace.recovery.load")}</button>
    {copies.map(copy => <button className="button button--secondary button--sm" key={copy.index}
      onClick={() => { setSelected(copy.index); setImported(false); }}>
      {t("workspace.recovery.copy", { number: copy.index + 1 })}
      {copy.snapshot ? ` (${copy.snapshot.sessions.length})` : ` · ${t("workspace.recovery.unreadable")}`}
    </button>)}
    {selected !== null && <section aria-label={t("workspace.recovery.preview")}>
      <h3>{t("workspace.recovery.preview")}</h3>
      {saved ? <>
        <ul>{preview.map((entry, index) => <li key={index}>
          {entry.groupLabel} · {entry.label} · <span className="mono">{entry.workingDirectory}</span>
        </li>)}</ul>
        <p className="field__hint">{t("workspace.recovery.importHint")}</p>
        <button className="button button--primary button--sm" disabled={!ready || retryingWorkspace || imported || preview.length === 0 || !onRecoverWorkspaceSnapshot}
          onClick={() => {
            try { onRecoverWorkspaceSnapshot?.(saved); setImported(true); setError(false); }
            catch { setError(true); }
          }}>{t(imported ? "workspace.recovery.imported" : "workspace.recovery.import")}</button>
      </> : <p>{t("workspace.recovery.unreadable")}</p>}
    </section>}
  </details>;
}
