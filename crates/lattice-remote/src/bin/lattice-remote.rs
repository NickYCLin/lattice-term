//! Scriptable and interactive viewer for Lattice Remote.
//!
//! The CLI intentionally has no `--pair-code` argument or arbitrary `exec`
//! subcommand. Secrets come from a hidden prompt or an owner-only file, while
//! shell access remains an explicit interactive TTY action authorised by the
//! Agent's `--terminal --allow-input` flags.

use clap::{Parser, Subcommand};
use crossterm::terminal::{disable_raw_mode, enable_raw_mode};
use lattice_remote::credentials::read_viewer_pairing_code_file;
use lattice_remote::device_pins::{verify_or_pin, PinOutcome, PINS_FILE};
use lattice_remote::relay::{dial, normalize_device_id, normalize_relay_endpoint};
use lattice_remote::{
    negotiate_protocol_version, normalize_viewer_pairing_code, RemoteFileEntry, RemoteFileKind,
    RemoteFileRequest, RemoteFileResponse, RemoteHello, RemoteMessage, SecureConnection, Transport,
    DEFAULT_PORT, FILE_CHUNK_SIZE, MAX_DIRECTORY_ENTRIES, MAX_REMOTE_PATH_BYTES,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::fs::{File, Metadata, OpenOptions};
use std::io::{IsTerminal, Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::time::{interval, timeout};
use zeroize::Zeroize;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const PAIRING_TIMEOUT: Duration = Duration::from_secs(12);
const RESPONSE_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_TRANSFER_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const TERMINAL_ESCAPE: u8 = 0x1d; // Ctrl+]

#[derive(Parser)]
#[command(
    name = "lattice-remote",
    about = "透過 Lattice Agent Remote 安全傳輸檔案或開啟互動終端",
    after_help = "配對碼不接受命令列參數，避免出現在程序清單與 shell 歷程。\n\
                  未指定 --pair-code-file 時會以隱藏方式詢問。"
)]
struct Cli {
    /// Direct Agent target. HOST alone uses port 44900; IPv6 needs [ADDRESS]:PORT.
    #[arg(long, value_name = "HOST[:PORT]", conflicts_with_all = ["relay", "device"], global = true)]
    direct: Option<String>,

    /// Relay URL or private relay HOST:PORT.
    #[arg(
        long,
        value_name = "WSS_URL",
        requires = "device",
        conflicts_with = "direct",
        global = true
    )]
    relay: Option<String>,

    /// Permanent nine-digit Agent device ID.
    #[arg(
        long,
        value_name = "DEVICE_ID",
        requires = "relay",
        conflicts_with = "direct",
        global = true
    )]
    device: Option<String>,

    /// Owner-only regular file containing the generated 32-character hexadecimal pairing token.
    #[arg(long, value_name = "FILE", global = true)]
    pair_code_file: Option<PathBuf>,

    /// Override the shared GUI/CLI relay device pin store.
    #[arg(long, value_name = "FILE", requires = "relay", global = true)]
    pins_file: Option<PathBuf>,

    /// Emit one machine-readable JSON result for non-interactive commands.
    #[arg(long, global = true)]
    json: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// List one directory inside the Agent's explicitly shared file root.
    List {
        #[arg(default_value = "/")]
        remote_path: String,
    },
    /// Atomically upload one regular file into the shared file root.
    Upload {
        local_file: PathBuf,
        remote_path: String,
        /// Explicitly allow replacement of an existing regular remote file.
        #[arg(long)]
        overwrite: bool,
    },
    /// Atomically download one remote file to a local path.
    Download {
        remote_path: String,
        local_file: PathBuf,
        /// Explicitly allow replacement when the local file stays unchanged.
        #[arg(long)]
        overwrite: bool,
    },
    /// Attach to an interactive terminal shared with --terminal --allow-input.
    Terminal,
}

struct PairingCode(String);

