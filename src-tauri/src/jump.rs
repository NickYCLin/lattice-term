//! Per-attempt SSH jump connections. Target and gateway identities never share credentials.
use crate::storage::Storage;
use crate::{
    domain::{ConnectionProfile, Protocol},
    hostkeys::HostKeyRecord,
    ssh::{AuthAttempt, AuthMethod, TrustingHandler},
};
use russh::{client, ChannelStream};
use serde::Deserialize;
use std::sync::{atomic::AtomicBool, Arc, Mutex};
use std::time::Duration;
use tauri::Manager;
use tokio::{net::TcpListener, task::JoinHandle};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JumpRequest {
    pub profile_id: String,
    pub auth: Option<AuthMethod>,
    #[serde(default)]
    pub use_saved_password: bool,
    #[serde(default)]
    pub remember_password: bool,
}

impl std::fmt::Debug for JumpRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JumpRequest")
            .field("profile_id", &self.profile_id)
            .field("authentication", &"[redacted]")
            .finish()
    }
}
impl Drop for JumpRequest {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        match self.auth.as_mut() {
            Some(AuthMethod::Password { password }) => password.zeroize(),
            Some(AuthMethod::PrivateKey {
                passphrase: Some(passphrase),
                ..
            }) => passphrase.zeroize(),
            _ => {}
        }
    }
}

static ADMISSION: std::sync::LazyLock<Arc<tokio::sync::Semaphore>> =
    std::sync::LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(16)));
pub struct Gateway {
    session: Arc<client::Handle<TrustingHandler>>,
    admission: Option<tokio::sync::OwnedSemaphorePermit>,
}
impl Drop for Gateway {
    fn drop(&mut self) {
        let session = self.session.clone();
        let admission = self.admission.take();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _admission = admission;
                let _ = tokio::time::timeout(
                    Duration::from_secs(2),
                    session.disconnect(russh::Disconnect::ByApplication, "", ""),
                )
                .await;
            });
        }
    }
}

pub fn validate_gateway(
    target: &ConnectionProfile,
    gateway: &ConnectionProfile,
) -> Result<(), String> {
    if gateway.protocol != Protocol::Ssh
        || gateway.id == target.id
        || gateway.jump_profile_id.is_some()
        || gateway.retired_to.is_some()
    {
        return Err(
            "jump:profile:Select an existing direct SSH connection as the jump host.".into(),
        );
    }
    if target.jump_profile_id.as_deref() != Some(gateway.id.as_str()) {
        return Err("jump:profile:The configured jump host changed; reopen the connection.".into());
    }
    Ok(())
}

pub async fn authenticate_gateway(
    profile: &ConnectionProfile,
    known: Option<HostKeyRecord>,
    auth: &AuthMethod,
) -> Result<Gateway, String> {
    if known.is_none() {
        return Err(
            "jump:trust:Connect to the jump host directly and verify its SSH fingerprint first."
                .into(),
        );
    }
    let admission = ADMISSION
        .clone()
        .try_acquire_owned()
        .map_err(|_| "jump:busy:Too many jump connections; close an unused session first.")?;
    let handler = TrustingHandler {
        windows_server: Arc::new(AtomicBool::new(false)),
        host: profile.hostname.clone(),
        port: profile.port,
        known,
        verdict: Arc::new(Mutex::new(None)),
        disconnect_reason: None,
    };
    let mut handle = tokio::time::timeout(Duration::from_secs(15), client::connect(Arc::new(client::Config::default()), (profile.hostname.as_str(), profile.port), handler))
        .await.map_err(|_| "jump:connect:The jump host connection timed out.")?
        .map_err(|_| "jump:trust-or-connect:Cannot reach the jump host or its SSH host key no longer matches. Check the direct SSH connection.")?;
    match tokio::time::timeout(
        Duration::from_secs(15),
        crate::ssh::authenticate(&mut handle, &profile.username, auth),
    )
    .await
    {
        Ok(AuthAttempt::Accepted) => Ok(Gateway {
            session: Arc::new(handle),
            admission: Some(admission),
        }),
        _ => Err(
            "jump:authenticate:Jump host authentication failed. Check its own password or key."
                .into(),
        ),
    }
}

