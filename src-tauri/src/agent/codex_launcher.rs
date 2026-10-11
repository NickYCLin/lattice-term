use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Command;

use super::codex_input_profile::{qualify_local_path, UnavailableReason};

#[derive(Clone)]
pub(super) struct Launcher {
    pub program: PathBuf,
    pub entrypoint: PathBuf,
    pub sources: Vec<PathBuf>,
}

impl Launcher {
    pub(super) fn validate_resolution(&self, native: &Path) -> Result<(), UnavailableReason> {
        let shim = self
            .sources
            .first()
            .ok_or(UnavailableReason::ConfigurationChanged)?;
        let (resolved, launcher) = resolve(
            shim,
            self.program.as_os_str(),
            &[self.entrypoint.clone().into()],
        )
        .map_err(|_| UnavailableReason::ConfigurationChanged)?;
        let launcher = launcher.ok_or(UnavailableReason::ConfigurationChanged)?;
        if resolved != native || launcher.sources != self.sources {
            return Err(UnavailableReason::ConfigurationChanged);
        }
        Ok(())
    }

    pub(super) fn command(&self) -> Command {
        let mut command = Command::new(&self.program);
        command.arg(&self.entrypoint);
        command
    }
}

pub(super) fn resolve(
    executable: &Path,
    program: &OsStr,
    prefix: &[OsString],
) -> Result<(PathBuf, Option<Launcher>), UnavailableReason> {
    if prefix.is_empty() && program == executable.as_os_str() {
        return Ok((executable.to_owned(), None));
    }
    if prefix.len() != 1 {
        return Err(UnavailableReason::UnsupportedLaunch);
    }
    let program = PathBuf::from(program);
    let entrypoint = PathBuf::from(&prefix[0]);
    if entrypoint.file_name() != Some(OsStr::new("codex.js"))
        || entrypoint.parent().and_then(Path::file_name) != Some(OsStr::new("bin"))
        || !program
            .file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case("node.exe"))
    {
        return Err(UnavailableReason::UnsupportedLaunch);
    }
    for path in [executable, program.as_path(), entrypoint.as_path()] {
        qualify_local_path(path)?;
    }
    let root = entrypoint
        .parent()
        .and_then(Path::parent)
        .ok_or(UnavailableReason::UnsupportedLaunch)?;
    let package = root.join("package.json");
    let metadata = read_package(&package)?;
    if metadata.get("name").and_then(serde_json::Value::as_str) != Some("@openai/codex")
        || metadata
            .pointer("/bin/codex")
            .and_then(serde_json::Value::as_str)
            != Some("bin/codex.js")
    {
        return Err(UnavailableReason::UnsupportedLaunch);
    }
    let version = metadata
        .get("version")
        .and_then(serde_json::Value::as_str)
        .ok_or(UnavailableReason::UnsupportedLaunch)?;
    let (platform, triple) = match std::env::consts::ARCH {
        "x86_64" => ("codex-win32-x64", "x86_64-pc-windows-msvc"),
        "aarch64" => ("codex-win32-arm64", "aarch64-pc-windows-msvc"),
        _ => return Err(UnavailableReason::UnsupportedLaunch),
    };
    let mut sources = vec![executable.to_owned(), entrypoint.clone(), package];
    let mut vendor = None;
    for ancestor in root.ancestors() {
        if ancestor.file_name() == Some(OsStr::new("node_modules")) {
            continue;
        }
        let candidate = ancestor
            .join("node_modules")
            .join("@openai")
            .join(platform)
            .join("package.json");
        qualify_local_path(&candidate)?;
        sources.push(candidate.clone());
        if candidate.exists() {
            let metadata = read_package(&candidate)?;
            if metadata.get("name").and_then(serde_json::Value::as_str) != Some("@openai/codex")
                || !metadata
                    .get("os")
                    .and_then(serde_json::Value::as_array)
                    .is_some_and(|values| values.iter().any(|value| value == "win32"))
                || !metadata
                    .get("cpu")
                    .and_then(serde_json::Value::as_array)
                    .is_some_and(|values| {
                        values.iter().any(|value| {
                            value
                                == if platform.ends_with("x64") {
                                    "x64"
                                } else {
                                    "arm64"
                                }
                        })
                    })
                || !metadata
                    .get("version")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|native_version| {
                        native_version == version
                            || native_version
                                == format!("{version}-{}", platform.trim_start_matches("codex-"))
                    })
            {
                return Err(UnavailableReason::UnsupportedLaunch);
            }
            vendor = candidate.parent().map(|parent| parent.join("vendor"));
            break;
        }
    }
    let native = vendor
        .unwrap_or_else(|| root.join("vendor"))
        .join(triple)
        .join("bin")
        .join("codex.exe");
    qualify_local_path(&native)?;
    if !native.is_file() {
        return Err(UnavailableReason::UnsupportedLaunch);
    }
    Ok((
        native,
        Some(Launcher {
            program,
            entrypoint,
            sources,
        }),
    ))
}

