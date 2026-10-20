use super::{DatabaseAction, DatabaseProfile, Engine, CELL_CHARS, MAX_COLUMNS};
use serde_json::{json, Value};
use sqlx::{ConnectOptions, Connection, Row};
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

type TextRows = Vec<Vec<Option<String>>>;

enum Client {
    Postgres(sqlx::PgConnection),
    Mysql(sqlx::MySqlConnection),
    Sqlite(sqlx::SqliteConnection),
    SqlServer(tiberius::Client<Compat<tokio::net::TcpStream>>),
}

fn failed() -> String {
    "資料庫操作失敗。請檢查服務、連接埠、帳密、資料庫名稱、唯讀權限與 TLS 憑證；伺服器原始錯誤不會回傳，以免洩漏敏感資料。".into()
}

fn mysql_text(value: Option<Vec<u8>>) -> Result<Option<String>, String> {
    value
        .map(String::from_utf8)
        .transpose()
        .map_err(|_| failed())
}

impl Client {
    async fn connect(profile: &DatabaseProfile, password: &str) -> Result<Self, String> {
        match profile.engine {
            Engine::Postgres => {
                let mut options = sqlx::postgres::PgConnectOptions::new()
                    .host(&profile.hostname)
                    .port(profile.port)
                    .username(&profile.username)
                    .password(password)
                    .database(&profile.database)
                    .ssl_mode(sqlx::postgres::PgSslMode::VerifyFull)
                    .disable_statement_logging();
                if !profile.tls_ca_pem.is_empty() {
                    options =
                        options.ssl_root_cert_from_pem(profile.tls_ca_pem.as_bytes().to_vec());
                }
                let mut connection = sqlx::PgConnection::connect_with(&options)
                    .await
                    .map_err(|_| failed())?;
                sqlx::query("BEGIN READ ONLY")
                    .execute(&mut connection)
                    .await
                    .map_err(|_| failed())?;
                sqlx::query("SET LOCAL statement_timeout = '15000ms'")
                    .execute(&mut connection)
                    .await
                    .map_err(|_| failed())?;
                Ok(Self::Postgres(connection))
            }
            Engine::Mysql | Engine::Mariadb => {
                let mut options = sqlx::mysql::MySqlConnectOptions::new()
                    .host(&profile.hostname)
                    .port(profile.port)
                    .username(&profile.username)
                    .password(password)
                    .database(&profile.database)
                    .ssl_mode(sqlx::mysql::MySqlSslMode::VerifyIdentity)
                    .disable_statement_logging();
                if !profile.tls_ca_pem.is_empty() {
                    options = options.ssl_ca_from_pem(profile.tls_ca_pem.as_bytes().to_vec());
                }
                let mut connection = sqlx::MySqlConnection::connect_with(&options)
                    .await
                    .map_err(|_| failed())?;
                sqlx::Executor::execute(&mut connection, "START TRANSACTION READ ONLY")
                    .await
                    .map_err(|_| failed())?;
                Ok(Self::Mysql(connection))
            }
            Engine::Sqlite => {
                let options = sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(&profile.sqlite_path)
                    .read_only(true)
                    .create_if_missing(false);
                let options = options.disable_statement_logging();
                let mut connection = sqlx::SqliteConnection::connect_with(&options)
                    .await
                    .map_err(|_| failed())?;
                sqlx::query("PRAGMA query_only = ON")
                    .execute(&mut connection)
                    .await
                    .map_err(|_| failed())?;
                sqlx::query("PRAGMA trusted_schema = OFF")
                    .execute(&mut connection)
                    .await
                    .map_err(|_| failed())?;
                Ok(Self::Sqlite(connection))
            }
            Engine::SqlServer => {
                let mut config = tiberius::Config::new();
                config.host(&profile.hostname);
                config.port(profile.port);
                config.database(&profile.database);
                config.authentication(tiberius::AuthMethod::sql_server(
                    &profile.username,
                    password,
                ));
                config.encryption(tiberius::EncryptionLevel::Required);
                let mut ca_file = None;
                if !profile.tls_ca_pem.is_empty() {
                    use std::io::Write;
                    let mut file = tempfile::Builder::new()
                        .prefix("latticeterm-ca-")
                        .suffix(".pem")
                        .tempfile()
                        .map_err(|_| failed())?;
                    file.write_all(profile.tls_ca_pem.as_bytes())
                        .map_err(|_| failed())?;
                    file.flush().map_err(|_| failed())?;
                    config.trust_cert_ca(file.path().to_string_lossy());
                    ca_file = Some(file);
                }
                let socket =
                    tokio::net::TcpStream::connect((profile.hostname.as_str(), profile.port))
                        .await
                        .map_err(|_| failed())?;
                socket.set_nodelay(true).map_err(|_| failed())?;
                let mut connection = tiberius::Client::connect(config, socket.compat_write())
                    .await
                    .map_err(|_| failed())?;
                drop(ca_file);
                connection
                    .simple_query("SET LOCK_TIMEOUT 15000; SET TEXTSIZE 4096")
                    .await
                    .map_err(|_| failed())?
                    .into_results()
                    .await
                    .map_err(|_| failed())?;
                Ok(Self::SqlServer(connection))
            }
        }
    }

