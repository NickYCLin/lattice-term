use super::*;
#[cfg(not(target_os = "ios"))]
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
        tls_ca_pem: String::new(),
        route: None,
        allow_mcp_read: false,
    }
}

#[test]
fn database_routes_are_bound_to_credentials_and_sqlite_cannot_use_a_gateway() {
    let directory = tempfile::tempdir().unwrap();
    let mut first = profile(directory.path(), "routed");
    let original = first.credential_profile().id;
    assert!(serde_json::to_value(&first).unwrap().get("route").is_none());
    first.route = Some(DatabaseRoute::Ssh {
        profile_id: "gateway-one".into(),
    });
    assert!(first.validate().is_err());
    assert_ne!(original, first.credential_profile().id);
    let ssh = first.credential_profile().id;
    first.route = Some(DatabaseRoute::Remote {
        profile_id: "gateway-one".into(),
    });
    assert_ne!(ssh, first.credential_profile().id);
    first.route = Some(DatabaseRoute::Ssh {
        profile_id: "gateway-two".into(),
    });
    assert_ne!(ssh, first.credential_profile().id);
    first.route = None;
    assert_eq!(original, first.credential_profile().id);
}

#[tokio::test]
async fn draft_probe_does_not_save_settings_or_grant_mcp_access() {
    let directory = tempfile::tempdir().unwrap();
    let registry = DatabaseRegistry::new(directory.path().into());
    let draft = profile(directory.path(), "draft");
    let before = registry.snapshot().unwrap();
    let result = registry
        .test_draft(draft.clone(), &before.revision, None)
        .await
        .unwrap();
    assert!(!result["rows"].as_array().unwrap().is_empty());
    assert!(!registry.path().exists());
    assert_eq!(registry.snapshot().unwrap().revision, before.revision);
    assert!(registry.snapshot().unwrap().profiles.is_empty());
    assert!(registry.workbenches.lock().unwrap().is_empty());

    assert!(registry
        .test_draft(draft.clone(), "stale", None)
        .await
        .is_err());
    let _permit = registry.calls.clone().acquire_many_owned(4).await.unwrap();
    assert!(registry
        .test_draft(draft, &before.revision, None)
        .await
        .unwrap_err()
        .contains("忙碌"));
}

