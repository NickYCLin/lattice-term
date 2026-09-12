//! Windows SSH starts a fixed PowerShell bootstrap from either cmd.exe or
//! PowerShell. Only base64 data crosses the outer shell; the child inherits raw
//! standard input/output handles (stderr redirect enables STARTF_USESTDHANDLES),
//! bypassing PowerShell's native-output text pipeline.
use super::*;
use base64::Engine;

pub(crate) fn valid_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 4
        || bytes.len() > 4096
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || !matches!(bytes[2], b'\\' | b'/')
        || value.chars().any(char::is_control)
    {
        return false;
    }
    let mut count = 0;
    for component in value[3..].split(['\\', '/']) {
        if component.is_empty() {
            continue;
        }
        count += 1;
        if matches!(component, "." | "..")
            || component.ends_with(['.', ' '])
            || component
                .chars()
                .any(|c| matches!(c, ':' | '"' | '<' | '>' | '|' | '?' | '*'))
        {
            return false;
        }
        let name = component
            .split('.')
            .next()
            .unwrap()
            .trim_end_matches(' ')
            .to_ascii_uppercase();
        if matches!(
            name.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        ) || ["COM", "LPT"].iter().any(|prefix| {
            name.strip_prefix(prefix).is_some_and(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        }) {
            return false;
        }
    }
    count > 0
}

// Paths cannot contain a quote. Double trailing backslashes so the closing
// quote survives the Windows native argument parser, including directory paths.
fn argument(path: &str) -> String {
    let trailing = path.chars().rev().take_while(|c| *c == '\\').count();
    format!("\"{path}{}\"", "\\".repeat(trailing))
}
fn data(value: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(value.as_bytes())
}
fn script(config: &FleetWorkspace) -> String {
    let arguments = format!(
        "mcp --data-dir {} --workspace-directory {}",
        argument(&config.data_directory),
        argument(&config.directory)
    );
    format!(
        "$ErrorActionPreference='Stop';$p=New-Object System.Diagnostics.ProcessStartInfo;\
         $p.FileName=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{}'));\
         $p.Arguments=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{}'));\
         $p.UseShellExecute=$false;$p.CreateNoWindow=$true;$p.RedirectStandardError=$true;\
         $c=[Diagnostics.Process]::Start($p);$e=$c.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError());try{{$c.WaitForExit();$e.GetAwaiter().GetResult();exit $c.ExitCode}}finally{{$c.Dispose()}}",
        data(&config.executable), data(&arguments)
    )
}
pub(super) fn command(config: &FleetWorkspace) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(
        script(config)
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    format!("powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {encoded}")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_paths_require_a_local_drive_and_unambiguous_components() {
        for valid in [
            r"C:\Program Files\LatticeTerm\lattice-term.exe",
            r"d:/工作區/100%&$'’(x)",
            r"C:\data\\",
        ] {
            assert!(valid_path(valid), "{valid}");
        }
        for invalid in [
            r"C:\",
            r"C:relative",
            r"\rooted",
            r"\\host\share\work",
            r"\\?\C:\work",
            r"\\.\pipe\name",
            r"C:\work\..\other",
            r"C:\work\.",
            r"C:\work\file:stream",
            r"C:\work\space ",
            r"C:\work\dot.",
            r"C:\work\NUL.txt",
            r"C:\work\COM¹",
            "C:\\work\\new\nline",
            "C:\\work\\a\"b",
        ] {
            assert!(!valid_path(invalid), "{invalid}");
        }
    }
    #[test]
    fn windows_bootstrap_contains_only_encoded_user_data_and_native_arguments() {
        let config = FleetWorkspace {
            platform: FleetPlatform::Windows,
            executable: r"C:\Program Files\O'Brien%&’\lattice-term.exe".into(),
            data_directory: r"D:\資料$()\".into(),
            directory: r"D:\work space\".into(),
        };
        let command = command(&config);
        let encoded = command.split_whitespace().last().unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        let script = String::from_utf16(
            &bytes
                .chunks_exact(2)
                .map(|b| u16::from_le_bytes([b[0], b[1]]))
                .collect::<Vec<_>>(),
        )
        .unwrap();
        assert!(!script.contains(&config.executable));
        assert!(!script.contains(&config.data_directory));
        assert!(script.contains(&data(&config.executable)));
        assert!(script.contains(&data(
            "mcp --data-dir \"D:\\資料$()\\\\\" --workspace-directory \"D:\\work space\\\\\""
        )));
        assert!(!script.contains("RedirectStandardOutput"));
        assert!(command.len() < 8000);
    }
}
