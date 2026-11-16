//! Content-free diagnostics. Never include native row contents or full paths.
use super::{additional, open_regular_transcript_handle_result, redact, TranscriptKind};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadDiagnostics {
    pub skipped_rows: u64,
    pub reasons: BTreeMap<String, u64>,
    pub partial: bool,
}
impl ReadDiagnostics {
    pub fn skip(&mut self, reason: &str) {
        self.skipped_rows += 1;
        *self.reasons.entry(reason.into()).or_default() += 1;
        self.partial = true;
    }
}
pub fn cli(kind: TranscriptKind) -> &'static str {
    match kind {
        TranscriptKind::Codex => "Codex",
        TranscriptKind::Claude => "Claude Code",
        TranscriptKind::Gemini => "Gemini CLI",
        TranscriptKind::Antigravity => "Antigravity",
        TranscriptKind::Cursor => "Cursor",
        TranscriptKind::Qwen => "Qwen Code",
        TranscriptKind::Copilot => "GitHub Copilot CLI",
        TranscriptKind::Grok => "Grok CLI",
        TranscriptKind::Kimi => "Kimi CLI",
        TranscriptKind::OpenCode => "OpenCode",
    }
}
pub fn unrecognized(path: &Path) -> &'static str {
    use std::io::Read;
    let mut prefix = [0u8; 4096];
    if let Ok(mut file) = open_regular_transcript_handle_result(path) {
        if let Ok(count) = file.read(&mut prefix) {
            if std::str::from_utf8(&prefix[..count]).is_err_and(|error| error.error_len().is_some())
            {
                return "decode";
            }
        }
    }
    "native.unsupportedFormat"
}
pub fn failure(kind: TranscriptKind, path: &Path, error: &str) -> String {
    if error.starts_with("native.read:") {
        return error.into();
    }
    let physical = additional::physical(path);
    let denied = open_regular_transcript_handle_result(physical)
        .is_err_and(|error| error.kind() == std::io::ErrorKind::PermissionDenied);
    let reason = if denied {
        "permission"
    } else if error == "empty" || std::fs::metadata(physical).is_ok_and(|m| m.len() == 0) {
        "empty"
    } else if error.contains("size") || error.contains("limit") {
        "size_limit"
    } else if error == "decode" || error.contains("decode JSON") || error.contains("compressed") {
        "decode"
    } else if error.contains("changed") {
        "changed"
    } else if error == "native.unsupportedFormat" || error == "unsupported_version" {
        "unsupported_version"
    } else if error == "no_readable_records" {
        "no_readable_records"
    } else if std::fs::symlink_metadata(physical)
        .is_err_and(|e| e.kind() == std::io::ErrorKind::PermissionDenied)
        || std::fs::metadata(physical).is_ok_and(|m| {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                m.permissions().mode() & 0o444 == 0
            }
            #[cfg(not(unix))]
            {
                let _ = m;
                false
            }
        })
    {
        "permission"
    } else if !physical.exists() {
        "unavailable"
    } else {
        "read"
    };
    let file = physical
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("transcript");
    let file: String = redact::text(file)
        .chars()
        .filter(|c| !c.is_control())
        .take(160)
        .collect();
    format!(
        "native.read:{}",
        serde_json::json!({"cli":cli(kind),"file":file,"reason":reason})
    )
}
