//! `services/canvases.py`: canvases: boards (HTML pages, images, Sketches, Diagrams), notes, arrows and labels on one
//! large plane.
//!
//! A canvas is one record (owner, revision, latest version) plus one file, `uploads/canvases/<id>/canvas.json`, that
//! holds the page tabs, boards, notes, arrows and labels. A board's content is stored as attachment files next to it
//! (an HTML board is a folder); every change of a board's content is a new, never rewritten revision folder, so a
//! version (a frozen copy of `canvas.json`) can always be shown or restored. It sits in a markdown field as
//! `![Name](canvas:cv_8f3a1c2d)`.
//!
//! Rules the design (design/screens/canvas.md) asks for, and where they live:
//!
//! * Layout changes (move, resize, notes, arrows, labels) need no lock and merge **per item**: every item carries the
//!   canvas revision it was last changed in, a save names the revision of each item it changes, and only an item
//!   changed twice conflicts (`save`).
//! * A board's content changes under a **lock** (`canvas_locks`); an AI team saves a board's new files straight into
//!   it (`put_board_content`), and is refused while a person holds the lock.
//! * Boards are open web pages: their files are kept exactly as given and run like a file opened in a browser.
//! * Versions are made on Done, on restore, and every 10 minutes for a canvas that is a Docs page.
//!
//! This file ports `canvases.py` lines 1-378 (constants, ids, the per-canvas lock, the files of a canvas and the
//! items of its plane); the other sections are in the submodules, each naming its lines.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use kb_base::{pyjson, pytext, time};
use kb_doctext::docs_text::DocsError;
use kb_files::uploads;
use regex::Regex;
use serde_json::{Map, Value, json};
use tokio::sync::OwnedMutexGuard;

use crate::canvas_png;

pub mod archive;
pub mod boards;
pub mod content;
pub mod docs;
pub mod rows;
pub mod save;
pub mod textdiff;
pub mod versions;

/// The canvas file's `format`.
pub const FORMAT: &str = "kanban-canvas";
/// The canvas file's `version`.
pub const FORMAT_VERSION: i64 = 1;

pub const MAX_BOARDS: usize = 60;
pub const MAX_BOARD_BYTES: usize = 5 * 1024 * 1024;
pub const MAX_CANVAS_BYTES: usize = 50 * 1024 * 1024;
pub const MAX_PAGES: usize = 10;
pub const MAX_FILES: usize = 300;
pub const MAX_NOTES: usize = 500;
pub const MAX_ARROWS: usize = 500;
pub const MAX_LABELS: usize = 300;
pub const MAX_TITLE: usize = 200;
pub const MIN_W: i64 = 320;
pub const MAX_W: i64 = 1920;
pub const MIN_H: i64 = 120;
pub const MAX_H: i64 = 6000;
pub const AUTO_VERSION_SECONDS: i64 = 10 * 60;
pub const OWNER_KINDS: [&str; 5] = ["idea", "ticket", "doc", "comment", "page"];
pub const BOARD_KINDS: [&str; 5] = ["html", "image", "sketch", "diagram", "empty"];
pub const NOTE_COLORS: [&str; 6] = ["yellow", "green", "blue", "pink", "purple", "grey"];

/// `SIZE_PRESETS[name]`.
pub fn size_preset(name: &str) -> Option<(i64, i64)> {
    match name {
        "desktop" => Some((1280, 800)),
        "laptop" => Some((1440, 900)),
        "wide" => Some((1920, 1080)),
        "tablet" => Some((820, 1180)),
        "phone" => Some((390, 844)),
        _ => None,
    }
}

/// The plain `Doc` of a canvas file: a JSON object.
pub type Doc = Map<String, Value>;

/// The extensions a frame may hold.
pub const ALLOWED_EXT: &[&str] = &[
    ".html",
    ".htm",
    ".css",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".avif",
    ".svg",
    ".ico",
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
    ".txt",
    ".json",
    ".md",
    ".js",
    ".mjs",
    ".cjs",
    ".map",
    ".wasm",
    ".xml",
    ".csv",
    ".mp3",
    ".mp4",
    ".webm",
    ".ogg",
    ".wav",
    ".webmanifest",
];
/// The extensions an import turns into a picture frame.
pub const IMAGE_EXT: [&str; 7] = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"];
/// The extensions a frame's text editor shows.
pub const TEXT_EXT: [&str; 6] = [".html", ".htm", ".css", ".txt", ".md", ".json"];

