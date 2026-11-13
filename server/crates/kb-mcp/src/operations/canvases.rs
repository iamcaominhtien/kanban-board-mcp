//! Canvas operations: boards of HTML, pictures, Sketches and Diagrams with notes and comments on one plane; and the
//! guides the docs tools return.
//!
//! An agent reads a canvas as data (frames, notes, arrows, comments, locks), comments on it, *creates* a canvas (or
//! adds frames to one) from local folders of web pages, and *changes* an HTML frame from a local folder. The change
//! is saved at once (files it leaves out stay). It never takes a lock from a person: a frame a person is editing is
//! refused (`docs/specs/canvas.md`).

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use kb_base::{pyjson, pytext};
use kb_doctext::docs_guide;
use kb_draw::canvases::boards::{AddBoard, PutContent, add_board, board_source, put_board_content};
use kb_draw::canvases::content::{Files, prepare_files};
use kb_draw::canvases::rows::{NewCanvas, Size, create_canvas, get_canvas, get_row, list_for_project};
use kb_draw::canvases::save::{SaveArgs, save};
use kb_draw::canvases::{
    self, MAX_BOARD_BYTES, MAX_BOARDS, MAX_PAGES, board_dir, board_of, embed_line, file_in, new_id, read_doc,
};
use kb_draw::{Error as DrawFailure, canvas_comments, canvas_design, sketches, visual_guides};
use kb_files::pathlib;
use serde_json::{Map, Value, json};

use crate::common::{self, ToolError, ToolResult, notify_on_success};
use crate::hooks;

/// `MAX_INLINE`: the most source text a frame read returns inline.
const MAX_INLINE: usize = 60_000;
/// `MAX_LAYOUT_ITEMS`.
const MAX_LAYOUT_ITEMS: usize = 200;

/// `_error`: a failure of the canvas service as the tool words it: the message, and what to do next for a lock or a
/// conflict.
pub fn canvas_error(err: DrawFailure) -> ToolError {
    match err {
        DrawFailure::Docs(exc) => {
            let hint = match exc.code.as_str() {
                "board_locked" => " A person is editing that frame; try again once they have saved.",
                "board_conflict" => " Read the frame again and change the new version.",
                _ => "",
            };
            ToolError::Value(format!("{}{hint}", exc.message))
        }
        DrawFailure::Value(message) => ToolError::Value(message),
        DrawFailure::Db(err) => err.into(),
        DrawFailure::Io(err) => ToolError::Other(err.to_string()),
    }
}

fn docs_failure(exc: kb_doctext::docs_text::DocsError) -> ToolError {
    canvas_error(DrawFailure::Docs(exc))
}

fn io_failure(err: impl std::fmt::Display) -> ToolError {
    ToolError::Other(err.to_string())
}

/// `_same_project`: an AI run may only touch canvases of the project it works in.
fn same_project(project_id: Option<&str>) -> Result<(), ToolError> {
    if let Some(run) = kb_ai::guard::current() {
        if project_id != Some(run.project_id.as_str()) {
            return Err(ToolError::value(
                "That canvas belongs to another project than this run works in, so it was left alone.",
            ));
        }
    }
    Ok(())
}

/// `_ai_folder(path, create=...)`: the folder an AI run names for frames, checked: an absolute folder (that exists,
/// unless `create`), and for an AI run not the computer's root, the home folder (or one above it) or a dot-folder in
/// the home (.ssh, .aws, .config ...). A person or another client may name any folder.
pub(crate) fn ai_folder(path: &str, create: bool) -> Result<PathBuf, ToolError> {
    let root = PathBuf::from(path);
    if !root.is_absolute() || (!create && !root.is_dir()) {
        return Err(ToolError::Value(format!("Give an absolute folder that exists (got {}).", pytext::repr(path))));
    }
    if kb_ai::guard::current().is_none() {
        return Ok(root);
    }
    // follows links, also of a folder that is not made yet
    let real = pathlib::resolve(&root);
    let home = pathlib::resolve(Path::new(&kb_base::pypath::expanduser("~")));
    if real.parent().is_none() || real == home || home.starts_with(&real) {
        return Err(ToolError::Value(format!(
            "{path} is too wide a folder for frames: give the folder that holds the pages."
        )));
    }
    if let Ok(rest) = real.strip_prefix(&home) {
        if rest.components().next().is_some_and(|c| c.as_os_str().to_string_lossy().starts_with('.')) {
            return Err(ToolError::Value(format!("{path} is a private folder, so it was left alone.")));
        }
    }
    Ok(root)
}

/// `_ai_skips(root, file)`: true when an AI run's folder holds a file that is never taken from it.
fn ai_skips(root: &Path, file: &Path) -> bool {
    kb_ai::guard::current().is_some()
        && kb_board::proofs::never_copied(&file.strip_prefix(root).unwrap_or(file).to_string_lossy())
}

/// `_at(anchor)`: a comment's pin as `docs_write(canvas_comment, at=...)` takes it: a CSS selector or 'text=...'.
fn pin_at(anchor: &Value) -> Option<String> {
    if !pyjson::truthy(anchor) {
        return None;
    }
    if pyjson::truthy(&anchor["sel"]) {
        return Some(pyjson::py_str(&anchor["sel"]));
    }
    pyjson::truthy(&anchor["text"]).then(|| format!("text={}", pyjson::py_str(&anchor["text"])))
}

// ---------------------------------------------------------------------------------------------------------------
// The guides
// ---------------------------------------------------------------------------------------------------------------

