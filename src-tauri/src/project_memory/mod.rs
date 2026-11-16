//! User-confirmed, vendor-neutral memory. Native CLI memories are import-only.
mod imports;
mod render;
mod storage;
#[cfg(test)]
mod tests;
use crate::transcript::redact;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};
use storage::{digest, Change};
pub const MAX_OUTPUT: usize = 16 * 1024;
pub const MAX_ENTRY: usize = 8192;
const PROJECT_STORE: &str = ".lattice/memory/entries.json";
const USER_STORE: &str = "project-memory/user/entries.json";
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    Project,
    User,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    User,
    Feedback,
    Project,
    Reference,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Location {
    Project,
    App,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    pub kind: String,
    pub cli: Option<String>,
    pub conversation_id: Option<String>,
    pub path: Option<String>,
}
impl Source {
    pub fn manual() -> Self {
        Self {
            kind: "manual".into(),
            cli: None,
            conversation_id: None,
            path: None,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub id: String,
    pub kind: Kind,
    pub content: String,
    pub source: Source,
    pub created_at: u64,
    pub updated_at: u64,
    pub last_used_at: u64,
    pub pinned: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Store {
    version: u32,
    entries: Vec<Entry>,
}
impl Default for Store {
    fn default() -> Self {
        Self {
            version: 1,
            entries: Vec::new(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    version: u32,
    storage: Location,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            version: 1,
            storage: Location::Project,
        }
    }
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewEntry {
    #[serde(flatten)]
    pub entry: Entry,
    pub scope: Scope,
    pub blocked: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub cli: String,
    pub file_name: String,
    pub state: String,
    pub reason: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub project_directory: Option<String>,
    pub storage: Location,
    pub revision: String,
    pub entries: Vec<ViewEntry>,
    pub output_bytes: usize,
    pub max_output_bytes: usize,
    pub files: Vec<SyncStatus>,
    pub warnings: Vec<String>,
    pub ignore_revision: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Draft {
    pub id: Option<String>,
    pub scope: Scope,
    pub kind: Kind,
    pub content: String,
    pub source: Source,
    pub pinned: bool,
}
#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Action {
    Upsert {
        draft: Draft,
    },
    Delete {
        id: String,
        scope: Scope,
    },
    Storage {
        location: Location,
    },
    Sync,
    Ignore {
        confirmed: bool,
    },
    Import {
        ids: Vec<String>,
        scope: Scope,
        definition_id: String,
        config_directory: Option<String>,
        preview_revision: String,
    },
}
struct Context {
    data: PathBuf,
    project: Option<PathBuf>,
    prefix: PathBuf,
}
type InstructionSnapshot = (String, Result<Option<Vec<u8>>, String>);
struct State {
    settings: Settings,
    user: Store,
    project: Store,
    revision: String,
    user_raw: Option<Vec<u8>>,
    project_raw: Option<Vec<u8>>,
    settings_raw: Option<Vec<u8>>,
    instructions: Vec<InstructionSnapshot>,
    ignore: Result<Option<Vec<u8>>, String>,
}
impl Context {
    fn new(data: &Path, project: Option<&str>) -> Result<Self, String> {
        if !data.is_absolute() {
            return Err("memory.path".into());
        }
        let data = storage::directory(data)?;
        let project = project
            .filter(|path| !path.trim().is_empty())
            .map(|path| storage::directory(Path::new(path)))
            .transpose()?;
        let key = project
            .as_ref()
            .map(|path| digest(path.to_string_lossy().as_bytes()))
            .unwrap_or_else(|| "general".into());
        Ok(Self {
            data,
            project,
            prefix: PathBuf::from("project-memory/projects").join(key),
        })
    }
    fn settings_path(&self) -> PathBuf {
        self.prefix.join("settings.json")
    }
    fn store_path(&self, location: Location) -> Result<(&Path, PathBuf), String> {
        match location {
            Location::App => Ok((&self.data, self.prefix.join("entries.json"))),
            Location::Project => Ok((
                self.project.as_deref().ok_or("memory.projectRequired")?,
                PathBuf::from(PROJECT_STORE),
            )),
        }
    }
    fn read(&self) -> Result<State, String> {
        let settings_raw = storage::read(&self.data, &self.settings_path())?;
        let settings: Settings = decode(settings_raw.as_deref())?;
        if settings.version != 1 {
            return Err("memory.format".into());
        }
        let user_raw = storage::read(&self.data, Path::new(USER_STORE))?;
        let user: Store = decode(user_raw.as_deref())?;
        valid_store(&user)?;
        let (project_raw, project) = if self.project.is_some() {
            let (root, path) = self.store_path(settings.storage)?;
            let raw = storage::read(root, &path)?;
            let store: Store = decode(raw.as_deref())?;
            valid_store(&store)?;
            (raw, store)
        } else {
            (None, Store::default())
        };
        let instructions = if let Some(root) = &self.project {
            [
                "AGENTS.md",
                "CLAUDE.md",
                "GEMINI.md",
                "QWEN.md",
                "AGENTS.override.md",
            ]
            .into_iter()
            .map(|name| (name.into(), storage::read(root, Path::new(name))))
            .collect()
        } else {
            Vec::new()
        };
        let ignore = self
            .project
            .as_ref()
            .map(|root| storage::read(root, Path::new(".gitignore")))
            .unwrap_or(Ok(None));
        let revision = digest(
            &serde_json::to_vec(&(
                &settings_raw,
                &user_raw,
                &project_raw,
                &instructions,
                &ignore,
            ))
            .map_err(|_| "memory.format")?,
        );
        Ok(State {
            settings,
            user,
            project,
            revision,
            user_raw,
            project_raw,
            settings_raw,
            instructions,
            ignore,
        })
    }
    fn view(&self, state: &State) -> Snapshot {
        let mut entries = Vec::new();
        for (scope, store) in [(Scope::User, &state.user), (Scope::Project, &state.project)] {
            for entry in &store.entries {
                let mut entry = entry.clone();
                let blocked = entry_secret(&entry);
                entry.content = redact::text(&entry.content);
                if let Ok(mut source) = serde_json::to_value(&entry.source) {
                    redact::value(&mut source);
                    if let Ok(safe) = serde_json::from_value(source) {
                        entry.source = safe;
                    }
                }
                entries.push(ViewEntry {
                    entry,
                    scope,
                    blocked,
                });
            }
        }
        let (files, output_bytes, warnings) = render::status(state, self.project.is_some());
        let ignore_revision = state
            .ignore
            .as_ref()
            .map(|raw| digest(raw.as_deref().unwrap_or_default()))
            .unwrap_or_else(|_| "unsafe".into());
        Snapshot {
            project_directory: self.project.as_ref().map(|path| path.display().to_string()),
            storage: state.settings.storage,
            revision: state.revision.clone(),
            entries,
            output_bytes,
            max_output_bytes: MAX_OUTPUT,
            files,
            warnings,
            ignore_revision,
        }
    }
}
fn decode<T: serde::de::DeserializeOwned + Default>(raw: Option<&[u8]>) -> Result<T, String> {
    raw.map(|raw| serde_json::from_slice(raw).map_err(|_| "memory.format".into()))
        .unwrap_or_else(|| Ok(T::default()))
}
fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| "memory.format")?;
    if bytes.len() > storage::LIMIT {
        return Err("memory.capacity".into());
    }
    Ok(bytes)
}
fn new_id() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "memory.write")?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |time| time.as_millis().min(u64::MAX as u128) as u64)
}
fn normalized(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}
fn valid_store(store: &Store) -> Result<(), String> {
    if store.version != 1 || store.entries.len() > 256 {
        return Err("memory.format".into());
    }
    let mut ids = BTreeSet::new();
    for entry in &store.entries {
        if entry.id.len() != 32
            || !entry.id.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !ids.insert(&entry.id)
            || entry.content.len() > MAX_ENTRY
            || entry.content.trim().is_empty()
            || entry.content.contains("<!-- LatticeTerm")
            || entry
                .content
                .chars()
                .any(|c| c.is_control() && !matches!(c, '\n' | '\t' | '\r'))
        {
            return Err("memory.format".into());
        }
    }
    Ok(())
}
fn entry_secret(entry: &Entry) -> bool {
    let raw = serde_json::to_string(entry).unwrap_or_default();
    redact::text(&entry.content) != entry.content
        || redact::text(&raw) != raw
        || entry.content.contains("[REDACTED]")
}
fn safe_draft(draft: &Draft) -> Result<(), String> {
    if draft.content.trim().is_empty()
        || draft.content.len() > MAX_ENTRY
        || draft.content.contains("<!-- LatticeTerm")
        || draft
            .content
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\t' | '\r'))
    {
        return Err("memory.content".into());
    }
    if !matches!(
        draft.source.kind.as_str(),
        "manual" | "cli" | "conversation"
    ) || serde_json::to_vec(&draft.source).map_or(true, |raw| raw.len() > 2048)
    {
        return Err("memory.content".into());
    }
    let raw = serde_json::to_string(draft).map_err(|_| "memory.content")?;
    if redact::text(&draft.content) != draft.content
        || redact::text(&raw) != raw
        || draft.content.contains("[REDACTED]")
    {
        return Err("memory.secret".into());
    }
    Ok(())
}
fn insert(store: &mut Store, draft: &Draft) -> Result<(), String> {
    safe_draft(draft)?;
    let duplicate = store.entries.iter().any(|entry| {
        Some(entry.id.as_str()) != draft.id.as_deref()
            && normalized(&entry.content) == normalized(&draft.content)
    });
    if duplicate {
        return Err("memory.duplicate".into());
    }
    let time = now();
    if let Some(id) = &draft.id {
        let entry = store
            .entries
            .iter_mut()
            .find(|entry| entry.id == *id)
            .ok_or("memory.missing")?;
        entry.kind = draft.kind;
        entry.content = draft.content.trim().into();
        entry.source = draft.source.clone();
        entry.updated_at = time;
        entry.pinned = draft.pinned;
    } else {
        if store.entries.len() >= 256 {
            return Err("memory.capacity".into());
        }
        store.entries.push(Entry {
            id: new_id()?,
            kind: draft.kind,
            content: draft.content.trim().into(),
            source: draft.source.clone(),
            created_at: time,
            updated_at: time,
            last_used_at: 0,
            pinned: draft.pinned,
        });
    }
    Ok(())
}
pub fn inspect(data: &Path, project: Option<&str>) -> Result<Snapshot, String> {
    let _lock = storage::lock(data)?;
    let ctx = Context::new(data, project)?;
    Ok(ctx.view(&ctx.read()?))
}
pub fn mutate(
    data: &Path,
    project: Option<&str>,
    expected: &str,
    action: Action,
) -> Result<Snapshot, String> {
    let _lock = storage::lock(data)?;
    let ctx = Context::new(data, project)?;
    let mut state = ctx.read()?;
    if state.revision != expected {
        return Err("memory.conflict".into());
    }
    let mut settings_changed = false;
    let mut user_changed = false;
    let mut project_changed = false;
    match action {
        Action::Upsert { draft } => {
            if draft.scope == Scope::User {
                insert(&mut state.user, &draft)?;
                user_changed = true;
            } else {
                if ctx.project.is_none() {
                    return Err("memory.projectRequired".into());
                }
                insert(&mut state.project, &draft)?;
                project_changed = true;
            }
        }
        Action::Delete { id, scope } => {
            let store = if scope == Scope::User {
                user_changed = true;
                &mut state.user
            } else {
                project_changed = true;
                &mut state.project
            };
            let before = store.entries.len();
            store.entries.retain(|entry| entry.id != id);
            if before == store.entries.len() {
                return Err("memory.missing".into());
            }
        }
        Action::Storage { location } => {
            if ctx.project.is_none() {
                return Err("memory.projectRequired".into());
            }
            if location != state.settings.storage {
                let (root, path) = ctx.store_path(location)?;
                let target = storage::read(root, &path)?;
                let target_store: Store = decode(target.as_deref())?;
                valid_store(&target_store)?;
                if !target_store.entries.is_empty()
                    && encode(&target_store)? != encode(&state.project)?
                {
                    return Err("memory.storageConflict".into());
                }
                state.settings.storage = location;
                state.project_raw = target;
                project_changed = true;
                settings_changed = true;
            }
        }
        Action::Sync => {}
        Action::Ignore { confirmed } => {
            if !confirmed {
                return Err("memory.confirmIgnore".into());
            }
            let root = ctx.project.as_deref().ok_or("memory.projectRequired")?;
            let before = state.ignore.clone()?;
            let old = String::from_utf8(before.clone().unwrap_or_default())
                .map_err(|_| "memory.format")?;
            if !old.lines().any(|line| line.trim() == "/.lattice/memory/") {
                let separator = if old.is_empty() || old.ends_with('\n') {
                    ""
                } else {
                    "\n"
                };
                storage::commit(vec![Change::new(
                    root,
                    ".gitignore",
                    before,
                    format!("{old}{separator}/.lattice/memory/\n").into_bytes(),
                )])?;
            }
            return Ok(ctx.view(&ctx.read()?));
        }
        Action::Import {
            ids,
            scope,
            definition_id,
            config_directory,
            preview_revision,
        } => {
            let preview =
                imports::collect(&ctx, &state, &definition_id, config_directory.as_deref())?;
            if preview.revision != preview_revision {
                return Err("memory.conflict".into());
            }
            let ids = ids.into_iter().collect::<BTreeSet<_>>();
            if ids.is_empty() {
                return Err("memory.selection".into());
            }
            let store = if scope == Scope::User {
                user_changed = true;
                &mut state.user
            } else {
                if ctx.project.is_none() {
                    return Err("memory.projectRequired".into());
                }
                project_changed = true;
                &mut state.project
            };
            for id in &ids {
                let item = preview
                    .candidates
                    .iter()
                    .find(|item| &item.id == id)
                    .ok_or("memory.conflict")?;
                if item.blocked {
                    return Err("memory.secret".into());
                }
                insert(
                    store,
                    &Draft {
                        id: None,
                        scope,
                        kind: item.kind,
                        content: item.content.clone(),
                        source: item.source.clone(),
                        pinned: false,
                    },
                )?;
            }
        }
    }
    let mut changes = Vec::new();
    if user_changed {
        if state.user.entries.iter().any(entry_secret) {
            return Err("memory.secret".into());
        }
        changes.push(Change::new(
            &ctx.data,
            USER_STORE,
            state.user_raw.clone(),
            encode(&state.user)?,
        ));
    }
    if project_changed {
        if state.project.entries.iter().any(entry_secret) {
            return Err("memory.secret".into());
        }
        let (root, path) = ctx.store_path(state.settings.storage)?;
        changes.push(Change::new(
            root,
            path,
            state.project_raw.clone(),
            encode(&state.project)?,
        ));
    }
    if settings_changed {
        changes.push(Change::new(
            &ctx.data,
            ctx.settings_path(),
            state.settings_raw.clone(),
            encode(&state.settings)?,
        ));
    }
    storage::commit(changes)?;
    let current = ctx.read()?;
    let sync_error = render::sync(&ctx, &current).err();
    let mut view = ctx.view(&ctx.read()?);
    if let Some(error) = sync_error {
        view.warnings.push(error);
    }
    Ok(view)
}
pub use imports::{Candidate, ImportPreview};
pub fn preview_import(
    data: &Path,
    project: Option<&str>,
    definition: &str,
    config: Option<&str>,
) -> Result<ImportPreview, String> {
    let _lock = storage::lock(data)?;
    let ctx = Context::new(data, project)?;
    imports::collect(&ctx, &ctx.read()?, definition, config)
}
/// Called only by app-owned launch paths, never by history previews/imports.
pub fn prepare(data: &Path, project: &Path, cli: &str) -> Result<(), String> {
    if ![
        "codex", "claude", "gemini", "qwen", "copilot", "opencode", "kimi", "grok",
    ]
    .contains(&cli)
    {
        return Ok(());
    }
    let _lock = storage::lock(data)?;
    let ctx = Context::new(data, Some(project.to_str().ok_or("memory.path")?))?;
    let mut state = ctx.read()?;
    let active = !state.user.entries.is_empty() || !state.project.entries.is_empty();
    if !active {
        return Ok(());
    }
    render::sync(&ctx, &state)?;
    if cli == "grok" {
        return Ok(());
    }
    if cli == "codex" && render::codex_override(&state) {
        return Err("memory.override".into());
    }
    let time = now();
    for entry in state
        .user
        .entries
        .iter_mut()
        .chain(state.project.entries.iter_mut())
    {
        entry.last_used_at = time;
    }
    let mut changes = Vec::new();
    if !state.user.entries.is_empty() {
        changes.push(Change::new(
            &ctx.data,
            USER_STORE,
            state.user_raw,
            encode(&state.user)?,
        ));
    }
    if !state.project.entries.is_empty() {
        let (root, path) = ctx.store_path(state.settings.storage)?;
        changes.push(Change::new(
            root,
            path,
            state.project_raw,
            encode(&state.project)?,
        ));
    }
    storage::commit(changes)
}

pub(crate) fn launch_error(reason: String) -> String {
    format!("專案記憶尚未同步，請至「指示與記憶」檢查容量或檔案後重試（{reason}）。")
}
