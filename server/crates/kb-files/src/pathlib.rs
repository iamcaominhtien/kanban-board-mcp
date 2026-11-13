//! The few behaviors of Python's `pathlib` (3.12) the server's file code depends on: how a path splits into parts,
//! what `name`, `stem` and `suffix` are, what `resolve()` does with a path that does not exist, and
//! `str.isprintable`.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

use unicode_properties::{GeneralCategory, UnicodeGeneralCategory};

fn is_separator(c: char) -> bool {
    c == '/' || (cfg!(windows) && c == '\\')
}

/// `Path(text).is_absolute()`.
pub fn is_absolute(text: &str) -> bool {
    text.chars().next().is_some_and(is_separator) || (cfg!(windows) && Path::new(text).is_absolute())
}

/// `Path(text).parts` without the root: the parts between separators, with empty parts and `.` dropped (`..` stays).
pub fn parts(text: &str) -> Vec<&str> {
    text.split(is_separator).filter(|part| !part.is_empty() && *part != ".").collect()
}

/// `Path(text).name`: the last part, or `""`.
pub fn name(text: &str) -> &str {
    parts(text).last().copied().unwrap_or("")
}

/// `PurePath.suffix` of a file name (3.12: a leading dot or a trailing dot makes no suffix).
pub fn suffix_of_name(name: &str) -> &str {
    match name.rfind('.') {
        Some(i) if i > 0 && i < name.len() - 1 => &name[i..],
        _ => "",
    }
}

/// `PurePath.stem` of a file name.
pub fn stem_of_name(name: &str) -> &str {
    match name.rfind('.') {
        Some(i) if i > 0 && i < name.len() - 1 => &name[..i],
        _ => name,
    }
}

/// `Path(text).suffix`.
pub fn suffix(text: &str) -> &str {
    suffix_of_name(name(text))
}

/// `Path(text).stem`.
pub fn stem(text: &str) -> &str {
    stem_of_name(name(text))
}

/// `Path.resolve()` (not strict): an absolute path with `..` applied and symbolic links followed as far as the path
/// exists; what does not exist is kept as written. The caller refuses a text with a NUL character first (Python
/// raises `ValueError` for it).
pub fn resolve(path: &Path) -> PathBuf {
    let absolute =
        if path.is_absolute() { path.to_path_buf() } else { std::env::current_dir().unwrap_or_default().join(path) };
    // what is left to walk; the target of a link is put in front of it
    let mut queue: VecDeque<OsString> = VecDeque::new();
    let mut walked = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => walked.push(component.as_os_str()),
            other => queue.push_back(other.as_os_str().to_os_string()),
        }
    }
    let mut followed = 0;
    while let Some(part) = queue.pop_front() {
        if part == "." {
            continue;
        }
        if part == ".." {
            walked.pop();
            continue;
        }
        let candidate = walked.join(&part);
        let is_link = std::fs::symlink_metadata(&candidate).is_ok_and(|meta| meta.file_type().is_symlink());
        if is_link && followed < 40 {
            if let Ok(target) = std::fs::read_link(&candidate) {
                followed += 1;
                let mut front: Vec<OsString> = Vec::new();
                for component in target.components() {
                    match component {
                        Component::Prefix(_) | Component::RootDir => {
                            walked = PathBuf::new();
                            walked.push(component.as_os_str());
                        }
                        other => front.push(other.as_os_str().to_os_string()),
                    }
                }
                for p in front.into_iter().rev() {
                    queue.push_front(p);
                }
                continue;
            }
        }
        walked = candidate;
    }
    walked
}

/// `str.isprintable()` for one character: not a control or format character, not unassigned or private, not a
/// separator other than the ASCII space.
pub fn is_printable(c: char) -> bool {
    if c == ' ' {
        return true;
    }
    !matches!(
        c.general_category(),
        GeneralCategory::Control
            | GeneralCategory::Format
            | GeneralCategory::Surrogate
            | GeneralCategory::PrivateUse
            | GeneralCategory::Unassigned
            | GeneralCategory::LineSeparator
            | GeneralCategory::ParagraphSeparator
            | GeneralCategory::SpaceSeparator
    )
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn parts_name_stem_and_suffix_follow_pathlib() {
        assert_eq!(parts("a//b/./c/.."), vec!["a", "b", "c", ".."]);
        assert_eq!(parts(""), Vec::<&str>::new());
        assert_eq!(name("dir/file.tar.gz"), "file.tar.gz");
        assert_eq!(name("dir/"), "dir");
        assert_eq!(name("/"), "");
        assert_eq!(suffix("dir/file.TAR.gz"), ".gz");
        assert_eq!(suffix(".hidden"), "");
        assert_eq!(suffix("file."), "");
        assert_eq!(suffix(".."), "");
        assert_eq!(stem(".hidden"), ".hidden");
        assert_eq!(stem("a.b.c"), "a.b");
        assert_eq!(stem(".."), "..");
        assert!(is_absolute("/etc"));
        assert!(!is_absolute("etc"));
    }

    #[test]
    fn resolve_follows_links_and_applies_dot_dot_where_nothing_exists() {
        let dir = tempfile::tempdir().expect("temp dir");
        let base = std::fs::canonicalize(dir.path()).expect("canonical");
        std::fs::create_dir(base.join("real")).expect("mkdir");
        std::os::unix::fs::symlink(base.join("real"), base.join("link")).expect("symlink");
        assert_eq!(resolve(&base.join("link/not/there.png")), base.join("real/not/there.png"));
        assert_eq!(resolve(&base.join("real/../real/./x")), base.join("real/x"));
        assert_eq!(resolve(&base.join("missing/../y")), base.join("y"));
    }

    #[test]
    fn printable_matches_python() {
        assert!(is_printable('a') && is_printable(' ') && is_printable('ế'));
        assert!(!is_printable('\n') && !is_printable('\u{200b}') && !is_printable('\u{a0}') && !is_printable('\u{7f}'));
    }
}
