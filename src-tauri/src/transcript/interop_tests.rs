//! Official Codex rollout interop: LatticeTerm reads; it must not rewrite.
use super::*;
use serde_json::json;
use std::io::Write;

fn official_codex_rollout(user: &str, assistant: &str) -> String {
    [
        json!({"timestamp":"2026-11-17T00:00:00.000Z","type":"session_meta","payload":{
            "id":"interop-session","cwd":"/synthetic","source":"cli","originator":"codex-desktop"
        }}),
        json!({"timestamp":"2026-11-17T00:00:01.000Z","type":"response_item","payload":{
            "type":"message","role":"user","content":[{"type":"input_text","text":user}]
        }}),
        json!({"timestamp":"2026-11-17T00:00:02.000Z","type":"response_item","payload":{
            "type":"message","role":"assistant","content":[{"type":"output_text","text":assistant}]
        }}),
    ]
    .into_iter()
    .map(|row| format!("{row}\n"))
    .collect()
}

fn official_codex_turn(user: &str, assistant: &str) -> String {
    [
        json!({"timestamp":"2026-11-17T00:01:00.000Z","type":"response_item","payload":{
            "type":"message","role":"user","content":[{"type":"input_text","text":user}]
        }}),
        json!({"timestamp":"2026-11-17T00:01:01.000Z","type":"response_item","payload":{
            "type":"message","role":"assistant","content":[{"type":"output_text","text":assistant}]
        }}),
    ]
    .into_iter()
    .map(|row| format!("{row}\n"))
    .collect()
}

#[test]
fn official_codex_rollout_prefix_stays_byte_identical_when_a_later_turn_is_appended() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rollout-interop-session.jsonl");
    let original = official_codex_rollout("from desktop", "desktop reply");
    fs::write(&path, &original).unwrap();
    let first = normalized::recent(&path, TranscriptKind::Codex).unwrap();
    assert!(first.messages.iter().any(|row| row.text == "from desktop"));
    assert!(first.messages.iter().any(|row| row.text == "desktop reply"));
    assert_eq!(fs::read(&path).unwrap(), original.as_bytes());

    let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
    file.write_all(official_codex_turn("from lattice", "lattice reply").as_bytes())
        .unwrap();
    drop(file);
    let after_append = fs::read(&path).unwrap();
    assert_eq!(&after_append[..original.len()], original.as_bytes());

    let second = normalized::recent(&path, TranscriptKind::Codex).unwrap();
    assert!(second.messages.iter().any(|row| row.text == "from desktop"));
    assert!(second
        .messages
        .iter()
        .any(|row| row.text == "desktop reply"));
    assert!(second.messages.iter().any(|row| row.text == "from lattice"));
    assert!(second
        .messages
        .iter()
        .any(|row| row.text == "lattice reply"));
    assert_eq!(fs::read(&path).unwrap(), after_append);
}

#[test]
fn official_codex_rollout_is_readable_when_write_protected() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rollout-readonly.jsonl");
    let original = official_codex_rollout("readonly prompt", "readonly reply");
    fs::write(&path, &original).unwrap();
    let mut permissions = fs::metadata(&path).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&path, permissions).unwrap();
    let snapshot = normalized::recent(&path, TranscriptKind::Codex).unwrap();
    assert!(snapshot
        .messages
        .iter()
        .any(|row| row.text == "readonly prompt"));
    assert!(snapshot
        .messages
        .iter()
        .any(|row| row.text == "readonly reply"));
    assert_eq!(fs::read(&path).unwrap(), original.as_bytes());
}
