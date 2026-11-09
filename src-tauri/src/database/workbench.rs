//! Shared SQL drafts and bounded results. MCP may inspect/edit an explicitly
//! shared draft. Execution additionally requires an explicit per-workbench grant.
use super::*;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workbench {
    #[serde(skip)]
    bound_profile: DatabaseProfile,
    pub id: String,
    pub profile_id: String,
    pub name: String,
    pub target: String,
    pub sql: String,
    pub revision: u64,
    pub busy: bool,
    pub share_read: bool,
    pub share_edit: bool,
    pub share_execute: bool,
    pub share_write: bool,
    pub detached: bool,
    pub updated_by: String,
    pub last_sql: String,
    pub result: Option<Value>,
    pub error: Option<String>,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorkbenchAction {
    Open {
        profile_id: String,
    },
    Read {
        id: String,
    },
    Edit {
        id: String,
        revision: u64,
        sql: String,
    },
    Share {
        id: String,
        revision: u64,
        read: bool,
        edit: bool,
        #[serde(default)]
        execute: bool,
        #[serde(default)]
        write: bool,
    },
    Execute {
        id: String,
        revision: u64,
        confirmed_write: bool,
    },
}

impl Workbench {
    pub(super) fn bound_to(&self, profile: &DatabaseProfile) -> bool {
        self.bound_profile == *profile
    }
}

fn edit(workbench: &mut Workbench, revision: u64, sql: &str, source: &str) -> Result<(), String> {
    if workbench.busy || revision != workbench.revision {
        return Err("SQL 草稿已變更或正在執行；請重新載入並確認，不會覆蓋他人的修改。".into());
    }
    if sql.len() > 65536 || sql.contains('\0') {
        return Err("SQL 超過長度限制或含有無效字元。".into());
    }
    workbench.sql = sql.into();
    workbench.revision += 1;
    workbench.updated_by = source.into();
    Ok(())
}

fn target(profile: &DatabaseProfile) -> String {
    if profile.engine == Engine::Sqlite {
        format!("SQLite · {}", profile.name)
    } else {
        format!(
            "{:?} · {}:{} / {}",
            profile.engine, profile.hostname, profile.port, profile.database
        )
    }
}

impl DatabaseRegistry {
    pub(super) fn workbench_action(
        &self,
        action: &DatabaseAction,
        profile: &DatabaseProfile,
    ) -> Option<Result<Value, String>> {
        match action {
            DatabaseAction::Workbenches { .. } => Some((|| {
                let panels = self.workbenches.lock().map_err(|_| "SQL 工作台忙碌中。")?;
                Ok(
                    json!({"workbenches":panels.values().filter(|w| w.bound_profile == *profile && w.share_read).map(|w| json!({"id":w.id,"name":w.name,"revision":w.revision,"busy":w.busy,"canEditSql":w.share_edit,"canExecuteSql":w.share_execute,"canWriteSql":w.share_write})).collect::<Vec<_>>()}),
                )
            })()),
            DatabaseAction::Workbench { workbench_id, .. }
            | DatabaseAction::WorkbenchSql { workbench_id, .. } => Some((|| {
                let mut panels = self.workbenches.lock().map_err(|_| "SQL 工作台忙碌中。")?;
                let panel = panels
                    .get_mut(workbench_id)
                    .filter(|w| w.bound_profile == *profile && w.share_read)
                    .ok_or("SQL 工作台不存在或未分享。")?;
                if let DatabaseAction::WorkbenchSql { revision, sql, .. } = action {
                    if !panel.share_edit {
                        return Err("使用者未允許 MCP 修改這份 SQL 草稿。".into());
                    }
                    edit(panel, *revision, sql, "mcp")?;
                }
                serde_json::to_value(panel).map_err(|_| "無法讀取 SQL 工作台。".into())
            })()),
            _ => None,
        }
    }

    async fn workbench_local(&self, action: WorkbenchAction) -> Result<Workbench, String> {
        if let WorkbenchAction::Open { profile_id } = &action {
            let registry = self.clone();
            let snapshot = crate::credential_call(move || registry.snapshot()).await?;
            let profile = snapshot
                .profiles
                .iter()
                .find(|p| p.id == *profile_id)
                .ok_or("請先儲存資料庫連線。")?;
            let mut panels = self.workbenches.lock().map_err(|_| "SQL 工作台忙碌中。")?;
            panels.retain(|_, panel| {
                panel.busy
                    || panel.detached
                    || snapshot
                        .profiles
                        .iter()
                        .any(|profile| profile.id == panel.profile_id)
            });
            if let Some(existing) = panels.values_mut().find(|w| w.profile_id == *profile_id) {
                if existing.bound_profile != *profile {
                    if existing.busy {
                        return Err("原連線的 SQL 仍在執行，請等候完成後重新開啟。".into());
                    }
                    existing.bound_profile = profile.clone();
                    existing.target = target(profile);
                    existing.name = profile.name.clone();
                    existing.share_read = false;
                    existing.share_edit = false;
                    existing.share_execute = false;
                    existing.share_write = false;
                    existing.result = None;
                    existing.last_sql.clear();
                    existing.error = None;
                    existing.revision += 1;
                }
                return Ok(existing.clone());
            }
            if panels.len() >= 16 {
                return Err("最多同時保留 16 個 SQL 工作台；請先關閉不再使用的工作台。".into());
            }
            let mut nonce = [0u8; 16];
            getrandom::fill(&mut nonce).map_err(|_| "無法建立 SQL 工作台。")?;
            let id: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
            let panel = Workbench {
                bound_profile: profile.clone(),
                id: id.clone(),
                profile_id: profile_id.clone(),
                name: profile.name.clone(),
                target: target(profile),
                sql: "SELECT 1".into(),
                revision: 0,
                busy: false,
                share_read: false,
                share_edit: false,
                share_execute: false,
                share_write: false,
                detached: false,
                updated_by: "user".into(),
                last_sql: String::new(),
                result: None,
                error: None,
            };
            panels.insert(id, panel.clone());
            return Ok(panel);
        }
        if let WorkbenchAction::Execute {
            id,
            revision,
            confirmed_write,
        } = action
        {
            let _permit = self
                .calls
                .clone()
                .try_acquire_owned()
                .map_err(|_| "資料庫忙碌中，請稍後再試。")?;
            let panel = {
                let mut panels = self.workbenches.lock().map_err(|_| "SQL 工作台忙碌中。")?;
                let panel = panels.get_mut(&id).ok_or("SQL 工作台已關閉。")?;
                if panel.busy || panel.revision != revision {
                    return Err("SQL 已變更或正在執行，請重新確認。".into());
                }
                panel.busy = true;
                panel.revision += 1;
                panel.result = None;
                panel.error = None;
                panel.last_sql = panel.sql.clone();
                panel.clone()
            };
            // Own the task through completion even if its originating window
            // closes. Never repeat a write when an IPC response was lost.
            let registry = self.clone();
            return tokio::spawn(async move {
                let _permit = _permit;
                let result = registry.run_sql(&panel, confirmed_write, false, None).await;
                let mut panels = registry
                    .workbenches
                    .lock()
                    .map_err(|_| "SQL 工作台忙碌中。")?;
                let panel = panels.get_mut(&id).ok_or("SQL 工作台已關閉。")?;
                panel.busy = false;
                panel.revision += 1;
                match result {
                    Ok(value) => panel.result = Some(value),
                    Err(error) => panel.error = Some(error),
                }
                Ok(panel.clone())
            })
            .await
            .map_err(|_| "SQL 執行結果無法確認，請先查詢，不要直接重送。")?;
        }
        let mut panels = self.workbenches.lock().map_err(|_| "SQL 工作台忙碌中。")?;
        match action {
            WorkbenchAction::Read { id } => {
                panels.get(&id).cloned().ok_or("SQL 工作台已關閉。".into())
            }
            WorkbenchAction::Edit { id, revision, sql } => {
                let panel = panels.get_mut(&id).ok_or("SQL 工作台已關閉。")?;
                edit(panel, revision, &sql, "user")?;
                Ok(panel.clone())
            }
            WorkbenchAction::Share {
                id,
                revision,
                read,
                edit: can_edit,
                execute,
                write,
            } => {
                let panel = panels.get_mut(&id).ok_or("SQL 工作台已關閉。")?;
                if panel.revision != revision {
                    return Err("SQL 工作台已變更，請重新載入。".into());
                }
                panel.share_read = read;
                panel.share_edit = read && can_edit;
                panel.share_execute = read && execute;
                panel.share_write = read && execute && write;
                panel.revision += 1;
                Ok(panel.clone())
            }
            _ => unreachable!(),
        }
    }

    fn check_mcp_sql(&self, panel: &Workbench, write: bool) -> Result<(), String> {
        let panels = self.workbenches.lock().map_err(|_| "SQL 工作台忙碌中。")?;
        let current = panels.get(&panel.id).ok_or("SQL 工作台已關閉。")?;
        if current.bound_profile != panel.bound_profile
            || !current.bound_profile.allow_mcp_read
            || !current.share_read
            || !current.share_execute
            || (write && !current.share_write)
        {
            return Err("未允許 MCP 執行這份 SQL，或執行權限已撤回。".into());
        }
        Ok(())
    }

    pub(super) async fn workbench_mcp(
        &self,
        profile: &DatabaseProfile,
        id: &str,
        revision: u64,
        guard: Option<McpGuard>,
        permit: tokio::sync::OwnedSemaphorePermit,
    ) -> Result<Value, String> {
        if let Some(check) = &guard {
            check()?;
        }
        let panel = {
            let mut panels = self.workbenches.lock().map_err(|_| "SQL 工作台忙碌中。")?;
            let panel = panels.get_mut(id).ok_or("SQL 工作台已關閉。")?;
            if panel.bound_profile != *profile
                || !profile.allow_mcp_read
                || !panel.share_read
                || !panel.share_execute
            {
                return Err("使用者未允許 MCP 執行此工作台的 SQL。".into());
            }
            if panel.busy || panel.revision != revision {
                return Err("SQL 已變更或正在執行，請重新讀取工作台；不可重送舊版本。".into());
            }
            panel.busy = true;
            panel.revision += 1;
            panel.result = None;
            panel.error = None;
            panel.last_sql = panel.sql.clone();
            panel.updated_by = "mcp".into();
            panel.clone()
        };
        let registry = self.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let result = registry
                .run_sql(&panel, panel.share_write, true, guard)
                .await;
            let mut panels = registry
                .workbenches
                .lock()
                .map_err(|_| "SQL 工作台忙碌中。")?;
            let current = panels.get_mut(&panel.id).ok_or("SQL 工作台已關閉。")?;
            current.busy = false;
            current.revision += 1;
            match result {
                Ok(result) => {
                    current.result = Some(result);
                    serde_json::to_value(current).map_err(|_| "無法讀取結果。".into())
                }
                Err(error) => {
                    current.error = Some(error.clone());
                    Err(error)
                }
            }
        })
        .await
        .map_err(|_| "SQL 執行結果無法確認；請先查詢，不要直接重送。".to_string())?
    }

    async fn run_sql(
        &self,
        panel: &Workbench,
        confirmed: bool,
        mcp: bool,
        guard: Option<McpGuard>,
    ) -> Result<Value, String> {
        let registry = self.clone();
        let snapshot = crate::credential_call(move || registry.snapshot()).await?;
        let profile = snapshot
            .profiles
            .iter()
            .find(|p| p.id == panel.profile_id)
            .cloned()
            .ok_or("資料庫連線已移除。")?;
        if profile != panel.bound_profile {
            return Err("連線設定已變更，請重新開啟工作台並確認 SQL。".into());
        }
        if mcp {
            self.check_mcp_sql(panel, confirmed)?;
        }
        if let Some(check) = &guard {
            check()?;
        }
        let credential_profile = profile.clone();
        let password = crate::credential_call(move || {
            credential_profile.validate()?;
            if credential_profile.engine == Engine::Sqlite {
                return Ok(Zeroizing::new(String::new()));
            }
            credentials::load_bound_with_context(
                &credential_profile.credential_profile(),
                CredentialKind::DatabasePassword,
                &credential_profile.credential_context(),
            )
            .map(Zeroizing::new)
            .map_err(|_| "無法讀取密碼，請解鎖憑證庫或重新儲存連線。".into())
        })
        .await?;
        let revalidate = || {
            if let Some(check) = &guard {
                check()?;
            }
            if mcp {
                self.check_mcp_sql(panel, confirmed)?;
            }
            let current = self.snapshot()?;
            if current.profiles.iter().find(|p| p.id == profile.id) != Some(&profile) {
                return Err("連線設定已變更；請先查詢資料確認執行結果，不要直接重送。".into());
            }
            Ok(())
        };
        revalidate()?;
        let route = self.connection_route(&profile).await?;
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            drivers::execute_sql(&route.profile, &password, &panel.sql, confirmed, revalidate),
        )
        .await
        .map_err(|_| "SQL 超過 20 秒；寫入結果可能無法確認，請先查詢資料，不要直接重送。")??;
        revalidate()?;
        Ok(result)
    }
}

