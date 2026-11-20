//! `docs_write(upload)` of a web page: a folder, a `.zip` or an `.html` file becomes a site (`kb_docs::docs_sites`)
//! that an HTML embed shows by its `src`, and the reply gives the embed's marker line to put in a page.

use std::path::{Path, PathBuf};

use kb_base::{pypath, pytext};
use kb_docs::docs_sites;
use kb_files::pathlib;
use serde_json::{Map, Value, json};

use super::canvases::ai_folder;
use super::docs::docs_error;
use crate::common::{self, ToolError, ToolResult};

/// Returns whether a file name is uploaded as a site: a `.zip`, `.html` or `.htm` file.
pub fn is_site_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [".zip", ".html", ".htm"].iter().any(|ext| lower.ends_with(ext))
}

/// Writes a value of a marker line as a JSON string, safe inside an HTML comment (as the annotated writer does).
fn marker_value(v: &str) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "\"\"".into()).replace("--", "-\\u002d").replace('>', "\\u003e")
}

/// The title of a site uploaded from `path`: `name` when given, else the folder's name or the file's name without
/// its extension.
fn title_of(path: &str, name: Option<&str>) -> String {
    if let Some(n) = name.map(str::trim).filter(|n| !n.is_empty()) {
        return n.chars().take(200).collect();
    }
    let base = pathlib::name(path.trim_end_matches(['/', '\\']));
    let stem = match base.rsplit_once('.') {
        Some((stem, ext)) if is_site_file(&format!(".{ext}")) && !stem.is_empty() => stem,
        _ => base,
    };
    stem.chars().take(200).collect()
}

/// Makes the site of `files` (blocking work off the async threads) and answers `{id, url, entry, files, bytes,
/// markdown}`: `files` is the number of files, `markdown` the embed's marker line.
async fn make_site(files: Vec<(String, Vec<u8>)>, title: &str) -> ToolResult {
    let made = tokio::task::spawn_blocking(move || docs_sites::create_site(files, None))
        .await
        .map_err(|e| ToolError::Other(format!("the site upload stopped: {e}")))?
        .map_err(docs_error)?;
    let url = made.get("url").and_then(Value::as_str).unwrap_or_default().to_string();
    let count = made.get("files").and_then(Value::as_array).map_or(0, Vec::len);
    let mut out = Map::new();
    out.insert("id".into(), made.get("id").cloned().unwrap_or(Value::Null));
    out.insert("url".into(), json!(url));
    out.insert("entry".into(), made.get("entry").cloned().unwrap_or(Value::Null));
    out.insert("files".into(), json!(count));
    out.insert("bytes".into(), made.get("bytes").cloned().unwrap_or(Value::Null));
    let title = if title.is_empty() { String::new() } else { format!(" title={}", marker_value(title)) };
    out.insert("markdown".into(), json!(format!("<!-- htmlEmbed src={}{title} -->", marker_value(&url))));
    Ok(Value::Object(out))
}

/// The site of one `.zip` or `.html` file given as data (base64 already decoded).
pub async fn site_from_data(name: &str, content: Vec<u8>) -> ToolResult {
    let clean: String = pathlib::name(name).chars().take(200).collect();
    let title = title_of(&clean, None);
    make_site(vec![(clean, content)], &title).await
}

/// Reads the files of a folder for a site: `(relative path, bytes)`. `.git` folders are left out, and for an AI run
/// also what is never taken from its folder (keys, `.env`, dot folders). Fails above the site's limits before
/// reading more.
fn read_folder(root: &Path, ai_run: bool) -> Result<Vec<(String, Vec<u8>)>, ToolError> {
    let mut out = Vec::new();
    let mut total: u64 = 0;
    let mut stack: Vec<(PathBuf, String, usize)> = vec![(root.to_path_buf(), String::new(), 0)];
    while let Some((dir, prefix, depth)) = stack.pop() {
        let entries = std::fs::read_dir(&dir).map_err(|e| ToolError::Value(format!("{}: {e}.", dir.display())))?;
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
            let Ok(ft) = e.file_type() else { continue };
            if name == ".git" || (ai_run && kb_board::proofs::never_copied(&rel)) {
                continue;
            }
            if ft.is_dir() {
                if depth < 32 {
                    stack.push((e.path(), rel, depth + 1));
                }
                continue;
            }
            // a link is followed (a file of the folder that points elsewhere is read as that file)
            let Ok(meta) = std::fs::metadata(e.path()) else { continue };
            if !meta.is_file() {
                continue;
            }
            total += meta.len();
            if total > docs_sites::MAX_SITE_BYTES {
                return Err(ToolError::Value(format!(
                    "{}: more than {} MB; a site can be {} MB at most.",
                    root.display(),
                    docs_sites::MAX_SITE_BYTES / (1024 * 1024),
                    docs_sites::MAX_SITE_BYTES / (1024 * 1024)
                )));
            }
            if out.len() >= docs_sites::MAX_SITE_FILES {
                return Err(ToolError::Value(format!(
                    "{}: more than {} files; a site can have {} files at most.",
                    root.display(),
                    docs_sites::MAX_SITE_FILES,
                    docs_sites::MAX_SITE_FILES
                )));
            }
            let data = std::fs::read(e.path()).map_err(|err| ToolError::Value(format!("{rel}: {err}.")))?;
            out.push((rel, data));
        }
    }
    if out.is_empty() {
        return Err(ToolError::Value(format!("{}: the folder has no files.", root.display())));
    }
    Ok(out)
}

