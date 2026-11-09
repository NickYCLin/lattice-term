//! Synthetic SSH gateway: no persistent host keys or system accounts.
use super::*;
use crate::hostkeys::HostKeyRecord;
use crate::tunnel::{StartTunnelRequest, TunnelRegistry, TunnelType};
use russh::keys::ssh_key::{private::Ed25519Keypair, HashAlg, PrivateKey};
use russh::{server, Channel};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

struct Gateway {
    host: String,
    port: u16,
    workers: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>>,
}
impl server::Handler for Gateway {
    type Error = russh::Error;
    async fn auth_password(
        &mut self,
        user: &str,
        password: &str,
    ) -> Result<server::Auth, Self::Error> {
        Ok(
            if user == "database-fixture" && password == "isolated-fixture-only" {
                server::Auth::Accept
            } else {
                server::Auth::reject()
            },
        )
    }
    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<server::Msg>,
        host: &str,
        port: u32,
        _: &str,
        _: u32,
        reply: server::ChannelOpenHandle,
        _: &mut server::Session,
    ) -> Result<(), Self::Error> {
        if host == self.host && port == u32::from(self.port) {
            if let Ok(mut socket) = TcpStream::connect((self.host.as_str(), self.port)).await {
                reply.accept().await;
                let worker = tokio::spawn(async move {
                    let _ = tokio::io::copy_bidirectional(&mut channel.into_stream(), &mut socket)
                        .await;
                });
                self.workers.lock().unwrap().push(worker);
            }
        }
        Ok(())
    }
}
struct SshFixture {
    port: u16,
    known: HostKeyRecord,
    task: tokio::task::JoinHandle<()>,
    workers: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>>,
}
impl Drop for SshFixture {
    fn drop(&mut self) {
        self.task.abort();
        for worker in self.workers.lock().unwrap().drain(..) {
            worker.abort();
        }
    }
}
impl SshFixture {
    async fn start(host: String, port: u16) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let gateway_port = listener.local_addr().unwrap().port();
        let mut seed = [0; 32];
        getrandom::fill(&mut seed).unwrap();
        let key = PrivateKey::from(Ed25519Keypair::from_seed(&seed));
        let known = HostKeyRecord {
            host: "127.0.0.1".into(),
            port: gateway_port,
            algorithm: key.algorithm().to_string(),
            fingerprint: key.public_key().fingerprint(HashAlg::Sha256).to_string(),
            first_trusted_at: 1,
            last_seen_at: 1,
        };
        let config = Arc::new(server::Config {
            keys: vec![key],
            auth_rejection_time: std::time::Duration::from_millis(1),
            ..Default::default()
        });
        let workers: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>> = Arc::default();
        let tasks = workers.clone();
        let task = tokio::spawn(async move {
            let mut sessions = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((socket, _)) = accepted else { break; };
                        let handler = Gateway { host: host.clone(), port, workers: tasks.clone() };
                        let config = config.clone();
                        sessions.spawn(async move { if let Ok(session) = server::run_stream(config, socket, handler).await { let _ = session.await; } });
                    }
                    _ = sessions.join_next(), if !sessions.is_empty() => {}
                }
            }
        });
        Self {
            port: gateway_port,
            known,
            task,
            workers,
        }
    }
    async fn tunnel(&self, host: String, port: u16) -> (Arc<TunnelRegistry>, u16) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let local_port = listener.local_addr().unwrap().port();
        let registry = Arc::new(TunnelRegistry::new());
        let request = StartTunnelRequest {
            tunnel_id: "database-fixture".into(),
            tunnel_type: TunnelType::Local,
            profile_id: "isolated-gateway".into(),
            local_host: "127.0.0.1".into(),
            local_port,
            remote_host: host,
            remote_port: port,
            ssh_hostname: "127.0.0.1".into(),
            ssh_port: self.port,
            ssh_username: "database-fixture".into(),
        };
        let barrier = registry.lock_tunnel_start().await;
        let reservation =
            crate::tunnel::reserve_tunnel_start(registry.clone(), &request, &barrier).unwrap();
        drop(barrier);
        crate::tunnel::start_reserved_tunnel_prebound(
            reservation,
            request,
            "isolated-fixture-only",
            Some(self.known.clone()),
            Some(listener),
        )
        .await
        .unwrap();
        (registry, local_port)
    }
}

#[tokio::test]
async fn ssh_database_channel_roundtrips_and_releases_loopback_listener() {
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = target.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut socket, _) = target.accept().await.unwrap();
            let mut query = [0; 8];
            socket.read_exact(&mut query).await.unwrap();
            assert_eq!(&query, b"SELECT 1");
            socket.write_all(b"1").await.unwrap();
        });
        let gateway = SshFixture::start("127.0.0.1".into(), port).await;
        let (registry, local_port) = gateway.tunnel("127.0.0.1".into(), port).await;
        let mut socket = TcpStream::connect(("127.0.0.1", local_port)).await.unwrap();
        socket.write_all(b"SELECT 1").await.unwrap();
        let mut reply = [0; 1];
        socket.read_exact(&mut reply).await.unwrap();
        assert_eq!(&reply, b"1");
        drop(socket);
        server.await.unwrap();
        registry.stop("database-fixture").await.unwrap();
        assert!(TcpStream::connect(("127.0.0.1", local_port)).await.is_err());
    })
    .await
    .unwrap();
}

