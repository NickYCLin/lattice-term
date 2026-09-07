//! Reading a CLI's own conversation history off disk.
//!
//! Different agent CLIs can't share memory, but each writes its conversation to
//! a structured file. Reading the source CLI's transcript and handing it to a
//! new CLI as an opening brief is the closest thing to "carrying the memory
//! over": the target sees the actual exchange and can continue from it.
//!
//! Every supported source hands context to the new CLI through a one-time
//! brief owned by LatticeTerm. We never write another CLI's memory or session
//! store: those directory trees can be changed by a running sandboxed CLI.
//!
//! Only CLIs whose on-disk format is verified are supported; everything else
//! returns `None` so the caller can stop an opt-in transfer safely.

use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::Write as _;
use std::io::{self, BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt;

const MAX_CODEX_SESSION_META_BYTES: usize = 256 * 1024;
const MAX_CLAUDE_SESSION_META_BYTES: u64 = 512 * 1024;
const MAX_CLAUDE_SESSION_META_LINES: usize = 64;
const MAX_TRANSCRIPT_FILE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_TRANSCRIPT_LINE_BYTES: usize = 2 * 1024 * 1024;
const MAX_TRANSCRIPT_SEARCH_DEPTH: usize = 32;
const MAX_TRANSCRIPT_SEARCH_ENTRIES: usize = 50_000;
const MAX_GEMINI_PROJECT_ROOT_BYTES: usize = 8 * 1024;
const MAX_GEMINI_MESSAGE_ID_BYTES: usize = 256;
const MAX_GEMINI_MESSAGE_RECORDS: usize = 50_000;
const MAX_GEMINI_TRANSCRIPT_TEXT_BYTES: usize = 16 * 1024 * 1024;

/// CLIs whose transcript layout we know how to read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranscriptKind {
    /// `~/.gemini/antigravity-cli/brain/<conversation>/.system_generated/logs/transcript.jsonl`
    Antigravity,
    /// `~/.claude/projects/<cwd-slug>/<session>.jsonl`
    Claude,
    /// `~/.codex/sessions/YYYY/MM/DD/rollout-*-<session>.jsonl`
    Codex,
    /// `~/.gemini/tmp/<project-hash>/chats/session-*.jsonl`
    Gemini,
}

impl TranscriptKind {
    pub fn from_definition(definition_id: &str) -> Option<Self> {
        match definition_id {
            "antigravity" => Some(Self::Antigravity),
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            "gemini" => Some(Self::Gemini),
            _ => None,
        }
    }
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Largest handoff brief written to disk. The exporter already caps what it
/// produces; this only bounds what a caller can hand in.
const MAX_HANDOFF_FILE_BYTES: usize = 256 * 1024;
/// A brief is for the CLI that starts next, not an archive; anything older
/// than this is swept on the next write.
const HANDOFF_FILE_TTL: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

/// Writes a handoff brief where the next CLI can read it, and returns the
/// path to point that CLI at.
///
/// Pasting tens of kilobytes into a terminal UI is slow (the interface
/// ingests it a keystroke at a time) and the model then has to digest all
/// of it before the person can say anything. A file plus a one-line pointer
/// makes the new CLI interactive at once; it reads the brief with its own
/// file tool, which is what those tools are fast at. The file lives under
/// LatticeTerm's data directory, owner-only, and is swept after a day.
pub fn write_handoff_file(
    data_dir: &Path,
    source_label: &str,
    transcript: &str,
) -> Result<PathBuf, String> {
    if transcript.trim().is_empty() {
        return Err("There is no conversation to hand off.".to_string());
    }
    if transcript.len() > MAX_HANDOFF_FILE_BYTES {
        return Err("The handoff is too large to write.".to_string());
    }
    let label: String = source_label
        .chars()
        .filter(|c| !c.is_control())
        .take(64)
        .collect();
    let dir = data_dir.join("handoffs");
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Cannot create the handoff directory: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }
    prune_handoff_files(&dir, std::time::SystemTime::now());

    let body = format!(
        "# 交接自 {}\n\n{}\n",
        if label.is_empty() {
            "另一個 AI 助理"
        } else {
            &label
        },
        transcript.trim()
    );
    // A random name that cannot collide, created owner-only (0600) and
    // kept rather than deleted on drop.
    let mut file = tempfile::Builder::new()
        .prefix("handoff-")
        .suffix(".md")
        .tempfile_in(&dir)
        .map_err(|error| format!("Cannot write the handoff file: {error}"))?;
    file.write_all(body.as_bytes())
        .map_err(|error| format!("Cannot write the handoff file: {error}"))?;
    file.as_file().sync_all().ok();
    let path = file
        .keep()
        .map_err(|error| format!("Cannot keep the handoff file: {error}"))?
        .1;
    Ok(path.canonicalize().unwrap_or(path))
}

/// Removes briefs past their day; a failure here is not a failure to hand
/// off, so nothing is reported.
fn prune_handoff_files(dir: &Path, now: std::time::SystemTime) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_brief = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("handoff-") && name.ends_with(".md"));
        if !is_brief {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let expired = metadata
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > HANDOFF_FILE_TTL);
        if expired {
            let _ = fs::remove_file(&path);
        }
    }
}

/// Compatibility for an older WebView. Returning false makes it use the
/// one-time handoff path without touching CLI-controlled directories.
pub fn import_handoff_into_memory(
    _target_definition_id: &str,
    _working_directory: &str,
    _source_label: &str,
    _transcript: &str,
) -> Result<bool, String> {
    Ok(false)
}

/// The most recently modified file in `dir` for which `keep` holds.
fn newest_matching(dir: &Path, keep: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    newest_matching_with_limits(
        dir,
        MAX_TRANSCRIPT_SEARCH_ENTRIES,
        MAX_TRANSCRIPT_SEARCH_DEPTH,
        keep,
    )
}

fn newest_matching_with_limits(
    dir: &Path,
    max_entries: usize,
    max_depth: usize,
    keep: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    let mut stack = vec![(dir.to_path_buf(), 0usize)];
    let mut visited = 0usize;
    while let Some((current, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            visited = visited.saturating_add(1);
            if visited > max_entries {
                return None;
            }
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            // Transcript roots are user-writable. Never let a nested symlink
            // turn a bounded history search into a scan outside that root.
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                if depth < max_depth {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            if !keep(&path) {
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            let modified = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
            if best
                .as_ref()
                .is_none_or(|(best_time, _)| modified > *best_time)
            {
                best = Some((modified, path));
            }
        }
    }
    best.map(|(_, path)| path)
}

/// Opens a regular transcript without following a final symlink, then checks
/// the opened handle rather than trusting path metadata that can race.
fn open_regular_transcript(path: &Path) -> Option<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW);
    #[cfg(windows)]
    options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    let file = options.open(path).ok()?;
    let metadata = file.metadata().ok()?;
    (metadata.is_file() && metadata.len() <= MAX_TRANSCRIPT_FILE_BYTES).then_some(file)
}

