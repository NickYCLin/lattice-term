use super::*;
use serde_json::json;
use std::fs;
fn draft(content: &str, scope: Scope) -> Draft {
    Draft {
        id: None,
        kind: Kind::Project,
        content: content.into(),
        source: Source::manual(),
        pinned: false,
        scope,
    }
}
fn inspect_work(data: &Path, work: &Path) -> Snapshot {
    inspect(data, work.to_str()).unwrap()
}
#[test]
fn neutral_store_renders_independent_blocks_and_is_idempotent() {
    let data = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    fs::write(
        work.path().join("AGENTS.md"),
        "# Existing rules\nKeep the original.\n",
    )
    .unwrap();
    fs::write(
        work.path().join("CLAUDE.md"),
        "# Native rules\nPrivate custom instruction.\n",
    )
    .unwrap();
    let before = inspect_work(data.path(), work.path());
    let saved = mutate(
        data.path(),
        work.path().to_str(),
        &before.revision,
        Action::Upsert {
            draft: draft("Use deterministic fixtures.", Scope::Project),
        },
    )
    .unwrap();
    assert_eq!(saved.entries.len(), 1);
    assert!(work.path().join(PROJECT_STORE).is_file());
    let agents = fs::read_to_string(work.path().join("AGENTS.md")).unwrap();
    assert!(agents.starts_with("# Existing rules\nKeep the original.\n"));
    assert!(agents.contains(render::START));
    assert!(agents.contains("Use deterministic fixtures."));
    let claude = fs::read_to_string(work.path().join("CLAUDE.md")).unwrap();
    assert!(claude.starts_with("# Native rules\nPrivate custom instruction.\n"));
    assert!(claude.contains("@AGENTS.md"));
    assert!(fs::read_to_string(work.path().join("QWEN.md"))
        .unwrap()
        .contains("@./AGENTS.md"));
    let synced = mutate(
        data.path(),
        work.path().to_str(),
        &saved.revision,
        Action::Sync,
    )
    .unwrap();
    assert_eq!(synced.revision, saved.revision);
    assert_eq!(
        agents,
        fs::read_to_string(work.path().join("AGENTS.md")).unwrap()
    );
}
#[test]
fn stale_revisions_never_replace_external_edits() {
    let data = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let before = inspect_work(data.path(), work.path());
    fs::write(work.path().join("AGENTS.md"), "external change").unwrap();
    assert_eq!(
        mutate(
            data.path(),
            work.path().to_str(),
            &before.revision,
            Action::Upsert {
                draft: draft("New note", Scope::Project)
            }
        )
        .unwrap_err(),
        "memory.conflict"
    );
    assert_eq!(
        fs::read_to_string(work.path().join("AGENTS.md")).unwrap(),
        "external change"
    );
    assert!(!work.path().join(PROJECT_STORE).exists());
}
#[test]
fn secret_entries_are_rejected_and_external_secret_store_never_leaks() {
    let data = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    for content in [
        "token=FAKE_SECRET",
        "sk-ant-FAKE_SYNTHETIC_12345678901234567890",
        "-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----",
    ] {
        let view = inspect_work(data.path(), work.path());
        assert_eq!(
            mutate(
                data.path(),
                work.path().to_str(),
                &view.revision,
                Action::Upsert {
                    draft: draft(content, Scope::Project)
                }
            )
            .unwrap_err(),
            "memory.secret"
        );
    }
    assert!(!work.path().join(PROJECT_STORE).exists());
}
#[test]
fn global_notes_follow_projects_and_launch_updates_only_owned_store() {
    let data = tempfile::tempdir().unwrap();
    let one = tempfile::tempdir().unwrap();
    let two = tempfile::tempdir().unwrap();
    let view = inspect_work(data.path(), one.path());
    mutate(
        data.path(),
        one.path().to_str(),
        &view.revision,
        Action::Upsert {
            draft: draft("Prefer concise replies.", Scope::User),
        },
    )
    .unwrap();
    let before = inspect_work(data.path(), two.path());
    assert_eq!(before.entries.len(), 1);
    assert_eq!(before.entries[0].entry.last_used_at, 0);
    prepare(data.path(), two.path(), "codex").unwrap();
    let after = inspect_work(data.path(), two.path());
    assert!(after.entries[0].entry.last_used_at > 0);
    assert!(fs::read_to_string(two.path().join("AGENTS.md"))
        .unwrap()
        .contains("Prefer concise replies."));
    assert!(!two.path().join(PROJECT_STORE).exists());
}
#[test]
fn app_storage_copies_memory_without_deleting_prior_data_and_requires_ignore_consent() {
    let data = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let view = inspect_work(data.path(), work.path());
    let saved = mutate(
        data.path(),
        work.path().to_str(),
        &view.revision,
        Action::Upsert {
            draft: draft("Keep a project decision.", Scope::Project),
        },
    )
    .unwrap();
    let changed = mutate(
        data.path(),
        work.path().to_str(),
        &saved.revision,
        Action::Storage {
            location: Location::App,
        },
    )
    .unwrap();
    assert_eq!(changed.storage, Location::App);
    assert_eq!(changed.entries.len(), 1);
    assert!(work.path().join(PROJECT_STORE).exists());
    assert!(!work.path().join(".gitignore").exists());
    assert_eq!(
        mutate(
            data.path(),
            work.path().to_str(),
            &changed.revision,
            Action::Ignore { confirmed: false }
        )
        .unwrap_err(),
        "memory.confirmIgnore"
    );
    let ignored = mutate(
        data.path(),
        work.path().to_str(),
        &changed.revision,
        Action::Ignore { confirmed: true },
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(work.path().join(".gitignore")).unwrap(),
        "/.lattice/memory/\n"
    );
    let again = mutate(
        data.path(),
        work.path().to_str(),
        &ignored.revision,
        Action::Ignore { confirmed: true },
    )
    .unwrap();
    assert_eq!(ignored.revision, again.revision);
}
#[test]
fn malformed_markers_and_symlinks_require_manual_review() {
    let data = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    fs::write(
        work.path().join("AGENTS.md"),
        format!("{}\nmissing end", render::START),
    )
    .unwrap();
    let view = inspect_work(data.path(), work.path());
    let saved = mutate(
        data.path(),
        work.path().to_str(),
        &view.revision,
        Action::Upsert {
            draft: draft(
                "Save neutral data even if export needs repair.",
                Scope::Project,
            ),
        },
    )
    .unwrap();
    assert!(saved.files.iter().any(|file| file.state == "manualReview"));
    assert!(saved.warnings.contains(&"memory.manualReview".into()));
    assert!(fs::read_to_string(work.path().join("AGENTS.md"))
        .unwrap()
        .ends_with("missing end"));
    #[cfg(unix)]
    {
        let outside = tempfile::tempdir().unwrap();
        let link = work.path().join("GEMINI.md");
        std::os::unix::fs::symlink(outside.path().join("GEMINI.md"), link).unwrap();
        let view = inspect_work(data.path(), work.path());
        assert!(view.files.iter().any(|file| file.state == "manualReview"));
        assert!(!outside.path().join("GEMINI.md").exists());
    }
}
#[test]
fn output_limit_never_drops_canonical_entries() {
    let data = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    for index in 0..5 {
        let view = inspect_work(data.path(), work.path());
        let value = format!("Decision {index}: {}", "words ".repeat(700));
        mutate(
            data.path(),
            work.path().to_str(),
            &view.revision,
            Action::Upsert {
                draft: draft(&value, Scope::Project),
            },
        )
        .unwrap();
    }
    let view = inspect_work(data.path(), work.path());
    assert_eq!(view.entries.len(), 5);
    assert!(view.output_bytes > MAX_OUTPUT);
    assert!(view.warnings.contains(&"memory.outputLimit".into()));
    assert!(prepare(data.path(), work.path(), "codex").is_err());
}
#[test]
fn imports_are_readonly_masked_deduplicated_and_selected_explicitly() {
    let data = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let native = tempfile::tempdir().unwrap();
    let slug = work
        .path()
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>();
    let folder = native.path().join("projects").join(slug).join("memory");
    fs::create_dir_all(&folder).unwrap();
    fs::write(
        folder.join("MEMORY.md"),
        "---\ntype: user\n---\nPrefer short examples.",
    )
    .unwrap();
    fs::write(folder.join("topic.md"), "Prefer short examples.").unwrap();
    fs::write(folder.join("secret.md"), "token=FAKE_SECRET").unwrap();
    let raw = fs::read(folder.join("secret.md")).unwrap();
    let preview = preview_import(
        data.path(),
        work.path().to_str(),
        "claude",
        native.path().to_str(),
    )
    .unwrap();
    assert_eq!(preview.candidates.len(), 2);
    assert!(!serde_json::to_string(&preview)
        .unwrap()
        .contains("FAKE_SECRET"));
    assert!(preview.candidates.iter().any(|item| item.blocked));
    let selected = preview
        .candidates
        .iter()
        .filter(|item| !item.blocked)
        .map(|item| item.id.clone())
        .collect::<Vec<_>>();
    assert!(!work.path().join(PROJECT_STORE).exists());
    let view = inspect_work(data.path(), work.path());
    let saved = mutate(
        data.path(),
        work.path().to_str(),
        &view.revision,
        Action::Import {
            ids: selected,
            scope: Scope::Project,
            definition_id: "claude".into(),
            config_directory: Some(native.path().display().to_string()),
            preview_revision: preview.revision,
        },
    )
    .unwrap();
    assert_eq!(saved.entries.len(), 1);
    assert_eq!(saved.entries[0].entry.kind, Kind::User);
    assert_eq!(raw, fs::read(folder.join("secret.md")).unwrap());
}
#[test]
fn codex_and_gemini_import_only_known_memory_sources() {
    let data = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let native = tempfile::tempdir().unwrap();
    fs::create_dir(native.path().join("memories_v2")).unwrap();
    fs::write(
        native.path().join("memories_v2/MEMORY.md"),
        "# Decision\nUse isolated fixtures.",
    )
    .unwrap();
    fs::write(
        native.path().join("auth.json"),
        "FAKE_CREDENTIALS_MUST_NOT_APPEAR",
    )
    .unwrap();
    fs::write(work.path().join("GEMINI.md"),"# Instructions\nDo not import this section.\n## Gemini Added Memories\n- Prefer local examples.\n## Other\nNot memory.").unwrap();
    let codex = preview_import(
        data.path(),
        work.path().to_str(),
        "codex",
        native.path().to_str(),
    )
    .unwrap();
    let content = serde_json::to_string(&codex).unwrap();
    assert!(content.contains("Use isolated fixtures"));
    assert!(!content.contains("FAKE_CREDENTIALS"));
    assert!(!content.contains("Do not import this"));
    let gemini = preview_import(
        data.path(),
        work.path().to_str(),
        "gemini",
        native.path().to_str(),
    )
    .unwrap();
    assert!(gemini
        .candidates
        .iter()
        .any(|item| item.content.contains("Prefer local examples")));
}
#[test]
fn imports_reject_changed_source_files_and_action_wire_is_camel_case() {
    let data = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let native = tempfile::tempdir().unwrap();
    fs::write(work.path().join("CLAUDE.md"), "Initial note").unwrap();
    let preview = preview_import(
        data.path(),
        work.path().to_str(),
        "claude",
        native.path().to_str(),
    )
    .unwrap();
    fs::write(work.path().join("CLAUDE.md"), "Changed note").unwrap();
    let view = inspect_work(data.path(), work.path());
    assert_eq!(
        mutate(
            data.path(),
            work.path().to_str(),
            &view.revision,
            Action::Import {
                ids: vec![preview.candidates[0].id.clone()],
                scope: Scope::Project,
                definition_id: "claude".into(),
                config_directory: Some(native.path().display().to_string()),
                preview_revision: preview.revision
            }
        )
        .unwrap_err(),
        "memory.conflict"
    );
    let _action:Action=serde_json::from_value(json!({"kind":"import","ids":["fake"],"scope":"project","definitionId":"codex","configDirectory":null,"previewRevision":"fake"})).unwrap();
}