#[tauri::command]
pub async fn database_workbench(
    registry: State<'_, DatabaseRegistry>,
    action: WorkbenchAction,
) -> Result<Workbench, String> {
    registry.workbench_local(action).await
}

#[tauri::command]
pub fn database_workbench_close(
    registry: State<'_, DatabaseRegistry>,
    id: String,
    revision: u64,
) -> Result<(), String> {
    let mut panels = registry
        .workbenches
        .lock()
        .map_err(|_| "SQL 工作台忙碌中。")?;
    let panel = panels.get(&id).ok_or("SQL 工作台已關閉。")?;
    if panel.revision != revision || panel.busy || panel.detached {
        return Err("工作台已變更、仍在執行或已分離，請先放回主視窗再關閉。".into());
    }
    panels.remove(&id);
    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
pub async fn database_popout(
    app: tauri::AppHandle,
    registry: State<'_, DatabaseRegistry>,
    id: String,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(), String> {
    if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("SQL 工作台識別碼無效。".into());
    }
    {
        if !registry
            .workbenches
            .lock()
            .map_err(|_| "SQL 工作台忙碌中。")?
            .contains_key(&id)
        {
            return Err("SQL 工作台不存在。".into());
        }
    }
    let label = format!("sql-{id}");
    if let Some(window) = app.get_webview_window(&label) {
        window.show().map_err(|e| e.to_string())?;
        window.unminimize().map_err(|e| e.to_string())?;
        return window.set_focus().map_err(|e| e.to_string());
    }
    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App(format!("index.html?database-workbench={id}").into()),
    )
    .title("LatticeTerm · SQL 工作台")
    .inner_size(1050.0, 720.0)
    .min_inner_size(480.0, 360.0);
    if let (Some(x), Some(y)) = (x, y) {
        if x.is_finite() && y.is_finite() {
            builder = builder.position(x, y);
        }
    }
    let window = builder
        .build()
        .map_err(|_| "無法開啟 SQL 獨立視窗，草稿仍保留於面板。")?;
    registry
        .workbenches
        .lock()
        .map_err(|_| "SQL 工作台忙碌中。")?
        .get_mut(&id)
        .ok_or("SQL 工作台不存在。")?
        .detached = true;
    let registry = registry.inner().clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            if let Ok(mut panels) = registry.workbenches.lock() {
                if let Some(panel) = panels.get_mut(&id) {
                    panel.detached = false;
                }
            }
        }
    });
    Ok(())
}

