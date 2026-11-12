//! `services/canvases.py` lines 380-657: permissions, the canvas row, create, read, list, delete and restore.

use kb_base::activity;
use kb_db::Session;
use kb_db::entities::{canvas, canvas_thread};
use kb_db::sea_orm::ActiveValue::{Set, Unchanged};
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder};
use kb_doctext::docs_text::DocsError;
use serde_json::{Map, Value, json};

use super::*;
use crate::{Result, hooks, sketches};

/// How the first board's size is given: a preset name or the width and height.
#[derive(Debug, Clone)]
pub enum Size {
    /// `desktop`, `laptop`, `wide`, `tablet` or `phone`.
    Preset(String),
    /// `(width, height)`.
    Dims(i64, i64),
}

impl Size {
    /// `SIZE_PRESETS[size] if isinstance(size, str) else size` (an unknown name is a `KeyError`: a 500).
    pub fn resolve(&self) -> Result<(i64, i64)> {
        match self {
            Size::Preset(name) => size_preset(name).ok_or_else(|| crate::Error::Value(format!("KeyError: '{name}'"))),
            Size::Dims(w, h) => Ok((*w, *h)),
        }
    }
}

/// `_need_member(role)`: viewers cannot edit.
pub fn need_member(role: &str) -> std::result::Result<(), DocsError> {
    if role == "viewer" {
        return Err(DocsError::new(
            403,
            "read_only",
            "Viewers can look at a canvas, open it large, present it and read comments, but cannot edit it.",
        ));
    }
    Ok(())
}

fn is_live(deleted_at: &Option<String>) -> bool {
    deleted_at.as_deref().is_none_or(str::is_empty)
}

/// `_canvas(session, canvas_id, deleted_ok=...)`: the row. Fails with 404 for one that is not there (or deleted).
pub async fn get_row(session: &Session, canvas_id: &str, deleted_ok: bool) -> Result<canvas::Model> {
    match canvas::Entity::find_by_id(canvas_id).one(session).await? {
        Some(c) if deleted_ok || is_live(&c.deleted_at) => Ok(c),
        _ => {
            Err(DocsError::new(404, "canvas_not_found", "Canvas not found. It was deleted, or you do not have access.")
                .into())
        }
    }
}

/// An `ActiveModel` that writes every column of the row (`session.add(c)` after the attributes were changed).
pub fn active(c: &canvas::Model) -> canvas::ActiveModel {
    canvas::ActiveModel {
        id: Unchanged(c.id.clone()),
        project_id: Set(c.project_id.clone()),
        owner_kind: Set(c.owner_kind.clone()),
        owner_id: Set(c.owner_id.clone()),
        page_id: Set(c.page_id.clone()),
        title: Set(c.title.clone()),
        rev: Set(c.rev),
        version: Set(c.version),
        board_count: Set(c.board_count),
        total_bytes: Set(c.total_bytes),
        created_by: Set(c.created_by.clone()),
        created_at: Set(c.created_at.clone()),
        updated_by: Set(c.updated_by.clone()),
        updated_at: Set(c.updated_at.clone()),
        deleted_at: Set(c.deleted_at.clone()),
        deleted_by: Set(c.deleted_by.clone()),
    }
}

/// `session.add(c)`: write the row (the caller commits).
pub async fn persist(session: &Session, c: &canvas::Model) -> Result<canvas::Model> {
    Ok(active(c).update(session).await?)
}

/// `_owner_for_project(kind)`.
fn owner_for_project(kind: &str) -> &str {
    if kind == "page" { "doc" } else { kind }
}

/// The caller's role for a canvas: viewer, member or admin (the owner's access).
pub async fn role_for(session: &Session, c: &canvas::Model) -> Result<String> {
    sketches::role_of(session, c.project_id.as_deref()).await
}

/// Like `role_for` but fails for viewers.
pub async fn member_role(session: &Session, c: &canvas::Model) -> Result<String> {
    let role = role_for(session, c).await?;
    need_member(&role)?;
    if let Some(page_id) = c.page_id.as_deref().filter(|p| !p.is_empty()) {
        // a canvas that is a Docs page follows the space's edit policy
        if let Some(docs) = hooks::canvas_docs() {
            docs.check_page_edit(session, page_id).await?;
        }
    }
    Ok(role)
}

/// The canvas record as the API returns it (no file bodies).
pub fn summary(c: &canvas::Model, role: &str) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("id".into(), json!(c.id));
    out.insert("project_id".into(), json!(c.project_id));
    out.insert("owner_kind".into(), json!(c.owner_kind));
    out.insert("owner_id".into(), json!(c.owner_id));
    out.insert("page_id".into(), json!(c.page_id));
    out.insert("title".into(), json!(c.title));
    out.insert("rev".into(), json!(c.rev));
    out.insert("version".into(), json!(c.version));
    out.insert("board_count".into(), json!(c.board_count));
    out.insert("total_bytes".into(), json!(c.total_bytes));
    out.insert("created_by".into(), json!(c.created_by));
    out.insert("created_at".into(), json!(c.created_at));
    out.insert("updated_by".into(), json!(c.updated_by));
    out.insert("updated_at".into(), json!(c.updated_at));
    out.insert("deleted_at".into(), json!(c.deleted_at));
    out.insert("role".into(), json!(role));
    out.insert("can_edit".into(), json!(role != "viewer" && is_live(&c.deleted_at)));
    out.insert("markdown".into(), json!(embed_line(&c.id, &c.title, None)));
    out.insert("limits".into(), limits());
    out
}