    async fn query(&mut self, statement: &str, parameters: &[&str]) -> Result<TextRows, String> {
        macro_rules! fetch {
            ($connection:expr) => {{
                let mut query = sqlx::query(statement);
                for parameter in parameters {
                    query = query.bind(*parameter);
                }
                query
                    .fetch_all($connection)
                    .await
                    .map_err(|_| failed())?
                    .into_iter()
                    .map(|row| {
                        (0..row.len())
                            .map(|index| {
                                row.try_get::<Option<String>, _>(index)
                                    .map_err(|_| failed())
                            })
                            .collect()
                    })
                    .collect()
            }};
        }
        match self {
            Self::Postgres(connection) => fetch!(connection),
            Self::Mysql(connection) => {
                let mut query = sqlx::query(statement);
                for parameter in parameters {
                    query = query.bind(*parameter);
                }
                query
                    .fetch_all(connection)
                    .await
                    .map_err(|_| failed())?
                    .into_iter()
                    .map(|row| {
                        (0..row.len())
                            .map(|index| mysql_text(row.try_get(index).map_err(|_| failed())?))
                            .collect()
                    })
                    .collect()
            }
            Self::Sqlite(connection) => fetch!(connection),
            Self::SqlServer(connection) => {
                let parameters: Vec<&dyn tiberius::ToSql> = parameters
                    .iter()
                    .map(|parameter| parameter as &dyn tiberius::ToSql)
                    .collect();
                let rows = connection
                    .query(statement, &parameters)
                    .await
                    .map_err(|_| failed())?
                    .into_first_result()
                    .await
                    .map_err(|_| failed())?;
                rows.into_iter()
                    .map(|row| {
                        (0..row.len())
                            .map(|index| {
                                row.try_get::<&str, _>(index)
                                    .map(|value| value.map(str::to_owned))
                                    .map_err(|_| failed())
                            })
                            .collect()
                    })
                    .collect()
            }
        }
    }

    async fn columns(
        &mut self,
        engine: Engine,
        schema: &str,
        table: &str,
    ) -> Result<TextRows, String> {
        let statement = match engine {
            Engine::Postgres => "SELECT a.attname::text, pg_catalog.format_type(a.atttypid,a.atttypmod)::text FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class t ON t.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND t.relname=$2 AND t.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum LIMIT 65",
            Engine::Mysql | Engine::Mariadb => "SELECT c.COLUMN_NAME, c.DATA_TYPE FROM information_schema.COLUMNS c JOIN information_schema.TABLES t ON t.TABLE_SCHEMA=c.TABLE_SCHEMA AND t.TABLE_NAME=c.TABLE_NAME WHERE c.TABLE_SCHEMA=? AND c.TABLE_NAME=? AND t.TABLE_TYPE='BASE TABLE' ORDER BY c.ORDINAL_POSITION LIMIT 65",
            Engine::SqlServer => "SELECT TOP (65) c.name, ty.name FROM sys.columns c JOIN sys.tables t ON t.object_id=c.object_id JOIN sys.schemas s ON s.schema_id=t.schema_id JOIN sys.types ty ON ty.user_type_id=c.user_type_id WHERE s.name=@P1 AND t.name=@P2 AND t.is_ms_shipped=0 ORDER BY c.column_id",
            Engine::Sqlite => {
                if schema != "main" { return Err("SQLite 只開放目前檔案的 main 結構。".into()); }
                let exists = self.query("SELECT name FROM pragma_table_list WHERE schema='main' AND type='table' AND name=? AND name NOT LIKE 'sqlite_%' LIMIT 1", &[table]).await?;
                if exists.is_empty() { return Err("找不到可讀取的一般資料表；不開放檢視表與虛擬資料表。".into()); }
                return self.query("SELECT name, type FROM pragma_table_xinfo(?) WHERE hidden=0 ORDER BY cid LIMIT 65", &[table]).await;
            }
        };
        self.query(statement, &[schema, table]).await
    }
}

