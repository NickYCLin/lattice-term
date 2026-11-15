//! One isolated Chromium profile per conversation, shared by the viewer and MCP.
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::OnceLock,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
struct Browser {
    child: Child,
    _profile: tempfile::TempDir,
    port: u16,
}
impl Drop for Browser {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
static BROWSERS: OnceLock<Mutex<HashMap<String, Browser>>> = OnceLock::new();
fn registry() -> &'static Mutex<HashMap<String, Browser>> {
    BROWSERS.get_or_init(Mutex::default)
}
fn executable() -> Result<PathBuf, String> {
    for name in [
        "google-chrome-stable",
        "google-chrome",
        "chromium",
        "chromium-browser",
        "msedge",
        "chrome",
    ] {
        if let Some(path) = crate::agent::find_executable(name) {
            return Ok(path);
        }
    }
    let mut paths = vec![
        PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        PathBuf::from("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
    ];
    for variable in ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"] {
        if let Some(root) = std::env::var_os(variable) {
            for suffix in [
                "Google/Chrome/Application/chrome.exe",
                "Microsoft/Edge/Application/msedge.exe",
            ] {
                paths.push(PathBuf::from(&root).join(suffix));
            }
        }
    }
    paths
        .into_iter()
        .find(|path| path.is_file())
        .ok_or("找不到 Chrome 或 Edge，請先安裝其中一種瀏覽器。".into())
}
fn launch() -> Result<Browser, String> {
    let profile = tempfile::Builder::new()
        .prefix("latticeterm-chat-browser-")
        .tempdir()
        .map_err(|e| e.to_string())?;
    let mut command = Command::new(executable()?);
    command
        .args([
            "--headless=new",
            "--remote-debugging-port=0",
            "--remote-debugging-address=127.0.0.1",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-sync",
            "--disable-extensions",
            "--window-size=1280,800",
        ])
        .arg(format!("--user-data-dir={}", profile.path().display()))
        .arg("about:blank")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let child = command.spawn().map_err(|e| e.to_string())?;
    let mut browser = Browser {
        child,
        _profile: profile,
        port: 0,
    };
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(8) {
        if let Ok(contents) =
            std::fs::read_to_string(browser._profile.path().join("DevToolsActivePort"))
        {
            if let Some(port) = contents
                .lines()
                .next()
                .and_then(|port| port.parse::<u16>().ok())
                .filter(|port| *port > 0)
            {
                browser.port = port;
                return Ok(browser);
            }
        }
        if browser
            .child
            .try_wait()
            .map_err(|e| e.to_string())?
            .is_some()
        {
            return Err("瀏覽器未能啟動；請檢查本機 Chrome／Edge。".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err("瀏覽器啟動逾時。".into())
}
pub async fn ensure(id: &str) -> Result<(), String> {
    super::checked_id(id)?;
    let mut browsers = registry().lock().await;
    if let Some(browser) = browsers.get_mut(id) {
        if browser
            .child
            .try_wait()
            .map_err(|e| e.to_string())?
            .is_none()
        {
            return Ok(());
        }
        browsers.remove(id);
    }
    if browsers.len() >= 16 {
        return Err("請先關閉不再使用的對話瀏覽器。".into());
    }
    let browser = tokio::task::spawn_blocking(launch)
        .await
        .map_err(|e| e.to_string())??;
    browsers.insert(id.into(), browser);
    Ok(())
}
pub async fn endpoint(id: &str) -> Result<String, String> {
    ensure(id).await?;
    let browsers = registry().lock().await;
    let browser = browsers.get(id).ok_or("瀏覽器已關閉。")?;
    Ok(format!("http://127.0.0.1:{}", browser.port))
}
pub async fn close(id: &str) {
    registry().lock().await.remove(id);
}
pub async fn close_all() {
    registry().lock().await.clear();
}
async fn target(port: u16) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(format!("http://127.0.0.1:{port}/json/list"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if response
        .content_length()
        .is_some_and(|size| size > 256 * 1024)
    {
        return Err("瀏覽器資料超過限制。".into());
    }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > 256 * 1024 {
        return Err("瀏覽器資料超過限制。".into());
    }
    let pages: Vec<Value> = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    pages
        .into_iter()
        .find(|page| page["type"] == "page")
        .ok_or("瀏覽器沒有可用分頁。".into())
}
async fn cdp(port: u16, target: &Value, method: &str, params: Value) -> Result<Value, String> {
    let address = target["webSocketDebuggerUrl"]
        .as_str()
        .ok_or("瀏覽器未提供除錯連線。")?;
    let parsed = reqwest::Url::parse(address).map_err(|e| e.to_string())?;
    if parsed.scheme() != "ws"
        || parsed.host_str() != Some("127.0.0.1")
        || parsed.port() != Some(port)
        || !parsed.path().starts_with("/devtools/page/")
    {
        return Err("瀏覽器除錯連線不符合本機範圍。".into());
    }
    tokio::time::timeout(Duration::from_secs(8), async {
        let (mut socket, _) = tokio_tungstenite::connect_async(address)
            .await
            .map_err(|e| e.to_string())?;
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                json!({"id":1,"method":method,"params":params})
                    .to_string()
                    .into(),
            ))
            .await
            .map_err(|e| e.to_string())?;
        while let Some(message) = socket.next().await {
            let message = message.map_err(|e| e.to_string())?;
            if message.len() > 24 * 1024 * 1024 {
                return Err("瀏覽器回應超過限制。".into());
            }
            if let Ok(text) = message.to_text() {
                let value: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
                if value["id"] == 1 {
                    if value.get("error").is_some() {
                        return Err(format!(
                            "{method}: {}",
                            value["error"]["message"]
                                .as_str()
                                .unwrap_or("瀏覽器拒絕這個操作。")
                                .chars()
                                .take(240)
                                .collect::<String>()
                        ));
                    }
                    let _ = socket.close(None).await;
                    return Ok(value["result"].clone());
                }
            }
        }
        Err("瀏覽器連線已結束。".into())
    })
    .await
    .map_err(|_| "瀏覽器操作逾時。".to_string())?
}
fn coordinate(args: &Value, name: &str, limit: u64) -> Result<f64, String> {
    args[name]
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0 && *n < limit as f64)
        .ok_or_else(|| format!("{name} 超出瀏覽器畫面。"))
}
pub async fn action(id: &str, action: &str, args: Value) -> Result<Value, String> {
    ensure(id).await?;
    let browsers = registry().lock().await;
    let browser = browsers.get(id).ok_or("瀏覽器已關閉。")?;
    let page = target(browser.port).await?;
    let send = |method: &'static str, params| cdp(browser.port, &page, method, params);
    let metrics = send("Page.getLayoutMetrics", json!({})).await?;
    let width = metrics["cssVisualViewport"]["clientWidth"]
        .as_u64()
        .filter(|value| *value > 0 && *value <= 8192)
        .ok_or("瀏覽器未回報畫面寬度。")?;
    let height = metrics["cssVisualViewport"]["clientHeight"]
        .as_u64()
        .filter(|value| *value > 0 && *value <= 8192)
        .ok_or("瀏覽器未回報畫面高度。")?;
    match action {
        "navigate" => {
            let url = args["url"]
                .as_str()
                .filter(|url| url.len() <= 4096)
                .ok_or("缺少網址。")?;
            let parsed = reqwest::Url::parse(url).map_err(|_| "網址無效。")?;
            if !["http", "https"].contains(&parsed.scheme())
                || !parsed.username().is_empty()
                || parsed.password().is_some()
            {
                return Err("瀏覽器只接受 HTTP／HTTPS 網址。".into());
            }
            send("Page.navigate", json!({"url":url})).await?;
        }
        "reload" => {
            send("Page.reload", json!({})).await?;
        }
        "back" | "forward" => {
            let history = send("Page.getNavigationHistory", json!({})).await?;
            let index = history["currentIndex"].as_i64().unwrap_or(0)
                + if action == "back" { -1 } else { 1 };
            let entry = history["entries"]
                .as_array()
                .and_then(|entries| {
                    usize::try_from(index)
                        .ok()
                        .and_then(|index| entries.get(index))
                })
                .ok_or("沒有可切換的瀏覽紀錄。")?;
            send(
                "Page.navigateToHistoryEntry",
                json!({"entryId":entry["id"]}),
            )
            .await?;
        }
        "click" => {
            let x = coordinate(&args, "x", width)?;
            let y = coordinate(&args, "y", height)?;
            for kind in ["mousePressed", "mouseReleased"] {
                send(
                    "Input.dispatchMouseEvent",
                    json!({"type":kind,"x":x,"y":y,"button":"left","clickCount":1}),
                )
                .await?;
            }
        }
        "type" => {
            let text = args["text"]
                .as_str()
                .filter(|text| text.len() <= 16000)
                .ok_or("輸入文字超過限制。")?;
            send("Input.insertText", json!({"text":text})).await?;
        }
        "key" => {
            let key = args["key"].as_str().ok_or("缺少按鍵。")?;
            let code = match key {
                "Enter" => 13,
                "Tab" => 9,
                "Escape" => 27,
                "Backspace" => 8,
                "ArrowDown" => 40,
                "ArrowUp" => 38,
                "ArrowLeft" => 37,
                "ArrowRight" => 39,
                _ => return Err("這個按鍵尚未支援。".into()),
            };
            for kind in ["keyDown", "keyUp"] {
                send("Input.dispatchKeyEvent", json!({"type":kind,"key":key,"windowsVirtualKeyCode":code,"nativeVirtualKeyCode":code})).await?;
            }
        }
        "scroll" => {
            let delta = args["delta"]
                .as_f64()
                .filter(|delta| delta.is_finite() && delta.abs() <= 2400.0)
                .ok_or("捲動量超過限制。")?;
            send(
                "Input.dispatchMouseEvent",
                json!({"type":"mouseWheel","x":width / 2,"y":height / 2,"deltaX":0,"deltaY":delta}),
            )
            .await?;
        }
        "snapshot" => {
            return send("Runtime.evaluate", json!({"expression":"JSON.stringify({title:document.title,url:location.href,text:document.body?.innerText?.slice(0,32000),elements:[...document.querySelectorAll('a,button,input,textarea,select')].slice(0,200).map(e=>({tag:e.tagName,text:e.innerText?.slice(0,160),label:e.getAttribute('aria-label'),type:e.getAttribute('type'),rect:(()=>{let r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()}))})","returnByValue":true})).await;
        }
        "screenshot" => {}
        _ => return Err("未知的瀏覽器操作。".into()),
    }
    // Navigation may detach the page briefly after an acknowledged action.
    // Retry only the read; never repeat a click, key, text input or navigation.
    let mut image = Value::Null;
    let mut current = page;
    for _ in 0..20 {
        current = target(browser.port).await?;
        match cdp(
            browser.port,
            &current,
            "Page.captureScreenshot",
            json!({"format":"jpeg","quality":70,"captureBeyondViewport":false}),
        )
        .await
        {
            Ok(value) => {
                image = value["data"].clone();
                break;
            }
            Err(error) if error.contains("Not attached to an active page") => {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(error) => return Err(error),
        }
    }
    let notice = image
        .is_null()
        .then_some("操作已送出，瀏覽器畫面尚未就緒；請重新擷取，不要重複執行剛才的操作。");
    Ok(
        json!({"image":image,"url":current["url"],"title":current["title"],"width":width,"height":height,"notice":notice}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "Requires local Chrome; uses only a synthetic loopback page"]
    async fn embedded_browser_navigates_types_and_shares_its_actual_frame() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        crate::install_rustls_crypto_provider();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                tokio::spawn(async move {
                    let mut data = [0; 4096];
                    let _ = stream.read(&mut data).await;
                    let body = "<title>Scoped browser fixture</title><input autofocus aria-label='test input'><button onclick='this.textContent=\"clicked\"'>Click</button>";
                    let _ = stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await;
                });
            }
        });
        let id = "test-browser-scoped";
        let operation = async {
            action(
                id,
                "navigate",
                json!({"url":format!("http://127.0.0.1:{port}")}),
            )
            .await?;
            let mut ready = false;
            for _ in 0..20 {
                let result = action(id, "snapshot", json!({})).await?;
                if result["result"]["value"]
                    .as_str()
                    .unwrap_or("")
                    .contains("test input")
                {
                    ready = true;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            assert!(ready);
            let frame = action(id, "type", json!({"text":"native browser input"})).await?;
            assert_eq!(frame["width"], 1280);
            assert!(frame["height"].as_u64().unwrap() >= 500);
            assert!(frame["image"].as_str().unwrap().starts_with("/9j/"));
            assert!(action(id, "navigate", json!({"url":"file:///etc/passwd"}))
                .await
                .is_err());
            assert!(action(id, "click", json!({"x":2000,"y":0})).await.is_err());
            let browsers = registry().lock().await;
            let browser = browsers.get(id).unwrap();
            let page = target(browser.port).await?;
            let value = cdp(
                browser.port,
                &page,
                "Runtime.evaluate",
                json!({"expression":"document.querySelector('input').value","returnByValue":true}),
            )
            .await?;
            assert_eq!(value["result"]["value"], "native browser input");
            Ok::<_, String>(())
        }
        .await;
        close(id).await;
        server.abort();
        operation.unwrap();
    }
}
