use super::codex_input_profile::{
    self, Output, ProbeChild, ProbeContext, ProcessJob, SupportedProfile, UnavailableReason,
};
use serde_json::{json, Value};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const RPC_TIMEOUT: Duration = Duration::from_secs(4);
const START_TIMEOUT: Duration = Duration::from_secs(12);
const MAX_HELP_BYTES: usize = 16 * 1024;

struct RpcClient {
    socket: tungstenite::WebSocket<uds_windows::UnixStream>,
    frames: usize,
}

impl RpcClient {
    fn send(&mut self, value: Value, deadline: Instant) -> Result<(), UnavailableReason> {
        self.set_timeout(deadline)?;
        let payload = serde_json::to_string(&value).map_err(|_| UnavailableReason::ProbeFailed)?;
        self.socket
            .send(tungstenite::Message::Text(payload.into()))
            .map_err(socket_error)
    }

    fn set_timeout(&mut self, deadline: Instant) -> Result<(), UnavailableReason> {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or(UnavailableReason::TimedOut)?;
        self.socket
            .get_mut()
            .set_read_timeout(Some(remaining))
            .map_err(|_| UnavailableReason::ProbeFailed)?;
        self.socket
            .get_mut()
            .set_write_timeout(Some(remaining))
            .map_err(|_| UnavailableReason::ProbeFailed)
    }

    fn reply(&mut self, id: u64, deadline: Instant) -> Result<Value, UnavailableReason> {
        loop {
            self.set_timeout(deadline)?;
            self.frames += 1;
            if self.frames > 128 {
                return Err(UnavailableReason::OutputLimit);
            }
            match self.socket.read().map_err(socket_error)? {
                tungstenite::Message::Text(payload) => {
                    let value: Value = serde_json::from_str(payload.as_str())
                        .map_err(|_| UnavailableReason::ProbeFailed)?;
                    if value.get("id").and_then(Value::as_u64) == Some(id) {
                        return value
                            .get("result")
                            .cloned()
                            .ok_or(UnavailableReason::ProbeFailed);
                    }
                }
                tungstenite::Message::Ping(_) | tungstenite::Message::Pong(_) => {}
                _ => return Err(UnavailableReason::ProbeFailed),
            }
        }
    }
}

fn socket_error(error: tungstenite::Error) -> UnavailableReason {
    match error {
        tungstenite::Error::Io(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
            ) =>
        {
            UnavailableReason::TimedOut
        }
        tungstenite::Error::Capacity(_) => UnavailableReason::OutputLimit,
        _ => UnavailableReason::ProbeFailed,
    }
}

pub(super) struct CodexControl {
    context: ProbeContext,
    socket: PathBuf,
    server: Mutex<OwnedServer>,
    _socket_directory: std::fs::File,
    _directory: tempfile::TempDir,
}

struct OwnedServer {
    child: Child,
    job: Option<ProcessJob>,
}

