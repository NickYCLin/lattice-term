//! Read-only launch-time qualification for Codex's native Windows input path.
//!
//! This is not a runtime TUI attestation. The owner must permanently invalidate
//! the result on non-query desktop input, process replacement, or a failed
//! revalidation. No failure here is a reason to prevent a manual CLI launch.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant};

const VERSION: &str = "codex-cli 0.153.4";
const MAX_CONFIG_BYTES: u64 = 2 * 1024 * 1024;
const MAX_TOTAL_CONFIG_BYTES: u64 = 16 * 1024 * 1024;
// The supported native Windows 0.153.4 executable is about 282 MiB. Keep a
// separate bounded binary limit; configuration files retain their small cap.
const MAX_BINARY_BYTES: u64 = 512 * 1024 * 1024;
const MAX_SOURCES: usize = 192;
const MAX_LINE: usize = 1024 * 1024;
const MAX_STDOUT: usize = 2 * 1024 * 1024;
const MAX_STDERR: usize = 64 * 1024;
const MAX_FRAMES: usize = 128;
const TIMEOUT: Duration = Duration::from_secs(15);

/// Exact native executable and final launch environment, not an npm/cmd shim.
/// Keep this local: arguments and the environment can contain account secrets.
#[derive(Clone)]
pub(crate) struct ProbeContext {
    pub native_executable: PathBuf,
    pub cwd: PathBuf,
    pub environment: Vec<(OsString, OsString)>,
    pub arguments: Vec<OsString>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum UnavailableReason {
    UnsupportedLaunch,
    UnsupportedVersion,
    UnsupportedSettings,
    UnverifiableSource,
    ConfigurationChanged,
    ProbeFailed,
    TimedOut,
    OutputLimit,
}

impl UnavailableReason {
    #[cfg(test)]
    pub(crate) fn message(self) -> &'static str {
        match self {
            Self::UnsupportedLaunch => "This Codex launch does not support verified MCP input.",
            Self::UnsupportedVersion => "This Codex version does not support verified MCP input.",
            Self::UnsupportedSettings => {
                "Custom Codex keybindings or Vim mode require manual input."
            }
            Self::UnverifiableSource => "The Codex input configuration could not be verified.",
            Self::ConfigurationChanged => {
                "The Codex launch configuration changed; use manual input."
            }
            Self::ProbeFailed => "The Codex input configuration check failed; use manual input.",
            Self::TimedOut => "The Codex input configuration check timed out; use manual input.",
            Self::OutputLimit => "The Codex input configuration check exceeded its output limit.",
        }
    }
}

type Result<T> = std::result::Result<T, UnavailableReason>;

#[derive(Clone, PartialEq, Eq)]
enum Stamp {
    Missing,
    File {
        canonical: PathBuf,
        digest: [u8; 32],
        length: u64,
    },
    Directory {
        canonical: PathBuf,
    },
}

#[derive(Clone)]
pub(crate) struct SupportedProfile {
    context_digest: [u8; 32],
    executable: Stamp,
    sources: BTreeMap<PathBuf, Stamp>,
}

impl SupportedProfile {
    /// No subprocess or refreshed grant. The owner must latch any failure for
    /// this launch, even if a later file edit restores the old contents.
    pub(crate) fn revalidate(&self, context: &ProbeContext) -> Result<()> {
        if context_digest(context)? != self.context_digest
            || stamp(&context.native_executable, MAX_BINARY_BYTES)? != self.executable
        {
            return Err(UnavailableReason::ConfigurationChanged);
        }
        if snapshot(&self.sources.keys().cloned().collect())? != self.sources {
            return Err(UnavailableReason::ConfigurationChanged);
        }
        Ok(())
    }
}

/// Does not send thread/start, turn/start, model listing, MCP, or tool requests.
/// App-server startup can maintain its normal local runtime/cache files; this
/// probe never writes configuration or conversation/queue contents.
pub(crate) fn inspect(context: &ProbeContext) -> Result<SupportedProfile> {
    let arguments = probe_arguments(context)?;
    let executable = stamp(&context.native_executable, MAX_BINARY_BYTES)?;
    if !matches!(executable, Stamp::File { .. })
        || !context.native_executable.is_absolute()
        || context
            .native_executable
            .extension()
            .and_then(|s| s.to_str())
            != Some("exe")
    {
        return Err(UnavailableReason::UnsupportedLaunch);
    }
    let mut source_paths = fallback_sources(context)?;
    let before = snapshot(&source_paths)?;
    let deadline = Instant::now() + TIMEOUT;
    let version = capture_version(context, deadline)?;
    if version.trim() != VERSION {
        return Err(UnavailableReason::UnsupportedVersion);
    }
    let sources = read_configuration(context, &arguments, &mut source_paths, deadline)?;
    if before
        .iter()
        .any(|(path, value)| sources.get(path) != Some(value))
        || stamp(&context.native_executable, MAX_BINARY_BYTES)? != executable
    {
        return Err(UnavailableReason::ConfigurationChanged);
    }
    Ok(SupportedProfile {
        context_digest: context_digest(context)?,
        executable,
        sources,
    })
}

