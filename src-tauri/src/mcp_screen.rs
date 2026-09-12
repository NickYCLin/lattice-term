//! The one frame an authorized MCP client may look at.
//!
//! RDP, VNC and Lattice Remote already hand every decoded frame to the
//! window as JPEG. Keeping a copy of the newest one costs a clone per
//! frame, so nothing is kept until the user has actually shared that
//! session's screen: `arm` turns retention on for one session, `disarm`
//! and `end` turn it off and drop what was held. A screen nobody shared
//! is never copied, and a session that ends takes its frame with it.
//!
//! Frames are the user's desktop. This module stores them in memory only,
//! never writes them anywhere, and hands out at most the newest one.

use std::collections::HashMap;
use std::sync::{Mutex, RwLock};
use tauri::Manager as _;

/// A frame larger than this is not retained: it cannot be delivered whole
/// through a tool result, and holding it would only mislead. The engines
/// encode JPEG at quality 78, where even a 4K desktop stays well under.
pub const MAX_FRAME_BYTES: usize = 1_500_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScreenBackend {
    Rdp,
    Vnc,
    Remote,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub frame_id: u64,
    pub width: u32,
    pub height: u32,
    pub mime_type: String,
    pub bytes: Vec<u8>,
    /// Unix milliseconds when this frame reached the desktop.
    pub at: u64,
}

/// Why a session that is sharing its screen has nothing to hand over.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Missing {
    /// Nothing has arrived yet; the next frame will fix it.
    NotYet,
    /// Every frame so far was too large to deliver whole.
    Oversized,
}

#[derive(Default)]
struct SessionState {
    latest: Option<Frame>,
    oversized: bool,
}

#[derive(Default)]
pub struct ScreenFrames {
    /// Read on every frame of every screen session, so the hot path takes a
    /// read lock and, for an unshared session, does nothing else.
    armed: RwLock<HashMap<String, bool>>,
    sessions: Mutex<HashMap<String, SessionState>>,
}

impl ScreenFrames {
    /// The newest frame of a shared session, replacing whatever was held.
    /// Does nothing at all while the session is not shared.
    pub fn offer(
        &self,
        session_id: &str,
        frame_id: u64,
        width: u32,
        height: u32,
        mime_type: &str,
        bytes: &[u8],
    ) {
        if !self.is_armed(session_id) {
            return;
        }
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        let state = sessions.entry(session_id.to_string()).or_default();
        if bytes.len() > MAX_FRAME_BYTES {
            state.oversized = true;
            return;
        }
        state.oversized = false;
        state.latest = Some(Frame {
            frame_id,
            width,
            height,
            mime_type: mime_type.to_string(),
            bytes: bytes.to_vec(),
            at: now_millis(),
        });
    }

    /// Starts retaining this session's frames.
    pub fn arm(&self, session_id: &str) {
        if let Ok(mut armed) = self.armed.write() {
            armed.insert(session_id.to_string(), true);
        }
    }

    /// Stops retaining, and drops the frame that was held.
    pub fn disarm(&self, session_id: &str) {
        if let Ok(mut armed) = self.armed.write() {
            armed.remove(session_id);
        }
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(session_id);
        }
    }

    /// Whether this session's frames are being retained right now.
    pub fn is_armed(&self, session_id: &str) -> bool {
        self.armed
            .read()
            .map(|armed| armed.get(session_id).copied().unwrap_or(false))
            .unwrap_or(false)
    }

    /// The newest retained frame, or why there is none.
    pub fn latest(&self, session_id: &str) -> Result<Frame, Missing> {
        let sessions = self.sessions.lock().map_err(|_| Missing::NotYet)?;
        let state = sessions.get(session_id).ok_or(Missing::NotYet)?;
        match (&state.latest, state.oversized) {
            (Some(frame), _) => Ok(frame.clone()),
            (None, true) => Err(Missing::Oversized),
            (None, false) => Err(Missing::NotYet),
        }
    }
}

/// Hands one frame to the shared store, when there is one. Called from
/// every screen backend's own emit path; base64 is decoded only while the
/// session is actually shared.
pub fn retain_shared_frame(
    app: &tauri::AppHandle,
    session_id: &str,
    frame_id: u64,
    width: u32,
    height: u32,
    mime_type: &str,
    base64: &str,
) {
    use base64::Engine as _;
    let Some(frames) = app.try_state::<std::sync::Arc<ScreenFrames>>() else {
        return;
    };
    if !frames.is_armed(session_id) {
        return;
    }
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(base64) else {
        return;
    };
    frames.offer(session_id, frame_id, width, height, mime_type, &bytes);
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(frames: &ScreenFrames, id: &str, frame_id: u64, size: usize) {
        frames.offer(id, frame_id, 1920, 1080, "image/jpeg", &vec![7u8; size]);
    }

    #[test]
    fn nothing_is_kept_until_the_user_shares_that_screen() {
        let frames = ScreenFrames::default();
        frame(&frames, "rdp-1", 1, 1024);
        assert_eq!(frames.latest("rdp-1"), Err(Missing::NotYet));
        assert!(!frames.is_armed("rdp-1"));

        frames.arm("rdp-1");
        frame(&frames, "rdp-1", 2, 1024);
        let latest = frames.latest("rdp-1").unwrap();
        assert_eq!(latest.frame_id, 2);
        assert_eq!(latest.bytes.len(), 1024);
        assert_eq!(latest.mime_type, "image/jpeg");

        // Only the newest is held, and only for the shared session.
        frame(&frames, "rdp-1", 3, 2048);
        assert_eq!(frames.latest("rdp-1").unwrap().frame_id, 3);
        frame(&frames, "rdp-2", 1, 2048);
        assert_eq!(frames.latest("rdp-2"), Err(Missing::NotYet));

        // Taking the share back drops the picture immediately.
        frames.disarm("rdp-1");
        assert_eq!(frames.latest("rdp-1"), Err(Missing::NotYet));
        frame(&frames, "rdp-1", 4, 1024);
        assert_eq!(frames.latest("rdp-1"), Err(Missing::NotYet));
    }

    #[test]
    fn a_frame_too_large_to_deliver_is_reported_rather_than_kept() {
        let frames = ScreenFrames::default();
        frames.arm("vnc-1");
        frame(&frames, "vnc-1", 1, MAX_FRAME_BYTES + 1);
        assert_eq!(frames.latest("vnc-1"), Err(Missing::Oversized));
        // A frame that fits clears the condition.
        frame(&frames, "vnc-1", 2, 512);
        assert_eq!(frames.latest("vnc-1").unwrap().frame_id, 2);
    }
}
