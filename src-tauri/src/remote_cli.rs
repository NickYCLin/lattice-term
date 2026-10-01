//! Explicit host-lifetime access to existing desktop and daemon PTYs.
use crate::agent::{AgentRegistry, AgentSessionSummary};
use lattice_remote::chat_protocol::ChatOperation;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, LazyLock, Mutex,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// A phone that stopped reading for this long has left the terminal.
const PHONE_IDLE: Duration = Duration::from_secs(5);
/// The phone resizes the shared PTY to fit its screen. Remember the desktop
/// size so the desktop view gets its layout back once the phone leaves.
#[derive(Default)]
struct Sizes {
    desktop: HashMap<String, (u32, u32)>,
    phone: HashMap<String, Instant>,
}
impl Sizes {
    /// Returns true when the phone starts sizing this terminal.
    fn phone_resized(&mut self, id: &str, now: Instant) -> bool {
        self.phone.insert(id.to_string(), now).is_none()
    }
    fn phone_read(&mut self, id: &str, now: Instant) {
        if let Some(seen) = self.phone.get_mut(id) {
            *seen = now;
        }
    }
    /// Once the phone is idle, stop tracking it and hand back the desktop size.
    fn phone_left(&mut self, id: &str, now: Instant) -> Option<Option<(u32, u32)>> {
        let seen = *self.phone.get(id)?;
        if now.duration_since(seen) < PHONE_IDLE {
            return None;
        }
        self.phone.remove(id);
        Some(self.desktop.get(id).copied())
    }
}
static SIZES: LazyLock<Mutex<Sizes>> = LazyLock::new(Mutex::default);
/// Called for every resize coming from the desktop's own terminal view.
pub fn remember_desktop_size(session_id: &str, cols: u32, rows: u32) {
    if let Ok(mut sizes) = SIZES.lock() {
        sizes.desktop.insert(session_id.to_string(), (cols, rows));
    }
}
async fn apply_size(app: &AppHandle, native: &str, cols: u32, rows: u32) -> Result<(), String> {
    if crate::agent_daemon::owns(native) {
        app.state::<crate::AppDaemon>()
            .request(
                false,
                crate::agent_daemon::Request::Resize {
                    session_id: native.to_string(),
                    cols,
                    rows,
                },
            )
            .await
            .map(|_| ())
    } else {
        crate::agent::resize(
            app.state::<Arc<AgentRegistry>>().inner(),
            native,
            cols,
            rows,
        )
    }
}
fn restore_when_phone_leaves(app: AppHandle, native: String) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let left = match SIZES.lock() {
                Ok(mut sizes) => sizes.phone_left(&native, Instant::now()),
                Err(_) => return,
            };
            match left {
                None => continue,
                Some(Some((cols, rows))) => {
                    let _ = apply_size(&app, &native, cols, rows).await;
                    return;
                }
                Some(None) => return,
            }
        }
    });
}