fn context_digest(context: &ProbeContext) -> Result<[u8; 32]> {
    let mut hasher = Sha256::new();
    fn add(hasher: &mut Sha256, value: &std::ffi::OsStr) -> Result<()> {
        let bytes = value
            .to_str()
            .ok_or(UnavailableReason::UnsupportedLaunch)?
            .as_bytes();
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(bytes);
        Ok(())
    }
    add(&mut hasher, context.native_executable.as_os_str())?;
    add(&mut hasher, context.cwd.as_os_str())?;
    hasher.update((context.arguments.len() as u64).to_le_bytes());
    for argument in &context.arguments {
        add(&mut hasher, argument)?;
    }
    let mut environment = context.environment.clone();
    environment.sort();
    hasher.update((environment.len() as u64).to_le_bytes());
    for (key, value) in &environment {
        add(&mut hasher, key)?;
        add(&mut hasher, value)?;
    }
    Ok(hasher.finalize().into())
}

fn environment(context: &ProbeContext, name: &str) -> Result<Option<PathBuf>> {
    let mut values = context.environment.iter().filter(|(key, _)| {
        key.to_str()
            .is_some_and(|key| key.eq_ignore_ascii_case(name))
    });
    let result = values.next().map(|(_, value)| PathBuf::from(value));
    if values.next().is_some() {
        return Err(UnavailableReason::UnsupportedLaunch);
    }
    Ok(result)
}

fn probe_arguments(context: &ProbeContext) -> Result<Vec<OsString>> {
    if !context.cwd.is_absolute() || context.arguments.len() > 128 {
        return Err(UnavailableReason::UnsupportedLaunch);
    }
    #[cfg(windows)]
    qualify_local_path(&context.cwd)?;
    let mut result = Vec::new();
    let mut index = 0;
    let mut saw_command = false;
    let mut positional = false;
    while index < context.arguments.len() {
        let argument = context.arguments[index]
            .to_str()
            .ok_or(UnavailableReason::UnsupportedLaunch)?;
        if argument.len() > 16 * 1024 || argument.contains('\0') {
            return Err(UnavailableReason::UnsupportedLaunch);
        }
        index += 1;
        if positional {
            validate_positional(argument)?;
            continue;
        }
        if argument == "--" {
            positional = true;
            continue;
        }
        let mut next = || -> Result<&str> {
            let value = context
                .arguments
                .get(index)
                .and_then(|s| s.to_str())
                .ok_or(UnavailableReason::UnsupportedLaunch)?;
            index += 1;
            if value.len() > 16 * 1024 || value.contains('\0') {
                return Err(UnavailableReason::UnsupportedLaunch);
            }
            Ok(value)
        };
        match argument {
            "-c" | "--config" => {
                let value = next()?;
                // Named legacy profiles are not the same as the new --profile
                // layer; do not silently inspect a different configuration.
                let key = value.split('=').next().unwrap_or("").trim();
                if key.is_empty() || key == "profile" || !value.contains('=') {
                    return Err(UnavailableReason::UnsupportedLaunch);
                }
                result.extend([OsString::from("-c"), OsString::from(value)]);
            }
            "--enable" | "--disable" => {
                let name = next()?;
                if !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') || name.is_empty()
                {
                    return Err(UnavailableReason::UnsupportedLaunch);
                }
                result.extend([
                    OsString::from("-c"),
                    OsString::from(format!("features.{name}={}", argument == "--enable")),
                ]);
            }
            "--cd" | "-C" => {
                let path = PathBuf::from(next()?);
                let path = if path.is_absolute() {
                    path
                } else {
                    context.cwd.join(path)
                };
                #[cfg(windows)]
                qualify_local_path(&path)?;
                if path.canonicalize().ok() != context.cwd.canonicalize().ok() || !path.exists() {
                    return Err(UnavailableReason::UnsupportedLaunch);
                }
            }
            "-m" | "--model" | "-s" | "--sandbox" | "-a" | "--ask-for-approval" | "--add-dir" => {
                next()?;
            }
            "--full-auto"
            | "--dangerously-bypass-approvals-and-sandbox"
            | "--search"
            | "--no-alt-screen"
            | "--last"
            | "--all"
            | "--include-non-interactive" => {}
            "--strict-config" => result.push(argument.into()),
            "resume" | "fork" if !saw_command => {
                saw_command = true;
            }
            value if value.starts_with('-') => return Err(UnavailableReason::UnsupportedLaunch),
            "exec" | "e" | "review" | "app-server" | "mcp-server" | "mcp" | "login" | "logout"
            | "queue" | "agents" | "app" | "doctor" | "debug" | "update"
                if !saw_command =>
            {
                return Err(UnavailableReason::UnsupportedLaunch);
            }
            _ => {
                validate_positional(argument)?;
                saw_command = true;
            }
        }
    }
    result.extend([OsString::from("app-server"), OsString::from("--stdio")]);
    Ok(result)
}