/// Keeps only the last `max_chars` characters without allowing the assembled
/// transcript to grow with the full on-disk history.
fn trim_tail(text: &mut String, max_chars: usize) -> bool {
    let count = text.chars().count();
    if count <= max_chars {
        return false;
    }
    let skip = count - max_chars;
    *text = text.chars().skip(skip).collect();
    true
}

/// Flattens a Claude/Codex content value (string, or an array of typed blocks)
/// into the plain text a human wrote or read, dropping tool calls and images.
fn content_text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.trim().to_string();
    }
    let Some(items) = content.as_array() else {
        return String::new();
    };
    let mut parts = Vec::new();
    for item in items {
        let kind = item.get("type").and_then(Value::as_str).unwrap_or("");
        if matches!(kind, "text" | "input_text" | "output_text") {
            if let Some(text) = item.get("text").and_then(Value::as_str) {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    parts.push(trimmed.to_string());
                }
            }
        }
    }
    parts.join("\n")
}

fn push_turn(out: &mut String, role: &str, text: &str) {
    if text.is_empty() {
        return;
    }
    let label = match role {
        "user" => "【使用者】",
        "assistant" => "【助理】",
        _ => return,
    };
    out.push_str(label);
    out.push('\n');
    out.push_str(text);
    out.push_str("\n\n");
}

/// Reads one JSONL row while discarding an oversized row in fixed-size reader
/// buffers. `Some(false)` means a row was present but exceeded the cap.
fn read_bounded_line<R: BufRead>(
    reader: &mut R,
    line: &mut Vec<u8>,
    max_bytes: usize,
) -> io::Result<Option<bool>> {
    line.clear();
    let mut saw_data = false;
    let mut oversized = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            if !saw_data {
                return Ok(None);
            }
            break;
        }
        saw_data = true;
        let newline = available.iter().position(|byte| *byte == b'\n');
        let data_len = newline.unwrap_or(available.len());
        if !oversized {
            if data_len <= max_bytes.saturating_sub(line.len()) {
                line.extend_from_slice(&available[..data_len]);
            } else {
                line.clear();
                oversized = true;
            }
        }
        reader.consume(data_len + usize::from(newline.is_some()));
        if newline.is_some() {
            break;
        }
    }
    if !oversized && line.last() == Some(&b'\r') {
        line.pop();
    }
    Ok(Some(!oversized))
}

/// Streams a bounded JSONL transcript. The file and each individual row have
/// independent caps; malformed rows are ignored as before, while oversized
/// rows are reported so the handoff can disclose that earlier content was cut.
fn visit_transcript_rows(path: &Path, mut visit: impl FnMut(&Value)) -> Option<bool> {
    let file = open_regular_transcript(path)?;
    // The handle may grow after metadata was checked. A `Take` cap keeps the
    // actual read bounded; one sentinel byte lets us detect and reject growth.
    let mut reader = BufReader::new(file).take(MAX_TRANSCRIPT_FILE_BYTES + 1);
    let mut line = Vec::new();
    let mut skipped_oversized = false;
    loop {
        match read_bounded_line(&mut reader, &mut line, MAX_TRANSCRIPT_LINE_BYTES).ok()? {
            None => break,
            Some(false) => skipped_oversized = true,
            Some(true) => {
                if let Ok(value) = serde_json::from_slice::<Value>(&line) {
                    visit(&value);
                }
            }
        }
    }
    if reader.limit() == 0 {
        return None;
    }
    Some(skipped_oversized)
}

fn finish_transcript(out: String, truncated: bool) -> Option<String> {
    let trimmed = out.trim();
    if trimmed.is_empty() {
        return None;
    }
    if truncated {
        Some(format!("…（更早的對話已略過）…\n\n{trimmed}"))
    } else {
        Some(trimmed.to_string())
    }
}

fn parse_claude(path: &Path, max_chars: usize) -> Option<String> {
    if max_chars == 0 {
        return None;
    }
    let mut out = String::new();
    let mut truncated = false;
    let skipped_oversized = visit_transcript_rows(path, |value| {
        let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
        if kind != "user" && kind != "assistant" {
            return;
        }
        let message = value.get("message");
        let role = message
            .and_then(|m| m.get("role"))
            .and_then(Value::as_str)
            .unwrap_or(kind);
        let text = message
            .and_then(|m| m.get("content"))
            .map(content_text)
            .unwrap_or_default();
        push_turn(&mut out, role, &text);
        truncated |= trim_tail(&mut out, max_chars);
    })?;
    finish_transcript(out, truncated || skipped_oversized)
}

fn parse_codex(path: &Path, max_chars: usize) -> Option<String> {
    if max_chars == 0 {
        return None;
    }
    let mut out = String::new();
    let mut truncated = false;
    let skipped_oversized = visit_transcript_rows(path, |value| {
        // Conversation turns live in the payload; skip meta, tool and world rows.
        let Some(payload) = value.get("payload") else {
            return;
        };
        if payload.get("type").and_then(Value::as_str) != Some("message") {
            return;
        }
        let role = payload.get("role").and_then(Value::as_str).unwrap_or("");
        if role != "user" && role != "assistant" {
            return;
        }
        let text = payload.get("content").map(content_text).unwrap_or_default();
        push_turn(&mut out, role, &text);
        truncated |= trim_tail(&mut out, max_chars);
    })?;
    finish_transcript(out, truncated || skipped_oversized)
}

/// Gemini stores text blocks without the Claude/Codex `type` discriminator.
/// Only read plain text blocks; tool payloads and any unknown block stay out
/// of a cross-CLI handoff.
fn gemini_content_text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.trim().to_string();
    }
    let Some(items) = content.as_array() else {
        return String::new();
    };
    items
        .iter()
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn gemini_role(message: &Value) -> Option<&'static str> {
    match message
        .get("role")
        .or_else(|| message.get("type"))
        .and_then(Value::as_str)
    {
        Some("user") => Some("user"),
        Some("assistant") | Some("gemini") | Some("model") => Some("assistant"),
        _ => None,
    }
}

struct GeminiMessageRecord {
    id: String,
    role: Option<&'static str>,
    text: String,
}

fn gemini_message_record(message: &Value) -> Option<GeminiMessageRecord> {
    let id = message.get("id").and_then(Value::as_str)?;
    if id.is_empty() || id.len() > MAX_GEMINI_MESSAGE_ID_BYTES {
        return None;
    }
    let role = gemini_role(message);
    let mut text = role
        .and_then(|_| message.get("content"))
        .map(gemini_content_text)
        .unwrap_or_default();
    let trimmed = text.trim_start();
    if role == Some("user")
        && (trimmed.starts_with("<session_context>")
            || trimmed.starts_with("<hook_context>")
            || trimmed.starts_with('/'))
    {
        text.clear();
    }
    Some(GeminiMessageRecord {
        id: id.to_string(),
        role,
        text,
    })
}

