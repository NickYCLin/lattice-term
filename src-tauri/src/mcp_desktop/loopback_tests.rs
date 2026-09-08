//! Real loopback SSH transport with a synthetic exec peer. No system accounts,
//! saved credentials, persistent keys, or external hosts are involved.

use super::*;
use crate::hostkeys::HostKeyRecord;
use crate::ssh::{AuthMethod, ConnectOutcome, ConnectRequest, SessionSink};
use base64::Engine;
use russh::keys::ssh_key::{private::Ed25519Keypair, HashAlg, PrivateKey};
use russh::{server, Channel, ChannelId, Pty};
use std::sync::atomic::{AtomicUsize, Ordering};

#[cfg(unix)]
mod openssh;

#[derive(Clone, Copy)]
enum SftpMode {
    Disabled,
    #[cfg(unix)]
    OpenSsh {
        denied_requests: Option<&'static str>,
    },
}

struct Handler {
    password: String,
    channels: Vec<Channel<server::Msg>>,
    execs: Arc<AtomicUsize>,
    authentications: Arc<AtomicUsize>,
    closed_channels: Arc<AtomicUsize>,
    sftp_mode: SftpMode,
    sftp_channels: std::collections::HashSet<ChannelId>,
}

impl server::Handler for Handler {
    type Error = russh::Error;

    async fn auth_password(
        &mut self,
        user: &str,
        password: &str,
    ) -> Result<server::Auth, Self::Error> {
        self.authentications.fetch_add(1, Ordering::Relaxed);
        Ok(if user == "isolated-test" && password == self.password {
            server::Auth::Accept
        } else {
            server::Auth::reject()
        })
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut server::Session,
    ) -> Result<(), Self::Error> {
        self.channels.push(channel);
        reply.accept().await;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn pty_request(
        &mut self,
        _: ChannelId,
        _: &str,
        _: u32,
        _: u32,
        _: u32,
        _: u32,
        _: &[(Pty, u32)],
        _: &mut server::Session,
    ) -> Result<(), Self::Error> {
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        if !self.sftp_channels.contains(&channel) {
            session.data(channel, data.to_vec())?;
        }
        Ok(())
    }

    async fn channel_close(
        &mut self,
        channel: ChannelId,
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        self.closed_channels.fetch_add(1, Ordering::Relaxed);
        self.sftp_channels.remove(&channel);
        session.close(channel)?;
        Ok(())
    }

    async fn subsystem_request(
        &mut self,
        channel_id: ChannelId,
        name: &str,
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        if name != "sftp" {
            session.channel_failure(channel_id)?;
            return Ok(());
        }
        match self.sftp_mode {
            SftpMode::Disabled => session.channel_failure(channel_id)?,
            #[cfg(unix)]
            SftpMode::OpenSsh { denied_requests } => {
                let Some(index) = self
                    .channels
                    .iter()
                    .position(|channel| channel.id() == channel_id)
                else {
                    session.channel_failure(channel_id)?;
                    return Ok(());
                };
                let channel = self.channels.swap_remove(index);
                let (peer, mut peer_stream) =
                    crate::sftp_test_server::OpenSshServer::start(denied_requests);
                self.sftp_channels.insert(channel_id);
                session.channel_success(channel_id)?;
                tokio::spawn(async move {
                    let mut ssh_stream = channel.into_stream();
                    // Both transport endpoints and the OpenSSH working directory
                    // belong to this one test. Dropping peer kills its child.
                    let _ = tokio::time::timeout(
                        Duration::from_secs(45),
                        tokio::io::copy_bidirectional(&mut ssh_stream, &mut peer_stream),
                    )
                    .await;
                    drop(peer);
                });
            }
        }
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        self.execs.fetch_add(1, Ordering::Relaxed);
        session.channel_success(channel)?;
        match data {
            b"result" => {
                session.data(channel, b"stdout: checked\n".to_vec())?;
                session.extended_data(channel, 1, b"stderr: warning\n".to_vec())?;
                // Exercise EOF before exit-status, a valid SSH message order.
                session.eof(channel)?;
                session.exit_status_request(channel, 7)?;
                session.close(channel)?;
            }
            b"missing-status" => {
                session.eof(channel)?;
                session.close(channel)?;
            }
            b"hold" => {}
            _ if data.starts_with(b"export LC_ALL=C;") => {}
            _ => {
                session.channel_failure(channel)?;
            }
        }
        Ok(())
    }
}

struct Peer {
    port: u16,
    password: String,
    known: HostKeyRecord,
    _task: tokio::task::JoinHandle<()>,
    execs: Arc<AtomicUsize>,
    authentications: Arc<AtomicUsize>,
    closed_channels: Arc<AtomicUsize>,
    shutdown: watch::Sender<bool>,
}

impl Peer {
    async fn start() -> Self {
        Self::start_with_sftp(SftpMode::Disabled).await
    }

