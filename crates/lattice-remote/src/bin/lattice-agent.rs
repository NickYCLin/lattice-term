use image::{imageops::FilterType, DynamicImage};
use lattice_remote::credentials::read_pairing_code_file;
use lattice_remote::relay::{
    format_device_id, normalize_relay_endpoint, read_server_message, write_client_message,
    DeviceIdentity, RelayClientMessage, RelayServerMessage,
};
use lattice_remote::{
    frame_messages, generate_pairing_code,
    host_files::{HostUpload, SharedFiles, UploadFinishOutcome},
    host_input::InputInjector,
    host_text::{self, HostTextUpload, TextSaveOutcome},
    normalize_pairing_code, FrameFormat, RemoteFileRequest, RemoteFileResponse, RemoteHello,
    RemoteMessage, SecureConnection, SecureWriter, Transport, DEFAULT_PORT, FILE_CHUNK_SIZE,
    MAX_FILE_ERROR_BYTES, MAX_TEXT_FILE_BYTES, PROTOCOL_VERSION,
};
use serde::Serialize;
use std::collections::HashMap;
use std::env;
use std::io::{Cursor, Read as _, Write as _};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpListener;
use tokio::runtime::Handle;
use tokio::sync::{mpsc, watch, Notify, OwnedSemaphorePermit, Semaphore};
use tokio::time::{sleep, timeout};
use xcap::Monitor;

const DEFAULT_FPS: u32 = 5;
const MAX_FPS: u32 = 10;
const MAX_WIDTH: u32 = 1280;
const MAX_HEIGHT: u32 = 720;
const MAX_PAIRING_FAILURES: u32 = 5;
const PAIRING_LIFETIME: Duration = Duration::from_secs(5 * 60);
const RELAY_PING_INTERVAL: Duration = Duration::from_secs(25);
const RELAY_RECONNECT_CAP: Duration = Duration::from_secs(60);
const REMOTE_SEND_TIMEOUT: Duration = Duration::from_secs(10);
const REMOTE_INPUT_ENQUEUE_TIMEOUT: Duration = Duration::from_secs(10);
// File work is authorised by the viewer, but still untrusted. Keep blocking
// pool demand bounded across the Agent lifetime and descriptors bounded per
// session.
const FILE_JOB_LIMIT: usize = 8;
const ACTIVE_DOWNLOAD_LIMIT: usize = 8;
const ACTIVE_UPLOAD_LIMIT: usize = 8;
const FILE_RESPONSE_ENQUEUE_TIMEOUT: Duration = Duration::from_secs(10);
const FILE_CONTROL_RESPONSE_TIMEOUT: Duration = Duration::from_millis(250);
const FILE_JOB_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(500);
const UPLOAD_COMMAND_QUEUE_CAPACITY: usize = 8;
const UPLOAD_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_UPLOAD_FILE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_SESSION_UPLOAD_BYTES: u64 = 8 * 1024 * 1024 * 1024;
static NEXT_UPLOAD_TARGET_RESERVATION: AtomicU64 = AtomicU64::new(1);
static ACTIVE_UPLOAD_TARGETS: OnceLock<Mutex<HashMap<PathBuf, u64>>> = OnceLock::new();
// Preserve every key transition while bounding the amount of work an
// authorised but abusive viewer can queue ahead of the OS input backend.
const SCREEN_INPUT_QUEUE_CAPACITY: usize = 256;
// A terminal input chunk is at most 48 KiB, so 32 queued chunks cap the PTY
// writer backlog at roughly 1.5 MiB while still accommodating large pastes.
const TERMINAL_INPUT_QUEUE_CAPACITY: usize = 32;
#[cfg(unix)]
const TERMINAL_PROCESS_GROUP_GRACE: Duration = Duration::from_millis(100);
#[cfg(unix)]
const TERMINAL_PTY_POLL_INTERVAL_MS: libc::c_int = 50;
#[cfg(target_os = "linux")]
const TERMINAL_SESSION_KILL_ROUNDS: usize = 4;
#[cfg(target_os = "linux")]
const TERMINAL_SESSION_KILL_INTERVAL: Duration = Duration::from_millis(25);

#[derive(Clone)]
struct Options {
    bind: SocketAddr,
    pairing_code: String,
    fps: u32,
    json: bool,
    allow_input: bool,
    allow_commands: bool,
    file_root: Option<PathBuf>,
    relay: Option<String>,
    identity_file: Option<PathBuf>,
    terminal: bool,
    /// Shared by every relay session so blocked filesystem calls cannot
    /// accumulate across reconnects.
    file_job_permits: Arc<Semaphore>,
    command_permits: Arc<Semaphore>,
}

#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum AgentEvent<'a> {
    Ready {
        address: String,
        pairing_code: String,
        /// Zero means the code does not expire while sharing stays on.
        expires_in_seconds: u64,
        view_only: bool,
        file_transfer: bool,
        commands: bool,
        file_root: Option<String>,
        /// Present in relay mode: the permanent nine-digit device ID.
        device_id: Option<String>,
        relay: Option<String>,
        /// True when the agent keeps serving sessions until stopped.
        persistent: bool,
    },
    PairingRequest {
        peer: String,
    },
    PairingRejected {
        attempts_remaining: u32,
    },
    Paired {
        peer: String,
    },
    /// Relay mode only: one session ended and the agent waits for the next.
    SessionEnded {
        reason: String,
    },
    /// Relay mode only: the control link dropped or came back.
    RelayState {
        connected: bool,
    },
    Failed {
        stage: &'a str,
        detail: String,
    },
    Stopped {
        reason: String,
    },
}

fn emit_event(json: bool, event: &AgentEvent<'_>) {
    if !json {
        return;
    }
    if let Ok(line) = serde_json::to_string(event) {
        println!("{line}");
        let _ = std::io::stdout().flush();
    }
}

fn help() -> &'static str {
    "Lattice Remote agent\n\n\
Usage: lattice-agent [--bind ADDRESS:PORT] [--relay HOST[:PORT]|WSS_URL] [--identity FILE]\n\
                     [--pair-code CODE|--pair-code-file FILE|--pair-code-stdin]\n\
                     [--fps 1-10] [--allow-input]\n\
                     [--file-root PATH] [--allow-commands] [--terminal] [--json]\n\n\
Direct mode (default): the safe default listens on 127.0.0.1 only. To receive\n\
a LAN connection, pass the machine's LAN address explicitly, for example\n\
--bind 192.168.1.20:44900. The agent accepts one successfully paired\n\
connection, streams the primary display over an encrypted channel, then exits.\n\n\
Relay mode: --relay connects outward to a lattice-relay server and registers\n\
this machine's permanent nine-digit device ID (kept in --identity, default\n\
under the user data folder). A viewer then reaches this machine by ID alone;\n\
the pairing code still authenticates every session end to end, the relay only\n\
forwards ciphertext, and the agent keeps serving sessions until stopped. Use\n\
wss:// through HTTPS ingress on the public Internet; raw HOST:PORT is for a\n\
trusted private network or VPN only.\n\n\
By default the session is view-only. Pass --allow-input to let the paired\n\
viewer control this machine's mouse and keyboard; without it, input messages\n\
are ignored. File access stays disabled unless --file-root explicitly shares\n\
one folder; every remote path is then confined to that folder.\n\n\
Windows commands: --allow-commands independently permits cmd / PowerShell\n\
execution as this account, beyond the file-sharing root. Off by default.\n\n\
Terminal mode: --terminal shares an encrypted shell session instead of the\n\
display, so a headless host (no desktop) works too. --allow-input lets the\n\
viewer type; without it the terminal is watch-only. --fps is ignored.\n\n\
Unattended access: use a 6-64 character ASCII password (case-sensitive letters,\n\
digits or symbols; no spaces), or keep the generated 128-bit pairing token.\n\
New agents and viewers use OPAQUE password pairing followed by Noise.\n\
Prefer --pair-code-file with an owner-only file, or pipe\n\
the code to --pair-code-stdin, so it does not appear in the process list.\n\
--pair-code remains available for interactive use. Without any of these a\n\
fresh code is generated per run. Five incomplete attempts per ten minutes are\n\
allowed across restarts, using pairing-attempts.json next to the identity file.\n\
Five failed pairings in a row also stop the agent.\n\
Typical headless setup:\n\
  lattice-agent --relay wss://relay.example.com --terminal --allow-input \\\n\
                --pair-code-file /secure/path/pair-code\n"
}

fn set_pairing_code(slot: &mut Option<String>, input: &str) -> Result<(), String> {
    if slot.is_some() {
        return Err("choose only one pairing-code source".to_string());
    }
    *slot = Some(normalize_pairing_code(input).map_err(|error| error.to_string())?);
    Ok(())
}

fn read_pairing_code_stdin() -> Result<String, String> {
    let mut input = String::new();
    std::io::stdin()
        .take(67)
        .read_to_string(&mut input)
        .map_err(|error| format!("cannot read --pair-code-stdin: {error}"))?;
    if input.len() > 66 {
        return Err(
            "--pair-code-stdin must be at most 64 characters plus a line ending".to_string(),
        );
    }
    Ok(input.trim_end_matches(['\r', '\n']).to_string())
}

fn reserve_pairing(
    options: &Options,
) -> Result<lattice_remote::pairing_limit::PairingPermit, String> {
    let identity = options
        .identity_file
        .clone()
        .or_else(default_identity_path)
        .ok_or("No durable pairing-attempt state location is available.")?;
    let path = std::path::absolute(identity.with_file_name("pairing-attempts.json"))
        .map_err(|error| error.to_string())?;
    lattice_remote::pairing_limit::PairingPermit::reserve(&path)
}

fn parse_options() -> Result<Options, String> {
    let mut bind = format!("127.0.0.1:{DEFAULT_PORT}")
        .parse()
        .expect("default address is valid");
    let mut pairing_code = None;
    let mut fps = DEFAULT_FPS;
    let mut json = false;
    let mut allow_input = false;
    let mut allow_commands = false;
    let mut file_root = None;
    let mut relay = None;
    let mut identity_file = None;
    let mut terminal = false;
    let mut arguments = env::args().skip(1);

    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--relay" => {
                let address = arguments.next().ok_or_else(|| {
                    "--relay needs HOST[:PORT], ws://URL, or wss://URL".to_string()
                })?;
                normalize_relay_endpoint(&address).map_err(|error| error.to_string())?;
                relay = Some(address);
            }
            "--identity" => {
                identity_file = Some(PathBuf::from(
                    arguments
                        .next()
                        .ok_or_else(|| "--identity needs a file path".to_string())?,
                ));
            }
            "--bind" => {
                bind = arguments
                    .next()
                    .ok_or_else(|| "--bind needs ADDRESS:PORT".to_string())?
                    .parse()
                    .map_err(|_| "--bind must be a valid IP_ADDRESS:PORT".to_string())?;
            }
            "--pair-code" => {
                let input = arguments.next().ok_or_else(|| {
                    "--pair-code needs a 6-64 character ASCII password or a generated token"
                        .to_string()
                })?;
                set_pairing_code(&mut pairing_code, &input)?;
            }
            "--pair-code-file" => {
                let path = PathBuf::from(
                    arguments
                        .next()
                        .ok_or_else(|| "--pair-code-file needs a path".to_string())?,
                );
                let input = read_pairing_code_file(&path)?;
                set_pairing_code(&mut pairing_code, &input)?;
            }
            "--pair-code-stdin" => {
                let input = read_pairing_code_stdin()?;
                set_pairing_code(&mut pairing_code, &input)?;
            }
            "--fps" => {
                fps = arguments
                    .next()
                    .ok_or_else(|| "--fps needs a number".to_string())?
                    .parse()
                    .map_err(|_| "--fps must be a number".to_string())?;
                if !(1..=MAX_FPS).contains(&fps) {
                    return Err(format!("--fps must be between 1 and {MAX_FPS}"));
                }
            }
            "--json" => json = true,
            "--allow-input" => allow_input = true,
            "--allow-commands" => {
                if !cfg!(windows) {
                    return Err("Command execution requires a Windows sharing host.".into());
                }
                allow_commands = true;
            }
            "--terminal" => terminal = true,
            "--file-root" => {
                let path = PathBuf::from(
                    arguments
                        .next()
                        .ok_or_else(|| "--file-root needs a folder path".to_string())?,
                );
                file_root = Some(SharedFiles::open(&path)?.root().to_path_buf());
            }
            "--help" | "-h" => {
                print!("{}", help());
                std::process::exit(0);
            }
            unknown => return Err(format!("unknown option: {unknown}")),
        }
    }

    Ok(Options {
        bind,
        pairing_code: pairing_code
            .map(Ok)
            .unwrap_or_else(generate_pairing_code)
            .map_err(|error| error.to_string())?,
        fps,
        json,
        allow_input,
        allow_commands,
        file_root,
        relay,
        identity_file,
        terminal,
        file_job_permits: Arc::new(Semaphore::new(FILE_JOB_LIMIT)),
        command_permits: Arc::new(Semaphore::new(2)),
    })
}

fn default_identity_path() -> Option<PathBuf> {
    if cfg!(windows) {
        env::var_os("APPDATA").map(|base| {
            PathBuf::from(base)
                .join("LatticeRemote")
                .join("identity.json")
        })
    } else {
        env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                env::var_os("HOME").map(|home| PathBuf::from(home).join(".local").join("share"))
            })
            .map(|base| base.join("lattice-remote").join("identity.json"))
    }
}

fn target_size(width: u32, height: u32) -> (u32, u32) {
    if width <= MAX_WIDTH && height <= MAX_HEIGHT {
        return (width, height);
    }
    let scale = (MAX_WIDTH as f64 / width as f64).min(MAX_HEIGHT as f64 / height as f64);
    (
        (width as f64 * scale).round().max(1.0) as u32,
        (height as f64 * scale).round().max(1.0) as u32,
    )
}

/// A single capture: the real captured size, the downscaled stream size, and
/// the encoded JPEG at the stream size.
struct Capture {
    display_width: u32,
    display_height: u32,
    stream_width: u32,
    stream_height: u32,
    jpeg: Vec<u8>,
}

fn capture_jpeg(monitor: &Monitor) -> Result<Capture, String> {
    let captured = monitor.capture_image().map_err(|error| error.to_string())?;
    let (display_width, display_height) = (captured.width(), captured.height());
    let (stream_width, stream_height) = target_size(display_width, display_height);
    let image = if display_width == stream_width && display_height == stream_height {
        captured
    } else {
        image::imageops::resize(&captured, stream_width, stream_height, FilterType::Triangle)
    };

    let mut output = Cursor::new(Vec::new());
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, 68);
    encoder
        .encode_image(&DynamicImage::ImageRgba8(image))
        .map_err(|error| error.to_string())?;
    Ok(Capture {
        display_width,
        display_height,
        stream_width,
        stream_height,
        jpeg: output.into_inner(),
    })
}

/// Runs the OS input backend on its own thread. `enigo::Enigo` is not portable
/// across async await points, so it lives here and consumes decoded inputs off
/// a channel. Returns when the channel closes (viewer gone), releasing keys.
fn spawn_input_thread(
    stream_width: u32,
    stream_height: u32,
    display_width: u32,
    display_height: u32,
    mut inputs: mpsc::Receiver<lattice_remote::RemoteInput>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut injector =
            match InputInjector::new(stream_width, stream_height, display_width, display_height) {
                Ok(injector) => injector,
                Err(error) => {
                    eprintln!("Input control unavailable: {error}");
                    // Drain so the sender never blocks on a full channel.
                    while inputs.blocking_recv().is_some() {}
                    return;
                }
            };
        while let Some(input) = inputs.blocking_recv() {
            let _ = injector.apply(input);
        }
        injector.release_all();
    })
}

fn bounded_input_channel<T>(capacity: usize) -> (mpsc::Sender<T>, mpsc::Receiver<T>) {
    mpsc::channel(capacity)
}

/// Waits for capacity instead of dropping key transitions. The wait stops
/// reading the encrypted stream, propagating bounded transport backpressure
/// to a viewer that sends input faster than the OS or PTY can consume it.
async fn send_input_with_backpressure<T>(
    sender: &mpsc::Sender<T>,
    input: T,
    wait: Duration,
) -> bool {
    matches!(timeout(wait, sender.send(input)).await, Ok(Ok(())))
}

/// Aborting a Tokio task is asynchronous: await its JoinHandle so captured
/// channel endpoints are definitely dropped before joining blocking threads.
async fn abort_and_wait<T>(task: tokio::task::JoinHandle<T>) {
    task.abort();
    let _ = task.await;
}