/// The whole canvas design guide: how to design frames that look like one considered product (in Claude Code it is
/// also the canvas-design skill), its craft page, and the folder of its exemplar boards on this machine.
pub async fn design_guide() -> ToolResult {
    Ok(json!({
        "guide": canvas_design::GUIDE,
        "craft": canvas_design::CRAFT,
        "examples": hooks::examples_dir(),
    }))
}

/// How to draw and edit a draw.io diagram, and what an AI does with a Sketch: {guide, sketches}.
pub async fn diagram_guide() -> ToolResult {
    Ok(Value::Object(visual_guides::diagram_guide()))
}

/// How to work in Docs (in Claude Code it is the docs-pages skill; issue #268): {guide}.
pub async fn docs_guide() -> ToolResult {
    Ok(Value::Object(docs_guide::guide()))
}

/// The board's shared guides for any role (in Claude Code they are its skills): {name: text} (issue #277).
pub async fn shared_guides() -> ToolResult {
    let mut out: Map<String, Value> =
        kb_skills::shared_skills::guides().into_iter().map(|(name, text)| (name, Value::String(text))).collect();
    for (name, _files) in kb_skills::shared_skills::extra_files() {
        // the scripts and themes a guide refers to are files: say where they are on this machine
        let mut text = out
            .get(&name)
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| ToolError::Other(kb_base::pytext::repr(&name)))?;
        text.push_str(&format!(
            "\n\nThis guide's folder (scripts/, themes/, examples/): {}\n",
            hooks::skill_dir(&name)
        ));
        out.insert(name, Value::String(text));
    }
    Ok(Value::Object(out))
}

/// How to use every part of a ticket and where files go: {guide, roles: {role: what it leaves on a ticket}}.
pub async fn ticket_guide() -> ToolResult {
    let roles: Map<String, Value> = kb_board::ticket_guide::ON_TICKET
        .iter()
        .map(|(role, text)| (role.to_string(), Value::String(text.to_string())))
        .collect();
    Ok(json!({"guide": kb_board::ticket_guide::GUIDE.as_str(), "roles": roles}))
}

/// One role's guide: {role, skill, guide}; without `query`, which roles have one: {roles: {role: what it covers}}.
pub async fn role_guide(query: Option<&str>) -> ToolResult {
    use kb_skills::role_skills;

    let query = query.unwrap_or_default();
    if pytext::strip(query).is_empty() {
        let roles: Map<String, Value> =
            role_skills::ROLE_SKILLS.iter().map(|(role, _n, desc, _b)| (role.to_string(), json!(desc))).collect();
        return Ok(json!({"roles": roles, "designer": "docs_read(action='design_guide')"}));
    }
    let role = pytext::strip(query).to_lowercase().replace([' ', '-'], "_");
    if role == "designer" {
        return Ok(json!({
            "role": "designer",
            "skill": "canvas-design",
            "guide": "The Designer's guide is the design guide: docs_read(action='design_guide').",
        }));
    }
    let Some(text) = role_skills::guide(&role) else {
        let names: Vec<&str> = role_skills::ROLE_SKILLS.iter().map(|(r, _n, _d, _b)| *r).collect();
        return Err(ToolError::Value(format!(
            "No guide for the role {}. Roles: {}, designer.",
            pytext::repr(query),
            names.join(", ")
        )));
    };
    let skill = role_skills::skill_of_role().into_iter().find(|(r, _)| *r == role).map(|(_, s)| s).unwrap_or_default();
    let mut out = Map::new();
    out.insert("role".into(), json!(role));
    out.insert("skill".into(), json!(skill));
    out.insert("guide".into(), json!(text));
    if role_skills::extra_files().iter().any(|(name, _)| name == skill) {
        // the templates the guide refers to are files: say where they are on this machine
        out.insert("folder".into(), json!(hooks::skill_dir(skill)));
    }
    Ok(Value::Object(out))
}

// ---------------------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------------------

/// List a project's canvases: [{id, title, owner_kind, owner_id, page_id, version, rev, boards, updated_by,
/// updated_at, markdown}].
pub async fn list_project_canvases(project_id: &str) -> ToolResult {
    same_project(Some(project_id))?;
    let session = common::async_session();
    let rows = list_for_project(&session, project_id).await.map_err(canvas_error)?;
    Ok(Value::Array(rows.into_iter().map(Value::Object).collect()))
}

