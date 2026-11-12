//! Sketches: paint-style drawings kept as a PNG plus an editable source (JSON with layers).
//!
//! A sketch sits in any markdown field as `![Name](sketch:sk_8f2a1c3d)`. Both files live in the uploads folder
//! (`uploads/sketches/<id>.png` and `<id>.sketch.json`), so a backup or export of the data folder carries them like
//! any attachment; the `sketch` table only holds the owner, the size and a version. Saving needs the version you
//! started from (`base_version`), so two people cannot silently overwrite each other. Deleting only *unlinks*: the
//! row and the files stay.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use base64::Engine;
use kb_base::{activity, pyjson, pytext, time};
use kb_db::Session;
use kb_db::entities::{docs_page, idea_ticket, member, project, sketch, ticket};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, IntoActiveModel, QueryFilter, QueryOrder};
use kb_doctext::docs_access;
use kb_doctext::docs_text::DocsError;
use kb_files::uploads;
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::util::{self, JsonError};
use crate::{Error, Result};

/// px, width and height.
pub const MAX_SIDE: i64 = 4096;
/// Per file: the PNG and the source each.
pub const MAX_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_LAYERS: usize = 10;
pub const MAX_TITLE: usize = 200;
pub const OWNER_KINDS: [&str; 4] = ["idea", "ticket", "doc", "comment"];
pub const SOURCE_FORMAT: &str = "kanban-sketch";
pub const SOURCE_VERSION: i64 = 1;

const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

fn sketch_ref() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\(sketch:(sk_[0-9a-f]{8})\)").expect("static pattern"))
}

/// Return the sketch ids a markdown text references, in order, without repeats.
pub fn refs_in(markdown: &str) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for m in sketch_ref().captures_iter(markdown) {
        let id = m[1].to_string();
        if !seen.contains(&id) {
            seen.push(id);
        }
    }
    seen
}

// --- files -----------------------------------------------------------------------

/// The folder both files of every sketch are kept in (inside the uploads folder).
pub fn sketches_dir() -> PathBuf {
    let path = uploads::get_uploads_dir(true).join("sketches");
    let _ = std::fs::create_dir_all(&path);
    path
}

/// Path of a sketch's PNG.
pub fn png_path(sketch_id: &str) -> PathBuf {
    sketches_dir().join(format!("{sketch_id}.png"))
}

/// Path of a sketch's editable source.
pub fn source_path(sketch_id: &str) -> PathBuf {
    sketches_dir().join(format!("{sketch_id}.sketch.json"))
}

type Staged = Vec<(PathBuf, PathBuf)>;

/// Write both files under temporary names; `publish` moves them in once the row is saved.
fn stage(sketch_id: &str, png: &[u8], source: &[u8]) -> std::io::Result<Staged> {
    let mut staged = Vec::new();
    for (final_path, content) in [(png_path(sketch_id), png), (source_path(sketch_id), source)] {
        let mut name = final_path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
        name.push(".tmp");
        let tmp = final_path.with_file_name(name);
        std::fs::write(&tmp, content)?;
        staged.push((tmp, final_path));
    }
    Ok(staged)
}

fn publish(staged: &Staged) -> std::io::Result<()> {
    for (tmp, final_path) in staged {
        std::fs::rename(tmp, final_path)?;
    }
    Ok(())
}

fn discard(staged: &Staged) {
    for (tmp, _) in staged {
        let _ = std::fs::remove_file(tmp);
    }
}

// --- validation ------------------------------------------------------------------

/// `_too_large(what, size, **extra)`.
fn too_large(what: &str, size: Option<usize>, extra: &[(&str, i64)]) -> DocsError {
    let mut err = DocsError::new(
        413,
        "sketch_too_large",
        format!(
            "This drawing is too large to save. The limit is {MAX_SIDE} \u{d7} {MAX_SIDE} px and {} MB. Crop it or \
             shrink the canvas.",
            MAX_BYTES / (1024 * 1024)
        ),
    )
    .with("part", what)
    .with("size_bytes", size.map_or(Value::Null, |s| json!(s)))
    .with("limit_bytes", MAX_BYTES as u64)
    .with("limit_px", MAX_SIDE);
    for (k, v) in extra {
        err = err.with(k, *v);
    }
    err
}