/// Requests cooperative cleanup before awaiting a task. Unlike aborting, this
/// lets receiver-owned file workers run their bounded shutdown path.
async fn stop_and_wait<T>(stop: watch::Sender<bool>, task: tokio::task::JoinHandle<T>) {
    stop.send_replace(true);
    let _ = task.await;
}

async fn send_remote_message<S>(
    writer: &mut SecureWriter<S>,
    message: &RemoteMessage,
) -> Result<(), String>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    match timeout(REMOTE_SEND_TIMEOUT, writer.send(message)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(error.to_string()),
        Err(_) => Err("Timed out writing to the remote viewer.".to_string()),
    }
}

#[cfg(unix)]
fn set_pty_nonblocking(file_descriptor: libc::c_int) -> Result<(), String> {
    // SAFETY: file_descriptor is borrowed from the live PTY master. F_GETFL
    // and F_SETFL do not take ownership of it.
    let flags = unsafe { libc::fcntl(file_descriptor, libc::F_GETFL) };
    if flags == -1 {
        return Err(format!(
            "Cannot inspect PTY flags: {}",
            std::io::Error::last_os_error()
        ));
    }
    // portable-pty creates the reader/writer with dup(2), so this file-status
    // flag applies to both pumps and makes every read/write cancellable.
    if unsafe { libc::fcntl(file_descriptor, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1 {
        return Err(format!(
            "Cannot make PTY I/O cancellable: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn wait_for_pty_event(
    file_descriptor: libc::c_int,
    events: libc::c_short,
    stopped: &AtomicBool,
) -> bool {
    while !stopped.load(Ordering::Relaxed) {
        let mut descriptor = libc::pollfd {
            fd: file_descriptor,
            events,
            revents: 0,
        };
        // SAFETY: descriptor points to one initialized pollfd for the live
        // PTY master and remains valid for the duration of this call.
        let ready = unsafe { libc::poll(&mut descriptor, 1, TERMINAL_PTY_POLL_INTERVAL_MS) };
        if stopped.load(Ordering::Relaxed) {
            return false;
        }
        if ready > 0 {
            if descriptor.revents & libc::POLLNVAL != 0 {
                return false;
            }
            // A requested readiness bit permits one nonblocking I/O attempt.
            // HUP/ERR without it ends the pump instead of spinning forever on
            // a persistent terminal error followed by WouldBlock.
            return descriptor.revents & events != 0;
        }
        if ready == 0 {
            continue;
        }
        if std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
            return false;
        }
    }
    false
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct LinuxProcessIdentity {
    process_id: libc::pid_t,
    session_id: libc::pid_t,
    start_time: u64,
}

#[cfg(target_os = "linux")]
fn parse_linux_process_identity(
    process_id: libc::pid_t,
    stat: &str,
) -> Option<LinuxProcessIdentity> {
    // comm may contain spaces and closing parentheses; the final ')' is the
    // only reliable boundary before the fixed fields beginning with state.
    let fields = stat
        .get(stat.rfind(')')? + 1..)?
        .split_whitespace()
        .collect::<Vec<_>>();
    Some(LinuxProcessIdentity {
        process_id,
        session_id: fields.get(3)?.parse().ok()?,
        // starttime is field 22; state is field 3 at index zero here.
        start_time: fields.get(19)?.parse().ok()?,
    })
}

#[cfg(target_os = "linux")]
fn read_linux_process_identity(process_id: libc::pid_t) -> Option<LinuxProcessIdentity> {
    let stat = std::fs::read_to_string(format!("/proc/{process_id}/stat")).ok()?;
    parse_linux_process_identity(process_id, &stat)
}

#[cfg(target_os = "linux")]
fn linux_session_processes(session_id: libc::pid_t) -> Vec<LinuxProcessIdentity> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| entry.file_name().to_string_lossy().parse().ok())
        .filter(|process_id| *process_id > 1 && *process_id != unsafe { libc::getpid() })
        .filter_map(read_linux_process_identity)
        .filter(|identity| identity.session_id == session_id)
        .collect()
}

#[cfg(target_os = "linux")]
fn open_verified_pidfd(identity: LinuxProcessIdentity) -> Option<std::os::fd::OwnedFd> {
    use std::os::fd::FromRawFd as _;

    // SAFETY: pidfd_open does not borrow userspace pointers. A non-negative
    // result is a newly owned descriptor, transferred to OwnedFd below.
    let descriptor = unsafe { libc::syscall(libc::SYS_pidfd_open, identity.process_id, 0) };
    if descriptor < 0 {
        return None;
    }
    let descriptor = unsafe { std::os::fd::OwnedFd::from_raw_fd(descriptor as libc::c_int) };
    // Close the scan-to-open PID reuse race: a pidfd pins one process, and a
    // second stat read must still match the original start-time identity.
    (read_linux_process_identity(identity.process_id) == Some(identity)).then_some(descriptor)
}

#[cfg(target_os = "linux")]
fn signal_pidfd(descriptor: &std::os::fd::OwnedFd, signal: libc::c_int) -> bool {
    use std::os::fd::AsRawFd as _;

    // SAFETY: the pidfd is owned for this call; a null siginfo with flags zero
    // requests ordinary signal delivery to that pinned process identity.
    unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            descriptor.as_raw_fd(),
            signal,
            std::ptr::null::<libc::siginfo_t>(),
            0,
        ) == 0
    }
}

#[cfg(target_os = "linux")]
fn signal_linux_session(session_id: libc::pid_t, signal: libc::c_int) -> bool {
    let mut delivered = false;
    for identity in linux_session_processes(session_id) {
        let Some(descriptor) = open_verified_pidfd(identity) else {
            continue;
        };
        delivered |= signal_pidfd(&descriptor, signal);
    }
    delivered
}

fn agent_name() -> String {
    env::var("COMPUTERNAME")
        .or_else(|_| env::var("HOSTNAME"))
        .ok()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "Lattice Agent".to_string())
}

fn safe_file_error(detail: impl Into<String>) -> String {
    let mut output = String::new();
    for character in detail.into().chars() {
        let character = if character.is_control() {
            ' '
        } else {
            character
        };
        if output.len() + character.len_utf8() > MAX_FILE_ERROR_BYTES {
            break;
        }
        output.push(character);
    }
    if output.trim().is_empty() {
        "Remote file operation failed.".to_string()
    } else {
        output
    }
}

fn file_error(operation_id: u64, detail: impl Into<String>) -> RemoteMessage {
    RemoteMessage::FileResponse(RemoteFileResponse::Error {
        operation_id,
        detail: safe_file_error(detail),
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FileJobKind {
    List,
    Download,
    Upload { announced_bytes: u64 },
}

enum UploadCommand {
    Chunk(Vec<u8>),
    Finish,
}

enum UploadActorEvent {
    Command(UploadCommand),
    Cancelled,
    Idle,
    Closed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FileSendOutcome {
    Sent,
    Cancelled,
    Failed,
}

#[derive(Clone)]
enum FileCancelResponse {
    Complete,
    Error(String),
    Silent,
}

enum FileJobState {
    Active,
    Cancelling(FileCancelResponse),
    /// UploadFinish has crossed its atomic point of no return. A later Cancel
    /// cannot truthfully undo a flush/rename already in progress, so the actor
    /// remains the sole owner of the real Complete/Error response.
    Committing,
    Terminal,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FileCancelDisposition {
    Requested,
    TerminalPending,
}

struct FileJobControl {
    kind: FileJobKind,
    state: Mutex<FileJobState>,
    cancelled: watch::Sender<bool>,
    failed: watch::Sender<bool>,
    upload_commands: Option<mpsc::Sender<UploadCommand>>,
    upload_committed: AtomicBool,
}

impl FileJobControl {
    fn new(
        kind: FileJobKind,
        upload_commands: Option<mpsc::Sender<UploadCommand>>,
        failed: watch::Sender<bool>,
    ) -> Self {
        let (cancelled, _) = watch::channel(false);
        Self {
            kind,
            state: Mutex::new(FileJobState::Active),
            cancelled,
            failed,
            upload_commands,
            upload_committed: AtomicBool::new(false),
        }
    }

    fn request_cancel(&self, response: FileCancelResponse) -> FileCancelDisposition {
        let requested = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            match &*state {
                FileJobState::Active => {
                    *state = FileJobState::Cancelling(response);
                    true
                }
                FileJobState::Cancelling(_) | FileJobState::Committing | FileJobState::Terminal => {
                    false
                }
            }
        };
        if requested {
            self.cancelled.send_replace(true);
            FileCancelDisposition::Requested
        } else {
            FileCancelDisposition::TerminalPending
        }
    }

    fn cancel_silently(&self) {
        let should_signal = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            match &*state {
                FileJobState::Active | FileJobState::Cancelling(_) => {
                    *state = FileJobState::Cancelling(FileCancelResponse::Silent);
                    true
                }
                FileJobState::Committing | FileJobState::Terminal => false,
            }
        };
        if should_signal {
            self.cancelled.send_replace(true);
        }
    }

    fn is_cancelled(&self) -> bool {
        matches!(
            *self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
            FileJobState::Cancelling(_)
        )
    }

    fn subscribe(&self) -> watch::Receiver<bool> {
        self.cancelled.subscribe()
    }

    fn fail_session(&self) {
        self.failed.send_replace(true);
    }

    fn claim_active_terminal(&self) -> bool {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if matches!(*state, FileJobState::Active) {
            *state = FileJobState::Terminal;
            true
        } else {
            false
        }
    }

    fn claim_cancel_terminal(&self) -> Option<FileCancelResponse> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let FileJobState::Cancelling(response) = &*state else {
            return None;
        };
        let response = response.clone();
        *state = FileJobState::Terminal;
        Some(response)
    }

    fn begin_upload_commit(&self) -> bool {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if matches!(*state, FileJobState::Active) {
            *state = FileJobState::Committing;
            true
        } else {
            false
        }
    }

    fn finish_upload_commit(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        debug_assert!(matches!(*state, FileJobState::Committing));
        *state = FileJobState::Terminal;
    }
}

#[derive(Default)]
struct ActiveFileJobs {
    operations: HashMap<u64, Arc<FileJobControl>>,
    active_upload_bytes: u64,
    committed_upload_bytes: u64,
}

impl ActiveFileJobs {
    fn insert(
        &mut self,
        operation_id: u64,
        control: Arc<FileJobControl>,
    ) -> Result<(), &'static str> {
        if self.operations.contains_key(&operation_id) {
            return Err("The file operation identifier is already active.");
        }
        match control.kind {
            FileJobKind::List => {}
            FileJobKind::Download => {
                let active_downloads = self
                    .operations
                    .values()
                    .filter(|job| job.kind == FileJobKind::Download)
                    .count();
                if active_downloads >= ACTIVE_DOWNLOAD_LIMIT {
                    return Err("Too many downloads are active.");
                }
            }
            FileJobKind::Upload { announced_bytes } => {
                if announced_bytes > MAX_UPLOAD_FILE_BYTES {
                    return Err("The upload is larger than the per-file limit.");
                }
                let active_uploads = self
                    .operations
                    .values()
                    .filter(|job| matches!(job.kind, FileJobKind::Upload { .. }))
                    .count();
                if active_uploads >= ACTIVE_UPLOAD_LIMIT {
                    return Err("Too many uploads are active.");
                }
                let next_bytes = self
                    .active_upload_bytes
                    .checked_add(self.committed_upload_bytes)
                    .and_then(|bytes| bytes.checked_add(announced_bytes))
                    .ok_or("The session upload byte count overflowed.")?;
                if next_bytes > MAX_SESSION_UPLOAD_BYTES {
                    return Err("The uploads exceed the session byte limit.");
                }
                self.active_upload_bytes = self
                    .active_upload_bytes
                    .checked_add(announced_bytes)
                    .ok_or("The active upload byte count overflowed.")?;
            }
        }
        self.operations.insert(operation_id, control);
        Ok(())
    }

    fn remove_if_current(&mut self, operation_id: u64, control: &Arc<FileJobControl>) {
        if self
            .operations
            .get(&operation_id)
            .is_some_and(|current| Arc::ptr_eq(current, control))
        {
            self.operations.remove(&operation_id);
            if let FileJobKind::Upload { announced_bytes } = control.kind {
                if !control.upload_committed.load(Ordering::Acquire) {
                    self.active_upload_bytes =
                        self.active_upload_bytes.saturating_sub(announced_bytes);
                }
            }
        }
    }

    fn commit_upload(&mut self, operation_id: u64, control: &Arc<FileJobControl>) {
        if !self
            .operations
            .get(&operation_id)
            .is_some_and(|current| Arc::ptr_eq(current, control))
        {
            return;
        }
        let FileJobKind::Upload { announced_bytes } = control.kind else {
            return;
        };
        if control.upload_committed.swap(true, Ordering::AcqRel) {
            return;
        }
        self.active_upload_bytes = self.active_upload_bytes.saturating_sub(announced_bytes);
        self.committed_upload_bytes = self
            .committed_upload_bytes
            .saturating_add(announced_bytes)
            .min(MAX_SESSION_UPLOAD_BYTES);
    }

    fn cancel(&self, operation_id: u64) -> Option<FileCancelDisposition> {
        self.operations
            .get(&operation_id)
            .map(|control| control.request_cancel(FileCancelResponse::Complete))
    }

    fn cancel_all(&mut self) {
        for control in self.operations.values() {
            control.cancel_silently();
        }
        // A session being torn down cannot reuse IDs. Clear its registry and
        // active byte reservations immediately; workers retain their Arc
        // identity until their bounded cleanup finishes. Committed accounting
        // remains relevant only for the lifetime of this now-closed registry.
        self.operations.clear();
        self.active_upload_bytes = 0;
    }
}

struct FileJobRegistry {
    active: Mutex<ActiveFileJobs>,
    in_flight: AtomicUsize,
    settled: Notify,
    failed: watch::Sender<bool>,
}

impl FileJobRegistry {
    fn new() -> Self {
        let (failed, _) = watch::channel(false);
        Self {
            active: Mutex::new(ActiveFileJobs::default()),
            in_flight: AtomicUsize::new(0),
            settled: Notify::new(),
            failed,
        }
    }

    fn insert(&self, operation_id: u64, control: Arc<FileJobControl>) -> Result<(), &'static str> {
        self.active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(operation_id, control)?;
        self.in_flight.fetch_add(1, Ordering::AcqRel);
        Ok(())
    }

    fn control(&self, operation_id: u64) -> Option<Arc<FileJobControl>> {
        self.active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .operations
            .get(&operation_id)
            .cloned()
    }

    fn cancel(&self, operation_id: u64) -> Option<FileCancelDisposition> {
        self.active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .cancel(operation_id)
    }

    fn cancel_all(&self) {
        self.active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .cancel_all();
    }

    fn commit_upload(&self, operation_id: u64, control: &Arc<FileJobControl>) {
        self.active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .commit_upload(operation_id, control);
    }

    fn subscribe_failures(&self) -> watch::Receiver<bool> {
        self.failed.subscribe()
    }

    fn fail_session(&self) {
        self.failed.send_replace(true);
    }

    async fn wait_for_idle(&self) {
        loop {
            let settled = self.settled.notified();
            if self.in_flight.load(Ordering::Acquire) == 0 {
                return;
            }
            settled.await;
        }
    }
}

struct FileJobRegistration {
    operation_id: u64,
    control: Arc<FileJobControl>,
    registry: Arc<FileJobRegistry>,
}

impl FileJobRegistration {
    fn subscribe(&self) -> watch::Receiver<bool> {
        self.control.subscribe()
    }
}

impl Drop for FileJobRegistration {
    fn drop(&mut self) {
        self.registry
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove_if_current(self.operation_id, &self.control);
        let previous = self.registry.in_flight.fetch_sub(1, Ordering::AcqRel);
        debug_assert!(previous > 0, "file job accounting underflowed");
        // `notify_one` stores a permit when shutdown has not polled yet,
        // avoiding the check-to-wait lost-wakeup window.
        self.registry.settled.notify_one();
    }
}

