//! Clipboard boundaries used by the desktop shell.
//!
//! Sensitive values are write-only to the WebView: only a SHA-256 digest is
//! retained and clearing compares the live clipboard first. Terminal text has
//! a separate, size-limited bridge because Linux WebKitGTK denies the browser
//! clipboard API even during explicit copy/paste keyboard gestures.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::AppHandle;
#[cfg(mobile)]
use tauri_plugin_clipboard_manager::ClipboardExt;
use zeroize::Zeroizing;

const MAX_SENSITIVE_VALUE_BYTES: usize = 4 * 1024;
const MAX_TERMINAL_TEXT_BYTES: usize = 1024 * 1024;
const ALLOWED_CLEAR_DELAYS: [u64; 4] = [15, 30, 60, 120];

fn checked_terminal_text(value: String) -> Result<Option<String>, String> {
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > MAX_TERMINAL_TEXT_BYTES {
        return Err("Terminal clipboard text is too long.".to_string());
    }
    Ok(Some(value))
}

fn read_terminal_text(io: &dyn ClipboardTextIo) -> Result<Option<String>, String> {
    let value = io
        .read_text()
        .map_err(|error| format!("Cannot read terminal clipboard text: {error}"))?;
    checked_terminal_text(value)
}

fn write_terminal_text(io: &dyn ClipboardTextIo, text: String) -> Result<(), String> {
    let text = checked_terminal_text(text)?
        .ok_or_else(|| "Terminal clipboard text is empty.".to_string())?;
    io.write_text(&text)
        .map_err(|error| format!("Cannot write terminal clipboard text: {error}"))
}

#[derive(Debug, Clone, Copy)]
struct ClipboardRecord {
    generation: u64,
    digest: [u8; 32],
    auto_clear: bool,
}

#[derive(Debug, Default)]
struct ClipboardTracker {
    generation: u64,
    current: Option<ClipboardRecord>,
}

impl ClipboardTracker {
    fn track(&mut self, digest: [u8; 32], auto_clear: bool) -> u64 {
        self.generation = self.generation.wrapping_add(1).max(1);
        self.current = Some(ClipboardRecord {
            generation: self.generation,
            digest,
            auto_clear,
        });
        self.generation
    }

    fn record(
        &self,
        expected_generation: Option<u64>,
        auto_clear_only: bool,
    ) -> Option<ClipboardRecord> {
        let record = self.current?;
        if expected_generation.is_some_and(|expected| expected != record.generation) {
            return None;
        }
        if auto_clear_only && !record.auto_clear {
            return None;
        }
        Some(record)
    }

    fn forget(&mut self, generation: u64) {
        if self
            .current
            .is_some_and(|record| record.generation == generation)
        {
            self.current = None;
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SensitiveClipboardClearOutcome {
    Cleared,
    Nothing,
    Preserved,
    Unavailable,
}

#[derive(Debug, Default)]
struct IoGateState {
    next_ticket: u64,
    serving: u64,
}

/// Serializes platform clipboard I/O without retaining a mutex guard while the OS
/// clipboard implementation is running. This matters on Linux, where an X11
/// or Wayland clipboard owner can stop responding indefinitely.
#[derive(Debug, Default)]
struct ClipboardIoGate {
    state: Mutex<IoGateState>,
    ready: Condvar,
}

impl ClipboardIoGate {
    fn enter(&self) -> ClipboardIoTurn<'_> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let ticket = state.next_ticket;
        state.next_ticket = state.next_ticket.wrapping_add(1);
        while state.serving != ticket {
            state = self
                .ready
                .wait(state)
                .unwrap_or_else(|error| error.into_inner());
        }
        drop(state);
        ClipboardIoTurn { gate: self }
    }
}

struct ClipboardIoTurn<'a> {
    gate: &'a ClipboardIoGate,
}

impl Drop for ClipboardIoTurn<'_> {
    fn drop(&mut self) {
        let mut state = self
            .gate
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.serving = state.serving.wrapping_add(1);
        self.gate.ready.notify_all();
    }
}

#[derive(Debug, Default)]
struct ActiveOperations {
    count: usize,
}

