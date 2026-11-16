use regex::{Regex, RegexBuilder};
use serde::Deserialize;
use serde_json::Value;
use std::path::Path;
use std::sync::OnceLock;

#[derive(Deserialize)]
struct Rule {
    pattern: String,
    flags: String,
}
fn rules() -> &'static Vec<Regex> {
    static RULES: OnceLock<Vec<Regex>> = OnceLock::new();
    RULES.get_or_init(|| {
        serde_json::from_str::<Vec<Rule>>(include_str!(
            "../../../src/security/transcriptRedaction.json"
        ))
        .expect("bundled redaction rules")
        .into_iter()
        .map(|rule| {
            RegexBuilder::new(&rule.pattern)
                .case_insensitive(rule.flags.contains('i'))
                .build()
                .expect("valid bundled rule")
        })
        .collect()
    })
}
pub fn text(input: &str) -> String {
    rules().iter().fold(input.to_owned(), |value, rule| {
        rule.replace_all(&value, "[REDACTED]").into_owned()
    })
}
pub fn value(value: &mut Value) {
    match value {
        Value::String(raw) => *raw = text(raw),
        Value::Array(items) => items.iter_mut().for_each(self::value),
        Value::Object(map) => {
            for (key, value) in map.iter_mut() {
                let name = key.to_ascii_lowercase().replace(['_', '-'], "");
                if matches!(
                    name.as_str(),
                    "password"
                        | "passwd"
                        | "pwd"
                        | "token"
                        | "accesstoken"
                        | "refreshtoken"
                        | "apikey"
                        | "secret"
                        | "clientsecret"
                        | "authorization"
                        | "awssecretaccesskey"
                        | "privatekey"
                ) {
                    *value = Value::String("[REDACTED]".into());
                } else {
                    self::value(value);
                }
            }
        }
        _ => {}
    }
}
pub fn forbidden(path: &Path) -> bool {
    path.components()
        .filter_map(|part| part.as_os_str().to_str())
        .any(|part| {
            let name = part.to_ascii_lowercase();
            matches!(
                name.as_str(),
                "auth.json"
                    | "credentials"
                    | "credentials.json"
                    | ".credentials.json"
                    | "keychain"
                    | "keychain.json"
                    | "oauth_creds.json"
                    | "token_cache"
                    | "tokens.json"
            ) || name.starts_with("credentials.")
                || name.starts_with("keychain.")
                || name.starts_with("token-cache")
                || name.starts_with("token_cache")
                || name == ".env"
                || name.starts_with(".env.")
        })
}

pub fn recent_masker(path: &Path) -> Option<Masker> {
    let mut masker = Masker::default();
    let length = super::open_regular_transcript_handle(path)?
        .metadata()
        .ok()?
        .len();
    if !path.extension().is_some_and(|ext| ext == "zst")
        && length > super::MAX_TRANSCRIPT_FILE_BYTES
    {
        masker
            .prime_prefix(path, length - super::MAX_TRANSCRIPT_TAIL_BYTES)
            .ok()?;
    }
    Some(masker)
}

#[derive(Default)]
pub struct Masker {
    pem: bool,
}
impl Masker {
    // A recent tail can start inside a PEM block. Scan only ASCII boundaries
    // in the discarded prefix, without retaining or parsing its contents.
    pub fn prime_prefix(&mut self, path: &Path, end: u64) -> Result<(), String> {
        use std::io::Read;
        let mut file =
            super::open_regular_transcript_handle(path).ok_or("Transcript unavailable.")?;
        let markers = Regex::new(
            r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----|-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----",
        )
        .expect("PEM boundary rule");
        let mut offset = 0u64;
        let mut carry = Vec::new();
        let mut buffer = [0u8; 65536];
        loop {
            let read = file
                .read(&mut buffer)
                .map_err(|_| "Cannot inspect transcript boundaries.")?;
            if read == 0 {
                break;
            }
            let take = if offset + read as u64 > end {
                buffer[..read]
                    .iter()
                    .enumerate()
                    .find(|(index, byte)| offset + *index as u64 >= end && **byte == b'\n')
                    .map_or(read, |(index, _)| index + 1)
            } else {
                read
            };
            carry.extend_from_slice(&buffer[..take]);
            for marker in markers.find_iter(&String::from_utf8_lossy(&carry)) {
                self.pem = marker.as_str().contains("BEGIN");
            }
            let start = carry.len().saturating_sub(128);
            carry.drain(..start);
            offset += take as u64;
            if offset > end && buffer.get(take.saturating_sub(1)) == Some(&b'\n') {
                break;
            }
        }
        Ok(())
    }

