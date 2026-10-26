mod drivers;
#[cfg(test)]
mod network_tests;
#[cfg(any(target_os = "ios", test))]
mod sqlite;
#[cfg(test)]
mod tests;

use crate::credentials::{self, CredentialKind};
use crate::domain::{ConnectionProfile, Environment, Protocol};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{Manager, State};
use tokio::sync::Semaphore;
use zeroize::Zeroizing;

const MAX_PROFILES: usize = 200;
const STORE_LIMIT: u64 = 1024 * 1024;
pub(super) const MAX_COLUMNS: usize = 64;
pub(super) const CELL_CHARS: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Engine {
    Postgres,
    Mysql,
    Mariadb,
    SqlServer,
    Sqlite,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatabaseProfile {
    pub id: String,
    pub host_key: String,
    pub name: String,
    pub engine: Engine,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub database: String,
    pub sqlite_path: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub tls_ca_pem: String,
    pub allow_mcp_read: bool,
}

impl DatabaseProfile {
    fn validate(&self) -> Result<(), String> {
        identifier(&self.id, 80)?;
        identifier(&self.host_key, 128)?;
        identifier(&self.name, 100)?;
        validate_ca(&self.tls_ca_pem)?;
        if self.engine == Engine::Sqlite {
            validate_sqlite_path(&self.sqlite_path)?;
            if !self.hostname.is_empty()
                || !self.username.is_empty()
                || !self.database.is_empty()
                || !self.tls_ca_pem.is_empty()
            {
                return Err("SQLite 請只設定本機檔案，不要填入伺服器欄位。".into());
            }
        } else {
            identifier(&self.hostname, 253)?;
            if self
                .hostname
                .chars()
                .any(|character| character.is_whitespace() || "/\\@?#".contains(character))
                || self.port == 0
            {
                return Err("請填入主機名稱與 1–65535 的連接埠，不接受連線網址。".into());
            }
            identifier(&self.username, 128)?;
            identifier(&self.database, 128)?;
            if !self.sqlite_path.is_empty() {
                return Err("伺服器資料庫不能設定 SQLite 路徑。".into());
            }
        }
        Ok(())
    }

    fn credential_profile(&self) -> ConnectionProfile {
        let mut binding = serde_json::to_vec(&(
            self.engine,
            &self.hostname,
            self.port,
            &self.username,
            &self.database,
            &self.sqlite_path,
        ))
        .unwrap_or_default();
        if !self.tls_ca_pem.is_empty() {
            binding.extend_from_slice(self.tls_ca_pem.as_bytes());
        }
        let digest: String = Sha256::digest(binding)
            .iter()
            .take(12)
            .map(|byte| format!("{byte:02x}"))
            .collect();
        ConnectionProfile {
            id: format!("database:{}:{digest}", self.id),
            name: self.name.clone(),
            protocol: Protocol::Ssh,
            hostname: self.hostname.clone(),
            port: self.port,
            username: self.username.clone(),
            environment: Environment::Unassigned,
            group: String::new(),
            tags: vec![],
            favorite: false,
            device_id: None,
            relay_address: None,
            machine_id: None,
        }
    }

    fn credential_context(&self) -> String {
        serde_json::to_string(&(self.engine, &self.database, &self.sqlite_path)).unwrap_or_default()
    }

    fn same_endpoint(&self, other: &Self) -> bool {
        self.engine == other.engine
            && self.hostname == other.hostname
            && self.port == other.port
            && self.username == other.username
            && self.database == other.database
            && self.sqlite_path == other.sqlite_path
            && self.tls_ca_pem == other.tls_ca_pem
    }
}

fn validate_ca(pem: &str) -> Result<(), String> {
    use rustls::pki_types::{pem::PemObject, CertificateDer};
    if pem.is_empty() {
        return Ok(());
    }
    let invalid = || "CA 必須是一張有效的 PEM 憑證（最多 16 KiB），不可包含私鑰。".to_string();
    if pem.len() > 16 * 1024
        || pem.matches("-----BEGIN ").count() != 1
        || !pem.trim_start().starts_with("-----BEGIN CERTIFICATE-----")
        || !pem.trim_end().ends_with("-----END CERTIFICATE-----")
    {
        return Err(invalid());
    }
    let certificate = CertificateDer::from_pem_slice(pem.as_bytes()).map_err(|_| invalid())?;
    rustls::RootCertStore::empty()
        .add(certificate)
        .map_err(|_| invalid())
}

fn identifier(value: &str, max: usize) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > max || value.chars().any(char::is_control) {
        return Err("欄位不可空白、含控制字元或超過長度限制。".into());
    }
    Ok(())
}