#[cfg(all(test, not(target_os = "ios")))]
mod tests {
    use super::*;

    async fn mcp_fixture(
        execute: bool,
        write: bool,
        sql: &str,
    ) -> (tempfile::TempDir, DatabaseRegistry, Workbench) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mcp.sqlite");
        rusqlite::Connection::open(&path).unwrap().execute_batch("CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO sample VALUES(1, 'original');").unwrap();
        let registry = DatabaseRegistry::new(directory.path().into());
        let profile = DatabaseProfile {
            id: "mcp".into(),
            host_key: "local".into(),
            name: "MCP test".into(),
            engine: Engine::Sqlite,
            hostname: String::new(),
            port: 0,
            username: String::new(),
            database: String::new(),
            sqlite_path: path.to_string_lossy().into_owned(),
            tls_ca_pem: String::new(),
            route: None,
            allow_mcp_read: true,
        };
        let snapshot = registry.snapshot().unwrap();
        registry
            .edit(&snapshot.revision, Some(profile), None, None)
            .unwrap();
        let panel = registry
            .workbench_local(WorkbenchAction::Open {
                profile_id: "mcp".into(),
            })
            .await
            .unwrap();
        let panel = registry
            .workbench_local(WorkbenchAction::Edit {
                id: panel.id.clone(),
                revision: panel.revision,
                sql: sql.into(),
            })
            .await
            .unwrap();
        let panel = registry
            .workbench_local(WorkbenchAction::Share {
                id: panel.id.clone(),
                revision: panel.revision,
                read: true,
                edit: true,
                execute,
                write,
            })
            .await
            .unwrap();
        (directory, registry, panel)
    }

    fn execute_mcp(panel: &Workbench) -> DatabaseAction {
        DatabaseAction::WorkbenchExecute {
            profile_id: panel.profile_id.clone(),
            workbench_id: panel.id.clone(),
            revision: panel.revision,
        }
    }

    #[tokio::test]
    async fn mcp_execution_is_opt_in_and_readonly_rejects_writes() {
        let (_dir, registry, panel) = mcp_fixture(false, false, "SELECT value FROM sample").await;
        assert!(registry.execute(execute_mcp(&panel), true).await.is_err());
        let (_dir, registry, panel) = mcp_fixture(true, false, "SELECT value FROM sample").await;
        let result = registry.execute(execute_mcp(&panel), true).await.unwrap();
        assert_eq!(result["result"]["rows"][0][0], "original");
        assert!(
            registry.execute(execute_mcp(&panel), true).await.is_err(),
            "stale execution must not replay"
        );
        let (dir, registry, panel) = mcp_fixture(true, false, "DELETE FROM sample").await;
        assert!(registry.execute(execute_mcp(&panel), true).await.is_err());
        let db = rusqlite::Connection::open(dir.path().join("mcp.sqlite")).unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM sample", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn mcp_write_grant_executes_once_and_revocation_blocks_execution() {
        let (dir, registry, panel) =
            mcp_fixture(true, true, "UPDATE sample SET value='changed' WHERE id=1").await;
        let result = registry.execute(execute_mcp(&panel), true).await.unwrap();
        assert_eq!(result["result"]["affectedRows"], 1);
        assert!(registry.execute(execute_mcp(&panel), true).await.is_err());
        let db = rusqlite::Connection::open(dir.path().join("mcp.sqlite")).unwrap();
        assert_eq!(
            db.query_row("SELECT value FROM sample", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "changed"
        );
        let mut panel = registry
            .workbench_local(WorkbenchAction::Read { id: panel.id })
            .await
            .unwrap();
        for sql in [
            "INSERT INTO sample VALUES(2, 'added')",
            "DELETE FROM sample WHERE id=2",
        ] {
            registry
                .execute(
                    DatabaseAction::WorkbenchSql {
                        profile_id: panel.profile_id.clone(),
                        workbench_id: panel.id.clone(),
                        revision: panel.revision,
                        sql: sql.into(),
                    },
                    true,
                )
                .await
                .unwrap();
            panel = registry
                .workbench_local(WorkbenchAction::Read { id: panel.id })
                .await
                .unwrap();
            let result = registry.execute(execute_mcp(&panel), true).await.unwrap();
            assert_eq!(result["result"]["affectedRows"], 1);
            panel = registry
                .workbench_local(WorkbenchAction::Read { id: panel.id })
                .await
                .unwrap();
        }
        assert_eq!(
            db.query_row("SELECT count(*) FROM sample", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        let panel = registry
            .workbench_local(WorkbenchAction::Share {
                id: panel.id,
                revision: panel.revision,
                read: true,
                edit: true,
                execute: false,
                write: false,
            })
            .await
            .unwrap();
        assert!(registry.execute(execute_mcp(&panel), true).await.is_err());
    }

    #[tokio::test]
    async fn mcp_global_revocation_before_commit_rolls_back_sqlite_write() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let (dir, registry, panel) = mcp_fixture(true, true, "DELETE FROM sample").await;
        let calls = Arc::new(AtomicUsize::new(0));
        let checked = calls.clone();
        let guard: McpGuard = Arc::new(move || {
            // Initial admission, credential lookup and pre-execution checks pass;
            // revoke when the driver asks permission to commit its transaction.
            if checked.fetch_add(1, Ordering::SeqCst) < 3 {
                Ok(())
            } else {
                Err("revoked".into())
            }
        });
        let error = registry
            .execute_guarded(execute_mcp(&panel), true, Some(guard))
            .await
            .unwrap_err();
        assert_eq!(error, "revoked");
        assert!(calls.load(Ordering::SeqCst) >= 4);
        let db = rusqlite::Connection::open(dir.path().join("mcp.sqlite")).unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM sample", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn shared_drafts_use_cas_never_execute_and_revoke_on_connection_change() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("panel.sqlite");
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE sample(id INTEGER); INSERT INTO sample VALUES(1);")
            .unwrap();
        drop(db);
        let registry = DatabaseRegistry::new(directory.path().into());
        let profile = DatabaseProfile {
            id: "panel".into(),
            host_key: "local".into(),
            name: "共享 SQL".into(),
            engine: Engine::Sqlite,
            hostname: String::new(),
            port: 0,
            username: String::new(),
            database: String::new(),
            sqlite_path: path.to_string_lossy().into_owned(),
            tls_ca_pem: String::new(),
            route: None,
            allow_mcp_read: true,
        };
        let original = registry.snapshot().unwrap();
        registry
            .edit(&original.revision, Some(profile.clone()), None, None)
            .unwrap();
        let panel = registry
            .workbench_local(WorkbenchAction::Open {
                profile_id: profile.id.clone(),
            })
            .await
            .unwrap();
        let read = DatabaseAction::Workbench {
            profile_id: profile.id.clone(),
            workbench_id: panel.id.clone(),
        };
        assert!(registry.execute(read.clone(), true).await.is_err());
        let panel = registry
            .workbench_local(WorkbenchAction::Share {
                id: panel.id.clone(),
                revision: panel.revision,
                read: true,
                edit: false,
                execute: false,
                write: false,
            })
            .await
            .unwrap();
        let change = DatabaseAction::WorkbenchSql {
            profile_id: profile.id.clone(),
            workbench_id: panel.id.clone(),
            revision: panel.revision,
            sql: "DELETE FROM sample".into(),
        };
        assert!(registry.execute(change, true).await.is_err());
        let panel = registry
            .workbench_local(WorkbenchAction::Share {
                id: panel.id.clone(),
                revision: panel.revision,
                read: true,
                edit: true,
                execute: false,
                write: false,
            })
            .await
            .unwrap();
        let change = DatabaseAction::WorkbenchSql {
            profile_id: profile.id.clone(),
            workbench_id: panel.id.clone(),
            revision: panel.revision,
            sql: "DELETE FROM sample".into(),
        };
        let edited = registry.execute(change.clone(), true).await.unwrap();
        assert_eq!(edited["updatedBy"], "mcp");
        assert!(edited.get("boundProfile").is_none());
        assert!(registry.execute(change, true).await.is_err());
        assert!(registry
            .workbench_local(WorkbenchAction::Execute {
                id: panel.id.clone(),
                revision: panel.revision,
                confirmed_write: true
            })
            .await
            .is_err());
        let db = rusqlite::Connection::open(&path).unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM sample", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        drop(db);
        let revision = edited["revision"].as_u64().unwrap();
        let result = registry
            .workbench_local(WorkbenchAction::Execute {
                id: panel.id.clone(),
                revision,
                confirmed_write: false,
            })
            .await
            .unwrap();
        assert!(result.error.is_some());
        assert!(!result.busy);
        let mut changed = profile.clone();
        changed.name = "不同連線設定".into();
        registry
            .edit(
                &registry.snapshot().unwrap().revision,
                Some(changed),
                None,
                None,
            )
            .unwrap();
        assert!(registry.execute(read, true).await.is_err());
        let reopened = registry
            .workbench_local(WorkbenchAction::Open {
                profile_id: profile.id,
            })
            .await
            .unwrap();
        assert!(!reopened.share_read);
        assert!(!reopened.share_edit);
        assert!(reopened.result.is_none());
        assert!(serde_json::from_value::<DatabaseAction>(
            json!({"kind":"execute","profileId":"panel","sql":"DELETE FROM sample"})
        )
        .is_err());
    }
}
