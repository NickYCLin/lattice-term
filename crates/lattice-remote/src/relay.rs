//! Rendezvous protocol for the optional lattice-relay server.
//!
//! The relay matches a viewer to an agent by a nine-digit device ID and then
//! forwards bytes blindly in both directions. Everything after the `Linked`
//! message is the ordinary end-to-end Noise handshake and session, so the
//! relay never holds a pairing code, a session key, or any plaintext.
//!
//! Control messages travel as JSON in the same `u32` length framing as the
//! encrypted transport, which keeps the server a single simple protocol.

use crate::wire::{read_wire, write_wire};
use crate::Transport;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use snow::{params::NoiseParams, Builder};
use std::io::Write as _;
use std::path::Path;
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncWrite};
use url::Url;

pub const DEFAULT_RELAY_PORT: u16 = 44_910;
const DEVICE_ID_DIGITS: usize = 9;
const MAX_DEVICE_ID_INPUT_BYTES: usize = 32;
pub const MAX_RELAY_AUTH_TOKEN_BYTES: usize = 256;

#[derive(Debug, Error)]
pub enum RelayError {
    #[error("device ID must contain exactly nine digits")]
    InvalidDeviceId,
    #[error("relay address must be HOST[:PORT], ws://URL, or wss://URL")]
    InvalidRelayAddress,
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("the relay connection closed")]
    Closed,
    #[error("the relay sent an unexpected message")]
    Protocol,
    #[error("{detail}")]
    Rejected { code: String, detail: String },
    #[error("identity error: {0}")]
    Identity(String),
}

impl From<crate::RemoteError> for RelayError {
    fn from(error: crate::RemoteError) -> Self {
        match error {
            crate::RemoteError::ConnectionClosed => RelayError::Closed,
            crate::RemoteError::Io(io) => RelayError::Io(io),
            _ => RelayError::Protocol,
        }
    }
}

/// What this build's relay understands. An agent only uses the newer
/// messages when the relay announced at least the level that added them.
pub const RELAY_PROTOCOL: u32 = 1;

/// Messages a client (agent or viewer) sends to the relay.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RelayClientMessage {
    /// An agent claims its device ID and waits for invites on this connection.
    Register {
        device_id: String,
        auth_token: String,
        agent_name: String,
    },
    /// An agent answers an invite on a fresh connection; the relay links it
    /// with the waiting viewer.
    Join {
        channel_id: String,
        device_id: String,
        auth_token: String,
    },
    /// A viewer asks to reach the device with this ID.
    Dial {
        device_id: String,
    },
    /// An agent that cannot take another session says so at once, so the
    /// viewer hears "busy" instead of waiting out the join timer.
    Decline {
        channel_id: String,
    },
    Ping,
}

/// Messages the relay sends back to a client.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RelayServerMessage {
    Registered {
        /// What this relay understands beyond the original messages. Zero is
        /// a relay old enough not to send the field at all.
        #[serde(default)]
        protocol: u32,
    },
    /// Sent on an agent's register connection when a viewer dials it.
    Invite {
        channel_id: String,
    },
    /// Both sides of a channel receive this; every byte after it is relayed
    /// blindly to the peer.
    Linked {
        agent_name: String,
    },
    Pong,
    Error {
        code: String,
        detail: String,
    },
}

pub async fn write_client_message<W: AsyncWrite + Unpin>(
    stream: &mut W,
    message: &RelayClientMessage,
) -> Result<(), RelayError> {
    let bytes = serde_json::to_vec(message).map_err(|_| RelayError::Protocol)?;
    write_wire(stream, &bytes).await.map_err(RelayError::from)
}

pub async fn read_client_message<R: AsyncRead + Unpin>(
    stream: &mut R,
) -> Result<RelayClientMessage, RelayError> {
    let bytes = read_wire(stream).await?;
    serde_json::from_slice(&bytes).map_err(|_| RelayError::Protocol)
}

pub async fn write_server_message<W: AsyncWrite + Unpin>(
    stream: &mut W,
    message: &RelayServerMessage,
) -> Result<(), RelayError> {
    let bytes = serde_json::to_vec(message).map_err(|_| RelayError::Protocol)?;
    write_wire(stream, &bytes).await.map_err(RelayError::from)
}

