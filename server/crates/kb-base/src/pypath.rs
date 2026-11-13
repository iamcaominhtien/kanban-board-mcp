//! `os.path` as the Python server used it, on text (the paths are stored and shown as text).
//!
//! Written for POSIX paths (`posixpath`); on Windows the separators of both kinds are understood and the native
//! one is written, which is what `ntpath` does for the paths the board handles.

use std::path::{MAIN_SEPARATOR, MAIN_SEPARATOR_STR, Path, PathBuf};

fn is_sep(c: char) -> bool {
    c == '/' || (cfg!(windows) && c == '\\')
}

/// `os.path.expanduser(path)`: a leading `~` is the home folder. `~name` (another user's home) is left as it is.
pub fn expanduser(path: &str) -> String {
    if !path.starts_with('~') {
        return path.to_string();
    }
    let rest = &path[1..];
    if !rest.is_empty() && !rest.starts_with(is_sep) {
        return path.to_string();
    }
    let home = if cfg!(windows) { std::env::var("USERPROFILE") } else { std::env::var("HOME") };
    match home {
        Ok(home) if !home.is_empty() => {
            // posixpath: "~" with HOME=/ is "/", and a trailing separator of HOME is dropped
            let home = home.trim_end_matches(is_sep);
            let joined = format!("{home}{rest}");
            if joined.is_empty() { MAIN_SEPARATOR_STR.to_string() } else { joined }
        }
        _ => path.to_string(),
    }
}

/// `os.path.isabs(path)`.
pub fn isabs(path: &str) -> bool {
    if cfg!(windows) { Path::new(path).is_absolute() } else { path.starts_with('/') }
}

/// `os.path.basename(path)`: what follows the last separator (empty for a path that ends with one).
pub fn basename(path: &str) -> &str {
    match path.rfind(is_sep) {
        Some(i) => &path[i + 1..],
        None => path,
    }
}

/// `os.path.dirname(path)`.
pub fn dirname(path: &str) -> &str {
    match path.rfind(is_sep) {
        Some(i) => {
            let head = &path[..i + 1];
            let trimmed = head.trim_end_matches(is_sep);
            // a head that is only separators is the root
            if trimmed.is_empty() { head } else { trimmed }
        }
        None => "",
    }
}

/// `os.path.join(base, path)`.
pub fn join(base: &str, path: &str) -> String {
    if isabs(path) {
        path.to_string()
    } else if base.is_empty() || base.ends_with(is_sep) {
        format!("{base}{path}")
    } else {
        format!("{base}{MAIN_SEPARATOR}{path}")
    }
}

/// `os.path.normpath(path)`: `.` and doubled separators removed, `..` resolved on the text alone.
pub fn normpath(path: &str) -> String {
    if path.is_empty() {
        return ".".to_string();
    }
    let (prefix, rest) = split_root(path);
    let rooted = !prefix.is_empty();
    let mut parts: Vec<&str> = Vec::new();
    for part in rest.split(is_sep) {
        match part {
            "" | "." => {}
            ".." => match parts.last() {
                Some(&last) if last != ".." => {
                    parts.pop();
                }
                _ if rooted => {}
                _ => parts.push(".."),
            },
            other => parts.push(other),
        }
    }
    let out = format!("{prefix}{}", parts.join(MAIN_SEPARATOR_STR));
    if out.is_empty() { ".".to_string() } else { out }
}

/// The root of a path (`/`, `//` as POSIX keeps exactly two, `C:\` on Windows) and what follows it.
fn split_root(path: &str) -> (String, &str) {
    if cfg!(windows) {
        let bytes = path.as_bytes();
        let drive = if bytes.len() >= 2 && bytes[1] == b':' { 2 } else { 0 };
        let after = &path[drive..];
        let rest = after.trim_start_matches(is_sep);
        let root = if rest.len() < after.len() { MAIN_SEPARATOR_STR } else { "" };
        return (format!("{}{root}", &path[..drive]), rest);
    }
    let rest = path.trim_start_matches('/');
    let slashes = path.len() - rest.len();
    let root = match slashes {
        0 => "",
        2 => "//",
        _ => "/",
    };
    (root.to_string(), rest)
}

/// `os.path.exists(path)`: false for a broken link and for a path that cannot be read.
pub async fn exists(path: &str) -> bool {
    tokio::fs::try_exists(path).await.unwrap_or(false)
}