pub async fn from_app(
    app: &tauri::AppHandle,
    target: &ConnectionProfile,
    mut request: JumpRequest,
) -> Result<Gateway, String> {
    let gateway = {
        let storage = app.state::<crate::AppStorage>();
        let guard = storage
            .lock()
            .map_err(|_| "jump:profile:Cannot read jump host settings.")?;
        guard
            .get_profile(
                target
                    .jump_profile_id
                    .as_deref()
                    .ok_or("jump:profile:No jump host is configured.")?,
            )
            .map_err(|_| "jump:profile:Cannot read jump host settings.")?
            .ok_or("jump:profile:The jump host was removed.")?
    };
    validate_gateway(target, &gateway)?;
    if request.profile_id != gateway.id {
        return Err("jump:profile:The selected jump host changed; reopen the connection.".into());
    }
    if request.use_saved_password && request.remember_password {
        return Err("jump:credential:Choose a saved or a new jump password, not both.".into());
    }
    if request.use_saved_password {
        let profile = gateway.clone();
        let password = crate::credential_call(move || {
            crate::credentials::load_bound(
                &profile,
                crate::credentials::CredentialKind::SshPassword,
            )
        })
        .await
        .map_err(|_| {
            "jump:credential:Unlock the credential store or save the jump host password first."
        })?;
        request.auth = Some(AuthMethod::Password { password });
    }
    let auth = request
        .auth
        .as_ref()
        .ok_or("jump:credential:Provide the jump host password or private key.")?;
    let known = match app.state::<crate::TrustState>().inner() {
        crate::TrustState::Unavailable(_) => {
            return Err("jump:trust:The SSH trust store is unavailable.".into())
        }
        crate::TrustState::Ready(store) => crate::ssh::known_record(
            &*store
                .lock()
                .map_err(|_| "jump:trust:Cannot read SSH trust.")?,
            &gateway.hostname,
            gateway.port,
        ),
    };
    let result = authenticate_gateway(&gateway, known, auth).await?;
    if request.remember_password {
        if let AuthMethod::Password { password } = auth {
            let password = zeroize::Zeroizing::new(password.clone());
            crate::credential_call(move || {
                crate::credentials::store_bound(
                    &gateway,
                    crate::credentials::CredentialKind::SshPassword,
                    &password,
                )
            })
            .await
            .map_err(|_| {
                "jump:credential:Connected to the jump host but could not save its password."
            })?;
        }
    }
    Ok(result)
}

