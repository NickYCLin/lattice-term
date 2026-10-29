use std::ffi::{OsStr, OsString};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::ERROR_CANCELLED;
use windows_sys::Win32::Security::{
    GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
};
use windows_sys::Win32::System::Com::{
    CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows_sys::Win32::UI::Shell::{
    ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    MessageBoxW, MB_ICONERROR, MB_OK, SW_SHOWNORMAL,
};

// Older installers may replay the legacy flag from a successful elevation.
// Use a distinct pending guard so the first update into this fix can elevate.
const LEGACY_ATTEMPTED: &str = "--latticeterm-elevation-attempted";
const ATTEMPTED: &str = "--latticeterm-elevation-pending";

fn is_elevation_argument(argument: &OsStr) -> bool {
    argument == ATTEMPTED || argument == LEGACY_ATTEMPTED
}

fn has_pending_elevation(arguments: &[OsString]) -> bool {
    arguments.iter().any(|argument| argument == ATTEMPTED)
}

fn restart_arguments(arguments: &[OsString]) -> Vec<OsString> {
    arguments
        .iter()
        .enumerate()
        .filter(|(index, argument)| *index == 0 || !is_elevation_argument(argument))
        .map(|(_, argument)| argument.clone())
        .collect()
}

pub(crate) fn restart_environment() -> tauri::Env {
    let mut environment = tauri::Env::default();
    environment.args_os = restart_arguments(&environment.args_os);
    environment
}

fn wide(value: &OsStr) -> Result<Vec<u16>, String> {
    let mut result: Vec<_> = value.encode_wide().collect();
    if result.contains(&0) {
        return Err("啟動參數含有無效的空字元。".into());
    }
    result.push(0);
    Ok(result)
}

fn quote_argument(argument: &OsStr) -> Result<Vec<u16>, String> {
    let input = wide(argument)?;
    let mut result = vec![34];
    let mut slashes = 0;
    for &character in &input[..input.len() - 1] {
        if character == 92 {
            slashes += 1;
            continue;
        }
        result.extend(std::iter::repeat_n(
            92,
            if character == 34 {
                slashes * 2 + 1
            } else {
                slashes
            },
        ));
        result.push(character);
        slashes = 0;
    }
    result.extend(std::iter::repeat_n(92, slashes * 2));
    result.push(34);
    Ok(result)
}

fn parameters(arguments: &[OsString]) -> Result<Vec<u16>, String> {
    let mut result = Vec::new();
    for argument in arguments
        .iter()
        .map(OsString::as_os_str)
        .filter(|argument| !is_elevation_argument(argument))
        .chain([OsStr::new(ATTEMPTED)])
    {
        if !result.is_empty() {
            result.push(32);
        }
        result.extend(quote_argument(argument)?);
    }
    result.push(0);
    Ok(result)
}

fn elevated() -> Result<bool, String> {
    let mut token = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(format!(
            "無法讀取目前的執行權限：{}",
            std::io::Error::last_os_error()
        ));
    }
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    let mut information = TOKEN_ELEVATION::default();
    let mut length = 0;
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenElevation,
            (&mut information as *mut TOKEN_ELEVATION).cast(),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut length,
        )
    } == 0
    {
        return Err(format!(
            "無法確認管理員權限：{}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(information.TokenIsElevated != 0)
}

fn elevation_required(is_elevated: bool, attempted: bool) -> Result<bool, String> {
    if is_elevated {
        return Ok(false);
    }
    if attempted {
        return Err("Windows 未授予管理員權限，已停止啟動，避免重複詢問。".into());
    }
    Ok(true)
}

struct ComApartment;

impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

pub fn ensure_elevated(arguments: &[OsString]) -> Result<bool, String> {
    if !elevation_required(elevated()?, has_pending_elevation(arguments))? {
        return Ok(false);
    }
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let directory = std::env::current_dir().map_err(|error| error.to_string())?;
    let executable = wide(executable.as_os_str())?;
    let directory = wide(directory.as_os_str())?;
    let parameters = parameters(arguments)?;
    let verb = wide(OsStr::new("runas"))?;
    let status = unsafe {
        CoInitializeEx(
            null_mut(),
            (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32,
        )
    };
    if status < 0 {
        return Err(format!("無法準備 Windows 權限確認介面：{status:#x}"));
    }
    let _apartment = ComApartment;
    let mut request = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
        lpVerb: verb.as_ptr(),
        lpFile: executable.as_ptr(),
        lpParameters: parameters.as_ptr(),
        lpDirectory: directory.as_ptr(),
        nShow: SW_SHOWNORMAL,
        ..Default::default()
    };
    if unsafe { ShellExecuteExW(&mut request) } == 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(ERROR_CANCELLED as i32) {
            return Err(format!("無法以系統管理員身分啟動 LatticeTerm：{error}"));
        }
    }
    Ok(true)
}

pub fn show_error(error: &str) {
    let title = wide(OsStr::new("LatticeTerm")).unwrap();
    let message = wide(OsStr::new(error)).unwrap_or_else(|_| title.clone());
    unsafe {
        MessageBoxW(
            null_mut(),
            message.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR,
        )
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::UI::Shell::CommandLineToArgvW;

    #[test]
    fn requests_elevation_once_and_never_falls_back_silently() {
        assert_eq!(elevation_required(false, false), Ok(true));
        assert_eq!(elevation_required(true, false), Ok(false));
        assert_eq!(elevation_required(true, true), Ok(false));
        assert!(elevation_required(false, true).is_err());
    }

    #[test]
    fn legacy_updater_arguments_get_a_fresh_elevation_attempt() {
        let arguments = vec![LEGACY_ATTEMPTED.into(), "--desktop-autostart".into()];
        assert_eq!(
            elevation_required(false, has_pending_elevation(&arguments)),
            Ok(true),
        );
        let pending = vec![ATTEMPTED.into()];
        assert!(elevation_required(false, has_pending_elevation(&pending)).is_err());
    }

    #[test]
    fn updater_and_restart_drop_consumed_guards_but_keep_launch_arguments() {
        let arguments: Vec<OsString> = [
            "lattice-term.exe",
            LEGACY_ATTEMPTED,
            "--desktop-autostart",
            ATTEMPTED,
            "專案資料夾",
        ]
        .into_iter()
        .map(OsString::from)
        .chain([OsString::from_wide(&[0xd800])])
        .collect();
        let restarted = restart_arguments(&arguments);
        assert_eq!(
            restarted,
            vec![
                OsString::from("lattice-term.exe"),
                OsString::from("--desktop-autostart"),
                OsString::from("專案資料夾"),
                OsString::from_wide(&[0xd800]),
            ],
        );
        assert_eq!(restart_arguments(&restarted), restarted);
        assert_eq!(
            elevation_required(false, has_pending_elevation(&restarted[1..])),
            Ok(true),
        );
    }

    #[test]
    fn preserves_windows_arguments_and_adds_a_loop_guard() {
        let arguments: Vec<OsString> = [
            "",
            "--desktop-autostart",
            LEGACY_ATTEMPTED,
            ATTEMPTED,
            "繁體中文與空白 資料夾",
            r"C:\folder with spaces\",
            r#"a\"b"#,
            r#"a" & exit 1 & "b"#,
            "😀",
        ]
        .into_iter()
        .map(OsString::from)
        .chain([OsString::from_wide(&[0xd800])])
        .collect();
        let mut command = quote_argument(OsStr::new("lattice-term.exe")).unwrap();
        command.push(32);
        command.extend(parameters(&arguments).unwrap());
        let mut count = 0;
        let parsed = unsafe { CommandLineToArgvW(command.as_ptr(), &mut count) };
        assert!(!parsed.is_null());
        let mut actual = Vec::new();
        for index in 1..count as usize {
            let value = unsafe { *parsed.add(index) };
            let mut length = 0;
            while unsafe { *value.add(length) } != 0 {
                length += 1;
            }
            actual.push(OsString::from_wide(unsafe {
                std::slice::from_raw_parts(value, length)
            }));
        }
        unsafe { LocalFree(parsed.cast()) };
        let mut expected: Vec<_> = arguments
            .into_iter()
            .filter(|argument| !is_elevation_argument(argument))
            .collect();
        expected.push(ATTEMPTED.into());
        assert_eq!(actual, expected);
    }

    #[test]
    fn rejects_embedded_nulls_instead_of_truncating_arguments() {
        assert!(parameters(&[OsString::from_wide(&[65, 0, 66])]).is_err());
    }

    #[test]
    fn can_read_the_current_token_without_requesting_elevation() {
        assert!(elevated().is_ok());
    }
}