/// The site of a path `docs_write(upload)` was given, when it is one: a folder (absolute), or a `.zip` or `.html`
/// file (absolute, or in an AI run a path in its working folder). `Ok(None)` for any other file, which is stored
/// as a file.
///
/// # Errors
/// The folder rules of an AI run (`ai_folder`: not the computer's root, the home folder or a dot folder in it), a
/// missing file, and the site's own refusals (no `.html` page, too large, an unsafe path in a zip…).
pub async fn site_from_path(path: &str, name: Option<&str>) -> Result<Option<Value>, ToolError> {
    let given = pypath::expanduser(pytext::strip(path));
    let as_path = PathBuf::from(&given);
    let ai_run = kb_ai::guard::current().is_some();
    if as_path.is_absolute() && as_path.is_dir() {
        let root = ai_folder(&given, false)?;
        let title = title_of(&given, name);
        let files = tokio::task::spawn_blocking(move || read_folder(&root, ai_run))
            .await
            .map_err(|e| ToolError::Other(format!("the folder could not be read: {e}")))??;
        return make_site(files, &title).await.map(Some);
    }
    if !is_site_file(&given) {
        return Ok(None);
    }
    let file = if as_path.is_absolute() {
        if ai_run {
            let parent = as_path.parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
            ai_folder(&parent, false)?;
            if kb_board::proofs::never_copied(pathlib::name(&given)) {
                return Err(ToolError::Value(format!("{path}: this kind of file is never taken from a folder.")));
            }
        }
        as_path
    } else {
        // in a board run, a path in the run's working folder (its worktree first)
        let folders = common::attach_folder().await?.unwrap_or_default();
        let found = folders
            .iter()
            .filter(|f| f.as_str() != kb_board::proofs::OUTSIDE_RUN)
            .map(|f| Path::new(f).join(&given))
            .find(|p| p.is_file());
        match found {
            Some(p) => p,
            None => {
                return Err(ToolError::Value(format!(
                    "{path}: no such file. Give its absolute path (in a board run: a path in your working folder)."
                )));
            }
        }
    };
    if !file.is_file() {
        return Err(ToolError::Value(format!("{path}: no such file. Save it first, then upload it.")));
    }
    let title = title_of(&given, name);
    let file_name = pathlib::name(&given).to_string();
    let data = tokio::fs::read(&file).await.map_err(|e| ToolError::Value(format!("{path}: {e}.")))?;
    make_site(vec![(file_name, data)], &title).await.map(Some)
}

/// Reads `markdown_file` for `create`, `update` and `edit`: an absolute path to a UTF-8 Markdown file (for an AI run,
/// in a folder `ai_folder` allows).
///
/// # Errors
/// A relative path, a missing file, a folder an AI run may not read, or a file that is not UTF-8.
pub async fn read_markdown_file(path: &str) -> Result<String, ToolError> {
    let given = pypath::expanduser(pytext::strip(path));
    let as_path = PathBuf::from(&given);
    if !as_path.is_absolute() {
        return Err(ToolError::Value(format!("markdown_file: give an absolute path (got {}).", pytext::repr(path))));
    }
    if kb_ai::guard::current().is_some() {
        let parent = as_path.parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        ai_folder(&parent, false)?;
        if kb_board::proofs::never_copied(pathlib::name(&given)) {
            return Err(ToolError::Value(format!("{path}: this kind of file is never read.")));
        }
    }
    if !as_path.is_file() {
        return Err(ToolError::Value(format!("markdown_file: {path} is not a file.")));
    }
    let bytes =
        tokio::fs::read(&as_path).await.map_err(|e| ToolError::Value(format!("markdown_file: {path}: {e}.")))?;
    let text =
        String::from_utf8(bytes).map_err(|_| ToolError::Value(format!("markdown_file: {path} is not UTF-8 text.")))?;
    Ok(text.strip_prefix('\u{feff}').map(str::to_string).unwrap_or(text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_and_markers() {
        assert_eq!(title_of("/work/globe/", None), "globe");
        assert_eq!(title_of("/work/Globe.HTML", None), "Globe");
        assert_eq!(title_of("/work/pack.zip", Some(" Earth ")), "Earth");
        assert_eq!(marker_value("a -- b > c"), "\"a -\\u002d b \\u003e c\"");
        assert!(is_site_file("x.HTM") && is_site_file("a.zip") && !is_site_file("a.md"));
    }
}