/// Width and height of a PNG read from its header, without decoding it.
///
/// Fails with 413 if the file is over the size limit and 422 if it is not a PNG.
pub fn png_size(png: &[u8]) -> std::result::Result<(u32, u32), DocsError> {
    if png.len() > MAX_BYTES {
        return Err(too_large("png", Some(png.len()), &[]));
    }
    if png.len() < 33 || !png.starts_with(PNG_SIGNATURE) || &png[12..16] != b"IHDR" {
        return Err(DocsError::new(422, "invalid_sketch", "The picture is not a PNG image."));
    }
    let width = u32::from_be_bytes([png[16], png[17], png[18], png[19]]);
    let height = u32::from_be_bytes([png[20], png[21], png[22], png[23]]);
    Ok((width, height))
}

/// `{width, height, layer_count}` of a drawing that passed `validate`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Info {
    /// Width in px.
    pub width: u32,
    /// Height in px.
    pub height: u32,
    /// How many layers the source has.
    pub layer_count: usize,
}

fn invalid(message: impl Into<String>) -> DocsError {
    DocsError::new(422, "invalid_sketch", message)
}

/// Check a PNG and its source belong together and are within the limits.
///
/// `source` is the editable source, a JSON document (see docs/specs/sketch-tool.md). Fails with 413 if a file is too
/// large or the canvas is over 4096 px, and with 422 if the source is malformed, has more than 10 layers, or does
/// not match the PNG.
pub fn validate(png: &[u8], source: &[u8]) -> Result<Info> {
    let (width, height) = png_size(png)?;
    if source.len() > MAX_BYTES {
        return Err(too_large("source", Some(source.len()), &[]).into());
    }
    if i64::from(width) > MAX_SIDE || i64::from(height) > MAX_SIDE {
        return Err(too_large("canvas", None, &[("width", i64::from(width)), ("height", i64::from(height))]).into());
    }
    if width < 1 || height < 1 {
        return Err(invalid("The picture is empty.").into());
    }
    if let Some(message) = util::utf8_error_message(source) {
        return Err(invalid(format!("The editable source is not valid JSON ({message}).")).into());
    }
    let text = String::from_utf8_lossy(source);
    let doc = match util::json_loads(&text) {
        Ok(doc) => doc,
        Err(JsonError::Decode(message)) => {
            return Err(invalid(format!("The editable source is not valid JSON ({message}).")).into());
        }
        Err(JsonError::Recursion(message)) => return Err(Error::Value(message)),
    };
    let layers = doc.get("layers").and_then(Value::as_array);
    let is_sketch =
        doc.is_object() && doc.get("format").and_then(Value::as_str) == Some(SOURCE_FORMAT) && layers.is_some();
    let Some(layers) = layers.filter(|_| is_sketch) else {
        return Err(invalid("This is not a sketch source (wrong format).").into());
    };
    if !util::json_equals_int(doc.get("version"), SOURCE_VERSION) {
        let shown = doc.get("version").map_or("None".to_string(), util::py_repr);
        return Err(invalid(format!("Unsupported sketch source version {shown}.")).into());
    }
    if layers.is_empty() || layers.len() > MAX_LAYERS {
        return Err(DocsError::new(
            422,
            "too_many_layers",
            format!("A drawing has 1 to {MAX_LAYERS} layers (this one has {}). Merge some layers.", layers.len()),
        )
        .with("layer_count", layers.len() as u64)
        .with("limit_layers", MAX_LAYERS as u64)
        .into());
    }
    if !util::json_equals_int(doc.get("width"), i64::from(width))
        || !util::json_equals_int(doc.get("height"), i64::from(height))
    {
        return Err(invalid("The size in the source does not match the picture.").into());
    }
    Ok(Info { width, height, layer_count: layers.len() })
}

/// `_title(title, fallback)`: a name without brackets or line breaks, at most 200 characters.
pub fn title(title: Option<&str>, fallback: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"[\[\]\n\r]+").expect("static pattern"));
    let text = re.replace_all(title.unwrap_or(""), " ");
    let text = util::strip_cut(&text, MAX_TITLE);
    if text.is_empty() { fallback.to_string() } else { text }
}

// --- permissions and owners ------------------------------------------------------

