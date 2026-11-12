//! `api/idea_space.py`: REST API of the Idea Space under `/api/idea-tickets`: stages, triage, merge, votes,
//! assumptions, evidence, comments, log, activity, promote.
//!
//! The basic idea routes (list, create, get, patch, delete, legacy status) are in `api/idea_tickets.py`; this router
//! is included before it so its fixed paths (`/counts`, `/similar`, ...) win over `/{ticket_id}`.
//!
//! The Python file is one module; here it is two: this file (lines 1-663 of the Python file: the helpers, listing,
//! stages, merge, votes, page, assumptions and evidence) and `idea_space_log.rs` (lines 666-942: comments, the
//! research log, activity and promote). `entries()` lists the routes of both in the order of the Python file.

use std::collections::{HashMap, HashSet};

use axum::Json;
use axum::http::StatusCode;
use kb_base::error::{Body, Path, Query};
use kb_base::{ApiError, ApiResult, activity, events};
use kb_db::Session;
use kb_db::entities::{idea_assumption, idea_ticket, member, ticket};
use kb_db::sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter};
use kb_doctext::docs_access::role_in;
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value, json};

use super::idea_space_log;
use super::{Entry, delete, get, patch, post, put};
use crate::error::{Error, IdeaRuleError};
use crate::idea_promote;
use crate::idea_similarity::{MIN_SCORE, find_similar, suggest_tags};
use crate::idea_space::{self as space, ListFilter, MoveStage, PageChanges};
use crate::idea_tickets::{self as base, TestTicket};
use crate::model::{IDEA_SOURCES, Idea};
use crate::schemas::{
    AssumptionCreate, EvidenceBody, IdeaListRow, IdeaTicketRead, Kind, MergeBody, OutcomeBody, PageBody, ParkManyBody,
    ProjectBody, ResolveBody, Scope, Sort, Stage, StageBody, TestTicketBody, VoteBody,
};
use kb_board::schemas::TicketRead;

/// The routes of this file, in the order of the Python file.
pub(super) fn entries() -> Vec<Entry> {
    vec![
        get("/api/idea-tickets/space", list_space),
        get("/api/idea-tickets/counts", get_counts),
        get("/api/idea-tickets/sorted-this-week", get_sorted_this_week),
        get("/api/idea-tickets/similar", get_similar),
        get("/api/idea-tickets/tag-suggestions", get_tag_suggestions),
        get("/api/idea-tickets/by-ticket/{ticket_id}", by_ticket),
        post("/api/idea-tickets/{idea_id}/stage", post_stage),
        post("/api/idea-tickets/{idea_id}/undo", post_undo),
        post("/api/idea-tickets/park-many", post_park_many),
        post("/api/idea-tickets/{idea_id}/merge", post_merge),
        post("/api/idea-tickets/{idea_id}/undo-merge", post_undo_merge),
        post("/api/idea-tickets/{idea_id}/vote", post_vote),
        post("/api/idea-tickets/{idea_id}/outcome", post_outcome),
        patch("/api/idea-tickets/{idea_id}/page", patch_page),
        put("/api/idea-tickets/{idea_id}/project", put_project),
        post("/api/idea-tickets/{idea_id}/assumption-records", post_assumption_record),
        patch("/api/idea-tickets/{idea_id}/assumption-records/{assumption_id}", patch_assumption_record),
        post("/api/idea-tickets/{idea_id}/assumption-records/{assumption_id}/test-ticket", post_test_ticket),
        post("/api/idea-tickets/{idea_id}/assumption-records/{assumption_id}/resolve", post_resolve),
        get("/api/idea-tickets/{idea_id}/evidence", get_evidence),
        post("/api/idea-tickets/{idea_id}/evidence", post_evidence),
        delete("/api/idea-tickets/{idea_id}/evidence/{evidence_id}", del_evidence),
        get("/api/idea-tickets/{idea_id}/comments", idea_space_log::get_comments),
        post("/api/idea-tickets/{idea_id}/comments", idea_space_log::post_comment),
        patch("/api/idea-tickets/{idea_id}/comments/{comment_id}", idea_space_log::patch_comment),
        delete("/api/idea-tickets/{idea_id}/comments/{comment_id}", idea_space_log::del_comment),
        get("/api/idea-tickets/{idea_id}/log", idea_space_log::get_log),
        post("/api/idea-tickets/{idea_id}/log", idea_space_log::post_log),
        patch("/api/idea-tickets/{idea_id}/log/{entry_id}", idea_space_log::patch_log),
        delete("/api/idea-tickets/{idea_id}/log/{entry_id}", idea_space_log::del_log),
        post("/api/idea-tickets/{idea_id}/log/{entry_id}/evidence", idea_space_log::post_log_as_evidence),
        get("/api/idea-tickets/{idea_id}/activity", idea_space_log::get_activity),
        get("/api/idea-tickets/{idea_id}/promote/preview", idea_space_log::get_promote_preview),
        post("/api/idea-tickets/{idea_id}/promote", idea_space_log::post_promote),
    ]
}

