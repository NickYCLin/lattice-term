//! Read-only, local directory identity for sidebar grouping; never changes launch paths.
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDirectoryIdentity {
    path: String,
    canonical_path: Option<String>,
}

pub fn identities(
    paths: Vec<String>,
    home: Option<PathBuf>,
) -> Result<Vec<ProjectDirectoryIdentity>, String> {
    if paths.len() > 256 {
        return Err("Too many project directories.".into());
    }
    #[cfg(target_os = "linux")]
    let mounts = bind_mounts::read();
    Ok(paths
        .into_iter()
        .map(|raw| {
            let canonical_path = canonical_directory(&raw, home.as_deref());
            #[cfg(target_os = "linux")]
            let canonical_path = canonical_path.and_then(|path| {
                bind_mounts::normalize(Path::new(&path), &mounts)
                    .to_str()
                    .map(str::to_owned)
            });
            ProjectDirectoryIdentity {
                path: raw,
                canonical_path,
            }
        })
        .collect())
}

fn canonical_directory(raw: &str, home: Option<&Path>) -> Option<String> {
    if raw.is_empty() || raw.len() > 4096 || raw.chars().any(char::is_control) {
        return None;
    }
    // Never probe UNC hosts or device namespaces just to draw a local sidebar.
    if raw.starts_with("\\\\") || raw.starts_with("//") {
        #[cfg(windows)]
        if raw.starts_with("\\\\?\\") && raw.as_bytes().get(5) == Some(&b':') {
            return canonical_directory(&raw[4..], home);
        }
        return None;
    }
    let path = if raw == "~" {
        home?.to_path_buf()
    } else if let Some(relative) = raw.strip_prefix("~/") {
        home?.join(relative)
    } else {
        PathBuf::from(raw)
    };
    if !path.is_absolute() || !path.is_dir() {
        return None;
    }
    std::fs::canonicalize(path)
        .ok()?
        .to_str()
        .map(str::to_owned)
}

