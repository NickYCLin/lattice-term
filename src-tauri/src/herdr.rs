use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{process::Stdio, time::Duration};
use tokio::io::AsyncReadExt;

const OUTPUT_LIMIT: u64 = 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct HerdrAgent {
    pub pane_id: String,
    pub terminal_id: String,
    pub agent: Option<String>,
    pub name: Option<String>,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub agent_status: String,
    #[serde(default)]
    pub interactive_ready: bool,
}

#[derive(Serialize)]
pub struct HerdrSnapshot {
    agent: HerdrAgent,
    text: String,
}

async fn bounded_read(reader: impl tokio::io::AsyncRead + Unpin) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader
        .take(OUTPUT_LIMIT + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| "無法讀取 Herdr 回應".to_string())?;
    if bytes.len() as u64 > OUTPUT_LIMIT {
        return Err("Herdr 回應過大，請縮小讀取範圍".into());
    }
    Ok(bytes)
}

async fn run(session: &str, args: &[&str]) -> Result<String, String> {
    if session.is_empty()
        || session.len() > 80
        || !session
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
    {
        return Err("Herdr 工作階段名稱只能包含英數字、底線與連字號".into());
    }
    let executable =
        crate::agent::find_executable(if cfg!(windows) { "herdr.exe" } else { "herdr" })
            .ok_or_else(|| {
                "找不到 Herdr，請先安裝並啟動 Herdr，再重新開啟 LatticeTerm".to_string()
            })?;
    let mut command = tokio::process::Command::new(executable);
    command
        .args(["--session", session])
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|_| "無法啟動 Herdr 連線指令".to_string())?;
    let stdout = child.stdout.take().ok_or("無法讀取 Herdr 輸出")?;
    let stderr = child.stderr.take().ok_or("無法讀取 Herdr 錯誤")?;
    let result = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::try_join!(bounded_read(stdout), bounded_read(stderr), async {
            child
                .wait()
                .await
                .map_err(|_| "無法取得 Herdr 指令狀態".to_string())
        })
    })
    .await
    .map_err(|_| "Herdr 回應逾時；若剛才正在送出，請先查看 Herdr，勿直接重送".to_string())??;
    if !result.2.success() {
        return Err("Herdr 拒絕操作或無法連線，請確認工作階段仍在執行；若正在送出，請先查看 Herdr 再決定是否重送".into());
    }
    String::from_utf8(result.0).map_err(|_| "Herdr 回應不是有效的 UTF-8".into())
}

fn result(text: &str) -> Result<Value, String> {
    let envelope: Value = serde_json::from_str(text)
        .map_err(|_| "無法解析 Herdr 回應，請確認版本支援 agent 指令".to_string())?;
    if envelope.get("error").is_some() {
        return Err("Herdr 拒絕操作，請在 Herdr 檢查狀態".into());
    }
    envelope
        .get("result")
        .cloned()
        .ok_or_else(|| "Herdr 回應缺少結果".into())
}

fn validate_target(target: &str, terminal_id: &str) -> Result<(), String> {
    if target.is_empty()
        || target.len() > 160
        || target.starts_with('-')
        || !target
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b":_-".contains(&byte))
        || terminal_id.is_empty()
        || terminal_id.len() > 160
    {
        return Err("無效的 Herdr 對話識別碼，請重新整理清單".into());
    }
    Ok(())
}