#[test]
fn edits_pins_deletes_and_crlf_preserve_surrounding_content() {
    let data = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let original = format!(
        "# Before\r\n{}\r\nold\r\n{}\r\n# After\r\nKeep bytes.\r\n",
        render::START,
        render::END
    );
    fs::write(work.path().join("AGENTS.md"), &original).unwrap();
    let initial = inspect_work(data.path(), work.path());
    let saved = mutate(
        data.path(),
        work.path().to_str(),
        &initial.revision,
        Action::Upsert {
            draft: draft("New decision", Scope::Project),
        },
    )
    .unwrap();
    let entry = &saved.entries[0].entry;
    let id = entry.id.clone();
    let created = entry.created_at;
    let mut edit = draft("Revised decision", Scope::Project);
    edit.id = Some(id.clone());
    edit.pinned = true;
    let edited = mutate(
        data.path(),
        work.path().to_str(),
        &saved.revision,
        Action::Upsert { draft: edit },
    )
    .unwrap();
    assert_eq!(edited.entries[0].entry.created_at, created);
    assert!(edited.entries[0].entry.pinned);
    let text = fs::read_to_string(work.path().join("AGENTS.md")).unwrap();
    assert!(text.starts_with("# Before\r\n"));
    assert!(text.ends_with("\r\n# After\r\nKeep bytes.\r\n"));
    assert!(!text.contains("old"));
    assert!(text.contains("釘選"));
    let deleted = mutate(
        data.path(),
        work.path().to_str(),
        &edited.revision,
        Action::Delete {
            id,
            scope: Scope::Project,
        },
    )
    .unwrap();
    assert!(deleted.entries.is_empty());
    assert_eq!(
        fs::read_to_string(work.path().join("AGENTS.md")).unwrap(),
        "# Before\r\n\r\n# After\r\nKeep bytes.\r\n"
    );
}
#[test]
fn external_secret_store_is_masked_and_never_exported() {
    let data = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    fs::create_dir_all(work.path().join(".lattice/memory")).unwrap();
    let entry = Entry {
        id: "a".repeat(32),
        kind: Kind::Project,
        content: "token=FAKE_EXTERNAL_SECRET".into(),
        source: Source::manual(),
        created_at: 1,
        updated_at: 1,
        last_used_at: 0,
        pinned: false,
    };
    fs::write(
        work.path().join(PROJECT_STORE),
        encode(&Store {
            version: 1,
            entries: vec![entry],
        })
        .unwrap(),
    )
    .unwrap();
    let view = inspect_work(data.path(), work.path());
    assert!(view.entries[0].blocked);
    assert!(!serde_json::to_string(&view)
        .unwrap()
        .contains("FAKE_EXTERNAL_SECRET"));
    assert_eq!(
        prepare(data.path(), work.path(), "codex").unwrap_err(),
        "memory.secret"
    );
    assert!(!work.path().join("AGENTS.md").exists());
    let mut external: Store =
        serde_json::from_slice(&fs::read(work.path().join(PROJECT_STORE)).unwrap()).unwrap();
    external.entries[0].content = render::END.into();
    fs::write(work.path().join(PROJECT_STORE), encode(&external).unwrap()).unwrap();
    assert_eq!(
        inspect(data.path(), work.path().to_str()).unwrap_err(),
        "memory.format"
    );
}
#[test]
fn duplicate_content_blocked_import_and_override_are_safe() {
    let data = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let native = tempfile::tempdir().unwrap();
    let initial = inspect_work(data.path(), work.path());
    let saved = mutate(
        data.path(),
        work.path().to_str(),
        &initial.revision,
        Action::Upsert {
            draft: draft("Use fixtures", Scope::Project),
        },
    )
    .unwrap();
    assert_eq!(
        mutate(
            data.path(),
            work.path().to_str(),
            &saved.revision,
            Action::Upsert {
                draft: draft("  use  FIXTURES\n", Scope::Project)
            }
        )
        .unwrap_err(),
        "memory.duplicate"
    );
    fs::write(work.path().join("CLAUDE.md"), "token=FAKE_BLOCKED").unwrap();
    let view = inspect_work(data.path(), work.path());
    let preview = preview_import(
        data.path(),
        work.path().to_str(),
        "claude",
        native.path().to_str(),
    )
    .unwrap();
    let blocked = preview.candidates.iter().find(|item| item.blocked).unwrap();
    assert_eq!(
        mutate(
            data.path(),
            work.path().to_str(),
            &view.revision,
            Action::Import {
                ids: vec![blocked.id.clone()],
                scope: Scope::Project,
                definition_id: "claude".into(),
                config_directory: Some(native.path().display().to_string()),
                preview_revision: preview.revision
            }
        )
        .unwrap_err(),
        "memory.secret"
    );
    fs::write(work.path().join("AGENTS.override.md"), "Custom override").unwrap();
    let view = inspect_work(data.path(), work.path());
    assert!(view
        .files
        .iter()
        .any(|file| file.cli == "Codex" && file.state == "manualReview"));
    assert_eq!(
        prepare(data.path(), work.path(), "codex").unwrap_err(),
        "memory.override"
    );
    #[cfg(unix)]
    {
        fs::remove_file(work.path().join("AGENTS.override.md")).unwrap();
        std::os::unix::fs::symlink(
            work.path().join("missing"),
            work.path().join("AGENTS.override.md"),
        )
        .unwrap();
        assert_eq!(
            prepare(data.path(), work.path(), "codex").unwrap_err(),
            "memory.override"
        );
    }
}
#[test]
fn empty_launch_does_not_create_instruction_files_or_touch_native_sources() {
    let data = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    prepare(data.path(), work.path(), "codex").unwrap();
    assert_eq!(fs::read_dir(work.path()).unwrap().count(), 0);
    let view = inspect(data.path(), None).unwrap();
    let saved = mutate(
        data.path(),
        None,
        &view.revision,
        Action::Upsert {
            draft: draft("Global decision", Scope::User),
        },
    )
    .unwrap();
    assert_eq!(saved.entries[0].scope, Scope::User);
    assert_eq!(
        mutate(
            data.path(),
            None,
            &saved.revision,
            Action::Upsert {
                draft: draft("Needs folder", Scope::Project)
            }
        )
        .unwrap_err(),
        "memory.projectRequired"
    );
}
#[cfg(unix)]
#[test]
fn linked_storage_directories_and_import_files_cannot_escape() {
    let data = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(outside.path(), work.path().join(".lattice")).unwrap();
    assert_eq!(
        inspect(data.path(), work.path().to_str()).unwrap_err(),
        "memory.path"
    );
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    fs::remove_file(work.path().join(".lattice")).unwrap();
    fs::write(outside.path().join("secret.md"), "MUST_NOT_READ").unwrap();
    fs::create_dir(outside.path().join("memories")).unwrap();
    std::os::unix::fs::symlink(
        outside.path().join("secret.md"),
        outside.path().join("memories/MEMORY.md"),
    )
    .unwrap();
    let preview = preview_import(
        data.path(),
        work.path().to_str(),
        "codex",
        outside.path().to_str(),
    )
    .unwrap();
    assert!(!serde_json::to_string(&preview)
        .unwrap()
        .contains("MUST_NOT_READ"));
}
#[test]
fn commit_preflight_rejects_conflicts_before_any_file_is_changed() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("a"), "original").unwrap();
    fs::write(root.path().join("b"), "external").unwrap();
    assert!(storage::commit(vec![
        Change::new(
            root.path(),
            "a",
            Some(b"original".to_vec()),
            b"updated".to_vec()
        ),
        Change::new(
            root.path(),
            "b",
            Some(b"expected".to_vec()),
            b"replacement".to_vec()
        )
    ])
    .is_err());
    assert_eq!(fs::read(root.path().join("a")).unwrap(), b"original");
    assert_eq!(fs::read(root.path().join("b")).unwrap(), b"external");
}
