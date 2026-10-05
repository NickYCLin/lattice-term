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
