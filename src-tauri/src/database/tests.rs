use super::*;
use sqlx::Connection;

fn profile(directory: &Path, id: &str) -> DatabaseProfile {
    let path = directory.join(format!("{id}.sqlite"));
    std::fs::write(&path, []).unwrap();
    DatabaseProfile {
        id: id.into(),
        host_key: "machine".into(),
        name: format!("測試 {id}"),
        engine: Engine::Sqlite,
        hostname: String::new(),
        port: 0,
        username: String::new(),
        database: String::new(),
        sqlite_path: path.to_string_lossy().into_owned(),
        allow_mcp_read: false,
    }
}

#[test]
fn persists_multiple_databases_without_overwriting_and_deletes_only_one() {
    let directory = tempfile::tempdir().unwrap();
    let registry = DatabaseRegistry::new(directory.path().into());
    let initial = registry.snapshot().unwrap();
    let first = profile(directory.path(), "first");
    let second = profile(directory.path(), "second");
    let snapshot = registry
        .edit(&initial.revision, Some(first.clone()), None, None)
        .unwrap();
    let snapshot = registry
        .edit(&snapshot.revision, Some(second), None, None)
        .unwrap();
    assert_eq!(snapshot.profiles.len(), 2);
    let snapshot = registry
        .edit(&snapshot.revision, None, Some("first"), None)
        .unwrap();
    assert_eq!(snapshot.profiles.len(), 1);
    assert_eq!(snapshot.profiles[0].id, "second");
    assert!(Path::new(&first.sqlite_path).exists());
    let raw = std::fs::read_to_string(registry.path()).unwrap();
    assert!(!raw.contains("password"));
    assert!(!raw.contains("secret"));
}

#[test]
fn rejects_external_changes_and_preserves_corrupt_files() {
    let directory = tempfile::tempdir().unwrap();
    let registry = DatabaseRegistry::new(directory.path().into());
    let initial = registry.snapshot().unwrap();
    let entry = profile(directory.path(), "first");
    registry
        .edit(&initial.revision, Some(entry.clone()), None, None)
        .unwrap();
    let before = std::fs::read(registry.path()).unwrap();
    assert!(registry
        .edit(&initial.revision, Some(entry.clone()), None, None)
        .is_err());
    assert_eq!(std::fs::read(registry.path()).unwrap(), before);
    for raw in [
        b"bad json".as_slice(),
        b"",
        b"{\"version\":999,\"profiles\":[]}",
    ] {
        std::fs::write(registry.path(), raw).unwrap();
        assert!(registry.snapshot().is_err());
        assert_eq!(std::fs::read(registry.path()).unwrap(), raw);
    }
}

#[test]
fn rejects_concurrent_process_writes() {
    let directory = tempfile::tempdir().unwrap();
    let registry = DatabaseRegistry::new(directory.path().into());
    let initial = registry.snapshot().unwrap();
    let lock = std::fs::File::create(directory.path().join("database_profiles.lock")).unwrap();
    lock.try_lock().unwrap();
    assert!(registry
        .edit(
            &initial.revision,
            Some(profile(directory.path(), "first")),
            None,
            None
        )
        .is_err());
    assert!(!registry.path().exists());
}

#[test]
fn validates_paths_limits_and_rejects_unknown_fields() {
    let directory = tempfile::tempdir().unwrap();
    let mut entry = profile(directory.path(), "first");
    assert!(entry.validate().is_ok());
    for path in [
        "relative.sqlite",
        "../private.sqlite",
        "\\\\server\\database.sqlite",
        "//server/database.sqlite",
    ] {
        entry.sqlite_path = path.into();
        assert!(entry.validate().is_err());
    }
    assert!(DatabaseAction::Rows {
        profile_id: "p".into(),
        schema: "main".into(),
        table: "t".into(),
        limit: 101,
        offset: 0
    }
    .validate()
    .is_err());
    assert!(DatabaseAction::Rows {
        profile_id: "p".into(),
        schema: "main".into(),
        table: "t".into(),
        limit: 50,
        offset: 100001
    }
    .validate()
    .is_err());
    assert!(serde_json::from_value::<DatabaseAction>(json!({"kind":"rows","profileId":"p","schema":"main","table":"t","limit":50,"offset":0,"sql":"DELETE FROM t"})).is_err());
    assert!(serde_json::from_value::<DatabaseAction>(
        json!({"kind":"list","hostname":"private.example"})
    )
    .is_err());
}

