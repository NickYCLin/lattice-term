//! Explicit process-local grants, never global Remote Host configuration.
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        OnceLock,
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Mutex,
};
#[derive(Default)]
struct Grant {
    receipt: Option<(String, Instant)>,
    epoch: u64,
}
static FOREGROUND: AtomicBool = AtomicBool::new(true);
static FOCUS_EPOCH: AtomicU64 = AtomicU64::new(0);
pub fn focus_changed(focused: bool) {
    if focused {
        FOCUS_EPOCH.fetch_add(1, Ordering::SeqCst);
    }
    FOREGROUND.store(focused, Ordering::SeqCst);
}
static GRANTS: OnceLock<Mutex<HashMap<String, Grant>>> = OnceLock::new();
fn registry() -> &'static Mutex<HashMap<String, Grant>> {
    GRANTS.get_or_init(Mutex::default)
}
pub async fn enable(id: &str, enabled: bool) -> Result<(), String> {
    super::checked_id(id)?;
    let mut grants = registry().lock().await;
    if enabled {
        let epoch = FOCUS_EPOCH.load(Ordering::SeqCst);
        grants.retain(|_, grant| grant.epoch == epoch);
        if grants.len() >= 32 && !grants.contains_key(id) {
            return Err("已達電腦工具的對話上限。".into());
        }
        grants.insert(
            id.into(),
            Grant {
                epoch,
                receipt: None,
            },
        );
    } else {
        grants.remove(id);
    }
    Ok(())
}
pub async fn enabled(id: &str) -> bool {
    registry()
        .lock()
        .await
        .get(id)
        .is_some_and(|grant| grant.epoch == FOCUS_EPOCH.load(Ordering::SeqCst))
}

pub async fn shutdown() {
    focus_changed(true);
    // Let a bounded input batch release its keys before the app exits.
    registry().lock().await.clear();
}

#[cfg(windows)]
static SANDBOX_EPOCH: AtomicU64 = AtomicU64::new(0);
#[cfg(windows)]
pub(super) fn invalidate_sandbox() {
    SANDBOX_EPOCH.fetch_add(1, Ordering::SeqCst);
}

pub async fn action(id: &str, kind: &str, mut args: Value) -> Result<Value, String> {
    let mut grants = registry().lock().await;
    #[cfg(windows)]
    let sandbox_epoch = SANDBOX_EPOCH.load(Ordering::SeqCst);
    #[cfg(windows)]
    let grant = {
        if !super::sandbox::allowed()? {
            return Err("共用設定已關閉沙箱電腦控制。".into());
        }
        grants.retain(|_, g| {
            g.epoch == sandbox_epoch
                && g.receipt
                    .as_ref()
                    .is_some_and(|(_, at)| at.elapsed() <= Duration::from_secs(30))
        });
        if grants.len() >= 32 && !grants.contains_key(id) {
            return Err("電腦控制已達同時使用上限。".into());
        }
        grants.entry(id.into()).or_insert_with(|| Grant {
            epoch: sandbox_epoch,
            receipt: None,
        })
    };
    #[cfg(not(windows))]
    let grant = grants.get_mut(id).ok_or("這個對話尚未允許電腦控制。")?;
    #[cfg(not(windows))]
    if FOREGROUND.load(Ordering::SeqCst) || grant.epoch != FOCUS_EPOCH.load(Ordering::SeqCst) {
        return Err("電腦操作已暫停；請從對話頁重新啟用並最小化視窗。".into());
    }

    let receipt_time = if kind != "capture" {
        let (receipt, at) = grant.receipt.as_ref().ok_or("請先擷取畫面。")?;
        if at.elapsed() > Duration::from_secs(30)
            || args["fingerprint"].as_str() != Some(receipt.as_str())
        {
            return Err("畫面收據已過期，請重新擷取。".into());
        }
        args["expected"] = json!(receipt);
        // A receipt authorizes only one input, including attempts that fail.
        let timestamp = *at;
        grant.receipt = None;
        Some(timestamp)
    } else {
        None
    };
    args["kind"] = json!(kind);
    #[cfg(not(windows))]
    let mut command = {
        let mut cmd = tokio::process::Command::new(crate::remote_host::agent_path()?);
        cmd.arg("--computer-stdio");
        cmd
    };
    #[cfg(windows)]
    let mut command = {
        let cmd = tokio::time::timeout(
            Duration::from_secs(300),
            super::sandbox::agent_command(kind == "capture"),
        )
        .await
        .map_err(|_| "沙箱未在五分鐘內就緒，請檢查 Windows Sandbox 狀態後重試。".to_owned())??;
        if sandbox_epoch != SANDBOX_EPOCH.load(Ordering::SeqCst) || !super::sandbox::allowed()? {
            return Err("沙箱權限已變更，操作已取消。".into());
        }
        cmd
    };
    if receipt_time.is_some_and(|at| at.elapsed() > Duration::from_secs(30)) {
        return Err("畫面收據已過期，請重新擷取。".into());
    }
    command
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let value = tokio::time::timeout(
        Duration::from_secs(if cfg!(windows) { 90 } else { 15 }),
        async {
            let mut child = command.spawn().map_err(|e| e.to_string())?;
            let mut stdin = child.stdin.take().ok_or("電腦工具輸入不可用。")?;
            stdin
                .write_all(args.to_string().as_bytes())
                .await
                .map_err(|e| e.to_string())?;
            drop(stdin);
            let mut output = Vec::new();
            child
                .stdout
                .take()
                .ok_or("電腦工具輸出不可用。")?
                .take(4 * 1024 * 1024 + 1)
                .read_to_end(&mut output)
                .await
                .map_err(|e| e.to_string())?;
            let status = child.wait().await.map_err(|e| e.to_string())?;
            if output.len() > 4 * 1024 * 1024 {
                return Err("電腦畫面超過限制。".into());
            }
            let value: Value = serde_json::from_slice(&output)
                .map_err(|_| "無法讀取電腦工具回應；請確認遠端元件與桌面程式版本一致。")?;
            if !status.success() || value.get("error").is_some() {
                return Err(value["error"]
                    .as_str()
                    .unwrap_or("無法使用電腦工具；請檢查螢幕錄製與輔助使用權限。")
                    .chars()
                    .take(1000)
                    .collect::<String>());
            }
            Ok(value)
        },
    )
    .await
    .map_err(|_| "電腦工具逾時，請重新擷取畫面。")??;
    #[cfg(windows)]
    if sandbox_epoch != SANDBOX_EPOCH.load(Ordering::SeqCst) || !super::sandbox::allowed()? {
        return Err("沙箱權限已變更，請重新擷取畫面。".into());
    }
    grant.receipt = Some((
        value["fingerprint"]
            .as_str()
            .ok_or("電腦工具未提供畫面收據。")?
            .into(),
        Instant::now(),
    ));
    Ok(value)
}