/// `_fail(status, code, message, **extra)`: an `HTTPException` whose detail is `{code, message, **extra}`.
pub(super) fn fail(status: u16, code: &str, message: &str, extra: &Map<String, Value>) -> ApiError {
    let mut detail = Map::new();
    detail.insert("code".into(), json!(code));
    detail.insert("message".into(), json!(message));
    detail.extend(extra.clone());
    ApiError::code(status, Value::Object(detail))
}

/// `_rule(exc)`: a broken rule is a 409 (a 404 for `not_found`).
fn rule(exc: IdeaRuleError) -> ApiError {
    let status = if exc.code == "not_found" { 404 } else { 409 };
    fail(status, &exc.code, &exc.message, &exc.extra)
}

/// `_value(exc)`: a missing thing is a 404, any other bad value a 400.
fn value(text: &str) -> ApiError {
    if text.contains("not found") {
        return fail(404, "not_found", text, &Map::new());
    }
    fail(400, "invalid", text, &Map::new())
}

/// `except space.IdeaRuleError: _rule(exc)` and `except ValueError: _value(exc)`; anything else is a 500.
pub(super) fn caught(err: Error) -> ApiError {
    match err {
        Error::Rule(exc) => rule(exc),
        Error::Value(text) => value(&text),
        Error::Db(err) => err.into(),
        Error::Other(message) => ApiError::internal(message),
    }
}

/// A route with no `try`: any failure is a 500.
pub(super) fn uncaught(err: Error) -> ApiError {
    match err {
        Error::Db(err) => err.into(),
        other => ApiError::internal(other),
    }
}

/// `_actor()`.
pub(super) fn actor() -> String {
    activity::current_actor()
}

/// Whether the current actor may move and edit the idea: members and admins of its project (anyone for an idea with
/// no project). Viewers can still add ideas, vote and comment.
pub async fn can_edit(session: &Session, idea: &idea_ticket::Model) -> Result<bool, DbErr> {
    let actor = actor();
    let Some(project_id) = idea.project_id.as_deref() else { return Ok(true) };
    if actor == activity::HUMAN_ACTOR || actor == activity::AGENT_ACTOR {
        return Ok(true);
    }
    let rows = member::Entity::find().filter(member::Column::ProjectId.eq(project_id)).all(session).await?;
    let role = role_in(&rows, &actor);
    Ok(role == "member" || role == "admin")
}

/// `_need_edit(session, idea_id)`: the idea, or the 404 / 403 the person gets.
pub(super) async fn need_edit(session: &Session, idea_id: &str) -> ApiResult<idea_ticket::Model> {
    let Some(idea) = idea_ticket::Entity::find_by_id(idea_id).one(session).await? else {
        return Err(fail(404, "not_found", &format!("Idea ticket '{idea_id}' not found"), &Map::new()));
    };
    if !can_edit(session, &idea).await? {
        return Err(fail(
            403,
            "read_only",
            "Only owners and members can change ideas. You can still vote and comment.",
            &Map::new(),
        ));
    }
    Ok(idea)
}

