//! `api/idea_space.py`, lines 666-942, the second part: comments, the research log, the activity list and promote (see
//! `idea_space.rs` for the first part and the helpers they share).

use axum::Json;
use axum::http::StatusCode;
use kb_base::error::{Body, Path, Query};
use kb_base::{ApiResult, events};
use kb_board::schemas::TicketRead;
use kb_db::entities::{idea_comment, idea_log_entry, idea_ticket};
use kb_db::sea_orm::EntityTrait;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::idea_space::{actor, caught, done, fail, need_edit, read, to_value, uncaught};
use crate::idea_promote::{self, Promote};
use crate::idea_space::{self as space, LogChanges};
use crate::schemas::{ActivityFilter, CommentBody, IdeaTicketRead, LogBody, LogEvidenceBody, LogPatch, PromoteBody};

// ── comments ───────────────────────────────────────────────────────────────

/// `_comment(c)`.
fn comment(c: &idea_comment::Model) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("id".into(), json!(c.id));
    out.insert("idea_id".into(), json!(c.idea_id));
    out.insert("author".into(), json!(c.author));
    out.insert("body".into(), json!(c.body));
    out.insert("ai".into(), json!(c.ai));
    out.insert("run_id".into(), json!(c.run_id));
    out.insert("created_at".into(), json!(c.created_at));
    out.insert("edited_at".into(), json!(c.edited_at));
    out
}

/// The idea's comments, oldest first.
pub(super) async fn get_comments(Path(idea_id): Path<String>) -> ApiResult<Json<Vec<Map<String, Value>>>> {
    let session = kb_db::session();
    if idea_ticket::Entity::find_by_id(idea_id.as_str()).one(&session).await?.is_none() {
        return Err(fail(404, "not_found", &format!("Idea ticket '{idea_id}' not found"), &Map::new()));
    }
    let comments = space::list_comments(&session, &idea_id).await.map_err(uncaught)?;
    Ok(Json(comments.iter().map(comment).collect()))
}

/// Comment on an idea. Anyone who can see it may comment.
pub(super) async fn post_comment(
    Path(idea_id): Path<String>,
    Body(body): Body<CommentBody>,
) -> ApiResult<(StatusCode, Json<Map<String, Value>>)> {
    let session = kb_db::session();
    let c = space::add_comment(&session, &idea_id, &body.body, Some(&actor()), false, None).await.map_err(caught)?;
    events::publish("invalidate", &[]).await;
    Ok((StatusCode::CREATED, Json(comment(&c))))
}

/// Edit a comment.
pub(super) async fn patch_comment(
    Path((idea_id, comment_id)): Path<(String, String)>,
    Body(body): Body<CommentBody>,
) -> ApiResult<Json<Map<String, Value>>> {
    let session = kb_db::session();
    let c = space::edit_comment(&session, &idea_id, &comment_id, &body.body).await.map_err(caught)?;
    events::publish("invalidate", &[]).await;
    Ok(Json(comment(&c)))
}

/// Delete a comment.
pub(super) async fn del_comment(Path((idea_id, comment_id)): Path<(String, String)>) -> ApiResult<StatusCode> {
    let session = kb_db::session();
    space::delete_comment(&session, &idea_id, &comment_id).await.map_err(caught)?;
    events::publish("invalidate", &[]).await;
    Ok(StatusCode::NO_CONTENT)
}

// ── research log ───────────────────────────────────────────────────────────

/// `_entry(e)`.
fn entry(e: &idea_log_entry::Model) -> Map<String, Value> {
    let attachments = if e.attachments.is_empty() {
        json!([])
    } else {
        serde_json::from_str::<Value>(&e.attachments).unwrap_or_else(|_| json!([]))
    };
    let mut out = Map::new();
    out.insert("id".into(), json!(e.id));
    out.insert("idea_id".into(), json!(e.idea_id));
    out.insert("kind".into(), json!(e.kind));
    out.insert("body".into(), json!(e.body));
    out.insert("author".into(), json!(e.author));
    out.insert("ai".into(), json!(e.ai));
    out.insert("pinned".into(), json!(e.pinned));
    out.insert("assumption_id".into(), json!(e.assumption_id));
    out.insert("attachments".into(), attachments);
    out.insert("ticket_id".into(), json!(e.ticket_id));
    out.insert("created_at".into(), json!(e.created_at));
    out
}

/// The research log: pinned first, then newest first.
pub(super) async fn get_log(Path(idea_id): Path<String>) -> ApiResult<Json<Vec<Map<String, Value>>>> {
    let session = kb_db::session();
    if idea_ticket::Entity::find_by_id(idea_id.as_str()).one(&session).await?.is_none() {
        return Err(fail(404, "not_found", &format!("Idea ticket '{idea_id}' not found"), &Map::new()));
    }
    let entries = space::list_log(&session, &idea_id).await.map_err(uncaught)?;
    Ok(Json(entries.iter().map(entry).collect()))
}

/// Add to the research log (members only).
pub(super) async fn post_log(
    Path(idea_id): Path<String>,
    Body(body): Body<LogBody>,
) -> ApiResult<(StatusCode, Json<Map<String, Value>>)> {
    let session = kb_db::session();
    need_edit(&session, &idea_id).await?;
    let e = space::add_log_entry(
        &session,
        &idea_id,
        body.kind.as_str(),
        &body.body,
        Some(&actor()),
        body.ai,
        body.assumption_id.as_deref(),
        &body.attachments,
        body.ticket_id.as_deref(),
    )
    .await
    .map_err(caught)?;
    events::publish("invalidate", &[]).await;
    Ok((StatusCode::CREATED, Json(entry(&e))))
}

