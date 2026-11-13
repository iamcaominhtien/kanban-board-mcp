//! `api/assist.py`: Board AI assistant API (AI v2): settings, the chat (one Claude Code conversation per chat), board
//! health. The routes keep the paths the UI calls. Drafts to apply are gone: the assistant acts directly with the
//! asker's rights, so those routes answer 410; the transient results of the editors and the sketch chat stay readable
//! here.

use axum::Json;
use axum::http::StatusCode;
use kb_base::error::{Body, OptionalBody, Path, Query};
use kb_base::{ApiError, Routes, events, pyjson};
use kb_db::Session;
use kb_db::entities::{ai_team, member, project, ticket};
use kb_db::sea_orm::{ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::api::{Failure, Res, assist_error, assist_failure, bool_map, by, put, sent};
use crate::assistant::chat::{self as svc_chat, NewChat, SendOpts};
use crate::assistant::errors::AssistError;
use crate::assistant::{
    drafts as svc_drafts, editor as svc_editor, engine, health as svc_health, settings as svc_settings,
};

/// `DRAFTS_GONE`.
const DRAFTS_GONE: &str =
    "Drafts are gone in AI v2: ask the Board AI in the chat; it does the change itself and says what it did.";

/// The routes of this file.
pub fn routes() -> Routes {
    Routes::new()
        .get("/projects/{project_id}/ai/assist", get_assist)
        .patch("/projects/{project_id}/ai/assist", patch_assist)
        .get("/projects/{project_id}/ai/assist/chats", get_chats)
        .post("/projects/{project_id}/ai/assist/chats", post_chat)
        .get("/ai/scopes/{kind}/{scope_id}", get_scope)
        .post("/ai/scopes/{kind}/{scope_id}/chat", post_scope_chat)
        .get("/tickets/{ticket_id}/ai/estimate", get_estimate)
        .get("/ai/assist/chats/{chat_id}", get_chat)
        .patch("/ai/assist/chats/{chat_id}", patch_chat)
        .post("/ai/assist/chats/{chat_id}/seen", chat_seen)
        .delete("/ai/assist/chats/{chat_id}", del_chat)
        .post("/ai/assist/chats/{chat_id}/messages", post_message)
        .get("/ai/assist/messages/{message_id}", get_message)
        .post("/ai/assist/messages/{message_id}/undo", post_undo)
        .post("/ai/assist/messages/{message_id}/feedback", post_feedback)
        .post("/ai/assist/messages/{message_id}/stop", post_stop)
        .post("/ai/assist/messages/{message_id}/retry", post_retry)
        .post("/ai/assist/messages/{message_id}/post-comment", post_message_as_comment)
        .post("/projects/{project_id}/ai/assist/drafts", post_draft)
        .get("/ai/assist/drafts/{draft_id}", get_draft)
        .get("/tickets/{ticket_id}/ai/assist/drafts", get_ticket_drafts)
        .get("/projects/{project_id}/ai/assist/drafts", get_project_drafts)
        .post("/ai/assist/drafts/{draft_id}/discard", post_discard)
        .post("/ai/assist/drafts/{draft_id}/cancel", post_cancel)
        .post("/ai/assist/drafts/{draft_id}/regenerate", post_regenerate)
        .post("/ai/assist/drafts/{draft_id}/{action}", post_draft_action)
        .patch("/ai/assist/drafts/{draft_id}", patch_draft)
        .get("/projects/{project_id}/ai/assist/similar", get_similar)
        .get("/projects/{project_id}/ai/assist/assignees", get_assignees)
        .get("/tickets/{ticket_id}/ai/assist/coverage", get_coverage)
        .get("/projects/{project_id}/ai/assist/health", get_health)
        .get("/projects/{project_id}/ai/assist/chips", get_chips)
        .post("/projects/{project_id}/ai/assist/health/run", post_health_run)
        .post("/projects/{project_id}/ai/assist/health/seen", post_health_seen)
        .post("/projects/{project_id}/ai/assist/health/snooze-all", post_snooze_all)
        .post("/ai/assist/insights/{insight_id}/{action}", post_insight)
}

/// `_project`: the project, or `not_found`.
async fn project_of(session: &Session, project_id: &str) -> Res<project::Model> {
    match project::Entity::find_by_id(project_id).one(session).await? {
        Some(p) => Ok(p),
        None => Err(assist_error(&AssistError::new("not_found", "Project not found."))),
    }
}

fn ok(map: Map<String, Value>) -> Res<Json<Value>> {
    Ok(Json(Value::Object(map)))
}

fn gone() -> Failure {
    Failure::Api(ApiError::code(410, DRAFTS_GONE))
}

// --------------------------------------------------------------------------- status and settings

/// `get_assist`: Settings > AI for this project plus the dock's state (who answers, features, spend, unseen insights).
async fn assist_state(project_id: &str) -> Res<Map<String, Value>> {
    let session = kb_db::session();
    project_of(&session, project_id).await?;
    let mut out = svc_settings::describe(&session, project_id).await?;
    let info = engine::ready(project_id, "chat").await?;
    let state = info.get("state").cloned().unwrap_or(Value::Null);
    let not_ready = state.as_str() != Some("ready");
    if let Some(Value::Object(board_ai)) = out.get_mut("board_ai") {
        board_ai.insert("state".into(), state);
        if not_ready {
            let coded = info.get("code").is_some_and(pyjson::truthy);
            let message = match info.get("message") {
                Some(m) if pyjson::truthy(m) => m.clone(),
                _ => json!(""),
            };
            board_ai.insert(
                "status".into(),
                json!({
                    "code": if coded { "paused" } else { "runner_missing" },
                    "label": if coded { "The Board AI is not ready" } else { "Claude Code was not found" },
                    "detail": message,
                }),
            );
        }
    }
    let panel = svc_health::panel(&session, project_id).await?;
    out.insert("unseen_insights".into(), panel.get("unseen").cloned().unwrap_or(Value::Null));
    let last_check = match panel.get("digest") {
        Some(d) if pyjson::truthy(d) => d.get("created_at").cloned().unwrap_or(Value::Null),
        _ => Value::Null,
    };
    out.insert("last_check".into(), last_check);
    let count = ticket::Entity::find().filter(ticket::Column::ProjectId.eq(project_id)).count(&session).await?;
    out.insert("ticket_count".into(), json!(count));
    Ok(out)
}

/// Settings > AI for this project plus the dock's state.
async fn get_assist(Path(project_id): Path<String>) -> Res<Json<Value>> {
    ok(assist_state(&project_id).await?)
}

/// Board-wide Board AI settings.
#[derive(Debug, Deserialize)]
struct AssistSettingsBody {
    #[serde(default, deserialize_with = "sent")]
    features: Option<Option<Map<String, Value>>>,
    #[serde(default, deserialize_with = "sent")]
    language: Option<Option<String>>,
    #[serde(default, deserialize_with = "sent")]
    tone: Option<Option<String>>,
    #[serde(default, deserialize_with = "sent")]
    style_guide: Option<Option<String>>,
    #[serde(default, deserialize_with = "sent")]
    health: Option<Option<Map<String, Value>>>,
}

/// Change the board-wide settings.
async fn patch_assist(Path(project_id): Path<String>, Body(body): Body<AssistSettingsBody>) -> Res<Json<Value>> {
    if let Some(Some(features)) = &body.features {
        bool_map(features, &["body", "features"])?;
    }
    let session = kb_db::session();
    project_of(&session, &project_id).await?;
    let mut data = Map::new();
    put(&mut data, "features", &body.features);
    put(&mut data, "language", &body.language);
    put(&mut data, "tone", &body.tone);
    put(&mut data, "style_guide", &body.style_guide);
    put(&mut data, "health", &body.health);
    svc_settings::update(&session, &data).await.map_err(assist_failure)?;
    events::publish(events::INVALIDATE, &[]).await;
    ok(assist_state(&project_id).await?)
}

// --------------------------------------------------------------------------- chat

#[derive(Debug, Deserialize)]
struct ChatsQuery {
    q: Option<String>,
}

/// The person's chats (private to them).
async fn get_chats(Path(project_id): Path<String>, Query(query): Query<ChatsQuery>) -> Res<Json<Value>> {
    let session = kb_db::session();
    project_of(&session, &project_id).await?;
    ok(svc_chat::list_chats(&session, &project_id, &by(), query.q.as_deref()).await?)
}

/// A new chat.
#[derive(Debug, Deserialize)]
struct ChatBody {
    #[serde(default = "project_scope")]
    scope: String,
    #[serde(default)]
    ticket_id: Option<String>,
    #[serde(default)]
    doc_id: Option<String>,
    #[serde(default)]
    scope_id: Option<String>,
    #[serde(default)]
    member_id: Option<String>,
    #[serde(default)]
    fresh: bool,
}

fn project_scope() -> String {
    "project".to_string()
}

/// New chat, or the person's latest chat about the same ticket or page.
async fn post_chat(Path(project_id): Path<String>, Body(body): Body<ChatBody>) -> Res<(StatusCode, Json<Value>)> {
    let session = kb_db::session();
    project_of(&session, &project_id).await?;
    let new = NewChat {
        scope: &body.scope,
        ticket_id: body.ticket_id.as_deref(),
        doc_id: body.doc_id.as_deref(),
        scope_id: body.scope_id.as_deref(),
        member_id: body.member_id.as_deref(),
        fresh: body.fresh,
    };
    let chat = svc_chat::create_chat(&session, &project_id, &by(), new).await.map_err(assist_failure)?;
    let out = svc_chat::detail(&session, &chat.id, &by()).await.map_err(assist_failure)?;
    Ok((StatusCode::CREATED, Json(Value::Object(out))))
}

/// The chat panel's state for a ticket, a page or an idea: what it reads and whether this person may ask.
async fn get_scope(Path((kind, scope_id)): Path<(String, String)>) -> Res<Json<Value>> {
    let session = kb_db::session();
    ok(svc_chat::scope_state(&session, &kind, &scope_id, &by()).await.map_err(assist_failure)?)
}

/// Open the person's chat about a thing.
#[derive(Debug, Deserialize)]
struct ScopeChatBody {
    #[serde(default)]
    fresh: bool,
}

/// The person's saved chat about this thing (private to them), or a new one with `fresh`.
async fn post_scope_chat(
    Path((kind, scope_id)): Path<(String, String)>,
    OptionalBody(body): OptionalBody<ScopeChatBody>,
) -> Res<Json<Value>> {
    let session = kb_db::session();
    let fresh = body.is_some_and(|b| b.fresh);
    let chat = svc_chat::scope_chat(&session, &kind, &scope_id, &by(), fresh).await.map_err(assist_failure)?;
    ok(svc_chat::detail(&session, &chat.id, &by()).await.map_err(assist_failure)?)
}

#[derive(Debug, Deserialize)]
struct EstimateQuery {
    member_id: String,
    #[serde(default = "ask")]
    mode: String,
}

fn ask() -> String {
    "ask".to_string()
}

/// What @mentioning an AI team in a comment would do (shown before the comment is sent). Runs on the account's
/// subscription: no cost estimate.
async fn get_estimate(Path(ticket_id): Path<String>, Query(query): Query<EstimateQuery>) -> Res<Json<Value>> {
    let session = kb_db::session();
    let t = ticket::Entity::find_by_id(ticket_id.as_str()).one(&session).await?;
    let m = member::Entity::find_by_id(query.member_id.as_str()).one(&session).await?;
    let (Some(_), Some(m)) = (t, m) else {
        return Err(assist_error(&AssistError::new("not_found", "Ticket or AI team not found.")));
    };
    let team = ai_team::Entity::find_by_id(query.member_id.as_str()).one(&session).await?;
    let available = team.as_ref().is_some_and(|t| !t.paused);
    let reason = if available {
        Value::Null
    } else if team.is_some() {
        json!("Paused")
    } else {
        json!("Not an AI team")
    };
    let work = query.mode == "work";
    ok(json!({
        "member_id": m.id,
        "member_name": m.name,
        "mode": if work { "work" } else { "ask" },
        "available": available,
        "reason": reason,
        "status": null,
        "metered": false,
        "estimate": {"metered": false, "usd": null, "tokens_in": 0, "tokens_out": 0},
        "reads": ["The ticket and its comments", "Linked pages", "The project's folder"],
        "can_edit_code": work,
        "stops_at": "review",
    })
    .as_object()
    .cloned()
    .unwrap_or_default())
}

/// A chat with its messages.
async fn get_chat(Path(chat_id): Path<String>) -> Res<Json<Value>> {
    let session = kb_db::session();
    ok(svc_chat::detail(&session, &chat_id, &by()).await.map_err(assist_failure)?)
}

/// Scope switch / include a page.
#[derive(Debug, Deserialize)]
struct ChatPatch {
    #[serde(default, deserialize_with = "sent")]
    scope: Option<Option<String>>,
    #[serde(default, deserialize_with = "sent")]
    ticket_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "sent")]
    doc_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "sent")]
    include_doc: Option<Option<String>>,
    #[serde(default, deserialize_with = "sent")]
    member_id: Option<Option<String>>,
}