pub async fn read_server_message<R: AsyncRead + Unpin>(
    stream: &mut R,
) -> Result<RelayServerMessage, RelayError> {
    let bytes = read_wire(stream).await?;
    serde_json::from_slice(&bytes).map_err(|_| RelayError::Protocol)
}

/// Validates and normalizes a relay endpoint. Raw TCP addresses default to
/// port 44910; WebSocket URLs retain their path so multiple services can share
/// one HTTPS hostname.
pub fn normalize_relay_endpoint(input: &str) -> Result<String, RelayError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(RelayError::InvalidRelayAddress);
    }

    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("ws://") || lower.starts_with("wss://") {
        let parsed = Url::parse(trimmed).map_err(|_| RelayError::InvalidRelayAddress)?;
        if parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.fragment().is_some()
            || parsed.port() == Some(0)
        {
            return Err(RelayError::InvalidRelayAddress);
        }
        return Ok(parsed.to_string());
    }
    if trimmed.contains("://") {
        return Err(RelayError::InvalidRelayAddress);
    }

    let parsed =
        Url::parse(&format!("tcp://{trimmed}")).map_err(|_| RelayError::InvalidRelayAddress)?;
    if parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !matches!(parsed.path(), "" | "/")
    {
        return Err(RelayError::InvalidRelayAddress);
    }
    let port = parsed.port().unwrap_or(DEFAULT_RELAY_PORT);
    if port == 0 {
        return Err(RelayError::InvalidRelayAddress);
    }
    let host = parsed.host_str().ok_or(RelayError::InvalidRelayAddress)?;
    let authority = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    Ok(authority)
}

pub fn normalize_device_id(input: &str) -> Result<String, RelayError> {
    if input.is_empty()
        || input.len() > MAX_DEVICE_ID_INPUT_BYTES
        || !input
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'-' | b' '))
    {
        return Err(RelayError::InvalidDeviceId);
    }
    let digits: String = input
        .chars()
        .filter(|character| *character != '-' && *character != ' ')
        .collect();
    if digits.len() == DEVICE_ID_DIGITS && digits.bytes().all(|byte| byte.is_ascii_digit()) {
        Ok(digits)
    } else {
        Err(RelayError::InvalidDeviceId)
    }
}

/// Renders "123456789" as the human-friendly "123 456 789".
pub fn format_device_id(device_id: &str) -> String {
    if device_id.len() != DEVICE_ID_DIGITS {
        return device_id.to_string();
    }
    format!(
        "{} {} {}",
        &device_id[..3],
        &device_id[3..6],
        &device_id[6..]
    )
}

/// Fresh cryptographically random bytes, drawn from the same X25519 keypair
/// source the pairing code uses, so no extra RNG dependency is needed.
fn random_bytes() -> Result<[u8; 32], RelayError> {
    let params: NoiseParams = "Noise_XXpsk3_25519_ChaChaPoly_BLAKE2s"
        .parse()
        .map_err(|_| RelayError::Protocol)?;
    let keypair = Builder::new(params)
        .generate_keypair()
        .map_err(|_| RelayError::Protocol)?;
    keypair.private[..32]
        .try_into()
        .map_err(|_| RelayError::Protocol)
}

pub fn random_token() -> Result<String, RelayError> {
    let bytes = random_bytes()?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub fn random_channel_id() -> Result<String, RelayError> {
    random_token()
}

/// Hash stored by the relay so a registered device ID cannot be claimed by
/// anyone who does not hold the original token.
pub fn hash_token(token: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"lattice-relay-token-v1:");
    digest.update(token.as_bytes());
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// A device's permanent relay identity: the nine-digit ID people type, the
/// secret token that proves ownership of that ID to the relay, and the Noise
/// static key that lets viewers pin this device across sessions. Neither
/// secret leaves the device: the relay only ever stores a token hash, and the
/// Noise handshake transmits just the public half of the key.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentity {
    pub device_id: String,
    pub auth_token: String,
    /// Hex-encoded X25519 private key. Empty only in identity files written
    /// by older builds; `load_or_create` upgrades those in place.
    #[serde(default)]
    pub noise_private: String,
}

fn decode_hex(input: &str) -> Result<Vec<u8>, RelayError> {
    if !input.len().is_multiple_of(2) || !input.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(RelayError::Identity(
            "the identity key is not valid hex".to_string(),
        ));
    }
    (0..input.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&input[index..index + 2], 16)
                .map_err(|_| RelayError::Identity("the identity key is not valid hex".to_string()))
        })
        .collect()
}