/// `MEDIA.get(ext, "application/octet-stream")`.
pub fn media_of(ext: &str) -> &'static str {
    match ext {
        ".html" | ".htm" => "text/html; charset=utf-8",
        ".css" => "text/css; charset=utf-8",
        ".png" => "image/png",
        ".jpg" | ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".avif" => "image/avif",
        ".svg" => "image/svg+xml",
        ".ico" => "image/x-icon",
        ".woff" => "font/woff",
        ".woff2" => "font/woff2",
        ".ttf" => "font/ttf",
        ".otf" => "font/otf",
        ".txt" | ".md" => "text/plain; charset=utf-8",
        ".json" | ".map" => "application/json",
        ".js" | ".mjs" | ".cjs" => "text/javascript; charset=utf-8",
        ".wasm" => "application/wasm",
        ".xml" => "application/xml",
        ".csv" => "text/csv; charset=utf-8",
        ".mp3" => "audio/mpeg",
        ".mp4" => "video/mp4",
        ".webm" => "video/webm",
        ".ogg" => "audio/ogg",
        ".wav" => "audio/wav",
        ".webmanifest" => "application/manifest+json",
        _ => "application/octet-stream",
    }
}

/// `_now()`.
pub fn now() -> String {
    time::now_iso()
}

/// `_id(prefix)`: `prefix_` and eight hex digits.
pub fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", &time::uuid4_hex()[..8])
}

type CanvasLock = Arc<tokio::sync::Mutex<()>>;

/// `serial`: run one write of a canvas at a time (read the file, change it, commit): two writes must never share a
/// revision. The guard is held for the whole function (`_LOCKS[canvas_id]`, an `asyncio.Lock` per canvas id).
pub async fn serial(canvas_id: &str) -> OwnedMutexGuard<()> {
    static LOCKS: OnceLock<Mutex<HashMap<String, CanvasLock>>> = OnceLock::new();
    let lock = {
        let mut map = LOCKS.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
        map.entry(canvas_id.to_string()).or_default().clone()
    };
    lock.lock_owned().await
}

fn canvas_ref() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\(canvas:(cv_[0-9a-f]{8})(?:#((?:b|p)_[0-9a-f]{8}))?\)").expect("static pattern"))
}

/// The canvas ids a markdown text references, in order, without repeats.
pub fn refs_in(markdown: &str) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for m in canvas_ref().captures_iter(markdown) {
        let id = m[1].to_string();
        if !seen.contains(&id) {
            seen.push(id);
        }
    }
    seen
}

/// A new canvas's name as typed ("[docs] Login canvas"): only line breaks and runs of spaces are folded. The brackets
/// are dropped where the name becomes markdown alt text (`embed_line`), not in the name (CA-1).
pub fn canvas_name(title: Option<&str>, fallback: &str) -> String {
    let text: String = pytext::squash(title.unwrap_or("")).chars().take(crate::sketches::MAX_TITLE).collect();
    if text.is_empty() { fallback.to_string() } else { text }
}

/// The markdown line that shows a canvas (or one board of it).
pub fn embed_line(canvas_id: &str, title: &str, board_id: Option<&str>) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"[\[\]\n\r]+").expect("static pattern"));
    let name = pytext::strip(&re.replace_all(title, " ")).to_string();
    let name = if name.is_empty() { "Canvas".to_string() } else { name };
    match board_id {
        Some(b) => format!("![{name}](canvas:{canvas_id}#{b})"),
        None => format!("![{name}](canvas:{canvas_id})"),
    }
}

// --- files -----------------------------------------------------------------------------------------------------

/// `_join(root, *parts)`: `root` plus `parts`, kept inside `root`: normalised, and refused if it would leave it.
/// Fails with 404 for a path that leaves `root`.
pub fn join(root: &Path, parts: &[&str]) -> Result<PathBuf, DocsError> {
    let base = kb_base::pypath::normpath(&root.to_string_lossy());
    let mut joined = base.clone();
    for part in parts {
        joined = kb_base::pypath::join(&joined, part);
    }
    let full = kb_base::pypath::normpath(&joined);
    let sep = std::path::MAIN_SEPARATOR;
    if full != base && !full.starts_with(&format!("{base}{sep}")) {
        return Err(DocsError::new(404, "file_not_found", "That file is not in the canvas."));
    }
    Ok(PathBuf::from(full))
}

