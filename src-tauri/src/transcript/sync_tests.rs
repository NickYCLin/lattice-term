use super::*;

#[test]
fn session_tools_follow_exact_identity_without_changing_history_or_handoff() {
    let home = tempfile::tempdir().unwrap();
    let path = fixture(home.path(), "tools", 1);
    fixture(home.path(), "other", 1);
    let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
    for payload in [
        serde_json::json!({"type":"function_call","call_id":"exec-1","name":"exec_command","arguments":"{\"command\":\"npm test\"}"}),
        serde_json::json!({"type":"function_call_output","call_id":"exec-1","output":"Exit code: 1\nfailed"}),
        serde_json::json!({"type":"custom_tool_call","call_id":"patch-1","name":"apply_patch","input":"*** Begin Patch\n*** End Patch"}),
        serde_json::json!({"type":"custom_tool_call_output","call_id":"patch-1","name":"apply_patch","output":[{"type":"input_text","text":"patched"},{"type":"input_image","image_url":"private-image"}]}),
    ] {
        writeln!(
            file,
            "\n{}",
            serde_json::json!({"type":"response_item","payload":payload})
        )
        .unwrap();
    }
    let messages =
        read_session_conversation("codex", "", Some("tools"), Some(home.path())).unwrap();
    assert_eq!(messages.len(), 5);
    assert_eq!(
        messages[1].tool.as_ref().unwrap().name.as_deref(),
        Some("exec_command")
    );
    assert_eq!(messages[2].tool.as_ref().unwrap().call_id, "exec-1");
    assert_eq!(messages[2].tool.as_ref().unwrap().kind, "result");
    assert_eq!(messages[2].text, "Exit code: 1\nfailed");
    assert_eq!(messages[3].tool.as_ref().unwrap().kind, "call");
    assert_eq!(messages[4].text, "patched");
    assert_eq!(
        read_conversation_snapshot(&path, TranscriptKind::Codex)
            .unwrap()
            .messages
            .len(),
        1
    );
    assert!(!parse_codex(&path, 10_000).unwrap().contains("npm test"));
    assert_eq!(
        read_session_conversation("codex", "", Some("other"), Some(home.path()))
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn session_tool_parser_rejects_unknown_rows_and_invalid_shapes() {
    for row in [
        serde_json::json!({"type":"event_msg","payload":{"type":"function_call","call_id":"id","name":"exec","arguments":"input"}}),
        serde_json::json!({"type":"response_item","payload":{"type":"reasoning","call_id":"id","name":"exec","arguments":"private"}}),
        serde_json::json!({"type":"response_item","payload":{"type":"function_call","call_id":"","name":"exec","arguments":"input"}}),
        serde_json::json!({"type":"response_item","payload":{"type":"function_call","call_id":"id","name":"exec\ncommand","arguments":"input"}}),
        serde_json::json!({"type":"response_item","payload":{"type":"function_call","call_id":"id","name":"exec","arguments":{"command":"input"}}}),
        serde_json::json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"id","output":{"unknown":"private"}}}),
    ] {
        assert!(codex_conversation_tool(&row).is_none());
    }
    let row = serde_json::json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"id","output":""}});
    assert!(codex_conversation_tool(&row).is_some());
}

#[test]
fn session_tool_snapshots_keep_existing_count_and_text_limits() {
    let home = tempfile::tempdir().unwrap();
    let path = fixture(home.path(), "bounded", 0);
    let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
    for index in 0..=HISTORY_MAX_MESSAGES {
        writeln!(
            file,
            "\n{}",
            serde_json::json!({"type":"response_item","payload":{
                "type":"function_call_output","call_id":format!("call-{index}"),"output":"output"
            }})
        )
        .unwrap();
    }
    let snapshot =
        read_conversation_snapshot_with_tools(&path, TranscriptKind::Codex, true).unwrap();
    assert!(snapshot.truncated);
    assert_eq!(snapshot.messages.len(), HISTORY_MAX_MESSAGES);
    assert_eq!(
        snapshot.messages[0].tool.as_ref().unwrap().call_id,
        "call-1"
    );
    writeln!(file, "\n{}", serde_json::json!({"type":"response_item","payload":{
        "type":"function_call_output","call_id":"huge","output":"x".repeat(HISTORY_MAX_TEXT_BYTES + 1)
    }})).unwrap();
    let snapshot =
        read_conversation_snapshot_with_tools(&path, TranscriptKind::Codex, true).unwrap();
    assert!(snapshot.truncated);
    assert!(snapshot.messages.is_empty());
}

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

fn scan_options() -> HistoryScanOptions {
    HistoryScanOptions {
        all: false,
        archived: false,
        retained: 100,
    }
}

fn write_rows(path: &Path, rows: &[serde_json::Value]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let rows = rows.iter().map(ToString::to_string).collect::<Vec<_>>();
    fs::write(path, rows.join("\n")).unwrap();
}