impl DeviceIdentity {
    pub fn generate() -> Result<Self, RelayError> {
        let bytes = random_bytes()?;
        let seed = u64::from_be_bytes(bytes[..8].try_into().map_err(|_| RelayError::Protocol)?);
        Ok(Self {
            device_id: format!("{:09}", seed % 1_000_000_000),
            auth_token: random_token()?,
            noise_private: random_token()?,
        })
    }

    /// The device's permanent Noise static private key.
    pub fn noise_private_bytes(&self) -> Result<Vec<u8>, RelayError> {
        let bytes = decode_hex(&self.noise_private)?;
        if bytes.len() != 32 {
            return Err(RelayError::Identity(
                "the identity key has the wrong length".to_string(),
            ));
        }
        Ok(bytes)
    }

    fn write(&self, path: &Path) -> Result<(), RelayError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| RelayError::Identity(error.to_string()))?;
        }
        let json = serde_json::to_vec_pretty(self)
            .map_err(|error| RelayError::Identity(error.to_string()))?;
        let mut options = std::fs::OpenOptions::new();
        options.create(true).truncate(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(path)
            .map_err(|error| RelayError::Identity(error.to_string()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(|error| RelayError::Identity(error.to_string()))?;
        }
        file.write_all(&json)
            .and_then(|()| file.sync_all())
            .map_err(|error| RelayError::Identity(error.to_string()))
    }

    fn protect_file(_path: &Path) -> Result<(), RelayError> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(_path, std::fs::Permissions::from_mode(0o600))
                .map_err(|error| RelayError::Identity(error.to_string()))?;
        }
        Ok(())
    }

    /// Loads the identity file, creating it on first use so the device keeps
    /// the same ID across restarts. Files from builds without a Noise key
    /// gain one here, keeping their device ID and token.
    pub fn load_or_create(path: &Path) -> Result<Self, RelayError> {
        match std::fs::metadata(path) {
            Ok(_) => Self::protect_file(path)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(RelayError::Identity(error.to_string())),
        }
        match std::fs::read(path) {
            Ok(bytes) => {
                let mut identity: Self = serde_json::from_slice(&bytes)
                    .map_err(|error| RelayError::Identity(error.to_string()))?;
                normalize_device_id(&identity.device_id)?;
                if identity.auth_token.trim().is_empty()
                    || identity.auth_token.len() > MAX_RELAY_AUTH_TOKEN_BYTES
                {
                    return Err(RelayError::Identity(
                        "the identity file has a missing or oversized token".to_string(),
                    ));
                }
                if identity.noise_private.trim().is_empty() {
                    identity.noise_private = random_token()?;
                    identity.write(path)?;
                }
                identity.noise_private_bytes()?;
                Ok(identity)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let identity = Self::generate()?;
                identity.write(path)?;
                Ok(identity)
            }
            Err(error) => Err(RelayError::Identity(error.to_string())),
        }
    }
}