/// A file named by a path from an upload or the canvas file, inside `root` (see `safe_path`).
pub fn file_in(root: &Path, rel: &str) -> Result<PathBuf, DocsError> {
    join(root, &[&safe_path(rel)?])
}

/// `_id_part(kind, value)`: an id that is about to become a folder name, checked against the shape the server makes
/// (nothing else, so no `..` or separator can reach the file system). Fails with 404.
pub fn id_part<'a>(kind: &str, value: &'a str) -> Result<&'a str, DocsError> {
    let prefix = if kind == "canvas" { "cv_" } else { "b_" };
    let shaped = value
        .strip_prefix(prefix)
        .is_some_and(|r| r.len() == 8 && r.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    if !shaped {
        return Err(DocsError::new(404, &format!("{kind}_not_found"), format!("There is no such {kind}.")));
    }
    Ok(value)
}

/// The folder one canvas keeps everything in (inside the uploads folder, so a backup carries it).
pub fn canvas_dir(canvas_id: &str) -> Result<PathBuf, crate::Error> {
    let root = uploads::get_uploads_dir(true).join("canvases");
    let p = join(&root, &[id_part("canvas", canvas_id)?])?;
    std::fs::create_dir_all(&p)?;
    Ok(p)
}

/// Path of the canvas file.
pub fn doc_path(canvas_id: &str) -> Result<PathBuf, crate::Error> {
    Ok(canvas_dir(canvas_id)?.join("canvas.json"))
}

/// Folder of one revision of a board's content.
pub fn board_dir(canvas_id: &str, board_id: &str, rev: i64) -> Result<PathBuf, crate::Error> {
    let board = id_part("board", board_id)?;
    Ok(join(&canvas_dir(canvas_id)?, &["boards", board, &format!("r{rev}")])?)
}

/// A file path inside a board folder, normalised. Fails with 422 for an absolute path, `..`, or odd characters.
pub fn safe_path(raw: &str) -> Result<String, DocsError> {
    let swapped = raw.replace('\\', "/");
    let text = pytext::strip(&swapped).trim_start_matches('/');
    let bad = text.is_empty()
        || text.split('/').any(|part| part == ".." || part.is_empty() || part == ".")
        || text.chars().count() > 240
        || text.chars().any(|ch| (ch as u32) < 32);
    if bad {
        return Err(DocsError::new(422, "invalid_file", format!("\u{201c}{raw}\u{201d} is not a usable file name.")));
    }
    Ok(text.to_string())
}

/// Write the canvas file (atomically), and the overview picture next to it.
pub fn write_doc(canvas_id: &str, doc: &Doc) -> Result<(), crate::Error> {
    let path = doc_path(canvas_id)?;
    let mut tmp_name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    tmp_name.push(".tmp");
    let tmp = path.with_file_name(tmp_name);
    std::fs::write(&tmp, dumps_doc(doc))?;
    std::fs::rename(&tmp, &path)?;
    // the overview sits next to the file, so a Docs or ticket export can point at a plain image of the canvas
    if let Some(parent) = path.parent() {
        // an export picture is a convenience; the canvas is saved
        let _ =
            std::fs::write(parent.join("overview.png"), canvas_png::overview(&Value::Object(doc.clone()), None, 1000));
    }
    Ok(())
}

/// `json.dumps(doc, ensure_ascii=False, separators=(",", ":"))`.
pub fn dumps_doc(doc: &Doc) -> String {
    pyjson::Dumps::new().ensure_ascii(false).compact().dump(doc)
}

/// Read the canvas file. Fails with 404 if the file is missing from the data folder.
pub fn read_doc(canvas_id: &str) -> Result<Doc, crate::Error> {
    let path = doc_path(canvas_id)?;
    let value = std::fs::read(&path)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .and_then(|text| pyjson::loads(&text))
        .ok_or_else(|| {
            DocsError::new(404, "canvas_file_missing", "The canvas file is missing from the data folder.")
        })?;
    Ok(normalize(value)?)
}

/// An empty canvas file with one page tab.
pub fn blank_doc() -> Doc {
    let mut doc = Map::new();
    doc.insert("format".into(), json!(FORMAT));
    doc.insert("version".into(), json!(FORMAT_VERSION));
    doc.insert("pages".into(), json!([{"id": new_id("p"), "name": "Page 1", "rev": 1}]));
    for key in ["boards", "notes", "arrows", "labels"] {
        doc.insert(key.into(), json!([]));
    }
    doc
}