impl Drop for PairingCode {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

struct Connected {
    connection: SecureConnection<Transport>,
    hello: RemoteHello,
    first_pin: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum LocalTargetState {
    Missing,
    File {
        length: u64,
        modified: Option<SystemTime>,
        sha256: [u8; 32],
    },
}

struct RawModeGuard;

impl Drop for RawModeGuard {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
    }
}

#[tokio::main]
async fn main() {
    if let Err(error) = run(Cli::parse()).await {
        eprintln!("錯誤：{error}");
        std::process::exit(1);
    }
}

async fn run(cli: Cli) -> Result<(), String> {
    if cli.direct.is_none() && cli.relay.is_none() {
        return Err("請指定 --direct HOST[:PORT]，或同時指定 --relay 與 --device。".into());
    }
    if matches!(&cli.command, Command::Terminal) && cli.json {
        return Err("互動終端不能搭配 --json。".into());
    }

    let mut connected = connect(&cli).await?;
    if connected.first_pin {
        eprintln!("已在首次成功配對後釘選這台裝置的身分金鑰。");
    }

    if matches!(&cli.command, Command::Terminal) {
        return terminal(connected).await;
    }

    let result = match &cli.command {
        Command::List { remote_path } => {
            list(
                &mut connected.connection,
                &connected.hello,
                remote_path,
                cli.json,
            )
            .await
        }
        Command::Upload {
            local_file,
            remote_path,
            overwrite,
        } => {
            upload(
                &mut connected.connection,
                &connected.hello,
                local_file,
                remote_path,
                *overwrite,
                cli.json,
            )
            .await
        }
        Command::Download {
            remote_path,
            local_file,
            overwrite,
        } => {
            download(
                &mut connected.connection,
                &connected.hello,
                remote_path,
                local_file,
                *overwrite,
                cli.json,
            )
            .await
        }
        Command::Terminal => unreachable!("terminal was handled above"),
    };
    let _ = timeout(
        Duration::from_secs(1),
        connected
            .connection
            .send(&RemoteMessage::Close("CLI operation complete.".into())),
    )
    .await;
    result
}

fn read_pairing_code(path: Option<&Path>) -> Result<PairingCode, String> {
    let mut input = match path {
        Some(path) => read_viewer_pairing_code_file(path)?,
        None => {
            if !std::io::stdin().is_terminal() {
                return Err("標準輸入不是互動終端；自動化時請使用 --pair-code-file。".to_string());
            }
            rpassword::prompt_password("Lattice Remote 配對碼：")
                .map_err(|error| format!("無法安全讀取配對碼：{error}"))?
        }
    };
    let normalized = normalize_viewer_pairing_code(&input).map_err(|error| error.to_string());
    input.zeroize();
    normalized.map(PairingCode)
}

fn parse_direct_target(input: &str) -> Result<(String, u16), String> {
    let input = input.trim();
    if input.is_empty()
        || input.len() > 512
        || input.chars().any(char::is_control)
        || input.chars().any(char::is_whitespace)
        || input.contains('/')
        || input.contains('\\')
    {
        return Err("--direct 必須是有效的 HOST[:PORT]。".to_string());
    }

    let (host, port) = if let Some(rest) = input.strip_prefix('[') {
        let (host, suffix) = rest
            .split_once(']')
            .ok_or_else(|| "IPv6 位址必須使用 [ADDRESS]:PORT。".to_string())?;
        let port = match suffix {
            "" => DEFAULT_PORT,
            value if value.starts_with(':') => value[1..]
                .parse::<u16>()
                .map_err(|_| "--direct 的連接埠無效。".to_string())?,
            _ => return Err("IPv6 位址必須使用 [ADDRESS]:PORT。".to_string()),
        };
        (host.to_string(), port)
    } else if input.matches(':').count() == 1 {
        let (host, port) = input
            .rsplit_once(':')
            .ok_or_else(|| "--direct 必須是有效的 HOST[:PORT]。".to_string())?;
        let port = port
            .parse::<u16>()
            .map_err(|_| "--direct 的連接埠無效。".to_string())?;
        (host.to_string(), port)
    } else if input.contains(':') {
        return Err("IPv6 位址必須使用 [ADDRESS]:PORT。".to_string());
    } else {
        (input.to_string(), DEFAULT_PORT)
    };
    if host.is_empty() || port == 0 {
        return Err("--direct 必須包含有效主機與非零連接埠。".to_string());
    }
    Ok((host, port))
}

fn default_pins_path() -> Result<PathBuf, String> {
    dirs::data_dir()
        .map(|base| base.join("io.github.nickyclin.latticeterm").join(PINS_FILE))
        .ok_or_else(|| "無法定位 LatticeTerm 的使用者資料目錄。".to_string())
}

async fn connect(cli: &Cli) -> Result<Connected, String> {
    let pairing_code = read_pairing_code(cli.pair_code_file.as_deref())?;
    let mut relay_pin = None;
    let mut connection = if let Some(endpoint) = cli.relay.as_deref() {
        let endpoint = normalize_relay_endpoint(endpoint).map_err(|error| error.to_string())?;
        let device_id = normalize_device_id(
            cli.device
                .as_deref()
                .ok_or_else(|| "--relay 需要 --device。".to_string())?,
        )
        .map_err(|error| error.to_string())?;
        let pins_path = cli
            .pins_file
            .clone()
            .map(Ok)
            .unwrap_or_else(default_pins_path)?;
        let expected_pin = lattice_remote::device_pins::pinned_fingerprint(&pins_path, &device_id)?;
        if pairing_code.0.len() == 8 && expected_pin.is_none() {
            return Err(lattice_remote::RemoteError::LegacyRequiresTrustedDevice.to_string());
        }
        let (stream, _) = timeout(CONNECT_TIMEOUT, dial(&endpoint, &device_id))
            .await
            .map_err(|_| "中繼伺服器在 15 秒內沒有回應。".to_string())?
            .map_err(|error| error.to_string())?;
        let connection = timeout(
            PAIRING_TIMEOUT,
            SecureConnection::initiate_for_device(stream, &pairing_code.0, expected_pin.as_deref()),
        )
        .await
        .map_err(|_| "Agent 在 12 秒內沒有完成安全配對。".to_string())?
        .map_err(|error| error.to_string())?;
        let key = connection
            .remote_static_key()
            .ok_or_else(|| "Agent 沒有提供可釘選的永久身分金鑰。".to_string())?;
        relay_pin = Some((device_id, key, pins_path));
        connection
    } else {
        let (host, port) = parse_direct_target(
            cli.direct
                .as_deref()
                .ok_or_else(|| "請指定連線目標。".to_string())?,
        )?;
        timeout(
            PAIRING_TIMEOUT,
            SecureConnection::connect(&host, port, &pairing_code.0),
        )
        .await
        .map_err(|_| "Agent 在 12 秒內沒有完成安全配對。".to_string())?
        .map_err(|error| error.to_string())?
    };

    let hello = match timeout(RESPONSE_IDLE_TIMEOUT, connection.receive()).await {
        Ok(Ok(RemoteMessage::Hello(hello))) => hello,
        Ok(Ok(_)) => return Err("Agent 沒有先送出身分與能力資訊。".to_string()),
        Ok(Err(_)) => return Err("配對碼被 Agent 拒絕。".to_string()),
        Err(_) => return Err("Agent 在 30 秒內沒有送出能力資訊。".to_string()),
    };
    negotiate_protocol_version(hello.protocol_version).map_err(|error| error.to_string())?;

    let first_pin = if let Some((device_id, key, path)) = relay_pin {
        verify_or_pin(&path, &device_id, &key)? == PinOutcome::FirstUse
    } else {
        false
    };
    Ok(Connected {
        connection,
        hello,
        first_pin,
    })
}

fn validate_remote_path(path: &str, allow_root: bool) -> Result<(), String> {
    if path.is_empty()
        || path.len() > MAX_REMOTE_PATH_BYTES
        || !path.starts_with('/')
        || path.contains('\\')
        || path.chars().any(char::is_control)
        || (!allow_root && path == "/")
        || path
            .split('/')
            .skip(1)
            .any(|part| part == "." || part == ".." || (part.is_empty() && path != "/"))
    {
        return Err("遠端路徑必須是分享根目錄內的正規絕對虛擬路徑。".to_string());
    }
    Ok(())
}

fn require_file_transfer(hello: &RemoteHello) -> Result<(), String> {
    if hello.file_transfer {
        Ok(())
    } else {
        Err("Agent 沒有以 --file-root 明確開放檔案傳輸。".to_string())
    }
}

async fn send(
    connection: &mut SecureConnection<Transport>,
    message: &RemoteMessage,
) -> Result<(), String> {
    timeout(RESPONSE_IDLE_TIMEOUT, connection.send(message))
        .await
        .map_err(|_| "傳送資料逾時。".to_string())?
        .map_err(|error| error.to_string())
}

async fn next_file_response(
    connection: &mut SecureConnection<Transport>,
) -> Result<RemoteFileResponse, String> {
    timeout(RESPONSE_IDLE_TIMEOUT, async {
        let mut skipped = 0usize;
        loop {
            let message = connection
                .receive()
                .await
                .map_err(|error| error.to_string())?;
            match message {
                RemoteMessage::FileResponse(response) => return Ok(response),
                RemoteMessage::FrameStart(_)
                | RemoteMessage::FrameChunk { .. }
                | RemoteMessage::TerminalData { .. }
                | RemoteMessage::KeepAlive => {
                    skipped += 1;
                    if skipped > 4096 {
                        return Err("Agent 持續傳送與檔案操作無關的資料；已中止等待。".to_string());
                    }
                }
                RemoteMessage::Close(reason) => {
                    return Err(format!("Agent 已結束工作階段：{reason}"));
                }
                _ => return Err("Agent 在檔案操作期間送出非預期訊息。".to_string()),
            }
        }
    })
    .await
    .map_err(|_| "等待 Agent 檔案回應逾時。".to_string())?
}

fn file_error(
    response: RemoteFileResponse,
    operation_id: u64,
) -> Result<RemoteFileResponse, String> {
    match response {
        RemoteFileResponse::Error {
            operation_id: actual,
            detail,
        } if actual == operation_id => Err(format!("Agent 拒絕檔案操作：{detail}")),
        other => Ok(other),
    }
}

async fn list(
    connection: &mut SecureConnection<Transport>,
    hello: &RemoteHello,
    remote_path: &str,
    json_output: bool,
) -> Result<(), String> {
    require_file_transfer(hello)?;
    validate_remote_path(remote_path, true)?;
    const REQUEST_ID: u64 = 1;
    send(
        connection,
        &RemoteMessage::FileRequest(RemoteFileRequest::List {
            request_id: REQUEST_ID,
            path: remote_path.to_string(),
        }),
    )
    .await?;

    match file_error(next_file_response(connection).await?, REQUEST_ID)? {
        RemoteFileResponse::ListStart { request_id, .. } if request_id == REQUEST_ID => {}
        _ => return Err("Agent 沒有正確開始目錄清單。".to_string()),
    }
    let mut entries = Vec::new();
    loop {
        match file_error(next_file_response(connection).await?, REQUEST_ID)? {
            RemoteFileResponse::ListEntry { request_id, entry } if request_id == REQUEST_ID => {
                if entries.len() >= MAX_DIRECTORY_ENTRIES {
                    return Err("Agent 回傳的目錄項目超過安全上限。".to_string());
                }
                entries.push(entry);
            }
            RemoteFileResponse::ListDone { request_id } if request_id == REQUEST_ID => break,
            _ => return Err("Agent 回傳了不一致的目錄清單。".to_string()),
        }
    }

    if json_output {
        let values = entries.iter().map(entry_json).collect::<Vec<_>>();
        println!(
            "{}",
            serde_json::to_string(&json!({
                "ok": true,
                "operation": "list",
                "path": remote_path,
                "fileRoot": hello.file_root_label,
                "entries": values,
            }))
            .map_err(|error| error.to_string())?
        );
    } else {
        println!("分享根目錄：{}", hello.file_root_label);
        for entry in entries {
            println!("{}\t{}\t{}", kind_label(entry.kind), entry.size, entry.path);
        }
    }
    Ok(())
}

fn kind_label(kind: RemoteFileKind) -> &'static str {
    match kind {
        RemoteFileKind::Directory => "dir",
        RemoteFileKind::File => "file",
        RemoteFileKind::Symlink => "symlink",
        RemoteFileKind::Other => "other",
    }
}

