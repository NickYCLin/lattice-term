use super::*;
pub const START: &str = "<!-- LatticeTerm project memory: start -->";
pub const END: &str = "<!-- LatticeTerm project memory: end -->";
fn range(text: &str) -> Result<Option<(usize, usize)>, String> {
    let starts = text.match_indices(START).collect::<Vec<_>>();
    let ends = text.match_indices(END).collect::<Vec<_>>();
    match (starts.as_slice(), ends.as_slice()) {
        ([], []) => Ok(None),
        ([(start, _)], [(end, _)]) if start < end => {
            if (*start > 0 && !text[..*start].ends_with('\n'))
                || !text[end + END.len()..].is_empty()
                    && !text[end + END.len()..].starts_with(['\r', '\n'])
            {
                return Err("memory.manualReview".into());
            }
            let mut fence = false;
            for line in text[..*start].lines() {
                if line.trim_start().starts_with("```") || line.trim_start().starts_with("~~~") {
                    fence = !fence;
                }
            }
            if fence {
                return Err("memory.manualReview".into());
            }
            Ok(Some((*start, end + END.len())))
        }
        _ => Err("memory.manualReview".into()),
    }
}
pub(super) fn outside(text: &str) -> Result<String, String> {
    let mut output = text.to_string();
    if let Some((start, end)) = range(text)? {
        output.replace_range(start..end, "");
    }
    Ok(output)
}
fn update(old: Option<&str>, body: &str) -> Result<Option<String>, String> {
    let Some(old) = old else {
        return Ok((!body.is_empty()).then(|| format!("{START}\n{body}\n{END}\n")));
    };
    let newline = if old.contains("\r\n") { "\r\n" } else { "\n" };
    let block = if body.is_empty() {
        String::new()
    } else {
        format!("{START}\n{body}\n{END}").replace('\n', newline)
    };
    if let Some((start, end)) = range(old)? {
        let mut next = old.to_string();
        next.replace_range(start..end, &block);
        return Ok(Some(next));
    }
    if body.is_empty() {
        return Ok(Some(old.into()));
    }
    let separator = if old.is_empty() {
        "".into()
    } else if old.ends_with("\n\n") || old.ends_with("\r\n\r\n") {
        String::new()
    } else if old.ends_with('\n') {
        newline.into()
    } else {
        format!("{newline}{newline}")
    };
    Ok(Some(format!("{old}{separator}{block}{newline}")))
}
fn kind_label(kind: Kind) -> &'static str {
    match kind {
        Kind::User => "使用者",
        Kind::Feedback => "回饋",
        Kind::Project => "專案",
        Kind::Reference => "參考",
    }
}
pub fn body(state: &State) -> Result<String, String> {
    if state
        .user
        .entries
        .iter()
        .chain(&state.project.entries)
        .any(entry_secret)
    {
        return Err("memory.secret".into());
    }
    if state.user.entries.is_empty() && state.project.entries.is_empty() {
        return Ok(String::new());
    }
    let mut text =
        "## LatticeTerm 跨工具記憶\n\n以下內容已由使用者確認；新的明確要求優先。\n".to_string();
    for (title, store) in [("跨專案", &state.user), ("此專案", &state.project)] {
        if store.entries.is_empty() {
            continue;
        }
        text.push_str(&format!("\n### {title}\n"));
        let mut entries = store.entries.iter().collect::<Vec<_>>();
        entries.sort_by_key(|entry| (!entry.pinned, entry.created_at, &entry.id));
        for entry in entries {
            let content = entry.content.replace("\r\n", "\n").replace('\r', "\n");
            let mut lines = content.lines();
            text.push_str(&format!(
                "\n- **{}{}**：{}\n",
                if entry.pinned { "釘選・" } else { "" },
                kind_label(entry.kind),
                lines.next().unwrap_or_default()
            ));
            for line in lines {
                text.push_str(&format!("  {line}\n"));
            }
        }
    }
    Ok(text.trim_end().into())
}
fn text<'a>(state: &'a State, name: &str) -> Result<Option<&'a str>, String> {
    let bytes = state
        .instructions
        .iter()
        .find(|(file, _)| file == name)
        .ok_or("memory.projectRequired")?
        .1
        .as_ref()
        .map_err(Clone::clone)?;
    bytes
        .as_deref()
        .map(|bytes| std::str::from_utf8(bytes).map_err(|_| "memory.format".into()))
        .transpose()
}
fn has_import(content: &str) -> bool {
    let mut fence = false;
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with("```") || line.starts_with("~~~") {
            fence = !fence;
            continue;
        }
        if !fence && matches!(line, "@AGENTS.md" | "@./AGENTS.md") {
            return true;
        }
    }
    false
}
fn plan(state: &State) -> Result<Vec<(String, Option<String>)>, String> {
    let body = body(state)?;
    let original = text(state, "AGENTS.md")?;
    if original.is_some_and(|text| text.contains('\0')) {
        return Err("memory.format".into());
    }
    let agents = update(original, &body)?;
    let output = if body.is_empty() {
        0
    } else {
        START.len()
            + END.len()
            + body.len()
            + 3
            + if original.is_some_and(|text| text.contains("\r\n")) {
                body.bytes().filter(|byte| *byte == b'\n').count() + 3
            } else {
                0
            }
    };
    if output > MAX_OUTPUT {
        return Err("memory.outputLimit".into());
    }
    if agents
        .as_ref()
        .is_some_and(|text| text.len() > crate::shared_agent_rules::MAX_SHARED_RULES_BYTES)
    {
        return Err("memory.outputLimit".into());
    }
    let mut targets = vec![("AGENTS.md".into(), agents)];
    for (name, import) in [
        ("CLAUDE.md", "@AGENTS.md"),
        ("GEMINI.md", "@./AGENTS.md"),
        ("QWEN.md", "@./AGENTS.md"),
    ] {
        let old = text(state, name)?;
        if old.is_some_and(|text| text.contains('\0')) {
            return Err("memory.format".into());
        }
        let next = if old.is_some_and(has_import) {
            range(old.unwrap_or_default())?;
            old.map(str::to_owned)
        } else {
            update(old, if body.is_empty() { "" } else { import })?
        };
        targets.push((name.into(), next));
    }
    Ok(targets)
}
pub(super) fn codex_override(state: &State) -> bool {
    match text(state, "AGENTS.override.md") {
        Ok(Some(text)) => !text.trim().is_empty(),
        Ok(None) => false,
        Err(_) => true,
    }
}
pub fn status(state: &State, has_project: bool) -> (Vec<SyncStatus>, usize, Vec<String>) {
    let body = body(state);
    let crlf = text(state, "AGENTS.md")
        .ok()
        .flatten()
        .is_some_and(|text| text.contains("\r\n"));
    let bytes = body.as_ref().map_or(0, |body| {
        if body.is_empty() {
            0
        } else {
            body.len()
                + START.len()
                + END.len()
                + 3
                + if crlf {
                    body.bytes().filter(|byte| *byte == b'\n').count() + 3
                } else {
                    0
                }
        }
    });
    if !has_project {
        return (Vec::new(), bytes, Vec::new());
    }
    let planned = plan(state);
    let error = planned.as_ref().err().cloned();
    let mut statuses = Vec::new();
    for (cli, file) in [
        ("Codex", "AGENTS.md"),
        ("Claude Code", "CLAUDE.md"),
        ("Gemini CLI", "GEMINI.md"),
        ("Qwen Code", "QWEN.md"),
        ("GitHub Copilot CLI", "AGENTS.md"),
        ("OpenCode", "AGENTS.md"),
        ("Kimi CLI", "AGENTS.md"),
        ("Grok Build", "AGENTS.md"),
    ] {
        let mut reason = error.clone();
        let state_name = if error.is_some() {
            if matches!(error.as_deref(), Some("memory.outputLimit")) {
                "needsSync"
            } else {
                "manualReview"
            }
        } else {
            let targets = planned.as_ref().expect("checked plan");
            let all = targets
                .iter()
                .all(|(name, next)| text(state, name).ok().flatten() == next.as_deref());
            if all {
                "synced"
            } else {
                "needsSync"
            }
        };
        let mut state_name = state_name;
        if cli == "Codex" && codex_override(state) {
            state_name = "manualReview";
            reason = Some("memory.override".into());
        }
        if cli == "Grok Build" {
            state_name = "manualReview";
            reason = Some("memory.grokReview".into());
        }
        statuses.push(SyncStatus {
            cli: cli.into(),
            file_name: file.into(),
            state: state_name.into(),
            reason,
        });
    }
    (statuses, bytes, error.into_iter().collect())
}
pub fn sync(ctx: &Context, state: &State) -> Result<(), String> {
    let Some(project) = &ctx.project else {
        return Ok(());
    };
    let targets = plan(state)?;
    let mut changes = Vec::new();
    for (name, next) in targets {
        if let Some(next) = next {
            let before = state
                .instructions
                .iter()
                .find(|(file, _)| file == &name)
                .ok_or("memory.format")?
                .1
                .clone()?;
            changes.push(Change::new(project, name, before, next.into_bytes()));
        }
    }
    storage::commit(changes)
}