    async fn start_with_sftp(sftp_mode: SftpMode) -> Self {
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut seed = [0; 32];
        getrandom::fill(&mut seed).unwrap();
        let key = PrivateKey::from(Ed25519Keypair::from_seed(&seed));
        let known = HostKeyRecord {
            host: "127.0.0.1".into(),
            port,
            algorithm: key.algorithm().to_string(),
            fingerprint: key.public_key().fingerprint(HashAlg::Sha256).to_string(),
            first_trusted_at: 1,
            last_seen_at: 1,
        };
        let config = Arc::new(server::Config {
            keys: vec![key],
            auth_rejection_time: Duration::from_millis(1),
            inactivity_timeout: Some(Duration::from_secs(15)),
            ..Default::default()
        });
        let password = opaque_id().unwrap();
        let execs = Arc::new(AtomicUsize::new(0));
        let authentications = Arc::new(AtomicUsize::new(0));
        let closed_channels = Arc::new(AtomicUsize::new(0));
        let (shutdown, mut closed) = watch::channel(false);
        let task_password = password.clone();
        let task_execs = Arc::clone(&execs);
        let task_authentications = Arc::clone(&authentications);
        let task_closed_channels = Arc::clone(&closed_channels);
        let task = tokio::spawn(async move {
            let mut peers = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    biased;
                    _ = cancelled(&mut closed) => break,
                    stream = listener.accept() => {
                        let (stream, _) = stream.unwrap();
                        let config = Arc::clone(&config);
                        let handler = Handler { password: task_password.clone(), channels: vec![], execs: Arc::clone(&task_execs), authentications: Arc::clone(&task_authentications), closed_channels: Arc::clone(&task_closed_channels), sftp_mode, sftp_channels: Default::default() };
                        let mut connection_closed = closed.clone();
                        peers.spawn(async move {
                            let Ok(session) = server::run_stream(config, stream, handler).await else { return; };
                            let handle = session.handle();
                            tokio::select! {
                                _ = cancelled(&mut connection_closed) => { let _ = handle.disconnect(russh::Disconnect::ByApplication, "test finished".into(), "en".into()).await; },
                                _ = session => {},
                            }
                        });
                    }
                }
            }
            while peers.join_next().await.is_some() {}
        });
        Self {
            port,
            password,
            known,
            _task: task,
            execs,
            authentications,
            closed_channels,
            shutdown,
        }
    }

    fn request(&self) -> ConnectRequest {
        ConnectRequest {
            profile_id: "synthetic-only".into(),
            hostname: "127.0.0.1".into(),
            port: self.port,
            username: "isolated-test".into(),
            auth: AuthMethod::Password {
                password: self.password.clone(),
            },
            use_saved_password: false,
            remember_password: false,
            cols: 80,
            rows: 24,
        }
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        self.shutdown.send_replace(true);
        // Connection tasks get the shutdown watch; the accept loop exits too.
    }
}

#[derive(Default)]
struct Sink(Mutex<Vec<u8>>);
impl SessionSink for Sink {
    fn data(&self, _: &str, bytes: &[u8]) {
        self.0.lock().unwrap().extend_from_slice(bytes);
    }
    fn closed(&self, _: &str, _: &str) {}
}