/// Read a canvas: {id, title, rev, version, markdown, pages, boards, notes, arrows, labels, comments, locks}.
pub async fn read_canvas(canvas_id: &str, board_id: Option<&str>, path: Option<&str>) -> ToolResult {
    let session = common::async_session();
    let out = get_canvas(&session, canvas_id).await.map_err(canvas_error)?;
    same_project(out.get("project_id").and_then(Value::as_str))?;
    let doc = out.get("doc").cloned().unwrap_or(Value::Null);
    let locks: Vec<Value> = out.get("locks").and_then(Value::as_array).cloned().unwrap_or_default();
    let threads = canvas_comments::list_threads(&session, canvas_id, None).await.map_err(canvas_error)?;
    let items = |key: &str| doc[key].as_array().cloned().unwrap_or_default();
    let boards: Vec<Value> = items("boards")
        .iter()
        .map(|b| {
            let content = b.get("content").filter(|c| pyjson::truthy(c));
            let files: Vec<Value> = content
                .and_then(|c| c.get("files"))
                .and_then(Value::as_array)
                .map(|list| list.iter().map(|f| f["path"].clone()).collect())
                .unwrap_or_default();
            let locked_by = locks.iter().find(|lk| lk["board_id"] == b["id"]).map(|lk| lk["holder"].clone());
            json!({
                "id": b["id"],
                "page": b["page"],
                "name": b["name"],
                "kind": b["kind"],
                "x": b["x"],
                "y": b["y"],
                "width": b["w"],
                "height": b["h"],
                "order": b.get("order").cloned().unwrap_or(json!(0)),
                "ref": b.get("ref").cloned().unwrap_or(Value::Null),
                "entry": content.and_then(|c| c.get("entry")).cloned().unwrap_or(Value::Null),
                "files": files,
                "locked_by": locked_by.unwrap_or(Value::Null),
            })
        })
        .collect();
    let comments: Vec<Value> = threads
        .iter()
        .map(|t| {
            let mut thread = Map::new();
            thread.insert("thread_id".into(), t["id"].clone());
            thread.insert("board_id".into(), t["board_id"].clone());
            thread.insert("status".into(), t["status"].clone());
            thread.insert("number".into(), t["number"].clone());
            // the element the person pinned it on, so the agent knows what they point at (#267)
            if let Some(at) = pin_at(&t["anchor"]) {
                thread.insert("at".into(), json!(at));
            }
            let list: Vec<Value> = t["comments"]
                .as_array()
                .map(|cs| {
                    cs.iter()
                        .map(|c| json!({"author": c["author"], "body": c["body"], "when": c["created_at"]}))
                        .collect()
                })
                .unwrap_or_default();
            thread.insert("comments".into(), Value::Array(list));
            Value::Object(thread)
        })
        .collect();
    let mut result = Map::new();
    for key in ["id", "title", "rev", "version", "markdown", "owner_kind", "owner_id"] {
        result.insert(key.into(), out.get(key).cloned().unwrap_or(Value::Null));
    }
    result.insert(
        "pages".into(),
        Value::Array(items("pages").iter().map(|p| json!({"id": p["id"], "name": p["name"]})).collect()),
    );
    result.insert("boards".into(), Value::Array(boards));
    result.insert(
        "notes".into(),
        Value::Array(
            items("notes")
                .iter()
                .map(|n| json!({"id": n["id"], "page": n["page"], "text": n["text"], "color": n["color"], "by": n["by"]}))
                .collect(),
        ),
    );
    result.insert(
        "arrows".into(),
        Value::Array(
            items("arrows")
                .iter()
                .map(|a| {
                    json!({"id": a["id"], "from": a["from"], "to": a["to"],
                           "label": a.get("label").cloned().unwrap_or(json!(""))})
                })
                .collect(),
        ),
    );
    result.insert(
        "labels".into(),
        Value::Array(
            items("labels").iter().map(|t| json!({"id": t["id"], "page": t["page"], "text": t["text"]})).collect(),
        ),
    );
    result.insert("comments".into(), Value::Array(comments));
    result.insert("locks".into(), Value::Array(locks));
    if let Some(board_id) = board_id.filter(|b| !b.is_empty()) {
        let src = board_source(&session, canvas_id, board_id).await.map_err(canvas_error)?;
        let doc_map = doc.as_object().cloned().unwrap_or_default();
        let index = board_of(&doc_map, board_id).map_err(docs_failure)?;
        let board = canvases::list(&doc_map, "boards")[index].clone();
        let mut shown = Map::new();
        shown.insert("id".into(), json!(board_id));
        shown.insert("name".into(), board["name"].clone());
        shown.insert("kind".into(), board["kind"].clone());
        shown.insert("content_rev".into(), src.get("rev").cloned().unwrap_or(Value::Null));
        shown.insert("entry".into(), src.get("entry").cloned().unwrap_or(Value::Null));
        if let Some(path) = path.filter(|p| !p.is_empty()) {
            let root = ai_folder(path, true)?;
            let mut written: Vec<Value> = Vec::new();
            if let Some(content) = board.get("content").filter(|c| pyjson::truthy(c)) {
                let src_root =
                    board_dir(canvas_id, board_id, content["rev"].as_i64().unwrap_or(0)).map_err(canvas_error)?;
                let real_root = pathlib::resolve(&root);
                for f in content["files"].as_array().map(Vec::as_slice).unwrap_or_default() {
                    let rel = f["path"].as_str().unwrap_or_default();
                    let target = root.join(rel);
                    if !pathlib::resolve(&target).starts_with(&real_root) {
                        return Err(ToolError::Value(format!("{rel} would land outside {}.", root.display())));
                    }
                    if let Some(parent) = target.parent() {
                        std::fs::create_dir_all(parent).map_err(io_failure)?;
                    }
                    std::fs::write(&target, std::fs::read(src_root.join(rel)).map_err(io_failure)?)
                        .map_err(io_failure)?;
                    written.push(json!(target.to_string_lossy()));
                }
            }
            shown.insert("path".into(), json!(root.to_string_lossy()));
            shown.insert("written".into(), Value::Array(written));
        } else {
            let mut total = 0usize;
            let mut inline: Vec<Value> = Vec::new();
            for f in src["files"].as_array().map(Vec::as_slice).unwrap_or_default() {
                total += f["text"].as_str().unwrap_or_default().chars().count();
                if total <= MAX_INLINE {
                    inline.push(f.clone());
                }
            }
            shown.insert("files".into(), Value::Array(inline));
            shown.insert("truncated".into(), json!(total > MAX_INLINE));
        }
        result.insert("board".into(), Value::Object(shown));
    }
    Ok(Value::Object(result))
}

// ---------------------------------------------------------------------------------------------------------------
// Folders of frames
// ---------------------------------------------------------------------------------------------------------------

/// Every path below `dir`, depth first, not going into a link to a folder (`Path.rglob("*")`).
fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(listing) = std::fs::read_dir(dir) else { return };
    for entry in listing.flatten() {
        let path = entry.path();
        out.push(path.clone());
        if path.is_dir() && !std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
            walk(&path, out);
        }
    }
}

