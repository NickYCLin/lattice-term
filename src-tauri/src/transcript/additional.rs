//! Read-only adapters for CLI journals. Only fixed history/metadata names are opened.
use super::diagnostics::ReadDiagnostics;
use super::*;
use rusqlite::{Connection, OpenFlags};
use serde_json::json;
pub const UNSUPPORTED: &str = "native.unsupportedFormat";
pub const KINDS: [TranscriptKind; 5] = [
    TranscriptKind::Qwen,
    TranscriptKind::Copilot,
    TranscriptKind::Grok,
    TranscriptKind::Kimi,
    TranscriptKind::OpenCode,
];
pub fn supported(kind: TranscriptKind) -> bool {
    KINDS.contains(&kind)
}
pub fn id(kind: TranscriptKind) -> &'static str {
    match kind {
        TranscriptKind::Qwen => "qwen",
        TranscriptKind::Copilot => "copilot",
        TranscriptKind::Grok => "grok",
        TranscriptKind::Kimi => "kimi",
        TranscriptKind::OpenCode => "opencode",
        _ => "",
    }
}
pub fn root(kind: TranscriptKind, profile: Option<&Path>) -> Option<PathBuf> {
    if let Some(profile) = profile {
        return profile
            .is_absolute()
            .then(|| profile.to_path_buf())
            .and_then(|path| path.canonicalize().ok());
    }
    let path = match kind {
        TranscriptKind::Qwen => std::env::var_os("QWEN_RUNTIME_DIR")
            .or_else(|| std::env::var_os("QWEN_HOME"))
            .map(PathBuf::from)
            .unwrap_or(home()?.join(".qwen")),
        TranscriptKind::Copilot => std::env::var_os("COPILOT_HOME")
            .map(PathBuf::from)
            .unwrap_or(home()?.join(".copilot")),
        TranscriptKind::Grok => std::env::var_os("GROK_HOME")
            .map(PathBuf::from)
            .unwrap_or(home()?.join(".grok")),
        TranscriptKind::Kimi => std::env::var_os("KIMI_CODE_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                let next = home().unwrap_or_default().join(".kimi-code");
                if next.is_dir() {
                    next
                } else {
                    home().unwrap_or_default().join(".kimi")
                }
            }),
        TranscriptKind::OpenCode => {
            if let Some(path) = std::env::var_os("OPENCODE_DB") {
                return PathBuf::from(path).canonicalize().ok();
            }
            std::env::var_os("XDG_DATA_HOME")
                .map(PathBuf::from)
                .unwrap_or(home()?.join(".local/share"))
                .join("opencode")
        }
        _ => return None,
    };
    path.canonicalize().ok()
}
pub fn physical(path: &Path) -> &Path {
    path.parent()
        .filter(|parent| parent.extension().is_some_and(|ext| ext == "db"))
        .unwrap_or(path)
}
fn small_json(path: &Path) -> Option<Value> {
    let file = open_regular_transcript_handle(path)?;
    if file.metadata().ok()?.len() > 1024 * 1024 {
        return None;
    }
    serde_json::from_reader(file.take(1024 * 1024 + 1)).ok()
}
fn first(path: &Path) -> Option<Value> {
    let mut reader = BufReader::new(open_regular_transcript_handle(path)?);
    let mut line = Vec::new();
    for _ in 0..64 {
        if !read_bounded_line(&mut reader, &mut line, MAX_TRANSCRIPT_LINE_BYTES).ok()?? {
            continue;
        }
        if let Ok(value) = serde_json::from_slice(&line) {
            return Some(value);
        }
    }
    None
}
fn kimi_directory(path: &Path) -> Option<(String, String)> {
    let session = if path.parent()?.file_name()? == "main" {
        path.parent()?.parent()?.parent()?
    } else {
        path.parent()?
    };
    if session.parent()?.parent()?.file_name()? != "sessions" {
        return None;
    }
    let id = session.file_name()?.to_str()?.to_string();
    let root = session.parent()?.parent()?.parent()?;
    let state = small_json(&session.join("state.json")).unwrap_or(Value::Null);
    if let Some(cwd) = state["workDir"].as_str().or_else(|| state["cwd"].as_str()) {
        return Some((id, cwd.into()));
    }
    // Explicitly whitelisted session index; never follow its sessionDir value.
    if let Some(file) = open_regular_transcript(&root.join("session_index.jsonl")) {
        let mut reader = BufReader::new(file);
        let mut line = Vec::new();
        for _ in 0..50_000 {
            let Some(valid) =
                read_bounded_line(&mut reader, &mut line, MAX_TRANSCRIPT_LINE_BYTES).ok()?
            else {
                break;
            };
            if !valid {
                continue;
            }
            if let Ok(row) = serde_json::from_slice::<Value>(&line) {
                if row["sessionId"] == id {
                    return Some((id, row["workDir"].as_str()?.into()));
                }
            }
        }
    }
    // Python Kimi's kimi.json is a workspace index, not config.toml or auth state.
    let metadata = small_json(&root.join("kimi.json"))?;
    let bucket = session.parent()?.file_name()?.to_str()?;
    for entry in metadata["work_dirs"].as_array()? {
        let cwd = entry["path"].as_str()?;
        use md5::{Digest, Md5};
        let hash: String = Md5::digest(cwd.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        if hash == bucket && entry["kaos"].as_str().is_none_or(|kaos| kaos == "local") {
            return Some((id, cwd.into()));
        }
    }
    None
}
pub fn metadata(path: &Path, kind: TranscriptKind) -> Option<(String, String)> {
    match kind {
        TranscriptKind::Qwen => {
            if path.extension()? != "jsonl" || path.parent()?.file_name()? != "chats" {
                return None;
            }
            let row = first(path)?;
            Some((
                row["sessionId"].as_str()?.into(),
                row["cwd"].as_str()?.into(),
            ))
        }
        TranscriptKind::Copilot => {
            if path.file_name()? != "events.jsonl"
                || path.parent()?.parent()?.file_name()? != "session-state"
            {
                return None;
            }
            let row = first(path)?;
            if row["type"] != "session.start" {
                return None;
            }
            let id = row["data"]["sessionId"].as_str()?;
            if path.parent()?.file_name()?.to_str()? != id {
                return None;
            }
            Some((
                id.into(),
                row.pointer("/data/context/cwd")?.as_str()?.into(),
            ))
        }
        TranscriptKind::Grok => {
            if path.file_name()? != "chat_history.jsonl"
                || path.parent()?.parent()?.parent()?.file_name()? != "sessions"
            {
                return None;
            }
            let meta = small_json(&path.parent()?.join("summary.json"))?;
            let id = path.parent()?.file_name()?.to_str()?;
            Some((
                id.into(),
                meta.pointer("/info/cwd")
                    .or_else(|| meta.get("cwd"))?
                    .as_str()?
                    .into(),
            ))
        }
        TranscriptKind::Kimi => {
            if path.file_name()? != "wire.jsonl" {
                return None;
            }
            if path.parent()?.file_name()? != "main"
                && path.parent()?.parent()?.file_name()? == "agents"
            {
                return None;
            }
            kimi_directory(path)
        }
        _ => None,
    }
}
fn directories(root: &Path, kind: TranscriptKind) -> Vec<PathBuf> {
    let names: &[&str] = match kind {
        TranscriptKind::Qwen => &["projects", "tmp"],
        TranscriptKind::Copilot => &["session-state"],
        _ => &["sessions"],
    };
    names
        .iter()
        .map(|name| root.join(name))
        .filter(|path| {
            fs::symlink_metadata(path)
                .is_ok_and(|meta| meta.is_dir() && !meta.file_type().is_symlink())
        })
        .collect()
}
pub fn validate_root(root: &Path, kind: TranscriptKind) -> Result<(), String> {
    if kind == TranscriptKind::OpenCode {
        let db = database_path(root);
        let connection = open_database(&db)?;
        db_layout(&connection)?;
    }
    Ok(())
}
pub fn locate(root: &Path, kind: TranscriptKind, cwd: &str, id: &str) -> Option<PathBuf> {
    if !normalized::valid_id(id) {
        return None;
    }
    if kind == TranscriptKind::OpenCode {
        let db = database_path(root);
        let connection = open_database(&db).ok()?;
        let table = db_layout(&connection).ok()?;
        let query = format!("SELECT directory FROM {table} WHERE id=?1 AND parent_id IS NULL");
        let directory: String = connection.query_row(&query, [id], |row| row.get(0)).ok()?;
        return (cwd.is_empty() || same_directory(&directory, cwd)).then(|| db.join(id));
    }
    let mut paths = Vec::new();
    let mut stack = directories(root, kind)
        .into_iter()
        .map(|path| (path, 0))
        .collect::<Vec<_>>();
    let mut visited = 0;
    while let Some((directory, depth)) = stack.pop() {
        for entry in fs::read_dir(directory).ok()? {
            let entry = entry.ok()?;
            visited += 1;
            if visited > 50_000 {
                return None;
            }
            let typ = entry.file_type().ok()?;
            if typ.is_symlink() {
                continue;
            }
            let path = entry.path();
            if typ.is_dir() {
                if depth < 5 {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            if !typ.is_file() {
                continue;
            }
            if metadata(&path, kind).is_some_and(|(session, directory)| {
                session == id && (cwd.is_empty() || same_directory(&directory, cwd))
            }) {
                paths.push(path);
                if paths.len() > 1 {
                    return None;
                }
            }
        }
    }
    paths.pop()
}
fn same_directory(left: &str, right: &str) -> bool {
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}
pub fn scan(
    kind: TranscriptKind,
    root: &Path,
    profile: Option<&str>,
    result: &mut Vec<(LocalConversation, PathBuf)>,
    options: HistoryScanOptions,
    incomplete: &mut bool,
) -> Result<(), String> {
    if kind != TranscriptKind::OpenCode {
        for directory in directories(root, kind) {
            scan_local_conversations(
                kind,
                &directory,
                profile,
                result,
                HistoryScanOptions {
                    all: options.all,
                    archived: options.archived,
                    retained: options.retained,
                },
                incomplete,
            )?;
        }
        return Ok(());
    }
    let db = database_path(root);
    if !db.is_file() {
        return Ok(());
    }
    let connection = open_database(&db)?;
    let table = db_layout(&connection)?;
    let query=format!("SELECT id,directory FROM {table} WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT 50001");
    let mut statement = connection.prepare(&query).map_err(|_| UNSUPPORTED)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|_| UNSUPPORTED)?;
    for (index, row) in rows.enumerate() {
        if index >= 50_000 {
            *incomplete = true;
            break;
        }
        let (id, cwd) = match row {
            Ok(value) => value,
            Err(_) => {
                *incomplete = true;
                continue;
            }
        };
        if !normalized::valid_id(&id) {
            continue;
        }
        let path = db.join(&id);
        if !rows_have_user(&path, kind) {
            continue;
        }
        push_entry(kind, path, id, cwd, profile, &options, result)?;
    }
    Ok(())
}
fn push_entry(
    kind: TranscriptKind,
    path: PathBuf,
    id: String,
    cwd: String,
    profile: Option<&str>,
    options: &HistoryScanOptions,
    result: &mut Vec<(LocalConversation, PathBuf)>,
) -> Result<(), String> {
    let physical = physical(&path);
    let updated_at = fs::metadata(physical)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |time| time.as_secs());
    result.push((
        LocalConversation {
            definition_id: self::id(kind).into(),
            profile_id: profile.map(str::to_string),
            native_session_id: id,
            working_directory: fs::canonicalize(&cwd)
                .unwrap_or(PathBuf::from(cwd))
                .to_string_lossy()
                .into_owned(),
            resumable: false,
            title: String::new(),
            updated_at,
            model_provider: None,
            archived: false,
            title_source: "firstMessage".into(),
        },
        path,
    ));
    if options.all && result.len() > 1024 {
        return Err("Too many local conversations.".into());
    }
    Ok(())
}
fn database_path(root: &Path) -> PathBuf {
    if root.extension().is_some_and(|ext| ext == "db") {
        root.into()
    } else {
        root.join("opencode.db")
    }
}
fn open_database(path: &Path) -> Result<Connection, String> {
    let file = open_regular_transcript_handle(path).ok_or(UNSUPPORTED)?;
    if file.metadata().map_err(|_| UNSUPPORTED)?.len() > 2 * 1024 * 1024 * 1024 {
        return Err(UNSUPPORTED.into());
    }
    // Immutable reads cannot write journal/SHM or acquire a write lock. A live WAL
    // must be closed/checkpointed by the owning CLI; never ignore uncheckpointed data.
    let wal = PathBuf::from(format!("{}-wal", path.display()));
    if fs::metadata(wal).is_ok_and(|meta| meta.len() > 0) {
        return Err("native.databaseBusy".into());
    }
    let canonical = path.canonicalize().map_err(|_| UNSUPPORTED)?;
    let mut url = reqwest::Url::from_file_path(&canonical).map_err(|_| UNSUPPORTED)?;
    url.set_query(Some("mode=ro&immutable=1"));
    let connection = Connection::open_with_flags(
        url.as_str(),
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| UNSUPPORTED)?;
    connection
        .pragma_update(None, "query_only", true)
        .map_err(|_| UNSUPPORTED)?;
    Ok(connection)
}
fn db_layout(connection: &Connection) -> Result<&'static str, String> {
    for table in ["session_v2", "session"] {
        if connection
            .prepare(&format!(
                "SELECT id,directory,parent_id,time_updated FROM {table} LIMIT 0"
            ))
            .is_ok()
        {
            return Ok(table);
        }
    }
    Err(UNSUPPORTED.into())
}
fn db_rows(path: &Path, mut visit: impl FnMut(&Value, u64)) -> Result<ReadDiagnostics, String> {
    let id = path
        .file_name()
        .and_then(|id| id.to_str())
        .ok_or(UNSUPPORTED)?;
    let connection = open_database(physical(path))?;
    let layout = db_layout(&connection)?;
    let (messages, parts) = if layout == "session" {
        ("message", "part")
    } else {
        ("session_message", "session_part")
    };
    let order = if layout == "session" {
        "m.time_created,m.id,p.time_created,p.id"
    } else {
        "m.seq,p.ordinal"
    };
    let part_type = if layout == "session" {
        "NULL"
    } else {
        "p.type"
    };
    let role = if layout == "session" {
        "NULL"
    } else {
        "m.type"
    };
    let query=format!("SELECT CASE WHEN length(m.data)<=25165824 THEN m.data END,CASE WHEN length(p.data)<=25165824 THEN p.data END,{role},{part_type},length(m.data),length(p.data) FROM {messages} m LEFT JOIN {parts} p ON p.message_id=m.id AND p.session_id=m.session_id WHERE m.session_id=?1 ORDER BY {order}");
    let mut statement = connection.prepare(&query).map_err(|_| UNSUPPORTED)?;
    let mut rows = statement.query([id]).map_err(|_| UNSUPPORTED)?;
    let mut index = 0;
    let mut skipped = ReadDiagnostics::default();
    while let Some(row) = rows.next().map_err(|_| UNSUPPORTED)? {
        if row.get::<_, u64>(4).unwrap_or(0) > 24 * 1024 * 1024
            || row.get::<_, u64>(5).unwrap_or(0) > 24 * 1024 * 1024
        {
            skipped.skip("oversized");
            continue;
        }
        let message = match row.get::<_, String>(0) {
            Ok(raw) => match serde_json::from_str::<Value>(&raw) {
                Ok(value) if value.is_object() => value,
                _ => {
                    skipped.skip("malformed");
                    continue;
                }
            },
            Err(_) => {
                skipped.skip("decode");
                continue;
            }
        };
        let part = match row.get::<_, Option<String>>(1) {
            Ok(raw) => raw,
            Err(_) => {
                skipped.skip("decode");
                continue;
            }
        };
        let role: String = row
            .get::<_, Option<String>>(2)
            .ok()
            .flatten()
            .or_else(|| message["role"].as_str().map(str::to_string))
            .unwrap_or_default();
        let mut parts = Vec::new();
        if let Some(part) = part {
            let mut part: Value = match serde_json::from_str::<Value>(&part) {
                Ok(value) if value.is_object() => value,
                _ => {
                    skipped.skip("malformed");
                    continue;
                }
            };
            if let Some(kind) = row.get::<_, Option<String>>(3).ok().flatten() {
                part["type"] = json!(kind);
            }
            parts.push(part);
        } else if role == "user" {
            parts.push(json!({"type":"text","text":message["text"]}));
        }
        let mut adapter = Adapter::default();
        for part in parts {
            adapter.opencode(&role, &part, |row| {
                visit(&row, index);
                index += 1;
            });
        }
    }
    Ok(skipped)
}
fn message(role: &str, content: Value) -> Value {
    json!({"type":role,"message":{"content":content}})
}
fn text(role: &str, raw: &str) -> Value {
    message(role, json!([{"type":"text","text":raw}]))
}
fn tool(id: &str, name: &str, input: &Value) -> Value {
    let decoded = input
        .as_str()
        .and_then(|text| serde_json::from_str::<Value>(text).ok());
    let mut args = decoded.as_ref().unwrap_or(input).clone();
    if let Some(map) = args.as_object_mut() {
        for (old, new) in [("old_str", "old_string"), ("new_str", "new_string")] {
            if let Some(value) = map.remove(old) {
                map.entry(new).or_insert(value);
            }
        }
    }
    let canonical = match name {
        "StrReplaceFile" => "Edit",
        "WriteFile" => "Write",
        other => other,
    };
    message(
        "assistant",
        json!([{"type":"tool_use","id":id,"name":canonical,"input":args}]),
    )
}
fn result(id: &str, output: &Value, error: bool) -> Value {
    let output = if output.is_object() {
        json!(output.to_string())
    } else {
        output.clone()
    };
    message(
        "user",
        json!([{"type":"tool_result","tool_use_id":id,"content":output,"is_error":error}]),
    )
}
#[derive(Default)]
struct Adapter {
    calls: std::collections::BTreeMap<String, (String, String)>,
    bytes: usize,
    last_call: Option<String>,
}
impl Adapter {
    fn opencode(&mut self, role: &str, part: &Value, mut emit: impl FnMut(Value)) {
        match part["type"].as_str() {
            Some("text") => emit(text(
                if role == "user" { "user" } else { "assistant" },
                part["text"].as_str().unwrap_or(""),
            )),
            Some("reasoning") => emit(message(
                "assistant",
                json!([{"type":"thinking","thinking":part["text"]}]),
            )),
            Some("tool") => {
                let id = part["callID"]
                    .as_str()
                    .or_else(|| part["callId"].as_str())
                    .or_else(|| part["id"].as_str())
                    .unwrap_or("recorded-call");
                let name = part["tool"]
                    .as_str()
                    .or_else(|| part["name"].as_str())
                    .unwrap_or("tool");
                let state = &part["state"];
                emit(tool(id, name, &state["input"]));
                if let Some(output) = state
                    .get("output")
                    .or_else(|| state.get("error"))
                    .or_else(|| state.get("content"))
                {
                    emit(result(id, output, state["status"] == "error"));
                }
            }
            _ => {}
        }
    }
    fn row(
        &mut self,
        row: &Value,
        kind: TranscriptKind,
        emit: &mut dyn FnMut(Value),
    ) -> Result<(), String> {
        match kind {
            TranscriptKind::Qwen => {
                if row["isSidechain"] == true {
                    return Ok(());
                }
                if row["subtype"].as_str().is_some_and(|subtype| {
                    subtype == "rewind" || subtype.starts_with("managed_session_")
                }) {
                    return Err(UNSUPPORTED.into());
                }
                let typ = row["type"].as_str().unwrap_or("");
                if matches!(typ, "user" | "assistant" | "tool_result") {
                    let role = if typ == "user" { "user" } else { "assistant" };
                    if let Some(parts) = row.pointer("/message/parts").and_then(Value::as_array) {
                        for part in parts {
                            if part["thought"] == true {
                                emit(message(
                                    "assistant",
                                    json!([{"type":"thinking","thinking":part["text"]}]),
                                ));
                            } else if let Some(raw) = part["text"].as_str() {
                                emit(text(role, raw));
                            }
                            if let Some(call) = part.get("functionCall") {
                                emit(tool(
                                    call["id"].as_str().unwrap_or("recorded-call"),
                                    call["name"].as_str().unwrap_or("tool"),
                                    &call["args"],
                                ));
                            }
                            if let Some(call) = part.get("functionResponse") {
                                emit(result(
                                    call["id"].as_str().unwrap_or("recorded-call"),
                                    &json!(super::gemini_content_text(
                                        &json!([{"text":call["response"].to_string()}])
                                    )),
                                    false,
                                ));
                            }
                        }
                    }
                }
            }
            TranscriptKind::Copilot => {
                if row["agentId"].is_string() {
                    return Ok(());
                }
                let data = &row["data"];
                match row["type"].as_str() {
                    Some("session.start") => {
                        if data["version"].as_u64().is_none_or(|v| v != 1) {
                            return Err(UNSUPPORTED.into());
                        }
                    }
                    Some("user.message") => {
                        emit(text("user", data["content"].as_str().unwrap_or("")))
                    }
                    Some("assistant.message") => {
                        emit(text("assistant", data["content"].as_str().unwrap_or("")));
                        if let Some(reasoning) = data["reasoningText"].as_str() {
                            emit(message(
                                "assistant",
                                json!([{"type":"thinking","thinking":reasoning}]),
                            ));
                        }
                    }
                    Some("assistant.reasoning") => emit(message(
                        "assistant",
                        json!([{"type":"thinking","thinking":data["content"]}]),
                    )),
                    Some("tool.execution_start") => emit(tool(
                        data["toolCallId"].as_str().unwrap_or("recorded-call"),
                        data["toolName"].as_str().unwrap_or("tool"),
                        &data["arguments"],
                    )),
                    Some("tool.execution_complete") => emit(result(
                        data["toolCallId"].as_str().unwrap_or("recorded-call"),
                        data.pointer("/result/content").unwrap_or(&data["error"]),
                        data["success"] == false,
                    )),
                    _ => {}
                }
            }
            TranscriptKind::Grok => {
                let role = row["role"].as_str().unwrap_or("");
                if matches!(role, "user" | "assistant") {
                    if let Some(raw) = row["content"].as_str() {
                        emit(text(role, raw));
                    } else if row["content"].is_array() {
                        let content = row["content"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|part| {
                                if part["type"] == "think" {
                                    json!({"type":"thinking","thinking":part["think"]})
                                } else {
                                    part.clone()
                                }
                            })
                            .collect::<Vec<_>>();
                        emit(message(role, json!(content)));
                    }
                    if let Some(calls) = row["tool_calls"]
                        .as_array()
                        .or_else(|| row["toolCalls"].as_array())
                    {
                        for call in calls {
                            emit(tool(
                                call["id"].as_str().unwrap_or("recorded-call"),
                                call["function"]["name"]
                                    .as_str()
                                    .or_else(|| call["name"].as_str())
                                    .unwrap_or("tool"),
                                call.pointer("/function/arguments")
                                    .or_else(|| call.get("arguments"))
                                    .unwrap_or(&Value::Null),
                            ));
                        }
                    }
                    if let Some(reasoning) = row["reasoning_content"].as_str() {
                        emit(message(
                            "assistant",
                            json!([{"type":"thinking","thinking":reasoning}]),
                        ));
                    }
                } else if role == "tool" {
                    emit(result(
                        row["tool_call_id"]
                            .as_str()
                            .or_else(|| row["toolCallId"].as_str())
                            .unwrap_or("recorded-call"),
                        &row["content"],
                        false,
                    ));
                }
            }
            TranscriptKind::Kimi => {
                if row["type"] == "metadata" {
                    if !matches!(
                        row["protocol_version"].as_str(),
                        Some(
                            "1.1"
                                | "1.2"
                                | "1.3"
                                | "1.4"
                                | "1.5"
                                | "1.6"
                                | "1.7"
                                | "1.8"
                                | "1.9"
                                | "1.10"
                        )
                    ) {
                        return Err(UNSUPPORTED.into());
                    }
                    return Ok(());
                }
                if row["type"] == "context.append_message" {
                    self.row(&row["message"], TranscriptKind::Grok, emit)?;
                    return Ok(());
                }
                if row["type"].as_str().is_some_and(|typ| {
                    typ.starts_with("context.") && typ != "context.apply_compaction"
                }) {
                    return Err(UNSUPPORTED.into());
                }
                let msg = &row["message"];
                let data = &msg["payload"];
                match msg["type"].as_str() {
                    Some("TurnBegin" | "SteerInput") => {
                        if let Some(raw) = data["user_input"].as_str() {
                            emit(text("user", raw));
                        } else {
                            emit(message("user", data["user_input"].clone()));
                        }
                    }
                    Some("ContentPart") => {
                        if data["type"] == "think" {
                            emit(message(
                                "assistant",
                                json!([{"type":"thinking","thinking":data["think"]}]),
                            ));
                        } else if data["type"] == "text" {
                            emit(text("assistant", data["text"].as_str().unwrap_or("")));
                        }
                    }
                    Some("ToolCall") => {
                        let id = data["id"].as_str().ok_or(UNSUPPORTED)?;
                        let name = data["function"]["name"]
                            .as_str()
                            .unwrap_or("tool")
                            .to_string();
                        if id.len() > 512 || name.len() > 512 {
                            return Err(UNSUPPORTED.into());
                        }
                        let args = data["function"]["arguments"]
                            .as_str()
                            .unwrap_or("")
                            .to_string();
                        self.bytes += args.len();
                        if self.bytes > 24 * 1024 * 1024 || self.calls.len() > 10_000 {
                            return Err(UNSUPPORTED.into());
                        }
                        self.last_call = Some(id.into());
                        self.calls.insert(id.into(), (name, args));
                    }
                    Some("ToolCallPart") => {
                        if let Some((_, args)) = data["id"]
                            .as_str()
                            .or(self.last_call.as_deref())
                            .and_then(|id| self.calls.get_mut(id))
                        {
                            let part = data["arguments_part"].as_str().unwrap_or("");
                            self.bytes += part.len();
                            if self.bytes > 24 * 1024 * 1024 {
                                return Err(UNSUPPORTED.into());
                            }
                            args.push_str(part);
                        }
                    }
                    Some("ToolResult") => {
                        let id = data["tool_call_id"].as_str().unwrap_or("recorded-call");
                        if let Some((name, args)) = self.calls.remove(id) {
                            self.bytes = self.bytes.saturating_sub(args.len());
                            if self.last_call.as_deref() == Some(id) {
                                self.last_call = None;
                            }
                            emit(tool(id, &name, &json!(args)));
                        }
                        emit(result(
                            id,
                            &data["return_value"]["output"],
                            data["return_value"]["is_error"] == true,
                        ));
                    }
                    _ => {}
                }
            }
            _ => return Err(UNSUPPORTED.into()),
        }
        Ok(())
    }
}
pub fn rows(
    path: &Path,
    kind: TranscriptKind,
    mut visit: impl FnMut(&Value, u64),
) -> Result<ReadDiagnostics, String> {
    if kind == TranscriptKind::OpenCode {
        return db_rows(path, visit);
    }
    let header = first(path).ok_or_else(|| diagnostics::unrecognized(path).to_string())?;
    let recognized = match kind {
        TranscriptKind::Qwen => {
            header["sessionId"].is_string()
                && header["version"].as_str().is_some_and(|v| {
                    ["0.14.", "0.22.", "0.27."]
                        .iter()
                        .any(|prefix| v.starts_with(prefix))
                })
        }
        TranscriptKind::Copilot => header["type"] == "session.start",
        TranscriptKind::Grok => header["role"].is_string(),
        TranscriptKind::Kimi => header["type"] == "metadata",
        _ => false,
    };
    if !recognized {
        return Err(UNSUPPORTED.into());
    }
    let mut adapter = Adapter::default();
    // Reject an unsupported header version before attempting record recovery.
    Adapter::default().row(&header, kind, &mut |_| {})?;
    let mut failure = None;
    let mut invalid_rows = 0;
    let mut skipped = normalized::stream_rows(path, |row, offset| {
        if failure.is_some() {
            return;
        }
        let mut sequence = 0;
        let mut invalid = false;
        let status = adapter.row(row, kind, &mut |row| {
            if row
                .pointer("/message/content/0/id")
                .is_some_and(|id| id == "recorded-call")
                || row
                    .pointer("/message/content/0/tool_use_id")
                    .is_some_and(|id| id == "recorded-call")
            {
                invalid = true;
                return;
            }
            if sequence < 256 {
                visit(&row, offset.saturating_mul(256) + sequence);
                sequence += 1;
            }
        });
        if invalid {
            invalid_rows += 1;
        }
        if let Err(error) = status {
            failure = Some(error);
        }
    })?;
    if let Some(error) = failure {
        return Err(error);
    }
    for _ in 0..invalid_rows {
        skipped.skip("invalid_record");
    }
    for (index, (id, (name, args))) in adapter.calls.into_iter().enumerate() {
        visit(&tool(&id, &name, &json!(args)), u64::MAX - index as u64);
    }
    Ok(skipped)
}
pub fn rows_have_user(path: &Path, kind: TranscriptKind) -> bool {
    let mut found = false;
    rows(path, kind, |row, _| {
        if row["type"] == "user" && !content_text(&row["message"]["content"]).is_empty() {
            found = true;
        }
    })
    .is_err()
        || found
}
pub fn preview(path: &Path, kind: TranscriptKind) -> Option<String> {
    normalized::recent(path, kind)
        .ok()?
        .messages
        .into_iter()
        .find(|row| row.role == "user" && !row.text.is_empty())
        .map(|row| row.text)
}