/// The project a drawing belongs to: the one given, else the owner's own (None for a free idea).
pub async fn project_of(
    session: &Session,
    owner_kind: &str,
    owner_id: &str,
    hint: Option<&str>,
) -> Result<Option<String>> {
    if let Some(hint) = hint.filter(|h| !h.is_empty()) {
        if project::Entity::find_by_id(hint).one(session).await?.is_none() {
            return Err(DocsError::new(404, "project_not_found", "Project not found").into());
        }
        return Ok(Some(hint.to_string()));
    }
    // a comment belongs to the ticket or page it is written on
    let order: [&str; 3] = match owner_kind {
        "ticket" | "comment" => ["ticket", "doc", "idea"],
        "doc" => ["doc", "ticket", "idea"],
        _ => ["idea", "ticket", "doc"],
    };
    for model in order {
        let found: Option<Option<String>> = match model {
            "ticket" => ticket::Entity::find_by_id(owner_id).one(session).await?.map(|r| Some(r.project_id)),
            "doc" => docs_page::Entity::find_by_id(owner_id).one(session).await?.map(|r| Some(r.project_id)),
            _ => idea_ticket::Entity::find_by_id(owner_id).one(session).await?.map(|r| r.project_id),
        };
        if let Some(project_id) = found {
            return Ok(project_id);
        }
    }
    Ok(None)
}

/// The caller's role for a drawing: viewer, member or admin.
///
/// A drawing of an idea that belongs to no project uses the caller's best role in any project.
pub async fn role_of(session: &Session, project_id: Option<&str>) -> Result<String> {
    let actor = activity::current_actor();
    if let Some(project_id) = project_id {
        return Ok(docs_access::role_in(&docs_access::members_of(session, project_id).await?, &actor));
    }
    if actor == activity::HUMAN_ACTOR {
        return Ok("admin".into());
    }
    if actor == activity::AGENT_ACTOR {
        return Ok("member".into());
    }
    let wanted = caseless::default_case_fold_str(&actor);
    let roles: Vec<String> = member::Entity::find()
        .all(session)
        .await?
        .into_iter()
        .filter(|m| caseless::default_case_fold_str(&m.name) == wanted && docs_access::ROLES.contains(&m.role.as_str()))
        .map(|m| m.role)
        .collect();
    for best in ["admin", "member"] {
        if roles.iter().any(|r| r == best) {
            return Ok(best.to_string());
        }
    }
    Ok("viewer".into())
}

/// `_need_member`: viewers cannot edit.
pub fn need_member(role: &str) -> std::result::Result<(), DocsError> {
    if role == "viewer" {
        return Err(DocsError::new(
            403,
            "read_only",
            "Viewers can look at drawings and open them large but cannot edit them.",
        ));
    }
    Ok(())
}

fn is_live(deleted_at: &Option<String>) -> bool {
    deleted_at.as_deref().is_none_or(str::is_empty)
}

/// `_sketch(session, sketch_id, deleted_ok=...)`.
pub async fn get_row(session: &Session, sketch_id: &str, deleted_ok: bool) -> Result<sketch::Model> {
    match sketch::Entity::find_by_id(sketch_id).one(session).await? {
        Some(s) if deleted_ok || is_live(&s.deleted_at) => Ok(s),
        _ => {
            Err(DocsError::new(404, "sketch_not_found", "Sketch not found. It was deleted, or you do not have access.")
                .into())
        }
    }
}

/// The sketch as the API returns it (no file bodies).
pub async fn out(session: &Session, s: &sketch::Model) -> Result<Map<String, Value>> {
    let role = role_of(session, s.project_id.as_deref()).await?;
    let mut out = Map::new();
    out.insert("id".into(), json!(s.id));
    out.insert("project_id".into(), json!(s.project_id));
    out.insert("owner_kind".into(), json!(s.owner_kind));
    out.insert("owner_id".into(), json!(s.owner_id));
    out.insert("title".into(), json!(s.title));
    out.insert("width".into(), json!(s.width));
    out.insert("height".into(), json!(s.height));
    out.insert("layer_count".into(), json!(s.layer_count));
    out.insert("version".into(), json!(s.version));
    out.insert("png_bytes".into(), json!(s.png_bytes));
    out.insert("source_bytes".into(), json!(s.source_bytes));
    out.insert("png_url".into(), json!(format!("/uploads/sketches/{}.png", s.id)));
    out.insert("source_url".into(), json!(format!("/uploads/sketches/{}.sketch.json", s.id)));
    out.insert("created_by".into(), json!(s.created_by));
    out.insert("created_at".into(), json!(s.created_at));
    out.insert("updated_by".into(), json!(s.updated_by));
    out.insert("updated_at".into(), json!(s.updated_at));
    out.insert("deleted_at".into(), json!(s.deleted_at));
    out.insert("role".into(), json!(role));
    out.insert("can_edit".into(), json!(role != "viewer" && is_live(&s.deleted_at)));
    Ok(out)
}

