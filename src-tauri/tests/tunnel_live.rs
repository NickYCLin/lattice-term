//! Live tunnel tests against a throwaway SSH server.
//!
//! `#[ignore]`d so ordinary `cargo test` and CI stay green. Run deliberately:
//!
//! ```text
//! docker run -d --name latticeterm-sshtest -p 2222:2222 -p 3333:3333 \
//!   -e PASSWORD_ACCESS=true -e USER_NAME=tester -e USER_PASSWORD=testpass123 \
//!   linuxserver/openssh-server
//! docker exec latticeterm-sshtest sed -i \
//!   -e 's/AllowTcpForwarding no/AllowTcpForwarding yes/' \
//!   -e 's/GatewayPorts no/GatewayPorts clientspecified/' /config/sshd/sshd_config
//! docker restart latticeterm-sshtest
//! cargo test --test tunnel_live -- --ignored --test-threads=1
//! ```
//!
//! These exist because the unit tests can prove SOCKS5 parsing and registry
//! bookkeeping, but only a real server can prove that bytes entering the local
//! listener come out of the remote side — the exact thing the first version of
//! this feature silently failed to do.

use latticeterm_lib::hostkeys::HostTrustStore;
use latticeterm_lib::ssh::{connect, ConnectOutcome, ConnectRequest, SessionSink, SshRegistry};
use latticeterm_lib::tunnel::{
    start_tunnel, StartTunnelRequest, TunnelRegistry, TunnelStatus, TunnelType,
};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const HOST: &str = "127.0.0.1";
const PORT: u16 = 2222;
const REMOTE_FORWARD_PORT: u16 = 3333;
const USER: &str = "tester";
const PASSWORD: &str = "testpass123";

struct DiscardSink;

impl SessionSink for DiscardSink {
    fn data(&self, _session_id: &str, _bytes: &[u8]) {}
    fn closed(&self, _session_id: &str, _reason: &str) {}
}

fn temp_dir(label: &str) -> std::path::PathBuf {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("latticeterm-tunnel-live-{label}-{unique}"));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Learns and trusts the container's host key the same way the app does:
/// one refused connection that reports the fingerprint, then an explicit
/// trust decision.
async fn trusted_record(label: &str) -> latticeterm_lib::hostkeys::HostKeyRecord {
    let mut store = HostTrustStore::open(&temp_dir(label)).unwrap();

    let request = ConnectRequest {
        jump: None,
        profile_id: "tunnel-live".into(),
        use_saved_password: false,
        remember_password: false,
        hostname: HOST.into(),
        port: PORT,
        username: USER.into(),
        auth: latticeterm_lib::ssh::AuthMethod::Password {
            password: PASSWORD.into(),
        },
        cols: 80,
        rows: 24,
    };

    let outcome = connect(
        Arc::new(DiscardSink),
        Arc::new(SshRegistry::new()),
        None,
        request,
    )
    .await;

    let ConnectOutcome::HostUnknown {
        host,
        port,
        algorithm,
        fingerprint,
    } = outcome
    else {
        panic!("expected the untrusted host to be refused, got {outcome:?}");
    };

    store
        .trust(&host, port, &algorithm, &fingerprint, 1)
        .unwrap()
}

fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

/// Reads until the SSH banner arrives or the timeout hits.
async fn read_banner(stream: &mut TcpStream) -> String {
    let mut collected = Vec::new();
    let deadline = tokio::time::sleep(Duration::from_secs(10));
    tokio::pin!(deadline);

    loop {
        let mut chunk = [0u8; 256];
        tokio::select! {
            read = stream.read(&mut chunk) => match read {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    collected.extend_from_slice(&chunk[..n]);
                    if collected.windows(7).any(|w| w == b"SSH-2.0") {
                        break;
                    }
                }
            },
            _ = &mut deadline => break,
        }
    }

    String::from_utf8_lossy(&collected).to_string()
}