#[cfg(test)]
pub(super) fn audit_database_sessions(root: &Path) -> Result<Vec<PathBuf>, String> {
    let path = database_path(root);
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let read = || {
        let connection = open_database(&path)?;
        let table = db_layout(&connection)?;
        let mut query = connection
            .prepare(&format!("SELECT id FROM {table}"))
            .map_err(|_| UNSUPPORTED)?;
        let rows = query
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|_| UNSUPPORTED)?;
        Ok(rows
            .filter_map(Result::ok)
            .filter(|id| normalized::valid_id(id))
            .map(|id| path.join(id))
            .collect())
    };
    read().map_err(|error: String| diagnostics::failure(TranscriptKind::OpenCode, &path, &error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    fn write(path: &Path, rows: &[Value]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            path,
            rows.iter()
                .map(|row| format!("{row}\n"))
                .collect::<String>(),
        )
        .unwrap();
    }
    fn fixture(kind: TranscriptKind) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let cwd = "/synthetic/project";
        let path = match kind {
            TranscriptKind::Qwen => {
                let path = root.join("projects/fake/chats/fake.jsonl");
                write(
                    &path,
                    &[
                        json!({"type":"user","sessionId":"fake","cwd":cwd,"version":"0.27.4","message":{"parts":[{"text":"question token=FAKE_TOKEN"}]}}),
                        json!({"type":"assistant","message":{"parts":[{"text":"answer"},{"thought":true,"text":"public reasoning"},{"functionCall":{"id":"c","name":"replace","args":{"file_path":"/synthetic/f","old_string":"before","new_string":"after"}}}]}}),
                        json!({"type":"tool_result","message":{"parts":[{"functionResponse":{"id":"c","response":{"output":"done"}}}]}}),
                        json!({"type":"assistant","isSidechain":true,"message":{"parts":[{"text":"NEVER_CHILD"}]}}),
                    ],
                );
                path
            }
            TranscriptKind::Copilot => {
                let path = root.join("session-state/fake/events.jsonl");
                write(
                    &path,
                    &[
                        json!({"type":"session.start","data":{"sessionId":"fake","version":1,"context":{"cwd":cwd}}}),
                        json!({"type":"user.message","data":{"content":"question token=FAKE_TOKEN"}}),
                        json!({"type":"assistant.reasoning","data":{"content":"public reasoning"}}),
                        json!({"type":"tool.execution_start","data":{"toolCallId":"c","toolName":"edit","arguments":{"path":"/synthetic/f","old_str":"before","new_str":"after"}}}),
                        json!({"type":"tool.execution_complete","data":{"toolCallId":"c","success":true,"result":{"content":"done"}}}),
                        json!({"type":"assistant.message","data":{"content":"answer"}}),
                        json!({"type":"assistant.message","agentId":"child","data":{"content":"NEVER_CHILD"}}),
                    ],
                );
                path
            }
            TranscriptKind::Grok => {
                let path = root.join("sessions/fake-group/fake/chat_history.jsonl");
                write(
                    &path,
                    &[
                        json!({"role":"user","content":"question token=FAKE_TOKEN"}),
                        json!({"role":"assistant","content":"answer","reasoning_content":"public reasoning","tool_calls":[{"id":"c","function":{"name":"edit","arguments":"{\"path\":\"/synthetic/f\",\"old_string\":\"before\",\"new_string\":\"after\"}"}}]}),
                        json!({"role":"tool","tool_call_id":"c","content":"done"}),
                    ],
                );
                fs::write(
                    path.parent().unwrap().join("summary.json"),
                    json!({"info":{"cwd":cwd,"id":"fake"}}).to_string(),
                )
                .unwrap();
                path
            }
            TranscriptKind::Kimi => {
                let path = root.join("sessions/fake-bucket/fake/agents/main/wire.jsonl");
                write(
                    &path,
                    &[
                        json!({"type":"metadata","protocol_version":"1.10"}),
                        json!({"message":{"type":"TurnBegin","payload":{"user_input":"question token=FAKE_TOKEN"}}}),
                        json!({"message":{"type":"ContentPart","payload":{"type":"think","think":"public reasoning"}}}),
                        json!({"message":{"type":"ToolCall","payload":{"id":"c","function":{"name":"StrReplaceFile","arguments":"{\"path\":\"/synthetic/f\",\"old_string\":\"before\","}}}}),
                        json!({"message":{"type":"ToolCallPart","payload":{"arguments_part":"\"new_string\":\"after\"}"}}}),
                        json!({"message":{"type":"ToolResult","payload":{"tool_call_id":"c","return_value":{"output":"done","is_error":false}}}}),
                        json!({"message":{"type":"ContentPart","payload":{"type":"text","text":"answer"}}}),
                        json!({"message":{"type":"SubagentEvent","payload":{"event":{"type":"ContentPart","payload":{"type":"text","text":"NEVER_CHILD"}}}}}),
                    ],
                );
                fs::write(
                    root.join("sessions/fake-bucket/fake/state.json"),
                    json!({"workDir":cwd}).to_string(),
                )
                .unwrap();
                path
            }
            _ => unreachable!(),
        };
        (dir, path)
    }
    #[test]
    fn jsonl_sources_normalize_tools_thoughts_diffs_and_mask_secrets_read_only() {
        for kind in [
            TranscriptKind::Qwen,
            TranscriptKind::Copilot,
            TranscriptKind::Grok,
            TranscriptKind::Kimi,
        ] {
            let (_dir, path) = fixture(kind);
            let original = fs::read(&path).unwrap();
            let meta = metadata(&path, kind).unwrap();
            assert_eq!(meta, ("fake".into(), "/synthetic/project".into()));
            let (page, _) = normalized::page(&path, kind, None, None).unwrap();
            let all = page
                .turns
                .iter()
                .flat_map(|turn| &turn.items)
                .collect::<Vec<_>>();
            let serialized = serde_json::to_string(&all).unwrap();
            assert!(!serialized.contains("FAKE_TOKEN"));
            assert!(!serialized.contains("NEVER_CHILD"));
            for expected in [
                normalized::ItemKind::User,
                normalized::ItemKind::Assistant,
                normalized::ItemKind::Reasoning,
                normalized::ItemKind::Tool,
                normalized::ItemKind::FileChange,
            ] {
                assert!(
                    all.iter().any(|item| item.kind == expected),
                    "missing {expected:?} for {kind:?}"
                );
            }
            assert!(all
                .iter()
                .any(|item| item.kind == normalized::ItemKind::Tool
                    && item.input.is_some()
                    && item.output.is_some()));
            assert_eq!(original, fs::read(&path).unwrap());
        }
    }
    #[test]
    fn malformed_huge_lines_and_unknown_versions_have_bounded_explicit_behavior() {
        for kind in [
            TranscriptKind::Qwen,
            TranscriptKind::Copilot,
            TranscriptKind::Grok,
            TranscriptKind::Kimi,
        ] {
            let (_dir, path) = fixture(kind);
            let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
            file.write_all(b"\n{unfinished\n").unwrap();
            file.write_all(&vec![b'x'; 24 * 1024 * 1024 + 1]).unwrap();
            file.write_all(b"\n").unwrap();
            drop(file);
            let page = normalized::page(&path, kind, None, None).unwrap().0;
            assert!(page.truncated);
            assert!(!page.warnings.is_empty());
            fs::write(&path, "{\"format\":\"future-unsupported\"}\n").unwrap();
            assert!(normalized::page(&path, kind, None, None)
                .unwrap_err()
                .contains("unsupported_version"));
        }
    }
    #[test]
    fn account_roots_exact_ids_empty_sessions_and_children_do_not_cross() {
        for kind in [
            TranscriptKind::Qwen,
            TranscriptKind::Copilot,
            TranscriptKind::Grok,
            TranscriptKind::Kimi,
        ] {
            let (dir, path) = fixture(kind);
            assert_eq!(
                locate(dir.path(), kind, "/synthetic/project", "fake"),
                Some(path.clone())
            );
            assert!(locate(dir.path(), kind, "/synthetic/other", "fake").is_none());
            assert!(locate(dir.path(), kind, "", "other").is_none());
            let other = tempfile::tempdir().unwrap();
            assert!(locate(other.path(), kind, "", "fake").is_none());
            assert_eq!(
                root(kind, Some(dir.path())).unwrap(),
                dir.path().canonicalize().unwrap()
            );
            let mut result = Vec::new();
            let mut incomplete = false;
            scan(
                kind,
                dir.path(),
                Some("test-account"),
                &mut result,
                HistoryScanOptions {
                    all: false,
                    archived: false,
                    retained: 100,
                },
                &mut incomplete,
            )
            .unwrap();
            assert_eq!(result.len(), 1);
            assert!(!result[0].0.resumable);
            assert_eq!(result[0].0.profile_id.as_deref(), Some("test-account"));
            let first = fs::read_to_string(&path)
                .unwrap()
                .lines()
                .next()
                .unwrap()
                .to_string();
            fs::write(&path, format!("{first}\n")).unwrap();
            assert!(
                !rows_have_user(&path, kind)
                    || kind == TranscriptKind::Qwen
                    || kind == TranscriptKind::Grok
            );
        }
    }
    fn database_fixture(v2: bool) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.db");
        let connection = Connection::open(&path).unwrap();
        if v2 {
            connection.execute_batch("CREATE TABLE session_v2(id TEXT,directory TEXT,parent_id TEXT,time_updated INT);CREATE TABLE session_message(id TEXT,session_id TEXT,type TEXT,seq INT,data TEXT);CREATE TABLE session_part(message_id TEXT,session_id TEXT,ordinal INT,type TEXT,data TEXT);").unwrap();
            connection
                .execute(
                    "INSERT INTO session_v2 VALUES('fake','/synthetic/project',NULL,1)",
                    [],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO session_message VALUES('u','fake','user',1,?1)",
                    [json!({"text":"question token=FAKE_TOKEN"}).to_string()],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO session_message VALUES('a','fake','assistant',2,'{}')",
                    [],
                )
                .unwrap();
            for (index,part) in [json!({"type":"text","text":"answer"}),json!({"type":"reasoning","text":"public reasoning"}),json!({"type":"tool","id":"c","name":"edit","state":{"status":"completed","input":{"path":"/synthetic/f","old_string":"before","new_string":"after"},"content":[{"type":"text","text":"done"}]}})].iter().enumerate(){connection.execute("INSERT INTO session_part VALUES('a','fake',?1,?2,?3)",rusqlite::params![index,part["type"].as_str(),part.to_string()]).unwrap();}
        } else {
            connection.execute_batch("CREATE TABLE session(id TEXT,directory TEXT,parent_id TEXT,time_updated INT);CREATE TABLE message(id TEXT,session_id TEXT,time_created INT,data TEXT);CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,time_created INT,data TEXT);").unwrap();
            connection
                .execute(
                    "INSERT INTO session VALUES('fake','/synthetic/project',NULL,1)",
                    [],
                )
                .unwrap();
            for (id, role, index) in [("u", "user", 1), ("a", "assistant", 2)] {
                connection
                    .execute(
                        "INSERT INTO message VALUES(?1,'fake',?2,?3)",
                        rusqlite::params![id, index, json!({"role":role}).to_string()],
                    )
                    .unwrap();
                connection.execute("INSERT INTO part VALUES(?1,?2,'fake',?3,?4)",rusqlite::params![format!("p{id}"),id,index,json!({"type":"text","text":if role=="user"{"question token=FAKE_TOKEN"}else{"answer"}}).to_string()]).unwrap();
            }
        }
        drop(connection);
        (dir, path)
    }
    #[test]
    fn sqlite_v1_v2_are_readonly_no_migration_no_write_lock_and_no_file_changes() {
        for v2 in [false, true] {
            let (_dir, path) = database_fixture(v2);
            let before = fs::read(&path).unwrap();
            let modified = fs::metadata(&path).unwrap().modified().unwrap();
            let source = path.join("fake");
            let (page, _) =
                normalized::page(&source, TranscriptKind::OpenCode, None, None).unwrap();
            let serialized = serde_json::to_string(&page).unwrap();
            assert!(serialized.contains("answer"));
            assert!(!serialized.contains("FAKE_TOKEN"));
            assert_eq!(
                Sha256::digest(before),
                Sha256::digest(fs::read(&path).unwrap())
            );
            assert_eq!(modified, fs::metadata(&path).unwrap().modified().unwrap());
            let connection = open_database(&path).unwrap();
            assert!(connection.execute("CREATE TABLE forbidden(x)", []).is_err());
            let writer = Connection::open(&path).unwrap();
            writer.execute_batch("BEGIN IMMEDIATE;ROLLBACK;").unwrap();
            assert!(!source.parent().unwrap().with_extension("db-wal").exists());
        }
    }
    #[test]
    fn sqlite_live_wal_and_unknown_schema_refuse_without_modifying_anything() {
        let (_dir, path) = database_fixture(false);
        let wal = PathBuf::from(format!("{}-wal", path.display()));
        fs::write(&wal, b"synthetic active WAL").unwrap();
        assert_eq!(open_database(&path).unwrap_err(), "native.databaseBusy");
        fs::remove_file(wal).unwrap();
        let unknown = tempfile::tempdir().unwrap();
        let path = unknown.path().join("opencode.db");
        drop(Connection::open(&path).unwrap());
        assert_eq!(
            db_layout(&open_database(&path).unwrap()).unwrap_err(),
            UNSUPPORTED
        );
    }
    #[test]
    fn all_sources_export_masked_handoffs_without_resuming_or_modifying_history() {
        for kind in KINDS {
            let (dir, path) = if kind == TranscriptKind::OpenCode {
                database_fixture(true)
            } else {
                fixture(kind)
            };
            let physical = if kind == TranscriptKind::OpenCode {
                path.clone()
            } else {
                physical(&path).into()
            };
            let before = fs::read(&physical).unwrap();
            let text = super::super::export(
                kind,
                "/synthetic/project",
                Some("fake"),
                Some(dir.path()),
                256,
            )
            .unwrap();
            assert!(text.contains("question"));
            assert!(text.contains("answer"));
            assert!(!text.contains("FAKE_TOKEN"));
            assert_eq!(before, fs::read(physical).unwrap());
        }
    }
    #[test]
    fn jsonl_pages_reach_the_start_and_empty_sessions_stay_out() {
        for kind in [
            TranscriptKind::Qwen,
            TranscriptKind::Copilot,
            TranscriptKind::Grok,
            TranscriptKind::Kimi,
        ] {
            let (_dir, path) = fixture(kind);
            let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
            for index in 0..650 {
                let value = format!("synthetic message {index}");
                let row = match kind {
                    TranscriptKind::Qwen => {
                        json!({"type":"user","message":{"parts":[{"text":value}]}})
                    }
                    TranscriptKind::Copilot => {
                        json!({"type":"user.message","data":{"content":value}})
                    }
                    TranscriptKind::Grok => json!({"role":"user","content":value}),
                    _ => json!({"message":{"type":"TurnBegin","payload":{"user_input":value}}}),
                };
                writeln!(file, "{row}").unwrap();
            }
            drop(file);
            let mut cursor = None;
            let mut ids = std::collections::BTreeSet::new();
            let mut prompts = 0;
            loop {
                let (page, _) = normalized::page(&path, kind, cursor.as_ref(), None).unwrap();
                for item in page.turns.iter().flat_map(|turn| &turn.items) {
                    assert!(ids.insert(item.id.clone()));
                    prompts += usize::from(item.text.starts_with("synthetic message "));
                }
                cursor = page.previous_cursor;
                if cursor.is_none() {
                    break;
                }
            }
            assert_eq!(prompts, 650);
            let empty = match kind {
                TranscriptKind::Qwen => {
                    json!({"type":"system","sessionId":"fake","cwd":"/synthetic/project","version":"0.27.4"})
                }
                TranscriptKind::Copilot => json!({"type":"session.start","data":{"version":1}}),
                TranscriptKind::Grok => json!({"role":"system","content":"internal context"}),
                _ => json!({"type":"metadata","protocol_version":"1.10"}),
            };
            write(&path, &[empty]);
            assert!(!rows_have_user(&path, kind));
        }
    }
    #[test]
    fn kimi_legacy_index_matches_lowercase_padded_md5_bucket() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let cwd = "/synthetic/project";
        let path = root.join("sessions/0bf1bb5b0142c5392a787c677ddc1506/fake/wire.jsonl");
        write(&path, &[]);
        write(
            &root.join("kimi.json"),
            &[json!({"work_dirs":[{"path":cwd,"kaos":"local"}]})],
        );

        assert_eq!(
            metadata(&path, TranscriptKind::Kimi),
            Some(("fake".into(), cwd.into()))
        );
    }

    #[test]
    fn kimi_new_journal_contract_and_unknown_mutations_are_explicit() {
        let (_dir, path) = fixture(TranscriptKind::Kimi);
        write(
            &path,
            &[
                json!({"type":"metadata","protocol_version":"1.5"}),
                json!({"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"new journal request"}]}}),
                json!({"type":"context.append_message","message":{"role":"assistant","content":[{"type":"think","think":"public reasoning"}],"toolCalls":[{"id":"c","function":{"name":"ReadFile","arguments":"{}"}}]}}),
                json!({"type":"context.append_message","message":{"role":"tool","toolCallId":"c","content":[{"type":"text","text":"done"}]}}),
            ],
        );
        let (page, _) = normalized::page(&path, TranscriptKind::Kimi, None, None).unwrap();
        let items = page
            .turns
            .iter()
            .flat_map(|turn| &turn.items)
            .collect::<Vec<_>>();
        assert!(items
            .iter()
            .any(|item| item.kind == normalized::ItemKind::Reasoning));
        assert!(items
            .iter()
            .any(|item| item.output.as_deref() == Some("done")));
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(file, "{}", json!({"type":"context.future_mutation"})).unwrap();
        drop(file);
        assert!(normalized::page(&path, TranscriptKind::Kimi, None, None)
            .unwrap_err()
            .contains("unsupported_version"));
    }
    #[cfg(unix)]
    #[test]
    fn history_roots_never_follow_nested_symlinks() {
        let (outside, _) = fixture(TranscriptKind::Qwen);
        let root = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("projects"),
            root.path().join("projects"),
        )
        .unwrap();
        assert!(locate(root.path(), TranscriptKind::Qwen, "", "fake").is_none());
    }
    #[test]
    fn structured_tool_errors_keep_masked_details() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("synthetic.jsonl");
        write(
            &path,
            &[
                tool("c", "edit", &json!({"path":"/synthetic/file"})),
                result(
                    "c",
                    &json!({"message":"synthetic failure","token":"FAKE_TOKEN"}),
                    true,
                ),
            ],
        );
        let (page, _) = normalized::page(&path, TranscriptKind::Claude, None, None).unwrap();
        let item = &page.turns[0].items[0];
        assert!(item.is_error);
        assert!(item.output.as_ref().unwrap().contains("synthetic failure"));
        assert!(!item.output.as_ref().unwrap().contains("FAKE_TOKEN"));
    }
    #[test]
    fn sqlite_paging_skips_empty_children_and_oversized_json_without_mutation() {
        let (dir, path) = database_fixture(true);
        let connection = Connection::open(&path).unwrap();
        connection
            .execute(
                "INSERT INTO session_v2 VALUES('empty','/synthetic/project',NULL,2)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO session_v2 VALUES('child','/synthetic/project','fake',3)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO session_message VALUES('hidden','child','user',1,?1)",
                [json!({"text":"NEVER_CHILD"}).to_string()],
            )
            .unwrap();
        for index in 0..650 {
            connection
                .execute(
                    "INSERT INTO session_message VALUES(?1,'fake','user',?2,?3)",
                    rusqlite::params![
                        format!("msg-{index}"),
                        index + 10,
                        json!({"text":format!("database message {index}")}).to_string()
                    ],
                )
                .unwrap();
        }
        connection
            .execute(
                "INSERT INTO session_message VALUES('huge','fake','user',9999,?1)",
                [json!({"text":" ".repeat(24*1024*1024+1)}).to_string()],
            )
            .unwrap();
        drop(connection);
        let before = fs::read(&path).unwrap();
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        let mut listed = Vec::new();
        let mut incomplete = false;
        scan(
            TranscriptKind::OpenCode,
            dir.path(),
            None,
            &mut listed,
            HistoryScanOptions {
                all: false,
                archived: false,
                retained: 100,
            },
            &mut incomplete,
        )
        .unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].0.native_session_id, "fake");
        assert!(locate(dir.path(), TranscriptKind::OpenCode, "", "child").is_none());
        assert!(locate(dir.path(), TranscriptKind::OpenCode, "", "../fake").is_none());
        let mut cursor = None;
        let mut prompts = 0;
        loop {
            let (page, _) = normalized::page(
                &path.join("fake"),
                TranscriptKind::OpenCode,
                cursor.as_ref(),
                None,
            )
            .unwrap();
            assert!(!page.warnings.is_empty());
            for item in page.turns.iter().flat_map(|turn| &turn.items) {
                assert!(!item.text.contains("NEVER_CHILD"));
                prompts += usize::from(item.text.starts_with("database message "));
            }
            cursor = page.previous_cursor;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(prompts, 650);
        assert_eq!(
            Sha256::digest(before),
            Sha256::digest(fs::read(&path).unwrap())
        );
        assert_eq!(modified, fs::metadata(&path).unwrap().modified().unwrap());
    }
}