#[cfg(target_os = "linux")]
mod bind_mounts {
    use std::os::unix::fs::MetadataExt;
    use std::path::{Path, PathBuf};
    #[derive(Debug)]
    pub(super) struct Mount {
        device: String,
        root: PathBuf,
        target: PathBuf,
    }
    fn unescape(value: &str) -> Option<PathBuf> {
        let bytes = value.as_bytes();
        let mut out = Vec::new();
        let mut index = 0;
        while index < bytes.len() {
            if bytes[index] == b'\\' {
                let octal = bytes.get(index + 1..index + 4)?;
                if !octal.iter().all(|byte| matches!(byte, b'0'..=b'7')) {
                    return None;
                }
                let decoded = (octal[0] - b'0') as u16 * 64
                    + (octal[1] - b'0') as u16 * 8
                    + (octal[2] - b'0') as u16;
                if decoded > 255 {
                    return None;
                }
                out.push(decoded as u8);
                index += 4;
            } else {
                out.push(bytes[index]);
                index += 1;
            }
        }
        String::from_utf8(out).ok().map(PathBuf::from)
    }
    fn parse(text: &str) -> Vec<Mount> {
        text.lines()
            .filter_map(|line| {
                let fields: Vec<_> = line.split_whitespace().collect();
                if fields.len() < 7 || !fields[6..].contains(&"-") {
                    return None;
                }
                Some(Mount {
                    device: fields[2].into(),
                    root: unescape(fields[3])?,
                    target: unescape(fields[4])?,
                })
            })
            .collect()
    }
    pub(super) fn read() -> Vec<Mount> {
        std::fs::read_to_string("/proc/self/mountinfo")
            .ok()
            .map(|text| parse(&text))
            .unwrap_or_default()
    }
    pub(super) fn normalize(path: &Path, mounts: &[Mount]) -> PathBuf {
        let Some(source) = mounts
            .iter()
            .filter(|mount| path.starts_with(&mount.target))
            .max_by_key(|mount| mount.target.components().count())
        else {
            return path.into();
        };
        let Ok(relative) = path.strip_prefix(&source.target) else {
            return path.into();
        };
        let underlying = source.root.join(relative);
        let Ok(original) = std::fs::metadata(path) else {
            return path.into();
        };
        let mut candidates: Vec<_> = mounts
            .iter()
            .filter(|mount| mount.device == source.device && underlying.starts_with(&mount.root))
            .collect();
        candidates.sort_by_key(|mount| (mount.root.components().count(), mount.target.clone()));
        for mount in candidates {
            let Ok(relative) = underlying.strip_prefix(&mount.root) else {
                continue;
            };
            let candidate = mount.target.join(relative);
            let Ok(candidate) = std::fs::canonicalize(candidate) else {
                continue;
            };
            if std::fs::metadata(&candidate).is_ok_and(|metadata| {
                metadata.dev() == original.dev()
                    && metadata.ino() == original.ino()
                    && metadata.is_dir()
            }) {
                return candidate;
            }
        }
        path.into()
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn mount_paths_decode_spaces_and_reject_bad_rows() {
            let rows=parse("1 0 8:1 / /data rw - ext4 local rw\n2 1 8:1 /home/a\\040b /alias\\040folder rw - ext4 local rw\ninvalid");
            assert_eq!(rows.len(), 2);
            assert_eq!(rows[1].root, Path::new("/home/a b"));
            assert_eq!(rows[1].target, Path::new("/alias folder"));
        }
        #[test]
        fn candidate_mapping_requires_matching_filesystem_identity() {
            let temp = tempfile::tempdir().unwrap();
            let real = temp.path().join("real");
            std::fs::create_dir_all(real.join("child")).unwrap();
            let alias = temp.path().join("alias");
            std::os::unix::fs::symlink(&real, &alias).unwrap();
            let mounts = vec![
                Mount {
                    device: "1:1".into(),
                    root: "/real".into(),
                    target: alias.clone(),
                },
                Mount {
                    device: "1:1".into(),
                    root: "/".into(),
                    target: temp.path().into(),
                },
            ];
            assert_eq!(normalize(&alias.join("child"), &mounts), real.join("child"));
            let wrong = temp.path().join("wrong");
            std::fs::create_dir_all(wrong.join("real/child")).unwrap();
            let mounts = vec![
                Mount {
                    device: "1:1".into(),
                    root: "/real".into(),
                    target: alias.clone(),
                },
                Mount {
                    device: "1:1".into(),
                    root: "/".into(),
                    target: wrong,
                },
            ];
            assert_eq!(normalize(&alias.join("child"), &mounts), real.join("child"));
        }
        #[test]
        fn existing_workspace_mount_aliases_resolve_to_one_verified_directory() {
            let path = std::fs::canonicalize(std::env::current_dir().unwrap()).unwrap();
            let mounts = read();
            let canonical = normalize(&path, &mounts);
            let source = mounts
                .iter()
                .filter(|mount| path.starts_with(&mount.target))
                .max_by_key(|mount| mount.target.components().count())
                .unwrap();
            let underlying = source.root.join(path.strip_prefix(&source.target).unwrap());
            let original = std::fs::metadata(&path).unwrap();
            for mount in mounts.iter().filter(|mount| {
                mount.device == source.device && underlying.starts_with(&mount.root)
            }) {
                let candidate = mount
                    .target
                    .join(underlying.strip_prefix(&mount.root).unwrap());
                if std::fs::metadata(&candidate).is_ok_and(|metadata| {
                    metadata.dev() == original.dev() && metadata.ino() == original.ino()
                }) {
                    assert_eq!(normalize(&candidate, &mounts), canonical);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_relative_network_and_device_paths_keep_lexical_fallback() {
        for path in [
            "",
            "relative",
            "C:relative",
            "\\\\server\\share",
            "\\\\.\\device",
            "//server/share",
            "/missing-project-test-0828",
        ] {
            assert!(canonical_directory(path, None).is_none(), "{path}");
        }
        assert!(identities(vec!["x".into(); 257], None).is_err());
    }
    #[test]
    fn existing_directories_and_home_aliases_resolve_without_changing_inputs() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().to_str().unwrap();
        let rows = identities(
            vec![path.into(), format!("{path}/"), "~".into()],
            Some(temp.path().to_path_buf()),
        )
        .unwrap();
        assert_eq!(rows[0].canonical_path, rows[1].canonical_path);
        assert_eq!(rows[0].canonical_path, rows[2].canonical_path);
        assert_eq!(rows[2].path, "~");
    }
    #[cfg(unix)]
    #[test]
    fn symlink_and_home_mount_aliases_share_identity_but_siblings_and_case_do_not() {
        let temp = tempfile::tempdir().unwrap();
        let real = temp.path().join("real");
        std::fs::create_dir(&real).unwrap();
        let alias = temp.path().join("alias");
        std::os::unix::fs::symlink(&real, &alias).unwrap();
        assert_eq!(
            canonical_directory(alias.to_str().unwrap(), None),
            canonical_directory(real.to_str().unwrap(), None)
        );
        let other = temp.path().join("Real");
        std::fs::create_dir(&other).unwrap();
        assert_ne!(
            canonical_directory(other.to_str().unwrap(), None),
            canonical_directory(real.to_str().unwrap(), None)
        );
    }
}
