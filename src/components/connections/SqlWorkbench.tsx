import { SqlResultTable } from "./SqlResultTable";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { draggedOutside, type SqlWorkbenchState } from "../../domain/sqlWorkbench";
import { useRuntimeSummary } from "../../app/useRuntimeSummary";
import { isMobilePlatform } from "../../app/navigation";

function checked(value: SqlWorkbenchState): SqlWorkbenchState {
  if (!value || typeof value.id !== "string" || typeof value.sql !== "string" || !Number.isSafeInteger(value.revision) || typeof value.busy !== "boolean") {
    throw new Error("目前後端未提供有效的 SQL 工作台，請確認桌面程式已更新。");
  }
  return value;
}

export function SqlWorkbench({ profileId, workbenchId, separate = false, mcpAllowed = false, onStateChange }: {
  profileId?: string; workbenchId?: string; separate?: boolean; mcpAllowed?: boolean;
  onStateChange?: (state: { busy: boolean; dirty: boolean }) => void;
}) {
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
          event.preventDefault(); setError("請先同步 SQL 草稿或等待執行完成，再關閉視窗。");
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
            setError("SQL 已在另一個視窗或 MCP 更新。請重新載入共享草稿後再修改，不會覆蓋目前輸入。");
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
    if (!panel) throw new Error("SQL 工作台尚未就緒。");
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
  if (closed) return <section className="sql-workbench" aria-label="SQL 工作台"><button type="button" className="button button--secondary" onClick={() => { current.current = null; setPanel(null); setSql(""); setClosed(false); }}>開啟 SQL 工作台</button></section>;
  if (panel?.detached && !separate) return <section className="sql-workbench" aria-label="SQL 工作台">
    <p>SQL 工作台已移到獨立視窗，草稿與結果持續共用。</p>
    <button className="button button--secondary" type="button" onClick={() => popout()}>顯示 SQL 視窗</button>
  </section>;

  return <section className={`sql-workbench${separate ? " sql-workbench--window" : ""}`} aria-label="SQL 工作台" aria-busy={busy}>
    <header className="sql-workbench__header" onPointerDown={(event) => {
      if (!canDetach || separate || busy || (event.target as HTMLElement).closest("button")) return;
      drag.current = { x: event.screenX, y: event.screenY };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }} onPointerUp={(event) => {
      const start = drag.current; drag.current = null;
      if (start && Math.hypot(start.x - event.screenX, start.y - event.screenY) > 40 && draggedOutside(event.clientX, event.clientY, window.innerWidth, window.innerHeight)) popout(event.screenX - 30, event.screenY - 20);
    }}>
      <h3>{separate ? `SQL 工作台${panel ? ` · ${panel.name}` : ""}` : "SQL 編輯器"}{!separate && canDetach && <small>可拖出視窗</small>}</h3>
      <button type="button" className="button button--secondary" aria-expanded={!editorCollapsed} onClick={() => setEditorCollapsed(value => !value)}>{editorCollapsed ? "展開 SQL 編輯器" : "收合 SQL 編輯器"}</button>
      {separate ? <button type="button" className="button button--secondary" disabled={busy} onClick={() => void perform(async () => {
        await sync();
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        operation.current = false;
        await getCurrentWindow().close();
      })}>放回主視窗</button> : canDetach && <button type="button" className="button button--secondary" disabled={!panel || busy} onClick={() => popout()}>移至獨立視窗</button>}
    </header>
    {error && <p className="database-manager__notice database-manager__error" role="alert">{error}</p>}
    {panel?.error && <p className="database-manager__notice database-manager__error" role="alert">{panel.error}</p>}
    {panel && separate && <p className="sql-workbench__target">目前連線：{panel.target ?? panel.name}</p>}
    <div className={`sql-workbench__body${editorCollapsed ? " is-editor-collapsed" : ""}`}><div className="sql-workbench__query">
    <div className="sql-workbench__editor" hidden={editorCollapsed}><div className="sql-workbench__code"><pre ref={lineNumbers} aria-hidden="true">{sql.split("\n").map((_, i) => i + 1).join("\n")}</pre><textarea aria-label="SQL 語法" rows={7} wrap="off" spellCheck={false} maxLength={65536} disabled={!panel || busy} value={sql} onScroll={(event) => { if (lineNumbers.current) lineNumbers.current.scrollTop = event.currentTarget.scrollTop; }} onChange={(event) => { setSql(event.target.value); setDirty(true); editing.current = true; }} /></div></div>
    <div className="sql-workbench__toolbar">

      <button type="button" className="button button--primary" disabled={!panel || busy || !sql.trim()} onClick={() => execute(false)}>執行查詢</button>
      <button type="button" className="button button--danger" disabled={!panel || busy || !sql.trim()} onClick={() => execute(true)}>執行增刪修…</button>
      <button type="button" className="button button--secondary" disabled={!panel || busy || !dirty} onClick={() => void perform(async () => { await sync(); })}>同步草稿</button>
    </div>
    {panel?.shareExecute && <button type="button" className="button button--secondary" disabled={pending} onClick={revokeExecution}>撤回 AI 執行授權</button>}
    <p className="sql-workbench__status">{dirty ? "尚未同步的變更" : panel?.updatedBy === "mcp" ? "MCP 已更新工作台" : "草稿已同步"} · 每次執行一個 SQL 敘述</p>
    {confirmation && <div role="group" aria-label="確認 SQL 資料變更" className="sql-workbench__confirm">
      <p>將對「{panel?.name} · {panel?.target ?? ""}」執行以下 SQL。請確認連線、WHERE 條件與資料範圍。</p>
      <pre>{confirmation.sql}</pre>
      <label><input type="checkbox" aria-label="確認執行資料變更" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />我已確認這份 SQL，要執行資料變更</label>
      <button type="button" className="button button--danger" disabled={busy || !accepted} onClick={() => void perform(async () => {
        const value = await invoke<SqlWorkbenchState>("database_workbench", { action: { kind: "execute", id: panel!.id, revision: confirmation.revision, confirmedWrite: true } });
        setConfirmation(null); setAccepted(false); apply(value);
      })}>確認執行這份 SQL</button>
      <button type="button" className="button button--secondary" onClick={() => setConfirmation(null)}>取消執行</button>
    </div>}
    {panel?.busy && <p role="status">SQL 執行中，最長等候 20 秒；請勿重複送出。</p>}
    </div>
    {panel && !panel.result && !panel.busy && !panel.error && <div className="sql-workbench__empty"><svg aria-hidden="true" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M9 9v11M15 9v11" /></svg><h4>查詢結果會顯示在這裡</h4><p>輸入 SQL，執行查詢後即可查看資料。</p></div>}
    {panel?.result && <div className="sql-workbench__results">
      <details><summary>這份結果執行的 SQL</summary><pre>{panel.lastSql}</pre></details>
      {panel.result.affectedRows !== null ? <p role="status">執行完成，伺服器回報影響 {panel.result.affectedRows} 筆資料。</p> : <>
        <p role="status">{panel.result.rows.length} 筆結果{panel.result.truncated ? "（結果已截斷，請用 SQL 縮小範圍）" : ""}，每格預覽最多 {panel.result.cellCharacterLimit} 字元。</p>
        <SqlResultTable key={panel.lastSql + panel.revision} result={panel.result} />
      </>}
    </div>}
    </div>
    <details className="sql-workbench__options"><summary>AI 與 MCP 權限 · {panel?.shareExecute ? panel.shareWrite ? "允許查詢與增刪修" : "唯讀查詢" : "不允許執行 SQL"}</summary>
      <div className="database-manager__actions">      <button type="button" className="button button--secondary" disabled={!panel || busy} onClick={() => void perform(async () => { apply(await invoke<SqlWorkbenchState>("database_workbench", { action: { kind: "read", id: panel!.id } })); })}>重新載入共享草稿</button>      {!separate && <button type="button" className="button button--secondary" disabled={!panel || busy || dirty} onClick={() => void perform(async () => {
        await invoke("database_workbench_close", {id:panel!.id,revision:panel!.revision}); setClosed(true); setPanel(null);
      })}>關閉工作台並清除草稿與結果</button>}</div>
    {panel && <div className="sql-workbench__sharing">
      {!mcpAllowed && !separate && <p>要透過 MCP 存取工作台，請先在「連線設定」頁面開啟「允許 MCP 讀取」並儲存。</p>}
      <label><input type="checkbox" checked={panel.shareRead} disabled={busy || dirty} onChange={(event) => {
        const read = event.target.checked;
        void share(read, read && panel.shareEdit);
      }} />允許 MCP 讀取此工作台的 SQL 與結果</label>
      <label><input type="checkbox" checked={panel.shareEdit} disabled={busy || dirty || !panel.shareRead} onChange={(event) => {
        const edit = event.target.checked;
        void share(panel.shareRead, edit);
      }} />{panel.shareExecute ? "允許 MCP 修改 SQL 草稿" : "允許 MCP 修改 SQL 草稿（不會自動執行）"}</label>
      <label className="sql-workbench__execution-permission">AI 執行 SQL 權限<select aria-label="AI 執行 SQL 權限" value={panel.shareExecute ? panel.shareWrite ? "write" : "read" : "none"} disabled={busy || dirty || !panel.shareRead || (!mcpAllowed && !separate)} onChange={event => {
        const permission = event.target.value;
        void share(panel.shareRead, permission !== "none" || panel.shareEdit, permission !== "none", permission === "write");
      }}><option value="none">不允許執行</option><option value="read">唯讀查詢</option><option value="write">查詢與增刪修</option></select></label>
      {panel.shareExecute && <p role="status">{panel.shareWrite ? "AI 可直接執行增刪修，不會逐次要求確認；資料庫帳號權限仍會限制操作。" : "AI 只能執行唯讀查詢；新增、修改與刪除會被拒絕。"} 可隨時改回不允許執行。</p>}
      <small>工作台 ID：{panel.id}。關閉程式會清除這些草稿與結果。</small>
    </div>}
    </details>
  </section>;
}