#[derive(Default)]
pub struct SensitiveClipboard {
    tracker: Mutex<ClipboardTracker>,
    io_gate: ClipboardIoGate,
    #[cfg(desktop)]
    desktop_clipboard: Mutex<Option<arboard::Clipboard>>,
    operations: Mutex<ActiveOperations>,
    operations_changed: Condvar,
    exiting: AtomicBool,
    exit_ready: AtomicBool,
    runtime_cleanup_started: AtomicBool,
}

struct ClipboardOperation<'a> {
    clipboard: &'a SensitiveClipboard,
}

impl Drop for ClipboardOperation<'_> {
    fn drop(&mut self) {
        let mut operations = self
            .clipboard
            .operations
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        operations.count = operations.count.saturating_sub(1);
        self.clipboard.operations_changed.notify_all();
    }
}

trait ClipboardTextIo {
    fn read_text(&self) -> Result<String, String>;
    fn write_text(&self, value: &str) -> Result<(), String>;
}

#[cfg(desktop)]
struct DesktopClipboardLease<'a> {
    slot: &'a Mutex<Option<arboard::Clipboard>>,
    clipboard: std::cell::RefCell<Option<arboard::Clipboard>>,
}

#[cfg(desktop)]
impl<'a> DesktopClipboardLease<'a> {
    fn take(slot: &'a Mutex<Option<arboard::Clipboard>>) -> Result<Self, String> {
        let mut stored = slot.lock().map_err(|error| error.to_string())?;
        let clipboard = match stored.take() {
            Some(clipboard) => clipboard,
            None => arboard::Clipboard::new().map_err(|error| error.to_string())?,
        };
        drop(stored);
        Ok(Self {
            slot,
            clipboard: std::cell::RefCell::new(Some(clipboard)),
        })
    }

    fn with_mut<T>(
        &self,
        operation: impl FnOnce(&mut arboard::Clipboard) -> Result<T, arboard::Error>,
    ) -> Result<T, String> {
        let mut clipboard = self.clipboard.borrow_mut();
        let clipboard = clipboard
            .as_mut()
            .ok_or_else(|| "The desktop clipboard is unavailable.".to_string())?;
        operation(clipboard).map_err(|error| error.to_string())
    }
}

#[cfg(desktop)]
impl Drop for DesktopClipboardLease<'_> {
    fn drop(&mut self) {
        let Some(clipboard) = self.clipboard.get_mut().take() else {
            return;
        };
        let mut stored = self.slot.lock().unwrap_or_else(|error| error.into_inner());
        debug_assert!(stored.is_none());
        if stored.is_none() {
            *stored = Some(clipboard);
        }
    }
}

struct PlatformClipboardTextIo<'a> {
    #[cfg(desktop)]
    clipboard: DesktopClipboardLease<'a>,
    #[cfg(mobile)]
    app: &'a AppHandle,
}

impl<'a> PlatformClipboardTextIo<'a> {
    fn new(state: &'a SensitiveClipboard, app: &'a AppHandle) -> Result<Self, String> {
        #[cfg(desktop)]
        {
            let _ = app;
            DesktopClipboardLease::take(&state.desktop_clipboard)
                .map(|clipboard| Self { clipboard })
        }
        #[cfg(mobile)]
        {
            let _ = state;
            Ok(Self { app })
        }
    }

    /// Files copied in a file manager, when the clipboard holds some.
    fn read_file_list(&self) -> Vec<std::path::PathBuf> {
        #[cfg(desktop)]
        {
            self.clipboard
                .with_mut(|clipboard| clipboard.get().file_list())
                .unwrap_or_default()
        }
        #[cfg(mobile)]
        {
            Vec::new()
        }
    }

    fn read_image_rgba(&self) -> Result<Option<(u32, u32, Vec<u8>)>, String> {
        #[cfg(desktop)]
        {
            let image = match self.clipboard.with_mut(arboard::Clipboard::get_image) {
                Ok(image) => image,
                Err(_) => return Ok(None),
            };
            let width = u32::try_from(image.width)
                .map_err(|_| "The clipboard image dimensions are too large.".to_string())?;
            let height = u32::try_from(image.height)
                .map_err(|_| "The clipboard image dimensions are too large.".to_string())?;
            Ok(Some((width, height, image.bytes.into_owned())))
        }
        #[cfg(mobile)]
        {
            let image = match self.app.clipboard().read_image() {
                Ok(image) => image,
                Err(_) => return Ok(None),
            };
            Ok(Some((image.width(), image.height(), image.rgba().to_vec())))
        }
    }
}