/// `sorted(root.rglob("*"))`.
fn rglob_sorted(root: &Path) -> Vec<PathBuf> {
    let mut all = Vec::new();
    walk(root, &mut all);
    all.sort_by(|a, b| a.components().cmp(b.components()));
    all
}

/// `_read_folder(root, top)`: the files of a frame folder (frame.json is not a frame file; nor is canvas.json when the
/// frame is the top folder).
fn read_folder(root: &Path, top: bool) -> Result<Files, ToolError> {
    let mut files: Files = Vec::new();
    let mut total = 0usize;
    for p in rglob_sorted(root) {
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if !p.is_file() || name == "frame.json" || ai_skips(root, &p) {
            continue;
        }
        if top && name == "canvas.json" && p.parent() == Some(root) {
            continue;
        }
        total += std::fs::metadata(&p).map_err(io_failure)?.len() as usize;
        if total > MAX_BOARD_BYTES {
            let shown = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let shown = if shown.is_empty() { root.to_string_lossy().into_owned() } else { shown };
            return Err(ToolError::Value(format!(
                "{shown} is over {} MB, the most a frame can hold.",
                MAX_BOARD_BYTES / (1024 * 1024)
            )));
        }
        let rel = p.strip_prefix(root).unwrap_or(&p).to_string_lossy().replace('\\', "/");
        files.push((rel, std::fs::read(&p).map_err(io_failure)?));
    }
    Ok(files)
}

/// `_json_file(p)`: a JSON object in a file, `{}` when there is no file.
fn json_file(p: &Path) -> Result<Map<String, Value>, ToolError> {
    if !p.is_file() {
        return Ok(Map::new());
    }
    let data = std::fs::read(p).ok().and_then(|bytes| String::from_utf8(bytes).ok());
    let parsed = data.and_then(|text| serde_json::from_str::<Value>(&text).ok());
    match parsed {
        None => Err(ToolError::Value(format!("{} is not valid JSON.", p.display()))),
        Some(Value::Object(map)) => Ok(map),
        Some(_) => Err(ToolError::Value(format!("{} must hold a JSON object.", p.display()))),
    }
}

/// `_page_name(value)`: a page tab named in frame.json or canvas.json ("Foundations"), or None for the first one.
fn page_name(value: Option<&Value>) -> Option<String> {
    let Some(Value::String(text)) = value else { return None };
    let name: String = pytext::strip(text).chars().take(80).collect();
    (!name.is_empty()).then_some(name)
}

/// `int(value)` of a JSON value, as Python reads it.
fn py_int(value: &Value) -> Result<i64, ToolError> {
    match value {
        Value::Number(n) => Ok(n.as_i64().unwrap_or_else(|| n.as_f64().unwrap_or(0.0) as i64)),
        Value::Bool(b) => Ok(i64::from(*b)),
        Value::String(s) => pytext::strip(s)
            .replace('_', "")
            .parse::<i64>()
            .map_err(|_| ToolError::Value(format!("invalid literal for int() with base 10: {}", pytext::repr(s)))),
        other => Err(ToolError::Other(format!(
            "int() argument must be a string, a bytes-like object or a real number, not '{}'",
            py_type(other)
        ))),
    }
}

/// `float(value)` of a JSON value, as Python reads it.
fn py_float(value: &Value) -> Result<f64, ToolError> {
    match value {
        Value::Number(n) => Ok(n.as_f64().unwrap_or(0.0)),
        Value::Bool(b) => Ok(f64::from(u8::from(*b))),
        Value::String(s) => pytext::strip(s)
            .parse::<f64>()
            .map_err(|_| ToolError::Value(format!("could not convert string to float: {}", pytext::repr(s)))),
        other => Err(ToolError::Other(format!(
            "float() argument must be a string or a real number, not '{}'",
            py_type(other)
        ))),
    }
}

fn py_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "NoneType",
        Value::Bool(_) => "bool",
        Value::Number(_) => "int",
        Value::String(_) => "str",
        Value::Array(_) => "list",
        Value::Object(_) => "dict",
    }
}

/// One frame found in a folder.
struct Frame {
    key: String,
    name: String,
    size: Option<Size>,
    fit: bool,
    page: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
    files: Files,
}

/// `re.sub(r"^\d+[-_. ]+", "", text)`: "01-today" shows as "today".
fn without_number(text: &str) -> String {
    let rest = text.trim_start_matches(kb_doctext::pystr::is_decimal);
    if rest.len() == text.len() {
        return text.to_string();
    }
    let after = rest.trim_start_matches(['-', '_', '.', ' ']);
    if after.len() == rest.len() { text.to_string() } else { after.to_string() }
}