#[tokio::test]
#[ignore = "needs the throwaway SSH container"]
async fn a_local_forward_carries_real_bytes_end_to_end() {
    let known = trusted_record("local").await;
    let registry = Arc::new(TunnelRegistry::new());
    let local_port = free_port();

    // Forward a local port to the container's own sshd: connecting to the
    // local end must produce the remote service's banner.
    let request = StartTunnelRequest {
        tunnel_id: "live-local".into(),
        tunnel_type: TunnelType::Local,
        profile_id: "tunnel-live".into(),
        local_host: "127.0.0.1".into(),
        local_port,
        remote_host: "127.0.0.1".into(),
        remote_port: PORT,
        ssh_hostname: HOST.into(),
        ssh_port: PORT,
        ssh_username: USER.into(),
    };

    start_tunnel(Arc::clone(&registry), request, PASSWORD, Some(known))
        .await
        .unwrap();

    let mut stream = TcpStream::connect(("127.0.0.1", local_port)).await.unwrap();
    let banner = read_banner(&mut stream).await;
    assert!(
        banner.contains("SSH-2.0"),
        "expected the forwarded service's banner, got {banner:?}"
    );
    drop(stream);

    // Give the counters a moment to absorb the transfer, then check that the
    // traffic was really observed.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let status = registry.status("live-local").unwrap();
    assert!(status.bytes_downloaded > 0, "downloaded bytes were counted");

    registry.stop("live-local").await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        TcpStream::connect(("127.0.0.1", local_port)).await.is_err(),
        "the listener closes when the tunnel stops"
    );
}

#[tokio::test]
#[ignore = "needs the throwaway SSH container"]
async fn a_dynamic_socks5_proxy_connects_to_a_requested_target() {
    let known = trusted_record("dynamic").await;
    let registry = Arc::new(TunnelRegistry::new());
    let local_port = free_port();

    let request = StartTunnelRequest {
        tunnel_id: "live-dynamic".into(),
        tunnel_type: TunnelType::Dynamic,
        profile_id: "tunnel-live".into(),
        local_host: "127.0.0.1".into(),
        local_port,
        remote_host: String::new(),
        remote_port: 0,
        ssh_hostname: HOST.into(),
        ssh_port: PORT,
        ssh_username: USER.into(),
    };

    start_tunnel(
        Arc::clone(&registry),
        request.clone(),
        PASSWORD,
        Some(known.clone()),
    )
    .await
    .unwrap();

    let mut stream = TcpStream::connect(("127.0.0.1", local_port)).await.unwrap();

    // SOCKS5 greeting and CONNECT to the container's sshd by IPv4.
    stream.write_all(&[0x05, 0x01, 0x00]).await.unwrap();
    let mut chosen = [0u8; 2];
    stream.read_exact(&mut chosen).await.unwrap();
    assert_eq!(chosen, [0x05, 0x00]);

    let mut connect_request = vec![0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1];
    connect_request.extend_from_slice(&PORT.to_be_bytes());
    stream.write_all(&connect_request).await.unwrap();

    let mut reply = [0u8; 10];
    stream.read_exact(&mut reply).await.unwrap();
    assert_eq!(reply[1], 0x00, "the CONNECT succeeds");

    let banner = read_banner(&mut stream).await;
    assert!(
        banner.contains("SSH-2.0"),
        "expected the proxied service's banner, got {banner:?}"
    );

    registry.stop("live-dynamic").await.unwrap();
    let stopped = registry.status("live-dynamic").unwrap();
    assert_eq!(stopped.status, TunnelStatus::Stopped);
    assert_eq!(stopped.active_connections, 0);

    let mut byte = [0u8; 1];
    match tokio::time::timeout(Duration::from_secs(2), stream.read(&mut byte)).await {
        Ok(Ok(0)) | Ok(Err(_)) => {}
        Ok(Ok(read)) => panic!("the stopped tunnel still delivered {read} byte(s)"),
        Err(_) => panic!("the existing SOCKS connection survived tunnel stop"),
    }
    assert!(
        TcpStream::connect(("127.0.0.1", local_port)).await.is_err(),
        "the stopped SOCKS listener no longer accepts connections"
    );

    // A successful Stop is an immediate restart boundary: the same id and
    // bind address must be reusable without waiting for a detached cleanup.
    start_tunnel(Arc::clone(&registry), request, PASSWORD, Some(known))
        .await
        .unwrap();
    registry.stop("live-dynamic").await.unwrap();
}