fn validate_positional(text: &str) -> Result<()> {
    if text.chars().any(char::is_control)
        || text.contains(['@', '$'])
        || text.starts_with('?')
        || text.trim_start().starts_with(['/', '!'])
    {
        return Err(UnavailableReason::UnsupportedLaunch);
    }
    Ok(())
}

fn validate_configuration(response: &Value) -> Result<()> {
    let config = response
        .get("config")
        .and_then(Value::as_object)
        .ok_or(UnavailableReason::ProbeFailed)?;
    if config.get("profile").is_some_and(|value| !value.is_null()) {
        return Err(UnavailableReason::UnsupportedLaunch);
    }
    let Some(tui) = config.get("tui").filter(|value| !value.is_null()) else {
        return Ok(());
    };
    let tui = tui
        .as_object()
        .ok_or(UnavailableReason::UnsupportedSettings)?;
    if tui
        .get("vim_mode_default")
        .is_some_and(|value| value != &Value::Bool(false))
    {
        return Err(UnavailableReason::UnsupportedSettings);
    }
    fn default_bindings(value: &Value) -> bool {
        // config/read serializes the typed keymap: unset actions are null,
        // whereas [] is an explicit unbind and must not be treated as default.
        value.is_null()
            || value
                .as_object()
                .is_some_and(|map| map.values().all(default_bindings))
    }
    if tui
        .get("keymap")
        .is_some_and(|value| !default_bindings(value))
    {
        return Err(UnavailableReason::UnsupportedSettings);
    }
    Ok(())
}

fn fallback_sources(context: &ProbeContext) -> Result<BTreeSet<PathBuf>> {
    let home = match environment(context, "CODEX_HOME")? {
        Some(home) => home,
        None => environment(context, "USERPROFILE")?
            .ok_or(UnavailableReason::UnverifiableSource)?
            .join(".codex"),
    };
    if !home.is_absolute() {
        return Err(UnavailableReason::UnverifiableSource);
    }
    let mut paths = BTreeSet::from([home.join("config.toml"), context.cwd.clone()]);
    // The reported system layer below must match one of these pre-snapshotted
    // sources. ProgramData is only a candidate, not an authority for Codex's
    // Known Folder lookup; a mismatch is unsupported rather than guessed.
    let program_data =
        environment(context, "ProgramData")?.ok_or(UnavailableReason::UnverifiableSource)?;
    if !program_data.is_absolute() {
        return Err(UnavailableReason::UnverifiableSource);
    }
    let system = program_data.join("OpenAI").join("Codex");
    for file in ["config.toml", "managed_config.toml", "requirements.toml"] {
        paths.insert(system.join(file));
    }
    for ancestor in context.cwd.ancestors() {
        paths.insert(ancestor.join(".codex").join("config.toml"));
        paths.insert(ancestor.join(".git"));
        if paths.len() > MAX_SOURCES {
            return Err(UnavailableReason::UnverifiableSource);
        }
    }
    Ok(paths)
}

fn collect_sources(response: &Value, paths: &mut BTreeSet<PathBuf>, binary: &Path) -> Result<()> {
    let layers = response
        .get("layers")
        .and_then(Value::as_array)
        .filter(|layers| layers.len() <= 64)
        .ok_or(UnavailableReason::UnverifiableSource)?;
    let mut system = false;
    let mut user = false;
    for layer in layers {
        let name = layer
            .get("name")
            .ok_or(UnavailableReason::UnverifiableSource)?;
        let kind = name
            .get("type")
            .and_then(Value::as_str)
            .ok_or(UnavailableReason::UnverifiableSource)?;
        let path = match kind {
            "sessionFlags" => continue,
            "project" => PathBuf::from(
                name.get("dotCodexFolder")
                    .and_then(Value::as_str)
                    .ok_or(UnavailableReason::UnverifiableSource)?,
            )
            .join("config.toml"),
            "system" | "user" | "packagedDefaults" | "legacyManagedConfigTomlFromFile" => {
                let path = PathBuf::from(
                    name.get("file")
                        .and_then(Value::as_str)
                        .ok_or(UnavailableReason::UnverifiableSource)?,
                );
                if kind == "system" {
                    if !paths.iter().any(|known| same_path_spelling(known, &path)) {
                        return Err(UnavailableReason::UnverifiableSource);
                    }
                    system = true;
                    let parent = path.parent().ok_or(UnavailableReason::UnverifiableSource)?;
                    paths.insert(parent.join("managed_config.toml"));
                    paths.insert(parent.join("requirements.toml"));
                }
                if kind == "user" {
                    if name.get("profile").is_some_and(|value| !value.is_null()) {
                        return Err(UnavailableReason::UnsupportedLaunch);
                    }
                    user = true;
                }
                if kind == "packagedDefaults" {
                    if path.canonicalize().ok() != binary.canonicalize().ok() {
                        return Err(UnavailableReason::UnverifiableSource);
                    }
                    continue; // Embedded defaults are covered by the executable hash.
                }
                path
            }
            _ => return Err(UnavailableReason::UnverifiableSource),
        };
        if !path.is_absolute() {
            return Err(UnavailableReason::UnverifiableSource);
        }
        paths.insert(path);
    }
    // Pinned config/read deliberately omits the embedded packagedDefaults
    // layer. The exact executable hash covers it; user/system are always
    // reported, including their absent config files.
    if !system || !user || paths.len() > MAX_SOURCES {
        return Err(UnavailableReason::UnverifiableSource);
    }
    Ok(())
}