/// Read models for ideas, with the ticket each became (id, title, status, project) filled in.
pub async fn reads(session: &Session, ideas: &[Idea]) -> ApiResult<Vec<IdeaTicketRead>> {
    let ids: Vec<String> = {
        let mut seen = HashSet::new();
        ideas
            .iter()
            .filter_map(|i| i.row.promoted_to_ticket_id.clone())
            .filter(|id| !id.is_empty() && seen.insert(id.clone()))
            .collect()
    };
    let mut tickets: HashMap<String, ticket::Model> = HashMap::new();
    if !ids.is_empty() {
        for t in ticket::Entity::find().filter(ticket::Column::Id.is_in(ids)).all(session).await? {
            tickets.insert(t.id.clone(), t);
        }
    }
    let mut out = Vec::new();
    let mut editable: HashMap<Option<String>, bool> = HashMap::new();
    for idea in ideas {
        let mut item = IdeaTicketRead::from_idea_ticket(idea).map_err(uncaught)?;
        if !editable.contains_key(&idea.row.project_id) {
            let can = can_edit(session, &idea.row).await?;
            editable.insert(idea.row.project_id.clone(), can);
        }
        item.can_edit = editable[&idea.row.project_id];
        if let Some(t) = idea.row.promoted_to_ticket_id.as_deref().and_then(|id| tickets.get(id)) {
            item.ticket = Some(json!({
                "id": t.id,
                "title": t.title,
                "status": t.status,
                "project_id": t.project_id,
                "assignee": t.assignee,
            }));
        }
        out.push(item);
    }
    Ok(out)
}

/// The read model of one idea.
pub async fn read(session: &Session, idea: &Idea) -> ApiResult<IdeaTicketRead> {
    let mut all = reads(session, std::slice::from_ref(idea)).await?;
    Ok(all.remove(0))
}

/// `_done(session, idea)`: tell the board, then read the idea.
pub(super) async fn done(session: &Session, idea: &Idea) -> ApiResult<Json<IdeaTicketRead>> {
    events::publish("invalidate", &[]).await;
    Ok(Json(read(session, idea).await?))
}

/// A `bool` query value as Pydantic reads it.
#[derive(Debug, Clone, Copy)]
struct QueryBool(bool);

impl<'de> Deserialize<'de> for QueryBool {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        match text.to_lowercase().as_str() {
            "1" | "true" | "t" | "yes" | "y" | "on" => Ok(QueryBool(true)),
            "0" | "false" | "f" | "no" | "n" | "off" => Ok(QueryBool(false)),
            _ => Err(serde::de::Error::custom("Input should be a valid boolean, unable to interpret input")),
        }
    }
}

// ── listing, counts, search ────────────────────────────────────────────────

/// The query of `GET /space`.
#[derive(Debug, Deserialize)]
struct SpaceQuery {
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    scope: Option<Scope>,
    #[serde(default)]
    stage: Vec<Stage>,
    #[serde(default)]
    active: Option<QueryBool>,
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    tag: Option<String>,
    #[serde(default)]
    sort: Option<Sort>,
}

/// List ideas for the Idea Space views: one project, all projects, or ideas with no project.
async fn list_space(Query(query): Query<SpaceQuery>) -> ApiResult<Json<Vec<IdeaListRow>>> {
    let session = kb_db::session();
    if let Some(source) = query.source.as_deref() {
        if !IDEA_SOURCES.contains(&source) {
            return Err(fail(
                400,
                "invalid",
                &format!("source must be one of: {}", IDEA_SOURCES.join(", ")),
                &Map::new(),
            ));
        }
    }
    let stages: Vec<String> = query.stage.iter().map(|s| s.as_str().to_string()).collect();
    let filter = ListFilter {
        project_id: query.project_id.as_deref(),
        scope: query.scope.map_or("project", Scope::as_str),
        stages: &stages,
        active: query.active.is_some_and(|a| a.0),
        q: query.q.as_deref(),
        source: query.source.as_deref(),
        tag: query.tag.as_deref(),
        sort: query.sort.map_or("readiness", Sort::as_str),
    };
    let ideas = space::list_ideas(&session, &filter).await.map_err(caught)?;
    let rows = reads(&session, &ideas).await?;
    Ok(Json(rows.into_iter().zip(&ideas).map(|(idea, i)| IdeaListRow { idea, warnings: space::warnings(i) }).collect()))
}

/// Counts for the project switcher, stage filters and the sidebar badge.
async fn get_counts() -> ApiResult<Json<Map<String, Value>>> {
    let session = kb_db::session();
    Ok(Json(space::counts(&session).await.map_err(uncaught)?))
}

