use super::*;

fn fixture(home: &Path, id: &str, count: usize) -> PathBuf {
    let path = home.join(format!("sessions/rollout-{id}.jsonl"));
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut rows = vec![serde_json::json!({"type":"session_meta","payload":{
        "id":id,"cwd":home,"source":"appServer","originator":"desktop"
    }})
    .to_string()];
    for i in 0..count {
        rows.push(serde_json::json!({"type":"response_item","payload":{
            "type":"message","role":"user","content":[{"type":"input_text","text":format!("{id} message {i}")}]
        }}).to_string());
    }
    fs::write(&path, rows.join("\n")).unwrap();
    path
}

fn profiles(home: &Path) -> Vec<HistoryProfile> {
    vec![HistoryProfile {
        definition_id: "codex".into(),
        profile_id: "test".into(),
        config_directory: home.to_string_lossy().into_owned(),
    }]
}

#[test]
fn growing_pages_pass_the_old_1024_limit_without_launching_or_modifying_history() {
    ONLY_PROFILE_HISTORY.with(|flag| flag.set(true));
    let home = tempfile::tempdir().unwrap();
    for i in 0..1025 {
        fixture(home.path(), &format!("id-{i:04}"), 1);
    }
    let entries = profiles(home.path());
    let first = local_conversation_page(&entries, 100).unwrap();
    assert_eq!(first.entries.len(), 100);
    assert!(first.has_more);
    assert!(!first.incomplete);
    let all = local_conversation_page(&entries, 1100).unwrap();
    assert_eq!(all.entries.len(), 1025);
    assert!(!all.has_more);
    assert_eq!(
        fs::read_dir(home.path().join("sessions")).unwrap().count(),
        1025
    );
    let again = local_conversation_page(&entries, 100).unwrap();
    assert_eq!(
        first
            .entries
            .iter()
            .map(|e| &e.native_session_id)
            .collect::<Vec<_>>(),
        again
            .entries
            .iter()
            .map(|e| &e.native_session_id)
            .collect::<Vec<_>>()
    );
}

#[test]
fn names_archive_and_exact_account_contents_refresh_from_the_source() {
    ONLY_PROFILE_HISTORY.with(|flag| flag.set(true));
    let home = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let path = fixture(home.path(), "shared-id", 1);
    fixture(other.path(), "shared-id", 2);
    let mut entries = profiles(home.path());
    entries.push(HistoryProfile {
        definition_id: "codex".into(),
        profile_id: "other".into(),
        config_directory: other.path().to_string_lossy().into_owned(),
    });
    let index = home.path().join("session_index.jsonl");
    fs::write(&index, "{\"id\":\"shared-id\",\"thread_name\":\"Old name\"}\n{\"id\":\"shared-id\",\"thread_name\":\"新名稱\"}\n").unwrap();
    let before = fs::read(&path).unwrap();
    let page = local_conversation_page(&entries, 100).unwrap();
    let item = page
        .entries
        .iter()
        .find(|e| e.profile_id.as_deref() == Some("test"))
        .unwrap();
    assert_eq!(item.title, "新名稱");
    assert_eq!(item.title_source, "nativeIndex");
    assert_eq!(
        read_local_conversation_snapshot("codex", "shared-id", Some("other"), &entries)
            .unwrap()
            .messages
            .len(),
        2
    );
    assert_eq!(fs::read(&path).unwrap(), before);
    fs::create_dir_all(home.path().join("archived_sessions")).unwrap();
    fs::rename(
        &path,
        home.path()
            .join("archived_sessions/rollout-shared-id.jsonl"),
    )
    .unwrap();
    let archived = local_conversation_page(&entries, 100).unwrap();
    let item = archived
        .entries
        .iter()
        .find(|e| e.profile_id.as_deref() == Some("test"))
        .unwrap();
    assert!(item.archived);
    assert!(!item.resumable);
    assert_eq!(item.title, "新名稱");
    assert_eq!(
        read_session_conversation("codex", "", Some("shared-id"), Some(home.path()))
            .unwrap()
            .len(),
        1
    );
    assert!(
        read_local_conversation_snapshot("codex", "shared-id", Some("missing"), &entries).is_err()
    );
}

#[test]
fn bounded_text_reads_disclose_truncation_and_refresh_appended_messages() {
    let home = tempfile::tempdir().unwrap();
    let path = fixture(home.path(), "large", 301);
    let snapshot = read_conversation_snapshot(&path, TranscriptKind::Codex).unwrap();
    assert!(snapshot.truncated);
    assert_eq!(snapshot.messages.len(), 300);
    assert_eq!(snapshot.messages[0].text, "large message 1");
    assert_eq!(snapshot.messages.last().unwrap().text, "large message 300");
    let path = fixture(home.path(), "small", 1);
    assert!(
        !read_conversation_snapshot(&path, TranscriptKind::Codex)
            .unwrap()
            .truncated
    );
    let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
    writeln!(file, "\n{{\"payload\":{{\"type\":\"message\",\"role\":\"assistant\",\"content\":\"new reply\"}}}}").unwrap();
    let latest = read_conversation_snapshot(&path, TranscriptKind::Codex).unwrap();
    assert_eq!(latest.messages.last().unwrap().text, "new reply");
}