fn upsert_gemini_message(
    records: &mut Vec<GeminiMessageRecord>,
    positions: &mut HashMap<String, usize>,
    text_bytes: &mut usize,
    message: &Value,
) -> bool {
    let Some(record) = gemini_message_record(message) else {
        return false;
    };
    if let Some(index) = positions.get(&record.id).copied() {
        *text_bytes = text_bytes
            .saturating_sub(records[index].text.len())
            .saturating_add(record.text.len());
        records[index] = record;
    } else {
        if records.len() >= MAX_GEMINI_MESSAGE_RECORDS {
            return false;
        }
        *text_bytes = text_bytes.saturating_add(record.text.len());
        positions.insert(record.id.clone(), records.len());
        records.push(record);
    }
    *text_bytes <= MAX_GEMINI_TRANSCRIPT_TEXT_BYTES
}

fn reset_gemini_messages(
    records: &mut Vec<GeminiMessageRecord>,
    positions: &mut HashMap<String, usize>,
    text_bytes: &mut usize,
    messages: &[Value],
) -> bool {
    records.clear();
    positions.clear();
    *text_bytes = 0;
    messages
        .iter()
        .all(|message| upsert_gemini_message(records, positions, text_bytes, message))
}

fn rewind_gemini_messages(
    records: &mut Vec<GeminiMessageRecord>,
    positions: &mut HashMap<String, usize>,
    text_bytes: &mut usize,
    rewind_to: &str,
) {
    let Some(index) = positions.get(rewind_to).copied() else {
        records.clear();
        positions.clear();
        *text_bytes = 0;
        return;
    };
    records.truncate(index);
    positions.clear();
    *text_bytes = 0;
    for (index, record) in records.iter().enumerate() {
        positions.insert(record.id.clone(), index);
        *text_bytes = text_bytes.saturating_add(record.text.len());
    }
}

fn parse_gemini(path: &Path, max_chars: usize) -> Option<String> {
    if max_chars == 0 {
        return None;
    }
    let mut records = Vec::new();
    let mut positions = HashMap::new();
    let mut text_bytes = 0usize;
    let mut valid = true;
    let skipped_oversized = visit_transcript_rows(path, |value| {
        if !valid {
            return;
        }
        if let Some(rewind_to) = value.get("$rewindTo").and_then(Value::as_str) {
            rewind_gemini_messages(&mut records, &mut positions, &mut text_bytes, rewind_to);
        } else if value.get("id").and_then(Value::as_str).is_some() {
            valid = upsert_gemini_message(&mut records, &mut positions, &mut text_bytes, value);
        } else if let Some(messages) = value
            .get("$set")
            .and_then(|set| set.get("messages"))
            .and_then(Value::as_array)
        {
            valid = reset_gemini_messages(&mut records, &mut positions, &mut text_bytes, messages);
        } else if let Some(messages) = value.get("messages").and_then(Value::as_array) {
            valid = messages.iter().all(|message| {
                upsert_gemini_message(&mut records, &mut positions, &mut text_bytes, message)
            });
        }
    })?;
    // An oversized row could be a rewind or replacement operation. Returning
    // partial state would hand the wrong conversation to another CLI.
    if !valid || skipped_oversized {
        return None;
    }
    let mut out = String::new();
    let mut truncated = false;
    for record in records {
        if let Some(role) = record.role {
            push_turn(&mut out, role, &record.text);
            truncated |= trim_tail(&mut out, max_chars);
        }
    }
    finish_transcript(out, truncated)
}

fn parse_antigravity(path: &Path, max_chars: usize) -> Option<String> {
    if max_chars == 0 {
        return None;
    }
    let mut out = String::new();
    let mut truncated = false;
    let skipped_oversized = visit_transcript_rows(path, |value| {
        if value.get("status").and_then(Value::as_str) != Some("DONE") {
            return;
        }
        let role = match (
            value.get("source").and_then(Value::as_str),
            value.get("type").and_then(Value::as_str),
        ) {
            (Some("USER_EXPLICIT"), Some("USER_INPUT")) => "user",
            (Some("MODEL"), Some("PLANNER_RESPONSE")) => "assistant",
            _ => return,
        };
        let Some(text) = value.get("content").and_then(Value::as_str) else {
            return;
        };
        push_turn(&mut out, role, text);
        truncated |= trim_tail(&mut out, max_chars);
    })?;
    finish_transcript(out, truncated || skipped_oversized)
}

struct ClaudeSessionMeta {
    id: String,
    cwd: String,
    is_main: bool,
}

/// Claude's first rows contain the session ID, while `cwd` and sidechain state
/// normally appear on the first user message a few rows later. Scan a bounded
/// prefix rather than trusting the lossy project-directory slug, which can
/// collide for distinct paths.
fn read_claude_session_meta(path: &Path) -> Option<ClaudeSessionMeta> {
    let file = open_regular_transcript(path)?;
    let mut reader = BufReader::new(file).take(MAX_CLAUDE_SESSION_META_BYTES + 1);
    let mut line = Vec::new();
    let mut session_id = None;
    let mut candidate_cwd: Option<String> = None;
    let mut explicit_main_seen = false;
    let mut sidechain_seen = false;
    let mut agent_seen = false;

    for _ in 0..MAX_CLAUDE_SESSION_META_LINES {
        line.clear();
        let read = reader.read_until(b'\n', &mut line).ok()?;
        if read == 0 {
            break;
        }
        if line.len() > MAX_CODEX_SESSION_META_BYTES {
            return None;
        }
        while matches!(line.last(), Some(b'\n' | b'\r')) {
            line.pop();
        }
        let Ok(value) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        if let Some(id) = value.get("sessionId").and_then(Value::as_str) {
            match session_id.as_deref() {
                Some(existing) if existing != id => return None,
                None => session_id = Some(id.to_string()),
                _ => {}
            }
        }
        sidechain_seen |= value.get("isSidechain").and_then(Value::as_bool) == Some(true);
        agent_seen |= value
            .get("agentId")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty());
        let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
        if !matches!(kind, "user" | "assistant") {
            continue;
        }
        let Some(cwd) = value
            .get("cwd")
            .and_then(Value::as_str)
            .filter(|cwd| !cwd.is_empty())
        else {
            continue;
        };
        let Some(is_sidechain) = value.get("isSidechain").and_then(Value::as_bool) else {
            // A missing sidechain marker is ambiguous. Keep scanning for a
            // verified conversation row instead of rejecting too early.
            continue;
        };
        if candidate_cwd.as_deref().is_some_and(|known| known != cwd) {
            return None;
        }
        candidate_cwd.get_or_insert_with(|| cwd.to_string());
        explicit_main_seen |= !is_sidechain;
    }
    Some(ClaudeSessionMeta {
        id: session_id?,
        cwd: candidate_cwd?,
        is_main: explicit_main_seen && !sidechain_seen && !agent_seen,
    })
}

fn is_jsonl(path: &Path) -> bool {
    path.extension().is_some_and(|ext| ext == "jsonl")
}