// --- create, read, update, copy, delete ----------------------------------------------

/// Save a new sketch (version 1).
///
/// `owner_kind` is `idea`, `ticket`, `doc` or `comment`; `owner_id` the id of the page, ticket or idea that holds it
/// (for a comment, of the ticket or page); `title` the name (it becomes the alt text); `png` the flattened picture;
/// `source` the editable source; `project_id` the project, when the owner does not say (a comment still being
/// written). Fails with 403 for viewers and 413 / 422 for a bad file.
pub async fn create_sketch(
    session: &Session,
    owner_kind: &str,
    owner_id: &str,
    title_text: Option<&str>,
    png: &[u8],
    source: &[u8],
    project_id: Option<&str>,
) -> Result<Map<String, Value>> {
    if !OWNER_KINDS.contains(&owner_kind) {
        return Err(DocsError::new(
            422,
            "invalid_owner",
            "owner_kind must be one of ('idea', 'ticket', 'doc', 'comment')",
        )
        .into());
    }
    if pytext::strip(owner_id).is_empty() {
        return Err(DocsError::new(422, "invalid_owner", "owner_id is required").into());
    }
    let project = project_of(session, owner_kind, owner_id, project_id).await?;
    need_member(&role_of(session, project.as_deref()).await?)?;
    let info = validate(png, source)?;
    let actor = activity::current_actor();
    let mut row = sketch::new();
    row.project_id = Set(project);
    row.owner_kind = Set(owner_kind.to_string());
    row.owner_id = Set(owner_id.to_string());
    row.title = Set(title(title_text, "Sketch"));
    row.width = Set(info.width as i32);
    row.height = Set(info.height as i32);
    row.layer_count = Set(info.layer_count as i32);
    row.png_bytes = Set(png.len() as i32);
    row.source_bytes = Set(source.len() as i32);
    row.created_by = Set(actor.clone());
    row.updated_by = Set(actor);
    let id = match &row.id {
        Set(id) => id.clone(),
        _ => time::prefixed_id("sk_", 8),
    };
    // Both files (up to 10 MB each) are staged before the row is inserted, so the database's write lock is held for
    // the insert only; the id is made before
    let staged = stage(&id, png, source)?;
    let saved = async {
        let s = row.insert(session).await?;
        session.commit().await?;
        Ok::<_, kb_db::sea_orm::DbErr>(s)
    }
    .await;
    let s = match saved {
        Ok(s) => s,
        Err(e) => {
            discard(&staged);
            return Err(e.into());
        }
    };
    publish(&staged)?;
    out(session, &s).await
}

/// Read a sketch's details.
pub async fn get_sketch(session: &Session, sketch_id: &str) -> Result<Map<String, Value>> {
    let s = get_row(session, sketch_id, false).await?;
    out(session, &s).await
}

/// Return `(content, media_type, file_name, sketch)` of a sketch's `png` or editable `source`.
pub async fn read_file(
    session: &Session,
    sketch_id: &str,
    kind: &str,
) -> Result<(Vec<u8>, &'static str, String, sketch::Model)> {
    let s = get_row(session, sketch_id, false).await?;
    let stem = util::file_stem(&s.title);
    let stem = if stem.is_empty() { "sketch".to_string() } else { stem };
    let path = if kind == "png" { png_path(&s.id) } else { source_path(&s.id) };
    let content = std::fs::read(&path).map_err(|_| {
        DocsError::new(404, "sketch_file_missing", "The drawing's file is missing from the data folder.")
    })?;
    if kind == "png" {
        return Ok((content, "image/png", format!("{stem}.png"), s));
    }
    Ok((content, "application/json", format!("{stem}.sketch.json"), s))
}