/// The query of `GET /sorted-this-week`.
#[derive(Debug, Deserialize)]
struct WeekQuery {
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    scope: Option<Scope>,
}

/// How many Inbox ideas the caller sorted in the last 7 days: kept, parked, merged, archived (ICT-9).
async fn get_sorted_this_week(Query(query): Query<WeekQuery>) -> ApiResult<Json<Map<String, Value>>> {
    let session = kb_db::session();
    let person = actor();
    let scope = query.scope.map_or("project", Scope::as_str);
    Ok(Json(
        space::sorted_this_week(&session, Some(&person), scope, query.project_id.as_deref()).await.map_err(uncaught)?,
    ))
}

/// The query of `GET /similar`.
#[derive(Debug, Deserialize)]
struct SimilarQuery {
    text: String,
    #[serde(default)]
    exclude: Option<String>,
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    kinds: Vec<Kind>,
    #[serde(default)]
    limit: Option<String>,
}

/// `limit: int = Query(default=5, ge=1, le=20)`.
fn query_limit(text: Option<&str>) -> ApiResult<usize> {
    let Some(text) = text else { return Ok(5) };
    let text = text.trim();
    let whole = match text.split_once('.') {
        Some((whole, fraction)) if !fraction.is_empty() && fraction.bytes().all(|b| b == b'0') => whole,
        Some(_) => "",
        None => text,
    };
    let digits = whole.strip_prefix(['+', '-']).unwrap_or(whole);
    let parsed = if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
        whole.strip_prefix('+').unwrap_or(whole).parse::<i64>().ok()
    } else {
        None
    };
    let Some(n) = parsed else {
        return Err(ApiError::validation(
            &["query", "limit"],
            "Input should be a valid integer, unable to parse string as an integer",
            "int_parsing",
        ));
    };
    if n < 1 {
        return Err(ApiError::validation(
            &["query", "limit"],
            "Input should be greater than or equal to 1",
            "greater_than_equal",
        ));
    }
    if n > 20 {
        return Err(ApiError::validation(
            &["query", "limit"],
            "Input should be less than or equal to 20",
            "less_than_equal",
        ));
    }
    Ok(n as usize)
}

/// Ideas, tickets and Docs that look like the text (local search, no model).
async fn get_similar(Query(query): Query<SimilarQuery>) -> ApiResult<Json<Vec<Map<String, Value>>>> {
    let limit = query_limit(query.limit.as_deref())?;
    let session = kb_db::session();
    let kinds: Vec<&str> = if query.kinds.is_empty() {
        vec!["idea", "ticket", "doc"]
    } else {
        query.kinds.iter().map(|k| k.as_str()).collect()
    };
    let found = find_similar(
        &session,
        &query.text,
        query.exclude.as_deref(),
        query.project_id.as_deref(),
        &kinds,
        limit,
        MIN_SCORE,
    )
    .await
    .map_err(uncaught)?;
    Ok(Json(found))
}

/// The query of `GET /tag-suggestions`.
#[derive(Debug, Deserialize)]
struct TagQuery {
    text: String,
    #[serde(default)]
    exclude: Option<String>,
}

/// Tags used by the ideas and tickets that look like the text.
async fn get_tag_suggestions(Query(query): Query<TagQuery>) -> ApiResult<Json<Vec<String>>> {
    let session = kb_db::session();
    Ok(Json(suggest_tags(&session, &query.text, query.exclude.as_deref()).await.map_err(uncaught)?))
}