fn try_admit_file_job(
    permits: &Arc<Semaphore>,
    registry: &Arc<FileJobRegistry>,
    kind: FileJobKind,
    operation_id: u64,
    upload_commands: Option<mpsc::Sender<UploadCommand>>,
) -> Result<(OwnedSemaphorePermit, FileJobRegistration), &'static str> {
    // `try_acquire_owned` is deliberately fail-fast: no unbounded queue of
    // authorised-but-hostile requests can accumulate behind blocking I/O.
    let permit = Arc::clone(permits)
        .try_acquire_owned()
        .map_err(|_| "Too many file operations are active.")?;
    let control = Arc::new(FileJobControl::new(
        kind,
        upload_commands,
        registry.failed.clone(),
    ));
    registry.insert(operation_id, Arc::clone(&control))?;
    Ok((
        permit,
        FileJobRegistration {
            operation_id,
            control,
            registry: Arc::clone(registry),
        },
    ))
}

fn send_file_job_message(
    runtime: &Handle,
    outgoing: &mpsc::Sender<RemoteMessage>,
    message: RemoteMessage,
    control: &FileJobControl,
    cancelled: &mut watch::Receiver<bool>,
) -> FileSendOutcome {
    if *cancelled.borrow() {
        return FileSendOutcome::Cancelled;
    }
    let outcome = runtime.block_on(async {
        tokio::select! {
            biased;
            _ = cancelled.changed() => FileSendOutcome::Cancelled,
            result = timeout(FILE_RESPONSE_ENQUEUE_TIMEOUT, outgoing.send(message)) => {
                if matches!(result, Ok(Ok(()))) {
                    FileSendOutcome::Sent
                } else {
                    FileSendOutcome::Failed
                }
            }
        }
    });
    if outcome == FileSendOutcome::Failed {
        control.fail_session();
    }
    outcome
}

fn send_file_terminal_message(
    runtime: &Handle,
    outgoing: &mpsc::Sender<RemoteMessage>,
    message: RemoteMessage,
    control: &FileJobControl,
) -> bool {
    let sent = runtime.block_on(async {
        matches!(
            timeout(FILE_RESPONSE_ENQUEUE_TIMEOUT, outgoing.send(message)).await,
            Ok(Ok(()))
        )
    });
    if !sent {
        control.fail_session();
    }
    sent
}

fn finish_cancelled_file_job(
    runtime: &Handle,
    outgoing: &mpsc::Sender<RemoteMessage>,
    operation_id: u64,
    control: &FileJobControl,
) {
    let Some(response) = control.claim_cancel_terminal() else {
        return;
    };
    let message = match response {
        FileCancelResponse::Complete => {
            Some(RemoteMessage::FileResponse(RemoteFileResponse::Complete {
                transfer_id: operation_id,
            }))
        }
        FileCancelResponse::Error(detail) => Some(file_error(operation_id, detail)),
        FileCancelResponse::Silent => None,
    };
    if let Some(message) = message {
        let _ = send_file_terminal_message(runtime, outgoing, message, control);
    }
}

fn finish_active_or_cancelled_file_job(
    runtime: &Handle,
    outgoing: &mpsc::Sender<RemoteMessage>,
    operation_id: u64,
    control: &FileJobControl,
    active_response: RemoteMessage,
) {
    if control.claim_active_terminal() {
        let _ = send_file_terminal_message(runtime, outgoing, active_response, control);
    } else {
        finish_cancelled_file_job(runtime, outgoing, operation_id, control);
    }
}

fn spawn_file_thread(
    name: &str,
    worker: impl FnOnce() + Send + 'static,
) -> Result<(), &'static str> {
    // Detached OS threads are intentional. Unlike Tokio's blocking pool, the
    // process can still exit after the bounded handler shutdown if a kernel or
    // network-filesystem syscall never returns. The Agent-wide semaphore caps
    // the number of such threads at FILE_JOB_LIMIT.
    std::thread::Builder::new()
        .name(name.to_string())
        .spawn(worker)
        .map(|_| ())
        .map_err(|_| "Cannot start the file worker.")
}

fn spawn_directory_list(
    files: Arc<SharedFiles>,
    request_id: u64,
    path: String,
    outgoing: mpsc::Sender<RemoteMessage>,
    permit: OwnedSemaphorePermit,
    registration: FileJobRegistration,
    runtime: Handle,
) -> Result<(), &'static str> {
    spawn_file_thread("lattice-file-list", move || {
        let _permit = permit;
        let mut cancelled = registration.subscribe();
        if registration.control.is_cancelled() {
            finish_cancelled_file_job(&runtime, &outgoing, request_id, &registration.control);
            return;
        }
        match files.list(&path) {
            Ok((path, entries)) => {
                match send_file_job_message(
                    &runtime,
                    &outgoing,
                    RemoteMessage::FileResponse(RemoteFileResponse::ListStart { request_id, path }),
                    &registration.control,
                    &mut cancelled,
                ) {
                    FileSendOutcome::Sent => {}
                    FileSendOutcome::Cancelled => {
                        finish_cancelled_file_job(
                            &runtime,
                            &outgoing,
                            request_id,
                            &registration.control,
                        );
                        return;
                    }
                    FileSendOutcome::Failed => return,
                }
                for entry in entries {
                    match send_file_job_message(
                        &runtime,
                        &outgoing,
                        RemoteMessage::FileResponse(RemoteFileResponse::ListEntry {
                            request_id,
                            entry,
                        }),
                        &registration.control,
                        &mut cancelled,
                    ) {
                        FileSendOutcome::Sent => {}
                        FileSendOutcome::Cancelled => {
                            finish_cancelled_file_job(
                                &runtime,
                                &outgoing,
                                request_id,
                                &registration.control,
                            );
                            return;
                        }
                        FileSendOutcome::Failed => return,
                    }
                }
                finish_active_or_cancelled_file_job(
                    &runtime,
                    &outgoing,
                    request_id,
                    &registration.control,
                    RemoteMessage::FileResponse(RemoteFileResponse::ListDone { request_id }),
                );
            }
            Err(error) => {
                finish_active_or_cancelled_file_job(
                    &runtime,
                    &outgoing,
                    request_id,
                    &registration.control,
                    file_error(request_id, error),
                );
            }
        }
    })
}

struct UploadJob {
    files: Arc<SharedFiles>,
    transfer_id: u64,
    path: String,
    size: u64,
    overwrite: bool,
    expected_revision: Option<[u8; 32]>,
    commands: mpsc::Receiver<UploadCommand>,
    outgoing: mpsc::Sender<RemoteMessage>,
    permit: OwnedSemaphorePermit,
    registration: FileJobRegistration,
    runtime: Handle,
}

enum PreparedUpload {
    File(HostUpload),
    Text(HostTextUpload),
}

enum UploadPublication {
    File(UploadFinishOutcome),
    Text(TextSaveOutcome),
}

impl PreparedUpload {
    fn destination(&self) -> &Path {
        match self {
            Self::File(upload) => upload.destination(),
            Self::Text(upload) => upload.destination(),
        }
    }

    fn write_chunk(&mut self, bytes: &[u8]) -> Result<u64, String> {
        match self {
            Self::File(upload) => upload.write_chunk(bytes),
            Self::Text(upload) => upload.write_chunk(bytes),
        }
    }

    fn finish(self) -> Result<UploadPublication, String> {
        match self {
            Self::File(upload) => upload.finish().map(UploadPublication::File),
            Self::Text(upload) => upload.finish().map(UploadPublication::Text),
        }
    }
}

struct UploadTargetReservation {
    key: PathBuf,
    token: u64,
}

impl Drop for UploadTargetReservation {
    fn drop(&mut self) {
        let mut active = ACTIVE_UPLOAD_TARGETS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if active.get(&self.key) == Some(&self.token) {
            active.remove(&self.key);
        }
    }
}

fn upload_target_reservation_key(destination: &Path) -> PathBuf {
    // Canonicalisation does not promise a portable Unicode/case-folded
    // spelling, including on Linux mounts such as VFAT, exFAT, CIFS, and
    // casefold-enabled ext4. Conservatively serialise uploads within one
    // canonical parent on every platform, so destination aliases cannot
    // re-enter the overwrite backup/restore sequence.
    let parent = destination.parent().unwrap_or(destination);
    PathBuf::from(parent.to_string_lossy().to_lowercase())
}

fn try_reserve_upload_target(destination: &Path) -> Result<UploadTargetReservation, &'static str> {
    let key = upload_target_reservation_key(destination);
    let token = NEXT_UPLOAD_TARGET_RESERVATION.fetch_add(1, Ordering::Relaxed);
    let mut active = ACTIVE_UPLOAD_TARGETS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if active.contains_key(&key) {
        return Err("Another upload in this destination folder is active.");
    }
    active.insert(key.clone(), token);
    Ok(UploadTargetReservation { key, token })
}

fn spawn_upload(job: UploadJob) -> Result<(), &'static str> {
    spawn_file_thread("lattice-file-upload", move || {
        let UploadJob {
            files,
            transfer_id,
            path,
            size,
            overwrite,
            expected_revision,
            mut commands,
            outgoing,
            permit,
            registration,
            runtime,
        } = job;
        let _permit = permit;
        let mut cancelled = registration.subscribe();
        if registration.control.is_cancelled() {
            finish_cancelled_file_job(&runtime, &outgoing, transfer_id, &registration.control);
            return;
        }
        let destination = match files.upload_destination(&path) {
            Ok(destination) => destination,
            Err(error) => {
                finish_active_or_cancelled_file_job(
                    &runtime,
                    &outgoing,
                    transfer_id,
                    &registration.control,
                    file_error(transfer_id, error),
                );
                return;
            }
        };
        if registration.control.is_cancelled() {
            finish_cancelled_file_job(&runtime, &outgoing, transfer_id, &registration.control);
            return;
        }
        let _target_reservation = match try_reserve_upload_target(&destination) {
            Ok(reservation) => reservation,
            Err(error) => {
                finish_active_or_cancelled_file_job(
                    &runtime,
                    &outgoing,
                    transfer_id,
                    &registration.control,
                    file_error(transfer_id, error),
                );
                return;
            }
        };
        let prepared = match expected_revision {
            Some(revision) => files
                .text_root()
                .begin_save(&path, size, revision)
                .map(PreparedUpload::Text),
            None => files
                .begin_upload(transfer_id, &path, size, overwrite)
                .map(PreparedUpload::File),
        };
        let mut upload = match prepared {
            Ok(upload) => upload,
            Err(error) => {
                finish_active_or_cancelled_file_job(
                    &runtime,
                    &outgoing,
                    transfer_id,
                    &registration.control,
                    file_error(transfer_id, error),
                );
                return;
            }
        };
        if upload.destination() != destination {
            drop(upload);
            finish_active_or_cancelled_file_job(
                &runtime,
                &outgoing,
                transfer_id,
                &registration.control,
                file_error(
                    transfer_id,
                    "The upload destination changed while it was being prepared.",
                ),
            );
            return;
        }
        // Recheck after every blocking filesystem call. Cancellation cannot
        // interrupt std::fs itself, but it suppresses every stale response and
        // drops the staging file at the next boundary.
        if registration.control.is_cancelled() {
            drop(upload);
            finish_cancelled_file_job(&runtime, &outgoing, transfer_id, &registration.control);
            return;
        }
        match send_file_job_message(
            &runtime,
            &outgoing,
            RemoteMessage::FileResponse(RemoteFileResponse::UploadReady { transfer_id }),
            &registration.control,
            &mut cancelled,
        ) {
            FileSendOutcome::Sent => {}
            FileSendOutcome::Cancelled => {
                drop(upload);
                finish_cancelled_file_job(&runtime, &outgoing, transfer_id, &registration.control);
                return;
            }
            FileSendOutcome::Failed => {
                drop(upload);
                let _ = registration.control.claim_active_terminal();
                return;
            }
        }

        loop {
            let event = runtime.block_on(async {
                tokio::select! {
                    biased;
                    _ = cancelled.changed() => UploadActorEvent::Cancelled,
                    result = timeout(UPLOAD_IDLE_TIMEOUT, commands.recv()) => match result {
                        Ok(Some(command)) => UploadActorEvent::Command(command),
                        Ok(None) => UploadActorEvent::Closed,
                        Err(_) => UploadActorEvent::Idle,
                    },
                }
            });
            match event {
                UploadActorEvent::Command(UploadCommand::Chunk(bytes)) => {
                    let result = upload.write_chunk(&bytes);
                    if registration.control.is_cancelled() {
                        drop(upload);
                        finish_cancelled_file_job(
                            &runtime,
                            &outgoing,
                            transfer_id,
                            &registration.control,
                        );
                        return;
                    }
                    if let Err(error) = result {
                        drop(upload);
                        finish_active_or_cancelled_file_job(
                            &runtime,
                            &outgoing,
                            transfer_id,
                            &registration.control,
                            file_error(transfer_id, error),
                        );
                        return;
                    }
                }
                UploadActorEvent::Command(UploadCommand::Finish) => {
                    // This state transition is the final cancellation check
                    // and commit point. Once it succeeds, Cancel cannot claim
                    // that a flush/rename already in progress was undone.
                    if !registration.control.begin_upload_commit() {
                        drop(upload);
                        finish_cancelled_file_job(
                            &runtime,
                            &outgoing,
                            transfer_id,
                            &registration.control,
                        );
                        return;
                    }
                    let result = upload.finish();
                    if let Ok(outcome) = &result {
                        registration
                            .registry
                            .commit_upload(transfer_id, &registration.control);
                        if let UploadPublication::File(
                            UploadFinishOutcome::PublishedWithCleanupWarning(detail),
                        ) = outcome
                        {
                            eprintln!(
                                "Remote upload {transfer_id} committed with a cleanup warning: {}",
                                safe_file_error(detail)
                            );
                        }
                    }
                    registration.control.finish_upload_commit();
                    let response = match result {
                        Ok(UploadPublication::File(_)) => {
                            RemoteMessage::FileResponse(RemoteFileResponse::Complete {
                                transfer_id,
                            })
                        }
                        Ok(UploadPublication::Text(outcome)) => {
                            RemoteMessage::FileResponse(RemoteFileResponse::TextSaved {
                                transfer_id,
                                revision: outcome.revision,
                                backup_path: outcome.backup_path,
                            })
                        }
                        Err(error) => file_error(transfer_id, error),
                    };
                    let _ = send_file_terminal_message(
                        &runtime,
                        &outgoing,
                        response,
                        &registration.control,
                    );
                    return;
                }
                UploadActorEvent::Cancelled => {
                    drop(upload);
                    finish_cancelled_file_job(
                        &runtime,
                        &outgoing,
                        transfer_id,
                        &registration.control,
                    );
                    return;
                }
                UploadActorEvent::Idle => {
                    drop(upload);
                    finish_active_or_cancelled_file_job(
                        &runtime,
                        &outgoing,
                        transfer_id,
                        &registration.control,
                        file_error(transfer_id, "The upload timed out while idle."),
                    );
                    return;
                }
                UploadActorEvent::Closed => {
                    drop(upload);
                    registration.control.cancel_silently();
                    finish_cancelled_file_job(
                        &runtime,
                        &outgoing,
                        transfer_id,
                        &registration.control,
                    );
                    return;
                }
            }
        }
    })
}

fn spawn_download(
    files: Arc<SharedFiles>,
    transfer_id: u64,
    path: String,
    outgoing: mpsc::Sender<RemoteMessage>,
    permit: OwnedSemaphorePermit,
    registration: FileJobRegistration,
    runtime: Handle,
) -> Result<(), &'static str> {
    spawn_file_thread("lattice-file-download", move || {
        let _permit = permit;
        let mut cancelled = registration.subscribe();
        if registration.control.is_cancelled() {
            finish_cancelled_file_job(&runtime, &outgoing, transfer_id, &registration.control);
            return;
        }
        let mut download = match files.download(&path) {
            Ok(download) => download,
            Err(error) => {
                finish_active_or_cancelled_file_job(
                    &runtime,
                    &outgoing,
                    transfer_id,
                    &registration.control,
                    file_error(transfer_id, error),
                );
                return;
            }
        };
        match send_file_job_message(
            &runtime,
            &outgoing,
            RemoteMessage::FileResponse(RemoteFileResponse::DownloadStart {
                transfer_id,
                name: download.name.clone(),
                size: download.size,
            }),
            &registration.control,
            &mut cancelled,
        ) {
            FileSendOutcome::Sent => {}
            FileSendOutcome::Cancelled => {
                drop(download);
                finish_cancelled_file_job(&runtime, &outgoing, transfer_id, &registration.control);
                return;
            }
            FileSendOutcome::Failed => {
                drop(download);
                return;
            }
        }
        let mut buffer = vec![0; FILE_CHUNK_SIZE];
        loop {
            if registration.control.is_cancelled() {
                drop(download);
                finish_cancelled_file_job(&runtime, &outgoing, transfer_id, &registration.control);
                return;
            }
            match download.read_chunk(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    match send_file_job_message(
                        &runtime,
                        &outgoing,
                        RemoteMessage::FileResponse(RemoteFileResponse::DownloadChunk {
                            transfer_id,
                            bytes: buffer[..read].to_vec(),
                        }),
                        &registration.control,
                        &mut cancelled,
                    ) {
                        FileSendOutcome::Sent => {}
                        FileSendOutcome::Cancelled => {
                            drop(download);
                            finish_cancelled_file_job(
                                &runtime,
                                &outgoing,
                                transfer_id,
                                &registration.control,
                            );
                            return;
                        }
                        FileSendOutcome::Failed => {
                            drop(download);
                            return;
                        }
                    }
                }
                Err(error) => {
                    drop(download);
                    finish_active_or_cancelled_file_job(
                        &runtime,
                        &outgoing,
                        transfer_id,
                        &registration.control,
                        file_error(transfer_id, error),
                    );
                    return;
                }
            }
        }
        drop(download);
        finish_active_or_cancelled_file_job(
            &runtime,
            &outgoing,
            transfer_id,
            &registration.control,
            RemoteMessage::FileResponse(RemoteFileResponse::Complete { transfer_id }),
        );
    })
}