fn read_package(path: &Path) -> Result<serde_json::Value, UnavailableReason> {
    qualify_local_path(path)?;
    let metadata = std::fs::metadata(path).map_err(|_| UnavailableReason::UnverifiableSource)?;
    if !metadata.is_file() || metadata.len() > 64 * 1024 {
        return Err(UnavailableReason::UnverifiableSource);
    }
    let file = std::fs::File::open(path).map_err(|_| UnavailableReason::UnverifiableSource)?;
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut std::io::Read::take(file, 64 * 1024 + 1), &mut bytes)
        .map_err(|_| UnavailableReason::UnverifiableSource)?;
    if bytes.len() > 64 * 1024 {
        return Err(UnavailableReason::UnverifiableSource);
    }
    serde_json::from_slice(&bytes).map_err(|_| UnavailableReason::UnverifiableSource)
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    pub(crate) fn fixture(root: &Path) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
        let shim = root.join("codex.cmd");
        let node = root.join("node.exe");
        let package = root.join("node_modules/@openai/codex");
        let entry = package.join("bin/codex.js");
        let (platform, triple, cpu) = if std::env::consts::ARCH == "aarch64" {
            ("codex-win32-arm64", "aarch64-pc-windows-msvc", "arm64")
        } else {
            ("codex-win32-x64", "x86_64-pc-windows-msvc", "x64")
        };
        let native_package = package.join("node_modules/@openai").join(platform);
        let native = native_package
            .join("vendor")
            .join(triple)
            .join("bin/codex.exe");
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::fs::create_dir_all(native.parent().unwrap()).unwrap();
        std::fs::write(&shim, "owned shim").unwrap();
        std::fs::write(&node, "owned runtime").unwrap();
        std::fs::write(&entry, "owned entrypoint").unwrap();
        std::fs::write(&native, "owned native executable").unwrap();
        std::fs::write(
            package.join("package.json"),
            r#"{"name":"@openai/codex","version":"0.1.0","bin":{"codex":"bin/codex.js"}}"#,
        )
        .unwrap();
        std::fs::write(native_package.join("package.json"), serde_json::json!({
            "name":"@openai/codex","version":format!("0.1.0-{}", platform.trim_start_matches("codex-")),
            "os":["win32"],"cpu":[cpu]
        }).to_string()).unwrap();
        (shim, node, entry, native)
    }

    #[test]
    fn codex_launcher_preserves_node_and_attests_native_package() {
        let temp = tempfile::tempdir().unwrap();
        let (shim, node, entry, native) = fixture(temp.path());
        let (resolved, launcher) =
            resolve(&shim, node.as_os_str(), &[entry.clone().into()]).unwrap();
        assert_eq!(resolved, native);
        let launcher = launcher.unwrap();
        assert_eq!(launcher.program, node);
        assert_eq!(launcher.entrypoint, entry);
        launcher.validate_resolution(&native).unwrap();
        assert!(launcher.validate_resolution(&node).is_err());
        assert!(launcher.sources.contains(&shim));
        assert!(launcher.sources.contains(&entry));
        assert_eq!(
            launcher.command().get_args().collect::<Vec<_>>(),
            [entry.as_os_str()]
        );
    }

    #[test]
    fn codex_launcher_rejects_custom_wrapper_arguments_and_package_changes() {
        let temp = tempfile::tempdir().unwrap();
        let (shim, node, entry, native) = fixture(temp.path());
        assert!(resolve(
            &shim,
            node.as_os_str(),
            &[entry.clone().into(), "--custom".into()]
        )
        .is_err());
        std::fs::write(
            entry
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join("package.json"),
            r#"{"name":"other","bin":{"codex":"bin/codex.js"}}"#,
        )
        .unwrap();
        assert!(resolve(&shim, node.as_os_str(), &[entry.into()]).is_err());
        assert!(resolve(&native, native.as_os_str(), &[])
            .unwrap()
            .1
            .is_none());
    }

    #[test]
    fn codex_launcher_rejects_missing_or_mismatched_platform_binary() {
        let temp = tempfile::tempdir().unwrap();
        let (shim, node, entry, native) = fixture(temp.path());
        let package = native
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap();
        std::fs::write(
            package.join("package.json"),
            r#"{"name":"@openai/codex","version":"other","os":["win32"],"cpu":["x64","arm64"]}"#,
        )
        .unwrap();
        assert!(resolve(&shim, node.as_os_str(), &[entry.into()]).is_err());
    }
}