/// What the ticket page needs: the idea it started as and the assumption it tests (either may be null).
async fn by_ticket(Path(ticket_id): Path<String>) -> ApiResult<Json<Map<String, Value>>> {
    let session = kb_db::session();
    let Some(ticket) = ticket::Entity::find_by_id(ticket_id.as_str()).one(&session).await? else {
        return Err(fail(404, "not_found", &format!("Ticket '{ticket_id}' not found"), &Map::new()));
    };
    let mut out = Map::new();
    out.insert("from_idea".into(), Value::Null);
    out.insert("tests".into(), Value::Null);
    if let Some(from_idea_id) = ticket.from_idea_id.as_deref().filter(|i| !i.is_empty()) {
        if idea_ticket::Entity::find_by_id(from_idea_id).one(&session).await?.is_some() {
            let idea = base::reload(&session, from_idea_id).await.map_err(uncaught)?;
            let checked = idea.assumptions().filter(|a| a.status == "validated").count();
            let confirmed: Vec<&str> =
                idea.assumptions().filter(|a| a.status == "validated").map(|a| a.text.as_str()).collect();
            let open: Vec<Value> = idea
                .assumptions()
                .filter(|a| a.status == "untested" || a.status == "testing")
                .map(|a| json!({"id": a.id, "text": a.text, "test_ticket_id": a.test_ticket_id}))
                .collect();
            out.insert(
                "from_idea".into(),
                json!({
                    "id": idea.row.id,
                    "title": idea.row.title,
                    "stage": idea.row.stage,
                    "demand": idea_promote::demand_note(&idea),
                    "assumptions_total": idea.assumption_records.len(),
                    "assumptions_checked": checked,
                    "confirmed": confirmed,
                    "log_count": idea.log_records.len(),
                    "outcome": idea.row.outcome,
                    "open": open,
                }),
            );
        }
    }
    if let Some(assumption_id) = ticket.tests_assumption_id.as_deref().filter(|i| !i.is_empty()) {
        if let Some(a) = idea_assumption::Entity::find_by_id(assumption_id).one(&session).await? {
            out.insert(
                "tests".into(),
                json!({
                    "idea_id": a.idea_id,
                    "assumption_id": a.id,
                    "text": a.text,
                    "status": a.status,
                    "impact": a.impact,
                }),
            );
        }
    }
    Ok(Json(out))
}

// ── stage, triage, merge ───────────────────────────────────────────────────

/// Move an idea to another stage. Keep may also set the project and tags in the same step.
async fn post_stage(Path(idea_id): Path<String>, Body(body): Body<StageBody>) -> ApiResult<Json<IdeaTicketRead>> {
    let session = kb_db::session();
    need_edit(&session, &idea_id).await?;
    let author = actor();
    if let Some(project_id) = body.project_id.as_deref() {
        space::assign_project(&session, &idea_id, Some(project_id), Some(&author)).await.map_err(caught)?;
    }
    if let Some(tags) = &body.tags {
        let tags: Vec<Value> = tags.iter().map(|t| json!(t)).collect();
        let changes = PageChanges { tags: Some(&tags), author: Some(&author), ..Default::default() };
        space::update_page(&session, &idea_id, &changes).await.map_err(caught)?;
    }
    let args = MoveStage {
        author: Some(&author),
        park_until: body.park_until.as_deref(),
        park_note: body.park_note.as_deref(),
        archive_reason: body.archive_reason.map(|r| r.as_str()),
        archive_note: body.archive_note.as_deref(),
        force: body.force,
        via: body.via.as_deref(),
    };
    let idea = space::move_stage(&session, &idea_id, body.to.as_str(), &args).await.map_err(caught)?;
    done(&session, &idea).await
}

/// Take back the last stage move.
async fn post_undo(Path(idea_id): Path<String>) -> ApiResult<Json<IdeaTicketRead>> {
    let session = kb_db::session();
    need_edit(&session, &idea_id).await?;
    let idea = space::undo_last_move(&session, &idea_id, Some(&actor())).await.map_err(caught)?;
    done(&session, &idea).await
}

/// Park several ideas in one step.
async fn post_park_many(Body(body): Body<ParkManyBody>) -> ApiResult<Json<Vec<IdeaTicketRead>>> {
    let session = kb_db::session();
    for id in &body.ids {
        need_edit(&session, id).await?;
    }
    let ideas = space::park_many(&session, &body.ids, &body.park_until, Some(&actor()), body.park_note.as_deref())
        .await
        .map_err(caught)?;
    events::publish("invalidate", &[]).await;
    Ok(Json(reads(&session, &ideas).await?))
}

/// Merge the idea into another idea; returns the target. Can be undone for 10 minutes.
async fn post_merge(Path(idea_id): Path<String>, Body(body): Body<MergeBody>) -> ApiResult<Json<IdeaTicketRead>> {
    let session = kb_db::session();
    need_edit(&session, &idea_id).await?;
    need_edit(&session, &body.into_id).await?;
    let target = space::merge(&session, &idea_id, &body.into_id, Some(&actor())).await.map_err(caught)?;
    done(&session, &target).await
}