#[tokio::test]
#[ignore = "needs the throwaway SSH container"]
async fn a_remote_forward_delivers_server_side_connections_locally() {
    let known = trusted_record("remote").await;
    let registry = Arc::new(TunnelRegistry::new());

    // A tiny local echo service plays the role of the forwarded target.
    let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target_port = target.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = target.accept().await {
            tokio::spawn(async move {
                let mut buffer = [0u8; 256];
                while let Ok(n) = socket.read(&mut buffer).await {
                    if n == 0 || socket.write_all(&buffer[..n]).await.is_err() {
                        break;
                    }
                }
            });
        }
    });

    let request = StartTunnelRequest {
        tunnel_id: "live-remote".into(),
        tunnel_type: TunnelType::Remote,
        profile_id: "tunnel-live".into(),
        local_host: "0.0.0.0".into(),
        local_port: REMOTE_FORWARD_PORT,
        remote_host: "127.0.0.1".into(),
        remote_port: target_port,
        ssh_hostname: HOST.into(),
        ssh_port: PORT,
        ssh_username: USER.into(),
    };

    start_tunnel(
        Arc::clone(&registry),
        request.clone(),
        PASSWORD,
        Some(known.clone()),
    )
    .await
    .unwrap();

    // Port 3333 is published by the container and GatewayPorts is explicitly
    // enabled in the setup above. Bytes entering that server-side listener
    // must reach the local echo target and return through the SSH channel.
    let mut remote = TcpStream::connect((HOST, REMOTE_FORWARD_PORT))
        .await
        .unwrap();
    let payload = b"lattice-remote-ok";
    remote.write_all(payload).await.unwrap();
    let mut echoed = [0u8; 17];
    remote.read_exact(&mut echoed).await.unwrap();
    assert_eq!(&echoed, payload);

    tokio::time::sleep(Duration::from_millis(300)).await;
    let status = registry.status("live-remote").unwrap();
    assert_eq!(
        status.status,
        latticeterm_lib::tunnel::TunnelStatus::Active,
        "the remote forward is accepted and held open"
    );
    assert!(
        status.bytes_uploaded > 0,
        "echo bytes returned to the remote side"
    );
    assert!(
        status.bytes_downloaded > 0,
        "remote bytes reached the local target"
    );

    registry.stop("live-remote").await.unwrap();
    let stopped = registry.status("live-remote").unwrap();
    assert_eq!(stopped.status, TunnelStatus::Stopped);
    assert_eq!(stopped.active_connections, 0);

    let mut byte = [0u8; 1];
    match tokio::time::timeout(Duration::from_secs(2), remote.read(&mut byte)).await {
        Ok(Ok(0)) | Ok(Err(_)) => {}
        Ok(Ok(read)) => panic!("the stopped remote tunnel still delivered {read} byte(s)"),
        Err(_) => panic!("the existing remote-forward connection survived tunnel stop"),
    }
    // Docker's published-port proxy can complete TCP connect even when no
    // process listens inside the container. Prove the old SSH listener is gone
    // by requiring an actual echo attempt to fail or close without bytes.
    if let Ok(mut probe) = TcpStream::connect((HOST, REMOTE_FORWARD_PORT)).await {
        let _ = probe.write_all(b"stopped-probe").await;
        let mut reply = [0u8; 13];
        match tokio::time::timeout(Duration::from_secs(2), probe.read(&mut reply)).await {
            Ok(Ok(0)) | Ok(Err(_)) => {}
            Ok(Ok(read)) => panic!("the stopped remote listener echoed {read} byte(s)"),
            Err(_) => panic!("the stopped remote listener kept a probe connection open"),
        }
    }

    start_tunnel(Arc::clone(&registry), request, PASSWORD, Some(known))
        .await
        .unwrap();
    registry.stop("live-remote").await.unwrap();
}