    pub fn text(&mut self, raw: &str) -> String {
        if self.pem {
            if let Some(end) = raw
                .find("-----END ")
                .and_then(|start| raw[start..].find("PRIVATE KEY-----").map(|end| start + end))
            {
                self.pem = false;
                return format!("[REDACTED]{}", text(&raw[end + "PRIVATE KEY-----".len()..]));
            }
            return "[REDACTED]".into();
        }
        if raw.contains("-----BEGIN ")
            && raw.contains("PRIVATE KEY-----")
            && !raw.contains("-----END ")
        {
            self.pem = true;
        }
        text(raw)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn common_secret_formats_are_irreversibly_masked() {
        for raw in [
            "sk-proj-FAKE_SYNTHETIC_12345678901234567890",
            "sk-ant-FAKE_SYNTHETIC_12345678901234567890",
            "AIzaFAKE_SYNTHETIC_12345678901234567890",
            "ghp_FAKESYNTHETIC12345678901234567890",
            "github_pat_FAKE_SYNTHETIC_12345678901234567890",
            "AKIAFAKE123456789012",
            "xoxb-FAKE-SYNTHETIC-1234567890",
            "Bearer FAKE_SYNTHETIC",
            "Authorization: Basic FAKE_SYNTHETIC",
            "https://fake-user:fake-password@example.invalid/",
            "password=FAKE_SYNTHETIC",
            "token=FAKE_SYNTHETIC",
            "-----BEGIN PRIVATE KEY-----\nFAKE_SYNTHETIC\n-----END PRIVATE KEY-----",
        ] {
            let masked = text(raw);
            assert_ne!(masked, raw, "not masked {raw}");
            assert!(!masked.contains("FAKE_SYNTHETIC"));
        }
        assert_eq!(text("ordinary recorded answer"), "ordinary recorded answer");
    }
    #[test]
    fn split_pem_records_fail_closed_until_end_marker() {
        let mut masker = Masker::default();
        assert!(masker
            .text("-----BEGIN PRIVATE KEY-----")
            .contains("REDACTED"));
        assert_eq!(masker.text("short fake fragment"), "[REDACTED]");
        assert_eq!(
            masker.text("-----END PRIVATE KEY-----after"),
            "[REDACTED]after"
        );
        assert_eq!(masker.text("normal"), "normal");
    }
    #[test]
    fn authentication_files_are_never_opened_even_when_alias_is_used() {
        let dir = tempfile::tempdir().unwrap();
        for name in [
            "auth.json",
            "credentials.json",
            ".env",
            ".env.local",
            "oauth_creds.json",
            "tokens.json",
        ] {
            let path = dir.path().join(name);
            std::fs::write(&path, "MUST_NOT_READ").unwrap();
            assert!(super::super::open_regular_transcript_handle(&path).is_none());
        }
        #[cfg(unix)]
        {
            let alias = dir.path().join("session-fake.jsonl");
            std::os::unix::fs::symlink(dir.path().join("auth.json"), &alias).unwrap();
            assert!(super::super::open_regular_transcript_handle(&alias).is_none());
        }
    }
    #[test]
    fn tail_masking_keeps_pem_state_from_discarded_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let mut data = "x".repeat(65520);
        data.push_str("-----BEGIN PRIVATE KEY-----\nshort fragment\nmore body\n-----END PRIVATE KEY-----\nnormal");
        std::fs::write(&path, data).unwrap();
        let mut masker = Masker::default();
        masker.prime_prefix(&path, 65555).unwrap();
        assert_eq!(masker.text("short fragment after tail"), "[REDACTED]");
        assert_eq!(
            masker.text("-----END PRIVATE KEY-----safe"),
            "[REDACTED]safe"
        );
    }
}
