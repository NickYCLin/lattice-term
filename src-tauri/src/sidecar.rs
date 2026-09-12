//! Shared lifecycle primitives for the isolated desktop protocol engines.

use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncWrite, AsyncWriteExt as _};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{watch, Mutex, Semaphore};
use tokio::time::timeout;

pub(crate) const SIDECAR_COMMAND_TIMEOUT: Duration = Duration::from_secs(1);
pub(crate) const SIDECAR_EXIT_TIMEOUT: Duration = Duration::from_secs(3);
pub(crate) const MAX_DESKTOP_SIDECARS: usize = 8;
pub(crate) const MAX_VNC_SIDECARS: usize = 4;

pub(crate) type BoxedSidecarStdin = Box<dyn AsyncWrite + Send + Unpin>;

pub(crate) fn boxed_sidecar_stdin(stdin: ChildStdin) -> BoxedSidecarStdin {
    Box::new(stdin)
}

pub(crate) fn desktop_sidecar_admission() -> Arc<Semaphore> {
    Arc::new(Semaphore::new(MAX_DESKTOP_SIDECARS))
}

/// Ensures cancellation of an async disconnect cannot strand a child after its
/// registry record has moved into the closing set. The normal disconnect path
/// disarms this guard only after it has either requested a hard stop or armed a
/// watchdog for the graceful close.
pub(crate) struct SidecarCloseCancellationGuard {
    stop: Option<watch::Sender<bool>>,
}

impl SidecarCloseCancellationGuard {
    pub(crate) fn new(stop: watch::Sender<bool>) -> Self {
        Self { stop: Some(stop) }
    }

    pub(crate) fn disarm(mut self) {
        self.stop = None;
    }
}

impl Drop for SidecarCloseCancellationGuard {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(true);
        }
    }
}

/// Completes when a registry owner requests hard shutdown. A closed control
/// channel is also a stop request: no owner remains to supervise the child.
pub(crate) async fn wait_for_stop(stop: &mut watch::Receiver<bool>) {
    if *stop.borrow() {
        return;
    }
    loop {
        if stop.changed().await.is_err() || *stop.borrow() {
            return;
        }
    }
}

async fn write_json_line<W, T>(writer: &mut W, value: &T) -> Result<(), String>
where
    W: AsyncWrite + Unpin + ?Sized,
    T: Serialize,
{
    let mut line = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    line.push(b'\n');
    writer
        .write_all(&line)
        .await
        .map_err(|error| error.to_string())?;
    writer.flush().await.map_err(|error| error.to_string())
}

pub(crate) async fn write_json_line_timeboxed<W, T>(
    writer: &mut W,
    value: &T,
    deadline: Duration,
    channel_name: &str,
) -> Result<(), String>
where
    W: AsyncWrite + Unpin + ?Sized,
    T: Serialize,
{
    timeout(deadline, write_json_line(writer, value))
        .await
        .map_err(|_| format!("{channel_name} did not accept a command before the deadline."))?
}

/// The deadline includes both waiting for the per-engine writer and the
/// actual write/flush. This prevents queued IPC calls from waiting forever
/// behind a sidecar whose stdin stopped draining.
pub(crate) async fn write_locked_json_line_timeboxed<W, T>(
    writer: &Mutex<W>,
    value: &T,
    deadline: Duration,
    channel_name: &str,
) -> Result<(), String>
where
    W: AsyncWrite + Unpin + ?Sized,
    T: Serialize,
{
    timeout(deadline, async {
        let mut writer = writer.lock().await;
        write_json_line(&mut *writer, value).await
    })
    .await
    .map_err(|_| format!("{channel_name} did not accept a command before the deadline."))?
}

/// Submit a bounded input batch under the existing UI writer lock. Once the
/// first byte is written, cancellation or a partial write closes the engine
/// rather than leaving an unmatched key/button press connected indefinitely.
pub(crate) async fn write_mcp_input_batch<T: Serialize, F>(
    writer: &Mutex<BoxedSidecarStdin>,
    commands: &[T],
    stop: watch::Sender<bool>,
    validate: F,
) -> Result<(), crate::mcp_desktop::ServiceError>
where
    F: FnOnce() -> Result<(), crate::mcp_desktop::ServiceError>,
{
    use crate::mcp_desktop::ServiceError;
    let mut bytes = Vec::new();
    if commands.is_empty() || commands.len() > 100 {
        return Err(ServiceError::invalid());
    }
    for command in commands {
        serde_json::to_writer(&mut bytes, command).map_err(|_| ServiceError::invalid())?;
        bytes.push(b'\n');
    }
    let mut writer = timeout(Duration::from_secs(1), writer.lock())
        .await
        .map_err(|_| ServiceError::new("busy", "The screen input channel is busy."))?;
    validate()?;
    let guard = SidecarCloseCancellationGuard::new(stop);
    let result = timeout(Duration::from_secs(1), async {
        writer.write_all(&bytes).await?;
        writer.flush().await
    })
    .await;
    if matches!(result, Ok(Ok(()))) {
        guard.disarm();
        Ok(())
    } else {
        Err(ServiceError::new(
            "unknown_outcome",
            "Screen input may be partial; inspect the remote screen before retrying.",
        ))
    }
}

