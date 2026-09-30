//! Saved-profile connection setup stays in the desktop credential/trust path.
use super::*;
use std::future::Future;
use std::pin::Pin;
use tauri::Manager;

pub type ConnectFuture = Pin<Box<dyn Future<Output = Result<(), ServiceError>> + Send>>;

impl DesktopService {
    fn saved_profile(&self, id: &str) -> Result<ConnectionProfile, ServiceError> {
        valid_id(id)?;
        if !self.connection_book_shared() {
            return Err(ServiceError::denied());
        }
        self.book
            .as_ref()
            .ok_or_else(ServiceError::unavailable)?
            .profiles()
            .into_iter()
            .find(|profile| profile.id == id)
            .ok_or_else(|| {
                ServiceError::new(
                    "not_found",
                    "The saved connection no longer exists. List saved connections again.",
                )
            })
    }

    fn connected_profile(&self, id: &str) -> Result<Option<Value>, ServiceError> {
        let profile = self.saved_profile(id)?;
        let live: Vec<_> = self
            .live_profiles()
            .into_iter()
            .filter(|(_, backend, session)| self.identity(*backend, session).is_some())
            .collect();
        let state = self.state.lock().map_err(|_| ServiceError::failed())?;
        for (_, backend, session_id) in live.iter().filter(|(profile, _, _)| profile == id) {
            if !self.session_matches_profile(&profile, *backend, session_id) {
                continue;
            }
            if let Some(grant) = state.grants.values().find(|grant| {
                grant.view.backend == *backend
                    && grant.session_id == *session_id
                    && self.connected(grant)
            }) {
                let mut connection = grant.view.clone();
                connection.label = profile.name.clone();
                return Ok(Some(json!({
                    "profileId": id, "connected": true, "targetId": grant.view.id,
                    "connection": connection
                })));
            }
        }
        if live.iter().any(|(profile, _, _)| profile == id) {
            return Err(ServiceError::new("not_authorized",
                "The connection is open but its saved target changed or MCP access is paused or unavailable. No second connection was opened."));
        }
        Ok(None)
    }

    fn session_matches_profile(
        &self,
        profile: &ConnectionProfile,
        backend: Backend,
        id: &str,
    ) -> bool {
        let address =
            |host: &str, port| host.eq_ignore_ascii_case(&profile.hostname) && port == profile.port;
        match (profile.protocol, backend) {
            (Protocol::Ssh, Backend::Ssh) => self.ssh.list().iter().any(|session| {
                session.session_id == id
                    && address(&session.host, session.port)
                    && session.username == profile.username
            }),
            (Protocol::Sftp, Backend::Sftp) => self.sftp.list().iter().any(|session| {
                session.session_id == id
                    && address(&session.host, session.port)
                    && session.username == profile.username
            }),
            (Protocol::Rdp, Backend::Rdp) => self.rdp.list().iter().any(|session| {
                session.session_id == id
                    && address(&session.host, session.port)
                    && session.username == profile.username
            }),
            (Protocol::Vnc, Backend::Vnc) => self
                .vnc
                .list()
                .iter()
                .any(|session| session.session_id == id && address(&session.host, session.port)),
            (Protocol::Lattice, Backend::Remote) => self
                .remote
                .session_for_target(
                    &profile.id,
                    &profile.hostname,
                    profile.port,
                    profile.device_id.as_deref(),
                )
                .is_some_and(|session| session.session_id == id),
            _ => false,
        }
    }

