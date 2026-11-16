//! Source-independent, masked records. Native files are never modified.
use super::{
    content_text, open_regular_transcript_handle, read_bounded_line, redact, TranscriptKind,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, VecDeque};
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const LINE_LIMIT: usize = 24 * 1024 * 1024;
const SCAN_LIMIT: u64 = 512 * 1024 * 1024;
const PAGE_BYTES: usize = 256 * 1024;
const PAGE_ITEMS: usize = 300;
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ItemKind {
    User,
    Assistant,
    Reasoning,
    Tool,
    FileChange,
    Image,
    System,
    Subagent,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedItem {
    pub id: String,
    pub turn_id: Option<String>,
    pub message_id: Option<String>,
    pub kind: ItemKind,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    pub is_error: bool,
    pub unreadable: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedTurn {
    pub id: String,
    pub items: Vec<NormalizedItem>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedPage {
    pub turns: Vec<NormalizedTurn>,
    pub previous_cursor: Option<HistoryCursor>,
    pub truncated: bool,
    pub warnings: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryCursor {
    pub before: u64,
    pub length: u64,
    pub modified: String,
}
#[derive(Debug)]
pub enum ImageSource {
    Data(String),
    File(PathBuf, bool),
}
struct Parser<'a> {
    items: VecDeque<(u64, NormalizedItem)>,
    bytes: usize,
    count: u64,
    before: u64,
    turn: Option<String>,
    message_id: Option<String>,
    preserve_turn: bool,
    allow_sidechain: bool,
    source: PathBuf,
    calls: BTreeMap<String, String>,
    clipped: bool,
    masker: redact::Masker,
    request: Option<&'a str>,
    image: Option<ImageSource>,
}
impl Parser<'_> {
    fn emit(&mut self, mut item: NormalizedItem) {
        item.text = self.masker.text(&item.text);
        item.input = item.input.map(|text| self.masker.text(&text));
        item.output = item.output.map(|text| self.masker.text(&text));
        item.turn_id = self.turn.clone();
        item.message_id = self.message_id.clone();
        let mut value = serde_json::to_value(&item).expect("record serialization");
        redact::value(&mut value);
        item = serde_json::from_value(value).expect("masked record shape");
        for field in [
            &mut item.name,
            &mut item.call_id,
            &mut item.message_id,
            &mut item.turn_id,
        ]
        .into_iter()
        .flatten()
        {
            if field.len() > 512 {
                *field = truncate_text(field, 512);
                self.clipped = true;
            }
        }
        let ordinal = self.count;
        self.count += 1;
        if ordinal >= self.before {
            return;
        }
        let size = serde_json::to_vec(&item).map_or(0, |data| data.len());
        if size > PAGE_BYTES {
            self.clipped = true;
            item.text = truncate_text(&item.text, PAGE_BYTES / 4);
            item.input = item.input.map(|s| truncate_text(&s, PAGE_BYTES / 4));
            item.output = item.output.map(|s| truncate_text(&s, PAGE_BYTES / 4));
        }
        let mut size = serde_json::to_vec(&item).map_or(0, |data| data.len());
        // JSON escaping can expand control characters sixfold. Bound the wire
        // representation as well as raw string bytes, without dropping a row.
        while size > PAGE_BYTES {
            self.clipped = true;
            item.text = truncate_text(&item.text, (item.text.len() / 2).max(64));
            item.input = item
                .input
                .map(|text| truncate_text(&text, (text.len() / 2).max(64)));
            item.output = item
                .output
                .map(|text| truncate_text(&text, (text.len() / 2).max(64)));
            size = serde_json::to_vec(&item).map_or(0, |data| data.len());
        }
        self.bytes += size;
        self.items.push_back((ordinal, item));
        while self.items.len() > PAGE_ITEMS || self.bytes > PAGE_BYTES {
            if let Some((_, old)) = self.items.pop_front() {
                self.bytes = self
                    .bytes
                    .saturating_sub(serde_json::to_vec(&old).map_or(0, |data| data.len()));
            }
        }
    }
    fn item(&self, id: String, kind: ItemKind, text: String) -> NormalizedItem {
        NormalizedItem {
            id,
            turn_id: None,
            message_id: None,
            kind,
            text,
            call_id: None,
            result_id: None,
            name: None,
            input: None,
            output: None,
            is_error: false,
            unreadable: false,
        }
    }
    fn plain(&mut self, id: String, role: &str, text: String) {
        if text.trim().is_empty() {
            return;
        }
        if role == "user" && !self.preserve_turn {
            self.turn = Some(id.clone());
        }
        let text = if role == "user" {
            super::visible_user_text(&text).to_string()
        } else {
            text
        };
        if text.trim().is_empty() {
            return;
        }
        if role == "user" {
            for (index, path) in super::images::attachment_paths(&text)
                .into_iter()
                .enumerate()
            {
                let key = format!("{id}:text-image:{index}");
                if self.request == Some(key.as_str()) {
                    self.image = Some(ImageSource::File(path.into(), true));
                }
                self.emit(self.item(key, ItemKind::Image, String::new()));
            }
        }
        self.emit(self.item(
            id,
            if role == "user" {
                ItemKind::User
            } else {
                ItemKind::Assistant
            },
            text,
        ));
    }
    fn picture(&mut self, id: String, block: &Value, user: bool) {
        let encoded = block
            .pointer("/source/data")
            .or_else(|| block.pointer("/inlineData/data"))
            .or_else(|| block.pointer("/inline_data/data"))
            .or_else(|| {
                block["mimeType"]
                    .as_str()
                    .filter(|mime| mime.starts_with("image/"))
                    .and_then(|_| block.get("data"))
            })
            .and_then(Value::as_str);
        let url = block["image_url"]
            .as_str()
            .or_else(|| block.pointer("/image_url/url").and_then(Value::as_str));
        let data = encoded.or_else(|| {
            url.and_then(|url| url.strip_prefix("data:image/"))
                .and_then(|url| url.split_once(";base64,").map(|(_, data)| data))
        });
        let path = block["path"]
            .as_str()
            .or_else(|| block.pointer("/source/path").and_then(Value::as_str))
            .or_else(|| url.filter(|url| Path::new(url).is_absolute()))
            .or_else(|| block.pointer("/fileData/fileUri").and_then(Value::as_str));
        let path = path.and_then(|raw| {
            if raw.starts_with("file://") {
                reqwest::Url::parse(raw).ok()?.to_file_path().ok()
            } else {
                Path::new(raw).is_absolute().then(|| PathBuf::from(raw))
            }
        });
        if data.is_none() && path.is_none() {
            return;
        }
        if self.request == Some(id.as_str()) {
            self.image = data
                .map(|data| ImageSource::Data(data.into()))
                .or_else(|| path.map(|path| ImageSource::File(path, user)));
        }
        self.emit(self.item(id, ItemKind::Image, String::new()));
    }
    fn tool(
        &mut self,
        id: String,
        call: &str,
        name: Option<&str>,
        input: Option<&Value>,
        output: Option<String>,
        error: bool,
    ) {
        let decoded = input
            .and_then(Value::as_str)
            .and_then(|text| serde_json::from_str::<Value>(text).ok());
        let input = decoded.as_ref().or(input);
        if let Some(name) = name {
            if self.calls.len() < 10_000 && call.len() <= 512 && name.len() <= 512 {
                self.calls.insert(call.into(), name.into());
            }
        }
        let output = output.map(|output| {
            if self.calls.contains_key(call) {
                expand_result(&self.source, call, &output)
            } else {
                output
            }
        });
        if self
            .calls
            .get(call)
            .is_some_and(|name| matches!(name.as_str(), "spawn_agent" | "functions.spawn_agent"))
        {
            if let Some(agent) = output
                .as_ref()
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
                .and_then(|value| value["agent_id"].as_str().map(str::to_owned))
            {
                if valid_id(&agent) {
                    let mut item =
                        self.item(format!("{id}:subagent"), ItemKind::Subagent, String::new());
                    item.name = Some(agent);
                    self.emit(item);
                }
            }
        }
        let mut item = self.item(id.clone(), ItemKind::Tool, String::new());
        item.call_id = Some(call.into());
        item.name = name.map(str::to_string);
        item.input = input.map(|input| {
            let mut safe = input.clone();
            redact::value(&mut safe);
            match safe {
                Value::String(text) => text,
                other => other.to_string(),
            }
        });
        item.output = output;
        item.is_error = error;
        self.emit(item);
        if let (Some(name), Some(input)) = (name, input) {
            if matches!(
                name.to_ascii_lowercase().as_str(),
                "edit" | "write" | "multiedit" | "replace" | "write_file" | "apply_patch"
            ) {
                let changes: Vec<&Value> = input["edits"]
                    .as_array()
                    .map(|items| items.iter().collect())
                    .unwrap_or_else(|| vec![input]);
                for (index, change) in changes.into_iter().enumerate() {
                    let old = change["old_string"]
                        .as_str()
                        .or_else(|| change["oldText"].as_str())
                        .unwrap_or("");
                    let new = change["new_string"]
                        .as_str()
                        .or_else(|| change["newText"].as_str())
                        .or_else(|| change["content"].as_str());
                    if let Some(new) = new {
                        let path = input["file_path"]
                            .as_str()
                            .or_else(|| input["path"].as_str())
                            .unwrap_or("recorded-file");
                        let mut diff = self.item(
                            format!("{id}:diff:{index}"),
                            ItemKind::FileChange,
                            format!(
                                "--- a/{path}\n+++ b/{path}\n@@ -1,{} +1,{} @@\n{}{}",
                                old.lines().count(),
                                new.lines().count(),
                                old.lines()
                                    .map(|line| format!("-{line}\n"))
                                    .collect::<String>(),
                                new.lines()
                                    .map(|line| format!("+{line}\n"))
                                    .collect::<String>()
                            ),
                        );
                        diff.name = Some(path.into());
                        self.emit(diff);
                    } else if name == "apply_patch" {
                        if let Some(patch) = input.as_str() {
                            self.emit(self.item(
                                format!("{id}:diff"),
                                ItemKind::FileChange,
                                patch.into(),
                            ));
                        }
                    }
                }
            }
        }
    }
    fn blocks(&mut self, id: &str, role: &str, content: &Value) {
        if let Some(text) = content.as_str() {
            if role == "tool" {
                if let Ok(value) = serde_json::from_str::<Value>(text) {
                    self.blocks(id, role, value.get("content").unwrap_or(&value));
                }
            }
            if matches!(role, "user" | "assistant") {
                self.plain(id.into(), role, text.into());
            }
            return;
        }
        let Some(blocks) = content.as_array() else {
            return;
        };
        for (index, block) in blocks.iter().enumerate() {
            let key = format!("{id}:{index}");
            if block.get("thoughtSignature").is_some()
                && block.get("text").is_none()
                && block.get("functionCall").is_none()
            {
                let mut item = self.item(key, ItemKind::Reasoning, String::new());
                item.unreadable = true;
                self.emit(item);
                continue;
            }
            if block["thought"] == true {
                let text = block["text"].as_str().unwrap_or("");
                let mut item = self.item(key, ItemKind::Reasoning, text.into());
                item.unreadable = text.is_empty();
                self.emit(item);
                continue;
            }
            if let Some(text) = block["text"]
                .as_str()
                .filter(|_| matches!(role, "user" | "assistant"))
            {
                self.plain(key.clone(), role, text.into());
            }
            match block["type"].as_str() {
                Some("thinking" | "redacted_thinking") => {
                    let summary = if block["type"] == "redacted_thinking" {
                        ""
                    } else {
                        block["thinking"].as_str().unwrap_or("")
                    };
                    let mut item = self.item(key.clone(), ItemKind::Reasoning, summary.into());
                    item.unreadable = summary.is_empty();
                    self.emit(item);
                }
                Some("tool_use") => {
                    if let Some(call) = block["id"].as_str() {
                        self.tool(
                            key.clone(),
                            call,
                            block["name"].as_str(),
                            Some(&block["input"]),
                            None,
                            false,
                        );
                    }
                }
                Some("tool_result") => {
                    if let Some(call) = block["tool_use_id"].as_str() {
                        self.tool(
                            key.clone(),
                            call,
                            None,
                            None,
                            Some(content_text(&block["content"])),
                            block["is_error"] == true,
                        );
                        self.blocks(&format!("{key}:result"), "tool", &block["content"]);
                    }
                }
                Some("image" | "input_image") => self.picture(key.clone(), block, role == "user"),
                _ => {}
            }
            if block.get("inlineData").is_some()
                || block.get("inline_data").is_some()
                || block.get("fileData").is_some()
            {
                self.picture(key.clone(), block, role == "user");
            }
            if let Some(call) = block.get("functionCall") {
                let call_id = call["id"].as_str().unwrap_or(&key);
                self.tool(
                    key.clone(),
                    call_id,
                    call["name"].as_str(),
                    Some(&call["args"]),
                    None,
                    false,
                );
            }
            if let Some(result) = block.get("functionResponse") {
                let call_id = result["id"].as_str().unwrap_or(&key);
                self.tool(
                    key.clone(),
                    call_id,
                    None,
                    None,
                    Some(result["response"].to_string()),
                    result.pointer("/response/error").is_some(),
                );
            }
        }
    }
    fn row(&mut self, row: &Value, kind: TranscriptKind, offset: u64) {
        let id = format!("record-{offset}");
        self.preserve_turn = kind == TranscriptKind::Codex;
        self.message_id = row["uuid"].as_str().map(str::to_string);
        match kind {
            TranscriptKind::Codex => {
                if row["type"] == "turn_context"
                    || row["type"] == "event_msg" && row["payload"]["type"] == "task_started"
                {
                    self.turn = row["payload"]["turn_id"].as_str().map(str::to_owned);
                }
                let payload = &row["payload"];
                if row["type"] == "response_item" {
                    match payload["type"].as_str() {
                        Some("message") => {
                            let role = payload["role"].as_str().unwrap_or("");
                            if matches!(role, "user" | "assistant") {
                                let turn = self.turn.clone();
                                self.blocks(&id, role, &payload["content"]);
                                if turn.is_some() {
                                    self.turn = turn;
                                }
                            }
                        }
                        Some("reasoning") => {
                            let summary = payload["summary"]
                                .as_array()
                                .map(|parts| {
                                    parts
                                        .iter()
                                        .filter(|part| {
                                            part["type"].is_null() || part["type"] == "summary_text"
                                        })
                                        .filter_map(|part| part["text"].as_str())
                                        .collect::<Vec<_>>()
                                        .join("\n")
                                })
                                .unwrap_or_default();
                            let mut item = self.item(id, ItemKind::Reasoning, summary);
                            item.unreadable = item.text.is_empty();
                            self.emit(item);
                        }
                        Some("function_call" | "custom_tool_call") => {
                            if let Some(call) = payload["call_id"].as_str() {
                                self.tool(
                                    id,
                                    call,
                                    payload["name"].as_str(),
                                    payload.get("arguments").or_else(|| payload.get("input")),
                                    None,
                                    false,
                                );
                            }
                        }
                        Some("function_call_output" | "custom_tool_call_output") => {
                            if let Some(call) = payload["call_id"].as_str() {
                                self.tool(
                                    id.clone(),
                                    call,
                                    None,
                                    None,
                                    Some(
                                        payload["output"]
                                            .as_str()
                                            .map(str::to_owned)
                                            .unwrap_or_else(|| content_text(&payload["output"])),
                                    ),
                                    false,
                                );
                                self.blocks(&format!("{id}:output"), "tool", &payload["output"]);
                            }
                        }
                        _ => {}
                    }
                } else if payload["type"] == "turn_diff" {
                    if let Some(diff) = payload["diff"].as_str() {
                        self.emit(self.item(id, ItemKind::FileChange, diff.into()));
                    }
                } else if matches!(
                    payload["type"].as_str(),
                    Some("context_compacted" | "task_complete" | "turn_aborted")
                ) {
                    self.emit(self.item(
                        id,
                        ItemKind::System,
                        payload["type"].as_str().unwrap_or_default().into(),
                    ));
                    if payload["type"] != "context_compacted" {
                        self.turn = None;
                    }
                } else if row["type"] == "compacted" {
                    self.emit(self.item(id, ItemKind::System, "context_compacted".into()));
                }
            }
            TranscriptKind::Claude => {
                if row["isSidechain"] == true && !self.allow_sidechain {
                    return;
                }
                let role = row["type"].as_str().unwrap_or("");
                if matches!(role, "user" | "assistant") {
                    self.blocks(&id, role, &row["message"]["content"]);
                } else if matches!(role, "system" | "summary") {
                    self.emit(self.item(id, ItemKind::System, content_text(&row["content"])));
                }
            }
            TranscriptKind::Gemini => {
                let role = row["type"].as_str().unwrap_or("");
                if role == "user" || matches!(role, "gemini" | "model" | "assistant") {
                    self.blocks(
                        &id,
                        if role == "user" { "user" } else { "assistant" },
                        &row["content"],
                    );
                    if let Some(thoughts) = row["thoughts"].as_array() {
                        for (index, thought) in thoughts.iter().enumerate() {
                            let text = [
                                thought["subject"].as_str(),
                                thought["description"].as_str(),
                                thought["text"].as_str(),
                            ]
                            .into_iter()
                            .flatten()
                            .collect::<Vec<_>>()
                            .join("\n");
                            let mut item = self.item(
                                format!("{id}:thought:{index}"),
                                ItemKind::Reasoning,
                                text,
                            );
                            item.unreadable = item.text.is_empty();
                            self.emit(item);
                        }
                    }
                    if let Some(tools) = row["toolCalls"].as_array() {
                        for (index, tool) in tools.iter().enumerate() {
                            let key = format!("{id}:tool:{index}");
                            if let Some(call) = tool["id"].as_str() {
                                self.tool(
                                    key.clone(),
                                    call,
                                    tool["name"].as_str(),
                                    Some(&tool["args"]),
                                    None,
                                    tool["status"] == "error",
                                );
                                if !tool["result"].is_null() {
                                    self.tool(
                                        format!("{key}:result"),
                                        call,
                                        None,
                                        None,
                                        Some(super::gemini_content_text(&tool["result"])),
                                        tool["status"] == "error",
                                    );
                                    self.blocks(&format!("{key}:images"), "tool", &tool["result"]);
                                }
                                if let Some(agent) = tool["agentId"].as_str() {
                                    let mut item = self.item(
                                        format!("{key}:agent"),
                                        ItemKind::Subagent,
                                        String::new(),
                                    );
                                    item.name = Some(agent.into());
                                    self.emit(item);
                                }
                            }
                        }
                    }
                } else if matches!(role, "info" | "error" | "warning") {
                    let mut item = self.item(
                        id,
                        ItemKind::System,
                        super::gemini_content_text(&row["content"]),
                    );
                    item.is_error = role == "error";
                    self.emit(item);
                }
            }
            TranscriptKind::Antigravity => {
                if let Some((role, text)) = super::antigravity_turn(row) {
                    self.plain(id, role, text.into());
                }
            }
            kind if super::additional::supported(kind) => {}
            TranscriptKind::Cursor => {
                if let Some((role, text)) = super::cursor_turn(row) {
                    self.plain(id, role, text);
                }
            }
            _ => {}
        }
    }
}

pub(super) fn decoded_reader(path: &Path) -> Option<Box<dyn Read>> {
    let file = open_regular_transcript_handle(path)?;
    if path.extension().is_some_and(|ext| ext == "zst") {
        if file.metadata().ok()?.len() > super::MAX_TRANSCRIPT_FILE_BYTES {
            return None;
        }
        let mut decoder = zstd::stream::read::Decoder::new(file).ok()?;
        decoder.window_log_max(27).ok()?;
        Some(Box::new(decoder))
    } else {
        Some(Box::new(file))
    }
}
pub(super) fn stream_rows(path: &Path, visit: impl FnMut(&Value, u64)) -> Result<bool, String> {
    stream_mode(path, false, visit)
}
fn stream_mode(path: &Path, tail: bool, visit: impl FnMut(&Value, u64)) -> Result<bool, String> {
    stream_mode_limit(path, tail, SCAN_LIMIT, visit)
}
fn stream_mode_limit(
    path: &Path,
    tail: bool,
    scan_limit: u64,
    mut visit: impl FnMut(&Value, u64),
) -> Result<bool, String> {
    let mut offset = 0;
    let mut partial = false;
    let mut file = open_regular_transcript_handle(path).ok_or("The transcript is unavailable.")?;
    let length = file
        .metadata()
        .map_err(|_| "Transcript unavailable.")?
        .len();
    if tail
        && !path.extension().is_some_and(|ext| ext == "zst")
        && length > super::MAX_TRANSCRIPT_FILE_BYTES
    {
        offset = length.saturating_sub(super::MAX_TRANSCRIPT_TAIL_BYTES);
        file.seek(SeekFrom::Start(offset - 1))
            .map_err(|_| "Cannot seek transcript.")?;
        let mut previous = [0];
        file.read_exact(&mut previous)
            .map_err(|_| "Cannot seek transcript.")?;
        partial = previous[0] != b'\n';
    }
    let reader: Box<dyn Read> = if path.extension().is_some_and(|ext| ext == "zst") {
        decoded_reader(path).ok_or("Invalid compressed transcript.")?
    } else {
        Box::new(file)
    };
    let budget = if offset > 0 {
        super::MAX_TRANSCRIPT_TAIL_BYTES
    } else if path.extension().is_some_and(|ext| ext == "zst") {
        scan_limit
    } else {
        length
    };
    let mut reader = BufReader::new(reader.take(budget + 1));
    let mut skipped = offset > 0;
    let mut line = Vec::new();
    if partial {
        let before = reader.get_ref().limit() + reader.buffer().len() as u64;
        read_bounded_line(&mut reader, &mut line, 0).map_err(|_| "Cannot read transcript.")?;
        offset += before - (reader.get_ref().limit() + reader.buffer().len() as u64);
    }
    loop {
        let before = reader.get_ref().limit() + reader.buffer().len() as u64;
        let read = read_bounded_line(&mut reader, &mut line, LINE_LIMIT)
            .map_err(|_| "Cannot read transcript.")?;
        match read {
            None => break,
            Some(false) => skipped = true,
            Some(true) => {
                if let Ok(row) = serde_json::from_slice::<Value>(&line) {
                    visit(&row, offset);
                } else if !line.iter().all(u8::is_ascii_whitespace) {
                    skipped = true;
                }
            }
        }
        offset += before - (reader.get_ref().limit() + reader.buffer().len() as u64);
    }
    if reader.get_ref().limit() == 0 {
        return Err("Transcript exceeds the decoded size limit.".into());
    }
    Ok(skipped)
}
fn parser<'a>(
    path: &Path,
    image_request: Option<&'a str>,
    before: u64,
    sidechain: bool,
) -> Parser<'a> {
    Parser {
        items: VecDeque::new(),
        bytes: 0,
        count: 0,
        before,
        turn: None,
        message_id: None,
        preserve_turn: false,
        allow_sidechain: sidechain,
        source: path.into(),
        calls: BTreeMap::new(),
        clipped: false,
        masker: redact::Masker::default(),
        request: image_request,
        image: None,
    }
}
pub fn recent(
    path: &Path,
    kind: TranscriptKind,
) -> Result<super::LocalConversationSnapshot, String> {
    let mut parser = parser(path, None, u64::MAX, false);
    if !super::additional::supported(kind)
        && kind != TranscriptKind::Gemini
        && !path.extension().is_some_and(|ext| ext == "zst")
    {
        let length = fingerprint(path)?.0;
        if length > super::MAX_TRANSCRIPT_FILE_BYTES {
            parser
                .masker
                .prime_prefix(path, length - super::MAX_TRANSCRIPT_TAIL_BYTES)?;
        }
    }
    let skipped = if super::additional::supported(kind) {
        super::additional::rows(path, kind, |row, index| {
            parser.row(row, TranscriptKind::Claude, index)
        })?
    } else if kind == TranscriptKind::Gemini {
        gemini_rows(path, |row, index| parser.row(row, kind, index))?
    } else {
        stream_mode(path, true, |row, index| parser.row(row, kind, index))?
    };
    append_children(&mut parser, path, kind);
    let dropped = parser.items.front().is_some_and(|(index, _)| *index > 0);
    let turns = vec![NormalizedTurn {
        id: "recent".into(),
        items: coalesce(parser.items.into_iter().map(|(_, item)| item).collect()),
    }];
    Ok(legacy(NormalizedPage {
        turns,
        previous_cursor: None,
        truncated: skipped || parser.count > PAGE_ITEMS as u64 || parser.clipped || dropped,
        warnings: Vec::new(),
    }))
}

