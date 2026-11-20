//! HTML sites for Docs embeds: a folder of web files (a page with its scripts, styles, models and pictures) stored
//! once and shown by an `htmlEmbed` block through its `src` (`/docs/sites/<id>/<entry>`).
//!
//! A site is stored under `<uploads>/docs-sites/<id>/`, each file at its relative path. The id is 12 random lowercase
//! hex digits and a site never changes: uploading a changed folder makes a new site. A site is made from a folder (its
//! files with their relative paths; a folder common to all of them is dropped), from one `.zip` (unpacked; a single
//! top folder is dropped) or from one `.html` file. Its files are served as a web server would (`GET
//! /docs/sites/<id>/<path>`): by their type, inline, without a sandbox or a content security policy, so a page with
//! scripts works as it does in a browser.

use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

use axum::extract::multipart::{Multipart, MultipartRejection};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::Response;
use axum::routing::post;
use axum::{Json, extract::DefaultBodyLimit};
use kb_base::error::Path as UrlPath;
use kb_base::{ApiError, ApiResult, Routes};
use kb_doctext::docs_text::DocsError;
use kb_files::{FileResponse, uploads};
use serde_json::{Map, Value, json};

use crate::{Result, docs_err};

/// The folder of the uploads folder that holds the sites.
pub const SITES_DIR: &str = "docs-sites";
/// The most bytes a site may hold (all its files together, unpacked).
pub const MAX_SITE_BYTES: u64 = 500 * 1024 * 1024;
/// The most files a site may hold.
pub const MAX_SITE_FILES: usize = 5000;
/// The start of the address of a site's files.
pub const URL_PREFIX: &str = "/docs/sites/";

/// Returns the folder that holds every site (`<uploads>/docs-sites`), made when missing.
pub fn sites_root() -> PathBuf {
    uploads::get_uploads_dir(true).join(SITES_DIR)
}

/// Returns whether `id` has the form of a site id: 12 lowercase hex digits.
pub fn is_site_id(id: &str) -> bool {
    id.len() == 12 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Returns the folder of the site `id`, or `None` when the id is malformed or no such site is stored.
pub fn site_dir(id: &str) -> Option<PathBuf> {
    if !is_site_id(id) {
        return None;
    }
    let dir = sites_root().join(id);
    dir.is_dir().then_some(dir)
}

/// Returns the stored file at `path` (relative to the site, `/`-separated, not percent-encoded) of the site `id`.
///
/// `None` when the site or the file does not exist, the path is a folder, or it leads outside the site's folder
/// (`..`, an absolute path, a link pointing out).
pub fn resolve_site_file(id: &str, path: &str) -> Option<PathBuf> {
    let dir = site_dir(id)?;
    let rel = safe_path(path).ok()?;
    let full = dir.join(&rel);
    let real = std::fs::canonicalize(&full).ok()?;
    let real_dir = std::fs::canonicalize(&dir).ok()?;
    (real.starts_with(&real_dir) && real.is_file()).then_some(real)
}

/// Returns the bytes of the file at `path` (relative to the site, `/`-separated) of the site `id`, or `None` as
/// [`resolve_site_file`]. Blocking: call it from blocking code.
pub fn read_site_file(id: &str, path: &str) -> Option<Vec<u8>> {
    std::fs::read(resolve_site_file(id, path)?).ok()
}

/// Returns every file of the site `id` as `(relative path, bytes)`, sorted by path; empty when there is no such
/// site. Blocking.
pub fn list_site_files(id: &str) -> Vec<(String, u64)> {
    let Some(dir) = site_dir(id) else { return Vec::new() };
    let mut out = Vec::new();
    walk(&dir, "", &mut out, 0);
    out.sort();
    out
}

fn walk(dir: &Path, prefix: &str, out: &mut Vec<(String, u64)>, depth: usize) {
    // a site folder is written by this module and holds no links; the depth cap is for a folder edited by hand
    if depth > 64 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            walk(&e.path(), &rel, out, depth + 1);
        } else if ft.is_file() {
            out.push((rel, e.metadata().map(|m| m.len()).unwrap_or(0)));
        }
    }
}