fn quoted(engine: Engine, identifier: &str) -> Result<String, String> {
    super::identifier(identifier, 256)?;
    Ok(match engine {
        Engine::Mysql | Engine::Mariadb => format!("`{}`", identifier.replace('`', "``")),
        Engine::SqlServer => format!("[{}]", identifier.replace(']', "]]")),
        _ => format!("\"{}\"", identifier.replace('"', "\"\"")),
    })
}

fn bounded(rows: TextRows, columns: Vec<String>, max_rows: usize) -> Value {
    let mut bytes = 0;
    let mut result = Vec::new();
    let mut truncated = rows.len() > max_rows;
    for row in rows.into_iter().take(max_rows) {
        let row: Vec<_> = row
            .into_iter()
            .map(|cell| cell.map(|value| value.chars().take(CELL_CHARS).collect::<String>()))
            .collect();
        bytes += serde_json::to_vec(&row).map_or(256 * 1024, |encoded| encoded.len());
        if bytes > 256 * 1024 {
            truncated = true;
            break;
        }
        result.push(row);
    }
    json!({"columns":columns,"rows":result,"truncated":truncated,"readOnly":true,"cellCharacterLimit":CELL_CHARS,"stableOrder":false})
}

pub(super) async fn read(
    profile: &DatabaseProfile,
    password: &str,
    action: &DatabaseAction,
) -> Result<Value, String> {
    let mut client = Client::connect(profile, password).await?;
    let engine = profile.engine;
    match action {
        DatabaseAction::List {} => Err("列出連線不需要開啟資料庫。".into()),
        DatabaseAction::Version { .. } => {
            let statement = match engine {
                Engine::Postgres => "SELECT version()::text",
                Engine::Mysql | Engine::Mariadb => "SELECT VERSION()",
                Engine::Sqlite => "SELECT sqlite_version()",
                Engine::SqlServer => {
                    "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128))"
                }
            };
            Ok(bounded(
                client.query(statement, &[]).await?,
                vec!["version".into()],
                1,
            ))
        }
        DatabaseAction::Tables { .. } => {
            let statement = match engine {
                Engine::Postgres => "SELECT n.nspname::text,t.relname::text FROM pg_catalog.pg_class t JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace WHERE t.relkind='r' AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' ORDER BY 1,2 LIMIT 201",
                Engine::Mysql | Engine::Mariadb => "SELECT TABLE_SCHEMA,TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME LIMIT 201",
                Engine::Sqlite => "SELECT schema,name FROM pragma_table_list WHERE schema='main' AND type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 201",
                Engine::SqlServer => "SELECT TOP (201) s.name,t.name FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id WHERE t.is_ms_shipped=0 ORDER BY s.name,t.name",
            };
            Ok(bounded(
                client.query(statement, &[]).await?,
                vec!["schema".into(), "table".into()],
                200,
            ))
        }
        DatabaseAction::Columns { schema, table, .. }
        | DatabaseAction::Rows { schema, table, .. } => {
            if matches!(engine, Engine::Mysql | Engine::Mariadb) && schema != &profile.database {
                return Err("只能讀取此連線設定的資料庫。".into());
            }
            let columns = client.columns(engine, schema, table).await?;
            if columns.is_empty() {
                return Err("找不到可讀取的一般資料表或沒有讀取權限。".into());
            }
            if matches!(action, DatabaseAction::Columns { .. }) {
                return Ok(bounded(
                    columns,
                    vec!["column".into(), "type".into()],
                    MAX_COLUMNS,
                ));
            }
            if columns.len() > MAX_COLUMNS {
                return Err("資料表超過 64 個欄位，第一版暫不開放整表瀏覽。".into());
            }
            let names = columns
                .iter()
                .map(|row| row[0].clone().ok_or_else(failed))
                .collect::<Result<Vec<_>, _>>()?;
            let selection = names
                .iter()
                .map(|name| {
                    let name = quoted(engine, name)?;
                    Ok(match engine {
                        Engine::SqlServer => format!("CAST({name} AS nvarchar({CELL_CHARS}))"),
                        Engine::Mysql | Engine::Mariadb => {
                            format!("LEFT(CAST({name} AS CHAR),{CELL_CHARS})")
                        }
                        _ => format!("SUBSTR(CAST({name} AS TEXT),1,{CELL_CHARS})"),
                    })
                })
                .collect::<Result<Vec<String>, String>>()?
                .join(",");
            let target = format!("{}.{}", quoted(engine, schema)?, quoted(engine, table)?);
            let DatabaseAction::Rows { limit, offset, .. } = action else {
                unreachable!()
            };
            let statement = match engine {
                Engine::SqlServer => format!("SELECT {selection} FROM {target} ORDER BY (SELECT NULL) OFFSET {offset} ROWS FETCH NEXT {} ROWS ONLY", limit + 1),
                _ => format!("SELECT {selection} FROM {target} LIMIT {} OFFSET {offset}", limit + 1),
            };
            Ok(bounded(
                client.query(&statement, &[]).await?,
                names,
                *limit as usize,
            ))
        }
    }
}

