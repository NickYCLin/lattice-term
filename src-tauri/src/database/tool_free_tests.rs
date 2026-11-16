//! Executed by the Docker harness as a separate test process with no tool PATH.
use super::*;
use crate::hostkeys::HostKeyRecord;
use crate::tunnel::{TunnelCredential, TunnelRegistry};
use russh::keys::ssh_key::HashAlg;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    profile: DatabaseProfile,
    password: String,
    ssh: SshFixture,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SshFixture {
    port: u16,
    private_key: std::path::PathBuf,
    host_public_key: std::path::PathBuf,
    database_port: u16,
}

fn assert_no_external_tools() {
    let path = std::env::var_os("PATH").expect("explicit isolated PATH");
    let paths = std::env::split_paths(&path).collect::<Vec<_>>();
    assert_eq!(
        paths.len(),
        1,
        "PATH must contain only the missing fixture directory"
    );
    assert!(
        !paths[0].exists(),
        "fixture PATH must not resolve to an existing directory"
    );
    for tool in ["psql", "mysql", "mariadb", "sqlcmd", "bcp", "isql", "ssh"] {
        match std::process::Command::new(tool).spawn() {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            _ => panic!("external tool unexpectedly available in isolated process"),
        }
    }
}

async fn probe(profile: &DatabaseProfile, password: &str, server_name: &str) {
    let result = drivers::execute_sql_with_server_name(
        profile,
        password,
        "SELECT 1",
        false,
        || Ok(()),
        server_name,
    )
    .await
    .expect("built-in driver query");
    assert_eq!(result["rows"][0][0], "1");
    let tables = drivers::read_with_server_name(
        profile,
        password,
        &DatabaseAction::Tables {
            profile_id: profile.id.clone(),
        },
        server_name,
    )
    .await
    .expect("table discovery");
    let table = tables["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row[1] == "sample")
        .expect("seed table");
    let columns = drivers::read_with_server_name(
        profile,
        password,
        &DatabaseAction::Columns {
            profile_id: profile.id.clone(),
            schema: table[0].as_str().unwrap().into(),
            table: "sample".into(),
        },
        server_name,
    )
    .await
    .expect("column discovery");
    assert_eq!(columns["rows"].as_array().unwrap().len(), 2);
}

#[tokio::test]
#[ignore = "Run node scripts/test-databases.mjs (Docker; launches with an unavailable PATH)"]
async fn isolated_network_databases_without_external_tools_direct_and_ssh() {
    // Must run before any network or database operation, in this subprocess only.
    assert_no_external_tools();
    crate::install_rustls_crypto_provider();
    tokio::time::timeout(std::time::Duration::from_secs(60), async {
        let path = std::env::var_os("LATTICETERM_TEST_DATABASES_JSON").expect("isolated fixture");
        let fixture: Fixture =
            serde_json::from_slice(&std::fs::read(path).unwrap()).expect("fixture format");
        for verified in [false, true] {
            let mut direct = fixture.profile.clone();
            if !verified {
                direct.tls_ca_pem.clear();
            }
            probe(&direct, &fixture.password, &direct.hostname).await;
            let mut profile = direct;
            profile.hostname = "database".into();
            profile.port = fixture.ssh.database_port;
            profile.route = Some(DatabaseRoute::Ssh {
                profile_id: "isolated-gateway".into(),
            });
            let registry = Arc::new(TunnelRegistry::new());
            let start_registry = registry.clone();
            let public_key = russh::keys::load_public_key(&fixture.ssh.host_public_key)
                .expect("temporary public host key");
            let known = HostKeyRecord {
                host: "127.0.0.1".into(),
                port: fixture.ssh.port,
                algorithm: public_key.algorithm().to_string(),
                fingerprint: public_key.fingerprint(HashAlg::Sha256).to_string(),
                first_trusted_at: 1,
                last_seen_at: 1,
            };
            let key = russh::keys::load_secret_key(&fixture.ssh.private_key, None)
                .expect("temporary client key");
            let route =
                transport::open_ssh_route(&profile, registry, |mut request, listener| async move {
                    request.ssh_hostname = "127.0.0.1".into();
                    request.ssh_port = fixture.ssh.port;
                    request.ssh_username = "root".into();
                    let guard = start_registry.lock_tunnel_start().await;
                    let reservation = crate::tunnel::reserve_tunnel_start(
                        start_registry.clone(),
                        &request,
                        &guard,
                    )?;
                    drop(guard);
                    crate::tunnel::start_reserved_tunnel_with_credential(
                        reservation,
                        request,
                        TunnelCredential::PrivateKey(Arc::new(key)),
                        Some(known),
                        Some(listener),
                    )
                    .await
                    .map(|_| ())
                })
                .await
                .expect("DatabaseRoute::Ssh through real sshd");
            probe(&route.profile, &fixture.password, &route.server_name).await;
            let address = (route.profile.hostname.clone(), route.profile.port);
            drop(route);
            let mut released = false;
            for _ in 0..100 {
                if tokio::net::TcpStream::connect((address.0.as_str(), address.1))
                    .await
                    .is_err()
                {
                    released = true;
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            assert!(released, "database route must release its listener");
        }
    })
    .await
    .expect("bounded isolated direct/SSH acceptance");
}

fn route_profile() -> DatabaseProfile {
    serde_json::from_value(
        json!({ "id":"route-fixture", "hostKey":"local", "name":"route fixture",
        "engine":"postgres", "hostname":"database", "port":5432, "username":"reader",
        "database":"sample", "sqlitePath":"", "allowMcpRead":false }),
    )
    .unwrap()
}

#[tokio::test]
async fn ssh_route_rejects_other_routes_before_starting_a_tunnel() {
    let profile = route_profile();
    let result =
        transport::open_ssh_route(&profile, Arc::new(TunnelRegistry::new()), |_, _| async {
            panic!("direct routes must not start SSH");
        })
        .await;
    assert!(result.is_err());
}

#[tokio::test]
async fn ssh_route_start_failure_releases_the_prebound_listener() {
    let mut profile = route_profile();
    profile.route = Some(DatabaseRoute::Ssh {
        profile_id: "gateway".into(),
    });
    let port = Arc::new(Mutex::new(0u16));
    let captured = port.clone();
    let result = transport::open_ssh_route(
        &profile,
        Arc::new(TunnelRegistry::new()),
        |request, listener| async move {
            *captured.lock().unwrap() = request.local_port;
            assert_eq!(request.remote_host, "database");
            assert_eq!(request.remote_port, 5432);
            assert_eq!(
                listener.local_addr().unwrap().ip(),
                std::net::Ipv4Addr::LOCALHOST
            );
            Err("isolated credential rejection".into())
        },
    )
    .await;
    assert!(result.is_err());
    let port = *port.lock().unwrap();
    assert_ne!(port, 0);
    assert!(tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .is_err());
}
