//! Lattice Remote.
//!
//! The protocol keeps a narrow boundary: an end-to-end encrypted transport
//! over direct TCP or a blind relay, pairing-code authentication, and JPEG
//! frames. Input injection and access to one shared file root are separately
//! opt-in per share. The optional relay only matches a viewer to a device ID
//! and forwards ciphertext; it never sees pairing codes or frame contents.

pub mod chat_protocol;
pub mod command_protocol;
pub mod credentials;
pub mod device_pins;
#[cfg(feature = "agent")]
pub mod host_commands;
#[cfg(feature = "agent")]
pub mod host_files;
#[cfg(feature = "agent")]
pub mod host_input;
#[cfg(feature = "agent")]
pub mod host_text;
pub mod pairing_limit;
mod password_pairing;
mod protocol;
pub mod relay;
#[cfg(feature = "relay-server")]
pub mod relay_server;
mod secure;
pub mod transport;
mod wire;

pub use protocol::{
    frame_messages, negotiate_protocol_version, CompleteFrame, FrameAssembler, FrameDescriptor,
    FrameFormat, PointerButton, ProtocolError, ProtocolMismatch, RemoteFileEntry, RemoteFileKind,
    RemoteFileRequest, RemoteFileResponse, RemoteHello, RemoteInput, RemoteMessage, DEFAULT_PORT,
    FILE_CHUNK_SIZE, FRAME_CHUNK_SIZE, MAX_AGENT_NAME_BYTES, MAX_CLOSE_REASON_BYTES,
    MAX_DIRECTORY_ENTRIES, MAX_FILE_ERROR_BYTES, MAX_FILE_ROOT_LABEL_BYTES, MAX_FRAME_BYTES,
    MAX_FRAME_DIMENSION, MAX_FRAME_PIXELS, MAX_REMOTE_PATH_BYTES, MAX_TEXT_FILE_BYTES,
    MAX_WHEEL_UNITS, MIN_COMPATIBLE_PROTOCOL_VERSION, PROTOCOL_VERSION,
};
pub use secure::{
    format_pairing_code, generate_pairing_code, normalize_legacy_pairing_code,
    normalize_pairing_code, normalize_viewer_pairing_code, RemoteError, SecureConnection,
    SecureReader, SecureWriter,
};
pub use transport::Transport;