impl ClipboardTextIo for PlatformClipboardTextIo<'_> {
    fn read_text(&self) -> Result<String, String> {
        #[cfg(desktop)]
        {
            self.clipboard.with_mut(arboard::Clipboard::get_text)
        }
        #[cfg(mobile)]
        {
            self.app
                .clipboard()
                .read_text()
                .map_err(|error| error.to_string())
        }
    }

    fn write_text(&self, value: &str) -> Result<(), String> {
        #[cfg(desktop)]
        {
            self.clipboard
                .with_mut(|clipboard| clipboard.set_text(value))
        }
        #[cfg(mobile)]
        {
            self.app
                .clipboard()
                .write_text(value)
                .map_err(|error| error.to_string())
        }
    }
}

fn digest_text(value: &str) -> [u8; 32] {
    Sha256::digest(value.as_bytes()).into()
}

fn validate_clear_delay(clear_after_seconds: Option<u64>) -> Result<(), String> {
    if clear_after_seconds.is_some_and(|seconds| !ALLOWED_CLEAR_DELAYS.contains(&seconds)) {
        return Err("The sensitive clipboard clear delay is not supported.".to_string());
    }
    Ok(())
}

impl SensitiveClipboard {
    /// Admits one clipboard operation before the exit seal is raised. The
    /// operation counter lets shutdown wait for a write that passed admission
    /// immediately before the seal without holding a lock during OS I/O.
    pub fn begin_operation(&self) -> Result<impl Drop + '_, String> {
        let mut operations = self.operations.lock().map_err(|error| error.to_string())?;
        if self.exiting.load(Ordering::Acquire) {
            return Err(
                "Clipboard access is unavailable while LatticeTerm is exiting.".to_string(),
            );
        }
        operations.count = operations
            .count
            .checked_add(1)
            .ok_or_else(|| "Too many clipboard operations are active.".to_string())?;
        Ok(ClipboardOperation { clipboard: self })
    }

    pub fn copy(
        self: &Arc<Self>,
        app: &AppHandle,
        value: String,
        clear_after_seconds: Option<u64>,
    ) -> Result<(), String> {
        validate_clear_delay(clear_after_seconds)?;
        let value = Zeroizing::new(value);
        if value.is_empty() || value.len() > MAX_SENSITIVE_VALUE_BYTES {
            return Err("Sensitive clipboard text is empty or too long.".to_string());
        }

        let _operation = self.begin_operation()?;
        let _turn = self.io_gate.enter();
        let io = PlatformClipboardTextIo::new(self, app)?;
        let generation = self.copy_with_io(&io, value.as_str(), clear_after_seconds.is_some())?;

        if let Some(seconds) = clear_after_seconds {
            let state = Arc::clone(self);
            let timer_app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(seconds)).await;
                let worker_state = Arc::clone(&state);
                let result = tauri::async_runtime::spawn_blocking(move || {
                    let Ok(_operation) = worker_state.begin_operation() else {
                        return SensitiveClipboardClearOutcome::Nothing;
                    };
                    let _turn = worker_state.io_gate.enter();
                    let Ok(io) = PlatformClipboardTextIo::new(&worker_state, &timer_app) else {
                        return SensitiveClipboardClearOutcome::Unavailable;
                    };
                    worker_state.clear_matching_with_io(&io, Some(generation), true)
                })
                .await;
                let _ = result;
            });
        }
        Ok(())
    }

    pub fn read_terminal_text(&self, app: &AppHandle) -> Result<Option<String>, String> {
        let _operation = self.begin_operation()?;
        let _turn = self.io_gate.enter();
        let io = PlatformClipboardTextIo::new(self, app)?;
        read_terminal_text(&io)
    }

    pub fn write_terminal_text(&self, app: &AppHandle, text: String) -> Result<(), String> {
        let _operation = self.begin_operation()?;
        let _turn = self.io_gate.enter();
        let io = PlatformClipboardTextIo::new(self, app)?;
        write_terminal_text(&io, text)
    }

    pub fn read_file_list(&self, app: &AppHandle) -> Result<Vec<std::path::PathBuf>, String> {
        let _operation = self.begin_operation()?;
        let _turn = self.io_gate.enter();
        Ok(PlatformClipboardTextIo::new(self, app)?.read_file_list())
    }

    pub fn read_image_rgba(&self, app: &AppHandle) -> Result<Option<(u32, u32, Vec<u8>)>, String> {
        let _operation = self.begin_operation()?;
        let _turn = self.io_gate.enter();
        PlatformClipboardTextIo::new(self, app)?.read_image_rgba()
    }

    fn copy_with_io(
        &self,
        io: &dyn ClipboardTextIo,
        value: &str,
        auto_clear: bool,
    ) -> Result<u64, String> {
        io.write_text(value)?;
        let mut tracker = self.tracker.lock().map_err(|error| error.to_string())?;
        Ok(tracker.track(digest_text(value), auto_clear))
    }

    pub fn clear_current(&self, app: &AppHandle) -> SensitiveClipboardClearOutcome {
        let Ok(_operation) = self.begin_operation() else {
            return SensitiveClipboardClearOutcome::Unavailable;
        };
        let _turn = self.io_gate.enter();
        let Ok(io) = PlatformClipboardTextIo::new(self, app) else {
            return SensitiveClipboardClearOutcome::Unavailable;
        };
        self.clear_matching_with_io(&io, None, false)
    }

    #[cfg(mobile)]
    fn clear_auto_on_exit(&self, app: &AppHandle) -> SensitiveClipboardClearOutcome {
        let _turn = self.io_gate.enter();
        let Ok(io) = PlatformClipboardTextIo::new(self, app) else {
            return SensitiveClipboardClearOutcome::Unavailable;
        };
        self.clear_matching_with_io(&io, None, true)
    }

    fn clear_matching_with_io(
        &self,
        io: &dyn ClipboardTextIo,
        expected_generation: Option<u64>,
        auto_clear_only: bool,
    ) -> SensitiveClipboardClearOutcome {
        // Phase one only copies the candidate. Never retain the tracker mutex
        // while talking to the platform clipboard.
        let record = {
            let Ok(tracker) = self.tracker.lock() else {
                return SensitiveClipboardClearOutcome::Unavailable;
            };
            let Some(record) = tracker.record(expected_generation, auto_clear_only) else {
                return SensitiveClipboardClearOutcome::Nothing;
            };
            record
        };

        let Ok(current) = io.read_text() else {
            return SensitiveClipboardClearOutcome::Unavailable;
        };

        // Phase two revalidates the generation after the potentially blocking
        // read. A newer sensitive copy must never be cleared by an old timer.
        {
            let Ok(mut tracker) = self.tracker.lock() else {
                return SensitiveClipboardClearOutcome::Unavailable;
            };
            let Some(current_record) = tracker.record(Some(record.generation), auto_clear_only)
            else {
                return SensitiveClipboardClearOutcome::Nothing;
            };
            if current.len() > MAX_SENSITIVE_VALUE_BYTES
                || digest_text(&current) != current_record.digest
            {
                tracker.forget(record.generation);
                return SensitiveClipboardClearOutcome::Preserved;
            }
        }

        if io.write_text("").is_err() {
            return SensitiveClipboardClearOutcome::Unavailable;
        }
        let Ok(mut tracker) = self.tracker.lock() else {
            return SensitiveClipboardClearOutcome::Unavailable;
        };
        tracker.forget(record.generation);
        SensitiveClipboardClearOutcome::Cleared
    }

    /// Raises a one-way seal. Calls that have not already passed admission can
    /// no longer put clipboard contents into the OS while shutdown is clearing.
    pub fn seal_for_exit(&self) -> bool {
        let _operations = self
            .operations
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.exiting
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    pub fn exit_ready(&self) -> bool {
        self.exit_ready.load(Ordering::Acquire)
    }

    pub fn mark_exit_ready(&self) {
        self.exit_ready.store(true, Ordering::Release);
    }

    pub fn begin_runtime_cleanup(&self) -> bool {
        self.runtime_cleanup_started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    fn wait_until_idle(&self, deadline: Instant) -> bool {
        let mut operations = self
            .operations
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        while operations.count != 0 {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return false;
            };
            let (next, wait) = self
                .operations_changed
                .wait_timeout(operations, remaining)
                .unwrap_or_else(|error| error.into_inner());
            operations = next;
            if wait.timed_out() && operations.count != 0 {
                return false;
            }
        }
        true
    }

    /// Clears an auto-clear value on a detached worker and returns at the
    /// deadline even if a platform clipboard owner is hung. The detached
    /// worker is intentional: Tokio waits for `spawn_blocking` jobs when its
    /// runtime shuts down, which would defeat a bounded exit/restart.
    pub async fn clear_auto_on_exit_timeboxed(
        self: &Arc<Self>,
        _app: AppHandle,
        timeout: Duration,
    ) -> SensitiveClipboardClearOutcome {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let state = Arc::clone(self);
        let deadline = Instant::now() + timeout;
        let spawned = std::thread::Builder::new()
            .name("latticeterm-clipboard-exit".to_string())
            .spawn(move || {
                let outcome = if state.wait_until_idle(deadline) {
                    #[cfg(desktop)]
                    {
                        let _turn = state.io_gate.enter();
                        match PlatformClipboardTextIo::new(&state, &_app) {
                            Ok(io) => state.clear_matching_with_io(&io, None, true),
                            Err(_) => SensitiveClipboardClearOutcome::Unavailable,
                        }
                    }
                    #[cfg(mobile)]
                    {
                        state.clear_auto_on_exit(&_app)
                    }
                } else {
                    SensitiveClipboardClearOutcome::Unavailable
                };
                let _ = sender.send(outcome);
            });
        if spawned.is_err() {
            return SensitiveClipboardClearOutcome::Unavailable;
        }

        match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(outcome)) => outcome,
            _ => SensitiveClipboardClearOutcome::Unavailable,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[derive(Default)]
    struct MemoryClipboard {
        value: Mutex<String>,
        writes: AtomicUsize,
    }

    impl ClipboardTextIo for MemoryClipboard {
        fn read_text(&self) -> Result<String, String> {
            Ok(self.value.lock().unwrap().clone())
        }

        fn write_text(&self, value: &str) -> Result<(), String> {
            *self.value.lock().unwrap() = value.to_string();
            self.writes.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }
    }

    struct ReplacingClipboard<'a> {
        state: &'a SensitiveClipboard,
        writes: AtomicUsize,
    }

    impl ClipboardTextIo for ReplacingClipboard<'_> {
        fn read_text(&self) -> Result<String, String> {
            self.state
                .tracker
                .lock()
                .unwrap()
                .track(digest_text("newer"), true);
            Ok("secret".to_string())
        }

        fn write_text(&self, _value: &str) -> Result<(), String> {
            self.writes.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }
    }

    #[test]
    fn accepts_only_the_exposed_clear_delays() {
        for seconds in ALLOWED_CLEAR_DELAYS {
            assert!(validate_clear_delay(Some(seconds)).is_ok());
        }
        assert!(validate_clear_delay(None).is_ok());
        assert!(validate_clear_delay(Some(0)).is_err());
        assert!(validate_clear_delay(Some(31)).is_err());
    }

    #[test]
    fn terminal_text_bridge_rejects_empty_writes_and_oversized_values() {
        assert_eq!(checked_terminal_text(String::new()).unwrap(), None);
        assert_eq!(
            checked_terminal_text("paste me".to_string()).unwrap(),
            Some("paste me".to_string())
        );
        assert!(checked_terminal_text("x".repeat(MAX_TERMINAL_TEXT_BYTES + 1)).is_err());
    }

    #[test]
    fn newer_values_invalidate_older_timers() {
        let mut tracker = ClipboardTracker::default();
        let first = tracker.track(digest_text("first"), true);
        let second = tracker.track(digest_text("second"), true);

        assert!(tracker.record(Some(first), true).is_none());
        assert_eq!(
            tracker
                .record(Some(second), true)
                .map(|record| record.digest),
            Some(digest_text("second"))
        );
    }

    #[test]
    fn disabled_auto_clear_still_allows_an_explicit_clear() {
        let mut tracker = ClipboardTracker::default();
        let generation = tracker.track(digest_text("secret"), false);

        assert!(tracker.record(Some(generation), true).is_none());
        assert!(tracker.record(Some(generation), false).is_some());
    }

    #[test]
    fn forgetting_is_generation_scoped() {
        let mut tracker = ClipboardTracker::default();
        let first = tracker.track(digest_text("first"), true);
        let second = tracker.track(digest_text("second"), true);

        tracker.forget(first);
        assert!(tracker.record(Some(second), false).is_some());
        tracker.forget(second);
        assert!(tracker.record(Some(second), false).is_none());
    }

    #[test]
    fn clear_preserves_a_different_live_value() {
        let state = SensitiveClipboard::default();
        let io = MemoryClipboard::default();
        let generation = state.copy_with_io(&io, "secret", true).unwrap();
        *io.value.lock().unwrap() = "new external value".to_string();

        assert_eq!(
            state.clear_matching_with_io(&io, Some(generation), true),
            SensitiveClipboardClearOutcome::Preserved
        );
        assert_eq!(*io.value.lock().unwrap(), "new external value");
        assert_eq!(io.writes.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn exit_seal_rejects_new_operations_but_allows_an_admitted_one_to_finish() {
        let state = SensitiveClipboard::default();
        let admitted = state.begin_operation().unwrap();

        assert!(state.seal_for_exit());
        assert!(state.begin_operation().is_err());
        drop(admitted);
        assert!(state.wait_until_idle(Instant::now() + Duration::from_millis(10)));
    }

    #[test]
    fn matching_clear_erases_and_forgets_the_tracked_value() {
        let state = SensitiveClipboard::default();
        let io = MemoryClipboard::default();
        let generation = state.copy_with_io(&io, "secret", true).unwrap();

        assert_eq!(
            state.clear_matching_with_io(&io, Some(generation), true),
            SensitiveClipboardClearOutcome::Cleared
        );
        assert_eq!(*io.value.lock().unwrap(), "");
        assert!(state
            .tracker
            .lock()
            .unwrap()
            .record(Some(generation), false)
            .is_none());
    }

    #[test]
    fn clear_revalidates_generation_after_the_platform_read() {
        let state = SensitiveClipboard::default();
        let initial = state
            .tracker
            .lock()
            .unwrap()
            .track(digest_text("secret"), true);
        let io = ReplacingClipboard {
            state: &state,
            writes: AtomicUsize::new(0),
        };

        assert_eq!(
            state.clear_matching_with_io(&io, Some(initial), true),
            SensitiveClipboardClearOutcome::Nothing
        );
        assert_eq!(io.writes.load(Ordering::Relaxed), 0);
        assert_eq!(
            state
                .tracker
                .lock()
                .unwrap()
                .record(None, true)
                .map(|record| record.digest),
            Some(digest_text("newer"))
        );
    }

    #[test]
    fn runtime_cleanup_can_only_start_once() {
        let state = SensitiveClipboard::default();
        assert!(state.begin_runtime_cleanup());
        assert!(!state.begin_runtime_cleanup());
    }

    #[test]
    fn io_gate_keeps_platform_clipboard_calls_serial() {
        let gate = Arc::new(ClipboardIoGate::default());
        let first_turn = gate.enter();
        let (entered_sender, entered_receiver) = std::sync::mpsc::channel();
        let worker_gate = Arc::clone(&gate);
        let worker = std::thread::spawn(move || {
            let _turn = worker_gate.enter();
            entered_sender.send(()).unwrap();
        });

        assert!(entered_receiver
            .recv_timeout(Duration::from_millis(25))
            .is_err());
        drop(first_turn);
        entered_receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        worker.join().unwrap();
    }
}
