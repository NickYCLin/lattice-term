//! Fixed passwords use OPAQUE, never a password-derived Noise PSK.
//! Registration is local to the host: neither the password nor its verifier
//! crosses the wire. The ephemeral setup and record live for this handshake.
//! OPAQUE's mutually authenticated session key binds the subsequent Noise
//! channel. Role, protocol and relay device ID are part of the login context.

use crate::secure::{read_wire, write_wire, RemoteError};
use opaque_ke::{
    argon2::Argon2, CipherSuite, ClientLogin, ClientLoginFinishParameters, ClientRegistration,
    ClientRegistrationFinishParameters, CredentialFinalization, CredentialRequest,
    CredentialResponse, ServerLogin, ServerLoginParameters, ServerRegistration, ServerSetup,
};
use rand::rngs::OsRng;
use tokio::io::{AsyncRead, AsyncWrite};
use zeroize::Zeroizing;

pub(crate) const PROLOGUE: &[u8] = b"Lattice Remote v4 OPAQUE password pairing";
const HEADER: &[u8] = b"LTP4";
const ACCOUNT: &[u8] = b"lattice-remote-viewer";

struct Suite;
impl CipherSuite for Suite {
    type OprfCs = opaque_ke::Ristretto255;
    type KeyExchange = opaque_ke::TripleDh<opaque_ke::Ristretto255, sha2_opaque::Sha512>;
    type Ksf = Argon2<'static>;
}

fn context(device_id: Option<&str>) -> Result<Vec<u8>, RemoteError> {
    let mut context = PROLOGUE.to_vec();
    match device_id {
        Some(id) => {
            let id = crate::relay::normalize_device_id(id).map_err(|_| RemoteError::Pairing)?;
            context.extend_from_slice(b":relay:");
            context.extend_from_slice(id.as_bytes());
        }
        None => context.extend_from_slice(b":direct"),
    }
    Ok(context)
}

async fn send<S: AsyncWrite + Unpin>(stream: &mut S, message: &[u8]) -> Result<(), RemoteError> {
    let mut frame = HEADER.to_vec();
    frame.extend_from_slice(message);
    write_wire(stream, &frame).await
}

async fn receive<S: AsyncRead + Unpin>(stream: &mut S) -> Result<Vec<u8>, RemoteError> {
    let frame = read_wire(stream).await?;
    if frame.len() > 1024 || !frame.starts_with(HEADER) {
        return Err(RemoteError::Pairing);
    }
    Ok(frame[HEADER.len()..].to_vec())
}

// OPAQUE already returns a pseudorandom 64-byte key. Domain-separated HKDF
// adapts it to Noise's 32-byte PSK; the password is never the hash input here.
fn noise_key(key: &[u8]) -> Zeroizing<[u8; 32]> {
    let mut psk = Zeroizing::new([0u8; 32]);
    hkdf::Hkdf::<sha2_opaque::Sha256>::new(Some(PROLOGUE), key)
        .expand(b"Noise XXpsk3 channel key", psk.as_mut())
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    psk
}

pub(crate) async fn initiate<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    password: &str,
    device_id: Option<&str>,
) -> Result<Zeroizing<[u8; 32]>, RemoteError> {
    let context = context(device_id)?;
    let start = ClientLogin::<Suite>::start(&mut OsRng, password.as_bytes())
        .map_err(|_| RemoteError::Pairing)?;
    send(stream, &start.message.serialize()).await?;
    let response = CredentialResponse::deserialize(&receive(stream).await?)
        .map_err(|_| RemoteError::Pairing)?;
    let finish = start
        .state
        .finish(
            &mut OsRng,
            password.as_bytes(),
            response,
            ClientLoginFinishParameters {
                context: Some(&context),
                ..Default::default()
            },
        )
        .map_err(|_| RemoteError::Pairing)?;
    send(stream, &finish.message.serialize()).await?;
    Ok(noise_key(&finish.session_key))
}

pub(crate) async fn accept<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    password: &str,
    device_id: Option<&str>,
) -> Result<Zeroizing<[u8; 32]>, RemoteError> {
    let context = context(device_id)?;
    // Reject malformed requests before the local Argon2 registration work.
    let request = CredentialRequest::deserialize(&receive(stream).await?)
        .map_err(|_| RemoteError::Pairing)?;
    let setup = ServerSetup::<Suite>::new(&mut OsRng);
    let registration = ClientRegistration::<Suite>::start(&mut OsRng, password.as_bytes())
        .map_err(|_| RemoteError::Pairing)?;
    let response = ServerRegistration::start(&setup, registration.message, ACCOUNT)
        .map_err(|_| RemoteError::Pairing)?;
    let registration = registration
        .state
        .finish(
            &mut OsRng,
            password.as_bytes(),
            response.message,
            ClientRegistrationFinishParameters::default(),
        )
        .map_err(|_| RemoteError::Pairing)?;
    let record = ServerRegistration::finish(registration.message);
    let parameters = ServerLoginParameters {
        context: Some(&context),
        ..Default::default()
    };
    let login = ServerLogin::start(
        &mut OsRng,
        &setup,
        Some(record),
        request,
        ACCOUNT,
        parameters,
    )
    .map_err(|_| RemoteError::Pairing)?;
    send(stream, &login.message.serialize()).await?;
    let proof = CredentialFinalization::deserialize(&receive(stream).await?)
        .map_err(|_| RemoteError::Pairing)?;
    let finish = login
        .state
        .finish(
            proof,
            ServerLoginParameters {
                context: Some(&context),
                ..Default::default()
            },
        )
        .map_err(|_| RemoteError::Pairing)?;
    Ok(noise_key(&finish.session_key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn same_password_produces_fresh_keys_not_a_reusable_proof() {
        let mut previous = None;
        for _ in 0..2 {
            let (mut client, mut server) = tokio::io::duplex(8192);
            let (client, server) = tokio::join!(
                initiate(&mut client, "aB3!xy", None),
                accept(&mut server, "aB3!xy", None)
            );
            let client = client.unwrap();
            assert_eq!(*client, *server.unwrap());
            if let Some(previous) = previous {
                assert_ne!(*client, previous);
            }
            previous = Some(*client);
        }
    }

    #[tokio::test]
    async fn replayed_login_finalization_is_rejected() {
        let password = "aB3!xy";
        let first = ClientLogin::<Suite>::start(&mut OsRng, password.as_bytes()).unwrap();
        let request = first.message.serialize();
        let (mut client, mut server) = tokio::io::duplex(8192);
        let viewer = async {
            send(&mut client, &request).await.unwrap();
            let response =
                CredentialResponse::deserialize(&receive(&mut client).await.unwrap()).unwrap();
            let context = context(None).unwrap();
            let finish = first
                .state
                .finish(
                    &mut OsRng,
                    password.as_bytes(),
                    response,
                    ClientLoginFinishParameters {
                        context: Some(&context),
                        ..Default::default()
                    },
                )
                .unwrap();
            let proof = finish.message.serialize().to_vec();
            send(&mut client, &proof).await.unwrap();
            proof
        };
        let (proof, paired) = tokio::join!(viewer, accept(&mut server, password, None));
        assert!(paired.is_ok());
        let (mut client, mut server) = tokio::io::duplex(8192);
        let replay = async {
            send(&mut client, &request).await.unwrap();
            receive(&mut client).await.unwrap();
            send(&mut client, &proof).await.unwrap();
        };
        let (_, paired) = tokio::join!(replay, accept(&mut server, password, None));
        assert!(paired.is_err());
    }
}
