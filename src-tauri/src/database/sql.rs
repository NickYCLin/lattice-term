use super::*;
use futures_util::TryStreamExt;
use sqlparser::{
    ast::{Query, SetExpr, Statement, Visit, Visitor},
    dialect::*,
    parser::Parser,
};
use sqlx::{AssertSqlSafe, Column, SqlSafeStr, ValueRef};
use std::ops::ControlFlow;

/// Parse and re-serialize a single statement. Never pass executable comments,
/// extra statements or transaction-control commands through to a driver.
pub(super) fn classify_sql(engine: Engine, text: &str) -> Result<(String, bool), String> {
    if text.is_empty() || text.len() > 65536 {
        return Err("SQL 必須為 1–65536 位元組。".into());
    }
    let dialect: Box<dyn Dialect> = match engine {
        Engine::Postgres => Box::new(PostgreSqlDialect {}),
        Engine::Mysql | Engine::Mariadb => Box::new(MySqlDialect {}),
        Engine::SqlServer => Box::new(MsSqlDialect {}),
        Engine::Sqlite => Box::new(SQLiteDialect {}),
    };
    let mut statements = Parser::new(dialect.as_ref())
        .with_recursion_limit(32)
        .try_with_sql(text)
        .and_then(|mut parser| parser.parse_statements())
        .map_err(|_| "無法解析 SQL，請檢查目前資料庫的語法。")?;
    if statements.len() != 1 {
        return Err("每次只能執行一個 SQL 敘述。".into());
    }
    struct Check {
        write: bool,
    }
    impl Visitor for Check {
        type Break = ();
        fn pre_visit_statement(&mut self, statement: &Statement) -> ControlFlow<()> {
            match statement {
                Statement::Query(_) => {}
                Statement::Insert(_) | Statement::Update(_) | Statement::Delete(_) => {
                    self.write = true
                }
                _ => return ControlFlow::Break(()),
            }
            ControlFlow::Continue(())
        }
        fn pre_visit_query(&mut self, query: &Query) -> ControlFlow<()> {
            fn into(body: &SetExpr) -> bool {
                match body {
                    SetExpr::Select(select) => select.into.is_some(),
                    SetExpr::SetOperation { left, right, .. } => into(left) || into(right),
                    _ => false,
                }
            }
            if into(&query.body) {
                return ControlFlow::Break(());
            }
            ControlFlow::Continue(())
        }
    }
    let statement = statements.remove(0);
    let mut check = Check { write: false };
    if statement.visit(&mut check).is_break() {
        return Err(
            "SQL 工作台只接受 SELECT、INSERT、UPDATE、DELETE；不開放建表、交易控制或 SELECT INTO。"
                .into(),
        );
    }
    Ok((statement.to_string(), check.write))
}

fn push_result(rows: &mut TextRows, row: Vec<Option<String>>, bytes: &mut usize) -> bool {
    let row: Vec<_> = row
        .into_iter()
        .map(|cell| cell.map(|s| s.chars().take(CELL_CHARS).collect::<String>()))
        .collect();
    *bytes += serde_json::to_vec(&row).map_or(262145, |v| v.len());
    if rows.len() >= 100 || *bytes > 262144 {
        return false;
    }
    rows.push(row);
    true
}

impl Client {
    async fn finish_transaction(&mut self, commit: bool) -> Result<(), String> {
        if let Self::SqlServer(client) = self {
            // Use TDS transaction-manager requests. Sending COMMIT through
            // execute/sp_executesql changes the RPC's transaction count and
            // can report an error after the server already committed.
            return if commit {
                client.commit_transaction().await
            } else {
                client.rollback_transaction().await
            }
            .map_err(|_| failed());
        }
        self.execute_statement(if commit { "COMMIT" } else { "ROLLBACK" })
            .await
            .map(|_| ())
    }

    async fn execute_statement(&mut self, statement: &str) -> Result<u64, String> {
        match self {
            Self::Postgres(c) => sqlx::Executor::execute(c, AssertSqlSafe(statement))
                .await
                .map(|r| r.rows_affected())
                .map_err(|_| failed()),
            Self::Mysql(c) => sqlx::Executor::execute(c, AssertSqlSafe(statement))
                .await
                .map(|r| r.rows_affected())
                .map_err(|_| failed()),
            #[cfg(not(target_os = "ios"))]
            Self::Sqlite(c) => sqlx::Executor::execute(c, AssertSqlSafe(statement))
                .await
                .map(|r| r.rows_affected())
                .map_err(|_| failed()),
            #[cfg(target_os = "ios")]
            Self::Sqlite(_) => Err("iOS SQLite 只開放唯讀存取。".into()),
            Self::SqlServer(c) => c
                .execute(statement, &[])
                .await
                .map(|r| r.total())
                .map_err(|_| failed()),
        }
    }