/// Make sure a canvas file has every list and at least one page tab.
pub fn normalize(doc: Value) -> Result<Doc, DocsError> {
    let Value::Object(mut doc) = doc else {
        return Err(DocsError::new(422, "invalid_canvas", "This is not a canvas file (wrong format)."));
    };
    if doc.get("format") != Some(&json!(FORMAT)) {
        return Err(DocsError::new(422, "invalid_canvas", "This is not a canvas file (wrong format)."));
    }
    for key in ["pages", "boards", "notes", "arrows", "labels"] {
        if !doc.get(key).is_some_and(Value::is_array) {
            doc.insert(key.into(), json!([]));
        }
    }
    if doc["pages"].as_array().is_some_and(Vec::is_empty) {
        doc.insert("pages".into(), json!([{"id": new_id("p"), "name": "Page 1", "rev": 1}]));
    }
    Ok(doc)
}

// --- items -----------------------------------------------------------------------------------------------------

/// The first code point of each block of ten decimal digits (Unicode category Nd) outside ASCII.
const DIGIT_ZEROS: [u32; 36] = [
    0x0660, 0x06F0, 0x07C0, 0x0966, 0x09E6, 0x0A66, 0x0AE6, 0x0B66, 0x0BE6, 0x0C66, 0x0CE6, 0x0D66, 0x0DE6, 0x0E50,
    0x0ED0, 0x0F20, 0x1040, 0x1090, 0x17E0, 0x1810, 0x1946, 0x19D0, 0x1A80, 0x1A90, 0x1B50, 0x1BB0, 0x1C40, 0x1C50,
    0xA620, 0xA8D0, 0xA900, 0xA9D0, 0xA9F0, 0xAA50, 0xABF0, 0xFF10,
];

/// Python's `float()` reads any decimal digit as its ASCII value (`float("\u0663")` is 3.0).
fn ascii_digits(text: &str) -> String {
    text.chars()
        .map(|c| match DIGIT_ZEROS.iter().find(|z| (**z..**z + 10).contains(&(c as u32))) {
            Some(z) => char::from(b'0' + (c as u32 - z) as u8),
            None => c,
        })
        .collect()
}

/// `float(value)` of a JSON value, as Python reads it (`None` where it raises).
fn py_float(value: &Value) -> Option<f64> {
    match value {
        Value::Bool(b) => Some(f64::from(u8::from(*b))),
        Value::Number(n) => n.as_f64(),
        Value::String(s) => {
            let converted = ascii_digits(s);
            let t = pytext::strip(&converted);
            let digits_ok = !t.contains('_')
                || t.char_indices().all(|(i, c)| {
                    c != '_'
                        || (i > 0
                            && t[..i].chars().next_back().is_some_and(|p| p.is_ascii_digit())
                            && t[i + 1..].chars().next().is_some_and(|n| n.is_ascii_digit()))
                });
            if !digits_ok {
                return None;
            }
            let cleaned = t.replace('_', "");
            // Rust also reads a leading `+` and the words `inf`, `infinity` and `nan` in any case, as Python does
            cleaned.parse::<f64>().ok()
        }
        _ => None,
    }
}

/// `_num(value, default, lo, hi)`: a number kept between two bounds; the default (as it was stored: a whole number
/// stays whole) when the value is not a number. A clamped number is the bound itself, a whole number.
pub fn num(value: Option<&Value>, default: &Value, lo: i64, hi: i64) -> Value {
    let Some(v) = value.and_then(py_float) else { return default.clone() };
    if v.is_nan() {
        return default.clone();
    }
    // `max(lo, min(hi, v))`
    let m = if v < hi as f64 { Some(v) } else { None };
    match m {
        Some(m) if m > lo as f64 => json!(m),
        Some(_) => json!(lo),
        None => json!(hi.max(lo)),
    }
}

/// `int(value)` of a number made by `num`.
pub fn as_int(value: &Value) -> i64 {
    match value {
        Value::Number(n) => n.as_i64().unwrap_or_else(|| n.as_f64().unwrap_or(0.0) as i64),
        _ => 0,
    }
}

