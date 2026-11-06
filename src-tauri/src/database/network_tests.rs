use super::*;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    profile: DatabaseProfile,
    password: String,
    writer_password: Option<String>,
}

#[tokio::test]
#[ignore = "Run node scripts/test-databases.mjs for isolated TLS database containers"]
async fn isolated_network_databases_verify_sql_workbench_crud() {
    let path = std::env::var_os("LATTICETERM_TEST_DATABASES_JSON").expect("isolated fixture path");
    let fixture: Fixture = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let mut profile = fixture.profile;
    assert_eq!(profile.hostname, "localhost");
    assert!(!profile.tls_ca_pem.is_empty());
    profile.validate().unwrap();
    assert!(
        drivers::execute_sql(
            &profile,
            &fixture.password,
            "DELETE FROM sql_workbench_qa",
            true,
            || Ok(())
        )
        .await
        .is_err(),
        "read-only server account must reject writes even after confirmation"
    );
    profile.username = "writer".into();
    let password = fixture.writer_password.expect("isolated writer credential");
    let literal = if profile.engine == Engine::SqlServer {
        "N"
    } else {
        ""
    };
    assert!(drivers::execute_sql(
        &profile,
        &password,
        "DELETE FROM sql_workbench_qa",
        false,
        || Ok(())
    )
    .await
    .is_err());
    for statement in [
        format!("INSERT INTO sql_workbench_qa VALUES(2,{literal}'新增中文🙂')"),
        format!("UPDATE sql_workbench_qa SET value={literal}'修改中文🙂' WHERE id=2"),
    ] {
        let result = drivers::execute_sql(&profile, &password, &statement, true, || Ok(()))
            .await
            .unwrap();
        assert_eq!(result["affectedRows"], 1);
    }
    let rows = drivers::execute_sql(
        &profile,
        &password,
        "SELECT id,value,NULL AS optional_value FROM sql_workbench_qa WHERE id=2",
        false,
        || Ok(()),
    )
    .await
    .unwrap();
    assert_eq!(rows["rows"], json!([["2", "修改中文🙂", null]]));
    let empty = drivers::execute_sql(
        &profile,
        &password,
        "SELECT id,value FROM sql_workbench_qa WHERE id=-1",
        false,
        || Ok(()),
    )
    .await
    .unwrap();
    assert_eq!(empty["columns"], json!(["id", "value"]));
    assert_eq!(empty["rows"], json!([]));
    assert!(drivers::execute_sql(
        &profile,
        &password,
        "UPDATE sql_workbench_qa SET value='rollback' WHERE id=1",
        true,
        || Err("連線設定已變更".into())
    )
    .await
    .is_err());
    let original = drivers::execute_sql(
        &profile,
        &password,
        "SELECT value FROM sql_workbench_qa WHERE id=1",
        false,
        || Ok(()),
    )
    .await
    .unwrap();
    assert_eq!(original["rows"], json!([["原始"]]));
    let deleted = drivers::execute_sql(
        &profile,
        &password,
        "DELETE FROM sql_workbench_qa WHERE id=2",
        true,
        || Ok(()),
    )
    .await
    .unwrap();
    assert_eq!(deleted["affectedRows"], 1);
}

#[tokio::test]
#[ignore = "Run node scripts/test-databases.mjs for isolated TLS database containers"]
async fn isolated_network_databases_verify_tls_and_readonly_queries() {
    let path = std::env::var_os("LATTICETERM_TEST_DATABASES_JSON").expect("isolated fixture path");
    let fixture: Fixture = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let profile = fixture.profile;
    assert_eq!(profile.hostname, "localhost");
    assert!(!profile.tls_ca_pem.is_empty());
    profile.validate().unwrap();
    let version = DatabaseAction::Version {
        profile_id: profile.id.clone(),
    };
    let mut untrusted = profile.clone();
    untrusted.tls_ca_pem.clear();
    assert!(
        drivers::read(&untrusted, &fixture.password, &version)
            .await
            .is_err(),
        "untrusted CA must fail"
    );
    let mut mismatched = profile.clone();
    let mut malformed = profile.clone();
    malformed.tls_ca_pem = "-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----".into();
    assert!(
        drivers::read(&malformed, &fixture.password, &version)
            .await
            .is_err(),
        "invalid CA must not fall back to unverified TLS"
    );
    mismatched.hostname = "127.0.0.1".into();
    assert!(
        drivers::read(&mismatched, &fixture.password, &version)
            .await
            .is_err(),
        "hostname mismatch must fail"
    );
    let result = drivers::read(&profile, &fixture.password, &version)
        .await
        .unwrap();
    assert!(!result["rows"][0][0].as_str().unwrap().is_empty());
    let directory = tempfile::tempdir().unwrap();
    let registry = DatabaseRegistry::new(directory.path().into());
    let snapshot = registry.snapshot().unwrap();
    assert!(registry
        .test_draft(
            profile.clone(),
            &snapshot.revision,
            Some(Zeroizing::new("incorrect-password".into())),
        )
        .await
        .is_err());
    let probe = registry
        .test_draft(
            profile.clone(),
            &snapshot.revision,
            Some(Zeroizing::new(fixture.password.clone())),
        )
        .await
        .unwrap();
    assert!(!probe["rows"][0][0].as_str().unwrap().is_empty());
    assert!(!registry.path().exists());
    assert_eq!(registry.snapshot().unwrap().revision, snapshot.revision);
    assert!(registry.snapshot().unwrap().profiles.is_empty());
    let tables = drivers::read(
        &profile,
        &fixture.password,
        &DatabaseAction::Tables {
            profile_id: profile.id.clone(),
        },
    )
    .await
    .unwrap();
    let table = tables["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row[1] == "sample")
        .expect("seed table");
    let schema = table[0].as_str().unwrap().to_string();
    let columns = drivers::read(
        &profile,
        &fixture.password,
        &DatabaseAction::Columns {
            profile_id: profile.id.clone(),
            schema: schema.clone(),
            table: "sample".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(columns["rows"].as_array().unwrap().len(), 2);
    let rows = drivers::read(
        &profile,
        &fixture.password,
        &DatabaseAction::Rows {
            profile_id: profile.id.clone(),
            schema: schema.clone(),
            table: "sample".into(),
            limit: 100,
            offset: 0,
        },
    )
    .await
    .unwrap();
    let rows = rows["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 3);
    assert!(rows.iter().any(|row| row[1].is_null()));
    assert!(rows.iter().any(|row| row[1] == "繁體中文🙂"));
    assert!(rows.iter().any(|row| row[1]
        .as_str()
        .is_some_and(|value| value.chars().count() == 512)));
    let page = drivers::read(
        &profile,
        &fixture.password,
        &DatabaseAction::Rows {
            profile_id: profile.id.clone(),
            schema,
            table: "sample".into(),
            limit: 1,
            offset: 1,
        },
    )
    .await
    .unwrap();
    assert_eq!(page["rows"].as_array().unwrap().len(), 1);
    assert_eq!(page["truncated"], true);
    assert!(drivers::write_is_rejected(&profile, &fixture.password).await);
    assert!(drivers::read(&profile, "incorrect-password", &version)
        .await
        .is_err());
}