/// Change what the chat is about, or include a page for it.
async fn patch_chat(Path(chat_id): Path<String>, Body(body): Body<ChatPatch>) -> Res<Json<Value>> {
    let session = kb_db::session();
    let mut data = Map::new();
    put(&mut data, "scope", &body.scope);
    put(&mut data, "ticket_id", &body.ticket_id);
    put(&mut data, "doc_id", &body.doc_id);
    put(&mut data, "include_doc", &body.include_doc);
    put(&mut data, "member_id", &body.member_id);
    svc_chat::update_chat(&session, &chat_id, &by(), &data).await.map_err(assist_failure)?;
    ok(svc_chat::detail(&session, &chat_id, &by()).await.map_err(assist_failure)?)
}

/// The page tells the board that its owner has this chat open and in front of them.
async fn chat_seen(Path(chat_id): Path<String>) -> Res<StatusCode> {
    let session = kb_db::session();
    svc_chat::mark_seen(&session, &chat_id, &by()).await.map_err(assist_failure)?;
    Ok(StatusCode::NO_CONTENT)
}

/// Delete a chat.
async fn del_chat(Path(chat_id): Path<String>) -> Res<StatusCode> {
    let session = kb_db::session();
    svc_chat::delete_chat(&session, &chat_id, &by()).await.map_err(assist_failure)?;
    Ok(StatusCode::NO_CONTENT)
}