fn entry_json(entry: &RemoteFileEntry) -> serde_json::Value {
    json!({
        "name": entry.name,
        "path": entry.path,
        "kind": kind_label(entry.kind),
        "size": entry.size,
        "modifiedAt": entry.modified_at,
    })
}

fn open_regular_file_no_follow(path: &Path, label: &str) -> Result<File, String> {
    let path_metadata =
        std::fs::symlink_metadata(path).map_err(|error| format!("無法檢查{label}：{error}"))?;
    if path_metadata.file_type().is_symlink() || !path_metadata.is_file() {
        return Err(format!("{label}必須是一般檔案，不能是目錄或連結。"));
    }

    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options
        .open(path)
        .map_err(|error| format!("無法安全開啟{label}：{error}"))?;
    let opened_metadata = file
        .metadata()
        .map_err(|error| format!("無法檢查已開啟的{label}：{error}"))?;
    if opened_metadata.file_type().is_symlink() || !opened_metadata.is_file() {
        return Err(format!("{label}必須是一般檔案，不能是目錄或連結。"));
    }
    Ok(file)
}

fn open_upload_source(path: &Path) -> Result<(File, u64), String> {
    let file = open_regular_file_no_follow(path, "上傳來源")?;
    let size = file
        .metadata()
        .map_err(|error| format!("無法檢查已開啟的來源檔案：{error}"))?
        .len();
    if size > MAX_TRANSFER_BYTES {
        return Err("單一檔案不可超過 4 GiB。".to_string());
    }
    Ok((file, size))
}