/// `_frames_of(root, title)`: the frames in a folder: each sub-folder with an .html page is one (named after it, or by
/// its frame.json); loose pages at the top are one frame.
fn frames_of(root: &Path, title: &str) -> Result<Vec<Frame>, ToolError> {
    let has_page = |dir: &Path| {
        rglob_sorted(dir).iter().any(|p| {
            let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            name.ends_with(".html") || name.ends_with(".htm")
        })
    };
    let mut subs: Vec<PathBuf> = std::fs::read_dir(root)
        .map(|list| list.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect())
        .unwrap_or_default();
    subs.sort_by(|a, b| a.components().cmp(b.components()));
    let sub_frames: Vec<PathBuf> = subs.into_iter().filter(|d| has_page(d)).collect();
    let loose = std::fs::read_dir(root)
        .map(|list| {
            list.flatten().map(|e| e.path()).any(|f| {
                let name = f.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                f.is_file() && [".html", ".htm"].contains(&pathlib::suffix_of_name(&name).to_lowercase().as_str())
            })
        })
        .unwrap_or(false);
    let dirs: Vec<PathBuf> = if loose && sub_frames.is_empty() { vec![root.to_path_buf()] } else { sub_frames };
    let mut frames = Vec::new();
    for d in dirs {
        let meta = json_file(&d.join("frame.json"))?;
        let size = match meta.get("size") {
            Some(Value::Array(list)) if list.len() == 2 => Some(Size::Dims(py_int(&list[0])?, py_int(&list[1])?)),
            Some(Value::String(name)) => Some(Size::Preset(name.clone())),
            _ => None,
        };
        let dir_name = d.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let is_root = d == root;
        let shown = if is_root { title.to_string() } else { dir_name.clone() };
        let stripped = without_number(&shown);
        let shown = if stripped.is_empty() { shown } else { stripped };
        let named = match meta.get("name") {
            Some(v) if pyjson::truthy(v) => pyjson::py_str(v),
            _ => shown,
        };
        let number = |v: Option<&Value>| match v {
            Some(Value::Number(n)) => n.as_f64(),
            Some(Value::String(s)) => pytext::strip(s).parse::<f64>().ok(),
            _ => None,
        };
        frames.push(Frame {
            key: if is_root { "main".to_string() } else { dir_name },
            name: named.chars().take(120).collect(),
            size,
            fit: meta.get("fit").is_some_and(pyjson::truthy),
            page: page_name(meta.get("page")),
            x: number(meta.get("x")),
            y: number(meta.get("y")),
            files: read_folder(&d, is_root)?,
        });
    }
    if frames.is_empty() {
        return Err(ToolError::value(
            "Found no HTML page: put an index.html in the folder (one frame) or in each sub-folder (one frame each).",
        ));
    }
    Ok(frames)
}

/// The notes, arrows and labels of a folder's canvas.json.
struct Layout {
    notes: Vec<Map<String, Value>>,
    arrows: Vec<Map<String, Value>>,
    labels: Vec<Map<String, Value>>,
}

/// `_plan_layout(root, frames)`: the notes, arrows and labels of the folder's canvas.json, checked against the frames
/// (before anything is created).
fn plan_layout(root: &Path, frames: &[Frame]) -> Result<Layout, ToolError> {
    let data = json_file(&root.join("canvas.json"))?;
    let objects = |key: &str| -> Vec<Map<String, Value>> {
        data.get(key)
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(|v| v.as_object().cloned()).collect())
            .unwrap_or_default()
    };
    let (notes, arrows, labels) = (objects("notes"), objects("arrows"), objects("labels"));
    if notes.len() + arrows.len() + labels.len() > MAX_LAYOUT_ITEMS {
        return Err(ToolError::Value(format!(
            "canvas.json holds up to {MAX_LAYOUT_ITEMS} notes, arrows and labels together."
        )));
    }
    let frame_refs: BTreeSet<String> = frames.iter().flat_map(|f| [f.key.clone(), f.name.clone()]).collect();
    let note_refs: BTreeSet<String> =
        notes.iter().filter(|n| n.get("id").is_some_and(pyjson::truthy)).map(|n| pyjson::py_str(&n["id"])).collect();
    let keys = || {
        let mut keys: Vec<&str> = frames.iter().map(|f| f.key.as_str()).collect();
        keys.sort_unstable();
        json!(keys)
    };
    for n in &notes {
        if let Some(near) = n.get("near").filter(|v| pyjson::truthy(v)) {
            if !near.as_str().is_some_and(|s| frame_refs.contains(s)) {
                return Err(ToolError::Value(format!(
                    "A note says near {}, which is not a frame (frames: {}).",
                    pyjson::py_repr(near),
                    pyjson::py_repr(&keys())
                )));
            }
        }
    }
    for a in &arrows {
        for end in ["from", "to"] {
            let value = a.get(end).unwrap_or(&Value::Null);
            if !value.as_str().is_some_and(|s| frame_refs.contains(s) || note_refs.contains(s)) {
                return Err(ToolError::Value(format!(
                    "An arrow {end} {} is not a frame or a note id (frames: {}, notes: {}).",
                    pyjson::py_repr(value),
                    pyjson::py_repr(&keys()),
                    pyjson::py_repr(&json!(note_refs.iter().collect::<Vec<_>>()))
                )));
            }
        }
    }
    Ok(Layout { notes, arrows, labels })
}

/// `_layout_pages(layout)`: the page names canvas.json's notes and labels give, beside the frames'.
fn layout_pages(layout: &Layout) -> Vec<String> {
    layout.notes.iter().chain(layout.labels.iter()).filter_map(|i| page_name(i.get("page"))).collect()
}