fn same_path_spelling(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    {
        fn normalize(path: &Path) -> Option<String> {
            let value = path.to_str()?.replace('/', "\\");
            Some(
                value
                    .strip_prefix(r"\\?\")
                    .unwrap_or(&value)
                    .to_ascii_lowercase(),
            )
        }
        match (normalize(left), normalize(right)) {
            (Some(left), Some(right)) => left == right,
            _ => false,
        }
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

fn stamp(path: &Path, max: u64) -> Result<Stamp> {
    #[cfg(windows)]
    qualify_local_path(path)?;
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Stamp::Missing),
        Err(_) => return Err(UnavailableReason::UnverifiableSource),
    };
    let canonical = path
        .canonicalize()
        .map_err(|_| UnavailableReason::UnverifiableSource)?;
    if metadata.is_dir() {
        return Ok(Stamp::Directory { canonical });
    }
    if !metadata.is_file() {
        return Err(UnavailableReason::UnverifiableSource);
    }
    validate_file_length(metadata.len(), max)?;
    let mut file = fs::File::open(path).map_err(|_| UnavailableReason::UnverifiableSource)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| UnavailableReason::UnverifiableSource)?;
        if read == 0 {
            break;
        }
        total += read as u64;
        if total > max {
            return Err(UnavailableReason::UnverifiableSource);
        }
        hasher.update(&buffer[..read]);
    }
    Ok(Stamp::File {
        canonical,
        digest: hasher.finalize().into(),
        length: total,
    })
}

fn validate_file_length(length: u64, max: u64) -> Result<()> {
    if length > max {
        Err(UnavailableReason::UnverifiableSource)
    } else {
        Ok(())
    }
}

fn snapshot(paths: &BTreeSet<PathBuf>) -> Result<BTreeMap<PathBuf, Stamp>> {
    let mut remaining = MAX_TOTAL_CONFIG_BYTES;
    let mut result = BTreeMap::new();
    for path in paths {
        let value = stamp(path, MAX_CONFIG_BYTES.min(remaining))?;
        if let Stamp::File { length, .. } = &value {
            remaining -= length;
        }
        result.insert(path.clone(), value);
    }
    Ok(result)
}

#[cfg(windows)]
fn qualify_local_path(path: &Path) -> Result<()> {
    use std::os::windows::fs::MetadataExt;
    use std::path::{Component, Prefix};
    use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;

    let Some(Component::Prefix(prefix)) = path.components().next() else {
        return Err(UnavailableReason::UnverifiableSource);
    };
    let letter = match prefix.kind() {
        Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => letter,
        _ => return Err(UnavailableReason::UnverifiableSource),
    };
    if !path.is_absolute() || path.components().any(|p| matches!(p, Component::ParentDir)) {
        return Err(UnavailableReason::UnverifiableSource);
    }
    let root = [letter as u16, b':' as u16, b'\\' as u16, 0];
    // Fixed local disks only: reject mapped network drives before filesystem
    // traversal. These checks bound supported sources, not OS I/O wall time.
    if unsafe { GetDriveTypeW(root.as_ptr()) } != 3 {
        return Err(UnavailableReason::UnverifiableSource);
    }
    let ancestors: Vec<_> = path.ancestors().collect();
    for ancestor in ancestors.into_iter().rev() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                // Reparse points, offline files and cloud recall flags may
                // redirect or hydrate outside the supported local read path.
                if metadata.file_attributes() & (0x400 | 0x1000 | 0x40000 | 0x400000) != 0 {
                    return Err(UnavailableReason::UnverifiableSource);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(_) => return Err(UnavailableReason::UnverifiableSource),
        }
    }
    Ok(())
}

enum Output {
    Line(Vec<u8>),
    Eof,
    Failed(UnavailableReason),
}

fn read_stdout(
    stdout: impl Read + Send + 'static,
    sender: Sender<Output>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut total = 0;
        for _ in 0..MAX_FRAMES {
            let mut line = Vec::new();
            let read = Read::by_ref(&mut reader)
                .take((MAX_LINE + 1) as u64)
                .read_until(b'\n', &mut line);
            match read {
                Ok(0) => {
                    let _ = sender.send(Output::Eof);
                    return;
                }
                Ok(size) => {
                    total += size;
                    if size > MAX_LINE || total > MAX_STDOUT {
                        let _ = sender.send(Output::Failed(UnavailableReason::OutputLimit));
                        return;
                    }
                    if sender.send(Output::Line(line)).is_err() {
                        return;
                    }
                }
                Err(_) => {
                    let _ = sender.send(Output::Failed(UnavailableReason::ProbeFailed));
                    return;
                }
            }
        }
        let _ = sender.send(Output::Failed(UnavailableReason::OutputLimit));
    })
}

