//! Conversation-scoped native tools. MCP stdio proxies to an ephemeral loopback
//! listener with a random capability path. No listener accepts browser Origins.
pub mod browser;
pub mod computer;
pub mod images;
#[cfg(windows)]
pub(crate) mod sandbox;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, OnceLock,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    sync::{Mutex, Semaphore},
};
const ENV: &str = "LATTICETERM_CHAT_TOOLS_URL";
static DATA_ROOT: OnceLock<PathBuf> = OnceLock::new();
pub fn set_data_root(path: PathBuf) {
    let _ = DATA_ROOT.set(path);
}
const MAX_REQUEST: usize = 64 * 1024;
// A cold Windows Sandbox can take several minutes before the guest logs on.
const TOOL_TIMEOUT_SECS: u64 = if cfg!(windows) { 420 } else { 190 };
struct Endpoint {
    url: String,
    directory: PathBuf,
    browser: Arc<AtomicBool>,
    active: Arc<AtomicBool>,
    ready: Arc<AtomicBool>,
    task: tokio::task::AbortHandle,
}
static ENDPOINTS: OnceLock<Mutex<HashMap<String, Endpoint>>> = OnceLock::new();
fn endpoints() -> &'static Mutex<HashMap<String, Endpoint>> {
    ENDPOINTS.get_or_init(Mutex::default)
}
pub(crate) fn checked_id(id: &str) -> Result<(), String> {
    if !id.is_empty()
        && id.len() <= 256
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        Ok(())
    } else {
        Err("對話識別碼無效。".into())
    }
}
pub async fn ensure(id: &str, directory: PathBuf, browser_enabled: bool) -> Result<String, String> {
    checked_id(id)?;
    let mut endpoints = endpoints().lock().await;
    if let Some(endpoint) = endpoints.get(id) {
        if endpoint.directory == directory {
            endpoint.browser.store(browser_enabled, Ordering::SeqCst);
            return Ok(endpoint.url.clone());
        }
    }
    if let Some(old) = endpoints.remove(id) {
        old.active.store(false, Ordering::SeqCst);
        old.task.abort();
    }
    if endpoints.len() >= 32 {
        return Err("對話工具連線已達上限。".into());
    }
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let mut random = [0u8; 32];
    getrandom::fill(&mut random).map_err(|e| e.to_string())?;
    let token: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let url = format!(
        "http://127.0.0.1:{}/{}",
        listener.local_addr().map_err(|e| e.to_string())?.port(),
        token
    );
    let thread = id.to_string();
    let root = directory.clone();
    let capability = token.clone();
    let browser = Arc::new(AtomicBool::new(browser_enabled));
    let active = Arc::new(AtomicBool::new(true));
    let ready = Arc::new(AtomicBool::new(false));
    let browser_state = browser.clone();
    let active_state = active.clone();
    let task = tokio::spawn(async move {
        let slots = Arc::new(Semaphore::new(4));
        loop {
            let Ok((stream, address)) = listener.accept().await else {
                break;
            };
            if !address.ip().is_loopback() {
                continue;
            }
            let Ok(permit) = slots.clone().try_acquire_owned() else {
                continue;
            };
            let id = thread.clone();
            let root = root.clone();
            let token = capability.clone();
            let browser = browser_state.clone();
            let active = active_state.clone();
            tokio::spawn(async move {
                let _permit = permit;
                let _ = tokio::time::timeout(
                    Duration::from_secs(TOOL_TIMEOUT_SECS + 5),
                    connection(stream, &id, &root, &browser, &active, &token),
                )
                .await;
            });
        }
    });
    endpoints.insert(
        id.into(),
        Endpoint {
            url: url.clone(),
            directory,
            browser,
            active,
            ready,
            task: task.abort_handle(),
        },
    );
    Ok(url)
}
pub async fn close(id: &str) {
    if let Some(endpoint) = endpoints().lock().await.remove(id) {
        endpoint.active.store(false, Ordering::SeqCst);
        endpoint.task.abort();
    }
    let _ = computer::enable(id, false).await;
    let _ = images::configure(id, None).await;
    browser::close(id).await;
}
pub async fn close_all() {
    computer::shutdown().await;
    for (_, endpoint) in endpoints().lock().await.drain() {
        endpoint.active.store(false, Ordering::SeqCst);
        endpoint.task.abort();
    }
    browser::close_all().await;
}
async fn connection(
    stream: TcpStream,
    id: &str,
    root: &std::path::Path,
    browser_enabled: &AtomicBool,
    active: &AtomicBool,
    token: &str,
) -> Result<(), String> {
    let mut reader = BufReader::new(stream);
    let mut head = String::new();
    loop {
        let mut line = String::new();
        let size = tokio::time::timeout(
            Duration::from_secs(3),
            (&mut reader).take(8193).read_line(&mut line),
        )
        .await
        .map_err(|_| "timeout")?
        .map_err(|e| e.to_string())?;
        if size == 0 || head.len() + size > 8192 {
            return Err("header limit".into());
        }
        head.push_str(&line);
        if line == "\r\n" {
            break;
        }
    }
    if !head.starts_with(&format!("POST /{token} HTTP/1.1\r\n"))
        || head.lines().any(|line| {
            line.to_ascii_lowercase().starts_with("origin:")
                || line.to_ascii_lowercase().starts_with("transfer-encoding:")
        })
    {
        return Err("unauthorized".into());
    }
    let lengths: Vec<usize> = head
        .lines()
        .filter_map(|line| {
            line.split_once(':')
                .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                .and_then(|(_, value)| value.trim().parse().ok())
        })
        .collect();
    if lengths.len() != 1 || lengths[0] > MAX_REQUEST {
        return Err("request limit".into());
    }
    let mut bytes = vec![0; lengths[0]];
    tokio::time::timeout(Duration::from_secs(3), reader.read_exact(&mut bytes))
        .await
        .map_err(|_| "timeout")?
        .map_err(|e| e.to_string())?;
    let request: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    // Recheck that a replaced listener did not retain access via a queued connection.
    if !endpoints()
        .lock()
        .await
        .get(id)
        .is_some_and(|endpoint| endpoint.url.ends_with(token))
    {
        return Err("revoked".into());
    }
    if !active.load(Ordering::SeqCst) {
        return Err("Tool access was revoked.".into());
    }
    let discovery = request["method"] == "tools/list";
    let result = dispatch(id, root, browser_enabled.load(Ordering::SeqCst), request).await;
    if discovery && result.is_ok() {
        if let Some(endpoint) = endpoints().lock().await.get(id) {
            if endpoint.active.load(Ordering::SeqCst) && endpoint.url.ends_with(token) {
                endpoint.ready.store(true, Ordering::SeqCst);
            }
        }
    }
    let value = match result {
        Ok(value) => json!({"result":value}),
        Err(error) => json!({"error":error}),
    };
    let body = value.to_string();
    let mut stream = reader.into_inner();
    stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.map_err(|e| e.to_string())?;
    Ok(())
}
fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false}})
}
async fn dispatch(
    id: &str,
    _root: &std::path::Path,
    browser_enabled: bool,
    request: Value,
) -> Result<Value, String> {
    if request["method"] == "tools/list" {
        let mut tools = Vec::new();
        {
            for (name, description, properties, required) in [
                (
                    "browser_navigate",
                    "Navigate the conversation's isolated embedded browser (HTTP/HTTPS only).",
                    json!({"url":{"type":"string"}}),
                    vec!["url"],
                ),
                (
                    "browser_screenshot",
                    "Capture the embedded browser viewport.",
                    json!({}),
                    vec![],
                ),
                (
                    "browser_snapshot",
                    "Read page text and interactive element viewport rectangles.",
                    json!({}),
                    vec![],
                ),
                (
                    "browser_click",
                    "Click a viewport coordinate after reading a screenshot or snapshot.",
                    json!({"x":{"type":"number"},"y":{"type":"number"}}),
                    vec!["x", "y"],
                ),
                (
                    "browser_type",
                    "Insert text into the focused browser field.",
                    json!({"text":{"type":"string"}}),
                    vec!["text"],
                ),
                (
                    "browser_key",
                    "Press Enter, Tab, Escape, Backspace, or an arrow key.",
                    json!({"key":{"type":"string"}}),
                    vec!["key"],
                ),
                (
                    "browser_scroll",
                    "Scroll the browser viewport vertically (maximum 2400 pixels).",
                    json!({"delta":{"type":"number"}}),
                    vec!["delta"],
                ),
            ] {
                tools.push(tool(name, description, properties, &required));
            }
        }
        // Advertise stable tool names; permissions are checked again per call.
        tools.push(tool("computer_screenshot", if cfg!(windows) { "Capture the isolated Windows Sandbox desktop. Apps and files on the host desktop are separate." } else { "Capture the primary desktop only after the user enabled computer control in this conversation." }, json!({}), &[]));
        for (name, properties, required) in [
            (
                "computer_click",
                json!({"x":{"type":"integer"},"y":{"type":"integer"},"fingerprint":{"type":"string"}}),
                vec!["x", "y", "fingerprint"],
            ),
            (
                "computer_type",
                json!({"text":{"type":"string"},"fingerprint":{"type":"string"}}),
                vec!["text", "fingerprint"],
            ),
            (
                "computer_key",
                json!({"key":{"type":"string"},"fingerprint":{"type":"string"}}),
                vec!["key", "fingerprint"],
            ),
            (
                "computer_scroll",
                json!({"units":{"type":"integer"},"fingerprint":{"type":"string"}}),
                vec!["units", "fingerprint"],
            ),
        ] {
            tools.push(tool(name, "Act only on the desktop returned by computer_screenshot. Requires access and a fresh, unchanged screenshot fingerprint. Every input consumes the receipt.", properties, &required));
        }
        tools.push(tool("generate_image", "Generate one image using the image service explicitly selected by the user in this conversation. This can incur the service's charges; only call when the user requests image generation. No source can be selected by the tool itself.", json!({"prompt":{"type":"string"}}), &["prompt"]));
        return Ok(json!({"tools":tools}));
    }
    if request["method"] != "tools/call" {
        return Err("Unsupported method".into());
    }
    let name = request["params"]["name"].as_str().ok_or("Missing tool")?;
    let args = request["params"]
        .get("arguments")
        .cloned()
        .unwrap_or(json!({}));
    let value = if let Some(action) = name.strip_prefix("browser_") {
        if !browser_enabled {
            return Err("這個對話未啟用瀏覽器工具。".into());
        }
        browser::action(id, action, args).await?
    } else if let Some(action) = name.strip_prefix("computer_") {
        computer::action(
            id,
            if action == "screenshot" {
                "capture"
            } else {
                action
            },
            args,
        )
        .await?
    } else if name == "generate_image" {
        {
            let data = DATA_ROOT.get().ok_or("圖片儲存位置尚未就緒。")?;
            let directory = crate::agent_chat::general_chat_directory(data, id)?;
            let mut result = images::generate(id, &directory, args).await?;
            if let Some(path) = result["path"].as_str() {
                if let Some(url) = crate::chat_images::preview(
                    &directory.to_string_lossy(),
                    Some(&directory),
                    path,
                )? {
                    if let Some((head, data)) = url.split_once(",") {
                        result["image"] = json!(data);
                        result["mimeType"] =
                            json!(head.trim_start_matches("data:").trim_end_matches(";base64"));
                    }
                }
            }
            result
        }
    } else {
        return Err("Unknown tool".into());
    };
    let mut content = vec![
        json!({"type":"text","text":value.as_object().map(|object| { let mut object = object.clone(); object.remove("image"); Value::Object(object).to_string() }).unwrap_or_else(|| value.to_string())}),
    ];
    if let Some(data) = value["image"].as_str() {
        content.push(json!({"type":"image","mimeType":value["mimeType"].as_str().unwrap_or("image/jpeg"),"data":data}));
    }
    Ok(json!({"content":content,"isError":false}))
}
pub fn run_cli(arguments: &[std::ffi::OsString]) -> Option<i32> {
    if arguments.first().and_then(|arg| arg.to_str()) != Some("--mcp-chat-tools") {
        return None;
    }
    crate::install_rustls_crypto_provider();
    Some(match tokio::runtime::Runtime::new() {
        Ok(runtime) => runtime.block_on(stdio()),
        Err(_) => 1,
    })
}
async fn stdio() -> i32 {
    let Ok(url) = std::env::var(ENV) else {
        return 1;
    };
    let Ok(parsed) = reqwest::Url::parse(&url) else {
        return 1;
    };
    if parsed.scheme() != "http"
        || parsed.host_str() != Some("127.0.0.1")
        || parsed.port().is_none()
        || parsed.path().len() != 65
        || !parsed.path()[1..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return 1;
    }
    let Ok(client) = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(TOOL_TIMEOUT_SECS))
        .build()
    else {
        return 1;
    };
    let mut input = BufReader::new(tokio::io::stdin());
    let mut output = tokio::io::stdout();
    loop {
        let mut bytes = Vec::new();
        let size = match (&mut input)
            .take((MAX_REQUEST + 1) as u64)
            .read_until(b'\n', &mut bytes)
            .await
        {
            Ok(size) => size,
            Err(_) => return 1,
        };
        if size == 0 {
            return 0;
        }
        if size > MAX_REQUEST {
            return 1;
        }
        let Ok(request) = serde_json::from_slice::<Value>(&bytes) else {
            return 1;
        };
        let Some(id) = request.get("id") else {
            continue;
        };
        let result = match request["method"].as_str() {
            Some("initialize") => Ok(json!({"protocolVersion":request["params"]["protocolVersion"].as_str().filter(|version| matches!(*version, "2024-11-05" | "2025-03-26" | "2025-06-18" | "2025-11-25")).unwrap_or("2025-11-25"),"capabilities":{"tools":{}},"serverInfo":{"name":"latticeterm-chat-tools","version":env!("CARGO_PKG_VERSION")}})),
            Some("ping") => Ok(json!({})),
            Some("tools/list" | "tools/call") => match client.post(&url).json(&request).send().await { Ok(response) => match response.json::<Value>().await { Ok(value) if value.get("result").is_some() => Ok(value["result"].clone()), Ok(value) => Err(value["error"].as_str().unwrap_or("Tool request failed").to_string()), Err(_) => Err("Tool response unavailable".into()) }, Err(_) => Err("Tool connection unavailable; the outcome may be unknown. Inspect before retrying.".into()) },
            _ => Err("Unsupported method".into()),
        };
        let response = match result {
            Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
            Err(error) => {
                json!({"jsonrpc":"2.0","id":id,"result":{"content":[{"type":"text","text":error}],"isError":true}})
            }
        };
        if output
            .write_all(format!("{response}\n").as_bytes())
            .await
            .is_err()
            || output.flush().await.is_err()
        {
            return 1;
        }
    }
}
pub fn environment() -> &'static str {
    ENV
}

