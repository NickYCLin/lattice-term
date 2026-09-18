//! Talking to a CLIProxyAPI server the user runs themselves.
//!
//! CLIProxyAPI fronts several coding-plan subscriptions behind one local
//! OpenAI/Claude/Gemini-compatible endpoint. LatticeTerm only needs two
//! things from it: proof that the address answers, and the list of models it
//! will accept. Everything else — which provider a model comes from, how the
//! proxy authenticates upstream — stays inside the proxy.
//!
//! The API key never leaves this process. It is read from the credential
//! store for one request and dropped; it is not returned to the interface,
//! written to a log, or placed in a CLI's configuration file.

use serde::{Deserialize, Serialize};
use std::time::Duration;
use zeroize::Zeroizing;

/// The proxy's own default. Shown as a placeholder, never assumed.
pub const DEFAULT_BASE_URL: &str = "http://127.0.0.1:8317";

const MAX_BASE_URL_LENGTH: usize = 256;
const MAX_KEY_LENGTH: usize = 512;
/// A model list is a few kilobytes. The cap stops a wrong address — a file
/// server, a log stream — from being read into memory.
const MAX_BODY_BYTES: usize = 1024 * 1024;
const MAX_MODELS: usize = 500;
const MAX_MODEL_ID_LENGTH: usize = 256;
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const MODELS_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyProbe {
    /// The address answered as a CLIProxyAPI health endpoint.
    pub healthy: bool,
    pub status: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyModel {
    pub id: String,
    pub owned_by: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ModelListBody {
    #[serde(default)]
    data: Vec<ModelEntry>,
}

#[derive(Debug, Deserialize)]
struct ModelEntry {
    id: String,
    #[serde(default)]
    owned_by: Option<String>,
}

/// Accepts what a person can reasonably type for their own proxy and rejects
/// what cannot be one. A credential is bound to the result of this function,
/// so two spellings of the same address must normalize to the same string.
pub fn normalize_base_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("cliproxy.url.empty".to_string());
    }
    if trimmed.len() > MAX_BASE_URL_LENGTH {
        return Err("cliproxy.url.long".to_string());
    }
    if trimmed.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("cliproxy.url.invalid".to_string());
    }
    let Some((raw_scheme, rest)) = trimmed.split_once("://") else {
        return Err("cliproxy.url.scheme".to_string());
    };
    let scheme = match raw_scheme.to_ascii_lowercase().as_str() {
        "http" => "http",
        "https" => "https",
        _ => return Err("cliproxy.url.scheme".to_string()),
    };
    // A query or fragment cannot belong to a base address, and credentials in
    // the authority would be a second, unmanaged place to keep a secret.
    if rest.contains('?') || rest.contains('#') || rest.contains('@') {
        return Err("cliproxy.url.invalid".to_string());
    }
    let (authority, path) = match rest.split_once('/') {
        Some((authority, path)) => (authority, path),
        None => (rest, ""),
    };
    if authority.is_empty() {
        return Err("cliproxy.url.invalid".to_string());
    }
    // Only the host is case-insensitive; a reverse-proxy path prefix is not.
    let authority = authority.to_ascii_lowercase();
    let path = path.trim_end_matches('/');
    if path.contains("..") {
        return Err("cliproxy.url.invalid".to_string());
    }
    Ok(if path.is_empty() {
        format!("{scheme}://{authority}")
    } else {
        format!("{scheme}://{authority}/{path}")
    })
}

pub fn validate_key(raw: &str) -> Result<String, String> {
    let key = raw.trim();
    if key.is_empty() {
        return Err("cliproxy.key.empty".to_string());
    }
    if key.len() > MAX_KEY_LENGTH {
        return Err("cliproxy.key.long".to_string());
    }
    // The key is sent as a header value; a control character would let a
    // pasted string split the request.
    if key.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("cliproxy.key.invalid".to_string());
    }
    Ok(key.to_string())
}