#[tokio::test]
async fn draft_probe_requires_a_password_for_a_new_network_endpoint() {
    let directory = tempfile::tempdir().unwrap();
    let registry = DatabaseRegistry::new(directory.path().into());
    let mut draft = profile(directory.path(), "draft");
    draft.engine = Engine::Postgres;
    draft.hostname = "db.invalid".into();
    draft.port = 5432;
    draft.username = "reader".into();
    draft.database = "orders".into();
    draft.sqlite_path.clear();
    let before = registry.snapshot().unwrap();
    let error = registry
        .test_draft(draft, &before.revision, None)
        .await
        .unwrap_err();
    assert!(error.contains("請輸入資料庫密碼"));
    assert!(!registry.path().exists());
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
fn reloads_generated_cleanup_keys_and_preserves_active_passwords() {
    let directory = tempfile::tempdir().unwrap();
    let registry = DatabaseRegistry::new(directory.path().into());
    let mut network = profile(directory.path(), "network");
    network.engine = Engine::Postgres;
    network.hostname = "database.invalid".into();
    network.port = 5432;
    network.username = "reader".into();
    network.database = "sample".into();
    network.sqlite_path.clear();
    let key = network.credential_profile().id;
    let raw = serde_json::to_vec(&Store {
        version: 1,
        profiles: vec![network.clone()],
        pending_credentials: vec![key.clone()],
    })
    .unwrap();
    std::fs::write(registry.path(), &raw).unwrap();
    let snapshot = registry.snapshot().unwrap();
    assert_eq!(snapshot.pending_credentials, vec![key]);
    assert_eq!(snapshot.credential_cleanup_pending, 1);
    assert_eq!(std::fs::read(registry.path()).unwrap(), raw);
    let snapshot = registry
        .edit(
            &snapshot.revision,
            Some(profile(directory.path(), "local")),
            None,
            None,
        )
        .unwrap();
    assert_eq!(snapshot.profiles.len(), 2);
    assert!(snapshot.profiles.contains(&network));
    assert_eq!(snapshot.credential_cleanup_pending, 0);
    assert!(registry.snapshot().unwrap().pending_credentials.is_empty());
}

#[test]
fn rejects_unscoped_cleanup_keys_without_modifying_the_store() {
    let directory = tempfile::tempdir().unwrap();
    let registry = DatabaseRegistry::new(directory.path().into());
    for key in [
        "database:fixture:0123456789abcdef".into(),
        "ssh-route".into(),
        "database-".into(),
        format!("database-{}", "a".repeat(63)),
        format!("database-{}", "a".repeat(65)),
        format!("database-{}", "g".repeat(64)),
        format!("database-{}", "A".repeat(64)),
    ] {
        let raw = serde_json::to_vec(&Store {
            version: 1,
            profiles: vec![],
            pending_credentials: vec![key],
        })
        .unwrap();
        std::fs::write(registry.path(), &raw).unwrap();
        assert!(registry
            .snapshot()
            .err()
            .unwrap()
            .contains("無效的資料庫憑證清理紀錄"));
        assert_eq!(std::fs::read(registry.path()).unwrap(), raw);
    }
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
    changed = original.clone();
    changed.tls_ca_pem = "different trust anchor".into();
    assert_ne!(identity, changed.credential_profile().id);
    assert!(!original.same_endpoint(&changed));
}

#[test]
fn database_credential_ids_satisfy_the_real_credential_store_contract() {
    let directory = tempfile::tempdir().unwrap();
    let mut entry = profile(directory.path(), "fixture");
    for id in [
        "fixture".to_string(),
        "資".repeat(26),
        "x".repeat(80),
        "fixture:custom/id".to_string(),
    ] {
        entry.id = id;
        let key = entry.credential_profile().id;
        assert!(crate::credentials::account(&key, CredentialKind::DatabasePassword).is_ok());
        assert_eq!(key.len(), 73);
        assert!(!key.contains("fixture"));
    }
    let first = entry.credential_profile().id;
    entry.id = "another-profile".into();
    assert_ne!(first, entry.credential_profile().id);
    assert!(crate::credentials::account(
        "database:fixture:0123456789abcdef",
        CredentialKind::DatabasePassword
    )
    .is_err());
}

#[test]
#[cfg(windows)]
#[ignore = "Writes and removes one disposable Windows credential; run explicitly"]
fn windows_database_password_save_roundtrip_uses_a_disposable_credential() {
    let directory = tempfile::tempdir().unwrap();
    crate::vault::initialize(directory.path().into());
    let registry = DatabaseRegistry::new(directory.path().into());
    let mut random_id = [0u8; 32];
    getrandom::fill(&mut random_id).unwrap();
    let random_id: String = random_id.iter().map(|byte| format!("{byte:02x}")).collect();
    let mut entry = profile(directory.path(), &random_id);
    entry.engine = Engine::SqlServer;
    entry.hostname = "db.invalid".into();
    entry.port = 1433;
    entry.username = "fixture-user".into();
    entry.database = "fixture-database".into();
    entry.sqlite_path.clear();
    let credential_profile = entry.credential_profile();
    let account =
        crate::credentials::account(&credential_profile.id, CredentialKind::DatabasePassword)
            .unwrap();
    let key = keyring::Entry::new("io.github.NickYCLin.LatticeTerm", &account).unwrap();
    struct Cleanup(keyring::Entry);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = self.0.delete_credential();
        }
    }
    let cleanup = Cleanup(key);
    let mut random_secret = Zeroizing::new([0u8; 32]);
    getrandom::fill(random_secret.as_mut()).unwrap();
    let secret = Zeroizing::new(
        random_secret
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>(),
    );
    let before = registry.snapshot().unwrap();
    let saved = registry
        .edit(
            &before.revision,
            Some(entry.clone()),
            None,
            Some(secret.clone()),
        )
        .unwrap();
    assert_eq!(saved.profiles, vec![entry.clone()]);
    let loaded = Zeroizing::new(
        credentials::load_bound_with_context(
            &credential_profile,
            CredentialKind::DatabasePassword,
            &entry.credential_context(),
        )
        .unwrap(),
    );
    assert!(loaded.as_str() == secret.as_str());
    let raw = std::fs::read_to_string(registry.path()).unwrap();
    assert!(!raw.contains(secret.as_str()));
    let reloaded = DatabaseRegistry::new(directory.path().into());
    let saved = reloaded.snapshot().unwrap();
    let deleted = reloaded
        .edit(&saved.revision, None, Some(&entry.id), None)
        .unwrap();
    assert!(deleted.profiles.is_empty());
    assert_eq!(deleted.credential_cleanup_pending, 0);
    assert!(reloaded.snapshot().unwrap().pending_credentials.is_empty());
    assert!(matches!(
        cleanup.0.get_password(),
        Err(keyring::Error::NoEntry)
    ));
}

#[test]
fn ca_input_rejects_private_keys_invalid_data_and_oversized_input() {
    assert!(validate_ca("").is_ok());
    for pem in [
        "not a certificate",
        "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
        "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----",
    ] {
        assert!(validate_ca(pem).is_err());
    }
    assert!(validate_ca(&"x".repeat(16385)).is_err());
    let directory = tempfile::tempdir().unwrap();
    let original = profile(directory.path(), "legacy");
    let raw = serde_json::to_value(&original).unwrap();
    assert!(raw.get("tlsCaPem").is_none());
    assert_eq!(
        serde_json::from_value::<DatabaseProfile>(raw).unwrap(),
        original
    );
}

#[tokio::test]
#[cfg(not(target_os = "ios"))]
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

#[test]
fn mcp_sql_execution_requires_a_revision_and_cannot_supply_its_own_write_grant() {
    assert!(serde_json::from_value::<DatabaseAction>(
        json!({"kind":"workbenchExecute","profileId":"p","workbenchId":"w","revision":3})
    )
    .is_ok());
    assert!(serde_json::from_value::<DatabaseAction>(
        json!({"kind":"workbenchExecute","profileId":"p","workbenchId":"w"})
    )
    .is_err());
    assert!(serde_json::from_value::<DatabaseAction>(json!({"kind":"workbenchExecute","profileId":"p","workbenchId":"w","revision":3,"confirmedWrite":true})).is_err());
    assert!(action_schema()["oneOf"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["properties"]["kind"]["const"] == "workbenchExecute"));
}
