//! A short-lived bridge to the existing chat runtime. It never creates a thread.
use super::*;
use tokio::sync::oneshot;

#[cfg(test)]
#[path = "chat_tests.rs"]
mod tests;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DesktopChatAction {
    State {},
    Read {
        #[serde(default)]
        before: Option<String>,
    },
    Send {
        text: String,
        request_id: String,
    },
}
impl DesktopChatAction {
    pub(super) fn scope(&self) -> Scope {
        match self {
            Self::State {} => Scope::FleetObserve,
            Self::Read { .. } => Scope::FleetRead,
            Self::Send { .. } => Scope::FleetControl,
        }
    }
    pub(super) fn request_id(&self) -> Option<&str> {
        match self {
            Self::Send { request_id, .. } => Some(request_id),
            _ => None,
        }
    }
    pub(super) fn validate(&self) -> Result<(), ServiceError> {
        match self {
            Self::Read {
                before: Some(before),
            } => valid_id(before),
            Self::Send { text, request_id } => {
                valid_id(request_id)?;
                if text.trim().is_empty()
                    || text.len() > 16384
                    || text
                        .chars()
                        .any(|c| c.is_control() && c != '\n' && c != '\t')
                {
                    return Err(ServiceError::invalid());
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub id: String,
    pub target_id: String,
    pub thread_id: String,
    pub action: DesktopChatAction,
}
struct Pending {
    request: ChatRequest,
    revoked: watch::Receiver<bool>,
    reply: oneshot::Sender<Result<Value, ServiceError>>,
    claimed: bool,
    expires: Instant,
}
#[derive(Default)]
struct ChatState {
    lease: Option<(String, Instant)>,
    threads: HashMap<String, usize>,
    pending: HashMap<String, Pending>,
}
type EmitRequest = Arc<dyn Fn(&str) -> Result<(), ServiceError> + Send + Sync>;
#[derive(Default)]
pub struct ChatBridge {
    next: std::sync::atomic::AtomicUsize,
    state: Mutex<ChatState>,
    emit: Mutex<Option<EmitRequest>>,
}
const LEASE: Duration = Duration::from_secs(20);
impl ChatBridge {
    pub fn set_emitter(&self, emit: EmitRequest) {
        *self.emit.lock().unwrap() = Some(emit);
    }
    pub fn open(&self) -> Result<String, ServiceError> {
        let id = opaque_id()?;
        *self.state.lock().unwrap() = ChatState {
            lease: Some((id.clone(), Instant::now())),
            ..Default::default()
        };
        Ok(id)
    }
    fn live(state: &ChatState, nonce: Option<&str>) -> bool {
        state
            .lease
            .as_ref()
            .is_some_and(|(id, at)| at.elapsed() < LEASE && nonce.is_none_or(|n| n == id))
    }
    pub fn heartbeat(&self, nonce: &str) -> Result<(), ServiceError> {
        let mut state = self.state.lock().map_err(|_| ServiceError::failed())?;
        if !Self::live(&state, Some(nonce)) {
            return Err(ServiceError::unavailable());
        }
        state.lease.as_mut().unwrap().1 = Instant::now();
        Ok(())
    }
    pub fn close(&self, nonce: &str) {
        let mut state = self.state.lock().unwrap();
        if state.lease.as_ref().is_some_and(|(id, _)| id == nonce) {
            *state = ChatState::default();
        }
    }
    fn binding(&self, nonce: &str, thread: &str, shared: bool) -> Result<(), ServiceError> {
        let mut state = self.state.lock().map_err(|_| ServiceError::failed())?;
        if !Self::live(&state, Some(nonce)) {
            return Err(ServiceError::unavailable());
        }
        state.threads.remove(thread);
        if shared {
            if state.threads.len() >= MAX_GRANTS {
                return Err(ServiceError::denied());
            }
            state
                .threads
                .insert(thread.into(), self.next.fetch_add(1, Ordering::Relaxed) + 1);
        }
        Ok(())
    }
    pub(super) fn identity(&self, thread: &str) -> Option<usize> {
        let state = self.state.lock().ok()?;
        if !Self::live(&state, None) {
            return None;
        }
        state.threads.get(thread).copied()
    }
    pub fn claim(&self, nonce: &str, id: &str) -> Result<ChatRequest, ServiceError> {
        let mut state = self.state.lock().map_err(|_| ServiceError::failed())?;
        if !Self::live(&state, Some(nonce)) {
            return Err(ServiceError::unavailable());
        }
        let pending = state.pending.get_mut(id).ok_or_else(ServiceError::denied)?;
        if pending.claimed || *pending.revoked.borrow() || pending.expires <= Instant::now() {
            return Err(ServiceError::denied());
        }
        pending.claimed = true;
        Ok(pending.request.clone())
    }
    pub fn reply(
        &self,
        nonce: &str,
        id: &str,
        value: Value,
        error: Option<String>,
    ) -> Result<(), ServiceError> {
        let mut state = self.state.lock().map_err(|_| ServiceError::failed())?;
        if !Self::live(&state, Some(nonce)) {
            return Err(ServiceError::unavailable());
        }
        let pending = state.pending.get(id).ok_or_else(ServiceError::denied)?;
        if !pending.claimed || *pending.revoked.borrow() {
            return Err(ServiceError::denied());
        }
        let result = if let Some(error) = error {
            Err(ServiceError::new(
                "not_ready",
                &error.chars().take(250).collect::<String>(),
            ))
        } else if serde_json::to_vec(&value)
            .map_err(|_| ServiceError::invalid())?
            .len()
            > 64 * 1024
        {
            Err(ServiceError::invalid())
        } else {
            Ok(value)
        };
        let pending = state.pending.remove(id).unwrap();
        let _ = pending.reply.send(result);
        Ok(())
    }
    pub(super) async fn request(
        &self,
        grant: &Grant,
        action: DesktopChatAction,
    ) -> Result<Value, ServiceError> {
        let id = opaque_id()?;
        let (tx, rx) = oneshot::channel();
        {
            let mut state = self.state.lock().map_err(|_| ServiceError::failed())?;
            if !Self::live(&state, None) || state.pending.len() >= MAX_CALLS {
                return Err(ServiceError::unavailable());
            }
            state.pending.insert(
                id.clone(),
                Pending {
                    request: ChatRequest {
                        id: id.clone(),
                        target_id: grant.view.id.clone(),
                        thread_id: grant.session_id.clone(),
                        action,
                    },
                    revoked: grant.revoked.subscribe(),
                    reply: tx,
                    claimed: false,
                    expires: Instant::now() + Duration::from_secs(15),
                },
            );
        }
        struct Cleanup<'a>(&'a ChatBridge, String);
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                if let Ok(mut state) = self.0.state.lock() {
                    state.pending.remove(&self.1);
                }
            }
        }
        let _cleanup = Cleanup(self, id.clone());
        let emit = self
            .emit
            .lock()
            .map_err(|_| ServiceError::failed())?
            .clone()
            .ok_or_else(ServiceError::unavailable)?;
        emit(&id)?;
        tokio::time::timeout(Duration::from_secs(15), rx).await
            .map_err(|_| ServiceError::new("unknown_outcome", "The chat runtime did not confirm delivery. Read the original thread and reuse the same requestId."))?
            .map_err(|_| ServiceError::unavailable())?
    }
}
impl DesktopService {
    /// Only the main window's explicit per-thread controls call this method.
    pub async fn share_chat(
        &self,
        nonce: &str,
        thread_id: &str,
        label: &str,
        read: bool,
        control: bool,
    ) -> Result<Option<TargetView>, ServiceError> {
        self.chat.heartbeat(nonce)?;
        valid_id(thread_id)?;
        let previous: Vec<_> = self
            .state
            .lock()
            .map_err(|_| ServiceError::failed())?
            .grants
            .values()
            .filter(|g| g.view.backend == Backend::DesktopChat && g.session_id == thread_id)
            .map(|g| g.view.id.clone())
            .collect();
        for id in previous {
            self.revoke(&id)?;
        }
        self.chat.binding(nonce, thread_id, read || control)?;
        if !read && !control {
            return Ok(None);
        }
        self.grant(GrantRequest {
            session_id: thread_id.into(),
            backend: Backend::DesktopChat,
            label: label.into(),
            scopes: Scopes {
                fleet_observe: true,
                fleet_read: read,
                fleet_control: control,
                ..Default::default()
            },
            roots: vec![],
            exec_plans: vec![],
            fleet: None,
        })
        .await
        .map(Some)
    }
}
