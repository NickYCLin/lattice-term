//! Viewer-side TCP streams. Each connector belongs to one authenticated session.
use crate::tcp_protocol::{TcpMessage, CHUNK_BYTES, MAX_STREAMS};
use crate::RemoteMessage;
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio::sync::mpsc;

pub struct ForwardedStream {
    socket: DuplexStream,
    worker: tokio::task::JoinHandle<()>,
}

#[cfg(all(test, feature = "agent"))]
mod tests {
    use super::*;
    use crate::{host_tcp::TcpForwards, SecureConnection};
    use tokio::net::TcpListener;

    struct Fixture {
        connector: Arc<TcpConnector>,
        tasks: Vec<tokio::task::JoinHandle<()>>,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.connector.close();
            for task in &self.tasks {
                task.abort();
            }
        }
    }
    async fn fixture(allowed: bool) -> Fixture {
        let code = crate::generate_pairing_code().unwrap();
        let (viewer, host) = tokio::io::duplex(128 * 1024);
        let (viewer, host) = tokio::join!(
            SecureConnection::initiate(viewer, &code),
            SecureConnection::accept(host, &code)
        );
        let (mut host_read, mut host_write) = host.unwrap().split();
        let (events, mut event_receiver) = mpsc::channel(16);
        let mut forwards = TcpForwards::new(allowed, events);
        let host = tokio::spawn(async move {
            loop {
                tokio::select! {
                    message = host_read.receive() => match message {
                        Ok(RemoteMessage::Tcp(message)) => if !forwards.handle(message).await { break; },
                        _ => break,
                    },
                    event = event_receiver.recv() => match event {
                        Some(event) => if host_write.send(&RemoteMessage::Tcp(event)).await.is_err() { break; },
                        None => break,
                    }
                }
            }
        });
        let (sender, mut receiver) = mpsc::channel(16);
        let connector = TcpConnector::new(sender);
        let (mut read, mut write) = viewer.unwrap().split();
        let writer = tokio::spawn(async move {
            while let Some(message) = receiver.recv().await {
                if write.send(&message).await.is_err() {
                    break;
                }
            }
        });
        let receiver_connector = connector.clone();
        let reader = tokio::spawn(async move {
            while let Ok(RemoteMessage::Tcp(message)) = read.receive().await {
                if !receiver_connector.receive(message) {
                    break;
                }
            }
            receiver_connector.close();
        });
        Fixture {
            connector,
            tasks: vec![host, reader, writer],
        }
    }

    #[tokio::test]
    async fn encrypted_tcp_preserves_bytes_and_half_close() {
        tokio::time::timeout(Duration::from_secs(15), async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let target = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = vec![];
                socket.read_to_end(&mut bytes).await.unwrap();
                assert_eq!(bytes, vec![0x5a; CHUNK_BYTES * 3]);
                socket.write_all(b"database-reply").await.unwrap();
                socket.shutdown().await.unwrap();
            });
            let fixture = fixture(true).await;
            let mut stream = fixture
                .connector
                .connect("127.0.0.1".into(), port)
                .await
                .unwrap();
            stream
                .write_all(&vec![0x5a; CHUNK_BYTES * 3])
                .await
                .unwrap();
            stream.shutdown().await.unwrap();
            let mut reply = vec![];
            stream.read_to_end(&mut reply).await.unwrap();
            assert_eq!(reply, b"database-reply");
            target.await.unwrap();
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn disabled_grant_never_connects_to_target() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = fixture(false).await;
        assert!(fixture
            .connector
            .connect("127.0.0.1".into(), listener.local_addr().unwrap().port())
            .await
            .is_err());
        assert!(
            tokio::time::timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn dropping_stream_closes_the_remote_socket() {
        tokio::time::timeout(Duration::from_secs(15), async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let fixture = fixture(true).await;
            let stream = fixture
                .connector
                .connect("127.0.0.1".into(), listener.local_addr().unwrap().port())
                .await
                .unwrap();
            let (mut socket, _) = listener.accept().await.unwrap();
            drop(stream);
            let mut byte = [0u8];
            assert_eq!(socket.read(&mut byte).await.unwrap(), 0);
        })
        .await
        .unwrap();
    }
}
impl Drop for ForwardedStream {
    fn drop(&mut self) {
        self.worker.abort();
    }
}
impl AsyncRead for ForwardedStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.socket).poll_read(cx, buffer)
    }
}
impl AsyncWrite for ForwardedStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.socket).poll_write(cx, bytes)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.socket).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.socket).poll_shutdown(cx)
    }
}