/// Redirects are never followed: a redirect is the one way an address the
/// user typed could hand the key to a host they did not name. The system
/// proxy is bypassed for the same reason, and because the usual address is
/// loopback, where a corporate proxy would only get in the way.
fn client(timeout: Duration) -> Result<reqwest::Client, String> {
    // `rustls-no-provider` leaves the choice to the process. The application
    // installs `ring` at startup; doing it here as well keeps this module
    // usable on its own and turns a would-be panic into ordinary setup.
    static PROVIDER: std::sync::Once = std::sync::Once::new();
    PROVIDER.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
    reqwest::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .user_agent(concat!("LatticeTerm/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| error.to_string())
}

async fn read_bounded(mut response: reqwest::Response) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|len| len > MAX_BODY_BYTES as u64)
    {
        return Err("cliproxy.models.oversized".to_string());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        if body.len() + chunk.len() > MAX_BODY_BYTES {
            return Err("cliproxy.models.oversized".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

pub async fn probe(base_url: &str) -> Result<ProxyProbe, String> {
    let base = normalize_base_url(base_url)?;
    let response = client(PROBE_TIMEOUT)?
        .get(format!("{base}/healthz"))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    Ok(ProxyProbe {
        healthy: status.is_success(),
        status: status.as_u16(),
    })
}

/// The proxy may be configured without `api-keys`, in which case it answers
/// an unauthenticated request. A missing saved key is therefore not an error
/// here; only the proxy decides whether the request is allowed.
pub async fn models(
    base_url: &str,
    key: Option<Zeroizing<String>>,
) -> Result<Vec<ProxyModel>, String> {
    let base = normalize_base_url(base_url)?;
    let mut request = client(MODELS_TIMEOUT)?.get(format!("{base}/v1/models"));
    if let Some(key) = key.as_deref() {
        request = request.bearer_auth(key);
    }
    let response = request.send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err("cliproxy.models.unauthorized".to_string());
    }
    if !status.is_success() {
        return Err(format!("cliproxy.models.status:{}", status.as_u16()));
    }
    let body = read_bounded(response).await?;
    let parsed: ModelListBody =
        serde_json::from_slice(&body).map_err(|_| "cliproxy.models.unreadable".to_string())?;
    let mut models: Vec<ProxyModel> = Vec::new();
    for entry in parsed.data {
        let id = entry.id.trim().to_string();
        if id.is_empty() || id.len() > MAX_MODEL_ID_LENGTH {
            continue;
        }
        if id.chars().any(|c| c.is_control()) {
            continue;
        }
        if models.iter().any(|model| model.id == id) {
            continue;
        }
        models.push(ProxyModel {
            id,
            owned_by: entry
                .owned_by
                .map(|owner| owner.trim().to_string())
                .filter(|owner| !owner.is_empty() && owner.len() <= MAX_MODEL_ID_LENGTH),
        });
        if models.len() >= MAX_MODELS {
            break;
        }
    }
    if models.is_empty() {
        return Err("cliproxy.models.empty".to_string());
    }
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::TcpListener;

    #[test]
    fn two_spellings_of_one_address_normalize_together() {
        for raw in [
            "http://127.0.0.1:8317",
            " http://127.0.0.1:8317/ ",
            "http://127.0.0.1:8317///",
        ] {
            assert_eq!(normalize_base_url(raw).unwrap(), "http://127.0.0.1:8317");
        }
        assert_eq!(
            normalize_base_url("HTTPS://Proxy.Example.COM/ai/").unwrap(),
            "https://proxy.example.com/ai"
        );
        // A path prefix is a reverse-proxy mount point and keeps its case.
        assert_eq!(
            normalize_base_url("http://host:8317/AI/Gateway").unwrap(),
            "http://host:8317/AI/Gateway"
        );
    }

    #[test]
    fn addresses_that_cannot_be_a_proxy_are_refused() {
        for raw in [
            "",
            "   ",
            "127.0.0.1:8317",
            "ftp://127.0.0.1",
            "file:///etc/passwd",
            "http://",
            "http://user:pass@127.0.0.1:8317",
            "http://127.0.0.1:8317?key=1",
            "http://127.0.0.1:8317#frag",
            "http://127.0.0.1:8317/../admin",
            "http://127.0.0.1:8317/a b",
        ] {
            assert!(normalize_base_url(raw).is_err(), "accepted {raw:?}");
        }
        assert!(normalize_base_url(&format!("http://{}", "h".repeat(300))).is_err());
    }

    #[test]
    fn a_key_that_could_split_a_header_is_refused() {
        assert_eq!(validate_key("  sk-abc  ").unwrap(), "sk-abc");
        for raw in ["", "   ", "sk-a b", "sk-a\r\nHost: evil", "sk-a\u{0}"] {
            assert!(validate_key(raw).is_err(), "accepted {raw:?}");
        }
        assert!(validate_key(&"k".repeat(600)).is_err());
    }

    /// One canned HTTP/1.1 exchange. Returns the address and the request head
    /// the client actually sent, so the test can check the Authorization it
    /// added rather than trusting the call site.
    async fn serve_once(
        status: &'static str,
        body: String,
    ) -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            while stream.read_exact(&mut byte).await.is_ok() {
                head.push(byte[0]);
                if head.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
            let _ = stream.flush().await;
            String::from_utf8_lossy(&head).to_string()
        });
        (address, handle)
    }

    #[tokio::test]
    async fn a_reachable_proxy_reports_healthy_and_lists_its_models() {
        let (address, served) = serve_once("200 OK", "{\"status\":\"ok\"}".to_string()).await;
        let probe = probe(&address).await.unwrap();
        assert_eq!(
            probe,
            ProxyProbe {
                healthy: true,
                status: 200
            }
        );
        assert!(served.await.unwrap().starts_with("GET /healthz "));

        // Duplicates collapse and an unusable entry is dropped rather than
        // shown as a model nobody can launch.
        let body = serde_json::json!({"object": "list", "data": [
            {"id": "gpt-5.6-sol", "owned_by": "openai"},
            {"id": "gpt-5.6-sol"},
            {"id": "  "},
            {"id": "claude-opus-5", "owned_by": "  "},
        ]})
        .to_string();
        let (address, served) = serve_once("200 OK", body).await;
        let models = models(&address, Some(Zeroizing::new("sk-secret".to_string())))
            .await
            .unwrap();
        assert_eq!(
            models,
            vec![
                ProxyModel {
                    id: "gpt-5.6-sol".to_string(),
                    owned_by: Some("openai".to_string())
                },
                ProxyModel {
                    id: "claude-opus-5".to_string(),
                    owned_by: None
                },
            ]
        );
        let head = served.await.unwrap();
        assert!(head.starts_with("GET /v1/models "), "{head}");
        assert!(head.contains("authorization: Bearer sk-secret"), "{head}");
    }

    #[tokio::test]
    async fn a_proxy_without_keys_is_asked_without_one() {
        let body = serde_json::json!({"data": [{"id": "gpt-5.6-sol"}]}).to_string();
        let (address, served) = serve_once("200 OK", body).await;
        assert_eq!(models(&address, None).await.unwrap().len(), 1);
        assert!(!served
            .await
            .unwrap()
            .to_lowercase()
            .contains("authorization"));
    }

    #[tokio::test]
    async fn a_refused_or_unusable_answer_is_named_rather_than_guessed() {
        let (address, _served) = serve_once("401 Unauthorized", "{}".to_string()).await;
        assert_eq!(
            models(&address, None).await.unwrap_err(),
            "cliproxy.models.unauthorized"
        );

        let (address, _served) = serve_once("503 Service Unavailable", "{}".to_string()).await;
        assert_eq!(
            models(&address, None).await.unwrap_err(),
            "cliproxy.models.status:503"
        );

        let (address, _served) = serve_once("200 OK", "not json".to_string()).await;
        assert_eq!(
            models(&address, None).await.unwrap_err(),
            "cliproxy.models.unreadable"
        );

        let (address, _served) = serve_once("200 OK", "{\"data\":[]}".to_string()).await;
        assert_eq!(
            models(&address, None).await.unwrap_err(),
            "cliproxy.models.empty"
        );

        // A wrong address that streams something large is refused before it
        // is read into memory.
        let oversized =
            serde_json::json!({"data": [{"id": "x".repeat(MAX_BODY_BYTES + 16)}]}).to_string();
        let (address, _served) = serve_once("200 OK", oversized).await;
        assert_eq!(
            models(&address, None).await.unwrap_err(),
            "cliproxy.models.oversized"
        );
    }

    #[tokio::test]
    async fn an_address_that_does_not_answer_is_an_error_not_a_hang() {
        // Bind and drop: the port is closed, so the connection is refused.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        assert!(probe(&address).await.is_err());
    }
}
