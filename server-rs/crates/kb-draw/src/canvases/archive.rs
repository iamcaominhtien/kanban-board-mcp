//! `services/canvases.py` lines 1925-2099: import (HTML files, pictures, a ZIP of a built page) and export (a ZIP of the
//! canvas or of one frame).

use std::io::{Cursor, Read, Write};

use kb_base::pyjson;
use kb_db::Session;
use kb_doctext::docs_text::DocsError;
use serde_json::{Map, Value, json};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use super::boards::{AddBoard, add_board};
use super::content::{Files, put_file};
use super::rows::{Size, get_row};
use super::*;
use crate::{Result, diagrams, sketches, util};

/// The files of a ZIP, safely: no absolute paths or `..`, a size cap on what it unpacks to.
pub fn unzip(data: &[u8]) -> Result<Files> {
    let mut z = ZipArchive::new(Cursor::new(data))
        .map_err(|_| DocsError::new(422, "invalid_file", "That ZIP file could not be read."))?;
    // the entries that are files, as `(index, name, size)`
    let mut infos: Vec<(usize, String, u64)> = Vec::new();
    for i in 0..z.len() {
        let Ok(file) = z.by_index_raw(i) else { continue };
        if !file.is_dir() && !file.name().starts_with("__MACOSX/") {
            infos.push((i, file.name().to_string(), file.size()));
        }
    }
    if infos.len() > MAX_FILES * 4 {
        return Err(DocsError::new(422, "too_many_files", "That ZIP holds too many files.").into());
    }
    let mut out: Files = Vec::new();
    let mut total = 0u64;
    for (index, name, size) in infos {
        total += size;
        if total > MAX_CANVAS_BYTES as u64 {
            return Err(
                DocsError::new(413, "canvas_too_large", "That ZIP unpacks to more than the canvas can hold.").into()
            );
        }
        let Ok(path) = safe_path(&name) else { continue };
        let broken =
            || DocsError::new(422, "invalid_file", "That ZIP could not be unpacked (it may be encrypted or damaged).");
        let mut file = z.by_index(index).map_err(|_| broken())?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).map_err(|_| broken())?;
        put_file(&mut out, path, bytes);
    }
    Ok(out)
}

/// `_strip_common_root(files)`: the one folder that holds every file is taken off their paths.
pub fn strip_common_root(files: Files) -> Files {
    let mut tops: Vec<&str> = Vec::new();
    for (p, _) in &files {
        let top = p.split('/').next().unwrap_or("");
        if !tops.contains(&top) {
            tops.push(top);
        }
    }
    if tops.len() == 1 && files.iter().all(|(p, _)| p.contains('/')) {
        let mut out = Vec::new();
        for (p, v) in files {
            put_file(&mut out, p.split_once('/').map(|(_, rest)| rest.to_string()).unwrap_or_default(), v);
        }
        return out;
    }
    files
}

/// Make a frame of each file: an HTML file, a picture, or a ZIP of a built page. Each is placed to the right of the last
/// one. (`.sketch` and `.drawio` files are turned into a Sketch or Diagram by the editor, which then adds a frame that
/// points at it.) Returns `{boards: [...], failed: [{name, message, code}], rev}`.
pub async fn import_files(
    session: &Session,
    canvas_id: &str,
    uploads: Vec<(String, Vec<u8>)>,
    page: Option<&str>,
    size: Option<Size>,
) -> Result<Map<String, Value>> {
    let mut boards: Vec<Value> = Vec::new();
    let mut failed: Vec<Value> = Vec::new();
    for (name, data) in uploads {
        let stem = kb_files::pathlib::name(&name.replace('\\', "/")).to_string();
        let ext = kb_files::pathlib::suffix_of_name(&stem).to_lowercase();
        let desktop = || Some(size.clone().unwrap_or_else(|| Size::Preset("desktop".into())));
        let made: Result<Map<String, Value>> = async {
            if ext == ".zip" {
                let files = strip_common_root(unzip(&data)?);
                add_board(
                    session,
                    canvas_id,
                    AddBoard { kind: "html".into(), files: Some(files), page: page.map(str::to_string), size: desktop(), ..Default::default() },
                )
                .await
            } else if ext == ".html" || ext == ".htm" {
                let stem_name = kb_files::pathlib::stem_of_name(&stem).to_string();
                add_board(
                    session,
                    canvas_id,
                    AddBoard {
                        kind: "html".into(),
                        files: Some(vec![("index.html".into(), data.clone())]),
                        name: if stem_name.to_lowercase() == "index" { None } else { Some(stem_name) },
                        page: page.map(str::to_string),
                        size: desktop(),
                        ..Default::default()
                    },
                )
                .await
            } else if IMAGE_EXT.contains(&ext.as_str()) {
                add_board(
                    session,
                    canvas_id,
                    AddBoard {
                        kind: "image".into(),
                        files: Some(vec![(stem.clone(), data.clone())]),
                        page: page.map(str::to_string),
                        size: size.clone(),
                        ..Default::default()
                    },
                )
                .await
            } else {
                Err(DocsError::new(
                    422,
                    "invalid_file",
                    format!(
                        "\u{201c}{stem}\u{201d} cannot become a frame. Use an HTML file, a picture, or a ZIP of a built page."
                    ),
                )
                .into())
            }
        }
        .await;
        match made {
            Ok(mut out) => boards.push(out.remove("board").unwrap_or(Value::Null)),
            Err(crate::Error::Docs(e)) => failed.push(json!({"name": stem, "message": e.message, "code": e.code})),
            Err(e) => return Err(e),
        }
    }
    let c = get_row(session, canvas_id, false).await?;
    let mut out = Map::new();
    out.insert("boards".into(), Value::Array(boards));
    out.insert("failed".into(), Value::Array(failed));
    out.insert("rev".into(), json!(c.rev));
    Ok(out)
}

