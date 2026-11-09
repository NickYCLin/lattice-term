//! Explicitly enabled, session-owned forwarding with bounded queues.
use crate::tcp_protocol::{TcpMessage, CHUNK_BYTES, MAX_STREAMS};
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

struct Stream {
    input: mpsc::Sender<TcpMessage>,
    worker: JoinHandle<()>,
}
impl Drop for Stream {
    fn drop(&mut self) {
        self.worker.abort();
    }
}

pub struct TcpForwards {
    allowed: bool,
    streams: HashMap<u32, Stream>,
    seen: HashSet<u32>,
    highest: u32,
    outgoing: mpsc::Sender<TcpMessage>,
    bridge: Option<JoinHandle<()>>,
}

impl TcpForwards {
    pub fn new(allowed: bool, outgoing: mpsc::Sender<TcpMessage>) -> Self {
        Self {
            allowed,
            outgoing,
            streams: HashMap::new(),
            seen: HashSet::new(),
            highest: 0,
            bridge: None,
        }
    }

    pub fn remote(allowed: bool, outgoing: mpsc::Sender<crate::RemoteMessage>) -> Self {
        let (sender, mut receiver) = mpsc::channel(16);
        let mut result = Self::new(allowed, sender);
        result.bridge = Some(tokio::spawn(async move {
            while let Some(message) = receiver.recv().await {
                if outgoing
                    .send(crate::RemoteMessage::Tcp(message))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        }));
        result
    }

    pub async fn handle(&mut self, message: TcpMessage) -> bool {
        let id = message.id();
        self.streams
            .retain(|_, stream| !stream.worker.is_finished());
        if !self.allowed || !message.valid() {
            return self.outgoing.send(TcpMessage::Failed { id }).await.is_ok();
        }
        match message {
            TcpMessage::Open { host, port, .. } => {
                if self.streams.len() >= MAX_STREAMS || !self.record_id(id) {
                    return self.outgoing.send(TcpMessage::Failed { id }).await.is_ok();
                }
                let (input, receiver) = mpsc::channel(8);
                let outgoing = self.outgoing.clone();
                let worker = tokio::spawn(async move {
                    let result = tokio::time::timeout(
                        Duration::from_secs(10),
                        TcpStream::connect((host.as_str(), port)),
                    )
                    .await;
                    match result {
                        Ok(Ok(socket)) => {
                            if outgoing.send(TcpMessage::Opened { id }).await.is_ok() {
                                pump(id, socket, receiver, &outgoing).await;
                            }
                        }
                        _ => {
                            let _ = outgoing.send(TcpMessage::Failed { id }).await;
                        }
                    }
                });
                self.streams.insert(id, Stream { input, worker });
            }
            TcpMessage::Close { .. } => {
                self.streams.remove(&id);
                return self.outgoing.send(TcpMessage::Closed { id }).await.is_ok();
            }
            message @ (TcpMessage::Data { .. } | TcpMessage::Eof { .. }) => {
                let accepted = self
                    .streams
                    .get(&id)
                    .is_some_and(|s| s.input.try_send(message).is_ok());
                if !accepted {
                    self.streams.remove(&id);
                    return self.outgoing.send(TcpMessage::Failed { id }).await.is_ok();
                }
            }
            _ => return false,
        }
        true
    }

    fn record_id(&mut self, id: u32) -> bool {
        let floor = self.highest.saturating_sub(1024);
        if id <= floor || self.seen.contains(&id) {
            return false;
        }
        self.highest = self.highest.max(id);
        let floor = self.highest.saturating_sub(1024);
        self.seen.retain(|id| *id > floor);
        self.seen.insert(id);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn long_lived_sessions_keep_replay_history_bounded_without_a_query_limit() {
        let (outgoing, _) = mpsc::channel(1);
        let mut forwards = TcpForwards::new(true, outgoing);
        assert!(forwards.record_id(2));
        assert!(forwards.record_id(1));
        assert!(!forwards.record_id(2));
        for id in 3..10_000 {
            assert!(forwards.record_id(id));
        }
        assert!(forwards.seen.len() <= 1024);
        assert!(!forwards.record_id(1));
        assert!(!forwards.record_id(9_999));
    }
}

impl Drop for TcpForwards {
    fn drop(&mut self) {
        self.streams.clear();
        if let Some(bridge) = self.bridge.take() {
            bridge.abort();
        }
    }
}

async fn pump(
    id: u32,
    socket: TcpStream,
    mut input: mpsc::Receiver<TcpMessage>,
    outgoing: &mpsc::Sender<TcpMessage>,
) {
    let (mut read, mut write) = socket.into_split();
    let mut buffer = vec![0; CHUNK_BYTES];
    let mut read_eof = false;
    let mut write_eof = false;
    let result: Result<(), ()> = async {
        while !read_eof || !write_eof {
            tokio::select! {
                message = input.recv() => match message {
                    Some(TcpMessage::Data { bytes, .. }) if !write_eof => write.write_all(&bytes).await.map_err(|_| ())?,
                    Some(TcpMessage::Eof { .. }) if !write_eof => { write.shutdown().await.map_err(|_| ())?; write_eof = true; }
                    _ => return Err(()),
                },
                result = read.read(&mut buffer), if !read_eof => {
                    let count = result.map_err(|_| ())?;
                    let event = if count == 0 { read_eof = true; TcpMessage::Eof { id } }
                        else { TcpMessage::Data { id, bytes: buffer[..count].to_vec() } };
                    outgoing.send(event).await.map_err(|_| ())?;
                }
            }
        }
        Ok(())
    }.await;
    let event = if result.is_ok() {
        TcpMessage::Closed { id }
    } else {
        TcpMessage::Failed { id }
    };
    let _ = outgoing.send(event).await;
}