#[tokio::test]
#[ignore = "Requires authorized LATTICETERM_TEST_DIRECT_DATABASE_JSON"]
async fn ssh_database_channel_reads_real_sql_server() {
    let raw =
        std::env::var("LATTICETERM_TEST_DIRECT_DATABASE_JSON").expect("explicit fixture required");
    let fixture: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let mut profile: DatabaseProfile = serde_json::from_value(fixture["profile"].clone()).unwrap();
    let gateway = SshFixture::start(profile.hostname.clone(), profile.port).await;
    let (registry, port) = gateway.tunnel(profile.hostname.clone(), profile.port).await;
    profile.hostname = "127.0.0.1".into();
    profile.port = port;
    let result = drivers::execute_sql(
        &profile,
        fixture["password"].as_str().unwrap(),
        "SELECT 1",
        false,
        || Ok(()),
    )
    .await;
    registry.stop("database-fixture").await.unwrap();
    assert_eq!(
        result.expect("SQL through SSH must succeed")["rows"][0][0],
        "1"
    );
}

struct RemoteWorkers(Vec<tokio::task::JoinHandle<()>>);
impl Drop for RemoteWorkers {
    fn drop(&mut self) {
        for task in &self.0 {
            task.abort();
        }
    }
}

#[tokio::test]
#[ignore = "Requires authorized database fixture and LATTICETERM_TEST_REMOTE_AGENT executable"]
async fn remote_database_channel_reads_real_sql_server() {
    use lattice_remote::{RemoteMessage, SecureConnection};
    use tokio::io::{AsyncBufReadExt, BufReader};
    let raw =
        std::env::var("LATTICETERM_TEST_DIRECT_DATABASE_JSON").expect("explicit fixture required");
    let fixture: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let mut profile: DatabaseProfile = serde_json::from_value(fixture["profile"].clone()).unwrap();
    let executable =
        std::env::var_os("LATTICETERM_TEST_REMOTE_AGENT").expect("explicit built agent required");
    let code = lattice_remote::generate_pairing_code().unwrap();
    let mut child = tokio::process::Command::new(executable)
        .args([
            "--bind",
            "127.0.0.1:0",
            "--terminal",
            "--allow-database-forwarding",
            "--pair-code-stdin",
            "--json",
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .expect("agent must start");
    let mut input = child.stdin.take().unwrap();
    input
        .write_all(format!("{code}\n").as_bytes())
        .await
        .unwrap();
    drop(input);
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let address = tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            let line = lines
                .next_line()
                .await
                .unwrap()
                .expect("agent must announce readiness");
            if let Ok(event) = serde_json::from_str::<serde_json::Value>(&line) {
                if event["kind"] == "ready" {
                    break event["address"]
                        .as_str()
                        .unwrap()
                        .parse::<std::net::SocketAddr>()
                        .unwrap();
                }
            }
        }
    })
    .await
    .expect("bounded agent startup");
    let mut connection = SecureConnection::connect("127.0.0.1", address.port(), &code)
        .await
        .unwrap();
    let hello = connection.receive().await.unwrap();
    assert!(matches!(hello, RemoteMessage::Hello(hello) if hello.database_forwarding));
    let (mut read, mut write) = connection.split();
    let (outgoing, mut messages) = tokio::sync::mpsc::channel(16);
    let connector = lattice_remote::client_tcp::TcpConnector::new(outgoing);
    let receiver_connector = connector.clone();
    let receiver = tokio::spawn(async move {
        while let Ok(message) = read.receive().await {
            if let RemoteMessage::Tcp(message) = message {
                if !receiver_connector.receive(message) {
                    break;
                }
            }
        }
        receiver_connector.close();
    });
    let writer = tokio::spawn(async move {
        while let Some(message) = messages.recv().await {
            if write.send(&message).await.is_err() {
                break;
            }
        }
    });
    let log = tokio::spawn(async move { while matches!(lines.next_line().await, Ok(Some(_))) {} });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let host = profile.hostname.clone();
    let remote_port = profile.port;
    let forward = tokio::spawn(async move {
        let (mut local, _) = listener.accept().await.unwrap();
        let mut remote = connector
            .connect(host, remote_port)
            .await
            .expect("agent must open database channel");
        let _ = tokio::io::copy_bidirectional(&mut local, &mut remote).await;
    });
    let _workers = RemoteWorkers(vec![receiver, writer, log, forward]);
    profile.hostname = "127.0.0.1".into();
    profile.port = port;
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(25),
        drivers::execute_sql(
            &profile,
            fixture["password"].as_str().unwrap(),
            "SELECT 1",
            false,
            || Ok(()),
        ),
    )
    .await;
    let _ = child.kill().await;
    let _ = child.wait().await;
    assert_eq!(
        result
            .expect("bounded database query")
            .expect("SQL through Remote must succeed")["rows"][0][0],
        "1"
    );
}