/// A question.
#[derive(Debug, Deserialize)]
struct MessageBody {
    text: String,
    #[serde(default)]
    #[allow(dead_code)]
    draft: bool,
    #[serde(default)]
    #[allow(dead_code)]
    send_all: bool,
    #[serde(default)]
    doc_ids: Vec<String>,
    #[serde(default)]
    #[allow(dead_code)]
    filters: Map<String, Value>,
    #[serde(default = "ask")]
    mode: String,
    #[serde(default)]
    #[allow(dead_code)]
    member_id: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    member_form: Option<Map<String, Value>>,
}

/// Ask; the answer is written into the returned AI message (poll it).
async fn post_message(Path(chat_id): Path<String>, Body(body): Body<MessageBody>) -> Res<Json<Value>> {
    let session = kb_db::session();
    let opts = SendOpts { doc_ids: body.doc_ids, mode: Some(body.mode), ..Default::default() };
    ok(svc_chat::send(&session, &chat_id, &by(), &body.text, opts).await.map_err(assist_failure)?)
}

fn value(v: Value) -> Res<Json<Value>> {
    Ok(Json(v))
}

/// One message (polled while it is written).
async fn get_message(Path(message_id): Path<String>) -> Res<Json<Value>> {
    let session = kb_db::session();
    value(svc_chat::get_message(&session, &message_id, &by()).await.map_err(assist_failure)?)
}