pub struct TcpConnector {
    outgoing: mpsc::Sender<RemoteMessage>,
    pending: Mutex<HashMap<u32, mpsc::Sender<TcpMessage>>>,
    next: AtomicU32,
    closed: AtomicBool,
    cancelled: tokio::sync::watch::Sender<bool>,
}
struct Lease {
    connector: Arc<TcpConnector>,
    id: u32,
}
impl Drop for Lease {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.connector.pending.lock() {
            pending.remove(&self.id);
        }
        // Failure to queue cancellation closes this connector; never reuse a
        // session with an unknown outstanding stream.
        if self
            .connector
            .outgoing
            .try_send(RemoteMessage::Tcp(TcpMessage::Close { id: self.id }))
            .is_err()
        {
            self.connector.close();
        }
    }
}
impl TcpConnector {
    pub fn new(outgoing: mpsc::Sender<RemoteMessage>) -> Arc<Self> {
        Arc::new(Self {
            outgoing,
            pending: Mutex::new(HashMap::new()),
            next: AtomicU32::new(1),
            closed: AtomicBool::new(false),
            cancelled: tokio::sync::watch::channel(false).0,
        })
    }
    pub fn cancellation(&self) -> tokio::sync::watch::Receiver<bool> {
        self.cancelled.subscribe()
    }
    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.cancelled.send_replace(true);
        if let Ok(mut pending) = self.pending.lock() {
            pending.clear();
        }
    }
    pub fn receive(&self, message: TcpMessage) -> bool {
        if !message.valid() || matches!(message, TcpMessage::Open { .. } | TcpMessage::Close { .. })
        {
            self.close();
            return false;
        }
        let Ok(mut pending) = self.pending.lock() else {
            return false;
        };
        if let Some(sender) = pending.get(&message.id()) {
            if sender.try_send(message.clone()).is_err() {
                pending.remove(&message.id());
                return false;
            }
        }
        true
    }
    pub async fn connect(
        self: &Arc<Self>,
        host: String,
        port: u16,
    ) -> Result<ForwardedStream, String> {
        let id = self.next.fetch_add(1, Ordering::AcqRel);
        let request = TcpMessage::Open { id, host, port };
        if !request.valid() || self.closed.load(Ordering::Acquire) {
            return Err("Remote database channel is unavailable.".into());
        }
        let (sender, mut receiver) = mpsc::channel(16);
        {
            let mut pending = self
                .pending
                .lock()
                .map_err(|_| "Remote database channel is unavailable.")?;
            if pending.len() >= MAX_STREAMS {
                return Err("Remote database channel is busy.".into());
            }
            pending.insert(id, sender);
        }
        let lease = Lease {
            connector: self.clone(),
            id,
        };
        let opened = tokio::time::timeout(Duration::from_secs(12), async {
            self.outgoing
                .send(RemoteMessage::Tcp(request))
                .await
                .map_err(|_| ())?;
            match receiver.recv().await {
                Some(TcpMessage::Opened { .. }) => Ok(()),
                _ => Err(()),
            }
        })
        .await;
        if !matches!(opened, Ok(Ok(()))) {
            return Err("The Remote host could not open the database endpoint.".into());
        }
        let (socket, mut worker) = tokio::io::duplex(CHUNK_BYTES * 2);
        let outgoing = self.outgoing.clone();
        let task = tokio::spawn(async move {
            let _lease = lease;
            let mut bytes = vec![0; CHUNK_BYTES];
            let (mut read, mut write) = tokio::io::split(&mut worker);
            let mut local_eof = false;
            loop {
                tokio::select! {
                    count = read.read(&mut bytes), if !local_eof => {
                        let Ok(count) = count else { break; };
                        let message = if count == 0 { local_eof = true; TcpMessage::Eof { id } }
                            else { TcpMessage::Data { id, bytes: bytes[..count].to_vec() } };
                        if outgoing.send(RemoteMessage::Tcp(message)).await.is_err() { break; }
                    }
                    message = receiver.recv() => match message {
                        Some(TcpMessage::Data { bytes, .. }) => if write.write_all(&bytes).await.is_err() { break; },
                        Some(TcpMessage::Eof { .. }) => { if write.shutdown().await.is_err() { break; } }
                        _ => break,
                    }
                }
            }
        });
        Ok(ForwardedStream {
            socket,
            worker: task,
        })
    }
}