fn validate_sqlite_path(raw: &str) -> Result<(), String> {
    identifier(raw, 2048)?;
    let path = Path::new(raw);
    if !path.is_absolute()
        || raw.starts_with("\\\\")
        || raw.starts_with("//")
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("SQLite 必須使用本機絕對路徑，不接受網路路徑或上層跳轉。".into());
    }
    #[cfg(windows)]
    if raw.get(2..).is_some_and(|rest| rest.contains(':')) {
        return Err("SQLite 路徑不可含替代資料流。".into());
    }
    for ancestor in path.ancestors() {
        let metadata =
            std::fs::symlink_metadata(ancestor).map_err(|_| "SQLite 檔案不存在或無法讀取。")?;
        if metadata.file_type().is_symlink() {
            return Err("SQLite 路徑不可經過符號連結。".into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("SQLite 路徑不可經過重新解析點。".into());
            }
        }
    }
    if !path.is_file() {
        return Err("SQLite 必須是既有的一般檔案。".into());
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Store {
    version: u32,
    profiles: Vec<DatabaseProfile>,
    #[serde(default)]
    pending_credentials: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    profiles: Vec<DatabaseProfile>,
    revision: String,
    credential_cleanup_pending: usize,
    #[serde(skip)]
    pending_credentials: Vec<String>,
}

#[derive(Clone)]
pub struct DatabaseRegistry {
    directory: PathBuf,
    lock: Arc<Mutex<()>>,
    calls: Arc<Semaphore>,
}

impl DatabaseRegistry {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            lock: Arc::new(Mutex::new(())),
            calls: Arc::new(Semaphore::new(4)),
        }
    }

    fn path(&self) -> PathBuf {
        self.directory.join("database_profiles.json")
    }

    fn raw(&self) -> Result<Vec<u8>, String> {
        let path = self.path();
        match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            Ok(metadata)
                if metadata.is_file()
                    && !metadata.file_type().is_symlink()
                    && metadata.len() <= STORE_LIMIT => {}
            _ => return Err("資料庫設定檔不是安全的一般檔案，或已超過容量限制。".into()),
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if std::fs::symlink_metadata(&path)
                .map_err(|_| "無法檢查資料庫設定檔。")?
                .file_attributes()
                & 0x400
                != 0
            {
                return Err("資料庫設定檔不可使用重新解析點。".into());
            }
        }
        std::fs::read(path).map_err(|_| "無法讀取資料庫設定檔。".into())
    }

    fn snapshot(&self) -> Result<Snapshot, String> {
        let raw = self.raw()?;
        if raw.is_empty() && self.path().exists() {
            return Err("資料庫設定檔是空檔，請先修復；不會覆蓋原檔。".into());
        }
        let (profiles, pending_credentials) = if raw.is_empty() {
            (vec![], vec![])
        } else {
            let store: Store = serde_json::from_slice(&raw)
                .map_err(|_| "資料庫設定檔無法解析；原檔已保留，請先修復。")?;
            if store.version != 1
                || store.profiles.len() > MAX_PROFILES
                || store.pending_credentials.len() > MAX_PROFILES * 2
            {
                return Err("資料庫設定檔版本或筆數不支援；原檔已保留。".into());
            }
            let mut ids = HashSet::new();
            for profile in &store.profiles {
                identifier(&profile.id, 80)?;
                if !ids.insert(&profile.id) {
                    return Err("資料庫設定有重複的識別碼。".into());
                }
            }
            for id in &store.pending_credentials {
                identifier(id, 128)?;
                if !id.starts_with("database:") {
                    return Err("無效的資料庫憑證清理紀錄。".into());
                }
            }
            (store.profiles, store.pending_credentials)
        };
        Ok(Snapshot {
            profiles,
            credential_cleanup_pending: pending_credentials.len(),
            pending_credentials,
            revision: Sha256::digest(raw)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
        })
    }

    fn write(&self, snapshot: Snapshot, expected: &str) -> Result<Snapshot, String> {
        if self.snapshot()?.revision != expected {
            return Err("資料庫設定已被其他視窗或程式修改，請重新載入後再試。".into());
        }
        let raw = serde_json::to_vec_pretty(&Store {
            version: 1,
            profiles: snapshot.profiles,
            pending_credentials: snapshot.pending_credentials,
        })
        .map_err(|_| "無法編碼資料庫設定。")?;
        crate::durable_file::atomic_write_private(&self.path(), &raw)
            .map_err(|_| "資料庫設定儲存未完成，請重新載入確認。")?;
        self.snapshot()
    }

    fn cleanup(&self, mut snapshot: Snapshot) -> Result<Snapshot, String> {
        if snapshot.pending_credentials.is_empty() {
            return Ok(snapshot);
        }
        let active: HashSet<_> = snapshot
            .profiles
            .iter()
            .filter(|profile| profile.engine != Engine::Sqlite)
            .map(|profile| profile.credential_profile().id)
            .collect();
        snapshot.pending_credentials.retain(|id| {
            !active.contains(id)
                && credentials::delete(id, CredentialKind::DatabasePassword).is_err()
        });
        let expected = snapshot.revision.clone();
        self.write(snapshot, &expected)
    }

    fn edit(
        &self,
        expected: &str,
        profile: Option<DatabaseProfile>,
        deleted: Option<&str>,
        password: Option<Zeroizing<String>>,
    ) -> Result<Snapshot, String> {
        let _guard = self.lock.lock().map_err(|_| "資料庫設定忙碌中。")?;
        std::fs::create_dir_all(&self.directory).map_err(|_| "無法建立設定目錄。")?;
        let lock_path = self.directory.join("database_profiles.lock");
        if std::fs::symlink_metadata(&lock_path)
            .is_ok_and(|metadata| !metadata.is_file() || metadata.file_type().is_symlink())
        {
            return Err("資料庫鎖定檔不是一般檔案。".into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if std::fs::symlink_metadata(&lock_path)
                .is_ok_and(|metadata| metadata.file_attributes() & 0x400 != 0)
            {
                return Err("資料庫鎖定檔不可使用重新解析點。".into());
            }
        }
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)
            .map_err(|_| "無法鎖定資料庫設定。")?;
        let _file_lock = crate::durable_file::FileLockGuard::acquire(lock)
            .map_err(|_| "其他程式正在修改資料庫設定，請稍後重試。")?;
        let mut snapshot = self.snapshot()?;
        if snapshot.revision != expected {
            return Err("資料庫設定已變更，請重新載入後再試。".into());
        }
        if let Some(profile) = profile {
            profile.validate()?;
            let existing = snapshot
                .profiles
                .iter()
                .position(|entry| entry.id == profile.id);
            if existing.is_none() && snapshot.profiles.len() >= MAX_PROFILES {
                return Err("最多可儲存 200 筆資料庫連線。".into());
            }
            let endpoint_changed =
                existing.is_some_and(|index| !snapshot.profiles[index].same_endpoint(&profile));
            if endpoint_changed {
                let old = &snapshot.profiles[existing.unwrap()];
                if old.engine != Engine::Sqlite {
                    snapshot
                        .pending_credentials
                        .push(old.credential_profile().id);
                }
            }
            if profile.engine != Engine::Sqlite {
                let credential_profile = profile.credential_profile();
                let context = profile.credential_context();
                if let Some(password) = password.as_ref().filter(|password| !password.is_empty()) {
                    credentials::store_bound_with_context(
                        &credential_profile,
                        CredentialKind::DatabasePassword,
                        &context,
                        password,
                    )
                    .map_err(|_| "無法儲存密碼，請確認憑證庫已解鎖。")?;
                } else if endpoint_changed || existing.is_none() {
                    return Err("新增或變更端點後，請重新填入資料庫密碼。".into());
                }
            } else if password.as_ref().is_some_and(|value| !value.is_empty()) {
                return Err("SQLite 不接受伺服器密碼。".into());
            }
            if let Some(index) = existing {
                snapshot.profiles[index] = profile;
            } else {
                snapshot.profiles.push(profile);
            }
        }
        if let Some(id) = deleted {
            let profile = snapshot
                .profiles
                .iter()
                .find(|entry| entry.id == id)
                .ok_or("資料庫連線已不存在。")?;
            if profile.engine != Engine::Sqlite {
                snapshot
                    .pending_credentials
                    .push(profile.credential_profile().id);
            }
            snapshot.profiles.retain(|entry| entry.id != id);
        }
        snapshot.pending_credentials.sort();
        snapshot.pending_credentials.dedup();
        if snapshot.pending_credentials.len() > MAX_PROFILES * 2 {
            return Err("請先完成舊密碼清理，再修改連線。".into());
        }
        let snapshot = self.write(snapshot, expected)?;
        self.cleanup(snapshot)
    }

    pub async fn execute(&self, action: DatabaseAction, mcp: bool) -> Result<Value, String> {
        let _permit = self
            .calls
            .clone()
            .try_acquire_owned()
            .map_err(|_| "資料庫查詢忙碌中，請稍後重試。")?;
        let registry = self.clone();
        let snapshot = crate::credential_call(move || registry.snapshot()).await?;
        if matches!(action, DatabaseAction::List {}) {
            let profiles: Vec<_> = snapshot.profiles.into_iter().filter(|profile| !mcp || profile.allow_mcp_read).map(|profile| json!({
                "id":profile.id, "hostKey":profile.host_key, "name":profile.name, "engine":profile.engine,
                "hostname":profile.hostname, "port":profile.port, "database":profile.database,
                "readOnly":true
            })).collect();
            return Ok(json!({"profiles":profiles}));
        }
        action.validate()?;
        let id = action.profile_id().ok_or("缺少資料庫連線識別碼。")?;
        let profile = snapshot
            .profiles
            .iter()
            .find(|entry| entry.id == id && (!mcp || entry.allow_mcp_read))
            .cloned()
            .ok_or("資料庫不存在，或未開啟 MCP 唯讀存取。")?;
        let credential_profile = profile.clone();
        let password = crate::credential_call(move || {
            credential_profile.validate()?;
            if credential_profile.engine == Engine::Sqlite {
                return Ok(Zeroizing::new(String::new()));
            }
            credentials::load_bound_with_context(
                &credential_profile.credential_profile(),
                CredentialKind::DatabasePassword,
                &credential_profile.credential_context(),
            )
            .map(Zeroizing::new)
            .map_err(|_| {
                "無法讀取資料庫密碼，請確認憑證庫已解鎖；變更端點後須重新儲存密碼。".into()
            })
        })
        .await?;
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            drivers::read(&profile, &password, &action),
        )
        .await
        .map_err(|_| "資料庫連線或查詢超過 20 秒，已中止。")??;
        let registry = self.clone();
        let current = crate::credential_call(move || registry.snapshot()).await?;
        if current.revision != snapshot.revision {
            return Err("查詢期間連線或授權已變更，結果不予回傳，請重新查詢。".into());
        }
        Ok(result)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DatabaseAction {
    List {},
    Version {
        profile_id: String,
    },
    Tables {
        profile_id: String,
    },
    Columns {
        profile_id: String,
        schema: String,
        table: String,
    },
    Rows {
        profile_id: String,
        schema: String,
        table: String,
        limit: u32,
        offset: u32,
    },
}

