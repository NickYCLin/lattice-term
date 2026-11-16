//! Candidate-only native imports. Never follows links or writes source files.
use super::*;
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub id: String,
    pub kind: Kind,
    pub content: String,
    pub source: Source,
    pub blocked: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub revision: String,
    pub candidates: Vec<Candidate>,
    pub warnings: Vec<String>,
}
fn native_root(definition: &str, config: Option<&str>) -> Result<Option<PathBuf>, String> {
    if !["claude", "codex", "gemini", "qwen"].contains(&definition) {
        return Err("memory.format".into());
    }
    if let Some(config) = config {
        let path = storage::directory(Path::new(config))?;
        if redact::forbidden(&path) {
            return Err("memory.path".into());
        }
        return Ok(Some(path));
    }
    let home = dirs::home_dir();
    let (variable, folder) = match definition {
        "claude" => (Some("CLAUDE_CONFIG_DIR"), ".claude"),
        "codex" => (Some("CODEX_HOME"), ".codex"),
        "gemini" => (None, ".gemini"),
        "qwen" => (Some("QWEN_HOME"), ".qwen"),
        _ => return Err("memory.format".into()),
    };
    let root = variable
        .and_then(std::env::var_os)
        .map(PathBuf::from)
        .or_else(|| home.map(|home| home.join(folder)));
    Ok(root
        .filter(|path| path.is_dir())
        .and_then(|path| storage::directory(&path).ok()))
}
fn files_in(
    root: &Path,
    relative: &Path,
    paths: &mut Vec<(PathBuf, PathBuf)>,
    warnings: &mut Vec<String>,
) {
    let directory = root.join(relative);
    if relative
        .components()
        .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return;
    }
    let mut current = root.to_path_buf();
    for part in relative.components() {
        current.push(part);
        if !std::fs::symlink_metadata(&current)
            .is_ok_and(|meta| meta.is_dir() && !meta.file_type().is_symlink())
        {
            return;
        }
    }
    if let Ok(entries) = std::fs::read_dir(&directory) {
        let mut names = entries
            .filter_map(Result::ok)
            .filter(|entry| {
                entry.file_type().is_ok_and(|typ| typ.is_file())
                    && entry.path().extension().is_some_and(|ext| ext == "md")
            })
            .map(|entry| entry.file_name())
            .collect::<Vec<_>>();
        names.sort();
        if names.len() > 64 {
            warnings.push("memory.importSkipped".into());
        }
        for name in names.into_iter().take(64) {
            paths.push((root.to_path_buf(), relative.join(name)));
        }
    }
}
fn strip_shared(text: &str) -> String {
    let mut inside = false;
    let mut result = String::new();
    for line in text.lines() {
        if line.contains("<!-- LatticeTerm shared AI rules: start -->") {
            inside = true;
            continue;
        }
        if line.contains("<!-- LatticeTerm shared AI rules: end -->") {
            inside = false;
            continue;
        }
        if !inside && !line.trim().starts_with('@') {
            result.push_str(line);
            result.push('\n');
        }
    }
    result
}
fn paragraphs(text: &str, default: Kind) -> Vec<(Kind, String)> {
    let mut kind = default;
    let mut body = text;
    if let Some(front) = text.strip_prefix("---\n") {
        if let Some((metadata, rest)) = front.split_once("\n---") {
            for line in metadata.lines() {
                if let Some(value) = line.strip_prefix("type:") {
                    kind = match value.trim() {
                        "user" => Kind::User,
                        "feedback" => Kind::Feedback,
                        "reference" => Kind::Reference,
                        _ => Kind::Project,
                    };
                }
            }
            body = rest;
        }
    }
    let mut parts = Vec::new();
    let mut chunk = String::new();
    for line in body.lines() {
        if (line.starts_with("# ") || line.starts_with("## ")) && !chunk.trim().is_empty() {
            parts.push((kind, chunk.trim().to_string()));
            chunk.clear();
        }
        if !line.trim().is_empty() || !chunk.is_empty() {
            chunk.push_str(line);
            chunk.push('\n');
        }
    }
    if !chunk.trim().is_empty() {
        parts.push((kind, chunk.trim().into()));
    }
    parts
}
fn gemini_memories(text: &str) -> String {
    let mut active = false;
    let mut output = String::new();
    for line in text.lines() {
        if line.trim() == "## Gemini Added Memories" {
            active = true;
            continue;
        }
        if active && line.starts_with("## ") {
            break;
        }
        if active {
            output.push_str(line);
            output.push('\n');
        }
    }
    output
}
pub fn collect(
    ctx: &Context,
    state: &State,
    definition: &str,
    config: Option<&str>,
) -> Result<ImportPreview, String> {
    let root = native_root(definition, config)?;
    let mut paths = Vec::new();
    let mut warnings = Vec::new();
    if let Some(root) = &ctx.project {
        for name in ["AGENTS.md", "CLAUDE.md", "GEMINI.md", "QWEN.md"] {
            paths.push((root.clone(), PathBuf::from(name)));
        }
    }
    if let Some(root) = root {
        match definition {
            "claude" => {
                if let Some(project) = &ctx.project {
                    let slug = project
                        .to_string_lossy()
                        .chars()
                        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
                        .collect::<String>();
                    files_in(
                        &root,
                        &PathBuf::from("projects").join(slug).join("memory"),
                        &mut paths,
                        &mut warnings,
                    );
                }
            }
            "codex" => {
                for folder in ["memories", "memories_v2"] {
                    files_in(&root, Path::new(folder), &mut paths, &mut warnings);
                    files_in(
                        &root,
                        &PathBuf::from(folder).join("rollout_summaries"),
                        &mut paths,
                        &mut warnings,
                    );
                }
            }
            "gemini" => paths.push((root, PathBuf::from("GEMINI.md"))),
            "qwen" => paths.push((root, PathBuf::from("QWEN.md"))),
            _ => {}
        }
    }
    paths.sort();
    paths.dedup();
    if paths.len() > 128 {
        warnings.push("memory.importSkipped".into());
        paths.truncate(128);
    }
    let mut seen = state
        .user
        .entries
        .iter()
        .chain(&state.project.entries)
        .map(|entry| normalized(&entry.content))
        .collect::<BTreeSet<_>>();
    let mut candidates = Vec::new();
    let mut fingerprints = Vec::new();
    for (root, relative) in paths {
        if redact::forbidden(&relative) {
            continue;
        }
        let raw = match storage::read(&root, &relative) {
            Ok(Some(raw)) => raw,
            Ok(None) => continue,
            Err(_) => {
                warnings.push("memory.importSkipped".into());
                continue;
            }
        };
        if raw.len() > 64 * 1024 {
            warnings.push("memory.importSkipped".into());
            continue;
        }
        let Ok(text) = String::from_utf8(raw.clone()) else {
            warnings.push("memory.importSkipped".into());
            continue;
        };
        fingerprints.push((root.join(&relative).display().to_string(), digest(&raw)));
        let text = match render::outside(&text) {
            Ok(text) => strip_shared(&text),
            Err(_) => {
                warnings.push("memory.importSkipped".into());
                continue;
            }
        };
        let text = if relative.file_name().is_some_and(|name| name == "GEMINI.md") {
            gemini_memories(&text)
        } else {
            text
        };
        for (kind, content) in paragraphs(&text, Kind::Project) {
            if candidates.len() >= 256 {
                warnings.push("memory.importSkipped".into());
                break;
            }
            if content.len() > MAX_ENTRY {
                warnings.push("memory.importSkipped".into());
                continue;
            }
            let normalized = normalized(&content);
            if normalized.is_empty() || !seen.insert(normalized) {
                continue;
            }
            let safe = redact::text(&content);
            let source = Source {
                kind: "cli".into(),
                cli: Some(
                    match relative.file_name().and_then(|name| name.to_str()) {
                        Some("AGENTS.md") => "shared",
                        Some("CLAUDE.md") => "claude",
                        Some("GEMINI.md") => "gemini",
                        Some("QWEN.md") => "qwen",
                        _ => definition,
                    }
                    .into(),
                ),
                conversation_id: None,
                path: Some(redact::text(&root.join(&relative).display().to_string())),
            };
            let id = digest(format!("{}\0{}", root.join(&relative).display(), content).as_bytes());
            let blocked = safe != content || safe.contains("[REDACTED]");
            candidates.push(Candidate {
                id,
                kind,
                content: safe,
                source,
                blocked,
            });
            if candidates.len() >= 256 {
                warnings.push("memory.importSkipped".into());
                break;
            }
        }
    }
    let revision = digest(
        &serde_json::to_vec(&(
            &state.revision,
            fingerprints,
            &candidates
                .iter()
                .map(|candidate| &candidate.id)
                .collect::<Vec<_>>(),
        ))
        .map_err(|_| "memory.format")?,
    );
    Ok(ImportPreview {
        revision,
        candidates,
        warnings,
    })
}
