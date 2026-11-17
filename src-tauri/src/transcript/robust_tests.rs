//! Synthetic fixtures only. The explicitly ignored audit emits aggregate counts only.
use super::*;
use serde_json::json;
use std::io::Write;
const JSONL_KINDS: [TranscriptKind; 7] = [
    TranscriptKind::Codex,
    TranscriptKind::Claude,
    TranscriptKind::Gemini,
    TranscriptKind::Qwen,
    TranscriptKind::Copilot,
    TranscriptKind::Grok,
    TranscriptKind::Kimi,
];
fn fixture(kind: TranscriptKind) -> String {
    let rows = match kind {
        TranscriptKind::Codex => vec![
            json!({"type":"response_item","unknown":"ignored","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"synthetic request"}]}}),
        ],
        TranscriptKind::Claude => vec![
            json!({"type":"user","unknown":"ignored","message":{"role":"user","content":[{"type":"text","text":"synthetic request"}]}}),
        ],
        TranscriptKind::Gemini => vec![
            json!({"id":"synthetic-user","type":"user","content":"synthetic request","unknown":"ignored"}),
        ],
        TranscriptKind::Qwen => vec![
            json!({"sessionId":"synthetic","version":"0.27.0","cwd":"/synthetic","unknown":"ignored"}),
            json!({"type":"user","message":{"parts":[{"text":"synthetic request","unknown":"ignored"}]}}),
        ],
        TranscriptKind::Copilot => vec![
            json!({"type":"session.start","data":{"sessionId":"synthetic","version":1}}),
            json!({"type":"user.message","unknown":"ignored","data":{"content":"synthetic request"}}),
        ],
        TranscriptKind::Grok => {
            vec![json!({"role":"user","content":"synthetic request","unknown":"ignored"})]
        }
        TranscriptKind::Kimi => vec![
            json!({"type":"metadata","protocol_version":"1.10"}),
            json!({"message":{"type":"TurnBegin","payload":{"user_input":"synthetic request","unknown":"ignored"}}}),
        ],
        _ => unreachable!(),
    };
    rows.into_iter().map(|row| format!("{row}\n")).collect()
}
#[test]
fn seven_jsonl_readers_recover_bad_rows_and_keep_exact_counts() {
    for kind in JSONL_KINDS {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("synthetic.jsonl");
        fs::write(&path, fixture(kind)).unwrap();
        let clean = normalized::recent(&path, kind).unwrap();
        assert_eq!(
            clean.diagnostics.skipped_rows,
            0,
            "{}",
            diagnostics::cli(kind)
        );
        assert!(clean
            .messages
            .iter()
            .any(|row| row.text == "synthetic request"));
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"not-json\n{\"unfinished\":\n\xff\xfe\n42\n")
            .unwrap();
        file.write_all(fixture(kind).as_bytes()).unwrap();
        drop(file);
        let before = fs::read(&path).unwrap();
        for snapshot in [
            normalized::recent(&path, kind).unwrap(),
            normalized::legacy(normalized::page(&path, kind, None, None).unwrap().0),
        ] {
            assert_eq!(
                snapshot.diagnostics.skipped_rows,
                4,
                "{}",
                diagnostics::cli(kind)
            );
            assert_eq!(snapshot.diagnostics.reasons["malformed"], 1);
            assert_eq!(snapshot.diagnostics.reasons["truncated_jsonl"], 1);
            assert_eq!(snapshot.diagnostics.reasons["decode"], 1);
            assert_eq!(snapshot.diagnostics.reasons["invalid_record"], 1);
            assert!(snapshot
                .messages
                .iter()
                .any(|row| row.text == "synthetic request"));
        }
        assert_eq!(fs::read(&path).unwrap(), before);
    }
}
#[test]
fn seven_jsonl_readers_skip_oversized_rows_without_losing_the_next_record() {
    for kind in JSONL_KINDS {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("synthetic.jsonl");
        fs::write(&path, fixture(kind)).unwrap();
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(&vec![b'x'; 24 * 1024 * 1024 + 1]).unwrap();
        writeln!(file).unwrap();
        file.write_all(fixture(kind).as_bytes()).unwrap();
        drop(file);
        let result = normalized::recent(&path, kind).unwrap();
        if kind == TranscriptKind::Codex {
            assert!(result.diagnostics.skipped_rows > 0);
        } else {
            assert_eq!(
                result.diagnostics.reasons["oversized"],
                1,
                "{}",
                diagnostics::cli(kind)
            );
        }
        assert!(result
            .messages
            .iter()
            .any(|row| row.text == "synthetic request"));
    }
}
#[test]
fn file_failures_are_explicit_sanitized_and_do_not_poison_other_sessions() {
    for kind in JSONL_KINDS {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("synthetic.jsonl");
        for data in [b"".as_slice(), b"{\"future_format\":99}\n", b"\xff\xfe\n"] {
            fs::write(&path, data).unwrap();
            let error = normalized::recent(&path, kind).unwrap_err();
            assert!(error.starts_with("native.read:"));
            assert!(error.contains("synthetic.jsonl"));
            assert!(!error.contains(&dir.path().display().to_string()));
            assert!(error.contains(diagnostics::cli(kind)));
            fs::write(dir.path().join("other.jsonl"), fixture(kind)).unwrap();
            assert!(normalized::recent(&dir.path().join("other.jsonl"), kind).is_ok());
        }
    }
}
fn database() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("opencode.db");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("CREATE TABLE session(id TEXT,directory TEXT,parent_id TEXT,time_updated INT);CREATE TABLE message(id TEXT,session_id TEXT,time_created INT,data TEXT);CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,time_created INT,data TEXT);INSERT INTO session VALUES('synthetic','/synthetic',NULL,1);").unwrap();
    for (index, data) in [
        r#"{"role":"user","unknown":true}"#,
        "{broken",
        r#"{"role":"assistant"}"#,
    ]
    .iter()
    .enumerate()
    {
        db.execute(
            "INSERT INTO message VALUES(?1,'synthetic',?2,?3)",
            rusqlite::params![index.to_string(), index, data],
        )
        .unwrap();
        db.execute(
            "INSERT INTO part VALUES(?1,?1,'synthetic',?2,?3)",
            rusqlite::params![
                index.to_string(),
                index,
                r#"{"type":"text","text":"synthetic request","unknown":true}"#
            ],
        )
        .unwrap();
    }
    drop(db);
    (dir, path)
}
#[test]
fn opencode_bad_json_invalid_encoding_and_oversize_are_row_local_and_read_only() {
    let (_dir, path) = database();
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("INSERT INTO message VALUES('decode','synthetic',4,CAST(X'FFFE' AS TEXT)); INSERT INTO message VALUES('large','synthetic',5,'{}'); INSERT INTO part VALUES('large','large','synthetic',5,replace(hex(zeroblob(12582913)),'0','x')); INSERT INTO message VALUES('part','synthetic',6,'{}'); INSERT INTO part VALUES('part','part','synthetic',6,'{broken');").unwrap();
    drop(db);
    let bytes = fs::read(&path).unwrap();
    let modified = fs::metadata(&path).unwrap().modified().unwrap();
    for loaded in [
        normalized::recent(&path.join("synthetic"), TranscriptKind::OpenCode).unwrap(),
        normalized::legacy(
            normalized::page(
                &path.join("synthetic"),
                TranscriptKind::OpenCode,
                None,
                None,
            )
            .unwrap()
            .0,
        ),
    ] {
        assert_eq!(loaded.diagnostics.skipped_rows, 4);
        assert_eq!(loaded.diagnostics.reasons["malformed"], 2);
        assert_eq!(loaded.diagnostics.reasons["decode"], 1);
        assert_eq!(loaded.diagnostics.reasons["oversized"], 1);
        assert_eq!(loaded.messages.len(), 2);
    }
    assert_eq!(fs::read(&path).unwrap(), bytes);
    assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), modified);
}
#[test]
fn gemini_json_preserves_a_readable_prefix_after_truncation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("session-synthetic.json");
    fs::write(&path, r#"{"messages":[{"id":"u","type":"user","content":"synthetic request","unknown":true},{"id":"truncated"#).unwrap();
    let loaded = normalized::recent(&path, TranscriptKind::Gemini).unwrap();
    assert_eq!(loaded.diagnostics.skipped_rows, 1);
    assert_eq!(loaded.messages[0].text, "synthetic request");
}