#[test]
fn gemini_history_lists_only_main_chats_with_a_visible_prompt() {
    let home = tempfile::tempdir().unwrap();
    let project = home.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let tmp = home.path().join("tmp");
    let chats = tmp.join("hash").join("chats");
    fs::create_dir_all(&chats).unwrap();
    fs::write(
        tmp.join("hash").join(".project_root"),
        project.to_string_lossy().as_bytes(),
    )
    .unwrap();
    write_rows(
        &chats.join("session-main.jsonl"),
        &[
            serde_json::json!({"sessionId":"gemini-main","kind":"main"}),
            serde_json::json!({"id":"u1","type":"user","content":[{"text":"整理發布流程\n細節"}]}),
            serde_json::json!({"id":"m1","type":"gemini","content":[{"text":"好的"}]}),
            serde_json::json!({"id":"t1","type":"tool","content":[{"text":"不應出現"}]}),
        ],
    );
    write_rows(
        &chats.join("session-sub.jsonl"),
        &[
            serde_json::json!({"sessionId":"gemini-sub","kind":"subagent"}),
            serde_json::json!({"id":"u1","type":"user","content":[{"text":"子任務"}]}),
        ],
    );
    write_rows(
        &chats.join("session-empty.jsonl"),
        &[
            serde_json::json!({"sessionId":"gemini-empty"}),
            serde_json::json!({"id":"u1","type":"user","content":[{"text":"/help"}]}),
        ],
    );
    let mut entries = Vec::new();
    let mut incomplete = false;
    scan_local_conversations(
        TranscriptKind::Gemini,
        &tmp,
        None,
        &mut entries,
        scan_options(),
        &mut incomplete,
    )
    .unwrap();
    assert!(!incomplete);
    assert_eq!(entries.len(), 1);
    let (entry, path) = &entries[0];
    assert_eq!(entry.definition_id, "gemini");
    assert_eq!(entry.native_session_id, "gemini-main");
    assert!(entry.resumable);
    assert_eq!(
        Path::new(&entry.working_directory),
        fs::canonicalize(&project).unwrap()
    );
    assert_eq!(
        history_preview(path, TranscriptKind::Gemini).as_deref(),
        Some("整理發布流程")
    );
    let snapshot = read_conversation_snapshot(path, TranscriptKind::Gemini).unwrap();
    let roles = snapshot
        .messages
        .iter()
        .map(|message| (message.role, message.text.as_str()))
        .collect::<Vec<_>>();
    assert_eq!(
        roles,
        [("user", "整理發布流程\n細節"), ("assistant", "好的")]
    );
}

#[test]
fn antigravity_history_follows_prompt_history_and_skips_detached_brains() {
    let home = tempfile::tempdir().unwrap();
    let project = home.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let root = home.path().join("antigravity-cli");
    let main_id = "11111111-2222-3333-4444-555555555555";
    let detached_id = "66666666-7777-8888-9999-aaaaaaaaaaaa";
    write_rows(
        &root.join("history.jsonl"),
        &[
            serde_json::json!({"type":"slash_command","display":"/model"}),
            serde_json::json!({"conversationId":main_id,"workspace":project}),
            serde_json::json!({"conversationId":"../escape","workspace":project}),
        ],
    );
    let transcript = |id: &str| {
        root.join("brain")
            .join(id)
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl")
    };
    write_rows(
        &transcript(main_id),
        &[
            serde_json::json!({"status":"DONE","source":"USER_EXPLICIT","type":"USER_INPUT","content":"檢查模型清單"}),
            serde_json::json!({"status":"RUNNING","source":"MODEL","type":"PLANNER_RESPONSE","content":"草稿"}),
            serde_json::json!({"status":"DONE","source":"MODEL","type":"TOOL_CALL","content":"工具輸出"}),
            serde_json::json!({"status":"DONE","source":"MODEL","type":"PLANNER_RESPONSE","content":"已確認"}),
        ],
    );
    write_rows(
        &transcript(detached_id),
        &[
            serde_json::json!({"status":"DONE","source":"USER_EXPLICIT","type":"USER_INPUT","content":"子代理"}),
        ],
    );
    let mut entries = Vec::new();
    let mut incomplete = false;
    scan_antigravity_conversations(&root, &mut entries, scan_options(), &mut incomplete).unwrap();
    assert!(!incomplete);
    assert_eq!(entries.len(), 1);
    let (entry, path) = &entries[0];
    assert_eq!(entry.definition_id, "antigravity");
    assert_eq!(entry.native_session_id, main_id);
    assert!(entry.resumable);
    assert_eq!(
        history_preview(path, TranscriptKind::Antigravity).as_deref(),
        Some("檢查模型清單")
    );
    let snapshot = read_conversation_snapshot(path, TranscriptKind::Antigravity).unwrap();
    let roles = snapshot
        .messages
        .iter()
        .map(|message| (message.role, message.text.as_str()))
        .collect::<Vec<_>>();
    assert_eq!(roles, [("user", "檢查模型清單"), ("assistant", "已確認")]);
    assert!(antigravity_transcript(&root, "../escape").is_none());
    assert!(antigravity_transcript(&root, detached_id).is_some());
}

#[test]
fn gemini_family_history_is_never_borrowed_for_an_account_profile() {
    let profile = tempfile::tempdir().unwrap();
    fs::create_dir_all(profile.path().join("tmp")).unwrap();
    fs::create_dir_all(profile.path().join("antigravity-cli")).unwrap();
    for kind in [TranscriptKind::Gemini, TranscriptKind::Antigravity] {
        assert!(history_root(kind, Some(profile.path())).is_none());
        assert!(history_root_with_archive(kind, None, true).is_none());
    }
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
