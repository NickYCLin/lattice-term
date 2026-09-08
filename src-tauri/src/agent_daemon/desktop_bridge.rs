//! Bounded, connection-owned reverse RPC. No credentials or arbitrary Tauri
//! commands cross this bridge. A lost desktop makes outcomes unknown; requests
//! are never replayed automatically onto a new desktop connection.
use super::{ClientRole, Frame, Request};
use crate::mcp_desktop::{DesktopOperation, TargetView};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use std::time::Duration;
use tokio::sync::{oneshot, Semaphore};

pub const PROTOCOL: u32 = 1;
const MAX_TARGETS: usize = 64;
const MAX_CALLS: usize = 16;
const MAX_REPLY: usize = 512 * 1024;
const UNKNOWN: &str = "desktop_operation_unknown: the desktop did not confirm the outcome; do not retry with a new request ID";

struct Owner {
    sender: super::server::ClientSender,
    targets: Vec<TargetView>,
    revision: u64,
}
struct Pending {
    owner: u64,
    revision: u64,
    target: String,
    reply: oneshot::Sender<Result<Value, String>>,
}
pub struct Bridge {
    attached: Mutex<std::collections::HashSet<u64>>,
    owners: Mutex<HashMap<u64, Owner>>,
    pending: Mutex<HashMap<u64, Pending>>,
    next: AtomicU64,
    allowance: Semaphore,
}
impl Default for Bridge {
    fn default() -> Self {
        Self {
            attached: Mutex::new(Default::default()),
            owners: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            next: AtomicU64::new(0),
            allowance: Semaphore::new(MAX_CALLS),
        }
    }
}
impl Bridge {
    pub fn attach(&self, owner: u64) {
        if let Ok(mut attached) = self.attached.lock() {
            attached.insert(owner);
        }
    }
    pub fn replace(
        &self,
        owner: u64,
        role: ClientRole,
        sender: super::server::ClientSender,
        targets: Vec<TargetView>,
    ) -> Result<Value, String> {
        if role != ClientRole::Desktop {
            return Err("Only the desktop may grant remote access".into());
        }
        let attached = self
            .attached
            .lock()
            .map_err(|_| "Remote bridge unavailable")?;
        if !attached.contains(&owner) {
            return Err("Desktop connection ended".into());
        }
        if targets.len() > MAX_TARGETS
            || serde_json::to_vec(&targets)
                .map_err(|_| "Invalid grants")?
                .len()
                > 64 * 1024
        {
            return Err("Too many remote grants".into());
        }
        let mut owners = self
            .owners
            .lock()
            .map_err(|_| "Remote grants unavailable")?;
        if owners
            .iter()
            .filter(|(id, _)| **id != owner)
            .map(|(_, other)| other.targets.len())
            .sum::<usize>()
            + targets.len()
            > MAX_TARGETS
        {
            return Err("Too many remote grants across desktops".into());
        }
        // An opaque target can belong to exactly one live desktop connection.
        let mut ids = std::collections::HashSet::new();
        if targets.iter().any(|target| {
            !ids.insert(&target.id)
                || target.id.is_empty()
                || target.id.len() > 128
                || !target
                    .id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                || owners.iter().any(|(id, other)| {
                    *id != owner && other.targets.iter().any(|t| t.id == target.id)
                })
        }) {
            return Err("Invalid or conflicting remote grant".into());
        }
        if owners.len() >= MAX_TARGETS && !owners.contains_key(&owner) {
            return Err("Too many desktop bridges".into());
        }
        if owners.get(&owner).is_some_and(|previous| {
            targets.iter().any(|target| {
                target.connected
                    && previous
                        .targets
                        .iter()
                        .any(|old| old.id == target.id && !old.connected)
            })
        }) {
            return Err("Offline grants require a new target ID and explicit approval".into());
        }
        let before: Vec<_> = owners
            .get(&owner)
            .map(|o| o.targets.iter().map(|t| t.id.clone()).collect())
            .unwrap_or_default();
        let after: Vec<_> = targets.iter().map(|t| t.id.clone()).collect();
        let revision = match owners.get(&owner) {
            Some(previous)
                if serde_json::to_value(&previous.targets).ok()
                    == serde_json::to_value(&targets).ok() =>
            {
                previous.revision
            }
            _ => self.next.fetch_add(1, Ordering::Relaxed) + 1,
        };
        owners.insert(
            owner,
            Owner {
                sender,
                targets,
                revision,
            },
        );
        Ok(
            json!({ "registered": true, "granted": after.iter().filter(|id| !before.contains(id)).collect::<Vec<_>>(), "revoked": before.iter().filter(|id| !after.contains(id)).collect::<Vec<_>>() }),
        )
    }

