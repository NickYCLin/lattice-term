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
use tauri::{AppHandle, Emitter};
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
    shared: Arc<Shared>,
    task: JoinHandle<()>,
}
impl Bridge {
    pub async fn start(app: AppHandle, host_id: String) -> Result<Self, String> {
        Self::start_dispatch(Arc::new(move |request| {
            let _ = app.emit(
                "remote-host://chat",
                Invocation {
                    host_id: host_id.clone(),
                    request,
                },
            );
        }))
        .await
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
                        let cached = state.completed.lock().ok()?.get(&id).cloned();
                        let response = if let Some(cached) = cached { cached } else {
                            if request.mutates() && state.completed.lock().ok()?.len() >= 1024 {
                                ChatResponse::failed(id.clone(), "Restart sharing before issuing more operations.")
                            } else {
                                let (tx, rx) = oneshot::channel();
                                state.pending.lock().ok()?.insert(id.clone(), tx);
                                let _pending = PendingGuard { state: state.clone(), id: id.clone() };
                                // Reserve mutation identity before dispatch, including uncertain outcomes.
                                if request.mutates() {
                                    state.completed.lock().ok()?.insert(id.clone(), ChatResponse::failed(id.clone(), "The operation was already submitted. Refresh its state before continuing."));
                                }
                                dispatch(request.clone());
                                let response = match tokio::time::timeout(Duration::from_secs(8), rx).await {
                                    Ok(Ok(response)) => response,
                                    _ => ChatResponse::failed(id.clone(), "The desktop did not acknowledge the operation. Refresh before sending again."),
                                };
                                state.pending.lock().ok()?.remove(&id);
                                if request.mutates() { state.completed.lock().ok()?.insert(id, response.clone()); }
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
            shared,
            task,
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
        bridge.stop();
        assert!(call(bridge.address.clone(), bridge.token.clone(), request)
            .await
            .is_none());
    }
}
