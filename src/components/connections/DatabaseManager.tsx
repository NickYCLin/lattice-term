import { invoke } from "@tauri-apps/api/core";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { ConnectionProfile } from "../../domain/connection";
import {
  databaseEngines, emptyDatabase, changeDatabaseEngine,
  type DatabaseAction, type DatabaseProfile, type DatabaseResult, type DatabaseSnapshot,
} from "../../domain/database";
import { useModalFocus } from "../overlays/modalFocus";
import { SqlWorkbench } from "./SqlWorkbench";

export function DatabaseManager({ profiles, hostKeys, onClose, embedded = false, onStateChange }: {
  profiles: ConnectionProfile[];
  hostKeys?: string[];
  onClose: () => void;
  embedded?: boolean;
  onStateChange?: (state: { busy: boolean; dirty: boolean }) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const operationBusy = useRef(false);
  const titleId = useId();
  const hostKey = hostKeys?.[0] ?? "local";
  const hosts = new Map(profiles.map((profile) => [profile.machineId ?? profile.id, profile]));
  const initialHost = profiles.find((profile) => hostKeys?.includes(profile.id) || hostKeys?.includes(profile.machineId ?? ""));
  const [view, setView] = useState<"sql" | "tables" | "settings">("sql");
  const [search, setSearch] = useState("");
  const [snapshot, setSnapshot] = useState<DatabaseSnapshot | null>(null);
  const [draft, setDraft] = useState(() => emptyDatabase(hostKey, initialHost?.hostname));
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [touched, setTouched] = useState(false);
  const [connectionBusy, setBusy] = useState(false);
  const [sqlState, setSqlState] = useState({ busy: false, dirty: false });
  const busy = connectionBusy || sqlState.busy || sqlState.dirty;
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
  const navigationBlocked = busy || (touched && dirty);
  const activeView = saved ? view : "settings";
  useEffect(() => { if (contentRef.current) contentRef.current.scrollTop = 0; }, [activeView, draft.id]);
  const available = snapshot?.profiles.filter((profile) => !hostKeys || hostKeys.includes(profile.hostKey)) ?? [];
  const visible = available.filter((profile) => `${profile.name} ${profile.hostname} ${profile.database}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  useModalFocus({ dialogRef, onEscape: onClose, escapeDisabled: navigationBlocked, active: !embedded });
  useEffect(() => { onStateChange?.({ busy, dirty: (touched && dirty) || sqlState.dirty }); }, [busy, dirty, touched, sqlState.dirty, onStateChange]);

  useEffect(() => {
    const request = ++generation.current;
    operationBusy.current = true;
    setBusy(true);
    void invoke<DatabaseSnapshot>("database_profiles").then((value) => {
      if (generation.current === request) {
        setSnapshot(value);
        const first = value.profiles.find((profile) => !hostKeys || hostKeys.includes(profile.hostKey));
        if (first) setDraft(first);
      }
    }).catch((reason: unknown) => {
      if (generation.current === request) setError(String(reason));
    }).finally(() => {
      if (generation.current === request) { operationBusy.current = false; setBusy(false); }
    });
    return () => { generation.current++; };
  }, []);

  function reset(profile = emptyDatabase(hostKey, initialHost?.hostname)) {
    setTouched(false); setView(snapshot?.profiles.some((entry) => entry.id === profile.id) ? "sql" : "settings");
    setDraft(profile); setPassword(""); setShowPassword(false); setResult(null); setResultKind(null); setTables([]);
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
    setTouched(true);
    setDraft((current) => ({ ...current, [key]: value, allowMcpRead: ["hostname", "port", "username", "database", "sqlitePath", "tlsCaPem"].includes(key) ? false : key === "allowMcpRead" ? Boolean(value) : current.allowMcpRead })); setResult(null);
  }

  function save(event: FormEvent) {
    event.preventDefault();
    if (!snapshot) return;
    void perform(async () => {
      const value = await invoke<DatabaseSnapshot>("database_save", { profile: draft, revision: snapshot.revision, password: password || null });
      setSnapshot(value); setDraft(value.profiles.find((profile) => profile.id === draft.id) ?? draft); setPassword(""); setShowPassword(false); setTables([]); setTableIndex(""); setResult(null);
      setTouched(false);
      setNotice("連線已儲存。可測試連線，或切換 SQL 工作台開始查詢。");
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
      if (kind === "version") setNotice("連線測試成功。");
      if (kind === "tables") { setTables(value.rows); setTableIndex(""); }
      setOffset(nextOffset);
      setPreviousOffsets(history);
    });
  }

  return (
    <div className={embedded ? undefined : "scrim scrim--center"} role={embedded ? undefined : "presentation"}>
      <div className={embedded ? "database-manager database-manager--embedded" : "dialog database-manager"} role={embedded ? "region" : "dialog"} aria-modal={embedded ? undefined : true} aria-labelledby={titleId} aria-busy={busy} ref={dialogRef} tabIndex={-1}>
        <header className="database-manager__header"><div><span className="database-manager__eyebrow">DATABASE WORKSPACE</span>
          {embedded ? <h4 id={titleId}>資料庫工作區</h4> : <h2 id={titleId}>資料庫工作區</h2>}
          </div>{!embedded && <button type="button" className="button button--secondary" onClick={onClose} disabled={navigationBlocked}>關閉</button>}
        </header>
        <div className="database-manager__layout">
          <aside className="database-manager__sidebar" aria-label="已儲存的資料庫">
            <div className="database-manager__sidebar-head"><h3>連線 <span>{available.length}</span></h3><button type="button" className="button button--secondary" disabled={navigationBlocked} onClick={() => reset()}>新增資料庫</button></div>
            <input className="database-manager__search" aria-label="搜尋資料庫連線" placeholder="搜尋連線…" value={search} onChange={(event) => setSearch(event.target.value)} />
            <ul className="database-manager__list">{visible.map((profile) => <li key={profile.id}>
              <button type="button" title={profile.name} aria-pressed={draft.id === profile.id} disabled={navigationBlocked} onClick={() => reset(profile)}>{profile.name}<small><span className="database-manager__engine-dot" />{profile.engine === "sqlite" ? "SQLite" : databaseEngines.find((engine) => engine.value === profile.engine)?.label} · {profile.engine === "sqlite" ? "本機檔案" : `${profile.hostname}:${profile.port}`}</small></button>
            </li>)}</ul>
            {snapshot && !visible.length && <p className="database-manager__hint">{available.length ? "沒有符合的連線" : "新增第一個資料庫連線，開始查詢資料。"}</p>}
            <div className="database-manager__sidebar-foot"><span>連線保存在此裝置</span><button type="button" disabled={navigationBlocked} onClick={() => void perform(async () => {
              const value = await invoke<DatabaseSnapshot>("database_profiles"); setSnapshot(value); reset(value.profiles.find((entry) => !hostKeys || hostKeys.includes(entry.hostKey)));
            })}>重新載入連線（捨棄未儲存設定）</button></div>
          </aside>
          <section className="database-manager__workspace" aria-label="資料庫內容">
            <div className="database-manager__connection-head"><div><h3>{saved?.name || "建立新連線"}</h3><p>{saved ? `${databaseEngines.find((engine) => engine.value === saved.engine)?.label} · ${saved.engine === "sqlite" ? "本機檔案" : `${saved.hostname}:${saved.port} / ${saved.database}`}` : "連接資料庫，將查詢與結果留在同一個工作區。"}</p></div><span className="database-manager__badge">{saved ? "已儲存" : "尚未儲存"}</span></div>
            <nav className="database-manager__tabs" aria-label="資料庫工作區頁面">{([ ["sql", "SQL 工作台"], ["tables", "資料表瀏覽"], ["settings", "連線設定"] ] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={activeView === key} disabled={navigationBlocked || (!saved && key !== "settings")} onClick={() => setView(key)}>{label}</button>)}</nav>
            <div className="database-manager__content" ref={contentRef}>
              {error && <p role="alert" className="database-manager__notice database-manager__error">{error}</p>}
              {notice && <p role="status" className="database-manager__notice">{notice}</p>}
              {(connectionBusy || sqlState.busy) && <p role="status" className="database-manager__notice">處理中…最長等候 20 秒</p>}
              {!!snapshot?.credentialCleanupPending && <div role="alert" className="database-manager__notice"><p>仍有 {snapshot.credentialCleanupPending} 筆舊密碼等待清除，請解鎖憑證庫後重試。</p><button type="button" className="button button--secondary" disabled={busy} onClick={() => void perform(async () => {
                const value = await invoke<DatabaseSnapshot>("database_cleanup", { revision: snapshot.revision }); setSnapshot(value);
              })}>重試清除舊密碼</button></div>}
          <form onSubmit={save} className="database-manager__settings" hidden={activeView !== "settings"}>
            <div className="database-manager__section-heading"><h3 className="visually-hidden">{saved ? "連線設定" : "新增資料庫連線"}</h3><p>設定端點與帳號，儲存後即可開啟 SQL 工作台。</p></div>
            <fieldset disabled={busy || !snapshot} className="database-manager__fields">
              <legend className="visually-hidden">資料庫連線與登入設定</legend>
              <section className="database-manager__form-card" aria-label="連線位置">
                <h4 className="database-manager__form-section"><span>01</span><span>連線位置<small>設定要連接的資料庫。</small></span></h4>
                <div className="database-manager__field-grid">
                  <label className="database-manager__span">連線名稱<input placeholder="例如：開發環境 PostgreSQL" required maxLength={100} value={draft.name} onChange={(event) => update("name", event.target.value)} /></label>
                  <label className="database-manager__span">資料庫種類<select value={draft.engine} onChange={(event) => {
                    setTouched(true); setDraft(changeDatabaseEngine(draft, event.target.value as DatabaseProfile["engine"]));
                    setPassword(""); setShowPassword(false); setResult(null); setTables([]); setTableIndex("");
                  }}>{databaseEngines.map((engine) => <option key={engine.value} value={engine.value}>{engine.label}</option>)}</select></label>
                  {draft.engine === "sqlite" ? <label className="database-manager__span">SQLite 檔案路徑<input required maxLength={2048} value={draft.sqlitePath} onChange={(event) => update("sqlitePath", event.target.value)} /></label> : <>
                    <label>主機名稱／IP<input placeholder="db.example.com" autoCapitalize="none" autoCorrect="off" spellCheck={false} required maxLength={253} value={draft.hostname} onChange={(event) => update("hostname", event.target.value)} /></label>
                    <label>連接埠<input inputMode="numeric" required type="number" min={1} max={65535} value={draft.port} onChange={(event) => update("port", Number(event.target.value))} /></label>
                    <label className="database-manager__span">資料庫名稱<input placeholder="要連線的資料庫名稱" autoCapitalize="none" spellCheck={false} required maxLength={128} value={draft.database} onChange={(event) => update("database", event.target.value)} /></label>
                  </>}
                  <details className="database-manager__advanced database-manager__span"><summary>連線分類（選填）</summary><label>所屬主機<select value={draft.hostKey} onChange={(event) => update("hostKey", event.target.value)}>
                    <option value="local">未分類／本機</option>
                    {!hosts.has(draft.hostKey) && draft.hostKey !== "local" && <option value={draft.hostKey}>原主機（卡片已移除或合併）</option>}
                    {[...hosts].map(([key, profile]) => <option key={key} value={key}>{profile.name}</option>)}
                  </select></label></details>
                </div>
              </section>
              <section className="database-manager__form-card" aria-label="登入資料與 AI 權限">
                <h4 className="database-manager__form-section"><span>02</span><span>登入資料<small>密碼加密儲存於此裝置，不會傳給 AI。</small></span></h4>
                <div className="database-manager__field-grid">
                  {draft.engine === "sqlite" ? <p className="database-manager__hint database-manager__span">本機 SQLite 檔案不需要帳號密碼。</p> : <>
                    <label className="database-manager__span">帳號<input placeholder="資料庫使用者名稱" autoCapitalize="none" autoCorrect="off" spellCheck={false} required autoComplete="off" maxLength={128} value={draft.username} onChange={(event) => update("username", event.target.value)} /></label>
                    <div className="database-manager__password database-manager__span"><label>密碼（留白保留；變更端點須重填）<input type={showPassword ? "text" : "password"} autoComplete="new-password" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder={saved ? "留白保留已儲存的密碼" : "輸入資料庫密碼"} value={password} onChange={(event) => { setTouched(true); setPassword(event.target.value); }} /></label><button type="button" className="button button--secondary" aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)}>{showPassword ? "隱藏密碼" : "顯示密碼"}</button><small>切換端點、帳號或憑證後，請重新輸入密碼。</small></div>
                    <details className="database-manager__advanced database-manager__span"><summary>進階 TLS 設定</summary><label>自訂 CA 憑證（選填，PEM 格式）<textarea value={draft.tlsCaPem ?? ""} maxLength={16384} rows={5} spellCheck={false} onChange={(event) => update("tlsCaPem", event.target.value)} /></label>
                      <p>內網自簽憑證請貼上管理員提供的 CA 公開憑證，不要貼私鑰。仍會驗證主機名稱；變更 CA 後須重填密碼並重新允許 MCP 讀取。</p></details>
                  </>}
                  <div className="database-manager__form-section database-manager__span"><span>03</span><span>AI 與 MCP 存取<small>SQL 唯讀或增刪修權限可在工作台個別設定。</small></span></div>
                  <label className="database-manager__permission database-manager__span"><input type="checkbox" checked={draft.allowMcpRead} onChange={(event) => update("allowMcpRead", event.target.checked)} />允許 MCP 讀取這個資料庫的結構與資料（不包含密碼）</label>
                  <p className="database-manager__hint database-manager__span">密碼儲存於目前選用的系統憑證庫或加密保管庫，不寫入連線設定。</p>
                </div>
              </section>
              <div className="database-manager__actions database-manager__save-bar database-manager__span">
                <button type="submit" className="button button--primary" disabled={!dirty}>{embedded ? "儲存資料庫連線" : "儲存連線"}</button>
                {saved && <button type="button" className="button button--secondary" disabled={dirty} onClick={() => read("version")}>測試連線</button>}
                <button type="button" className="button button--secondary" onClick={() => reset(saved ?? available[0])}>取消編輯</button>
                {saved && <button type="button" className="database-manager__delete" onClick={() => setDeleting(saved.id)}>刪除此資料庫連線</button>}
              </div>
              {deleting && <div className="database-manager__span sql-workbench__confirm" role="group" aria-label="確認刪除資料庫連線">
                <p>只刪除此連線與保存的密碼，不刪除資料庫、檔案或其他連線。</p>
                <button type="button" className="button button--danger" onClick={() => void perform(async () => {
                  const value = await invoke<DatabaseSnapshot>("database_delete", { profileId: deleting, revision: snapshot!.revision });
                  setSnapshot(value); reset();
                })}>確認刪除此連線</button>
                <button type="button" className="button button--secondary" onClick={() => setDeleting(null)}>取消刪除</button>
              </div>}
            </fieldset>
          </form>
        <section className="database-manager__browse" aria-label="唯讀資料瀏覽" hidden={activeView !== "tables"}><div className="database-manager__section-heading"><h3>資料表瀏覽</h3><p>查看資料表結構與分頁資料。</p></div>
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

              {saved && <div hidden={activeView !== "sql"}>{!dirty ? <SqlWorkbench key={saved.id} profileId={saved.id} mcpAllowed={saved.allowMcpRead} onStateChange={setSqlState} /> : <p className="database-manager__notice">請先儲存或取消連線設定的變更。</p>}</div>}
            </div>
            <footer className="database-manager__footer"><span>{sqlState.dirty ? "SQL 尚未同步，請先同步草稿再切換連線。" : touched && dirty ? "連線設定尚未儲存" : "SQL 查詢與資料增刪修"}</span><span>{draft.engine === "sqlite" ? "本機 SQLite 檔案" : "伺服器連線驗證 TLS 憑證"}</span></footer>
          </section>
        </div>
      </div>
    </div>
  );
}