/// The numbers the editor needs to explain a refusal.
pub fn limits() -> Value {
    json!({
        "boards": MAX_BOARDS,
        "board_bytes": MAX_BOARD_BYTES,
        "canvas_bytes": MAX_CANVAS_BYTES,
        "pages": MAX_PAGES,
        "lock_idle_seconds": canvas_locks::IDLE_SECONDS,
        "min_width": MIN_W,
        "max_width": MAX_W,
    })
}

use crate::canvas_locks;

/// `_totals(doc)`: the number of boards and the bytes of their content.
pub fn totals(doc: &Doc) -> (i32, i32) {
    let boards = list(doc, "boards");
    let bytes: i64 = boards.iter().map(|b| b.get("content").and_then(|c| c.get("bytes")).map_or(0, as_int)).sum();
    (boards.len() as i32, bytes as i32)
}

/// A canvas that is a Docs page has its boards as sections: keep the page index in step.
pub async fn reindex(session: &Session, c: &canvas::Model) -> Result<()> {
    let Some(page_id) = c.page_id.as_deref().filter(|p| !p.is_empty()) else { return Ok(()) };
    let Some(docs) = hooks::canvas_docs() else { return Ok(()) };
    let done = async {
        docs.reindex(session, &[page_id.to_string()]).await?;
        session.commit().await?;
        Ok::<(), crate::Error>(())
    }
    .await;
    if done.is_err() {
        // the index is a convenience; the canvas is saved
        let _ = session.rollback().await;
    }
    Ok(())
}

/// `_touch(c, doc)`: bump the revision and the counters after the file changed.
pub fn touch(c: &mut canvas::Model, doc: &Doc) {
    c.rev += 1;
    (c.board_count, c.total_bytes) = totals(doc);
    c.updated_by = activity::current_actor();
    c.updated_at = now();
}

// --- create, read, list, delete ---------------------------------------------------------------------------------

/// What `create_canvas` is told.
#[derive(Debug, Clone)]
pub struct NewCanvas<'a> {
    /// `idea`, `ticket`, `doc`, `comment` or `page` (a canvas that is its own Docs page).
    pub owner_kind: &'a str,
    /// Id of the ticket, page or idea that holds it.
    pub owner_id: &'a str,
    /// Name; becomes the alt text.
    pub title: Option<&'a str>,
    /// Project, when the owner does not say (a comment still being written).
    pub project_id: Option<&'a str>,
    /// The Docs page of a canvas that lives in Docs.
    pub page_id: Option<&'a str>,
    /// `blank` (one empty board) or `none` (no board; boards come from files).
    pub start: &'a str,
    /// Size of the first board.
    pub size: Size,
}

impl Default for NewCanvas<'_> {
    fn default() -> Self {
        Self {
            owner_kind: "doc",
            owner_id: "",
            title: None,
            project_id: None,
            page_id: None,
            start: "blank",
            size: Size::Preset("desktop".into()),
        }
    }
}

/// Create a canvas, with its first (empty) board when `start` is `blank`. Fails with 403 for viewers and 422 for a bad
/// owner.
pub async fn create_canvas(session: &Session, new: NewCanvas<'_>) -> Result<Map<String, Value>> {
    if !OWNER_KINDS.contains(&new.owner_kind) {
        return Err(DocsError::new(
            422,
            "invalid_owner",
            "owner_kind must be one of ('idea', 'ticket', 'doc', 'comment', 'page')",
        )
        .into());
    }
    if kb_base::pytext::strip(new.owner_id).is_empty() {
        return Err(DocsError::new(422, "invalid_owner", "owner_id is required").into());
    }
    let project =
        sketches::project_of(session, owner_for_project(new.owner_kind), new.owner_id, new.project_id).await?;
    need_member(&sketches::role_of(session, project.as_deref()).await?)?;
    let actor = activity::current_actor();
    let name = canvas_name(new.title, "Canvas");
    let mut row = canvas::new();
    row.project_id = Set(project);
    row.owner_kind = Set(new.owner_kind.to_string());
    row.owner_id = Set(new.owner_id.to_string());
    row.page_id = Set(new.page_id.map(str::to_string));
    row.title = Set(name);
    row.created_by = Set(actor.clone());
    row.updated_by = Set(actor.clone());
    let id = match &row.id {
        Set(id) => id.clone(),
        _ => unreachable!("canvas::new() sets the id"),
    };
    let mut doc = blank_doc();
    let first_page = list(&doc, "pages")[0]["id"].clone();
    if new.start == "blank" {
        let (w, h) = new.size.resolve()?;
        list_mut(&mut doc, "boards").push(json!({
            "id": new_id("b"), "page": first_page, "name": "Frame 1", "kind": "empty",
            "x": 0, "y": 0, "w": w, "h": h, "order": 0, "ref": null, "content": null,
            "rev": 1, "created_by": actor,
        }));
    }
    let (count, bytes) = totals(&doc);
    row.board_count = Set(count);
    row.total_bytes = Set(bytes);
    // The file (and its overview picture) first: the row's insert takes the database's write lock until the commit,
    // and other writers wait meanwhile. The id is made before, so it is known already.
    write_doc(&id, &doc)?;
    let mut c = row.insert(session).await?;
    session.commit().await?;
    versions::version(session, &mut c, "create", None, Some("Created"), None).await?;
    session.commit().await?;
    get_canvas(session, &c.id).await
}

