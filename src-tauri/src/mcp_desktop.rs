//! Explicit, revocable access to connections owned by the desktop window.
//!
//! This service never connects, authenticates, accepts host keys, or reads a
//! saved profile. A desktop grant is bound to one already trusted live session.
//! Commands and absolute paths stay here; the daemon sees only redacted views.
//! SFTP path checks assume a cooperative trusted server. They are not a chroot
//! and cannot defeat another remote process changing directories between calls.

#[cfg(test)]
mod loopback_tests;
mod paths;
mod ssh_jobs;

use crate::mcp_screen::{ScreenBackend, ScreenKey};
use crate::sftp::SftpRegistry;
use crate::ssh::SshRegistry;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{watch, Semaphore};

const MAX_GRANTS: usize = 64;
const MAX_OPERATIONS: usize = 256;
const OPERATION_RETENTION: Duration = Duration::from_secs(15 * 60);
const MAX_CALLS: usize = 8;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Backend {
    Ssh,
    Sftp,
    /// Screen sessions. They share one capability — the picture the user is
    /// already looking at — and nothing else: no shell, no files.
    Rdp,
    Vnc,
    Remote,
}

impl Backend {
    pub fn is_screen(self) -> bool {
        matches!(self, Self::Rdp | Self::Vnc | Self::Remote)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    Metrics,
    List,
    Exec,
    Upload,
    Download,
    /// One still picture of the shared screen, on request. Never a stream,
    /// and never keyboard or pointer input.
    Screen,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scopes {
    #[serde(default)]
    pub metrics: bool,
    #[serde(default)]
    pub list: bool,
    #[serde(default)]
    pub exec: bool,
    #[serde(default)]
    pub upload: bool,
    #[serde(default)]
    pub download: bool,
    #[serde(default)]
    pub screen: bool,
}

impl Scopes {
    pub fn allows(&self, scope: Scope) -> bool {
        match scope {
            Scope::Metrics => self.metrics,
            Scope::List => self.list,
            Scope::Exec => self.exec,
            Scope::Upload => self.upload,
            Scope::Download => self.download,
            Scope::Screen => self.screen,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecPlan {
    pub id: String,
    pub label: String,
    pub command: String,
    pub timeout_ms: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RootRequest {
    pub id: String,
    pub label: String,
    pub remote_path: String,
    #[serde(default)]
    pub local_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GrantRequest {
    pub session_id: String,
    pub backend: Backend,
    pub label: String,
    pub scopes: Scopes,
    #[serde(default)]
    pub exec_plans: Vec<ExecPlan>,
    #[serde(default)]
    pub roots: Vec<RootRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NamedView {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TargetView {
    pub id: String,
    pub label: String,
    pub backend: Backend,
    pub scopes: Scopes,
    pub plans: Vec<NamedView>,
    pub roots: Vec<NamedView>,
    pub connected: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TransferDirection {
    Upload,
    Download,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DesktopOperation {
    ListConnections,
    GetMetrics {
        target_id: String,
    },
    CaptureScreen {
        target_id: String,
    },
    ListDirectory {
        target_id: String,
        root_id: String,
        path: String,
    },
    Exec {
        target_id: String,
        plan_id: String,
        request_id: String,
    },
    Transfer {
        target_id: String,
        root_id: String,
        direction: TransferDirection,
        local_path: String,
        remote_path: String,
        request_id: String,
    },
    Cancel {
        target_id: String,
        operation_id: String,
        request_id: String,
    },
    OperationStatus {
        target_id: String,
        operation_id: String,
    },
}

impl DesktopOperation {
    pub fn target_id(&self) -> Option<&str> {
        match self {
            Self::ListConnections => None,
            Self::GetMetrics { target_id }
            | Self::CaptureScreen { target_id }
            | Self::ListDirectory { target_id, .. }
            | Self::Exec { target_id, .. }
            | Self::Transfer { target_id, .. }
            | Self::Cancel { target_id, .. }
            | Self::OperationStatus { target_id, .. } => Some(target_id),
        }
    }

    pub fn required_scope(&self) -> Option<Scope> {
        match self {
            Self::GetMetrics { .. } => Some(Scope::Metrics),
            Self::CaptureScreen { .. } => Some(Scope::Screen),
            Self::ListDirectory { .. } => Some(Scope::List),
            Self::Exec { .. } => Some(Scope::Exec),
            Self::Transfer {
                direction: TransferDirection::Upload,
                ..
            } => Some(Scope::Upload),
            Self::Transfer {
                direction: TransferDirection::Download,
                ..
            } => Some(Scope::Download),
            // Cancellation/status require ownership of the original operation.
            Self::ListConnections | Self::Cancel { .. } | Self::OperationStatus { .. } => None,
        }
    }

    fn request_id(&self) -> Option<&str> {
        match self {
            Self::Exec { request_id, .. }
            | Self::Transfer { request_id, .. }
            | Self::Cancel { request_id, .. } => Some(request_id),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ServiceError {
    pub code: String,
    pub message: String,
}

impl ServiceError {
    fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    fn invalid() -> Self {
        Self::new(
            "invalid_request",
            "The operation or approved configuration is invalid.",
        )
    }

    fn denied() -> Self {
        Self::new(
            "not_authorized",
            "This connection or operation is not shared, or its grant was revoked.",
        )
    }

    fn unavailable() -> Self {
        Self::new(
            "needs_user_action",
            "Connect and verify this session in LatticeTerm before sharing it.",
        )
    }

    fn failed() -> Self {
        Self::new(
            "operation_failed",
            "The remote operation failed; inspect the connection in LatticeTerm.",
        )
    }
}

impl std::fmt::Display for ServiceError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ServiceError {}

struct Grant {
    view: TargetView,
    session_id: String,
    identity: usize,
    plans: Vec<ExecPlan>,
    roots: Vec<paths::Root>,
    revoked: watch::Sender<bool>,
}

struct OperationRecord {
    id: String,
    client: String,
    request_id: String,
    target_id: String,
    fingerprint: String,
    finished_at: Option<Instant>,
    result: Option<Result<Value, ServiceError>>,
    cancel: watch::Sender<bool>,
}

#[derive(Default)]
struct State {
    grants: HashMap<String, Arc<Grant>>,
    operations: HashMap<String, OperationRecord>,
    /// When each target last handed over a picture.
    captures: HashMap<String, Instant>,
}

pub struct DesktopService {
    ssh: Arc<SshRegistry>,
    sftp: Arc<SftpRegistry>,
    rdp: Arc<crate::rdp::RdpRegistry>,
    vnc: Arc<crate::vnc::VncRegistry>,
    remote: Arc<crate::remote::RemoteRegistry>,
    screens: Arc<crate::mcp_screen::ScreenFrames>,
    state: Arc<Mutex<State>>,
    calls: Arc<Semaphore>,
}

impl DesktopService {
    /// Shell and file access only. Screens stay unavailable until
    /// [`Self::with_screens`] names the registries that own them.
    pub fn new(ssh: Arc<SshRegistry>, sftp: Arc<SftpRegistry>) -> Self {
        Self {
            ssh,
            sftp,
            rdp: Arc::new(crate::rdp::RdpRegistry::new()),
            vnc: Arc::new(crate::vnc::VncRegistry::new()),
            remote: Arc::new(crate::remote::RemoteRegistry::new()),
            screens: Arc::new(crate::mcp_screen::ScreenFrames::default()),
            state: Arc::new(Mutex::new(State::default())),
            calls: Arc::new(Semaphore::new(MAX_CALLS)),
        }
    }

    pub fn with_screens(
        mut self,
        rdp: Arc<crate::rdp::RdpRegistry>,
        vnc: Arc<crate::vnc::VncRegistry>,
        remote: Arc<crate::remote::RemoteRegistry>,
        screens: Arc<crate::mcp_screen::ScreenFrames>,
    ) -> Self {
        self.rdp = rdp;
        self.vnc = vnc;
        self.remote = remote;
        self.screens = screens;
        self
    }

    fn identity(&self, backend: Backend, session_id: &str) -> Option<usize> {
        match backend {
            Backend::Ssh => self
                .ssh
                .session_handle(session_id)
                .filter(|handle| !handle.is_closed())
                .map(|handle| Arc::as_ptr(&handle) as usize),
            Backend::Sftp => self
                .sftp
                .connected_session(session_id)
                .map(|handle| Arc::as_ptr(&handle) as usize),
            // One run of one screen session, as its own registry sees it.
            // A reconnection under the same id is a different run, so the
            // grant goes offline rather than following the new screen.
            Backend::Rdp => self
                .rdp
                .screen_generation(session_id)
                .map(|generation| generation as usize),
            Backend::Vnc => self
                .vnc
                .screen_generation(session_id)
                .map(|generation| generation as usize),
            Backend::Remote => self
                .remote
                .screen_generation(session_id)
                .map(|generation| generation as usize),
        }
    }

    fn connected(&self, grant: &Grant) -> bool {
        if *grant.revoked.borrow() {
            return false;
        }
        if self.identity(grant.view.backend, &grant.session_id) != Some(grant.identity) {
            // Offline is terminal for this grant, even if a registry later
            // presents the same ID/handle again. Wake pending jobs immediately;
            // only a new explicit desktop grant can restore access.
            grant.revoked.send_replace(true);
            if let Some(key) = self.screen_key(grant) {
                self.screens.disarm(&key);
            }
            return false;
        }
        true
    }

    pub async fn grant(&self, request: GrantRequest) -> Result<TargetView, ServiceError> {
        validate_grant(&request)?;
        let identity = self
            .identity(request.backend, &request.session_id)
            .ok_or_else(ServiceError::unavailable)?;
        let mut roots = Vec::new();
        for root in &request.roots {
            let session = self
                .sftp
                .session(&request.session_id)
                .map_err(|_| ServiceError::unavailable())?;
            roots.push(paths::prepare_root(&session, root).await?);
        }
        let view = TargetView {
            id: opaque_id()?,
            label: request.label,
            backend: request.backend,
            scopes: request.scopes,
            plans: request
                .exec_plans
                .iter()
                .map(|plan| NamedView {
                    id: plan.id.clone(),
                    label: plan.label.clone(),
                })
                .collect(),
            roots: request
                .roots
                .iter()
                .map(|root| NamedView {
                    id: root.id.clone(),
                    label: root.label.clone(),
                })
                .collect(),
            connected: true,
        };
        if self.identity(request.backend, &request.session_id) != Some(identity) {
            return Err(ServiceError::unavailable());
        }
        let grant = Arc::new(Grant {
            view: view.clone(),
            session_id: request.session_id,
            identity,
            plans: request.exec_plans,
            roots,
            revoked: watch::channel(false).0,
        });
        let mut state = self.state.lock().map_err(|_| ServiceError::failed())?;
        if state.grants.len() >= MAX_GRANTS {
            return Err(ServiceError::new(
                "capacity",
                "Too many shared connections; revoke one before adding another.",
            ));
        }
        if let Some(key) = self.screen_key(&grant) {
            self.screens.arm(&key);
            // A disconnect may have run its cleanup before arm acquired the
            // frame lock. Recheck after arming so it cannot leave retention on.
            if !self.connected(&grant) {
                self.screens.disarm(&key);
                return Err(ServiceError::unavailable());
            }
        }
        state.grants.insert(view.id.clone(), grant);
        Ok(view)
    }

    pub fn revoke(&self, target_id: &str) -> Result<(), ServiceError> {
        let mut state = self.state.lock().map_err(|_| ServiceError::failed())?;
        if let Some(grant) = state.grants.remove(target_id) {
            grant.revoked.send_replace(true);
            self.stop_retaining(&state, &grant);
        }
        state.captures.remove(target_id);
        for operation in state
            .operations
            .values()
            .filter(|operation| operation.target_id == target_id)
        {
            operation.cancel.send_replace(true);
        }
        Ok(())
    }

    fn screen_key(&self, grant: &Grant) -> Option<ScreenKey> {
        let backend = match grant.view.backend {
            Backend::Rdp => ScreenBackend::Rdp,
            Backend::Vnc => ScreenBackend::Vnc,
            Backend::Remote => ScreenBackend::Remote,
            _ => return None,
        };
        Some(ScreenKey::new(
            backend,
            &grant.session_id,
            grant.identity as u64,
        ))
    }

    /// A screen keeps being copied only while some grant still shares it.
    fn stop_retaining(&self, state: &State, grant: &Grant) {
        let Some(key) = self.screen_key(grant) else {
            return;
        };
        let shared_elsewhere = state
            .grants
            .values()
            .any(|other| !*other.revoked.borrow() && self.screen_key(other).as_ref() == Some(&key));
        if !shared_elsewhere {
            self.screens.disarm(&key);
        }
    }

    pub fn revoke_all(&self) {
        if let Ok(mut state) = self.state.lock() {
            for (_, grant) in state.grants.drain() {
                grant.revoked.send_replace(true);
                if let Some(key) = self.screen_key(&grant) {
                    self.screens.disarm(&key);
                }
            }
            state.captures.clear();
            for operation in state.operations.values() {
                operation.cancel.send_replace(true);
            }
        }
    }

    pub fn targets(&self) -> Vec<TargetView> {
        let Ok(state) = self.state.lock() else {
            return Vec::new();
        };
        let mut views: Vec<_> = state
            .grants
            .values()
            .map(|grant| {
                let mut view = grant.view.clone();
                view.connected = self.connected(grant);
                view
            })
            .collect();
        views.sort_by(|left, right| left.id.cmp(&right.id));
        views
    }

    fn authorized(&self, operation: &DesktopOperation) -> Result<Arc<Grant>, ServiceError> {
        let id = operation.target_id().ok_or_else(ServiceError::invalid)?;
        let state = self.state.lock().map_err(|_| ServiceError::failed())?;
        let grant = state.grants.get(id).ok_or_else(ServiceError::denied)?;
        if *grant.revoked.borrow()
            || operation
                .required_scope()
                .is_some_and(|scope| !grant.view.scopes.allows(scope))
        {
            return Err(ServiceError::denied());
        }
        if !self.connected(grant) {
            return Err(ServiceError::unavailable());
        }
        Ok(Arc::clone(grant))
    }

    pub async fn execute(
        self: &Arc<Self>,
        client: &str,
        operation: DesktopOperation,
    ) -> Result<Value, ServiceError> {
        if client.is_empty() || client.len() > 512 || client.chars().any(char::is_control) {
            return Err(ServiceError::invalid());
        }
        if matches!(operation, DesktopOperation::ListConnections) {
            return Ok(json!({ "connections": self.targets(), "desktopRequired": true }));
        }
        let grant = self.authorized(&operation)?;
        self.preflight(client, &grant, &operation)?;
        if let DesktopOperation::OperationStatus { operation_id, .. } = &operation {
            let result = self.operation_status(client, &grant.view.id, operation_id);
            return self.authorized(&operation).and(result);
        }
        let mut lease = if let Some(request_id) = operation.request_id() {
            match self.reserve(client, request_id, &grant.view.id, &operation)? {
                Reservation::Replay(value) => return self.authorized(&operation).and(value),
                Reservation::New(lease) => Some(lease),
            }
        } else {
            None
        };
        if matches!(
            operation,
            DesktopOperation::Exec { .. } | DesktopOperation::Transfer { .. }
        ) {
            let mut lease = lease.ok_or_else(ServiceError::invalid)?;
            let permit = match Arc::clone(&self.calls).try_acquire_owned() {
                Ok(permit) => permit,
                Err(_) => {
                    let error =
                        ServiceError::new("busy", "The desktop operation limit has been reached.");
                    lease.finish(Err(error.clone()));
                    return Err(error);
                }
            };
            let response =
                json!({ "operationId": lease.id, "state": "running", "duplicate": false });
            let service = Arc::clone(self);
            tokio::spawn(async move {
                let _permit = permit;
                let result = match service.authorized(&operation) {
                    Ok(_) => service.run(&grant, &operation, Some(&lease)).await,
                    Err(error) => Err(error),
                };
                let result = service.authorized(&operation).and(result);
                lease.finish(result);
            });
            return Ok(response);
        }
        let result = if let DesktopOperation::Cancel { operation_id, .. } = &operation {
            self.cancel(client, &grant.view.id, operation_id)
        } else {
            match self.calls.try_acquire() {
                Ok(_permit) => self.run(&grant, &operation, lease.as_ref()).await,
                Err(_) => Err(ServiceError::new(
                    "busy",
                    "The desktop operation limit has been reached.",
                )),
            }
        };
        // Never disclose a fresh read or a cached write result after revocation.
        let result = self.authorized(&operation).and(result);
        if let Some(lease) = lease.as_mut() {
            lease.finish(result.clone());
        }
        result
    }

    /// Reject invalid target/configuration identifiers before they can consume
    /// the finite write ledger. Network-dependent failures remain recorded.
    fn preflight(
        &self,
        client: &str,
        grant: &Grant,
        operation: &DesktopOperation,
    ) -> Result<(), ServiceError> {
        match operation {
            // Nothing to check beyond the scope and the live stream: a
            // capture names no plan, path or file.
            DesktopOperation::CaptureScreen { .. } => {}
            DesktopOperation::Exec { plan_id, .. } => {
                if !grant.plans.iter().any(|plan| plan.id == *plan_id) {
                    return Err(ServiceError::denied());
                }
            }
            DesktopOperation::ListDirectory { root_id, path, .. } => {
                if !grant.roots.iter().any(|root| root.id == *root_id) {
                    return Err(ServiceError::denied());
                }
                paths::preflight_directory(path)?;
            }
            DesktopOperation::Transfer {
                root_id,
                local_path,
                remote_path,
                ..
            } => {
                if !grant.roots.iter().any(|root| root.id == *root_id) {
                    return Err(ServiceError::denied());
                }
                paths::preflight_transfer(local_path, remote_path)?;
            }
            DesktopOperation::Cancel { operation_id, .. }
            | DesktopOperation::OperationStatus { operation_id, .. } => {
                valid_id(operation_id)?;
                let state = self.state.lock().map_err(|_| ServiceError::failed())?;
                if !state
                    .operations
                    .get(operation_id)
                    .is_some_and(|entry| entry.client == client && entry.target_id == grant.view.id)
                {
                    return Err(ServiceError::denied());
                }
            }
            DesktopOperation::ListConnections | DesktopOperation::GetMetrics { .. } => {}
        }
        Ok(())
    }

    async fn run(
        &self,
        grant: &Grant,
        operation: &DesktopOperation,
        lease: Option<&OperationLease>,
    ) -> Result<Value, ServiceError> {
        let mut revoked = grant.revoked.subscribe();
        let mut cancel = lease
            .map(|lease| lease.cancel.subscribe())
            .unwrap_or_else(|| watch::channel(false).1);
        let work = async {
            match operation {
                DesktopOperation::GetMetrics { .. } => {
                    let metrics = crate::metrics::collect_for_session(&self.ssh, &grant.session_id)
                        .await
                        .map_err(metrics_error)?;
                    Ok(json!({ "metrics": metrics_view(metrics), "platform": "linux" }))
                }
                DesktopOperation::CaptureScreen { .. } => self.capture_screen(grant),
                DesktopOperation::ListDirectory { root_id, path, .. } => {
                    let root = grant
                        .roots
                        .iter()
                        .find(|root| root.id == *root_id)
                        .ok_or_else(ServiceError::denied)?;
                    paths::list_directory(&self.sftp, &grant.session_id, root, path).await
                }
                DesktopOperation::Exec { plan_id, .. } => {
                    let plan = grant
                        .plans
                        .iter()
                        .find(|plan| plan.id == *plan_id)
                        .ok_or_else(ServiceError::denied)?;
                    let handle = self
                        .ssh
                        .session_handle(&grant.session_id)
                        .ok_or_else(ServiceError::unavailable)?;
                    let lease = lease.ok_or_else(ServiceError::invalid)?;
                    ssh_jobs::execute(
                        handle,
                        plan,
                        &lease.id,
                        grant.revoked.subscribe(),
                        lease.cancel.subscribe(),
                    )
                    .await
                }
                DesktopOperation::Transfer {
                    root_id,
                    direction,
                    local_path,
                    remote_path,
                    ..
                } => {
                    let root = grant
                        .roots
                        .iter()
                        .find(|root| root.id == *root_id)
                        .ok_or_else(ServiceError::denied)?;
                    let lease = lease.ok_or_else(ServiceError::invalid)?;
                    let result = paths::transfer(
                        &self.sftp,
                        &grant.session_id,
                        root,
                        *direction,
                        local_path,
                        remote_path,
                        grant.revoked.subscribe(),
                        lease.cancel.subscribe(),
                    )
                    .await?;
                    Ok(
                        json!({ "operationId": lease.id, "state": "completed", "bytes": result["count"], "sha256": result["sha256"], "overwrite": false }),
                    )
                }
                _ => Err(ServiceError::invalid()),
            }
        };
        // Exec closes its dedicated channel itself, preserving partial output.
        if matches!(operation, DesktopOperation::Exec { .. }) {
            return work.await;
        }
        tokio::select! {
            biased;
            _ = cancelled(&mut revoked) => Err(ServiceError::denied()),
            _ = cancelled(&mut cancel), if lease.is_some() => Err(ServiceError::new("unknown_outcome", "Cancellation requested; a remote write may already have taken effect.")),
            result = tokio::time::timeout(Duration::from_secs(if lease.is_some() { 60 } else { 10 }), work) => result.map_err(|_| ServiceError::new(if lease.is_some() { "unknown_outcome" } else { "timed_out" }, "The operation deadline elapsed; check its status before retrying."))?,
        }
    }

    fn reserve(
        &self,
        client: &str,
        request_id: &str,
        target_id: &str,
        operation: &DesktopOperation,
    ) -> Result<Reservation, ServiceError> {
        valid_id(request_id)?;
        let fingerprint =
            sha256(&serde_json::to_vec(operation).map_err(|_| ServiceError::invalid())?);
        let mut state = self.state.lock().map_err(|_| ServiceError::failed())?;
        state.operations.retain(|_, operation| {
            operation
                .finished_at
                .is_none_or(|time| time.elapsed() < OPERATION_RETENTION)
        });
        if let Some(existing) = state
            .operations
            .values()
            .find(|entry| entry.client == client && entry.request_id == request_id)
        {
            if existing.fingerprint != fingerprint {
                return Err(ServiceError::new(
                    "request_conflict",
                    "This request ID was already used for a different operation.",
                ));
            }
            return Ok(Reservation::Replay(replay(existing)));
        }
        // Never evict unexpired entries and accidentally allow a second write.
        if state.operations.len() >= MAX_OPERATIONS {
            return Err(ServiceError::new(
                "capacity",
                "The operation ledger is full; wait for its retention period.",
            ));
        }
        let id = opaque_id()?;
        let cancel = watch::channel(false).0;
        state.operations.insert(
            id.clone(),
            OperationRecord {
                id: id.clone(),
                client: client.into(),
                request_id: request_id.into(),
                target_id: target_id.into(),
                fingerprint,
                finished_at: None,
                result: None,
                cancel: cancel.clone(),
            },
        );
        Ok(Reservation::New(OperationLease {
            id,
            state: Arc::clone(&self.state),
            cancel,
            finished: false,
        }))
    }

    fn operation_status(
        &self,
        client: &str,
        target_id: &str,
        id: &str,
    ) -> Result<Value, ServiceError> {
        let state = self.state.lock().map_err(|_| ServiceError::failed())?;
        let entry = state
            .operations
            .get(id)
            .filter(|entry| {
                entry.client == client
                    && entry.target_id == target_id
                    && entry
                        .finished_at
                        .is_none_or(|time| time.elapsed() < OPERATION_RETENTION)
            })
            .ok_or_else(|| {
                ServiceError::new(
                    "unknown_outcome",
                    "No retained operation is available for this client and target.",
                )
            })?;
        replay(entry)
    }

    fn cancel(&self, client: &str, target_id: &str, id: &str) -> Result<Value, ServiceError> {
        let state = self.state.lock().map_err(|_| ServiceError::failed())?;
        let entry = state
            .operations
            .get(id)
            .filter(|entry| entry.client == client && entry.target_id == target_id)
            .ok_or_else(ServiceError::denied)?;
        if entry.result.is_some() {
            return replay(entry);
        }
        entry.cancel.send_replace(true);
        Ok(
            json!({ "operationId": id, "state": "cancelRequested", "remoteProcessTerminationConfirmed": false }),
        )
    }
}

impl Drop for DesktopService {
    fn drop(&mut self) {
        self.revoke_all();
    }
}

enum Reservation {
    Replay(Result<Value, ServiceError>),
    New(OperationLease),
}

struct OperationLease {
    id: String,
    state: Arc<Mutex<State>>,
    cancel: watch::Sender<bool>,
    finished: bool,
}

impl OperationLease {
    fn finish(&mut self, result: Result<Value, ServiceError>) {
        if let Ok(mut state) = self.state.lock() {
            if let Some(entry) = state.operations.get_mut(&self.id) {
                entry.result = Some(result);
                entry.finished_at = Some(Instant::now());
            }
        }
        self.finished = true;
    }
}

impl Drop for OperationLease {
    fn drop(&mut self) {
        if !self.finished {
            self.cancel.send_replace(true);
            self.finish(Err(ServiceError::new(
                "unknown_outcome",
                "The operation was interrupted; do not blindly repeat it.",
            )));
        }
    }
}

fn replay(entry: &OperationRecord) -> Result<Value, ServiceError> {
    match &entry.result {
        Some(Ok(result)) => {
            let mut result = result.clone();
            if let Some(object) = result.as_object_mut() {
                object.insert("duplicate".into(), json!(true));
            }
            Ok(result)
        }
        Some(Err(error)) => Err(error.clone()),
        None => Ok(json!({ "operationId": entry.id, "state": "running", "duplicate": true })),
    }
}

async fn cancelled(receiver: &mut watch::Receiver<bool>) {
    if *receiver.borrow() {
        return;
    }
    while receiver.changed().await.is_ok() {
        if *receiver.borrow() {
            return;
        }
    }
    // A dropped sender means its owner is gone, not permission to continue.
}

fn valid_id(id: &str) -> Result<(), ServiceError> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(ServiceError::invalid());
    }
    Ok(())
}

fn label(label: &str) -> bool {
    !label.trim().is_empty() && label.chars().count() <= 128 && !label.chars().any(char::is_control)
}

fn validate_grant(request: &GrantRequest) -> Result<(), ServiceError> {
    if !label(&request.label)
        || request.session_id.is_empty()
        || request.session_id.len() > 128
        || request.exec_plans.len() > 16
        || request.roots.len() > 8
    {
        return Err(ServiceError::invalid());
    }
    if request.backend.is_screen()
        && (!request.scopes.screen
            || request.scopes.metrics
            || request.scopes.list
            || request.scopes.exec
            || request.scopes.upload
            || request.scopes.download
            || !request.exec_plans.is_empty()
            || !request.roots.is_empty())
    {
        return Err(ServiceError::invalid());
    }
    if !request.backend.is_screen() && request.scopes.screen {
        return Err(ServiceError::invalid());
    }
    if (request.backend == Backend::Ssh
        && (request.scopes.list
            || request.scopes.upload
            || request.scopes.download
            || !request.roots.is_empty()))
        || (request.backend == Backend::Sftp
            && (request.scopes.metrics || request.scopes.exec || !request.exec_plans.is_empty()))
    {
        return Err(ServiceError::invalid());
    }
    let mut ids = std::collections::HashSet::new();
    for plan in &request.exec_plans {
        valid_id(&plan.id)?;
        if !ids.insert(&plan.id)
            || !label(&plan.label)
            || plan.command.is_empty()
            || plan.command.len() > 8192
            || plan.command.contains('\0')
            || !(100..=60_000).contains(&plan.timeout_ms)
        {
            return Err(ServiceError::invalid());
        }
    }
    ids.clear();
    for root in &request.roots {
        valid_id(&root.id)?;
        if !ids.insert(&root.id)
            || !label(&root.label)
            || ((request.scopes.upload || request.scopes.download) && root.local_path.is_none())
        {
            return Err(ServiceError::invalid());
        }
    }
    if (request.scopes.exec && request.exec_plans.is_empty())
        || ((request.scopes.list || request.scopes.upload || request.scopes.download)
            && request.roots.is_empty())
    {
        return Err(ServiceError::invalid());
    }
    Ok(())
}

fn opaque_id() -> Result<String, ServiceError> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| ServiceError::failed())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// One still picture per this often, per target. A screen is the user's
/// desktop: a client that wants to watch must ask again, visibly, rather
/// than stream.
const SCREEN_CAPTURE_INTERVAL: Duration = Duration::from_secs(2);

impl DesktopService {
    fn capture_screen(&self, grant: &Grant) -> Result<Value, ServiceError> {
        {
            let mut state = self.state.lock().map_err(|_| ServiceError::failed())?;
            let last = state.captures.get(&grant.view.id).copied();
            if last.is_some_and(|at| at.elapsed() < SCREEN_CAPTURE_INTERVAL) {
                return Err(ServiceError::new(
                    "busy",
                    "One screen capture every two seconds; ask again in a moment.",
                ));
            }
            state.captures.insert(grant.view.id.clone(), Instant::now());
        }
        let frame = self
            .screens
            .latest(&self.screen_key(grant).ok_or_else(ServiceError::invalid)?)
            .map_err(|missing| match missing {
                crate::mcp_screen::Missing::NotYet => ServiceError::new(
                    "not_ready",
                    "This screen has not produced a frame yet; ask again shortly.",
                ),
                crate::mcp_screen::Missing::Oversized => ServiceError::new(
                    "unsupported",
                    "This screen's frames are too large to hand over whole; lower the remote resolution or colour depth.",
                ),
            })?;
        Ok(json!({
            "frameId": frame.frame_id,
            "capturedAt": frame.at,
            "width": frame.width,
            "height": frame.height,
            "mimeType": frame.mime_type,
            "base64": base64::engine::general_purpose::STANDARD.encode(&frame.bytes),
        }))
    }
}

/// A host that is not Linux will never answer this probe, so say that
/// instead of "the operation failed": one is worth retrying, the other is
/// not. The probe's own words are not passed through; they can mention the
/// commands it ran.
fn metrics_error(reason: String) -> ServiceError {
    if reason.contains("Linux") {
        ServiceError::new(
            "unsupported",
            "Resource readings need a Linux host; this connection did not report Linux /proc data.",
        )
    } else {
        ServiceError::failed()
    }
}

/// Deliberately separate from the desktop metrics DTO. No server-supplied
/// text (CPU model, mountpoint, filesystem, host or account) crosses MCP.
/// Disk labels are snapshot-local ordinals, not stable device identifiers;
/// capacities stay per entry because mountpoints may refer to the same disk.
fn metrics_view(metrics: crate::metrics::HostMetricsPayload) -> Value {
    let memory = |value: crate::metrics::MemoryPayload| json!({ "totalBytes": value.total_bytes, "usedBytes": value.used_bytes });
    let disks: Vec<_> = metrics
        .disks
        .into_iter()
        .take(16)
        .enumerate()
        .map(|(index, disk)| {
            json!({
                "id": format!("disk-{}", index + 1),
                "totalBytes": disk.total_bytes,
                "usedBytes": disk.used_bytes,
            })
        })
        .collect();
    json!({
        "collectedAt": metrics.collected_at,
        "uptimeSeconds": metrics.uptime_seconds,
        "cpu": {
            "usagePercent": metrics.cpu.usage_percent,
            "cores": metrics.cpu.cores,
            "loadAverage": metrics.cpu.load_average,
        },
        "memory": memory(metrics.memory),
        "swap": metrics.swap.map(memory),
        "disks": disks,
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn revoking_one_of_two_grants_keeps_only_the_still_shared_screen() {
        use super::*;
        let service =
            DesktopService::new(Arc::new(SshRegistry::new()), Arc::new(SftpRegistry::new()));
        let grant = |id: &str| {
            Arc::new(Grant {
                view: TargetView {
                    id: id.into(),
                    label: "test screen".into(),
                    backend: Backend::Rdp,
                    scopes: Scopes {
                        screen: true,
                        ..Scopes::default()
                    },
                    plans: vec![],
                    roots: vec![],
                    connected: true,
                },
                session_id: "same-screen".into(),
                identity: 1,
                plans: vec![],
                roots: vec![],
                revoked: watch::channel(false).0,
            })
        };
        let first = grant("one");
        let second = grant("two");
        let key = service.screen_key(&first).unwrap();
        service.screens.arm(&key);
        service.screens.offer(&key, 1, 1, 1, "image/jpeg", &[7]);
        {
            let mut state = service.state.lock().unwrap();
            state.grants.insert("one".into(), first);
            state.grants.insert("two".into(), second);
        }
        service.revoke("one").unwrap();
        assert_eq!(service.screens.latest(&key).unwrap().bytes, vec![7]);
        service.revoke("two").unwrap();
        assert!(!service.screens.is_armed(&key));
        assert_eq!(
            service.screens.latest(&key),
            Err(crate::mcp_screen::Missing::NotYet)
        );
    }

    #[tokio::test]
    async fn a_screen_grant_needs_a_live_screen_and_shares_nothing_else() {
        use super::{Backend, GrantRequest, Scopes};
        let screens = std::sync::Arc::new(crate::mcp_screen::ScreenFrames::default());
        let service = std::sync::Arc::new(
            super::DesktopService::new(
                std::sync::Arc::new(crate::ssh::SshRegistry::new()),
                std::sync::Arc::new(crate::sftp::SftpRegistry::new()),
            )
            .with_screens(
                std::sync::Arc::new(crate::rdp::RdpRegistry::new()),
                std::sync::Arc::new(crate::vnc::VncRegistry::new()),
                std::sync::Arc::new(crate::remote::RemoteRegistry::new()),
                std::sync::Arc::clone(&screens),
            ),
        );
        let request = |scopes: Scopes| GrantRequest {
            session_id: "rdp-session".into(),
            backend: Backend::Rdp,
            label: "desk".into(),
            scopes,
            exec_plans: Vec::new(),
            roots: Vec::new(),
        };

        // A screen grant carries the screen scope and nothing else.
        let mixed = Scopes {
            screen: true,
            metrics: true,
            ..Scopes::default()
        };
        assert_eq!(
            service.grant(request(mixed)).await.unwrap_err().code,
            "invalid_request"
        );
        // Shell and file connections cannot claim the screen scope either.
        let mut shell = request(Scopes {
            screen: true,
            ..Scopes::default()
        });
        shell.backend = Backend::Ssh;
        assert_eq!(
            service.grant(shell).await.unwrap_err().code,
            "invalid_request"
        );

        // With no live screen session there is nothing to share, and
        // nothing starts being retained.
        let only_screen = Scopes {
            screen: true,
            ..Scopes::default()
        };
        assert_eq!(
            service.grant(request(only_screen)).await.unwrap_err().code,
            "needs_user_action"
        );
        assert!(!screens.is_armed(&crate::mcp_screen::ScreenKey::new(
            crate::mcp_screen::ScreenBackend::Rdp,
            "rdp-session",
            1
        )));
    }

    #[test]
    fn a_host_without_linux_metrics_is_unsupported_rather_than_a_failure() {
        use super::metrics_error;
        let unsupported = metrics_error(
            "The host did not report Linux /proc data — resource readings need a Linux host."
                .to_string(),
        );
        assert_eq!(unsupported.code, "unsupported");
        // The probe's own words never reach the client: they name commands.
        assert!(!unsupported.message.contains("/proc data —"));

        let broken = metrics_error("could not open a channel: closed".to_string());
        assert_eq!(broken.code, "operation_failed");
    }

    use super::*;

    fn service() -> Arc<DesktopService> {
        Arc::new(DesktopService::new(
            Arc::new(SshRegistry::new()),
            Arc::new(SftpRegistry::new()),
        ))
    }

    fn request() -> GrantRequest {
        GrantRequest {
            session_id: "not-connected".into(),
            backend: Backend::Ssh,
            label: "測試主機".into(),
            scopes: Scopes {
                metrics: true,
                ..Scopes::default()
            },
            exec_plans: vec![],
            roots: vec![],
        }
    }

    #[tokio::test]
    async fn sharing_never_connects_or_bypasses_the_existing_trust_flow() {
        let service = service();
        assert_eq!(
            service.grant(request()).await.unwrap_err().code,
            "needs_user_action"
        );
        assert!(service.targets().is_empty());
        assert_eq!(
            service
                .execute(
                    "client",
                    DesktopOperation::GetMetrics {
                        target_id: "guessed".into()
                    }
                )
                .await
                .unwrap_err()
                .code,
            "not_authorized"
        );
    }

    #[test]
    fn observer_views_cannot_serialize_saved_commands_hosts_or_absolute_roots() {
        let view = TargetView {
            id: "opaque".into(),
            label: "Test".into(),
            backend: Backend::Ssh,
            scopes: Scopes::default(),
            plans: vec![NamedView {
                id: "test".into(),
                label: "Run tests".into(),
            }],
            roots: vec![],
            connected: true,
        };
        let object = serde_json::to_value(view).unwrap();
        assert_eq!(object.as_object().unwrap().len(), 7);
        for forbidden in [
            "sessionId",
            "host",
            "username",
            "command",
            "localPath",
            "remotePath",
        ] {
            assert!(object.get(forbidden).is_none());
        }
    }

    #[test]
    fn metrics_view_keeps_numeric_capacity_without_server_paths_or_freeform_text() {
        use crate::metrics::{CpuPayload, DiskPayload, HostMetricsPayload, MemoryPayload};

        let result = metrics_view(HostMetricsPayload {
            collected_at: 42,
            uptime_seconds: 3600,
            cpu: CpuPayload {
                usage_percent: 12.5,
                cores: 4,
                model: Some("synthetic-account: freeform server content".into()),
                load_average: Some([0.1, 0.2, 0.3]),
            },
            memory: MemoryPayload {
                total_bytes: 16_000,
                used_bytes: 8_000,
            },
            swap: Some(MemoryPayload {
                total_bytes: 4_000,
                used_bytes: 500,
            }),
            disks: vec![
                DiskPayload {
                    mountpoint: "/home/synthetic-account/private".into(),
                    filesystem: Some("synthetic-host:/private/export".into()),
                    total_bytes: 20_000,
                    used_bytes: 5_000,
                },
                DiskPayload {
                    mountpoint: "/private/second".into(),
                    filesystem: Some("/dev/private-disk".into()),
                    total_bytes: 30_000,
                    used_bytes: 10_000,
                },
            ],
        });
        assert_eq!(result["cpu"]["usagePercent"], 12.5);
        assert_eq!(result["cpu"]["cores"], 4);
        assert_eq!(result["cpu"]["loadAverage"], json!([0.1, 0.2, 0.3]));
        assert_eq!(result["memory"]["totalBytes"], 16_000);
        assert_eq!(result["swap"]["usedBytes"], 500);
        assert_eq!(
            result["disks"],
            json!([
                {"id": "disk-1", "totalBytes": 20_000, "usedBytes": 5_000},
                {"id": "disk-2", "totalBytes": 30_000, "usedBytes": 10_000},
            ])
        );
        let encoded = result.to_string();
        for forbidden in ["synthetic-", "private", "model", "mountpoint", "filesystem"] {
            assert!(
                !encoded.contains(forbidden),
                "unexpected field: {forbidden}"
            );
        }
        assert_eq!(result.as_object().unwrap().len(), 6);
        assert_eq!(result["cpu"].as_object().unwrap().len(), 3);
    }

    #[test]
    fn duplicate_writes_and_changed_arguments_do_not_execute_again() {
        let service = service();
        let operation = DesktopOperation::Exec {
            target_id: "target".into(),
            plan_id: "plan".into(),
            request_id: "r1".into(),
        };
        let Reservation::New(mut lease) = service
            .reserve("client", "r1", "target", &operation)
            .unwrap()
        else {
            panic!()
        };
        let Reservation::Replay(Ok(running)) = service
            .reserve("client", "r1", "target", &operation)
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(running["state"], "running");
        lease.finish(Ok(json!({ "operationId": lease.id, "state": "completed" })));
        let Reservation::Replay(Ok(done)) = service
            .reserve("client", "r1", "target", &operation)
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(done["duplicate"], true);
        assert!(matches!(
            service.reserve("other", "r1", "target", &operation),
            Ok(Reservation::New(_))
        ));
        let changed = DesktopOperation::Exec {
            target_id: "target".into(),
            plan_id: "different".into(),
            request_id: "r1".into(),
        };
        assert!(
            matches!(service.reserve("client", "r1", "target", &changed), Err(error) if error.code == "request_conflict")
        );
    }

    #[test]
    fn abandoned_operations_remain_unknown_and_do_not_repeat() {
        let service = service();
        let operation = DesktopOperation::Exec {
            target_id: "target".into(),
            plan_id: "plan".into(),
            request_id: "r1".into(),
        };
        drop(
            service
                .reserve("client", "r1", "target", &operation)
                .unwrap(),
        );
        assert!(
            matches!(service.reserve("client", "r1", "target", &operation), Ok(Reservation::Replay(Err(error))) if error.code == "unknown_outcome")
        );
    }

    #[tokio::test]
    async fn revocation_wakes_a_pending_operation_and_cancel_is_client_scoped() {
        let service = service();
        let operation = DesktopOperation::Exec {
            target_id: "target".into(),
            plan_id: "plan".into(),
            request_id: "r1".into(),
        };
        let Reservation::New(lease) = service
            .reserve("client", "r1", "target", &operation)
            .unwrap()
        else {
            panic!()
        };
        assert!(service.cancel("other", "target", &lease.id).is_err());
        let mut receiver = lease.cancel.subscribe();
        service.revoke("target").unwrap();
        tokio::time::timeout(Duration::from_millis(100), cancelled(&mut receiver))
            .await
            .unwrap();
    }

    #[test]
    fn scope_schema_rejects_unrecognized_permissions_and_backend_mismatches() {
        assert!(serde_json::from_value::<Scopes>(json!({ "all": true })).is_err());
        let mut request = request();
        request.scopes.upload = true;
        assert!(validate_grant(&request).is_err());
        request.scopes.upload = false;
        request.exec_plans.push(ExecPlan {
            id: "p".into(),
            label: "Test".into(),
            command: "echo test".into(),
            timeout_ms: 60_001,
        });
        assert!(validate_grant(&request).is_err());
    }
}