async fn upload(
    connection: &mut SecureConnection<Transport>,
    hello: &RemoteHello,
    local_file: &Path,
    remote_path: &str,
    overwrite: bool,
    json_output: bool,
) -> Result<(), String> {
    require_file_transfer(hello)?;
    validate_remote_path(remote_path, false)?;
    let (mut file, size) = open_upload_source(local_file)?;
    const TRANSFER_ID: u64 = 1;
    send(
        connection,
        &RemoteMessage::FileRequest(RemoteFileRequest::UploadStart {
            transfer_id: TRANSFER_ID,
            path: remote_path.to_string(),
            size,
            overwrite,
        }),
    )
    .await?;
    match file_error(next_file_response(connection).await?, TRANSFER_ID)? {
        RemoteFileResponse::UploadReady { transfer_id } if transfer_id == TRANSFER_ID => {}
        _ => return Err("Agent 沒有正確準備上傳。".to_string()),
    }

    let mut buffer = vec![0u8; FILE_CHUNK_SIZE];
    let mut digest = Sha256::new();
    let mut sent = 0u64;
    let transfer_result = async {
        loop {
            let read = file
                .read(&mut buffer)
                .map_err(|error| format!("讀取本機來源檔案失敗：{error}"))?;
            if read == 0 {
                break;
            }
            sent = sent
                .checked_add(read as u64)
                .ok_or_else(|| "上傳位元組計數溢位。".to_string())?;
            if sent > size {
                return Err("來源檔案在上傳期間變大；已取消。".to_string());
            }
            digest.update(&buffer[..read]);
            send(
                connection,
                &RemoteMessage::FileRequest(RemoteFileRequest::UploadChunk {
                    transfer_id: TRANSFER_ID,
                    bytes: buffer[..read].to_vec(),
                }),
            )
            .await?;
        }
        if sent != size {
            return Err("來源檔案在上傳期間縮小；已取消。".to_string());
        }
        send(
            connection,
            &RemoteMessage::FileRequest(RemoteFileRequest::UploadFinish {
                transfer_id: TRANSFER_ID,
            }),
        )
        .await?;
        match file_error(next_file_response(connection).await?, TRANSFER_ID)? {
            RemoteFileResponse::Complete { transfer_id } if transfer_id == TRANSFER_ID => Ok(()),
            _ => Err("Agent 沒有確認上傳完成。".to_string()),
        }
    }
    .await;
    if transfer_result.is_err() {
        let _ = send(
            connection,
            &RemoteMessage::FileRequest(RemoteFileRequest::Cancel {
                transfer_id: TRANSFER_ID,
            }),
        )
        .await;
    }
    transfer_result?;

    let sha256 = hex_digest(digest.finalize());
    if json_output {
        println!(
            "{}",
            serde_json::to_string(&json!({
                "ok": true,
                "operation": "upload",
                "localPath": local_file,
                "remotePath": remote_path,
                "bytes": size,
                "sha256": sha256,
            }))
            .map_err(|error| error.to_string())?
        );
    } else {
        println!("上傳完成：{remote_path}（{size} bytes，SHA-256 {sha256}）");
    }
    Ok(())
}