/// Undo all: put back what the answer changed on tickets, unless someone else changed it since.
async fn post_undo(Path(message_id): Path<String>) -> Res<Json<Value>> {
    let session = kb_db::session();
    value(svc_chat::undo_receipt(&session, &message_id, &by()).await.map_err(assist_failure)?)
}

/// Thumbs up / down on an answer (None clears it).
#[derive(Debug, Deserialize)]
struct FeedbackBody {
    #[serde(default)]
    thumb: Option<String>,
    #[serde(default)]
    reason: String,
}

/// Keep the asker's verdict on an answer.
async fn post_feedback(Path(message_id): Path<String>, Body(body): Body<FeedbackBody>) -> Res<Json<Value>> {
    let session = kb_db::session();
    value(
        svc_chat::set_feedback(&session, &message_id, &by(), body.thumb.as_deref(), &body.reason)
            .await
            .map_err(assist_failure)?,
    )
}

/// Stop the answer.
async fn post_stop(Path(message_id): Path<String>) -> Res<Json<Value>> {
    let session = kb_db::session();
    value(svc_chat::stop(&session, &message_id, &by()).await.map_err(assist_failure)?)
}

/// Try again, or Continue.
#[derive(Debug, Deserialize)]
struct RetryBody {
    #[serde(default)]
    #[allow(dead_code)]
    send_all: bool,
    #[serde(default, rename = "continue")]
    continue_: bool,
}

