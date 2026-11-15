//! User-selected OpenAI-compatible image endpoint. Keys stay in the native vault.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, path::Path, sync::OnceLock, time::Duration};
use tokio::sync::Mutex;
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageSource {
    pub base_url: String,
    pub proxy_id: String,
    pub model: String,
}
static SOURCES: OnceLock<Mutex<HashMap<String, ImageSource>>> = OnceLock::new();
fn registry() -> &'static Mutex<HashMap<String, ImageSource>> {
    SOURCES.get_or_init(Mutex::default)
}
pub async fn configure(id: &str, source: Option<ImageSource>) -> Result<(), String> {
    super::checked_id(id)?;
    if let Some(source) = source.as_ref() {
        crate::cliproxy::normalize_base_url(&source.base_url)?;
        if source.model.is_empty()
            || source.model.len() > 200
            || source.model.chars().any(char::is_control)
        {
            return Err("請輸入服務實際支援的圖片模型。".into());
        }
        let base = source.base_url.clone();
        let proxy_id = source.proxy_id.clone();
        tokio::task::spawn_blocking(move || {
            crate::cliproxy::launch::ProxyLaunch::load(&base, Some(&proxy_id))
        })
        .await
        .map_err(|e| e.to_string())??;
    }
    let mut sources = registry().lock().await;
    if let Some(source) = source {
        if sources.len() >= 32 && !sources.contains_key(id) {
            return Err("圖片工具的對話數已達上限。".into());
        }
        sources.insert(id.into(), source);
    } else {
        sources.remove(id);
    }
    Ok(())
}
pub async fn source(id: &str) -> Option<ImageSource> {
    registry().lock().await.get(id).cloned()
}
pub async fn configured(id: &str) -> bool {
    registry().lock().await.contains_key(id)
}
pub async fn generate(id: &str, directory: &Path, args: Value) -> Result<Value, String> {
    let source = registry()
        .lock()
        .await
        .get(id)
        .cloned()
        .ok_or("請先在對話工具選取圖片服務與模型。")?;
    let prompt = args["prompt"]
        .as_str()
        .filter(|prompt| !prompt.trim().is_empty() && prompt.len() <= 16000)
        .ok_or("圖片描述需為 1–16000 個位元組。")?;
    let model = source.model.clone();
    let target = tokio::task::spawn_blocking(move || {
        crate::cliproxy::launch::ProxyLaunch::load(&source.base_url, Some(&source.proxy_id))
    })
    .await
    .map_err(|e| e.to_string())??;
    let value = request_image(target.base_url(), target.key(), &model, prompt).await?;
    let encoded = value["data"][0]["b64_json"]
        .as_str()
        .ok_or("圖片服務必須回傳 b64_json；不會自動開啟服務提供的外部下載網址。")?;
    let paths = crate::chat_images::store(
        directory,
        &[crate::chat_images::ToolImage::Data(encoded.into())],
    );
    let path = paths
        .first()
        .ok_or("圖片內容不是有效或大小允許的 PNG／JPEG／GIF／WebP。")?;
    Ok(json!({"path":path,"model":model,"usage":value["usage"]}))
}

async fn request_image(
    base: &str,
    key: Option<&str>,
    model: &str,
    prompt: &str,
) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;
    let mut request = client
        .post(format!("{}/v1/images/generations", base))
        .json(&json!({"model":model,"prompt":prompt,"n":1,"size":"1024x1024"}));
    if let Some(key) = key {
        request = request.bearer_auth(key);
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| "圖片服務未確認結果；請先檢查服務紀錄再重試，避免重複計費。")?;
    if !response.status().is_success() {
        return Err(format!(
            "圖片服務回覆 HTTP {}；請確認端點與模型支援 images/generations。",
            response.status().as_u16()
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "圖片回應中斷，請檢查服務紀錄。")?
    {
        if bytes.len() + chunk.len() > 24 * 1024 * 1024 {
            return Err("圖片回應超過 24 MiB。".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "圖片服務未回傳有效 JSON。")?;
    Ok(value)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn sends_the_images_api_contract_and_refuses_redirects() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        crate::install_rustls_crypto_provider();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            for redirect in [false, true] {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = vec![0; 8192];
                let size = stream.read(&mut request).await.unwrap();
                let request = String::from_utf8_lossy(&request[..size]);
                assert!(request.starts_with("POST /v1/images/generations HTTP/1.1"));
                assert!(request
                    .to_ascii_lowercase()
                    .contains("authorization: bearer synthetic-key"));
                assert!(request.contains("\"model\":\"synthetic-image-model\""));
                assert!(request.contains("\"n\":1"));
                let response = if redirect {
                    "HTTP/1.1 302 Found\r\nLocation: https://example.invalid/never-follow\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string()
                } else {
                    let body = r#"{"data":[{"b64_json":"fixture"}],"usage":{"total_tokens":3}}"#;
                    format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len())
                };
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let result = request_image(
            &base,
            Some("synthetic-key"),
            "synthetic-image-model",
            "synthetic prompt",
        )
        .await
        .unwrap();
        assert_eq!(result["data"][0]["b64_json"], "fixture");
        assert!(request_image(
            &base,
            Some("synthetic-key"),
            "synthetic-image-model",
            "synthetic prompt"
        )
        .await
        .unwrap_err()
        .contains("302"));
        server.await.unwrap();
        assert!(generate(
            "unconfigured-test-image",
            Path::new("/unused"),
            json!({"prompt":"must not contact a service"})
        )
        .await
        .is_err());
    }
}