// 50 summaries of escaped labels and a clipped folder stay below the 60 KiB encrypted response limit.
const MAX_LISTED: usize = 50;
fn label(value: &str) -> String {
    let mut output = String::new();
    for c in value.chars().filter(|c| !c.is_control()) {
        if output.len() + c.len_utf8() > 64 {
            break;
        }
        output.push(c);
    }
    output
}
/// Only the folder name, so the phone can tell projects apart without the
/// account path.
fn project_name(directory: &str) -> String {
    // The host may describe a Windows path while running elsewhere in tests.
    label(
        directory
            .trim_end_matches(['/', '\\'])
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or_default(),
    )
}
/// Where the CLI runs, with the home folder shortened to `~`. Long paths keep
/// their last folders, which are the ones that tell projects apart.
fn short_directory(directory: &str, home: Option<&str>) -> String {
    const LIMIT: usize = 160;
    let trimmed = directory.trim_end_matches(['/', '\\']);
    let shown = match home.map(|home| home.trim_end_matches(['/', '\\'])) {
        Some(home) if !home.is_empty() && trimmed == home => "~".to_string(),
        Some(home)
            if !home.is_empty()
                && trimmed.starts_with(home)
                && trimmed[home.len()..].starts_with(['/', '\\']) =>
        {
            format!("~{}", &trimmed[home.len()..])
        }
        _ => trimmed.to_string(),
    };
    let clean: Vec<char> = shown.chars().filter(|c| !c.is_control()).collect();
    let mut tail = String::new();
    for c in clean.iter().rev() {
        if tail.len() + c.len_utf8() > LIMIT - '…'.len_utf8() {
            return format!("…{}", tail.chars().rev().collect::<String>());
        }
        tail.push(*c);
    }
    clean.into_iter().collect()
}
/// Mirrors `cliProxyIdFromArguments` in the desktop UI.
fn uses_cli_proxy(arguments: &[String]) -> bool {
    arguments.windows(2).any(|pair| {
        (pair[0] == "-c" || pair[0] == "--config")
            && pair[1]
                .strip_prefix("model_provider=")
                .is_some_and(|provider| provider.starts_with("latticeterm_cliproxyapi"))
    })
}
const MAX_UPLOADS: usize = 4;
const UPLOAD_TTL: Duration = Duration::from_secs(10 * 60);
struct Upload {
    session: String,
    total: u32,
    bytes: Vec<u8>,
    at: Instant,
}
enum Piece {
    Partial(usize),
    Done(Vec<u8>),
    /// The last piece was sent again after the image was already pasted.
    AlreadyPasted,
}
/// Phone images arriving piece by piece, keyed by the phone's upload ID.
#[derive(Default)]
struct Uploads {
    partial: HashMap<String, Upload>,
    finished: HashMap<String, (String, Instant)>,
}
impl Uploads {
    fn add(
        &mut self,
        session: &str,
        upload_id: &str,
        offset: u32,
        total: u32,
        data: &[u8],
        now: Instant,
    ) -> Result<Piece, String> {
        self.partial
            .retain(|_, upload| now.duration_since(upload.at) < UPLOAD_TTL);
        self.finished
            .retain(|_, (_, at)| now.duration_since(*at) < UPLOAD_TTL);
        if self
            .finished
            .get(upload_id)
            .is_some_and(|(owner, _)| owner == session)
        {
            return Ok(Piece::AlreadyPasted);
        }
        if !self.partial.contains_key(upload_id) {
            if offset != 0 {
                return Err("The image upload expired. Send the image again.".into());
            }
            if self.partial.len() >= MAX_UPLOADS {
                return Err("Too many images are uploading. Try again shortly.".into());
            }
            self.partial.insert(
                upload_id.to_string(),
                Upload {
                    session: session.to_string(),
                    total,
                    bytes: Vec::new(),
                    at: now,
                },
            );
        }
        let upload = self
            .partial
            .get_mut(upload_id)
            .ok_or("The image upload expired. Send the image again.")?;
        let start = offset as usize;
        let end = start + data.len();
        let received = upload.bytes.len();
        if upload.session != session || upload.total != total || end > total as usize {
            self.partial.remove(upload_id);
            return Err("The image upload does not match. Send the image again.".into());
        }
        // A retried piece that already arrived is acknowledged, not appended twice.
        if end <= received && upload.bytes[start..end] == *data {
            return Ok(Piece::Partial(received));
        }
        if start != received {
            self.partial.remove(upload_id);
            return Err("Part of the image was lost. Send the image again.".into());
        }
        upload.bytes.extend_from_slice(data);
        upload.at = now;
        if upload.bytes.len() < total as usize {
            return Ok(Piece::Partial(upload.bytes.len()));
        }
        let upload = self
            .partial
            .remove(upload_id)
            .ok_or("The image upload expired. Send the image again.")?;
        Ok(Piece::Done(upload.bytes))
    }
    fn pasted(&mut self, session: &str, upload_id: &str, now: Instant) {
        self.finished
            .insert(upload_id.to_string(), (session.to_string(), now));
    }
}
/// Only images the CLIs can read are saved; the bytes decide, not a name.
fn image_suffix(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(".png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some(".jpg")
    } else {
        None
    }
}
/// What a desktop paste of the saved image would type into the CLI.
fn pasted_path(path: &str, bracketed: bool) -> String {
    let path: String = path.chars().filter(|c| !c.is_control()).collect();
    if bracketed {
        format!("\x1b[200~{path}\x1b[201~")
    } else {
        path
    }
}
pub struct Access {
    active: AtomicBool,
    revoked: tokio::sync::Notify,
    sessions: Mutex<HashMap<String, String>>,
    uploads: Mutex<Uploads>,
}
impl Access {
    pub fn new(allowed: bool) -> Self {
        Self {
            active: AtomicBool::new(allowed),
            revoked: tokio::sync::Notify::new(),
            sessions: Mutex::new(HashMap::new()),
            uploads: Mutex::new(Uploads::default()),
        }
    }
    pub fn allowed(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }
    pub fn revoke(&self) {
        self.active.store(false, Ordering::Release);
        self.revoked.notify_waiters();
    }
    fn check(&self) -> Result<(), String> {
        if self.allowed() {
            Ok(())
        } else {
            Err("CLI sharing is disabled. Enable it on the host and reconnect.".into())
        }
    }
    fn project(&self, sessions: Vec<AgentSessionSummary>) -> Result<Value, String> {
        self.check()?;
        let mut ids = self.sessions.lock().map_err(|e| e.to_string())?;
        ids.retain(|_, native| sessions.iter().any(|s| s.session_id == *native));
        let mut output = Vec::new();
        let home = dirs::home_dir().map(|home| home.to_string_lossy().into_owned());
        for session in sessions.into_iter().take(MAX_LISTED) {
            let id = if let Some((id, _)) = ids
                .iter()
                .find(|(_, native)| **native == session.session_id)
            {
                id.clone()
            } else {
                let mut bytes = [0u8; 16];
                getrandom::fill(&mut bytes).map_err(|_| "Cannot identify the shared CLI.")?;
                let id: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
                ids.insert(id.clone(), session.session_id);
                id
            };
            // Do not disclose native IDs, executable arguments, account paths or PIDs.
            output.push(json!({
                "id": id,
                "label": label(&session.label),
                "groupLabel": label(&session.group_label),
                "agent": label(&session.definition_id),
                "state": session.state,
                "detached": session.detached,
                "model": label(session.model.as_deref().unwrap_or_default()),
                "project": project_name(&session.working_directory),
                "directory": short_directory(&session.working_directory, home.as_deref()),
                "proxy": uses_cli_proxy(&session.launch_arguments),
            }));
        }
        Ok(json!(output))
    }
    fn resolve(&self, id: &str) -> Result<String, String> {
        self.check()?;
        self.sessions
            .lock()
            .map_err(|e| e.to_string())?
            .get(id)
            .cloned()
            .ok_or_else(|| "The CLI is no longer available. Refresh the session list.".into())
    }
    pub async fn perform(
        &self,
        app: &AppHandle,
        operation: ChatOperation,
    ) -> Result<Value, String> {
        self.check()?;
        // Cancel a daemon attachment/read/write still waiting when sharing ends.
        // Bytes already sent to a PTY cannot be recalled.
        tokio::select! {
            biased;
            _ = self.revoked.notified() => Err("CLI sharing was revoked.".into()),
            result = self.perform_active(app, operation) => result,
        }
    }
    async fn perform_active(
        &self,
        app: &AppHandle,
        operation: ChatOperation,
    ) -> Result<Value, String> {
        self.check()?;
        let registry = app.state::<Arc<AgentRegistry>>();
        let daemon = app.state::<crate::AppDaemon>();
        if matches!(operation, ChatOperation::CliList) {
            let mut sessions = registry.list();
            sessions.extend(daemon.sessions().await);
            return self.project(sessions);
        }
        let remote_id = match &operation {
            ChatOperation::CliRead { session_id, .. }
            | ChatOperation::CliInput { session_id, .. }
            | ChatOperation::CliResize { session_id, .. }
            | ChatOperation::CliAttach { session_id, .. } => session_id.clone(),
            _ => return Err("Not a CLI operation.".into()),
        };
        let native = self.resolve(&remote_id)?;
        if let ChatOperation::CliAttach {
            upload_id,
            offset,
            total,
            data,
            bracketed,
            ..
        } = operation
        {
            return self
                .attach(app, &native, &upload_id, offset, total, &data, bracketed)
                .await;
        }
        if let Ok(mut sizes) = SIZES.lock() {
            let now = Instant::now();
            match &operation {
                ChatOperation::CliResize { .. } if sizes.phone_resized(&native, now) => {
                    restore_when_phone_leaves(app.clone(), native.clone());
                }
                ChatOperation::CliRead { .. } => sizes.phone_read(&native, now),
                _ => {}
            }
        }
        let background = crate::agent_daemon::owns(&native);
        if !background {
            return self.perform_local(&registry, &crate::agent::EventSink(app.clone()), operation);
        }
        let result = match operation {
            ChatOperation::CliRead { cursor, .. } => {
                let value = daemon
                    .request(
                        false,
                        crate::agent_daemon::Request::Observe {
                            session_id: native,
                            cursor,
                            max_bytes: 24 * 1024,
                        },
                    )
                    .await?;
                let mut range: crate::agent::AgentOutputRange = serde_json::from_value(value)
                    .map_err(|_| "Cannot read the background CLI output.")?;
                range.session_id = remote_id;
                serde_json::to_value(range).map_err(|e| e.to_string())?
            }
            ChatOperation::CliInput { data, .. } => {
                use base64::Engine;
                self.check()?;
                daemon
                    .request(
                        false,
                        crate::agent_daemon::Request::Send {
                            session_id: native,
                            data: base64::engine::general_purpose::STANDARD.encode(data.as_bytes()),
                        },
                    )
                    .await?;
                Value::Null
            }
            ChatOperation::CliResize { cols, rows, .. } => {
                self.check()?;
                daemon
                    .request(
                        false,
                        crate::agent_daemon::Request::Resize {
                            session_id: native,
                            cols,
                            rows,
                        },
                    )
                    .await?;
                Value::Null
            }
            _ => return Err("Not a CLI operation.".into()),
        };
        self.check()?;
        Ok(result)
    }
    #[allow(clippy::too_many_arguments)]
    async fn attach(
        &self,
        app: &AppHandle,
        native: &str,
        upload_id: &str,
        offset: u32,
        total: u32,
        data: &str,
        bracketed: bool,
    ) -> Result<Value, String> {
        use base64::Engine;
        let engine = base64::engine::general_purpose::STANDARD;
        let piece = engine
            .decode(data)
            .map_err(|_| "Part of the image was damaged. Send the image again.")?;
        let piece = self.uploads.lock().map_err(|e| e.to_string())?.add(
            native,
            upload_id,
            offset,
            total,
            &piece,
            Instant::now(),
        )?;
        let image = match piece {
            Piece::Partial(received) => return Ok(json!({"received": received, "done": false})),
            Piece::AlreadyPasted => return Ok(json!({"received": total, "done": true})),
            Piece::Done(image) => image,
        };
        let suffix = image_suffix(&image).ok_or("Only PNG or JPEG images can be sent.")?;
        self.check()?;
        let background = crate::agent_daemon::owns(native);
        let path = if background {
            app.state::<crate::AppDaemon>()
                .request(
                    false,
                    crate::agent_daemon::Request::StageImage {
                        session_id: native.to_string(),
                        png: engine.encode(&image),
                    },
                )
                .await?
                .as_str()
                .map(str::to_string)
                .ok_or("Cannot save the image on the host.")?
        } else {
            use std::io::Write as _;
            let mut file = tempfile::Builder::new()
                .prefix("latticeterm-phone-")
                .suffix(suffix)
                .tempfile()
                .map_err(|e| format!("Cannot save the image on the host: {e}"))?;
            file.write_all(&image)
                .map_err(|e| format!("Cannot save the image on the host: {e}"))?;
            app.state::<Arc<AgentRegistry>>()
                .stage_clipboard_image(native, file)?
                .to_string_lossy()
                .into_owned()
        };
        // The path stays on the host; only the CLI sees it.
        let paste = engine.encode(pasted_path(&path, bracketed).as_bytes());
        self.check()?;
        if background {
            app.state::<crate::AppDaemon>()
                .request(
                    false,
                    crate::agent_daemon::Request::Send {
                        session_id: native.to_string(),
                        data: paste,
                    },
                )
                .await?;
        } else {
            crate::agent::send(
                &crate::agent::EventSink(app.clone()),
                app.state::<Arc<AgentRegistry>>().inner(),
                native,
                &paste,
            )?;
        }
        if let Ok(mut uploads) = self.uploads.lock() {
            uploads.pasted(native, upload_id, Instant::now());
        }
        Ok(json!({"received": total, "done": true}))
    }
    fn perform_local(
        &self,
        registry: &AgentRegistry,
        sink: &dyn crate::agent::AgentSink,
        operation: ChatOperation,
    ) -> Result<Value, String> {
        let id = match &operation {
            ChatOperation::CliRead { session_id, .. }
            | ChatOperation::CliInput { session_id, .. }
            | ChatOperation::CliResize { session_id, .. } => session_id,
            _ => return Err("Not a terminal operation.".into()),
        };
        let native = self.resolve(id)?;
        match &operation {
            ChatOperation::CliRead { cursor, .. } => {
                let mut range = registry.output_range(&native, *cursor, 24 * 1024)?;
                range.session_id = id.clone();
                serde_json::to_value(range).map_err(|e| e.to_string())
            }
            ChatOperation::CliInput { data, .. } => {
                use base64::Engine;
                crate::agent::send(
                    sink,
                    registry,
                    &native,
                    &base64::engine::general_purpose::STANDARD.encode(data.as_bytes()),
                )?;
                Ok(Value::Null)
            }
            ChatOperation::CliResize { cols, rows, .. } => {
                crate::agent::resize(registry, &native, *cols, *rows)?;
                Ok(Value::Null)
            }
            _ => unreachable!(),
        }
    }
}