/// Save a new version of a sketch.
///
/// `base_version` is the version the edit started from; it must be the latest unless `force` ("Replace theirs").
/// Fails with 403 for viewers and 409 `sketch_conflict` if someone saved a newer version.
pub async fn update_sketch(
    session: &Session,
    sketch_id: &str,
    base_version: i32,
    png: &[u8],
    source: &[u8],
    title_text: Option<&str>,
    force: bool,
) -> Result<Map<String, Value>> {
    let s = get_row(session, sketch_id, false).await?;
    need_member(&role_of(session, s.project_id.as_deref()).await?)?;
    if base_version != s.version && !force {
        return Err(DocsError::new(
            409,
            "sketch_conflict",
            format!("{} saved this drawing while you were drawing.", s.updated_by),
        )
        .with("latest_version", s.version)
        .with("latest_author", s.updated_by.clone())
        .with("latest_at", s.updated_at.clone())
        .into());
    }
    let info = validate(png, source)?;
    let id = s.id.clone();
    let new_title = title_text.map(|t| title(Some(t), &s.title));
    let new_version = s.version + 1;
    let mut row = kb_db::edit(s);
    row.version = Set(new_version);
    row.updated_by = Set(activity::current_actor());
    row.updated_at = Set(time::now_iso());
    row.width = Set(info.width as i32);
    row.height = Set(info.height as i32);
    row.layer_count = Set(info.layer_count as i32);
    row.png_bytes = Set(png.len() as i32);
    row.source_bytes = Set(source.len() as i32);
    if let Some(t) = new_title {
        row.title = Set(t);
    }
    let staged = stage(&id, png, source)?;
    let saved = async {
        let s = row.update(session).await?;
        session.commit().await?;
        Ok::<_, kb_db::sea_orm::DbErr>(s)
    }
    .await;
    let s = match saved {
        Ok(s) => s,
        Err(e) => {
            discard(&staged);
            return Err(e.into());
        }
    };
    publish(&staged)?;
    out(session, &s).await
}

/// Make a second sketch next to the first and leave the first alone.
///
/// `png` and `source` are the copy's picture and source (the unsaved state of the editor); the original's when
/// omitted. `title` is the name of the copy, `<name> copy` by default. Returns the new sketch (new id, version 1,
/// same owner).
pub async fn copy_sketch(
    session: &Session,
    sketch_id: &str,
    png: Option<Vec<u8>>,
    source: Option<Vec<u8>>,
    title_text: Option<&str>,
) -> Result<Map<String, Value>> {
    let s = get_row(session, sketch_id, false).await?;
    need_member(&role_of(session, s.project_id.as_deref()).await?)?;
    let (png, source) = match (png, source) {
        (Some(png), Some(source)) => (png, source),
        _ => (read_file(session, sketch_id, "png").await?.0, read_file(session, sketch_id, "source").await?.0),
    };
    create_sketch(
        session,
        &s.owner_kind,
        &s.owner_id,
        Some(&title(title_text, &format!("{} copy", s.title))),
        &png,
        &source,
        s.project_id.as_deref(),
    )
    .await
}

/// Unlink a sketch: it stops resolving but its row and files are kept.
pub async fn delete_sketch(session: &Session, sketch_id: &str) -> Result<Map<String, Value>> {
    let s = get_row(session, sketch_id, false).await?;
    need_member(&role_of(session, s.project_id.as_deref()).await?)?;
    let mut row = kb_db::edit(s);
    row.deleted_at = Set(Some(time::now_iso()));
    row.deleted_by = Set(Some(activity::current_actor()));
    let s = row.update(session).await?;
    session.commit().await?;
    let mut out = Map::new();
    out.insert("id".into(), json!(s.id));
    out.insert("deleted_at".into(), json!(s.deleted_at));
    Ok(out)
}

/// Bring an unlinked sketch back.
pub async fn restore_sketch(session: &Session, sketch_id: &str) -> Result<Map<String, Value>> {
    let s = get_row(session, sketch_id, true).await?;
    need_member(&role_of(session, s.project_id.as_deref()).await?)?;
    let mut row = kb_db::edit(s);
    row.deleted_at = Set(None);
    row.deleted_by = Set(None);
    let s = row.update(session).await?;
    session.commit().await?;
    out(session, &s).await
}

