//! Pictures and files in what an AI reads, as files it can open.
//!
//! A comment, a description or a Docs page shows a pasted picture as `![name](/uploads/…)`: a web path, not a file on
//! this computer, and the uploads folder is outside the folders a run may read (it also holds people's private chat
//! files, so it is never opened to an AI as a whole). Before a prompt goes out, each upload it names is copied into a
//! folder of that call only, which the CLI is allowed to read (`--add-dir`), and the prompt ends with where each one is,
//! to open with Read (Claude reads images).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use kb_base::pypath;
use kb_files::uploads::{PRIVATE_DIR, resolve_upload_path};
use regex::Regex;

static UPLOAD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"/uploads/([^\s)"'\]<>\\|?\#]{1,300})"#).expect("the upload pattern written in the code compiles")
});
static UNSAFE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^A-Za-z0-9_-]").expect("the key pattern written in the code compiles"));

/// The folder of one call's copies (a run, a chat answer, a Docs answer).
pub fn folder_for(key: &str) -> PathBuf {
    let safe: String = UNSAFE.replace_all(key, "_").chars().take(80).collect();
    std::env::temp_dir().join("kanban-ai-pictures").join(safe)
}

/// `Path(rel).name` for a POSIX path: the last part, `.` parts and empty parts left out.
fn name_of(rel: &str) -> &str {
    rel.split('/').rfind(|p| !p.is_empty() && *p != ".").unwrap_or("")
}

/// Copy the uploads `text` names into the call's folder and add where they are. Returns (the text with a note at its
/// end, or as it was; the folder to let the CLI read, or None).
pub fn stage(text: &str, key: &str) -> std::io::Result<(String, Option<String>)> {
    let mut found: Vec<(String, PathBuf)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for caps in UPLOAD.captures_iter(text) {
        let rel = caps[1].to_string();
        if seen.contains(&rel) || rel.split('/').next().unwrap_or("").to_lowercase() == PRIVATE_DIR {
            continue;
        }
        seen.insert(rel.clone());
        if let Some(path) = resolve_upload_path(&rel).filter(|p| p.is_file()) {
            found.push((rel, path));
        }
    }
    if found.is_empty() {
        return Ok((text.to_string(), None));
    }
    let folder = folder_for(key);
    std::fs::create_dir_all(&folder)?;
    let folder_text = folder.to_string_lossy().into_owned();
    let mut lines = Vec::new();
    for (rel, path) in &found {
        // the copy keeps only the file name and must stay inside the call's folder (no "..", no separators)
        let target = pypath::normpath(&pypath::join(&folder_text, name_of(rel)));
        if !target.starts_with(&format!("{folder_text}/")) {
            continue;
        }
        let copy = Path::new(&target);
        if !copy.exists() {
            copy2(path, copy)?;
        }
        lines.push(format!("- /uploads/{rel} → {target}"));
    }
    let note = format!(
        "Pictures and files in the text above, as files on this computer: open each with Read to see it (Read shows images) before you answer about it.\n{}",
        lines.join("\n")
    );
    Ok((format!("{text}\n\n{note}"), Some(folder_text)))
}

/// `shutil.copy2`: the content, the permissions and the modification time.
fn copy2(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::copy(from, to)?;
    if let Ok(modified) = std::fs::metadata(from).and_then(|m| m.modified()) {
        let file = std::fs::OpenOptions::new().write(true).open(to)?;
        file.set_modified(modified)?;
    }
    Ok(())
}
