//! The uploads folder: where it is, which files may be served from it, the MIME table of the file types the board
//! knows, and the names stored files get (`uploads.py`).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{Map, Value};
use unicode_normalization::UnicodeNormalization;

use crate::pathlib;

pub const UPLOADS_DIR_ENV_VAR: &str = "KANBAN_UPLOADS_DIR";
/// Files kept in the uploads folder (so a backup carries them) that are never served: `/uploads/...` answers "invalid
/// path" for anything under it. The AI chats keep the pictures and files people attach there.
pub const PRIVATE_DIR: &str = "_private";
pub const MAX_DESCRIPTION_IMAGE_BYTES: u64 = 5 * 1024 * 1024;
pub const MAX_ATTACHMENT_BYTES: u64 = 100 * 1024 * 1024;

pub const SUPPORTED_IMAGE_EXTENSIONS: &[&str] = &[".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"];

/// `MIME_BY_EXTENSION`, in the order of the Python table.
pub const MIME_BY_EXTENSION: &[(&str, &str)] = &[
    // Images
    (".png", "image/png"),
    (".jpg", "image/jpeg"),
    (".jpeg", "image/jpeg"),
    (".gif", "image/gif"),
    (".webp", "image/webp"),
    (".svg", "image/svg+xml"),
    (".bmp", "image/bmp"),
    (".ico", "image/x-icon"),
    // Text / Document / Data
    (".txt", "text/plain"),
    (".log", "text/plain"),
    (".csv", "text/csv"),
    (".tsv", "text/tab-separated-values"),
    (".json", "application/json"),
    (".xml", "application/xml"),
    (".yaml", "text/yaml"),
    (".yml", "text/yaml"),
    (".md", "text/markdown"),
    (".markdown", "text/markdown"),
    (".pdf", "application/pdf"),
    // Office documents
    (".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    (".xls", "application/vnd.ms-excel"),
    (".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    (".doc", "application/msword"),
    (".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
    (".ppt", "application/vnd.ms-powerpoint"),
    // Code & Scripts
    (".js", "text/javascript"),
    (".ts", "text/plain"),
    (".jsx", "text/plain"),
    (".tsx", "text/plain"),
    (".py", "text/plain"),
    (".css", "text/css"),
    // text/plain prevents stored XSS execution in app origin
    (".html", "text/plain"),
    (".sql", "text/plain"),
    (".sh", "text/plain"),
    (".env", "text/plain"),
    // Media
    (".mp3", "audio/mpeg"),
    (".wav", "audio/wav"),
    (".ogg", "audio/ogg"),
    (".mp4", "video/mp4"),
    (".webm", "video/webm"),
    // Archives
    (".zip", "application/zip"),
    (".tar", "application/x-tar"),
    (".gz", "application/gzip"),
    (".rar", "application/vnd.rar"),
    (".7z", "application/x-7z-compressed"),
];

pub const VIEWABLE_INLINE_EXTENSIONS: &[&str] = &[
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".svg",
    ".bmp",
    ".ico",
    ".txt",
    ".log",
    ".csv",
    ".tsv",
    ".json",
    ".xml",
    ".yaml",
    ".yml",
    ".md",
    ".markdown",
    ".pdf",
    ".js",
    ".ts",
    ".jsx",
    ".tsx",
    ".py",
    ".css",
    ".html",
    ".sql",
    ".sh",
    ".env",
    ".mp3",
    ".wav",
    ".ogg",
    ".mp4",
    ".webm",
];

/// `MIME_BY_EXTENSION.get(extension)`: the type of a file by its extension (with the dot, lower case).
pub fn mime_by_extension(extension: &str) -> Option<&'static str> {
    MIME_BY_EXTENSION.iter().find(|(ext, _)| *ext == extension).map(|(_, mime)| *mime)
}

/// `extension in VIEWABLE_INLINE_EXTENSIONS`.
pub fn is_viewable_inline(extension: &str) -> bool {
    VIEWABLE_INLINE_EXTENSIONS.contains(&extension)
}

/// `extension in SUPPORTED_IMAGE_EXTENSIONS`.
pub fn is_supported_image(extension: &str) -> bool {
    SUPPORTED_IMAGE_EXTENSIONS.contains(&extension)
}

/// `SUPPORTED_IMAGE_MIME_TYPES`: the image types, sorted, each once.
pub fn supported_image_mime_types() -> Vec<&'static str> {
    let mut types: Vec<&'static str> =
        SUPPORTED_IMAGE_EXTENSIONS.iter().filter_map(|ext| mime_by_extension(ext)).collect();
    types.sort_unstable();
    types.dedup();
    types
}

/// Where `resolve_uploads_dir` found the folder: `KANBAN_UPLOADS_DIR` (the app sets it for its own processes).
pub const SOURCE_ENV: &str = "env";
/// `data_folder` of the config file: `<data folder>/uploads`.
pub const SOURCE_DATA_FOLDER: &str = "data_folder";
/// `uploads_dir` of the config file, written by the desktop app at its start.
pub const SOURCE_CONFIG: &str = "config";
/// Next to `KANBAN_DB_PATH`.
pub const SOURCE_DB_PATH: &str = "db_path";
/// `uploads` next to the program: the last resort, and the only folder the desktop app does not serve.
pub const SOURCE_CODE: &str = "code";

static FALLBACK_LOGGED: AtomicBool = AtomicBool::new(false);

/// The folder next to the program (`server/uploads` next to the code in the Python server).
fn code_uploads_dir() -> PathBuf {
    let exe_dir = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf));
    exe_dir.unwrap_or_default().join("uploads")
}