    pub(super) async fn connect_saved(
        &self,
        client: &str,
        profile_id: &str,
        request_id: &str,
        operation: &DesktopOperation,
    ) -> Result<Value, ServiceError> {
        let profile = self.saved_profile(profile_id)?;
        valid_id(request_id)?;
        // Serialize connection setup across clients so the same profile is not
        // authenticated twice. Busy requests have no side effects or ledger entry.
        let _guard = self.connecting.try_lock().map_err(|_| {
            ServiceError::new(
                "busy",
                "A saved connection is being opened; retry with the same requestId.",
            )
        })?;
        let mut lease = match self.reserve(client, request_id, profile_id, operation)? {
            Reservation::New(lease) => lease,
            Reservation::Replay(result) => {
                result?;
                let mut result = self.connected_profile(profile_id)?.ok_or_else(|| {
                    ServiceError::new("needs_user_action", "The previous connection ended. List saved connections before starting a new request.")
                })?;
                result["duplicate"] = json!(true);
                return Ok(result);
            }
        };
        let result = async {
            if let Some(existing) = self.connected_profile(profile_id)? {
                return Ok(existing);
            }
            if self.state.lock().map_err(|_| ServiceError::failed())?.grants.len() >= MAX_GRANTS
                || self.live_profiles().len() >= MAX_GRANTS
            {
                return Err(ServiceError::new("capacity", "The shared connection limit has been reached."));
            }
            let book = self.book.as_ref().ok_or_else(ServiceError::unavailable)?;
            tokio::time::timeout(Duration::from_secs(12), book.connect(profile)).await
                .map_err(|_| ServiceError::new("unknown_outcome", "Connection setup timed out. List saved connections before retrying; do not blindly change requestId."))??;
            self.saved_profile(profile_id)?;
            self.grant_live_connections().await;
            self.connected_profile(profile_id)?.ok_or_else(ServiceError::unavailable)
        }.await;
        // Closing the connection book also closes this entry point.
        let result = self.saved_profile(profile_id).and(result);
        lease.finish(result.clone());
        result
    }
}

fn connection_error(outcome: &Value) -> ServiceError {
    // Never expose the transport's detail: it may contain hosts or accounts.
    match outcome["outcome"].as_str() {
        Some("hostUnknown" | "hostChanged") => ServiceError::new(
            "host_verification_required", "Verify this saved connection's host key in LatticeTerm before connecting."),
        Some("authFailed") => ServiceError::new(
            "credential_required", "The saved login was rejected. Update this connection's saved credentials."),
        _ if outcome["stage"] == "credential" => ServiceError::new(
            "credential_required", "Save valid login credentials for this connection in LatticeTerm."),
        _ if outcome["stage"] == "trust" || outcome["stage"] == "certificate" => ServiceError::new(
            "host_verification_required", "Verify this connection's host identity in LatticeTerm."),
        _ => ServiceError::new("connection_failed", "Could not open this saved connection. Check the desktop connection status and network."),
    }
}