type ProbeWrite = (Vec<u8>, Sender<Result<()>>);

struct ProbeChild {
    child: Child,
    output: Receiver<Output>,
    readers: Vec<thread::JoinHandle<()>>,
    input: Option<Sender<ProbeWrite>>,
    job: Option<ProcessJob>,
}

impl ProbeChild {
    fn spawn(context: &ProbeContext, arguments: &[OsString]) -> Result<Self> {
        let mut command = Command::new(&context.native_executable);
        command
            .args(arguments)
            .current_dir(&context.cwd)
            .env_clear()
            .envs(context.environment.clone())
            .env("CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
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
        let (sender, output) = mpsc::channel();
        let (Some(stdout), Some(mut stderr), Some(mut stdin)) =
            (child.stdout.take(), child.stderr.take(), child.stdin.take())
        else {
            drop(job);
            let _ = child.kill();
            let _ = child.wait();
            return Err(UnavailableReason::ProbeFailed);
        };
        let (input, writes) = mpsc::channel::<ProbeWrite>();
        let readers = vec![
            read_stdout(stdout, sender.clone()),
            thread::spawn(move || {
                let mut buffer = [0_u8; 4096];
                let mut total = 0;
                loop {
                    match stderr.read(&mut buffer) {
                        Ok(0) => return,
                        Ok(read) => {
                            total += read;
                            if total > MAX_STDERR {
                                let _ = sender.send(Output::Failed(UnavailableReason::OutputLimit));
                                return;
                            }
                        }
                        Err(_) => return,
                    }
                }
            }),
            thread::spawn(move || {
                while let Ok((bytes, done)) = writes.recv() {
                    let result = stdin
                        .write_all(&bytes)
                        .and_then(|()| stdin.flush())
                        .map_err(|_| UnavailableReason::ProbeFailed);
                    let failed = result.is_err();
                    let _ = done.send(result);
                    if failed {
                        return;
                    }
                }
            }),
        ];
        Ok(Self {
            child,
            output,
            readers,
            input: Some(input),
            job: Some(job),
        })
    }

    fn send(&mut self, value: Value, deadline: Instant) -> Result<()> {
        let mut bytes = serde_json::to_vec(&value).map_err(|_| UnavailableReason::ProbeFailed)?;
        bytes.push(b'\n');
        if bytes.len() > 32 * 1024 {
            return Err(UnavailableReason::OutputLimit);
        }
        let (done, result) = mpsc::channel();
        self.input
            .as_ref()
            .ok_or(UnavailableReason::ProbeFailed)?
            .send((bytes, done))
            .map_err(|_| UnavailableReason::ProbeFailed)?;
        result
            .recv_timeout(
                deadline
                    .checked_duration_since(Instant::now())
                    .ok_or(UnavailableReason::TimedOut)?,
            )
            .map_err(|_| UnavailableReason::TimedOut)?
    }

    fn next(&self, deadline: Instant) -> Result<Output> {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or(UnavailableReason::TimedOut)?;
        self.output
            .recv_timeout(remaining)
            .map_err(|error| match error {
                mpsc::RecvTimeoutError::Timeout => UnavailableReason::TimedOut,
                mpsc::RecvTimeoutError::Disconnected => UnavailableReason::ProbeFailed,
            })
    }

    fn reply(&self, id: u64, deadline: Instant) -> Result<Value> {
        loop {
            match self.next(deadline)? {
                Output::Line(line) => {
                    let value: Value = serde_json::from_slice(&line)
                        .map_err(|_| UnavailableReason::ProbeFailed)?;
                    if value.get("id").and_then(Value::as_u64) == Some(id) {
                        return value
                            .get("result")
                            .cloned()
                            .ok_or(UnavailableReason::ProbeFailed);
                    }
                    // Unsolicited requests are never executed or answered.
                }
                Output::Failed(error) => return Err(error),
                Output::Eof => return Err(UnavailableReason::ProbeFailed),
            }
        }
    }
}

impl Drop for ProbeChild {
    fn drop(&mut self) {
        self.input.take();
        self.job.take(); // Close job first: inherited pipes in descendants also close.
        let _ = self.child.kill();
        let _ = self.child.wait();
        for reader in self.readers.drain(..) {
            let _ = reader.join();
        }
    }
}

fn capture_version(context: &ProbeContext, deadline: Instant) -> Result<String> {
    let mut probe = ProbeChild::spawn(context, &[OsString::from("--version")])?;
    let mut output = Vec::new();
    loop {
        match probe.next(deadline)? {
            Output::Line(line) => {
                output.extend(line);
                if output.len() > 256 {
                    return Err(UnavailableReason::UnsupportedVersion);
                }
            }
            Output::Eof => {
                loop {
                    match probe.child.try_wait() {
                        Ok(Some(status)) if status.success() => break,
                        Ok(Some(_)) | Err(_) => return Err(UnavailableReason::ProbeFailed),
                        Ok(None) if Instant::now() >= deadline => {
                            return Err(UnavailableReason::TimedOut);
                        }
                        Ok(None) => thread::sleep(Duration::from_millis(5)),
                    }
                }
                return String::from_utf8(output)
                    .map_err(|_| UnavailableReason::UnsupportedVersion);
            }
            Output::Failed(error) => return Err(error),
        }
    }
}

fn read_configuration(
    context: &ProbeContext,
    arguments: &[OsString],
    paths: &mut BTreeSet<PathBuf>,
    deadline: Instant,
) -> Result<BTreeMap<PathBuf, Stamp>> {
    let mut probe = ProbeChild::spawn(context, arguments)?;
    probe.send(
        json!({"id":1,"method":"initialize","params":{
            "clientInfo":{"name":"latticeterm-input-profile","version":"1"},
            "capabilities":{"experimentalApi":true}
        }}),
        deadline,
    )?;
    probe.reply(1, deadline)?;
    probe.send(json!({"method":"initialized"}), deadline)?;
    probe.send(json!({"id":2,"method":"config/read","params":{
        "includeLayers":true,"cwd":context.cwd.to_str().ok_or(UnavailableReason::UnsupportedLaunch)?
    }}), deadline)?;
    let first = probe.reply(2, deadline)?;
    validate_configuration(&first)?;
    collect_sources(&first, paths, &context.native_executable)?;
    let before = snapshot(paths)?;
    // Discover first, then inspect between two complete source snapshots.
    // This closes the ordinary configuration-edit race for discovered files.
    probe.send(json!({"id":3,"method":"config/read","params":{
        "includeLayers":true,"cwd":context.cwd.to_str().ok_or(UnavailableReason::UnsupportedLaunch)?
    }}), deadline)?;
    let second = probe.reply(3, deadline)?;
    validate_configuration(&second)?;
    let mut after_paths = paths.clone();
    collect_sources(&second, &mut after_paths, &context.native_executable)?;
    let after = snapshot(&after_paths)?;
    if *paths != after_paths || before != after || first.get("layers") != second.get("layers") {
        return Err(UnavailableReason::ConfigurationChanged);
    }
    Ok(after)
}

#[cfg(windows)]
struct ProcessJob {
    _handle: std::os::windows::io::OwnedHandle,
}

#[cfg(windows)]
impl ProcessJob {
    fn attach(child: &Child) -> Result<Self> {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(UnavailableReason::ProbeFailed);
        }
        let owned = unsafe { OwnedHandle::from_raw_handle(handle) };
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            )
        };
        if configured == 0
            || unsafe { AssignProcessToJobObject(handle, child.as_raw_handle()) } == 0
        {
            return Err(UnavailableReason::ProbeFailed);
        }
        Ok(Self { _handle: owned })
    }
}

