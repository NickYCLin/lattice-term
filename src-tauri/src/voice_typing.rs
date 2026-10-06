//! Dictation through the operating system's own speech service.
//!
//! WebView2 exposes `webkitSpeechRecognition`, but it has no speech service
//! behind it. Windows ships voice typing (Win+H), which types into whatever
//! text box has focus, so the desktop opens that panel instead of bundling a
//! recogniser or sending audio anywhere itself.

/// Opens Windows voice typing for the focused text box.
///
/// Only the fixed Win+H chord is sent; the caller must focus the input first.
#[cfg(windows)]
pub fn start() -> Result<(), String> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VIRTUAL_KEY,
        VK_LWIN,
    };

    const VK_H: VIRTUAL_KEY = 0x48;
    fn key(code: VIRTUAL_KEY, up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: code,
                    wScan: 0,
                    dwFlags: if up { KEYEVENTF_KEYUP } else { 0 },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }
    let inputs = [
        key(VK_LWIN, false),
        key(VK_H, false),
        key(VK_H, true),
        key(VK_LWIN, true),
    ];
    // SAFETY: `inputs` is a live array of fully initialised INPUT values and
    // the size argument matches the element type.
    let sent = unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        )
    };
    if sent as usize == inputs.len() {
        Ok(())
    } else {
        Err(
            "Windows did not accept the voice typing shortcut. Press Win+H to start dictation."
                .to_string(),
        )
    }
}

#[cfg(not(windows))]
pub fn start() -> Result<(), String> {
    Err("Voice typing through the system is only available on Windows.".to_string())
}

#[derive(Clone, Copy, PartialEq)]
enum DictationSignal {
    Listen,
    Finish,
    Cancel,
}

#[derive(Default)]
pub struct DictationState {
    active: std::sync::Mutex<Option<(String, tokio::sync::watch::Sender<DictationSignal>)>>,
}

impl DictationState {
    pub fn stop(&self, request_id: &str, cancel: bool) -> Result<(), String> {
        let active = self
            .active
            .lock()
            .map_err(|_| "Dictation state is unavailable")?;
        if let Some((id, sender)) = active.as_ref() {
            if id == request_id {
                let _ = sender.send(if cancel {
                    DictationSignal::Cancel
                } else {
                    DictationSignal::Finish
                });
            }
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
fn local_model_directory() -> Option<std::path::PathBuf> {
    let cache = std::env::var_os("XDG_CACHE_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".cache"))
        })?;
    let directory = cache.join("whisper");
    directory.join("base.pt").is_file().then_some(directory)
}

#[cfg(target_os = "linux")]
fn local_tool_path() -> std::ffi::OsString {
    let mut directories: Vec<_> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    if let Some(home) = std::env::var_os("HOME") {
        directories.push(std::path::PathBuf::from(home).join(".local/bin"));
    }
    std::env::join_paths(directories).unwrap_or_default()
}

#[cfg(target_os = "linux")]
fn find_program(name: &str) -> Option<std::path::PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    std::env::split_paths(&local_tool_path()).find_map(|directory| {
        let program = directory.join(name);
        std::fs::metadata(&program)
            .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
            .then_some(program)
    })
}

pub fn local_available() -> bool {
    #[cfg(target_os = "linux")]
    {
        local_model_directory().is_some()
            && ["arecord", "whisper", "ffmpeg"]
                .into_iter()
                .all(|name| find_program(name).is_some())
    }
    #[cfg(not(target_os = "linux"))]
    false
}

pub async fn dictate(
    state: &DictationState,
    request_id: String,
    lang: String,
) -> Result<String, String> {
    #[cfg(target_os = "linux")]
    {
        if request_id.is_empty() || request_id.len() > 128 {
            return Err("Invalid dictation request".to_string());
        }
        if !local_available() {
            return Err("Local dictation needs arecord, ffmpeg, Whisper and an existing base.pt model in the Whisper cache. No audio is uploaded or model downloaded.".to_string());
        }
        let language = whisper_language(&lang)?;
        let (sender, receiver) = tokio::sync::watch::channel(DictationSignal::Listen);
        {
            let mut active = state
                .active
                .lock()
                .map_err(|_| "Dictation state is unavailable")?;
            if active.is_some() {
                return Err("Another dictation is already running".to_string());
            }
            *active = Some((request_id.clone(), sender));
        }
        let result = record_and_transcribe(language, receiver).await;
        if let Ok(mut active) = state.active.lock() {
            if active.as_ref().is_some_and(|(id, _)| id == &request_id) {
                *active = None;
            }
        }
        result
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (state, request_id, lang);
        Err("Local dictation is only available on Linux".to_string())
    }
}

#[cfg(target_os = "linux")]
fn whisper_language(lang: &str) -> Result<&str, String> {
    let language = lang.split('-').next().unwrap_or("");
    match language {
        "zh" | "en" | "ja" | "ko" | "de" | "fr" | "es" | "pt" => Ok(language),
        _ => Err("Unsupported dictation language".to_string()),
    }
}

#[cfg(target_os = "linux")]
async fn record_and_transcribe(
    language: &str,
    receiver: tokio::sync::watch::Receiver<DictationSignal>,
) -> Result<String, String> {
    let model_directory = local_model_directory().ok_or("Local Whisper base model is missing")?;
    let recorder = find_program("arecord").ok_or("Local recorder is missing")?;
    let transcriber = find_program("whisper").ok_or("Local Whisper is missing")?;
    run_local_dictation(
        language,
        receiver,
        &recorder,
        &transcriber,
        &model_directory,
    )
    .await
}

#[cfg(target_os = "linux")]
async fn run_local_dictation(
    language: &str,
    mut receiver: tokio::sync::watch::Receiver<DictationSignal>,
    recorder: &std::path::Path,
    transcriber: &std::path::Path,
    model_directory: &std::path::Path,
) -> Result<String, String> {
    use std::process::Stdio;
    use std::time::Duration;
    use tokio::process::Command;

    if *receiver.borrow() == DictationSignal::Cancel {
        return Ok(String::new());
    }
    let directory = tempfile::tempdir().map_err(|_| "Cannot create private dictation storage")?;
    let audio = directory.path().join("speech.wav");
    let mut recording = Command::new(recorder)
        .args([
            "-q", "-D", "default", "-f", "S16_LE", "-r", "16000", "-c", "1", "-d", "12", "-t",
            "wav",
        ])
        .arg(&audio)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "Cannot start microphone recording")?;
    tokio::select! {
        result = recording.wait() => {
            if !result.map_err(|_| "Microphone recording failed")?.success() {
                return Err("Microphone recording failed; check the default input device".to_string());
            }
        }
        _ = tokio::time::sleep(Duration::from_secs(15)) => {
            kill_process_group(&recording);
            let _ = recording.kill().await;
            return Err("Microphone recording timed out".to_string());
        }
        _ = receiver.changed() => {
            if *receiver.borrow() == DictationSignal::Cancel {
                kill_process_group(&recording);
                let _ = recording.kill().await;
                return Ok(String::new());
            }
            if let Some(id) = recording.id() {
                unsafe { libc::kill(-(id as libc::pid_t), libc::SIGINT); }
            }
            tokio::time::timeout(Duration::from_secs(3), recording.wait()).await
                .map_err(|_| "Microphone did not stop")?
                .map_err(|_| "Microphone recording failed")?;
        }
    }
    if *receiver.borrow() == DictationSignal::Cancel {
        return Ok(String::new());
    }
    let mut transcription = Command::new(transcriber)
        .arg(&audio)
        .arg("--model")
        .arg(model_directory.join("base.pt"))
        .args([
            "--language",
            language,
            "--task",
            "transcribe",
            "--device",
            "cpu",
            "--fp16",
            "False",
            "--output_format",
            "txt",
            "--output_dir",
        ])
        .arg(directory.path())
        .env("PATH", local_tool_path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "Cannot start local Whisper transcription")?;
    let deadline = tokio::time::sleep(Duration::from_secs(120));
    tokio::pin!(deadline);
    let status = loop {
        tokio::select! {
            result = transcription.wait() => {
                break result.map_err(|_| "Local transcription failed")?;
            }
            _ = &mut deadline => {
                kill_process_group(&transcription);
                let _ = transcription.kill().await;
                return Err("Local transcription timed out".to_string());
            }
            _ = receiver.changed() => {
                if *receiver.borrow() == DictationSignal::Cancel {
                    kill_process_group(&transcription);
                    let _ = transcription.kill().await;
                    return Ok(String::new());
                }
            }
        }
    };
    if !status.success() {
        return Err("Local Whisper transcription failed".to_string());
    }
    if std::fs::metadata(directory.path().join("speech.txt"))
        .map_err(|_| "Cannot read local transcription")?
        .len()
        > 16 * 1024
    {
        return Err("Local transcription is too large".to_string());
    }
    let text = std::fs::read_to_string(directory.path().join("speech.txt"))
        .map_err(|_| "Cannot read local transcription")?;
    Ok(text.trim().to_string())
}