fn truncate_text(text: &str, bytes: usize) -> String {
    if text.len() <= bytes {
        return text.into();
    }
    let end = text
        .char_indices()
        .map(|(index, _)| index)
        .take_while(|index| *index <= bytes)
        .last()
        .unwrap_or(0);
    format!("{}\n[content truncated]", &text[..end])
}
pub(super) fn has_user(path: &Path) -> bool {
    let mut visible = false;
    gemini_rows(path, |row, _| {
        if super::gemini_message_record(row).is_some_and(|record| {
            record.role == Some("user") && !super::visible_user_text(&record.text).is_empty()
        }) {
            visible = true;
        }
    })
    .is_ok()
        && visible
}
fn json_messages(path: &Path, visit: &mut dyn FnMut(&Value, u64)) -> Result<(), String> {
    use serde::de::{DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
    struct Messages<'a>(&'a mut dyn FnMut(&Value, u64));
    impl<'de> DeserializeSeed<'de> for Messages<'_> {
        type Value = ();
        fn deserialize<D: serde::Deserializer<'de>>(self, de: D) -> Result<(), D::Error> {
            de.deserialize_seq(self)
        }
    }
    impl<'de> Visitor<'de> for Messages<'_> {
        type Value = ();
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("messages")
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
            let mut index = 0;
            while let Some(value) = seq.next_element::<Value>()? {
                (self.0)(&value, index);
                index += 1;
            }
            Ok(())
        }
    }
    struct Root<'a>(&'a mut dyn FnMut(&Value, u64));
    impl<'de> Visitor<'de> for Root<'_> {
        type Value = ();
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("conversation")
        }
        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
            while let Some(key) = map.next_key::<String>()? {
                if key == "messages" {
                    map.next_value_seed(Messages(self.0))?;
                } else {
                    map.next_value::<IgnoredAny>()?;
                }
            }
            Ok(())
        }
    }
    let file = open_regular_transcript_handle(path).ok_or("Transcript unavailable.")?;
    if file
        .metadata()
        .map_err(|_| "Transcript unavailable.")?
        .len()
        > super::MAX_TRANSCRIPT_FILE_BYTES
    {
        return Err("JSON transcript exceeds the bounded reader size.".into());
    }
    let mut de = serde_json::Deserializer::from_reader(BufReader::new(
        file.take(super::MAX_TRANSCRIPT_FILE_BYTES + 1),
    ));
    serde::de::Deserializer::deserialize_map(&mut de, Root(visit))
        .map_err(|_| "Cannot decode JSON conversation.".to_string())
}
fn gemini_rows(path: &Path, mut visit: impl FnMut(&Value, u64)) -> Result<bool, String> {
    if path.extension().is_some_and(|ext| ext == "json") {
        json_messages(path, &mut visit)?;
        return Ok(false);
    }
    let mut records = BTreeMap::<String, Value>::new();
    let mut order = Vec::<String>::new();
    let mut overflow = false;
    let mut replay_bytes = 0usize;
    let skipped = stream_rows(path, |row, _| {
        replay_bytes =
            replay_bytes.saturating_add(serde_json::to_vec(row).map_or(0, |bytes| bytes.len()));
        if replay_bytes > 64 * 1024 * 1024 {
            overflow = true;
        }
        if overflow {
            return;
        }
        if let Some(messages) = row
            .pointer("/$set/messages")
            .or_else(|| row.get("messages"))
            .and_then(Value::as_array)
        {
            records.clear();
            order.clear();
            for message in messages {
                if let Some(id) = message["id"].as_str() {
                    order.push(id.into());
                    records.insert(id.into(), message.clone());
                }
            }
        } else if let Some(id) = row["$rewindTo"].as_str() {
            if let Some(index) = order.iter().position(|entry| entry == id) {
                for key in order.drain(index..) {
                    records.remove(&key);
                }
            } else {
                records.clear();
                order.clear();
            }
        } else if let Some(patch) = row.get("$patch") {
            let updates = patch["updates"]
                .as_array()
                .map(|updates| updates.iter().collect::<Vec<_>>())
                .unwrap_or_else(|| vec![patch]);
            for update in updates {
                if let Some(held) = update["id"].as_str().and_then(|id| records.get_mut(id)) {
                    if let Some(content) = update.get("content") {
                        held["content"] = content.clone();
                    }
                    if let (Some(patches), Some(tools)) = (
                        update["toolCalls"].as_array(),
                        held["toolCalls"].as_array_mut(),
                    ) {
                        for patch in patches {
                            if let Some(tool) =
                                tools.iter_mut().find(|tool| tool["id"] == patch["id"])
                            {
                                for field in ["result", "status", "resultDisplay"] {
                                    if let Some(value) = patch.get(field) {
                                        tool[field] = value.clone();
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if let Some(ids) = patch["removeIds"].as_array() {
                for id in ids.iter().filter_map(Value::as_str) {
                    records.remove(id);
                    order.retain(|key| key != id);
                }
            }
            if let Some(ids) = patch["orderIds"].as_array() {
                let mut next = ids
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|id| records.contains_key(*id))
                    .map(str::to_string)
                    .collect::<Vec<_>>();
                for key in &order {
                    if !next.contains(key) {
                        next.push(key.clone());
                    }
                }
                order = next;
            }
        } else if let Some(id) = row["id"].as_str() {
            if !records.contains_key(id) {
                order.push(id.into());
            }
            records.insert(id.into(), row.clone());
        }
        overflow |= records.len() > 50_000;
    })?;
    if overflow || skipped {
        return Err("Gemini event history exceeds limits or contains an incomplete mutation; refresh after the CLI finishes writing.".into());
    }
    for (index, id) in order.iter().enumerate() {
        if let Some(row) = records.get(id) {
            visit(row, index as u64);
        }
    }
    Ok(false)
}
fn fingerprint(path: &Path) -> Result<(u64, String), String> {
    let file = open_regular_transcript_handle(super::additional::physical(path))
        .ok_or("Transcript unavailable.")?;
    let meta = file.metadata().map_err(|_| "Transcript unavailable.")?;
    Ok((
        meta.len(),
        meta.modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |time| time.as_nanos())
            .to_string(),
    ))
}
pub fn page(
    path: &Path,
    kind: TranscriptKind,
    cursor: Option<&HistoryCursor>,
    image_request: Option<&str>,
) -> Result<(NormalizedPage, Option<ImageSource>), String> {
    let (length, modified) = fingerprint(path)?;
    if cursor.is_some_and(|cursor| cursor.length != length || cursor.modified != modified) {
        return Err("The native history changed; reload before reading older records.".into());
    }
    let mut parser = Parser {
        items: VecDeque::new(),
        bytes: 0,
        count: 0,
        before: cursor.map_or(u64::MAX, |cursor| cursor.before),
        turn: None,
        message_id: None,
        preserve_turn: false,
        allow_sidechain: path
            .components()
            .any(|part| part.as_os_str() == "subagents"),
        source: path.into(),
        calls: BTreeMap::new(),
        clipped: false,
        masker: redact::Masker::default(),
        request: image_request,
        image: None,
    };
    let skipped = if super::additional::supported(kind) {
        super::additional::rows(path, kind, |row, index| {
            parser.row(row, TranscriptKind::Claude, index)
        })?
    } else if kind == TranscriptKind::Gemini {
        gemini_rows(path, |row, index| parser.row(row, kind, index))?
    } else {
        stream_rows(path, |row, index| parser.row(row, kind, index))?
    };
    append_children(&mut parser, path, kind);
    if fingerprint(path)? != (length, modified.clone()) {
        return Err("The native history changed while reading; retry.".into());
    }
    let first = parser.items.front().map_or(0, |(ordinal, _)| *ordinal);
    let mut turns = Vec::<NormalizedTurn>::new();
    for (_, item) in parser.items {
        let turn = item.turn_id.clone().unwrap_or_else(|| "unscoped".into());
        if turns.last().is_none_or(|held| held.id != turn) {
            turns.push(NormalizedTurn {
                id: turn,
                items: Vec::new(),
            });
        }
        turns.last_mut().expect("turn exists").items.push(item);
    }
    for turn in &mut turns {
        turn.items = coalesce(std::mem::take(&mut turn.items));
    }
    Ok((
        NormalizedPage {
            turns,
            previous_cursor: (first > 0).then_some(HistoryCursor {
                before: first,
                length,
                modified,
            }),
            truncated: skipped || first > 0 || parser.clipped,
            warnings: if skipped || parser.clipped {
                vec!["Malformed, oversized or incomplete rows were skipped.".into()]
            } else {
                Vec::new()
            },
        },
        parser.image,
    ))
}
pub fn child_agents(path: &Path) -> Vec<String> {
    let Ok(real) = path.canonicalize() else {
        return Vec::new();
    };
    let path = real.as_path();
    let Some(stem) = path.file_stem().and_then(|name| name.to_str()) else {
        return Vec::new();
    };
    let dir = path.with_file_name(stem).join("subagents");
    let Ok(real) = dir.canonicalize() else {
        return Vec::new();
    };
    if real != dir
        || std::fs::symlink_metadata(&dir).is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut agents = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name();
            let id = name
                .to_str()?
                .strip_prefix("agent-")?
                .strip_suffix(".jsonl")?;
            if valid_id(id) && open_regular_transcript_handle(&entry.path()).is_some() {
                Some(id.into())
            } else {
                None
            }
        })
        .take(128)
        .collect::<Vec<_>>();
    agents.sort();
    agents
}
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}
pub fn legacy(page: NormalizedPage) -> super::LocalConversationSnapshot {
    let mut messages = Vec::new();
    for item in page.turns.into_iter().flat_map(|turn| turn.items) {
        let (role, text, tool, record) = match item.kind {
            ItemKind::User => ("user", item.text.clone(), None, Some(item.clone())),
            ItemKind::Assistant => ("assistant", item.text.clone(), None, Some(item.clone())),
            ItemKind::Tool => {
                let call = item.input.is_some();
                (
                    "assistant",
                    if call {
                        item.input.clone().unwrap_or_default()
                    } else {
                        item.output.clone().unwrap_or_default()
                    },
                    Some(super::ConversationTool {
                        call_id: item.call_id.clone().unwrap_or_else(|| item.id.clone()),
                        name: item.name.clone(),
                        kind: if call { "call" } else { "result" },
                    }),
                    Some(item.clone()),
                )
            }
            ItemKind::Reasoning => (
                "assistant",
                item.text.clone(),
                Some(super::ConversationTool {
                    call_id: item.id.clone(),
                    name: None,
                    kind: "reasoning",
                }),
                Some(item.clone()),
            ),
            _ => ("assistant", item.text.clone(), None, Some(item.clone())),
        };
        let paired = item.kind == ItemKind::Tool && item.input.is_some() && item.output.is_some();
        messages.push(super::LocalConversationMessage {
            role,
            text,
            tool,
            native_turn_id: item.turn_id.clone(),
            native_message_id: item.message_id.clone(),
            record,
        });
        if paired {
            let mut result = item.clone();
            result.id = item
                .result_id
                .clone()
                .unwrap_or_else(|| format!("{}:result", item.id));
            result.input = None;
            messages.push(super::LocalConversationMessage {
                role: "assistant",
                text: result.output.clone().unwrap_or_default(),
                tool: Some(super::ConversationTool {
                    call_id: result.call_id.clone().unwrap_or_else(|| result.id.clone()),
                    name: None,
                    kind: "result",
                }),
                native_turn_id: result.turn_id.clone(),
                native_message_id: result.message_id.clone(),
                record: Some(result),
            });
        }
    }
    super::LocalConversationSnapshot {
        messages,
        truncated: page.truncated,
        archived: None,
    }
}

pub fn conversation_path(
    context: &super::ImageConversation,
    cwd: &str,
    agent: Option<&str>,
) -> Result<(TranscriptKind, PathBuf), String> {
    if !valid_id(&context.native_session_id) {
        return Err("Invalid native conversation identity.".into());
    }
    let (kind, path) = super::session_transcript_path(
        &context.definition_id,
        cwd,
        &context.native_session_id,
        context.profile_config_path.as_deref().map(Path::new),
    )?
    .ok_or("Native conversation unavailable.")?;
    let Some(agent) = agent else {
        return Ok((kind, path));
    };
    if !valid_id(agent) {
        return Err("Invalid child conversation identity.".into());
    }
    if kind == TranscriptKind::Gemini && children(path.as_path(), kind).iter().any(|id| id == agent)
    {
        let meta = super::gemini_metadata(&path).ok_or("Child conversation unavailable.")?;
        return Ok((
            kind,
            path.parent()
                .ok_or("Child conversation unavailable.")?
                .join(meta.session_id)
                .join(format!("{agent}.jsonl")),
        ));
    }
    if kind == TranscriptKind::Claude {
        if !child_agents(&path).iter().any(|id| id == agent) {
            return Err("Child conversation unavailable.".into());
        }
        let stem = path.file_stem().ok_or("Child conversation unavailable.")?;
        return Ok((
            kind,
            path.with_file_name(stem)
                .join("subagents")
                .join(format!("agent-{agent}.jsonl")),
        ));
    }
    let mut cursor = None;
    let referenced = loop {
        let (parent, _) = page(&path, kind, cursor.as_ref(), None)?;
        if parent
            .turns
            .iter()
            .flat_map(|turn| &turn.items)
            .any(|item| item.kind == ItemKind::Subagent && item.name.as_deref() == Some(agent))
        {
            break true;
        }
        cursor = parent.previous_cursor;
        if cursor.is_none() {
            break false;
        }
    };
    if !referenced {
        return Err("Child conversation is not referenced by this parent.".into());
    }
    super::session_transcript_path(
        &context.definition_id,
        cwd,
        agent,
        context.profile_config_path.as_deref().map(Path::new),
    )?
    .ok_or_else(|| "Child conversation unavailable.".into())
}
pub fn image_preview(
    context: &super::ImageConversation,
    cwd: &str,
    data: &Path,
    id: &str,
    agent: Option<&str>,
) -> Result<Option<String>, String> {
    if id.len() > 512 {
        return Err("chat.images.denied".into());
    }
    let (kind, path) = conversation_path(context, cwd, agent)?;
    let (_, image) = page(&path, kind, None, Some(id))?;
    match image {
        Some(ImageSource::Data(encoded)) => {
            use sha2::{Digest, Sha256};
            let hash = Sha256::digest(path.to_string_lossy().as_bytes());
            let key = format!(
                "native-preview-{}",
                hash[..16]
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>()
            );
            let directory = crate::agent_chat::general_chat_directory(data, &key)?;
            let saved = crate::chat_images::store(
                &directory,
                &[crate::chat_images::ToolImage::Data(encoded)],
            )
            .into_iter()
            .next()
            .ok_or("chat.images.denied")?;
            crate::chat_images::preview(
                directory.to_str().ok_or("chat.images.denied")?,
                Some(&directory),
                &saved,
            )
        }
        Some(ImageSource::File(path, user)) => {
            if redact::forbidden(&path)
                || path
                    .canonicalize()
                    .ok()
                    .is_some_and(|path| redact::forbidden(&path))
                || !path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| {
                        matches!(
                            ext.to_ascii_lowercase().as_str(),
                            "png" | "jpg" | "jpeg" | "webp" | "gif"
                        )
                    })
            {
                return Err("chat.images.denied".into());
            }
            let raw = path.to_str().ok_or("chat.images.denied")?;
            if crate::chat_attachments::is_other_workspace(data, None, raw) {
                if !user {
                    return Err("chat.images.denied".into());
                }
                crate::chat_attachments::preview_referenced_image(data, &[raw.into()], raw)
            } else {
                crate::chat_images::preview(cwd, None, raw)
            }
        }
        None => Ok(None),
    }
}

fn expand_result(source: &Path, call: &str, output: &str) -> String {
    if !valid_id(call) || !output.contains("<persisted-output>") {
        return output.into();
    }
    let Some(raw) = output
        .split_once("Full output saved to:")
        .and_then(|(_, rest)| rest.lines().next())
        .map(str::trim)
    else {
        return output.into();
    };
    let Ok(source) = source.canonicalize() else {
        return output.into();
    };
    let Some(stem) = source.file_stem() else {
        return output.into();
    };
    let root = source.with_file_name(stem).join("tool-results");
    let path = Path::new(raw);
    let Some(name) = path.file_stem().and_then(|name| name.to_str()) else {
        return output.into();
    };
    if !valid_id(name)
        || redact::forbidden(path)
        || path.parent() != Some(root.as_path())
        || !path
            .extension()
            .is_some_and(|ext| ext == "txt" || ext == "json")
        || root.canonicalize().ok().as_deref() != Some(root.as_path())
        || path.canonicalize().ok().as_deref() != Some(path)
    {
        return output.into();
    }
    let Some(file) = open_regular_transcript_handle(path) else {
        return output.into();
    };
    if !file
        .metadata()
        .is_ok_and(|meta| meta.len() <= 16 * 1024 * 1024)
    {
        return format!("{output}\n[recorded output exceeds 16 MiB limit]");
    }
    let mut text = String::new();
    if file
        .take(16 * 1024 * 1024 + 1)
        .read_to_string(&mut text)
        .is_err()
    {
        return output.into();
    }
    format!("{output}\n{}", redact::text(&text))
}

fn coalesce(items: Vec<NormalizedItem>) -> Vec<NormalizedItem> {
    let mut calls = BTreeMap::<String, usize>::new();
    let mut output = Vec::<NormalizedItem>::new();
    for item in items {
        if item.kind == ItemKind::User {
            calls.clear();
        }
        if item.kind == ItemKind::Tool {
            if let Some(id) = &item.call_id {
                if item.input.is_some() {
                    calls.insert(id.clone(), output.len());
                } else if let Some(index) = calls.get(id).copied() {
                    output[index].output = item.output;
                    output[index].is_error |= item.is_error;
                    output[index].result_id = Some(item.id);
                    continue;
                }
            }
        }
        output.push(item);
    }
    output
}

fn children(path: &Path, kind: TranscriptKind) -> Vec<String> {
    if kind == TranscriptKind::Claude {
        return child_agents(path);
    }
    if kind != TranscriptKind::Gemini {
        return Vec::new();
    }
    let Some(meta) = super::gemini_metadata(path) else {
        return Vec::new();
    };
    if !valid_id(&meta.session_id) {
        return Vec::new();
    }
    let Some(parent) = path.parent().and_then(|path| path.canonicalize().ok()) else {
        return Vec::new();
    };
    let dir = parent.join(meta.session_id);
    if dir.canonicalize().ok().as_deref() != Some(dir.as_path()) {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut ids = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let id = path.file_stem()?.to_str()?;
            if path.extension().is_some_and(|ext| ext == "jsonl")
                && valid_id(id)
                && super::gemini_metadata(&path).is_some_and(|meta| {
                    meta.session_id == id && meta.kind.as_deref() == Some("subagent")
                })
            {
                Some(id.into())
            } else {
                None
            }
        })
        .take(128)
        .collect::<Vec<_>>();
    ids.sort();
    ids
}
fn append_children(parser: &mut Parser<'_>, path: &Path, kind: TranscriptKind) {
    for agent in children(path, kind) {
        let mut item = parser.item(
            format!("subagent:{agent}"),
            ItemKind::Subagent,
            String::new(),
        );
        item.name = Some(agent);
        parser.emit(item);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    fn fixture(rows: &[Value]) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session-fixture.jsonl");
        fs::write(
            &path,
            rows.iter()
                .map(|row| format!("{row}\n"))
                .collect::<String>(),
        )
        .unwrap();
        (dir, path)
    }
    fn items(path: &Path, kind: TranscriptKind) -> Vec<NormalizedItem> {
        page(path, kind, None, None)
            .unwrap()
            .0
            .turns
            .into_iter()
            .flat_map(|turn| turn.items)
            .collect()
    }
    fn claude(text: &str) -> Value {
        json!({"type":"user","message":{"content":text}})
    }
    #[test]
    fn claude_pairs_tools_reads_public_reasoning_diff_and_images_without_changing_source() {
        let (_dir, path) = fixture(&[
            claude("synthetic request"),
            json!({"type":"assistant","uuid":"a","message":{"content":[
                {"type":"thinking","thinking":"public analysis","signature":"NEVER_SIGNATURE"},
                {"type":"redacted_thinking","data":"NEVER_CIPHERTEXT"},
                {"type":"tool_use","id":"edit-1","name":"Edit","input":{"file_path":"/synthetic/a","old_string":"before","new_string":"after"}}
            ]}}),
            json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"edit-1","content":[{"type":"text","text":"done"},{"type":"image","source":{"type":"base64","data":"ZmFrZS1pbWFnZQ=="}}]}]}}),
            json!({"type":"assistant","message":{"content":[{"type":"text","text":"final"}]}}),
            json!({"type":"assistant","isSidechain":true,"message":{"content":"NEVER_CHILD"}}),
        ]);
        let original = fs::read(&path).unwrap();
        let found = items(&path, TranscriptKind::Claude);
        let tool = found
            .iter()
            .find(|item| item.kind == ItemKind::Tool)
            .unwrap();
        assert_eq!(tool.call_id.as_deref(), Some("edit-1"));
        assert_eq!(tool.output.as_deref(), Some("done"));
        assert!(
            found
                .iter()
                .any(|item| item.kind == ItemKind::FileChange
                    && item.text.contains("-before\n+after"))
        );
        assert!(found
            .iter()
            .any(|item| item.kind == ItemKind::Reasoning && item.unreadable));
        let image = found
            .iter()
            .find(|item| item.kind == ItemKind::Image)
            .unwrap();
        assert!(
            matches!(page(&path,TranscriptKind::Claude,None,Some(&image.id)).unwrap().1,Some(ImageSource::Data(data)) if data=="ZmFrZS1pbWFnZQ==")
        );
        let serialized = serde_json::to_string(&found).unwrap();
        assert!(!serialized.contains("NEVER_"));
        assert!(!serialized.contains("ZmFrZS1pbWFnZQ"));
        assert!(!super::super::parse_claude(&path, 64000)
            .unwrap()
            .contains("NEVER_CHILD"));
        assert_eq!(fs::read(path).unwrap(), original);
    }
    #[test]
    fn codex_pairs_tools_retains_public_summary_patch_and_output_image() {
        let (_dir, path) = fixture(&[
            json!({"type":"turn_context","payload":{"turn_id":"t1"}}),
            json!({"type":"response_item","payload":{"type":"reasoning","summary":[{"text":"summary"}],"encrypted_content":"NEVER_CIPHERTEXT"}}),
            json!({"type":"response_item","payload":{"type":"custom_tool_call","call_id":"c1","name":"apply_patch","input":"*** Begin Patch\n*** Add File: fake\n+hello\n*** End Patch"}}),
            json!({"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"c1","output":[{"type":"text","text":"done"},{"type":"image","image_url":"data:image/png;base64,ZmFrZQ=="}]}}),
            json!({"type":"compacted","payload":{"message":"ignored"}}),
        ]);
        let found = items(&path, TranscriptKind::Codex);
        assert!(found
            .iter()
            .any(|item| item.kind == ItemKind::Tool && item.output.as_deref() == Some("done")));
        assert!(found.iter().any(|item| item.kind == ItemKind::FileChange));
        assert!(found.iter().any(|item| item.kind == ItemKind::Image));
        assert!(found.iter().any(|item| item.kind == ItemKind::System));
        assert!(!serde_json::to_string(&found).unwrap().contains("NEVER_"));
    }
    #[test]
    fn gemini_json_and_jsonl_share_rich_normalization() {
        let messages = vec![
            json!({"id":"u","type":"user","content":[{"text":"synthetic"},{"inlineData":{"mimeType":"image/png","data":"ZmFrZQ=="}}]}),
            json!({"id":"a","type":"gemini","content":[{"thought":true,"text":"public thought"},{"text":"answer"}],"thoughts":[{"subject":"plan","description":"recorded summary"}],"toolCalls":[{"id":"c","name":"replace","args":{"file_path":"/synthetic/a","old_string":"old","new_string":"new"},"result":[{"text":"updated"}],"status":"success"}]}),
        ];
        let (dir, path) = fixture(&messages);
        let plain = dir.path().join("session-fixture.json");
        fs::write(
            &plain,
            json!({"sessionId":"fake-id","messages":messages}).to_string(),
        )
        .unwrap();
        for path in [path, plain] {
            let found = items(&path, TranscriptKind::Gemini);
            assert!(found.iter().any(
                |item| item.kind == ItemKind::Tool && item.output.as_deref() == Some("updated")
            ));
            for kind in [
                ItemKind::User,
                ItemKind::Assistant,
                ItemKind::Reasoning,
                ItemKind::Image,
                ItemKind::FileChange,
            ] {
                assert!(
                    found.iter().any(|item| item.kind == kind),
                    "missing {kind:?}"
                );
            }
            assert!(!found
                .iter()
                .any(|item| item.kind == ItemKind::Assistant && item.text == "public thought"));
        }
    }
    #[test]
    fn gemini_replays_patch_rewind_set_and_removals() {
        let (_dir, path) = fixture(&[
            json!({"sessionId":"fake-parent","kind":"main"}),
            json!({"id":"u","type":"user","content":"kept"}),
            json!({"id":"a","type":"gemini","content":"old","toolCalls":[{"id":"c","name":"read_file","args":{}}]}),
            json!({"$patch":{"id":"a","content":"patched","toolCalls":[{"id":"c","result":[{"text":"result"}],"status":"success"}]}}),
            json!({"id":"rewound","type":"user","content":"must disappear"}),
            json!({"$rewindTo":"rewound"}),
            json!({"id":"removed","type":"user","content":"also disappears"}),
            json!({"$patch":{"removeIds":["removed"],"orderIds":["u","a"]}}),
        ]);
        let found = items(&path, TranscriptKind::Gemini);
        let encoded = serde_json::to_string(&found).unwrap();
        assert!(encoded.contains("patched"));
        assert!(encoded.contains("result"));
        assert!(!encoded.contains("disappear"));
        let mut original = fs::read_to_string(&path).unwrap();
        original.push('\n');
        original.push_str(&format!(
            "{}\n",
            json!({"$set":{"messages":[{"id":"reset","type":"user","content":"reset only"}]}})
        ));
        fs::write(&path, original).unwrap();
        let found = items(&path, TranscriptKind::Gemini);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].text, "reset only");
    }
    #[test]
    fn pages_walk_back_to_beginning_with_stable_ids_and_reject_stale_cursor() {
        let rows = (0..725)
            .map(|index| claude(&format!("message {index}")))
            .collect::<Vec<_>>();
        let (_dir, path) = fixture(&rows);
        let mut cursor = None;
        let mut seen = std::collections::BTreeSet::new();
        let mut pages = 0;
        loop {
            let (page, _) = page(&path, TranscriptKind::Claude, cursor.as_ref(), None).unwrap();
            pages += 1;
            let bytes = page
                .turns
                .iter()
                .flat_map(|turn| &turn.items)
                .map(|item| {
                    assert!(seen.insert(item.id.clone()));
                    serde_json::to_vec(item).unwrap().len()
                })
                .sum::<usize>();
            assert!(bytes <= PAGE_BYTES);
            cursor = page.previous_cursor;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(seen.len(), 725);
        assert_eq!(pages, 3);
        let cursor = page(&path, TranscriptKind::Claude, None, None)
            .unwrap()
            .0
            .previous_cursor
            .unwrap();
        fs::write(&path, "changed").unwrap();
        assert!(page(&path, TranscriptKind::Claude, Some(&cursor), None).is_err());
    }
    #[test]
    fn malformed_and_huge_rows_warn_and_keep_bounded_readable_records() {
        let (_dir, path) = fixture(&[claude("before")]);
        let mut bytes = fs::read(&path).unwrap();
        bytes.extend(vec![b'x'; LINE_LIMIT + 1]);
        bytes.extend_from_slice(b"\n");
        bytes.extend(format!("{}\n{{unfinished", claude("after")).as_bytes());
        fs::write(&path, bytes).unwrap();
        let page = page(&path, TranscriptKind::Claude, None, None).unwrap().0;
        assert!(page.truncated);
        assert!(!page.warnings.is_empty());
        assert_eq!(page.turns.iter().flat_map(|turn| &turn.items).count(), 2);
    }
    #[test]
    fn zstd_is_streamed_and_corruption_rejected() {
        let (dir, path) = fixture(&[
            json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"compressed synthetic"}]}}),
        ]);
        let compressed = dir.path().join("rollout-fixture.jsonl.zst");
        let encoded = zstd::stream::encode_all(fs::read(&path).unwrap().as_slice(), 1).unwrap();
        fs::write(&compressed, &encoded).unwrap();
        assert_eq!(
            items(&compressed, TranscriptKind::Codex)[0].text,
            "compressed synthetic"
        );
        fs::write(&compressed, &encoded[..encoded.len() / 2]).unwrap();
        assert!(page(&compressed, TranscriptKind::Codex, None, None).is_err());
    }
    #[test]
    fn subagents_stay_separate_and_cannot_follow_external_symlinks() {
        let (dir, path) = fixture(&[claude("parent")]);
        let children = path.with_extension("").join("subagents");
        fs::create_dir_all(&children).unwrap();
        fs::write(
            children.join("agent-child.jsonl"),
            format!(
                "{}\n",
                json!({"type":"assistant","isSidechain":true,"message":{"content":"child only"}})
            ),
        )
        .unwrap();
        let found = items(&path, TranscriptKind::Claude);
        assert!(found.iter().any(|item| item.kind == ItemKind::Subagent));
        assert!(!found.iter().any(|item| item.text == "child only"));
        assert_eq!(
            items(&children.join("agent-child.jsonl"), TranscriptKind::Claude)[0].text,
            "child only"
        );
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                dir.path().join("outside.jsonl"),
                children.join("agent-escape.jsonl"),
            )
            .unwrap();
            assert_eq!(child_agents(&path), vec!["child"]);
        }
    }
    #[test]
    fn gemini_subagents_require_exact_parent_directory_and_metadata() {
        let (dir, path) = fixture(&[
            json!({"sessionId":"fake-parent","kind":"main"}),
            json!({"id":"u","type":"user","content":"parent"}),
        ]);
        let sub = dir.path().join("fake-parent");
        fs::create_dir(&sub).unwrap();
        fs::write(
            sub.join("child.jsonl"),
            "{\"sessionId\":\"child\",\"kind\":\"subagent\"}\n",
        )
        .unwrap();
        fs::write(
            sub.join("wrong.jsonl"),
            "{\"sessionId\":\"other\",\"kind\":\"subagent\"}\n",
        )
        .unwrap();
        assert_eq!(children(&path, TranscriptKind::Gemini), vec!["child"]);
    }
    #[test]
    fn persisted_outputs_are_scoped_bounded_and_masked() {
        let (dir, path) = fixture(&[claude("parent")]);
        let root = path.with_extension("").join("tool-results");
        fs::create_dir_all(&root).unwrap();
        let output = root.join("tool-1.txt");
        fs::write(&output, "password=FAKE_PASSWORD").unwrap();
        let marker = format!(
            "<persisted-output>\nFull output saved to: {}\n</persisted-output>",
            output.display()
        );
        let expanded = expand_result(&path, "tool-1", &marker);
        assert!(expanded.contains("[REDACTED]"));
        assert!(!expanded.contains("FAKE_PASSWORD"));
        let outside = dir.path().join("credentials.json");
        fs::write(&outside, "DO_NOT_READ").unwrap();
        let marker = format!(
            "<persisted-output>\nFull output saved to: {}",
            outside.display()
        );
        assert_eq!(expand_result(&path, "tool-1", &marker), marker);
    }
    #[test]
    fn structured_items_are_masked_before_leaving_rust() {
        let secret = "sk-ant-FAKE_SYNTHETIC_12345678901234567890";
        let (_dir, path) = fixture(&[
            claude(&format!("password=FAKE_PASSWORD {secret}")),
            json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"c","name":"shell","input":{"api_key":"FAKE_KEY","cmd":"Authorization: Bearer FAKE_BEARER"}}]}}),
        ]);
        let encoded = serde_json::to_string(&items(&path, TranscriptKind::Claude)).unwrap();
        for raw in [secret, "FAKE_PASSWORD", "FAKE_KEY", "FAKE_BEARER"] {
            assert!(!encoded.contains(raw), "leaked {raw}");
        }
        assert!(encoded.contains("REDACTED"));
    }
    #[test]
    fn compressed_scan_limit_and_jsonl_mutation_damage_fail_closed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout-fixture.jsonl.zst");
        let data = (0..100)
            .map(|_| format!("{}\n", claude("synthetic")))
            .collect::<String>();
        fs::write(&path, zstd::stream::encode_all(data.as_bytes(), 1).unwrap()).unwrap();
        assert!(stream_mode_limit(&path, false, 128, |_, _| {}).is_err());
        let path = dir.path().join("session-fixture.jsonl");
        fs::write(
            &path,
            "{\"id\":\"u\",\"type\":\"user\",\"content\":\"hello\"}\n{\"$patch\":",
        )
        .unwrap();
        assert!(page(&path, TranscriptKind::Gemini, None, None).is_err());
    }
    #[test]
    fn image_endpoint_is_exact_scoped_and_rejects_unrecorded_or_credential_paths() {
        use std::io::Write;
        let account = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let source = account.path().join("sessions/rollout-held.jsonl");
        super::super::tests::write_codex_rollout(
            &source,
            "held",
            work.path(),
            json!("cli"),
            "synthetic",
            1,
        );
        let image = crate::chat_attachments::stage_clipboard_image(
            data.path(),
            "old-id",
            1,
            1,
            &[1, 2, 3, 255],
        )
        .unwrap();
        let pixels = crate::chat_images::preview(
            image.parent().unwrap().to_str().unwrap(),
            Some(image.parent().unwrap()),
            image.to_str().unwrap(),
        )
        .unwrap()
        .unwrap();
        let mut file = fs::OpenOptions::new().append(true).open(&source).unwrap();
        writeln!(file,"\n{}",json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_image","image_url":pixels},{"type":"input_image","image_url":image.to_str().unwrap()}]}})).unwrap();
        let context = super::super::ImageConversation {
            definition_id: "codex".into(),
            native_session_id: "held".into(),
            profile_config_path: Some(account.path().display().to_string()),
        };
        let records = items(&source, TranscriptKind::Codex)
            .into_iter()
            .filter(|item| item.kind == ItemKind::Image)
            .collect::<Vec<_>>();
        assert_eq!(records.len(), 2);
        for record in &records {
            assert!(image_preview(
                &context,
                work.path().to_str().unwrap(),
                data.path(),
                &record.id,
                None
            )
            .unwrap()
            .unwrap()
            .starts_with("data:image/png;base64,"));
        }
        assert!(image_preview(
            &context,
            work.path().to_str().unwrap(),
            data.path(),
            "record-not-referenced",
            None
        )
        .unwrap()
        .is_none());
        fs::remove_file(&image).unwrap();
        assert_eq!(
            image_preview(
                &context,
                work.path().to_str().unwrap(),
                data.path(),
                &records[1].id,
                None
            )
            .unwrap_err(),
            "chat.images.missing"
        );
        let denied = super::super::ImageConversation {
            native_session_id: "other".into(),
            ..context
        };
        assert!(image_preview(
            &denied,
            work.path().to_str().unwrap(),
            data.path(),
            &records[0].id,
            None
        )
        .is_err());
    }
    #[test]
    fn handoff_writes_only_masked_text_and_source_labels() {
        let dir = tempfile::tempdir().unwrap();
        let path = super::super::write_handoff_file(
            dir.path(),
            "password=FAKE_LABEL",
            "user: token=FAKE_TOKEN\nassistant: ordinary",
        )
        .unwrap();
        let content = fs::read_to_string(path).unwrap();
        assert!(!content.contains("FAKE_"));
        assert!(content.contains("ordinary"));
        assert!(content.contains("REDACTED"));
    }
    #[test]
    fn json_escaping_does_not_evict_all_content_or_break_snapshot_accounting() {
        let body = "\u{0001}".repeat(200_000);
        let (_dir, path) = fixture(&[claude(&body)]);
        let result = page(&path, TranscriptKind::Claude, None, None).unwrap().0;
        assert!(result.truncated);
        assert_eq!(result.turns.iter().flat_map(|turn| &turn.items).count(), 1);
        assert!(serde_json::to_vec(&result.turns[0].items[0]).unwrap().len() <= PAGE_BYTES);
        fs::write(
            &path,
            format!(
                "{}\n",
                claude(&format!("password=\"{}\"", "fake value ".repeat(30_000)))
            ),
        )
        .unwrap();
        let legacy = super::super::read_conversation_snapshot_with_tools(
            &path,
            TranscriptKind::Claude,
            false,
        )
        .unwrap();
        assert_eq!(legacy.messages.len(), 1);
        assert!(legacy.messages[0].text.contains("REDACTED"));
    }
    #[test]
    fn signature_only_gemini_and_encoded_tool_images_use_safe_records() {
        let (_dir, path) = fixture(&[
            json!({"id":"a","type":"gemini","content":[{"thoughtSignature":"NEVER_SIGNATURE"},{"fileData":{"mimeType":"image/png","fileUri":"file:///synthetic/fake.png"}}],"toolCalls":[{"id":"c","name":"image","args":{},"result":[{"type":"image","mimeType":"image/png","data":"ZmFrZQ=="}]}]}),
        ]);
        let found = items(&path, TranscriptKind::Gemini);
        assert!(found
            .iter()
            .any(|item| item.kind == ItemKind::Reasoning && item.unreadable));
        assert_eq!(
            found
                .iter()
                .filter(|item| item.kind == ItemKind::Image)
                .count(),
            2
        );
        assert!(!serde_json::to_string(&found)
            .unwrap()
            .contains("NEVER_SIGNATURE"));
    }
}