#[derive(Default)]
struct AuditMetrics {
    large: u64,
    first_ok: u64,
    complete: u64,
    old_limited: u64,
    old_complete: u64,
    truncated_rows: u64,
    max_bytes: u64,
    max_decoded: u64,
    peak_page_bytes: u64,
    first_ms: Vec<u64>,
    full_ms: Vec<u64>,
}
impl AuditMetrics {
    fn merge(&mut self, other: Self) {
        self.large += other.large;
        self.first_ok += other.first_ok;
        self.complete += other.complete;
        self.old_limited += other.old_limited;
        self.old_complete += other.old_complete;
        self.truncated_rows += other.truncated_rows;
        self.max_bytes = self.max_bytes.max(other.max_bytes);
        self.max_decoded = self.max_decoded.max(other.max_decoded);
        self.peak_page_bytes = self.peak_page_bytes.max(other.peak_page_bytes);
        self.first_ms.extend(other.first_ms);
        self.full_ms.extend(other.full_ms);
    }
}
fn audit_reason(error: &str) -> String {
    error
        .strip_prefix("native.read:")
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .and_then(|value| value["reason"].as_str().map(str::to_string))
        .unwrap_or_else(|| "read".into())
}
fn audit_rss_kib() -> u64 {
    #[cfg(target_os = "linux")]
    {
        fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|s| {
                s.lines()
                    .find(|line| line.starts_with("VmRSS:"))
                    .and_then(|line| line.split_whitespace().nth(1)?.parse().ok())
            })
            .unwrap_or(0)
    }
    #[cfg(not(target_os = "linux"))]
    {
        0
    }
}
/// Opt-in real-machine audit: no content, paths, titles, identities or errors are printed.
#[test]
#[ignore = "explicitly requested read-only local audit; aggregate counts only"]
fn audit_real_native_sessions_read_only() {
    use std::collections::BTreeMap;
    let kinds = JSONL_KINDS.into_iter().chain([TranscriptKind::OpenCode]);
    for kind in kinds {
        let mut candidates = Vec::new();
        let mut failures = 0u64;
        let mut errors = BTreeMap::<String, u64>::new();
        if let Some(root) = history_root(kind, None) {
            if kind == TranscriptKind::OpenCode {
                match additional::audit_database_sessions(&root) {
                    Ok(paths) => candidates = paths,
                    Err(error) => {
                        failures += 1;
                        let reason = error
                            .strip_prefix("native.read:")
                            .and_then(|text| serde_json::from_str::<Value>(text).ok())
                            .and_then(|value| value["reason"].as_str().map(str::to_string))
                            .unwrap_or_else(|| "read".into());
                        *errors.entry(reason).or_default() += 1;
                    }
                }
            } else {
                let mut stack = vec![root];
                if kind == TranscriptKind::Codex {
                    if let Some(archive) = history_root_with_archive(kind, None, true) {
                        stack.push(archive);
                    }
                }
                while let Some(dir) = stack.pop() {
                    let children = match fs::read_dir(&dir) {
                        Ok(children) => children,
                        Err(_) => {
                            failures += 1;
                            *errors
                                .entry("permission_or_unavailable".into())
                                .or_default() += 1;
                            continue;
                        }
                    };
                    for entry in children.flatten() {
                        let path = entry.path();
                        if redact::forbidden(&path) {
                            continue;
                        }
                        let Ok(typ) = entry.file_type() else {
                            continue;
                        };
                        if typ.is_symlink() {
                            continue;
                        }
                        if typ.is_dir() {
                            stack.push(path);
                            continue;
                        }
                        let name = entry.file_name();
                        let name = name.to_string_lossy();
                        let keep = match kind {
                            TranscriptKind::Codex => {
                                name.starts_with("rollout-")
                                    && (name.ends_with(".jsonl") || name.ends_with(".jsonl.zst"))
                            }
                            TranscriptKind::Claude => name.ends_with(".jsonl"),
                            TranscriptKind::Gemini => {
                                name.starts_with("session-")
                                    && (name.ends_with(".jsonl") || name.ends_with(".json"))
                            }
                            TranscriptKind::Qwen => {
                                path.parent()
                                    .is_some_and(|p| p.file_name().is_some_and(|n| n == "chats"))
                                    && name.ends_with(".jsonl")
                            }
                            TranscriptKind::Copilot => name == "events.jsonl",
                            TranscriptKind::Grok => name == "chat_history.jsonl",
                            TranscriptKind::Kimi => name == "wire.jsonl",
                            _ => false,
                        };
                        if keep && typ.is_file() {
                            candidates.push(path);
                        }
                    }
                }
            }
        }
        let mut successful = 0u64;
        let mut skipped = 0u64;
        candidates.sort();
        candidates.dedup();
        // Optional stable shards keep a large real-machine audit bounded per
        // process. Only hashes are used internally; paths are never printed.
        if let Some(part) = std::env::var("LATTICE_NATIVE_AUDIT_PART")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|part| *part < 4)
        {
            use std::hash::{Hash, Hasher};
            candidates.retain(|path| {
                let mut hash = std::collections::hash_map::DefaultHasher::new();
                path.hash(&mut hash);
                hash.finish() % 4 == part
            });
        }
        let samples = candidates.len();
        let rss_base = audit_rss_kib();
        let rss_peak = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(rss_base));
        let sampling = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let sampler = {
            let peak = rss_peak.clone();
            let running = sampling.clone();
            std::thread::spawn(move || {
                while running.load(std::sync::atomic::Ordering::Relaxed) {
                    peak.fetch_max(audit_rss_kib(), std::sync::atomic::Ordering::Relaxed);
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
            })
        };
        let reports = std::thread::scope(|scope| {
            let workers: Vec<_> = candidates
                .chunks(samples.div_ceil(4).max(1))
                .map(|paths| {
                    scope.spawn(move || {
                        let mut successful = 0u64;
                        let mut skipped = 0u64;
                        let mut failures = 0u64;
                        let mut errors = BTreeMap::<String, u64>::new();
                        let mut metrics = AuditMetrics::default();
                        for path in paths {
                            let size = fs::metadata(additional::physical(path))
                                .map(|m| m.len())
                                .unwrap_or(0);
                            metrics.max_bytes = metrics.max_bytes.max(size);
                            let started = std::time::Instant::now();
                            let first = normalized::page(path, kind, None, None);
                            let first = if first
                                .as_ref()
                                .is_err_and(|error| audit_reason(error) == "changed")
                            {
                                std::thread::sleep(std::time::Duration::from_millis(50));
                                normalized::page(path, kind, None, None)
                            } else {
                                first
                            };
                            match first {
                                Ok((page, _)) => {
                                    let first_ms = started.elapsed().as_millis() as u64;
                                    let decoded = page.decoded_bytes.unwrap_or(size);
                                    metrics.max_decoded = metrics.max_decoded.max(decoded);
                                    metrics.peak_page_bytes = metrics
                                        .peak_page_bytes
                                        .max(serde_json::to_vec(&page).unwrap().len() as u64);
                                    metrics.truncated_rows += page.diagnostics.truncated_rows;
                                    skipped += page.diagnostics.skipped_rows;
                                    for (reason, count) in &page.diagnostics.reasons {
                                        *errors.entry(reason.clone()).or_default() += count;
                                    }
                                    let old_limited = kind == TranscriptKind::Codex
                                        && path.extension().is_some_and(|s| s == "zst")
                                        && (size > MAX_TRANSCRIPT_FILE_BYTES
                                            || decoded > 512 * 1024 * 1024);
                                    let large = kind == TranscriptKind::Codex
                                        && (size > MAX_TRANSCRIPT_FILE_BYTES || old_limited);
                                    if large {
                                        metrics.large += 1;
                                        metrics.first_ok += 1;
                                        metrics.old_limited += u64::from(old_limited);
                                        metrics.first_ms.push(first_ms);
                                        let mut cursor = page.previous_cursor;
                                        let mut failure = None;
                                        while let Some(before) = cursor {
                                            match normalized::page(path, kind, Some(&before), None)
                                            {
                                                Ok((page, _)) => {
                                                    metrics.peak_page_bytes =
                                                        metrics.peak_page_bytes.max(
                                                            serde_json::to_vec(&page).unwrap().len()
                                                                as u64,
                                                        );
                                                    if page.previous_cursor.as_ref().is_some_and(
                                                        |next| next.before >= before.before,
                                                    ) {
                                                        failure = Some("cursor_progress".into());
                                                        break;
                                                    }
                                                    cursor = page.previous_cursor;
                                                }
                                                Err(error) => {
                                                    failure = Some(audit_reason(&error));
                                                    break;
                                                }
                                            }
                                        }
                                        metrics.full_ms.push(started.elapsed().as_millis() as u64);
                                        if let Some(reason) = failure {
                                            failures += 1;
                                            *errors.entry(reason).or_default() += 1;
                                            continue;
                                        }
                                        metrics.complete += 1;
                                        metrics.old_complete += u64::from(old_limited);
                                    }
                                    successful += 1;
                                }
                                Err(error) => {
                                    failures += 1;
                                    *errors.entry(audit_reason(&error)).or_default() += 1;
                                    if kind == TranscriptKind::Codex
                                        && size > MAX_TRANSCRIPT_FILE_BYTES
                                    {
                                        metrics.large += 1;
                                        if path.extension().is_some_and(|s| s == "zst") {
                                            metrics.old_limited += 1;
                                        }
                                    }
                                }
                            }
                        }
                        (successful, skipped, failures, errors, metrics)
                    })
                })
                .collect();
            workers
                .into_iter()
                .map(|worker| worker.join().expect("native audit worker completed"))
                .collect::<Vec<_>>()
        });
        sampling.store(false, std::sync::atomic::Ordering::Relaxed);
        sampler.join().unwrap();
        let mut metrics = AuditMetrics::default();
        for (loaded, rows, failed, reasons, report) in reports {
            metrics.merge(report);
            successful += loaded;
            skipped += rows;
            failures += failed;
            for (reason, count) in reasons {
                *errors.entry(reason).or_default() += count;
            }
        }
        println!(
            "NATIVE_AUDIT {} samples={} success={} skipped_rows={} file_failures={} reasons={}",
            diagnostics::cli(kind),
            samples,
            successful,
            skipped,
            failures,
            serde_json::to_string(&errors).unwrap()
        );
        println!(
            "NATIVE_METRICS {} {}",
            diagnostics::cli(kind),
            serde_json::json!({
                "largeFiles":metrics.large,"largeFirstOk":metrics.first_ok,"largeComplete":metrics.complete,
                "oldLimited":metrics.old_limited,"oldLimitedComplete":metrics.old_complete,
                "maxFileBytes":metrics.max_bytes,"maxDecodedBytes":metrics.max_decoded,"truncatedRows":metrics.truncated_rows,
                "peakPageBytes":metrics.peak_page_bytes,"rssPeakDeltaKiB":rss_peak.load(std::sync::atomic::Ordering::Relaxed).saturating_sub(rss_base),
                "largeFirstMs":metrics.first_ms,"largeFullMs":metrics.full_ms
            })
        );
    }
}

