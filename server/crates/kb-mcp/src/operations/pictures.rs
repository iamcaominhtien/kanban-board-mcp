//! Look at what you drew: a PNG of a diagram, a canvas frame, a sketch or a local file (issue #267).
//!
//! An agent with only the board's MCP server has no browser of its own, so it could not see the diagram or the frame
//! it made before handing it in. `docs_read(action='picture')` draws one with the browser the board finds on the
//! machine (`kb_draw::screenshots`), writes it where the agent can open it, and keeps a copy on the board so the
//! picture can go straight into a comment (`markdown`). Without any browser it says so and gives a wireframe.

use std::path::{Path, PathBuf};

use kb_draw::canvases::{self, rows};
use kb_draw::{Error as DrawFailure, canvas_png, diagram_export, diagram_model, diagrams, screenshots, sketches};
use kb_files::{pathlib, uploads};
use serde_json::{Map, Value, json};

use crate::common::{self, ToolError, ToolResult};

/// `FRAME_WIDTHS`.
const FRAME_WIDTHS: [(&str, i64); 4] = [("phone", 390), ("tablet", 820), ("desktop", 1280), ("laptop", 1440)];

/// `NO_BROWSER`.
const NO_BROWSER: &str = "No browser on this machine, so this is a wireframe (boxes and lines, no text): check the \
                          words with docs_read(diagram) or the frame's source. Install Chrome or Chromium (or set \
                          KANBAN_CHROME_PATH) for a real picture; the desktop app draws one with its own browser.";

/// `(png, drawn_by, note)`.
type Drawn = (Vec<u8>, &'static str, String);

/// What a failure of a drawing service says to the agent: the message alone (`raise ValueError(exc.message)`).
fn plain(err: DrawFailure) -> ToolError {
    match err {
        DrawFailure::Docs(exc) => ToolError::Value(exc.message),
        DrawFailure::Value(message) => ToolError::Value(message),
        DrawFailure::Db(err) => err.into(),
        DrawFailure::Io(err) => ToolError::Other(err.to_string()),
    }
}

fn model_error(err: diagram_model::Error) -> ToolError {
    match err {
        diagram_model::Error::Docs(exc) => ToolError::Value(exc.message),
        diagram_model::Error::Value(message) => ToolError::Other(message),
    }
}

fn docs_failure(exc: kb_doctext::docs_text::DocsError) -> ToolError {
    ToolError::Value(exc.message)
}

fn io_failure(err: impl std::fmt::Display) -> ToolError {
    ToolError::Other(err.to_string())
}

/// `_size(png)`: width and height from the header of a PNG.
fn size_of(png: &[u8]) -> (u32, u32) {
    if png.len() >= 24 && png[..8] == *b"\x89PNG\r\n\x1a\n" {
        return (
            u32::from_be_bytes([png[16], png[17], png[18], png[19]]),
            u32::from_be_bytes([png[20], png[21], png[22], png[23]]),
        );
    }
    (0, 0)
}

/// `_stem(text)`: a file name made of word characters, dots and dashes.
fn stem(text: &str) -> String {
    let mut out = String::new();
    let mut gap = false;
    for c in text.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') {
            if gap {
                out.push('-');
                gap = false;
            }
            out.push(c);
        } else {
            gap = true;
        }
    }
    if gap {
        out.push('-');
    }
    let trimmed = out.trim_matches(|c| matches!(c, '-' | '.' | '_'));
    if trimmed.is_empty() { "picture".to_string() } else { trimmed.to_string() }
}

/// `_target(path, name)`: where the PNG goes: `path` (a folder gets `<name>.png`), else a folder of the board's in
/// the temp folder.
fn target(path: Option<&str>, name: &str) -> Result<PathBuf, ToolError> {
    let Some(path) = path.filter(|p| !p.is_empty()) else {
        let folder = std::env::temp_dir().join("kanban-pictures");
        std::fs::create_dir_all(&folder).map_err(io_failure)?;
        return Ok(folder.join(format!("{}.png", stem(name))));
    };
    if !pathlib::is_absolute(path) {
        return Err(ToolError::Value(format!(
            "Give an absolute path for the picture (got {}).",
            kb_base::pytext::repr(path)
        )));
    }
    let mut p = PathBuf::from(path);
    if pathlib::suffix(path).to_lowercase() != ".png" {
        std::fs::create_dir_all(&p).map_err(io_failure)?;
        p = p.join(format!("{}.png", stem(name)));
    }
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(io_failure)?;
    }
    Ok(p)
}