fn check_identity(agent: &HerdrAgent, target: &str, terminal_id: &str) -> Result<(), String> {
    if agent.pane_id != target || agent.terminal_id != terminal_id {
        return Err("Herdr 終端已更換，請重新選取，未送出訊息".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn herdr_agents(session: String) -> Result<Vec<HerdrAgent>, String> {
    let response = result(&run(&session, &["agent", "list"]).await?)?;
    serde_json::from_value(
        response
            .get("agents")
            .cloned()
            .ok_or("Herdr 回應缺少 agent 清單")?,
    )
    .map_err(|_| "Herdr agent 清單格式不符".into())
}

#[tauri::command]
pub async fn herdr_read(
    session: String,
    target: String,
    terminal_id: String,
) -> Result<HerdrSnapshot, String> {
    validate_target(&target, &terminal_id)?;
    let agent = get_agent(&session, &target).await?;
    check_identity(&agent, &target, &terminal_id)?;
    let text = run(
        &session,
        &[
            "agent", "read", &target, "--source", "recent", "--lines", "500", "--format", "text",
        ],
    )
    .await?;
    check_identity(&get_agent(&session, &target).await?, &target, &terminal_id)?;
    Ok(HerdrSnapshot { agent, text })
}

async fn get_agent(session: &str, target: &str) -> Result<HerdrAgent, String> {
    let response = result(&run(session, &["agent", "get", target]).await?)?;
    serde_json::from_value(
        response
            .get("agent")
            .cloned()
            .ok_or("Herdr 回應缺少 agent")?,
    )
    .map_err(|_| "Herdr agent 格式不符".into())
}

fn check_prompt(agent: &HerdrAgent, text: &str) -> Result<(), String> {
    if !matches!(agent.agent_status.as_str(), "idle" | "done") || !agent.interactive_ready {
        return Err("Herdr 對話尚未就緒或需要人工操作，請先回 Herdr 處理".into());
    }
    if text.trim().is_empty() || text.len() > 16_000 || text.chars().any(char::is_control) {
        return Err("請輸入 16000 位元組內的單行訊息，勿包含控制字元".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn herdr_prompt(
    session: String,
    target: String,
    terminal_id: String,
    text: String,
) -> Result<(), String> {
    validate_target(&target, &terminal_id)?;
    let agent = get_agent(&session, &target).await?;
    check_identity(&agent, &target, &terminal_id)?;
    check_prompt(&agent, &text)?;
    result(&run(&session, &["agent", "prompt", &target, &text]).await?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent() -> HerdrAgent {
        serde_json::from_value(serde_json::json!({"pane_id":"w1:p2", "terminal_id":"term-1", "agent":"codex", "agent_status":"idle", "interactive_ready":true})).unwrap()
    }

    #[test]
    fn rejects_invalid_responses_and_targets() {
        assert!(result("{}").is_err());
        assert!(result(r#"{"error":{"code":"busy"},"result":{}}"#).is_err());
        for target in ["", "--help", "w1:p2 & calc", "w1:p2\n"] {
            assert!(validate_target(target, "term-1").is_err());
        }
        assert!(validate_target("w1:p2", "term-1").is_ok());
    }

    #[test]
    fn guards_terminal_identity_and_ready_state() {
        let mut current = agent();
        assert!(check_identity(&current, "w1:p2", "term-2").is_err());
        assert!(check_identity(&current, "w1:p3", "term-1").is_err());
        assert!(check_prompt(&current, "請繼續 & 保留原始檔").is_ok());
        for status in ["working", "blocked", "unknown"] {
            current.agent_status = status.into();
            assert!(check_prompt(&current, "繼續").is_err());
        }
        current.agent_status = "done".into();
        current.interactive_ready = false;
        assert!(check_prompt(&current, "繼續").is_err());
    }

    #[test]
    fn rejects_control_input_and_oversized_prompts() {
        for text in [
            "",
            " ",
            "a\nb",
            "a\rb",
            "a\u{1b}b",
            "a\tb",
            &"x".repeat(16_001),
        ] {
            assert!(check_prompt(&agent(), text).is_err());
        }
    }

    #[tokio::test]
    async fn bounds_output() {
        assert_eq!(bounded_read(&b"test"[..]).await.unwrap(), b"test");
        assert!(bounded_read(&vec![b'x'; OUTPUT_LIMIT as usize + 1][..])
            .await
            .is_err());
    }
}