fn locate_claude_in(
    projects_root: &Path,
    working_directory: &str,
    captured: Option<&str>,
) -> Option<PathBuf> {
    let projects_root = fs::canonicalize(projects_root).ok()?;
    if let Some(id) = captured {
        return newest_matching(&projects_root, |path| {
            is_jsonl(path)
                && read_claude_session_meta(path).is_some_and(|meta| meta.is_main && meta.id == id)
        });
    }

    let expected_cwd = fs::canonicalize(working_directory).ok()?;
    newest_matching(&projects_root, |path| {
        if !is_jsonl(path) {
            return false;
        }
        let Some(meta) = read_claude_session_meta(path) else {
            return false;
        };
        meta.is_main
            && fs::canonicalize(meta.cwd)
                .ok()
                .is_some_and(|cwd| cwd == expected_cwd)
    })
}

fn locate_claude(working_directory: &str, captured: Option<&str>) -> Option<PathBuf> {
    let projects_root = home()?.join(".claude").join("projects");
    locate_claude_in(&projects_root, working_directory, captured)
}

struct CodexSessionMeta {
    id: Option<String>,
    cwd: Option<String>,
    source_is_string: bool,
    source_is_known_main_cli: bool,
}

/// Codex keeps the session identity in the first JSONL row. Read only a
/// bounded prefix so a malformed history cannot allocate an unbounded buffer
/// merely while LatticeTerm is deciding which transcript belongs to a pane.
fn read_codex_session_meta(path: &Path) -> Option<CodexSessionMeta> {
    let file = open_regular_transcript(path)?;
    let mut reader = BufReader::new(file).take((MAX_CODEX_SESSION_META_BYTES + 2) as u64);
    let mut line = Vec::with_capacity(MAX_CODEX_SESSION_META_BYTES.min(8 * 1024));
    reader.read_until(b'\n', &mut line).ok()?;
    if line.last() == Some(&b'\n') {
        line.pop();
    }
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    if line.len() > MAX_CODEX_SESSION_META_BYTES {
        return None;
    }
    let value = serde_json::from_slice::<Value>(&line).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("session_meta") {
        return None;
    }
    let payload = value.get("payload")?;
    let source = payload.get("source").and_then(Value::as_str);
    let originator = payload.get("originator").and_then(Value::as_str);
    Some(CodexSessionMeta {
        id: payload
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string),
        cwd: payload
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::to_string),
        source_is_string: source.is_some(),
        source_is_known_main_cli: source == Some("cli")
            || matches!(
                (source, originator),
                (Some("unknown"), Some("codex_cli_rs"))
            ),
    })
}

fn is_codex_rollout(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("rollout-"))
        && path.extension().is_some_and(|ext| ext == "jsonl")
}

fn locate_codex_in(
    sessions_root: &Path,
    working_directory: &str,
    captured: Option<&str>,
) -> Option<PathBuf> {
    let root = fs::canonicalize(sessions_root).ok()?;
    if let Some(id) = captured {
        return newest_matching(&root, |path| {
            is_codex_rollout(path)
                && read_codex_session_meta(path)
                    .is_some_and(|meta| meta.source_is_string && meta.id.as_deref() == Some(id))
        });
    }

    let expected_cwd = fs::canonicalize(working_directory).ok()?;
    newest_matching(&root, |path| {
        if !is_codex_rollout(path) {
            return false;
        }
        let Some(meta) = read_codex_session_meta(path) else {
            return false;
        };
        meta.source_is_known_main_cli
            && meta
                .cwd
                .and_then(|cwd| fs::canonicalize(cwd).ok())
                .is_some_and(|cwd| cwd == expected_cwd)
    })
}

fn locate_codex(working_directory: &str, captured: Option<&str>) -> Option<PathBuf> {
    let root = home()?.join(".codex").join("sessions");
    locate_codex_in(&root, working_directory, captured)
}

fn is_gemini_session(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("session-"))
        && path
            .extension()
            .is_some_and(|extension| extension == "jsonl")
}

/// Gemini records the project root beside each hashed chat directory. Read a
/// small, regular file only, then canonicalize it before matching a session.
fn read_gemini_project_root(path: &Path) -> Option<PathBuf> {
    let file = open_regular_transcript(path)?;
    let mut contents = String::new();
    file.take((MAX_GEMINI_PROJECT_ROOT_BYTES + 1) as u64)
        .read_to_string(&mut contents)
        .ok()?;
    if contents.len() > MAX_GEMINI_PROJECT_ROOT_BYTES || contents.contains('\0') {
        return None;
    }
    fs::canonicalize(contents.trim()).ok()
}

fn read_gemini_session_id(path: &Path) -> Option<String> {
    let file = open_regular_transcript(path)?;
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    if !read_bounded_line(&mut reader, &mut line, MAX_TRANSCRIPT_LINE_BYTES)
        .ok()?
        .unwrap_or(false)
    {
        return None;
    }
    serde_json::from_slice::<Value>(&line)
        .ok()?
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn gemini_project_root(working_directory: &str) -> Option<PathBuf> {
    // Gemini's Storage project root is the exact target directory passed at
    // launch, unlike Claude auto-memory which deliberately scopes to the Git
    // repository. Matching a parent repository here would select the wrong
    // chat when Gemini was launched from a subdirectory.
    fs::canonicalize(working_directory).ok()
}

fn gemini_session_matches(path: &Path, expected_root: &Path, captured: Option<&str>) -> bool {
    if captured.is_some_and(|id| read_gemini_session_id(path).as_deref() != Some(id)) {
        return false;
    }
    let Some(project_root_file) = path
        .parent()
        .and_then(Path::parent)
        .map(|directory| directory.join(".project_root"))
    else {
        return false;
    };
    read_gemini_project_root(&project_root_file).is_some_and(|root| root == expected_root)
}

fn locate_gemini_in(
    sessions_root: &Path,
    working_directory: &str,
    captured: Option<&str>,
) -> Option<PathBuf> {
    let root = fs::canonicalize(sessions_root).ok()?;
    let expected_root = gemini_project_root(working_directory)?;
    newest_matching(&root, |path| {
        is_gemini_session(path) && gemini_session_matches(path, &expected_root, captured)
    })
}

fn locate_gemini(working_directory: &str, captured: Option<&str>) -> Option<PathBuf> {
    let root = home()?.join(".gemini").join("tmp");
    locate_gemini_in(&root, working_directory, captured)
}

fn antigravity_conversation_id(value: &str) -> bool {
    value.len() == 36
        && value.chars().enumerate().all(|(index, character)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                character == '-'
            } else {
                character.is_ascii_hexdigit()
            }
        })
}

fn locate_antigravity_in(root: &Path, captured: Option<&str>) -> Option<PathBuf> {
    let captured = captured.filter(|value| antigravity_conversation_id(value))?;
    let root = fs::canonicalize(root).ok()?;
    let transcript = root
        .join("brain")
        .join(captured)
        .join(".system_generated")
        .join("logs")
        .join("transcript.jsonl");
    let canonical = fs::canonicalize(&transcript).ok()?;
    canonical.starts_with(&root).then_some(canonical)
}