/// `_check_run(project_id, local)`: inside an AI run, the item is of the run's project and a local source is in the
/// run's folder. Returns whether the run may write.
async fn check_run(project_id: Option<&str>, local: Option<&Path>) -> Result<bool, ToolError> {
    let Some(run) = kb_ai::guard::current() else { return Ok(true) };
    if project_id.is_some_and(|p| p != run.project_id) {
        return Err(ToolError::value("That belongs to another project than this run works in, so it was left alone."));
    }
    if let Some(local) = local {
        let folders = common::run_folder().await?.unwrap_or_default();
        let real = pathlib::resolve(local);
        let inside = folders.iter().any(|f| {
            let base = pathlib::resolve(Path::new(f));
            real.starts_with(&base)
        });
        if !inside {
            return Err(ToolError::Value(format!(
                "{} is outside your working folder: look at files you made there.",
                local.display()
            )));
        }
    }
    Ok(true)
}

/// `_frame_width(folder)`: the width a frame folder is drawn at: its frame.json `size`, else desktop.
fn frame_width(folder: &Path) -> i64 {
    let size = std::fs::read_to_string(folder.join("frame.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|meta| meta.get("size").cloned());
    match size {
        Some(Value::Array(list)) if !list.is_empty() && list[0].is_number() => list[0].as_f64().unwrap_or(0.0) as i64,
        Some(Value::String(name)) if !name.is_empty() => {
            FRAME_WIDTHS.iter().find(|(n, _)| *n == name).map_or(1280, |(_, w)| *w)
        }
        _ => 1280,
    }
}

/// `_diagram_png(source, svg)`: the editor's own SVG when there is one, else the server's plain one.
async fn diagram_png(source: &str, svg: Option<String>) -> Result<Drawn, ToolError> {
    let mut note = String::new();
    let mut svg = svg;
    if svg.is_none() {
        let session = common::async_session();
        let settings = diagrams::get_settings(&session, None).await.map_err(plain)?;
        let mode = settings["mode"].as_str().unwrap_or_default();
        let url = settings["effective_url"].as_str().unwrap_or_default();
        if diagram_export::enabled(mode) && !url.is_empty() {
            svg = diagram_export::export_svg(source, url, None).await;
        }
    }
    let svg = match svg {
        Some(svg) => svg,
        None => {
            note = "Drawn by the board's plain renderer (boxes, ellipses, diamonds, cylinders, arrows, text); other \
                    shapes show as boxes and the editor draws them exactly."
                .to_string();
            diagram_model::render_svg(source).map_err(model_error)?
        }
    };
    match screenshots::svg_png(&svg, None).await {
        Some(png) => Ok((png, "browser", note)),
        None => Ok((
            diagram_model::wireframe_png(source, 1600.0).map_err(model_error)?,
            "wireframe",
            NO_BROWSER.to_string(),
        )),
    }
}

/// `_frame_png(folder, entry, width)`.
async fn frame_png(folder: &Path, entry: &str, width: i64) -> Result<Drawn, ToolError> {
    if let Some(png) = screenshots::page_png(folder, entry, width, None).await {
        return Ok((png, "browser", String::new()));
    }
    let text = std::fs::read(folder.join(entry)).ok().map(|bytes| String::from_utf8_lossy(&bytes).into_owned());
    Ok((
        canvas_png::board_snapshot(text.as_deref(), width, 800, 800),
        "wireframe",
        NO_BROWSER.replace("(boxes and lines, no text)", "(bars for text, boxes)"),
    ))
}

/// `_local(src, width)`: `(png, drawn_by, note, name)` of a local file or frame folder.
async fn local(src: &Path, width: Option<i64>) -> Result<(Vec<u8>, &'static str, String, String), ToolError> {
    if src.is_dir() {
        let entry = if src.join("index.html").is_file() {
            "index.html".to_string()
        } else {
            let mut pages: Vec<String> = std::fs::read_dir(src)
                .map(|list| list.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
                .unwrap_or_default();
            pages.retain(|n| n.contains(".htm"));
            pages.sort();
            let Some(first) = pages.into_iter().next() else {
                return Err(ToolError::Value(format!(
                    "{} has no index.html: give a frame folder, an .html, .svg or .drawio file.",
                    src.display()
                )));
            };
            first
        };
        let (png, by, note) = frame_png(src, &entry, width.unwrap_or_else(|| frame_width(src))).await?;
        let name = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        return Ok((png, by, note, name));
    }
    if !src.is_file() {
        return Err(ToolError::Value(format!("{} does not exist: write the file first, then look.", src.display())));
    }
    let file_name = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let suffix = pathlib::suffix_of_name(&file_name).to_lowercase();
    let parent = src.parent().unwrap_or(Path::new("/"));
    let name = if file_name == "index.html" {
        parent.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    } else {
        pathlib::stem_of_name(&file_name).to_string()
    };
    match suffix.as_str() {
        ".html" | ".htm" => {
            let (png, by, note) = frame_png(parent, &file_name, width.unwrap_or_else(|| frame_width(parent))).await?;
            Ok((png, by, note, name))
        }
        ".svg" => {
            let text = std::fs::read_to_string(src).map_err(io_failure)?;
            match screenshots::svg_png(&text, width).await {
                Some(png) => Ok((png, "browser", String::new(), name)),
                None => Err(ToolError::Value(format!(
                    "{}, so an SVG cannot be drawn.",
                    NO_BROWSER.split(':').next().unwrap_or_default()
                ))),
            }
        }
        ".drawio" | ".xml" => {
            let source = diagrams::read_local(&src.to_string_lossy(), "path").map_err(docs_failure)?;
            diagrams::validate_source(&source).map_err(docs_failure)?;
            let (png, by, note) = diagram_png(&source, None).await?;
            Ok((png, by, note, name))
        }
        _ => Err(ToolError::Value(format!(
            "{file_name}: a picture is drawn of a frame folder or an .html, .svg or .drawio file."
        ))),
    }
}

/// The arguments of `picture`.
#[derive(Debug, Default)]
pub struct PictureArgs {
    /// Without an id: the local file to look at; with an id: where to write the PNG.
    pub path: Option<String>,
    /// A diagram `dg_xxxxxxxx`.
    pub diagram_id: Option<String>,
    /// diagram_id: an older version.
    pub version: Option<i64>,
    /// A canvas `cv_xxxxxxxx`.
    pub canvas_id: Option<String>,
    /// canvas_id: the frame `b_xxxxxxxx` to draw.
    pub board_id: Option<String>,
    /// A sketch `sk_xxxxxxxx`.
    pub sketch_id: Option<String>,
    /// A frame or page: the width to draw it at.
    pub width: Option<i64>,
}

/// A PNG of what you drew, to look at before you hand it in: {path, width, height, drawn_by, markdown}.
pub async fn picture(args: PictureArgs) -> ToolResult {
    let PictureArgs { mut path, diagram_id, version, canvas_id, board_id, sketch_id, width } = args;
    let (diagram_id, canvas_id, sketch_id) = (
        diagram_id.filter(|v| !v.is_empty()),
        canvas_id.filter(|v| !v.is_empty()),
        sketch_id.filter(|v| !v.is_empty()),
    );
    let given = [&diagram_id, &canvas_id, &sketch_id].iter().filter(|x| x.is_some()).count();
    if given > 1 {
        return Err(ToolError::value("Give one of diagram_id, canvas_id or sketch_id."));
    }
    if given == 0 && path.as_deref().is_none_or(str::is_empty) {
        return Err(ToolError::value(
            "Give diagram_id, canvas_id (+ board_id) or sketch_id, or `path` of a local .drawio, .svg, .html file or \
             frame folder to look at.",
        ));
    }
    let (png, drawn_by, note, name, may_write): (Vec<u8>, &str, String, String, bool);
    if let Some(diagram_id) = diagram_id {
        let session = common::async_session();
        let version = version.and_then(|v| i32::try_from(v).ok());
        let d = diagrams::get_diagram(&session, &diagram_id, version, true).await.map_err(plain)?;
        let (svg, _, _) = diagrams::read_file(&session, &diagram_id, "svg", version).await.map_err(plain)?;
        let source = d["source"].as_str().unwrap_or_default().to_string();
        let kind = d["preview_kind"].as_str().unwrap_or_default();
        name = d["label"].as_str().unwrap_or_default().to_string();
        may_write = check_run(d["project_id"].as_str(), None).await?;
        let svg = if kind == "editor" || kind == "agent" { Some(svg) } else { None };
        (png, drawn_by, note) = diagram_png(&source, svg).await?;
    } else if let Some(sketch_id) = sketch_id {
        let session = common::async_session();
        let s = sketches::get_sketch(&session, &sketch_id).await.map_err(plain)?;
        may_write = check_run(s["project_id"].as_str(), None).await?;
        png = std::fs::read(sketches::png_path(s["id"].as_str().unwrap_or_default())).map_err(io_failure)?;
        drawn_by = "stored";
        note = String::new();
        name = s["title"].as_str().unwrap_or_default().to_string();
    } else if let Some(canvas_id) = canvas_id {
        let session = common::async_session();
        let c = rows::get_row(&session, &canvas_id, false).await.map_err(plain)?;
        let doc = canvases::read_doc(&c.id).map_err(plain)?;
        may_write = check_run(c.project_id.as_deref(), None).await?;
        match board_id.as_deref().filter(|b| !b.is_empty()) {
            None => {
                png = canvas_png::overview(&Value::Object(doc), None, 1200);
                drawn_by = "wireframe";
                note = "The page's layout only: frames as boxes, notes as squares. Pass board_id for a real picture \
                        of a frame."
                    .to_string();
                name = c.title.clone();
            }
            Some(board_id) => {
                let index = canvases::board_of(&doc, board_id).map_err(docs_failure)?;
                let board = canvases::list(&doc, "boards")[index].clone();
                name = format!("{}-{}", c.title, board["name"].as_str().unwrap_or_default());
                (png, drawn_by, note) = board_png(&board, &c.id, width).await?;
            }
        }
    } else {
        let given_path = path.clone().unwrap_or_default();
        let src = PathBuf::from(&given_path);
        if !src.is_absolute() {
            return Err(ToolError::Value(format!(
                "Give an absolute path (got {}).",
                kb_base::pytext::repr(&given_path)
            )));
        }
        may_write = check_run(None, Some(&src)).await?;
        let (p, by, n, nm) = local(&src, width).await?;
        (png, drawn_by, note, name) = (p, by, n, nm);
        // beside the file; a frame's picture beside its folder, so it never becomes a file of the frame
        let frame: Option<&Path> = if src.is_dir() {
            Some(&src)
        } else if src.file_name().is_some_and(|n| n == "index.html") {
            src.parent()
        } else {
            None
        };
        path = Some(match frame {
            Some(frame) => {
                let folder = frame.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                frame
                    .parent()
                    .unwrap_or(Path::new("/"))
                    .join(format!("{}.png", stem(&folder)))
                    .to_string_lossy()
                    .into_owned()
            }
            None => {
                let name = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let stem = pathlib::stem_of_name(&name);
                src.with_file_name(format!("{stem}.png")).to_string_lossy().into_owned()
            }
        });
    }
    // safe mode writes nothing beside your files and nothing on the board: only a PNG in the temp folder
    if may_write && path.as_deref().is_some_and(|p| !p.is_empty()) && given > 0 {
        // inside a run, a PNG is written only in the run's own folder, as its other files are
        check_run(None, path.as_deref().map(Path::new)).await?;
    }
    let target = target(if may_write { path.as_deref() } else { None }, &name)?;
    std::fs::write(&target, &png).map_err(io_failure)?;
    let (w, h) = size_of(&png);
    let mut out = Map::new();
    out.insert("path".into(), json!(target.to_string_lossy()));
    out.insert("width".into(), json!(w));
    out.insert("height".into(), json!(h));
    out.insert("drawn_by".into(), json!(drawn_by));
    if !note.is_empty() {
        out.insert("note".into(), json!(note));
    }
    if may_write {
        let file_name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let stored = uploads::build_upload_filename(&file_name);
        std::fs::write(uploads::get_uploads_dir(true).join(&stored), &png).map_err(io_failure)?;
        out.insert("markdown".into(), json!(format!("![{name}](/uploads/{stored})")));
    }
    out.insert(
        "look".into(),
        json!(format!(
            "Open the PNG and check it before you hand it in{}",
            if may_write { "; to show it, put `markdown` in a ticket comment or Docs page." } else { "." }
        )),
    );
    Ok(Value::Object(out))
}

/// `_board_png(board, canvas_id, width)`: `(png, drawn_by, note)` of one frame of a canvas.
async fn board_png(board: &Value, canvas_id: &str, width: Option<i64>) -> Result<Drawn, ToolError> {
    let kind = board["kind"].as_str().unwrap_or_default();
    let content = board.get("content").filter(|c| kb_base::pyjson::truthy(c));
    let reference = board.get("ref").and_then(Value::as_str).filter(|r| !r.is_empty());
    if let (Some(reference), "sketch") = (reference, kind) {
        return Ok((std::fs::read(sketches::png_path(reference)).map_err(io_failure)?, "stored", String::new()));
    }
    if let (Some(reference), "diagram") = (reference, kind) {
        let session = common::async_session();
        let d = diagrams::get_diagram(&session, reference, None, true).await.map_err(plain)?;
        let (svg, _, _) = diagrams::read_file(&session, reference, "svg", None).await.map_err(plain)?;
        let source = d["source"].as_str().unwrap_or_default().to_string();
        let pk = d["preview_kind"].as_str().unwrap_or_default();
        return diagram_png(&source, if pk == "editor" || pk == "agent" { Some(svg) } else { None }).await;
    }
    let Some(content) = content else {
        return Err(ToolError::value("That frame is empty: there is nothing to draw yet."));
    };
    let rev = content.get("rev").map_or(0, canvases::as_int);
    let root = canvases::board_dir(canvas_id, board["id"].as_str().unwrap_or_default(), rev).map_err(plain)?;
    let board_width = board.get("w").map_or(0, canvases::as_int);
    let entry = content["entry"].as_str().unwrap_or_default();
    if kind == "image" {
        let data = std::fs::read(canvases::file_in(&root, entry).map_err(docs_failure)?).map_err(io_failure)?;
        if data.len() >= 8 && data[..8] == *b"\x89PNG\r\n\x1a\n" {
            return Ok((data, "stored", String::new()));
        }
        let tmp = tempfile::Builder::new().prefix("kanban-pic-").tempdir().map_err(io_failure)?;
        let ext = pathlib::suffix(entry);
        std::fs::write(tmp.path().join(format!("picture{ext}")), &data).map_err(io_failure)?;
        std::fs::write(
            tmp.path().join("index.html"),
            format!(
                "<!doctype html><meta name='viewport' content='width=device-width, initial-scale=1'><style>body{{margin:0}}img{{display:block;width:100%}}</style><img src='picture{ext}'>"
            ),
        )
        .map_err(io_failure)?;
        return frame_png(tmp.path(), "index.html", board_width).await;
    }
    let tmp = tempfile::Builder::new().prefix("kanban-pic-").tempdir().map_err(io_failure)?;
    let base = pathlib::resolve(tmp.path());
    for f in content.get("files").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default() {
        let rel = f["path"].as_str().unwrap_or_default();
        let dest = pathlib::resolve(&tmp.path().join(rel));
        if !dest.starts_with(&base) {
            continue;
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(io_failure)?;
        }
        let bytes = std::fs::read(canvases::file_in(&root, rel).map_err(docs_failure)?).map_err(io_failure)?;
        std::fs::write(&dest, bytes).map_err(io_failure)?;
    }
    frame_png(tmp.path(), entry, width.filter(|w| *w != 0).unwrap_or(board_width)).await
}