/// Undo the last merge into this idea (within 10 minutes).
async fn post_undo_merge(Path(idea_id): Path<String>) -> ApiResult<Json<IdeaTicketRead>> {
    let session = kb_db::session();
    need_edit(&session, &idea_id).await?;
    let target = space::undo_merge(&session, &idea_id, Some(&actor())).await.map_err(caught)?;
    done(&session, &target).await
}

/// Vote for an idea (one per person), or take the vote back. Anyone who can see the idea may vote.
async fn post_vote(Path(idea_id): Path<String>, Body(body): Body<VoteBody>) -> ApiResult<Json<IdeaTicketRead>> {
    let session = kb_db::session();
    let voter = body.voter.filter(|v| !v.is_empty()).unwrap_or_else(actor);
    let idea = space::vote(&session, &idea_id, &voter, body.on).await.map_err(caught)?;
    done(&session, &idea).await
}

/// Save the outcome of a shipped idea.
async fn post_outcome(Path(idea_id): Path<String>, Body(body): Body<OutcomeBody>) -> ApiResult<Json<IdeaTicketRead>> {
    let session = kb_db::session();
    need_edit(&session, &idea_id).await?;
    let idea = space::record_outcome(&session, &idea_id, body.outcome.as_str(), body.note.as_deref(), Some(&actor()))
        .await
        .map_err(caught)?;
    done(&session, &idea).await
}

// ── page, project ──────────────────────────────────────────────────────────

/// Edit the page (markdown body), details, title, tags, owner, effort guess or workspace retention.
async fn patch_page(Path(idea_id): Path<String>, Body(body): Body<PageBody>) -> ApiResult<Json<IdeaTicketRead>> {
    let session = kb_db::session();
    need_edit(&session, &idea_id).await?;
    let author = actor();
    let tags: Option<Vec<Value>> = body.tags.as_ref().map(|t| t.iter().map(|t| json!(t)).collect());
    fn sent(value: &Option<Option<String>>) -> space::Sent<'_> {
        match value {
            None => space::Sent::Skip,
            Some(value) => space::Sent::Set(value.as_deref()),
        }
    }
    let changes = PageChanges {
        body: body.body.as_deref(),
        details: body.details.as_deref(),
        owner: sent(&body.owner),
        effort_guess: sent(&body.effort_guess),
        workspace_retention: body.workspace_retention.map(|r| r.as_str()),
        tags: tags.as_deref(),
        title: body.title.as_deref(),
        author: Some(&author),
        ai: body.ai,
    };
    let idea = space::update_page(&session, &idea_id, &changes).await.map_err(caught)?;
    done(&session, &idea).await
}

/// Choose the project of an idea.
async fn put_project(Path(idea_id): Path<String>, Body(body): Body<ProjectBody>) -> ApiResult<Json<IdeaTicketRead>> {
    let session = kb_db::session();
    need_edit(&session, &idea_id).await?;
    let idea =
        space::assign_project(&session, &idea_id, body.project_id.as_deref(), Some(&actor())).await.map_err(caught)?;
    done(&session, &idea).await
}

// ── assumptions ────────────────────────────────────────────────────────────

/// Add an assumption with its impact.
async fn post_assumption_record(
    Path(idea_id): Path<String>,
    Body(body): Body<AssumptionCreate>,
) -> ApiResult<Json<IdeaTicketRead>> {
    let session = kb_db::session();
    need_edit(&session, &idea_id).await?;
    let idea = base::add_assumption(&session, &idea_id, &body.text, body.impact.as_str(), Some(&actor()), body.ai)
        .await
        .map_err(caught)?;
    done(&session, &idea).await
}

