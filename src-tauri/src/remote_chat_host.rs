//! A host-lifetime, loopback-only bridge to the desktop's existing chat owner.
use lattice_remote::chat_protocol::{ChatRequest, ChatResponse};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::{oneshot, Semaphore},
    task::JoinHandle,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    token: String,
    request: ChatRequest,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Invocation {
    host_id: String,
    request: ChatRequest,
}
struct Shared {
    active: AtomicBool,
    pending: Mutex<HashMap<String, oneshot::Sender<ChatResponse>>>,
    completed: Mutex<HashMap<String, ChatResponse>>,
    fingerprints: Mutex<HashMap<String, [u8; 32]>>,
}
// CLI typing needs more identities than chat turns. Keep the cache bounded
// even when a conversation mutation returns a large projection.
fn cached_response(response: &ChatResponse) -> ChatResponse {
    if serde_json::to_vec(response).is_ok_and(|bytes| bytes.len() <= 1024) {
        response.clone()
    } else {
        ChatResponse::failed(
            response.id.clone(),
            "This operation was already submitted. Refresh its state before continuing.",
        )
    }
}
struct PendingGuard {
    state: Arc<Shared>,
    id: String,
}
impl Drop for PendingGuard {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.state.pending.lock() {
            pending.remove(&self.id);
        }
    }
}
pub struct Bridge {
    pub address: String,
    pub token: String,
    pub allow_chat: bool,
    pub cli: Arc<crate::remote_cli::Access>,
    pub fleet: Option<Arc<crate::remote_fleet::Access>>,
    shared: Arc<Shared>,
    task: JoinHandle<()>,
}
impl Bridge {
    #[cfg(test)]
    pub(crate) async fn fleet_fixture(access: Arc<crate::remote_fleet::Access>) -> Arc<Self> {
        let owner = Arc::new(std::sync::OnceLock::<std::sync::Weak<Self>>::new());
        let reply_owner = owner.clone();
        let dispatch_access = access.clone();
        let mut bridge = Self::start_dispatch(Arc::new(move |request| {
            let (owner, access) = (reply_owner.clone(), dispatch_access.clone());
            tokio::spawn(async move {
                let lattice_remote::chat_protocol::ChatOperation::Fleet { request: call } =
                    request.operation
                else {
                    return;
                };
                let response = match access.perform(call).await {
                    Ok(value) => ChatResponse {
                        id: request.id,
                        value,
                        error: None,
                    },
                    Err(error) => ChatResponse::failed(request.id, &error),
                };
                if let Some(bridge) = owner.get().and_then(std::sync::Weak::upgrade) {
                    let _ = bridge.reply(response);
                }
            });
        }))
        .await
        .unwrap();
        bridge.fleet = Some(access);
        let bridge = Arc::new(bridge);
        assert!(owner.set(Arc::downgrade(&bridge)).is_ok());
        bridge
    }