/// `resolve_uploads_dir` with its four inputs given: the order is `KANBAN_UPLOADS_DIR`, `data_folder` of the config
/// file, the folder of `KANBAN_DB_PATH`, `uploads_dir` of the config file, then the folder next to the code.
fn pick_uploads_dir(
    env_value: Option<&str>,
    data_folder: Option<PathBuf>,
    db_env: Option<&str>,
    recorded: Option<PathBuf>,
    code_dir: impl FnOnce() -> PathBuf,
) -> (PathBuf, &'static str) {
    if let Some(value) = env_value.filter(|v| !v.is_empty()) {
        return (PathBuf::from(value), SOURCE_ENV);
    }
    if let Some(folder) = data_folder {
        return (folder.join("uploads"), SOURCE_DATA_FOLDER);
    }
    if let Some(db) = db_env.filter(|v| !v.is_empty()) {
        // an instance that names its own database keeps its files beside it (a throwaway board, a test): the folder the
        // desktop app recorded must not take its files
        let resolved = pathlib::resolve(Path::new(db));
        return (resolved.parent().map(Path::to_path_buf).unwrap_or_default().join("uploads"), SOURCE_DB_PATH);
    }
    if let Some(folder) = recorded {
        return (folder, SOURCE_CONFIG);
    }
    (code_dir(), SOURCE_CODE)
}

/// The uploads folder and where it came from (a `SOURCE_*` name). Order: `KANBAN_UPLOADS_DIR`, `data_folder` of the
/// config file, the folder of `KANBAN_DB_PATH`, `uploads_dir` of the config file (recorded by the desktop app), then
/// `uploads` next to the program.
pub fn resolve_uploads_dir() -> (PathBuf, &'static str) {
    let env_value = std::env::var(UPLOADS_DIR_ENV_VAR).ok();
    let db_env = std::env::var("KANBAN_DB_PATH").ok();
    pick_uploads_dir(
        env_value.as_deref(),
        kb_base::config::get_data_folder(),
        db_env.as_deref(),
        kb_base::config::get_uploads_dir(),
        code_uploads_dir,
    )
}

/// The uploads directory, created when `create` is true.
pub fn get_uploads_dir(create: bool) -> PathBuf {
    let (candidate, source) = resolve_uploads_dir();
    if source == SOURCE_CODE && !FALLBACK_LOGGED.swap(true, Ordering::SeqCst) {
        tracing::warn!(
            target: "uploads",
            "No uploads folder is configured (no KANBAN_UPLOADS_DIR, no data folder or uploads_dir in the config \
             file, no KANBAN_DB_PATH): files are kept in {}, next to the code, which the desktop app does not serve.",
            candidate.display()
        );
    }
    if create {
        let _ = std::fs::create_dir_all(&candidate);
    }
    pathlib::resolve(&candidate)
}

/// Where a stored file went, for the result of a tool that stores one: `{"stored_in": folder}`, plus a `warning` when
/// the folder is the one next to the code (the desktop app serves another, so the link would not open there).
pub fn storage_info() -> Map<String, Value> {
    let (folder, source) = resolve_uploads_dir();
    let stored_in = pathlib::resolve(&folder).to_string_lossy().into_owned();
    let mut info = Map::new();
    info.insert("stored_in".into(), Value::String(stored_in.clone()));
    if source == SOURCE_CODE {
        info.insert(
            "warning".into(),
            Value::String(format!(
                "The file is stored in {stored_in}, which the app does not serve: no uploads folder is \
                 configured for this MCP server. Start the desktop app once (it records its uploads folder in the \
                 config file) or set KANBAN_UPLOADS_DIR in the environment of this MCP server, then attach the file again."
            )),
        );
    }
    info
}

