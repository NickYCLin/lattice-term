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
  const runtime = useRuntimeSummary();
  const canDetach = runtime.host === "tauri" && !isMobilePlatform(runtime.summary?.platform);
  const live = useRef(true);
  const current = useRef(panel); current.current = panel;
  const editing = useRef(dirty); editing.current = dirty;
  const operation = useRef(false);
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
          else { setError("SQL 已在另一個視窗或 MCP 更新。請重新載入共享草稿後再修改，不會覆蓋目前輸入。"); }
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
      <h3>SQL 工作台{panel ? ` · ${panel.name}` : ""}</h3>
      {separate ? <button type="button" className="button button--secondary" disabled={busy} onClick={() => void perform(async () => {
        await sync();
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        operation.current = false;
        await getCurrentWindow().close();
      })}>放回主視窗</button> : canDetach && <button type="button" className="button button--secondary" disabled={!panel || busy} onClick={() => popout()}>移至獨立視窗</button>}
    </header>
    {!separate && canDetach && <p>拖曳上方標題列到視窗外可分離；關閉獨立視窗會回到這個面板。</p>}
    {error && <p role="alert">{error}</p>}
    {panel?.error && <p role="alert">{panel.error}</p>}
    {panel && <p>目前連線：{panel.target ?? panel.name}</p>}
    <label className="sql-workbench__editor">SQL 語法<textarea aria-label="SQL 語法" rows={9} spellCheck={false} maxLength={65536} disabled={!panel || busy} value={sql} onChange={(event) => { setSql(event.target.value); setDirty(true); editing.current = true; }} /></label>
    <div className="database-manager__actions">
      {!separate && <button type="button" className="button button--secondary" disabled={!panel || busy || dirty} onClick={() => void perform(async () => {
        await invoke("database_workbench_close", {id:panel!.id,revision:panel!.revision}); setClosed(true); setPanel(null);
      })}>關閉工作台並清除草稿與結果</button>}
      <button type="button" className="button button--secondary" disabled={!panel || busy || !dirty} onClick={() => void perform(async () => { await sync(); })}>同步草稿</button>
      <button type="button" className="button button--secondary" disabled={!panel || busy} onClick={() => void perform(async () => { apply(await invoke<SqlWorkbenchState>("database_workbench", { action: { kind: "read", id: panel!.id } })); })}>重新載入共享草稿</button>
      <button type="button" className="button button--primary" disabled={!panel || busy || !sql.trim()} onClick={() => execute(false)}>執行查詢</button>
      <button type="button" className="button button--danger" disabled={!panel || busy || !sql.trim()} onClick={() => execute(true)}>執行增刪修…</button>
    </div>
    <p>{dirty ? "目前有未同步的 SQL；同步後 MCP 才能看到最新語法。" : panel?.updatedBy === "mcp" ? "MCP 已更新這份 SQL 草稿，尚未執行。" : "SQL 草稿已同步。"} 每次執行一個 SELECT、INSERT、UPDATE 或 DELETE；寫入帳號需具備對應資料庫權限。</p>
    {panel && <div className="sql-workbench__sharing">
      {!mcpAllowed && !separate && <p>要透過 MCP 存取工作台，請先在上方連線設定開啟「允許 MCP 讀取」並儲存。</p>}
      <label><input type="checkbox" checked={panel.shareRead} disabled={busy || dirty} onChange={(event) => {
        const read = event.target.checked;
        void perform(async () => { apply(await invoke<SqlWorkbenchState>("database_workbench", { action: { kind: "share", id: panel.id, revision: panel.revision, read, edit: read && panel.shareEdit } })); });
      }} />允許 MCP 讀取此工作台的 SQL 與結果</label>
      <label><input type="checkbox" checked={panel.shareEdit} disabled={busy || dirty || !panel.shareRead} onChange={(event) => {
        const edit = event.target.checked;
        void perform(async () => { apply(await invoke<SqlWorkbenchState>("database_workbench", { action: { kind: "share", id: panel.id, revision: panel.revision, read: panel.shareRead, edit } })); });
      }} />允許 MCP 修改 SQL 草稿（不會自動執行）</label>
      <small>工作台 ID：{panel.id}。關閉程式會清除這些草稿與結果。</small>
    </div>}
    {confirmation && <div role="group" aria-label="確認 SQL 資料變更" className="sql-workbench__confirm">
      <p>將對「{panel?.name} · {panel?.target ?? ""}」執行以下 SQL。請確認連線、WHERE 條件與資料範圍。</p>
      <pre>{confirmation.sql}</pre>
      <label><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />我已確認這份 SQL，要執行資料變更</label>
      <button type="button" className="button button--danger" disabled={busy || !accepted} onClick={() => void perform(async () => {
        const value = await invoke<SqlWorkbenchState>("database_workbench", { action: { kind: "execute", id: panel!.id, revision: confirmation.revision, confirmedWrite: true } });
        setConfirmation(null); setAccepted(false); apply(value);
      })}>確認執行這份 SQL</button>
      <button type="button" className="button button--secondary" onClick={() => setConfirmation(null)}>取消執行</button>
    </div>}
    {panel?.busy && <p role="status">SQL 執行中，最長等候 20 秒；請勿重複送出。</p>}
    {panel?.result && <div className="sql-workbench__results">
      <details><summary>這份結果執行的 SQL</summary><pre>{panel.lastSql}</pre></details>
      {panel.result.affectedRows !== null ? <p role="status">執行完成，伺服器回報影響 {panel.result.affectedRows} 筆資料。</p> : <>
        <p role="status">{panel.result.rows.length} 筆結果{panel.result.truncated ? "（結果已截斷，請用 SQL 縮小範圍）" : ""}，每格預覽最多 {panel.result.cellCharacterLimit} 字元。</p>
        <div className="database-manager__result" tabIndex={0} role="region" aria-label="SQL 查詢結果"><table>
          <thead><tr>{panel.result.columns.map((name, i) => <th key={i} scope="col">{name}</th>)}</tr></thead>
          <tbody>{panel.result.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell === null ? <em>NULL</em> : cell}</td>)}</tr>)}</tbody>
        </table></div>
      </>}
    </div>}
  </section>;
}
