//! One command at a time per encrypted session, with a host-wide execution cap.
use crate::command_protocol::{CommandEnd, CommandEvent, CommandRequest};
use crate::RemoteMessage;
use std::collections::HashSet;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tokio::sync::{mpsc, watch, OwnedSemaphorePermit, Semaphore};

pub fn supported_shells(allowed: bool) -> u8 {
    if !allowed {
        0
    } else if cfg!(windows) {
        3
    } else if cfg!(unix) {
        4
    } else {
        0
    }
}

/// Publish completion only after both the process and its execution slot end.
struct RunningSlot {
    permit: Option<OwnedSemaphorePermit>,
    complete: Arc<AtomicBool>,
}
impl Drop for RunningSlot {
    fn drop(&mut self) {
        drop(self.permit.take());
        self.complete.store(true, Ordering::Release);
    }
}

struct ActiveCommand {
    id: u32,
    cancel: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
    complete: Arc<AtomicBool>,
}

pub struct Commands {
    allowed: bool,
    seen: HashSet<u32>,
    active: Option<ActiveCommand>,
    outgoing: mpsc::Sender<RemoteMessage>,
    permits: Arc<Semaphore>,
    failed: watch::Sender<bool>,
}
impl Commands {
    pub fn new(
        allowed: bool,
        outgoing: mpsc::Sender<RemoteMessage>,
        permits: Arc<Semaphore>,
    ) -> Self {
        Self {
            allowed,
            seen: HashSet::new(),
            active: None,
            outgoing,
            permits,
            failed: watch::channel(false).0,
        }
    }
    pub fn subscribe_failures(&self) -> watch::Receiver<bool> {
        self.failed.subscribe()
    }
    async fn reject(&self, id: u32, detail: &str) -> bool {
        send(
            &self.outgoing,
            CommandEvent::Finished {
                id,
                reason: CommandEnd::Failed,
                exit_code: None,
                detail: detail.into(),
            },
        )
        .await
    }
    pub async fn handle(&mut self, request: CommandRequest) -> bool {
        let id = request.id();
        if !request.valid()
            || supported_shells(self.allowed) == 0
            || matches!(&request, CommandRequest::Run { shell, .. } if supported_shells(self.allowed) & shell.flag() == 0)
        {
            return self
                .reject(id, "Command execution is not enabled on this host.")
                .await;
        }
        if matches!(request, CommandRequest::Cancel { .. }) {
            if let Some(active) = &self.active {
                if active.id == id {
                    let _ = active.cancel.send(true);
                }
            }
            return true;
        }
        if self.seen.contains(&id) {
            // Never replay a state-changing command, including after completion.
            // Do not send a second Finished for a still-running matching ID.
            return true;
        }
        if self.seen.len() >= 256 {
            return self
                .reject(
                    id,
                    "This session reached its command limit. Reconnect to run more commands.",
                )
                .await;
        }
        self.seen.insert(id);
        if self
            .active
            .as_ref()
            .is_some_and(|active| !active.complete.load(Ordering::Acquire))
        {
            return self.reject(id, "Another command is still running.").await;
        }
        let Ok(permit) = Arc::clone(&self.permits).try_acquire_owned() else {
            return self
                .reject(id, "The host command limit has been reached.")
                .await;
        };
        let (cancel, receiver) = watch::channel(false);
        let outgoing = self.outgoing.clone();
        let failed = self.failed.clone();
        let complete = Arc::new(AtomicBool::new(false));
        let slot = RunningSlot {
            permit: Some(permit),
            complete: complete.clone(),
        };
        let task = tokio::spawn(async move {
            #[cfg(windows)]
            let sent = windows::run(request, receiver, outgoing, slot).await;
            #[cfg(unix)]
            let sent = unix::run(request, receiver, outgoing, slot).await;
            #[cfg(not(any(windows, unix)))]
            let sent = {
                let _ = (request, receiver, outgoing, slot);
                true
            };
            if !sent {
                let _ = failed.send(true);
            }
        });
        self.active = Some(ActiveCommand {
            id,
            cancel,
            task,
            complete,
        });
        true
    }
    pub async fn shutdown(&mut self) {
        if let Some(ActiveCommand {
            cancel, mut task, ..
        }) = self.active.take()
        {
            let _ = cancel.send(true);
            if tokio::time::timeout(Duration::from_secs(6), &mut task)
                .await
                .is_err()
            {
                task.abort();
                let _ = task.await;
            }
        }
    }
}
impl Drop for Commands {
    fn drop(&mut self) {
        if let Some(ActiveCommand { cancel, task, .. }) = self.active.take() {
            let _ = cancel.send(true);
            task.abort(); // Dropping the owned job/process group cleans up its children.
        }
    }
}
async fn send(outgoing: &mpsc::Sender<RemoteMessage>, event: CommandEvent) -> bool {
    matches!(
        tokio::time::timeout(
            Duration::from_secs(2),
            outgoing.send(RemoteMessage::CommandEvent(event))
        )
        .await,
        Ok(Ok(()))
    )
}

mod scripts;
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn commands_require_independent_host_permission() {
        let (tx, mut rx) = mpsc::channel(4);
        let mut commands = Commands::new(false, tx, Arc::new(Semaphore::new(1)));
        assert!(
            commands
                .handle(CommandRequest::Run {
                    id: 1,
                    shell: crate::command_protocol::CommandShell::Cmd,
                    command: "echo rejected".into(),
                    directory: String::new(),
                    timeout_seconds: 5
                })
                .await
        );
        assert!(matches!(
            rx.recv().await,
            Some(RemoteMessage::CommandEvent(CommandEvent::Finished {
                reason: CommandEnd::Failed,
                ..
            }))
        ));
        assert!(commands.active.is_none());
    }
}
