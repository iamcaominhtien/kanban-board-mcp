//! `services/canvases.py` lines 1427-1923 (frames): add a frame, save a frame's content under its lock, duplicate, copy a
//! whole canvas, and read a frame's files, source, snapshot and the canvas overview.

use kb_base::{activity, pyjson, pytext};
use kb_db::Session;
use kb_db::entities::{canvas, diagram, sketch};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, EntityTrait};
use kb_doctext::docs_text::DocsError;
use serde_json::{Map, Value, json};

use super::content::{self, Files};
use super::rows::{Size, get_canvas, get_row, member_role, persist, touch};
use super::*;
use crate::{Result, canvas_locks, canvas_png, sketches};

/// What `add_board` is told.
#[derive(Debug, Clone)]
pub struct AddBoard {
    /// Name of the frame (the page title, or "Frame n").
    pub name: Option<String>,
    /// `html` (needs `files`), `image` (one picture in `files`), `sketch` / `diagram` (`ref`) or `empty`.
    pub kind: String,
    /// Page tab; the first when omitted.
    pub page: Option<String>,
    /// `{path: bytes}` of an HTML or image frame.
    pub files: Option<Files>,
    /// The page of an HTML frame to show.
    pub entry: Option<String>,
    /// Id of the Sketch (`sk_...`) or Diagram (`dg_...`) a frame holds; it always shows its latest version.
    pub reference: Option<String>,
    /// A preset name (`desktop`...) or `(width, height)`.
    pub size: Option<Size>,
    /// Position; placed to the right of the last frame when omitted.
    pub x: Option<f64>,
    /// Position.
    pub y: Option<f64>,
    /// Make the height fit the page: the editor measures the page once and sets the height.
    pub fit: bool,
}

impl Default for AddBoard {
    fn default() -> Self {
        Self {
            name: None,
            kind: "empty".into(),
            page: None,
            files: None,
            entry: None,
            reference: None,
            size: None,
            x: None,
            y: None,
            fit: false,
        }
    }
}

/// `min(MAX, max(MIN, ...))` of the size a picture asks for: the width the editor allows, the height in proportion.
fn fit_dims(dims: (i64, i64)) -> (i64, i64) {
    let w = MAX_W.min(MIN_W.max(dims.0));
    let h = (dims.1 as f64 * w as f64 / dims.0.max(1) as f64).round_ties_even() as i64;
    (w, MAX_H.min(MIN_H.max(h)))
}

