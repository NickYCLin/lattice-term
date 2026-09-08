//! The user-private local socket under the daemon protocol.
//!
//! Unix: a socket file in a user-private runtime directory, mode 0600. The
//! directory is the user's own, and a stale file left by a crashed daemon is
//! replaced only after a connect attempt proves nobody is listening.
//! Windows: a named pipe whose name is derived from the data directory; the
//! token exchanged in `Hello` is what keeps it private there.

use super::DaemonPaths;
use std::io;

#[cfg(unix)]
#[allow(unused_imports)]
pub use unix::{accept, bind, connect, ClientStream};
#[cfg(windows)]
#[allow(unused_imports)]
pub use windows::{accept, bind, connect, ClientStream};

#[cfg(unix)]
mod unix {
    use super::*;
    use tokio::net::{UnixListener, UnixStream};

    pub type Listener = UnixListener;
    pub type Stream = UnixStream;
    #[allow(dead_code)]
    pub type ClientStream = UnixStream;

    /// The socket's directory must be ours alone: created 0700, and if it
    /// already exists it has to be a real directory owned by this user with
    /// no group or world bits, or a stranger could plant a socket there.
    fn prepare_private_dir(dir: &std::path::Path) -> io::Result<()> {
        use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
        if let Err(error) = std::fs::DirBuilder::new().mode(0o700).create(dir) {
            if error.kind() != io::ErrorKind::AlreadyExists {
                return Err(error);
            }
        }
        let metadata = std::fs::symlink_metadata(dir)?;
        // SAFETY: geteuid has no preconditions and cannot fail.
        let uid = unsafe { libc::geteuid() };
        if !metadata.is_dir() || metadata.uid() != uid || metadata.permissions().mode() & 0o077 != 0
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("{} is not a private directory of this user", dir.display()),
            ));
        }
        Ok(())
    }

    pub async fn bind(paths: &DaemonPaths) -> io::Result<Listener> {
        std::fs::create_dir_all(&paths.data_dir)?;
        if let Some(dir) = paths.socket.parent() {
            prepare_private_dir(dir)?;
        }
        if paths.socket.exists() {
            if UnixStream::connect(&paths.socket).await.is_ok() {
                return Err(io::Error::new(
                    io::ErrorKind::AddrInUse,
                    "another Lattice Agent daemon is already listening",
                ));
            }
            std::fs::remove_file(&paths.socket)?;
        }
        let listener = UnixListener::bind(&paths.socket)?;
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&paths.socket, std::fs::Permissions::from_mode(0o600))?;
        Ok(listener)
    }

    pub async fn accept(listener: &mut Listener) -> io::Result<Stream> {
        listener.accept().await.map(|(stream, _)| stream)
    }

    pub async fn connect(paths: &DaemonPaths) -> io::Result<Stream> {
        use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
        let directory = paths.socket.parent().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "missing daemon socket directory",
            )
        })?;
        prepare_private_dir(directory)?;
        let metadata = std::fs::symlink_metadata(&paths.socket)?;
        // SAFETY: geteuid has no preconditions.
        let uid = unsafe { libc::geteuid() };
        if !metadata.file_type().is_socket()
            || metadata.uid() != uid
            || metadata.permissions().mode() & 0o077 != 0
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "the daemon socket is not private to this user",
            ));
        }
        let stream = UnixStream::connect(&paths.socket).await?;
        if stream.peer_cred()?.uid() != uid {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "the daemon peer belongs to another user",
            ));
        }
        Ok(stream)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::unix::fs::{symlink, PermissionsExt};

        #[tokio::test]
        async fn daemon_attachment_rejects_untrusted_path_shapes_before_connecting() {
            let directory = tempfile::tempdir().unwrap();
            let mut paths = DaemonPaths::new(directory.path());
            let private = directory.path().join("private");
            std::fs::create_dir(&private).unwrap();
            std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o700)).unwrap();
            paths.socket = private.join("daemon.sock");
            let listener = UnixListener::bind(&paths.socket).unwrap();
            std::fs::set_permissions(&paths.socket, std::fs::Permissions::from_mode(0o600))
                .unwrap();
            let stream = connect(&paths).await.unwrap();
            drop(stream);
            std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o755)).unwrap();
            assert!(connect(&paths).await.is_err());
            std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o700)).unwrap();
            let link = private.join("redirect.sock");
            symlink(&paths.socket, &link).unwrap();
            paths.socket = link;
            assert!(connect(&paths).await.is_err());
            drop(listener);
        }
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeServer, ServerOptions};

    pub struct Listener {
        name: String,
        next: Option<NamedPipeServer>,
    }

    /// Both ends of a pipe implement AsyncRead + AsyncWrite; the server side
    /// is what `accept` yields, so that is the stream type on this platform.
    pub type Stream = NamedPipeServer;

    pub async fn bind(paths: &DaemonPaths) -> io::Result<Listener> {
        std::fs::create_dir_all(&paths.data_dir)?;
        let name = paths.pipe_name();
        // Refusing to be the second instance is what makes the pipe a lock.
        let first = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&name)?;
        Ok(Listener {
            name,
            next: Some(first),
        })
    }

    pub async fn accept(listener: &mut Listener) -> io::Result<Stream> {
        if listener.next.is_none() {
            listener.next = Some(ServerOptions::new().create(&listener.name)?);
        }
        // `serve` races this future against its timer and shutdown signal.
        // Keep the pipe owned by Listener while awaiting: taking it first
        // would drop even an already connected client when select cancels us.
        let connecting = listener
            .next
            .as_ref()
            .ok_or_else(|| io::Error::other("the pending daemon pipe was not initialized"))?;
        if let Err(error) = connecting.connect().await {
            listener.next = None;
            return Err(error);
        }
        let server = listener
            .next
            .take()
            .ok_or_else(|| io::Error::other("the connected daemon pipe was not retained"))?;
        // Have the next instance ready before handing this one out so a
        // client arriving meanwhile finds a pipe to connect to.
        listener.next = ServerOptions::new().create(&listener.name).ok();
        Ok(server)
    }

    pub type ClientStream = tokio::net::windows::named_pipe::NamedPipeClient;

    pub async fn connect(paths: &DaemonPaths) -> io::Result<ClientStream> {
        let name = paths.pipe_name();
        match connect_named_pipe(&name).await {
            // Only absence permits fallback. Do not hide access-denied or a
            // busy current daemon by attaching to a different instance.
            Err(error) if error.raw_os_error() == Some(2) => {
                let legacy = paths.legacy_pipe_name();
                if legacy == name {
                    return Err(error);
                }
                connect_named_pipe(&legacy).await
            }
            result => result,
        }
    }

    async fn connect_named_pipe(name: &str) -> io::Result<ClientStream> {
        let mut attempts = 0;
        loop {
            match ClientOptions::new().open(name) {
                Ok(client) => return Ok(client),
                // ERROR_PIPE_BUSY: every instance is mid-connect; wait a moment.
                Err(error) if error.raw_os_error() == Some(231) && attempts < 20 => {
                    attempts += 1;
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
                Err(error) => return Err(error),
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[tokio::test]
        async fn cancelling_accept_preserves_a_connected_client_for_the_next_poll() {
            use std::time::Duration;
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let dir = tempfile::tempdir().unwrap();
            let paths = DaemonPaths::new(dir.path());
            let mut listener = bind(&paths).await.unwrap();
            let mut accepting = Box::pin(accept(&mut listener));
            // Poll once so accept is waiting on ConnectNamedPipe. Keep that
            // future alive until a client has actually connected to its pipe.
            assert!(
                tokio::time::timeout(Duration::from_millis(10), &mut accepting)
                    .await
                    .is_err()
            );
            let mut client = connect(&paths).await.unwrap();
            // Equivalent to the daemon's ticker winning tokio::select! before
            // the now-ready accept branch is polled again.
            drop(accepting);
            let mut server = tokio::time::timeout(Duration::from_secs(2), accept(&mut listener))
                .await
                .expect("the pending client must survive cancellation")
                .unwrap();
            client.write_all(b"still connected").await.unwrap();
            let mut received = [0; 15];
            tokio::time::timeout(Duration::from_secs(2), server.read_exact(&mut received))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(&received, b"still connected");
            server.write_all(b"ok").await.unwrap();
            let mut reply = [0; 2];
            tokio::time::timeout(Duration::from_secs(2), client.read_exact(&mut reply))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(&reply, b"ok");
        }

        #[tokio::test]
        async fn a_client_reaches_the_legacy_pipe_without_replacing_it() {
            let dir = tempfile::tempdir().unwrap();
            let paths = DaemonPaths::new(&dir.path().join("Legacy Data"));
            std::fs::create_dir_all(&paths.data_dir).unwrap();
            assert_ne!(paths.pipe_name(), paths.legacy_pipe_name());
            let old = ServerOptions::new()
                .first_pipe_instance(true)
                .create(paths.legacy_pipe_name())
                .unwrap();
            let connection = connect(&paths).await.unwrap();
            old.connect().await.unwrap();
            drop(connection);
            // The fallback did not bind a second daemon at the new name.
            assert_eq!(
                ClientOptions::new()
                    .open(paths.pipe_name())
                    .unwrap_err()
                    .raw_os_error(),
                Some(2)
            );
        }
    }
}