/// `_make_pages(session, canvas, names, fresh)`: `{page name: page id}` for the pages the folder names, in the order
/// they first appear: an existing page of that name is reused, the others are added. A new canvas's first page
/// ("Page 1") takes the first name.
async fn make_pages(
    session: &kb_db::Session,
    canvas_id: &str,
    base_rev: i64,
    names: &[String],
    fresh: bool,
) -> Result<Vec<(String, String)>, ToolError> {
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let doc = read_doc(canvas_id).map_err(canvas_error)?;
    let pages = canvases::list(&doc, "pages").to_vec();
    let by_name: HashMap<String, String> =
        pages.iter().map(|p| (pyjson::py_str(&p["name"]), pyjson::py_str(&p["id"]))).collect();
    let mut ids: Vec<(String, String)> = Vec::new();
    let mut upsert: Vec<Map<String, Value>> = Vec::new();
    for (i, name) in names.iter().enumerate() {
        let obj = |value: Value| value.as_object().cloned().unwrap_or_default();
        if let Some(id) = by_name.get(name) {
            ids.push((name.clone(), id.clone()));
        } else if fresh && i == 0 {
            let first = &pages[0];
            ids.push((name.clone(), pyjson::py_str(&first["id"])));
            upsert.push(obj(
                json!({"id": first["id"], "rev": first.get("rev").cloned().unwrap_or(Value::Null), "name": name}),
            ));
        } else {
            let id = new_id("p");
            ids.push((name.clone(), id.clone()));
            upsert.push(obj(json!({"id": id, "name": name, "order": pages.len() + upsert.len()})));
        }
    }
    if !upsert.is_empty() {
        save(
            session,
            canvas_id,
            SaveArgs { base_rev, upsert: vec![("pages".to_string(), upsert)], ..Default::default() },
        )
        .await
        .map_err(canvas_error)?;
    }
    Ok(ids)
}

/// `a + b` as Python adds two numbers of a canvas: whole numbers stay whole.
fn plus(a: &Value, b: &Value) -> Value {
    match (a.as_i64(), b.as_i64()) {
        (Some(a), Some(b)) => json!(a + b),
        _ => json!(a.as_f64().unwrap_or(0.0) + b.as_f64().unwrap_or(0.0)),
    }
}

/// `_apply_layout(session, canvas, layout, placed, pages)`: notes, arrows and labels from canvas.json, saved in one
/// go (a note says `near` a frame or gives x and y).
async fn apply_layout(
    session: &kb_db::Session,
    canvas_id: &str,
    base_rev: i64,
    layout: &Layout,
    placed: &[(String, Value)],
    pages: &[(String, String)],
) -> Result<Map<String, Value>, ToolError> {
    if layout.notes.is_empty() && layout.arrows.is_empty() && layout.labels.is_empty() {
        return Ok(Map::new());
    }
    let placed_of = |key: &str| placed.iter().rev().find(|(k, _)| k == key).map(|(_, b)| b);
    let page_id = |name: Option<String>| -> Option<String> {
        let name = name.unwrap_or_default();
        pages.iter().find(|(n, _)| *n == name).map(|(_, id)| id.clone())
    };
    let on = |page: &Option<String>| -> Vec<&Value> {
        placed
            .iter()
            .map(|(_, b)| b)
            .filter(|b| match page {
                Some(page) => b.get("page").and_then(Value::as_str) == Some(page.as_str()),
                None => true,
            })
            .collect()
    };
    let mut ids: HashMap<String, String> = HashMap::new();
    let mut note_page: HashMap<String, Option<String>> = HashMap::new();
    let (mut notes, mut arrows, mut labels): (
        Vec<Map<String, Value>>,
        Vec<Map<String, Value>>,
        Vec<Map<String, Value>>,
    ) = (Vec::new(), Vec::new(), Vec::new());
    for n in &layout.notes {
        let nid = new_id("n");
        if n.get("id").is_some_and(pyjson::truthy) {
            ids.insert(pyjson::py_str(&n["id"]), nid.clone());
        }
        let near = n.get("near").filter(|v| pyjson::truthy(v)).and_then(Value::as_str).and_then(&placed_of);
        let page = match near {
            Some(near) => near.get("page").and_then(Value::as_str).map(str::to_string),
            None => page_id(page_name(n.get("page"))),
        };
        note_page.insert(nid.clone(), page.clone());
        let low = on(&page)
            .iter()
            .map(|b| plus(&b["y"], &b["h"]))
            .max_by(|a, b| a.as_f64().partial_cmp(&b.as_f64()).unwrap_or(std::cmp::Ordering::Equal))
            .unwrap_or(json!(0));
        let low = plus(&low, &json!(60));
        let x_default = match near {
            Some(near) => json!(near["x"].as_f64().unwrap_or(0.0) + py_float(n.get("dx").unwrap_or(&json!(0)))?),
            None => json!(0),
        };
        let y_default = match near {
            Some(near) => plus(&plus(&near["y"], &near["h"]), &json!(60)),
            None => low,
        };
        let mut note = Map::new();
        note.insert("id".into(), json!(nid));
        note.insert("x".into(), n.get("x").cloned().unwrap_or(x_default));
        note.insert("y".into(), n.get("y").cloned().unwrap_or(y_default));
        note.insert("w".into(), n.get("w").cloned().unwrap_or(json!(260)));
        note.insert("h".into(), n.get("h").cloned().unwrap_or(json!(130)));
        note.insert("text".into(), json!(n.get("text").map_or(String::new(), pyjson::py_str)));
        note.insert("color".into(), n.get("color").cloned().unwrap_or(json!("yellow")));
        if let Some(page) = page {
            note.insert("page".into(), json!(page));
        }
        notes.push(note);
    }
    for a in &layout.arrows {
        let end_id = |end: &str| -> String {
            let key = pyjson::py_str(&a[end]);
            match placed_of(&key) {
                Some(b) => pyjson::py_str(&b["id"]),
                None => ids.get(&key).cloned().unwrap_or_default(),
            }
        };
        let ends = [end_id("from"), end_id("to")];
        let start = placed_of(&pyjson::py_str(&a["from"]));
        let page = match start {
            Some(start) => start.get("page").and_then(Value::as_str).map(str::to_string),
            None => note_page.get(&ends[0]).cloned().flatten(),
        };
        let mut arrow = Map::new();
        arrow.insert("id".into(), json!(new_id("a")));
        arrow.insert("from".into(), json!(ends[0]));
        arrow.insert("to".into(), json!(ends[1]));
        arrow.insert("label".into(), json!(a.get("label").map_or(String::new(), pyjson::py_str)));
        if let Some(page) = page {
            arrow.insert("page".into(), json!(page));
        }
        arrows.push(arrow);
    }
    for t in &layout.labels {
        let page = page_id(page_name(t.get("page")));
        let top = on(&page)
            .iter()
            .map(|b| b["y"].clone())
            .min_by(|a, b| a.as_f64().partial_cmp(&b.as_f64()).unwrap_or(std::cmp::Ordering::Equal))
            .unwrap_or(json!(0));
        let mut label = Map::new();
        label.insert("id".into(), json!(new_id("t")));
        label.insert("x".into(), t.get("x").cloned().unwrap_or(json!(0)));
        label.insert("y".into(), t.get("y").cloned().unwrap_or_else(|| plus(&top, &json!(-120))));
        label.insert("text".into(), json!(t.get("text").map_or(String::new(), pyjson::py_str)));
        label.insert("size".into(), t.get("size").cloned().unwrap_or(json!(24)));
        if let Some(page) = page {
            label.insert("page".into(), json!(page));
        }
        labels.push(label);
    }
    let counts = (notes.len(), arrows.len(), labels.len());
    save(
        session,
        canvas_id,
        SaveArgs {
            base_rev,
            upsert: vec![("notes".into(), notes), ("arrows".into(), arrows), ("labels".into(), labels)],
            ..Default::default()
        },
    )
    .await
    .map_err(canvas_error)?;
    let mut out = Map::new();
    out.insert("notes".into(), json!(counts.0));
    out.insert("arrows".into(), json!(counts.1));
    out.insert("labels".into(), json!(counts.2));
    Ok(out)
}

