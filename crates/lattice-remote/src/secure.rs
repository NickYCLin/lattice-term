use crate::{ProtocolError, RemoteMessage};
use sha2::{Digest, Sha256};
use snow::{params::NoiseParams, Builder, TransportState};
use std::sync::{Arc, Mutex};
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncWrite, ReadHalf, WriteHalf};
use tokio::net::TcpStream;
use zeroize::Zeroizing;

pub(crate) use crate::wire::{read_wire, write_wire};

const NOISE_PATTERN: &str = "Noise_XXpsk3_25519_ChaChaPoly_BLAKE2s";
const PROLOGUE: &[u8] = b"Lattice Remote v3 high-entropy pairing";
const LEGACY_PROLOGUE: &[u8] = b"Lattice Remote v2 direct encrypted workspace";
pub const PAIRING_TOKEN_HEX_LENGTH: usize = 32;
const MAX_PLAINTEXT: usize = crate::wire::MAX_WIRE_MESSAGE - 16;

#[derive(Debug, Error)]
pub enum RemoteError {
    #[error("pairing requires 6-64 ASCII characters (case-sensitive letters, numbers or symbols; no spaces), or a generated 32-character hexadecimal token")]
    InvalidPairingCode,
    #[error("Legacy eight-digit pairing requires a previously trusted device ID. This computer has no verified key for that device; use an existing trusted computer or update the host once to establish trust.")]
    LegacyRequiresTrustedDevice,
    #[error("The device identity does not match its trusted key. Pairing was stopped before sending the pairing proof.")]
    PeerIdentityMismatch,
    #[error("connection closed")]
    ConnectionClosed,
    #[error("wire message is too large")]
    MessageTooLarge,
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("secure pairing failed")]
    Pairing,
    #[error("protocol error: {0}")]
    Protocol(#[from] ProtocolError),
}

pub fn normalize_pairing_code(input: &str) -> Result<String, RemoteError> {
    // Only the exact uppercase grouped display of a generated token is a
    // presentation alias. Raw passwords (even 32 hex characters) keep case.
    if input.len() == 39
        && input.split('-').count() == 8
        && input.split('-').all(|part| {
            part.len() == 4
                && part
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
        })
    {
        return Ok(input.replace('-', ""));
    }
    if (6..=64).contains(&input.len()) && input.bytes().all(|byte| byte.is_ascii_graphic()) {
        Ok(input.to_string())
    } else {
        Err(RemoteError::InvalidPairingCode)
    }
}

fn normalize_generated_token(input: &str) -> Option<String> {
    let normalized: String = input
        .chars()
        .filter(|character| *character != '-' && !character.is_ascii_whitespace())
        .collect();
    if normalized.len() == PAIRING_TOKEN_HEX_LENGTH
        && normalized.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        Some(normalized.to_ascii_uppercase())
    } else {
        None
    }
}

/// New viewers use password pairing by default, including six/eight-digit PINs.
pub fn normalize_viewer_pairing_code(input: &str) -> Result<String, RemoteError> {
    normalize_pairing_code(input)
}

/// Only for an explicitly selected legacy connection, never an automatic retry.
pub fn normalize_legacy_pairing_code(input: &str) -> Result<String, RemoteError> {
    if let Some(token) = normalize_generated_token(input) {
        return Ok(token);
    }
    let code: String = input
        .chars()
        .filter(|character| *character != '-' && !character.is_ascii_whitespace())
        .collect();
    if code.len() == 8 && code.bytes().all(|byte| byte.is_ascii_digit()) {
        Ok(code)
    } else {
        Err(RemoteError::InvalidPairingCode)
    }
}

fn pairing_key(input: &str) -> Result<Zeroizing<[u8; 32]>, RemoteError> {
    let code =
        Zeroizing::new(normalize_generated_token(input).ok_or(RemoteError::InvalidPairingCode)?);
    let mut digest = Sha256::new();
    digest.update(b"lattice-remote-pairing-token-v2:");
    digest.update(code.as_bytes());
    Ok(Zeroizing::new(digest.finalize().into()))
}

pub fn generate_pairing_code() -> Result<String, RemoteError> {
    let mut bytes = Zeroizing::new([0u8; 16]);
    getrandom::fill(bytes.as_mut()).map_err(|_| RemoteError::Pairing)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02X}")).collect())
}

