//! Opt-in acceptance against an operator-selected relay, using the built Agent.
use super::*;
use lattice_remote::{
    chat_protocol::{ChatOperation, ChatRequest},
    relay::{dial, DeviceIdentity},
    RemoteMessage, SecureConnection, Transport,
};
use std::{
    io::Write,
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};

struct AgentProcess(Child);
impl Drop for AgentProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
struct Relay {
    wire: tokio::sync::Mutex<Option<SecureConnection<Transport>>>,
    endpoint: String,
    device: String,
    code: String,
    fingerprint: String,
    bridge: Arc<crate::remote_chat_host::Bridge>,
    _agent: AgentProcess,
    next: AtomicU64,
}
pub(super) struct TestAccess {
    access: Arc<Access>,
    relay: Option<Relay>,
}
async fn connect(
    endpoint: &str,
    device: &str,
    code: &str,
    pin: Option<&str>,
) -> SecureConnection<Transport> {
    let (wire, _) = dial(endpoint, device).await.expect("relay dial failed");
    let mut wire = SecureConnection::initiate_for_target(wire, code, pin, Some(device))
        .await
        .expect("authenticated handshake failed");
    loop {
        if let RemoteMessage::Hello(hello) = wire.receive().await.unwrap() {
            assert!(hello.fleet && hello.terminal);
            assert!(!hello.chat && !hello.cli && hello.view_only && !hello.file_transfer);
            break;
        }
    }
    wire
}
impl TestAccess {
    pub(super) async fn new(access: Arc<Access>, enabled: bool, temp: &std::path::Path) -> Self {
        if !enabled {
            return Self {
                access,
                relay: None,
            };
        }
        let endpoint = std::env::var("LATTICE_RELAY_SMOKE_ENDPOINT")
            .expect("set the acceptance relay endpoint");
        let executable =
            std::env::var("LATTICE_FLEET_ACCEPTANCE_AGENT").expect("set the built Agent path");
        assert!(std::path::Path::new(&executable).is_absolute());
        let identity_path = temp.join("acceptance-identity.json");
        let identity = DeviceIdentity::load_or_create(&identity_path).unwrap();
        let code = lattice_remote::generate_pairing_code().unwrap();
        let bridge = crate::remote_chat_host::Bridge::fleet_fixture(access.clone()).await;
        let mut command = Command::new(executable);
        command
            .args([
                "--relay",
                &endpoint,
                "--terminal",
                "--pair-code-stdin",
                "--identity",
            ])
            .arg(&identity_path)
            .env("LATTICE_CHAT_BRIDGE", &bridge.address)
            .env("LATTICE_CHAT_TOKEN", &bridge.token)
            .env("LATTICE_CHAT_ALLOWED", "0")
            .env("LATTICE_CLI_ALLOWED", "0")
            .env("LATTICE_FLEET_ALLOWED", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut agent = AgentProcess(command.spawn().unwrap());
        writeln!(agent.0.stdin.take().unwrap(), "{code}").unwrap();
        // Allow the real Agent to establish its registration, without dialing a
        // production device or reusing any saved pairing/identity material.
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert!(
            agent.0.try_wait().unwrap().is_none(),
            "Agent exited before registration"
        );
        let wire = tokio::time::timeout(
            Duration::from_secs(30),
            connect(&endpoint, &identity.device_id, &code, None),
        )
        .await
        .unwrap();
        let fingerprint =
            lattice_remote::device_pins::fingerprint(&wire.remote_static_key().unwrap());
        Self {
            access,
            relay: Some(Relay {
                wire: tokio::sync::Mutex::new(Some(wire)),
                endpoint,
                device: identity.device_id,
                code,
                fingerprint,
                bridge,
                _agent: agent,
                next: AtomicU64::new(1),
            }),
        }
    }
    pub(super) async fn perform(&self, request: FleetRequest) -> Result<Value, String> {
        let Some(relay) = &self.relay else {
            return self.access.perform(request).await;
        };
        let id = request
            .action
            .get("requestId")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("read-{}", relay.next.fetch_add(1, Ordering::Relaxed)));
        let request = ChatRequest {
            id: id.clone(),
            operation: ChatOperation::Fleet { request },
        };
        let mut guard = relay.wire.lock().await;
        let wire = guard.as_mut().unwrap();
        wire.send(&RemoteMessage::ChatRequest(request))
            .await
            .map_err(|_| "send failed")?;
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                if let RemoteMessage::ChatResponse(response) =
                    wire.receive().await.map_err(|_| "receive failed")?
                {
                    assert_eq!(response.id, id);
                    assert!(response.valid());
                    assert!(serde_json::to_vec(&response).unwrap().len() <= 60 * 1024);
                    return match response.error {
                        Some(error) => Err(error),
                        None => Ok(response.value),
                    };
                }
            }
        })
        .await
        .map_err(|_| "response timed out".to_owned())?
    }
    pub(super) async fn reconnect(&self) {
        let Some(relay) = &self.relay else {
            return;
        };
        let mut guard = relay.wire.lock().await;
        drop(guard.take());
        tokio::time::sleep(Duration::from_millis(200)).await;
        *guard = Some(
            tokio::time::timeout(
                Duration::from_secs(30),
                connect(
                    &relay.endpoint,
                    &relay.device,
                    &relay.code,
                    Some(&relay.fingerprint),
                ),
            )
            .await
            .unwrap(),
        );
    }
    pub(super) fn revoke(&self) {
        self.access.revoke();
        // Stop the host bridge as the sharing UI does, leaving the encrypted
        // Agent connection alive long enough to observe rejected requests.
        if let Some(relay) = &self.relay {
            relay.bridge.stop();
        }
    }
}
