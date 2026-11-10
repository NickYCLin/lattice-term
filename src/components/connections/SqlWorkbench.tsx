import { useI18n } from "../../i18n/context";
import { SqlResultTable } from "./SqlResultTable";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { draggedOutside, type SqlWorkbenchState } from "../../domain/sqlWorkbench";
import { useRuntimeSummary } from "../../app/useRuntimeSummary";
import { isMobilePlatform } from "../../app/navigation";

export function SqlWorkbench({ profileId, workbenchId, separate = false, mcpAllowed = false, onStateChange }: {
  profileId?: string; workbenchId?: string; separate?: boolean; mcpAllowed?: boolean;
  onStateChange?: (state: { busy: boolean; dirty: boolean }) => void;
}) {
  const { t } = useI18n();
  function checked(value: SqlWorkbenchState): SqlWorkbenchState {
    if (!value || typeof value.id !== "string" || typeof value.sql !== "string" || !Number.isSafeInteger(value.revision) || typeof value.busy !== "boolean") {
      throw new Error(t("database.invalidWorkbench"));
    }
    return value;
  }
  const [panel, setPanel] = useState<SqlWorkbenchState | null>(null);
  const [sql, setSql] = useState("");
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [confirmation, setConfirmation] = useState<{ sql: string; revision: number } | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [closed, setClosed] = useState(false);
  const [editorCollapsed, setEditorCollapsed] = useState(false);
  const runtime = useRuntimeSummary();
  const canDetach = runtime.host === "tauri" && !isMobilePlatform(runtime.summary?.platform);
  const live = useRef(true);
  const current = useRef(panel); current.current = panel;
  const editing = useRef(dirty); editing.current = dirty;
  const operation = useRef(false);
  const lineNumbers = useRef<HTMLPreElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => { onStateChange?.({ busy: pending || panel?.busy === true, dirty }); }, [pending, panel?.busy, dirty, onStateChange]);
  useEffect(() => () => onStateChange?.({ busy: false, dirty: false }), [onStateChange]);

  useEffect(() => {
    if (!separate) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const stop = await getCurrentWindow().onCloseRequested((event) => {
        if (editing.current || operation.current || current.current?.busy) {
          event.preventDefault(); setError(t("database.syncBeforeClose"));
        }
      });
      if (cancelled) stop(); else unlisten = stop;
    }).catch(() => {});
    return () => { cancelled = true; unlisten?.(); };
  }, [separate]);

  useEffect(() => {
    if (closed) return;
    live.current = true;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let id = workbenchId;
    async function refresh() {
      try {
        const value = checked(await invoke<SqlWorkbenchState>("database_workbench", { action: id ? { kind: "read", id } : { kind: "open", profileId } }));
        if (cancelled || !live.current) return;
        id = value.id;
        if (value.revision < (current.current?.revision ?? -1)) { timer = setTimeout(() => void refresh(), 1000); return; }
        if (!operation.current) {
          if (!editing.current) { current.current = value; setSql(value.sql); setPanel(value); }
          else if (current.current?.revision === value.revision) { setPanel(value); }
          else {
            // Keep the draft's CAS revision, but let an in-flight query finish.
            setPanel(previous => previous ? { ...previous, busy: value.busy } : previous);
            setError(t("database.conflict"));
          }
        }
      } catch (reason) { if (live.current) setError(String(reason)); }
      if (live.current) timer = setTimeout(() => void refresh(), 1000);
    }
    void refresh();
    return () => { cancelled = true; live.current = false; clearTimeout(timer); };
  }, [profileId, workbenchId, closed]);

  useEffect(() => {
    if (confirmation && (confirmation.sql !== sql || confirmation.revision !== panel?.revision)) {
      setConfirmation(null); setAccepted(false);
    }
  }, [sql, panel?.revision, confirmation]);

  async function perform(task: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true; setPending(true); setError("");
    try { await task(); } catch (reason) { if (live.current) setError(String(reason)); }
    finally { operation.current = false; if (live.current) setPending(false); }
  }

  function apply(value: SqlWorkbenchState) {
    if (!live.current) return;
    checked(value);
    current.current = value;
    setPanel(value); setSql(value.sql); setDirty(false); editing.current = false;
  }

  async function sync(): Promise<SqlWorkbenchState> {
    if (!panel) throw new Error(t("database.notReady"));
    if (!dirty) return panel;
    const value = await invoke<SqlWorkbenchState>("database_workbench", { action: { kind: "edit", id: panel.id, revision: panel.revision, sql } });
    apply(value); return value;
  }

  function execute(write: boolean) {
    void perform(async () => {
      const value = await sync();
      if (write) { setConfirmation({ sql: value.sql, revision: value.revision }); setAccepted(false); return; }
      apply(await invoke<SqlWorkbenchState>("database_workbench", { action: { kind: "execute", id: value.id, revision: value.revision, confirmedWrite: false } }));
    });
  }

  function popout(x?: number, y?: number) {
    if (!panel) return;
    void perform(async () => {
      const value = await sync();
      await invoke("database_popout", { id: value.id, x: x ?? null, y: y ?? null });
      apply(await invoke<SqlWorkbenchState>("database_workbench", { action: { kind: "read", id: value.id } }));
    });
  }

  async function share(read: boolean, edit: boolean, execute = panel?.shareExecute === true, write = panel?.shareWrite === true) {
    if (!panel) return;
    await perform(async () => { apply(await invoke<SqlWorkbenchState>("database_workbench", {
      action: { kind: "share", id: panel.id, revision: panel.revision, read, edit, execute: read && execute, write: read && execute && write },
    })); });
  }

  function revokeExecution() {
    if (!panel) return;
    void perform(async () => {
      // A local unsynced draft must not prevent revocation or be overwritten.
      const before = current.current;
      const latest = checked(await invoke<SqlWorkbenchState>("database_workbench", { action: { kind: "read", id: panel.id } }));
      const value = checked(await invoke<SqlWorkbenchState>("database_workbench", { action: {
        kind: "share", id: latest.id, revision: latest.revision,
        read: latest.shareRead, edit: latest.shareEdit, execute: false, write: false,
      } }));
      if (!editing.current) apply(value);
      else if (before?.sql === value.sql) { current.current = value; setPanel(value); }
      else setPanel(previous => previous ? { ...previous, shareExecute: false, shareWrite: false } : previous);
    });
  }

  const busy = pending || panel?.busy === true;
  if (closed) return <section className="sql-workbench" aria-label={t("database.workbench")}><button type="button" className="button button--secondary" onClick={() => { current.current = null; setPanel(null); setSql(""); setClosed(false); }}>{t("database.openWorkbench")}</button></section>;
  if (panel?.detached && !separate) return <section className="sql-workbench" aria-label={t("database.workbench")}>
    <p>{t("database.detachedHint")}</p>
    <button className="button button--secondary" type="button" onClick={() => popout()}>{t("database.showWindow")}</button>
  </section>;

  return <section className={`sql-workbench${separate ? " sql-workbench--window" : ""}`} aria-label={t("database.workbench")} aria-busy={busy}>
    <header className="sql-workbench__header" onPointerDown={(event) => {
      if (!canDetach || separate || busy || (event.target as HTMLElement).closest("button")) return;
      drag.current = { x: event.screenX, y: event.screenY };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }} onPointerUp={(event) => {
      const start = drag.current; drag.current = null;
      if (start && Math.hypot(start.x - event.screenX, start.y - event.screenY) > 40 && draggedOutside(event.clientX, event.clientY, window.innerWidth, window.innerHeight)) popout(event.screenX - 30, event.screenY - 20);
    }}>
      <h3>{separate ? `${t("database.workbench")}${panel ? ` · ${panel.name}` : ""}` : t("database.editor")}{!separate && canDetach && <small>{t("database.dragHint")}</small>}</h3>
      <button type="button" className="button button--secondary" aria-expanded={!editorCollapsed} onClick={() => setEditorCollapsed(value => !value)}>{editorCollapsed ? t("database.expandEditor") : t("database.collapseEditor")}</button>
      {separate ? <button type="button" className="button button--secondary" disabled={busy} onClick={() => void perform(async () => {
        await sync();
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        operation.current = false;
        await getCurrentWindow().close();
      })}>{t("database.reattach")}</button> : canDetach && <button type="button" className="button button--secondary" disabled={!panel || busy} onClick={() => popout()}>{t("database.detach")}</button>}
    </header>
    {error && <p className="database-manager__notice database-manager__error" role="alert">{error}</p>}
    {panel?.error && <p className="database-manager__notice database-manager__error" role="alert">{panel.error}</p>}
    {panel && separate && <p className="sql-workbench__target">{t("database.currentConnection", { target: panel.target ?? panel.name })}</p>}
    <div className={`sql-workbench__body${editorCollapsed ? " is-editor-collapsed" : ""}`}><div className="sql-workbench__query">
    <div className="sql-workbench__editor" hidden={editorCollapsed}><div className="sql-workbench__code"><pre ref={lineNumbers} aria-hidden="true">{sql.split("\n").map((_, i) => i + 1).join("\n")}</pre><textarea aria-label={t("database.sql")} rows={7} wrap="off" spellCheck={false} maxLength={65536} disabled={!panel || busy} value={sql} onScroll={(event) => { if (lineNumbers.current) lineNumbers.current.scrollTop = event.currentTarget.scrollTop; }} onChange={(event) => { setSql(event.target.value); setDirty(true); editing.current = true; }} /></div></div>
    <div className="sql-workbench__toolbar">

      <button type="button" className="button button--primary" disabled={!panel || busy || !sql.trim()} onClick={() => execute(false)}>{t("database.execute")}</button>
      <button type="button" className="button button--danger" disabled={!panel || busy || !sql.trim()} onClick={() => execute(true)}>{t("database.executeWrite")}</button>
      <button type="button" className="button button--secondary" disabled={!panel || busy || !dirty} onClick={() => void perform(async () => { await sync(); })}>{t("database.sync")}</button>
    </div>
    {panel?.shareExecute && <button type="button" className="button button--secondary" disabled={pending} onClick={revokeExecution}>{t("database.revoke")}</button>}
    <p className="sql-workbench__status">{dirty ? t("database.draftUnsynced") : panel?.updatedBy === "mcp" ? t("database.mcpUpdated") : t("database.draftSynced")}{t("database.oneStatement")}</p>
    {confirmation && <div role="group" aria-label={t("database.confirmWrite")} className="sql-workbench__confirm">
      <p>{t("database.writeConfirmation", { name: panel?.name ?? "", target: panel?.target ?? "" })}</p>
      <pre>{confirmation.sql}</pre>
      <label><input type="checkbox" aria-label={t("database.confirmWriteLabel")} checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />{t("database.acceptWrite")}</label>
      <button type="button" className="button button--danger" disabled={busy || !accepted} onClick={() => void perform(async () => {
        const value = await invoke<SqlWorkbenchState>("database_workbench", { action: { kind: "execute", id: panel!.id, revision: confirmation.revision, confirmedWrite: true } });
        setConfirmation(null); setAccepted(false); apply(value);
      })}>{t("database.executeConfirmed")}</button>
      <button type="button" className="button button--secondary" onClick={() => setConfirmation(null)}>{t("database.cancelExecute")}</button>
    </div>}
    {panel?.busy && <p role="status">{t("database.executing")}</p>}
    </div>
    {panel && !panel.result && !panel.busy && !panel.error && <div className="sql-workbench__empty"><svg aria-hidden="true" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M9 9v11M15 9v11" /></svg><h4>{t("database.resultsPlaceholder")}</h4><p>{t("database.resultsHint")}</p></div>}
    {panel?.result && <div className="sql-workbench__results">
      <details><summary>{t("database.executedSql")}</summary><pre>{panel.lastSql}</pre></details>
      {panel.result.affectedRows !== null ? <p role="status">{t("database.affectedRows", { count: panel.result.affectedRows })}</p> : <>
        <p role="status">{t("database.resultSummary", { count: panel.result.rows.length, truncated: panel.result.truncated ? t("database.resultTruncated") : "", limit: panel.result.cellCharacterLimit })}</p>
        <SqlResultTable key={panel.lastSql + panel.revision} result={panel.result} />
      </>}
    </div>}
    </div>
    <details className="sql-workbench__options"><summary>{t("database.aiPermissions", { permission: panel?.shareExecute ? panel.shareWrite ? t("database.allowWrite") : t("database.readOnly") : t("database.noExecution") })}</summary>
      <div className="database-manager__actions">      <button type="button" className="button button--secondary" disabled={!panel || busy} onClick={() => void perform(async () => { apply(await invoke<SqlWorkbenchState>("database_workbench", { action: { kind: "read", id: panel!.id } })); })}>{t("database.reloadDraft")}</button>      {!separate && <button type="button" className="button button--secondary" disabled={!panel || busy || dirty} onClick={() => void perform(async () => {
        await invoke("database_workbench_close", {id:panel!.id,revision:panel!.revision}); setClosed(true); setPanel(null);
      })}>{t("database.closeWorkbench")}</button>}</div>
    {panel && <div className="sql-workbench__sharing">
      {!mcpAllowed && !separate && <p>{t("database.mcpPrerequisite")}</p>}
      <label><input type="checkbox" checked={panel.shareRead} disabled={busy || dirty} onChange={(event) => {
        const read = event.target.checked;
        void share(read, read && panel.shareEdit);
      }} />{t("database.shareRead")}</label>
      <label><input type="checkbox" checked={panel.shareEdit} disabled={busy || dirty || !panel.shareRead} onChange={(event) => {
        const edit = event.target.checked;
        void share(panel.shareRead, edit);
      }} />{panel.shareExecute ? t("database.shareEdit") : t("database.shareEditNoExecute")}</label>
      <label className="sql-workbench__execution-permission">{t("database.executionPermission")}<select aria-label={t("database.executionPermission")} value={panel.shareExecute ? panel.shareWrite ? "write" : "read" : "none"} disabled={busy || dirty || !panel.shareRead || (!mcpAllowed && !separate)} onChange={event => {
        const permission = event.target.value;
        void share(panel.shareRead, permission !== "none" || panel.shareEdit, permission !== "none", permission === "write");
      }}><option value="none">{t("database.denyExecution")}</option><option value="read">{t("database.readOnly")}</option><option value="write">{t("database.readWrite")}</option></select></label>
      {panel.shareExecute && <p role="status">{panel.shareWrite ? t("database.writeWarning") : t("database.readWarning")}{t("database.revokeHint")}</p>}
      <small>{t("database.workbenchId", { id: panel.id })}</small>
    </div>}
    </details>
  </section>;
}
