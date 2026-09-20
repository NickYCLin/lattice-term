//! Byte-stream transports used by the relay protocol.
//!
//! Native deployments keep using raw TCP. WebSocket binary frames let the
//! same byte stream travel through ordinary HTTPS ingress such as Cloudflare
//! Tunnel without exposing another public port. The relay protocol and Noise
//! layer above this module see identical ordered bytes on either carrier.

use futures_util::{SinkExt as _, StreamExt as _};
use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{ready, Context, Poll};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::error::ProtocolError;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::protocol::{Message, WebSocketConfig};
use tokio_tungstenite::tungstenite::Error as WsError;
use tokio_tungstenite::{
    accept_async_with_config, accept_hdr_async_with_config, connect_async_with_config,
    WebSocketStream,
};

const MAX_WEBSOCKET_MESSAGE_BYTES: usize = 128 * 1024;
const MAX_WEBSOCKET_WRITE_BUFFER_BYTES: usize = 256 * 1024;

fn websocket_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_write_buffer_size(MAX_WEBSOCKET_WRITE_BUFFER_BYTES)
        .max_message_size(Some(MAX_WEBSOCKET_MESSAGE_BYTES))
        .max_frame_size(Some(MAX_WEBSOCKET_MESSAGE_BYTES))
}

/// Probes a quiet connection so a peer that vanished without closing its
/// socket becomes a read or write error instead of an endless wait. Best
/// effort: a platform that refuses the option keeps the plain socket.
pub fn set_keepalive(stream: &TcpStream) {
    let keepalive = socket2::TcpKeepalive::new()
        .with_time(Duration::from_secs(30))
        .with_interval(Duration::from_secs(10));
    #[cfg(not(any(target_os = "windows", target_os = "openbsd")))]
    let keepalive = keepalive.with_retries(3);
    let _ = socket2::SockRef::from(stream).set_tcp_keepalive(&keepalive);
}

/// A byte stream that carries relay control messages and encrypted sessions.
pub enum Transport {
    Tcp(TcpStream),
    /// Boxed so client-side TLS and server-side plaintext WebSockets share one
    /// type while still implementing Tokio's byte-stream traits.
    WebSocket(Box<dyn ByteStream>),
}

pub trait ByteStream: AsyncRead + AsyncWrite + Unpin + Send {}

impl<T: AsyncRead + AsyncWrite + Unpin + Send> ByteStream for T {}

impl Transport {
    pub fn is_websocket_endpoint(endpoint: &str) -> bool {
        let lower = endpoint.to_ascii_lowercase();
        lower.starts_with("ws://") || lower.starts_with("wss://")
    }

    /// Connects to a normalized `HOST:PORT`, `ws://`, or `wss://` endpoint.
    pub async fn connect(endpoint: &str) -> io::Result<Self> {
        if Self::is_websocket_endpoint(endpoint) {
            let (socket, _response) =
                connect_async_with_config(endpoint, Some(websocket_config()), false)
                    .await
                    .map_err(handshake_error)?;
            Ok(Self::WebSocket(Box::new(WebSocketByteStream::new(socket))))
        } else {
            let stream = TcpStream::connect(endpoint).await?;
            stream.set_nodelay(true)?;
            set_keepalive(&stream);
            Ok(Self::Tcp(stream))
        }
    }

    /// Completes the server side of a WebSocket upgrade from HTTPS ingress.
    pub async fn accept_websocket(stream: TcpStream) -> io::Result<Self> {
        stream.set_nodelay(true)?;
        set_keepalive(&stream);
        let socket = accept_async_with_config(stream, Some(websocket_config()))
            .await
            .map_err(handshake_error)?;
        Ok(Self::WebSocket(Box::new(WebSocketByteStream::new(socket))))
    }

    /// Accepts an upgrade and reports one request header alongside the stream.
    ///
    /// A relay behind HTTPS ingress sees every public client as loopback, and
    /// the real address exists only in a header the proxy adds during the
    /// handshake. Nothing above this layer can recover it afterwards, so the
    /// value is captured while the request is still in hand.
    // The handshake callback's error type is tungstenite's own bulky
    // `ErrorResponse`, and this callback never builds one: it only reads a
    // header and returns the response it was handed.
    #[allow(clippy::result_large_err)]
    pub async fn accept_websocket_with_header(
        stream: TcpStream,
        header_name: &str,
    ) -> io::Result<(Self, Option<String>)> {
        stream.set_nodelay(true)?;
        set_keepalive(&stream);
        let captured = Arc::new(Mutex::new(None));
        let sink = Arc::clone(&captured);
        let wanted = header_name.to_owned();
        let socket = accept_hdr_async_with_config(
            stream,
            move |request: &Request, response: Response| {
                if let Ok(mut slot) = sink.lock() {
                    *slot = last_header_element(request, &wanted);
                }
                Ok(response)
            },
            Some(websocket_config()),
        )
        .await
        .map_err(handshake_error)?;
        let forwarded = captured.lock().ok().and_then(|mut slot| slot.take());
        Ok((
            Self::WebSocket(Box::new(WebSocketByteStream::new(socket))),
            forwarded,
        ))
    }
}