/// List the sketches of one page, ticket, idea or comment's ticket, newest change first.
pub async fn list_sketches(session: &Session, owner_kind: &str, owner_id: &str) -> Result<Vec<Map<String, Value>>> {
    let rows = sketch::Entity::find()
        .filter(sketch::Column::OwnerKind.eq(owner_kind))
        .filter(sketch::Column::OwnerId.eq(owner_id))
        .filter(sketch::Column::DeletedAt.is_null())
        .order_by_desc(sketch::Column::UpdatedAt)
        .all(session)
        .await?;
    let mut list = Vec::new();
    for s in rows {
        list.push(out(session, &s).await?);
    }
    Ok(list)
}

// --- files for an agent (MCP: docs_read sketch(es), docs_write sketch_create / sketch_save) --------------------

fn file_error(message: impl Into<String>) -> DocsError {
    DocsError::new(422, "invalid_file", message)
}

/// Read a local file the agent named: an absolute path to a regular file of at most 10 MB.
pub fn read_local(path: &str, what: &str) -> std::result::Result<Vec<u8>, DocsError> {
    if !kb_files::pathlib::is_absolute(path) {
        return Err(file_error(format!("Give an absolute path for the {what} (got {}).", pytext::repr(path))));
    }
    let p = Path::new(path);
    if !p.is_file() {
        return Err(file_error(format!("The {what} is not a file: {path}.")));
    }
    let size = match p.metadata() {
        Ok(m) => m.len() as usize,
        Err(e) => return Err(file_error(format!("The {what} could not be read ({}).", util::strerror(&e)))),
    };
    if size > MAX_BYTES {
        return Err(too_large(what, Some(size), &[]));
    }
    std::fs::read(p).map_err(|e| file_error(format!("The {what} could not be read ({}).", util::strerror(&e))))
}

/// A source for a picture that came without one: the white page, the picture on a locked layer of its own and an
/// empty "Marks" layer above it, chosen. Used when an agent saves only a PNG (a screenshot for a person to mark on,
/// issue #267): the person's marks go above the picture and never change it, as with "Draw on it" in the editor.
pub fn flat_source(png: &[u8]) -> std::result::Result<Vec<u8>, DocsError> {
    let (width, height) = png_size(png)?;
    let doc = json!({
        "format": SOURCE_FORMAT,
        "version": SOURCE_VERSION,
        "width": width,
        "height": height,
        "background": "white",
        "activeLayer": "l3",
        "layers": [
            {"id": "l1", "name": "Background", "kind": "paper", "visible": true, "opacity": 1, "locked": true,
             "png": null, "texts": []},
            {"id": "l2", "name": "Picture", "kind": "picture", "visible": true, "opacity": 1, "locked": true,
             "png": format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)),
             "texts": []},
            {"id": "l3", "name": "Marks", "kind": "layer", "visible": true, "opacity": 1, "locked": false,
             "png": null, "texts": []},
        ],
    });
    Ok(pyjson::dumps(&doc).into_bytes())
}

/// A project's sketches in brief, newest change first: `[{id, title, owner_kind, owner_id, version, width, height,
/// layers, updated_by, updated_at, markdown}]`.
pub async fn list_for_agent(session: &Session, project_id: &str) -> Result<Vec<Value>> {
    let rows = sketch::Entity::find()
        .filter(sketch::Column::ProjectId.eq(project_id))
        .filter(sketch::Column::DeletedAt.is_null())
        .order_by_desc(sketch::Column::UpdatedAt)
        .all(session)
        .await?;
    Ok(rows
        .into_iter()
        .map(|s| {
            json!({
                "id": s.id, "title": s.title, "owner_kind": s.owner_kind, "owner_id": s.owner_id,
                "version": s.version, "width": s.width, "height": s.height, "layers": s.layer_count,
                "updated_by": s.updated_by, "updated_at": s.updated_at,
                "markdown": format!("![{}](sketch:{})", s.title, s.id),
            })
        })
        .collect())
}

