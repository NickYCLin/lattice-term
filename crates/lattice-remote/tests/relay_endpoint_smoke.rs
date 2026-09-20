//! End-to-end smoke test for a deployed TCP, ws://, or wss:// relay.
//!
//! ```sh
//! LATTICE_RELAY_SMOKE_ENDPOINT=wss://relay.example.com \
//!   cargo test --manifest-path crates/lattice-remote/Cargo.toml \
//!   --test relay_endpoint_smoke -- --ignored --nocapture
//! ```

use lattice_remote::relay::{
    dial, read_server_message, write_client_message, DeviceIdentity, RelayClientMessage,
    RelayServerMessage,
};
use lattice_remote::{RemoteMessage, SecureConnection, Transport};
use std::env;
use std::time::Duration;
use tokio::time::timeout;

const DEFAULT_PAIRING_CODE: &str = "90000001";
const STEP_TIMEOUT: Duration = Duration::from_secs(20);

#[tokio::test]
#[ignore = "requires LATTICE_RELAY_SMOKE_ENDPOINT and network access"]
async fn deployed_endpoint_links_a_noise_encrypted_session() {
    let endpoint = env::var("LATTICE_RELAY_SMOKE_ENDPOINT")
        .expect("Set LATTICE_RELAY_SMOKE_ENDPOINT to the relay endpoint.");
    let pairing_code =
        env::var("LATTICE_RELAY_SMOKE_CODE").unwrap_or_else(|_| DEFAULT_PAIRING_CODE.to_string());
    let identity = DeviceIdentity::generate().expect("could not create a smoke-test identity");

    let mut control = timeout(STEP_TIMEOUT, Transport::connect(&endpoint))
        .await
        .expect("the relay did not answer registration in time")
        .expect("could not connect the test agent to the relay");
    write_client_message(
        &mut control,
        &RelayClientMessage::Register {
            device_id: identity.device_id.clone(),
            auth_token: identity.auth_token.clone(),
            agent_name: "Lattice relay smoke test".to_string(),
        },
    )
    .await
    .expect("could not register the test agent");
    assert_eq!(
        timeout(STEP_TIMEOUT, read_server_message(&mut control))
            .await
            .expect("the relay did not confirm registration in time")
            .expect("the relay dropped the registration"),
        RelayServerMessage::Registered {
            protocol: lattice_remote::relay::RELAY_PROTOCOL
        }
    );
    println!("registered temporary device on {endpoint}");

    let agent_endpoint = endpoint.clone();
    let agent_code = pairing_code.clone();
    let agent_identity = identity.clone();
    let agent = tokio::spawn(async move {
        let RelayServerMessage::Invite { channel_id } =
            timeout(STEP_TIMEOUT, read_server_message(&mut control))
                .await
                .expect("the agent did not receive an invite in time")
                .expect("the agent control connection closed")
        else {
            panic!("the relay sent an unexpected control message");
        };
        let mut session = timeout(STEP_TIMEOUT, Transport::connect(&agent_endpoint))
            .await
            .expect("the agent session connection timed out")
            .expect("the agent could not open its session connection");
        let static_key = agent_identity
            .noise_private_bytes()
            .expect("the test identity key is invalid");
        write_client_message(
            &mut session,
            &RelayClientMessage::Join {
                channel_id,
                device_id: agent_identity.device_id.clone(),
                auth_token: agent_identity.auth_token.clone(),
            },
        )
        .await
        .expect("the agent could not join the invited channel");
        assert!(matches!(
            timeout(STEP_TIMEOUT, read_server_message(&mut session))
                .await
                .expect("the relay did not link the agent in time")
                .expect("the relay dropped the agent session"),
            RelayServerMessage::Linked { .. }
        ));
        let mut secure =
            SecureConnection::accept_with_static_key(session, &agent_code, &static_key)
                .await
                .expect("the agent could not complete the Noise handshake");
        assert_eq!(
            secure.receive().await.expect("the agent received nothing"),
            RemoteMessage::KeepAlive
        );
        secure
            .send(&RemoteMessage::KeepAlive)
            .await
            .expect("the agent could not reply");
    });

    let (viewer_stream, _) = timeout(STEP_TIMEOUT, dial(&endpoint, &identity.device_id))
        .await
        .expect("the viewer dial timed out")
        .expect("the relay could not link the viewer");
    let mut viewer = timeout(
        STEP_TIMEOUT,
        SecureConnection::initiate(viewer_stream, &pairing_code),
    )
    .await
    .expect("the viewer Noise handshake timed out")
    .expect("the viewer could not complete the Noise handshake");
    assert!(viewer.remote_static_key().is_some());
    viewer
        .send(&RemoteMessage::KeepAlive)
        .await
        .expect("the viewer could not send");
    assert_eq!(
        timeout(STEP_TIMEOUT, viewer.receive())
            .await
            .expect("the agent reply timed out")
            .expect("the viewer received nothing"),
        RemoteMessage::KeepAlive
    );
    agent.await.expect("the agent task failed");
    println!("end-to-end encrypted round trip succeeded through {endpoint}");
}