#[test]
fn credentials_are_bound_to_engine_endpoint_account_and_database() {
    let directory = tempfile::tempdir().unwrap();
    let original = profile(directory.path(), "first");
    let identity = original.credential_profile().id;
    let mut changed = original.clone();
    changed.name = "重新命名".into();
    changed.allow_mcp_read = true;
    assert_eq!(identity, changed.credential_profile().id);
    changed.hostname = "elsewhere.invalid".into();
    assert_ne!(identity, changed.credential_profile().id);
    changed = original.clone();
    changed.engine = Engine::Postgres;
    assert_ne!(identity, changed.credential_profile().id);
    changed = original.clone();
    changed.database = "other".into();
    assert_ne!(identity, changed.credential_profile().id);
    changed = original.clone();
    changed.username = "other".into();
    assert_ne!(identity, changed.credential_profile().id);
    changed = original.clone();
    changed.port = 9999;
    assert_ne!(identity, changed.credential_profile().id);
    assert!(identity.len() <= 128);
}

#[tokio::test]
async fn sqlite_reads_real_tables_with_explicit_mcp_grants_and_no_write_access() {
    let directory = tempfile::tempdir().unwrap();
    let registry = DatabaseRegistry::new(directory.path().into());
    let mut entry = profile(directory.path(), "fixture");
    let options = sqlx::sqlite::SqliteConnectOptions::new().filename(&entry.sqlite_path);
    let mut connection = sqlx::SqliteConnection::connect_with(&options)
        .await
        .unwrap();
    sqlx::query("CREATE TABLE sample (id INTEGER, value TEXT)")
        .execute(&mut connection)
        .await
        .unwrap();
    sqlx::query("INSERT INTO sample VALUES (1, NULL), (2, ?)")
        .bind("中".repeat(700))
        .execute(&mut connection)
        .await
        .unwrap();
    sqlx::query("CREATE VIEW hidden_view AS SELECT * FROM sample")
        .execute(&mut connection)
        .await
        .unwrap();
    sqlx::query("CREATE TABLE \"odd\"\"; DROP TABLE sample;--\" (\"a]`\" TEXT)")
        .execute(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();
    let initial = registry.snapshot().unwrap();
    let snapshot = registry
        .edit(&initial.revision, Some(entry.clone()), None, None)
        .unwrap();
    let hidden = registry
        .execute(DatabaseAction::List {}, true)
        .await
        .unwrap();
    assert_eq!(hidden["profiles"], json!([]));
    assert!(registry
        .execute(
            DatabaseAction::Version {
                profile_id: entry.id.clone()
            },
            true
        )
        .await
        .is_err());
    entry.allow_mcp_read = true;
    registry
        .edit(&snapshot.revision, Some(entry.clone()), None, None)
        .unwrap();
    let listed = registry
        .execute(DatabaseAction::List {}, true)
        .await
        .unwrap();
    assert_eq!(listed["profiles"][0]["id"], entry.id);
    assert!(!listed.to_string().contains("sqlitePath"));
    assert!(!listed.to_string().contains(&entry.sqlite_path));
    let tables = registry
        .execute(
            DatabaseAction::Tables {
                profile_id: entry.id.clone(),
            },
            true,
        )
        .await
        .unwrap();
    assert!(!tables.to_string().contains("hidden_view"));
    let columns = registry
        .execute(
            DatabaseAction::Columns {
                profile_id: entry.id.clone(),
                schema: "main".into(),
                table: "sample".into(),
            },
            true,
        )
        .await
        .unwrap();
    assert_eq!(columns["rows"][0], json!(["id", "INTEGER"]));
    let first = registry
        .execute(
            DatabaseAction::Rows {
                profile_id: entry.id.clone(),
                schema: "main".into(),
                table: "sample".into(),
                limit: 1,
                offset: 0,
            },
            true,
        )
        .await
        .unwrap();
    assert_eq!(first["rows"][0], json!(["1", null]));
    assert_eq!(first["truncated"], true);
    let second = registry
        .execute(
            DatabaseAction::Rows {
                profile_id: entry.id.clone(),
                schema: "main".into(),
                table: "sample".into(),
                limit: 1,
                offset: 1,
            },
            true,
        )
        .await
        .unwrap();
    assert_eq!(
        second["rows"][0][1].as_str().unwrap().chars().count(),
        CELL_CHARS
    );
    assert!(registry
        .execute(
            DatabaseAction::Columns {
                profile_id: entry.id.clone(),
                schema: "main".into(),
                table: "hidden_view".into()
            },
            true
        )
        .await
        .is_err());
    let odd = registry
        .execute(
            DatabaseAction::Rows {
                profile_id: entry.id.clone(),
                schema: "main".into(),
                table: "odd\"; DROP TABLE sample;--".into(),
                limit: 1,
                offset: 0,
            },
            true,
        )
        .await
        .unwrap();
    assert_eq!(odd["columns"], json!(["a]`"]));
    let read_options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&entry.sqlite_path)
        .read_only(true);
    let mut readonly = sqlx::SqliteConnection::connect_with(&read_options)
        .await
        .unwrap();
    assert!(sqlx::query("DELETE FROM sample")
        .execute(&mut readonly)
        .await
        .is_err());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM sample")
        .fetch_one(&mut readonly)
        .await
        .unwrap();
    assert_eq!(count, 2);
}
