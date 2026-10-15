#[cfg(test)]
mod tests {
    use base64::{engine::general_purpose::STANDARD, Engine};

    const KEY: &str = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const LEGACY: &str = "untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==";
    const PREHASHED: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==";

    fn verify(key: &str, data: &[u8], signature: &str) -> (bool, bool) {
        let old = minisign_old::PublicKey::from_base64(key).and_then(|key| {
            minisign_old::Signature::decode(signature)
                .and_then(|signature| key.verify(data, &signature, true))
        });
        let new = minisign_new::PublicKey::from_base64(key).and_then(|key| {
            minisign_new::Signature::decode(signature)
                .and_then(|signature| key.verify(data, &signature, true))
        });
        (old.is_ok(), new.is_ok())
    }

    #[test]
    fn legacy_signature_remains_compatible() {
        assert_eq!(verify(KEY, b"test", LEGACY), (true, true));
    }

    #[test]
    fn prehashed_signature_remains_compatible() {
        assert_eq!(verify(KEY, b"test", PREHASHED), (true, true));
    }

    #[test]
    fn modified_artifact_is_rejected() {
        for signature in [LEGACY, PREHASHED] {
            assert_eq!(verify(KEY, b"Test", signature), (false, false));
        }
    }

    #[test]
    fn modified_trusted_comment_is_rejected() {
        for signature in [LEGACY, PREHASHED] {
            assert_eq!(
                verify(KEY, b"test", &signature.replace("file:test", "file:other")),
                (false, false)
            );
        }
    }

    #[test]
    fn wrong_key_is_rejected() {
        let mut key = STANDARD.decode(KEY).unwrap();
        key[10] ^= 1;
        assert_eq!(
            verify(&STANDARD.encode(key), b"test", PREHASHED),
            (false, false)
        );
    }

    #[test]
    fn malformed_signature_is_rejected() {
        assert_eq!(verify(KEY, b"test", "invalid"), (false, false));
    }

    #[test]
    #[ignore = "需明確提供已發行資產、簽章與公開金鑰"]
    fn published_release_asset_remains_compatible() {
        let mut data = std::fs::read(std::env::var("LATTICE_UPDATE_ASSET").unwrap()).unwrap();
        let encoded =
            std::fs::read_to_string(std::env::var("LATTICE_UPDATE_SIGNATURE").unwrap()).unwrap();
        let signature = String::from_utf8(STANDARD.decode(encoded.trim()).unwrap()).unwrap();
        let public_key = String::from_utf8(
            STANDARD
                .decode(std::env::var("LATTICE_UPDATE_PUBLIC_KEY").unwrap())
                .unwrap(),
        )
        .unwrap();
        let old = minisign_old::PublicKey::decode(&public_key).unwrap();
        let new = minisign_new::PublicKey::decode(&public_key).unwrap();
        let old_signature = minisign_old::Signature::decode(&signature).unwrap();
        let new_signature = minisign_new::Signature::decode(&signature).unwrap();
        assert!(old.verify(&data, &old_signature, true).is_ok());
        assert!(new.verify(&data, &new_signature, true).is_ok());
        data[0] ^= 1;
        assert!(old.verify(&data, &old_signature, true).is_err());
        assert!(new.verify(&data, &new_signature, true).is_err());
    }

    #[test]
    fn noncanonical_global_signature_is_rejected_by_both_verifiers() {
        let order = [
            0xed_u8, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9,
            0xde, 0x14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10,
        ];
        for signature in [LEGACY, PREHASHED] {
            let mut lines: Vec<String> = signature.lines().map(str::to_owned).collect();
            let mut global = STANDARD.decode(&lines[3]).unwrap();
            let mut carry = 0_u16;
            for (byte, addend) in global[32..].iter_mut().zip(order) {
                let sum = u16::from(*byte) + u16::from(addend) + carry;
                *byte = sum as u8;
                carry = sum >> 8;
            }
            assert_eq!(carry, 0);
            lines[3] = STANDARD.encode(global);
            assert_eq!(verify(KEY, b"test", &lines.join("\n")), (false, false));
        }
    }
}