/// Prepared asynchronously by the desktop before a foreground PTY is launched.
/// Only argv configuration and an environment capability are passed to the child.
pub(crate) struct SessionLaunchTools {
    pub id: String,
    pub url: String,
    pub arguments: Vec<String>,
}
pub(crate) async fn prepare_session(
    id: String,
    definition: &str,
    directory: PathBuf,
) -> Result<SessionLaunchTools, String> {
    let directory = directory.canonicalize().map_err(|e| e.to_string())?;
    let url = ensure(&id, directory, true).await?;
    // The built-in bridge has no Node/download prerequisite. Foreground CLIs
    // must not wait for an optional Playwright server during normal startup.
    let arguments = match definition {
        "codex" => crate::agent_chat::browser::codex_arguments(),
        "claude" => crate::agent_chat::browser::claude_arguments(None),
        _ => return Err("這個助理不支援對話工具。".into()),
    };
    Ok(SessionLaunchTools { id, url, arguments })
}
pub(crate) async fn registered(id: &str) -> bool {
    endpoints()
        .lock()
        .await
        .get(id)
        .is_some_and(|endpoint| endpoint.ready.load(Ordering::SeqCst))
}

pub(crate) async fn set_browser_enabled(id: &str, enabled: bool) -> Result<(), String> {
    checked_id(id)?;
    let guard = endpoints().lock().await;
    let endpoint = guard.get(id).ok_or("這個工作階段尚未載入助理工具。")?;
    endpoint.browser.store(enabled, Ordering::SeqCst);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn loopback_tools_require_the_current_capability_and_explicit_computer_grant() {
        crate::install_rustls_crypto_provider();
        let root = tempfile::tempdir().unwrap();
        let id = "test-scoped-tools-transport";
        let url = ensure(id, root.path().into(), true).await.unwrap();
        assert!(!registered(id).await);
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        let list: Value = client
            .post(&url)
            .json(&json!({"method":"tools/list"}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(list["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["name"] == "browser_navigate"));
        let denied: Value = client.post(&url).json(&json!({"method":"tools/call","params":{"name":"computer_screenshot","arguments":{}}})).send().await.unwrap().json().await.unwrap();
        assert!(denied["error"].as_str().unwrap().contains("尚未允許"));
        assert!(client
            .post(&url)
            .header("Origin", "https://example.invalid")
            .json(&json!({"method":"tools/list"}))
            .send()
            .await
            .is_err());
        let replacement = ensure(id, root.path().into(), false).await.unwrap();
        assert_eq!(url, replacement); // Live CLI children retain their original capability.
        let denied: Value = client
            .post(&url)
            .json(
                &json!({"method":"tools/call","params":{"name":"browser_snapshot","arguments":{}}}),
            )
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(denied["error"].as_str().unwrap().contains("瀏覽器"));
        assert!(registered(id).await);
        computer::enable(id, true).await.unwrap();
        assert!(computer::enabled(id).await); // Armed while the composer is still visible.
        computer::focus_changed(false);
        assert!(computer::enabled(id).await);
        computer::focus_changed(true);
        assert!(!computer::enabled(id).await);
        computer::focus_changed(false);
        assert!(!computer::enabled(id).await);
        close(id).await;
        assert!(!computer::enabled(id).await);
    }
}
