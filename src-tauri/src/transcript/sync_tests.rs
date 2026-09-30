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
fn history_pages_exclude_internal_and_empty_records_before_applying_the_limit() {
    ONLY_PROFILE_HISTORY.with(|flag| flag.set(true));
    let home = tempfile::tempdir().unwrap();
    let root = home.path();
    // Internal jobs outnumber actual conversations, as in a desktop account
    // that has used agent delegation. They must not crowd the first page out.
    for i in 0..120 {
        super::tests::write_codex_rollout(
            &root.join(format!("sessions/rollout-internal-{i}.jsonl")),
            &format!("internal-{i}"),
            root,
            if i % 2 == 0 {
                serde_json::json!({"subagent":{"thread_spawn":{}}})
            } else {
                serde_json::json!("exec")
            },
            "Codex Desktop",
            200,
        );
    }
    fixture(root, "empty", 0);
    let context_only = fixture(root, "context-only", 0);
    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(&context_only)
        .unwrap();
    writeln!(file, "\n{}", serde_json::json!({"type":"response_item","payload":{
        "type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>machine</environment_context>"}]
    }})).unwrap();
    fixture(root, "real", 1);
    let archived = root.join("archived_sessions/rollout-archive.jsonl");
    super::tests::write_codex_rollout(
        &archived,
        "archive",
        root,
        serde_json::json!("vscode"),
        "Codex Desktop",
        300,
    );
    let page = local_conversation_page(&profiles(root), 1, false).unwrap();
    assert_eq!(page.entries.len(), 1);
    assert_eq!(page.entries[0].native_session_id, "real");
    assert!(!page.has_more);
    let all = local_conversation_page(&profiles(root), 10, true).unwrap();
    assert_eq!(all.entries.len(), 2);
    assert!(all
        .entries
        .iter()
        .any(|entry| entry.archived && !entry.resumable));
    assert!(archived.is_file());
    assert!(root.join("sessions/rollout-empty.jsonl").is_file());
}

#[test]
fn uncertain_or_image_only_history_is_not_mistaken_for_an_empty_session() {
    let home = tempfile::tempdir().unwrap();
    let path = fixture(home.path(), "image", 0);
    let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
    writeln!(
        file,
        "\n{}",
        serde_json::json!({"type":"response_item","payload":{
            "type":"message","role":"user","content":[{"type":"input_image","image_url":"fixture"}]
        }})
    )
    .unwrap();
    assert!(codex_history_may_have_user_input(&path));
    fs::write(&path, "{incomplete").unwrap();
    assert!(codex_history_may_have_user_input(&path));
    fs::write(&path, "x".repeat(256 * 1024 + 1)).unwrap();
    assert!(codex_history_may_have_user_input(&path));
}

#[test]
fn growing_pages_pass_the_old_1024_limit_without_launching_or_modifying_history() {
    ONLY_PROFILE_HISTORY.with(|flag| flag.set(true));
    let home = tempfile::tempdir().unwrap();
    for i in 0..1025 {
        fixture(home.path(), &format!("id-{i:04}"), 1);
    }
    let entries = profiles(home.path());
    let first = local_conversation_page(&entries, 100, false).unwrap();
    assert_eq!(first.entries.len(), 100);
    assert!(first.has_more);
    assert!(!first.incomplete);
    let all = local_conversation_page(&entries, 1100, false).unwrap();
    assert_eq!(all.entries.len(), 1025);
    assert!(!all.has_more);
    assert_eq!(
        fs::read_dir(home.path().join("sessions")).unwrap().count(),
        1025
    );
    let again = local_conversation_page(&entries, 100, false).unwrap();
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
    let page = local_conversation_page(&entries, 100, false).unwrap();
    let item = page
        .entries
        .iter()
        .find(|e| e.profile_id.as_deref() == Some("test"))
        .unwrap();
    assert_eq!(item.title, "新名稱");
    assert_eq!(
        read_local_conversation_snapshot("codex", "shared-id", Some("test"), &entries)
            .unwrap()
            .archived,
        Some(false)
    );
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
    let active = local_conversation_page(&entries, 100, false).unwrap();
    assert_eq!(active.entries.len(), 1);
    assert_eq!(active.entries[0].profile_id.as_deref(), Some("other"));
    let archived = local_conversation_page(&entries, 100, true).unwrap();
    let item = archived
        .entries
        .iter()
        .find(|e| e.profile_id.as_deref() == Some("test"))
        .unwrap();
    assert!(item.archived);
    assert!(!item.resumable);
    assert_eq!(
        read_local_conversation_snapshot("codex", "shared-id", Some("test"), &entries)
            .unwrap()
            .archived,
        Some(true)
    );
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
