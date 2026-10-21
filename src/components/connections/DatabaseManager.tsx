import { invoke } from "@tauri-apps/api/core";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { ConnectionProfile } from "../../domain/connection";
import {
  databaseEngines, emptyDatabase, changeDatabaseEngine,
  type DatabaseAction, type DatabaseProfile, type DatabaseResult, type DatabaseSnapshot,
} from "../../domain/database";
import { useModalFocus } from "../overlays/modalFocus";

export function DatabaseManager({ profiles, hostKeys, onClose }: {
  profiles: ConnectionProfile[];
  hostKeys?: string[];
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const operationBusy = useRef(false);
  const titleId = useId();
  const hostKey = hostKeys?.[0] ?? "local";
  const hosts = new Map(profiles.map((profile) => [profile.machineId ?? profile.id, profile]));
  const initialHost = profiles.find((profile) => hostKeys?.includes(profile.id) || hostKeys?.includes(profile.machineId ?? ""));
  const [snapshot, setSnapshot] = useState<DatabaseSnapshot | null>(null);
  const [draft, setDraft] = useState(() => emptyDatabase(hostKey, initialHost?.hostname));
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [result, setResult] = useState<DatabaseResult | null>(null);
  const [resultKind, setResultKind] = useState<DatabaseAction["kind"] | null>(null);
  const [tables, setTables] = useState<(string | null)[][]>([]);
  const [tableIndex, setTableIndex] = useState("");
  const [offset, setOffset] = useState(0);
  const [previousOffsets, setPreviousOffsets] = useState<number[]>([]);
  const saved = snapshot?.profiles.find((profile) => profile.id === draft.id);
  const dirty = !saved || JSON.stringify(saved) !== JSON.stringify(draft) || password.length > 0;
  useModalFocus({ dialogRef, onEscape: onClose, escapeDisabled: busy });

  useEffect(() => {
    const request = ++generation.current;
    operationBusy.current = true;
    setBusy(true);
    void invoke<DatabaseSnapshot>("database_profiles").then((value) => {
      if (generation.current === request) setSnapshot(value);
    }).catch((reason: unknown) => {
      if (generation.current === request) setError(String(reason));
    }).finally(() => {
      if (generation.current === request) { operationBusy.current = false; setBusy(false); }
    });
    return () => { generation.current++; };
  }, []);

  function reset(profile = emptyDatabase(hostKey, initialHost?.hostname)) {
    setDraft(profile); setPassword(""); setResult(null); setResultKind(null); setTables([]);
    setTableIndex(""); setOffset(0); setDeleting(null); setError(""); setNotice("");
  }

  async function perform(operation: () => Promise<void>) {
    if (operationBusy.current) return;
    operationBusy.current = true;
    const request = ++generation.current;
    setBusy(true); setError(""); setNotice("");
    try { await operation(); }
    catch (reason) { if (generation.current === request) setError(String(reason)); }
    finally {
      if (generation.current === request) { operationBusy.current = false; setBusy(false); }
    }
  }

  function update<Key extends keyof DatabaseProfile>(key: Key, value: DatabaseProfile[Key]) {
    setDraft((current) => ({ ...current, [key]: value, allowMcpRead: ["hostname", "port", "username", "database", "sqlitePath", "tlsCaPem"].includes(key) ? false : key === "allowMcpRead" ? Boolean(value) : current.allowMcpRead })); setResult(null);
  }

  function save(event: FormEvent) {
    event.preventDefault();
    if (!snapshot) return;
    void perform(async () => {
      const value = await invoke<DatabaseSnapshot>("database_save", { profile: draft, revision: snapshot.revision, password: password || null });
      setSnapshot(value); setDraft(value.profiles.find((profile) => profile.id === draft.id) ?? draft); setPassword(""); setTables([]); setTableIndex(""); setResult(null);
      setNotice("連線已儲存；尚未代表已連線成功，請按測試連線確認。");
    });
  }

  function read(kind: DatabaseAction["kind"], nextOffset = 0, history: number[] = []) {
    const table = tables[Number(tableIndex)];
    if (!saved || dirty || ((kind === "rows" || kind === "columns") && (!table?.[0] || !table[1]))) return;
    const action: DatabaseAction = kind === "version" || kind === "tables"
      ? { kind, profileId: saved.id }
      : kind === "columns"
        ? { kind, profileId: saved.id, schema: table[0]!, table: table[1]! }
        : { kind, profileId: saved.id, schema: table[0]!, table: table[1]!, limit: 50, offset: nextOffset };
    void perform(async () => {
      setResult(null);
      const value = await invoke<DatabaseResult>("database_read", { action });
      setResult(value);
      setResultKind(kind);
      if (kind === "tables") { setTables(value.rows); setTableIndex(""); }
      setOffset(nextOffset);
      setPreviousOffsets(history);
    });
  }

  return (
    <div className="scrim scrim--center" role="presentation">
      <div className="dialog database-manager" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy} ref={dialogRef} tabIndex={-1}>
        <header className="database-manager__header">
          <h2 className="dialog__title" id={titleId}>資料庫連線</h2>
          <button type="button" className="button button--secondary" onClick={onClose} disabled={busy}>關閉</button>
        </header>
        <p>同一台主機可新增多個種類、版本或執行個體；以名稱及連接埠區分。此處只讀資料，部署仍走原有的 SSH／SFTP。</p>
        <p>伺服器連線強制驗證 TLS 憑證，請使用唯讀帳號。不自動探索 instance 連接埠，也不會傳回密碼。</p>
        {error && <p role="alert" className="database-manager__error">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {!!snapshot?.credentialCleanupPending && <div role="alert">
          <p>連線設定已更新，仍有 {snapshot.credentialCleanupPending} 筆舊密碼等待清除。請解鎖憑證庫後重試；尚未完成密碼清除。</p>
          <button type="button" className="button button--secondary" disabled={busy} onClick={() => void perform(async () => {
            const value = await invoke<DatabaseSnapshot>("database_cleanup", { revision: snapshot.revision }); setSnapshot(value);
          })}>重試清除舊密碼</button>
        </div>}
        {busy && <p role="status">處理中…最長等候 20 秒</p>}
        <div className="database-manager__layout">
          <aside aria-label="已儲存的資料庫">
            <button type="button" className="button button--primary" disabled={busy} onClick={() => reset()}>新增資料庫</button>
            <ul className="database-manager__list">
              {snapshot?.profiles.filter((profile) => !hostKeys || hostKeys.includes(profile.hostKey)).map((profile) => (
                <li key={profile.id}>
                  <button type="button" className="button button--secondary" aria-pressed={draft.id === profile.id} disabled={busy} onClick={() => reset(profile)}>
                    {profile.name} · {databaseEngines.find((engine) => engine.value === profile.engine)?.label} {profile.port || ""}
                  </button>
                </li>
              ))}
            </ul>
          </aside>
          <form onSubmit={save}>
            <fieldset disabled={busy || !snapshot} className="database-manager__fields">
              <label>連線名稱（例如 PostgreSQL 16 測試庫）<input required maxLength={100} value={draft.name} onChange={(event) => update("name", event.target.value)} /></label>
              <label>所屬主機<select value={draft.hostKey} onChange={(event) => update("hostKey", event.target.value)}>
                <option value="local">未分類／本機</option>
                {!hosts.has(draft.hostKey) && draft.hostKey !== "local" && <option value={draft.hostKey}>原主機（卡片已移除或合併）</option>}
                {[...hosts].map(([key, profile]) => <option key={key} value={key}>{profile.name}</option>)}
              </select></label>
              <label>資料庫種類<select value={draft.engine} onChange={(event) => {
                setDraft(changeDatabaseEngine(draft, event.target.value as DatabaseProfile["engine"]));
                setPassword(""); setResult(null); setTables([]); setTableIndex("");
              }}>{databaseEngines.map((engine) => <option key={engine.value} value={engine.value}>{engine.label}</option>)}</select></label>
              {draft.engine === "sqlite" ? (
                <label>既有 SQLite 本機檔案（絕對路徑）<input required maxLength={2048} value={draft.sqlitePath} onChange={(event) => update("sqlitePath", event.target.value)} /></label>
              ) : <>
                <label>主機名稱／IP<input required maxLength={253} value={draft.hostname} onChange={(event) => update("hostname", event.target.value)} /></label>
                <label>連接埠<input required type="number" min={1} max={65535} value={draft.port} onChange={(event) => update("port", Number(event.target.value))} /></label>
                <label>資料庫名稱<input required maxLength={128} value={draft.database} onChange={(event) => update("database", event.target.value)} /></label>
                <label>帳號<input required autoComplete="off" maxLength={128} value={draft.username} onChange={(event) => update("username", event.target.value)} /></label>
                <label>密碼（留白保留；變更端點須重填）<input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
                <label>自訂 CA 憑證（選填，PEM 格式）<textarea value={draft.tlsCaPem ?? ""} maxLength={16384} rows={5} spellCheck={false} onChange={(event) => update("tlsCaPem", event.target.value)} /></label>
                <p>內網自簽憑證請貼上管理員提供的 CA 公開憑證，不要貼私鑰。仍會驗證主機名稱；變更 CA 後須重填密碼並重新允許 MCP 讀取。</p>
              </>}
              <label className="database-manager__permission"><input type="checkbox" checked={draft.allowMcpRead} onChange={(event) => update("allowMcpRead", event.target.checked)} />允許 MCP 讀取這個資料庫的結構與資料（不包含密碼）</label>
              <p>密碼儲存於目前選用的系統憑證庫或加密保管庫，不寫入連線設定。</p>
              <div className="database-manager__actions">
                <button type="submit" className="button button--primary" disabled={!dirty}>儲存連線</button>
                {saved && <button type="button" className="button button--danger" onClick={() => setDeleting(saved.id)}>刪除此資料庫連線</button>}
              </div>
              {deleting && <div role="group" aria-label="確認刪除資料庫連線">
                <p>只刪除此連線與保存的密碼，不刪除資料庫、檔案或其他連線。</p>
                <button type="button" className="button button--danger" onClick={() => void perform(async () => {
                  const value = await invoke<DatabaseSnapshot>("database_delete", { profileId: deleting, revision: snapshot!.revision });
                  setSnapshot(value); reset();
                })}>確認刪除此連線</button>
                <button type="button" className="button button--secondary" onClick={() => setDeleting(null)}>取消刪除</button>
              </div>}
            </fieldset>
          </form>
        </div>
        <section aria-label="唯讀資料瀏覽">
          <div className="database-manager__actions">
            <button type="button" className="button button--secondary" disabled={busy || dirty} onClick={() => read("version")}>測試連線／讀取版本</button>
            <button type="button" className="button button--secondary" disabled={busy || dirty} onClick={() => read("tables")}>列出資料表</button>
            <label>資料表<select disabled={busy || dirty || !tables.length} value={tableIndex} onChange={(event) => { setTableIndex(event.target.value); setResult(null); setOffset(0); }}>
              <option value="">請選擇資料表</option>
              {tables.map((table, index) => <option key={index} value={index}>{table[0]}.{table[1]}</option>)}
            </select></label>
            <button type="button" className="button button--secondary" disabled={busy || dirty || tableIndex === ""} onClick={() => read("columns")}>查看欄位</button>
            <button type="button" className="button button--primary" disabled={busy || dirty || tableIndex === ""} onClick={() => read("rows")}>讀取前 50 筆</button>
          </div>
          {dirty && <p>請先儲存目前設定，再測試或查詢。</p>}
          {result && <>
            <p>唯讀 · 每格最多 {result.cellCharacterLimit} 字元 · {result.rows.length} 筆{result.truncated ? " · 尚有資料或已達回傳容量限制" : ""}。分頁未保證固定排序，資料異動時可能重複或跳過。</p>
            <div className="database-manager__result" tabIndex={0} role="region" aria-label="查詢結果">
              <table><thead><tr>{result.columns.map((column, index) => <th key={index} scope="col">{column}</th>)}</tr></thead>
                <tbody>{result.rows.map((row, index) => <tr key={index}>{row.map((value, cell) => <td key={cell}>{value === null ? <em>NULL</em> : value}</td>)}</tr>)}</tbody>
              </table>
            </div>
            {tableIndex !== "" && resultKind === "rows" && <div className="database-manager__actions">
              <button type="button" className="button button--secondary" disabled={busy || dirty || !previousOffsets.length} onClick={() => read("rows", previousOffsets[previousOffsets.length - 1] ?? 0, previousOffsets.slice(0, -1))}>上一頁</button>
              <button type="button" className="button button--secondary" disabled={busy || dirty || !result.truncated || !result.rows.length || offset + result.rows.length > 100000} onClick={() => read("rows", offset + result.rows.length, [...previousOffsets, offset])}>下一頁</button>
            </div>}
          </>}
        </section>
        <button type="button" className="button button--secondary" disabled={busy} onClick={() => void perform(async () => {
          const value = await invoke<DatabaseSnapshot>("database_profiles"); setSnapshot(value); reset();
        })}>重新載入連線（捨棄未儲存設定）</button>
      </div>
    </div>
  );
}