fn locate_antigravity(captured: Option<&str>) -> Option<PathBuf> {
    let root = home()?.join(".gemini").join("antigravity-cli");
    locate_antigravity_in(&root, captured)
}

/// Reads the source CLI's most relevant conversation and returns it as plain,
/// role-labelled text capped at `max_chars`, or `None` when nothing is found.
pub fn export(
    kind: TranscriptKind,
    working_directory: &str,
    captured_session_id: Option<&str>,
    profile_directory: Option<&Path>,
    max_chars: usize,
) -> Option<String> {
    // A missing or malformed account root must not fall back to somebody
    // else's default history, including when no native id was captured yet.
    if let Some(profile) = profile_directory {
        if !profile.is_absolute() || !profile.is_dir() {
            return None;
        }
    }
    match kind {
        TranscriptKind::Antigravity => {
            let path = locate_antigravity(captured_session_id)?;
            parse_antigravity(&path, max_chars)
        }
        TranscriptKind::Claude => {
            let path = match profile_directory {
                Some(profile) => locate_claude_in(
                    &profile.join("projects"),
                    working_directory,
                    captured_session_id,
                ),
                None => locate_claude(working_directory, captured_session_id),
            }?;
            parse_claude(&path, max_chars)
        }
        TranscriptKind::Codex => {
            let path = match profile_directory {
                Some(profile) => locate_codex_in(
                    &profile.join("sessions"),
                    working_directory,
                    captured_session_id,
                ),
                None => locate_codex(working_directory, captured_session_id),
            }?;
            parse_codex(&path, max_chars)
        }
        TranscriptKind::Gemini => {
            let path = locate_gemini(working_directory, captured_session_id)?;
            parse_gemini(&path, max_chars)
        }
    }
}

#[cfg(test)]
mod tests {
    // Claude's fixture directory layout; production lookup verifies the
    // transcript metadata instead of trusting a project slug alone.
    fn claude_slug(working_directory: &str) -> String {
        working_directory
            .chars()
            .map(|ch| match ch {
                '/' | '\\' | ':' => '-',
                other => other,
            })
            .collect()
    }

    use super::*;

    #[test]
    fn handoff_files_are_private_named_and_swept_after_a_day() {
        let data = tempfile::tempdir().unwrap();
        let path =
            write_handoff_file(data.path(), "OpenAI Codex", "user: hi\nassistant: hello").unwrap();
        assert!(path.starts_with(data.path().join("handoffs")));
        assert!(path
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("handoff-"));
        let body = fs::read_to_string(&path).unwrap();
        assert!(body.starts_with("# 交接自 OpenAI Codex\n"));
        assert!(body.contains("assistant: hello"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }

        // A day-old brief goes on the next write; a fresh one stays.
        set_modified(&path, 1);
        let second = write_handoff_file(data.path(), "x", "later").unwrap();
        assert!(!path.exists(), "expired brief was kept");
        assert!(second.exists());

        assert!(write_handoff_file(data.path(), "x", "   ").is_err());
        assert!(
            write_handoff_file(data.path(), "x", &"a".repeat(MAX_HANDOFF_FILE_BYTES + 1)).is_err()
        );
    }

    /// Times a real export against this machine's own histories. Ignored:
    /// it depends on what the user has on disk. `cargo test time_real_export -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn time_real_export() {
        let cwd = std::env::var("LATTICETERM_TIMING_CWD")
            .unwrap_or_else(|_| std::env::current_dir().unwrap().display().to_string());
        for (label, path) in [
            (
                "claude-big",
                std::env::var("LATTICETERM_TIMING_CLAUDE").ok(),
            ),
            ("codex-big", std::env::var("LATTICETERM_TIMING_CODEX").ok()),
        ] {
            if let Some(path) = path {
                let path = PathBuf::from(path);
                let started = std::time::Instant::now();
                let out = if label.starts_with("claude") {
                    parse_claude(&path, 64 * 1024)
                } else {
                    parse_codex(&path, 64 * 1024)
                };
                eprintln!(
                    "{label}: parse {:?} bytes={} chars={}",
                    started.elapsed(),
                    fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
                    out.map(|t| t.chars().count()).unwrap_or(0)
                );
            }
        }
        for kind in [TranscriptKind::Codex, TranscriptKind::Claude] {
            let started = std::time::Instant::now();
            let path = match kind {
                TranscriptKind::Codex => locate_codex(&cwd, None),
                TranscriptKind::Claude => locate_claude(&cwd, None),
                _ => None,
            };
            let located = started.elapsed();
            let parsed = path.as_ref().map(|path| {
                let started = std::time::Instant::now();
                let out = match kind {
                    TranscriptKind::Codex => parse_codex(path, 64 * 1024),
                    _ => parse_claude(path, 64 * 1024),
                };
                (
                    started.elapsed(),
                    out.map(|text| text.len()).unwrap_or(0),
                    fs::metadata(path).map(|m| m.len()).unwrap_or(0),
                )
            });
            eprintln!("{kind:?}: locate {located:?} path={path:?} parse={parsed:?}");
        }
    }

