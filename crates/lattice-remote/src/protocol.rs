use std::fmt;

pub const PROTOCOL_VERSION: u16 = 2;
/// The oldest peer this build still knows how to talk to.
///
/// Two machines running different LatticeTerm releases must be able to
/// connect, or the one that is behind can never be reached to update it —
/// exactly the session someone needs most. Raise this only when a version
/// genuinely cannot be spoken any more, and say so in the release notes.
pub const MIN_COMPATIBLE_PROTOCOL_VERSION: u16 = 2;
pub const DEFAULT_PORT: u16 = 44_900;
pub const FRAME_CHUNK_SIZE: usize = 48 * 1024;
pub const FILE_CHUNK_SIZE: usize = 48 * 1024;
pub const MAX_TEXT_FILE_BYTES: usize = 1024 * 1024;
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_AGENT_NAME_BYTES: usize = 256;
pub const MAX_FILE_ROOT_LABEL_BYTES: usize = 256;
pub const MAX_REMOTE_PATH_BYTES: usize = 4 * 1024;
pub const MAX_FILE_ERROR_BYTES: usize = 1024;
pub const MAX_DIRECTORY_ENTRIES: usize = 4096;
pub const MAX_FRAME_DIMENSION: u32 = 16_384;
pub const MAX_FRAME_PIXELS: u64 = 32 * 1024 * 1024;
pub const MAX_CLOSE_REASON_BYTES: usize = 1024;

/// Why two peers cannot talk, and which side is behind.
///
/// The distinction is the whole point: the message has to tell the operator
/// which machine to update, and a viewer that is itself too old cannot be
/// fixed from the far end.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtocolMismatch {
    /// The peer speaks a version this build no longer understands.
    PeerTooOld { peer: u16, oldest_supported: u16 },
    /// The peer is newer than anything this build understands, so the machine
    /// to update is this one.
    PeerTooNew { peer: u16, newest_supported: u16 },
}

impl fmt::Display for ProtocolMismatch {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::PeerTooOld {
                peer,
                oldest_supported,
            } => write!(
                formatter,
                "The other machine speaks Lattice Remote protocol {peer}, \
                 older than the oldest this build supports ({oldest_supported}). \
                 Update LatticeTerm on that machine."
            ),
            Self::PeerTooNew {
                peer,
                newest_supported,
            } => write!(
                formatter,
                "The other machine speaks Lattice Remote protocol {peer}, \
                 newer than this build understands ({newest_supported}). \
                 Update LatticeTerm on this machine."
            ),
        }
    }
}

/// The protocol version two peers will actually use.
///
/// A newer build talks down to an older peer rather than refusing it, so the
/// machine that is behind stays reachable. Anything newer than this build is
/// refused, because there is no way to guess what it added.
pub fn negotiate_protocol_version(peer: u16) -> Result<u16, ProtocolMismatch> {
    if peer < MIN_COMPATIBLE_PROTOCOL_VERSION {
        return Err(ProtocolMismatch::PeerTooOld {
            peer,
            oldest_supported: MIN_COMPATIBLE_PROTOCOL_VERSION,
        });
    }
    if peer > PROTOCOL_VERSION {
        return Err(ProtocolMismatch::PeerTooNew {
            peer,
            newest_supported: PROTOCOL_VERSION,
        });
    }
    Ok(peer)
}

const MESSAGE_HELLO: u8 = 1;
const MESSAGE_FRAME_START: u8 = 2;
const MESSAGE_FRAME_CHUNK: u8 = 3;
const MESSAGE_KEEP_ALIVE: u8 = 4;
const MESSAGE_CLOSE: u8 = 5;
const MESSAGE_INPUT: u8 = 6;
const MESSAGE_FILE_REQUEST: u8 = 7;
const MESSAGE_FILE_RESPONSE: u8 = 8;
const MESSAGE_TERMINAL_DATA: u8 = 9;
const MESSAGE_TERMINAL_INPUT: u8 = 10;
const MESSAGE_TERMINAL_RESIZE: u8 = 11;

/// One terminal payload may carry at most this many raw PTY bytes.
pub const TERMINAL_CHUNK_SIZE: usize = 48 * 1024;
/// Terminal grids larger than this are treated as protocol abuse.
pub const MAX_TERMINAL_DIMENSION: u16 = 1024;

const INPUT_MOUSE_MOVE: u8 = 1;
const INPUT_MOUSE_BUTTON: u8 = 2;
const INPUT_WHEEL: u8 = 3;
const INPUT_KEY: u8 = 4;
const INPUT_RELEASE_ALL: u8 = 5;

const FILE_REQUEST_LIST: u8 = 1;
const FILE_REQUEST_DOWNLOAD: u8 = 2;
const FILE_REQUEST_UPLOAD_START: u8 = 3;
const FILE_REQUEST_UPLOAD_CHUNK: u8 = 4;
const FILE_REQUEST_UPLOAD_FINISH: u8 = 5;
const FILE_REQUEST_CANCEL: u8 = 6;
const FILE_REQUEST_READ_TEXT: u8 = 7;
const FILE_REQUEST_SAVE_TEXT_START: u8 = 8;

const FILE_RESPONSE_LIST_START: u8 = 1;
const FILE_RESPONSE_LIST_ENTRY: u8 = 2;
const FILE_RESPONSE_LIST_DONE: u8 = 3;
const FILE_RESPONSE_DOWNLOAD_START: u8 = 4;
const FILE_RESPONSE_DOWNLOAD_CHUNK: u8 = 5;
const FILE_RESPONSE_UPLOAD_READY: u8 = 6;
const FILE_RESPONSE_COMPLETE: u8 = 7;
const FILE_RESPONSE_ERROR: u8 = 8;
const FILE_RESPONSE_TEXT_START: u8 = 9;
const FILE_RESPONSE_TEXT_SAVED: u8 = 10;