/// Write a sketch's PNG and its editable source to local paths.
///
/// `path` is a folder (or a path ending in `/`): `<name>.png` and `<name>.sketch.json` are written inside it. A path
/// ending in `.png` names the picture; the source goes next to it as `<same name>.sketch.json`.
///
/// Returns `{png_path, source_path, id, title, version, width, height, layers, markdown}`; send `version` back as
/// `base_version` when saving.
pub async fn export_to_files(session: &Session, sketch_id: &str, path: &str) -> Result<Map<String, Value>> {
    let s = get_row(session, sketch_id, false).await?;
    if !kb_files::pathlib::is_absolute(path) {
        return Err(file_error(format!("Give an absolute path (got {}).", pytext::repr(path))).into());
    }
    let target = util::path_str(path);
    let png_target = if Path::new(&target).is_dir()
        || path.ends_with('/')
        || path.ends_with('\\')
        || kb_files::pathlib::suffix(path).to_lowercase() != ".png"
    {
        let stem = util::file_stem(&s.title);
        let stem = if stem.is_empty() { "sketch".to_string() } else { stem };
        util::path_str(&format!("{target}/{stem}.png"))
    } else {
        target
    };
    let png_dir = png_target.rsplit_once('/').map_or("", |(d, _)| d);
    let png_dir = if png_dir.is_empty() { "/" } else { png_dir };
    let source_target = util::path_str(&format!("{png_dir}/{}.sketch.json", kb_files::pathlib::stem(&png_target)));
    let (png_file, source_file) = (png_path(&s.id), source_path(&s.id));
    let missing = || DocsError::new(404, "sketch_file_missing", "The drawing's file is missing from the data folder.");
    if !png_file.exists() || !source_file.exists() {
        return Err(missing().into());
    }
    let png = std::fs::read(&png_file)?;
    let src = std::fs::read(&source_file)?;
    let written = (|| -> std::io::Result<()> {
        std::fs::create_dir_all(png_dir)?;
        std::fs::write(&png_target, &png)?;
        std::fs::write(&source_target, &src)
    })();
    if let Err(e) = written {
        return Err(file_error(format!("{png_dir} could not be written ({}).", util::strerror(&e))).into());
    }
    let mut out = Map::new();
    out.insert("png_path".into(), json!(png_target));
    out.insert("source_path".into(), json!(source_target));
    out.insert("id".into(), json!(s.id));
    out.insert("title".into(), json!(s.title));
    out.insert("version".into(), json!(s.version));
    out.insert("width".into(), json!(s.width));
    out.insert("height".into(), json!(s.height));
    out.insert("layers".into(), json!(s.layer_count));
    out.insert("markdown".into(), json!(format!("![{}](sketch:{})", s.title, s.id)));
    Ok(out)
}

/// Create a sketch from a local PNG and (optionally) its `.sketch.json` source. Without a source the picture becomes
/// one picture layer on a white page. The owner (a ticket or a Docs page) must exist.
pub async fn create_from_files(
    session: &Session,
    owner_kind: &str,
    owner_id: &str,
    title_text: &str,
    path: &str,
    source_path: Option<&str>,
) -> Result<Map<String, Value>> {
    if owner_kind != "ticket" && owner_kind != "doc" {
        return Err(DocsError::new(422, "invalid_owner", "owner_kind must be 'ticket' or 'doc'.").into());
    }
    if project_of(session, owner_kind, owner_id, None).await?.is_none() {
        let what = if owner_kind == "ticket" { "ticket" } else { "Docs page" };
        return Err(
            DocsError::new(404, "owner_not_found", format!("No {what} with id {}.", pytext::repr(owner_id))).into()
        );
    }
    let png = read_local(path, "picture")?;
    let source = match source_path.filter(|p| !p.is_empty()) {
        Some(p) => read_local(p, "source")?,
        None => flat_source(&png)?,
    };
    create_sketch(session, owner_kind, owner_id, Some(title_text), &png, &source, None).await
}

/// Save a local PNG (and its `.sketch.json`) as a new version of a sketch; a stale `base_version` is refused
/// (409 `sketch_conflict`) before the files are read. Without a source the picture becomes one picture layer.
pub async fn save_from_files(
    session: &Session,
    sketch_id: &str,
    path: &str,
    base_version: i32,
    source_path: Option<&str>,
    title_text: Option<&str>,
) -> Result<Map<String, Value>> {
    let s = get_row(session, sketch_id, false).await?;
    if base_version != s.version {
        return update_sketch(session, sketch_id, base_version, b"", b"", None, false).await;
    }
    let png = read_local(path, "picture")?;
    let source = match source_path.filter(|p| !p.is_empty()) {
        Some(p) => read_local(p, "source")?,
        None => flat_source(&png)?,
    };
    update_sketch(session, sketch_id, base_version, &png, &source, title_text, false).await
}