#[test]
fn bad_opencode_schema_does_not_take_down_another_cli_list() {
    ONLY_PROFILE_HISTORY.with(|flag| flag.set(true));
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            ONLY_PROFILE_HISTORY.with(|flag| flag.set(false));
        }
    }
    let _reset = Reset;
    let code = tempfile::tempdir().unwrap();
    fs::write(code.path().join("opencode.db"), b"not a database").unwrap();
    let codex = tempfile::tempdir().unwrap();
    tests::write_codex_rollout(
        &codex.path().join("sessions/rollout-synthetic.jsonl"),
        "synthetic",
        Path::new("/synthetic"),
        json!("cli"),
        "codex_cli_rs",
        1,
    );
    let page = local_conversation_page(
        &[
            HistoryProfile {
                definition_id: "opencode".into(),
                profile_id: "synthetic-code".into(),
                config_directory: code.path().display().to_string(),
            },
            HistoryProfile {
                definition_id: "codex".into(),
                profile_id: "synthetic-codex".into(),
                config_directory: codex.path().display().to_string(),
            },
        ],
        100,
        false,
    )
    .unwrap();
    assert!(page
        .entries
        .iter()
        .any(|entry| entry.definition_id == "codex"));
    assert_eq!(page.failures.len(), 1);
    assert!(page.failures[0].contains("OpenCode"));
    assert!(page.failures[0].contains("opencode.db"));
    assert!(!page.failures[0].contains(&code.path().display().to_string()));
}
#[test]
fn opencode_file_level_empty_corrupt_and_unknown_schema_fail_explicitly() {
    for bytes in [b"".as_slice(), b"\xff\xfe", b"future database format"] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.db");
        fs::write(&path, bytes).unwrap();
        let error =
            normalized::recent(&path.join("synthetic"), TranscriptKind::OpenCode).unwrap_err();
        assert!(error.contains("OpenCode"));
        assert!(error.contains("opencode.db"));
        assert!(!error.contains(&dir.path().display().to_string()));
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("opencode.db");
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute_batch("CREATE TABLE future_schema(x INT);")
        .unwrap();
    drop(connection);
    assert!(
        normalized::recent(&path.join("synthetic"), TranscriptKind::OpenCode)
            .unwrap_err()
            .contains("unsupported_version")
    );
}
#[cfg(unix)]
#[test]
fn denied_native_file_returns_a_content_free_permission_reason() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("synthetic.jsonl");
    fs::write(&path, fixture(TranscriptKind::Codex)).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
    // Root can bypass file permissions; the diagnostic contract stays stable.
    let error = diagnostics::failure(TranscriptKind::Codex, &path, "Transcript unavailable.");
    assert!(error.contains("permission"));
    assert!(!error.contains(&dir.path().display().to_string()));
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
}

