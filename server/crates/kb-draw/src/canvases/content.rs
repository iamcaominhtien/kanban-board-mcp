//! `services/canvases.py` lines 1230-1425: what a frame holds: picture sizes, the files of an HTML
//! frame and their limits, revision folders on disk, and where a new frame goes on the plane.

use std::path::Path;
use std::sync::OnceLock;

use kb_doctext::docs_text::DocsError;
use regex::Regex;
use serde_json::{Map, Value, json};

use super::*;
use crate::canvas_html;

/// `{path: bytes}` in the order the files came (a dict).
pub type Files = Vec<(String, Vec<u8>)>;

/// `files[name] = data`: a later file with the same name replaces the earlier one in its place.
pub fn put_file(files: &mut Files, name: String, data: Vec<u8>) {
    match files.iter_mut().find(|(n, _)| *n == name) {
        Some(slot) => slot.1 = data,
        None => files.push((name, data)),
    }
}

/// `_magic_image(data)`: the extension of a picture, from its first bytes.
pub fn magic_image(data: &[u8]) -> Option<&'static str> {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some(".png");
    }
    if data.starts_with(b"\xff\xd8\xff") {
        return Some(".jpg");
    }
    if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        return Some(".gif");
    }
    if data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        return Some(".webp");
    }
    let head: Vec<u8> = data[..data.len().min(1024)]
        .iter()
        .copied()
        .skip_while(|b| matches!(b, b'\t' | b'\n' | 0x0b | 0x0c | b'\r' | b' '))
        .map(|b| b.to_ascii_lowercase())
        .collect();
    let lower_2048: Vec<u8> = data[..data.len().min(2048)].to_ascii_lowercase();
    let has_svg = lower_2048.windows(4).any(|w| w == b"<svg");
    if head.starts_with(b"<svg") || (head.starts_with(b"<?xml") && has_svg) {
        return Some(".svg");
    }
    None
}

fn le(data: &[u8], from: usize, to: usize) -> i64 {
    let slice = data.get(from.min(data.len())..to.min(data.len())).unwrap_or_default();
    slice.iter().rev().fold(0i64, |acc, b| (acc << 8) | i64::from(*b))
}

fn be16(data: &[u8], at: usize) -> Option<i64> {
    let s = data.get(at..at + 2)?;
    Some(i64::from(u16::from_be_bytes([s[0], s[1]])))
}