/// Waits briefly for a sidecar which has already announced closure, then asks
/// the OS to kill it without releasing admission while the process remains.
pub(crate) async fn wait_for_sidecar_exit(child: &mut Child) {
    if matches!(timeout(SIDECAR_EXIT_TIMEOUT, child.wait()).await, Ok(Ok(_))) {
        return;
    }
    terminate_sidecar(child).await;
}

/// Force-stops a sidecar and retains admission until Tokio reaps it.
pub(crate) async fn terminate_sidecar(child: &mut Child) {
    let _ = child.start_kill();
    // Once the hard kill is requested, keep the worker and its admission
    // permit until the OS confirms process collection. Releasing the permit
    // on a second timeout would let repeated closes accumulate unreaped
    // children outside the configured cap.
    let _ = child.wait().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Serialize;

    #[derive(Serialize)]
    struct TestCommand {
        payload: String,
    }

    #[tokio::test]
    async fn mcp_batch_rechecks_authorization_after_waiting_for_the_ui_writer() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let (stream, mut reader) = tokio::io::duplex(1024);
        let writer = Arc::new(Mutex::new(Box::new(stream) as BoxedSidecarStdin));
        let held = writer.lock().await;
        let authorized = Arc::new(AtomicBool::new(true));
        let (stop, stopped) = watch::channel(false);
        let task_writer = Arc::clone(&writer);
        let task_authorized = Arc::clone(&authorized);
        let task = tokio::spawn(async move {
            write_mcp_input_batch(
                &task_writer,
                &[TestCommand {
                    payload: "must not arrive".into(),
                }],
                stop,
                || {
                    if task_authorized.load(Ordering::SeqCst) {
                        Ok(())
                    } else {
                        Err(crate::mcp_desktop::ServiceError::denied())
                    }
                },
            )
            .await
        });
        tokio::task::yield_now().await;
        authorized.store(false, Ordering::SeqCst);
        drop(held);
        assert_eq!(task.await.unwrap().unwrap_err().code, "not_authorized");
        assert!(!*stopped.borrow());
        use tokio::io::AsyncReadExt;
        assert!(timeout(Duration::from_millis(20), reader.read_u8())
            .await
            .is_err());
    }

    #[tokio::test]
    async fn cancelling_a_partial_mcp_batch_stops_the_engine() {
        let (stream, _reader) = tokio::io::duplex(1);
        let writer = Mutex::new(Box::new(stream) as BoxedSidecarStdin);
        let (stop, stopped) = watch::channel(false);
        let result = timeout(
            Duration::from_millis(20),
            write_mcp_input_batch(
                &writer,
                &[TestCommand {
                    payload: "partial".into(),
                }],
                stop,
                || Ok(()),
            ),
        )
        .await;
        assert!(result.is_err());
        assert!(*stopped.borrow());
    }

    #[tokio::test]
    async fn locked_write_deadline_includes_mutex_admission() {
        let writer = Mutex::new(tokio::io::sink());
        let guard = writer.lock().await;
        let result = write_locked_json_line_timeboxed(
            &writer,
            &TestCommand {
                payload: "blocked".to_string(),
            },
            Duration::from_millis(20),
            "test sidecar",
        )
        .await;
        drop(guard);

        assert!(result.unwrap_err().contains("before the deadline"));
    }

    #[tokio::test]
    async fn write_deadline_stops_a_sidecar_that_does_not_drain_stdin() {
        let (mut writer, _reader) = tokio::io::duplex(1);
        let result = write_json_line_timeboxed(
            &mut writer,
            &TestCommand {
                payload: "larger than the one-byte pipe".to_string(),
            },
            Duration::from_millis(20),
            "test sidecar",
        )
        .await;

        assert!(result.unwrap_err().contains("before the deadline"));
    }

    #[tokio::test]
    async fn dropping_a_close_guard_requests_hard_stop() {
        let (stop, mut receiver) = watch::channel(false);
        drop(SidecarCloseCancellationGuard::new(stop));

        receiver.changed().await.unwrap();
        assert!(*receiver.borrow());
    }

    #[test]
    fn disarming_a_close_guard_keeps_the_worker_under_its_watchdog() {
        let (stop, receiver) = watch::channel(false);
        SidecarCloseCancellationGuard::new(stop).disarm();

        assert!(!*receiver.borrow());
    }
}