    async fn sql_rows(&mut self, statement: &str) -> Result<Value, String> {
        let mut rows = vec![];
        let mut names = vec![];
        let mut bytes = 0;
        let mut truncated = false;
        macro_rules! stream_rows {
            ($connection:expr) => {{
                // Simple-query/text protocol preserves arbitrary scalar types
                // as server-formatted text, rather than decoding them as i64.
                let description = sqlx::Executor::prepare(&mut *$connection, AssertSqlSafe(statement).into_sql_str()).await.map_err(|_| failed())?;
                names = sqlx::Statement::columns(&description).iter().map(|c| c.name().to_owned()).collect();
                if names.len() > MAX_COLUMNS { return Err("查詢結果最多支援 64 個欄位。".into()); }
                let mut stream = sqlx::Executor::fetch($connection, AssertSqlSafe(statement));
                while let Some(row) = stream.try_next().await.map_err(|_| failed())? {
                    if row.len() > MAX_COLUMNS { return Err("查詢結果最多支援 64 個欄位。".into()); }
                    names = row.columns().iter().map(|c| c.name().to_owned()).collect();
                    let cells = (0..row.len()).map(|i| {
                        if row.try_get_raw(i).map_err(|_| failed())?.is_null() { return Ok(None); }
                        row.try_get_unchecked::<Option<String>, _>(i).map_err(|_| "此結果含有無法顯示的型別，請在 SQL 以 CAST 轉成文字。".into())
                    }).collect::<Result<Vec<_>, String>>()?;
                    if !push_result(&mut rows, cells, &mut bytes) { truncated = true; break; }
                }
            }};
        }
        match self {
            Self::Postgres(c) => stream_rows!(c),
            Self::Mysql(c) => stream_rows!(c),
            #[cfg(not(target_os = "ios"))]
            Self::Sqlite(c) => stream_rows!(c),
            #[cfg(target_os = "ios")]
            Self::Sqlite(_) => return Err("iOS SQLite 請使用既有唯讀資料表瀏覽。".into()),
            Self::SqlServer(c) => {
                let mut stream = c.simple_query(statement).await.map_err(|_| failed())?;
                while let Some(item) = stream.try_next().await.map_err(|_| failed())? {
                    match item {
                        tiberius::QueryItem::Metadata(m) => {
                            names = m.columns().iter().map(|c| c.name().to_owned()).collect();
                            if names.len() > MAX_COLUMNS {
                                return Err("查詢結果最多支援 64 個欄位。".into());
                            }
                        }
                        tiberius::QueryItem::Row(row) => {
                            use tiberius::ColumnData::*;
                            let cells = row
                                .cells()
                                .enumerate()
                                .map(|(index, (_, value))| {
                                    Ok(match value {
                                        String(v) => v.as_ref().map(|s| s.to_string()),
                                        U8(v) => v.map(|v| v.to_string()),
                                        I16(v) => v.map(|v| v.to_string()),
                                        I32(v) => v.map(|v| v.to_string()),
                                        I64(v) => v.map(|v| v.to_string()),
                                        F32(v) => v.map(|v| v.to_string()),
                                        F64(v) => v.map(|v| v.to_string()),
                                        Bit(v) => v.map(|v| v.to_string()),
                                        Guid(v) => v.map(|v| v.to_string()),
                                        Numeric(v) => v.as_ref().map(|v| v.to_string()),
                                        Binary(v) => v.as_ref().map(|v| {
                                            format!(
                                                "0x{}",
                                                v.iter()
                                                    .take(256)
                                                    .map(|b| format!("{b:02x}"))
                                                    .collect::<std::string::String>()
                                            )
                                        }),
                                        Xml(v) => v.as_ref().map(|v| v.to_string()),
                                        DateTime(_) | SmallDateTime(_) | DateTime2(_) => row
                                            .try_get::<chrono::NaiveDateTime, _>(index)
                                            .map_err(|_| failed())?
                                            .map(|v| v.to_string()),
                                        Date(_) => row
                                            .try_get::<chrono::NaiveDate, _>(index)
                                            .map_err(|_| failed())?
                                            .map(|v| v.to_string()),
                                        Time(_) => row
                                            .try_get::<chrono::NaiveTime, _>(index)
                                            .map_err(|_| failed())?
                                            .map(|v| v.to_string()),
                                        DateTimeOffset(_) => row
                                            .try_get::<chrono::DateTime<chrono::FixedOffset>, _>(
                                                index,
                                            )
                                            .map_err(|_| failed())?
                                            .map(|v| v.to_string()),
                                    })
                                })
                                .collect::<Result<Vec<_>, std::string::String>>()?;
                            if !push_result(&mut rows, cells, &mut bytes) {
                                truncated = true;
                                break;
                            }
                        }
                    }
                }
            }
        }
        Ok(
            json!({"columns":names,"rows":rows,"truncated":truncated,"cellCharacterLimit":CELL_CHARS,"stableOrder":false,"affectedRows":null}),
        )
    }
}