async fn bounded(test: impl std::future::Future<Output = ()>) {
    tokio::time::timeout(Duration::from_secs(20), test)
        .await
        .expect("isolated SSH test exceeded its deadline");
}

#[tokio::test]
async fn actual_ssh_host_key_unknown_and_changed_are_rejected_before_authentication() {
    bounded(async {
        let peer = Peer::start().await;
        let ssh = Arc::new(SshRegistry::new());
        let sink: Arc<dyn SessionSink> = Arc::new(Sink::default());
        let unknown =
            crate::ssh::connect(Arc::clone(&sink), Arc::clone(&ssh), None, peer.request()).await;
        assert!(matches!(unknown, ConnectOutcome::HostUnknown { .. }));
        let mut wrong = peer.known.clone();
        wrong.fingerprint = "SHA256:deliberately-not-the-server-key".into();
        let changed =
            crate::ssh::connect(sink, Arc::clone(&ssh), Some(wrong), peer.request()).await;
        assert!(matches!(changed, ConnectOutcome::HostChanged { .. }));
        assert!(ssh.list().is_empty());
        assert_eq!(peer.authentications.load(Ordering::Relaxed), 0);
        assert_eq!(peer.execs.load(Ordering::Relaxed), 0);
    })
    .await;
}

async fn poll(service: &Arc<DesktopService>, target: &str, operation_id: &str) -> Value {
    loop {
        let value = service
            .execute(
                "client",
                DesktopOperation::OperationStatus {
                    target_id: target.into(),
                    operation_id: operation_id.into(),
                },
            )
            .await
            .unwrap();
        if value["state"] != "running" {
            return value;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn actual_ssh_exec_is_bounded_deduplicated_and_does_not_close_the_users_terminal() {
    bounded(async {
        let peer = Peer::start().await;
        let ssh = Arc::new(SshRegistry::new());
        let sink = Arc::new(Sink::default());
        let outcome = crate::ssh::connect(
            sink.clone(),
            Arc::clone(&ssh),
            Some(peer.known.clone()),
            peer.request(),
        )
        .await;
        let ConnectOutcome::Connected { session_id } = outcome else {
            panic!("trusted test SSH session did not connect")
        };
        let service = Arc::new(DesktopService::new(
            Arc::clone(&ssh),
            Arc::new(SftpRegistry::new()),
        ));
        let grant = service
            .grant(GrantRequest {
                session_id: session_id.clone(),
                backend: Backend::Ssh,
                label: "Isolated SSH".into(),
                scopes: Scopes {
                    exec: true,
                    ..Default::default()
                },
                roots: vec![],
                exec_plans: vec![
                    ExecPlan {
                        id: "result".into(),
                        label: "Known result".into(),
                        command: "result".into(),
                        timeout_ms: 3000,
                    },
                    ExecPlan {
                        id: "timeout".into(),
                        label: "Bounded wait".into(),
                        command: "hold".into(),
                        timeout_ms: 150,
                    },
                    ExecPlan {
                        id: "hold".into(),
                        label: "Cancellable wait".into(),
                        command: "hold".into(),
                        timeout_ms: 10_000,
                    },
                    ExecPlan {
                        id: "missing".into(),
                        label: "Missing exit status".into(),
                        command: "missing-status".into(),
                        timeout_ms: 3000,
                    },
                ],
            })
            .await
            .unwrap();
        let operation = DesktopOperation::Exec {
            target_id: grant.id.clone(),
            plan_id: "result".into(),
            request_id: "r1".into(),
        };
        for index in 0..300 {
            let invalid = DesktopOperation::Exec {
                target_id: grant.id.clone(),
                plan_id: "not-approved".into(),
                request_id: format!("invalid-{index}"),
            };
            assert!(service.execute("client", invalid).await.is_err());
        }
        assert!(service.state.lock().unwrap().operations.is_empty());
        let started = service.execute("client", operation.clone()).await.unwrap();
        assert_eq!(started["state"], "running");
        let duplicate = service.execute("client", operation.clone()).await.unwrap();
        assert_eq!(duplicate["operationId"], started["operationId"]);
        let result = poll(
            &service,
            &grant.id,
            started["operationId"].as_str().unwrap(),
        )
        .await;
        assert_eq!(result["stdout"], "stdout: checked\n");
        assert_eq!(result["stderr"], "stderr: warning\n");
        assert_eq!(result["exitStatus"], 7);
        assert_eq!(result["state"], "exited");
        assert_eq!(peer.execs.load(Ordering::Relaxed), 1);
        service.execute("client", operation).await.unwrap();
        assert_eq!(peer.execs.load(Ordering::Relaxed), 1);

        for (plan_id, expected) in [("timeout", "timedOut"), ("missing", "unknown")] {
            let started = service
                .execute(
                    "client",
                    DesktopOperation::Exec {
                        target_id: grant.id.clone(),
                        plan_id: plan_id.into(),
                        request_id: plan_id.into(),
                    },
                )
                .await
                .unwrap();
            let result = poll(
                &service,
                &grant.id,
                started["operationId"].as_str().unwrap(),
            )
            .await;
            assert_eq!(result["state"], expected);
            assert!(result["exitStatus"].is_null());
        }
        let started = service
            .execute(
                "client",
                DesktopOperation::Exec {
                    target_id: grant.id.clone(),
                    plan_id: "hold".into(),
                    request_id: "cancel-me".into(),
                },
            )
            .await
            .unwrap();
        let id = started["operationId"].as_str().unwrap();
        service
            .execute(
                "client",
                DesktopOperation::Cancel {
                    target_id: grant.id.clone(),
                    operation_id: id.into(),
                    request_id: "c1".into(),
                },
            )
            .await
            .unwrap();
        assert_eq!(poll(&service, &grant.id, id).await["state"], "cancelled");
        assert_eq!(ssh.list().len(), 1);
        crate::ssh::send(
            &ssh,
            &session_id,
            &base64::engine::general_purpose::STANDARD.encode(b"human-input"),
        )
        .await
        .unwrap();
        while !sink
            .0
            .lock()
            .unwrap()
            .windows(11)
            .any(|bytes| bytes == b"human-input")
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        let revoking = service
            .execute(
                "client",
                DesktopOperation::Exec {
                    target_id: grant.id.clone(),
                    plan_id: "hold".into(),
                    request_id: "revoke-me".into(),
                },
            )
            .await
            .unwrap();
        service.revoke(&grant.id).unwrap();
        assert!(service
            .execute(
                "client",
                DesktopOperation::OperationStatus {
                    target_id: grant.id.clone(),
                    operation_id: revoking["operationId"].as_str().unwrap().into()
                }
            )
            .await
            .is_err());
        assert!(service.targets().is_empty());
        assert_eq!(ssh.list().len(), 1);
        crate::ssh::disconnect(&ssh, &session_id).await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn an_observed_offline_grant_stays_revoked_when_the_same_live_handle_returns() {
    bounded(async {
        let peer = Peer::start().await;
        let ssh = Arc::new(SshRegistry::new());
        let outcome = crate::ssh::connect(
            Arc::new(Sink::default()),
            Arc::clone(&ssh),
            Some(peer.known.clone()),
            peer.request(),
        )
        .await;
        let ConnectOutcome::Connected { session_id } = outcome else {
            panic!("trusted test SSH session did not connect")
        };
        let handle = ssh.session_handle(&session_id).unwrap();
        let service = Arc::new(DesktopService::new(
            Arc::clone(&ssh),
            Arc::new(SftpRegistry::new()),
        ));
        let request = GrantRequest {
            session_id: session_id.clone(),
            backend: Backend::Ssh,
            label: "Ephemeral SSH".into(),
            scopes: Scopes {
                exec: true,
                ..Default::default()
            },
            roots: vec![],
            exec_plans: vec![ExecPlan {
                id: "result".into(),
                label: "Known result".into(),
                command: "result".into(),
                timeout_ms: 3000,
            }],
        };
        let target = service.grant(request.clone()).await.unwrap();
        // Simulate an observed registry identity gap while retaining the real
        // localhost connection; restoring the pointer must not restore consent.
        let (identity, mut revoked) = {
            let mut state = service.state.lock().unwrap();
            let grant = Arc::get_mut(state.grants.get_mut(&target.id).unwrap()).unwrap();
            let identity = grant.identity;
            grant.identity = identity.wrapping_add(1);
            (identity, grant.revoked.subscribe())
        };
        assert!(!service.targets()[0].connected);
        tokio::time::timeout(Duration::from_millis(100), cancelled(&mut revoked))
            .await
            .expect("offline observation must cancel pending work");
        {
            let mut state = service.state.lock().unwrap();
            Arc::get_mut(state.grants.get_mut(&target.id).unwrap())
                .unwrap()
                .identity = identity;
        }
        assert!(!handle.is_closed());
        assert_eq!(service.identity(Backend::Ssh, &session_id), Some(identity));
        assert!(!service.targets()[0].connected);
        assert_eq!(
            service
                .execute(
                    "client",
                    DesktopOperation::Exec {
                        target_id: target.id.clone(),
                        plan_id: "result".into(),
                        request_id: "old-grant".into(),
                    },
                )
                .await
                .unwrap_err()
                .code,
            "not_authorized"
        );
        assert_eq!(peer.execs.load(Ordering::Relaxed), 0);

        let replacement = service.grant(request.clone()).await.unwrap();
        assert_ne!(target.id, replacement.id);
        let accepted = service
            .execute(
                "client",
                DesktopOperation::Exec {
                    target_id: replacement.id.clone(),
                    plan_id: "result".into(),
                    request_id: "new-grant".into(),
                },
            )
            .await
            .unwrap();
        assert_eq!(
            poll(
                &service,
                &replacement.id,
                accepted["operationId"].as_str().unwrap(),
            )
            .await["exitStatus"],
            7
        );
        // Also exercise a real transport closure, not only the identity gap.
        peer.shutdown.send_replace(true);
        tokio::time::timeout(Duration::from_secs(3), async {
            while !handle.is_closed() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(service.targets().iter().all(|target| !target.connected));
        assert_eq!(
            service.grant(request).await.unwrap_err().code,
            "needs_user_action"
        );
    })
    .await;
}

#[tokio::test]
async fn actual_ssh_metrics_timeout_closes_only_its_dedicated_channel() {
    bounded(async {
        let peer = Peer::start().await;
        let ssh = Arc::new(SshRegistry::new());
        let sink = Arc::new(Sink::default());
        let outcome = crate::ssh::connect(
            sink.clone(),
            Arc::clone(&ssh),
            Some(peer.known.clone()),
            peer.request(),
        )
        .await;
        let ConnectOutcome::Connected { session_id } = outcome else {
            panic!("trusted test SSH session did not connect")
        };
        let expired = tokio::time::timeout(
            Duration::from_millis(300),
            crate::metrics::collect_for_session(&ssh, &session_id),
        )
        .await;
        assert!(expired.is_err());
        assert_eq!(peer.execs.load(Ordering::Relaxed), 1);
        tokio::time::timeout(Duration::from_secs(3), async {
            while peer.closed_channels.load(Ordering::Relaxed) == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("dropping the probe did not close its SSH channel");
        assert_eq!(ssh.list().len(), 1);
        crate::ssh::send(
            &ssh,
            &session_id,
            &base64::engine::general_purpose::STANDARD.encode(b"still-open"),
        )
        .await
        .unwrap();
        while !sink
            .0
            .lock()
            .unwrap()
            .windows(10)
            .any(|bytes| bytes == b"still-open")
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        crate::ssh::disconnect(&ssh, &session_id).await.unwrap();
    })
    .await;
}