fn spawn_text_read(
    files: Arc<SharedFiles>,
    request_id: u64,
    path: String,
    outgoing: mpsc::Sender<RemoteMessage>,
    permit: OwnedSemaphorePermit,
    registration: FileJobRegistration,
    runtime: Handle,
) -> Result<(), &'static str> {
    spawn_file_thread("lattice-file-text", move || {
        let _permit = permit;
        let mut cancelled = registration.subscribe();
        if registration.control.is_cancelled() {
            finish_cancelled_file_job(&runtime, &outgoing, request_id, &registration.control);
            return;
        }
        let snapshot = match files.text_root().read(&path) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                finish_active_or_cancelled_file_job(
                    &runtime,
                    &outgoing,
                    request_id,
                    &registration.control,
                    file_error(request_id, error),
                );
                return;
            }
        };
        let start = RemoteFileResponse::TextStart {
            request_id,
            size: snapshot.bytes.len() as u64,
            revision: snapshot.revision,
        };
        let responses =
            std::iter::once(start).chain(snapshot.bytes.chunks(FILE_CHUNK_SIZE).map(|bytes| {
                RemoteFileResponse::DownloadChunk {
                    transfer_id: request_id,
                    bytes: bytes.to_vec(),
                }
            }));
        for response in responses {
            match send_file_job_message(
                &runtime,
                &outgoing,
                RemoteMessage::FileResponse(response),
                &registration.control,
                &mut cancelled,
            ) {
                FileSendOutcome::Sent => {}
                FileSendOutcome::Cancelled => {
                    finish_cancelled_file_job(
                        &runtime,
                        &outgoing,
                        request_id,
                        &registration.control,
                    );
                    return;
                }
                FileSendOutcome::Failed => return,
            }
        }
        finish_active_or_cancelled_file_job(
            &runtime,
            &outgoing,
            request_id,
            &registration.control,
            RemoteMessage::FileResponse(RemoteFileResponse::Complete {
                transfer_id: request_id,
            }),
        );
    })
}

/// Serves the shared-folder side of a session; both the screen stream and the
/// terminal stream accept the same file requests over their receiver loops.
struct FileRequestHandler {
    files: Option<Arc<SharedFiles>>,
    outgoing: mpsc::Sender<RemoteMessage>,
    permits: Arc<Semaphore>,
    registry: Arc<FileJobRegistry>,
}

impl FileRequestHandler {
    fn new(
        files: Option<Arc<SharedFiles>>,
        outgoing: mpsc::Sender<RemoteMessage>,
        permits: Arc<Semaphore>,
    ) -> Self {
        Self {
            files,
            outgoing,
            permits,
            registry: Arc::new(FileJobRegistry::new()),
        }
    }

    async fn send_immediate(&self, response: RemoteMessage) -> bool {
        let sent = matches!(
            timeout(FILE_CONTROL_RESPONSE_TIMEOUT, self.outgoing.send(response)).await,
            Ok(Ok(()))
        );
        if !sent {
            self.registry.fail_session();
        }
        sent
    }

    async fn reject(&self, operation_id: u64, detail: impl Into<String>) -> bool {
        self.send_immediate(file_error(operation_id, detail)).await
    }

    async fn handle(&mut self, request: RemoteFileRequest) -> bool {
        match request {
            RemoteFileRequest::ReadText { request_id, path } => {
                if !host_text::editing_supported() {
                    return self
                        .reject(request_id, host_text::UNSUPPORTED_PLATFORM)
                        .await;
                }
                let Some(files) = self.files.clone() else {
                    return self
                        .reject(request_id, "File sharing is not enabled.")
                        .await;
                };
                match try_admit_file_job(
                    &self.permits,
                    &self.registry,
                    FileJobKind::Download,
                    request_id,
                    None,
                ) {
                    Ok((permit, registration)) => match spawn_text_read(
                        files,
                        request_id,
                        path,
                        self.outgoing.clone(),
                        permit,
                        registration,
                        Handle::current(),
                    ) {
                        Ok(()) => true,
                        Err(error) => self.reject(request_id, error).await,
                    },
                    Err(error) => self.reject(request_id, error).await,
                }
            }
            RemoteFileRequest::SaveTextStart {
                transfer_id,
                path,
                size,
                expected_revision,
            } => {
                if !host_text::editing_supported() {
                    return self
                        .reject(transfer_id, host_text::UNSUPPORTED_PLATFORM)
                        .await;
                }
                if size > MAX_TEXT_FILE_BYTES as u64 {
                    return self
                        .reject(transfer_id, "The text file is larger than 1 MiB.")
                        .await;
                }
                let Some(files) = self.files.clone() else {
                    return self
                        .reject(transfer_id, "File sharing is not enabled.")
                        .await;
                };
                let (commands_tx, commands_rx) = mpsc::channel(UPLOAD_COMMAND_QUEUE_CAPACITY);
                match try_admit_file_job(
                    &self.permits,
                    &self.registry,
                    FileJobKind::Upload {
                        announced_bytes: size,
                    },
                    transfer_id,
                    Some(commands_tx),
                ) {
                    Ok((permit, registration)) => match spawn_upload(UploadJob {
                        files,
                        transfer_id,
                        path,
                        size,
                        overwrite: true,
                        expected_revision: Some(expected_revision),
                        commands: commands_rx,
                        outgoing: self.outgoing.clone(),
                        permit,
                        registration,
                        runtime: Handle::current(),
                    }) {
                        Ok(()) => true,
                        Err(error) => self.reject(transfer_id, error).await,
                    },
                    Err(error) => self.reject(transfer_id, error).await,
                }
            }
            RemoteFileRequest::List { request_id, path } => {
                let Some(files) = self.files.clone() else {
                    return self
                        .reject(request_id, "File sharing is not enabled.")
                        .await;
                };
                match try_admit_file_job(
                    &self.permits,
                    &self.registry,
                    FileJobKind::List,
                    request_id,
                    None,
                ) {
                    Ok((permit, registration)) => match spawn_directory_list(
                        files,
                        request_id,
                        path,
                        self.outgoing.clone(),
                        permit,
                        registration,
                        Handle::current(),
                    ) {
                        Ok(()) => true,
                        Err(error) => self.reject(request_id, error).await,
                    },
                    Err(error) => self.reject(request_id, error).await,
                }
            }
            RemoteFileRequest::Download { transfer_id, path } => {
                let Some(files) = self.files.clone() else {
                    return self
                        .reject(transfer_id, "File sharing is not enabled.")
                        .await;
                };
                match try_admit_file_job(
                    &self.permits,
                    &self.registry,
                    FileJobKind::Download,
                    transfer_id,
                    None,
                ) {
                    Ok((permit, registration)) => match spawn_download(
                        files,
                        transfer_id,
                        path,
                        self.outgoing.clone(),
                        permit,
                        registration,
                        Handle::current(),
                    ) {
                        Ok(()) => true,
                        Err(error) => self.reject(transfer_id, error).await,
                    },
                    Err(error) => self.reject(transfer_id, error).await,
                }
            }
            RemoteFileRequest::UploadStart {
                transfer_id,
                path,
                size,
                overwrite,
            } => {
                let Some(files) = self.files.clone() else {
                    return self
                        .reject(transfer_id, "File sharing is not enabled.")
                        .await;
                };
                let (commands_tx, commands_rx) = mpsc::channel(UPLOAD_COMMAND_QUEUE_CAPACITY);
                match try_admit_file_job(
                    &self.permits,
                    &self.registry,
                    FileJobKind::Upload {
                        announced_bytes: size,
                    },
                    transfer_id,
                    Some(commands_tx),
                ) {
                    Ok((permit, registration)) => match spawn_upload(UploadJob {
                        files,
                        transfer_id,
                        path,
                        size,
                        overwrite,
                        expected_revision: None,
                        commands: commands_rx,
                        outgoing: self.outgoing.clone(),
                        permit,
                        registration,
                        runtime: Handle::current(),
                    }) {
                        Ok(()) => true,
                        Err(error) => self.reject(transfer_id, error).await,
                    },
                    Err(error) => self.reject(transfer_id, error).await,
                }
            }
            RemoteFileRequest::UploadChunk { transfer_id, bytes } => {
                self.send_upload_command(transfer_id, UploadCommand::Chunk(bytes))
                    .await
            }
            RemoteFileRequest::UploadFinish { transfer_id } => {
                self.send_upload_command(transfer_id, UploadCommand::Finish)
                    .await
            }
            RemoteFileRequest::Cancel { transfer_id } => {
                if self.registry.cancel(transfer_id).is_some() {
                    // The worker owns the only terminal response. It first
                    // stops stale output and closes its FD/temp file, then
                    // queues Complete before releasing the operation ID.
                    true
                } else {
                    // Unknown/already-settled cancellation is idempotent.
                    self.send_immediate(RemoteMessage::FileResponse(RemoteFileResponse::Complete {
                        transfer_id,
                    }))
                    .await
                }
            }
        }
    }

    async fn send_upload_command(&self, transfer_id: u64, command: UploadCommand) -> bool {
        let Some(control) = self.registry.control(transfer_id) else {
            return self.reject(transfer_id, "The upload is not active.").await;
        };
        let Some(commands) = &control.upload_commands else {
            return self
                .reject(transfer_id, "The file operation is not an upload.")
                .await;
        };
        match timeout(REMOTE_INPUT_ENQUEUE_TIMEOUT, commands.send(command)).await {
            Ok(Ok(())) => true,
            Err(_) => {
                // Bounded waiting propagates disk backpressure into
                // encrypted/TCP reads. A peer that stays ahead for the full
                // timeout gets one worker-owned Error after staging cleanup.
                control.request_cancel(FileCancelResponse::Error(
                    "The upload input stayed backpressured for too long.".to_string(),
                ));
                true
            }
            Ok(Err(_)) => {
                // The actor ended before accepting this command. Its terminal
                // response is either already queued or failed; wake the
                // receiver so neither case is silently ignored.
                self.registry.fail_session();
                false
            }
        }
    }

    /// Stops registered work and normally closes upload files when the
    /// current filesystem call returns. `std::fs` cannot interrupt a kernel or
    /// network-filesystem syscall already in progress: after the bounded wait,
    /// that detached worker may still hold its FD/temp file and global permit.
    /// The Agent-wide cap keeps later sessions fail-fast, and direct process
    /// exit is not held hostage by a Tokio blocking-pool join.
    fn cancel_all(&mut self) {
        self.registry.cancel_all();
    }

    async fn shutdown(&mut self) {
        self.cancel_all();
        let _ = timeout(FILE_JOB_SHUTDOWN_TIMEOUT, self.registry.wait_for_idle()).await;
    }
}

impl Drop for FileRequestHandler {
    fn drop(&mut self) {
        self.cancel_all();
    }
}

async fn serve<S>(
    connection: SecureConnection<S>,
    fps: u32,
    allow_input: bool,
    allow_commands: bool,
    file_root: Option<PathBuf>,
    file_job_permits: Arc<Semaphore>,
    command_permits: Arc<Semaphore>,
) -> Result<(), String>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let monitors = Monitor::all().map_err(|error| error.to_string())?;
    let monitor = monitors
        .into_iter()
        .find(|monitor| monitor.is_primary().unwrap_or(false))
        .ok_or_else(|| "no primary display is available".to_string())?;
    let mut capture = capture_jpeg(&monitor)?;
    let mut width = capture.stream_width;
    let mut height = capture.stream_height;

    let shared_files = file_root.map(SharedFiles::open).transpose()?.map(Arc::new);
    let (mut reader, mut writer_half) = connection.split();

    send_remote_message(
        &mut writer_half,
        &RemoteMessage::Hello(RemoteHello {
            protocol_version: PROTOCOL_VERSION,
            agent_name: agent_name(),
            width,
            height,
            view_only: !allow_input,
            file_transfer: shared_files.is_some(),
            file_edit: shared_files.is_some() && host_text::editing_supported(),
            command_shells: lattice_remote::host_commands::supported_shells(allow_commands),
            file_root_label: shared_files
                .as_ref()
                .map(|files| files.label().to_string())
                .unwrap_or_default(),
            terminal: false,
        }),
    )
    .await?;

    // One bounded writer queue serialises frames and file responses on the
    // Noise send state while applying backpressure to large downloads.
    let (outgoing, mut outgoing_rx) = mpsc::channel::<RemoteMessage>(128);
    let writer = tokio::spawn(async move {
        while let Some(message) = outgoing_rx.recv().await {
            if send_remote_message(&mut writer_half, &message)
                .await
                .is_err()
            {
                break;
            }
        }
    });

    // Receiving runs on its own task. Input remains independently authorised;
    // file messages are accepted only when an explicit shared root exists.
    let (input_tx, input_thread) = if allow_input {
        let (tx, rx) = bounded_input_channel(SCREEN_INPUT_QUEUE_CAPACITY);
        let handle = spawn_input_thread(
            capture.stream_width,
            capture.stream_height,
            capture.display_width,
            capture.display_height,
            rx,
        );
        (Some(tx), Some(handle))
    } else {
        (None, None)
    };

    let mut command_handler = lattice_remote::host_commands::Commands::new(
        allow_commands,
        outgoing.clone(),
        command_permits,
    );
    let mut file_handler =
        FileRequestHandler::new(shared_files.clone(), outgoing.clone(), file_job_permits);
    let mut file_failed_rx = file_handler.registry.subscribe_failures();
    let mut command_failed_rx = command_handler.subscribe_failures();
    let (receiver_stop_tx, mut receiver_stop_rx) = watch::channel(false);
    let receiver = tokio::spawn(async move {
        loop {
            let message = tokio::select! {
                biased;
                _ = receiver_stop_rx.changed() => break,
                _ = file_failed_rx.changed() => break,
                _ = command_failed_rx.changed() => break,
                message = reader.receive() => message,
            };
            match message {
                Ok(RemoteMessage::Input(input)) => {
                    if let Some(tx) = &input_tx {
                        let queued = tokio::select! {
                            biased;
                            _ = receiver_stop_rx.changed() => false,
                            queued = send_input_with_backpressure(
                                tx,
                                input,
                                REMOTE_INPUT_ENQUEUE_TIMEOUT,
                            ) => queued,
                        };
                        if !queued {
                            break;
                        }
                    }
                }
                Ok(RemoteMessage::CommandRequest(request)) => {
                    if !command_handler.handle(request).await {
                        break;
                    }
                }
                Ok(RemoteMessage::FileRequest(request)) => {
                    let handled = tokio::select! {
                        biased;
                        _ = receiver_stop_rx.changed() => false,
                        _ = file_failed_rx.changed() => false,
                        handled = file_handler.handle(request) => handled,
                    };
                    if !handled {
                        break;
                    }
                }
                Ok(RemoteMessage::Close(_)) | Err(_) => break,
                Ok(_) => {}
            }
        }
        // Dropping the sender ends the input thread and releases held keys.
        drop(input_tx);
        command_handler.shutdown().await;
        file_handler.shutdown().await;
    });

    let interval = Duration::from_millis(1000 / fps as u64);
    let mut frame_id = 0u64;
    let stream_result = loop {
        if receiver.is_finished() {
            break Ok(());
        }
        let started = Instant::now();
        frame_id = frame_id.wrapping_add(1);
        let mut send_error = None;
        let messages =
            match frame_messages(frame_id, width, height, FrameFormat::Jpeg, &capture.jpeg) {
                Ok(messages) => messages,
                Err(error) => break Err(error.to_string()),
            };
        for message in messages {
            if outgoing.send(message).await.is_err() {
                send_error = Some("The encrypted writer stopped.".to_string());
                break;
            }
        }
        if let Some(error) = send_error {
            break Err(error);
        }

        if started.elapsed() < interval {
            sleep(interval - started.elapsed()).await;
        }
        capture = match capture_jpeg(&monitor) {
            Ok(capture) => capture,
            Err(error) => break Err(error),
        };
        width = capture.stream_width;
        height = capture.stream_height;
    };

    // Cooperatively stop and await the receiver so its bounded file shutdown
    // and input-sender drop run even when capture or the writer failed first.
    stop_and_wait(receiver_stop_tx, receiver).await;
    drop(outgoing);
    abort_and_wait(writer).await;
    if let Some(handle) = input_thread {
        let _ = handle.join();
    }
    stream_result
}