#[cfg(test)]
mod upload_tests {
    use super::*;
    #[test]
    fn phone_images_arrive_in_order_and_retries_are_not_pasted_twice() {
        let now = Instant::now();
        let mut uploads = Uploads::default();
        assert!(matches!(
            uploads.add("s", "u", 0, 6, b"abc", now),
            Ok(Piece::Partial(3))
        ));
        assert!(matches!(
            uploads.add("s", "u", 0, 6, b"abc", now),
            Ok(Piece::Partial(3))
        ));
        assert!(uploads.add("other", "u", 3, 6, b"def", now).is_err());
        assert!(matches!(
            uploads.add("s", "u", 0, 6, b"abc", now),
            Ok(Piece::Partial(3))
        ));
        let Ok(Piece::Done(bytes)) = uploads.add("s", "u", 3, 6, b"def", now) else {
            panic!("the last piece completes the image");
        };
        assert_eq!(bytes, b"abcdef");
        uploads.pasted("s", "u", now);
        assert!(matches!(
            uploads.add("s", "u", 3, 6, b"def", now),
            Ok(Piece::AlreadyPasted)
        ));
        assert!(uploads.add("s", "gap", 3, 6, b"def", now).is_err());
        assert!(uploads.add("s", "skip", 0, 9, b"abc", now).is_ok());
        assert!(uploads.add("s", "skip", 6, 9, b"ghi", now).is_err());
        assert!(uploads.add("s", "skip", 3, 9, b"def", now).is_err());
        assert!(uploads.add("s", "long", 0, 2, b"abc", now).is_err());
        for id in ["a", "b", "c", "d"] {
            assert!(uploads.add("s", id, 0, 9, b"abc", now).is_ok());
        }
        assert!(uploads.add("s", "e", 0, 9, b"abc", now).is_err());
        let later = now + UPLOAD_TTL;
        assert!(uploads.add("s", "e", 0, 9, b"abc", later).is_ok());
        assert!(uploads.add("s", "a", 3, 9, b"def", later).is_err());
    }
    #[test]
    fn only_png_or_jpeg_is_pasted_as_a_plain_path() {
        assert_eq!(image_suffix(b"\x89PNG\r\n\x1a\nrest"), Some(".png"));
        assert_eq!(image_suffix(&[0xff, 0xd8, 0xff, 0xe0]), Some(".jpg"));
        assert_eq!(image_suffix(b"GIF89a"), None);
        assert_eq!(image_suffix(b"<svg"), None);
        assert_eq!(pasted_path("/tmp/a b.jpg", false), "/tmp/a b.jpg");
        assert_eq!(
            pasted_path("/tmp/a\r.jpg", true),
            "\x1b[200~/tmp/a.jpg\x1b[201~"
        );
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::agent::{self, AgentLifecycle, AgentSink, AgentStateSource, AgentTokenUsage};
    use base64::Engine;
    struct Sink;
    impl AgentSink for Sink {
        fn data(&self, _: &str, _: u64, _: &[u8]) {}
        fn state(&self, _: &str, _: AgentLifecycle, _: AgentStateSource) {}
        fn closed(&self, _: &str, _: &str) {}
        fn captured(&self, _: &str, _: &str) {}
        fn model(&self, _: &str, _: &str) {}
        fn usage(&self, _: &str, _: &AgentTokenUsage) {}
        fn queue(&self, _: &str, _: usize) {}
    }
    #[test]
    fn the_desktop_size_comes_back_after_the_phone_goes_quiet() {
        let mut sizes = Sizes::default();
        let start = Instant::now();
        sizes.desktop.insert("a".into(), (180, 48));
        assert!(sizes.phone_resized("a", start));
        assert!(!sizes.phone_resized("a", start));
        sizes.phone_read("a", start + Duration::from_secs(4));
        assert_eq!(sizes.phone_left("a", start + Duration::from_secs(6)), None);
        assert_eq!(
            sizes.phone_left("a", start + Duration::from_secs(9)),
            Some(Some((180, 48)))
        );
        assert_eq!(sizes.phone_left("a", start + Duration::from_secs(20)), None);
        sizes.phone_read("b", start);
        assert!(!sizes.phone.contains_key("b"));
    }
    #[test]
    fn escaped_labels_keep_a_full_list_within_the_wire_budget() {
        let hostile = "\\\"".repeat(1000);
        let value = json!({"id": "a".repeat(32), "label": label(&hostile), "groupLabel": label(&hostile), "agent": label(&hostile), "state": "needsAttention", "detached": false, "model": label(&hostile), "project": project_name(&format!("/x/{hostile}")), "directory": short_directory(&format!("/x/{}", hostile.repeat(8)), None), "proxy": true});
        let response =
            json!({"id": "r".repeat(160), "value": vec![value; MAX_LISTED], "error": null});
        assert!(serde_json::to_vec(&response).unwrap().len() <= 60 * 1024);
    }
    #[test]
    fn the_list_names_the_project_folder_and_proxy_without_the_path() {
        assert_eq!(
            project_name("/data/me/projects/LatticeTerm/"),
            "LatticeTerm"
        );
        assert_eq!(project_name("C:\\Users\\me\\VowBook"), "VowBook");
        assert_eq!(
            short_directory("/home/me/projects/LatticeTerm/", Some("/home/me")),
            "~/projects/LatticeTerm"
        );
        assert_eq!(short_directory("/home/me", Some("/home/me/")), "~");
        assert_eq!(
            short_directory("/home/meow/x", Some("/home/me")),
            "/home/meow/x"
        );
        let deep = format!("/data/{}/LatticeTerm", "a".repeat(300));
        let shown = short_directory(&deep, None);
        assert!(shown.starts_with('…') && shown.ends_with("/LatticeTerm"));
        assert!(shown.len() <= 160);
        assert_eq!(project_name(""), "");
        let proxied = ["-c", "model_provider=latticeterm_cliproxyapi_work"].map(String::from);
        assert!(uses_cli_proxy(&proxied));
        assert!(!uses_cli_proxy(&["-c", "model=gpt"].map(String::from)));
        assert!(!uses_cli_proxy(&[
            "model_provider=latticeterm_cliproxyapi".to_string()
        ]));
    }
    #[test]
    fn existing_pty_lists_reads_accepts_input_and_revokes_without_relaunch() {
        let registry = Arc::new(AgentRegistry::new());
        struct Cleanup(Arc<AgentRegistry>);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                self.0.stop_all();
            }
        }
        let _cleanup = Cleanup(registry.clone());
        let request = serde_json::from_value(json!({"definitionId":"custom", "label":"Existing test CLI", "executable":"/bin/cat", "workingDirectory":std::env::temp_dir(), "cols":80, "rows":24})).unwrap();
        let session = agent::launch(Arc::new(Sink), registry.clone(), request).unwrap();
        let denied = Access::new(false);
        assert!(denied.project(registry.list()).is_err());
        let access = Access::new(true);
        let list = access.project(registry.list()).unwrap();
        let id = list[0]["id"].as_str().unwrap().to_string();
        assert_ne!(id, session.session_id);
        let text = serde_json::to_string(&list).unwrap();
        for excluded in [
            "processId",
            "profileConfigPath",
            "executable",
            "launchArguments",
            "capturedSessionId",
            "workingDirectory",
        ] {
            assert!(!text.contains(excluded));
        }
        assert!(access.resolve(&session.session_id).is_err());
        assert_eq!(access.project(registry.list()).unwrap()[0]["id"], id);
        access
            .perform_local(
                &registry,
                &Sink,
                ChatOperation::CliResize {
                    session_id: id.clone(),
                    cols: 100,
                    rows: 30,
                },
            )
            .unwrap();
        access
            .perform_local(
                &registry,
                &Sink,
                ChatOperation::CliInput {
                    session_id: id.clone(),
                    data: "remote-cli-中文\r".into(),
                },
            )
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            let output = access
                .perform_local(
                    &registry,
                    &Sink,
                    ChatOperation::CliRead {
                        session_id: id.clone(),
                        cursor: 0,
                    },
                )
                .unwrap();
            assert_eq!(output["sessionId"], id);
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(output["base64"].as_str().unwrap())
                .unwrap();
            if String::from_utf8_lossy(&bytes).contains("remote-cli-中文") {
                let next = output["nextCursor"].as_u64().unwrap();
                let page = access
                    .perform_local(
                        &registry,
                        &Sink,
                        ChatOperation::CliRead {
                            session_id: id.clone(),
                            cursor: next,
                        },
                    )
                    .unwrap();
                assert_eq!(page["cursor"], next);
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "PTY did not receive input"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(registry.list()[0].process_id, session.process_id);
        access.revoke();
        assert!(access
            .perform_local(
                &registry,
                &Sink,
                ChatOperation::CliInput {
                    session_id: id.clone(),
                    data: "forbidden\r".into()
                }
            )
            .is_err());
        assert!(access.project(registry.list()).is_err());
        assert!(Access::new(true).resolve(&id).is_err());
        assert_eq!(registry.list()[0].process_id, session.process_id);
    }
}