/// Add a frame to the canvas. Returns `{board, rev}`. Fails with 403, and 413 / 422 for limits and bad files.
pub async fn add_board(session: &Session, canvas_id: &str, args: AddBoard) -> Result<Map<String, Value>> {
    let _guard = serial(canvas_id).await;
    if !BOARD_KINDS.contains(&args.kind.as_str()) {
        return Err(DocsError::new(
            422,
            "invalid_board",
            "kind must be one of ('html', 'image', 'sketch', 'diagram', 'empty')",
        )
        .into());
    }
    let kind = args.kind.as_str();
    let mut c = get_row(session, canvas_id, false).await?;
    let read = c.clone();
    member_role(session, &c).await?;
    let mut doc = read_doc(&c.id)?;
    if list(&doc, "boards").len() >= MAX_BOARDS {
        return Err(DocsError::new(422, "too_many_boards", format!("A canvas holds up to {MAX_BOARDS} frames."))
            .with("limit_boards", MAX_BOARDS)
            .into());
    }
    let page_ids: Vec<&str> = list(&doc, "pages").iter().filter_map(|p| p.get("id").and_then(Value::as_str)).collect();
    let page: Value = match args.page.as_deref() {
        Some(p) if page_ids.contains(&p) => json!(p),
        _ => list(&doc, "pages")[0]["id"].clone(),
    };
    let board_id = new_id("b");
    let new_rev = i64::from(c.rev) + 1;
    let mut content: Option<Map<String, Value>> = None;
    let mut written: Files = Vec::new();
    let (mut w, mut h) = match &args.size {
        None => size_preset("desktop").unwrap_or((1280, 800)),
        Some(Size::Preset(name)) => size_preset(name).unwrap_or((1280, 800)),
        Some(Size::Dims(w, h)) => (*w, *h),
    };
    let mut title = String::new();
    match kind {
        "html" => {
            let files = args.files.as_ref().filter(|f| !f.is_empty());
            let Some(files) = files else {
                return Err(DocsError::new(422, "no_page", "A frame needs an HTML page.").into());
            };
            let (clean, info) = content::prepare_files(files, args.entry.as_deref())?;
            title = info.get("title").and_then(Value::as_str).unwrap_or("").to_string();
            written = clean;
            content = Some(info);
        }
        "image" => {
            let files = args.files.as_ref().filter(|f| f.len() == 1);
            let Some(files) = files else {
                return Err(DocsError::new(422, "invalid_file", "An image frame holds one picture.").into());
            };
            let (raw_name, data) = &files[0];
            let Some(ext) = content::magic_image(data) else {
                return Err(DocsError::new(422, "invalid_file", "Pictures can be PNG, JPEG, GIF, WebP or SVG.").into());
            };
            if data.len() > MAX_BOARD_BYTES {
                return Err(content::too_large_board(data.len()).into());
            }
            let file_name = format!("image{ext}");
            title = kb_files::pathlib::stem(raw_name).to_string();
            let mut info = Map::new();
            info.insert("entry".into(), json!(file_name));
            info.insert("files".into(), json!([{"path": file_name, "bytes": data.len()}]));
            info.insert("bytes".into(), json!(data.len()));
            info.insert("skipped".into(), json!([]));
            info.insert("title".into(), json!(title));
            written = vec![(file_name, data.clone())];
            content = Some(info);
            if let Some(dims) = content::image_size(data) {
                if args.size.is_none() {
                    (w, h) = fit_dims(dims);
                }
            }
        }
        "sketch" | "diagram" => {
            let (name, dims) = check_ref(session, &c, kind, args.reference.as_deref()).await?;
            title = name;
            if let Some(dims) = dims {
                if args.size.is_none() {
                    (w, h) = fit_dims(dims);
                }
            }
        }
        _ => {}
    }
    if let Some(info) = content.as_mut() {
        let bytes = info.get("bytes").map_or(0, as_int) as usize;
        content::check_canvas_bytes(&doc, None, bytes)?;
        info.insert("rev".into(), json!(new_rev));
    }
    let (px, py) = content::free_spot(&doc, &page, w as f64, h as f64);
    let actor = activity::current_actor();
    let n_same = list(&doc, "boards").iter().filter(|b| b.get("page") == Some(&page)).count();
    let name = text(args.name.as_deref().map(|n| json!(n)).as_ref(), MAX_TITLE);
    let name = pytext::strip(&name).to_string();
    let name = if !name.is_empty() {
        name
    } else if !title.is_empty() {
        title
    } else {
        format!("Frame {}", list(&doc, "boards").len() + 1)
    };
    let is_ref_kind = kind == "sketch" || kind == "diagram";
    let mut board = Map::new();
    board.insert("id".into(), json!(board_id));
    board.insert("page".into(), page.clone());
    board.insert("name".into(), json!(name));
    board.insert("kind".into(), json!(kind));
    board.insert("x".into(), json!(args.x.unwrap_or(px)));
    board.insert("y".into(), json!(args.y.unwrap_or(py)));
    board.insert("w".into(), json!(w as f64));
    board.insert("h".into(), json!(h as f64));
    board.insert("order".into(), json!(n_same));
    board.insert("ref".into(), if is_ref_kind { json!(args.reference) } else { Value::Null });
    board.insert("content".into(), content.map_or(Value::Null, Value::Object));
    board.insert("rev".into(), json!(new_rev));
    board.insert("created_by".into(), json!(actor));
    if args.fit && kind == "html" {
        board.insert("fit".into(), json!(true));
    }
    if !written.is_empty() {
        content::write_revision(&c.id, &board_id, new_rev, &written)?;
    }
    list_mut(&mut doc, "boards").push(Value::Object(board.clone()));
    c.rev = (new_rev - 1) as i32;
    touch(&mut c, &doc);
    write_doc(&c.id, &doc)?;
    c = persist(session, &read, &c).await?;
    session.commit().await?;
    rows::reindex(session, &c).await?;
    let mut out = Map::new();
    out.insert("board".into(), Value::Object(board));
    out.insert("rev".into(), json!(c.rev));
    Ok(out)
}

