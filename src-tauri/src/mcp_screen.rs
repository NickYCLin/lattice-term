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
use std::sync::Mutex;
use tauri::Manager as _;

/// A frame larger than this is not retained: it cannot be delivered whole
/// through a tool result, and holding it would only mislead. The engines
/// encode JPEG at quality 78, where even a 4K desktop stays well under.
pub const MAX_FRAME_BYTES: usize = 1_500_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScreenBackend {
    Rdp,
    Vnc,
    Remote,
}

/// A frame belongs to one backend connection generation, never just a UI ID.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ScreenKey {
    pub backend: ScreenBackend,
    pub session_id: String,
    pub generation: u64,
}

impl ScreenKey {
    pub fn new(backend: ScreenBackend, session_id: &str, generation: u64) -> Self {
        Self {
            backend,
            session_id: session_id.into(),
            generation,
        }
    }
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
    /// The newest frame was too large to deliver whole.
    Oversized,
}

#[derive(Default)]
struct SessionState {
    latest: Option<Frame>,
    oversized: bool,
}

#[derive(Default)]
pub struct ScreenFrames {
    // Authorization and content share one lock, so an in-flight offer cannot
    // recreate a frame after disarm has returned.
    sessions: Mutex<HashMap<ScreenKey, SessionState>>,
}

impl ScreenFrames {
    /// The newest frame of a shared session, replacing whatever was held.
    /// Does nothing at all while the session is not shared.
    pub fn offer(
        &self,
        key: &ScreenKey,
        frame_id: u64,
        width: u32,
        height: u32,
        mime_type: &str,
        bytes: &[u8],
    ) {
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        let Some(state) = sessions.get_mut(key) else {
            return;
        };
        if bytes.len() > MAX_FRAME_BYTES {
            state.latest = None;
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

    /// Starts retaining without replacing another grant's current frame.
    pub fn arm(&self, key: &ScreenKey) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.entry(key.clone()).or_default();
        }
    }

    pub fn disarm(&self, key: &ScreenKey) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(key);
        }
    }

    pub fn is_armed(&self, key: &ScreenKey) -> bool {
        self.sessions
            .lock()
            .map(|sessions| sessions.contains_key(key))
            .unwrap_or(false)
    }

    /// The newest retained frame, or why there is none.
    pub fn latest(&self, key: &ScreenKey) -> Result<Frame, Missing> {
        let sessions = self.sessions.lock().map_err(|_| Missing::NotYet)?;
        let state = sessions.get(key).ok_or(Missing::NotYet)?;
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
    key: &ScreenKey,
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
    if !frames.is_armed(key) {
        return;
    }
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(base64) else {
        return;
    };
    frames.offer(key, frame_id, width, height, mime_type, &bytes);
}

/// Called when the backend connection ends, including local disconnect.
pub fn end_shared_screen(app: &tauri::AppHandle, key: &ScreenKey) {
    if let Some(frames) = app.try_state::<std::sync::Arc<ScreenFrames>>() {
        frames.disarm(key);
    }
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

    fn key(id: &str) -> ScreenKey {
        ScreenKey::new(ScreenBackend::Rdp, id, 1)
    }

    fn frame(frames: &ScreenFrames, id: &str, frame_id: u64, size: usize) {
        frames.offer(
            &key(id),
            frame_id,
            1920,
            1080,
            "image/jpeg",
            &vec![7u8; size],
        );
    }

    #[test]
    fn nothing_is_kept_until_the_user_shares_that_screen() {
        let frames = ScreenFrames::default();
        frame(&frames, "rdp-1", 1, 1024);
        assert_eq!(frames.latest(&key("rdp-1")), Err(Missing::NotYet));
        assert!(!frames.is_armed(&key("rdp-1")));

        frames.arm(&key("rdp-1"));
        frame(&frames, "rdp-1", 2, 1024);
        let latest = frames.latest(&key("rdp-1")).unwrap();
        assert_eq!(latest.frame_id, 2);
        assert_eq!(latest.bytes.len(), 1024);
        assert_eq!(latest.mime_type, "image/jpeg");

        // Only the newest is held, and only for the shared session.
        frame(&frames, "rdp-1", 3, 2048);
        assert_eq!(frames.latest(&key("rdp-1")).unwrap().frame_id, 3);
        frame(&frames, "rdp-2", 1, 2048);
        assert_eq!(frames.latest(&key("rdp-2")), Err(Missing::NotYet));

        // Taking the share back drops the picture immediately.
        frames.disarm(&key("rdp-1"));
        assert_eq!(frames.latest(&key("rdp-1")), Err(Missing::NotYet));
        frame(&frames, "rdp-1", 4, 1024);
        assert_eq!(frames.latest(&key("rdp-1")), Err(Missing::NotYet));
    }

    #[test]
    fn a_frame_too_large_to_deliver_is_reported_rather_than_kept() {
        let frames = ScreenFrames::default();
        frames.arm(&key("vnc-1"));
        frame(&frames, "vnc-1", 1, MAX_FRAME_BYTES + 1);
        assert_eq!(frames.latest(&key("vnc-1")), Err(Missing::Oversized));
        // A frame that fits clears the condition.
        frame(&frames, "vnc-1", 2, 512);
        assert_eq!(frames.latest(&key("vnc-1")).unwrap().frame_id, 2);
        frame(&frames, "vnc-1", 3, MAX_FRAME_BYTES + 1);
        assert_eq!(frames.latest(&key("vnc-1")), Err(Missing::Oversized));
    }
}

#[cfg(test)]
mod isolation_tests {
    use super::*;

    #[test]
    fn backend_and_generation_cannot_supply_each_others_frames() {
        let frames = ScreenFrames::default();
        let key = ScreenKey::new(ScreenBackend::Rdp, "same-id", 2);
        frames.arm(&key);
        for other in [
            ScreenKey::new(ScreenBackend::Rdp, "same-id", 1),
            ScreenKey::new(ScreenBackend::Vnc, "same-id", 2),
        ] {
            frames.offer(&other, 1, 2, 2, "image/jpeg", &[1]);
            frames.disarm(&other);
        }
        assert_eq!(frames.latest(&key), Err(Missing::NotYet));
        frames.offer(&key, 2, 2, 2, "image/jpeg", &[2]);
        frames.arm(&key);
        assert_eq!(frames.latest(&key).unwrap().frame_id, 2);
    }

    #[test]
    fn concurrent_offers_cannot_retain_after_revocation() {
        let frames = std::sync::Arc::new(ScreenFrames::default());
        let key = ScreenKey::new(ScreenBackend::Remote, "race", 1);
        frames.arm(&key);
        std::thread::scope(|scope| {
            for _ in 0..4 {
                scope.spawn(|| {
                    for i in 0..1000 {
                        frames.offer(&key, i, 1, 1, "image/jpeg", &[7]);
                    }
                });
            }
            frames.disarm(&key);
        });
        assert!(!frames.is_armed(&key));
        assert_eq!(frames.latest(&key), Err(Missing::NotYet));
    }
}