/// Viewer-side rendezvous: connects to the relay, dials a device ID, and
/// returns the linked stream plus the agent's advertised name. The caller
/// then runs the ordinary Noise handshake over the returned stream.
pub async fn dial(endpoint: &str, device_id: &str) -> Result<(Transport, String), RelayError> {
    let device_id = normalize_device_id(device_id)?;
    let endpoint = normalize_relay_endpoint(endpoint)?;
    let mut stream = Transport::connect(&endpoint).await?;
    write_client_message(&mut stream, &RelayClientMessage::Dial { device_id }).await?;
    match read_server_message(&mut stream).await? {
        RelayServerMessage::Linked { agent_name } => Ok((stream, agent_name)),
        RelayServerMessage::Error { code, detail } => Err(RelayError::Rejected { code, detail }),
        _ => Err(RelayError::Protocol),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_ids_normalize_and_format() {
        assert_eq!(normalize_device_id("123 456 789").unwrap(), "123456789");
        assert_eq!(normalize_device_id("123-456-789").unwrap(), "123456789");
        assert!(normalize_device_id("12345678").is_err());
        assert!(normalize_device_id("12345678a").is_err());
        assert!(normalize_device_id("123\n456789").is_err());
        assert!(normalize_device_id(&format!(
            "{}123456789",
            "-".repeat(MAX_DEVICE_ID_INPUT_BYTES)
        ))
        .is_err());
        assert_eq!(format_device_id("123456789"), "123 456 789");
    }

    #[test]
    fn identity_files_reject_oversized_authentication_tokens() {
        let directory = std::env::temp_dir().join(format!(
            "lattice-relay-invalid-identity-{}-{}",
            std::process::id(),
            random_token().unwrap()
        ));
        let path = directory.join("identity.json");
        std::fs::create_dir_all(&directory).unwrap();
        let json = serde_json::json!({
            "deviceId": "123456789",
            "authToken": "a".repeat(MAX_RELAY_AUTH_TOKEN_BYTES + 1),
            "noisePrivate": random_token().unwrap(),
        });
        std::fs::write(&path, serde_json::to_vec(&json).unwrap()).unwrap();

        assert!(matches!(
            DeviceIdentity::load_or_create(&path),
            Err(RelayError::Identity(_))
        ));
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn an_identity_file_without_a_noise_key_gains_one_in_place() {
        let directory = std::env::temp_dir().join(format!(
            "lattice-relay-migrate-{}-{}",
            std::process::id(),
            random_token().unwrap()
        ));
        let path = directory.join("identity.json");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            &path,
            br#"{"deviceId":"123456789","authToken":"legacy-token"}"#,
        )
        .unwrap();

        let upgraded = DeviceIdentity::load_or_create(&path).unwrap();
        assert_eq!(upgraded.device_id, "123456789");
        assert_eq!(upgraded.auth_token, "legacy-token");
        assert_eq!(upgraded.noise_private_bytes().unwrap().len(), 32);

        // The upgrade is persisted, and the key stays put afterwards.
        let reloaded = DeviceIdentity::load_or_create(&path).unwrap();
        assert_eq!(reloaded.noise_private, upgraded.noise_private);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn generated_identity_is_stable_on_disk() {
        let directory = std::env::temp_dir().join(format!(
            "lattice-relay-identity-{}-{}",
            std::process::id(),
            random_token().unwrap()
        ));
        let path = directory.join("identity.json");
        let first = DeviceIdentity::load_or_create(&path).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        let second = DeviceIdentity::load_or_create(&path).unwrap();
        assert_eq!(first.device_id, second.device_id);
        assert_eq!(first.auth_token, second.auth_token);
        assert_eq!(first.device_id.len(), 9);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn relay_endpoints_are_normalized_and_default_the_tcp_port() {
        assert_eq!(
            normalize_relay_endpoint("relay.example.com").unwrap(),
            "relay.example.com:44910"
        );
        assert_eq!(
            normalize_relay_endpoint("relay.example.com:5000").unwrap(),
            "relay.example.com:5000"
        );
        assert_eq!(
            normalize_relay_endpoint("203.0.113.7:44910").unwrap(),
            "203.0.113.7:44910"
        );
        assert_eq!(
            normalize_relay_endpoint("wss://relay.example.com/lattice").unwrap(),
            "wss://relay.example.com/lattice"
        );
        assert_eq!(
            normalize_relay_endpoint("[2001:db8::1]:44910").unwrap(),
            "[2001:db8::1]:44910"
        );
        assert!(normalize_relay_endpoint("").is_err());
        assert!(normalize_relay_endpoint(":5000").is_err());
        assert!(normalize_relay_endpoint("host:notaport").is_err());
        assert!(normalize_relay_endpoint("https://relay.example.com").is_err());
        assert!(normalize_relay_endpoint("wss://user@relay.example.com").is_err());
    }

    #[test]
    fn control_messages_round_trip_as_camel_case_json() {
        let message = RelayClientMessage::Register {
            device_id: "123456789".to_string(),
            auth_token: "token".to_string(),
            agent_name: "Desk".to_string(),
        };
        let json = serde_json::to_value(&message).unwrap();
        assert_eq!(json["kind"], "register");
        assert_eq!(json["deviceId"], "123456789");
        let back: RelayClientMessage = serde_json::from_value(json).unwrap();
        assert_eq!(back, message);
    }

    #[test]
    fn token_hashes_are_stable_and_hide_the_token() {
        let hash = hash_token("secret");
        assert_eq!(hash, hash_token("secret"));
        assert_ne!(hash, hash_token("other"));
        assert!(!hash.contains("secret"));
        assert_eq!(hash.len(), 64);
    }
}