/// The Sketch or Diagram a frame holds must exist and belong to the same project: `(its name, its size)`.
async fn check_ref(
    session: &Session,
    c: &canvas::Model,
    kind: &str,
    reference: Option<&str>,
) -> Result<(String, Option<(i64, i64)>)> {
    let id = reference.unwrap_or("");
    let live = |d: &Option<String>| d.as_deref().is_none_or(str::is_empty);
    if kind == "sketch" {
        let s = match sketch::Entity::find_by_id(id).one(session).await? {
            Some(s) if live(&s.deleted_at) => s,
            _ => return Err(DocsError::new(404, "sketch_not_found", "That sketch was not found.").into()),
        };
        if s.project_id != c.project_id {
            return Err(DocsError::new(422, "other_project", "That sketch belongs to another project.").into());
        }
        return Ok((s.title, Some((i64::from(s.width), i64::from(s.height)))));
    }
    let d = match diagram::Entity::find_by_id(id).one(session).await? {
        Some(d) if live(&d.deleted_at) => d,
        _ => return Err(DocsError::new(404, "diagram_not_found", "That diagram was not found.").into()),
    };
    if Some(&d.project_id) != c.project_id.as_ref() {
        return Err(DocsError::new(422, "other_project", "That diagram belongs to another project.").into());
    }
    Ok((d.label, None))
}

/// What `put_board_content` is told besides the files.
#[derive(Debug, Clone)]
pub struct PutContent<'a> {
    /// The page to show.
    pub entry: Option<&'a str>,
    /// The content revision the editor started from; a different one means somebody saved meanwhile.
    pub base_content_rev: Option<i64>,
    /// Let go of the lock after saving (Save to canvas).
    pub release: bool,
    /// The AI team that saves this change. The frame keeps its name (`ai_saved_by`) so the plane can show who changed
    /// it; a save by a person clears it.
    pub ai_team: Option<&'a str>,
}

impl Default for PutContent<'_> {
    fn default() -> Self {
        Self { entry: None, base_content_rev: None, release: true, ai_team: None }
    }
}

/// `_locked(board, lock)`.
fn locked(board: &Value, lock: &canvas_locks::Lock) -> DocsError {
    let name = board.get("name").map_or(String::new(), pyjson::py_str);
    DocsError::new(
        423,
        "board_locked",
        format!("{} is editing {name}. You can still look, comment and move it.", lock.holder),
    )
    .with("holder", lock.holder.clone())
    .with("since", lock.since_iso.clone())
    .with("board_id", board.get("id").cloned().unwrap_or(Value::Null))
}

