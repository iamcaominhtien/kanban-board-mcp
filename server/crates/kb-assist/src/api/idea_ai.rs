//! `api/idea_ai.py`: the AI helpers of the Idea Space (AI v2: turns of the Idea assistant with a skill): status and
//! switches, triage advice, Shape with AI, Ask, Prepare a ticket and the grooming digest. Nothing is applied for the
//! person.

use axum::Json;
use axum::http::StatusCode;
use kb_base::activity::{self, AGENT_ACTOR, HUMAN_ACTOR};
use kb_base::error::{Body, Path, Query};
use kb_base::{ApiError, Routes};
use kb_db::Session;
use kb_db::entities::{idea_ticket, member};
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use kb_doctext::docs_access::role_in;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::api::{Failure, Res, assist_error, put, sent};
use crate::assistant::ideas::{self as idea_ai, Error, IdeaAiError};

/// The routes of this file (`prefix="/api/idea-ai"`).
pub fn routes() -> Routes {
    Routes::new()
        .get("/api/idea-ai/status", get_status)
        .get("/api/idea-ai/settings", get_settings_route)
        .put("/api/idea-ai/settings", put_settings)
        .post("/api/idea-ai/advice", post_advice)
        .get("/api/idea-ai/advice", get_advice)
        .post("/api/idea-ai/advice/{advice_id}/state", post_advice_state)
        .post("/api/idea-ai/ask", post_ask)
        .post("/api/idea-ai/shape", post_shape)
        .post("/api/idea-ai/shape/{request_id}/stop", post_shape_stop)
        .post("/api/idea-ai/prepare-ticket", post_prepare_ticket)
        .get("/api/idea-ai/digest", get_digest)
        .post("/api/idea-ai/digest/run", post_digest_run)
}

/// `_fail(status, code, message)`: an `HTTPException` whose detail is `{code, message}`.
fn fail(status: u16, code: &str, message: &str) -> Failure {
    Failure::Api(ApiError::code(status, json!({"code": code, "message": message})))
}

/// `_ai_error(exc)`.
fn ai_error(exc: &IdeaAiError) -> Failure {
    fail(if exc.code == "not_found" { 404 } else { 409 }, &exc.code, &exc.message)
}

/// What an uncaught failure of the Idea AI is: `IdeaAiError` is caught by the routes that say so, an `AssistError`
/// has a handler in the app, anything else is a 500.
fn uncaught(err: Error) -> Failure {
    match err {
        Error::Idea(e) => ai_error(&e),
        Error::Assist(e) => assist_error(&e),
        Error::Db(e) => e.into(),
        other @ (Error::Value(_) | Error::Other(_)) => Failure::Api(ApiError::internal(other)),
    }
}

/// Only members can ask the AI; viewers can still read what was suggested.
async fn need_member(session: &Session, project_id: Option<&str>) -> Res<()> {
    let actor = activity::current_actor();
    let Some(project_id) = project_id else { return Ok(()) };
    if actor == HUMAN_ACTOR || actor == AGENT_ACTOR {
        return Ok(());
    }
    let rows = member::Entity::find().filter(member::Column::ProjectId.eq(project_id)).all(session).await?;
    let role = role_in(&rows, &actor);
    if role != "member" && role != "admin" {
        return Err(fail(403, "not_member", "Only members can ask the AI. You can still read what it suggested."));
    }
    Ok(())
}

async fn need_admin(session: &Session, project_id: Option<&str>) -> Res<()> {
    let actor = activity::current_actor();
    let Some(project_id) = project_id else { return Ok(()) };
    if actor == HUMAN_ACTOR {
        return Ok(());
    }
    let rows = member::Entity::find().filter(member::Column::ProjectId.eq(project_id)).all(session).await?;
    if role_in(&rows, &actor) != "admin" {
        return Err(fail(403, "read_only", "Only project admins change the AI settings."));
    }
    Ok(())
}

fn obj(map: Map<String, Value>) -> Res<Json<Value>> {
    Ok(Json(Value::Object(map)))
}

/// A 422 of one field, as Pydantic words it.
fn invalid(loc: &[&str], msg: &str, kind: &str) -> Failure {
    Failure::Api(ApiError::validation(loc, msg, kind))
}