/// `os.path.realpath(path)`: absolute, without `.`, `..` or symbolic links. A part that does not exist is kept as
/// written (Python does not require the path to exist).
pub async fn realpath(path: &str) -> String {
    let absolute = if isabs(path) {
        path.to_string()
    } else {
        let cwd = std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        join(&cwd, path)
    };
    let normal = normpath(&absolute);
    let (prefix, rest) = split_root(&normal);
    // POSIX realpath gives one leading slash
    let root = if prefix == "//" { "/".to_string() } else { prefix };
    let mut resolved = PathBuf::from(&root);
    let mut todo: Vec<String> = rest.split(is_sep).filter(|p| !p.is_empty()).rev().map(str::to_string).collect();
    // a loop of links ends here, as the kernel's limit ends it for Python
    let mut links_left = 40;
    while let Some(part) = todo.pop() {
        if part == "." {
            continue;
        }
        if part == ".." {
            resolved.pop();
            continue;
        }
        let candidate = resolved.join(&part);
        let target = match tokio::fs::symlink_metadata(&candidate).await {
            Ok(meta) if meta.file_type().is_symlink() && links_left > 0 => tokio::fs::read_link(&candidate).await.ok(),
            _ => None,
        };
        match target {
            Some(target) => {
                links_left -= 1;
                let target = target.to_string_lossy().into_owned();
                if isabs(&target) {
                    let (prefix, _) = split_root(&target);
                    resolved = PathBuf::from(if prefix == "//" { "/".to_string() } else { prefix });
                }
                let (_, rest) = split_root(&target);
                todo.extend(rest.split(is_sep).filter(|p| !p.is_empty()).rev().map(str::to_string));
            }
            None => resolved = candidate,
        }
    }
    resolved.to_string_lossy().into_owned()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn normpath_matches_posixpath() {
        for (path, expected) in [
            ("", "."),
            ("a/./b//c/", "a/b/c"),
            ("/a/b/../c", "/a/c"),
            ("/../a", "/a"),
            ("../a/..", ".."),
            ("a/..", "."),
            ("//a", "//a"),
            ("///a", "/a"),
            ("/", "/"),
        ] {
            assert_eq!(normpath(path), expected, "{path:?}");
        }
    }

    #[test]
    fn join_basename_dirname_match_posixpath() {
        assert_eq!(join("/repo", "../wt"), "/repo/../wt");
        assert_eq!(join("/repo/", "wt"), "/repo/wt");
        assert_eq!(join("/repo", "/abs"), "/abs");
        assert_eq!(basename("/a/b"), "b");
        assert_eq!(basename("/a/b/"), "");
        assert_eq!(dirname("/a/b"), "/a");
        assert_eq!(dirname("/a"), "/");
        assert_eq!(dirname("a"), "");
        assert_eq!(dirname("/a//b"), "/a");
    }

    #[test]
    fn expanduser_only_expands_the_callers_home() {
        let home = std::env::var("HOME").unwrap_or_default();
        if !home.is_empty() {
            assert_eq!(expanduser("~/x"), format!("{}/x", home.trim_end_matches('/')));
        }
        assert_eq!(expanduser("/x/~"), "/x/~");
        assert_eq!(expanduser("~nobody-here/x"), "~nobody-here/x");
    }

    #[tokio::test]
    async fn realpath_follows_links_and_keeps_missing_parts() {
        let dir = tempfile::tempdir().expect("temporary folder");
        let root = realpath(&dir.path().to_string_lossy()).await;
        std::fs::create_dir_all(format!("{root}/real/sub")).expect("mkdir");
        std::os::unix::fs::symlink(format!("{root}/real"), format!("{root}/link")).expect("symlink");
        std::os::unix::fs::symlink("real/sub", format!("{root}/rel")).expect("symlink");
        assert_eq!(realpath(&format!("{root}/link/sub/../sub")).await, format!("{root}/real/sub"));
        assert_eq!(realpath(&format!("{root}/rel")).await, format!("{root}/real/sub"));
        assert_eq!(realpath(&format!("{root}/link/missing/x")).await, format!("{root}/real/missing/x"));
        assert_eq!(realpath(&format!("{root}/./real//sub/")).await, format!("{root}/real/sub"));
    }
}
