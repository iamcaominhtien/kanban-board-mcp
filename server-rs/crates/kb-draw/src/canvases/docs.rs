//! `services/canvases.py` lines 2101-2192: a canvas as a Docs page. The page itself is made by the Docs area, which is
//! above this crate: `hooks::CanvasDocs`.

use kb_db::Session;
use kb_db::entities::{canvas, docs_page};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, EntityTrait};
use kb_doctext::docs_text::DocsError;
use serde_json::{Map, Value, json};

use super::rows::{NewCanvas, Size, create_canvas, get_canvas, get_row, member_role, persist, summary};
use super::*;
use crate::{Result, hooks, sketches};

fn docs_hook() -> Result<&'static dyn hooks::CanvasDocs> {
    hooks::canvas_docs().ok_or_else(|| crate::Error::Value("The Docs area is not available.".into()))
}

/// `session.get(DocsPage, id)` and `row.kind = "canvas"`, committed.
async fn mark_page_as_canvas(session: &Session, page_id: &str) -> Result<docs_page::Model> {
    let row = docs_page::Entity::find_by_id(page_id)
        .one(session)
        .await?
        .ok_or_else(|| crate::Error::Value("the new Docs page is not in the database".into()))?;
    let mut am = kb_db::edit(row);
    am.kind = Set("canvas".to_string());
    let row = am.update(session).await?;
    session.commit().await?;
    Ok(row)
}

/// `{**page, "kind": "canvas"}`.
fn with_kind(mut page: Map<String, Value>) -> Map<String, Value> {
    page.insert("kind".into(), json!("canvas"));
    page
}

/// Docs > New page > Canvas: a Docs page of kind `canvas` with its canvas (one empty frame).
pub async fn create_docs_canvas(
    session: &Session,
    project_id: &str,
    title: &str,
    parent_id: Option<&str>,
) -> Result<Map<String, Value>> {
    let page = docs_hook()?.create_page(session, project_id, title, parent_id).await?;
    let page_id = page.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    let row = mark_page_as_canvas(session, &page_id).await?;
    let canvas = create_canvas(
        session,
        NewCanvas {
            owner_kind: "page",
            owner_id: &row.id,
            title: Some(title),
            project_id: Some(project_id),
            page_id: Some(&row.id),
            start: "blank",
            size: Size::Preset("desktop".into()),
        },
    )
    .await?;
    publish_page_line(session, &row.id, &canvas).await?;
    let mut out = Map::new();
    out.insert("page".into(), Value::Object(with_kind(page)));
    out.insert("canvas".into(), Value::Object(canvas));
    Ok(out)
}

/// The text of a canvas page is its embed line, so search, exports and backlinks see it like any page.
async fn publish_page_line(session: &Session, page_id: &str, canvas: &Map<String, Value>) -> Result<()> {
    let id = canvas.get("id").and_then(Value::as_str).unwrap_or("");
    let title = canvas.get("title").and_then(Value::as_str).unwrap_or("");
    docs_hook()?.publish_page(session, page_id, 0, &embed_line(id, title, None), "Canvas").await
}

/// Give an inline canvas its own Docs page. It keeps its boards, comments and history, and the text it came from keeps
/// showing it (the id does not change). Fails with 422 for a canvas without a project (a free idea) or one that is
/// already a page.
pub async fn move_to_docs(
    session: &Session,
    canvas_id: &str,
    title: Option<&str>,
    parent_id: Option<&str>,
) -> Result<Map<String, Value>> {
    let mut c = get_row(session, canvas_id, false).await?;
    let read = c.clone();
    member_role(session, &c).await?;
    if c.page_id.as_deref().is_some_and(|p| !p.is_empty()) {
        return Err(DocsError::new(422, "already_page", "This canvas is already a Docs page.").into());
    }
    let Some(project_id) = c.project_id.clone().filter(|p| !p.is_empty()) else {
        return Err(DocsError::new(422, "no_project", "Only a canvas in a project can move to Docs.").into());
    };
    let name = title.filter(|t| !t.is_empty()).unwrap_or(&c.title).to_string();
    let out = create_docs_canvas_page(session, &c, &project_id, &name, parent_id).await?;
    let page_id = out.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    let row = docs_page::Entity::find_by_id(page_id.as_str())
        .one(session)
        .await?
        .ok_or_else(|| crate::Error::Value("the new Docs page is not in the database".into()))?;
    c.owner_kind = "page".into();
    c.owner_id = row.id.clone();
    c.page_id = Some(row.id.clone());
    if let Some(t) = title.filter(|t| !t.is_empty()) {
        c.title = sketches::title(Some(t), &c.title);
    }
    let c: canvas::Model = persist(session, &read, &c).await?;
    session.commit().await?;
    publish_page_line(session, &row.id, &summary(&c, "member")).await?;
    let mut result = Map::new();
    result.insert("page".into(), Value::Object(out));
    result.insert("canvas".into(), Value::Object(get_canvas(session, &c.id).await?));
    Ok(result)
}

/// Create the Docs page row for an existing canvas.
pub async fn create_docs_canvas_page(
    session: &Session,
    _c: &canvas::Model,
    project_id: &str,
    title: &str,
    parent_id: Option<&str>,
) -> Result<Map<String, Value>> {
    let page = docs_hook()?.create_page(session, project_id, title, parent_id).await?;
    let page_id = page.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    mark_page_as_canvas(session, &page_id).await?;
    Ok(with_kind(page))
}