#[cfg(not(windows))]
struct ProcessJob;
#[cfg(not(windows))]
impl ProcessJob {
    fn attach(_: &Child) -> Result<Self> {
        Err(UnavailableReason::UnsupportedLaunch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context(path: &Path, args: &[&str]) -> ProbeContext {
        ProbeContext {
            native_executable: path.join("codex.exe"),
            cwd: path.to_owned(),
            environment: vec![
                ("CODEX_HOME".into(), path.as_os_str().to_owned()),
                ("ProgramData".into(), path.as_os_str().to_owned()),
            ],
            arguments: args.iter().map(OsString::from).collect(),
        }
    }

    #[test]
    fn codex_input_profile_accepts_defaults_but_not_custom_keys_or_vim() {
        for config in [
            json!({}),
            json!({"tui":null,"profile":null}),
            json!({"tui":{}}),
            json!({"tui":{"keymap":{"global":{}},"vim_mode_default":false}}),
            json!({"tui":{"keymap":{
                "global":{"quit":null},
                "composer":{"submit":null,"queue":null},
                "editor":{"insert_newline":null,"move_line_end":null},
                "history_search":{}
            },"vim_mode_default":false}}),
        ] {
            assert!(validate_configuration(&json!({"config":config})).is_ok());
        }
        for config in [
            json!({"tui":{"vim_mode_default":true}}),
            json!({"tui":{"keymap":{"composer":{"submit":[]}}}}),
            json!({"tui":{"keymap":{"global":{"copy":"end"}}}}),
            json!({"tui":{"keymap":{"editor":{"move_line_end":"end enter"}}}}),
        ] {
            assert_eq!(
                validate_configuration(&json!({"config":config})),
                Err(UnavailableReason::UnsupportedSettings)
            );
        }
    }

    #[test]
    fn codex_input_profile_only_replays_safe_configuration_arguments() {
        let temp = tempfile::tempdir().unwrap();
        let ctx = context(
            temp.path(),
            &[
                "-c",
                "tui.vim_mode_default=false",
                "--model",
                "example",
                "resume",
                "native-id",
                "bootstrap text",
            ],
        );
        assert_eq!(
            probe_arguments(&ctx).unwrap(),
            vec![
                OsString::from("-c"),
                "tui.vim_mode_default=false".into(),
                "app-server".into(),
                "--stdio".into()
            ]
        );
        for args in [
            vec!["--remote", "ws://localhost"],
            vec!["--profile", "work"],
            vec!["--unknown"],
            vec!["-c", "profile=work"],
            vec!["exec", "text"],
            vec!["/vim"],
            vec!["resume", "native-id", "body\nbody"],
            vec!["--", "!command"],
            vec!["body@mention"],
            vec!["?help"],
        ] {
            assert_eq!(
                probe_arguments(&context(temp.path(), &args)),
                Err(UnavailableReason::UnsupportedLaunch)
            );
        }
        for text in ["Check this?", " ?literal"] {
            assert!(probe_arguments(&context(temp.path(), &[text])).is_ok());
        }
    }

    #[test]
    fn codex_input_profile_detects_new_parent_configuration_and_context_change() {
        let temp = tempfile::tempdir().unwrap();
        let ctx = context(temp.path(), &[]);
        let paths = fallback_sources(&ctx).unwrap();
        let owned_config = temp.path().join(".codex/config.toml");
        assert!(paths.contains(&owned_config));
        // Unit fixtures must not read real ancestor/user configuration.
        let paths = BTreeSet::from([owned_config.clone()]);
        let before = snapshot(&paths).unwrap();
        fs::create_dir(temp.path().join(".codex")).unwrap();
        fs::write(owned_config, "[tui.keymap]\n").unwrap();
        assert!(before != snapshot(&paths).unwrap());
        let mut changed = ctx.clone();
        changed
            .environment
            .push(("EXAMPLE".into(), "changed".into()));
        assert_ne!(
            context_digest(&ctx).unwrap(),
            context_digest(&changed).unwrap()
        );
    }

    #[test]
    fn codex_input_profile_rejects_unverifiable_or_missing_layer_sources() {
        let mut paths = BTreeSet::new();
        for response in [
            json!({}),
            json!({"layers":[]}),
            json!({"layers":[{"name":{"type":"enterpriseManaged","id":"example"}}]}),
        ] {
            assert_eq!(
                collect_sources(&response, &mut paths, Path::new("codex.exe")),
                Err(UnavailableReason::UnverifiableSource)
            );
        }
    }

    #[test]
    fn codex_input_profile_accepts_native_typed_defaults_and_tracks_absent_sources() {
        // Structure observed from the pinned native config/read, sanitized to
        // owned paths: typed null actions and only user/system source layers.
        let temp = tempfile::tempdir().unwrap();
        let ctx = context(temp.path(), &[]);
        fs::write(&ctx.native_executable, b"owned-binary-fixture").unwrap();
        let user = temp.path().join("config.toml");
        let system = temp.path().join("OpenAI/Codex/config.toml");
        let mut paths = BTreeSet::from([user.clone(), system.clone()]);
        let response = json!({
            "config": {"profile":null,"disable_paste_burst":null,"tui":{
                "vim_mode_default":false,"disable_paste_burst":null,
                "keymap":{
                    "agents":{"new_task":null},"approval":{"approve":null},
                    "chat":{"interrupt_turn":null},
                    "composer":{"submit":null,"queue":null},
                    "editor":{"insert_newline":null,"move_line_end":null},
                    "global":{"submit":null,"toggle_vim_mode":null},
                    "list":{"accept":null},"pager":{"close":null},
                    "vim_normal":{"append_line_end":null},
                    "vim_operator":{"motion_line_end":null},
                    "vim_search":{"forward":null},"vim_text_object":{"word":null}
                }
            }},
            "origins":{},"layers":[
                {"config":{},"name":{"type":"user","file":user,"profile":null},"version":"owned-v1"},
                {"config":{},"name":{"type":"system","file":system},"version":"owned-v1"}
            ]
        });
        validate_configuration(&response).unwrap();
        collect_sources(&response, &mut paths, &ctx.native_executable).unwrap();
        let profile = SupportedProfile {
            context_digest: context_digest(&ctx).unwrap(),
            executable: stamp(&ctx.native_executable, MAX_BINARY_BYTES).unwrap(),
            sources: snapshot(&paths).unwrap(),
        };
        profile.revalidate(&ctx).unwrap();
        let mut changed = ctx.clone();
        changed.arguments.push("different prompt".into());
        assert_eq!(
            profile.revalidate(&changed),
            Err(UnavailableReason::ConfigurationChanged)
        );
        fs::create_dir_all(system.parent().unwrap()).unwrap();
        fs::write(&system, "[tui]\nvim_mode_default=true\n").unwrap();
        assert_eq!(
            profile.revalidate(&ctx),
            Err(UnavailableReason::ConfigurationChanged)
        );
    }

    #[cfg(windows)]
    #[test]
    fn codex_input_profile_timeout_reaps_owned_child_tree_and_pipe_readers() {
        use std::os::windows::io::{AsHandle, AsRawHandle};
        use windows_sys::Win32::System::Threading::WaitForSingleObject;

        let temp = tempfile::tempdir().unwrap();
        let mut ctx = context(temp.path(), &[]);
        let system_root = std::env::var_os("SystemRoot").expect("Windows SystemRoot");
        ctx.native_executable =
            PathBuf::from(&system_root).join("System32/WindowsPowerShell/v1.0/powershell.exe");
        ctx.environment = std::env::vars_os().collect();
        // Both levels are owned metadata-only fixtures; no profiles, CLI
        // accounts, models, network, global process scans, or persistent writes.
        let arguments: Vec<OsString> = [
            "-NoProfile", "-NonInteractive", "-Command",
            r#"& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "Write-Output 'owned-ready'; Start-Sleep -Seconds 30""#,
        ].into_iter().map(OsString::from).collect();
        let probe = ProbeChild::spawn(&ctx, &arguments).unwrap();
        let process = probe.child.as_handle().try_clone_to_owned().unwrap();
        assert!(
            matches!(probe.next(Instant::now() + Duration::from_secs(10)).unwrap(), Output::Line(line) if line == b"owned-ready\r\n")
        );
        assert!(matches!(
            probe.next(Instant::now() + Duration::from_millis(20)),
            Err(UnavailableReason::TimedOut)
        ));
        let started = Instant::now();
        drop(probe);
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(
            unsafe { WaitForSingleObject(process.as_raw_handle(), 0) },
            0
        );
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "opt-in exact native Codex metadata only; no model or thread requests"]
    fn codex_input_profile_native_metadata_only_acceptance() {
        let native = std::env::var_os("LATTICETERM_TEST_CODEX_NATIVE")
            .expect("set LATTICETERM_TEST_CODEX_NATIVE to the exact native executable");
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let selected_home = std::env::var_os("LATTICETERM_TEST_CODEX_PROFILE_HOME");
        let owned_home = temp.path().join("codex-home");
        fs::create_dir(&owned_home).unwrap();
        let home = selected_home
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or(owned_home);
        let mut environment: Vec<_> = std::env::vars_os()
            .filter(|(key, _)| !key.to_string_lossy().eq_ignore_ascii_case("CODEX_HOME"))
            .collect();
        environment.push(("CODEX_HOME".into(), home.as_os_str().to_owned()));
        let ctx = ProbeContext {
            native_executable: native.into(),
            cwd: workspace,
            environment,
            arguments: Vec::new(),
        };
        let profile = inspect(&ctx).unwrap_or_else(|reason| panic!("{}", reason.message()));
        profile.revalidate(&ctx).unwrap();
        if selected_home.is_none() {
            // Only mutate this test's new empty home; an explicitly selected
            // real account is read-only and never rewritten by acceptance.
            fs::write(home.join("config.toml"), "[tui]\nvim_mode_default=true\n").unwrap();
            assert_eq!(
                profile.revalidate(&ctx),
                Err(UnavailableReason::ConfigurationChanged)
            );
        }
    }

    #[test]
    fn codex_input_profile_output_is_bounded_without_revealing_content() {
        let (sender, receiver) = mpsc::channel();
        let reader = read_stdout(std::io::Cursor::new(vec![b'x'; MAX_LINE + 2]), sender);
        assert!(matches!(
            receiver.recv().unwrap(),
            Output::Failed(UnavailableReason::OutputLimit)
        ));
        reader.join().unwrap();
        assert!(!UnavailableReason::ProbeFailed.message().contains("stderr"));
    }

    #[test]
    fn codex_input_profile_accepts_supported_native_binary_size_without_relaxing_config_limit() {
        // Metadata measured from the pinned native Windows executable, not a
        // fabricated small shell stub; avoid writing a huge fixture to disk.
        let supported_native_length = 295_408_944;
        assert!(validate_file_length(supported_native_length, MAX_BINARY_BYTES).is_ok());
        assert_eq!(
            validate_file_length(supported_native_length, MAX_CONFIG_BYTES),
            Err(UnavailableReason::UnverifiableSource)
        );
        assert_eq!(
            validate_file_length(MAX_BINARY_BYTES + 1, MAX_BINARY_BYTES),
            Err(UnavailableReason::UnverifiableSource)
        );
    }

    #[cfg(windows)]
    #[test]
    fn codex_input_profile_rejects_network_and_device_paths_before_file_io() {
        for path in [
            r"\\invalid.example\share\config.toml",
            r"\\?\UNC\invalid.example\share\config.toml",
            r"\\.\pipe\owned-fixture",
        ] {
            assert_eq!(
                qualify_local_path(Path::new(path)),
                Err(UnavailableReason::UnverifiableSource)
            );
        }
        assert!(same_path_spelling(
            Path::new(r"\\?\C:\fixture\config.toml"),
            Path::new(r"c:\fixture\config.toml")
        ));
    }
}