/// Edit, re-kind or pin a log entry.
pub(super) async fn patch_log(
    Path((idea_id, entry_id)): Path<(String, String)>,
    Body(body): Body<LogPatch>,
) -> ApiResult<Json<Map<String, Value>>> {
    let session = kb_db::session();
    need_edit(&session, &idea_id).await?;
    let changes = LogChanges { body: body.body.as_deref(), pinned: body.pinned, kind: body.kind.map(|k| k.as_str()) };
    let e = space::update_log_entry(&session, &idea_id, &entry_id, &changes).await.map_err(caught)?;
    events::publish("invalidate", &[]).await;
    Ok(Json(entry(&e)))
}

/// Delete a log entry.
pub(super) async fn del_log(Path((idea_id, entry_id)): Path<(String, String)>) -> ApiResult<StatusCode> {
    let session = kb_db::session();
    need_edit(&session, &idea_id).await?;
    space::delete_log_entry(&session, &idea_id, &entry_id, Some(&actor())).await.map_err(caught)?;
    events::publish("invalidate", &[]).await;
    Ok(StatusCode::NO_CONTENT)
}

/// "Use as evidence": a log entry becomes evidence for an assumption.
pub(super) async fn post_log_as_evidence(
    Path((idea_id, entry_id)): Path<(String, String)>,
    Body(body): Body<LogEvidenceBody>,
) -> ApiResult<Json<IdeaTicketRead>> {
    let session = kb_db::session();
    need_edit(&session, &idea_id).await?;
    let idea = space::log_entry_as_evidence(&session, &idea_id, &entry_id, &body.assumption_id, Some(&actor()))
        .await
        .map_err(caught)?;
    done(&session, &idea).await
}

// ── activity ───────────────────────────────────────────────────────────────

/// The query of `GET /{idea_id}/activity`.
#[derive(Debug, Deserialize)]
pub(super) struct ActivityQuery {
    #[serde(default)]
    filter: Option<ActivityFilter>,
}

/// Who changed what and when, newest first, with the counts the filters show.
pub(super) async fn get_activity(
    Path(idea_id): Path<String>,
    Query(query): Query<ActivityQuery>,
) -> ApiResult<Json<Map<String, Value>>> {
    let session = kb_db::session();
    let idea = space::get_or_raise(&session, &idea_id).await.map_err(caught)?;
    let items = space::activity(&idea, query.filter.map(|f| f.as_str())).map_err(caught)?;
    let mut counts = Map::new();
    for name in space::ACTIVITY_FILTERS {
        counts.insert(name.to_string(), json!(space::activity(&idea, Some(name)).map_err(caught)?.len()));
    }
    counts.insert("all".into(), json!(space::activity(&idea, None).map_err(caught)?.len()));
    let mut out = Map::new();
    out.insert("items".into(), Value::Array(items));
    out.insert("counts".into(), Value::Object(counts));
    Ok(Json(out))
}

// ── promote ────────────────────────────────────────────────────────────────

/// The query of `GET /{idea_id}/promote/preview`.
#[derive(Debug, Deserialize)]
pub(super) struct PreviewQuery {
    #[serde(default)]
    project_id: Option<String>,
}

/// What Promote would create. Nothing is written.
pub(super) async fn get_promote_preview(
    Path(idea_id): Path<String>,
    Query(query): Query<PreviewQuery>,
) -> ApiResult<Json<Map<String, Value>>> {
    let session = kb_db::session();
    Ok(Json(idea_promote::preview(&session, &idea_id, query.project_id.as_deref()).await.map_err(caught)?))
}

/// Promote an idea: create the ticket (and sub-tickets) and make the idea Building. A person must press Create: an AI
/// member cannot promote.
pub(super) async fn post_promote(
    Path(idea_id): Path<String>,
    Body(body): Body<PromoteBody>,
) -> ApiResult<(StatusCode, Json<Map<String, Value>>)> {
    let session = kb_db::session();
    need_edit(&session, &idea_id).await?;
    let author = actor();
    let args = Promote {
        project_id: body.project_id.as_deref(),
        title: body.title.as_deref(),
        r#type: body.r#type.as_str(),
        priority: body.priority.as_str(),
        status: body.status.as_str(),
        description: body.description.as_deref(),
        sub_tickets: &body.sub_tickets,
        acknowledge_not_ready: body.acknowledge_not_ready,
        workspace: body.workspace.as_str(),
        author: Some(&author),
    };
    let (idea, ticket, children) = idea_promote::promote(&session, &idea_id, &args).await.map_err(caught)?;
    events::publish("invalidate", &[]).await;
    let mut out = Map::new();
    out.insert("idea".into(), to_value(&read(&session, &idea).await?)?);
    out.insert("ticket".into(), to_value(&TicketRead::from_ticket(ticket)?)?);
    let mut subs = Vec::new();
    for child in children {
        subs.push(to_value(&TicketRead::from_ticket(child)?)?);
    }
    out.insert("sub_tickets".into(), Value::Array(subs));
    Ok((StatusCode::CREATED, Json(out)))
}