/// Try again: the same question, answered again.
async fn post_retry(Path(message_id): Path<String>, OptionalBody(body): OptionalBody<RetryBody>) -> Res<Json<Value>> {
    let session = kb_db::session();
    let continue_ = body.is_some_and(|b| b.continue_);
    value(svc_chat::retry(&session, &message_id, &by(), continue_).await.map_err(assist_failure)?)
}

/// Post an answer as a comment (optionally edited first).
#[derive(Debug, Deserialize)]
struct PostCommentBody {
    #[serde(default)]
    text: Option<String>,
}

/// "Post as comment": share a ticket chat answer with the team, as a comment with the AI badge.
async fn post_message_as_comment(
    Path(message_id): Path<String>,
    OptionalBody(body): OptionalBody<PostCommentBody>,
) -> Res<Json<Value>> {
    let session = kb_db::session();
    let text = body.and_then(|b| b.text);
    ok(svc_chat::post_as_comment(&session, &message_id, &by(), text.as_deref()).await.map_err(assist_failure)?)
}

// --------------------------------------------------------------------------- drafts (gone, except editor results)

/// Gone: the Board AI no longer prepares drafts to apply.
async fn post_draft(Path(_project_id): Path<String>) -> Res<StatusCode> {
    Err(gone())
}

/// A result of an editor or the sketch chat (polled while it is written).
async fn get_draft(Path(draft_id): Path<String>) -> Res<Json<Value>> {
    ok(svc_drafts::get(&draft_id).map_err(|e| assist_error(&e))?)
}

/// No drafts any more: an empty list, so the ticket renders.
async fn get_ticket_drafts(Path(_ticket_id): Path<String>) -> Json<Value> {
    Json(json!([]))
}

/// No drafts any more: an empty list, so pages render.
async fn get_project_drafts(Path(_project_id): Path<String>) -> Json<Value> {
    Json(json!([]))
}

/// Discard a result of an editor or the sketch chat.
async fn post_discard(Path(draft_id): Path<String>) -> Res<Json<Value>> {
    ok(svc_drafts::close(&draft_id, "discarded", Some(&by())).map_err(|e| assist_error(&e))?)
}

/// Stop a result that is being written.
async fn post_cancel(Path(draft_id): Path<String>) -> Res<Json<Value>> {
    ok(svc_drafts::close(&draft_id, "cancelled", Some(&by())).map_err(|e| assist_error(&e))?)
}

/// Try again: the same editor request, written again.
async fn post_regenerate(Path(draft_id): Path<String>) -> Res<Json<Value>> {
    ok(svc_editor::again(&draft_id, &by(), false).await.map_err(|e| assist_error(&e))?)
}

/// Gone: apply, undo and request-apply belonged to drafts the Board AI prepared.
async fn post_draft_action(Path(_p): Path<(String, String)>) -> Res<StatusCode> {
    Err(gone())
}

/// Gone with the drafts.
async fn patch_draft(Path(_draft_id): Path<String>) -> Res<StatusCode> {
    Err(gone())
}

// --------------------------------------------------------------------------- matching (the assistant does it when asked)