/// Returns the address of a site's file: `/docs/sites/<id>/<path>`, each path segment percent-encoded.
pub fn site_url(id: &str, path: &str) -> String {
    format!("{URL_PREFIX}{id}/{}", encode_path(path))
}

/// Reads the address of a site's file (`/docs/sites/<id>/<path>`, also with a scheme and host before it, or with a
/// query or fragment after it): the site id and the decoded relative path. `None` for any other address.
pub fn parse_site_url(src: &str) -> Option<(String, String)> {
    let start = src.find(URL_PREFIX)?;
    let before = &src[..start];
    if !(before.is_empty() || before.contains("://")) {
        return None;
    }
    let rest = &src[start + URL_PREFIX.len()..];
    let rest = rest.split(['?', '#']).next().unwrap_or("");
    let (id, path) = rest.split_once('/')?;
    if !is_site_id(id) || path.is_empty() {
        return None;
    }
    Some((id.to_string(), decode_path(path)?))
}

/// Percent-encodes a relative path for a URL, keeping `/` and the characters a path segment may hold.
fn encode_path(path: &str) -> String {
    let mut out = String::new();
    for b in path.bytes() {
        let keep = b.is_ascii_alphanumeric() || b"-._~/!$&'()*+,;=:@".contains(&b);
        if keep {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn decode_path(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Returns the content type a site's file is served with, by its extension (`application/octet-stream` for an
/// unknown one).
pub fn content_type(path: &str) -> &'static str {
    let ext = path.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json",
        "webmanifest" => "application/manifest+json",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "glb" => "model/gltf-binary",
        "gltf" => "model/gltf+json",
        "obj" | "mtl" => "text/plain; charset=utf-8",
        "stl" => "model/stl",
        "hdr" | "bin" | "ktx2" | "basis" | "drc" => "application/octet-stream",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "ogv" => "video/ogg",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "csv" => "text/csv; charset=utf-8",
        "tsv" => "text/tab-separated-values; charset=utf-8",
        "txt" | "md" => "text/plain; charset=utf-8",
        "xml" => "application/xml",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// Checks and normalises a relative path given for a site file: `\` read as `/`, empty and `.` segments dropped.
///
/// # Errors
/// 422 `unsafe_path` for a `..` segment, an absolute path, a drive letter, a NUL or an empty path.
pub fn safe_path(path: &str) -> Result<String> {
    let unsafe_path = || docs_err(422, "unsafe_path", format!("The path {path} leads outside the site's folder"));
    let p = path.replace('\\', "/");
    if p.starts_with('/') || p.contains('\0') {
        return unsafe_path();
    }
    let mut parts = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." => return unsafe_path(),
            s if parts.is_empty()
                && s.len() >= 2
                && s.as_bytes()[1] == b':'
                && s.as_bytes()[0].is_ascii_alphabetic() =>
            {
                return unsafe_path();
            }
            s => parts.push(s),
        }
    }
    if parts.is_empty() {
        return unsafe_path();
    }
    Ok(parts.join("/"))
}

fn is_html(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".html") || lower.ends_with(".htm")
}

/// Files no site needs, left out of a folder or a zip (made by the system, not by its author).
fn is_junk(path: &str) -> bool {
    path.split('/').any(|s| s == "__MACOSX" || s == ".DS_Store" || s == "Thumbs.db" || s == "desktop.ini")
}

fn too_large<T>(total: u64) -> Result<T> {
    Err(DocsError::new(
        413,
        "too_large",
        format!(
            "This site is {}. A site can be {} at most",
            crate::docs_embeds::html::human_size(total),
            crate::docs_embeds::html::human_size(MAX_SITE_BYTES)
        ),
    )
    .with("limit_mb", MAX_SITE_BYTES / (1024 * 1024))
    .with("size_bytes", total)
    .into())
}

fn too_many_files<T>(count: usize) -> Result<T> {
    Err(DocsError::new(
        422,
        "too_many_files",
        format!("This site has {count} files. A site can have {MAX_SITE_FILES} files at most"),
    )
    .with("limit", MAX_SITE_FILES)
    .into())
}

/// Unpacks a zip into `(path, bytes)` (folders and system files left out), within the size and count limits.
fn unzip(bytes: &[u8]) -> Result<Vec<(String, Vec<u8>)>> {
    let bad = || docs_err(422, "bad_zip", "This .zip file cannot be read");
    let Ok(mut archive) = zip::ZipArchive::new(Cursor::new(bytes)) else { return bad() };
    let mut out = Vec::new();
    let mut total: u64 = 0;
    let count = archive.len();
    for i in 0..count {
        let Ok(mut entry) = archive.by_index(i) else { return bad() };
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().to_string();
        if is_junk(&name.replace('\\', "/")) {
            continue;
        }
        let path = safe_path(&name)?;
        if out.len() >= MAX_SITE_FILES {
            return too_many_files(count);
        }
        // read at most what is left of the limit (and one byte more), whatever the entry claims its size is
        let room = MAX_SITE_BYTES - total;
        let mut data = Vec::new();
        if (&mut entry).take(room + 1).read_to_end(&mut data).is_err() {
            return bad();
        }
        total += data.len() as u64;
        if total > MAX_SITE_BYTES {
            return too_large(total);
        }
        out.push((path, data));
    }
    Ok(out)
}

/// Drops the first folder of every path when all paths share it (a folder uploaded with its own name, a zip with
/// one top folder). Returns the folder dropped.
fn strip_common_folder(files: &mut [(String, Vec<u8>)]) -> Option<String> {
    let first = files.first()?.0.split_once('/')?.0.to_string();
    let prefix = format!("{first}/");
    if !files.iter().all(|(p, _)| p.starts_with(&prefix)) {
        return None;
    }
    for (p, _) in files.iter_mut() {
        *p = p[prefix.len()..].to_string();
    }
    Some(first)
}

/// Normalises the files of an upload into the files of a site: a single `.zip` is unpacked, paths are checked,
/// system files are dropped and a folder common to all of them is dropped. Returns the files (each path once, the
/// last one given wins) and the folder dropped, if any.
///
/// # Errors
/// As [`create_site`].
fn site_files(files: Vec<(String, Vec<u8>)>) -> Result<(Vec<(String, Vec<u8>)>, Option<String>)> {
    if files.is_empty() {
        return docs_err(422, "missing_file", "Choose a folder, a .zip file or an .html file");
    }
    let files = if files.len() == 1 && files[0].0.to_ascii_lowercase().ends_with(".zip") {
        unzip(&files[0].1)?
    } else {
        let mut out = Vec::with_capacity(files.len());
        for (p, data) in files {
            if is_junk(&p.replace('\\', "/")) {
                continue;
            }
            out.push((safe_path(&p)?, data));
        }
        out
    };
    let mut files = files;
    let dropped = strip_common_folder(&mut files);
    // the last of two files with the same path wins
    let mut seen = std::collections::HashSet::new();
    let mut unique: Vec<(String, Vec<u8>)> = Vec::with_capacity(files.len());
    for (p, data) in files.into_iter().rev() {
        if seen.insert(p.clone()) {
            unique.push((p, data));
        }
    }
    unique.reverse();
    if unique.len() > MAX_SITE_FILES {
        return too_many_files(unique.len());
    }
    let total: u64 = unique.iter().map(|(_, d)| d.len() as u64).sum();
    if total > MAX_SITE_BYTES {
        return too_large(total);
    }
    Ok((unique, dropped))
}

/// The entry page of a site: `entry` when given (with or without the folder dropped from the paths), else
/// `index.html` at the root, else the first `.html` file at the root (by name).
fn pick_entry(files: &[(String, Vec<u8>)], entry: Option<&str>, dropped: Option<&str>) -> Result<String> {
    let has = |p: &str| files.iter().any(|(f, _)| f == p);
    if let Some(want) = entry.map(str::trim).filter(|e| !e.is_empty()) {
        let want = safe_path(want)?;
        let without = dropped.and_then(|d| want.strip_prefix(&format!("{d}/")).map(str::to_string));
        for cand in [Some(want.clone()), without].into_iter().flatten() {
            if has(&cand) {
                return Ok(cand);
            }
        }
        return docs_err(422, "no_html_page", format!("The entry page {want} is not among the files"));
    }
    if has("index.html") {
        return Ok("index.html".into());
    }
    let mut root_pages: Vec<&str> =
        files.iter().map(|(p, _)| p.as_str()).filter(|p| !p.contains('/') && is_html(p)).collect();
    root_pages.sort_by_key(|p| (!p.eq_ignore_ascii_case("index.htm"), p.to_string()));
    match root_pages.first() {
        Some(p) => Ok((*p).to_string()),
        None => docs_err(422, "no_html_page", "There is no .html page at the top of the folder (index.html)"),
    }
}

/// Makes a new site of uploaded files and returns `{id, url, entry, files: [{path, bytes}], bytes}` (`url` is the
/// entry's address, `bytes` all the files together).
///
/// `files` are `(relative path, bytes)`: the files of a folder (paths with `/` or `\`; a folder common to all of
/// them is dropped), or one `.zip` file (unpacked, a single top folder dropped), or one `.html` file. `entry` is the
/// page to show (a path among the files); by default `index.html` at the root, else the first `.html` file at the
/// root. Blocking (it writes the files): call it from blocking code.
///
/// # Errors
/// 422 `missing_file` (no files), `unsafe_path` (a path leading outside the folder), `bad_zip`, `too_many_files`
/// (more than [`MAX_SITE_FILES`]), `no_html_page` (no entry page); 413 `too_large` (more than [`MAX_SITE_BYTES`]);
/// [`crate::Error::Other`] when the files cannot be written.
pub fn create_site(files: Vec<(String, Vec<u8>)>, entry: Option<&str>) -> Result<Map<String, Value>> {
    let (files, dropped) = site_files(files)?;
    let entry = pick_entry(&files, entry, dropped.as_deref())?;
    let root = sites_root();
    let io = |e: std::io::Error| crate::Error::Other(format!("could not store the site: {e}"));
    std::fs::create_dir_all(&root).map_err(io)?;
    let id = loop {
        let id: String = kb_base::time::uuid4_hex().chars().take(12).collect();
        if !root.join(&id).exists() {
            break id;
        }
    };
    // written to a folder of its own first, then renamed: a site is there whole or not at all
    let temp = root.join(format!(".part-{id}"));
    let written = (|| -> std::io::Result<()> {
        for (p, data) in &files {
            let dest = temp.join(p);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&dest, data)?;
        }
        std::fs::create_dir_all(&temp)?;
        std::fs::rename(&temp, root.join(&id))
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_dir_all(&temp);
        return Err(io(e));
    }
    let mut listed: Vec<Value> = files.iter().map(|(p, d)| json!({"path": p, "bytes": d.len()})).collect();
    listed.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    let total: u64 = files.iter().map(|(_, d)| d.len() as u64).sum();
    let mut out = Map::new();
    out.insert("id".into(), json!(id));
    out.insert("url".into(), json!(site_url(&id, &entry)));
    out.insert("entry".into(), json!(entry));
    out.insert("files".into(), Value::Array(listed));
    out.insert("bytes".into(), json!(total));
    Ok(out)
}

// ---------------------------------------------------------------- routes

/// The routes of the sites: the upload (`POST /projects/{project_id}/docs/sites`) and the files (`GET
/// /docs/sites/{site_id}/{path}`).
pub fn routes() -> Routes {
    Routes::new()
        // a whole folder in one form: the body limit of the extractors is lifted, the handler caps the site's size
        .add("POST", "/projects/{project_id}/docs/sites", post(post_site).layer(DefaultBodyLimit::disable()))
        .get("/docs/sites/{site_id}/{file_path:path}", get_site_file)
}

/// The form of an upload: the files with their paths, and the fields.
struct SiteForm {
    files: Vec<(String, Vec<u8>)>,
    paths: Vec<String>,
    entry: Option<String>,
}

/// Reads the form of `POST /projects/{project_id}/docs/sites`: parts `files` (the filename is the relative path,
/// or a `paths` field gives it, in the same order) and an optional `entry`.
async fn read_site_form(mut multipart: Multipart) -> Result<SiteForm> {
    let bad_form = || crate::Error::from(DocsError::new(400, "bad_form", "There was an error parsing the body"));
    let mut form = SiteForm { files: Vec::new(), paths: Vec::new(), entry: None };
    let mut total: u64 = 0;
    while let Some(mut field) = multipart.next_field().await.map_err(|_| bad_form())? {
        let name = field.name().unwrap_or("").to_string();
        if let Some(filename) = field.file_name().map(str::to_string) {
            if name != "files" && name != "file" {
                continue;
            }
            let mut data: Vec<u8> = Vec::new();
            while let Some(chunk) = field.chunk().await.map_err(|_| bad_form())? {
                total += chunk.len() as u64;
                if total > MAX_SITE_BYTES {
                    return too_large(total);
                }
                data.extend_from_slice(&chunk);
            }
            form.files.push((filename, data));
        } else {
            let text = field.text().await.map_err(|_| bad_form())?;
            match name.as_str() {
                "paths" => form.paths.push(text),
                "entry" => form.entry = Some(text),
                _ => {}
            }
        }
    }
    Ok(form)
}

/// Stores a folder, a `.zip` or an `.html` file as a site for the project's Docs (the actor needs to edit them) and
/// answers 201 with what [`create_site`] returns.
async fn post_site(
    headers: HeaderMap,
    UrlPath(project_id): UrlPath<String>,
    multipart: std::result::Result<Multipart, MultipartRejection>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let done = |r: Result<Map<String, Value>>| r.map_err(|e| crate::api::docs_error(&headers, e));
    let session = kb_db::session();
    done(crate::docs::project(&session, &project_id, true).await.map(|_| Map::new()))?;
    let multipart = multipart.map_err(|_| ApiError::validation(&["body", "files"], "Field required", "missing"))?;
    let form = match read_site_form(multipart).await {
        Ok(f) => f,
        Err(e) => return Err(crate::api::docs_error(&headers, e)),
    };
    let SiteForm { files, paths, entry } = form;
    let files: Vec<(String, Vec<u8>)> = files
        .into_iter()
        .enumerate()
        .map(|(i, (name, data))| (paths.get(i).filter(|p| !p.is_empty()).cloned().unwrap_or(name), data))
        .collect();
    let made = tokio::task::spawn_blocking(move || create_site(files, entry.as_deref()))
        .await
        .map_err(|e| ApiError::internal(format!("the site upload stopped: {e}")))?;
    let out = done(made)?;
    Ok((StatusCode::CREATED, Json(Value::Object(out))))
}

/// Serves a file of a site inline, by its type, with no sandbox or content security policy (an embed's page runs
/// as in a browser). 404 for a site, a file or a folder that is not there.
async fn get_site_file(
    UrlPath((site_id, file_path)): UrlPath<(String, String)>,
    method: Method,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let (id, path) = (site_id.clone(), file_path.clone());
    let found = tokio::task::spawn_blocking(move || resolve_site_file(&id, &path))
        .await
        .map_err(|e| ApiError::internal(format!("the site file could not be read: {e}")))?;
    let Some(real) = found else { return Err(ApiError::not_found("File not found")) };
    Ok(FileResponse::new(real)
        .media_type(content_type(&file_path))
        .header("x-content-type-options", "nosniff")
        .header("cache-control", "private, max-age=31536000, immutable")
        .respond(&method, &headers)
        .await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_checked() {
        assert_eq!(safe_path("a\\b/./c.html").unwrap(), "a/b/c.html");
        for bad in ["../x", "a/../../x", "/etc/passwd", "C:/x", "c:\\x", "", "./", "a\0b"] {
            assert!(safe_path(bad).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn ids_and_urls() {
        assert!(is_site_id("ab12cd34ef56"));
        assert!(!is_site_id("AB12CD34EF56"));
        assert!(!is_site_id("ab12cd34ef5"));
        assert_eq!(site_url("ab12cd34ef56", "my page/ä.html"), "/docs/sites/ab12cd34ef56/my%20page/%C3%A4.html");
        assert_eq!(
            parse_site_url("/docs/sites/ab12cd34ef56/my%20page/%C3%A4.html?x=1"),
            Some(("ab12cd34ef56".into(), "my page/ä.html".into()))
        );
        assert_eq!(
            parse_site_url("http://127.0.0.1:8000/docs/sites/ab12cd34ef56/index.html"),
            Some(("ab12cd34ef56".into(), "index.html".into()))
        );
        assert_eq!(parse_site_url("/other/docs/sites/ab12cd34ef56/index.html"), None);
        assert_eq!(parse_site_url("/docs/sites/ab12cd34ef56/"), None);
        assert_eq!(parse_site_url("/docs/sites/nothex/index.html"), None);
    }

    #[test]
    fn content_types() {
        assert_eq!(content_type("a/B.HTML"), "text/html; charset=utf-8");
        assert_eq!(content_type("m.mjs"), "text/javascript; charset=utf-8");
        assert_eq!(content_type("w.wasm"), "application/wasm");
        assert_eq!(content_type("model.glb"), "model/gltf-binary");
        assert_eq!(content_type("noext"), "application/octet-stream");
    }

    fn f(p: &str) -> (String, Vec<u8>) {
        (p.to_string(), b"x".to_vec())
    }

    #[test]
    fn folder_and_entry() {
        let (files, dropped) = site_files(vec![f("globe/index.html"), f("globe/js/app.js")]).unwrap();
        assert_eq!(dropped.as_deref(), Some("globe"));
        assert_eq!(files.iter().map(|x| x.0.as_str()).collect::<Vec<_>>(), ["index.html", "js/app.js"]);
        assert_eq!(pick_entry(&files, None, None).unwrap(), "index.html");
        assert_eq!(pick_entry(&files, Some("globe/index.html"), dropped.as_deref()).unwrap(), "index.html");
        let (files, _) = site_files(vec![f("b.html"), f("a.html"), f("sub/index.html")]).unwrap();
        assert_eq!(pick_entry(&files, None, None).unwrap(), "a.html");
        let (files, _) = site_files(vec![f("x/a.css"), f("y/b.html")]).unwrap();
        assert!(pick_entry(&files, None, None).is_err());
        assert!(pick_entry(&files, Some("nope.html"), None).is_err());
        assert!(site_files(vec![f("a/../../b.html")]).is_err());
        assert!(site_files(Vec::new()).is_err());
        let (files, _) = site_files(vec![f("index.html"), f("__MACOSX/._index.html"), f("index.html")]).unwrap();
        assert_eq!(files.len(), 1);
    }

    #[test]
    fn zip_is_unpacked() {
        use std::io::Write;
        let mut buf = Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            let o = zip::write::SimpleFileOptions::default();
            z.add_directory("site/", o).unwrap();
            z.start_file("site/index.html", o).unwrap();
            z.write_all(b"<h1>hi</h1>").unwrap();
            z.start_file("site/css/a.css", o).unwrap();
            z.write_all(b"h1{}").unwrap();
            z.finish().unwrap();
        }
        let (files, dropped) = site_files(vec![("pack.zip".into(), buf.into_inner())]).unwrap();
        assert_eq!(dropped.as_deref(), Some("site"));
        assert_eq!(files.iter().map(|x| x.0.as_str()).collect::<Vec<_>>(), ["index.html", "css/a.css"]);
        assert!(site_files(vec![("bad.zip".into(), b"not a zip".to_vec())]).is_err());
    }
}