pub(in crate::database) async fn execute_sql(
    profile: &DatabaseProfile,
    password: &str,
    text: &str,
    confirmed: bool,
    before_commit: impl Fn() -> Result<(), String> + Send + Sync,
) -> Result<Value, String> {
    let (statement, write) = classify_sql(profile.engine, text)?;
    if write && !confirmed {
        return Err("增刪修需要使用者確認這份 SQL 後執行。".into());
    }
    let mut client = Client::connect_mode(profile, password, write).await?;
    if !write {
        return client.sql_rows(&statement).await;
    }
    let count = client.execute_statement(&statement).await?;
    if let Err(error) = before_commit() {
        let _ = client.finish_transaction(false).await;
        return Err(error);
    }
    client
        .finish_transaction(true)
        .await
        .map_err(|_| "提交結果無法確認，請先查詢資料，不要直接重送 SQL。")?;
    Ok(
        json!({"columns":[],"rows":[],"truncated":false,"cellCharacterLimit":CELL_CHARS,"stableOrder":false,"affectedRows":count}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_one_statement_and_detects_writes_in_ctes() {
        for sql in [
            "SELECT 1; DELETE FROM sample",
            "DROP TABLE sample",
            "BEGIN",
            "PRAGMA query_only=OFF",
            "SELECT * INTO copy FROM sample",
        ] {
            assert!(classify_sql(Engine::Sqlite, sql).is_err(), "{sql}");
        }
        assert!(
            !classify_sql(Engine::Postgres, "SELECT 'DELETE; INTO' AS text")
                .unwrap()
                .1
        );
        assert!(
            classify_sql(
                Engine::Postgres,
                "WITH gone AS (DELETE FROM sample RETURNING *) SELECT * FROM gone"
            )
            .unwrap()
            .1
        );
        for engine in [
            Engine::Postgres,
            Engine::Mysql,
            Engine::Mariadb,
            Engine::SqlServer,
            Engine::Sqlite,
        ] {
            assert!(
                classify_sql(engine, "UPDATE sample SET value='中文' WHERE id=1")
                    .unwrap()
                    .1
            );
        }
    }

    #[cfg(not(target_os = "ios"))]
    #[tokio::test]
    async fn sqlite_sql_crud_requires_confirmation_rolls_back_and_bounds_results() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("sql.sqlite");
        let setup = rusqlite::Connection::open(&path).unwrap();
        setup.execute_batch("CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO sample VALUES(1, '原始');").unwrap();
        drop(setup);
        let profile = DatabaseProfile {
            id: "fixture".into(),
            host_key: "local".into(),
            name: "SQL 測試".into(),
            engine: Engine::Sqlite,
            hostname: String::new(),
            port: 0,
            username: String::new(),
            database: String::new(),
            sqlite_path: path.to_string_lossy().into_owned(),
            tls_ca_pem: String::new(),
            allow_mcp_read: false,
        };
        assert!(
            execute_sql(&profile, "", "DELETE FROM sample", false, || Ok(()))
                .await
                .is_err()
        );
        let select = execute_sql(
            &profile,
            "",
            "SELECT id,value,NULL AS empty FROM sample",
            false,
            || Ok(()),
        )
        .await
        .unwrap();
        assert_eq!(select["rows"], json!([["1", "原始", null]]));
        assert_eq!(
            execute_sql(
                &profile,
                "",
                "INSERT INTO sample VALUES(2,'新增中文')",
                true,
                || Ok(())
            )
            .await
            .unwrap()["affectedRows"],
            1
        );
        assert_eq!(
            execute_sql(
                &profile,
                "",
                "UPDATE sample SET value='修改' WHERE id=2",
                true,
                || Ok(())
            )
            .await
            .unwrap()["affectedRows"],
            1
        );
        assert!(execute_sql(
            &profile,
            "",
            "UPDATE sample SET value='不得提交'",
            true,
            || Err("連線已變更".into())
        )
        .await
        .is_err());
        assert_eq!(
            execute_sql(
                &profile,
                "",
                "SELECT value FROM sample WHERE id=2",
                false,
                || Ok(())
            )
            .await
            .unwrap()["rows"],
            json!([["修改"]])
        );
        assert_eq!(
            execute_sql(&profile, "", "DELETE FROM sample WHERE id=2", true, || Ok(
                ()
            ))
            .await
            .unwrap()["affectedRows"],
            1
        );
        let many = execute_sql(&profile,"","WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<150) SELECT x FROM n",false,||Ok(())).await.unwrap();
        assert_eq!(many["rows"].as_array().unwrap().len(), 100);
        assert_eq!(many["truncated"], true);
        assert!(super::super::write_is_rejected(&profile, "").await);
    }
}