/// One wheel message may scroll at most this many notches in either direction.
pub const MAX_WHEEL_UNITS: i8 = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteHello {
    pub protocol_version: u16,
    pub agent_name: String,
    /// Stream width in pixels, or the column count for a terminal session.
    pub width: u32,
    /// Stream height in pixels, or the row count for a terminal session.
    pub height: u32,
    pub view_only: bool,
    pub file_transfer: bool,
    /// Human-readable name for the explicitly shared root. Remote paths remain
    /// virtual and never reveal the host's absolute filesystem location.
    pub file_root_label: String,
    /// A headless host shares a shell instead of a display. Encoded as an
    /// optional trailing byte so screen-mode hellos stay wire-identical for
    /// older viewers.
    pub terminal: bool,
    /// Optional trailing capability. Never send text requests to a peer that
    /// did not advertise it; older hosts continue to support ordinary files.
    pub file_edit: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteFileKind {
    Directory,
    File,
    Symlink,
    Other,
}

impl RemoteFileKind {
    fn encode(self) -> u8 {
        match self {
            Self::Directory => 1,
            Self::File => 2,
            Self::Symlink => 3,
            Self::Other => 4,
        }
    }

    fn decode(value: u8) -> Result<Self, ProtocolError> {
        match value {
            1 => Ok(Self::Directory),
            2 => Ok(Self::File),
            3 => Ok(Self::Symlink),
            4 => Ok(Self::Other),
            _ => Err(ProtocolError::InvalidMessage("unknown file kind")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteFileEntry {
    pub name: String,
    pub path: String,
    pub kind: RemoteFileKind,
    pub size: u64,
    pub modified_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteFileRequest {
    ReadText {
        request_id: u64,
        path: String,
    },
    SaveTextStart {
        transfer_id: u64,
        path: String,
        size: u64,
        expected_revision: [u8; 32],
    },
    List {
        request_id: u64,
        path: String,
    },
    Download {
        transfer_id: u64,
        path: String,
    },
    UploadStart {
        transfer_id: u64,
        path: String,
        size: u64,
        overwrite: bool,
    },
    UploadChunk {
        transfer_id: u64,
        bytes: Vec<u8>,
    },
    UploadFinish {
        transfer_id: u64,
    },
    Cancel {
        transfer_id: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteFileResponse {
    TextStart {
        request_id: u64,
        size: u64,
        revision: [u8; 32],
    },
    TextSaved {
        transfer_id: u64,
        revision: [u8; 32],
        backup_path: String,
    },
    ListStart {
        request_id: u64,
        path: String,
    },
    ListEntry {
        request_id: u64,
        entry: RemoteFileEntry,
    },
    ListDone {
        request_id: u64,
    },
    DownloadStart {
        transfer_id: u64,
        name: String,
        size: u64,
    },
    DownloadChunk {
        transfer_id: u64,
        bytes: Vec<u8>,
    },
    UploadReady {
        transfer_id: u64,
    },
    Complete {
        transfer_id: u64,
    },
    Error {
        operation_id: u64,
        detail: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameFormat {
    Jpeg,
}

impl FrameFormat {
    fn encode(self) -> u8 {
        match self {
            Self::Jpeg => 1,
        }
    }

    fn decode(value: u8) -> Result<Self, ProtocolError> {
        match value {
            1 => Ok(Self::Jpeg),
            _ => Err(ProtocolError::InvalidMessage("unknown frame format")),
        }
    }

    pub fn mime_type(self) -> &'static str {
        match self {
            Self::Jpeg => "image/jpeg",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameDescriptor {
    pub frame_id: u64,
    pub width: u32,
    pub height: u32,
    pub encoded_len: u32,
    pub chunk_count: u16,
    pub format: FrameFormat,
}

/// A mouse button in the three-button model every target platform shares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PointerButton {
    Left,
    Middle,
    Right,
}

impl PointerButton {
    fn encode(self) -> u8 {
        match self {
            Self::Left => 0,
            Self::Middle => 1,
            Self::Right => 2,
        }
    }

    fn decode(value: u8) -> Result<Self, ProtocolError> {
        match value {
            0 => Ok(Self::Left),
            1 => Ok(Self::Middle),
            2 => Ok(Self::Right),
            _ => Err(ProtocolError::InvalidMessage("unknown pointer button")),
        }
    }
}

/// Viewer-to-agent input. Only valid after a Hello that advertised
/// `view_only: false`; a view-only agent drops these without acting on them.
///
/// Coordinates are in the agent's advertised stream space (the Hello
/// width/height); the agent maps them onto the real display. Keys use X11
/// keysyms, the same encoding the VNC pane already produces.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteInput {
    MouseMove {
        x: u16,
        y: u16,
    },
    MouseButton {
        button: PointerButton,
        pressed: bool,
    },
    Wheel {
        horizontal: bool,
        units: i8,
    },
    Key {
        keysym: u32,
        pressed: bool,
    },
    ReleaseAll,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteMessage {
    Hello(RemoteHello),
    FrameStart(FrameDescriptor),
    FrameChunk {
        frame_id: u64,
        chunk_index: u16,
        bytes: Vec<u8>,
    },
    KeepAlive,
    Close(String),
    Input(RemoteInput),
    FileRequest(RemoteFileRequest),
    FileResponse(RemoteFileResponse),
    /// Raw PTY output from a terminal-mode agent.
    TerminalData {
        bytes: Vec<u8>,
    },
    /// Raw viewer keystrokes for the agent's PTY. Only valid after a Hello
    /// that advertised `terminal: true` and `view_only: false`.
    TerminalInput {
        bytes: Vec<u8>,
    },
    /// The viewer's terminal grid changed size.
    TerminalResize {
        cols: u16,
        rows: u16,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompleteFrame {
    pub frame_id: u64,
    pub width: u32,
    pub height: u32,
    pub format: FrameFormat,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    InvalidMessage(&'static str),
    InvalidText,
    InvalidHello,
    FrameTooLarge(usize),
    UnexpectedChunk,
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidMessage(reason) => write!(formatter, "invalid message: {reason}"),
            Self::InvalidText => write!(formatter, "message contains invalid UTF-8"),
            Self::InvalidHello => write!(formatter, "invalid hello payload"),
            Self::FrameTooLarge(size) => write!(formatter, "frame is too large ({size} bytes)"),
            Self::UnexpectedChunk => write!(formatter, "frame chunks arrived out of order"),
        }
    }
}

impl std::error::Error for ProtocolError {}

fn valid_frame_dimensions(width: u32, height: u32) -> bool {
    width > 0
        && height > 0
        && width <= MAX_FRAME_DIMENSION
        && height <= MAX_FRAME_DIMENSION
        && u64::from(width) * u64::from(height) <= MAX_FRAME_PIXELS
}

fn validate_hello(hello: &RemoteHello) -> Result<(), ProtocolError> {
    if hello.agent_name.is_empty()
        || hello.agent_name.len() > MAX_AGENT_NAME_BYTES
        || hello.agent_name.chars().any(char::is_control)
        || hello.file_root_label.len() > MAX_FILE_ROOT_LABEL_BYTES
        || hello.file_root_label.chars().any(char::is_control)
        // Enabled sharing requires a label; disabled sharing requires none.
        || hello.file_transfer == hello.file_root_label.is_empty()
        || (hello.file_edit && !hello.file_transfer)
        || !valid_frame_dimensions(hello.width, hello.height)
        // Terminal sessions carry a character grid, not pixels.
        || (hello.terminal
            && (hello.width > u32::from(MAX_TERMINAL_DIMENSION)
                || hello.height > u32::from(MAX_TERMINAL_DIMENSION)))
    {
        return Err(ProtocolError::InvalidHello);
    }
    Ok(())
}

fn validate_terminal_bytes(bytes: &[u8]) -> Result<(), ProtocolError> {
    if bytes.is_empty() || bytes.len() > TERMINAL_CHUNK_SIZE {
        return Err(ProtocolError::InvalidMessage("invalid terminal payload"));
    }
    Ok(())
}

fn validate_terminal_size(cols: u16, rows: u16) -> Result<(), ProtocolError> {
    if cols == 0 || rows == 0 || cols > MAX_TERMINAL_DIMENSION || rows > MAX_TERMINAL_DIMENSION {
        return Err(ProtocolError::InvalidMessage("invalid terminal size"));
    }
    Ok(())
}

fn validate_frame_descriptor(frame: &FrameDescriptor) -> Result<(), ProtocolError> {
    let encoded_len = frame.encoded_len as usize;
    let expected_chunks = encoded_len.div_ceil(FRAME_CHUNK_SIZE);
    if !valid_frame_dimensions(frame.width, frame.height)
        || encoded_len == 0
        || encoded_len > MAX_FRAME_BYTES
        || frame.chunk_count as usize != expected_chunks
    {
        return Err(ProtocolError::InvalidMessage("invalid frame descriptor"));
    }
    Ok(())
}

fn validate_input(input: &RemoteInput) -> Result<(), ProtocolError> {
    match input {
        RemoteInput::Wheel { units, .. } => {
            if *units == 0 || units.unsigned_abs() > MAX_WHEEL_UNITS.unsigned_abs() {
                return Err(ProtocolError::InvalidMessage("wheel units out of range"));
            }
        }
        RemoteInput::MouseMove { .. }
        | RemoteInput::MouseButton { .. }
        | RemoteInput::Key { .. }
        | RemoteInput::ReleaseAll => {}
    }
    Ok(())
}

impl RemoteMessage {
    pub fn encode(&self) -> Result<Vec<u8>, ProtocolError> {
        match self {
            Self::Hello(hello) => {
                validate_hello(hello)?;
                let name = hello.agent_name.as_bytes();
                let root = hello.file_root_label.as_bytes();
                let mut output = Vec::with_capacity(16 + name.len() + root.len());
                output.push(MESSAGE_HELLO);
                output.extend_from_slice(&hello.protocol_version.to_be_bytes());
                output.extend_from_slice(&hello.width.to_be_bytes());
                output.extend_from_slice(&hello.height.to_be_bytes());
                output.push(u8::from(hello.view_only));
                output.push(u8::from(hello.file_transfer));
                output.extend_from_slice(&(name.len() as u16).to_be_bytes());
                output.extend_from_slice(&(root.len() as u16).to_be_bytes());
                output.extend_from_slice(name);
                output.extend_from_slice(root);
                // Hosts without optional capabilities stay byte-identical to
                // the original protocol v2 hello. Editing appends a terminal
                // placeholder and its own capability for tolerant v2 peers.
                if hello.terminal || hello.file_edit {
                    output.push(u8::from(hello.terminal));
                }
                if hello.file_edit {
                    output.push(1);
                }
                Ok(output)
            }
            Self::FrameStart(frame) => {
                validate_frame_descriptor(frame)?;
                let mut output = Vec::with_capacity(24);
                output.push(MESSAGE_FRAME_START);
                output.extend_from_slice(&frame.frame_id.to_be_bytes());
                output.extend_from_slice(&frame.width.to_be_bytes());
                output.extend_from_slice(&frame.height.to_be_bytes());
                output.extend_from_slice(&frame.encoded_len.to_be_bytes());
                output.extend_from_slice(&frame.chunk_count.to_be_bytes());
                output.push(frame.format.encode());
                Ok(output)
            }
            Self::FrameChunk {
                frame_id,
                chunk_index,
                bytes,
            } => {
                if bytes.len() > FRAME_CHUNK_SIZE {
                    return Err(ProtocolError::InvalidMessage("frame chunk is too large"));
                }
                let mut output = Vec::with_capacity(11 + bytes.len());
                output.push(MESSAGE_FRAME_CHUNK);
                output.extend_from_slice(&frame_id.to_be_bytes());
                output.extend_from_slice(&chunk_index.to_be_bytes());
                output.extend_from_slice(bytes);
                Ok(output)
            }
            Self::KeepAlive => Ok(vec![MESSAGE_KEEP_ALIVE]),
            Self::Input(input) => {
                validate_input(input)?;
                let mut output = Vec::with_capacity(8);
                output.push(MESSAGE_INPUT);
                match input {
                    RemoteInput::MouseMove { x, y } => {
                        output.push(INPUT_MOUSE_MOVE);
                        output.extend_from_slice(&x.to_be_bytes());
                        output.extend_from_slice(&y.to_be_bytes());
                    }
                    RemoteInput::MouseButton { button, pressed } => {
                        output.push(INPUT_MOUSE_BUTTON);
                        output.push(button.encode());
                        output.push(u8::from(*pressed));
                    }
                    RemoteInput::Wheel { horizontal, units } => {
                        output.push(INPUT_WHEEL);
                        output.push(u8::from(*horizontal));
                        output.push(units.to_be_bytes()[0]);
                    }
                    RemoteInput::Key { keysym, pressed } => {
                        output.push(INPUT_KEY);
                        output.extend_from_slice(&keysym.to_be_bytes());
                        output.push(u8::from(*pressed));
                    }
                    RemoteInput::ReleaseAll => output.push(INPUT_RELEASE_ALL),
                }
                Ok(output)
            }
            Self::FileRequest(request) => encode_file_request(request),
            Self::FileResponse(response) => encode_file_response(response),
            Self::TerminalData { bytes } => {
                validate_terminal_bytes(bytes)?;
                let mut output = Vec::with_capacity(1 + bytes.len());
                output.push(MESSAGE_TERMINAL_DATA);
                output.extend_from_slice(bytes);
                Ok(output)
            }
            Self::TerminalInput { bytes } => {
                validate_terminal_bytes(bytes)?;
                let mut output = Vec::with_capacity(1 + bytes.len());
                output.push(MESSAGE_TERMINAL_INPUT);
                output.extend_from_slice(bytes);
                Ok(output)
            }
            Self::TerminalResize { cols, rows } => {
                validate_terminal_size(*cols, *rows)?;
                let mut output = Vec::with_capacity(5);
                output.push(MESSAGE_TERMINAL_RESIZE);
                output.extend_from_slice(&cols.to_be_bytes());
                output.extend_from_slice(&rows.to_be_bytes());
                Ok(output)
            }
            Self::Close(reason) => {
                let bytes = reason.as_bytes();
                if bytes.len() > MAX_CLOSE_REASON_BYTES {
                    return Err(ProtocolError::InvalidMessage("close reason is too long"));
                }
                let mut output = Vec::with_capacity(1 + bytes.len());
                output.push(MESSAGE_CLOSE);
                output.extend_from_slice(bytes);
                Ok(output)
            }
        }
    }

    pub fn decode(input: &[u8]) -> Result<Self, ProtocolError> {
        let kind = *input
            .first()
            .ok_or(ProtocolError::InvalidMessage("empty message"))?;
        let body = &input[1..];

        match kind {
            MESSAGE_HELLO => {
                if body.len() < 16 {
                    return Err(ProtocolError::InvalidHello);
                }
                let protocol_version = read_u16(body, 0)?;
                let width = read_u32(body, 2)?;
                let height = read_u32(body, 6)?;
                let view_only = match body[10] {
                    0 => false,
                    1 => true,
                    _ => return Err(ProtocolError::InvalidHello),
                };
                let file_transfer = decode_bool(body[11])?;
                let name_len = read_u16(body, 12)? as usize;
                let root_len = read_u16(body, 14)? as usize;
                let base_len = 16 + name_len + root_len;
                if body.len() < base_len {
                    return Err(ProtocolError::InvalidHello);
                }
                // `terminal` arrived as an optional trailing byte so that
                // screen-mode hellos stayed wire-identical for viewers that
                // predated it. File editing uses the next optional byte.
                // Anything beyond these capabilities belongs to a protocol
                // version this build does not know, and is skipped rather
                // than refused: an older machine has to stay reachable from a
                // newer one, or it can never be updated. The frame cap still
                // bounds how much can arrive.
                let terminal = match body.get(base_len) {
                    None => false,
                    Some(byte) => decode_bool(*byte)?,
                };
                let file_edit = match body.get(base_len + 1) {
                    None => false,
                    Some(byte) => decode_bool(*byte)?,
                };
                if name_len == 0 {
                    return Err(ProtocolError::InvalidHello);
                }
                let agent_name = std::str::from_utf8(&body[16..16 + name_len])
                    .map_err(|_| ProtocolError::InvalidText)?
                    .to_string();
                let file_root_label = std::str::from_utf8(&body[16 + name_len..base_len])
                    .map_err(|_| ProtocolError::InvalidText)?
                    .to_string();
                let hello = RemoteHello {
                    protocol_version,
                    agent_name,
                    width,
                    height,
                    view_only,
                    file_transfer,
                    file_root_label,
                    terminal,
                    file_edit,
                };
                validate_hello(&hello)?;
                Ok(Self::Hello(hello))
            }
            MESSAGE_FRAME_START => {
                if body.len() != 23 {
                    return Err(ProtocolError::InvalidMessage("invalid frame start length"));
                }
                let descriptor = FrameDescriptor {
                    frame_id: read_u64(body, 0)?,
                    width: read_u32(body, 8)?,
                    height: read_u32(body, 12)?,
                    encoded_len: read_u32(body, 16)?,
                    chunk_count: read_u16(body, 20)?,
                    format: FrameFormat::decode(body[22])?,
                };
                validate_frame_descriptor(&descriptor)?;
                Ok(Self::FrameStart(descriptor))
            }
            MESSAGE_FRAME_CHUNK => {
                if body.len() < 10 {
                    return Err(ProtocolError::InvalidMessage("invalid frame chunk length"));
                }
                let bytes = body[10..].to_vec();
                if bytes.len() > FRAME_CHUNK_SIZE {
                    return Err(ProtocolError::InvalidMessage("frame chunk is too large"));
                }
                Ok(Self::FrameChunk {
                    frame_id: read_u64(body, 0)?,
                    chunk_index: read_u16(body, 8)?,
                    bytes,
                })
            }
            MESSAGE_KEEP_ALIVE if body.is_empty() => Ok(Self::KeepAlive),
            MESSAGE_INPUT => {
                let subkind = *body
                    .first()
                    .ok_or(ProtocolError::InvalidMessage("empty input message"))?;
                let detail = &body[1..];
                let input = match subkind {
                    INPUT_MOUSE_MOVE if detail.len() == 4 => RemoteInput::MouseMove {
                        x: read_u16(detail, 0)?,
                        y: read_u16(detail, 2)?,
                    },
                    INPUT_MOUSE_BUTTON if detail.len() == 2 => RemoteInput::MouseButton {
                        button: PointerButton::decode(detail[0])?,
                        pressed: decode_bool(detail[1])?,
                    },
                    INPUT_WHEEL if detail.len() == 2 => RemoteInput::Wheel {
                        horizontal: decode_bool(detail[0])?,
                        units: i8::from_be_bytes([detail[1]]),
                    },
                    INPUT_KEY if detail.len() == 5 => RemoteInput::Key {
                        keysym: read_u32(detail, 0)?,
                        pressed: decode_bool(detail[4])?,
                    },
                    INPUT_RELEASE_ALL if detail.is_empty() => RemoteInput::ReleaseAll,
                    _ => return Err(ProtocolError::InvalidMessage("invalid input message")),
                };
                validate_input(&input)?;
                Ok(Self::Input(input))
            }
            MESSAGE_FILE_REQUEST => decode_file_request(body).map(Self::FileRequest),
            MESSAGE_FILE_RESPONSE => decode_file_response(body).map(Self::FileResponse),
            MESSAGE_TERMINAL_DATA => {
                validate_terminal_bytes(body)?;
                Ok(Self::TerminalData {
                    bytes: body.to_vec(),
                })
            }
            MESSAGE_TERMINAL_INPUT => {
                validate_terminal_bytes(body)?;
                Ok(Self::TerminalInput {
                    bytes: body.to_vec(),
                })
            }
            MESSAGE_TERMINAL_RESIZE => {
                if body.len() != 4 {
                    return Err(ProtocolError::InvalidMessage("invalid terminal size"));
                }
                let cols = read_u16(body, 0)?;
                let rows = read_u16(body, 2)?;
                validate_terminal_size(cols, rows)?;
                Ok(Self::TerminalResize { cols, rows })
            }
            MESSAGE_CLOSE => {
                if body.len() > MAX_CLOSE_REASON_BYTES {
                    return Err(ProtocolError::InvalidMessage("close reason is too long"));
                }
                Ok(Self::Close(
                    std::str::from_utf8(body)
                        .map_err(|_| ProtocolError::InvalidText)?
                        .to_string(),
                ))
            }
            _ => Err(ProtocolError::InvalidMessage("unknown message type")),
        }
    }
}

fn valid_remote_path(path: &str) -> bool {
    let structure = path == "/"
        || (!path.ends_with('/')
            && path
                .split('/')
                .skip(1)
                .all(|component| !component.is_empty() && component != "." && component != ".."));
    structure
        && !path.is_empty()
        && path.len() <= MAX_REMOTE_PATH_BYTES
        && path.starts_with('/')
        && !path.contains('\0')
        && !path.contains('\\')
        && !path.chars().any(char::is_control)
}

fn valid_file_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && name.len() <= MAX_FILE_ROOT_LABEL_BYTES
        && !name.contains(['/', '\\', '\0'])
        && !name.chars().any(char::is_control)
}

fn put_text(output: &mut Vec<u8>, value: &str) -> Result<(), ProtocolError> {
    if value.len() > u16::MAX as usize {
        return Err(ProtocolError::InvalidMessage("text field is too large"));
    }
    output.extend_from_slice(&(value.len() as u16).to_be_bytes());
    output.extend_from_slice(value.as_bytes());
    Ok(())
}

fn read_text<'a>(input: &'a [u8], offset: &mut usize) -> Result<&'a str, ProtocolError> {
    let length = read_u16(input, *offset)? as usize;
    *offset += 2;
    let bytes = input
        .get(*offset..*offset + length)
        .ok_or(ProtocolError::InvalidMessage("truncated text field"))?;
    *offset += length;
    std::str::from_utf8(bytes).map_err(|_| ProtocolError::InvalidText)
}

fn finish_decode(input: &[u8], offset: usize) -> Result<(), ProtocolError> {
    if offset == input.len() {
        Ok(())
    } else {
        Err(ProtocolError::InvalidMessage("trailing message bytes"))
    }
}

fn encode_file_request(request: &RemoteFileRequest) -> Result<Vec<u8>, ProtocolError> {
    let mut output = Vec::with_capacity(64);
    output.push(MESSAGE_FILE_REQUEST);
    match request {
        RemoteFileRequest::ReadText { request_id, path } => {
            if !valid_remote_path(path) || path == "/" {
                return Err(ProtocolError::InvalidMessage("invalid text file path"));
            }
            output.push(FILE_REQUEST_READ_TEXT);
            output.extend_from_slice(&request_id.to_be_bytes());
            put_text(&mut output, path)?;
        }
        RemoteFileRequest::SaveTextStart {
            transfer_id,
            path,
            size,
            expected_revision,
        } => {
            if !valid_remote_path(path) || path == "/" || *size > MAX_TEXT_FILE_BYTES as u64 {
                return Err(ProtocolError::InvalidMessage("invalid text save request"));
            }
            output.push(FILE_REQUEST_SAVE_TEXT_START);
            output.extend_from_slice(&transfer_id.to_be_bytes());
            output.extend_from_slice(&size.to_be_bytes());
            output.extend_from_slice(expected_revision);
            put_text(&mut output, path)?;
        }
        RemoteFileRequest::List { request_id, path } => {
            if !valid_remote_path(path) {
                return Err(ProtocolError::InvalidMessage("invalid remote path"));
            }
            output.push(FILE_REQUEST_LIST);
            output.extend_from_slice(&request_id.to_be_bytes());
            put_text(&mut output, path)?;
        }
        RemoteFileRequest::Download { transfer_id, path } => {
            if !valid_remote_path(path) {
                return Err(ProtocolError::InvalidMessage("invalid remote path"));
            }
            output.push(FILE_REQUEST_DOWNLOAD);
            output.extend_from_slice(&transfer_id.to_be_bytes());
            put_text(&mut output, path)?;
        }
        RemoteFileRequest::UploadStart {
            transfer_id,
            path,
            size,
            overwrite,
        } => {
            if !valid_remote_path(path) {
                return Err(ProtocolError::InvalidMessage("invalid remote path"));
            }
            output.push(FILE_REQUEST_UPLOAD_START);
            output.extend_from_slice(&transfer_id.to_be_bytes());
            output.extend_from_slice(&size.to_be_bytes());
            output.push(u8::from(*overwrite));
            put_text(&mut output, path)?;
        }
        RemoteFileRequest::UploadChunk { transfer_id, bytes } => {
            if bytes.is_empty() || bytes.len() > FILE_CHUNK_SIZE {
                return Err(ProtocolError::InvalidMessage("invalid file chunk"));
            }
            output.push(FILE_REQUEST_UPLOAD_CHUNK);
            output.extend_from_slice(&transfer_id.to_be_bytes());
            output.extend_from_slice(bytes);
        }
        RemoteFileRequest::UploadFinish { transfer_id } => {
            output.push(FILE_REQUEST_UPLOAD_FINISH);
            output.extend_from_slice(&transfer_id.to_be_bytes());
        }
        RemoteFileRequest::Cancel { transfer_id } => {
            output.push(FILE_REQUEST_CANCEL);
            output.extend_from_slice(&transfer_id.to_be_bytes());
        }
    }
    Ok(output)
}

fn decode_file_request(body: &[u8]) -> Result<RemoteFileRequest, ProtocolError> {
    let subkind = *body
        .first()
        .ok_or(ProtocolError::InvalidMessage("empty file request"))?;
    let detail = &body[1..];
    if detail.len() < 8 {
        return Err(ProtocolError::InvalidMessage("truncated file request"));
    }
    let operation_id = read_u64(detail, 0)?;
    match subkind {
        FILE_REQUEST_READ_TEXT => {
            let mut offset = 8;
            let path = read_text(detail, &mut offset)?.to_string();
            finish_decode(detail, offset)?;
            if !valid_remote_path(&path) || path == "/" {
                return Err(ProtocolError::InvalidMessage("invalid text file path"));
            }
            Ok(RemoteFileRequest::ReadText {
                request_id: operation_id,
                path,
            })
        }
        FILE_REQUEST_SAVE_TEXT_START => {
            if detail.len() < 50 {
                return Err(ProtocolError::InvalidMessage("truncated text save request"));
            }
            let size = read_u64(detail, 8)?;
            let expected_revision = detail[16..48].try_into().expect("checked revision length");
            let mut offset = 48;
            let path = read_text(detail, &mut offset)?.to_string();
            finish_decode(detail, offset)?;
            if !valid_remote_path(&path) || path == "/" || size > MAX_TEXT_FILE_BYTES as u64 {
                return Err(ProtocolError::InvalidMessage("invalid text save request"));
            }
            Ok(RemoteFileRequest::SaveTextStart {
                transfer_id: operation_id,
                path,
                size,
                expected_revision,
            })
        }
        FILE_REQUEST_LIST | FILE_REQUEST_DOWNLOAD => {
            let mut offset = 8;
            let path = read_text(detail, &mut offset)?.to_string();
            finish_decode(detail, offset)?;
            if !valid_remote_path(&path) {
                return Err(ProtocolError::InvalidMessage("invalid remote path"));
            }
            if subkind == FILE_REQUEST_LIST {
                Ok(RemoteFileRequest::List {
                    request_id: operation_id,
                    path,
                })
            } else {
                Ok(RemoteFileRequest::Download {
                    transfer_id: operation_id,
                    path,
                })
            }
        }
        FILE_REQUEST_UPLOAD_START => {
            if detail.len() < 19 {
                return Err(ProtocolError::InvalidMessage("truncated upload request"));
            }
            let size = read_u64(detail, 8)?;
            let overwrite = decode_bool(detail[16])?;
            let mut offset = 17;
            let path = read_text(detail, &mut offset)?.to_string();
            finish_decode(detail, offset)?;
            if !valid_remote_path(&path) {
                return Err(ProtocolError::InvalidMessage("invalid remote path"));
            }
            Ok(RemoteFileRequest::UploadStart {
                transfer_id: operation_id,
                path,
                size,
                overwrite,
            })
        }
        FILE_REQUEST_UPLOAD_CHUNK => {
            let bytes = detail[8..].to_vec();
            if bytes.is_empty() || bytes.len() > FILE_CHUNK_SIZE {
                return Err(ProtocolError::InvalidMessage("invalid file chunk"));
            }
            Ok(RemoteFileRequest::UploadChunk {
                transfer_id: operation_id,
                bytes,
            })
        }
        FILE_REQUEST_UPLOAD_FINISH if detail.len() == 8 => Ok(RemoteFileRequest::UploadFinish {
            transfer_id: operation_id,
        }),
        FILE_REQUEST_CANCEL if detail.len() == 8 => Ok(RemoteFileRequest::Cancel {
            transfer_id: operation_id,
        }),
        _ => Err(ProtocolError::InvalidMessage("invalid file request")),
    }
}

fn encode_file_response(response: &RemoteFileResponse) -> Result<Vec<u8>, ProtocolError> {
    let mut output = Vec::with_capacity(64);
    output.push(MESSAGE_FILE_RESPONSE);
    match response {
        RemoteFileResponse::TextStart {
            request_id,
            size,
            revision,
        } => {
            if *size > MAX_TEXT_FILE_BYTES as u64 {
                return Err(ProtocolError::InvalidMessage("text file is too large"));
            }
            output.push(FILE_RESPONSE_TEXT_START);
            output.extend_from_slice(&request_id.to_be_bytes());
            output.extend_from_slice(&size.to_be_bytes());
            output.extend_from_slice(revision);
        }
        RemoteFileResponse::TextSaved {
            transfer_id,
            revision,
            backup_path,
        } => {
            if !valid_remote_path(backup_path) || backup_path == "/" {
                return Err(ProtocolError::InvalidMessage("invalid text backup path"));
            }
            output.push(FILE_RESPONSE_TEXT_SAVED);
            output.extend_from_slice(&transfer_id.to_be_bytes());
            output.extend_from_slice(revision);
            put_text(&mut output, backup_path)?;
        }
        RemoteFileResponse::ListStart { request_id, path } => {
            if !valid_remote_path(path) {
                return Err(ProtocolError::InvalidMessage("invalid remote path"));
            }
            output.push(FILE_RESPONSE_LIST_START);
            output.extend_from_slice(&request_id.to_be_bytes());
            put_text(&mut output, path)?;
        }
        RemoteFileResponse::ListEntry { request_id, entry } => {
            if !valid_file_name(&entry.name) || !valid_remote_path(&entry.path) {
                return Err(ProtocolError::InvalidMessage("invalid directory entry"));
            }
            output.push(FILE_RESPONSE_LIST_ENTRY);
            output.extend_from_slice(&request_id.to_be_bytes());
            output.push(entry.kind.encode());
            output.extend_from_slice(&entry.size.to_be_bytes());
            match entry.modified_at {
                Some(value) => {
                    output.push(1);
                    output.extend_from_slice(&value.to_be_bytes());
                }
                None => output.push(0),
            }
            put_text(&mut output, &entry.name)?;
            put_text(&mut output, &entry.path)?;
        }
        RemoteFileResponse::ListDone { request_id } => {
            output.push(FILE_RESPONSE_LIST_DONE);
            output.extend_from_slice(&request_id.to_be_bytes());
        }
        RemoteFileResponse::DownloadStart {
            transfer_id,
            name,
            size,
        } => {
            if !valid_file_name(name) {
                return Err(ProtocolError::InvalidMessage("invalid file name"));
            }
            output.push(FILE_RESPONSE_DOWNLOAD_START);
            output.extend_from_slice(&transfer_id.to_be_bytes());
            output.extend_from_slice(&size.to_be_bytes());
            put_text(&mut output, name)?;
        }
        RemoteFileResponse::DownloadChunk { transfer_id, bytes } => {
            if bytes.is_empty() || bytes.len() > FILE_CHUNK_SIZE {
                return Err(ProtocolError::InvalidMessage("invalid file chunk"));
            }
            output.push(FILE_RESPONSE_DOWNLOAD_CHUNK);
            output.extend_from_slice(&transfer_id.to_be_bytes());
            output.extend_from_slice(bytes);
        }
        RemoteFileResponse::UploadReady { transfer_id } => {
            output.push(FILE_RESPONSE_UPLOAD_READY);
            output.extend_from_slice(&transfer_id.to_be_bytes());
        }
        RemoteFileResponse::Complete { transfer_id } => {
            output.push(FILE_RESPONSE_COMPLETE);
            output.extend_from_slice(&transfer_id.to_be_bytes());
        }
        RemoteFileResponse::Error {
            operation_id,
            detail,
        } => {
            if detail.is_empty()
                || detail.len() > MAX_FILE_ERROR_BYTES
                || detail.chars().any(char::is_control)
            {
                return Err(ProtocolError::InvalidMessage("invalid file error"));
            }
            output.push(FILE_RESPONSE_ERROR);
            output.extend_from_slice(&operation_id.to_be_bytes());
            put_text(&mut output, detail)?;
        }
    }
    Ok(output)
}

fn decode_file_response(body: &[u8]) -> Result<RemoteFileResponse, ProtocolError> {
    let subkind = *body
        .first()
        .ok_or(ProtocolError::InvalidMessage("empty file response"))?;
    let detail = &body[1..];
    if detail.len() < 8 {
        return Err(ProtocolError::InvalidMessage("truncated file response"));
    }
    let operation_id = read_u64(detail, 0)?;
    match subkind {
        FILE_RESPONSE_TEXT_START if detail.len() == 48 => {
            let size = read_u64(detail, 8)?;
            if size > MAX_TEXT_FILE_BYTES as u64 {
                return Err(ProtocolError::InvalidMessage("text file is too large"));
            }
            Ok(RemoteFileResponse::TextStart {
                request_id: operation_id,
                size,
                revision: detail[16..48].try_into().expect("checked revision length"),
            })
        }
        FILE_RESPONSE_TEXT_SAVED if detail.len() >= 42 => {
            let revision = detail[8..40].try_into().expect("checked revision length");
            let mut offset = 40;
            let backup_path = read_text(detail, &mut offset)?.to_string();
            finish_decode(detail, offset)?;
            if !valid_remote_path(&backup_path) || backup_path == "/" {
                return Err(ProtocolError::InvalidMessage("invalid text backup path"));
            }
            Ok(RemoteFileResponse::TextSaved {
                transfer_id: operation_id,
                revision,
                backup_path,
            })
        }
        FILE_RESPONSE_LIST_START => {
            let mut offset = 8;
            let path = read_text(detail, &mut offset)?.to_string();
            finish_decode(detail, offset)?;
            if !valid_remote_path(&path) {
                return Err(ProtocolError::InvalidMessage("invalid remote path"));
            }
            Ok(RemoteFileResponse::ListStart {
                request_id: operation_id,
                path,
            })
        }
        FILE_RESPONSE_LIST_ENTRY => {
            if detail.len() < 18 {
                return Err(ProtocolError::InvalidMessage("truncated directory entry"));
            }
            let kind = RemoteFileKind::decode(detail[8])?;
            let size = read_u64(detail, 9)?;
            let has_modified = decode_bool(detail[17])?;
            let mut offset = 18;
            let modified_at = if has_modified {
                let value = read_u64(detail, offset)?;
                offset += 8;
                Some(value)
            } else {
                None
            };
            let name = read_text(detail, &mut offset)?.to_string();
            let path = read_text(detail, &mut offset)?.to_string();
            finish_decode(detail, offset)?;
            if !valid_file_name(&name) || !valid_remote_path(&path) {
                return Err(ProtocolError::InvalidMessage("invalid directory entry"));
            }
            Ok(RemoteFileResponse::ListEntry {
                request_id: operation_id,
                entry: RemoteFileEntry {
                    name,
                    path,
                    kind,
                    size,
                    modified_at,
                },
            })
        }
        FILE_RESPONSE_LIST_DONE if detail.len() == 8 => Ok(RemoteFileResponse::ListDone {
            request_id: operation_id,
        }),
        FILE_RESPONSE_DOWNLOAD_START => {
            if detail.len() < 18 {
                return Err(ProtocolError::InvalidMessage("truncated download start"));
            }
            let size = read_u64(detail, 8)?;
            let mut offset = 16;
            let name = read_text(detail, &mut offset)?.to_string();
            finish_decode(detail, offset)?;
            if !valid_file_name(&name) {
                return Err(ProtocolError::InvalidMessage("invalid file name"));
            }
            Ok(RemoteFileResponse::DownloadStart {
                transfer_id: operation_id,
                name,
                size,
            })
        }
        FILE_RESPONSE_DOWNLOAD_CHUNK => {
            let bytes = detail[8..].to_vec();
            if bytes.is_empty() || bytes.len() > FILE_CHUNK_SIZE {
                return Err(ProtocolError::InvalidMessage("invalid file chunk"));
            }
            Ok(RemoteFileResponse::DownloadChunk {
                transfer_id: operation_id,
                bytes,
            })
        }
        FILE_RESPONSE_UPLOAD_READY if detail.len() == 8 => Ok(RemoteFileResponse::UploadReady {
            transfer_id: operation_id,
        }),
        FILE_RESPONSE_COMPLETE if detail.len() == 8 => Ok(RemoteFileResponse::Complete {
            transfer_id: operation_id,
        }),
        FILE_RESPONSE_ERROR => {
            let mut offset = 8;
            let detail_text = read_text(detail, &mut offset)?.to_string();
            finish_decode(detail, offset)?;
            if detail_text.is_empty()
                || detail_text.len() > MAX_FILE_ERROR_BYTES
                || detail_text.chars().any(char::is_control)
            {
                return Err(ProtocolError::InvalidMessage("invalid file error"));
            }
            Ok(RemoteFileResponse::Error {
                operation_id,
                detail: detail_text,
            })
        }
        _ => Err(ProtocolError::InvalidMessage("invalid file response")),
    }
}

fn decode_bool(value: u8) -> Result<bool, ProtocolError> {
    match value {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(ProtocolError::InvalidMessage("invalid boolean byte")),
    }
}

fn read_u16(input: &[u8], offset: usize) -> Result<u16, ProtocolError> {
    let bytes = input
        .get(offset..offset + 2)
        .ok_or(ProtocolError::InvalidMessage("truncated integer"))?;
    Ok(u16::from_be_bytes([bytes[0], bytes[1]]))
}

fn read_u32(input: &[u8], offset: usize) -> Result<u32, ProtocolError> {
    let bytes = input
        .get(offset..offset + 4)
        .ok_or(ProtocolError::InvalidMessage("truncated integer"))?;
    Ok(u32::from_be_bytes(
        bytes.try_into().expect("four-byte slice"),
    ))
}

fn read_u64(input: &[u8], offset: usize) -> Result<u64, ProtocolError> {
    let bytes = input
        .get(offset..offset + 8)
        .ok_or(ProtocolError::InvalidMessage("truncated integer"))?;
    Ok(u64::from_be_bytes(
        bytes.try_into().expect("eight-byte slice"),
    ))
}

pub fn frame_messages(
    frame_id: u64,
    width: u32,
    height: u32,
    format: FrameFormat,
    bytes: &[u8],
) -> Result<Vec<RemoteMessage>, ProtocolError> {
    if bytes.is_empty() {
        return Err(ProtocolError::InvalidMessage("empty frame"));
    }
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(ProtocolError::FrameTooLarge(bytes.len()));
    }
    let chunks = bytes.len().div_ceil(FRAME_CHUNK_SIZE);
    if chunks > u16::MAX as usize {
        return Err(ProtocolError::FrameTooLarge(bytes.len()));
    }

    let descriptor = FrameDescriptor {
        frame_id,
        width,
        height,
        encoded_len: bytes.len() as u32,
        chunk_count: chunks as u16,
        format,
    };
    validate_frame_descriptor(&descriptor)?;

    let mut messages = Vec::with_capacity(chunks + 1);
    messages.push(RemoteMessage::FrameStart(descriptor));
    for (index, chunk) in bytes.chunks(FRAME_CHUNK_SIZE).enumerate() {
        messages.push(RemoteMessage::FrameChunk {
            frame_id,
            chunk_index: index as u16,
            bytes: chunk.to_vec(),
        });
    }
    Ok(messages)
}

#[derive(Debug, Default)]
pub struct FrameAssembler {
    pending: Option<PendingFrame>,
}

#[derive(Debug)]
struct PendingFrame {
    descriptor: FrameDescriptor,
    next_chunk: u16,
    bytes: Vec<u8>,
}

impl FrameAssembler {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, message: RemoteMessage) -> Result<Option<CompleteFrame>, ProtocolError> {
        match message {
            RemoteMessage::FrameStart(descriptor) => {
                validate_frame_descriptor(&descriptor)?;
                let encoded_len = descriptor.encoded_len as usize;
                self.pending = Some(PendingFrame {
                    descriptor,
                    next_chunk: 0,
                    bytes: Vec::with_capacity(encoded_len),
                });
                Ok(None)
            }
            RemoteMessage::FrameChunk {
                frame_id,
                chunk_index,
                bytes,
            } => {
                let pending = self
                    .pending
                    .as_mut()
                    .ok_or(ProtocolError::UnexpectedChunk)?;
                if pending.descriptor.frame_id != frame_id || pending.next_chunk != chunk_index {
                    self.pending = None;
                    return Err(ProtocolError::UnexpectedChunk);
                }
                if pending.bytes.len() + bytes.len() > pending.descriptor.encoded_len as usize {
                    self.pending = None;
                    return Err(ProtocolError::UnexpectedChunk);
                }
                pending.bytes.extend_from_slice(&bytes);
                pending.next_chunk += 1;

                if pending.next_chunk == pending.descriptor.chunk_count {
                    let complete = self.pending.take().expect("pending frame exists");
                    if complete.bytes.len() != complete.descriptor.encoded_len as usize {
                        return Err(ProtocolError::UnexpectedChunk);
                    }
                    return Ok(Some(CompleteFrame {
                        frame_id: complete.descriptor.frame_id,
                        width: complete.descriptor.width,
                        height: complete.descriptor.height,
                        format: complete.descriptor.format,
                        bytes: complete.bytes,
                    }));
                }
                Ok(None)
            }
            _ => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_round_trips() {
        let message = RemoteMessage::Hello(RemoteHello {
            protocol_version: PROTOCOL_VERSION,
            agent_name: "Studio Mac".into(),
            width: 1280,
            height: 720,
            view_only: true,
            file_transfer: false,
            file_root_label: String::new(),
            file_edit: false,
            terminal: false,
        });
        assert_eq!(
            RemoteMessage::decode(&message.encode().unwrap()).unwrap(),
            message
        );
    }

    #[test]
    fn terminal_messages_round_trip() {
        let messages = vec![
            RemoteMessage::Hello(RemoteHello {
                protocol_version: PROTOCOL_VERSION,
                agent_name: "Headless box".into(),
                width: 120,
                height: 32,
                view_only: false,
                file_transfer: false,
                file_root_label: String::new(),
                file_edit: false,
                terminal: true,
            }),
            RemoteMessage::TerminalData {
                bytes: b"login: ".to_vec(),
            },
            RemoteMessage::TerminalInput {
                bytes: b"ls -la\r".to_vec(),
            },
            RemoteMessage::TerminalResize {
                cols: 132,
                rows: 43,
            },
        ];
        for message in messages {
            assert_eq!(
                RemoteMessage::decode(&message.encode().unwrap()).unwrap(),
                message
            );
        }
    }

    #[test]
    fn a_newer_build_talks_down_to_an_older_peer() {
        for peer in MIN_COMPATIBLE_PROTOCOL_VERSION..=PROTOCOL_VERSION {
            assert_eq!(negotiate_protocol_version(peer), Ok(peer));
        }
    }

    #[test]
    fn a_refusal_names_the_machine_to_update() {
        assert_eq!(
            negotiate_protocol_version(PROTOCOL_VERSION + 1),
            Err(ProtocolMismatch::PeerTooNew {
                peer: PROTOCOL_VERSION + 1,
                newest_supported: PROTOCOL_VERSION,
            })
        );
        assert!(negotiate_protocol_version(PROTOCOL_VERSION + 1)
            .unwrap_err()
            .to_string()
            .contains("this machine"));

        assert_eq!(
            negotiate_protocol_version(MIN_COMPATIBLE_PROTOCOL_VERSION - 1),
            Err(ProtocolMismatch::PeerTooOld {
                peer: MIN_COMPATIBLE_PROTOCOL_VERSION - 1,
                oldest_supported: MIN_COMPATIBLE_PROTOCOL_VERSION,
            })
        );
        assert!(
            negotiate_protocol_version(MIN_COMPATIBLE_PROTOCOL_VERSION - 1)
                .unwrap_err()
                .to_string()
                .contains("that machine")
        );
    }

    #[test]
    fn a_hello_from_a_future_version_still_decodes() {
        // A later protocol may append fields. An older viewer has to read the
        // part it knows and ignore the rest, or the machine running it can
        // never connect to a newer one to be updated.
        let mut encoded = RemoteMessage::Hello(RemoteHello {
            protocol_version: PROTOCOL_VERSION,
            agent_name: "Workshop".to_string(),
            // A terminal hello carries a character grid, not pixels.
            width: 120,
            height: 40,
            view_only: true,
            file_transfer: false,
            file_root_label: String::new(),
            file_edit: false,
            terminal: true,
        })
        .encode()
        .unwrap();
        // Whatever a later version appends after the fields this build knows.
        encoded.extend_from_slice(&[0, 7, 42, 200]);

        let RemoteMessage::Hello(decoded) = RemoteMessage::decode(&encoded).unwrap() else {
            panic!("expected a hello");
        };
        assert_eq!(decoded.agent_name, "Workshop");
        assert!(decoded.terminal);
        assert!(decoded.view_only);
    }

    #[test]
    fn terminal_hello_flag_is_a_trailing_byte_only_when_set() {
        // A screen-mode hello must stay byte-identical to protocol v2, so a
        // viewer without terminal support keeps decoding it.
        let screen = RemoteMessage::Hello(RemoteHello {
            protocol_version: PROTOCOL_VERSION,
            agent_name: "Studio Mac".into(),
            width: 1280,
            height: 720,
            view_only: true,
            file_transfer: false,
            file_root_label: String::new(),
            file_edit: false,
            terminal: false,
        })
        .encode()
        .unwrap();
        assert_eq!(screen.len(), 1 + 16 + "Studio Mac".len());

        let terminal = RemoteMessage::Hello(RemoteHello {
            protocol_version: PROTOCOL_VERSION,
            agent_name: "Studio Mac".into(),
            width: 120,
            height: 32,
            view_only: false,
            file_transfer: false,
            file_root_label: String::new(),
            file_edit: false,
            terminal: true,
        })
        .encode()
        .unwrap();
        assert_eq!(terminal.len(), screen.len() + 1);
    }

    #[test]
    fn text_capability_defaults_off_for_old_hosts_and_requires_file_sharing() {
        let mut hello = RemoteHello {
            protocol_version: PROTOCOL_VERSION,
            agent_name: "Editor host".into(),
            width: 640,
            height: 480,
            view_only: true,
            file_transfer: true,
            file_root_label: "Shared".into(),
            terminal: false,
            file_edit: false,
        };
        let legacy = RemoteMessage::Hello(hello.clone()).encode().unwrap();
        assert_eq!(
            RemoteMessage::decode(&legacy).unwrap(),
            RemoteMessage::Hello(hello.clone())
        );
        hello.file_edit = true;
        let current = RemoteMessage::Hello(hello.clone()).encode().unwrap();
        assert_eq!(current.len(), legacy.len() + 2);
        assert_eq!(&current[..legacy.len()], legacy.as_slice());
        assert_eq!(&current[legacy.len()..], &[0, 1]);
        assert_eq!(
            RemoteMessage::decode(&current).unwrap(),
            RemoteMessage::Hello(hello.clone())
        );
        hello.file_transfer = false;
        hello.file_root_label.clear();
        assert!(RemoteMessage::Hello(hello).encode().is_err());
        let mut invalid_flag = current;
        *invalid_flag.last_mut().unwrap() = 2;
        assert!(RemoteMessage::decode(&invalid_flag).is_err());
    }

    #[test]
    fn text_protocol_rejects_oversized_requests_responses_and_unsafe_backup_paths() {
        let valid = RemoteMessage::FileRequest(RemoteFileRequest::SaveTextStart {
            transfer_id: 17,
            path: "/note.txt".into(),
            size: MAX_TEXT_FILE_BYTES as u64,
            expected_revision: [9; 32],
        });
        let encoded = valid.encode().unwrap();
        for length in 0..encoded.len() {
            assert!(RemoteMessage::decode(&encoded[..length]).is_err());
        }
        let mut oversized = encoded;
        oversized[10..18].copy_from_slice(&(MAX_TEXT_FILE_BYTES as u64 + 1).to_be_bytes());
        assert!(RemoteMessage::decode(&oversized).is_err());
        assert!(RemoteMessage::FileResponse(RemoteFileResponse::TextStart {
            request_id: 17,
            size: MAX_TEXT_FILE_BYTES as u64 + 1,
            revision: [0; 32],
        })
        .encode()
        .is_err());
        for backup_path in ["/", "/../outside", "/folder//note", "/bad\0name"] {
            assert!(RemoteMessage::FileResponse(RemoteFileResponse::TextSaved {
                transfer_id: 17,
                revision: [0; 32],
                backup_path: backup_path.into(),
            })
            .encode()
            .is_err());
        }
    }

    #[test]
    fn rejects_malformed_terminal_messages() {
        assert!(RemoteMessage::TerminalData { bytes: Vec::new() }
            .encode()
            .is_err());
        assert!(RemoteMessage::TerminalInput {
            bytes: vec![0; TERMINAL_CHUNK_SIZE + 1],
        }
        .encode()
        .is_err());
        assert!(RemoteMessage::TerminalResize { cols: 0, rows: 24 }
            .encode()
            .is_err());
        assert!(RemoteMessage::TerminalResize {
            cols: MAX_TERMINAL_DIMENSION + 1,
            rows: 24,
        }
        .encode()
        .is_err());
        // A terminal hello carries a character grid, not pixel dimensions.
        assert!(RemoteMessage::Hello(RemoteHello {
            protocol_version: PROTOCOL_VERSION,
            agent_name: "Headless box".into(),
            width: u32::from(MAX_TERMINAL_DIMENSION) + 1,
            height: 32,
            view_only: false,
            file_transfer: false,
            file_root_label: String::new(),
            file_edit: false,
            terminal: true,
        })
        .encode()
        .is_err());
    }

    #[test]
    fn file_workspace_messages_round_trip() {
        let messages = vec![
            RemoteMessage::FileRequest(RemoteFileRequest::ReadText {
                request_id: 11,
                path: "/docs/note.txt".into(),
            }),
            RemoteMessage::FileRequest(RemoteFileRequest::SaveTextStart {
                transfer_id: 12,
                path: "/docs/note.txt".into(),
                size: MAX_TEXT_FILE_BYTES as u64,
                expected_revision: [0x42; 32],
            }),
            RemoteMessage::FileResponse(RemoteFileResponse::TextStart {
                request_id: 11,
                size: MAX_TEXT_FILE_BYTES as u64,
                revision: [0x42; 32],
            }),
            RemoteMessage::FileResponse(RemoteFileResponse::TextSaved {
                transfer_id: 12,
                revision: [0x84; 32],
                backup_path: "/docs/.latticeterm-edit-backup-test/note.txt".into(),
            }),
            RemoteMessage::FileRequest(RemoteFileRequest::List {
                request_id: 1,
                path: "/docs".into(),
            }),
            RemoteMessage::FileRequest(RemoteFileRequest::UploadStart {
                transfer_id: 2,
                path: "/docs/report.bin".into(),
                size: 3,
                overwrite: true,
            }),
            RemoteMessage::FileRequest(RemoteFileRequest::UploadChunk {
                transfer_id: 2,
                bytes: vec![0, 128, 255],
            }),
            RemoteMessage::FileResponse(RemoteFileResponse::ListEntry {
                request_id: 1,
                entry: RemoteFileEntry {
                    name: "report.bin".into(),
                    path: "/docs/report.bin".into(),
                    kind: RemoteFileKind::File,
                    size: 3,
                    modified_at: Some(123),
                },
            }),
            RemoteMessage::FileResponse(RemoteFileResponse::DownloadStart {
                transfer_id: 3,
                name: "report.bin".into(),
                size: 3,
            }),
            RemoteMessage::FileResponse(RemoteFileResponse::DownloadChunk {
                transfer_id: 3,
                bytes: vec![0, 128, 255],
            }),
            RemoteMessage::FileResponse(RemoteFileResponse::Complete { transfer_id: 3 }),
        ];
        for message in messages {
            assert_eq!(
                RemoteMessage::decode(&message.encode().unwrap()).unwrap(),
                message
            );
        }
    }

    #[test]
    fn file_workspace_rejects_traversal_and_oversized_chunks() {
        assert!(RemoteMessage::FileRequest(RemoteFileRequest::List {
            request_id: 1,
            path: "/../secret".into(),
        })
        .encode()
        .is_err());
        assert!(RemoteMessage::FileRequest(RemoteFileRequest::UploadChunk {
            transfer_id: 2,
            bytes: vec![0; FILE_CHUNK_SIZE + 1],
        })
        .encode()
        .is_err());
        assert!(
            RemoteMessage::FileResponse(RemoteFileResponse::DownloadStart {
                transfer_id: 3,
                name: "..".into(),
                size: 1,
            })
            .encode()
            .is_err()
        );
    }

    #[test]
    fn rejects_unsafe_hello_metadata_on_encode_and_decode() {
        let oversized_name = RemoteMessage::Hello(RemoteHello {
            protocol_version: PROTOCOL_VERSION,
            agent_name: "a".repeat(MAX_AGENT_NAME_BYTES + 1),
            width: 1280,
            height: 720,
            view_only: true,
            file_transfer: false,
            file_root_label: String::new(),
            file_edit: false,
            terminal: false,
        });
        assert_eq!(oversized_name.encode(), Err(ProtocolError::InvalidHello));

        let control_name = RemoteMessage::Hello(RemoteHello {
            protocol_version: PROTOCOL_VERSION,
            agent_name: "host\nname".into(),
            width: 1280,
            height: 720,
            view_only: true,
            file_transfer: false,
            file_root_label: String::new(),
            file_edit: false,
            terminal: false,
        });
        assert_eq!(control_name.encode(), Err(ProtocolError::InvalidHello));

        let mut oversized_dimensions = RemoteMessage::Hello(RemoteHello {
            protocol_version: PROTOCOL_VERSION,
            agent_name: "Studio Mac".into(),
            width: 1280,
            height: 720,
            view_only: true,
            file_transfer: false,
            file_root_label: String::new(),
            file_edit: false,
            terminal: false,
        })
        .encode()
        .unwrap();
        oversized_dimensions[3..7].copy_from_slice(&(MAX_FRAME_DIMENSION + 1).to_be_bytes());
        assert_eq!(
            RemoteMessage::decode(&oversized_dimensions),
            Err(ProtocolError::InvalidHello)
        );
    }

    #[test]
    fn rejects_unsafe_frame_dimensions_before_assembly() {
        let one_pixel = [0x5a];
        assert!(
            frame_messages(1, MAX_FRAME_DIMENSION + 1, 1, FrameFormat::Jpeg, &one_pixel,).is_err()
        );
        assert!(frame_messages(
            1,
            MAX_FRAME_DIMENSION,
            (MAX_FRAME_PIXELS / u64::from(MAX_FRAME_DIMENSION)) as u32 + 1,
            FrameFormat::Jpeg,
            &one_pixel,
        )
        .is_err());
        assert!(frame_messages(1, 8192, 4096, FrameFormat::Jpeg, &one_pixel).is_ok());

        let mut invalid_wire = RemoteMessage::FrameStart(FrameDescriptor {
            frame_id: 1,
            width: 1280,
            height: 720,
            encoded_len: 1,
            chunk_count: 1,
            format: FrameFormat::Jpeg,
        })
        .encode()
        .unwrap();
        invalid_wire[9..13].copy_from_slice(&(MAX_FRAME_DIMENSION + 1).to_be_bytes());
        assert_eq!(
            RemoteMessage::decode(&invalid_wire),
            Err(ProtocolError::InvalidMessage("invalid frame descriptor"))
        );
    }

    #[test]
    fn enforces_close_reason_limit_on_send_and_receive() {
        let reason = "x".repeat(MAX_CLOSE_REASON_BYTES + 1);
        assert_eq!(
            RemoteMessage::Close(reason.clone()).encode(),
            Err(ProtocolError::InvalidMessage("close reason is too long"))
        );

        let mut wire = vec![MESSAGE_CLOSE];
        wire.extend_from_slice(reason.as_bytes());
        assert_eq!(
            RemoteMessage::decode(&wire),
            Err(ProtocolError::InvalidMessage("close reason is too long"))
        );
    }

    #[test]
    fn chunks_and_reassembles_a_large_frame() {
        let original = vec![0x5a; FRAME_CHUNK_SIZE * 2 + 17];
        let messages = frame_messages(7, 1280, 720, FrameFormat::Jpeg, &original).unwrap();
        assert_eq!(messages.len(), 4);

        let mut assembler = FrameAssembler::new();
        let mut complete = None;
        for message in messages {
            complete = assembler.push(message).unwrap().or(complete);
        }
        let complete = complete.expect("frame should complete");
        assert_eq!(complete.frame_id, 7);
        assert_eq!(complete.bytes, original);
    }

    #[test]
    fn rejects_out_of_order_chunks() {
        let original = vec![1; FRAME_CHUNK_SIZE + 1];
        let mut messages = frame_messages(1, 10, 10, FrameFormat::Jpeg, &original).unwrap();
        let mut assembler = FrameAssembler::new();
        assembler.push(messages.remove(0)).unwrap();
        let second_chunk = messages.remove(1);
        assert_eq!(
            assembler.push(second_chunk),
            Err(ProtocolError::UnexpectedChunk)
        );
    }

    #[test]
    fn input_messages_round_trip() {
        let inputs = [
            RemoteInput::MouseMove { x: 0, y: 719 },
            RemoteInput::MouseMove {
                x: u16::MAX,
                y: u16::MAX,
            },
            RemoteInput::MouseButton {
                button: PointerButton::Left,
                pressed: true,
            },
            RemoteInput::MouseButton {
                button: PointerButton::Right,
                pressed: false,
            },
            RemoteInput::Wheel {
                horizontal: false,
                units: -3,
            },
            RemoteInput::Key {
                keysym: 0x01000000 + 0x4e2d, // '中' beyond Latin-1
                pressed: true,
            },
            RemoteInput::ReleaseAll,
        ];
        for input in inputs {
            let message = RemoteMessage::Input(input);
            assert_eq!(
                RemoteMessage::decode(&message.encode().unwrap()).unwrap(),
                message
            );
        }
    }

    #[test]
    fn rejects_malformed_input_messages() {
        assert_eq!(
            RemoteMessage::Input(RemoteInput::Wheel {
                horizontal: true,
                units: 0,
            })
            .encode(),
            Err(ProtocolError::InvalidMessage("wheel units out of range"))
        );
        assert_eq!(
            RemoteMessage::Input(RemoteInput::Wheel {
                horizontal: true,
                units: MAX_WHEEL_UNITS + 1,
            })
            .encode(),
            Err(ProtocolError::InvalidMessage("wheel units out of range"))
        );

        // Unknown subkind, truncated body, bad button, non-binary boolean.
        for wire in [
            vec![6u8, 9],
            vec![6u8, 1, 0, 0, 0],
            vec![6u8, 2, 3, 1],
            vec![6u8, 2, 0, 2],
            vec![6u8],
        ] {
            assert!(RemoteMessage::decode(&wire).is_err(), "wire {wire:?}");
        }
    }

    #[test]
    fn refuses_oversized_frames() {
        let bytes = vec![0; MAX_FRAME_BYTES + 1];
        assert_eq!(
            frame_messages(1, 10, 10, FrameFormat::Jpeg, &bytes),
            Err(ProtocolError::FrameTooLarge(MAX_FRAME_BYTES + 1))
        );
    }
}