fn inspect_local_target(path: &Path) -> Result<LocalTargetState, String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err("下載目的地不能是目錄或連結。".to_string())
        }
        Ok(_) => {
            let mut file = open_regular_file_no_follow(path, "下載目的地")?;
            let before = file
                .metadata()
                .map_err(|error| format!("無法檢查已開啟的下載目的地：{error}"))?;
            if before.len() > MAX_TRANSFER_BYTES {
                return Err("既有下載目的檔不可超過 4 GiB。".to_string());
            }
            let mut digest = Sha256::new();
            let mut buffer = [0u8; 64 * 1024];
            loop {
                let read = file
                    .read(&mut buffer)
                    .map_err(|error| format!("無法驗證既有下載目的檔：{error}"))?;
                if read == 0 {
                    break;
                }
                digest.update(&buffer[..read]);
            }
            let after = file
                .metadata()
                .map_err(|error| format!("無法重新檢查下載目的地：{error}"))?;
            if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
                return Err("檢查期間下載目的檔被其他程序修改；已停止操作。".to_string());
            }
            Ok(local_target_state(&after, digest.finalize().into()))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(LocalTargetState::Missing),
        Err(error) => Err(format!("無法檢查下載目的地：{error}")),
    }
}

fn local_target_state(metadata: &Metadata, sha256: [u8; 32]) -> LocalTargetState {
    LocalTargetState::File {
        length: metadata.len(),
        modified: metadata.modified().ok(),
        sha256,
    }
}