#[test]
fn damaged_identity_is_reported_without_authorizing_content_by_filename() {
    for kind in [
        TranscriptKind::Codex,
        TranscriptKind::Claude,
        TranscriptKind::Qwen,
        TranscriptKind::Copilot,
        TranscriptKind::Grok,
        TranscriptKind::Kimi,
    ] {
        let dir = tempfile::tempdir().unwrap();
        let relative = match kind {
            TranscriptKind::Codex => "sessions/rollout-synthetic.jsonl",
            TranscriptKind::Claude => "projects/fixture/synthetic.jsonl",
            TranscriptKind::Qwen => "projects/fixture/chats/synthetic.jsonl",
            TranscriptKind::Copilot => "session-state/synthetic/events.jsonl",
            TranscriptKind::Grok => "sessions/fixture/synthetic/chat_history.jsonl",
            TranscriptKind::Kimi => "sessions/fixture/synthetic/agents/main/wire.jsonl",
            _ => unreachable!(),
        };
        let file = dir.path().join(relative);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, b"\xff\xfe").unwrap();
        let cli = match kind {
            TranscriptKind::Codex => "codex",
            TranscriptKind::Claude => "claude",
            _ => additional::id(kind),
        };
        let error = read_session_conversation_snapshot(
            cli,
            "/synthetic",
            Some("synthetic"),
            Some(dir.path()),
        )
        .unwrap_err();
        assert!(error.contains(diagnostics::cli(kind)));
        assert!(error.contains("decode"));
        assert!(!error.contains(&dir.path().display().to_string()));
    }
}

#[test]
fn invalid_oversized_compressed_files_report_decode_instead_of_size_errors() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rollout-synthetic.jsonl.zst");
    fs::File::create(&path)
        .unwrap()
        .set_len(MAX_TRANSCRIPT_FILE_BYTES + 1)
        .unwrap();
    let error = normalized::page(&path, TranscriptKind::Codex, None, None).unwrap_err();
    assert!(error.contains("decode"));
    assert!(!error.contains("size_limit"));
}