    pub async fn start(
        app: AppHandle,
        host_id: String,
        allow_chat: bool,
        allow_cli: bool,
        fleet: Option<Arc<crate::remote_fleet::Access>>,
    ) -> Result<Self, String> {
        let cli = Arc::new(crate::remote_cli::Access::new(allow_cli));
        let access = cli.clone();
        let fleet_access = fleet.clone();
        let mut bridge = Self::start_dispatch(Arc::new(move |request| {
            if request.operation.is_fleet() {
                let (app, host_id, fleet) = (app.clone(), host_id.clone(), fleet_access.clone());
                tokio::spawn(async move {
                    let lattice_remote::chat_protocol::ChatOperation::Fleet { request: call } = request.operation else { return; };
                    let result = match fleet { Some(access) => access.perform(call).await, None => Err("Fleet sharing is disabled.".into()) };
                    let response = match result { Ok(value) => ChatResponse { id: request.id, value, error: None }, Err(message) => ChatResponse::failed(request.id, &message) };
                    let registry = app.state::<Arc<crate::remote_host::RemoteHostRegistry>>();
                    let _ = crate::remote_host::chat_reply(&registry, &host_id, response);
                });
            } else if request.operation.is_cli() || !allow_chat {
                let (app, host_id, access) = (app.clone(), host_id.clone(), access.clone());
                tokio::spawn(async move {
                    let result = if request.operation.is_cli() { access.perform(&app, request.operation).await } else { Err("Conversation sharing is disabled.".into()) };
                    let response = match result {
                        Ok(value) => ChatResponse { id: request.id, value, error: None },
                        Err(_) => ChatResponse::failed(request.id, "CLI unavailable or operation failed. Check sharing permissions and refresh before sending again."),
                    };
                    let registry = app.state::<Arc<crate::remote_host::RemoteHostRegistry>>();
                    let _ = crate::remote_host::chat_reply(&registry, &host_id, response);
                });
            } else {
                let _ = app.emit("remote-host://chat", Invocation { host_id: host_id.clone(), request });
            }
        })).await?;
        bridge.allow_chat = allow_chat;
        bridge.cli = cli;
        bridge.fleet = fleet;
        Ok(bridge)
    }
    async fn start_dispatch(
        dispatch: Arc<dyn Fn(ChatRequest) + Send + Sync>,
    ) -> Result<Self, String> {
        let mut secret = [0u8; 32];
        getrandom::fill(&mut secret)
            .map_err(|_| "Cannot create the conversation bridge secret.")?;
        let token: String = secret.iter().map(|byte| format!("{byte:02x}")).collect();
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|error| error.to_string())?;
        let address = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .to_string();
        let shared = Arc::new(Shared {
            active: AtomicBool::new(true),
            pending: Mutex::new(HashMap::new()),
            completed: Mutex::new(HashMap::new()),
            fingerprints: Mutex::new(HashMap::new()),
        });
        let state = shared.clone();
        let bearer = token.clone();
        let task = tokio::spawn(async move {
            // Bound untrusted local sockets and serialize mutations from all viewers.
            let permits = Arc::new(Semaphore::new(4));
            let operations = Arc::new(tokio::sync::Mutex::new(()));
            while let Ok((mut stream, _)) = listener.accept().await {
                let Ok(permit) = permits.clone().try_acquire_owned() else {
                    continue;
                };
                let (state, bearer, dispatch, operations) = (
                    state.clone(),
                    bearer.clone(),
                    dispatch.clone(),
                    operations.clone(),
                );
                tokio::spawn(async move {
                    let _permit = permit;
                    let _ = tokio::time::timeout(Duration::from_secs(11), async {
                        let size = stream.read_u32().await.ok()? as usize;
                        if size > 24 * 1024 { return None; }
                        let mut bytes = vec![0; size];
                        stream.read_exact(&mut bytes).await.ok()?;
                        let envelope: Envelope = serde_json::from_slice(&bytes).ok()?;
                        if envelope.token != bearer || !envelope.request.valid() { return None; }
                        let _operation = operations.lock().await;
                        if !state.active.load(Ordering::Acquire) { return None; }
                        let request = envelope.request;
                        let id = request.id.clone();
                        use sha2::{Digest, Sha256};
                        let fingerprint: [u8; 32] = Sha256::digest(serde_json::to_vec(&request).ok()?).into();
                        let conflict = state.fingerprints.lock().ok()?.get(&id).is_some_and(|saved| saved != &fingerprint);
                        let cached = state.completed.lock().ok()?.get(&id).cloned();
                        let response = if conflict { ChatResponse::failed(id.clone(), "The request ID was already used for a different operation.") } else if let Some(cached) = cached { cached } else {
                            if request.mutates() && state.completed.lock().ok()?.len() >= 65536 {
                                ChatResponse::failed(id.clone(), "Restart sharing before issuing more operations.")
                            } else {
                                let (tx, rx) = oneshot::channel();
                                state.pending.lock().ok()?.insert(id.clone(), tx);
                                let _pending = PendingGuard { state: state.clone(), id: id.clone() };
                                // Reserve mutation identity before dispatch, including uncertain outcomes.
                                if request.mutates() {
                                    state.fingerprints.lock().ok()?.insert(id.clone(), fingerprint);
                                    state.completed.lock().ok()?.insert(id.clone(), ChatResponse::failed(id.clone(), "The operation was already submitted. Refresh its state before continuing."));
                                }
                                dispatch(request.clone());
                                let response = match tokio::time::timeout(Duration::from_secs(8), rx).await {
                                    Ok(Ok(response)) => response,
                                    _ => ChatResponse::failed(id.clone(), "The desktop did not acknowledge the operation. Refresh before sending again."),
                                };
                                state.pending.lock().ok()?.remove(&id);
                                if request.mutates() { state.completed.lock().ok()?.insert(id, cached_response(&response)); }
                                response
                            }
                        };
                        if !state.active.load(Ordering::Acquire) { return None; }
                        let bytes = serde_json::to_vec(&response).ok()?;
                        if bytes.len() > 60 * 1024 { return None; }
                        stream.write_u32(bytes.len() as u32).await.ok()?;
                        stream.write_all(&bytes).await.ok()?;
                        Some(())
                    }).await;
                });
            }
        });
        Ok(Self {
            address,
            token,
            allow_chat: false,
            cli: Arc::new(crate::remote_cli::Access::new(false)),
            shared,
            task,
            fleet: None,
        })
    }
    pub fn reply(&self, response: ChatResponse) -> Result<(), String> {
        if !self.shared.active.load(Ordering::Acquire)
            || !response.valid()
            || serde_json::to_vec(&response)
                .map_err(|e| e.to_string())?
                .len()
                > 60 * 1024
        {
            return Err("Conversation sharing is unavailable or the response is too large.".into());
        }
        if let Some(tx) = self
            .shared
            .pending
            .lock()
            .map_err(|e| e.to_string())?
            .remove(&response.id)
        {
            let _ = tx.send(response);
        }
        Ok(())
    }
    pub fn stop(&self) {
        self.cli.revoke();
        if let Some(fleet) = &self.fleet {
            fleet.revoke();
        }
        self.shared.active.store(false, Ordering::Release);
        self.task.abort();
        if let Ok(mut pending) = self.shared.pending.lock() {
            pending.clear();
        }
    }
}
impl Drop for Bridge {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lattice_remote::chat_protocol::ChatOperation;
    async fn call(address: String, token: String, request: ChatRequest) -> Option<ChatResponse> {
        let mut stream = tokio::net::TcpStream::connect(address).await.ok()?;
        let bytes =
            serde_json::to_vec(&serde_json::json!({"token":token,"request":request})).unwrap();
        stream.write_u32(bytes.len() as u32).await.ok()?;
        stream.write_all(&bytes).await.ok()?;
        let n = stream.read_u32().await.ok()? as usize;
        let mut bytes = vec![0; n];
        stream.read_exact(&mut bytes).await.ok()?;
        serde_json::from_slice(&bytes).ok()
    }
    #[tokio::test]
    async fn host_bridge_authenticates_deduplicates_and_revokes() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let bridge = Bridge::start_dispatch(Arc::new(move |request| {
            let _ = tx.send(request);
        }))
        .await
        .unwrap();
        let request = ChatRequest {
            id: "request-1".into(),
            operation: ChatOperation::Send {
                thread_id: "thread-1".into(),
                text: "hello".into(),
            },
        };
        assert!(
            call(bridge.address.clone(), "wrong".into(), request.clone())
                .await
                .is_none()
        );
        assert!(rx.try_recv().is_err());
        let task = tokio::spawn(call(
            bridge.address.clone(),
            bridge.token.clone(),
            request.clone(),
        ));
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), rx.recv())
                .await
                .unwrap()
                .unwrap(),
            request
        );
        let response = ChatResponse {
            id: request.id.clone(),
            value: serde_json::json!({"accepted":true}),
            error: None,
        };
        bridge.reply(response.clone()).unwrap();
        assert_eq!(task.await.unwrap(), Some(response.clone()));
        assert_eq!(
            call(
                bridge.address.clone(),
                bridge.token.clone(),
                request.clone()
            )
            .await,
            Some(response)
        );
        assert!(rx.try_recv().is_err());
        let mut conflicting = request.clone();
        conflicting.operation = ChatOperation::Stop {
            thread_id: "thread-1".into(),
            turn_id: "turn-1".into(),
        };
        let conflict = call(bridge.address.clone(), bridge.token.clone(), conflicting)
            .await
            .unwrap();
        assert!(conflict.error.is_some());
        assert!(rx.try_recv().is_err());
        bridge.stop();
        assert!(call(bridge.address.clone(), bridge.token.clone(), request)
            .await
            .is_none());
    }
}