/// `str(value or "")`.
fn py_str_or_empty(value: &Value) -> String {
    if !pyjson::truthy(value) {
        return String::new();
    }
    match value {
        Value::String(s) => s.clone(),
        Value::Array(_) | Value::Object(_) => crate::util::py_repr(value),
        other => pyjson::py_str(other),
    }
}

/// `_text(value, limit)`: `str(value or "")` without control characters, cut to `limit` characters.
pub fn text(value: Option<&Value>, limit: usize) -> String {
    let raw = value.map(py_str_or_empty).unwrap_or_default();
    raw.chars().filter(|c| !matches!(*c as u32, 0..=8 | 0x0b | 0x0c | 0x0e..=0x1f)).take(limit).collect()
}

/// `_find(items, item_id)`: the index of the item with that id.
pub fn find(items: &[Value], item_id: &str) -> Option<usize> {
    items.iter().position(|i| i.get("id").and_then(Value::as_str) == Some(item_id))
}

/// The items of one list of the canvas file.
pub fn list<'a>(doc: &'a Doc, key: &str) -> &'a [Value] {
    doc.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default()
}

/// The items of one list of the canvas file, to change.
pub fn list_mut<'a>(doc: &'a mut Doc, key: &str) -> &'a mut Vec<Value> {
    if !doc.get(key).is_some_and(Value::is_array) {
        doc.insert(key.into(), json!([]));
    }
    match doc.get_mut(key) {
        Some(Value::Array(items)) => items,
        _ => unreachable!("the list was just made"),
    }
}

/// A board of the canvas (its index). Fails with 404 if there is no such board.
pub fn board_of(doc: &Doc, board_id: &str) -> Result<usize, DocsError> {
    find(list(doc, "boards"), board_id)
        .ok_or_else(|| DocsError::new(404, "board_not_found", "That frame is not on this canvas any more."))
}

/// `_page_ref(value)`: a page tab id, else None.
fn page_ref(value: Option<&Value>) -> Value {
    match value {
        Some(Value::String(s)) => Value::String(s.clone()),
        _ => Value::Null,
    }
}

/// `src.get(key, base.get(key))`: the source's value, else the old one.
fn pick<'a>(src: &'a Map<String, Value>, base: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    src.get(key).or_else(|| base.get(key))
}

fn pick_or<'a>(src: &'a Map<String, Value>, base: &'a Map<String, Value>, key: &str, default: &'a Value) -> &'a Value {
    src.get(key).or_else(|| base.get(key)).unwrap_or(default)
}

/// The layout fields of a board a client may set: name, position, size, order and page tab.
pub fn clean_board_layout(src: &Map<String, Value>, old: Option<&Map<String, Value>>) -> Map<String, Value> {
    let empty = Map::new();
    let base = old.unwrap_or(&empty);
    let mut out = Map::new();
    let name = text(Some(pick_or(src, base, "name", &json!("Frame"))), MAX_TITLE);
    let name = pytext::strip(&name).to_string();
    out.insert("name".into(), json!(if name.is_empty() { "Frame".to_string() } else { name }));
    out.insert("x".into(), num(src.get("x"), base.get("x").unwrap_or(&json!(0)), -100000, 100000));
    out.insert("y".into(), num(src.get("y"), base.get("y").unwrap_or(&json!(0)), -100000, 100000));
    out.insert("w".into(), num(src.get("w"), base.get("w").unwrap_or(&json!(1280)), MIN_W, MAX_W));
    out.insert("h".into(), num(src.get("h"), base.get("h").unwrap_or(&json!(800)), MIN_H, MAX_H));
    out.insert(
        "order".into(),
        json!(as_int(&num(src.get("order"), base.get("order").unwrap_or(&json!(0)), -1, 100000))),
    );
    out.insert("page".into(), page_ref(pick(src, base, "page")));
    if let Some(fit) = pick(src, base, "fit").filter(|v| !v.is_null()) {
        out.insert("fit".into(), json!(pyjson::truthy(fit)));
    }
    out
}