/// `_slug(text, fallback)`.
pub fn slug(text: &str, fallback: &str) -> String {
    let s = util::file_stem(text);
    if s.is_empty() { fallback.to_string() } else { s }
}

fn zip_error(e: impl std::fmt::Display) -> crate::Error {
    crate::Error::Io(std::io::Error::other(e.to_string()))
}

/// A ZIP of the canvas (`canvas.json` and a folder per frame) or of one frame: `(zip bytes, file name)`.
pub async fn export_zip(
    session: &Session,
    canvas_id: &str,
    board_id: Option<&str>,
    version: Option<i32>,
) -> Result<(Vec<u8>, String)> {
    let c = get_row(session, canvas_id, false).await?;
    // `if version`: 0 is the current file
    let doc: Doc = match version.filter(|v| *v != 0) {
        Some(n) => match pyjson::loads(&versions::get_version_row(session, canvas_id, n).await?.doc) {
            Some(Value::Object(o)) => o,
            _ => Map::new(),
        },
        None => read_doc(&c.id)?,
    };
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let mut z = ZipWriter::new(Cursor::new(Vec::new()));
    let mut used: Vec<String> = Vec::new();
    for b in list(&doc, "boards") {
        let id = b.get("id").and_then(Value::as_str).unwrap_or("");
        if board_id.is_some_and(|only| !only.is_empty()) && Some(id) != board_id {
            continue;
        }
        let mut folder = slug(b.get("name").and_then(Value::as_str).unwrap_or(""), id);
        while used.contains(&folder) {
            folder.push_str("-2");
        }
        used.push(folder.clone());
        let prefix = if board_id.is_some_and(|only| !only.is_empty()) { String::new() } else { format!("{folder}/") };
        let content = b.get("content").filter(|v| pyjson::truthy(v));
        let reference = b.get("ref").and_then(Value::as_str).filter(|r| !r.is_empty());
        let kind = b.get("kind").and_then(Value::as_str).unwrap_or("");
        if let Some(content) = content {
            let root = board_dir(&c.id, id, content.get("rev").map_or(0, as_int))?;
            for f in content.get("files").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default() {
                let path = f.get("path").and_then(Value::as_str).unwrap_or("");
                let p = file_in(&root, path)?;
                if p.is_file() {
                    z.start_file(format!("{prefix}{path}"), options).map_err(zip_error)?;
                    z.write_all(&std::fs::read(&p)?)?;
                }
            }
        } else if kind == "sketch" && reference.is_some() {
            let p = sketches::png_path(reference.unwrap_or(""));
            if p.exists() {
                z.start_file(format!("{prefix}{folder}.png"), options).map_err(zip_error)?;
                z.write_all(&std::fs::read(&p)?)?;
            }
        } else if kind == "diagram" && reference.is_some() {
            match diagrams::read_file(session, reference.unwrap_or(""), "svg", None).await {
                Ok((svg, _, _)) => {
                    z.start_file(format!("{prefix}{folder}.svg"), options).map_err(zip_error)?;
                    z.write_all(svg.as_bytes())?;
                }
                Err(crate::Error::Docs(_)) => {}
                Err(e) => return Err(e),
            }
        }
    }
    if board_id.is_none_or(str::is_empty) {
        z.start_file("canvas.json", options).map_err(zip_error)?;
        z.write_all(pyjson::Dumps::new().indent(2).ensure_ascii(false).dump(&doc).as_bytes())?;
    }
    let bytes = z.finish().map_err(zip_error)?.into_inner();
    let mut stem = slug(&c.title, "canvas");
    if let Some(bid) = board_id.filter(|b| !b.is_empty()) {
        let name =
            list(&doc, "boards")[board_of(&doc, bid)?].get("name").and_then(Value::as_str).unwrap_or("").to_string();
        stem = slug(&name, "frame");
    }
    Ok((bytes, format!("{stem}.zip")))
}