fn download_parent(path: &Path) -> &Path {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

async fn download(
    connection: &mut SecureConnection<Transport>,
    hello: &RemoteHello,
    remote_path: &str,
    local_file: &Path,
    overwrite: bool,
    json_output: bool,
) -> Result<(), String> {
    require_file_transfer(hello)?;
    validate_remote_path(remote_path, false)?;
    let initial_target = inspect_local_target(local_file)?;
    if initial_target != LocalTargetState::Missing && !overwrite {
        return Err("本機檔案已存在；確認後加上 --overwrite。".to_string());
    }
    let parent = download_parent(local_file);
    if !parent.is_dir() {
        return Err("下載目的資料夾不存在。".to_string());
    }

    const TRANSFER_ID: u64 = 1;
    send(
        connection,
        &RemoteMessage::FileRequest(RemoteFileRequest::Download {
            transfer_id: TRANSFER_ID,
            path: remote_path.to_string(),
        }),
    )
    .await?;
    let expected = match file_error(next_file_response(connection).await?, TRANSFER_ID)? {
        RemoteFileResponse::DownloadStart {
            transfer_id, size, ..
        } if transfer_id == TRANSFER_ID => size,
        _ => return Err("Agent 沒有正確開始下載。".to_string()),
    };
    if expected > MAX_TRANSFER_BYTES {
        let _ = send(
            connection,
            &RemoteMessage::FileRequest(RemoteFileRequest::Cancel {
                transfer_id: TRANSFER_ID,
            }),
        )
        .await;
        return Err("單一檔案不可超過 4 GiB。".to_string());
    }

    let mut staged = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("無法建立私人下載暫存檔：{error}"))?;
    let mut received = 0u64;
    let mut digest = Sha256::new();
    let transfer_result = async {
        loop {
            match file_error(next_file_response(connection).await?, TRANSFER_ID)? {
                RemoteFileResponse::DownloadChunk { transfer_id, bytes }
                    if transfer_id == TRANSFER_ID =>
                {
                    if bytes.is_empty() || bytes.len() > FILE_CHUNK_SIZE {
                        return Err("Agent 回傳了無效的下載區塊。".to_string());
                    }
                    received = received
                        .checked_add(bytes.len() as u64)
                        .ok_or_else(|| "下載位元組計數溢位。".to_string())?;
                    if received > expected {
                        return Err("Agent 回傳的資料超過宣告大小。".to_string());
                    }
                    staged
                        .as_file_mut()
                        .write_all(&bytes)
                        .map_err(|error| format!("無法寫入下載暫存檔：{error}"))?;
                    digest.update(&bytes);
                }
                RemoteFileResponse::Complete { transfer_id } if transfer_id == TRANSFER_ID => {
                    break;
                }
                _ => return Err("Agent 回傳了不一致的下載資料。".to_string()),
            }
        }
        if received != expected {
            return Err(format!(
                "下載大小不符：收到 {received} bytes，預期 {expected} bytes。"
            ));
        }
        staged
            .as_file_mut()
            .flush()
            .and_then(|()| staged.as_file().sync_all())
            .map_err(|error| format!("無法安全完成下載暫存檔：{error}"))
    }
    .await;
    if transfer_result.is_err() {
        let _ = send(
            connection,
            &RemoteMessage::FileRequest(RemoteFileRequest::Cancel {
                transfer_id: TRANSFER_ID,
            }),
        )
        .await;
    }
    transfer_result?;

    let current_target = inspect_local_target(local_file)?;
    if current_target != initial_target {
        return Err("下載期間目的檔案被其他程序修改；未覆蓋該檔案。".to_string());
    }
    if overwrite {
        staged
            .persist(local_file)
            .map_err(|error| format!("無法原子替換本機檔案：{}", error.error))?;
    } else {
        staged
            .persist_noclobber(local_file)
            .map_err(|error| format!("無法在不覆蓋的情況下發布本機檔案：{}", error.error))?;
    }

    let sha256 = hex_digest(digest.finalize());
    if json_output {
        println!(
            "{}",
            serde_json::to_string(&json!({
                "ok": true,
                "operation": "download",
                "remotePath": remote_path,
                "localPath": local_file,
                "bytes": expected,
                "sha256": sha256,
            }))
            .map_err(|error| error.to_string())?
        );
    } else {
        println!(
            "下載完成：{}（{} bytes，SHA-256 {}）",
            local_file.display(),
            expected,
            sha256
        );
    }
    Ok(())
}

fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    bytes
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

async fn terminal(mut connected: Connected) -> Result<(), String> {
    if !connected.hello.terminal {
        return Err("Agent 沒有以 --terminal 分享 shell。".to_string());
    }
    if connected.hello.view_only {
        return Err("Agent 未加上 --allow-input，此工作階段只能觀看。".to_string());
    }
    if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
        return Err("terminal 子命令必須在真實互動終端中執行。".to_string());
    }

    let (cols, rows) = crossterm::terminal::size().unwrap_or((120, 30));
    send(
        &mut connected.connection,
        &RemoteMessage::TerminalResize { cols, rows },
    )
    .await?;
    eprintln!(
        "已連上 {}；按 Ctrl+] 中斷，不會自動執行任何部署指令。",
        connected.hello.agent_name
    );
    enable_raw_mode().map_err(|error| format!("無法切換終端原始模式：{error}"))?;
    let _raw_mode = RawModeGuard;

    let (mut reader, mut writer) = connected.connection.split();
    let mut output = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        loop {
            match reader.receive().await.map_err(|error| error.to_string())? {
                RemoteMessage::TerminalData { bytes } => {
                    stdout
                        .write_all(&bytes)
                        .await
                        .map_err(|error| format!("無法顯示遠端終端輸出：{error}"))?;
                    stdout
                        .flush()
                        .await
                        .map_err(|error| format!("無法更新遠端終端輸出：{error}"))?;
                }
                RemoteMessage::KeepAlive => {}
                RemoteMessage::Close(_) => return Ok::<(), String>(()),
                _ => return Err("Agent 在終端工作階段送出非預期訊息。".to_string()),
            }
        }
    });
    let mut input = tokio::spawn(async move {
        let mut stdin = tokio::io::stdin();
        let mut buffer = [0u8; 4096];
        let mut resize_tick = interval(Duration::from_millis(500));
        let mut last_size = (cols, rows);
        loop {
            tokio::select! {
                read = stdin.read(&mut buffer) => {
                    let read = read.map_err(|error| format!("無法讀取本機終端輸入：{error}"))?;
                    if read == 0 {
                        let _ = writer.send(&RemoteMessage::Close("Local terminal closed.".into())).await;
                        return Ok::<(), String>(());
                    }
                    let bytes = &buffer[..read];
                    if let Some(position) = bytes.iter().position(|byte| *byte == TERMINAL_ESCAPE) {
                        if position > 0 {
                            writer
                                .send(&RemoteMessage::TerminalInput {
                                    bytes: bytes[..position].to_vec(),
                                })
                                .await
                                .map_err(|error| error.to_string())?;
                        }
                        let _ = writer.send(&RemoteMessage::Close("Viewer disconnected.".into())).await;
                        return Ok(());
                    }
                    writer
                        .send(&RemoteMessage::TerminalInput { bytes: bytes.to_vec() })
                        .await
                        .map_err(|error| error.to_string())?;
                }
                _ = resize_tick.tick() => {
                    if let Ok(size) = crossterm::terminal::size() {
                        if size != last_size {
                            writer
                                .send(&RemoteMessage::TerminalResize { cols: size.0, rows: size.1 })
                                .await
                                .map_err(|error| error.to_string())?;
                            last_size = size;
                        }
                    }
                }
            }
        }
    });

    tokio::select! {
        result = &mut output => {
            input.abort();
            result.map_err(|error| format!("遠端終端輸出工作失敗：{error}"))??;
        }
        result = &mut input => {
            output.abort();
            result.map_err(|error| format!("遠端終端輸入工作失敗：{error}"))??;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn direct_targets_support_defaults_hostnames_and_bracketed_ipv6() {
        assert_eq!(
            parse_direct_target("server.example.com").unwrap(),
            ("server.example.com".into(), DEFAULT_PORT)
        );
        assert_eq!(
            parse_direct_target("server.example.com:45000").unwrap(),
            ("server.example.com".into(), 45000)
        );
        assert_eq!(
            parse_direct_target("[::1]:45000").unwrap(),
            ("::1".into(), 45000)
        );
        assert!(parse_direct_target("::1").is_err());
        assert!(parse_direct_target("host:0").is_err());
    }

    #[test]
    fn clap_contract_has_no_pairing_code_value_argument() {
        let command = Cli::command();
        assert!(command
            .get_arguments()
            .all(|argument| argument.get_id() != "pair_code"));
        assert!(Cli::try_parse_from([
            "lattice-remote",
            "--direct",
            "localhost",
            "--pair-code",
            "12345678",
            "list"
        ])
        .is_err());
    }

    #[test]
    fn relay_requires_a_device_and_conflicts_with_direct() {
        assert!(Cli::try_parse_from([
            "lattice-remote",
            "--relay",
            "wss://relay.example.com",
            "list"
        ])
        .is_err());
        assert!(Cli::try_parse_from([
            "lattice-remote",
            "--direct",
            "localhost",
            "--relay",
            "wss://relay.example.com",
            "--device",
            "123456789",
            "list"
        ])
        .is_err());
    }

    #[test]
    fn remote_paths_reject_traversal_and_ambiguous_separators() {
        assert!(validate_remote_path("/release.tar.gz", false).is_ok());
        assert!(validate_remote_path("/", true).is_ok());
        assert!(validate_remote_path("../secret", false).is_err());
        assert!(validate_remote_path("/../secret", false).is_err());
        assert!(validate_remote_path("/nested//file", false).is_err());
        assert!(validate_remote_path("/nested\\file", false).is_err());
    }

    #[test]
    fn local_target_state_detects_same_length_content_changes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("target.bin");
        std::fs::write(&path, b"alpha").unwrap();
        let first = inspect_local_target(&path).unwrap();
        std::fs::write(&path, b"bravo").unwrap();
        let second = inspect_local_target(&path).unwrap();
        assert_ne!(first, second);
    }

    #[cfg(unix)]
    #[test]
    fn upload_source_rejects_symbolic_links() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target.bin");
        let link = directory.path().join("source.bin");
        std::fs::write(&target, b"release").unwrap();
        symlink(&target, &link).unwrap();
        assert!(open_upload_source(&link).is_err());
    }
}
