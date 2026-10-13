use std::path::{Path, PathBuf};

const ARGUMENT: &str = "--desktop-autostart";

fn launch_command(program: &Path) -> Result<String, String> {
    let path = program
        .to_str()
        .ok_or("The application path is not valid text.")?;
    if path.contains('"') || path.chars().any(char::is_control) {
        return Err("The application path contains unsafe characters.".into());
    }
    Ok(format!("\"{path}\" {ARGUMENT}"))
}

fn is_ours(content: &str) -> bool {
    let suffix = format!("\" {ARGUMENT}");
    let Some(path) = content
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix(&suffix))
    else {
        return false;
    };
    !path.contains('"')
        && !path.chars().any(char::is_control)
        && path.rsplit(['/', '\\']).next().is_some_and(|name| {
            name.eq_ignore_ascii_case("lattice-term.exe") || name == "lattice-term"
        })
}

pub fn enabled() -> Result<bool, String> {
    platform::read().map(|value| value.is_some_and(|content| is_ours(&content)))
}

pub fn set(enable: bool) -> Result<(), String> {
    let existing = platform::read()?;
    if existing.as_deref().is_some_and(|content| !is_ours(content)) {
        return Err(
            "Another login entry already uses LatticeTerm's name; it was not changed.".into(),
        );
    }
    if !enable {
        return platform::write(None, existing.as_deref());
    }
    let program = std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .or_else(|| std::env::current_exe().ok())
        .ok_or("Cannot locate the application executable.")?;
    platform::write(Some(&launch_command(&program)?), existing.as_deref())
}

pub fn refresh() {
    if enabled().unwrap_or(false) {
        let _ = set(true);
    }
}

#[cfg(windows)]
mod platform {
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW,
        RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_SZ,
    };

    const KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const NAME: &str = "LatticeTerm desktop";
    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }
    struct RegistryKey(HKEY);
    impl Drop for RegistryKey {
        fn drop(&mut self) {
            unsafe {
                RegCloseKey(self.0);
            }
        }
    }
    fn query(key: HKEY) -> Result<Option<String>, String> {
        let name = wide(NAME);
        let mut kind = 0;
        let mut length = 0;
        let status = unsafe {
            RegQueryValueExW(
                key,
                name.as_ptr(),
                std::ptr::null(),
                &mut kind,
                std::ptr::null_mut(),
                &mut length,
            )
        };
        if status == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        if status != ERROR_SUCCESS || kind != REG_SZ || length > 32768 || length % 2 != 0 {
            return Err(format!("Cannot read the desktop login entry ({status})."));
        }
        let mut buffer = vec![0u16; length as usize / 2];
        let status = unsafe {
            RegQueryValueExW(
                key,
                name.as_ptr(),
                std::ptr::null(),
                &mut kind,
                buffer.as_mut_ptr().cast(),
                &mut length,
            )
        };
        if status != ERROR_SUCCESS
            || kind != REG_SZ
            || length as usize > buffer.len() * 2
            || length % 2 != 0
        {
            return Err(format!(
                "The desktop login entry changed while reading ({status})."
            ));
        }
        buffer.truncate(length as usize / 2);
        if buffer.last() == Some(&0) {
            buffer.pop();
        }
        String::from_utf16(&buffer)
            .map(Some)
            .map_err(|_| "The desktop login entry is not valid text.".into())
    }
    pub fn read() -> Result<Option<String>, String> {
        let mut handle = std::ptr::null_mut();
        let status = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                wide(KEY).as_ptr(),
                0,
                KEY_QUERY_VALUE,
                &mut handle,
            )
        };
        if status == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        if status != ERROR_SUCCESS {
            return Err(format!("Cannot open the desktop login entry ({status})."));
        }
        let key = RegistryKey(handle);
        query(key.0)
    }
    pub fn write(content: Option<&str>, expected: Option<&str>) -> Result<(), String> {
        let mut handle = std::ptr::null_mut();
        let status = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                wide(KEY).as_ptr(),
                0,
                std::ptr::null(),
                0,
                KEY_QUERY_VALUE | KEY_SET_VALUE,
                std::ptr::null(),
                &mut handle,
                std::ptr::null_mut(),
            )
        };
        if status != ERROR_SUCCESS {
            return Err(format!(
                "Cannot open the desktop login entry for writing ({status})."
            ));
        }
        let key = RegistryKey(handle);
        if query(key.0)?.as_deref() != expected {
            return Err("The desktop login entry was changed by another program.".into());
        }
        let name = wide(NAME);
        let status = if let Some(content) = content {
            let value = wide(content);
            unsafe {
                RegSetValueExW(
                    key.0,
                    name.as_ptr(),
                    0,
                    REG_SZ,
                    value.as_ptr().cast(),
                    (value.len() * 2) as u32,
                )
            }
        } else {
            unsafe { RegDeleteValueW(key.0, name.as_ptr()) }
        };
        if status == ERROR_SUCCESS || content.is_none() && status == ERROR_FILE_NOT_FOUND {
            Ok(())
        } else {
            Err(format!("Cannot change the desktop login entry ({status})."))
        }
    }
}

#[cfg(not(windows))]
mod platform {
    pub fn read() -> Result<Option<String>, String> {
        Err("Desktop login startup is currently supported on Windows only.".into())
    }
    pub fn write(_content: Option<&str>, _expected: Option<&str>) -> Result<(), String> {
        Err("Desktop login startup is currently supported on Windows only.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn desktop_entry_is_separate_from_the_background_service() {
        let command = launch_command(Path::new("C:/Apps/Lattice Term/lattice-term.exe")).unwrap();
        assert!(is_ours(&command));
        assert!(!command.contains("agent-daemon"));
        assert!(!is_ours(
            "\"C:/Apps/lattice-term.exe\" agent-daemon --data-dir C:/data"
        ));
        assert!(!is_ours("\"C:/Apps/other.exe\" --desktop-autostart"));
        assert!(!is_ours(
            "\"C:/Apps/lattice-term.exe\" --other --desktop-autostart"
        ));
    }
    #[test]
    fn rejects_command_line_injection_and_preserves_unicode_paths() {
        assert!(launch_command(Path::new("C:/bad\"/lattice-term.exe")).is_err());
        assert!(launch_command(Path::new("C:/bad\n/lattice-term.exe")).is_err());
        let command = launch_command(Path::new("C:/工具/Lattice Term/lattice-term.exe")).unwrap();
        assert!(command.contains("工具"));
        assert!(is_ours(&command));
    }
}
