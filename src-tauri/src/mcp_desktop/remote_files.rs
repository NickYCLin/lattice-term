//! One approved file at a time through the host-selected Remote file root.
use super::{cancelled, ServiceError, TransferDirection};
use crate::remote::RemoteRegistry;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;
use tokio::sync::watch;

#[cfg(test)]
const MAX_UPLOAD: u64 = 8 * 1024 * 1024;

pub(super) fn validate(
    direction: TransferDirection,
    local: &str,
    remote: &str,
) -> Result<(), ServiceError> {
    // Slash paths are relative to the *host's shared root*, never its drive.
    if remote.len() > 2048
        || !remote.starts_with('/')
        || remote == "/"
        || remote.contains(['\\', ':'])
        || remote.chars().any(char::is_control)
        || remote
            .split('/')
            .skip(1)
            .any(|part| part.is_empty() || part == "." || part == "..")
        || local.len() > 4096
        || local.chars().any(char::is_control)
    {
        return Err(ServiceError::invalid());
    }
    match direction {
        TransferDirection::Upload if !Path::new(local).is_absolute() => {
            Err(ServiceError::invalid())
        }
        TransferDirection::Download if !local.is_empty() => Err(ServiceError::invalid()),
        _ => Ok(()),
    }
}

/// Snapshot a regular file only after approval; the sent bytes and reported
/// digest refer to this one snapshot even if the source changes afterwards.
fn upload_bytes(path: &str) -> Result<Vec<u8>, ServiceError> {
    super::paths::read_approved_local(path)
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn execute(
    registry: &RemoteRegistry,
    session: &str,
    generation: u64,
    direction: TransferDirection,
    local: &str,
    remote: &str,
    operation_id: &str,
    mut revoked: watch::Receiver<bool>,
    mut cancel: watch::Receiver<bool>,
) -> Result<Value, ServiceError> {
    validate(direction, local, remote)?;
    if *revoked.borrow() || *cancel.borrow() {
        return Err(ServiceError::denied());
    }
    let (files, outbound) = registry
        .mcp_file_access(session, generation)
        .map_err(|_| ServiceError::denied())?;
    let deadline = tokio::time::sleep(Duration::from_secs(60));
    tokio::pin!(deadline);
    let mut transfer_id = None;
    let work = async {
        match direction {
            TransferDirection::Upload => {
                let local = local.to_owned();
                let bytes = tokio::task::spawn_blocking(move || upload_bytes(&local))
                    .await
                    .map_err(|_| ServiceError::failed())??;
                let sha256 = super::sha256(&bytes);
                let (parent, name) = remote.rsplit_once('/').ok_or_else(ServiceError::invalid)?;
                let transfer = files
                    .upload_begin_with_receipt(
                        &outbound,
                        if parent.is_empty() { "/" } else { parent }.into(),
                        name.into(),
                        bytes.len() as u64,
                        false,
                        &mut transfer_id,
                    )
                    .await
                    .map_err(|_| unknown())?;
                for chunk in bytes.chunks(lattice_remote::FILE_CHUNK_SIZE) {
                    files
                        .upload_chunk(&outbound, &transfer.transfer_id, &STANDARD.encode(chunk))
                        .await
                        .map_err(|_| unknown())?;
                }
                files
                    .upload_finish(&outbound, &transfer.transfer_id)
                    .await
                    .map_err(|_| unknown())?;
                Ok(json!({"operationId": operation_id, "state": "completed",
                    "bytes": bytes.len(), "sha256": sha256, "overwrite": false,
                    "hostAcknowledged": true, "remoteHashVerified": false}))
            }
            TransferDirection::Download => {
                let transfer = files
                    .download_start_with_receipt(&outbound, remote.into(), &mut transfer_id)
                    .await
                    .map_err(|_| unknown())?;
                loop {
                    let current = files
                        .transfers()
                        .into_iter()
                        .find(|entry| entry.transfer_id == transfer.transfer_id)
                        .ok_or_else(unknown)?;
                    match current.state {
                        "done" => {
                            return Ok(json!({
                                "operationId": operation_id, "state": "completed",
                                "bytes": current.bytes_done, "localPath": current.local_path,
                                "overwrite": false
                            }))
                        }
                        "error" | "cancelled" => return Err(unknown()),
                        _ => tokio::time::sleep(Duration::from_millis(50)).await,
                    }
                }
            }
        }
    };
    // A cancelled future still owns its pinned connection and transfer ID;
    // stop that transfer, never a newly reconnected session.
    let result = tokio::select! {
        biased;
        _ = cancelled(&mut revoked) => Err(ServiceError::denied()),
        _ = cancelled(&mut cancel) => Err(unknown()),
        _ = &mut deadline => Err(unknown()),
        result = work => result,
    };
    if result.is_err() {
        if let Some(id) = transfer_id {
            let _ =
                tokio::time::timeout(Duration::from_secs(2), files.cancel(&outbound, &id)).await;
        }
    }
    result
}

fn unknown() -> ServiceError {
    ServiceError::new("unknown_outcome",
        "The file transfer did not confirm completion. Inspect its operation and destination before retrying.")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remote_paths_stay_inside_the_shared_root() {
        for path in [
            "/",
            "/../secret",
            "/a/./b",
            "/a//b",
            "/a/",
            "C:/data",
            "/C:/data",
            "/a\\b",
            "/a\nb",
        ] {
            assert!(
                validate(TransferDirection::Download, "", path).is_err(),
                "{path:?}"
            );
        }
        assert!(validate(TransferDirection::Download, "", "/folder/file.zip").is_ok());
        assert!(validate(TransferDirection::Download, "chosen-output", "/file").is_err());
        assert!(validate(TransferDirection::Upload, "relative.txt", "/file").is_err());
    }
    #[test]
    fn uploads_are_snapshots_of_regular_files() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        use std::io::Write;
        file.write_all(b"test payload").unwrap();
        assert_eq!(
            upload_bytes(file.path().to_str().unwrap()).unwrap(),
            b"test payload"
        );
        assert!(upload_bytes(file.path().parent().unwrap().to_str().unwrap()).is_err());
        file.as_file().set_len(MAX_UPLOAD + 1).unwrap();
        assert!(upload_bytes(file.path().to_str().unwrap()).is_err());
    }
}
