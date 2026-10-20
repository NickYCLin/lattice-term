use super::*;
use serde::Deserialize;

#[derive(Deserialize)]
struct Fixture {
    profile: DatabaseProfile,
    password: String,
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