/// Save a frame's new content (the person editing it holds the lock). Fails with 423 `board_locked` if somebody else
/// holds the frame, 409 `board_conflict`, and 413 / 422.
pub async fn put_board_content(
    session: &Session,
    canvas_id: &str,
    board_id: &str,
    files: &Files,
    opts: PutContent<'_>,
) -> Result<Map<String, Value>> {
    let _guard = serial(canvas_id).await;
    let mut c = get_row(session, canvas_id, false).await?;
    let read = c.clone();
    member_role(session, &c).await?;
    let mut doc = read_doc(&c.id)?;
    let bi = board_of(&doc, board_id)?;
    let board = list(&doc, "boards")[bi].clone();
    if !matches!(board.get("kind").and_then(Value::as_str), Some("html" | "empty")) {
        return Err(DocsError::new(
            422,
            "not_editable_here",
            "Images, Sketches and Diagrams are changed in their own editors.",
        )
        .into());
    }
    let actor = activity::current_actor();
    let held_before = canvas_locks::locks_of(&c.id)
        .iter()
        .any(|lk| lk.get("board_id") == Some(&json!(board_id)) && lk.get("holder") == Some(&json!(actor)));
    let (taken, lock) = canvas_locks::acquire(&c.id, board_id, &actor);
    if !taken {
        return Err(locked(&board, &lock).into());
    }
    let done: Result<()> = async {
        let cur_rev =
            board.get("content").filter(|v| pyjson::truthy(v)).and_then(|c| c.get("rev")).filter(|v| !v.is_null());
        if let (Some(base), Some(cur)) = (opts.base_content_rev, cur_rev) {
            if !py_eq(&json!(base), cur) {
                // the team that saved the board's content, else whoever touched the canvas last
                let saver = board
                    .get("ai_saved_by")
                    .filter(|v| pyjson::truthy(v))
                    .map_or_else(|| c.updated_by.clone(), pyjson::py_str);
                let name = board.get("name").map_or(String::new(), pyjson::py_str);
                return Err(DocsError::new(
                    409,
                    "board_conflict",
                    format!("{saver} saved a newer version of {name} while you were editing it."),
                )
                .with("latest_content_rev", cur.clone())
                .with("latest_author", saver)
                .into());
            }
        }
        let (written, mut info) = content::prepare_files(files, opts.entry)?;
        content::check_canvas_bytes(&doc, Some(board_id), info.get("bytes").map_or(0, as_int) as usize)?;
        let new_rev = i64::from(c.rev) + 1;
        info.insert("rev".into(), json!(new_rev));
        content::write_revision(&c.id, board_id, new_rev, &written)?;
        if let Value::Object(b) = &mut list_mut(&mut doc, "boards")[bi] {
            b.insert("kind".into(), json!("html"));
            b.insert("content".into(), Value::Object(info));
            b.insert("rev".into(), json!(new_rev));
            match opts.ai_team.filter(|t| !t.is_empty()) {
                Some(team) => {
                    b.insert("ai_saved_by".into(), json!(team.chars().take(80).collect::<String>()));
                }
                None => {
                    b.shift_remove("ai_saved_by");
                }
            }
        }
        c.rev = (new_rev - 1) as i32;
        touch(&mut c, &doc);
        write_doc(&c.id, &doc)?;
        c = persist(session, &read, &c).await?;
        session.commit().await?;
        Ok(())
    }
    .await;
    if let Err(e) = done {
        // a refused save must not leave the board locked for ten minutes when this call took the lock itself (an
        // editor that held it before stays open to fix the problem)
        if opts.release && !held_before {
            canvas_locks::release(&c.id, board_id, Some(&actor));
        }
        return Err(e);
    }
    if opts.release {
        canvas_locks::release(&c.id, board_id, Some(&actor));
    }
    let mut out = Map::new();
    out.insert("board".into(), list(&doc, "boards")[bi].clone());
    out.insert("rev".into(), json!(c.rev));
    Ok(out)
}

/// Take the lock on a frame so its content can be changed. Fails with 423 `board_locked` if somebody else holds it,
/// and 422 for a frame that is not edited as source.
pub async fn lock_board(session: &Session, canvas_id: &str, board_id: &str) -> Result<Map<String, Value>> {
    let c = get_row(session, canvas_id, false).await?;
    member_role(session, &c).await?;
    let doc = read_doc(&c.id)?;
    let board = list(&doc, "boards")[board_of(&doc, board_id)?].clone();
    if !matches!(board.get("kind").and_then(Value::as_str), Some("html" | "empty")) {
        return Err(DocsError::new(
            422,
            "not_editable_here",
            "Images, Sketches and Diagrams are changed in their own editors.",
        )
        .into());
    }
    let (taken, lock) = canvas_locks::acquire(&c.id, board_id, &activity::current_actor());
    if !taken {
        return Err(locked(&board, &lock).into());
    }
    Ok(canvas_locks::describe(&c.id, board_id).unwrap_or_default())
}