/// Change an assumption's text, impact, status or test ticket.
async fn patch_assumption_record(
    Path((idea_id, assumption_id)): Path<(String, String)>,
    Body(body): Body<crate::schemas::AssumptionEdit>,
) -> ApiResult<Json<IdeaTicketRead>> {
    let session = kb_db::session();
    need_edit(&session, &idea_id).await?;
    let author = actor();
    let mut idea: Option<Idea> = None;
    if body.text.is_some() || body.impact.is_some() || body.test_ticket_id.is_some() {
        // `kwargs[k] = sent[k]`: a value sent as null is the same as one left out for the text and the impact, and the
        // end of the link for the test ticket
        let test_ticket = match &body.test_ticket_id {
            None => TestTicket::Skip,
            Some(id) => TestTicket::Set(id.as_deref()),
        };
        idea = Some(
            base::update_assumption(
                &session,
                &idea_id,
                &assumption_id,
                body.text.as_ref().and_then(|t| t.as_deref()),
                body.impact.and_then(|i| i).map(|i| i.as_str()),
                test_ticket,
                Some(&author),
            )
            .await
            .map_err(caught)?,
        );
    }
    if let Some(Some(status)) = body.status {
        idea = Some(
            base::update_assumption_status(&session, &idea_id, &assumption_id, status.as_str(), Some(&author))
                .await
                .map_err(caught)?,
        );
    }
    let idea = match idea {
        Some(idea) => idea,
        None => space::get_or_raise(&session, &idea_id).await.map_err(caught)?,
    };
    done(&session, &idea).await
}

/// Create a test ticket for an assumption, linked both ways; the assumption becomes Testing.
async fn post_test_ticket(
    Path((idea_id, assumption_id)): Path<(String, String)>,
    Body(body): Body<TestTicketBody>,
) -> ApiResult<(StatusCode, Json<Map<String, Value>>)> {
    let session = kb_db::session();
    need_edit(&session, &idea_id).await?;
    let (idea, ticket) = space::create_test_ticket(
        &session,
        &idea_id,
        &assumption_id,
        body.title.as_deref(),
        body.assignee.as_deref(),
        Some(&actor()),
    )
    .await
    .map_err(caught)?;
    events::publish("invalidate", &[]).await;
    let mut out = Map::new();
    out.insert("idea".into(), to_value(&read(&session, &idea).await?)?);
    out.insert("ticket".into(), to_value(&TicketRead::from_ticket(ticket)?)?);
    Ok((StatusCode::CREATED, Json(out)))
}

/// `model.model_dump()`.
pub(super) fn to_value<T: serde::Serialize>(model: &T) -> ApiResult<Value> {
    Ok(serde_json::to_value(model)?)
}

/// Answer "validated or disproved?" after a test ticket was closed.
async fn post_resolve(
    Path((idea_id, assumption_id)): Path<(String, String)>,
    Body(body): Body<ResolveBody>,
) -> ApiResult<Json<IdeaTicketRead>> {
    let session = kb_db::session();
    need_edit(&session, &idea_id).await?;
    let idea = space::resolve_assumption(&session, &idea_id, &assumption_id, body.outcome.as_str(), Some(&actor()))
        .await
        .map_err(caught)?;
    done(&session, &idea).await
}

// ── evidence ───────────────────────────────────────────────────────────────

/// The Evidence tab: each piece once with the assumptions it supports.
async fn get_evidence(Path(idea_id): Path<String>) -> ApiResult<Json<Vec<Map<String, Value>>>> {
    let session = kb_db::session();
    let idea = space::get_or_raise(&session, &idea_id).await.map_err(caught)?;
    Ok(Json(space::list_evidence(&idea)))
}

/// Attach evidence to assumptions.
async fn post_evidence(
    Path(idea_id): Path<String>,
    Body(body): Body<EvidenceBody>,
) -> ApiResult<(StatusCode, Json<IdeaTicketRead>)> {
    let session = kb_db::session();
    need_edit(&session, &idea_id).await?;
    let idea = space::add_evidence(
        &session,
        &idea_id,
        &body.assumption_ids,
        body.kind.as_str(),
        &body.reference,
        &body.title,
        Some(&actor()),
    )
    .await
    .map_err(caught)?;
    events::publish("invalidate", &[]).await;
    Ok((StatusCode::CREATED, Json(read(&session, &idea).await?)))
}

/// Remove a piece of evidence.
async fn del_evidence(Path((idea_id, evidence_id)): Path<(String, String)>) -> ApiResult<Json<IdeaTicketRead>> {
    let session = kb_db::session();
    need_edit(&session, &idea_id).await?;
    let idea = space::delete_evidence(&session, &idea_id, &evidence_id, Some(&actor())).await.map_err(caught)?;
    done(&session, &idea).await
}
