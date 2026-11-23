//! Route the Windows computer tools exclusively into the app's Windows Sandbox.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    io::ErrorKind,
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::process::Command;

const OFF: &str = "sandbox-computer.disabled";
const CONFIG: &str = "<Configuration><ClipboardRedirection>Disable</ClipboardRedirection><AudioInput>Disable</AudioInput><VideoInput>Disable</VideoInput></Configuration>";

fn root() -> Result<&'static Path, String> {
    super::DATA_ROOT
        .get()
        .map(PathBuf::as_path)
        .ok_or("尚未允許電腦控制：沙箱設定尚未載入。".into())
}

fn preference(dir: &Path) -> Result<bool, String> {
    match std::fs::symlink_metadata(dir.join(OFF)) {
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(true),
        Ok(meta)
            if meta.is_file()
                && meta.len() == 0
                && std::os::windows::fs::MetadataExt::file_attributes(&meta) & 0x400 == 0 =>
        {
            Ok(false)
        }
        Ok(_) => Err("沙箱設定檔格式不符。".into()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn allowed() -> Result<bool, String> {
    preference(root()?)
}

#[tauri::command]
pub(crate) async fn chat_sandbox_preference(enabled: Option<bool>) -> Result<bool, String> {
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _lock = LOCK.lock().await;
    let dir = root()?;
    let current = preference(dir)?;
    if let Some(next) = enabled.filter(|value| *value != current) {
        if next {
            crate::durable_file::durable_remove_private(&dir.join(OFF))?;
        } else {
            std::fs::File::create_new(dir.join(OFF))
                .and_then(|file| file.sync_all())
                .map_err(|e| e.to_string())?;
        }
        super::computer::invalidate_sandbox();
    }
    preference(dir)
}

// Stable across restarts, but never adopt another application's active Sandbox.
fn sandbox_id(dir: &Path) -> String {
    let digest: String = Sha256::digest(dir.as_os_str().as_encoded_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!(
        "{}-{}-4{}-a{}-{}",
        &digest[..8],
        &digest[8..12],
        &digest[13..16],
        &digest[17..20],
        &digest[20..32]
    )
}

fn command(exe: &Path) -> Command {
    let mut command = Command::new(exe);
    command
        .creation_flags(0x08000000)
        .kill_on_drop(true)
        .stdin(Stdio::null());
    command
}

async fn json_output(mut cmd: Command) -> Result<Value, String> {
    let output = cmd.output().await.map_err(|e| e.to_string())?;
    if !output.status.success() {
        let detail = if output.stderr.is_empty() {
            &output.stdout
        } else {
            &output.stderr
        };
        return Err(format!(
            "Windows Sandbox: {}",
            String::from_utf8_lossy(detail)
                .chars()
                .take(1500)
                .collect::<String>()
        ));
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("無法讀取 Windows Sandbox 回應：{e}"))
}

pub async fn agent_command(capture: bool) -> Result<Command, String> {
    let local = dirs::data_local_dir().ok_or("找不到本機應用程式目錄。")?;
    let aliases = local.join("Microsoft/WindowsApps");
    let winapp = [
        aliases.join("winapp.exe"),
        local.join("LatticeTermTools/WinAppCLI/0.8.0/winapp.exe"),
    ]
    .into_iter()
    .find(|p| p.is_file())
    .ok_or("請安裝 Microsoft WinApp CLI 0.8 或更新版本，再使用 Windows Sandbox 電腦控制。")?;
    let wsb = aliases.join("wsb.exe");
    if !wsb.is_file() {
        return Err("請先啟用 Windows Sandbox 並安裝其命令列工具 wsb。".into());
    }
    let id = sandbox_id(root()?);
    let mut list = command(&wsb);
    list.args(["list", "--raw"]);
    let list = json_output(list).await?;
    let sessions = list["WindowsSandboxEnvironments"]
        .as_array()
        .ok_or("無法辨識沙箱清單。")?;
    if sessions.is_empty() {
        if !capture {
            return Err("原本的沙箱已關閉，請重新擷取畫面。".into());
        }
        let mut start = command(&wsb);
        start.args(["start", "--id", &id, "--config", CONFIG, "--raw"]);
        json_output(start).await?;
    } else if sessions.len() != 1
        || !sessions[0]["Id"]
            .as_str()
            .is_some_and(|s| s.eq_ignore_ascii_case(&id))
    {
        return Err("另一個 Windows Sandbox 正在運作。請保存其中的工作並關閉後再試。".into());
    }
    let scoped = || {
        let mut cmd = command(&winapp);
        cmd.env("WINAPP_CLI_TELEMETRY_OPTOUT", "1");
        cmd
    };
    let mut push = scoped();
    push.args(["target", "push", "sandbox"])
        .arg(crate::remote_host::agent_path()?)
        .args([
            "lattice/lattice-agent.exe",
            "--expect-sandbox",
            &id,
            "--json",
        ]);
    let pushed = json_output(push).await?;
    let guest = pushed["targetPath"]
        .as_str()
        .ok_or("找不到沙箱內的電腦工具。")?;
    let mut exec = scoped();
    exec.args([
        "target",
        "exec",
        "sandbox",
        "--expect-sandbox",
        &id,
        "--",
        guest,
        "--computer-stdio",
    ]);
    Ok(exec)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Run by itself with a built lattice-agent and an available Windows Sandbox.
    #[tokio::test]
    #[ignore = "starts and stops a dedicated Windows Sandbox"]
    async fn live_capture_and_global_disable() {
        let dir = tempfile::tempdir().unwrap();
        super::super::set_data_root(dir.path().to_owned());
        let id = sandbox_id(dir.path());
        let frame =
            super::super::computer::action("sandbox-qa", "capture", serde_json::json!({})).await;
        // Only this test's random temp directory can produce this sandbox ID.
        let stop = command(
            &dirs::data_local_dir()
                .unwrap()
                .join("Microsoft/WindowsApps/wsb.exe"),
        )
        .args(["stop", "--id", &id])
        .output()
        .await
        .unwrap();
        let frame = frame.unwrap();
        assert!(stop.status.success());
        assert!(frame["width"].as_u64().unwrap() > 0 && frame["height"].as_u64().unwrap() > 0);
        assert!(!frame["image"].as_str().unwrap().is_empty());
        assert!(!chat_sandbox_preference(Some(false)).await.unwrap());
        assert!(
            super::super::computer::action("different-chat", "capture", serde_json::json!({}))
                .await
                .unwrap_err()
                .contains("共用設定已關閉")
        );
        assert!(chat_sandbox_preference(Some(true)).await.unwrap());
    }
    #[test]
    fn missing_preference_defaults_on_and_conflicting_files_are_preserved() {
        let dir = tempfile::tempdir().unwrap();
        assert!(preference(dir.path()).unwrap());
        let path = dir.path().join(OFF);
        std::fs::File::create_new(&path).unwrap();
        assert!(!preference(dir.path()).unwrap());
        std::fs::write(&path, b"keep").unwrap();
        assert!(preference(dir.path()).is_err());
        assert_eq!(std::fs::read(path).unwrap(), b"keep");
    }
}