/// Show you are still editing. `{alive: False}` when the lock was lost.
pub async fn heartbeat_board(session: &Session, canvas_id: &str, board_id: &str) -> Result<Map<String, Value>> {
    get_row(session, canvas_id, false).await?;
    let ok = canvas_locks::heartbeat(canvas_id, board_id, &activity::current_actor());
    let mut out = Map::new();
    out.insert("alive".into(), json!(ok));
    out.insert("lock".into(), canvas_locks::describe(canvas_id, board_id).map_or(Value::Null, Value::Object));
    Ok(out)
}

/// Let go of the lock (Cancel, or closing the editor).
pub async fn unlock_board(session: &Session, canvas_id: &str, board_id: &str) -> Result<Map<String, Value>> {
    get_row(session, canvas_id, false).await?;
    let mut out = Map::new();
    out.insert("released".into(), json!(canvas_locks::release(canvas_id, board_id, Some(&activity::current_actor()))));
    Ok(out)
}

/// Copy a frame next to the original.
pub async fn duplicate_board(session: &Session, canvas_id: &str, board_id: &str) -> Result<Map<String, Value>> {
    let _guard = serial(canvas_id).await;
    let mut c = get_row(session, canvas_id, false).await?;
    let read = c.clone();
    member_role(session, &c).await?;
    let mut doc = read_doc(&c.id)?;
    let src = list(&doc, "boards")[board_of(&doc, board_id)?].clone();
    if list(&doc, "boards").len() >= MAX_BOARDS {
        return Err(DocsError::new(422, "too_many_boards", format!("A canvas holds up to {MAX_BOARDS} frames."))
            .with("limit_boards", MAX_BOARDS)
            .into());
    }
    let new_rev = i64::from(c.rev) + 1;
    let mut copy = src.as_object().cloned().unwrap_or_default();
    let new_board_id = new_id("b");
    copy.insert("id".into(), json!(new_board_id));
    let name = format!("{} copy", src.get("name").map_or(String::new(), pyjson::py_str));
    copy.insert("name".into(), json!(name.chars().take(MAX_TITLE).collect::<String>()));
    let page = src.get("page").cloned().unwrap_or(Value::Null);
    let (cx, cy) = content::free_spot(
        &doc,
        &page,
        src.get("w").and_then(Value::as_f64).unwrap_or(0.0),
        src.get("h").and_then(Value::as_f64).unwrap_or(0.0),
    );
    copy.insert("x".into(), json!(cx));
    copy.insert("y".into(), json!(cy));
    let order = list(&doc, "boards").iter().filter(|b| b.get("page") == Some(&page)).count();
    copy.insert("order".into(), json!(order));
    copy.insert("rev".into(), json!(new_rev));
    copy.insert("created_by".into(), json!(activity::current_actor()));
    // a person's copy is not the team's change
    copy.shift_remove("ai_saved_by");
    if let Some(src_content) = src.get("content").filter(|v| pyjson::truthy(v)) {
        let bytes = src_content.get("bytes").map_or(0, as_int) as usize;
        content::check_canvas_bytes(&doc, None, bytes)?;
        let old = board_dir(&c.id, board_id, src_content.get("rev").map_or(0, as_int))?;
        let files = content::read_tree(&old)?;
        if let Some(Value::Object(cc)) = copy.get_mut("content") {
            cc.insert("rev".into(), json!(new_rev));
        }
        content::write_revision(&c.id, &new_board_id, new_rev, &files)?;
    }
    list_mut(&mut doc, "boards").push(Value::Object(copy.clone()));
    c.rev = (new_rev - 1) as i32;
    touch(&mut c, &doc);
    write_doc(&c.id, &doc)?;
    c = persist(session, &read, &c).await?;
    session.commit().await?;
    rows::reindex(session, &c).await?;
    let mut out = Map::new();
    out.insert("board".into(), Value::Object(copy));
    out.insert("rev".into(), json!(c.rev));
    Ok(out)
}

