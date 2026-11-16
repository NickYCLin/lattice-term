//! TLS policy is shared by tests and every connection path. A supplied CA
//! always verifies the server, even when a legacy profile defaults to bypass.
use super::DatabaseProfile;
use sqlx::ConnectOptions;

pub(super) fn verifies(profile: &DatabaseProfile) -> bool {
    !profile.tls_ca_pem.is_empty() || !profile.tls_trust_server_certificate
}

pub(super) fn postgres(
    profile: &DatabaseProfile,
    password: &str,
    server_name: &str,
) -> sqlx::postgres::PgConnectOptions {
    use sqlx::postgres::PgSslMode;
    let mode = if !verifies(profile) {
        PgSslMode::Prefer
    } else if server_name != profile.hostname {
        PgSslMode::VerifyCa
    } else {
        PgSslMode::VerifyFull
    };
    let mut options = sqlx::postgres::PgConnectOptions::new()
        .host(&profile.hostname)
        .port(profile.port)
        .username(&profile.username)
        .password(password)
        .database(&profile.database)
        .ssl_mode(mode)
        .disable_statement_logging();
    if !profile.tls_ca_pem.is_empty() {
        options = options.ssl_root_cert_from_pem(profile.tls_ca_pem.as_bytes().to_vec());
    }
    options
}

pub(super) fn mysql(
    profile: &DatabaseProfile,
    password: &str,
    server_name: &str,
) -> sqlx::mysql::MySqlConnectOptions {
    use sqlx::mysql::MySqlSslMode;
    let mode = if !verifies(profile) {
        MySqlSslMode::Preferred
    } else if server_name != profile.hostname {
        MySqlSslMode::VerifyCa
    } else {
        MySqlSslMode::VerifyIdentity
    };
    let mut options = sqlx::mysql::MySqlConnectOptions::new()
        .host(&profile.hostname)
        .port(profile.port)
        .username(&profile.username)
        .password(password)
        .database(&profile.database)
        .ssl_mode(mode)
        .disable_statement_logging();
    if !profile.tls_ca_pem.is_empty() {
        options = options.ssl_ca_from_pem(profile.tls_ca_pem.as_bytes().to_vec());
    }
    options
}

pub(super) fn sql_server(
    profile: &DatabaseProfile,
    password: &str,
    server_name: &str,
) -> tiberius::Config {
    let mut config = tiberius::Config::new();
    config.host(&profile.hostname);
    config.port(profile.port);
    config.database(&profile.database);
    config.authentication(tiberius::AuthMethod::sql_server(
        &profile.username,
        password,
    ));
    config.hostname_in_certificate(server_name);
    if verifies(profile) {
        config.encryption(tiberius::EncryptionLevel::Required);
        if !profile.tls_ca_pem.is_empty() {
            // Both rustls and Windows native-tls add these roots in memory.
            config.trust_cert_ca_bundle(profile.tls_ca_pem.as_bytes().to_vec());
        }
    } else {
        config.encryption(tiberius::EncryptionLevel::On);
        config.trust_cert();
    }
    config
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn profile() -> DatabaseProfile {
        serde_json::from_value(
            json!({ "id":"tls-test", "hostKey":"local", "name":"TLS test",
            "engine":"postgres", "hostname":"localhost", "port":5432, "username":"fixture",
            "database":"sample", "sqlitePath":"", "allowMcpRead":false }),
        )
        .unwrap()
    }

    #[test]
    fn legacy_profiles_keep_opportunistic_tls_and_their_credential_binding() {
        let profile = profile();
        assert!(profile.tls_trust_server_certificate);
        assert!(serde_json::to_value(&profile)
            .unwrap()
            .get("tlsTrustServerCertificate")
            .is_none());
        assert!(matches!(
            postgres(&profile, "", "localhost").get_ssl_mode(),
            sqlx::postgres::PgSslMode::Prefer
        ));
        assert!(matches!(
            mysql(&profile, "", "localhost").get_ssl_mode(),
            sqlx::mysql::MySqlSslMode::Preferred
        ));
        let mut verified = profile.clone();
        verified.tls_trust_server_certificate = false;
        assert!(!profile.same_endpoint(&verified));
        assert_ne!(
            profile.credential_profile().id,
            verified.credential_profile().id
        );
        assert_eq!(
            serde_json::to_value(&verified).unwrap()["tlsTrustServerCertificate"],
            false
        );
    }

    #[test]
    fn supplied_ca_always_verifies_and_never_calls_trust_cert() {
        let mut profile = profile();
        // The option builders carry public CA bytes; validation happens before
        // connecting. Isolated tests below exercise real CA parsing/handshakes.
        profile.tls_ca_pem = "PUBLIC_CA_TEST_SENTINEL".into();
        for trust in [true, false] {
            profile.tls_trust_server_certificate = trust;
            assert!(verifies(&profile));
            assert!(matches!(
                postgres(&profile, "", "localhost").get_ssl_mode(),
                sqlx::postgres::PgSslMode::VerifyFull
            ));
            assert!(matches!(
                mysql(&profile, "", "localhost").get_ssl_mode(),
                sqlx::mysql::MySqlSslMode::VerifyIdentity
            ));
            let mut config = sql_server(&profile, "", "localhost");
            // Tiberius rejects adding CA bytes if trust_cert() was called.
            // This public-API invariant catches an accidental bypass on either
            // rustls or the Windows native-tls backend without peeking at Debug.
            config.trust_cert_ca_bundle(Vec::new());
        }
    }

    #[test]
    fn explicit_verification_without_ca_uses_driver_roots_and_requires_tls() {
        let mut profile = profile();
        profile.tls_trust_server_certificate = false;
        assert!(verifies(&profile));
        assert!(matches!(
            postgres(&profile, "", "localhost").get_ssl_mode(),
            sqlx::postgres::PgSslMode::VerifyFull
        ));
        assert!(matches!(
            mysql(&profile, "", "localhost").get_ssl_mode(),
            sqlx::mysql::MySqlSslMode::VerifyIdentity
        ));
        sql_server(&profile, "", "localhost").trust_cert_ca_bundle(Vec::new());
    }

    #[test]
    fn forwarded_sqlx_connections_verify_the_ca_instead_of_the_loopback_name() {
        let mut profile = profile();
        profile.hostname = "127.0.0.1".into();
        profile.tls_ca_pem = "PUBLIC_CA_TEST_SENTINEL".into();
        assert!(matches!(
            postgres(&profile, "", "original.example").get_ssl_mode(),
            sqlx::postgres::PgSslMode::VerifyCa
        ));
        assert!(matches!(
            mysql(&profile, "", "original.example").get_ssl_mode(),
            sqlx::mysql::MySqlSslMode::VerifyCa
        ));
    }
}
