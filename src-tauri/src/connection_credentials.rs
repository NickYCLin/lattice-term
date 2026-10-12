use crate::credentials::{self, CredentialKind};
use crate::domain::{ConnectionDraft, ConnectionProfile, Protocol};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialRecordDraft {
    pub secret: Option<String>,
    pub allow_mcp_read: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialRecordStatus {
    pub saved: bool,
    pub allow_mcp_read: bool,
    pub detail: Option<String>,
}

pub fn validate_profile(profile: &ConnectionProfile) -> Result<(), String> {
    let draft = ConnectionDraft {
        name: profile.name.clone(),
        protocol: profile.protocol,
        hostname: profile.hostname.clone(),
        username: profile.username.clone(),
        port: profile.port,
        environment: profile.environment,
        group: Some(profile.group.clone()),
        tags: profile.tags.clone(),
        favorite: profile.favorite,
        device_id: profile.device_id.clone(),
        relay_address: profile.relay_address.clone(),
    };
    if profile.id.is_empty()
        || profile.id.len() > 128
        || !crate::domain::validate_connection_draft(&draft).is_empty()
    {
        return Err("The connection profile is invalid; review its name, endpoint and account before saving.".into());
    }
    Ok(())
}

pub fn specification(profile: &ConnectionProfile) -> Result<(CredentialKind, String), String> {
    Ok(match profile.protocol {
        Protocol::Ssh => (CredentialKind::SshPassword, String::new()),
        Protocol::Sftp => (CredentialKind::SftpPassword, String::new()),
        Protocol::Rdp => (
            CredentialKind::RdpPassword,
            crate::rdp_credential_context(&None),
        ),
        Protocol::Vnc => (CredentialKind::VncPassword, String::new()),
        Protocol::Lattice => (
            CredentialKind::LatticePairingCode,
            crate::lattice_pairing_context(profile)?,
        ),
    })
}

pub fn binding(profile: &ConnectionProfile) -> Result<String, String> {
    let (_, context) = specification(profile)?;
    Ok(credentials::profile_binding_sha256_with_context(
        profile, &context,
    ))
}

pub fn load(profile: &ConnectionProfile) -> Result<Zeroizing<String>, String> {
    let (kind, context) = specification(profile)?;
    credentials::load_bound_with_context(profile, kind, &context).map(Zeroizing::new)
}

pub fn store(profile: &ConnectionProfile, secret: &str) -> Result<(), String> {
    if secret.is_empty() || secret.len() > 16384 {
        return Err("The credential must contain between 1 and 16384 UTF-8 bytes.".to_string());
    }
    let (kind, context) = specification(profile)?;
    credentials::store_bound_with_context(profile, kind, &context, secret)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(protocol: Protocol) -> ConnectionProfile {
        ConnectionProfile {
            id: "test-profile".into(),
            name: "Offline login".into(),
            protocol,
            hostname: "offline.example".into(),
            username: "tester".into(),
            port: protocol.default_port(),
            environment: crate::domain::Environment::Unassigned,
            group: "".into(),
            tags: vec![],
            favorite: false,
            device_id: None,
            relay_address: None,
            machine_id: None,
        }
    }

    #[test]
    fn record_bindings_match_the_existing_connect_flows() {
        for protocol in [Protocol::Ssh, Protocol::Sftp, Protocol::Vnc] {
            let profile = profile(protocol);
            assert_eq!(
                binding(&profile).unwrap(),
                credentials::profile_binding_sha256(&profile)
            );
        }
        let rdp = profile(Protocol::Rdp);
        assert_eq!(
            binding(&rdp).unwrap(),
            credentials::profile_binding_sha256_with_context(&rdp, "rdp-domain:none")
        );
        assert_ne!(
            binding(&rdp).unwrap(),
            credentials::profile_binding_sha256_with_context(&rdp, "rdp-domain:some:4:corp")
        );
    }

    #[test]
    fn pairing_records_require_a_permanent_device_identity() {
        let mut remote = profile(Protocol::Lattice);
        assert!(binding(&remote).is_err());
        remote.device_id = Some("123456789".into());
        let first = binding(&remote).unwrap();
        remote.device_id = Some("987654321".into());
        assert_ne!(first, binding(&remote).unwrap());
    }

    #[test]
    fn empty_and_oversized_secrets_are_rejected_before_storage() {
        let profile = profile(Protocol::Ssh);
        assert!(store(&profile, "").is_err());
        assert!(store(&profile, &"x".repeat(16385)).is_err());
    }

    #[test]
    fn invalid_records_are_rejected_before_any_credential_write() {
        let mut profile = profile(Protocol::Ssh);
        assert!(validate_profile(&profile).is_ok());
        profile.hostname.clear();
        assert!(validate_profile(&profile).is_err());
    }
}