impl Gateway {
    pub async fn stream(
        &self,
        host: &str,
        port: u16,
    ) -> Result<ChannelStream<client::Msg>, String> {
        tokio::time::timeout(
            Duration::from_secs(15),
            self.session
                .channel_open_direct_tcpip(host, u32::from(port), "127.0.0.1", 0),
        )
        .await
        .map_err(|_| "target:connect:The jump host timed out connecting to the target.")?
        .map(|channel| channel.into_stream())
        .map_err(|_| {
            "target:connect:The jump host cannot reach the target or does not allow forwarding."
                .into()
        })
    }
    pub async fn forward(self, host: String, port: u16) -> Result<TcpRoute, String> {
        // A real target probe distinguishes forwarding denial from a sidecar error.
        drop(self.stream(&host, port).await?);
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|_| "jump:bind:Cannot reserve a local forwarding port.")?;
        let local_port = listener
            .local_addr()
            .map_err(|_| "jump:bind:Cannot read the forwarding port.")?
            .port();
        let worker = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((mut local, _)) = accepted else { break; };
                        if connections.len() >= 32 { continue; }
                        let session = self.session.clone(); let host = host.clone();
                        connections.spawn(async move {
                            if let Ok(Ok(channel)) = tokio::time::timeout(Duration::from_secs(15), session.channel_open_direct_tcpip(host, u32::from(port), "127.0.0.1", 0)).await {
                                let mut remote = channel.into_stream();
                                let _ = tokio::io::copy_bidirectional(&mut local, &mut remote).await;
                            }
                        });
                    },
                    _ = connections.join_next(), if !connections.is_empty() => {}
                }
            }
        });
        Ok(TcpRoute {
            port: local_port,
            worker,
        })
    }
}
pub struct TcpRoute {
    pub port: u16,
    worker: JoinHandle<()>,
}
impl Drop for TcpRoute {
    fn drop(&mut self) {
        self.worker.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpStream;
    fn profile(id: &str) -> ConnectionProfile {
        serde_json::from_value(serde_json::json!({"id":id,"name":id,"protocol":"ssh","hostname":"fixture.invalid","port":22,"username":"fixture","environment":"unassigned","group":"","tags":[],"favorite":false})).unwrap()
    }
    #[test]
    fn gateway_reference_rejects_self_chains_non_ssh_and_replaced_gateway() {
        let mut target = profile("target");
        target.jump_profile_id = Some("gateway".into());
        let mut gateway = profile("gateway");
        assert!(validate_gateway(&target, &gateway).is_ok());
        gateway.jump_profile_id = Some("other".into());
        assert!(validate_gateway(&target, &gateway).is_err());
        gateway.jump_profile_id = None;
        gateway.protocol = Protocol::Rdp;
        assert!(validate_gateway(&target, &gateway).is_err());
        gateway.protocol = Protocol::Ssh;
        gateway.retired_to = Some("other".into());
        assert!(validate_gateway(&target, &gateway).is_err());
        assert!(validate_gateway(&target, &target).is_err());
        assert!(validate_gateway(&target, &profile("replaced")).is_err());
    }
    #[test]
    fn jump_credentials_are_redacted_and_target_credential_binding_is_unchanged() {
        let request = JumpRequest {
            profile_id: "gateway".into(),
            auth: Some(AuthMethod::Password {
                password: "synthetic-runtime-secret".into(),
            }),
            use_saved_password: false,
            remember_password: false,
        };
        assert!(!format!("{request:?}").contains("synthetic-runtime-secret"));
        let mut target = profile("target");
        let before = crate::credentials::profile_binding_sha256(&target);
        target.jump_profile_id = Some("gateway".into());
        assert_eq!(crate::credentials::profile_binding_sha256(&target), before);
        let json = serde_json::to_string(&target).unwrap();
        assert!(json.contains("jumpProfileId"));
        assert!(!json.contains("synthetic-runtime-secret"));
        assert_eq!(
            serde_json::from_str::<ConnectionProfile>(&json).unwrap(),
            target
        );
    }
    #[tokio::test]
    async fn unverified_gateway_is_refused_before_connecting() {
        assert!(authenticate_gateway(
            &profile("gateway"),
            None,
            &AuthMethod::Password {
                password: String::new()
            }
        )
        .await
        .err()
        .unwrap()
        .starts_with("jump:trust:"));
    }
    #[tokio::test]
    async fn dropping_route_releases_the_prebound_loopback_listener() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let route = TcpRoute {
            port,
            worker: tokio::spawn(async move {
                let _listener = listener;
                std::future::pending::<()>().await;
            }),
        };
        assert!(TcpStream::connect(("127.0.0.1", port)).await.is_ok());
        drop(route);
        for _ in 0..30 {
            if TcpListener::bind(("127.0.0.1", port)).await.is_ok() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("route listener must close after owner drops");
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        profile: crate::database::DatabaseProfile,
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
    #[derive(Default)]
    struct Sink {
        output: Mutex<Vec<u8>>,
        closed: AtomicBool,
    }
    impl crate::ssh::SessionSink for Sink {
        fn data(&self, _: &str, bytes: &[u8]) {
            self.output.lock().unwrap().extend_from_slice(bytes);
        }
        fn closed(&self, _: &str, _: &str) {
            self.closed.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
    #[tokio::test]
    #[ignore = "Run node scripts/test-databases.mjs postgres (throwaway SSH and SQL containers)"]
    async fn isolated_jump_ssh_and_sql() {
        crate::install_rustls_crypto_provider();
        let file = std::env::var_os("LATTICETERM_TEST_DATABASES_JSON").expect("isolated fixture");
        let fixture: Fixture = serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();
        tokio::time::timeout(Duration::from_secs(45), async {
            let public_key = russh::keys::load_public_key(&fixture.ssh.host_public_key).unwrap();
            let mut gateway = profile("isolated-gateway");
            gateway.hostname = "127.0.0.1".into();
            gateway.port = fixture.ssh.port;
            gateway.username = "root".into();
            let known = HostKeyRecord {
                host: gateway.hostname.clone(),
                port: gateway.port,
                algorithm: public_key.algorithm().to_string(),
                fingerprint: public_key
                    .fingerprint(russh::keys::ssh_key::HashAlg::Sha256)
                    .to_string(),
                first_trusted_at: 1,
                last_seen_at: 1,
            };
            let auth = AuthMethod::PrivateKey {
                path: fixture.ssh.private_key.to_string_lossy().into(),
                passphrase: None,
            };
            let first = authenticate_gateway(&gateway, Some(known.clone()), &auth)
                .await
                .unwrap();
            let mut target_known = known.clone();
            target_known.port = 2222;
            let sink = Arc::new(Sink::default());
            let registry = Arc::new(crate::ssh::SshRegistry::new());
            let result = crate::ssh::connect_via(
                sink.clone(),
                registry.clone(),
                Some(target_known),
                crate::ssh::ConnectRequest {
                    jump: None,
                    profile_id: "isolated-target".into(),
                    hostname: "127.0.0.1".into(),
                    port: 2222,
                    username: "root".into(),
                    auth: auth.clone(),
                    use_saved_password: false,
                    remember_password: false,
                    cols: 80,
                    rows: 24,
                },
                Some(first),
            )
            .await;
            let crate::ssh::ConnectOutcome::Connected { session_id } = result else {
                panic!("native ProxyJump must open a target shell");
            };
            crate::ssh::send(
                &registry,
                &session_id,
                &base64::Engine::encode(
                    &base64::engine::general_purpose::STANDARD,
                    b"printf 'jump-acceptance-ok\\n'; exit\n",
                ),
            )
            .await
            .unwrap();
            while !sink.closed.load(std::sync::atomic::Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            assert!(String::from_utf8_lossy(&sink.output.lock().unwrap())
                .contains("jump-acceptance-ok"));
            assert!(registry.list().is_empty());
            let second = authenticate_gateway(&gateway, Some(known), &auth)
                .await
                .unwrap();
            assert!(second
                .stream("127.0.0.1", 1)
                .await
                .err()
                .unwrap()
                .starts_with("target:connect:"));
            let route = second
                .forward("database".into(), fixture.ssh.database_port)
                .await
                .unwrap();
            let port = route.port;
            let mut database = fixture.profile.clone();
            database.hostname = "127.0.0.1".into();
            database.port = port;
            let result =
                crate::database::probe_jump_route(&database, &fixture.password, "database")
                    .await
                    .unwrap();
            assert_eq!(result["rows"][0][0], "1");
            drop(route);
            for _ in 0..50 {
                if TcpStream::connect(("127.0.0.1", port)).await.is_err() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("native jump SQL listener must close");
        })
        .await
        .expect("bounded SSH and SQL acceptance");
    }
}