/// A `Literal[...]` field that holds none of the allowed words.
fn literal(value: &str, allowed: &[&str], field: &str) -> Res<()> {
    if allowed.contains(&value) {
        return Ok(());
    }
    let quoted: Vec<String> = allowed.iter().map(|a| format!("'{a}'")).collect();
    let msg = match quoted.split_last() {
        Some((last, rest)) if !rest.is_empty() => format!("Input should be {} or {last}", rest.join(", ")),
        _ => format!("Input should be {}", quoted.join("")),
    };
    Err(invalid(&["body", field], &msg, "literal_error"))
}

/// A `str` with `min_length` / `max_length` (characters).
fn length(value: &str, min: usize, max: usize, field: &str) -> Res<()> {
    let n = value.chars().count();
    if n < min {
        let msg = format!("String should have at least {min} character{}", if min == 1 { "" } else { "s" });
        return Err(invalid(&["body", field], &msg, "string_too_short"));
    }
    if n > max {
        return Err(invalid(
            &["body", field],
            &format!("String should have at most {max} characters"),
            "string_too_long",
        ));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct ProjectQuery {
    project_id: Option<String>,
}

/// Whether AI help is available for the project (or for ideas with no project), and why not.
async fn get_status(Query(q): Query<ProjectQuery>) -> Res<Json<Value>> {
    let session = kb_db::session();
    obj(idea_ai::status(&session, q.project_id.as_deref()).await.map_err(uncaught)?)
}

/// Switches of the AI helpers; omitted values stay as they are.
#[derive(Debug, Deserialize)]
struct SettingsBody {
    #[serde(default, deserialize_with = "sent")]
    enabled: Option<Option<bool>>,
    #[serde(default, deserialize_with = "sent")]
    triage_advice: Option<Option<bool>>,
    #[serde(default, deserialize_with = "sent")]
    weekly_grooming: Option<Option<bool>>,
    #[serde(default, deserialize_with = "sent")]
    ask: Option<Option<bool>>,
    #[serde(default, deserialize_with = "sent")]
    read_docs: Option<Option<bool>>,
    #[serde(default, deserialize_with = "sent")]
    read_repo: Option<Option<bool>>,
    #[serde(default, deserialize_with = "sent")]
    daily_cap: Option<Option<f64>>,
}

/// The AI settings and whether the assistant can answer.
async fn get_settings_route(Query(q): Query<ProjectQuery>) -> Res<Json<Value>> {
    let session = kb_db::session();
    obj(idea_ai::status(&session, q.project_id.as_deref()).await.map_err(uncaught)?)
}

/// Change the AI switches of a project (admins).
async fn put_settings(Query(q): Query<ProjectQuery>, Body(body): Body<SettingsBody>) -> Res<Json<Value>> {
    if let Some(Some(cap)) = body.daily_cap {
        if cap <= 0.0 {
            return Err(invalid(&["body", "daily_cap"], "Input should be greater than 0", "greater_than"));
        }
        if cap > 1000.0 {
            return Err(invalid(
                &["body", "daily_cap"],
                "Input should be less than or equal to 1000",
                "less_than_equal",
            ));
        }
    }
    let session = kb_db::session();
    need_admin(&session, q.project_id.as_deref()).await?;
    let mut values = Map::new();
    put(&mut values, "enabled", &body.enabled);
    put(&mut values, "triage_advice", &body.triage_advice);
    put(&mut values, "weekly_grooming", &body.weekly_grooming);
    put(&mut values, "ask", &body.ask);
    put(&mut values, "read_docs", &body.read_docs);
    put(&mut values, "read_repo", &body.read_repo);
    put(&mut values, "daily_cap", &body.daily_cap);
    idea_ai::update_settings(&session, q.project_id.as_deref(), &values).await?;
    obj(idea_ai::status(&session, q.project_id.as_deref()).await.map_err(uncaught)?)
}

/// Ask for triage advice on Inbox ideas.
#[derive(Debug, Deserialize)]
struct AdviceBody {
    idea_ids: Vec<String>,
}

/// `_ERROR_TEXT.get(code, ...)`.
fn error_text(code: &str) -> &'static str {
    match code {
        "not_member" => "Only members of the project can ask for advice.",
        "failed" => "The AI could not answer. Try again.",
        "bad_answer" => "The AI gave an answer that could not be used.",
        _ => "The AI could not finish this idea.",
    }
}

/// Read the ideas and suggest Keep, Park, Merge or Archive for each. Nothing is applied. An idea the AI is not sure
/// about gets no advice (it is listed in `none`).
async fn post_advice(Body(body): Body<AdviceBody>) -> Res<Json<Value>> {
    let n = body.idea_ids.len();
    if n < 1 {
        return Err(invalid(
            &["body", "idea_ids"],
            "List should have at least 1 item after validation, not 0",
            "too_short",
        ));
    }
    if n > 30 {
        return Err(invalid(
            &["body", "idea_ids"],
            &format!("List should have at most 30 items after validation, not {n}"),
            "too_long",
        ));
    }
    let session = kb_db::session();
    let mut none: Vec<Value> = Vec::new();
    let mut errors: Vec<Value> = Vec::new();
    for idea_id in &body.idea_ids {
        let Some(idea) = idea_ticket::Entity::find_by_id(idea_id.as_str()).one(&session).await? else {
            errors.push(json!({"idea_id": idea_id, "code": "not_found", "message": "Idea not found"}));
            continue;
        };
        need_member(&session, idea.project_id.as_deref()).await?;
        match idea_ai::advise(&session, idea_id, &activity::current_actor()).await {
            Ok(Some(_)) => {}
            Ok(None) => none.push(json!(idea_id)),
            Err(Error::Idea(exc)) => {
                if ["off", "no_member", "unavailable", "cap"].contains(&exc.code.as_str()) {
                    // nothing else can work either
                    return Err(ai_error(&exc));
                }
                errors.push(json!({"idea_id": idea_id, "code": exc.code, "message": error_text(&exc.code)}));
            }
            Err(other) => return Err(uncaught(other)),
        }
    }
    let advice = idea_ai::advice_for(&session, &body.idea_ids, false).await?;
    Ok(Json(json!({"advice": advice, "none": none, "errors": errors})))
}

#[derive(Debug, Deserialize)]
struct AdviceQuery {
    idea_ids: Vec<String>,
    #[serde(default)]
    include_none: Option<String>,
}

/// Open advice for the ideas, each marked `stale` when the idea changed after the AI read it.
async fn get_advice(Query(q): Query<AdviceQuery>) -> Res<Json<Value>> {
    let include_none = match q.include_none.as_deref().map(str::to_lowercase).as_deref() {
        None => false,
        Some("1" | "true" | "t" | "yes" | "y" | "on") => true,
        Some("0" | "false" | "f" | "no" | "n" | "off") => false,
        Some(_) => {
            return Err(Failure::Api(ApiError::validation(
                &["query", "include_none"],
                "Input should be a valid boolean, unable to interpret input",
                "bool_parsing",
            )));
        }
    };
    let session = kb_db::session();
    Ok(Json(Value::Array(idea_ai::advice_for(&session, &q.idea_ids, include_none).await?)))
}

/// What happened to a piece of advice.
#[derive(Debug, Deserialize)]
struct AdviceState {
    state: String,
}

/// Mark advice accepted or ignored (the person did the move themselves).
async fn post_advice_state(Path(advice_id): Path<String>, Body(body): Body<AdviceState>) -> Res<Json<Value>> {
    literal(&body.state, &["accepted", "ignored"], "state")?;
    let session = kb_db::session();
    match idea_ai::set_advice_state(&session, &advice_id, &body.state).await {
        Ok(a) => Ok(Json(json!({"id": a.id, "state": a.state}))),
        Err(Error::Value(message)) => Err(fail(404, "not_found", &message)),
        Err(other) => Err(uncaught(other)),
    }
}

/// A question about the ideas in view.
#[derive(Debug, Deserialize)]
struct AskBody {
    question: String,
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default = "project_scope")]
    scope: String,
}