/// Create a canvas from folders of web pages, or add frames to an existing one (canvas_id). Returns {id, title,
/// version, markdown, boards: [{id, name, w, h}]}: put `markdown` on its own line in the ticket, idea or Docs page.
pub async fn create_canvas_from_files(
    path: &str,
    owner_kind: Option<&str>,
    owner_id: Option<&str>,
    title: Option<&str>,
    canvas_id: Option<&str>,
) -> ToolResult {
    notify_on_success(async {
        let root = ai_folder(path, false)?;
        let canvas_id = canvas_id.filter(|c| !c.is_empty());
        let owner = owner_kind.filter(|k| !k.is_empty()).zip(owner_id.filter(|i| !i.is_empty()));
        if canvas_id.is_none() && owner.is_none() {
            return Err(ToolError::value(
                "Give owner_kind and owner_id for a new canvas, or canvas_id to add frames to one.",
            ));
        }
        let frames = frames_of(&root, title.filter(|t| !t.is_empty()).unwrap_or("Frame"))?;
        if frames.len() > MAX_BOARDS {
            return Err(ToolError::Value(format!("A canvas holds up to {MAX_BOARDS} frames.")));
        }
        let layout = plan_layout(&root, &frames)?;
        let mut page_names: Vec<String> = Vec::new();
        for name in frames.iter().filter_map(|f| f.page.clone()).chain(layout_pages(&layout)) {
            if !page_names.contains(&name) {
                page_names.push(name);
            }
        }
        if page_names.len() > MAX_PAGES {
            return Err(ToolError::Value(format!("A canvas has up to {MAX_PAGES} page tabs.")));
        }
        let session = common::async_session();
        // check every frame before anything is created
        for f in &frames {
            prepare_files(&f.files, None).map_err(docs_failure)?;
        }
        let out_id = match (canvas_id, owner) {
            (Some(canvas_id), _) => {
                let c = get_row(&session, canvas_id, false).await.map_err(canvas_error)?;
                same_project(c.project_id.as_deref())?;
                c.id
            }
            (None, Some((kind, id))) => {
                // `_owner_for_project(owner_kind)`
                let project_kind = if kind == "page" { "doc" } else { kind };
                let project = sketches::project_of(&session, project_kind, id, None).await.map_err(canvas_error)?;
                same_project(project.as_deref())?;
                let made = create_canvas(
                    &session,
                    NewCanvas { owner_kind: kind, owner_id: id, title, start: "none", ..NewCanvas::default() },
                )
                .await
                .map_err(canvas_error)?;
                made["id"].as_str().unwrap_or_default().to_string()
            }
            (None, None) => return Err(ToolError::Other("no canvas".into())),
        };
        let current = get_row(&session, &out_id, false).await.map_err(canvas_error)?;
        let pages = make_pages(&session, &out_id, i64::from(current.rev), &page_names, canvas_id.is_none()).await?;
        let mut boards: Vec<Value> = Vec::new();
        let mut placed: Vec<(String, Value)> = Vec::new();
        for f in frames {
            let made = add_board(
                &session,
                &out_id,
                AddBoard {
                    name: Some(f.name.clone()),
                    kind: "html".into(),
                    page: pages.iter().find(|(n, _)| Some(n) == f.page.as_ref()).map(|(_, id)| id.clone()),
                    files: Some(f.files),
                    size: f.size,
                    x: f.x,
                    y: f.y,
                    fit: f.fit,
                    ..AddBoard::default()
                },
            )
            .await
            .map_err(canvas_error)?;
            let b = made["board"].clone();
            placed.push((f.key.clone(), b.clone()));
            if f.name != f.key {
                placed.push((f.name.clone(), b.clone()));
            }
            boards.push(json!({"id": b["id"], "name": b["name"], "w": b["w"], "h": b["h"]}));
        }
        let fresh = get_row(&session, &out_id, false).await.map_err(canvas_error)?;
        let counts = apply_layout(&session, &out_id, i64::from(fresh.rev), &layout, &placed, &pages).await?;
        let fresh = get_row(&session, &out_id, false).await.map_err(canvas_error)?;
        let mut out = Map::new();
        out.insert("id".into(), json!(fresh.id));
        out.insert("title".into(), json!(fresh.title));
        out.insert("version".into(), json!(fresh.version));
        out.insert("markdown".into(), json!(embed_line(&fresh.id, &fresh.title, None)));
        out.insert("boards".into(), Value::Array(boards));
        if !pages.is_empty() {
            out.insert("pages".into(), json!(pages.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>()));
        }
        out.extend(counts);
        Ok(Value::Object(out))
    })
    .await
}

