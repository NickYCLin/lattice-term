//! Session-owned, bounded, immutable deployment snapshots.
use crate::mcp_desktop::ServiceError;
use serde_json::{json, Value};
use std::io::Write;
use std::sync::Mutex;

fn failed() -> ServiceError {
    ServiceError::new(
        "operation_failed",
        "The RDP deployment snapshot could not be prepared.",
    )
}

pub(super) struct StagingArea {
    directory: tempfile::TempDir,
    published: Mutex<(u64, u32)>,
}

pub(crate) fn valid_name(name: &str) -> bool {
    // Portable Windows leaf names; no traversal, ADS, device aliases or
    // trailing-dot normalization. A single archive can contain a whole site.
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    !name.is_empty()
        && name.len() <= 128
        && !name.starts_with('.')
        && !name.ends_with(['.', ' '])
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        && !matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        )
        && !(stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

impl StagingArea {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            directory: tempfile::Builder::new()
                .prefix("lattice-rdp-stage-")
                .tempdir()
                .map_err(|e| e.to_string())?,
            published: Mutex::new((0, 0)),
        })
    }
    pub fn path(&self) -> String {
        self.directory.path().to_string_lossy().into_owned()
    }
    pub fn publish(
        &self,
        name: &str,
        bytes: &[u8],
        validate: impl FnOnce() -> Result<(), ServiceError>,
    ) -> Result<Value, ServiceError> {
        if !valid_name(name) || bytes.len() > 8 * 1024 * 1024 {
            return Err(ServiceError::invalid());
        }
        let mut count = self.published.lock().map_err(|_| failed())?;
        if count.0 + bytes.len() as u64 > 128 * 1024 * 1024 || count.1 >= 256 {
            return Err(ServiceError::new(
                "capacity",
                "RDP staging is limited to 128 MiB and 256 files per connection. Reconnect to clear it.",
            ));
        }
        // Snapshot outside the redirected directory so partial bytes cannot
        // be observed by the server. persist_noclobber preserves conflicts.
        let mut file = tempfile::NamedTempFile::new().map_err(|_| failed())?;
        file.write_all(bytes)
            .and_then(|_| file.as_file().sync_all())
            .map_err(|_| failed())?;
        validate()?;
        file.persist_noclobber(self.directory.path().join(name)).map_err(|_| ServiceError::new("file_conflict", "The staging name already exists or could not be published. Nothing was overwritten."))?;
        count.0 += bytes.len() as u64;
        count.1 += 1;
        Ok(
            json!({"state":"staged", "bytes":bytes.len(), "remotePath":format!(r"\\tsclient\LatticeDeploy\{name}"), "remoteCopied":false, "remoteHashVerified":false, "overwrite":false}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_windows_aliases_and_non_leaf_names() {
        for name in [
            "", "../a", "a/b", r"a\b", "a:ads", "a.", "a ", "CON.zip", "com1.zip", "LPT9",
            ".hidden",
        ] {
            assert!(!valid_name(name), "{name}");
        }
        assert!(valid_name("site-2026.10.zip"));
    }
    #[test]
    fn stages_complete_snapshots_without_overwriting_and_cleans_up() {
        let area = StagingArea::new().unwrap();
        let path = area.directory.path().to_owned();
        let receipt = area.publish("site.zip", b"site", || Ok(())).unwrap();
        assert_eq!(receipt["remoteCopied"], false);
        assert_eq!(std::fs::read(path.join("site.zip")).unwrap(), b"site");
        assert!(area.publish("site.zip", b"changed", || Ok(())).is_err());
        assert!(area
            .publish("denied.zip", b"denied", || Err(ServiceError::denied()))
            .is_err());
        assert!(!path.join("denied.zip").exists());
        drop(area);
        assert!(!path.exists());
    }

    #[test]
    fn capacity_and_size_limits_apply_before_publication() {
        let area = StagingArea::new().unwrap();
        *area.published.lock().unwrap() = (128 * 1024 * 1024, 1);
        assert_eq!(
            area.publish("full.zip", b"x", || Ok(())).unwrap_err().code,
            "capacity"
        );
        *area.published.lock().unwrap() = (0, 256);
        assert_eq!(
            area.publish("empty.zip", b"", || Ok(())).unwrap_err().code,
            "capacity"
        );
        assert!(!area.directory.path().join("empty.zip").exists());
        assert!(area
            .publish("large.zip", &vec![0; 8 * 1024 * 1024 + 1], || Ok(()))
            .is_err());
    }
}