/// Similar tickets were found by the old matcher; the assistant now says so when asked. Empty list.
async fn get_similar(Path(_project_id): Path<String>) -> Json<Value> {
    Json(json!([]))
}

/// Suggested assignees came from the old matcher. Empty list.
async fn get_assignees(Path(_project_id): Path<String>) -> Json<Value> {
    Json(json!([]))
}

/// `dict.get(key)` of a JSON object (`None` for a key that is not there).
fn get(v: &Value, key: &str) -> Value {
    v.get(key).cloned().unwrap_or(Value::Null)
}

/// Test cases by acceptance criterion (no model): which criteria have a test case.
async fn get_coverage(Path(ticket_id): Path<String>) -> Res<Json<Value>> {
    let session = kb_db::session();
    let Some(t) = ticket::Entity::find_by_id(ticket_id.as_str()).one(&session).await? else {
        return Err(assist_error(&AssistError::new("not_found", "Ticket not found.")));
    };
    let load = |text: &str| -> Res<Vec<Value>> {
        let text = if text.is_empty() { "[]" } else { text };
        match pyjson::loads(text) {
            Some(Value::Array(items)) => Ok(items),
            _ => Err(Failure::Api(ApiError::internal("a ticket's criteria or test cases are not a JSON list"))),
        }
    };
    let criteria = load(&t.acceptance_criteria)?;
    let cases = load(&t.test_cases)?;
    let mut cov = Vec::new();
    for (n, c) in criteria.iter().enumerate() {
        let id = get(c, "id");
        let text = match get(c, "text") {
            v if pyjson::truthy(&v) => v,
            _ => json!(""),
        };
        let mut names = Vec::new();
        for tc in &cases {
            if get(tc, "criterion_id") == id {
                let name = [get(tc, "code"), get(tc, "title")].into_iter().find(pyjson::truthy).unwrap_or(json!(""));
                names.push(name);
            }
        }
        cov.push(json!({"index": n, "id": id, "text": text, "cases": names}));
    }
    let covered = cov.iter().filter(|c| c["cases"].as_array().is_some_and(|a| !a.is_empty())).count();
    let total = cov.len();
    value(json!({"coverage": cov, "covered": covered, "total": total}))
}

// --------------------------------------------------------------------------- board health

/// The Board health panel.
async fn get_health(Path(project_id): Path<String>) -> Res<Json<Value>> {
    let session = kb_db::session();
    project_of(&session, &project_id).await?;
    ok(svc_health::panel(&session, &project_id).await?)
}

/// Insight chips for board cards.
async fn get_chips(Path(project_id): Path<String>) -> Res<Json<Value>> {
    let session = kb_db::session();
    value(Value::Array(svc_health::chips(&session, &project_id).await?))
}

/// Run the check now: the assistant reads the board.
async fn post_health_run(Path(project_id): Path<String>) -> Res<Json<Value>> {
    let session = kb_db::session();
    project_of(&session, &project_id).await?;
    ok(svc_health::check(&project_id, &by()).await.map_err(assist_failure)?)
}

/// The panel was opened.
async fn post_health_seen(Path(project_id): Path<String>) -> Res<Json<Value>> {
    let session = kb_db::session();
    svc_health::mark_seen(&session, &project_id).await?;
    value(json!({"ok": true}))
}

/// Snooze every open insight for a day.
async fn post_snooze_all(Path(project_id): Path<String>) -> Res<Json<Value>> {
    let session = kb_db::session();
    let snoozed = svc_health::snooze_all(&session, &project_id, 24).await?;
    value(json!({"snoozed": snoozed}))
}

/// Snooze length.
#[derive(Debug, Deserialize)]
struct InsightBody {
    #[serde(default = "day")]
    hours: i64,
}

fn day() -> i64 {
    24
}

/// snooze | dismiss | restore (`act` made a draft: 410).
async fn post_insight(
    Path((insight_id, action)): Path<(String, String)>,
    OptionalBody(body): OptionalBody<InsightBody>,
) -> Res<Json<Value>> {
    let session = kb_db::session();
    let hours = body.map_or(24, |b| b.hours);
    value(svc_health::set_state(&session, &insight_id, &action, hours).await.map_err(assist_failure)?)
}
