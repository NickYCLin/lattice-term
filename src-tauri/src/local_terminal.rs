//! Plain local shells for the chat window's terminal panel.
//!
//! Agent Fleet's PTYs carry a CLI catalog, reporters and integrations; a
//! conversation only needs the user's own shell in its working folder. Each
//! shell lives as long as its panel: closing the panel or quitting the app
//! ends it, and nothing it prints is stored.

use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

pub const EVENT_DATA: &str = "local-terminal-data";
pub const EVENT_EXIT: &str = "local-terminal-exit";
const MAX_TERMINALS: usize = 8;
const MAX_INPUT_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTerminalData {
    pub terminal_id: String,
    pub base64: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTerminalExit {
    pub terminal_id: String,
    pub code: Option<u32>,
}

/// Where the shell's output and end go; the app forwards them as events.
pub trait LocalTerminalSink: Send + Sync + 'static {
    fn data(&self, event: LocalTerminalData);
    fn exit(&self, event: LocalTerminalExit);
}

struct Entry {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

#[derive(Default)]
pub struct LocalTerminals {
    entries: Mutex<HashMap<String, Arc<Entry>>>,
    counter: AtomicU64,
}

/// The user's shell and its arguments. On Unix that is `$SHELL` as an
/// interactive login shell, so the panel sees the same PATH as a terminal
/// app; Windows gets PowerShell from the system directory, never from PATH.
fn shell() -> (PathBuf, Vec<&'static str>) {
    #[cfg(windows)]
    {
        let root = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        (
            root.join(r"System32\WindowsPowerShell\v1.0\powershell.exe"),
            vec!["-NoLogo"],
        )
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var_os("SHELL")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute() && path.is_file())
            .unwrap_or_else(|| PathBuf::from("/bin/sh"));
        (shell, vec!["-l"])
    }
}

fn clamp_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols: cols.clamp(2, 1000),
        rows: rows.clamp(1, 500),
        pixel_width: 0,
        pixel_height: 0,
    }
}