/// The canvas with its file, the live locks and the number of open comments.
pub async fn get_canvas(session: &Session, canvas_id: &str) -> Result<Map<String, Value>> {
    let c = get_row(session, canvas_id, false).await?;
    let role = role_for(session, &c).await?;
    let mut out = summary(&c, &role);
    out.insert("doc".into(), Value::Object(read_doc(&c.id)?));
    out.insert("locks".into(), Value::Array(canvas_locks::locks_of(&c.id).into_iter().map(Value::Object).collect()));
    out.insert("open_comments".into(), json!(open_count(session, &c.id).await?));
    Ok(out)
}

/// `canvas_comments.open_count(session, canvas_id)` (part 2 of the canvases owns the comments; this count is all
/// that `get_canvas` needs of them): the open threads of a canvas.
pub async fn open_count(session: &Session, canvas_id: &str) -> Result<u64> {
    Ok(canvas_thread::Entity::find()
        .filter(canvas_thread::Column::CanvasId.eq(canvas_id))
        .filter(canvas_thread::Column::Status.eq("open"))
        .count(session)
        .await?)
}

/// The canvases of one page, ticket, idea or comment's ticket, newest change first.
pub async fn list_canvases(session: &Session, owner_kind: &str, owner_id: &str) -> Result<Vec<Map<String, Value>>> {
    let rows = canvas::Entity::find()
        .filter(canvas::Column::OwnerKind.eq(owner_kind))
        .filter(canvas::Column::OwnerId.eq(owner_id))
        .filter(canvas::Column::DeletedAt.is_null())
        .order_by_desc(canvas::Column::UpdatedAt)
        .all(session)
        .await?;
    let mut out = Vec::new();
    for c in rows {
        out.push(summary(&c, &role_for(session, &c).await?));
    }
    Ok(out)
}

/// A project's canvases in brief, newest change first.
pub async fn list_for_project(session: &Session, project_id: &str) -> Result<Vec<Map<String, Value>>> {
    let rows = canvas::Entity::find()
        .filter(canvas::Column::ProjectId.eq(project_id))
        .filter(canvas::Column::DeletedAt.is_null())
        .order_by_desc(canvas::Column::UpdatedAt)
        .all(session)
        .await?;
    Ok(rows
        .into_iter()
        .map(|c| {
            let mut m = Map::new();
            m.insert("id".into(), json!(c.id));
            m.insert("title".into(), json!(c.title));
            m.insert("owner_kind".into(), json!(c.owner_kind));
            m.insert("owner_id".into(), json!(c.owner_id));
            m.insert("page_id".into(), json!(c.page_id));
            m.insert("version".into(), json!(c.version));
            m.insert("rev".into(), json!(c.rev));
            m.insert("boards".into(), json!(c.board_count));
            m.insert("updated_by".into(), json!(c.updated_by));
            m.insert("updated_at".into(), json!(c.updated_at));
            m.insert("markdown".into(), json!(embed_line(&c.id, &c.title, None)));
            m
        })
        .collect())
}

/// Unlink a canvas: it stops resolving but its row and files are kept and it can be restored.
pub async fn delete_canvas(session: &Session, canvas_id: &str) -> Result<Map<String, Value>> {
    let mut c = get_row(session, canvas_id, false).await?;
    member_role(session, &c).await?;
    c.deleted_at = Some(now());
    c.deleted_by = Some(activity::current_actor());
    let c = persist(session, &c).await?;
    session.commit().await?;
    canvas_locks::release_all(&c.id, None);
    let mut out = Map::new();
    out.insert("id".into(), json!(c.id));
    out.insert("deleted_at".into(), json!(c.deleted_at));
    Ok(out)
}

/// Bring an unlinked canvas back.
pub async fn restore_canvas(session: &Session, canvas_id: &str) -> Result<Map<String, Value>> {
    let mut c = get_row(session, canvas_id, true).await?;
    member_role(session, &c).await?;
    c.deleted_at = None;
    c.deleted_by = None;
    let c = persist(session, &c).await?;
    session.commit().await?;
    get_canvas(session, &c.id).await
}

/// Change a canvas's name (not a new revision). The row is written but not committed, as in Python.
pub async fn rename_canvas(session: &Session, canvas_id: &str, title: &str) -> Result<canvas::Model> {
    let mut c = get_row(session, canvas_id, false).await?;
    member_role(session, &c).await?;
    c.title = sketches::title(Some(title), &c.title);
    persist(session, &c).await
}