/// Width and height of a PNG, JPEG, GIF, WebP or SVG, read from the header.
pub fn image_size(data: &[u8]) -> Option<(i64, i64)> {
    if data.starts_with(b"\x89PNG") {
        let s = data.get(16..24)?;
        return Some((
            i64::from(u32::from_be_bytes([s[0], s[1], s[2], s[3]])),
            i64::from(u32::from_be_bytes([s[4], s[5], s[6], s[7]])),
        ));
    }
    if data.starts_with(b"GIF") {
        let s = data.get(6..10)?;
        return Some((i64::from(u16::from_le_bytes([s[0], s[1]])), i64::from(u16::from_le_bytes([s[2], s[3]]))));
    }
    if data.starts_with(b"\xff\xd8") {
        let mut i = 2usize;
        while i + 9 < data.len() {
            if data[i] != 0xFF {
                i += 1;
                continue;
            }
            let marker = data[i + 1];
            if (0xC0..=0xCF).contains(&marker) && ![0xC4, 0xC8, 0xCC].contains(&marker) {
                let (h, w) = (be16(data, i + 5)?, be16(data, i + 7)?);
                return Some((w, h));
            }
            i += 2 + be16(data, i + 2)? as usize;
        }
    }
    if data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        let kind = data.get(12..16).unwrap_or_default();
        if kind == b"VP8X" {
            return Some((1 + le(data, 24, 27), 1 + le(data, 27, 30)));
        }
        if kind == b"VP8 " {
            let s = data.get(26..30)?;
            return Some((
                i64::from(u16::from_le_bytes([s[0], s[1]])) & 0x3FFF,
                i64::from(u16::from_le_bytes([s[2], s[3]])) & 0x3FFF,
            ));
        }
        if kind == b"VP8L" {
            let bits = le(data, 21, 25);
            return Some(((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1));
        }
    }
    let text = crate::util::decode_ignore(&data[..data.len().min(4096)]);
    static TAG: OnceLock<Regex> = OnceLock::new();
    static WIDTH: OnceLock<Regex> = OnceLock::new();
    static HEIGHT: OnceLock<Regex> = OnceLock::new();
    static BOX: OnceLock<Regex> = OnceLock::new();
    let tag_re = TAG.get_or_init(|| Regex::new(r"(?is)<svg[^>]*>").expect("static pattern"));
    let tag = tag_re.find(&text)?.as_str();
    let wm = WIDTH.get_or_init(|| Regex::new(r#"\bwidth="([\d.]+)"#).expect("static pattern")).captures(tag);
    let hm = HEIGHT.get_or_init(|| Regex::new(r#"\bheight="([\d.]+)"#).expect("static pattern")).captures(tag);
    if let (Some(w), Some(h)) = (&wm, &hm) {
        // `float()` of a number with two dots is a `ValueError`, caught: no size
        let (w, h) = (w[1].parse::<f64>().ok()?, h[1].parse::<f64>().ok()?);
        return Some((w as i64, h as i64));
    }
    let vb = BOX
        .get_or_init(|| {
            Regex::new(r#"viewBox="[\d.\-]+[ ,]+[\d.\-]+[ ,]+([\d.]+)[ ,]+([\d.]+)""#).expect("static pattern")
        })
        .captures(tag)?;
    Some((vb[1].parse::<f64>().ok()? as i64, vb[2].parse::<f64>().ok()? as i64))
}

/// `DocsError(413, "board_too_large", ...)` for a frame of `size` bytes.
pub fn too_large_board(size: usize) -> DocsError {
    DocsError::new(
        413,
        "board_too_large",
        format!(
            "This frame is {:.1} MB. A frame can hold up to {} MB, and a canvas {MAX_BOARDS} frames and {} MB. Remove \
             embedded images or split the page, then save again.",
            size as f64 / (1024.0 * 1024.0),
            MAX_BOARD_BYTES / (1024 * 1024),
            MAX_CANVAS_BYTES / (1024 * 1024)
        ),
    )
    .with("size_bytes", size)
    .with("limit_bytes", MAX_BOARD_BYTES)
    .with("limit_boards", MAX_BOARDS)
    .with("limit_canvas_bytes", MAX_CANVAS_BYTES)
}

/// `_check_canvas_bytes(doc, replacing, new_bytes)`: the canvas would be over its size.
pub fn check_canvas_bytes(doc: &Doc, replacing: Option<&str>, new_bytes: usize) -> std::result::Result<(), DocsError> {
    let total: i64 = list(doc, "boards")
        .iter()
        .filter(|b| b.get("id").and_then(Value::as_str) != replacing || replacing.is_none())
        .map(|b| b.get("content").and_then(|c| c.get("bytes")).map_or(0, as_int))
        .sum();
    let would_be = total as f64 + new_bytes as f64;
    if total + new_bytes as i64 > MAX_CANVAS_BYTES as i64 {
        return Err(DocsError::new(
            413,
            "canvas_too_large",
            format!(
                "This canvas would be {:.1} MB. A canvas can hold up to {} MB.",
                would_be / (1024.0 * 1024.0),
                MAX_CANVAS_BYTES / (1024 * 1024)
            ),
        )
        .with("limit_canvas_bytes", MAX_CANVAS_BYTES));
    }
    Ok(())
}

/// Check the files of an HTML board (kept as given: nothing is stripped): `(files, content info {entry, files, bytes,
/// skipped, title})`. Fails with 413 over the size limit, and 422 for no page, too many files or a bad path.
pub fn prepare_files(
    files: &Files,
    entry: Option<&str>,
) -> std::result::Result<(Files, Map<String, Value>), DocsError> {
    if files.len() > MAX_FILES {
        return Err(DocsError::new(422, "too_many_files", format!("A frame holds up to {MAX_FILES} files.")));
    }
    let mut clean: Files = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    for (raw, data) in files {
        let path = safe_path(raw)?;
        let ext = kb_files::pathlib::suffix(&path).to_lowercase();
        if !ALLOWED_EXT.contains(&ext.as_str()) {
            skipped.push(path);
            continue;
        }
        put_file(&mut clean, path, data.clone());
    }
    for (path, _) in &clean {
        let mut parent = path.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
        while !parent.is_empty() {
            if clean.iter().any(|(n, _)| n == parent) {
                return Err(DocsError::new(
                    422,
                    "invalid_file",
                    format!("\u{201c}{parent}\u{201d} is both a file and a folder."),
                ));
            }
            parent = parent.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
        }
    }
    let total: usize = clean.iter().map(|(_, v)| v.len()).sum();
    if total > MAX_BOARD_BYTES {
        return Err(too_large_board(total));
    }
    let mut pages: Vec<&str> = clean
        .iter()
        .map(|(p, _)| p.as_str())
        .filter(|p| {
            let l = p.to_lowercase();
            l.ends_with(".html") || l.ends_with(".htm")
        })
        .collect();
    pages.sort_unstable();
    if pages.is_empty() {
        return Err(DocsError::new(422, "no_page", "A frame needs an HTML page (for example index.html)."));
    }
    let entry = match entry.filter(|e| !e.is_empty()) {
        Some(e) => {
            let e = safe_path(e)?;
            if !clean.iter().any(|(n, _)| *n == e) {
                return Err(DocsError::new(
                    422,
                    "no_page",
                    format!("The page \u{201c}{e}\u{201d} is not among the files."),
                ));
            }
            e
        }
        None => {
            if clean.iter().any(|(n, _)| n == "index.html") {
                "index.html".to_string()
            } else {
                pages[0].to_string()
            }
        }
    };
    let entry_data = &clean.iter().find(|(n, _)| *n == entry).map(|(_, d)| d.as_slice()).unwrap_or_default();
    let title = canvas_html::title_of(&String::from_utf8_lossy(entry_data), "");
    let mut names: Vec<&(String, Vec<u8>)> = clean.iter().collect();
    names.sort_by(|a, b| a.0.cmp(&b.0));
    let mut info = Map::new();
    info.insert("entry".into(), json!(entry));
    info.insert(
        "files".into(),
        Value::Array(names.iter().map(|(p, d)| json!({"path": p, "bytes": d.len()})).collect()),
    );
    info.insert("bytes".into(), json!(total));
    info.insert("skipped".into(), json!(skipped));
    info.insert("title".into(), json!(title));
    Ok((clean, info))
}

/// Write a board's files as revision `rev` (never over an earlier one).
pub fn write_revision(canvas_id: &str, board_id: &str, rev: i64, files: &Files) -> Result<(), crate::Error> {
    let root = board_dir(canvas_id, board_id, rev)?;
    if root.exists() {
        std::fs::remove_dir_all(&root)?;
    }
    for (path, data) in files {
        let target = file_in(&root, path)?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&target, data)?;
    }
    Ok(())
}

/// Every file under `root` as `(relative posix path, bytes)` (`p.relative_to(root).as_posix(): p.read_bytes() for p in
/// root.rglob("*") if p.is_file()`).
pub fn read_tree(root: &Path) -> Result<Files, crate::Error> {
    fn walk(dir: &Path, root: &Path, out: &mut Files) -> std::io::Result<()> {
        let mut entries: Vec<_> = std::fs::read_dir(dir)?.collect::<std::io::Result<Vec<_>>>()?;
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let p = e.path();
            if p.is_dir() {
                walk(&p, root, out)?;
            } else if p.is_file() {
                let rel = p.strip_prefix(root).unwrap_or(&p).to_string_lossy().replace('\\', "/");
                out.push((rel, std::fs::read(&p)?));
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    if root.is_dir() {
        walk(root, root, &mut out)?;
    }
    Ok(out)
}

fn f(v: Option<&Value>) -> f64 {
    v.and_then(Value::as_f64).unwrap_or(0.0)
}

/// `_free_spot(doc, page, w, h)`: to the right of the last frame, never on top of another.
pub fn free_spot(doc: &Doc, page: &Value, w: f64, h: f64) -> (f64, f64) {
    let same: Vec<&Value> = list(doc, "boards")
        .iter()
        .filter(|b| b.get("page") == Some(page) || (page.is_null() && b.get("page").is_none()))
        .collect();
    if same.is_empty() {
        return (0.0, 0.0);
    }
    // `max(same, key=(x + w, -y))`: the first of equal keys
    let mut last = same[0];
    for b in &same[1..] {
        let (kb, kl) =
            ((f(b.get("x")) + f(b.get("w")), -f(b.get("y"))), (f(last.get("x")) + f(last.get("w")), -f(last.get("y"))));
        if kb > kl {
            last = b;
        }
    }
    let mut x = f(last.get("x")) + f(last.get("w")) + 80.0;
    let y = same.iter().map(|b| f(b.get("y"))).fold(f64::INFINITY, f64::min);
    while same.iter().any(|b| {
        x < f(b.get("x")) + f(b.get("w"))
            && x + w > f(b.get("x"))
            && y < f(b.get("y")) + f(b.get("h"))
            && y + h > f(b.get("y"))
    }) {
        x += 80.0;
    }
    (x, y)
}