    fn set_modified(path: &Path, seconds: u64) {
        let times = fs::FileTimes::new()
            .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(seconds));
        fs::OpenOptions::new()
            .write(true)
            .open(path)
            .unwrap()
            .set_times(times)
            .unwrap();
    }

    fn write_codex_rollout(
        path: &Path,
        id: &str,
        cwd: &Path,
        source: Value,
        originator: &str,
        modified: u64,
    ) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let rows = [
            serde_json::json!({
                "type": "session_meta",
                "payload": {
                    "id": id,
                    "cwd": cwd.to_string_lossy(),
                    "source": source,
                    "originator": originator,
                }
            })
            .to_string(),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": id}],
                }
            })
            .to_string(),
        ];
        fs::write(path, rows.join("\n")).unwrap();
        set_modified(path, modified);
    }

    #[test]
    fn account_profile_exports_never_cross_into_another_accounts_history() {
        let directory = tempfile::tempdir().unwrap();
        let cwd = directory.path();
        let a = directory.path().join("account-a");
        let b = directory.path().join("account-b");
        for (root, id, modified) in [(&a, "session-a", 20), (&b, "session-b", 10)] {
            write_codex_rollout(
                &root.join("sessions").join(format!("rollout-{id}.jsonl")),
                id,
                cwd,
                serde_json::json!("cli"),
                "codex_cli_rs",
                modified,
            );
            write_claude_session(
                &root.join("projects").join(format!("{id}.jsonl")),
                id,
                cwd,
                false,
                modified,
            );
        }
        for kind in [TranscriptKind::Codex, TranscriptKind::Claude] {
            let text = export(kind, cwd.to_str().unwrap(), None, Some(&b), 5000).unwrap();
            assert!(text.contains("session-b"));
            assert!(!text.contains("session-a"));
            assert!(export(
                kind,
                cwd.to_str().unwrap(),
                Some("session-a"),
                Some(&b),
                5000
            )
            .is_none());
            assert!(export(
                kind,
                cwd.to_str().unwrap(),
                None,
                Some(&directory.path().join("missing")),
                5000
            )
            .is_none());
        }
    }

    fn write_claude_session(path: &Path, id: &str, cwd: &Path, is_sidechain: bool, modified: u64) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let rows = [
            serde_json::json!({"type": "mode", "sessionId": id}).to_string(),
            serde_json::json!({"type": "permission-mode", "sessionId": id}).to_string(),
            serde_json::json!({
                "type": "user",
                "sessionId": id,
                "cwd": cwd.to_string_lossy(),
                "isSidechain": is_sidechain,
                "message": {"role": "user", "content": id},
            })
            .to_string(),
        ];
        fs::write(path, rows.join("\n")).unwrap();
        set_modified(path, modified);
    }

    #[cfg(unix)]
    #[test]
    fn handoff_does_not_write_through_cli_controlled_memory_directories() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let outside = directory.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("MEMORY.md"), "keep original").unwrap();
        let config = directory.path().join(".claude");
        fs::create_dir(&config).unwrap();
        symlink(&outside, config.join("projects")).unwrap();
        assert!(!import_handoff_into_memory(
            "claude",
            directory.path().to_str().unwrap(),
            "Codex",
            "new context"
        )
        .unwrap());
        let handoff = write_handoff_file(directory.path(), "Codex", "new context").unwrap();
        assert!(fs::read_to_string(handoff).unwrap().contains("new context"));
        assert_eq!(
            fs::read_to_string(outside.join("MEMORY.md")).unwrap(),
            "keep original"
        );
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 1);
    }

    #[test]
    fn content_text_reads_strings_and_text_blocks() {
        assert_eq!(content_text(&Value::String("hi".into())), "hi");
        let blocks = serde_json::json!([
            {"type": "text", "text": "keep me"},
            {"type": "tool_use", "name": "bash"},
            {"type": "output_text", "text": "and me"},
        ]);
        assert_eq!(content_text(&blocks), "keep me\nand me");
    }

    #[test]
    fn recursive_search_fails_closed_when_its_entry_budget_is_exhausted() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("first.jsonl"), b"one").unwrap();
        fs::write(directory.path().join("second.jsonl"), b"two").unwrap();

        assert_eq!(
            newest_matching_with_limits(directory.path(), 1, 1, |_| true),
            None
        );
    }

    #[test]
    fn tail_marks_a_truncation() {
        let mut short = "abcdef".to_string();
        assert!(!trim_tail(&mut short, 10));
        assert_eq!(short, "abcdef");

        let mut long = "abcdef".to_string();
        assert!(trim_tail(&mut long, 3));
        assert_eq!(long, "def");
        assert!(finish_transcript(long, true).unwrap().contains("略過"));
    }

    #[test]
    fn claude_transcript_extracts_user_and_assistant_turns() {
        let dir = tempfile::tempdir().unwrap();
        let slug = claude_slug(dir.path().to_str().unwrap());
        let projects = dir.path().join(".claude").join("projects").join(&slug);
        fs::create_dir_all(&projects).unwrap();
        let jsonl = [
            r#"{"type":"mode","sessionId":"s"}"#,
            r#"{"type":"user","message":{"role":"user","content":"重構 payments"}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"好的"},{"type":"tool_use","name":"bash"}]}}"#,
        ]
        .join("\n");
        fs::write(projects.join("abc.jsonl"), jsonl).unwrap();

        let text = parse_claude(&projects.join("abc.jsonl"), 5000).unwrap();
        assert!(text.contains("【使用者】"));
        assert!(text.contains("重構 payments"));
        assert!(text.contains("【助理】"));
        assert!(text.contains("好的"));
        assert!(!text.contains("bash"));
    }

    #[test]
    fn codex_transcript_reads_payload_messages_only() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("rollout-x.jsonl");
        let jsonl = [
            r#"{"type":"session_meta","payload":{"cwd":"/x"}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"問題一"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"答案一"}]}}"#,
            r#"{"type":"event_msg","payload":{"type":"reasoning"}}"#,
        ]
        .join("\n");
        fs::write(&file, jsonl).unwrap();

        let text = parse_codex(&file, 5000).unwrap();
        assert!(text.contains("問題一"));
        assert!(text.contains("答案一"));
        assert!(!text.contains("reasoning"));
    }

    #[test]
    fn gemini_transcript_exports_the_matching_project_session() {
        let directory = tempfile::tempdir().unwrap();
        let repository = directory.path().join("repository");
        let project = repository.join("packages").join("desktop");
        let gemini_root = directory.path().join(".gemini").join("tmp");
        let session = gemini_root
            .join("project-hash")
            .join("chats")
            .join("session-2026-09-01.jsonl");
        fs::create_dir_all(session.parent().unwrap()).unwrap();
        fs::create_dir_all(&project).unwrap();
        fs::write(repository.join(".git"), "gitdir: nowhere").unwrap();
        fs::write(
            session
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join(".project_root"),
            project.to_string_lossy().as_bytes(),
        )
        .unwrap();
        let rows = [
            serde_json::json!({"sessionId": "gemini-session", "projectHash": "project-hash"})
                .to_string(),
            serde_json::json!({
                "id": "outdated",
                "type": "user",
                "content": [{"text": "discard this old branch"}]
            })
            .to_string(),
            serde_json::json!({
                "$set": {
                    "messages": [
                        {"id": "context", "type": "user", "content": [{"text": "<session_context>ignore</session_context>"}]},
                        {"id": "user-1", "type": "user", "content": [{"text": "remember red panda"}]},
                        {"id": "model-1", "type": "gemini", "content": [{"text": "outdated answer"}]},
                        {"id": "tool-1", "type": "tool", "content": [{"text": "must not transfer"}]}
                    ]
                }
            })
            .to_string(),
            serde_json::json!({"$rewindTo": "model-1"}).to_string(),
            serde_json::json!({
                "id": "model-2",
                "type": "gemini",
                "content": [{"text": "I will remember it"}]
            })
            .to_string(),
        ];
        fs::write(&session, rows.join("\n")).unwrap();

        let located = locate_gemini_in(
            &gemini_root,
            &project.to_string_lossy(),
            Some("gemini-session"),
        )
        .unwrap();
        assert_eq!(located, session);

        let text = parse_gemini(&located, 5000).unwrap();
        assert!(text.contains("remember red panda"));
        assert!(text.contains("I will remember it"));
        assert!(!text.contains("discard this old branch"));
        assert!(!text.contains("outdated answer"));
        assert!(!text.contains("session_context"));
        assert!(!text.contains("must not transfer"));
    }

    #[test]
    fn antigravity_transcript_uses_only_user_prompts_and_final_answers() {
        let directory = tempfile::tempdir().unwrap();
        let conversation_id = "0199aa11-bb22-4c33-8d44-ee55ff667788";
        let transcript = directory
            .path()
            .join("brain")
            .join(conversation_id)
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl");
        fs::create_dir_all(transcript.parent().unwrap()).unwrap();
        let rows = [
            serde_json::json!({
                "step_index": 0,
                "source": "USER_EXPLICIT",
                "type": "USER_INPUT",
                "status": "DONE",
                "content": "remember the blue folder"
            }),
            serde_json::json!({
                "step_index": 1,
                "source": "MODEL",
                "type": "GENERIC",
                "status": "DONE",
                "content": "private tool planning"
            }),
            serde_json::json!({
                "step_index": 2,
                "source": "SYSTEM",
                "type": "SYSTEM_MESSAGE",
                "status": "DONE",
                "content": "tool output"
            }),
            serde_json::json!({
                "step_index": 3,
                "source": "MODEL",
                "type": "PLANNER_RESPONSE",
                "status": "RUNNING",
                "content": "unfinished answer"
            }),
            serde_json::json!({
                "step_index": 4,
                "source": "MODEL",
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "content": "I will remember the blue folder"
            }),
        ];
        fs::write(
            &transcript,
            rows.iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();

        let located = locate_antigravity_in(directory.path(), Some(conversation_id)).unwrap();
        assert_eq!(located, fs::canonicalize(&transcript).unwrap());
        let text = parse_antigravity(&located, 5000).unwrap();
        assert!(text.contains("remember the blue folder"));
        assert!(text.contains("I will remember the blue folder"));
        assert!(!text.contains("private tool planning"));
        assert!(!text.contains("tool output"));
        assert!(!text.contains("unfinished answer"));
        assert!(locate_antigravity_in(directory.path(), Some("../outside")).is_none());
    }

    #[test]
    fn codex_transcript_skips_oversized_rows_and_rejects_oversized_files() {
        let directory = tempfile::tempdir().unwrap();
        let transcript = directory.path().join("rollout-streamed.jsonl");
        let valid = serde_json::json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "仍能讀到後續訊息"}],
            }
        })
        .to_string();
        let mut rows = Vec::with_capacity(MAX_TRANSCRIPT_LINE_BYTES + valid.len() + 2);
        rows.extend(std::iter::repeat_n(b'x', MAX_TRANSCRIPT_LINE_BYTES + 1));
        rows.push(b'\n');
        rows.extend_from_slice(valid.as_bytes());
        fs::write(&transcript, rows).unwrap();

        let text = parse_codex(&transcript, 5_000).unwrap();
        assert!(text.contains("仍能讀到後續訊息"));
        assert!(text.contains("略過"));

        let too_large = directory.path().join("rollout-too-large.jsonl");
        let file = fs::File::create(&too_large).unwrap();
        file.set_len(MAX_TRANSCRIPT_FILE_BYTES + 1).unwrap();
        assert_eq!(parse_codex(&too_large, 5_000), None);
    }

    #[test]
    fn codex_fallback_stays_in_the_same_cwd_and_ignores_subagents() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("sessions");
        let target_cwd = directory.path().join("target");
        let other_cwd = directory.path().join("other");
        fs::create_dir_all(&target_cwd).unwrap();
        fs::create_dir_all(&other_cwd).unwrap();

        let target = root.join("2026/08/30/rollout-target.jsonl");
        write_codex_rollout(
            &target,
            "target-main",
            &target_cwd,
            Value::String("cli".to_string()),
            "codex-tui",
            10,
        );
        write_codex_rollout(
            &root.join("2026/08/30/rollout-other.jsonl"),
            "other-main",
            &other_cwd,
            Value::String("cli".to_string()),
            "codex-tui",
            20,
        );
        write_codex_rollout(
            &root.join("2026/08/30/rollout-subagent.jsonl"),
            "target-subagent",
            &target_cwd,
            serde_json::json!({"subagent": "review"}),
            "codex-tui",
            30,
        );

        assert_eq!(
            locate_codex_in(&root, target_cwd.to_str().unwrap(), None),
            Some(target)
        );
    }

    #[test]
    fn codex_captured_id_is_exact_and_survives_a_moved_working_directory() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("sessions");
        let old_cwd = directory.path().join("old-location");
        let current_cwd = directory.path().join("current-location");
        fs::create_dir_all(&current_cwd).unwrap();
        let rollout = root.join("2026/08/30/rollout-session-42.jsonl");
        write_codex_rollout(
            &rollout,
            "session-42",
            &old_cwd,
            Value::String("exec".to_string()),
            "codex_exec",
            10,
        );
        write_codex_rollout(
            &root.join("2026/08/30/rollout-unrelated-fallback.jsonl"),
            "newer-session",
            &current_cwd,
            Value::String("cli".to_string()),
            "codex-tui",
            20,
        );

        assert_eq!(
            locate_codex_in(&root, current_cwd.to_str().unwrap(), Some("session-42"),),
            Some(rollout)
        );
        assert_eq!(
            locate_codex_in(&root, current_cwd.to_str().unwrap(), Some("session"),),
            None
        );
        assert_eq!(
            locate_codex_in(
                &root,
                current_cwd.to_str().unwrap(),
                Some("../../session-42"),
            ),
            None
        );
    }

    #[test]
    fn codex_captured_id_rejects_subagent_metadata() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("sessions");
        let cwd = directory.path().join("workspace");
        fs::create_dir_all(&cwd).unwrap();
        write_codex_rollout(
            &root.join("2026/08/30/rollout-subagent.jsonl"),
            "subagent-session",
            &cwd,
            serde_json::json!({"subagent": "review"}),
            "codex-tui",
            10,
        );

        assert_eq!(
            locate_codex_in(&root, cwd.to_str().unwrap(), Some("subagent-session")),
            None
        );
    }

    #[test]
    fn codex_fallback_accepts_the_legacy_main_cli_source() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("sessions");
        let cwd = directory.path().join("workspace");
        fs::create_dir_all(&cwd).unwrap();
        let legacy = root.join("2025/01/01/rollout-legacy.jsonl");
        write_codex_rollout(
            &legacy,
            "legacy-main",
            &cwd,
            Value::String("unknown".to_string()),
            "codex_cli_rs",
            10,
        );

        assert_eq!(
            locate_codex_in(&root, cwd.to_str().unwrap(), None),
            Some(legacy)
        );

        let future_cli = root.join("2026/08/30/rollout-future-cli.jsonl");
        write_codex_rollout(
            &future_cli,
            "future-main",
            &cwd,
            Value::String("cli".to_string()),
            "future-codex-tui",
            20,
        );
        assert_eq!(
            locate_codex_in(&root, cwd.to_str().unwrap(), None),
            Some(future_cli)
        );
    }

    #[test]
    fn codex_locator_rejects_oversized_or_malformed_metadata() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("sessions");
        let cwd = directory.path().join("workspace");
        fs::create_dir_all(root.join("2026/08/30")).unwrap();
        fs::create_dir_all(&cwd).unwrap();
        fs::write(
            root.join("2026/08/30/rollout-oversized.jsonl"),
            vec![b'x'; MAX_CODEX_SESSION_META_BYTES + 1],
        )
        .unwrap();
        fs::write(
            root.join("2026/08/30/rollout-malformed.jsonl"),
            b"not-json\n",
        )
        .unwrap();

        assert_eq!(locate_codex_in(&root, cwd.to_str().unwrap(), None), None);
    }

    #[cfg(unix)]
    #[test]
    fn codex_locator_does_not_follow_nested_symlinks() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("sessions");
        let outside = directory.path().join("outside");
        let cwd = directory.path().join("workspace");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::create_dir_all(&cwd).unwrap();
        let escaped = outside.join("rollout-escaped.jsonl");
        write_codex_rollout(
            &escaped,
            "escaped",
            &cwd,
            Value::String("cli".to_string()),
            "codex-tui",
            10,
        );
        std::os::unix::fs::symlink(&outside, root.join("linked-outside")).unwrap();
        std::os::unix::fs::symlink(&escaped, root.join("rollout-linked-file.jsonl")).unwrap();

        assert_eq!(locate_codex_in(&root, cwd.to_str().unwrap(), None), None);
        assert_eq!(
            parse_codex(&root.join("rollout-linked-file.jsonl"), 5_000),
            None
        );
    }

    #[test]
    fn claude_captured_id_cannot_escape_its_project_directory() {
        let directory = tempfile::tempdir().unwrap();
        let projects_root = directory.path().join(".claude/projects");
        let working_directory = directory.path().join("workspace");
        let project = projects_root.join(claude_slug(working_directory.to_str().unwrap()));
        fs::create_dir_all(&project).unwrap();
        fs::write(directory.path().join(".claude/escape.jsonl"), b"outside").unwrap();

        assert_eq!(
            locate_claude_in(
                &projects_root,
                working_directory.to_str().unwrap(),
                Some("../../escape"),
            ),
            None
        );

        let valid = project.join("session-42.jsonl");
        write_claude_session(&valid, "session-42", &working_directory, false, 10);
        assert_eq!(
            locate_claude_in(
                &projects_root,
                working_directory.to_str().unwrap(),
                Some("session-42"),
            ),
            Some(valid)
        );
    }

    #[test]
    fn claude_fallback_uses_metadata_to_disambiguate_slug_collisions() {
        let directory = tempfile::tempdir().unwrap();
        let projects_root = directory.path().join(".claude/projects");
        let target_cwd = directory.path().join("a-b/c");
        let other_cwd = directory.path().join("a/b-c");
        fs::create_dir_all(&target_cwd).unwrap();
        fs::create_dir_all(&other_cwd).unwrap();
        assert_eq!(
            claude_slug(target_cwd.to_str().unwrap()),
            claude_slug(other_cwd.to_str().unwrap())
        );
        let project = projects_root.join(claude_slug(target_cwd.to_str().unwrap()));
        let target = project.join("target.jsonl");
        write_claude_session(&target, "target", &target_cwd, false, 10);
        write_claude_session(&project.join("other.jsonl"), "other", &other_cwd, false, 20);

        assert_eq!(
            locate_claude_in(&projects_root, target_cwd.to_str().unwrap(), None),
            Some(target)
        );
    }

    #[test]
    fn claude_captured_id_survives_a_moved_cwd_but_rejects_sidechains() {
        let directory = tempfile::tempdir().unwrap();
        let projects_root = directory.path().join(".claude/projects");
        let old_cwd = directory.path().join("old-location");
        let current_cwd = directory.path().join("current-location");
        fs::create_dir_all(&old_cwd).unwrap();
        fs::create_dir_all(&current_cwd).unwrap();
        let old_project = projects_root.join(claude_slug(old_cwd.to_str().unwrap()));
        let main = old_project.join("main-session.jsonl");
        write_claude_session(&main, "main-session", &old_cwd, false, 10);
        write_claude_session(
            &old_project.join("sidechain-session.jsonl"),
            "sidechain-session",
            &old_cwd,
            true,
            20,
        );
        write_claude_session(
            &projects_root
                .join(claude_slug(current_cwd.to_str().unwrap()))
                .join("newer-session.jsonl"),
            "newer-session",
            &current_cwd,
            false,
            30,
        );

        assert_eq!(
            locate_claude_in(
                &projects_root,
                current_cwd.to_str().unwrap(),
                Some("main-session"),
            ),
            Some(main)
        );
        assert_eq!(
            locate_claude_in(
                &projects_root,
                current_cwd.to_str().unwrap(),
                Some("sidechain-session"),
            ),
            None
        );

        let ambiguous = old_project.join("ambiguous-session.jsonl");
        fs::write(
            &ambiguous,
            [
                serde_json::json!({"type": "mode", "sessionId": "ambiguous-session"}).to_string(),
                serde_json::json!({
                    "type": "user",
                    "sessionId": "ambiguous-session",
                    "cwd": old_cwd.to_string_lossy(),
                    "message": {"role": "user", "content": "ambiguous"},
                })
                .to_string(),
            ]
            .join("\n"),
        )
        .unwrap();
        assert_eq!(
            locate_claude_in(
                &projects_root,
                current_cwd.to_str().unwrap(),
                Some("ambiguous-session"),
            ),
            None
        );
    }

    #[test]
    fn claude_metadata_requires_consistent_ids_and_an_explicit_main_row() {
        let directory = tempfile::tempdir().unwrap();
        let projects_root = directory.path().join(".claude/projects");
        let cwd = directory.path().join("workspace");
        fs::create_dir_all(&cwd).unwrap();
        let project = projects_root.join("project");
        fs::create_dir_all(&project).unwrap();

        let verified = project.join("verified.jsonl");
        fs::write(
            &verified,
            [
                serde_json::json!({"type": "mode", "sessionId": "verified"}).to_string(),
                serde_json::json!({
                    "type": "user",
                    "sessionId": "verified",
                    "cwd": cwd.to_string_lossy(),
                    "message": {"role": "user", "content": "ambiguous prefix"},
                })
                .to_string(),
                serde_json::json!({
                    "type": "assistant",
                    "sessionId": "verified",
                    "cwd": cwd.to_string_lossy(),
                    "isSidechain": false,
                    "message": {"role": "assistant", "content": "verified row"},
                })
                .to_string(),
            ]
            .join("\n"),
        )
        .unwrap();
        assert_eq!(
            locate_claude_in(&projects_root, cwd.to_str().unwrap(), Some("verified")),
            Some(verified)
        );

        let conflicting = project.join("conflicting.jsonl");
        fs::write(
            &conflicting,
            [
                serde_json::json!({"type": "mode", "sessionId": "expected"}).to_string(),
                serde_json::json!({
                    "type": "user",
                    "sessionId": "different",
                    "cwd": cwd.to_string_lossy(),
                    "isSidechain": false,
                    "message": {"role": "user", "content": "wrong session"},
                })
                .to_string(),
            ]
            .join("\n"),
        )
        .unwrap();
        assert_eq!(
            locate_claude_in(&projects_root, cwd.to_str().unwrap(), Some("expected")),
            None
        );
        assert_eq!(
            locate_claude_in(&projects_root, cwd.to_str().unwrap(), Some("different")),
            None
        );
    }
}