/// The pictures and fonts of a frame (everything the source editor does not show), kept when its text is saved.
pub async fn board_binary_files(session: &Session, canvas_id: &str, board_id: &str) -> Result<Files> {
    let c = get_row(session, canvas_id, false).await?;
    let doc = read_doc(&c.id)?;
    let board = &list(&doc, "boards")[board_of(&doc, board_id)?];
    let Some(content) = board.get("content").filter(|v| pyjson::truthy(v)) else { return Ok(Vec::new()) };
    let root = board_dir(&c.id, board_id, content.get("rev").map_or(0, as_int))?;
    let mut out = Vec::new();
    for f in content.get("files").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default() {
        let path = f.get("path").and_then(Value::as_str).unwrap_or("");
        let ext = kb_files::pathlib::suffix(path).to_lowercase();
        if TEXT_EXT.contains(&ext.as_str()) {
            continue;
        }
        let file = file_in(&root, path)?;
        if file.is_file() {
            out.push((path.to_string(), std::fs::read(file)?));
        }
    }
    Ok(out)
}

/// Save a copy: a second canvas of the same owner with the same frames, notes, arrows and labels. Comments and history
/// stay with the original.
pub async fn copy_canvas(session: &Session, canvas_id: &str, title: Option<&str>) -> Result<Map<String, Value>> {
    let src = get_row(session, canvas_id, false).await?;
    member_role(session, &src).await?;
    let mut doc = read_doc(&src.id)?;
    let actor = activity::current_actor();
    let mut row = canvas::new();
    row.project_id = Set(src.project_id.clone());
    row.owner_kind = Set(if src.owner_kind == "page" { "doc".to_string() } else { src.owner_kind.clone() });
    row.owner_id = Set(src.owner_id.clone());
    row.title = Set(sketches::title(title, &format!("{} copy", src.title)));
    row.created_by = Set(actor.clone());
    row.updated_by = Set(actor);
    let new_id = match &row.id {
        Set(id) => id.clone(),
        _ => unreachable!("canvas::new() sets the id"),
    };
    for (k, _) in save::KINDS {
        for item in list_mut(&mut doc, k) {
            if let Value::Object(m) = item {
                m.insert("rev".into(), json!(1));
            }
        }
    }
    for b in list_mut(&mut doc, "boards") {
        if let Value::Object(m) = b {
            // the copy is a person's, the team's mark stays on the original
            m.shift_remove("ai_saved_by");
            if let Some(Value::Object(content)) = m.get_mut("content").filter(|v| pyjson::truthy(v)) {
                content.insert("rev".into(), json!(1));
            }
        }
    }
    // copy each frame's current files as revision 1
    let src_doc = read_doc(&src.id)?;
    for (b, sb) in list(&doc, "boards").iter().zip(list(&src_doc, "boards")) {
        if let Some(content) = sb.get("content").filter(|v| pyjson::truthy(v)) {
            let sid = sb.get("id").and_then(Value::as_str).unwrap_or("");
            let root = board_dir(&src.id, sid, content.get("rev").map_or(0, as_int))?;
            let files = content::read_tree(&root)?;
            content::write_revision(&new_id, b.get("id").and_then(Value::as_str).unwrap_or(""), 1, &files)?;
        }
    }
    let (count, bytes) = rows::totals(&doc);
    row.board_count = Set(count);
    row.total_bytes = Set(bytes);
    write_doc(&new_id, &doc)?;
    // every frame's files (up to the canvas's size cap) and the overview are written before the row is inserted, so
    // the database's write lock is held for the insert only
    let mut c = row.insert(session).await?;
    session.commit().await?;
    versions::version(session, &mut c, "create", None, Some(&format!("Copy of {}", src.title)), None).await?;
    session.commit().await?;
    get_canvas(session, &c.id).await
}