    pub fn known_target(&self, operation: &DesktopOperation) -> Option<String> {
        let id = operation.target_id()?;
        self.owners
            .lock()
            .ok()?
            .values()
            .any(|owner| owner.targets.iter().any(|target| target.id == id))
            .then(|| id.to_string())
    }

    pub fn remove(&self, owner: u64) {
        if let Ok(mut attached) = self.attached.lock() {
            attached.remove(&owner);
        }
        if let Ok(mut owners) = self.owners.lock() {
            owners.remove(&owner);
        }
        if let Ok(mut pending) = self.pending.lock() {
            let ids: Vec<_> = pending
                .iter()
                .filter(|(_, p)| p.owner == owner)
                .map(|(id, _)| *id)
                .collect();
            for id in ids {
                if let Some(p) = pending.remove(&id) {
                    let _ = p.reply.send(Err(UNKNOWN.into()));
                }
            }
        }
    }

    pub fn resolve(&self, owner: u64, role: ClientRole, id: u64, outcome: Result<Value, String>) {
        if role != ClientRole::Desktop {
            return;
        }
        let Ok(mut pending) = self.pending.lock() else {
            return;
        };
        if !pending.get(&id).is_some_and(|p| p.owner == owner) {
            return;
        }
        let Some(p) = pending.remove(&id) else {
            return;
        };
        // Withdrawn grants cannot leak a response queued before revocation.
        let authorized = self.owners.lock().ok().is_some_and(|owners| {
            owners.get(&owner).is_some_and(|o| {
                o.revision == p.revision && o.targets.iter().any(|t| t.id == p.target)
            })
        });
        let outcome = if !authorized {
            Err("Remote grant was revoked; operation outcome may be unknown".into())
        } else if match &outcome {
            Ok(value) => value.to_string().len() > MAX_REPLY,
            Err(error) => error.len() > MAX_REPLY,
        } {
            Err("Remote result exceeded its limit; operation outcome may be unknown".into())
        } else {
            outcome
        };
        let _ = p.reply.send(outcome);
    }

    pub async fn call(&self, client: &str, operation: DesktopOperation) -> Result<Value, String> {
        let _permit = self
            .allowance
            .try_acquire()
            .map_err(|_| "Too many remote operations")?;
        let route = {
            let owners = self
                .owners
                .lock()
                .map_err(|_| "Remote grants unavailable")?;
            let Some(target_id) = operation.target_id() else {
                let result = json!({"connections": owners.values().filter(|o| !o.sender.is_disconnected()).flat_map(|o| o.targets.iter()).collect::<Vec<_>>() });
                if result.to_string().len() > MAX_REPLY {
                    return Err("Remote connection list exceeded its limit".into());
                }
                return Ok(result);
            };
            let (owner_id, owner) = owners
                .iter()
                .find(|(_, owner)| {
                    !owner.sender.is_disconnected()
                        && owner.targets.iter().any(|t| t.id == target_id)
                })
                .ok_or("needs_user_action: connect and explicitly grant access in LatticeTerm")?;
            // Desktop executes the same scope check again against its own live grant.
            let target = owner
                .targets
                .iter()
                .find(|t| t.id == target_id)
                .ok_or("Remote grant unavailable")?;
            if operation
                .required_scope()
                .is_some_and(|scope| !target.scopes.allows(scope))
            {
                return Err("This remote operation is not authorized".into());
            }
            if !target.connected {
                return Err("needs_user_action: the authorized connection is offline".into());
            }
            (
                *owner_id,
                owner.sender.clone(),
                target_id.to_string(),
                owner.revision,
            )
        };
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| "Remote bridge unavailable")?
            .insert(
                id,
                Pending {
                    owner: route.0,
                    revision: route.3,
                    target: route.2,
                    reply: tx,
                },
            );
        let _cleanup = PendingGuard {
            pending: &self.pending,
            id,
        };
        let line = serde_json::to_string(&Frame::Request {
            id,
            body: Request::DesktopInvoke {
                client: client.to_string(),
                operation,
            },
        })
        .map_err(|_| "Invalid remote operation")?;
        if route.1.send(line).is_err() {
            self.remove(route.0);
        }
        let result = match tokio::time::timeout(Duration::from_secs(15), rx).await {
            Ok(Ok(result)) => result,
            _ => Err(UNKNOWN.into()),
        };
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&id);
        }
        result
    }
}

struct PendingGuard<'a> {
    pending: &'a Mutex<HashMap<u64, Pending>>,
    id: u64,
}
impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&self.id);
        }
    }
}

#[cfg(test)]
#[path = "desktop_bridge_tests.rs"]
mod tests;