impl DatabaseAction {
    fn profile_id(&self) -> Option<&str> {
        match self {
            Self::List {} => None,
            Self::Version { profile_id }
            | Self::Tables { profile_id }
            | Self::Columns { profile_id, .. }
            | Self::Rows { profile_id, .. } => Some(profile_id),
        }
    }
    fn validate(&self) -> Result<(), String> {
        if let Some(id) = self.profile_id() {
            identifier(id, 80)?;
        }
        if let Self::Columns { schema, table, .. } | Self::Rows { schema, table, .. } = self {
            identifier(schema, 256)?;
            identifier(table, 256)?;
        }
        if let Self::Rows { limit, offset, .. } = self {
            if *limit == 0 || *limit > 100 || *offset > 100_000 {
                return Err("每次限讀 1–100 筆，位移最多 100000。".into());
            }
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn database_profiles(registry: State<'_, DatabaseRegistry>) -> Result<Snapshot, String> {
    let registry = registry.inner().clone();
    crate::credential_call(move || registry.snapshot()).await
}

#[tauri::command]
pub async fn database_save(
    registry: State<'_, DatabaseRegistry>,
    profile: DatabaseProfile,
    revision: String,
    password: Option<String>,
) -> Result<Snapshot, String> {
    if password.as_ref().is_some_and(|value| value.len() > 4096) {
        return Err("密碼超過長度限制。".into());
    }
    let registry = registry.inner().clone();
    let password = password.map(Zeroizing::new);
    crate::credential_call(move || registry.edit(&revision, Some(profile), None, password)).await
}

#[tauri::command]
pub async fn database_delete(
    registry: State<'_, DatabaseRegistry>,
    profile_id: String,
    revision: String,
) -> Result<Snapshot, String> {
    identifier(&profile_id, 80)?;
    let registry = registry.inner().clone();
    crate::credential_call(move || registry.edit(&revision, None, Some(&profile_id), None)).await
}

#[tauri::command]
pub async fn database_cleanup(
    registry: State<'_, DatabaseRegistry>,
    revision: String,
) -> Result<Snapshot, String> {
    let registry = registry.inner().clone();
    crate::credential_call(move || registry.edit(&revision, None, None, None)).await
}

#[tauri::command]
pub async fn database_read(
    registry: State<'_, DatabaseRegistry>,
    action: DatabaseAction,
) -> Result<Value, String> {
    registry.execute(action, false).await
}

pub fn from_desktop(
    app: tauri::AppHandle,
    action: DatabaseAction,
) -> crate::mcp_desktop::CredentialReadFuture {
    Box::pin(async move {
        app.state::<DatabaseRegistry>()
            .execute(action, true)
            .await
            .map_err(|message| crate::mcp_desktop::ServiceError {
                code: "database_unavailable".into(),
                message,
            })
    })
}

pub fn action_schema() -> Value {
    let id = json!({"type":"string","minLength":1,"maxLength":80});
    let name = json!({"type":"string","minLength":1,"maxLength":256});
    let variants: Vec<_> = ["list", "version", "tables", "columns", "rows"].into_iter().map(|kind| {
        let mut properties = json!({"kind":{"const":kind}});
        let mut required = vec!["kind"];
        if kind != "list" { properties["profileId"] = id.clone(); required.push("profileId"); }
        if kind == "columns" || kind == "rows" {
            properties["schema"] = name.clone(); properties["table"] = name.clone();
            required.extend(["schema", "table"]);
        }
        if kind == "rows" {
            properties["limit"] = json!({"type":"integer","minimum":1,"maximum":100});
            properties["offset"] = json!({"type":"integer","minimum":0,"maximum":100000});
            required.extend(["limit", "offset"]);
        }
        json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
    }).collect();
    json!({"oneOf":variants})
}