/// Reads the value a trusted proxy contributed to one request header.
///
/// A proxy that appends to an existing chain writes its own value last, so
/// taking the final element of the final occurrence keeps a client from
/// choosing the value by sending the header itself.
fn last_header_element(request: &Request, header_name: &str) -> Option<String> {
    let raw = request
        .headers()
        .get_all(header_name)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .next_back()?;
    let element = raw.rsplit(',').next()?.trim();
    (!element.is_empty()).then(|| element.to_owned())
}

impl From<TcpStream> for Transport {
    fn from(stream: TcpStream) -> Self {
        Self::Tcp(stream)
    }
}

macro_rules! delegate {
    ($self:ident, $stream:ident => $body:expr) => {
        match $self.get_mut() {
            Transport::Tcp($stream) => {
                let $stream = Pin::new($stream);
                $body
            }
            Transport::WebSocket($stream) => {
                let $stream = Pin::new($stream);
                $body
            }
        }
    };
}

impl AsyncRead for Transport {
    fn poll_read(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        delegate!(self, stream => stream.poll_read(context, buffer))
    }
}

impl AsyncWrite for Transport {
    fn poll_write(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        delegate!(self, stream => stream.poll_write(context, buffer))
    }

    fn poll_flush(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        delegate!(self, stream => stream.poll_flush(context))
    }

    fn poll_shutdown(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        delegate!(self, stream => stream.poll_shutdown(context))
    }
}

/// Presents ordered WebSocket binary frames as a continuous byte stream.
struct WebSocketByteStream<S> {
    socket: WebSocketStream<S>,
    pending: Vec<u8>,
    offset: usize,
}

impl<S> WebSocketByteStream<S> {
    fn new(socket: WebSocketStream<S>) -> Self {
        Self {
            socket,
            pending: Vec::new(),
            offset: 0,
        }
    }
}

impl<S> AsyncRead for WebSocketByteStream<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    fn poll_read(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        loop {
            if this.offset < this.pending.len() {
                let take = buffer.remaining().min(this.pending.len() - this.offset);
                buffer.put_slice(&this.pending[this.offset..this.offset + take]);
                this.offset += take;
                if this.offset == this.pending.len() {
                    this.pending.clear();
                    this.offset = 0;
                }
                return Poll::Ready(Ok(()));
            }
            match ready!(this.socket.poll_next_unpin(context)) {
                Some(Ok(Message::Binary(payload))) => {
                    if payload.is_empty() {
                        continue;
                    }
                    this.pending = payload.to_vec();
                    this.offset = 0;
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => continue,
                Some(Ok(Message::Close(_))) | None => return Poll::Ready(Ok(())),
                Some(Ok(Message::Text(_))) => {
                    return Poll::Ready(Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "the relay carries binary WebSocket frames only",
                    )))
                }
                Some(Err(error)) if is_peer_gone(&error) => return Poll::Ready(Ok(())),
                Some(Err(error)) => return Poll::Ready(Err(stream_error(error))),
            }
        }
    }
}