fn project_scope() -> String {
    "project".to_string()
}

/// Ask about ideas ("what should we test next?"). The answer lists the ideas it used.
async fn post_ask(Body(body): Body<AskBody>) -> Res<Json<Value>> {
    length(&body.question, 1, 1000, "question")?;
    literal(&body.scope, &["project", "all", "none"], "scope")?;
    let session = kb_db::session();
    need_member(&session, body.project_id.as_deref()).await?;
    let has_project = body.project_id.as_deref().is_some_and(|p| !p.is_empty());
    let scope = if has_project || body.scope != "project" { body.scope.as_str() } else { "all" };
    let out = idea_ai::ask(&session, &body.question, body.project_id.as_deref(), scope, &activity::current_actor())
        .await
        .map_err(uncaught)?;
    obj(out)
}

/// What to help with on an idea page.
#[derive(Debug, Deserialize)]
struct ShapeBody {
    idea_id: String,
    kind: String,
    #[serde(default)]
    question: Option<String>,
    #[serde(default)]
    request_id: Option<String>,
}

/// Draft the problem, assumptions, cheapest tests, an effort guess, what already exists, or an answer. The drafts come
/// back; a person adds each one (with the AI chip) from the page.
async fn post_shape(Body(body): Body<ShapeBody>) -> Res<Json<Value>> {
    literal(&body.kind, &["problem", "assumptions", "tests", "effort", "exists", "ask"], "kind")?;
    if let Some(q) = &body.question {
        if q.chars().count() > 1000 {
            return Err(invalid(
                &["body", "question"],
                "String should have at most 1000 characters",
                "string_too_long",
            ));
        }
    }
    if let Some(r) = &body.request_id {
        length(r, 8, 64, "request_id")?;
    }
    let session = kb_db::session();
    let Some(idea) = idea_ticket::Entity::find_by_id(body.idea_id.as_str()).one(&session).await? else {
        return Err(fail(404, "not_found", &format!("Idea ticket '{}' not found", body.idea_id)));
    };
    need_member(&session, idea.project_id.as_deref()).await?;
    let person = activity::current_actor();
    let (idea_id, kind, question) = (body.idea_id.clone(), body.kind.clone(), body.question.clone());
    let run = async move {
        let session = kb_db::session();
        idea_ai::shape(&session, &idea_id, &kind, question.as_deref(), &person).await
    };
    match idea_ai::run_stoppable(body.request_id.as_deref(), run).await {
        Ok(out) => obj(out),
        Err(Error::Idea(exc)) => Err(ai_error(&exc)),
        // `except ValueError`: an `AssistError` is one
        Err(Error::Value(message)) => Err(fail(400, "invalid", &message)),
        Err(Error::Assist(exc)) => Err(fail(400, "invalid", &exc.message)),
        Err(other) => Err(uncaught(other)),
    }
}

