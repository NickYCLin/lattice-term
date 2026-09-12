//! One command at a time per encrypted session, with a host-wide execution cap.
use crate::command_protocol::{CommandEnd, CommandEvent, CommandRequest};
use crate::RemoteMessage;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, watch, Semaphore};

pub fn supported_shells(allowed: bool) -> u8 {
    if cfg!(windows) && allowed {
        3
    } else {
        0
    }
}

pub struct Commands {
    allowed: bool,
    seen: HashSet<u32>,
    active: Option<(u32, watch::Sender<bool>, tokio::task::JoinHandle<()>)>,
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
        if !request.valid() || supported_shells(self.allowed) == 0 {
            return self
                .reject(id, "Command execution is not enabled on this host.")
                .await;
        }
        if matches!(request, CommandRequest::Cancel { .. }) {
            if let Some((active, cancel, _)) = &self.active {
                if *active == id {
                    let _ = cancel.send(true);
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
            .is_some_and(|(_, _, task)| !task.is_finished())
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
        let task = tokio::spawn(async move {
            let _permit = permit;
            #[cfg(windows)]
            let sent = windows::run(request, receiver, outgoing).await;
            #[cfg(not(windows))]
            let sent = {
                let _ = (request, receiver, outgoing);
                true
            };
            if !sent {
                let _ = failed.send(true);
            }
        });
        self.active = Some((id, cancel, task));
        true
    }
    pub async fn shutdown(&mut self) {
        if let Some((_, cancel, mut task)) = self.active.take() {
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
        if let Some((_, cancel, task)) = self.active.take() {
            let _ = cancel.send(true);
            task.abort(); // Dropping the owned Job Object terminates its process tree.
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
