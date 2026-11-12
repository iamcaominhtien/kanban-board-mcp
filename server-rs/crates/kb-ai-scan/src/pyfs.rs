//! The file helpers of `repo_scan.py` (lines 62-74: `_read`, `_json`) and the order in which Python's `pathlib` and
//! `os.walk` visit a tree.
//!
//! The order matters: `root.rglob("package.json")[:12]` keeps the first twelve manifests in the order the directories
//! are read, and that order is the file system's. Both languages read a directory through the system (`scandir` /
//! `read_dir`), so the same walk gives the same order; this file is that walk as Python 3.12's `pathlib` makes it
//! (`_RecursiveWildcardSelector`: the root, then, for every directory in depth-first order, its sub-directories
//! *before* the next level) and as `os.walk` makes it.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::Error;

/// `path.read_text(encoding="utf-8", errors="replace")[:limit]`, `""` when the file cannot be read. Python's text mode
/// reads `\r\n` and `\r` as `\n`.
pub fn read(path: &Path, limit: usize) -> String {
    let Ok(bytes) = std::fs::read(path) else {
        return String::new();
    };
    let text = String::from_utf8_lossy(&bytes);
    let text = if text.contains('\r') { text.replace("\r\n", "\n").replace('\r', "\n") } else { text.into_owned() };
    match text.char_indices().nth(limit) {
        Some((at, _)) => text[..at].to_string(),
        None => text,
    }
}

/// `_read(path)` with the default limit of 200 000 characters.
pub fn read_default(path: &Path) -> String {
    read(path, 200_000)
}

/// `_json(path)`: what `json.loads` gives for the file (any JSON value), `{}` when it is not JSON or cannot be read.
pub fn json(path: &Path) -> Value {
    serde_json::from_str(&read_default(path)).unwrap_or_else(|_| Value::Object(Map::new()))
}

/// The name Python gives the type of a JSON value (`type(x).__name__`).
pub fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "NoneType",
        Value::Bool(_) => "bool",
        Value::Number(n) if n.is_f64() => "float",
        Value::Number(_) => "int",
        Value::String(_) => "str",
        Value::Array(_) => "list",
        Value::Object(_) => "dict",
    }
}

/// `value.get(key)` on what `json.loads` gave: only a dict has `get` (anything else is the `AttributeError`).
pub fn get<'a>(value: &'a Value, key: &str) -> Result<Option<&'a Value>, Error> {
    match value {
        Value::Object(map) => Ok(map.get(key)),
        other => Err(Error::Other(format!("'{}' object has no attribute 'get'", type_name(other)))),
    }
}

/// `{**value}` of a value that is not None / empty: only a dict is a mapping (the `TypeError` otherwise).
pub fn mapping(value: &Value) -> Result<Map<String, Value>, Error> {
    match value {
        Value::Object(map) => Ok(map.clone()),
        other => Err(Error::Other(format!("'{}' object is not a mapping", type_name(other)))),
    }
}

/// `str(Path(text))`: empty is `.`, repeated and trailing slashes and `.` parts go, a leading `//` (exactly two)
/// stays.
pub fn path_str(text: &str) -> String {
    if text.is_empty() {
        return ".".to_string();
    }
    let leading = text.chars().take_while(|c| *c == '/').count();
    let prefix = match leading {
        0 => "",
        2 => "//",
        _ => "/",
    };
    let body: Vec<&str> = text.split('/').filter(|p| !p.is_empty() && *p != ".").collect();
    let body = body.join("/");
    if prefix.is_empty() && body.is_empty() { ".".to_string() } else { format!("{prefix}{body}") }
}

/// The parts of `Path(text).parts` (the root `/` is not a name any filter looks for, so it is left out).
pub fn parts(text: &str) -> Vec<String> {
    text.split('/').filter(|p| !p.is_empty() && *p != ".").map(str::to_string).collect()
}

/// `a / b` for a relative path kept as text (`""` is the root).
pub fn join_rel(rel: &str, name: &str) -> String {
    if rel.is_empty() { name.to_string() } else { format!("{rel}/{name}") }
}

/// Whether a path exists, following links (`Path.exists()`).
pub fn exists(path: &Path) -> bool {
    path.exists()
}

fn names_of(dir: &Path) -> Option<Vec<(String, std::fs::FileType)>> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else { continue };
        let Ok(kind) = entry.file_type() else { continue };
        out.push((name, kind));
    }
    Some(out)
}

/// The directories `Path.rglob(...)` looks into, in its order (Python 3.12): the root, then for each directory the walk
/// reaches (depth-first), its real sub-directories (a link to a directory is not one) in the order they are read.
/// `prune(name)` drops a sub-directory with everything below it: only for names every caller filters out afterwards
/// (the result is the same, the walk is shorter). Returns the directory and its path from the root (`""` for the root).
pub fn walk_dirs(root: &Path, prune: &dyn Fn(&str) -> bool) -> Vec<(PathBuf, String)> {
    let mut starts: Vec<(PathBuf, String)> = vec![(root.to_path_buf(), String::new())];
    let mut stack: Vec<(PathBuf, String)> = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, rel)) = stack.pop() {
        let Some(entries) = names_of(&dir) else { continue };
        let names: Vec<String> =
            entries.into_iter().filter(|(n, kind)| kind.is_dir() && !prune(n)).map(|(n, _)| n).collect();
        for name in &names {
            starts.push((dir.join(name), join_rel(&rel, name)));
        }
        for name in names.iter().rev() {
            stack.push((dir.join(name), join_rel(&rel, name)));
        }
    }
    starts
}

/// The entries of a directory in the order they are read, with their names.
pub fn entry_names(dir: &Path) -> Vec<String> {
    names_of(dir).map(|v| v.into_iter().map(|(n, _)| n).collect()).unwrap_or_default()
}

/// `os.walk(top)`: `visit(dirpath, dirs, names)` gets each directory top-down; it may change `dirs` (what is left is
/// walked, a link to a directory is listed but not entered) and returns false to stop the walk (Python's `break`).
pub fn os_walk(top: &Path, visit: &mut dyn FnMut(&Path, &mut Vec<String>, &[String]) -> bool) {
    walk(top, visit);
}

fn walk(top: &Path, visit: &mut dyn FnMut(&Path, &mut Vec<String>, &[String]) -> bool) -> bool {
    let Ok(entries) = std::fs::read_dir(top) else {
        return true;
    };
    let mut dirs: Vec<String> = Vec::new();
    let mut names: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else { continue };
        // `entry.is_dir()` follows links; an error counts as "not a directory"
        if entry.path().is_dir() { dirs.push(name) } else { names.push(name) }
    }
    if !visit(top, &mut dirs, &names) {
        return false;
    }
    for name in &dirs {
        let path = top.join(name);
        let is_link = std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink());
        if !is_link && !walk(&path, visit) {
            return false;
        }
    }
    true
}