/// A file of one revision of a frame: `(bytes, media type)`. Fails with 404 if the frame or file does not exist.
pub async fn read_board_file(
    session: &Session,
    canvas_id: &str,
    board_id: &str,
    rev: i64,
    path: &str,
) -> Result<(Vec<u8>, &'static str)> {
    let c = get_row(session, canvas_id, false).await?;
    let target = file_in(&board_dir(&c.id, board_id, rev)?, path)?;
    if !target.is_file() {
        return Err(DocsError::new(404, "file_not_found", "That file is not in the frame.").into());
    }
    let ext = kb_files::pathlib::suffix(&target.to_string_lossy()).to_lowercase();
    Ok((std::fs::read(&target)?, media_of(&ext)))
}

/// The text files of an HTML frame, for the source editor.
pub async fn board_source(session: &Session, canvas_id: &str, board_id: &str) -> Result<Map<String, Value>> {
    let c = get_row(session, canvas_id, false).await?;
    let doc = read_doc(&c.id)?;
    let board = &list(&doc, "boards")[board_of(&doc, board_id)?];
    let mut out = Map::new();
    out.insert("board_id".into(), json!(board_id));
    let Some(content) = board.get("content").filter(|v| pyjson::truthy(v)) else {
        out.insert("rev".into(), Value::Null);
        out.insert("entry".into(), json!("index.html"));
        out.insert("files".into(), json!([]));
        return Ok(out);
    };
    let rev = content.get("rev").map_or(0, as_int);
    let root = board_dir(&c.id, board_id, rev)?;
    let mut files = Vec::new();
    for f in content.get("files").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default() {
        let path = f.get("path").and_then(Value::as_str).unwrap_or("");
        if TEXT_EXT.contains(&kb_files::pathlib::suffix(path).to_lowercase().as_str()) {
            match std::fs::read(file_in(&root, path)?) {
                Ok(bytes) => files.push(json!({"path": path, "text": String::from_utf8_lossy(&bytes)})),
                Err(_) => continue,
            }
        }
    }
    out.insert("rev".into(), content.get("rev").cloned().unwrap_or(Value::Null));
    out.insert("entry".into(), content.get("entry").cloned().unwrap_or(Value::Null));
    out.insert("files".into(), Value::Array(files));
    Ok(out)
}

/// A PNG wireframe of an HTML or empty frame (what is drawn below 40% zoom).
pub async fn board_snapshot(session: &Session, canvas_id: &str, board_id: &str, rev: Option<i64>) -> Result<Vec<u8>> {
    let c = get_row(session, canvas_id, false).await?;
    let doc = read_doc(&c.id)?;
    let board = &list(&doc, "boards")[board_of(&doc, board_id)?];
    let content = board.get("content").filter(|v| pyjson::truthy(v));
    let mut html_text: Option<String> = None;
    if let (Some(content), Some("html")) = (content, board.get("kind").and_then(Value::as_str)) {
        let r = rev.unwrap_or_else(|| content.get("rev").map_or(0, as_int));
        let entry = content.get("entry").and_then(Value::as_str).unwrap_or("");
        let file = file_in(&board_dir(&c.id, board_id, r)?, entry)?;
        html_text = std::fs::read(file).ok().map(|b| String::from_utf8_lossy(&b).into_owned());
    }
    let int = |k: &str| board.get(k).map_or(0, as_int);
    Ok(canvas_png::board_snapshot(html_text.as_deref(), int("w"), int("h"), 360))
}

/// A PNG wireframe of one page tab (what an export writes where the canvas stood).
pub async fn overview_png(session: &Session, canvas_id: &str, page: Option<&str>) -> Result<Vec<u8>> {
    let c = get_row(session, canvas_id, false).await?;
    Ok(canvas_png::overview(&Value::Object(read_doc(&c.id)?), page, 1200))
}
