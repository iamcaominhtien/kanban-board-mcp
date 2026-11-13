//! Reading from the server's own disk (MCP) (`services/docs_import.py` lines 536-584).

use std::path::{Path, PathBuf};

use super::{EXTENSIONS, MAX_FILES, SKIP_DIRS};
use crate::{Result, docs_err};

/// `os.path.expanduser(path)`.
fn expand_user(path: &str) -> PathBuf {
    if path == "~" || path.starts_with("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return Path::new(&home).join(path.trim_start_matches('~').trim_start_matches('/'));
        }
    }
    PathBuf::from(path)
}

/// Read one Markdown file, or every `.md`/`.markdown` file under a folder.
///
/// Returns `(relative path, bytes)` pairs. Fails with 404 if the path is missing and 422 if no Markdown files are
/// found or a limit is exceeded.
pub fn collect_local(path: &str) -> Result<Vec<(String, Vec<u8>)>> {
    let root = expand_user(path);
    if !root.exists() {
        return docs_err(404, "path_not_found", format!("Path not found: {path}"));
    }
    let read = |p: &Path| std::fs::read(p).map_err(|e| crate::Error::Other(format!("{}: {e}", p.display())));
    if root.is_file() {
        let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        return Ok(vec![(name, read(&root)?)]);
    }
    let mut out: Vec<(String, Vec<u8>)> = Vec::new();
    let base = root.canonicalize().unwrap_or_else(|_| root.clone());
    walk(&root, &root, &base, &mut out, &read)?;
    if out.is_empty() {
        return docs_err(422, "no_files", format!("No .md or .markdown files found in {path}"));
    }
    Ok(out)
}

/// `os.walk(root)` with the folders sorted, the hidden and `SKIP_DIRS` ones left out, and the files sorted.
fn walk(
    root: &Path,
    dir: &Path,
    base: &Path,
    out: &mut Vec<(String, Vec<u8>)>,
    read: &dyn Fn(&Path) -> Result<Vec<u8>>,
) -> Result<()> {
    let mut dirs: Vec<String> = Vec::new();
    let mut files: Vec<String> = Vec::new();
    if let Ok(listing) = std::fs::read_dir(dir) {
        for entry in listing.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            // os.walk lists a link to a folder with the folders
            if entry.path().is_dir() {
                dirs.push(name);
            } else {
                files.push(name);
            }
        }
    }
    files.sort();
    for name in &files {
        if name.starts_with('.') || !EXTENSIONS.iter().any(|x| name.to_lowercase().ends_with(x)) {
            continue;
        }
        let full = dir.join(name);
        // a symlink pointing outside the folder
        if !full.canonicalize().is_ok_and(|p| p.starts_with(base)) {
            continue;
        }
        if out.len() > MAX_FILES {
            return docs_err(422, "too_many_files", format!("At most {MAX_FILES} files can be imported at once"));
        }
        let relative = full.strip_prefix(root).unwrap_or(&full).to_string_lossy().replace('\\', "/");
        out.push((relative, read(&full)?));
    }
    dirs.retain(|d| !d.starts_with('.') && !SKIP_DIRS.contains(&d.as_str()));
    dirs.sort();
    for d in dirs {
        // `os.walk` does not follow links to folders
        let path = dir.join(&d);
        if std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
            continue;
        }
        walk(root, &path, base, out, read)?;
    }
    Ok(())
}