/// Resolve a relative upload path inside `uploads_dir` (already resolved), or `None` if it escapes it.
fn resolve_in(uploads_dir: &Path, file_path: &str) -> Option<PathBuf> {
    if pathlib::is_absolute(file_path) {
        return None;
    }
    let safe_parts = pathlib::parts(file_path);
    if safe_parts.contains(&"..") {
        return None;
    }
    if safe_parts.first().is_some_and(|part| part.to_lowercase() == PRIVATE_DIR) {
        return None;
    }
    // Python raises ValueError for a NUL character in a path, and the function answers None for a ValueError
    if file_path.contains('\0') {
        return None;
    }
    let mut joined = uploads_dir.to_path_buf();
    joined.extend(&safe_parts);
    let resolved = pathlib::resolve(&joined);
    resolved.strip_prefix(uploads_dir).is_ok().then_some(resolved)
}

/// Resolve a relative upload path inside the uploads directory, or `None` if it escapes it.
pub fn resolve_upload_path(file_path: &str) -> Option<PathBuf> {
    let uploads_dir = get_uploads_dir(false);
    resolve_in(&uploads_dir, file_path)
}

/// The folder inside the uploads folder whose files are never served over `/uploads/...`.
pub fn get_private_dir() -> PathBuf {
    let path = get_uploads_dir(true).join(PRIVATE_DIR);
    let _ = std::fs::create_dir_all(&path);
    path
}

/// A safe `(stem, extension)` pair for an uploaded filename.
pub fn sanitize_filename(filename: &str) -> (String, String) {
    let original_name = match pathlib::name(filename) {
        "" => "image",
        name => name,
    };
    let stem = match pathlib::stem_of_name(original_name) {
        "" => "image",
        stem => stem,
    };
    let ascii: String = stem.nfkd().filter(char::is_ascii).collect();
    let mut cleaned = String::with_capacity(ascii.len());
    let mut in_run = false;
    for c in ascii.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
            cleaned.push(c);
            in_run = false;
        } else if !in_run {
            cleaned.push('-');
            in_run = true;
        }
    }
    let trimmed = cleaned.trim_matches(['.', '_', '-']);
    let stem = if trimmed.is_empty() { "image".to_string() } else { trimmed.to_string() };
    (stem, pathlib::suffix_of_name(original_name).to_lowercase())
}

/// A unique stored filename built from the original name.
pub fn build_upload_filename(original_filename: &str) -> String {
    let (stem, extension) = sanitize_filename(original_filename);
    let unique: String = kb_base::time::uuid4_hex().chars().take(12).collect();
    format!("{stem}-{unique}{extension}")
}