/// Reuses the same profile binding, credential store and host verification as
/// the Connect button. MCP accepts only a saved ID, never a host or password.
pub(crate) fn connect_from_desktop(
    app: tauri::AppHandle,
    profile: ConnectionProfile,
) -> ConnectFuture {
    Box::pin(async move {
        let request = json!({
            "profileId": profile.id, "hostname": profile.hostname, "port": profile.port,
            "username": profile.username, "auth":{"kind":"password","password":""},
            "useSavedPassword": true, "rememberPassword": false, "password":"",
            "cols": 100, "rows": 30, "domain": null, "width": 1280, "height": 800,
            "pairingCode": "", "useSavedPairingCode": true, "rememberPairingCode": false,
            "deviceId": profile.device_id.unwrap_or_default(),
            "relayAddress": profile.relay_address.unwrap_or_default()
        });
        let outcome = match profile.protocol {
            Protocol::Ssh => {
                let request =
                    serde_json::from_value(request).map_err(|_| ServiceError::invalid())?;
                let outcome =
                    crate::ssh_connect(app.clone(), request, app.state(), app.state(), app.state())
                        .await;
                serde_json::to_value(outcome.map_err(|_| ServiceError::failed())?)
            }
            Protocol::Sftp => {
                let request =
                    serde_json::from_value(request).map_err(|_| ServiceError::invalid())?;
                let outcome = crate::sftp_connect(
                    app.clone(),
                    request,
                    app.state(),
                    app.state(),
                    app.state(),
                )
                .await;
                serde_json::to_value(outcome.map_err(|_| ServiceError::failed())?)
            }
            Protocol::Vnc => {
                let request =
                    serde_json::from_value(request).map_err(|_| ServiceError::invalid())?;
                let outcome =
                    crate::vnc_connect(app.clone(), request, app.state(), app.state()).await;
                serde_json::to_value(outcome.map_err(|_| ServiceError::failed())?)
            }
            Protocol::Lattice => {
                let request =
                    serde_json::from_value(request).map_err(|_| ServiceError::invalid())?;
                let outcome =
                    crate::remote_connect(app.clone(), request, app.state(), app.state()).await;
                serde_json::to_value(outcome.map_err(|_| ServiceError::failed())?)
            }
            Protocol::Rdp => {
                // The profile has no persisted domain. Only credentials saved
                // without a domain can be used; the credential binding rejects
                // another context, and the normal certificate check still runs.
                let request = crate::rdp::RdpConnectRequest {
                    profile_id: profile.id.clone(),
                    hostname: profile.hostname.clone(),
                    port: profile.port,
                    username: profile.username.clone(),
                    password: String::new(),
                    use_saved_password: true,
                    remember_password: false,
                    domain: None,
                    width: 1280,
                    height: 800,
                };
                let outcome =
                    crate::rdp_connect(app.clone(), request, app.state(), app.state()).await;
                serde_json::to_value(outcome.map_err(|_| ServiceError::failed())?)
            }
        }
        .map_err(|_| ServiceError::failed())?;
        if outcome["outcome"] == "connected" {
            Ok(())
        } else {
            Err(connection_error(&outcome))
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    struct RefusingBook {
        attempts: Arc<AtomicUsize>,
    }
    impl ConnectionBook for RefusingBook {
        fn profiles(&self) -> Vec<ConnectionProfile> {
            vec![ConnectionProfile {
                id: "saved".into(),
                name: "Test".into(),
                protocol: Protocol::Sftp,
                hostname: "private.invalid".into(),
                username: "private-user".into(),
                port: 22,
                environment: Environment::Development,
                group: String::new(),
                tags: vec![],
                favorite: false,
                device_id: None,
                relay_address: None,
                machine_id: None,
            }]
        }
        fn connect(&self, _: ConnectionProfile) -> ConnectFuture {
            self.attempts.fetch_add(1, Ordering::Relaxed);
            Box::pin(async {
                Err(ServiceError::new(
                    "credential_required",
                    "Save credentials first.",
                ))
            })
        }
    }

    #[tokio::test]
    async fn saved_connections_require_the_book_and_deduplicate_failed_authentication() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let service = Arc::new(
            DesktopService::new(Arc::new(SshRegistry::new()), Arc::new(SftpRegistry::new()))
                .with_connection_book(Arc::new(RefusingBook {
                    attempts: attempts.clone(),
                })),
        );
        let operation = |profile: &str| DesktopOperation::ConnectSaved {
            profile_id: profile.into(),
            request_id: "request".into(),
        };
        service.share_connection_book(false);
        assert_eq!(
            service
                .execute("client", operation("saved"))
                .await
                .unwrap_err()
                .code,
            "not_authorized"
        );
        service.share_connection_book(true);
        assert_eq!(
            service
                .execute("client", operation("missing"))
                .await
                .unwrap_err()
                .code,
            "not_found"
        );
        assert_eq!(attempts.load(Ordering::Relaxed), 0);
        for _ in 0..2 {
            assert_eq!(
                service
                    .execute("client", operation("saved"))
                    .await
                    .unwrap_err()
                    .code,
                "credential_required"
            );
        }
        assert_eq!(attempts.load(Ordering::Relaxed), 1);
        service.share_connection_book(false);
        assert_eq!(
            service
                .execute("client", operation("saved"))
                .await
                .unwrap_err()
                .code,
            "not_authorized"
        );
        assert_eq!(attempts.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn connection_failures_do_not_expose_transport_details() {
        for outcome in [
            json!({"outcome":"hostUnknown","host":"private.invalid","fingerprint":"secret"}),
            json!({"outcome":"hostChanged","host":"private.invalid"}),
            json!({"outcome":"authFailed"}),
            json!({"outcome":"failed","stage":"credential","detail":"secret-password"}),
            json!({"outcome":"failed","stage":"connect","detail":"private.invalid"}),
        ] {
            let error = connection_error(&outcome);
            assert!(!error.message.contains("private.invalid"));
            assert!(!error.message.contains("secret"));
        }
    }
}