#[cfg(test)]
pub(super) async fn write_is_rejected(profile: &DatabaseProfile, password: &str) -> bool {
    Client::connect(profile, password)
        .await
        .unwrap()
        .query("INSERT INTO sample VALUES (99, 'unexpected')", &[])
        .await
        .is_err()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mysql_metadata_accepts_binary_collation_but_requires_valid_utf8() {
        assert_eq!(mysql_text(None).unwrap(), None);
        assert_eq!(mysql_text(Some(vec![])).unwrap(), Some(String::new()));
        assert_eq!(
            mysql_text(Some("繁體中文🙂".as_bytes().to_vec())).unwrap(),
            Some("繁體中文🙂".into())
        );
        assert!(mysql_text(Some(vec![0xff])).is_err());
    }

    #[tokio::test]
    async fn sqlite_driver_itself_rejects_writes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("readonly.sqlite");
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let mut writable = sqlx::SqliteConnection::connect_with(&options)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE sample (value TEXT)")
            .execute(&mut writable)
            .await
            .unwrap();
        writable.close().await.unwrap();
        let profile = DatabaseProfile {
            id: "readonly".into(),
            host_key: "local".into(),
            name: "唯讀測試".into(),
            engine: Engine::Sqlite,
            hostname: String::new(),
            port: 0,
            username: String::new(),
            database: String::new(),
            sqlite_path: path.to_string_lossy().into_owned(),
            tls_ca_pem: String::new(),
            allow_mcp_read: false,
        };
        let Client::Sqlite(mut connection) = Client::connect(&profile, "").await.unwrap() else {
            panic!("expected SQLite");
        };
        assert!(sqlx::query("INSERT INTO sample VALUES ('unexpected')")
            .execute(&mut connection)
            .await
            .is_err());
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sample")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn quotes_identifiers_instead_of_interpolating_sql() {
        assert_eq!(
            quoted(Engine::Postgres, "odd\"; DROP TABLE t;--").unwrap(),
            "\"odd\"\"; DROP TABLE t;--\""
        );
        assert_eq!(quoted(Engine::Mysql, "a`b").unwrap(), "`a``b`");
        assert_eq!(quoted(Engine::SqlServer, "a]b").unwrap(), "[a]]b]");
        assert!(quoted(Engine::Sqlite, "x\0y").is_err());
    }

    #[test]
    fn bounds_results_and_reports_truncation() {
        let value = bounded(
            vec![vec![Some("中".repeat(1000))]; 101],
            vec!["data".into()],
            100,
        );
        assert_eq!(value["rows"].as_array().unwrap().len(), 100);
        assert_eq!(
            value["rows"][0][0].as_str().unwrap().chars().count(),
            CELL_CHARS
        );
        assert_eq!(value["truncated"], true);
    }
}
