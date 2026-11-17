//! Read-only check: whether the latest Codex native turn has already finished.
use super::*;
use std::io::{Read, Seek, SeekFrom};

const TAIL_CHUNK: usize = 64 * 1024;

/// `Some(true)` when the latest Codex task finished (`task_complete` or
/// `turn_aborted`); `Some(false)` when a `task_started` is still open; `None`
/// when the transcript is missing or has no task boundary.
pub(crate) fn native_turn_receipt(
    definition_id: &str,
    working_directory: &str,
    native_id: &str,
    profile: Option<&Path>,
) -> Option<(PathBuf, bool)> {
    let (kind, path) =
        session_transcript_path(definition_id, working_directory, native_id, profile)
            .ok()
            .flatten()?;
    if kind != TranscriptKind::Codex {
        return None;
    }
    Some((path.clone(), latest_codex_turn_complete(&path)?))
}

pub(crate) fn latest_codex_turn_complete(path: &Path) -> Option<bool> {
    last_codex_task_complete(path).ok().flatten()
}

fn last_codex_task_complete(path: &Path) -> std::io::Result<Option<bool>> {
    let mut file = fs::File::open(path)?;
    let mut pos = file.metadata()?.len();
    let mut carry = Vec::new();
    while pos > 0 {
        let start = pos.saturating_sub(TAIL_CHUNK as u64);
        let size = (pos - start) as usize;
        file.seek(SeekFrom::Start(start))?;
        let mut buf = vec![0; size];
        file.read_exact(&mut buf)?;
        buf.append(&mut carry);
        let (rest, next_carry) = if start > 0 {
            match buf.iter().position(|byte| *byte == b'\n') {
                Some(index) => (buf[index + 1..].to_vec(), buf[..index].to_vec()),
                None => {
                    carry = buf;
                    pos = start;
                    continue;
                }
            }
        } else {
            (buf, Vec::new())
        };
        carry = next_carry;
        for line in rest.split(|byte| *byte == b'\n').rev() {
            if line.is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_slice::<Value>(line) else {
                continue;
            };
            if value["type"] != "event_msg" {
                continue;
            }
            match value["payload"]["type"].as_str() {
                Some("task_complete" | "turn_aborted") => return Ok(Some(true)),
                Some("task_started") => return Ok(Some(false)),
                _ => {}
            }
        }
        pos = start;
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn write_rollout(rows: &[Value]) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout-turn.jsonl");
        let body = rows
            .iter()
            .map(|row| format!("{row}\n"))
            .collect::<String>();
        fs::write(&path, body).unwrap();
        (dir, path)
    }

    fn event(kind: &str, turn: &str) -> Value {
        json!({"type":"event_msg","payload":{"type":kind,"turn_id":turn}})
    }

    #[test]
    fn latest_codex_turn_is_complete_after_task_complete_and_does_not_rewrite() {
        let (_dir, path) = write_rollout(&[
            event("task_started", "first"),
            json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"one"}]}}),
            event("task_complete", "first"),
        ]);
        let before = fs::read(&path).unwrap();
        assert_eq!(latest_codex_turn_complete(&path), Some(true));
        assert_eq!(fs::read(&path).unwrap(), before);
    }

    #[test]
    fn latest_codex_turn_stays_open_after_a_newer_task_started() {
        let (_dir, path) = write_rollout(&[
            event("task_started", "first"),
            event("task_complete", "first"),
            event("task_started", "second"),
        ]);
        assert_eq!(latest_codex_turn_complete(&path), Some(false));
    }

    #[test]
    fn aborted_turn_counts_as_complete() {
        let (_dir, path) = write_rollout(&[
            event("task_started", "first"),
            event("turn_aborted", "first"),
        ]);
        assert_eq!(latest_codex_turn_complete(&path), Some(true));
    }

    #[test]
    fn a_transcript_without_task_boundaries_is_unavailable() {
        let (_dir, path) = write_rollout(&[json!({"type":"session_meta","payload":{"id":"x"}})]);
        assert_eq!(latest_codex_turn_complete(&path), None);
    }

    #[test]
    fn native_turn_receipt_uses_a_profile_root_and_leaves_the_file_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        fs::create_dir_all(&sessions).unwrap();
        let id = "00000000-0000-4000-8000-0000000000aa";
        let path = sessions.join(format!("rollout-{id}.jsonl"));
        let body = [
            json!({"type":"session_meta","payload":{"id":id,"cwd":"/synthetic","source":"cli"}}),
            event("task_started", "one"),
            event("task_complete", "one"),
        ]
        .into_iter()
        .map(|row| format!("{row}\n"))
        .collect::<String>();
        fs::write(&path, &body).unwrap();
        let before = fs::read(&path).unwrap();
        assert_eq!(
            native_turn_receipt("codex", "/synthetic", id, Some(dir.path()))
                .map(|(_, complete)| complete),
            Some(true)
        );
        assert_eq!(fs::read(&path).unwrap(), before);
    }
}