#[cfg(target_os = "linux")]
fn kill_process_group(child: &tokio::process::Child) {
    if let Some(id) = child.id() {
        unsafe {
            libc::kill(-(id as libc::pid_t), libc::SIGKILL);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stop_only_controls_the_matching_request() {
        let state = DictationState::default();
        let (sender, receiver) = tokio::sync::watch::channel(DictationSignal::Listen);
        *state.active.lock().unwrap() = Some(("composer".to_string(), sender));
        state.stop("another", true).unwrap();
        assert!(*receiver.borrow() == DictationSignal::Listen);
        state.stop("composer", false).unwrap();
        assert!(*receiver.borrow() == DictationSignal::Finish);
        state.stop("composer", true).unwrap();
        assert!(*receiver.borrow() == DictationSignal::Cancel);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn language_is_an_allowlisted_iso_code() {
        assert_eq!(whisper_language("zh-TW").unwrap(), "zh");
        assert_eq!(whisper_language("en-US").unwrap(), "en");
        assert!(whisper_language("--output_dir").is_err());
        assert!(whisper_language("unknown").is_err());
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn local_pipeline_reads_text_without_using_a_microphone() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = tempfile::tempdir().unwrap();
        let recorder = fixture.path().join("recorder");
        let transcriber = fixture.path().join("transcriber");
        std::fs::write(&recorder, "#!/bin/sh\nfor argument do destination=$argument; done\nprintf fixture > \"$destination\"\n").unwrap();
        std::fs::write(&transcriber, "#!/bin/sh\nfor argument do destination=$argument; done\nprintf '測試聽寫\\n' > \"$destination/speech.txt\"\n").unwrap();
        for program in [&recorder, &transcriber] {
            std::fs::set_permissions(program, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let (_sender, receiver) = tokio::sync::watch::channel(DictationSignal::Listen);
        let text = run_local_dictation("zh", receiver, &recorder, &transcriber, fixture.path())
            .await
            .unwrap();
        assert_eq!(text, "測試聽寫");
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_cancelled_request_never_starts_recording() {
        let (_sender, receiver) = tokio::sync::watch::channel(DictationSignal::Cancel);
        assert_eq!(
            run_local_dictation(
                "zh",
                receiver,
                std::path::Path::new("/missing-recorder"),
                std::path::Path::new("/missing-transcriber"),
                std::path::Path::new("/missing-model")
            )
            .await
            .unwrap(),
            ""
        );
    }
}