const TERMINAL_COLS: u16 = 120;
const TERMINAL_ROWS: u16 = 32;

/// Owns a PTY child until it has either exited naturally or been terminated
/// and reaped. `portable-pty::Child` has no process-killing `Drop`, so simply
/// returning after `spawn_command` can otherwise orphan the shell.
struct TerminalChildGuard {
    child: Option<Box<dyn portable_pty::Child + Send + Sync>>,
    // portable-pty calls setsid(2) before exec on Unix, making the spawned
    // shell PID both the session and initial process-group leader. Linux uses
    // the ID to terminate every process still in that PTY session; other Unix
    // systems safely fall back to its initial process group.
    #[cfg(unix)]
    process_group: Option<libc::pid_t>,
}

impl TerminalChildGuard {
    fn new(child: Box<dyn portable_pty::Child + Send + Sync>) -> Self {
        #[cfg(unix)]
        let process_group = child
            .process_id()
            .and_then(|process_id| libc::pid_t::try_from(process_id).ok())
            .filter(|process_group| {
                // Never allow a malformed/custom Child implementation to
                // target init or the agent's own process group.
                *process_group > 1 && *process_group != unsafe { libc::getpgrp() }
            });
        Self {
            child: Some(child),
            #[cfg(unix)]
            process_group,
        }
    }

    fn terminate_and_wait(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };

        #[cfg(unix)]
        if let Some(process_group) = self.process_group.take() {
            // SAFETY: process_group is a validated positive PID distinct from
            // the agent's group. The unreaped leader pins this group/session
            // ID until all signalling is complete.
            let _ = unsafe { libc::killpg(process_group, libc::SIGHUP) };

            #[cfg(target_os = "linux")]
            let mut used_pidfd = signal_linux_session(process_group, libc::SIGHUP);
            std::thread::sleep(TERMINAL_PROCESS_GROUP_GRACE);

            #[cfg(target_os = "linux")]
            for _ in 0..TERMINAL_SESSION_KILL_ROUNDS {
                used_pidfd |= signal_linux_session(process_group, libc::SIGKILL);
                std::thread::sleep(TERMINAL_SESSION_KILL_INTERVAL);
            }

            // Keep the leader unreaped until after this final group fallback,
            // so its PID cannot be reused for an unrelated process group.
            let kill_sent = unsafe { libc::killpg(process_group, libc::SIGKILL) } == 0;
            #[cfg(target_os = "linux")]
            let termination_sent = used_pidfd || kill_sent;
            #[cfg(not(target_os = "linux"))]
            let termination_sent = kill_sent;
            if !termination_sent {
                let _ = child.kill();
            }
            let _ = child.wait();
            return;
        }

        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

impl Drop for TerminalChildGuard {
    fn drop(&mut self) {
        self.terminate_and_wait();
    }
}

fn default_shell() -> String {
    if cfg!(windows) {
        env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string())
    } else {
        env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    }
}

/// Terminal mode: instead of streaming the display, the agent runs the user's
/// shell in a PTY and bridges raw bytes both ways. This is what a headless
/// host without any desktop can share; file access rides the same channel.
async fn serve_terminal<S>(
    connection: SecureConnection<S>,
    allow_input: bool,
    allow_commands: bool,
    file_root: Option<PathBuf>,
    file_job_permits: Arc<Semaphore>,
    command_permits: Arc<Semaphore>,
) -> Result<(), String>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};

    // Validate the optional shared root before starting a process. The CLI
    // validated it earlier, but it can disappear before a viewer connects.
    let shared_files = file_root.map(SharedFiles::open).transpose()?.map(Arc::new);
    let pty = native_pty_system()
        .openpty(PtySize {
            rows: TERMINAL_ROWS,
            cols: TERMINAL_COLS,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Cannot open a PTY: {error}"))?;
    let mut command = CommandBuilder::new(default_shell());
    if let Some(home) = env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
        command.cwd(home);
    }
    let child = pty
        .slave
        .spawn_command(command)
        .map_err(|error| format!("Cannot start the shell: {error}"))?;
    let mut child = TerminalChildGuard::new(child);
    drop(pty.slave);
    let master = pty.master;
    #[cfg(unix)]
    let pty_poll_fd = master
        .as_raw_fd()
        .ok_or_else(|| "The PTY master has no pollable file descriptor.".to_string())?;
    let mut pty_reader = master
        .try_clone_reader()
        .map_err(|error| error.to_string())?;
    let mut pty_writer = master.take_writer().map_err(|error| error.to_string())?;
    #[cfg(unix)]
    set_pty_nonblocking(pty_poll_fd)?;

    let (mut reader, mut writer_half) = connection.split();
    send_remote_message(
        &mut writer_half,
        &RemoteMessage::Hello(RemoteHello {
            protocol_version: PROTOCOL_VERSION,
            agent_name: agent_name(),
            width: u32::from(TERMINAL_COLS),
            height: u32::from(TERMINAL_ROWS),
            view_only: !allow_input,
            file_transfer: shared_files.is_some(),
            file_edit: shared_files.is_some() && host_text::editing_supported(),
            command_shells: lattice_remote::host_commands::supported_shells(allow_commands),
            file_root_label: shared_files
                .as_ref()
                .map(|files| files.label().to_string())
                .unwrap_or_default(),
            terminal: true,
        }),
    )
    .await?;

    let (outgoing, mut outgoing_rx) = mpsc::channel::<RemoteMessage>(128);
    // Either side of the PTY-to-wire pump can finish independently of the
    // viewer's read half. A sticky watch signal wakes the receive loop even
    // when the viewer keeps its socket open and sends nothing further.
    let (pump_ended_tx, mut pump_ended_rx) = watch::channel(false);
    let writer_ended_tx = pump_ended_tx.clone();
    let writer = tokio::spawn(async move {
        while let Some(message) = outgoing_rx.recv().await {
            if send_remote_message(&mut writer_half, &message)
                .await
                .is_err()
            {
                break;
            }
        }
        let _ = writer_ended_tx.send(true);
    });

    // Blocking PTY reads run on a plain thread; a closed channel or shell
    // exit ends the pump, and the Close tells the viewer why.
    let pump_stopped = Arc::new(AtomicBool::new(false));
    let output_tx = outgoing.clone();
    let output_ended_tx = pump_ended_tx.clone();
    let output_stopped = Arc::clone(&pump_stopped);
    let output_thread = std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            #[cfg(unix)]
            if !wait_for_pty_event(pty_poll_fd, libc::POLLIN, &output_stopped) {
                break;
            }
            if output_stopped.load(Ordering::Relaxed) {
                break;
            }
            match pty_reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(length) => {
                    if output_tx
                        .blocking_send(RemoteMessage::TerminalData {
                            bytes: buffer[..length].to_vec(),
                        })
                        .is_err()
                    {
                        break;
                    }
                }
                #[cfg(unix)]
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                    ) => {}
                Err(_) => break,
            }
        }
        // Never wait for room for the final advisory Close: the separate end
        // signal drives teardown and will close the transport if its queue is
        // already backpressured.
        let _ = output_tx.try_send(RemoteMessage::Close("The shell session ended.".to_string()));
        let _ = output_ended_tx.send(true);
    });

    // Keystrokes reach the PTY through a bounded blocking writer thread. The
    // async sender below waits for room, bounding large-paste memory usage.
    let (keystroke_tx, mut keystroke_rx) =
        bounded_input_channel::<Vec<u8>>(TERMINAL_INPUT_QUEUE_CAPACITY);
    let input_ended_tx = pump_ended_tx.clone();
    #[cfg(unix)]
    let input_stopped = Arc::clone(&pump_stopped);
    let input_thread = std::thread::spawn(move || {
        #[cfg(unix)]
        'input: while let Some(bytes) = keystroke_rx.blocking_recv() {
            let mut remaining = bytes.as_slice();
            while !remaining.is_empty() {
                if !wait_for_pty_event(pty_poll_fd, libc::POLLOUT, &input_stopped) {
                    break 'input;
                }
                match pty_writer.write(remaining) {
                    Ok(0) => break 'input,
                    Ok(length) => remaining = &remaining[length..],
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                        ) => {}
                    Err(_) => break 'input,
                }
            }
        }
        #[cfg(not(unix))]
        while let Some(bytes) = keystroke_rx.blocking_recv() {
            if pty_writer.write_all(&bytes).is_err() {
                break;
            }
            let _ = pty_writer.flush();
        }
        let _ = input_ended_tx.send(true);
    });
    drop(pump_ended_tx);

    let mut command_handler = lattice_remote::host_commands::Commands::new(
        allow_commands,
        outgoing.clone(),
        command_permits,
    );
    let mut file_handler =
        FileRequestHandler::new(shared_files, outgoing.clone(), file_job_permits);
    let mut file_failed_rx = file_handler.registry.subscribe_failures();
    let mut command_failed_rx = command_handler.subscribe_failures();
    loop {
        let message = tokio::select! {
            biased;
            _ = pump_ended_rx.changed() => break,
            _ = file_failed_rx.changed() => break,
                _ = command_failed_rx.changed() => break,
            message = reader.receive() => message,
        };
        match message {
            Ok(RemoteMessage::TerminalInput { bytes }) => {
                if allow_input {
                    let queued = tokio::select! {
                        biased;
                        _ = pump_ended_rx.changed() => false,
                        queued = send_input_with_backpressure(
                            &keystroke_tx,
                            bytes,
                            REMOTE_INPUT_ENQUEUE_TIMEOUT,
                        ) => queued,
                    };
                    if !queued {
                        break;
                    }
                }
            }
            Ok(RemoteMessage::TerminalResize { cols, rows }) => {
                if allow_input {
                    let _ = master.resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    });
                }
            }
            Ok(RemoteMessage::CommandRequest(request)) => {
                if !command_handler.handle(request).await {
                    break;
                }
            }
            Ok(RemoteMessage::FileRequest(request)) => {
                let handled = tokio::select! {
                    biased;
                    _ = pump_ended_rx.changed() => false,
                    _ = file_failed_rx.changed() => false,
                    handled = file_handler.handle(request) => handled,
                };
                if !handled {
                    break;
                }
            }
            Ok(RemoteMessage::Close(_)) | Err(_) => break,
            Ok(_) => {}
        }
    }

    command_handler.shutdown().await;
    file_handler.shutdown().await;
    drop(file_handler);
    drop(keystroke_tx);
    pump_stopped.store(true, Ordering::Relaxed);
    child.terminate_and_wait();
    drop(outgoing);
    // Dropping the async receiver first guarantees a PTY output thread stuck
    // in blocking_send observes closure before we synchronously join it.
    abort_and_wait(writer).await;
    // Unix polling borrows master's raw fd, so keep it alive through both
    // joins. Dropping the ConPTY master is Windows' available I/O wake-up.
    #[cfg(windows)]
    drop(master);
    let _ = output_thread.join();
    let _ = input_thread.join();
    #[cfg(not(windows))]
    drop(master);
    Ok(())
}

/// How one relayed session concluded, reported back to the control loop.
enum SessionOutcome {
    /// The viewer failed the pairing handshake.
    Rejected,
    /// A paired session ran and finished for the given reason.
    Ended(String),
}

/// Serves one invited session over a fresh relay connection. The pairing code
/// still authenticates the viewer end to end; the relay only linked sockets.
async fn run_relay_session(
    relay_endpoint: String,
    channel_id: String,
    identity: DeviceIdentity,
    options: Options,
) -> SessionOutcome {
    let mut stream = match Transport::connect(&relay_endpoint).await {
        Ok(stream) => stream,
        Err(error) => return SessionOutcome::Ended(format!("Could not reach the relay: {error}")),
    };
    if write_client_message(
        &mut stream,
        &RelayClientMessage::Join {
            channel_id,
            device_id: identity.device_id.clone(),
            auth_token: identity.auth_token.clone(),
        },
    )
    .await
    .is_err()
    {
        return SessionOutcome::Ended("The relay dropped the session invite.".to_string());
    }
    match timeout(Duration::from_secs(10), read_server_message(&mut stream)).await {
        Ok(Ok(RelayServerMessage::Linked { .. })) => {}
        _ => return SessionOutcome::Ended("The relay did not link the session.".to_string()),
    }

    emit_event(
        options.json,
        &AgentEvent::PairingRequest {
            peer: "relay".to_string(),
        },
    );
    // The permanent identity key lets returning viewers pin this device.
    let static_key = match identity.noise_private_bytes() {
        Ok(static_key) => static_key,
        Err(error) => return SessionOutcome::Ended(format!("Identity key unavailable: {error}")),
    };
    let permit = match reserve_pairing(&options) {
        Ok(permit) => permit,
        Err(detail) => {
            emit_event(
                options.json,
                &AgentEvent::Failed {
                    stage: "pairing",
                    detail,
                },
            );
            return SessionOutcome::Rejected;
        }
    };
    let secure = match timeout(
        Duration::from_secs(10),
        SecureConnection::accept_for_device(
            stream,
            &options.pairing_code,
            &static_key,
            Some(&identity.device_id),
        ),
    )
    .await
    {
        Ok(Ok(secure)) => secure,
        Ok(Err(_)) | Err(_) => return SessionOutcome::Rejected,
    };
    if let Err(detail) = permit.authenticated() {
        emit_event(
            options.json,
            &AgentEvent::Failed {
                stage: "pairing",
                detail,
            },
        );
        return SessionOutcome::Rejected;
    }
    emit_event(
        options.json,
        &AgentEvent::Paired {
            peer: "relay".to_string(),
        },
    );
    let outcome = if options.terminal {
        serve_terminal(
            secure,
            options.allow_input,
            options.allow_commands,
            options.file_root,
            Arc::clone(&options.file_job_permits),
            Arc::clone(&options.command_permits),
        )
        .await
    } else {
        serve(
            secure,
            options.fps,
            options.allow_input,
            options.allow_commands,
            options.file_root,
            Arc::clone(&options.file_job_permits),
            Arc::clone(&options.command_permits),
        )
        .await
    };
    match outcome {
        Ok(()) => SessionOutcome::Ended("Remote session completed.".to_string()),
        Err(error) => SessionOutcome::Ended(format!("Session ended: {error}")),
    }
}

