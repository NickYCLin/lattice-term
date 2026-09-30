//! Bounded, read-only queries within an existing SFTP grant.
use super::{paths, sha256, ServiceError};
use crate::sftp::SftpRegistry;
use serde_json::{json, Value};
use std::collections::{BTreeSet, VecDeque};
use std::future::Future;
use tokio::io::AsyncReadExt;
use tokio::time::{timeout_at, Duration, Instant};

const MAX_FILE_BYTES: usize = 1024 * 1024;
const MAX_PAGE_BYTES: u32 = 32 * 1024;
const MAX_DIRECTORIES: usize = 64;
const MAX_ENTRIES: usize = 4096;

pub(super) fn default_page_bytes() -> u32 {
    16 * 1024
}
pub(super) fn default_depth() -> u8 {
    3
}
pub(super) fn default_matches() -> u16 {
    50
}

fn invalid() -> ServiceError {
    ServiceError::new("invalid_input", "Check the relative path and query limits.")
}
fn conflict() -> ServiceError {
    ServiceError::new(
        "file_conflict",
        "The file changed. Start reading again from offset zero.",
    )
}
fn too_large() -> ServiceError {
    ServiceError::new(
        "file_too_large",
        "Text reads are limited to 1 MiB per file.",
    )
}

pub(super) fn validate_read(
    path: &str,
    offset: u64,
    max_bytes: u32,
    expected: Option<&str>,
) -> Result<(), ServiceError> {
    paths::preflight_directory(path)?;
    if path.is_empty()
        || offset > MAX_FILE_BYTES as u64
        || !(4..=MAX_PAGE_BYTES).contains(&max_bytes)
        || expected.is_some_and(|hash| {
            hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
    {
        return Err(invalid());
    }
    Ok(())
}

pub(super) fn validate_find(
    path: &str,
    query: &str,
    depth: u8,
    results: u16,
) -> Result<(), ServiceError> {
    paths::preflight_directory(path)?;
    if query.trim().is_empty()
        || query.chars().count() > 128
        || query.chars().any(char::is_control)
        || depth > 8
        || !(1..=200).contains(&results)
    {
        return Err(invalid());
    }
    Ok(())
}

fn text_page(
    bytes: &[u8],
    offset: u64,
    max_bytes: u32,
    expected: Option<&str>,
) -> Result<Value, ServiceError> {
    if bytes.len() > MAX_FILE_BYTES {
        return Err(too_large());
    }
    let hash = sha256(bytes);
    if expected.is_some_and(|expected| !expected.eq_ignore_ascii_case(&hash)) {
        return Err(conflict());
    }
    let text = std::str::from_utf8(bytes)
        .ok()
        .filter(|text| !text.contains('\0'))
        .ok_or_else(|| {
            ServiceError::new(
                "unsupported_encoding",
                "Only UTF-8 text without NUL is supported.",
            )
        })?;
    let start = usize::try_from(offset).map_err(|_| invalid())?;
    if !text.is_char_boundary(start) {
        return Err(invalid());
    }
    let mut end = bytes.len().min(start.saturating_add(max_bytes as usize));
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Ok(json!({
        "encoding": "utf-8", "text": &text[start..end], "size": bytes.len(),
        "sha256": hash, "offset": offset, "nextOffset": end,
        "hasMore": end < bytes.len()
    }))
}

pub(super) async fn read_text(
    registry: &SftpRegistry,
    session_id: &str,
    root: &paths::Root,
    path: &str,
    offset: u64,
    max_bytes: u32,
    expected: Option<&str>,
) -> Result<Value, ServiceError> {
    validate_read(path, offset, max_bytes, expected)?;
    let session = registry
        .session(session_id)
        .map_err(|_| ServiceError::unavailable())?;
    let remote = paths::check_remote(&session, &root.remote, path, false).await?;
    let mut file = session
        .open(remote.clone())
        .await
        .map_err(|_| ServiceError::failed())?;
    let before = file.metadata().await.map_err(|_| ServiceError::failed())?;
    if !before.file_type().is_file() {
        return Err(invalid());
    }
    if before.size.is_some_and(|size| size > MAX_FILE_BYTES as u64) {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_FILE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| ServiceError::failed())?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err(too_large());
    }
    let after = file.metadata().await.map_err(|_| ServiceError::failed())?;
    paths::check_remote(&session, &root.remote, path, false).await?;
    let current = session
        .symlink_metadata(remote)
        .await
        .map_err(|_| ServiceError::failed())?;
    if before.size != after.size
        || before.mtime != after.mtime
        || after.size != current.size
        || after.mtime != current.mtime
        || after.size.is_some_and(|size| size != bytes.len() as u64)
    {
        return Err(conflict());
    }
    let mut result = text_page(&bytes, offset, max_bytes, expected)?;
    result["rootId"] = json!(root.id);
    result["path"] = json!(path);
    Ok(result)
}

pub(super) async fn find_files(
    registry: &SftpRegistry,
    session_id: &str,
    root: &paths::Root,
    path: &str,
    query: &str,
    depth: u8,
    results: u16,
) -> Result<Value, ServiceError> {
    validate_find(path, query, depth, results)?;
    let mut value = walk(path, query, depth, results, |relative| async move {
        paths::list_directory(registry, session_id, root, &relative).await
    })
    .await?;
    value["rootId"] = json!(root.id);
    Ok(value)
}

async fn walk<F, Fut>(
    path: &str,
    query: &str,
    max_depth: u8,
    max_results: u16,
    mut list: F,
) -> Result<Value, ServiceError>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<Value, ServiceError>>,
{
    let needle = query.to_lowercase();
    let mut queue = VecDeque::from([(path.to_string(), 0u8)]);
    let mut matches = Vec::new();
    let mut limits = BTreeSet::new();
    let mut scanned = 0;
    let mut directories = 0;
    let mut skipped = 0;
    // Leave time for DesktopService's final authorization check (10s total).
    let deadline = Instant::now() + Duration::from_secs(8);
    'search: while let Some((relative, depth)) = queue.pop_front() {
        if directories >= MAX_DIRECTORIES {
            limits.insert("directories");
            break;
        }
        let directory = match timeout_at(deadline, list(relative)).await {
            Ok(Ok(value)) => value,
            Ok(Err(error)) if directories == 0 => return Err(error),
            Ok(Err(_)) => {
                skipped += 1;
                directories += 1;
                limits.insert("unreadableDirectory");
                continue;
            }
            Err(_) => {
                limits.insert("timeout");
                break;
            }
        };
        directories += 1;
        if directory["truncated"] == true {
            limits.insert("directoryEntries");
        }
        let entries = directory["entries"]
            .as_array()
            .ok_or_else(ServiceError::failed)?;
        for entry in entries {
            if scanned >= MAX_ENTRIES {
                limits.insert("entries");
                break 'search;
            }
            scanned += 1;
            match entry["kind"].as_str() {
                Some("file")
                    if entry["name"]
                        .as_str()
                        .is_some_and(|name| name.to_lowercase().contains(&needle)) =>
                {
                    if matches.len() >= usize::from(max_results) {
                        limits.insert("results");
                        break 'search;
                    }
                    matches.push(entry.clone());
                }
                Some("directory") => {
                    if depth >= max_depth {
                        limits.insert("depth");
                    } else if queue.len() + directories >= MAX_DIRECTORIES {
                        limits.insert("directories");
                    } else if let Some(child) = entry["path"].as_str() {
                        queue.push_back((child.to_string(), depth + 1));
                    }
                }
                _ => {}
            }
        }
    }
    Ok(json!({
        "path": path, "nameContains": query, "matches": matches,
        "truncated": !limits.is_empty(), "limitsReached": limits,
        "directoriesScanned": directories, "entriesScanned": scanned,
        "skippedDirectories": skipped, "maxDepth": max_depth, "maxResults": max_results
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_preserve_utf8_and_detect_version_changes() {
        let text = "a中🙂尾";
        let mut offset = 0;
        let mut rebuilt = String::new();
        while offset < text.len() as u64 {
            let page =
                text_page(text.as_bytes(), offset, 4, Some(&sha256(text.as_bytes()))).unwrap();
            rebuilt.push_str(page["text"].as_str().unwrap());
            let next = page["nextOffset"].as_u64().unwrap();
            assert!(next > offset);
            offset = next;
        }
        assert_eq!(rebuilt, text);
        assert!(text_page(text.as_bytes(), 2, 4, None).is_err());
        assert!(text_page(text.as_bytes(), 100, 4, None).is_err());
        assert_eq!(
            text_page(b"new", 0, 4, Some(&sha256(b"old")))
                .unwrap_err()
                .code,
            "file_conflict"
        );
        assert_eq!(text_page(b"", 0, 4, None).unwrap()["hasMore"], false);
        for bytes in [b"\xff".as_slice(), b"a\0b".as_slice()] {
            assert_eq!(
                text_page(bytes, 0, 4, None).unwrap_err().code,
                "unsupported_encoding"
            );
        }
        assert!(text_page(&vec![b'x'; MAX_FILE_BYTES + 1], 0, 4, None).is_err());
    }

    #[test]
    fn query_validation_bounds_paths_sizes_and_depth() {
        for path in ["", "../escape", "/absolute", "a\\b"] {
            assert!(validate_read(path, 0, 4, None).is_err());
        }
        for size in [0, 3, MAX_PAGE_BYTES + 1] {
            assert!(validate_read("a.txt", 0, size, None).is_err());
        }
        assert!(validate_read("a.txt", 0, 4, Some("not a hash")).is_err());
        assert!(validate_find("", "README", 0, 1).is_ok());
        assert!(validate_find("", " ", 3, 50).is_err());
        assert!(validate_find("", "x", 9, 50).is_err());
        assert!(validate_find("", "x", 3, 201).is_err());
    }

    fn directory(entries: Value) -> Value {
        json!({"entries": entries, "truncated": false})
    }

    #[tokio::test]
    async fn search_reports_depth_results_and_unreadable_directories() {
        let root = directory(json!([
            {"name":"README.md","path":"README.md","kind":"file"},
            {"name":"sub","path":"sub","kind":"directory"},
            {"name":"readme-link","path":"readme-link","kind":"symlink"}
        ]));
        let shallow = walk("", "readme", 0, 50, |_| async { Ok(root.clone()) })
            .await
            .unwrap();
        assert_eq!(shallow["matches"].as_array().unwrap().len(), 1);
        assert_eq!(shallow["limitsReached"], json!(["depth"]));
        let nested = walk("", "readme", 3, 1, |path| {
            let value = if path.is_empty() {
                root.clone()
            } else {
                directory(json!([{"name":"README.txt","path":"sub/README.txt","kind":"file"}]))
            };
            async { Ok(value) }
        })
        .await
        .unwrap();
        assert_eq!(nested["matches"].as_array().unwrap().len(), 1);
        assert_eq!(nested["limitsReached"], json!(["results"]));
        let skipped = walk("", "readme", 3, 50, |path| {
            let value = if path.is_empty() {
                Ok(root.clone())
            } else {
                Err(ServiceError::failed())
            };
            async { value }
        })
        .await
        .unwrap();
        assert_eq!(skipped["skippedDirectories"], 1);
        assert_eq!(skipped["truncated"], true);
    }

    #[tokio::test]
    async fn search_is_bounded_and_reports_upstream_truncation() {
        let broad = walk("", "absent", 8, 200, |path| async move {
            let entries: Vec<_> = (0..512).map(|i| json!({
                "name": format!("dir{i}"), "path": format!("{path}/dir{i}"), "kind":"directory"
            })).collect();
            Ok(json!({"entries": entries, "truncated": true}))
        })
        .await
        .unwrap();
        assert!(broad["directoriesScanned"].as_u64().unwrap() <= MAX_DIRECTORIES as u64);
        assert!(broad["entriesScanned"].as_u64().unwrap() <= MAX_ENTRIES as u64);
        assert_eq!(broad["truncated"], true);
        assert!(broad["limitsReached"]
            .as_array()
            .unwrap()
            .contains(&json!("directoryEntries")));
        let complete = walk("", "absent", 0, 50, |_| async { Ok(directory(json!([]))) })
            .await
            .unwrap();
        assert_eq!(complete["truncated"], false);
        assert!(
            walk("", "x", 0, 50, |_| async { Err(ServiceError::denied()) })
                .await
                .is_err()
        );
    }
}
