import { useI18n } from "../../i18n/context";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { mergeMachineCards, type ConnectionProfile } from "../../domain/connection";
import {
  databaseEngines, emptyDatabase, changeDatabaseEngine,
  type DatabaseAction, type DatabaseProfile, type DatabaseResult, type DatabaseSnapshot,
} from "../../domain/database";
import { useModalFocus } from "../overlays/modalFocus";
import { SqlWorkbench } from "./SqlWorkbench";

export function DatabaseManager({ profiles, hostKeys, defaultHostKey = hostKeys?.[0], onClose, embedded = false, onStateChange, initialProfileId, initialView = "sql", settingsOnly = false, createNew = false, onProfileSelected, onConfigure, catalogRevision = 0, settingsFormId, onSaved }: {
  profiles: ConnectionProfile[];
  hostKeys?: string[];
  defaultHostKey?: string;
  onClose: () => void;
  embedded?: boolean;
  initialProfileId?: string;
  initialView?: "sql" | "tables" | "settings";
  settingsOnly?: boolean;
  settingsFormId?: string;
  onSaved?: (profile: DatabaseProfile, openWorkspace: boolean) => void;
  createNew?: boolean;
  onProfileSelected?: (profile: DatabaseProfile | null) => void;
  onConfigure?: (profileId?: string, hostKey?: string) => void;
  catalogRevision?: number;
  onStateChange?: (state: { busy: boolean; dirty: boolean }) => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const operationBusy = useRef(false);
  const titleId = useId();
  const cardTargets = new Map(mergeMachineCards(profiles).map(({ profile }) => [profile.machineId ?? profile.id, profile]));
  const [view, setView] = useState<"sql" | "tables" | "settings">(settingsOnly ? "settings" : initialView);
  const [search, setSearch] = useState("");
  const [snapshot, setSnapshot] = useState<DatabaseSnapshot | null>(null);
  const [createdIds, setCreatedIds] = useState<string[]>([]);
  const [draft, setDraft] = useState(() => emptyDatabase(defaultHostKey));
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
  const activeView = settingsOnly ? "settings" : saved ? view : "settings";
  useEffect(() => { if (contentRef.current) contentRef.current.scrollTop = 0; }, [activeView, draft.id]);
  const available = snapshot?.profiles.filter((profile) => !hostKeys || hostKeys.includes(profile.hostKey) || profile.id === initialProfileId || createdIds.includes(profile.id)) ?? [];
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
        const first = createNew ? undefined : value.profiles.find(profile => profile.id === initialProfileId) ?? value.profiles.find((profile) => !hostKeys || hostKeys.includes(profile.hostKey));
        if (first) setDraft(first);
        onProfileSelected?.(first ?? null);
      }
    }).catch((reason: unknown) => {
      if (generation.current === request) setError(String(reason));
    }).finally(() => {
      if (generation.current === request) { operationBusy.current = false; setBusy(false); }
    });
    return () => { generation.current++; };
  }, []);

  const lastCatalogRevision = useRef(catalogRevision);
  const blockedRef = useRef(navigationBlocked); blockedRef.current = navigationBlocked;
  useEffect(() => {
    if (!snapshot || navigationBlocked || lastCatalogRevision.current === catalogRevision) return;
    const request = ++generation.current;
    lastCatalogRevision.current = catalogRevision;
    void invoke<DatabaseSnapshot>("database_profiles").then(value => {
      if (request !== generation.current) return;
      if (blockedRef.current) { lastCatalogRevision.current = -1; return; }
      setSnapshot(value);
      const selected = value.profiles.find(profile => profile.id === draft.id);
      if (selected) setDraft(selected);
      else setDraft(emptyDatabase(defaultHostKey));
    }).catch(reason => { if (request === generation.current) setError(String(reason)); });
  }, [catalogRevision, navigationBlocked, snapshot]);

  function reset(profile = emptyDatabase(defaultHostKey)) {
    setTouched(false); setView(snapshot?.profiles.some((entry) => entry.id === profile.id) ? "sql" : "settings");
    setDraft(profile); onProfileSelected?.(snapshot?.profiles.some(entry => entry.id === profile.id) ? profile : null); setPassword(""); setShowPassword(false); setResult(null); setResultKind(null); setTables([]);
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
    setDraft((current) => ({ ...current, [key]: value, allowMcpRead: ["hostname", "port", "username", "database", "sqlitePath", "tlsCaPem", "route"].includes(key) ? false : key === "allowMcpRead" ? Boolean(value) : current.allowMcpRead })); setResult(null);
  }

  function save(event: FormEvent) {
    event.preventDefault();
    if (!snapshot) { setError(t("database.notLoaded")); return; }
    const intent = (event.nativeEvent as SubmitEvent | undefined)?.submitter?.getAttribute("value");
    if (intent === "test") { testConnection(); return; }
    void perform(async () => {
      const value = await invoke<DatabaseSnapshot>("database_save", { profile: draft, revision: snapshot.revision, password: password || null });
      if (!saved) setCreatedIds(ids => [...ids, draft.id]);
      setSnapshot(value); setDraft(value.profiles.find((profile) => profile.id === draft.id) ?? draft); setPassword(""); setShowPassword(false); setTables([]); setTableIndex(""); setResult(null);
      setTouched(false);
      const selected = value.profiles.find(profile => profile.id === draft.id);
      if (selected) onProfileSelected?.(selected);
      if (selected) onSaved?.(selected, intent === "open");
      setNotice(t("database.saveSuccess"));
    });
  }

  function testConnection() {
    if (!snapshot) { setError(t("database.notLoaded")); return; }
    void perform(async () => {
      await invoke<DatabaseResult>("database_test", { profile: draft, revision: snapshot.revision, password: password || null });
      setNotice(t("database.testSuccessHint"));
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
      if (kind === "version") setNotice(t("database.testSuccess"));
      if (kind === "tables") { setTables(value.rows); setTableIndex(""); }
      setOffset(nextOffset);
      setPreviousOffsets(history);
    });
  }

  return (
    <div className={embedded ? undefined : "scrim scrim--center"} role={embedded ? undefined : "presentation"}>
      <div className={`${embedded ? "database-manager database-manager--embedded" : "dialog database-manager"}${settingsOnly ? " database-manager--settings" : ""}`} role={embedded ? "region" : "dialog"} aria-modal={embedded ? undefined : true} aria-labelledby={titleId} aria-busy={busy} ref={dialogRef} tabIndex={-1}>
        <header className="database-manager__header"><div><span className="database-manager__eyebrow">DATABASE WORKSPACE</span>
          {embedded ? <h4 id={titleId}>{t("database.workspace")}</h4> : <h2 id={titleId}>{t("database.workspace")}</h2>}
          </div>{!embedded && <button type="button" className="button button--secondary" onClick={onClose} disabled={navigationBlocked}>{t("database.close")}</button>}
        </header>
        <div className="database-manager__layout">
          <aside className="database-manager__sidebar" aria-label={t("database.savedConnections")}>
            <div className="database-manager__sidebar-head"><h3>{t("database.connections")} <span>{available.length}</span></h3><button type="button" className="button button--secondary" disabled={navigationBlocked} onClick={() => onConfigure ? onConfigure(undefined, defaultHostKey) : reset()}>{t("database.add")}</button></div>
            <input className="database-manager__search" aria-label={t("database.searchLabel")} placeholder={t("database.searchPlaceholder")} value={search} onChange={(event) => setSearch(event.target.value)} />
            <ul className="database-manager__list">{visible.map((profile) => <li key={profile.id}>
              <button type="button" title={profile.name} aria-pressed={draft.id === profile.id} disabled={navigationBlocked} onClick={() => reset(profile)}>{profile.name}<small><span className="database-manager__engine-dot" />{profile.engine === "sqlite" ? "SQLite" : databaseEngines.find((engine) => engine.value === profile.engine)?.label} · {profile.engine === "sqlite" ? t("database.localFile") : `${profile.hostname}:${profile.port}`}</small></button>
            </li>)}</ul>
            {snapshot && !visible.length && <p className="database-manager__hint">{available.length ? t("database.noMatches") : t("database.firstConnection")}</p>}
            <div className="database-manager__sidebar-foot"><span>{t("database.storedLocally")}</span><button type="button" disabled={navigationBlocked} onClick={() => void perform(async () => {
              const value = await invoke<DatabaseSnapshot>("database_profiles"); setSnapshot(value); reset(value.profiles.find((entry) => !hostKeys || hostKeys.includes(entry.hostKey)));
            })}>{t("database.reloadDiscard")}</button></div>
          </aside>
          <section className="database-manager__workspace" aria-label={t("database.content")}>
            <div className="database-manager__connection-head"><div><h3>{saved?.name || t("database.create")}</h3><p>{saved ? `${databaseEngines.find((engine) => engine.value === saved.engine)?.label} · ${saved.engine === "sqlite" ? t("database.localFile") : `${saved.hostname}:${saved.port} / ${saved.database}`}` : t("database.workspaceHint")}</p></div><span className="database-manager__badge">{saved ? t("database.saved") : t("database.unsaved")}</span></div>
            {!settingsOnly && <nav className="database-manager__tabs" aria-label={t("database.pages")}>{([ ["sql", t("database.workbench")], ["tables", t("database.browse")], ["settings", t("database.settings")] ] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={activeView === key} disabled={navigationBlocked || (!saved && key !== "settings")} onClick={() => key === "settings" && onConfigure ? onConfigure(saved?.id, saved?.hostKey ?? defaultHostKey) : setView(key)}>{label}</button>)}</nav>}
            <div className="database-manager__content" ref={contentRef}>
              {error && <p role="alert" className="database-manager__notice database-manager__error">{error}</p>}
              {!snapshot && !connectionBusy && <button type="button" className="button button--secondary" onClick={() => void perform(async () => {
                const value = await invoke<DatabaseSnapshot>("database_profiles");
                setSnapshot(value);
                if (!touched) {
                  const first = createNew ? undefined : value.profiles.find(profile => profile.id === initialProfileId) ?? value.profiles.find(profile => !hostKeys || hostKeys.includes(profile.hostKey));
                  if (first) setDraft(first);
                  onProfileSelected?.(first ?? null);
                }
              })}>{t("database.reloadKeep")}</button>}
              {notice && <p role="status" className="database-manager__notice">{notice}</p>}
              {(connectionBusy || sqlState.busy) && <p role="status" className="database-manager__notice">{t("database.busy")}</p>}
              {!!snapshot?.credentialCleanupPending && <div role="alert" className="database-manager__notice"><p>{t("database.cleanupPending", { count: snapshot.credentialCleanupPending })}</p><button type="button" className="button button--secondary" disabled={busy} onClick={() => void perform(async () => {
                const value = await invoke<DatabaseSnapshot>("database_cleanup", { revision: snapshot.revision }); setSnapshot(value);
              })}>{t("database.retryCleanup")}</button></div>}
          {onConfigure && activeView === "settings" && <div className="database-manager__section-heading"><h3>{t("database.add")}</h3><p>{t("database.standaloneHint")}</p><button type="button" className="button button--primary" onClick={() => onConfigure(saved?.id, saved?.hostKey ?? defaultHostKey)}>{t("database.configure")}</button></div>}
          <form id={settingsFormId} onSubmit={save} className="database-manager__settings" hidden={activeView !== "settings" || Boolean(onConfigure)}>
            <div className="database-manager__section-heading"><h3 className="visually-hidden">{saved ? t("database.settings") : t("database.add")}</h3><p>{t("database.settingsHint")}</p></div>
            <fieldset disabled={busy || !snapshot} className="database-manager__fields">
              <legend className="visually-hidden">{t("database.loginSettings")}</legend>
              <section className="database-manager__form-card" aria-label={t("database.location")}>
                <h4 className="database-manager__form-section"><span>01</span><span>{t("database.location")}<small>{t("database.locationHint")}</small></span></h4>
                <div className="database-manager__field-grid">
                  <label className="database-manager__span">{t("database.name")}<input placeholder={t("database.namePlaceholder")} required maxLength={100} value={draft.name} onChange={(event) => update("name", event.target.value)} /></label>
                  {draft.engine !== "sqlite" && <>
                    <label className="database-manager__span">{t("database.route")}<select value={draft.route ? `${draft.route.kind}:${draft.route.profileId}` : "direct"} onChange={event => {
                      const value = event.target.value;
                      const index = value.indexOf(":");
                      update("route", value === "direct" ? null : { kind: value.slice(0, index) as "ssh" | "remote", profileId: value.slice(index + 1) });
                    }}>
                      <option value="direct">{t("database.direct")}</option>
                      {profiles.filter(profile => profile.protocol === "ssh" || profile.protocol === "lattice").map(profile => <option key={profile.id} value={`${profile.protocol === "ssh" ? "ssh" : "remote"}:${profile.id}`}>{profile.protocol === "ssh" ? t("database.sshTunnel") : t("database.remoteTunnel")}：{profile.name}</option>)}
                    </select></label>
                    <p className="database-manager__hint database-manager__span">{t("database.routeHint")}</p>
                  </>}
                  <label className="database-manager__span">{t("database.engine")}<select value={draft.engine} onChange={(event) => {
                    setTouched(true); setDraft(changeDatabaseEngine(draft, event.target.value as DatabaseProfile["engine"]));
                    setPassword(""); setShowPassword(false); setResult(null); setTables([]); setTableIndex("");
                  }}>{databaseEngines.map((engine) => <option key={engine.value} value={engine.value}>{engine.label}</option>)}</select></label>
                  {draft.engine === "sqlite" ? <label className="database-manager__span">{t("database.sqlitePath")}<input required maxLength={2048} value={draft.sqlitePath} onChange={(event) => update("sqlitePath", event.target.value)} /></label> : <>
                    <label>{t("database.hostname")}<input placeholder="db.example.com" autoCapitalize="none" autoCorrect="off" spellCheck={false} required maxLength={253} value={draft.hostname} onChange={(event) => update("hostname", event.target.value)} /></label>
                    <label>{t("database.port")}<input inputMode="numeric" required type="number" min={1} max={65535} value={draft.port} onChange={(event) => update("port", Number(event.target.value))} /></label>
                    <label className="database-manager__span">{t("database.databaseName")}<input placeholder={t("database.databasePlaceholder")} autoCapitalize="none" spellCheck={false} required maxLength={128} value={draft.database} onChange={(event) => update("database", event.target.value)} /></label>
                  </>}
                  <details className="database-manager__advanced database-manager__span"><summary>{t("database.cardDisplay")}</summary>
                    <label>{t("database.groupWithRemote")}<select value={draft.hostKey} onChange={event => update("hostKey", event.target.value)}>
                      <option value="local">{t("database.standaloneCard")}</option>
                      {draft.hostKey !== "local" && !cardTargets.has(draft.hostKey) && <option value={draft.hostKey}>{profiles.find(profile => profile.id === draft.hostKey)?.name ?? t("database.removedCard")}</option>}
                      {[...cardTargets].map(([key, profile]) => <option key={key} value={key}>{profile.name}</option>)}
                    </select></label>
                    <p className="database-manager__hint">{t("database.cardHint")}</p>
                  </details>
                </div>
              </section>
              <section className="database-manager__form-card" aria-label={t("database.loginPermissions")}>
                <h4 className="database-manager__form-section"><span>02</span><span>{t("database.login")}<small>{t("database.passwordHint")}</small></span></h4>
                <div className="database-manager__field-grid">
                  {draft.engine === "sqlite" ? <p className="database-manager__hint database-manager__span">{t("database.sqliteLoginHint")}</p> : <>
                    <label className="database-manager__span">{t("database.username")}<input placeholder={t("database.usernamePlaceholder")} autoCapitalize="none" autoCorrect="off" spellCheck={false} required autoComplete="off" maxLength={128} value={draft.username} onChange={(event) => update("username", event.target.value)} /></label>
                    <div className="database-manager__password database-manager__span"><label>{t("database.password")}<input type={showPassword ? "text" : "password"} autoComplete="new-password" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder={saved ? t("database.keepPassword") : t("database.enterPassword")} value={password} onChange={(event) => { setTouched(true); setPassword(event.target.value); }} /></label><button type="button" className="button button--secondary" aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)}>{showPassword ? t("database.hidePassword") : t("database.showPassword")}</button><small>{t("database.passwordEndpointHint")}</small></div>
                  </>}
                  <div className="database-manager__form-section database-manager__span"><span>03</span><span>{t("database.aiAccess")}<small>{t("database.aiAccessHint")}</small></span></div>
                  <label className="database-manager__permission database-manager__span"><input type="checkbox" checked={draft.allowMcpRead} onChange={(event) => update("allowMcpRead", event.target.checked)} />{t("database.allowRead")}</label>
                  <p className="database-manager__hint database-manager__span">{t("database.credentialHint")}</p>
                </div>
              </section>
              <div className="database-manager__actions database-manager__save-bar database-manager__span">
                {!settingsFormId && <>
                <button type="submit" className="button button--primary" disabled={!dirty}>{embedded ? t("database.saveDatabase") : t("database.save")}</button>
                <button type="button" className="button button--secondary" onClick={testConnection}>{t("database.test")}</button>
                <button type="button" className="button button--secondary" onClick={() => reset(saved ?? available[0])}>{t("database.cancelEdit")}</button>
                </>}
                {saved && <button type="button" className="database-manager__delete" onClick={() => setDeleting(saved.id)}>{t("database.delete")}</button>}
              </div>
              {deleting && <div className="database-manager__span sql-workbench__confirm" role="group" aria-label={t("database.deleteLabel")}>
                <p>{t("database.deleteHint")}</p>
                <button type="button" className="button button--danger" onClick={() => void perform(async () => {
                  const value = await invoke<DatabaseSnapshot>("database_delete", { profileId: deleting, revision: snapshot!.revision });
                  setSnapshot(value); reset();
                })}>{t("database.confirmDelete")}</button>
                <button type="button" className="button button--secondary" onClick={() => setDeleting(null)}>{t("database.cancelDelete")}</button>
              </div>}
            </fieldset>
          </form>
        <section className="database-manager__browse" aria-label={t("database.readOnlyBrowse")} hidden={activeView !== "tables"}><div className="database-manager__section-heading"><h3>{t("database.browse")}</h3><p>{t("database.browseHint")}</p></div>
          <div className="database-manager__actions">
            <button type="button" className="button button--secondary" disabled={busy || dirty} onClick={() => read("version")}>{t("database.readVersion")}</button>
            <button type="button" className="button button--secondary" disabled={busy || dirty} onClick={() => read("tables")}>{t("database.listTables")}</button>
            <label>{t("database.table")}<select disabled={busy || dirty || !tables.length} value={tableIndex} onChange={(event) => { setTableIndex(event.target.value); setResult(null); setOffset(0); }}>
              <option value="">{t("database.selectTable")}</option>
              {tables.map((table, index) => <option key={index} value={index}>{table[0]}.{table[1]}</option>)}
            </select></label>
            <button type="button" className="button button--secondary" disabled={busy || dirty || tableIndex === ""} onClick={() => read("columns")}>{t("database.columns")}</button>
            <button type="button" className="button button--primary" disabled={busy || dirty || tableIndex === ""} onClick={() => read("rows")}>{t("database.firstRows")}</button>
          </div>
          {dirty && <p>{t("database.saveBeforeQuery")}</p>}
          {result && <>
            <p>{t("database.browseSummary", { limit: result.cellCharacterLimit, count: result.rows.length, truncated: result.truncated ? t("database.truncated") : "" })}</p>
            <div className="database-manager__result" tabIndex={0} role="region" aria-label={t("database.results")}>
              <table><thead><tr>{result.columns.map((column, index) => <th key={index} scope="col">{column}</th>)}</tr></thead>
                <tbody>{result.rows.map((row, index) => <tr key={index}>{row.map((value, cell) => <td key={cell}>{value === null ? <em>NULL</em> : value}</td>)}</tr>)}</tbody>
              </table>
            </div>
            {tableIndex !== "" && resultKind === "rows" && <div className="database-manager__actions">
              <button type="button" className="button button--secondary" disabled={busy || dirty || !previousOffsets.length} onClick={() => read("rows", previousOffsets[previousOffsets.length - 1] ?? 0, previousOffsets.slice(0, -1))}>{t("database.previous")}</button>
              <button type="button" className="button button--secondary" disabled={busy || dirty || !result.truncated || !result.rows.length || offset + result.rows.length > 100000} onClick={() => read("rows", offset + result.rows.length, [...previousOffsets, offset])}>{t("database.next")}</button>
            </div>}
          </>}
        </section>

              {saved && !settingsOnly && <div hidden={activeView !== "sql"}>{!dirty ? <SqlWorkbench key={JSON.stringify(saved)} profileId={saved.id} mcpAllowed={saved.allowMcpRead} onStateChange={setSqlState} /> : <p className="database-manager__notice">{t("database.saveOrCancel")}</p>}</div>}
            </div>
            <footer className="database-manager__footer"><span>{sqlState.dirty ? t("database.syncBeforeSwitch") : touched && dirty ? t("database.settingsUnsaved") : settingsOnly ? t("database.settingsLocal") : t("database.queryAndWrite")}</span><span>{draft.engine === "sqlite" ? t("database.sqliteLocal") : t("database.noCa")}</span></footer>
          </section>
        </div>
      </div>
    </div>
  );
}