/// Markdown-safe alt text derived from the filename.
pub fn build_markdown_alt_text(original_filename: &str) -> String {
    let (stem, _) = sanitize_filename(original_filename);
    let alt = stem.replace(['[', ']'], "");
    if alt.is_empty() { "image".to_string() } else { alt }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn dir() -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().expect("temp dir");
        let base = std::fs::canonicalize(temp.path()).expect("canonical");
        (temp, base)
    }

    #[test]
    fn the_tables_have_the_sizes_of_the_python_ones() {
        assert_eq!(MIME_BY_EXTENSION.len(), 45);
        assert_eq!(mime_by_extension(".html"), Some("text/plain"));
        assert_eq!(mime_by_extension(".pdf"), Some("application/pdf"));
        assert_eq!(mime_by_extension(".exe"), None);
        assert!(is_viewable_inline(".webm") && is_viewable_inline(".html") && !is_viewable_inline(".zip"));
        assert_eq!(VIEWABLE_INLINE_EXTENSIONS.len(), 34);
        assert!(is_supported_image(".svg") && !is_supported_image(".pdf"));
        assert_eq!(
            supported_image_mime_types(),
            vec!["image/bmp", "image/gif", "image/jpeg", "image/png", "image/svg+xml", "image/webp", "image/x-icon"]
        );
    }

    #[test]
    fn the_folder_comes_from_the_first_source_that_names_one() {
        let code = || PathBuf::from("/code/uploads");
        let folder = Some(PathBuf::from("/data"));
        let recorded = Some(PathBuf::from("/recorded"));
        let all = pick_uploads_dir(Some("/env"), folder.clone(), Some("/db/kanban.db"), recorded.clone(), code);
        assert_eq!(all, (PathBuf::from("/env"), SOURCE_ENV));
        let no_env = pick_uploads_dir(Some(""), folder.clone(), Some("/db/kanban.db"), recorded.clone(), code);
        assert_eq!(no_env, (PathBuf::from("/data/uploads"), SOURCE_DATA_FOLDER));
        let db = pick_uploads_dir(None, None, Some("/db/kanban.db"), recorded.clone(), code);
        assert_eq!(db, (PathBuf::from("/db/uploads"), SOURCE_DB_PATH));
        assert_eq!(pick_uploads_dir(None, None, None, recorded, code), (PathBuf::from("/recorded"), SOURCE_CONFIG));
        assert_eq!(pick_uploads_dir(None, None, Some(""), None, code), (PathBuf::from("/code/uploads"), SOURCE_CODE));
    }

    #[test]
    fn resolve_upload_path_does_not_create_the_uploads_dir_on_read() {
        let (_temp, base) = dir();
        let uploads = base.join("uploads");
        let resolved = resolve_in(&uploads, "nested/example.png");
        assert_eq!(resolved, Some(uploads.join("nested").join("example.png")));
        assert!(!uploads.exists());
    }

    #[test]
    fn resolve_upload_path_refuses_what_escapes_or_is_private() {
        let (_temp, base) = dir();
        let uploads = base.join("uploads");
        std::fs::create_dir(&uploads).expect("mkdir");
        assert_eq!(resolve_in(&uploads, "/etc/passwd"), None);
        assert_eq!(resolve_in(&uploads, "../x.png"), None);
        assert_eq!(resolve_in(&uploads, "a/../../x.png"), None);
        assert_eq!(resolve_in(&uploads, "_private/x.png"), None);
        assert_eq!(resolve_in(&uploads, "_PRIVATE/x.png"), None);
        assert_eq!(resolve_in(&uploads, "a\0b"), None);
        assert_eq!(resolve_in(&uploads, "a//./b.png"), Some(uploads.join("a").join("b.png")));
        assert_eq!(resolve_in(&uploads, ""), Some(uploads.clone()));
        // a link that leads out of the folder is refused; one that stays inside is followed
        let outside = base.join("outside.txt");
        std::fs::write(&outside, "x").expect("write");
        std::os::unix::fs::symlink(&outside, uploads.join("out.txt")).expect("symlink");
        std::fs::write(uploads.join("in.txt"), "x").expect("write");
        std::os::unix::fs::symlink(uploads.join("in.txt"), uploads.join("alias.txt")).expect("symlink");
        assert_eq!(resolve_in(&uploads, "out.txt"), None);
        assert_eq!(resolve_in(&uploads, "alias.txt"), Some(uploads.join("in.txt")));
    }

    #[test]
    fn filenames_are_made_safe() {
        assert_eq!(sanitize_filename("diagram.png"), ("diagram".into(), ".png".into()));
        assert_eq!(sanitize_filename("Tiến Việt.PNG"), ("Tien-Viet".into(), ".png".into()));
        assert_eq!(sanitize_filename("../../etc/pass wd.txt"), ("pass-wd".into(), ".txt".into()));
        assert_eq!(sanitize_filename(""), ("image".into(), "".into()));
        assert_eq!(sanitize_filename("..."), ("image".into(), "".into()));
        assert_eq!(sanitize_filename("日本語.png"), ("image".into(), ".png".into()));
        assert_eq!(sanitize_filename(".env"), (".env".trim_matches('.').into(), "".into()));
        assert_eq!(sanitize_filename("a  b__c.tar.gz"), ("a-b__c.tar".into(), ".gz".into()));
        assert_eq!(sanitize_filename("ﬁle.txt"), ("file".into(), ".txt".into()));
        let name = build_upload_filename("my photo.JPG");
        assert!(
            name.starts_with("my-photo-") && name.ends_with(".jpg") && name.len() == "my-photo-".len() + 12 + 4,
            "{name}"
        );
        assert_eq!(build_markdown_alt_text("a[b].png"), "a-b");
    }
}

#[cfg(test)]
mod golden {
    use super::*;

    #[test]
    fn filenames_are_sanitized_as_python_sanitizes_them() {
        let rows: Vec<Value> =
            serde_json::from_str(include_str!("../../../contract/golden/uploads.json")).expect("golden file");
        assert!(rows.len() > 20);
        for row in rows {
            let name = row["name"].as_str().expect("name");
            let (stem, extension) = sanitize_filename(name);
            assert_eq!(serde_json::json!([stem, extension]), row["stem_ext"], "sanitize_filename({name:?})");
            assert_eq!(build_markdown_alt_text(name), row["alt"].as_str().expect("alt"), "alt text of {name:?}");
        }
    }
}