impl<S> AsyncWrite for WebSocketByteStream<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    fn poll_write(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        ready!(this.socket.poll_ready_unpin(context)).map_err(stream_error)?;
        this.socket
            .start_send_unpin(Message::Binary(buffer.to_vec().into()))
            .map_err(stream_error)?;
        Poll::Ready(Ok(buffer.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.get_mut()
            .socket
            .poll_flush_unpin(context)
            .map_err(stream_error)
    }

    fn poll_shutdown(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.get_mut()
            .socket
            .poll_close_unpin(context)
            .map_err(stream_error)
    }
}

fn is_peer_gone(error: &WsError) -> bool {
    matches!(
        error,
        WsError::ConnectionClosed
            | WsError::AlreadyClosed
            | WsError::Protocol(ProtocolError::ResetWithoutClosingHandshake)
    )
}

fn handshake_error(error: WsError) -> io::Error {
    io::Error::new(io::ErrorKind::ConnectionRefused, error)
}

fn stream_error(error: WsError) -> io::Error {
    match error {
        WsError::ConnectionClosed | WsError::AlreadyClosed => {
            io::Error::from(io::ErrorKind::BrokenPipe)
        }
        WsError::Io(error) => error,
        other => io::Error::other(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::{read_wire, write_wire, MAX_WIRE_MESSAGE};
    use tokio::io::{duplex, AsyncReadExt as _};
    use tokio_tungstenite::tungstenite::error::CapacityError;
    use tokio_tungstenite::tungstenite::protocol::Role;

    /// Runs a real upgrade against `accept_websocket_with_header` and reports
    /// what the server captured. The request is written by hand so a test can
    /// send header shapes a well-behaved client library would not.
    async fn captured_header(header_name: &str, request_headers: &str) -> Option<String> {
        use tokio::io::AsyncWriteExt as _;
        use tokio::net::{TcpListener, TcpStream};

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let name = header_name.to_owned();
        let server = tokio::spawn(async move {
            let (stream, _peer) = listener.accept().await.unwrap();
            Transport::accept_websocket_with_header(stream, &name)
                .await
                .map(|(_transport, forwarded)| forwarded)
        });

        let mut client = TcpStream::connect(address).await.unwrap();
        client
            .write_all(
                format!(
                    "GET / HTTP/1.1\r\nHost: relay.test\r\nUpgrade: websocket\r\n\
                     Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
                     Sec-WebSocket-Version: 13\r\n{request_headers}\r\n"
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        // Hold the socket open until the handshake completes.
        let captured = server.await.unwrap().unwrap();
        drop(client);
        captured
    }

    #[tokio::test]
    async fn the_forwarded_client_address_survives_the_handshake() {
        assert_eq!(
            captured_header("Cf-Connecting-Ip", "Cf-Connecting-Ip: 203.0.113.9\r\n").await,
            Some("203.0.113.9".to_string())
        );
        // Header lookup is case-insensitive, as HTTP requires.
        assert_eq!(
            captured_header("Cf-Connecting-Ip", "cf-connecting-ip: 203.0.113.9\r\n").await,
            Some("203.0.113.9".to_string())
        );
        assert_eq!(captured_header("Cf-Connecting-Ip", "").await, None);
    }

    #[tokio::test]
    async fn an_appending_proxy_overrides_what_the_client_sent() {
        // A client that writes its own chain first cannot outrank the value a
        // proxy appends, whether it arrives in the same header or another.
        assert_eq!(
            captured_header(
                "X-Forwarded-For",
                "X-Forwarded-For: 198.51.100.4, 203.0.113.9\r\n"
            )
            .await,
            Some("203.0.113.9".to_string())
        );
        assert_eq!(
            captured_header(
                "X-Forwarded-For",
                "X-Forwarded-For: 198.51.100.4\r\nX-Forwarded-For: 203.0.113.9\r\n"
            )
            .await,
            Some("203.0.113.9".to_string())
        );
    }

    #[test]
    fn websocket_config_caps_frames_and_messages_without_loosening_defaults() {
        let defaults = WebSocketConfig::default();
        let config = websocket_config();

        assert_eq!(config.max_message_size, Some(MAX_WEBSOCKET_MESSAGE_BYTES));
        assert_eq!(config.max_frame_size, Some(MAX_WEBSOCKET_MESSAGE_BYTES));
        assert_eq!(config.read_buffer_size, defaults.read_buffer_size);
        assert_eq!(config.write_buffer_size, defaults.write_buffer_size);
        assert_eq!(
            config.max_write_buffer_size,
            MAX_WEBSOCKET_WRITE_BUFFER_BYTES
        );
        assert_eq!(
            config.accept_unmasked_frames,
            defaults.accept_unmasked_frames
        );
    }

    #[tokio::test]
    async fn oversized_binary_frame_is_rejected_before_reaching_byte_stream() {
        let (client_io, server_io) = duplex(MAX_WEBSOCKET_MESSAGE_BYTES + 1024);
        let mut sender = WebSocketStream::from_raw_socket(client_io, Role::Client, None).await;
        let receiver =
            WebSocketStream::from_raw_socket(server_io, Role::Server, Some(websocket_config()))
                .await;
        let mut byte_stream = WebSocketByteStream::new(receiver);

        sender
            .send(Message::Binary(
                vec![0_u8; MAX_WEBSOCKET_MESSAGE_BYTES + 1].into(),
            ))
            .await
            .expect("the unrestricted peer should send the oversized frame");

        let mut byte = [0_u8; 1];
        let error = byte_stream
            .read(&mut byte)
            .await
            .expect_err("the configured receiver must reject the oversized frame");
        let websocket_error = error
            .get_ref()
            .and_then(|source| source.downcast_ref::<WsError>())
            .expect("the byte stream should preserve the WebSocket capacity error");

        assert!(matches!(
            websocket_error,
            WsError::Capacity(CapacityError::MessageTooLong { size, max_size })
                if *size == MAX_WEBSOCKET_MESSAGE_BYTES + 1
                    && *max_size == MAX_WEBSOCKET_MESSAGE_BYTES
        ));
    }

    #[tokio::test]
    async fn largest_valid_wire_message_crosses_the_configured_websocket() {
        let (client_io, server_io) = duplex(MAX_WIRE_MESSAGE + 2048);
        let client =
            WebSocketStream::from_raw_socket(client_io, Role::Client, Some(websocket_config()))
                .await;
        let server =
            WebSocketStream::from_raw_socket(server_io, Role::Server, Some(websocket_config()))
                .await;
        let mut writer = WebSocketByteStream::new(client);
        let mut reader = WebSocketByteStream::new(server);
        let expected = vec![0x5a; MAX_WIRE_MESSAGE];
        let send_bytes = expected.clone();

        let sending = tokio::spawn(async move {
            write_wire(&mut writer, &send_bytes).await.unwrap();
        });
        let received = read_wire(&mut reader).await.unwrap();
        sending.await.unwrap();

        assert_eq!(received, expected);
    }
}