/// Display only; callers validate or generate the token before formatting it.
pub fn format_pairing_code(code: &str) -> String {
    if code.len() != 32
        || !code
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
    {
        return code.to_string();
    }
    code.as_bytes()
        .chunks(4)
        .map(String::from_utf8_lossy)
        .collect::<Vec<_>>()
        .join("-")
}

/// An encrypted protocol channel over any byte stream. Direct connections use
/// a plain `TcpStream`; relayed connections hand over the stream after the
/// rendezvous exchange, and the Noise handshake runs end to end regardless.
pub struct SecureConnection<S = TcpStream> {
    stream: S,
    transport: TransportState,
}

impl SecureConnection<crate::Transport> {
    /// Dials a direct TCP connection and wraps it in [`crate::Transport`], so
    /// callers that also accept relayed WebSocket streams share one type.
    pub async fn connect(host: &str, port: u16, pairing_code: &str) -> Result<Self, RemoteError> {
        normalize_pairing_code(pairing_code)?;
        let stream = TcpStream::connect((host, port)).await?;
        stream.set_nodelay(true)?;
        Self::initiate(crate::Transport::from(stream), pairing_code).await
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin + Send> SecureConnection<S> {
    pub async fn initiate(stream: S, pairing_code: &str) -> Result<Self, RemoteError> {
        Self::initiate_for_target(stream, pairing_code, None, None).await
    }

    pub async fn initiate_for_target(
        mut stream: S,
        pairing_code: &str,
        expected_fingerprint: Option<&str>,
        device_id: Option<&str>,
    ) -> Result<Self, RemoteError> {
        let code = Zeroizing::new(normalize_pairing_code(pairing_code)?);
        let psk = crate::password_pairing::initiate(&mut stream, &code, device_id).await?;
        Self::initiate_with_identity(
            stream,
            psk,
            crate::password_pairing::PROLOGUE,
            expected_fingerprint,
        )
        .await
    }

    /// Returning relay viewers may use the old pairing protocol only after
    /// authenticating the host's pinned static key. Never fall back on failure.
    pub async fn initiate_for_device(
        stream: S,
        pairing_code: &str,
        expected_fingerprint: Option<&str>,
    ) -> Result<Self, RemoteError> {
        // Compatibility API for explicitly opted-in, previously pinned v2 hosts.
        // Desktop and CLI default to `initiate_for_target`, never this method.
        let code = Zeroizing::new(normalize_legacy_pairing_code(pairing_code)?);
        if code.len() == 8 {
            let pin = expected_fingerprint
                .filter(|pin| pin.len() == 64 && pin.bytes().all(|byte| byte.is_ascii_hexdigit()))
                .ok_or(RemoteError::LegacyRequiresTrustedDevice)?;
            let mut digest = Sha256::new();
            digest.update(b"lattice-remote-pairing-v1:");
            digest.update(code.as_bytes());
            Self::initiate_with_identity(
                stream,
                Zeroizing::new(digest.finalize().into()),
                LEGACY_PROLOGUE,
                Some(pin),
            )
            .await
        } else {
            Self::initiate_with_identity(
                stream,
                pairing_key(pairing_code)?,
                PROLOGUE,
                expected_fingerprint,
            )
            .await
        }
    }

    async fn initiate_with_identity(
        mut stream: S,
        psk: Zeroizing<[u8; 32]>,
        prologue: &[u8],
        expected_fingerprint: Option<&str>,
    ) -> Result<Self, RemoteError> {
        let params: NoiseParams = NOISE_PATTERN.parse().map_err(|_| RemoteError::Pairing)?;
        let keypair = Builder::new(params.clone())
            .generate_keypair()
            .map_err(|_| RemoteError::Pairing)?;
        let builder = Builder::new(params)
            .prologue(prologue)
            .map_err(|_| RemoteError::Pairing)?
            .local_private_key(&keypair.private)
            .map_err(|_| RemoteError::Pairing)?
            .psk(3, &psk)
            .map_err(|_| RemoteError::Pairing)?;
        let mut handshake = builder
            .build_initiator()
            .map_err(|_| RemoteError::Pairing)?;
        let mut write_buffer = vec![0u8; 1024];
        let mut read_buffer = vec![0u8; 1024];

        let written = handshake
            .write_message(&[], &mut write_buffer)
            .map_err(|_| RemoteError::Pairing)?;
        write_wire(&mut stream, &write_buffer[..written]).await?;

        let response = read_wire(&mut stream).await?;
        handshake
            .read_message(&response, &mut read_buffer)
            .map_err(|_| RemoteError::Pairing)?;

        // XX message 2 includes `s, es`, proving possession of the responder's
        // static private key. Check it BEFORE message 3 (`psk3`): an untrusted
        // responder must never collect a proof for offline guessing of old
        // eight-digit secrets. A post-handshake pin check would be too late.
        if let Some(expected) = expected_fingerprint {
            let key = handshake
                .get_remote_static()
                .ok_or(RemoteError::PeerIdentityMismatch)?;
            if !crate::device_pins::fingerprint(key).eq_ignore_ascii_case(expected) {
                return Err(RemoteError::PeerIdentityMismatch);
            }
        }

        let written = handshake
            .write_message(&[], &mut write_buffer)
            .map_err(|_| RemoteError::Pairing)?;
        write_wire(&mut stream, &write_buffer[..written]).await?;

        let transport = handshake
            .into_transport_mode()
            .map_err(|_| RemoteError::Pairing)?;
        Ok(Self { stream, transport })
    }

    /// Accepts with a throwaway static key: right for one-shot direct
    /// pairing, where nothing outlives the session that a viewer could pin.
    pub async fn accept(stream: S, pairing_code: &str) -> Result<Self, RemoteError> {
        let params: NoiseParams = NOISE_PATTERN.parse().map_err(|_| RemoteError::Pairing)?;
        let keypair = Builder::new(params)
            .generate_keypair()
            .map_err(|_| RemoteError::Pairing)?;
        Self::accept_with_static_key(stream, pairing_code, &keypair.private).await
    }

    /// Accepts with the device's permanent static key, so returning viewers
    /// can pin this device's public identity across sessions.
    pub async fn accept_with_static_key(
        stream: S,
        pairing_code: &str,
        static_private_key: &[u8],
    ) -> Result<Self, RemoteError> {
        Self::accept_for_device(stream, pairing_code, static_private_key, None).await
    }

    pub async fn accept_for_device(
        mut stream: S,
        pairing_code: &str,
        static_private_key: &[u8],
        device_id: Option<&str>,
    ) -> Result<Self, RemoteError> {
        let code = Zeroizing::new(normalize_pairing_code(pairing_code)?);
        let psk = crate::password_pairing::accept(&mut stream, &code, device_id).await?;
        let params: NoiseParams = NOISE_PATTERN.parse().map_err(|_| RemoteError::Pairing)?;
        let builder = Builder::new(params)
            .prologue(crate::password_pairing::PROLOGUE)
            .map_err(|_| RemoteError::Pairing)?
            .local_private_key(static_private_key)
            .map_err(|_| RemoteError::Pairing)?
            .psk(3, &psk)
            .map_err(|_| RemoteError::Pairing)?;
        let mut handshake = builder
            .build_responder()
            .map_err(|_| RemoteError::Pairing)?;
        let mut write_buffer = vec![0u8; 1024];
        let mut read_buffer = vec![0u8; 1024];

        let request = read_wire(&mut stream).await?;
        handshake
            .read_message(&request, &mut read_buffer)
            .map_err(|_| RemoteError::Pairing)?;

        let written = handshake
            .write_message(&[], &mut write_buffer)
            .map_err(|_| RemoteError::Pairing)?;
        write_wire(&mut stream, &write_buffer[..written]).await?;

        let request = read_wire(&mut stream).await?;
        handshake
            .read_message(&request, &mut read_buffer)
            .map_err(|_| RemoteError::Pairing)?;

        let transport = handshake
            .into_transport_mode()
            .map_err(|_| RemoteError::Pairing)?;
        Ok(Self { stream, transport })
    }

    /// The peer's Noise static public key, exchanged during the handshake.
    /// Viewers pin this for relay devices, which keep a permanent key.
    pub fn remote_static_key(&self) -> Option<Vec<u8>> {
        self.transport.get_remote_static().map(<[u8]>::to_vec)
    }

    pub async fn send(&mut self, message: &RemoteMessage) -> Result<(), RemoteError> {
        let encrypted = seal(&mut self.transport, message)?;
        write_wire(&mut self.stream, &encrypted).await
    }

    pub async fn receive(&mut self) -> Result<RemoteMessage, RemoteError> {
        let encrypted = read_wire(&mut self.stream).await?;
        open(&mut self.transport, &encrypted)
    }

    /// Splits the connection so one task can receive while another sends.
    ///
    /// Noise keeps independent cipher states per direction, so this is safe
    /// as long as each direction stays single-tasked — which the halves
    /// enforce by taking `&mut self`. The shared mutex only serialises the
    /// brief non-async encrypt/decrypt calls.
    pub fn split(self) -> (SecureReader<S>, SecureWriter<S>) {
        let (read_half, write_half) = tokio::io::split(self.stream);
        let transport = Arc::new(Mutex::new(self.transport));
        (
            SecureReader {
                stream: read_half,
                transport: Arc::clone(&transport),
            },
            SecureWriter {
                stream: write_half,
                transport,
            },
        )
    }
}

pub struct SecureReader<S = TcpStream> {
    stream: ReadHalf<S>,
    transport: Arc<Mutex<TransportState>>,
}

impl<S: AsyncRead + AsyncWrite + Unpin + Send> SecureReader<S> {
    pub async fn receive(&mut self) -> Result<RemoteMessage, RemoteError> {
        let encrypted = read_wire(&mut self.stream).await?;
        let mut transport = self.transport.lock().map_err(|_| RemoteError::Pairing)?;
        open(&mut transport, &encrypted)
    }
}

pub struct SecureWriter<S = TcpStream> {
    stream: WriteHalf<S>,
    transport: Arc<Mutex<TransportState>>,
}

impl<S: AsyncRead + AsyncWrite + Unpin + Send> SecureWriter<S> {
    pub async fn send(&mut self, message: &RemoteMessage) -> Result<(), RemoteError> {
        let encrypted = {
            let mut transport = self.transport.lock().map_err(|_| RemoteError::Pairing)?;
            seal(&mut transport, message)?
        };
        write_wire(&mut self.stream, &encrypted).await
    }
}

fn seal(transport: &mut TransportState, message: &RemoteMessage) -> Result<Vec<u8>, RemoteError> {
    let plaintext = message.encode()?;
    if plaintext.len() > MAX_PLAINTEXT {
        return Err(RemoteError::MessageTooLarge);
    }
    let mut encrypted = vec![0u8; plaintext.len() + 16];
    let written = transport
        .write_message(&plaintext, &mut encrypted)
        .map_err(|_| RemoteError::Pairing)?;
    encrypted.truncate(written);
    Ok(encrypted)
}

fn open(transport: &mut TransportState, encrypted: &[u8]) -> Result<RemoteMessage, RemoteError> {
    let mut plaintext = vec![0u8; encrypted.len()];
    let read = transport
        .read_message(encrypted, &mut plaintext)
        .map_err(|_| RemoteError::Pairing)?;
    RemoteMessage::decode(&plaintext[..read]).map_err(RemoteError::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{RemoteHello, PROTOCOL_VERSION};
    use tokio::net::TcpListener;

    // Frozen responder recipes from v2/v3. Deliberately do not call the
    // production accept path or reuse its prologue / pairing-key helper.
    async fn legacy_responder(
        mut stream: tokio::io::DuplexStream,
        private_key: &[u8],
    ) -> Result<SecureConnection<tokio::io::DuplexStream>, RemoteError> {
        old_responder(&mut stream, private_key, false)
            .await
            .map(|transport| SecureConnection { stream, transport })
    }

    async fn old_responder(
        stream: &mut tokio::io::DuplexStream,
        private_key: &[u8],
        token: bool,
    ) -> Result<TransportState, RemoteError> {
        let mut digest = Sha256::new();
        digest.update(if token {
            b"lattice-remote-pairing-token-v2:".as_slice()
        } else {
            b"lattice-remote-pairing-v1:".as_slice()
        });
        digest.update(if token {
            b"0123456789ABCDEF0123456789ABCDEF".as_slice()
        } else {
            b"12345678".as_slice()
        });
        let psk: [u8; 32] = digest.finalize().into();
        let mut handshake = Builder::new("Noise_XXpsk3_25519_ChaChaPoly_BLAKE2s".parse().unwrap())
            .prologue(if token {
                b"Lattice Remote v3 high-entropy pairing".as_slice()
            } else {
                b"Lattice Remote v2 direct encrypted workspace".as_slice()
            })
            .unwrap()
            .local_private_key(private_key)
            .unwrap()
            .psk(3, &psk)
            .unwrap()
            .build_responder()
            .unwrap();
        let mut buffer = [0u8; 1024];
        let first = read_wire(stream).await?;
        handshake
            .read_message(&first, &mut buffer)
            .map_err(|_| RemoteError::Pairing)?;
        let written = handshake.write_message(&[], &mut buffer).unwrap();
        write_wire(stream, &buffer[..written]).await?;
        let third = read_wire(stream).await?;
        handshake
            .read_message(&third, &mut buffer)
            .map_err(|_| RemoteError::Pairing)?;
        Ok(handshake.into_transport_mode().unwrap())
    }

    #[tokio::test]
    async fn trusted_v033_host_exchanges_encrypted_hello_and_terminal_data() {
        let keypair = Builder::new(NOISE_PATTERN.parse().unwrap())
            .generate_keypair()
            .unwrap();
        let pin = crate::device_pins::fingerprint(&keypair.public);
        let (viewer, host) = tokio::io::duplex(8192);
        let server = tokio::spawn(async move {
            let mut connection = legacy_responder(host, &keypair.private).await.unwrap();
            connection
                .send(&RemoteMessage::Hello(RemoteHello {
                    protocol_version: 2,
                    agent_name: "v0.33.0 fixture".into(),
                    width: 80,
                    height: 24,
                    view_only: false,
                    file_transfer: false,
                    file_root_label: String::new(),
                    file_edit: false,
                    terminal: true,
                }))
                .await
                .unwrap();
            assert_eq!(
                connection.receive().await.unwrap(),
                RemoteMessage::TerminalInput {
                    bytes: b"pwd\r".to_vec()
                }
            );
            connection
                .send(&RemoteMessage::TerminalData {
                    bytes: b"/shared\r\n".to_vec(),
                })
                .await
                .unwrap();
        });
        let mut connection = SecureConnection::initiate_for_device(viewer, "1234-5678", Some(&pin))
            .await
            .unwrap();
        let RemoteMessage::Hello(hello) = connection.receive().await.unwrap() else {
            panic!("missing Hello")
        };
        assert_eq!(
            crate::negotiate_protocol_version(hello.protocol_version).unwrap(),
            2
        );
        assert!(hello.terminal);
        connection
            .send(&RemoteMessage::TerminalInput {
                bytes: b"pwd\r".to_vec(),
            })
            .await
            .unwrap();
        assert_eq!(
            connection.receive().await.unwrap(),
            RemoteMessage::TerminalData {
                bytes: b"/shared\r\n".to_vec()
            }
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn legacy_unknown_or_invalid_pin_sends_no_handshake() {
        use tokio::io::AsyncReadExt;
        for pin in [None, Some(""), Some("invalid")] {
            let (viewer, mut host) = tokio::io::duplex(8192);
            assert!(matches!(
                SecureConnection::initiate_for_device(viewer, "12345678", pin).await,
                Err(RemoteError::LegacyRequiresTrustedDevice)
            ));
            assert_eq!(host.read(&mut [0u8; 1]).await.unwrap(), 0);
        }
    }

    #[tokio::test]
    async fn legacy_changed_identity_never_receives_psk_proof() {
        let keypair = Builder::new(NOISE_PATTERN.parse().unwrap())
            .generate_keypair()
            .unwrap();
        let (viewer, host) = tokio::io::duplex(8192);
        let server = tokio::spawn(async move { legacy_responder(host, &keypair.private).await });
        let wrong_pin = crate::device_pins::fingerprint(b"a different trusted key");
        assert!(matches!(
            SecureConnection::initiate_for_device(viewer, "12345678", Some(&wrong_pin)).await,
            Err(RemoteError::PeerIdentityMismatch)
        ));
        // The old responder sees EOF while waiting for message 3, not an
        // authentication error after collecting a guessable pairing proof.
        assert!(matches!(
            server.await.unwrap(),
            Err(RemoteError::ConnectionClosed)
        ));
    }

    #[tokio::test]
    async fn legacy_wrong_code_is_rejected_by_the_trusted_host() {
        let keypair = Builder::new(NOISE_PATTERN.parse().unwrap())
            .generate_keypair()
            .unwrap();
        let pin = crate::device_pins::fingerprint(&keypair.public);
        let (viewer, host) = tokio::io::duplex(8192);
        let server = tokio::spawn(async move { legacy_responder(host, &keypair.private).await });
        let mut connection = SecureConnection::initiate_for_device(viewer, "87654321", Some(&pin))
            .await
            .unwrap();
        assert!(matches!(server.await.unwrap(), Err(RemoteError::Pairing)));
        assert!(connection.receive().await.is_err());
    }

    #[tokio::test]
    async fn modern_tokens_never_retry_the_legacy_protocol() {
        let keypair = Builder::new(NOISE_PATTERN.parse().unwrap())
            .generate_keypair()
            .unwrap();
        let pin = crate::device_pins::fingerprint(&keypair.public);
        let (viewer, host) = tokio::io::duplex(8192);
        let server = tokio::spawn(async move { legacy_responder(host, &keypair.private).await });
        assert!(SecureConnection::initiate_for_device(
            viewer,
            "0123456789ABCDEF0123456789ABCDEF",
            Some(&pin)
        )
        .await
        .is_err());
        assert!(server.await.unwrap().is_err());
    }

    #[tokio::test]
    async fn modern_hosts_and_direct_viewers_reject_less_than_six_characters() {
        let (viewer, host) = tokio::io::duplex(8192);
        assert!(matches!(
            SecureConnection::initiate(viewer, "12345").await,
            Err(RemoteError::InvalidPairingCode)
        ));
        assert!(matches!(
            SecureConnection::accept(host, "12345").await,
            Err(RemoteError::InvalidPairingCode)
        ));
        assert!(matches!(
            SecureConnection::connect("127.0.0.1", 1, "12345").await,
            Err(RemoteError::InvalidPairingCode)
        ));
    }

    #[test]
    fn accepts_human_friendly_pairing_code() {
        assert_eq!(
            normalize_pairing_code("0123-4567-89AB-CDEF-0123-4567-89AB-CDEF").unwrap(),
            "0123456789ABCDEF0123456789ABCDEF"
        );
        assert_eq!(
            normalize_legacy_pairing_code(" 0123 4567 89ab cdef 0123 4567 89ab cdef ").unwrap(),
            "0123456789ABCDEF0123456789ABCDEF"
        );
        for password in [
            "123456",
            "1234567",
            "12345678",
            "aB3!xY",
            "aB-3!x",
            "aB'\"`$\\x",
            &"!".repeat(64),
        ] {
            assert_eq!(normalize_pairing_code(password).unwrap(), password);
            assert_eq!(format_pairing_code(password), password);
            assert!(
                pairing_key(password).is_err(),
                "password must never use a static Noise PSK"
            );
        }
        for invalid in [
            "12345",
            "aB 3!xy",
            " aB3!xy",
            "aB3!xy\n",
            "密碼123456",
            "aB3!xy\u{200b}",
            &"!".repeat(65),
        ] {
            assert!(normalize_pairing_code(invalid).is_err());
        }
    }

    #[tokio::test]
    async fn fixed_passwords_pair_and_exchange_encrypted_messages() {
        for password in ["123456", "12345678", "aB3!xY", "aB'\"`$\\x"] {
            let (viewer, host) = tokio::io::duplex(8192);
            let (viewer, host) = tokio::join!(
                SecureConnection::initiate(viewer, password),
                SecureConnection::accept(host, password)
            );
            let mut viewer = viewer.unwrap();
            let mut host = host.unwrap();
            let message = RemoteMessage::KeepAlive;
            viewer.send(&message).await.unwrap();
            assert_eq!(host.receive().await.unwrap(), message);
        }
    }

    #[tokio::test]
    async fn fixed_password_case_mismatch_fails_on_both_ends() {
        let (viewer, host) = tokio::io::duplex(8192);
        let (viewer, host) = tokio::join!(
            SecureConnection::initiate(viewer, "Ab3!xY"),
            SecureConnection::accept(host, "ab3!xy")
        );
        assert!(viewer.is_err());
        assert!(host.is_err());
    }

    #[tokio::test]
    async fn hex_shaped_passwords_still_use_case_sensitive_password_pairing() {
        let (viewer, host) = tokio::io::duplex(8192);
        let mixed_case = "aBcD".repeat(8);
        let uppercase = "ABCD".repeat(8);
        let (viewer, host) = tokio::join!(
            SecureConnection::initiate(viewer, &mixed_case),
            SecureConnection::accept(host, &uppercase)
        );
        assert!(viewer.is_err());
        assert!(host.is_err());
    }

    #[tokio::test]
    async fn explicit_compatibility_still_connects_to_a_v3_token_host() {
        let key = Builder::new(NOISE_PATTERN.parse().unwrap())
            .generate_keypair()
            .unwrap();
        let (viewer, mut host) = tokio::io::duplex(8192);
        let (viewer, transport) = tokio::join!(
            SecureConnection::initiate_for_device(
                viewer,
                "0123-4567-89ab-cdef-0123-4567-89ab-cdef",
                None
            ),
            old_responder(&mut host, &key.private, true)
        );
        let mut viewer = viewer.unwrap();
        let mut host = SecureConnection {
            stream: host,
            transport: transport.unwrap(),
        };
        host.send(&RemoteMessage::KeepAlive).await.unwrap();
        assert_eq!(viewer.receive().await.unwrap(), RemoteMessage::KeepAlive);
    }

    #[tokio::test]
    async fn password_pairing_binds_relay_device_id_and_existing_noise_pin() {
        let params: NoiseParams = NOISE_PATTERN.parse().unwrap();
        let key = Builder::new(params).generate_keypair().unwrap();
        let pin = crate::device_pins::fingerprint(&key.public);
        for (target, expected_pin, succeeds) in [
            ("123456789", pin.clone(), true),
            ("987654321", pin.clone(), false),
            ("123456789", "0".repeat(64), false),
        ] {
            let (viewer, host) = tokio::io::duplex(8192);
            let (viewer, host) = tokio::join!(
                SecureConnection::initiate_for_target(
                    viewer,
                    "aB3!xy",
                    Some(&expected_pin),
                    Some(target)
                ),
                SecureConnection::accept_for_device(
                    host,
                    "aB3!xy",
                    &key.private,
                    Some("123456789")
                )
            );
            assert_eq!(viewer.is_ok(), succeeds);
            assert_eq!(host.is_ok(), succeeds);
        }
    }

    #[tokio::test]
    async fn password_pairing_never_retries_the_legacy_handshake() {
        let (viewer, host) = tokio::io::duplex(8192);
        let params: NoiseParams = NOISE_PATTERN.parse().unwrap();
        let key = Builder::new(params).generate_keypair().unwrap();
        let pin = crate::device_pins::fingerprint(&key.public);
        let (viewer, host) = tokio::join!(
            SecureConnection::initiate_for_target(viewer, "12345678", Some(&pin), None),
            legacy_responder(host, &key.private)
        );
        assert!(viewer.is_err());
        assert!(host.is_err());
    }

    #[test]
    fn generated_pairing_token_uses_128_random_bits() {
        let code = generate_pairing_code().unwrap();
        assert_eq!(code.len(), 32);
        assert!(code.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(code, generate_pairing_code().unwrap());
        assert_eq!(
            normalize_pairing_code(&format_pairing_code(&code)).unwrap(),
            code
        );
    }

    #[tokio::test]
    async fn encrypted_peers_exchange_protocol_messages() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut secure = SecureConnection::accept(stream, "0123456789ABCDEF0123456789ABCDEF")
                .await
                .unwrap();
            secure
                .send(&RemoteMessage::Hello(RemoteHello {
                    protocol_version: PROTOCOL_VERSION,
                    agent_name: "Test agent".into(),
                    width: 640,
                    height: 360,
                    view_only: true,
                    file_transfer: false,
                    file_root_label: String::new(),
                    file_edit: false,
                    terminal: false,
                }))
                .await
                .unwrap();
            assert_eq!(secure.receive().await.unwrap(), RemoteMessage::KeepAlive);
        });

        let stream = TcpStream::connect(address).await.unwrap();
        let mut client =
            SecureConnection::initiate(stream, "0123-4567-89AB-CDEF-0123-4567-89AB-CDEF")
                .await
                .unwrap();
        let hello = client.receive().await.unwrap();
        assert!(matches!(hello, RemoteMessage::Hello(_)));
        client.send(&RemoteMessage::KeepAlive).await.unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn split_halves_exchange_messages_in_both_directions() {
        use crate::{PointerButton, RemoteInput};

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let secure = SecureConnection::accept(stream, "0123456789ABCDEF0123456789ABCDEF")
                .await
                .unwrap();
            let (mut reader, mut writer) = secure.split();
            // Send frames from one task while the other consumes input.
            let sender = tokio::spawn(async move {
                for _ in 0..3 {
                    writer.send(&RemoteMessage::KeepAlive).await.unwrap();
                }
                writer
                    .send(&RemoteMessage::Close("done".into()))
                    .await
                    .unwrap();
            });
            let mut inputs = Vec::new();
            while let Ok(RemoteMessage::Input(input)) = reader.receive().await {
                inputs.push(input);
                if inputs.len() == 2 {
                    break;
                }
            }
            sender.await.unwrap();
            inputs
        });

        let stream = TcpStream::connect(address).await.unwrap();
        let client = SecureConnection::initiate(stream, "0123-4567-89AB-CDEF-0123-4567-89AB-CDEF")
            .await
            .unwrap();
        let (mut reader, mut writer) = client.split();
        writer
            .send(&RemoteMessage::Input(RemoteInput::MouseMove {
                x: 10,
                y: 20,
            }))
            .await
            .unwrap();
        writer
            .send(&RemoteMessage::Input(RemoteInput::MouseButton {
                button: PointerButton::Left,
                pressed: true,
            }))
            .await
            .unwrap();
        let mut closes = 0;
        loop {
            match reader.receive().await.unwrap() {
                RemoteMessage::Close(reason) => {
                    assert_eq!(reason, "done");
                    closes += 1;
                    break;
                }
                RemoteMessage::KeepAlive => {}
                other => panic!("unexpected message: {other:?}"),
            }
        }
        assert_eq!(closes, 1);
        assert_eq!(
            server.await.unwrap(),
            vec![
                RemoteInput::MouseMove { x: 10, y: 20 },
                RemoteInput::MouseButton {
                    button: PointerButton::Left,
                    pressed: true,
                },
            ],
        );
    }

    #[tokio::test]
    async fn a_persistent_static_key_shows_the_same_identity_across_sessions() {
        use crate::relay::DeviceIdentity;

        let identity = DeviceIdentity::generate().unwrap();
        let mut seen = Vec::new();
        for _ in 0..2 {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let key = identity.noise_private_bytes().unwrap();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                SecureConnection::accept_with_static_key(
                    stream,
                    "0123456789ABCDEF0123456789ABCDEF",
                    &key,
                )
                .await
                .unwrap()
            });
            let stream = TcpStream::connect(address).await.unwrap();
            let pin = seen
                .first()
                .map(|key: &Vec<u8>| crate::device_pins::fingerprint(key));
            let client = SecureConnection::initiate_for_target(
                stream,
                "0123456789ABCDEF0123456789ABCDEF",
                pin.as_deref(),
                None,
            )
            .await
            .unwrap();
            seen.push(
                client
                    .remote_static_key()
                    .expect("responder sent a static key"),
            );
            server.await.unwrap();
        }
        assert_eq!(seen[0], seen[1]);

        // A different identity presents a different key.
        let other = DeviceIdentity::generate().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let key = other.noise_private_bytes().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            SecureConnection::accept_with_static_key(
                stream,
                "0123456789ABCDEF0123456789ABCDEF",
                &key,
            )
            .await
            .unwrap()
        });
        let stream = TcpStream::connect(address).await.unwrap();
        let client = SecureConnection::initiate(stream, "0123456789ABCDEF0123456789ABCDEF")
            .await
            .unwrap();
        assert_ne!(seen[0], client.remote_static_key().unwrap());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn wrong_pairing_code_is_rejected_by_responder() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            SecureConnection::accept(stream, "11112222333344445555666677778888").await
        });

        let stream = TcpStream::connect(address).await.unwrap();
        let initiator =
            SecureConnection::initiate(stream, "9999AAAABBBBCCCCDDDDEEEEFFFF0000").await;
        let responder = server.await.unwrap();
        assert!(initiator.is_err());
        assert!(responder.is_err());
    }
}