impl Drop for OwnedServer {
    fn drop(&mut self) {
        self.job.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum State {
    Idle,
    Working,
    NeedsAttention,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Snapshot {
    pub thread_id: String,
    pub state: State,
}

impl CodexControl {
    pub(super) fn start(
        context: &ProbeContext,
    ) -> Result<(Self, SupportedProfile), UnavailableReason> {
        let profile = codex_input_profile::inspect_protocol(context)?;
        let deadline = Instant::now() + START_TIMEOUT;
        let help = capture_help(context, &["-h"], deadline)?;
        let server_help = capture_help(context, &["app-server", "-h"], deadline)?;
        let queue_help = capture_help(context, &["queue", "-h"], deadline)?;
        if !supports_protocol(&help, &server_help, &queue_help) {
            return Err(UnavailableReason::UnsupportedLaunch);
        }
        let directory = tempfile::Builder::new()
            .prefix("lt-codex-")
            .tempdir()
            .map_err(|_| UnavailableReason::ProbeFailed)?;
        codex_input_profile::qualify_local_path(directory.path())?;
        let private_directory = directory.path().join("private");
        let socket_directory =
            crate::agent_daemon::audit::create_private_runtime_directory(&private_directory)
                .map_err(|_| UnavailableReason::UnverifiableSource)?;
        let socket = private_directory.join("control.sock");
        if socket.as_os_str().to_string_lossy().len() > 100 {
            return Err(UnavailableReason::UnsupportedLaunch);
        }
        let mut arguments = codex_input_profile::probe_arguments(context)?;
        arguments.truncate(arguments.len() - 2);
        arguments.extend([
            OsString::from("app-server"),
            OsString::from("--listen"),
            OsString::from(format!("unix://{}", socket.display())),
        ]);
        let mut command = Command::new(&context.native_executable);
        command
            .args(arguments)
            .current_dir(&context.cwd)
            .env_clear()
            .envs(context.environment.clone())
            .env("CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let mut child = command
            .spawn()
            .map_err(|_| UnavailableReason::ProbeFailed)?;
        let job = match ProcessJob::attach(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let control = Self {
            context: context.clone(),
            socket,
            server: Mutex::new(OwnedServer {
                child,
                job: Some(job),
            }),
            _socket_directory: socket_directory,
            _directory: directory,
        };
        loop {
            control.ensure_alive()?;
            if control.socket.exists() {
                let mut client = control.client(deadline)?;
                let loaded = rpc(&mut client, 2, "thread/loaded/list", json!({}), deadline)?;
                loaded_thread_ids(&loaded)?;
                profile.revalidate(context)?;
                return Ok((control, profile));
            }
            if Instant::now() >= deadline {
                return Err(UnavailableReason::TimedOut);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    pub(super) fn endpoint(&self) -> OsString {
        format!("unix://{}", self.socket.display()).into()
    }

    pub(super) fn shutdown(&self) {
        if let Ok(mut server) = self.server.lock() {
            server.job.take();
            let _ = server.child.kill();
            let _ = server.child.wait();
        }
    }

    fn ensure_alive(&self) -> Result<(), UnavailableReason> {
        let mut server = self
            .server
            .lock()
            .map_err(|_| UnavailableReason::ProbeFailed)?;
        match server.child.try_wait() {
            Ok(None) => Ok(()),
            _ => Err(UnavailableReason::ProbeFailed),
        }
    }

    fn client(&self, deadline: Instant) -> Result<RpcClient, UnavailableReason> {
        self.ensure_alive()?;
        let socket = uds_windows::UnixStream::connect(&self.socket)
            .map_err(|_| UnavailableReason::ProbeFailed)?;
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or(UnavailableReason::TimedOut)?;
        socket
            .set_read_timeout(Some(remaining))
            .map_err(|_| UnavailableReason::ProbeFailed)?;
        socket
            .set_write_timeout(Some(remaining))
            .map_err(|_| UnavailableReason::ProbeFailed)?;
        let config = tungstenite::protocol::WebSocketConfig::default()
            .max_message_size(Some(1024 * 1024))
            .max_frame_size(Some(1024 * 1024));
        let (socket, _) =
            tungstenite::client::client_with_config("ws://localhost/", socket, Some(config))
                .map_err(|error| match error {
                    tungstenite::HandshakeError::Failure(error) => socket_error(error),
                    tungstenite::HandshakeError::Interrupted(_) => UnavailableReason::TimedOut,
                })?;
        let mut client = RpcClient { socket, frames: 0 };
        rpc(
            &mut client,
            1,
            "initialize",
            json!({
            "clientInfo":{"name":"latticeterm-terminal-control","version":"1"},
            "capabilities":{"experimentalApi":true,
                "optOutNotificationMethods":["item/agentMessage/delta","item/reasoning/textDelta",
                    "item/reasoning/summaryTextDelta","item/commandExecution/outputDelta",
                    "item/fileChange/outputDelta"]}}),
            deadline,
        )?;
        client.send(json!({"method":"initialized"}), deadline)?;
        Ok(client)
    }

    pub(super) fn snapshot(
        &self,
        expected: Option<&str>,
    ) -> Result<Option<Snapshot>, UnavailableReason> {
        let deadline = Instant::now() + RPC_TIMEOUT;
        let mut client = self.client(deadline)?;
        self.snapshot_with(&mut client, expected, deadline)
    }

    fn snapshot_with(
        &self,
        client: &mut RpcClient,
        expected: Option<&str>,
        deadline: Instant,
    ) -> Result<Option<Snapshot>, UnavailableReason> {
        let loaded = rpc(client, 2, "thread/loaded/list", json!({}), deadline)?;
        let ids = loaded_thread_ids(&loaded)?;
        let candidates = select_candidates(&ids, expected)?;
        let mut root = None;
        for (index, thread_id) in candidates.iter().enumerate() {
            let response = rpc(
                client,
                10 + index as u64,
                "thread/read",
                json!({"threadId":thread_id,"includeTurns":false}),
                deadline,
            )?;
            if let Some(mut snapshot) = parse_snapshot(&response, thread_id, &self.context.cwd)? {
                if snapshot.state == State::Idle {
                    let queue = rpc(
                        client,
                        50 + index as u64,
                        "thread/queue/list",
                        json!({"threadId":thread_id,"limit":1}),
                        deadline,
                    )?;
                    if !queue_is_empty(&queue)? {
                        snapshot.state = State::Working;
                    }
                }
                if root.is_some() {
                    return Err(UnavailableReason::ProbeFailed);
                }
                root = Some(snapshot);
            }
        }
        if expected.is_some() && root.is_none() {
            return Err(UnavailableReason::ProbeFailed);
        }
        Ok(root)
    }

    pub(super) fn send(
        &self,
        thread_id: &str,
        text: &str,
        authorized: impl Fn() -> bool,
    ) -> Result<(), String> {
        let deadline = Instant::now() + RPC_TIMEOUT;
        let mut client = self
            .client(deadline)
            .map_err(|_| CONTROL_UNAVAILABLE.to_string())?;
        let snapshot = self
            .snapshot_with(&mut client, Some(thread_id), deadline)
            .map_err(|_| CONTROL_UNAVAILABLE.to_string())?
            .ok_or_else(|| CONTROL_UNAVAILABLE.to_string())?;
        if snapshot.state != State::Idle || !authorized() {
            return Err("The original Codex conversation is not ready for this MCP prompt.".into());
        }
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).map_err(|_| CONTROL_UNAVAILABLE.to_string())?;
        nonce[6] = (nonce[6] & 0x0f) | 0x40;
        nonce[8] = (nonce[8] & 0x3f) | 0x80;
        let hex: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
        let message_id = format!(
            "{}-{}-{}-{}-{}",
            &hex[..8],
            &hex[8..12],
            &hex[12..16],
            &hex[16..20],
            &hex[20..]
        );
        if !authorized() {
            return Err("This session is not under active MCP control.".into());
        }
        client
            .send(
                json!({"id":100,"method":"thread/queue/add","params":{
            "threadId":thread_id,"clientUserMessageId":message_id,
            "input":[{"type":"text","text":text,"text_elements":[]}]}}),
                deadline,
            )
            .map_err(|_| CONTROL_OUTCOME_UNKNOWN.to_string())?;
        let response = client
            .reply(100, deadline)
            .map_err(|_| CONTROL_OUTCOME_UNKNOWN.to_string())?;
        validate_receipt(&response, &message_id)
            .map_err(|_| CONTROL_OUTCOME_UNKNOWN.to_string())?;
        if !authorized() {
            return Err(CONTROL_OUTCOME_UNKNOWN.to_string());
        }
        Ok(())
    }
}

pub(super) const CONTROL_UNAVAILABLE: &str = "The original Codex app server is unavailable or its conversation identity could not be verified. No replacement server or PTY input was used.";
pub(super) const CONTROL_OUTCOME_UNKNOWN: &str = "The Codex queue request outcome could not be confirmed. Do not resend automatically; inspect the original conversation first. No PTY fallback was used.";

fn capture_help(
    context: &ProbeContext,
    arguments: &[&str],
    deadline: Instant,
) -> Result<String, UnavailableReason> {
    let args: Vec<OsString> = arguments.iter().map(OsString::from).collect();
    let child = ProbeChild::spawn(context, &args)?;
    let mut bytes = Vec::new();
    loop {
        match child.next(deadline)? {
            Output::Line(line) => {
                bytes.extend(line);
                if bytes.len() > MAX_HELP_BYTES {
                    return Err(UnavailableReason::OutputLimit);
                }
            }
            Output::Eof => {
                return String::from_utf8(bytes).map_err(|_| UnavailableReason::ProbeFailed)
            }
            Output::Failed(error) => return Err(error),
        }
    }
}

fn supports_protocol(help: &str, server: &str, queue: &str) -> bool {
    help.contains("--remote <")
        && server.contains("--listen <")
        && queue.contains("--thread <")
        && queue.contains("--message <")
}

fn rpc(
    client: &mut RpcClient,
    id: u64,
    method: &str,
    params: Value,
    deadline: Instant,
) -> Result<Value, UnavailableReason> {
    client.send(json!({"id":id,"method":method,"params":params}), deadline)?;
    client.reply(id, deadline)
}

fn loaded_thread_ids(response: &Value) -> Result<Vec<String>, UnavailableReason> {
    if response
        .get("nextCursor")
        .is_none_or(|cursor| !cursor.is_null())
    {
        return Err(UnavailableReason::ProbeFailed);
    }
    response
        .get("data")
        .and_then(Value::as_array)
        .filter(|ids| ids.len() <= 32)
        .ok_or(UnavailableReason::ProbeFailed)?
        .iter()
        .map(|id| {
            id.as_str()
                .filter(|id| valid_thread_id(id))
                .map(str::to_owned)
                .ok_or(UnavailableReason::ProbeFailed)
        })
        .collect()
}

fn valid_thread_id(thread_id: &str) -> bool {
    thread_id.len() == 36
        && thread_id.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

fn select_candidates(
    ids: &[String],
    expected: Option<&str>,
) -> Result<Vec<String>, UnavailableReason> {
    if let Some(expected) = expected {
        if !valid_thread_id(expected) || !ids.iter().any(|id| id == expected) {
            return Err(UnavailableReason::ProbeFailed);
        }
        Ok(vec![expected.to_owned()])
    } else {
        Ok(ids.to_vec())
    }
}

fn parse_snapshot(
    response: &Value,
    expected: &str,
    cwd: &Path,
) -> Result<Option<Snapshot>, UnavailableReason> {
    let thread = response
        .get("thread")
        .ok_or(UnavailableReason::ProbeFailed)?;
    if thread.get("id").and_then(Value::as_str) != Some(expected) {
        return Err(UnavailableReason::ProbeFailed);
    }
    if thread.get("source").is_some_and(Value::is_object) {
        return Ok(None);
    }
    if thread.get("ephemeral") == Some(&Value::Bool(true))
        || thread
            .get("threadSource")
            .is_some_and(|source| !source.is_null() && source.as_str() != Some("user"))
    {
        return Ok(None);
    }
    if !matches!(
        thread.get("source").and_then(Value::as_str),
        Some("cli" | "vscode")
    ) {
        return Err(UnavailableReason::ProbeFailed);
    }
    let directory = thread
        .get("cwd")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or(UnavailableReason::ProbeFailed)?;
    let actual = directory
        .canonicalize()
        .map_err(|_| UnavailableReason::ProbeFailed)?;
    let expected_directory = cwd
        .canonicalize()
        .map_err(|_| UnavailableReason::ProbeFailed)?;
    if actual != expected_directory {
        return Err(UnavailableReason::ProbeFailed);
    }
    let status = thread.get("status").ok_or(UnavailableReason::ProbeFailed)?;
    let state = match status.get("type").and_then(Value::as_str) {
        Some("idle") => State::Idle,
        Some("active") => {
            let flags = status
                .get("activeFlags")
                .and_then(Value::as_array)
                .ok_or(UnavailableReason::ProbeFailed)?;
            if flags.is_empty() {
                State::Working
            } else {
                State::NeedsAttention
            }
        }
        Some("systemError") => State::NeedsAttention,
        _ => return Err(UnavailableReason::ProbeFailed),
    };
    Ok(Some(Snapshot {
        thread_id: expected.to_owned(),
        state,
    }))
}

fn queue_is_empty(response: &Value) -> Result<bool, UnavailableReason> {
    let data = response
        .get("data")
        .and_then(Value::as_array)
        .ok_or(UnavailableReason::ProbeFailed)?;
    let cursor = response
        .get("nextCursor")
        .ok_or(UnavailableReason::ProbeFailed)?;
    Ok(data.is_empty() && cursor.is_null())
}

fn validate_receipt(response: &Value, message_id: &str) -> Result<(), UnavailableReason> {
    let receipt = response
        .get("queuedSubmission")
        .ok_or(UnavailableReason::ProbeFailed)?;
    if receipt
        .get("id")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
        || receipt.get("clientUserMessageId").and_then(Value::as_str) != Some(message_id)
    {
        return Err(UnavailableReason::ProbeFailed);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const ROOT: &str = "00000000-0000-4000-8000-000000000001";
    const OTHER: &str = "00000000-0000-4000-8000-000000000002";

    #[test]
    fn codex_mcp_submit_control_capability_probe_has_no_version_allowlist() {
        assert!(supports_protocol(
            "--remote <ADDR>",
            "--listen <TRANSPORT>",
            "--thread <THREAD> --message <TEXT>"
        ));
        assert!(!supports_protocol(
            "--remote <ADDR>",
            "other commands",
            "--thread <THREAD> --message <TEXT>"
        ));
        assert!(!supports_protocol(
            "--remote <ADDR>",
            "--listen <TRANSPORT>",
            "unknown command"
        ));
        assert!(!supports_protocol(
            "commands",
            "--listen <TRANSPORT>",
            "--thread <THREAD> --message <TEXT>"
        ));
    }

    #[test]
    fn codex_mcp_submit_control_rejects_incomplete_or_changed_loaded_identity() {
        assert_eq!(
            loaded_thread_ids(&json!({"data":[ROOT],"nextCursor":null})).unwrap(),
            vec![ROOT]
        );
        for response in [
            json!({"data":[ROOT]}),
            json!({"data":[ROOT],"nextCursor":"more"}),
            json!({"data":["invalid"],"nextCursor":null}),
            json!({"data":null,"nextCursor":null}),
        ] {
            assert!(loaded_thread_ids(&response).is_err());
        }
        assert_eq!(
            select_candidates(&[ROOT.into(), OTHER.into()], Some(ROOT)).unwrap(),
            vec![ROOT]
        );
        assert!(select_candidates(&[OTHER.into()], Some(ROOT)).is_err());
        assert!(select_candidates(&[ROOT.into()], Some("--last")).is_err());
    }

    #[test]
    fn codex_mcp_submit_control_only_accepts_original_root_and_official_lifecycle() {
        let directory = tempfile::tempdir().unwrap();
        let mut response = json!({"thread":{"id":ROOT,"cwd":directory.path(),"source":"cli","status":{"type":"idle"}}});
        assert_eq!(
            parse_snapshot(&response, ROOT, directory.path())
                .unwrap()
                .unwrap()
                .state,
            State::Idle
        );
        response["thread"]["status"] = json!({"type":"active","activeFlags":[]});
        response["thread"]["source"] = json!("vscode");
        assert_eq!(
            parse_snapshot(&response, ROOT, directory.path())
                .unwrap()
                .unwrap()
                .state,
            State::Working
        );
        response["thread"]["status"]["activeFlags"] = json!(["waitingOnApproval"]);
        assert_eq!(
            parse_snapshot(&response, ROOT, directory.path())
                .unwrap()
                .unwrap()
                .state,
            State::NeedsAttention
        );
        response["thread"]["status"] = json!({"type":"notLoaded"});
        assert!(parse_snapshot(&response, ROOT, directory.path()).is_err());
        response["thread"]["source"] =
            json!({"subAgent":{"thread_spawn":{"parent_thread_id":ROOT}}});
        assert!(parse_snapshot(&response, ROOT, directory.path())
            .unwrap()
            .is_none());
        response["thread"]["source"] = json!("cli");
        response["thread"]["status"] = json!({"type":"idle"});
        response["thread"]["threadSource"] = json!("thread_title");
        assert!(parse_snapshot(&response, ROOT, directory.path())
            .unwrap()
            .is_none());
        response["thread"]["threadSource"] = json!("user");
        response["thread"]["ephemeral"] = json!(true);
        assert!(parse_snapshot(&response, ROOT, directory.path())
            .unwrap()
            .is_none());
        response["thread"]["ephemeral"] = json!(false);
        for source in ["appServer", "exec", "unknown"] {
            response["thread"]["source"] = json!(source);
            assert!(parse_snapshot(&response, ROOT, directory.path()).is_err());
        }
        response["thread"]["source"] = json!("cli");
        response["thread"]["id"] = json!(OTHER);
        assert!(parse_snapshot(&response, ROOT, directory.path()).is_err());
        response["thread"]["id"] = json!(ROOT);
        response["thread"]["cwd"] = json!("relative/path");
        assert!(parse_snapshot(&response, ROOT, directory.path()).is_err());
    }

    #[test]
    fn codex_mcp_submit_control_requires_correlated_queue_receipt() {
        assert!(validate_receipt(
            &json!({"queuedSubmission":{"id":"queue-1","clientUserMessageId":ROOT}}),
            ROOT
        )
        .is_ok());
        for receipt in [
            json!({}),
            json!({"queuedSubmission":{"id":"queue-1"}}),
            json!({"queuedSubmission":{"id":"queue-1","clientUserMessageId":OTHER}}),
            json!({"queuedSubmission":{"id":"","clientUserMessageId":ROOT}}),
        ] {
            assert!(validate_receipt(&receipt, ROOT).is_err());
        }
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires LATTICETERM_TEST_CODEX_NATIVE; isolated metadata-only native app server"]
    fn codex_control_native_metadata_acceptance() {
        let native =
            std::env::var_os("LATTICETERM_TEST_CODEX_NATIVE").expect("set exact native executable");
        let directory = tempfile::tempdir().unwrap();
        let home = directory.path().join("home");
        let cwd = directory.path().join("workspace");
        std::fs::create_dir(&home).unwrap();
        std::fs::create_dir(&cwd).unwrap();
        let mut environment: Vec<_> = std::env::vars_os()
            .filter(|(key, _)| !key.to_string_lossy().eq_ignore_ascii_case("CODEX_HOME"))
            .collect();
        environment.push(("CODEX_HOME".into(), home.as_os_str().to_owned()));
        let context = ProbeContext {
            native_executable: native.into(),
            cwd,
            environment,
            arguments: vec![],
        };
        let (control, profile) = CodexControl::start(&context).unwrap();
        assert_eq!(control.snapshot(None).unwrap(), None);
        assert!(control.snapshot(Some(ROOT)).is_err());
        profile.revalidate(&context).unwrap();
        let socket = control.socket.clone();
        let pid = control.server.lock().unwrap().child.id();
        drop(control);
        assert!(!socket.exists());
        node_process_absent(pid);
    }

    #[test]
    fn codex_mcp_submit_control_rejects_pending_or_incomplete_native_queue() {
        assert!(queue_is_empty(&json!({"data":[],"nextCursor":null})).unwrap());
        assert!(!queue_is_empty(&json!({"data":[{"id":"pending"}],"nextCursor":null})).unwrap());
        assert!(!queue_is_empty(&json!({"data":[],"nextCursor":"more"})).unwrap());
        assert!(queue_is_empty(&json!({"data":[]})).is_err());
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires exact native CLI; model traffic goes only to an owned loopback fixture"]
    fn codex_control_native_original_thread_round_acceptance() {
        let fixture = MockProvider::start();
        let (_directory, context) = model_fixture_context(&fixture);
        let (control, profile) = CodexControl::start(&context).expect("native protocol start");
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut terminal_client = control.client(deadline).unwrap();
        let opened = rpc(
            &mut terminal_client,
            3,
            "thread/start",
            json!({
            "cwd":context.cwd,"model":"latticeterm-probe","modelProvider":"latticeterm_probe",
            "approvalPolicy":"on-request","sandbox":"read-only","ephemeral":false}),
            deadline,
        )
        .unwrap();
        let thread_id = opened["thread"]["id"].as_str().unwrap();
        assert!(valid_thread_id(thread_id));
        assert_eq!(
            control.snapshot(Some(thread_id)).unwrap().unwrap().state,
            State::Idle
        );
        assert!(control
            .send(OTHER, "must not create another conversation", || true)
            .is_err());
        assert!(control.send(thread_id, "not authorized", || false).is_err());
        profile.revalidate(&context).unwrap();
        let prompt = "latticeterm native control probe";
        control
            .send(thread_id, prompt, || true)
            .expect("same-thread native queue");
        let request = fixture
            .received
            .recv_timeout(Duration::from_secs(12))
            .expect("owned loopback model request");
        let input = request["input"].as_array().unwrap();
        assert!(input.iter().any(|item| item["role"] == "user"
            && item["content"]
                .as_array()
                .is_some_and(|content| content.iter().any(|part| part["text"] == prompt))));
        assert_eq!(
            control.snapshot(Some(thread_id)).unwrap().unwrap().state,
            State::Working
        );
        assert!(control
            .send(thread_id, "must not steer an active turn", || true)
            .is_err());
        fixture.release.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(12);
        loop {
            let snapshot = control.snapshot(Some(thread_id)).unwrap().unwrap();
            assert_eq!(snapshot.thread_id, thread_id);
            if snapshot.state == State::Idle {
                break;
            }
            assert!(Instant::now() < deadline, "native turn did not finish");
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(fixture.received.try_recv().is_err());
        control.shutdown();
        assert!(control.snapshot(Some(thread_id)).is_err());
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires exact native CLI; isolated real TUI and owned loopback model"]
    fn codex_control_native_tui_same_thread_acceptance() {
        let fixture = MockProvider::start();
        let (_directory, mut context) = model_fixture_context(&fixture);
        context.arguments = [
            "--no-alt-screen",
            "-m",
            "latticeterm-tui-probe",
            "-s",
            "read-only",
            "-a",
            "on-request",
            "-c",
            "check_for_update_on_startup=false",
        ]
        .into_iter()
        .map(OsString::from)
        .collect();
        let (control, profile) = CodexControl::start(&context).unwrap();
        let terminal = NativeTerminal::start(&context, control.endpoint());
        let deadline = Instant::now() + Duration::from_secs(30);
        let snapshot = loop {
            match control.snapshot(None) {
                Ok(Some(snapshot)) => break snapshot,
                Ok(None) => (),
                Err(_) => (),
            }
            assert!(
                Instant::now() < deadline,
                "real TUI did not load its thread: {}",
                terminal.output()
            );
            std::thread::sleep(Duration::from_millis(100));
        };
        assert_eq!(snapshot.state, State::Idle);
        profile.revalidate(&context).unwrap();
        let prompt = "same TUI thread native MCP probe";
        control.send(&snapshot.thread_id, prompt, || true).unwrap();
        let request = fixture
            .received
            .recv_timeout(Duration::from_secs(12))
            .unwrap();
        assert_eq!(request["model"], "latticeterm-tui-probe");
        assert!(request["input"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["role"] == "user"
                && item["content"]
                    .as_array()
                    .is_some_and(|content| content.iter().any(|part| part["text"] == prompt))));
        assert_eq!(
            control
                .snapshot(Some(&snapshot.thread_id))
                .unwrap()
                .unwrap()
                .state,
            State::Working
        );
        fixture.release.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let current = control
                .snapshot(Some(&snapshot.thread_id))
                .unwrap()
                .unwrap();
            assert_eq!(current.thread_id, snapshot.thread_id);
            if current.state == State::Idle && terminal.output().contains(prompt) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "native TUI did not render the same prompt: {}",
                terminal.output()
            );
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(fixture.received.try_recv().is_err());
        drop(terminal);
        control.shutdown();
    }

    #[cfg(windows)]
    struct NativeTerminal {
        child: Box<dyn portable_pty::Child + Send + Sync>,
        _master: Box<dyn portable_pty::MasterPty + Send>,
        output: std::sync::Arc<Mutex<Vec<u8>>>,
    }

    #[cfg(windows)]
    impl NativeTerminal {
        fn start(context: &ProbeContext, endpoint: OsString) -> Self {
            use std::io::{Read, Write};
            let pair = portable_pty::native_pty_system()
                .openpty(portable_pty::PtySize {
                    rows: 40,
                    cols: 120,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .unwrap();
            let mut command = portable_pty::CommandBuilder::new(&context.native_executable);
            command.env_clear();
            for (key, value) in &context.environment {
                command.env(key, value);
            }
            command.env("TERM", "xterm-256color");
            command.cwd(&context.cwd);
            command.args(&context.arguments);
            command.args([OsString::from("--remote"), endpoint]);
            let child = pair.slave.spawn_command(command).unwrap();
            drop(pair.slave);
            let mut reader = pair.master.try_clone_reader().unwrap();
            let mut writer = pair.master.take_writer().unwrap();
            let output = std::sync::Arc::new(Mutex::new(Vec::new()));
            let capture = std::sync::Arc::clone(&output);
            std::thread::spawn(move || {
                let mut cursor = super::super::conpty_startup::Cursor::new(true);
                let mut buffer = [0; 8192];
                while let Ok(count) = reader.read(&mut buffer) {
                    if count == 0 {
                        break;
                    }
                    let (reply, bytes) = cursor.feed(&buffer[..count]);
                    if reply {
                        let _ = writer.write_all(b"\x1b[1;1R");
                        let _ = writer.flush();
                    }
                    let mut capture = capture.lock().unwrap();
                    if capture.len() + bytes.len() <= 1024 * 1024 {
                        capture.extend(bytes);
                    }
                }
            });
            Self {
                child,
                _master: pair.master,
                output,
            }
        }

        fn output(&self) -> String {
            super::super::strip_ansi(&String::from_utf8_lossy(&self.output.lock().unwrap()))
        }
    }

    #[cfg(windows)]
    impl Drop for NativeTerminal {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    #[cfg(windows)]
    fn model_fixture_context(fixture: &MockProvider) -> (tempfile::TempDir, ProbeContext) {
        let native =
            std::env::var_os("LATTICETERM_TEST_CODEX_NATIVE").expect("set exact native executable");
        let directory = tempfile::tempdir().unwrap();
        let home = directory.path().join("home");
        let cwd = directory.path().join("workspace");
        std::fs::create_dir(&home).unwrap();
        std::fs::create_dir(&cwd).unwrap();
        std::fs::write(
            home.join("config.toml"),
            format!(
                r#"model = "latticeterm-probe"
model_provider = "latticeterm_probe"
check_for_update_on_startup = false
sandbox_mode = "read-only"
[projects.{}]
trust_level = "trusted"
[analytics]
enabled = false
[model_providers.latticeterm_probe]
name = "Owned loopback fixture"
base_url = "http://{}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
"#,
                serde_json::to_string(&cwd.to_string_lossy()).unwrap(),
                fixture.address
            ),
        )
        .unwrap();
        let mut environment: Vec<_> = std::env::vars_os()
            .filter(|(key, _)| {
                let name = key.to_string_lossy().to_ascii_uppercase();
                matches!(
                    name.as_str(),
                    "PATH"
                        | "PATHEXT"
                        | "SYSTEMROOT"
                        | "WINDIR"
                        | "PROGRAMDATA"
                        | "TEMP"
                        | "TMP"
                        | "USERPROFILE"
                        | "HOMEDRIVE"
                        | "HOMEPATH"
                        | "LOCALAPPDATA"
                        | "APPDATA"
                        | "COMSPEC"
                )
            })
            .collect();
        environment.push(("CODEX_HOME".into(), home.as_os_str().to_owned()));
        let context = ProbeContext {
            native_executable: native.into(),
            cwd,
            environment,
            arguments: vec![],
        };
        (directory, context)
    }

    #[cfg(windows)]
    struct MockProvider {
        address: std::net::SocketAddr,
        received: std::sync::mpsc::Receiver<Value>,
        release: std::sync::mpsc::Sender<()>,
        stopped: std::sync::Arc<std::sync::atomic::AtomicBool>,
        worker: Option<std::thread::JoinHandle<()>>,
    }

    #[cfg(windows)]
    impl MockProvider {
        fn start() -> Self {
            use std::io::{BufRead, Read, Write};
            use std::sync::atomic::{AtomicBool, Ordering};
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            listener.set_nonblocking(true).unwrap();
            let (sender, received) = std::sync::mpsc::channel();
            let (release, wait) = std::sync::mpsc::channel();
            let stopped = std::sync::Arc::new(AtomicBool::new(false));
            let flag = std::sync::Arc::clone(&stopped);
            let worker = std::thread::spawn(move || {
                while !flag.load(Ordering::Acquire) {
                    let Ok((mut socket, _)) = listener.accept() else {
                        std::thread::sleep(Duration::from_millis(10));
                        continue;
                    };
                    socket
                        .set_read_timeout(Some(Duration::from_secs(3)))
                        .unwrap();
                    socket
                        .set_write_timeout(Some(Duration::from_secs(3)))
                        .unwrap();
                    let mut reader = std::io::BufReader::new(socket.try_clone().unwrap());
                    let mut first = String::new();
                    if reader.read_line(&mut first).is_err() {
                        continue;
                    }
                    let mut length = 0;
                    loop {
                        let mut header = String::new();
                        if reader.read_line(&mut header).is_err()
                            || header == "\r\n"
                            || header.is_empty()
                        {
                            break;
                        }
                        if let Some((name, value)) = header.split_once(':') {
                            if name.eq_ignore_ascii_case("content-length") {
                                length = value.trim().parse::<usize>().unwrap();
                            }
                        }
                    }
                    assert!(length <= 1024 * 1024);
                    let mut body = vec![0; length];
                    if reader.read_exact(&mut body).is_err() {
                        continue;
                    }
                    if !first.starts_with("POST /v1/responses ") {
                        let response = "{\"data\":[]}";
                        let _ = write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response);
                        continue;
                    }
                    let value: Value = serde_json::from_slice(&body).expect("fixture request JSON");
                    let is_title = value["input"].as_array().is_some_and(|input| {
                        input.iter().any(|item| {
                            item["role"] == "user"
                                && item["content"].as_array().is_some_and(|content| {
                                    content.iter().any(|part| {
                                        part["text"].as_str().is_some_and(|text| {
                                            text.starts_with(
                                                "Generate a concise, single-line task title",
                                            )
                                        })
                                    })
                                })
                        })
                    });
                    if !is_title {
                        let _ = sender.send(value);
                        let _ = wait.recv_timeout(Duration::from_secs(12));
                    }
                    let text = if is_title {
                        "{\"title\":\"Native probe\"}"
                    } else {
                        "probe-ok"
                    };
                    let response = json!({"id":"fixture-response","object":"response","status":"completed",
                        "model":"latticeterm-probe","output":[{"id":"fixture-message","type":"message",
                            "role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]}],
                        "usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}});
                    let events = format!(
                        "data: {}\n\ndata: {}\n\ndata: {}\n\ndata: {}\n\n",
                        json!({"type":"response.created","response":{"id":"fixture-response","status":"in_progress"}}),
                        json!({"type":"response.output_item.added","output_index":0,"item":{"id":"fixture-message","type":"message","role":"assistant","status":"in_progress","content":[]}}),
                        json!({"type":"response.output_item.done","output_index":0,"item":response["output"][0]}),
                        json!({"type":"response.completed","response":response})
                    );
                    let _ = write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",events.len(),events);
                }
            });
            Self {
                address,
                received,
                release,
                stopped,
                worker: Some(worker),
            }
        }
    }

    #[cfg(windows)]
    impl Drop for MockProvider {
        fn drop(&mut self) {
            self.stopped
                .store(true, std::sync::atomic::Ordering::Release);
            let _ = self.release.send(());
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        }
    }

    #[cfg(windows)]
    fn node_process_absent(pid: u32) {
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if !handle.is_null() {
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(handle);
            }
            panic!("owned native server still exists");
        }
    }
}