/// Stop a running shape request. `stopped` is false when it had already ended.
async fn post_shape_stop(Path(request_id): Path<String>) -> Json<Value> {
    Json(json!({"stopped": idea_ai::stop_shape(&request_id)}))
}

/// The idea to prepare a ticket from.
#[derive(Debug, Deserialize)]
struct PrepareBody {
    idea_id: String,
}

/// Draft the ticket text, acceptance criteria and a split for the Promote dialog.
async fn post_prepare_ticket(Body(body): Body<PrepareBody>) -> Res<Json<Value>> {
    let session = kb_db::session();
    let Some(idea) = idea_ticket::Entity::find_by_id(body.idea_id.as_str()).one(&session).await? else {
        return Err(fail(404, "not_found", &format!("Idea ticket '{}' not found", body.idea_id)));
    };
    need_member(&session, idea.project_id.as_deref()).await?;
    obj(idea_ai::prepare_ticket(&session, &body.idea_id, &activity::current_actor()).await.map_err(uncaught)?)
}

/// The newest grooming digest. A digest is not a notification: nobody is pinged.
async fn get_digest(Query(q): Query<ProjectQuery>) -> Res<Json<Value>> {
    let session = kb_db::session();
    match idea_ai::latest_digest(&session, q.project_id.as_deref()).await? {
        Some(d) => obj(idea_ai::digest_out(&d)),
        None => Ok(Json(Value::Null)),
    }
}

/// Which project's digest to write now.
#[derive(Debug, Deserialize)]
struct DigestBody {
    #[serde(default)]
    project_id: Option<String>,
}

/// Write the digest now (members).
async fn post_digest_run(Body(body): Body<DigestBody>) -> Res<(StatusCode, Json<Value>)> {
    let session = kb_db::session();
    need_member(&session, body.project_id.as_deref()).await?;
    let digest =
        idea_ai::groom(&session, body.project_id.as_deref(), &activity::current_actor()).await.map_err(uncaught)?;
    Ok((StatusCode::CREATED, Json(Value::Object(idea_ai::digest_out(&digest)))))
}