/// Change an HTML frame from a folder; the board changes at once (History gets no version; the earlier files stay in
/// the board). Returns {board_id, name, content_rev, files, note}. A frame a person is editing is locked: the error
/// names them, try again later.
pub async fn update_canvas_frame(canvas_id: &str, board_id: &str, path: &str, note: Option<&str>) -> ToolResult {
    notify_on_success(async {
        let root = ai_folder(path, false)?;
        let files = read_folder(&root, false)?;
        if files.is_empty() {
            return Err(ToolError::Value(format!("{} holds no files to put in the frame.", root.display())));
        }
        let session = common::async_session();
        let c = get_row(&session, canvas_id, false).await.map_err(canvas_error)?;
        same_project(c.project_id.as_deref())?;
        let doc = read_doc(&c.id).map_err(canvas_error)?;
        let index = board_of(&doc, board_id).map_err(docs_failure)?;
        let board = canvases::list(&doc, "boards")[index].clone();
        let content = board.get("content").filter(|v| pyjson::truthy(v)).cloned().unwrap_or(json!({}));
        let mut current: Files = Vec::new();
        if let Some(rev) = content.get("rev").and_then(Value::as_i64) {
            let folder = board_dir(&c.id, board_id, rev).map_err(canvas_error)?;
            for f in content["files"].as_array().map(Vec::as_slice).unwrap_or_default() {
                let rel = f["path"].as_str().unwrap_or_default();
                let file = file_in(&folder, rel).map_err(docs_failure)?;
                if file.is_file() {
                    current.push((rel.to_string(), std::fs::read(&file).map_err(io_failure)?));
                }
            }
        }
        // `{**current, **files}`: a new file replaces the old one in place, the others go last
        let mut merged = current;
        for (name, data) in &files {
            match merged.iter_mut().find(|(n, _)| n == name) {
                Some(slot) => slot.1 = data.clone(),
                None => merged.push((name.clone(), data.clone())),
            }
        }
        let team = kb_ai::guard::current().map(|run| run.member_name).unwrap_or_else(|| "AI".to_string());
        let entry = content.get("entry").and_then(Value::as_str).map(str::to_string);
        let out = put_board_content(
            &session,
            canvas_id,
            board_id,
            &merged,
            PutContent {
                entry: entry.as_deref(),
                base_content_rev: content.get("rev").and_then(Value::as_i64),
                release: true,
                ai_team: Some(team.as_str()),
            },
        )
        .await
        .map_err(canvas_error)?;
        let changed = &out["board"];
        let mut names: Vec<&str> = files.iter().map(|(n, _)| n.as_str()).collect();
        names.sort_unstable();
        let mut reply = Map::new();
        reply.insert("board_id".into(), json!(board_id));
        reply.insert("name".into(), changed["name"].clone());
        reply.insert("content_rev".into(), changed["content"]["rev"].clone());
        reply.insert("files".into(), json!(names));
        if let Some(note) = note.filter(|n| !n.is_empty()) {
            reply.insert("note".into(), json!(note));
        }
        Ok(Value::Object(reply))
    })
    .await
}

/// Comment on a canvas under your own name. Returns the thread {id, number, board_id, status, comments}. You never
/// resolve a person's thread.
pub async fn comment_on_canvas(
    canvas_id: &str,
    body: &str,
    board_id: Option<&str>,
    thread_id: Option<&str>,
    at: Option<&str>,
) -> ToolResult {
    notify_on_success(async {
        let session = common::async_session();
        let c = get_row(&session, canvas_id, false).await.map_err(canvas_error)?;
        same_project(c.project_id.as_deref())?;
        let ai = kb_ai::guard::current().map(|run| json!({"member": run.member_name}));
        if let Some(thread_id) = thread_id.filter(|t| !t.is_empty()) {
            let thread = canvas_comments::thread_by_id(&session, thread_id).await.map_err(canvas_error)?;
            if thread["canvas_id"] != json!(canvas_id) {
                return Err(ToolError::value("That thread belongs to another canvas."));
            }
            let reply = canvas_comments::reply(&session, thread_id, body, ai.as_ref()).await.map_err(canvas_error)?;
            return Ok(Value::Object(reply));
        }
        let board_id = board_id.filter(|b| !b.is_empty());
        let at = at.filter(|a| !a.is_empty());
        let anchor = match (at, board_id) {
            (Some(at), Some(_)) => Some(match at.strip_prefix("text=") {
                Some(text) => json!({"text": text}),
                None => json!({"sel": at}),
            }),
            (Some(_), None) => {
                return Err(ToolError::value("`at` needs board_id: it names an element of that frame."));
            }
            _ => None,
        };
        let new = canvas_comments::NewThread {
            body,
            board_id,
            x: 0.5,
            y: 0.5,
            page: None,
            anchor: anchor.as_ref(),
            ai: ai.as_ref(),
        };
        let thread = canvas_comments::add_thread(&session, canvas_id, new).await.map_err(canvas_error)?;
        Ok(Value::Object(thread))
    })
    .await
}