/// `_clean_note(src, old, actor)`.
pub fn clean_note(src: &Map<String, Value>, old: Option<&Map<String, Value>>, actor: &str) -> Map<String, Value> {
    let empty = Map::new();
    let base = old.unwrap_or(&empty);
    let color = pick_or(src, base, "color", &json!("yellow")).clone();
    let mut out = Map::new();
    out.insert("x".into(), num(src.get("x"), base.get("x").unwrap_or(&json!(0)), -100000, 100000));
    out.insert("y".into(), num(src.get("y"), base.get("y").unwrap_or(&json!(0)), -100000, 100000));
    out.insert("w".into(), num(src.get("w"), base.get("w").unwrap_or(&json!(160)), 80, 600));
    out.insert("h".into(), num(src.get("h"), base.get("h").unwrap_or(&json!(100)), 60, 600));
    out.insert("text".into(), json!(text(Some(pick_or(src, base, "text", &json!(""))), 1000)));
    let valid = color.as_str().filter(|c| NOTE_COLORS.contains(c)).unwrap_or("yellow");
    out.insert("color".into(), json!(valid));
    let by = base.get("by").filter(|v| pyjson::truthy(v)).cloned().unwrap_or_else(|| json!(initials(actor)));
    out.insert("by".into(), by);
    out.insert("page".into(), page_ref(pick(src, base, "page")));
    out
}

/// `_clean_label(src, old)`.
pub fn clean_label(src: &Map<String, Value>, old: Option<&Map<String, Value>>) -> Map<String, Value> {
    let empty = Map::new();
    let base = old.unwrap_or(&empty);
    let mut out = Map::new();
    out.insert("x".into(), num(src.get("x"), base.get("x").unwrap_or(&json!(0)), -100000, 100000));
    out.insert("y".into(), num(src.get("y"), base.get("y").unwrap_or(&json!(0)), -100000, 100000));
    out.insert("text".into(), json!(text(Some(pick_or(src, base, "text", &json!(""))), 200)));
    out.insert("size".into(), json!(as_int(&num(src.get("size"), base.get("size").unwrap_or(&json!(20)), 10, 96))));
    out.insert("page".into(), page_ref(pick(src, base, "page")));
    out
}

/// `_clean_arrow(src, old)`.
pub fn clean_arrow(src: &Map<String, Value>, old: Option<&Map<String, Value>>) -> Map<String, Value> {
    let empty = Map::new();
    let base = old.unwrap_or(&empty);
    let mut out = Map::new();
    out.insert("from".into(), json!(text(pick(src, base, "from"), 40)));
    out.insert("to".into(), json!(text(pick(src, base, "to"), 40)));
    out.insert("label".into(), json!(text(Some(pick_or(src, base, "label", &json!(""))), 120)));
    out.insert("page".into(), page_ref(pick(src, base, "page")));
    out
}

/// `_initials(name)`: the first letters of the first two words, in capitals (`?` for none).
fn initials(name: &str) -> String {
    let parts: Vec<&str> =
        name.split(|c: char| pytext::is_space(c) || matches!(c, '.' | '_' | '-')).filter(|p| !p.is_empty()).collect();
    let joined: String = parts.iter().take(2).filter_map(|p| p.chars().next()).collect();
    if joined.is_empty() { "?".into() } else { joined.to_uppercase() }
}

/// `_arrow_ends_exist(doc, arrow)`.
pub fn arrow_ends_exist(doc: &Doc, arrow: &Map<String, Value>) -> bool {
    ["from", "to"].iter().all(|end| {
        let id = arrow.get(*end).and_then(Value::as_str).unwrap_or("");
        find(list(doc, "boards"), id).is_some() || find(list(doc, "notes"), id).is_some()
    })
}

/// Python's `a == b` for two values read from JSON: `1 == 1.0` and `True == 1`, objects regardless of key order.
pub fn py_eq(a: &Value, b: &Value) -> bool {
    fn as_number(v: &Value) -> Option<f64> {
        match v {
            Value::Number(n) => n.as_f64(),
            Value::Bool(b) => Some(f64::from(u8::from(*b))),
            _ => None,
        }
    }
    match (a, b) {
        (Value::Null, Value::Null) => true,
        (Value::String(x), Value::String(y)) => x == y,
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| py_eq(p, q)),
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| py_eq(v, w)))
        }
        _ => match (as_number(a), as_number(b)) {
            (Some(x), Some(y)) => x == y,
            _ => false,
        },
    }
}

/// `py_eq` for two optional values (`None` is a missing key or `None`).
pub fn py_eq_opt(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(x), None) | (None, Some(x)) => x.is_null(),
        (Some(x), Some(y)) => py_eq(x, y),
    }
}