impl LocalTerminals {
    pub fn open(
        &self,
        sink: Arc<dyn LocalTerminalSink>,
        working_directory: Option<&str>,
        cols: u16,
        rows: u16,
    ) -> Result<String, String> {
        let directory = match working_directory.map(str::trim).filter(|d| !d.is_empty()) {
            Some(directory) => {
                let path = Path::new(directory);
                if !path.is_absolute() || !path.is_dir() {
                    return Err("The working folder is not an existing absolute folder.".into());
                }
                path.to_path_buf()
            }
            None => dirs::home_dir().ok_or("Cannot find the home folder.")?,
        };
        if self.entries.lock().map_err(|e| e.to_string())?.len() >= MAX_TERMINALS {
            return Err("Too many terminals are open. Close one first.".into());
        }
        let pair = native_pty_system()
            .openpty(clamp_size(cols, rows))
            .map_err(|error| format!("Cannot create a local terminal: {error}"))?;
        let (program, args) = shell();
        let mut command = CommandBuilder::new(&program);
        command.args(args);
        command.cwd(&directory);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("Cannot start {}: {error}", program.display()))?;
        drop(pair.slave);
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| error.to_string())?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| error.to_string())?;
        let id = format!(
            "local-terminal-{}",
            self.counter.fetch_add(1, Ordering::Relaxed) + 1
        );
        let entry = Arc::new(Entry {
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            killer: Mutex::new(child.clone_killer()),
        });
        self.entries
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id.clone(), entry);

        let terminal_id = id.clone();
        std::thread::Builder::new()
            .name("latticeterm-local-terminal".into())
            .spawn(move || {
                let mut buffer = [0u8; 16 * 1024];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(count) => sink.data(LocalTerminalData {
                            terminal_id: terminal_id.clone(),
                            base64: base64::engine::general_purpose::STANDARD
                                .encode(&buffer[..count]),
                        }),
                    }
                }
                let code = child.wait().ok().map(|status| status.exit_code());
                sink.exit(LocalTerminalExit { terminal_id, code });
            })
            .map_err(|error| error.to_string())?;
        Ok(id)
    }

    fn get(&self, id: &str) -> Result<Arc<Entry>, String> {
        self.entries
            .lock()
            .map_err(|e| e.to_string())?
            .get(id)
            .cloned()
            .ok_or_else(|| "This terminal has already closed.".to_string())
    }

    pub fn write(&self, id: &str, base64: &str) -> Result<(), String> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(base64)
            .map_err(|_| "Invalid terminal input.".to_string())?;
        if bytes.len() > MAX_INPUT_BYTES {
            return Err("Too much input at once.".into());
        }
        let entry = self.get(id)?;
        let mut writer = entry.writer.lock().map_err(|e| e.to_string())?;
        writer
            .write_all(&bytes)
            .and_then(|()| writer.flush())
            .map_err(|error| error.to_string())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let entry = self.get(id)?;
        let master = entry.master.lock().map_err(|e| e.to_string())?;
        master
            .resize(clamp_size(cols, rows))
            .map_err(|error| error.to_string())
    }

    /// Ends the shell. Its reader then reports the exit as usual.
    pub fn close(&self, id: &str) -> Result<(), String> {
        let entry = self.entries.lock().map_err(|e| e.to_string())?.remove(id);
        if let Some(entry) = entry {
            if let Ok(mut killer) = entry.killer.lock() {
                let _ = killer.kill();
            }
        }
        Ok(())
    }

    pub fn close_all(&self) {
        let ids: Vec<String> = self
            .entries
            .lock()
            .map(|entries| entries.keys().cloned().collect())
            .unwrap_or_default();
        for id in ids {
            let _ = self.close(&id);
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    struct Channel(Mutex<mpsc::Sender<(String, Vec<u8>, bool)>>);

    impl LocalTerminalSink for Channel {
        fn data(&self, event: LocalTerminalData) {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(event.base64)
                .unwrap();
            let _ = self
                .0
                .lock()
                .unwrap()
                .send((event.terminal_id, bytes, false));
        }
        fn exit(&self, event: LocalTerminalExit) {
            let _ = self
                .0
                .lock()
                .unwrap()
                .send((event.terminal_id, Vec::new(), true));
        }
    }

    #[test]
    fn a_shell_runs_in_the_folder_and_reports_its_end() {
        let folder = tempfile::tempdir().unwrap();
        let (tx, rx) = mpsc::channel();
        let terminals = LocalTerminals::default();
        let id = terminals
            .open(
                Arc::new(Channel(Mutex::new(tx))),
                Some(folder.path().to_str().unwrap()),
                80,
                24,
            )
            .unwrap();
        let encode = |text: &str| base64::engine::general_purpose::STANDARD.encode(text);
        terminals
            .write(&id, &encode("echo marker-$((20+22)); pwd; exit\n"))
            .unwrap();
        let mut output = Vec::new();
        let mut exited = false;
        while let Ok((_, bytes, end)) = rx.recv_timeout(Duration::from_secs(15)) {
            output.extend(bytes);
            if end {
                exited = true;
                break;
            }
        }
        let text = String::from_utf8_lossy(&output);
        assert!(text.contains("marker-42"), "{text}");
        let folder_name = folder.path().file_name().unwrap().to_str().unwrap();
        assert!(text.contains(folder_name), "{text}");
        assert!(exited);
        terminals.close(&id).unwrap();
        assert!(terminals.write(&id, &encode("x")).is_err());
    }

    #[test]
    fn a_missing_or_relative_folder_is_refused() {
        let (tx, _rx) = mpsc::channel();
        let sink: Arc<dyn LocalTerminalSink> = Arc::new(Channel(Mutex::new(tx)));
        let terminals = LocalTerminals::default();
        assert!(terminals
            .open(Arc::clone(&sink), Some("relative"), 80, 24)
            .is_err());
        assert!(terminals
            .open(sink, Some("/definitely/not/here"), 80, 24)
            .is_err());
    }
}