/// Relay mode: register the permanent device ID, then keep serving sessions
/// until stopped. The control link reconnects with backoff; a session in
/// flight rides its own connection and survives a control drop.
async fn run_relay(options: &Options) -> String {
    let relay_raw = options.relay.clone().expect("relay mode requires --relay");
    let relay_endpoint = match normalize_relay_endpoint(&relay_raw) {
        Ok(endpoint) => endpoint,
        Err(error) => {
            emit_event(
                options.json,
                &AgentEvent::Failed {
                    stage: "relay",
                    detail: error.to_string(),
                },
            );
            return "The relay address is invalid.".to_string();
        }
    };
    let identity_path = match options.identity_file.clone().or_else(default_identity_path) {
        Some(path) => path,
        None => {
            let detail = "No identity file location is available.".to_string();
            emit_event(
                options.json,
                &AgentEvent::Failed {
                    stage: "identity",
                    detail: detail.clone(),
                },
            );
            return detail;
        }
    };
    let identity = match DeviceIdentity::load_or_create(&identity_path) {
        Ok(identity) => identity,
        Err(error) => {
            emit_event(
                options.json,
                &AgentEvent::Failed {
                    stage: "identity",
                    detail: error.to_string(),
                },
            );
            return format!("Cannot load the device identity: {error}");
        }
    };

    let listening_address = listener.local_addr().unwrap_or(options.bind);
    let formatted_code = lattice_remote::format_pairing_code(&options.pairing_code);
    let mut failed_pairings = 0u32;
    let mut announced = false;
    let mut link_up = false;
    let mut reconnect_delay = Duration::from_secs(1);

    loop {
        let connected = async {
            let stream = Transport::connect(&relay_endpoint)
                .await
                .map_err(|error| error.to_string())?;
            let (mut read_half, mut write_half) = tokio::io::split(stream);
            write_client_message(
                &mut write_half,
                &RelayClientMessage::Register {
                    device_id: identity.device_id.clone(),
                    auth_token: identity.auth_token.clone(),
                    agent_name: agent_name(),
                },
            )
            .await
            .map_err(|error| error.to_string())?;
            match timeout(Duration::from_secs(10), read_server_message(&mut read_half)).await {
                Ok(Ok(RelayServerMessage::Registered)) => Ok((read_half, write_half, None)),
                Ok(Ok(RelayServerMessage::Error { code, detail })) => {
                    Ok((read_half, write_half, Some((code, detail))))
                }
                _ => Err("The relay did not answer the registration.".to_string()),
            }
        }
        .await;

        let (mut read_half, mut write_half) = match connected {
            Ok((_, _, Some((code, detail)))) => {
                emit_event(
                    options.json,
                    &AgentEvent::Failed {
                        stage: "relay",
                        detail: detail.clone(),
                    },
                );
                return format!("The relay refused this device ({code}): {detail}");
            }
            Ok((read_half, write_half, None)) => (read_half, write_half),
            Err(detail) => {
                if !announced {
                    emit_event(
                        options.json,
                        &AgentEvent::Failed {
                            stage: "relay",
                            detail: detail.clone(),
                        },
                    );
                    return format!("Cannot reach the relay: {detail}");
                }
                if link_up {
                    link_up = false;
                    emit_event(options.json, &AgentEvent::RelayState { connected: false });
                }
                sleep(reconnect_delay).await;
                reconnect_delay = (reconnect_delay * 2).min(RELAY_RECONNECT_CAP);
                continue;
            }
        };
        reconnect_delay = Duration::from_secs(1);

        if !announced {
            announced = true;
            emit_event(
                options.json,
                &AgentEvent::Ready {
                    address: relay_raw.clone(),
                    pairing_code: formatted_code.clone(),
                    expires_in_seconds: 0,
                    view_only: !options.allow_input,
                    file_transfer: options.file_root.is_some(),
                    commands: options.allow_commands,
                    file_root: options
                        .file_root
                        .as_ref()
                        .map(|path| path.display().to_string()),
                    device_id: Some(identity.device_id.clone()),
                    relay: Some(relay_raw.clone()),
                    persistent: true,
                },
            );
            if !options.json {
                println!("Lattice Remote is ready over the relay {relay_raw}.");
                println!("Device ID: {}", format_device_id(&identity.device_id));
                println!("Pairing code: {formatted_code}");
                println!("The code stays valid until sharing stops.");
            }
        }
        if !link_up {
            link_up = true;
            emit_event(options.json, &AgentEvent::RelayState { connected: true });
        }

        // A writer channel serialises pings; the reader loop below owns
        // invites and session outcomes.
        let (control_tx, mut control_rx) = mpsc::channel::<RelayClientMessage>(4);
        let writer_task = tokio::spawn(async move {
            while let Some(message) = control_rx.recv().await {
                if write_client_message(&mut write_half, &message)
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });
        let ping_tx = control_tx.clone();
        let ping_task = tokio::spawn(async move {
            loop {
                sleep(RELAY_PING_INTERVAL).await;
                if ping_tx.send(RelayClientMessage::Ping).await.is_err() {
                    break;
                }
            }
        });

        // Sessions run inline: pings keep flowing from their own task, so a
        // long session cannot get this device deregistered, and a second
        // viewer's dial simply times out while a session streams. `serve`
        // holds OS capture handles that are not `Send`, which also rules
        // out spawning sessions onto other threads.
        let fatal = loop {
            match read_server_message(&mut read_half).await {
                Ok(RelayServerMessage::Invite { channel_id }) => {
                    let outcome = run_relay_session(
                        relay_endpoint.clone(),
                        channel_id,
                        identity.clone(),
                        options.clone(),
                    )
                    .await;
                    match outcome {
                        SessionOutcome::Rejected => {
                            failed_pairings += 1;
                            let attempts_remaining =
                                MAX_PAIRING_FAILURES.saturating_sub(failed_pairings);
                            emit_event(
                                options.json,
                                &AgentEvent::PairingRejected { attempts_remaining },
                            );
                            if failed_pairings >= MAX_PAIRING_FAILURES {
                                break Some(
                                    "Too many failed pairing attempts; the Agent stopped."
                                        .to_string(),
                                );
                            }
                        }
                        SessionOutcome::Ended(reason) => {
                            failed_pairings = 0;
                            emit_event(options.json, &AgentEvent::SessionEnded { reason });
                        }
                    }
                }
                Ok(_) => {}
                Err(_) => break None,
            }
        };

        ping_task.abort();
        writer_task.abort();
        if let Some(reason) = fatal {
            return reason;
        }
        if link_up {
            link_up = false;
            emit_event(options.json, &AgentEvent::RelayState { connected: false });
        }
        sleep(reconnect_delay).await;
        reconnect_delay = (reconnect_delay * 2).min(RELAY_RECONNECT_CAP);
    }
}

#[tokio::main]
async fn main() {
    let requested_json = env::args().any(|argument| argument == "--json");
    let options = match parse_options() {
        Ok(options) => options,
        Err(error) => {
            emit_event(
                requested_json,
                &AgentEvent::Failed {
                    stage: "options",
                    detail: error.clone(),
                },
            );
            if !requested_json {
                eprintln!("Error: {error}\n\n{}", help());
            }
            std::process::exit(2);
        }
    };

    if options.relay.is_some() {
        let stop_reason = run_relay(&options).await;
        emit_event(
            options.json,
            &AgentEvent::Stopped {
                reason: stop_reason.clone(),
            },
        );
        if !options.json {
            eprintln!("{stop_reason}");
        }
        return;
    }

    let listener = match TcpListener::bind(options.bind).await {
        Ok(listener) => listener,
        Err(error) => {
            let detail = format!("Unable to listen on {}: {error}", options.bind);
            emit_event(
                options.json,
                &AgentEvent::Failed {
                    stage: "listen",
                    detail: detail.clone(),
                },
            );
            if !options.json {
                eprintln!("{detail}");
            }
            std::process::exit(1);
        }
    };

    let listening_address = listener.local_addr().unwrap_or(options.bind);
    let formatted_code = lattice_remote::format_pairing_code(&options.pairing_code);
    emit_event(
        options.json,
        &AgentEvent::Ready {
            address: listening_address.to_string(),
            pairing_code: formatted_code.clone(),
            expires_in_seconds: PAIRING_LIFETIME.as_secs(),
            view_only: !options.allow_input,
            file_transfer: options.file_root.is_some(),
            commands: options.allow_commands,
            file_root: options
                .file_root
                .as_ref()
                .map(|path| path.display().to_string()),
            device_id: None,
            relay: None,
            persistent: false,
        },
    );
    if !options.json {
        let mode = if options.allow_input {
            "remote control enabled"
        } else {
            "view-only"
        };
        println!("Lattice Remote is ready ({mode})");
        println!("Address: {listening_address}");
        println!("Pairing code: {formatted_code}");
        println!("The code is valid for one successful connection and is not saved.");
    }

    let expires_at = Instant::now() + PAIRING_LIFETIME;
    let mut failed_pairings = 0_u32;
    let stop_reason = loop {
        let remaining = expires_at.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break "Pairing code expired after five minutes.".to_string();
        }
        let (stream, peer) = match timeout(remaining, listener.accept()).await {
            Ok(Ok((stream, peer))) => {
                let _ = stream.set_nodelay(true);
                (stream, peer)
            }
            Ok(Err(error)) => {
                if !options.json {
                    eprintln!("Could not accept connection: {error}");
                }
                continue;
            }
            Err(_) => break "Pairing code expired after five minutes.".to_string(),
        };
        emit_event(
            options.json,
            &AgentEvent::PairingRequest {
                peer: peer.to_string(),
            },
        );
        if !options.json {
            eprintln!("Pairing request from {peer}");
        }
        let permit = match reserve_pairing(&options) {
            Ok(permit) => permit,
            Err(detail) => break detail,
        };
        let secure = match timeout(
            Duration::from_secs(10),
            SecureConnection::accept(stream, &options.pairing_code),
        )
        .await
        {
            Ok(Ok(connection)) => connection,
            Ok(Err(_)) | Err(_) => {
                failed_pairings += 1;
                let attempts_remaining = MAX_PAIRING_FAILURES.saturating_sub(failed_pairings);
                emit_event(
                    options.json,
                    &AgentEvent::PairingRejected { attempts_remaining },
                );
                if !options.json {
                    eprintln!("Pairing rejected.");
                }
                if failed_pairings >= MAX_PAIRING_FAILURES {
                    break "Too many failed pairing attempts; the Agent stopped.".to_string();
                }
                sleep(Duration::from_secs(u64::from(failed_pairings))).await;
                continue;
            }
        };

        if let Err(detail) = permit.authenticated() {
            break detail;
        }
        emit_event(
            options.json,
            &AgentEvent::Paired {
                peer: peer.to_string(),
            },
        );
        if !options.json {
            let stream_kind = if options.allow_input {
                "interactive"
            } else {
                "view-only"
            };
            println!("Paired with {peer}. Starting encrypted {stream_kind} stream.");
        }
        let outcome = if options.terminal {
            serve_terminal(
                secure,
                options.allow_input,
                options.allow_commands,
                options.file_root.clone(),
                Arc::clone(&options.file_job_permits),
                Arc::clone(&options.command_permits),
            )
            .await
        } else {
            serve(
                secure,
                options.fps,
                options.allow_input,
                options.allow_commands,
                options.file_root.clone(),
                Arc::clone(&options.file_job_permits),
                Arc::clone(&options.command_permits),
            )
            .await
        };
        break match outcome {
            Ok(()) => "Remote session completed.".to_string(),
            Err(error) => format!("Session ended: {error}"),
        };
    };

    emit_event(
        options.json,
        &AgentEvent::Stopped {
            reason: stop_reason.clone(),
        },
    );
    if !options.json {
        eprintln!("{stop_reason}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    static NEXT_FILE_TEST_ROOT: AtomicUsize = AtomicUsize::new(1);

    struct FileTestRoot(PathBuf);

    impl FileTestRoot {
        fn new(label: &str) -> Self {
            let token = NEXT_FILE_TEST_ROOT.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "lattice-agent-{label}-{}-{token}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).expect("create file handler test root");
            Self(path)
        }

        fn shared(&self) -> Arc<SharedFiles> {
            Arc::new(SharedFiles::open(&self.0).expect("open file handler test root"))
        }

        fn staging_files(&self) -> usize {
            fn count(directory: &Path) -> usize {
                std::fs::read_dir(directory)
                    .expect("read file handler test directory")
                    .filter_map(Result::ok)
                    .map(|entry| {
                        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                            count(&entry.path())
                        } else {
                            usize::from(entry.file_name().to_string_lossy().ends_with(".part"))
                        }
                    })
                    .sum()
            }
            count(&self.0)
        }

        fn private_upload_artifacts(&self) -> usize {
            fn count(directory: &Path) -> usize {
                std::fs::read_dir(directory)
                    .expect("read file handler test directory")
                    .filter_map(Result::ok)
                    .map(|entry| {
                        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                            count(&entry.path())
                        } else {
                            let name = entry.file_name();
                            let name = name.to_string_lossy();
                            usize::from(
                                name.contains(".latticeterm-upload-")
                                    || name.contains(".latticeterm-replaced-"),
                            )
                        }
                    })
                    .sum()
            }
            count(&self.0)
        }
    }

    impl Drop for FileTestRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    async fn next_handler_file_response(
        receiver: &mut mpsc::Receiver<RemoteMessage>,
    ) -> RemoteFileResponse {
        match timeout(Duration::from_secs(2), receiver.recv())
            .await
            .expect("file handler response timed out")
            .expect("file handler response channel closed")
        {
            RemoteMessage::FileResponse(response) => response,
            other => panic!("unexpected file handler message: {other:?}"),
        }
    }

    #[derive(Debug, Default)]
    struct MockTerminalChildState {
        running: bool,
        try_waits: usize,
        kills: usize,
        waits: usize,
    }

    #[derive(Clone, Debug)]
    struct MockTerminalChild {
        state: Arc<Mutex<MockTerminalChildState>>,
    }

    impl portable_pty::ChildKiller for MockTerminalChild {
        fn kill(&mut self) -> std::io::Result<()> {
            let mut state = self.state.lock().unwrap();
            state.kills += 1;
            state.running = false;
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            Box::new(self.clone())
        }
    }

    impl portable_pty::Child for MockTerminalChild {
        fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
            let mut state = self.state.lock().unwrap();
            state.try_waits += 1;
            Ok((!state.running).then(|| portable_pty::ExitStatus::with_exit_code(0)))
        }

        fn wait(&mut self) -> std::io::Result<portable_pty::ExitStatus> {
            let mut state = self.state.lock().unwrap();
            state.waits += 1;
            state.running = false;
            Ok(portable_pty::ExitStatus::with_exit_code(0))
        }

        fn process_id(&self) -> Option<u32> {
            None
        }

        #[cfg(windows)]
        fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
            None
        }
    }

    fn mock_terminal_child(
        running: bool,
    ) -> (
        Box<dyn portable_pty::Child + Send + Sync>,
        Arc<Mutex<MockTerminalChildState>>,
    ) {
        let state = Arc::new(Mutex::new(MockTerminalChildState {
            running,
            ..MockTerminalChildState::default()
        }));
        (
            Box::new(MockTerminalChild {
                state: Arc::clone(&state),
            }),
            state,
        )
    }

    #[test]
    fn terminal_child_guard_terminates_and_reaps_on_drop() {
        let (child, state) = mock_terminal_child(true);
        {
            let _guard = TerminalChildGuard::new(child);
        }

        let state = state.lock().unwrap();
        assert_eq!(state.try_waits, 1);
        assert_eq!(state.kills, 1);
        assert_eq!(state.waits, 1);
        assert!(!state.running);
    }

    #[test]
    fn terminal_child_guard_explicit_cleanup_is_not_repeated_on_drop() {
        let (child, state) = mock_terminal_child(true);
        let mut guard = TerminalChildGuard::new(child);
        guard.terminate_and_wait();
        drop(guard);

        let state = state.lock().unwrap();
        assert_eq!(state.try_waits, 1);
        assert_eq!(state.kills, 1);
        assert_eq!(state.waits, 1);
    }

    #[test]
    fn terminal_child_guard_does_not_kill_an_already_exited_child() {
        let (child, state) = mock_terminal_child(false);
        drop(TerminalChildGuard::new(child));

        let state = state.lock().unwrap();
        assert_eq!(state.try_waits, 1);
        assert_eq!(state.kills, 0);
        assert_eq!(state.waits, 0);
    }

    #[tokio::test]
    async fn bounded_input_queue_waits_for_room_and_fails_after_receiver_closes() {
        let (sender, mut receiver) = bounded_input_channel::<usize>(TERMINAL_INPUT_QUEUE_CAPACITY);
        assert_eq!(sender.capacity(), TERMINAL_INPUT_QUEUE_CAPACITY);

        for value in 0..TERMINAL_INPUT_QUEUE_CAPACITY {
            assert!(
                send_input_with_backpressure(&sender, value, REMOTE_INPUT_ENQUEUE_TIMEOUT,).await
            );
        }

        let blocked_sender = sender.clone();
        let blocked = tokio::spawn(async move {
            send_input_with_backpressure(
                &blocked_sender,
                TERMINAL_INPUT_QUEUE_CAPACITY,
                REMOTE_INPUT_ENQUEUE_TIMEOUT,
            )
            .await
        });
        tokio::task::yield_now().await;
        assert!(
            !blocked.is_finished(),
            "the capacity + 1 input must wait instead of growing the queue"
        );

        assert_eq!(receiver.recv().await, Some(0));
        assert!(timeout(Duration::from_secs(1), blocked)
            .await
            .expect("backpressured sender should resume")
            .expect("input sender task should not panic"));

        drop(receiver);
        assert!(
            !send_input_with_backpressure(&sender, usize::MAX, REMOTE_INPUT_ENQUEUE_TIMEOUT,).await
        );

        let (timeout_sender, _timeout_receiver) = bounded_input_channel::<usize>(1);
        assert!(
            send_input_with_backpressure(&timeout_sender, 1, REMOTE_INPUT_ENQUEUE_TIMEOUT).await
        );
        assert!(
            !send_input_with_backpressure(&timeout_sender, 2, Duration::from_millis(10)).await,
            "a full input queue must time out instead of pinning the receive task"
        );

        let (screen_sender, _screen_receiver) =
            bounded_input_channel::<usize>(SCREEN_INPUT_QUEUE_CAPACITY);
        assert_eq!(screen_sender.capacity(), SCREEN_INPUT_QUEUE_CAPACITY);
    }

    #[tokio::test]
    async fn abort_and_wait_drops_task_channels_before_returning() {
        let (sender, mut receiver) = mpsc::channel::<()>(1);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _ = started_tx.send(());
            std::future::pending::<()>().await;
            drop(sender);
        });
        started_rx.await.expect("task should start");

        abort_and_wait(task).await;

        assert_eq!(receiver.recv().await, None);
    }

    #[tokio::test]
    async fn cooperative_stop_runs_receiver_cleanup_before_returning() {
        let (stop_tx, mut stop_rx) = watch::channel(false);
        let (cleanup_tx, cleanup_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _ = stop_rx.changed().await;
            let _ = cleanup_tx.send(());
        });

        stop_and_wait(stop_tx, task).await;

        cleanup_rx
            .await
            .expect("cooperative receiver cleanup must run before join returns");
    }

    #[test]
    fn file_job_admission_is_global_fail_fast_and_cross_kind_unique() {
        let permits = Arc::new(Semaphore::new(FILE_JOB_LIMIT));
        let first_session = Arc::new(FileJobRegistry::new());
        let second_session = Arc::new(FileJobRegistry::new());
        let mut admitted = Vec::new();

        for operation_id in 0..4 {
            admitted.push(
                try_admit_file_job(
                    &permits,
                    &first_session,
                    FileJobKind::List,
                    operation_id,
                    None,
                )
                .expect("first session job should fit"),
            );
        }
        for operation_id in 4..FILE_JOB_LIMIT as u64 {
            admitted.push(
                try_admit_file_job(
                    &permits,
                    &second_session,
                    FileJobKind::Download,
                    operation_id,
                    None,
                )
                .expect("second session job should fit global cap"),
            );
        }
        assert_eq!(permits.available_permits(), 0);
        assert_eq!(
            try_admit_file_job(&permits, &second_session, FileJobKind::List, 99, None,).err(),
            Some("Too many file operations are active.")
        );

        drop(admitted);
        assert_eq!(permits.available_permits(), FILE_JOB_LIMIT);
        let old = try_admit_file_job(&permits, &first_session, FileJobKind::List, 7, None)
            .expect("list should be admitted");
        assert_eq!(
            try_admit_file_job(&permits, &first_session, FileJobKind::Download, 7, None,).err(),
            Some("The file operation identifier is already active.")
        );
        drop(old);
        assert_eq!(first_session.in_flight.load(Ordering::Acquire), 0);
    }

    #[test]
    fn download_and_upload_resource_caps_reject_without_leaking_permits() {
        let permits = Arc::new(Semaphore::new(32));
        let downloads = Arc::new(FileJobRegistry::new());
        let mut admitted_downloads = Vec::new();
        for operation_id in 0..ACTIVE_DOWNLOAD_LIMIT as u64 {
            admitted_downloads.push(
                try_admit_file_job(
                    &permits,
                    &downloads,
                    FileJobKind::Download,
                    operation_id,
                    None,
                )
                .expect("download should fit its descriptor cap"),
            );
        }
        let permits_before_rejection = permits.available_permits();
        assert_eq!(
            try_admit_file_job(&permits, &downloads, FileJobKind::Download, 100, None,).err(),
            Some("Too many downloads are active.")
        );
        assert_eq!(permits.available_permits(), permits_before_rejection);
        drop(admitted_downloads);

        let uploads = Arc::new(FileJobRegistry::new());
        let mut admitted_uploads = Vec::new();
        let mut upload_receivers = Vec::new();
        for operation_id in 0..ACTIVE_UPLOAD_LIMIT as u64 {
            let (commands, receiver) = mpsc::channel(1);
            admitted_uploads.push(
                try_admit_file_job(
                    &permits,
                    &uploads,
                    FileJobKind::Upload { announced_bytes: 1 },
                    operation_id,
                    Some(commands),
                )
                .expect("upload should fit its descriptor cap"),
            );
            upload_receivers.push(receiver);
        }
        assert_eq!(
            try_admit_file_job(
                &permits,
                &uploads,
                FileJobKind::Upload { announced_bytes: 1 },
                100,
                None,
            )
            .err(),
            Some("Too many uploads are active.")
        );
        drop(admitted_uploads);
        drop(upload_receivers);

        let byte_limited = Arc::new(FileJobRegistry::new());
        let failed_before_open = try_admit_file_job(
            &permits,
            &byte_limited,
            FileJobKind::Upload {
                announced_bytes: MAX_UPLOAD_FILE_BYTES,
            },
            1,
            None,
        )
        .expect("reservation for a not-yet-opened upload should fit");
        drop(failed_before_open);
        assert_eq!(byte_limited.active.lock().unwrap().active_upload_bytes, 0);
        assert_eq!(
            byte_limited.active.lock().unwrap().committed_upload_bytes,
            0
        );

        let (first_permit, first_registration) = try_admit_file_job(
            &permits,
            &byte_limited,
            FileJobKind::Upload {
                announced_bytes: MAX_UPLOAD_FILE_BYTES,
            },
            10,
            None,
        )
        .expect("first committed upload should fit");
        byte_limited.commit_upload(10, &first_registration.control);
        drop((first_permit, first_registration));
        let (second_permit, second_registration) = try_admit_file_job(
            &permits,
            &byte_limited,
            FileJobKind::Upload {
                announced_bytes: MAX_UPLOAD_FILE_BYTES,
            },
            11,
            None,
        )
        .expect("second committed upload should fit session cap");
        byte_limited.commit_upload(11, &second_registration.control);
        drop((second_permit, second_registration));
        assert_eq!(
            try_admit_file_job(
                &permits,
                &byte_limited,
                FileJobKind::Upload { announced_bytes: 1 },
                12,
                None,
            )
            .err(),
            Some("The uploads exceed the session byte limit.")
        );
        assert_eq!(
            try_admit_file_job(
                &permits,
                &Arc::new(FileJobRegistry::new()),
                FileJobKind::Upload {
                    announced_bytes: MAX_UPLOAD_FILE_BYTES + 1,
                },
                4,
                None,
            )
            .err(),
            Some("The upload is larger than the per-file limit.")
        );
        assert_eq!(permits.available_permits(), 32);
    }

    #[test]
    fn cancelled_operation_blocks_reuse_and_stale_cleanup_cannot_remove_replacement() {
        let permits = Arc::new(Semaphore::new(2));
        let registry = Arc::new(FileJobRegistry::new());
        let (old_permit, old_registration) =
            try_admit_file_job(&permits, &registry, FileJobKind::Download, 41, None)
                .expect("old operation should be admitted");
        let old_control = Arc::clone(&old_registration.control);
        assert_eq!(registry.cancel(41), Some(FileCancelDisposition::Requested));
        assert!(old_control.is_cancelled());
        assert_eq!(
            try_admit_file_job(&permits, &registry, FileJobKind::List, 41, None).err(),
            Some("The file operation identifier is already active.")
        );

        drop((old_permit, old_registration));
        let (new_permit, new_registration) =
            try_admit_file_job(&permits, &registry, FileJobKind::List, 41, None)
                .expect("identifier can be reused after the old worker exits");
        registry
            .active
            .lock()
            .unwrap()
            .remove_if_current(41, &old_control);
        assert!(registry
            .control(41)
            .is_some_and(|current| Arc::ptr_eq(&current, &new_registration.control)));
        drop((new_permit, new_registration));
        assert_eq!(registry.in_flight.load(Ordering::Acquire), 0);
    }

    #[test]
    fn upload_commit_point_rejects_late_cancel_and_preserves_single_terminal_owner() {
        let (failed, _) = watch::channel(false);
        let control = FileJobControl::new(FileJobKind::Upload { announced_bytes: 1 }, None, failed);
        assert!(control.begin_upload_commit());
        assert_eq!(
            control.request_cancel(FileCancelResponse::Complete),
            FileCancelDisposition::TerminalPending
        );
        assert!(!control.is_cancelled());
        control.finish_upload_commit();

        let (failed, _) = watch::channel(false);
        let cancelled =
            FileJobControl::new(FileJobKind::Upload { announced_bytes: 1 }, None, failed);
        assert_eq!(
            cancelled.request_cancel(FileCancelResponse::Complete),
            FileCancelDisposition::Requested
        );
        assert!(!cancelled.begin_upload_commit());
    }

    #[test]
    fn upload_target_reservations_serialize_a_canonical_folder_and_release_on_drop() {
        let root = FileTestRoot::new("folder-reservation");
        let shared = root.shared();
        let first_target = shared.upload_destination("/first.bin").unwrap();
        let second_target = shared.upload_destination("/second.bin").unwrap();
        let first = try_reserve_upload_target(&first_target).expect("reserve first target folder");

        assert_eq!(
            try_reserve_upload_target(&second_target).err(),
            Some("Another upload in this destination folder is active.")
        );
        drop(first);

        let second = try_reserve_upload_target(&second_target)
            .expect("dropping the old guard should release the folder");
        drop(second);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn full_outgoing_queue_is_cancelled_without_stranding_worker_or_permit() {
        let root = FileTestRoot::new("full-outgoing");
        std::fs::write(root.0.join("large.bin"), vec![7; FILE_CHUNK_SIZE * 2])
            .expect("write download fixture");
        let permits = Arc::new(Semaphore::new(FILE_JOB_LIMIT));
        let (outgoing, _receiver) = mpsc::channel(1);
        outgoing
            .try_send(RemoteMessage::Close("queue full".to_string()))
            .expect("prefill outgoing queue");
        let mut handler =
            FileRequestHandler::new(Some(root.shared()), outgoing, Arc::clone(&permits));
        let registry = Arc::clone(&handler.registry);

        assert!(
            handler
                .handle(RemoteFileRequest::Download {
                    transfer_id: 9,
                    path: "/large.bin".to_string(),
                })
                .await
        );
        assert_eq!(registry.in_flight.load(Ordering::Acquire), 1);
        handler.shutdown().await;
        timeout(Duration::from_secs(1), registry.wait_for_idle())
            .await
            .expect("cancel should wake a worker blocked on outgoing capacity");
        assert_eq!(permits.available_permits(), FILE_JOB_LIMIT);
        assert!(registry.active.lock().unwrap().operations.is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancel_has_one_worker_owned_terminal_response_after_stale_output_stops() {
        let root = FileTestRoot::new("cancel-terminal");
        std::fs::write(root.0.join("large.bin"), vec![3; FILE_CHUNK_SIZE * 2])
            .expect("write download fixture");
        let permits = Arc::new(Semaphore::new(FILE_JOB_LIMIT));
        let (outgoing, mut receiver) = mpsc::channel(1);
        outgoing
            .try_send(RemoteMessage::Close("prefill".to_string()))
            .expect("prefill outgoing queue");
        let mut handler =
            FileRequestHandler::new(Some(root.shared()), outgoing, Arc::clone(&permits));
        let registry = Arc::clone(&handler.registry);
        assert!(
            handler
                .handle(RemoteFileRequest::Download {
                    transfer_id: 19,
                    path: "/large.bin".to_string(),
                })
                .await
        );
        tokio::time::sleep(Duration::from_millis(20)).await;

        assert!(
            handler
                .handle(RemoteFileRequest::Cancel { transfer_id: 19 })
                .await
        );
        assert!(matches!(
            receiver.recv().await,
            Some(RemoteMessage::Close(_))
        ));
        assert_eq!(
            next_handler_file_response(&mut receiver).await,
            RemoteFileResponse::Complete { transfer_id: 19 }
        );
        timeout(Duration::from_secs(1), registry.wait_for_idle())
            .await
            .expect("cancelled worker should settle after terminal enqueue");
        assert!(
            receiver.try_recv().is_err(),
            "no stale response may follow Complete"
        );
        assert_eq!(permits.available_permits(), FILE_JOB_LIMIT);
    }

    #[tokio::test]
    async fn full_immediate_error_queue_fails_the_session_closed() {
        let permits = Arc::new(Semaphore::new(FILE_JOB_LIMIT));
        let (outgoing, _receiver) = mpsc::channel(1);
        outgoing
            .try_send(RemoteMessage::Close("prefill".to_string()))
            .expect("prefill outgoing queue");
        let mut handler = FileRequestHandler::new(None, outgoing, permits);
        let failed = handler.registry.subscribe_failures();

        assert!(
            !handler
                .handle(RemoteFileRequest::List {
                    request_id: 88,
                    path: "/".to_string(),
                })
                .await
        );
        assert!(*failed.borrow());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn worker_outgoing_failure_wakes_session_and_releases_registration() {
        let root = FileTestRoot::new("worker-send-failure");
        std::fs::write(root.0.join("note.txt"), b"data").unwrap();
        let permits = Arc::new(Semaphore::new(FILE_JOB_LIMIT));
        let (outgoing, receiver) = mpsc::channel(1);
        drop(receiver);
        let mut handler =
            FileRequestHandler::new(Some(root.shared()), outgoing, Arc::clone(&permits));
        let registry = Arc::clone(&handler.registry);
        let mut failed = registry.subscribe_failures();

        assert!(
            handler
                .handle(RemoteFileRequest::Download {
                    transfer_id: 91,
                    path: "/note.txt".to_string(),
                })
                .await
        );
        timeout(Duration::from_secs(1), failed.changed())
            .await
            .expect("worker send failure must wake the session")
            .expect("failure sender stays alive with handler");
        timeout(Duration::from_secs(1), registry.wait_for_idle())
            .await
            .expect("failed worker should unregister");
        assert_eq!(permits.available_permits(), FILE_JOB_LIMIT);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn shutdown_timeout_keeps_stuck_fd_and_global_permit_until_worker_returns() {
        let root = FileTestRoot::new("stuck-worker");
        let shared = root.shared();
        let upload = shared
            .begin_upload(55, "/blocked.bin", 1, false)
            .expect("open staging upload");
        let permits = Arc::new(Semaphore::new(1));
        let (outgoing, _receiver) = mpsc::channel(1);
        let mut handler = FileRequestHandler::new(None, outgoing, Arc::clone(&permits));
        let registry = Arc::clone(&handler.registry);
        let (permit, registration) = try_admit_file_job(
            &permits,
            &registry,
            FileJobKind::Upload { announced_bytes: 1 },
            55,
            None,
        )
        .expect("stuck worker should be admitted");
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        spawn_file_thread("lattice-file-stuck-test", move || {
            let _permit = permit;
            let _registration = registration;
            let _upload = upload;
            let _ = release_rx.recv();
        })
        .expect("spawn stuck worker fixture");

        handler.shutdown().await;
        assert_eq!(permits.available_permits(), 0);
        assert_eq!(registry.in_flight.load(Ordering::Acquire), 1);
        assert!(registry.active.lock().unwrap().operations.is_empty());
        assert_eq!(root.staging_files(), 1);
        assert_eq!(
            try_admit_file_job(
                &permits,
                &Arc::new(FileJobRegistry::new()),
                FileJobKind::List,
                99,
                None,
            )
            .err(),
            Some("Too many file operations are active.")
        );

        release_tx.send(()).expect("release stuck worker fixture");
        timeout(Duration::from_secs(1), registry.wait_for_idle())
            .await
            .expect("released worker should settle");
        assert_eq!(root.staging_files(), 0);
        assert_eq!(permits.available_permits(), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn upload_flood_opens_only_eight_files_and_drop_cleans_every_staging_file() {
        let root = FileTestRoot::new("upload-cap");
        let permits = Arc::new(Semaphore::new(FILE_JOB_LIMIT));
        let (outgoing, mut receiver) = mpsc::channel(32);
        let mut handler =
            FileRequestHandler::new(Some(root.shared()), outgoing, Arc::clone(&permits));
        let registry = Arc::clone(&handler.registry);

        for transfer_id in 0..ACTIVE_UPLOAD_LIMIT as u64 {
            std::fs::create_dir(root.0.join(format!("slot-{transfer_id}")))
                .expect("create independent upload destination folder");
            assert!(
                handler
                    .handle(RemoteFileRequest::UploadStart {
                        transfer_id,
                        path: format!("/slot-{transfer_id}/upload.bin"),
                        size: 1,
                        overwrite: false,
                    })
                    .await
            );
        }
        let mut ready = 0;
        while ready < ACTIVE_UPLOAD_LIMIT {
            if matches!(
                next_handler_file_response(&mut receiver).await,
                RemoteFileResponse::UploadReady { .. }
            ) {
                ready += 1;
            }
        }
        assert_eq!(root.staging_files(), ACTIVE_UPLOAD_LIMIT);
        assert_eq!(permits.available_permits(), 0);

        assert!(
            handler
                .handle(RemoteFileRequest::UploadStart {
                    transfer_id: 99,
                    path: "/rejected.bin".to_string(),
                    size: 1,
                    overwrite: false,
                })
                .await
        );
        assert!(matches!(
            next_handler_file_response(&mut receiver).await,
            RemoteFileResponse::Error {
                operation_id: 99,
                ..
            }
        ));

        drop(handler);
        assert!(registry.active.lock().unwrap().operations.is_empty());
        timeout(Duration::from_secs(1), registry.wait_for_idle())
            .await
            .expect("dropping the handler should settle upload actors");
        assert_eq!(root.staging_files(), 0);
        assert_eq!(permits.available_permits(), FILE_JOB_LIMIT);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_sessions_reserve_one_overwrite_target_until_publish_settles() {
        let root = FileTestRoot::new("same-overwrite-target");
        std::fs::write(root.0.join("shared.bin"), b"older").unwrap();
        let shared = root.shared();
        let permits = Arc::new(Semaphore::new(FILE_JOB_LIMIT));
        let (outgoing_a, mut receiver_a) = mpsc::channel(8);
        let (outgoing_b, mut receiver_b) = mpsc::channel(8);
        let mut handler_a =
            FileRequestHandler::new(Some(Arc::clone(&shared)), outgoing_a, Arc::clone(&permits));
        let mut handler_b = FileRequestHandler::new(Some(shared), outgoing_b, Arc::clone(&permits));

        let (accepted_a, accepted_b) = tokio::join!(
            handler_a.handle(RemoteFileRequest::UploadStart {
                transfer_id: 201,
                path: "/shared.bin".to_string(),
                size: 5,
                overwrite: true,
            }),
            handler_b.handle(RemoteFileRequest::UploadStart {
                transfer_id: 202,
                path: "/shared.bin".to_string(),
                size: 5,
                overwrite: true,
            })
        );
        assert!(accepted_a && accepted_b);

        let (response_a, response_b) = tokio::join!(
            next_handler_file_response(&mut receiver_a),
            next_handler_file_response(&mut receiver_b)
        );
        let (winner, winner_bytes, winner_handler, winner_receiver) = match (response_a, response_b)
        {
            (
                RemoteFileResponse::UploadReady { transfer_id: 201 },
                RemoteFileResponse::Error {
                    operation_id: 202, ..
                },
            ) => (201, b"first".to_vec(), &mut handler_a, &mut receiver_a),
            (
                RemoteFileResponse::Error {
                    operation_id: 201, ..
                },
                RemoteFileResponse::UploadReady { transfer_id: 202 },
            ) => (202, b"other".to_vec(), &mut handler_b, &mut receiver_b),
            responses => {
                panic!("expected one ready upload and one reservation error: {responses:?}")
            }
        };

        assert!(
            winner_handler
                .handle(RemoteFileRequest::UploadChunk {
                    transfer_id: winner,
                    bytes: winner_bytes.clone(),
                })
                .await
        );
        assert!(
            winner_handler
                .handle(RemoteFileRequest::UploadFinish {
                    transfer_id: winner,
                })
                .await
        );
        assert_eq!(
            next_handler_file_response(winner_receiver).await,
            RemoteFileResponse::Complete {
                transfer_id: winner
            }
        );

        handler_a.shutdown().await;
        handler_b.shutdown().await;
        assert_eq!(
            std::fs::read(root.0.join("shared.bin")).unwrap(),
            winner_bytes
        );
        assert_eq!(root.private_upload_artifacts(), 0);
        assert_eq!(permits.available_permits(), FILE_JOB_LIMIT);
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn text_editor_reads_saves_and_interlocks_with_ordinary_uploads() {
        let root = FileTestRoot::new("text-editor-interlock");
        std::fs::write(root.0.join("note.txt"), b"original").unwrap();
        let shared = root.shared();
        let permits = Arc::new(Semaphore::new(FILE_JOB_LIMIT));
        let (outgoing_a, mut receiver_a) = mpsc::channel(8);
        let (outgoing_b, mut receiver_b) = mpsc::channel(8);
        let mut editor =
            FileRequestHandler::new(Some(Arc::clone(&shared)), outgoing_a, Arc::clone(&permits));
        let mut uploader =
            FileRequestHandler::new(Some(Arc::clone(&shared)), outgoing_b, Arc::clone(&permits));
        assert!(
            editor
                .handle(RemoteFileRequest::ReadText {
                    request_id: 601,
                    path: "/note.txt".into()
                })
                .await
        );
        let revision = match next_handler_file_response(&mut receiver_a).await {
            RemoteFileResponse::TextStart {
                request_id: 601,
                size: 8,
                revision,
            } => revision,
            response => panic!("unexpected text start: {response:?}"),
        };
        assert_eq!(
            next_handler_file_response(&mut receiver_a).await,
            RemoteFileResponse::DownloadChunk {
                transfer_id: 601,
                bytes: b"original".to_vec()
            }
        );
        assert_eq!(
            next_handler_file_response(&mut receiver_a).await,
            RemoteFileResponse::Complete { transfer_id: 601 }
        );
        assert!(
            editor
                .handle(RemoteFileRequest::SaveTextStart {
                    transfer_id: 602,
                    path: "/note.txt".into(),
                    size: 6,
                    expected_revision: revision,
                })
                .await
        );
        assert_eq!(
            next_handler_file_response(&mut receiver_a).await,
            RemoteFileResponse::UploadReady { transfer_id: 602 }
        );
        assert!(
            uploader
                .handle(RemoteFileRequest::UploadStart {
                    transfer_id: 603,
                    path: "/note.txt".into(),
                    size: 7,
                    overwrite: true,
                })
                .await
        );
        assert!(matches!(next_handler_file_response(&mut receiver_b).await,
            RemoteFileResponse::Error { operation_id: 603, detail } if detail.contains("Another upload")));
        assert!(
            editor
                .handle(RemoteFileRequest::UploadChunk {
                    transfer_id: 602,
                    bytes: b"edited".to_vec()
                })
                .await
        );
        assert!(
            editor
                .handle(RemoteFileRequest::UploadFinish { transfer_id: 602 })
                .await
        );
        let saved_revision = match next_handler_file_response(&mut receiver_a).await {
            RemoteFileResponse::TextSaved {
                transfer_id: 602,
                revision,
                backup_path,
            } => {
                assert_eq!(
                    std::fs::read(root.0.join(&backup_path[1..])).unwrap(),
                    b"original"
                );
                revision
            }
            response => panic!("unexpected text save: {response:?}"),
        };
        assert_eq!(std::fs::read(root.0.join("note.txt")).unwrap(), b"edited");
        assert_eq!(
            shared.text_root().read("/note.txt").unwrap().revision,
            saved_revision
        );
        editor.shutdown().await;
        uploader.shutdown().await;
        assert_eq!(permits.available_permits(), FILE_JOB_LIMIT);
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn text_editor_conflicts_and_cancellation_never_truncate_the_target() {
        let root = FileTestRoot::new("text-editor-conflict-cancel");
        let path = root.0.join("note.txt");
        std::fs::write(&path, b"original").unwrap();
        let shared = root.shared();
        let revision = shared.text_root().read("/note.txt").unwrap().revision;
        let permits = Arc::new(Semaphore::new(FILE_JOB_LIMIT));
        let (outgoing, mut receiver) = mpsc::channel(8);
        let mut editor =
            FileRequestHandler::new(Some(Arc::clone(&shared)), outgoing, Arc::clone(&permits));
        assert!(
            editor
                .handle(RemoteFileRequest::SaveTextStart {
                    transfer_id: 701,
                    path: "/note.txt".into(),
                    size: 6,
                    expected_revision: revision,
                })
                .await
        );
        assert_eq!(
            next_handler_file_response(&mut receiver).await,
            RemoteFileResponse::UploadReady { transfer_id: 701 }
        );
        assert!(
            editor
                .handle(RemoteFileRequest::UploadChunk {
                    transfer_id: 701,
                    bytes: b"edited".to_vec()
                })
                .await
        );
        std::fs::write(&path, b"external").unwrap();
        assert!(
            editor
                .handle(RemoteFileRequest::UploadFinish { transfer_id: 701 })
                .await
        );
        assert!(matches!(next_handler_file_response(&mut receiver).await,
            RemoteFileResponse::Error { operation_id: 701, detail } if detail.contains("changed outside")));
        timeout(Duration::from_secs(1), editor.registry.wait_for_idle())
            .await
            .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"external");
        let revision = shared.text_root().read("/note.txt").unwrap().revision;
        assert!(
            editor
                .handle(RemoteFileRequest::SaveTextStart {
                    transfer_id: 702,
                    path: "/note.txt".into(),
                    size: 6,
                    expected_revision: revision,
                })
                .await
        );
        assert_eq!(
            next_handler_file_response(&mut receiver).await,
            RemoteFileResponse::UploadReady { transfer_id: 702 }
        );
        assert!(
            editor
                .handle(RemoteFileRequest::UploadChunk {
                    transfer_id: 702,
                    bytes: b"part".to_vec()
                })
                .await
        );
        assert!(
            editor
                .handle(RemoteFileRequest::Cancel { transfer_id: 702 })
                .await
        );
        assert_eq!(
            next_handler_file_response(&mut receiver).await,
            RemoteFileResponse::Complete { transfer_id: 702 }
        );
        editor.shutdown().await;
        assert_eq!(std::fs::read(&path).unwrap(), b"external");
        assert_eq!(std::fs::read_dir(&root.0).unwrap().count(), 1);
        assert_eq!(permits.available_permits(), FILE_JOB_LIMIT);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_text_requests_fail_closed_without_starting_workers() {
        let root = FileTestRoot::new("windows-text-disabled");
        std::fs::write(root.0.join("note.txt"), b"original").unwrap();
        let permits = Arc::new(Semaphore::new(FILE_JOB_LIMIT));
        let (outgoing, mut receiver) = mpsc::channel(8);
        let mut handler =
            FileRequestHandler::new(Some(root.shared()), outgoing, Arc::clone(&permits));
        for request in [
            RemoteFileRequest::ReadText {
                request_id: 801,
                path: "/note.txt".into(),
            },
            RemoteFileRequest::SaveTextStart {
                transfer_id: 802,
                path: "/note.txt".into(),
                size: 0,
                expected_revision: [0; 32],
            },
        ] {
            assert!(handler.handle(request).await);
            assert!(matches!(next_handler_file_response(&mut receiver).await,
                RemoteFileResponse::Error { detail, .. } if detail.contains("Windows hosts are not yet supported")));
        }
        assert_eq!(permits.available_permits(), FILE_JOB_LIMIT);
        assert_eq!(std::fs::read(root.0.join("note.txt")).unwrap(), b"original");
    }

    #[tokio::test]
    async fn bounded_upload_command_queue_applies_backpressure_without_false_cancellation() {
        let permits = Arc::new(Semaphore::new(FILE_JOB_LIMIT));
        let (outgoing, _responses) = mpsc::channel(2);
        let handler = FileRequestHandler::new(None, outgoing, Arc::clone(&permits));
        let (commands, mut commands_receiver) = mpsc::channel(UPLOAD_COMMAND_QUEUE_CAPACITY);
        let (permit, registration) = try_admit_file_job(
            &permits,
            &handler.registry,
            FileJobKind::Upload { announced_bytes: 8 },
            71,
            Some(commands),
        )
        .expect("upload should be admitted");
        for _ in 0..UPLOAD_COMMAND_QUEUE_CAPACITY {
            registration
                .control
                .upload_commands
                .as_ref()
                .unwrap()
                .try_send(UploadCommand::Chunk(vec![1]))
                .expect("prefill upload command queue");
        }
        {
            let send = handler.send_upload_command(71, UploadCommand::Chunk(vec![1]));
            tokio::pin!(send);
            assert!(timeout(Duration::from_millis(10), &mut send).await.is_err());
            assert!(!registration.control.is_cancelled());

            assert!(commands_receiver.recv().await.is_some());
            assert!(timeout(Duration::from_secs(1), &mut send)
                .await
                .expect("backpressured upload command should resume"));
        }
        assert!(!registration.control.is_cancelled());
        drop((permit, registration, handler));
        assert_eq!(permits.available_permits(), FILE_JOB_LIMIT);
    }

    #[test]
    fn protocol_file_errors_are_sanitized_and_bounded() {
        let detail = format!("unsafe\n{}\u{0}", "x".repeat(MAX_FILE_ERROR_BYTES * 2));
        let RemoteMessage::FileResponse(RemoteFileResponse::Error { detail, .. }) =
            file_error(1, detail)
        else {
            panic!("file_error returned the wrong protocol message");
        };
        assert!(detail.len() <= MAX_FILE_ERROR_BYTES);
        assert!(!detail.chars().any(char::is_control));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn parses_linux_proc_stat_with_spaces_and_closing_parenthesis_in_comm() {
        let mut fields = vec!["0"; 20];
        fields[0] = "R";
        fields[3] = "4242";
        fields[19] = "987654321";
        let stat = format!("4242 (shell worker ) tricky) {}", fields.join(" "));

        assert_eq!(
            parse_linux_process_identity(4242, &stat),
            Some(LinuxProcessIdentity {
                process_id: 4242,
                session_id: 4242,
                start_time: 987654321,
            })
        );
        assert_eq!(parse_linux_process_identity(4242, "truncated"), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn verified_pidfd_keeps_current_process_identity_and_accepts_signal_zero() {
        // SAFETY: getpid has no preconditions or side effects.
        let process_id = unsafe { libc::getpid() };
        let identity = read_linux_process_identity(process_id).expect("read current process stat");
        let descriptor = open_verified_pidfd(identity).expect("open current process pidfd");

        assert_eq!(read_linux_process_identity(process_id), Some(identity));
        assert!(signal_pidfd(&descriptor, 0));
    }

    #[test]
    fn downscales_to_the_stream_boundary() {
        assert_eq!(target_size(1920, 1080), (1280, 720));
        assert_eq!(target_size(1280, 1024), (900, 720));
        assert_eq!(target_size(800, 600), (800, 600));
    }

    #[test]
    fn ready_event_is_machine_readable() {
        let event = AgentEvent::Ready {
            address: "127.0.0.1:44900".to_string(),
            pairing_code: "0123-4567-89AB-CDEF-0123-4567-89AB-CDEF".to_string(),
            expires_in_seconds: 300,
            view_only: true,
            file_transfer: false,
            commands: false,
            file_root: None,
            device_id: Some("123456789".to_string()),
            relay: Some("relay.example.com".to_string()),
            persistent: true,
        };
        let json = serde_json::to_value(event).expect("serialize agent event");
        assert_eq!(json["kind"], "ready");
        assert_eq!(
            json["pairingCode"],
            "0123-4567-89AB-CDEF-0123-4567-89AB-CDEF"
        );
        assert_eq!(json["deviceId"], "123456789");
        assert_eq!(json["persistent"], true);
    }

    #[test]
    fn pairing_code_sources_cannot_override_each_other() {
        let mut code = None;
        set_pairing_code(&mut code, "0123-4567-89AB-CDEF-0123-4567-89AB-CDEF").unwrap();
        assert_eq!(code.as_deref(), Some("0123456789ABCDEF0123456789ABCDEF"));
        assert!(set_pairing_code(&mut code, "87654321FEDCBA0987654321FEDCBA09").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn pairing_code_file_requires_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let path =
            std::env::temp_dir().join(format!("lattice-agent-pair-code-{}", std::process::id()));
        std::fs::write(&path, "0123456789ABCDEF0123456789ABCDEF\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            read_pairing_code_file(&path).unwrap(),
            "0123456789ABCDEF0123456789ABCDEF"
        );

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_pairing_code_file(&path).is_err());
        let _ = std::fs::remove_file(path);
    }
}
