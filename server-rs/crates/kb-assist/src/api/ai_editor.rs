//! `api/ai_editor.py`: AI in every editor (AI v2): the /ai menu, the selection bar. A request is one assistant turn
//! with the `editor-write` skill; its result is held until the person accepts or discards it
//! (`GET /ai/assist/drafts/{id}`).

use axum::Json;
use axum::http::StatusCode;
use kb_base::Routes;
use kb_base::error::{Body, OptionalBody, Path, Query};
use kb_db::Session;
use kb_db::entities::project;
use kb_db::sea_orm::EntityTrait;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::api::{Res, assist_error, assist_failure, bool_map, by};
use crate::assistant::editor as svc_editor;
use crate::assistant::errors::AssistError;

/// The routes of this file.
pub fn routes() -> Routes {
    Routes::new()
        .get("/projects/{project_id}/ai/editor/state", get_editor_state)
        .post("/projects/{project_id}/ai/editor/preview", post_editor_preview)
        .post("/projects/{project_id}/ai/editor/drafts", post_editor_draft)
        .post("/ai/editor/drafts/{draft_id}/accept", post_editor_accept)
        .post("/ai/editor/drafts/{draft_id}/continue", post_editor_continue)
}

async fn project_exists(session: &Session, project_id: &str) -> Res<()> {
    if project::Entity::find_by_id(project_id).one(session).await?.is_none() {
        return Err(assist_error(&AssistError::new("not_found", "Project not found.")));
    }
    Ok(())
}

/// One request from an editor: where it is, what to do, the text around the cursor and what to read besides.
#[derive(Debug, Deserialize)]
struct EditorBody {
    surface: String,
    action: String,
    #[serde(default)]
    selection: String,
    #[serde(default)]
    before: String,
    #[serde(default)]
    after: String,
    #[serde(default)]
    prompt: String,
    #[serde(default)]
    language: String,
    #[serde(default)]
    ticket_id: Option<String>,
    #[serde(default)]
    doc_id: Option<String>,
    #[serde(default)]
    idea_id: Option<String>,
    #[serde(default)]
    include: Map<String, Value>,
}

impl EditorBody {
    /// `body.model_dump()`.
    fn dump(&self) -> Map<String, Value> {
        let mut out = Map::new();
        out.insert("surface".into(), json!(self.surface));
        out.insert("action".into(), json!(self.action));
        out.insert("selection".into(), json!(self.selection));
        out.insert("before".into(), json!(self.before));
        out.insert("after".into(), json!(self.after));
        out.insert("prompt".into(), json!(self.prompt));
        out.insert("language".into(), json!(self.language));
        out.insert("ticket_id".into(), json!(self.ticket_id));
        out.insert("doc_id".into(), json!(self.doc_id));
        out.insert("idea_id".into(), json!(self.idea_id));
        out.insert("include".into(), Value::Object(self.include.clone()));
        out
    }
}

#[derive(Debug, Deserialize)]
struct StateQuery {
    surface: String,
    #[allow(dead_code)]
    ticket_id: Option<String>,
    #[allow(dead_code)]
    idea_id: Option<String>,
}

/// Whether the person may use AI in this editor, and the /ai menu and the selection bar for it.
async fn get_editor_state(Path(project_id): Path<String>, Query(query): Query<StateQuery>) -> Res<Json<Value>> {
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    let out = svc_editor::state(&session, &project_id, &query.surface).await.map_err(assist_failure)?;
    Ok(Json(Value::Object(out)))
}

/// "What will be sent": the pieces of this request. Sends nothing.
async fn post_editor_preview(Path(project_id): Path<String>, Body(body): Body<EditorBody>) -> Res<Json<Value>> {
    bool_map(&body.include, &["body", "include"])?;
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    let out = svc_editor::preview(&body.dump()).map_err(|e| assist_error(&e))?;
    Ok(Json(Value::Object(out)))
}

/// Ask for a draft. It is written in the background (poll `GET /ai/assist/drafts/{id}`); the text is not touched.
async fn post_editor_draft(
    Path(project_id): Path<String>,
    Body(body): Body<EditorBody>,
) -> Res<(StatusCode, Json<Value>)> {
    bool_map(&body.include, &["body", "include"])?;
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    let out = svc_editor::start(&session, &project_id, &body.dump(), &by()).await.map_err(assist_failure)?;
    Ok((StatusCode::CREATED, Json(Value::Object(out))))
}

/// What was accepted (a list of criteria can be trimmed or edited first).
#[derive(Debug, Deserialize)]
struct AcceptBody {
    #[serde(default)]
    items: Option<Vec<String>>,
}

/// Accept: the editor has put the text in; an accepted list of criteria is added to the ticket.
async fn post_editor_accept(
    Path(draft_id): Path<String>,
    OptionalBody(body): OptionalBody<AcceptBody>,
) -> Res<Json<Value>> {
    let items = body.and_then(|b| b.items);
    let out = svc_editor::accept(&draft_id, &by(), items).await.map_err(assist_failure)?;
    Ok(Json(Value::Object(out)))
}

/// Continue a draft: carry on from what it has.
async fn post_editor_continue(Path(draft_id): Path<String>) -> Res<Json<Value>> {
    let out = svc_editor::again(&draft_id, &by(), true).await.map_err(|e| assist_error(&e))?;
    Ok(Json(Value::Object(out)))
}
