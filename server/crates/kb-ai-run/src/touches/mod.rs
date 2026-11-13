//! You stepped in (design/screens/ai-team-review.md, A; AI v2): every time a person had to touch the work of the
//! project's AI teams, and whether the touch was needed (`services/ai/touches.py`).
//!
//! Nothing here is stored per touch. A touch is worked out, newest first, from what the board already keeps:
//!
//! - an answer to a team's question: the run's question and answer;
//! - a run started by hand (the Run button): `ai_run.trigger` and `started_by`;
//! - a run stopped by a person or retried by one: `ended_by` (no stop code) and the `retry` trigger;
//! - a message to a lead that is working: `ai_run_message` (direction in; `/compact` is a command and a message that
//!   only started a new run are not touches);
//! - a ticket edited while a run works on it, an account signed in again, a team (or the whole project) paused and
//!   resumed: audit entries written when the action happens (`record_edit`, `record_signin`, and the pause routes).
//!
//! The only thing stored is the mark a person gives to a touch (`ai_touch_mark`), under the touch's stable key, so a
//! clean-up of runs or of the audit log never takes a mark with it. Approvals and a status ceiling do not exist in AI
//! v2, so no touch is "by rule" yet: the tab has no such mark until a rule exists.
//!
//! The Python module is one file; here it is this file (lines 1 to 286 and 632 to 774: the constants, recording,
//! `carry_answer`, `answers_of`, the marks and the lessons) and `collect` (289 to 629: `collect` and `stepped_in`).
//! Every name of the Python module is `touches::<name>` here too.

use std::collections::HashSet;

use chrono::{DateTime, Duration, FixedOffset, Utc};
use kb_ai::audit;
use kb_ai::store::{active_runs, ai_names, loads, now_iso, parse_iso};
use kb_ai_know::knowledge;
use kb_base::{pyjson, pytext};
use kb_db::Session;
use kb_db::entities::{ai_account, ai_audit, ai_run, ai_team, ai_touch_mark, member};
use kb_db::sea_orm::sea_query::Expr;
use kb_db::sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, ModelTrait, QueryFilter, QueryOrder,
    QuerySelect, SqlErr,
};
use serde_json::{Map, Value, json};

use crate::clock;

mod collect;

pub use collect::*;

/// The ranges of the tab and their days.
pub const RANGES: [(&str, i64); 4] = [("24h", 1), ("7d", 7), ("30d", 30), ("90d", 90)];
/// The range of a request that names none (or one that does not exist).
pub const DEFAULT_RANGE: &str = "7d";
/// The marks a person can give to a touch.
pub const MARKS: [&str; 2] = ["needed", "avoidable"];
/// The most touches the tab lists.
pub const LIMIT: usize = 500;
/// The longest lesson Memory keeps (characters).
pub const LESSON_MAX: usize = 600;

/// The kinds of touch and what the tab calls them, in the order of the tab.
pub const KINDS: [(&str, &str); 8] = [
    ("answer", "Answered a team's question"),
    ("run_by_hand", "Started a run by hand"),
    ("stop", "Stopped a run"),
    ("retry", "Retried a run"),
    ("message", "Sent a message to the lead"),
    ("edit", "Edited a ticket while a run worked on it"),
    ("signin", "Signed an account in again"),
    ("pause", "Paused or resumed"),
];

/// Names the board uses for itself: what they did is not a person stepping in
pub const MACHINE: [&str; 9] = ["board", "system", "schedule", "scheduler", "runner", "auto", "github", "api", ""];

/// Audit actions written for touches that no other table keeps
pub const EDIT_ACTION: &str = "ticket_edited_during_run";
/// The audit action of a sign-in a person opened.
pub const SIGNIN_ACTION: &str = "account_signin";
/// The audit actions of a pause and of its end, of a team and of the whole project.
pub const PAUSE_ACTIONS: [&str; 4] = ["team_paused", "team_resumed", "project_paused", "project_resumed"];
/// the lesson_id of a touch while its lesson is being made (a second request finds the touch taken)
pub const CLAIMED: &str = "pending";
/// The states of a run that is over, for a message sent to it.
pub const RUN_ENDED: [&str; 4] = ["finished", "failed", "cancelled", "timed_out"];
/// a stop that comes with a pause or a removal of the team by the same person is part of it, not a touch of its own
pub const STOP_WITH_PAUSE_S: i64 = 60;
/// typing in the description saves again and again: one touch per run per five minutes
pub const EDIT_COALESCE_S: f64 = 300.0;

/// The label of a kind of touch (`KINDS[kind]`).
pub fn kind_label(kind: &str) -> Option<&'static str> {
    KINDS.iter().find(|(key, _)| *key == kind).map(|(_, label)| *label)
}

/// `str(value)` of a JSON value.
pub(crate) fn text_of(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => pyjson::py_str(other),
    }
}

/// `(b - a).total_seconds()`.
pub(crate) fn seconds_between(a: &DateTime<FixedOffset>, b: &DateTime<FixedOffset>) -> f64 {
    let delta = b.signed_duration_since(a);
    delta.num_microseconds().map_or_else(|| delta.num_milliseconds() as f64 / 1e3, |us| us as f64 / 1e6)
}

/// Whether this actor name is a person (not the board, a schedule or one of the project's AIs).
pub fn is_person(name: Option<&str>, ai: Option<&HashSet<String>>) -> bool {
    let n = pytext::strip(name.unwrap_or(""));
    !n.is_empty() && !MACHINE.contains(&n.to_lowercase().as_str()) && !ai.is_some_and(|ai| ai.contains(n))
}

/// `_clip`: the text on one line, cut to `n` characters with an ellipsis (Python's default `n`: 160).
pub fn clip(text: Option<&str>, n: usize) -> String {
    let t = pytext::squash(text.unwrap_or(""));
    let count = t.chars().count();
    if count <= n {
        return t;
    }
    // `t[: n - 1]`: with `n` 0 the slice ends one character before the end
    let keep = if n == 0 { count - 1 } else { n - 1 };
    let mut out: String = t.chars().take(keep).collect();
    out.push('…');
    out
}

/// The start of a range ("24h", "7d", "30d", "90d"; anything else is the default).
pub fn since_of(range_key: &str, now: Option<DateTime<Utc>>) -> DateTime<Utc> {
    let days_of = |key: &str| RANGES.iter().find(|(k, _)| *k == key).map(|(_, days)| *days);
    let days = days_of(range_key).or_else(|| days_of(DEFAULT_RANGE)).unwrap_or(7);
    now.unwrap_or_else(clock::now) - Duration::days(days)
}

// --------------------------------------------------------------------------- recording

/// A person edited a ticket while a run was on it: one audit entry per such run (coalesced), written when it
/// happens. Returns how many were written. (`what` empty: "the ticket".)
pub async fn record_edit(session: &Session, ticket_id: &str, by: Option<&str>, what: &str) -> Result<i64, DbErr> {
    let runs: Vec<ai_run::Model> = active_runs(session, None, Some(ticket_id))
        .await?
        .into_iter()
        .filter(|r| matches!(r.state.as_str(), "starting" | "running" | "needs_input") && r.kind == "team")
        .collect();
    let Some(first) = runs.first() else { return Ok(0) };
    if !is_person(by, Some(&ai_names(session, &first.project_id).await?)) {
        return Ok(0);
    }
    let mut written = 0;
    let now = clock::now().fixed_offset();
    for r in &runs {
        let last = ai_audit::Entity::find()
            .filter(ai_audit::Column::RunId.eq(r.id.as_str()))
            .filter(ai_audit::Column::Action.eq(EDIT_ACTION))
            .order_by_desc(ai_audit::Column::Seq)
            .limit(1)
            .one(session)
            .await?;
        if let Some(last) = &last {
            let when = parse_iso(Some(&last.created_at));
            if when.is_some_and(|when| seconds_between(&when, &now) < EDIT_COALESCE_S)
                && last.on_behalf_of.as_deref() == by
            {
                continue;
            }
        }
        let who = member::Entity::find_by_id(r.member_id.as_str()).one(session).await?;
        let mut detail = Map::new();
        detail.insert("what".into(), json!(if what.is_empty() { "the ticket" } else { what }));
        audit::record(
            &r.project_id,
            EDIT_ACTION,
            "info",
            audit::Entry {
                member_id: Some(r.member_id.clone()),
                member_name: who.map(|m| m.name).unwrap_or_default(),
                on_behalf_of: by.map(str::to_string),
                run_id: Some(r.id.clone()),
                target: Some(ticket_id.to_string()),
                detail,
            },
        )
        .await?;
        written += 1;
    }
    Ok(written)
}

/// A person opened the sign-in of an AI account: one audit entry per project whose teams run as this account.
/// Returns how many were written (a note about the sign-in must never fail the sign-in: 0 when it could not be
/// written).
pub async fn record_signin(session: &Session, account: &ai_account::Model, by: &str) -> i64 {
    let written = async {
        let teams =
            ai_team::Entity::find().filter(ai_team::Column::AccountId.eq(account.id.as_str())).all(session).await?;
        let mut by_project: Vec<(String, Vec<String>)> = Vec::new();
        for t in teams {
            match by_project.iter_mut().find(|(project_id, _)| *project_id == t.project_id) {
                Some((_, ids)) => ids.push(t.id),
                None => by_project.push((t.project_id, vec![t.id])),
            }
        }
        for (project_id, team_ids) in &by_project {
            let mut detail = Map::new();
            detail.insert("account".into(), json!(account.name));
            detail.insert("account_id".into(), json!(account.id));
            detail.insert("team_ids".into(), json!(team_ids));
            audit::record(
                project_id,
                SIGNIN_ACTION,
                "info",
                audit::Entry { on_behalf_of: Some(by.to_string()), detail, ..Default::default() },
            )
            .await?;
        }
        Ok::<i64, DbErr>(by_project.len() as i64)
    };
    match written.await {
        Ok(n) => n,
        Err(err) => {
            tracing::error!(target: "kanban.ai.touches", "Could not record the sign-in of {} as a touch: {err}", account.id);
            0
        }
    }
}

/// The whole project's AI was paused or resumed by a person (the teams' own pauses are recorded by `teams`). The
/// audit entry must never undo the pause: a failure is logged.
pub async fn record_pause(project_id: &str, action: &str, by: &str, detail: Option<Map<String, Value>>) {
    let entry =
        audit::Entry { on_behalf_of: Some(by.to_string()), detail: detail.unwrap_or_default(), ..Default::default() };
    if let Err(err) = audit::record(project_id, action, "info", entry).await {
        tracing::error!(target: "kanban.ai.touches", "Could not record {action} as a touch: {err}");
    }
}

/// `loads(text, {}) or {}` as an object.
pub(crate) fn object_of(text: Option<&str>) -> Map<String, Value> {
    match loads(text, json!({})) {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// The answered questions of a run to keep when it asks a new one (a run holds one question; the earlier ones, with
/// their answers, move to `previous` so each answer stays a touch).
pub fn carry_answer(question_json: Option<&str>, answer: Option<&str>) -> Vec<Value> {
    let old = object_of(question_json);
    let mut previous: Vec<Value> = match old.get("previous") {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    };
    let answered_at = old.get("answered_at").filter(|v| pyjson::truthy(v));
    if let (Some(answer), Some(answered_at)) = (answer.filter(|a| !a.is_empty()), answered_at) {
        previous.push(json!({
            "text": old.get("text").cloned().unwrap_or_else(|| json!("")),
            "answer": answer,
            "answered_at": answered_at,
            "answered_by": old.get("answered_by").cloned().unwrap_or(Value::Null),
        }));
    }
    let from = previous.len().saturating_sub(20);
    previous.split_off(from)
}

/// Every answered question of a run, oldest first: `{text, answer, at, by, index}`.
pub fn answers_of(r: &ai_run::Model) -> Vec<Map<String, Value>> {
    let q = object_of(r.question.as_deref());
    let mut pairs: Vec<Map<String, Value>> = Vec::new();
    if let Some(Value::Array(previous)) = q.get("previous") {
        for p in previous {
            let Value::Object(p) = p else { continue };
            let mut pair = Map::new();
            pair.insert("text".into(), p.get("text").cloned().unwrap_or_else(|| json!("")));
            pair.insert("answer".into(), p.get("answer").cloned().unwrap_or_else(|| json!("")));
            pair.insert("at".into(), p.get("answered_at").cloned().unwrap_or(Value::Null));
            pair.insert("by".into(), p.get("answered_by").cloned().unwrap_or(Value::Null));
            pairs.push(pair);
        }
    }
    let answered_at = q.get("answered_at").filter(|v| pyjson::truthy(v));
    if let (Some(answer), Some(answered_at)) = (r.answer.as_deref().filter(|a| !a.is_empty()), answered_at) {
        let mut pair = Map::new();
        pair.insert("text".into(), q.get("text").cloned().unwrap_or_else(|| json!("")));
        pair.insert("answer".into(), json!(answer));
        pair.insert("at".into(), answered_at.clone());
        pair.insert("by".into(), q.get("answered_by").cloned().unwrap_or(Value::Null));
        pairs.push(pair);
    }
    for (i, pair) in pairs.iter_mut().enumerate() {
        pair.insert("index".into(), json!(i));
    }
    pairs
}

// --------------------------------------------------------------------------- marks and lessons

/// What a function of this module fails with.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// `TouchError` (a `ValueError`): the mark or lesson could not be set.
    #[error("{0}")]
    Touch(String),
    /// The database call failed.
    #[error(transparent)]
    Db(#[from] DbErr),
    /// Anything Python lets through as a 500.
    #[error("{0}")]
    Other(String),
}

fn refuse<T>(message: impl Into<String>) -> Result<T, Error> {
    Err(Error::Touch(message.into()))
}

/// `_find`: the touch with this key, read from the rows it comes from (any age).
async fn find(session: &Session, project_id: &str, key: &str) -> Result<Map<String, Value>, Error> {
    for t in collect(session, project_id, since_of("90d", None), Some(key)).await? {
        if t.get("id").and_then(Value::as_str) == Some(key) {
            return Ok(t);
        }
    }
    refuse("This touch is no longer in the list.")
}

fn mark_dict(key: &str, row: Option<&ai_touch_mark::Model>) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("id".into(), json!(key));
    out.insert("mark".into(), json!(row.map(|r| r.mark.as_str())));
    out.insert("marked_by".into(), json!(row.and_then(|r| r.marked_by.as_deref())));
    out.insert("marked_at".into(), json!(row.map(|r| r.marked_at.as_str())));
    out.insert("lesson_id".into(), json!(row.and_then(|r| r.lesson_id.as_deref())));
    out
}

async fn remark(
    session: &Session,
    row: ai_touch_mark::Model,
    mark: &str,
    by: &str,
) -> Result<ai_touch_mark::Model, DbErr> {
    let mut row = kb_db::edit(row);
    row.mark = Set(mark.to_string());
    row.marked_by = Set(Some(by.to_string()));
    row.marked_at = Set(now_iso());
    row.update(session).await
}

/// Give a touch the mark needed or avoidable, or take it away (mark None). The mark stays.
pub async fn set_mark(
    session: &Session,
    project_id: &str,
    key: &str,
    mark: Option<&str>,
    by: &str,
) -> Result<Map<String, Value>, Error> {
    if mark.is_some_and(|m| !MARKS.contains(&m)) {
        return refuse("A mark is “needed” or “avoidable”.");
    }
    let row = ai_touch_mark::Entity::find_by_id(key).one(session).await?;
    if row.as_ref().is_some_and(|r| r.project_id != project_id) {
        return refuse("This touch belongs to another project.");
    }
    let Some(mark) = mark else {
        if row.as_ref().is_some_and(|r| r.lesson_id.as_deref().is_some_and(|l| !l.is_empty())) {
            return refuse("A lesson was made from this touch: its mark stays.");
        }
        if let Some(row) = row {
            row.delete(session).await?;
            session.commit().await?;
        }
        return Ok(mark_dict(key, None));
    };
    let saved = match row {
        None => {
            find(session, project_id, key).await?; // only a touch of the list can be marked
            let mut new = ai_touch_mark::new();
            new.key = Set(key.to_string());
            new.project_id = Set(project_id.to_string());
            new.mark = Set(mark.to_string());
            new.marked_by = Set(Some(by.to_string()));
            new.insert(session).await
        }
        Some(row) => remark(session, row, mark, by).await,
    };
    let saved = match saved {
        Ok(row) => session.commit().await.map(|()| row),
        Err(err) => Err(err),
    };
    let row = match saved {
        Ok(row) => row,
        // two first marks of the same touch at once: the later one updates the earlier
        Err(err) if matches!(err.sql_err(), Some(SqlErr::UniqueConstraintViolation(_))) => {
            session.rollback().await?;
            let Some(row) = ai_touch_mark::Entity::find_by_id(key).one(session).await? else {
                return refuse("Could not save the mark. Try again.");
            };
            let row = remark(session, row, mark, by).await?;
            session.commit().await?;
            row
        }
        Err(err) => return Err(err.into()),
    };
    Ok(mark_dict(key, Some(&row)))
}

/// A starting sentence for the lesson a person writes from an avoidable touch.
///
/// It always ends with "Next time, do this without a person."; when the whole is too long the details are
/// shortened.
pub fn draft_lesson(touch: &Map<String, Value>) -> String {
    let ticket = match touch.get("ticket_id").filter(|v| pyjson::truthy(v)) {
        Some(id) => format!(" on {}", text_of(id)),
        None => String::new(),
    };
    let head = format!("{}{ticket}: ", touch.get("label").map(text_of).unwrap_or_default());
    let tail = " Next time, do this without a person.";
    let details = match touch.get("details").filter(|v| pyjson::truthy(v)) {
        Some(value) => text_of(value),
        None => String::new(),
    };
    let mut details = pytext::squash(&details);
    let room = LESSON_MAX as i64 - head.chars().count() as i64 - tail.chars().count() as i64 - 1; // one for the full stop
    if details.chars().count() as i64 > room {
        let keep: String = details.chars().take((room - 1).max(0) as usize).collect();
        details = format!("{}…", keep.trim_end_matches(pytext::is_space));
    }
    if details.chars().last().is_some_and(|last| !".!?…".contains(last)) {
        details.push('.');
    }
    format!("{head}{details}{tail}")
}

async fn set_lesson(session: &Session, key: &str, lesson_id: Option<&str>, only_free: bool) -> Result<u64, DbErr> {
    let mut stmt = ai_touch_mark::Entity::update_many()
        .col_expr(ai_touch_mark::Column::LessonId, Expr::value(lesson_id.map(str::to_string)))
        .filter(ai_touch_mark::Column::Key.eq(key));
    if only_free {
        stmt = stmt.filter(ai_touch_mark::Column::LessonId.is_null());
    }
    let done = stmt.exec(session).await?;
    session.commit().await?;
    Ok(done.rows_affected)
}

/// “Make a lesson” on an avoidable touch: a proposed lesson in Memory, linked to the touch.
pub async fn make_lesson(
    session: &Session,
    project_id: &str,
    key: &str,
    text: Option<&str>,
    by: &str,
) -> Result<Map<String, Value>, Error> {
    let touch = find(session, project_id, key).await?;
    if touch.get("mark").and_then(Value::as_str) != Some("avoidable") {
        return refuse("Mark the touch Avoidable first.");
    }
    if touch.get("lesson_id").is_some_and(pyjson::truthy) {
        return refuse("A lesson was already made from this touch.");
    }
    let given = pytext::strip(text.unwrap_or(""));
    let body = if given.is_empty() { draft_lesson(&touch) } else { given.to_string() };
    // Memory keeps 600 characters of a lesson: say so instead of dropping the end without a word
    if pytext::squash(&body).chars().count() > LESSON_MAX {
        return refuse(format!("The lesson is limited to {LESSON_MAX} characters."));
    }
    // claim the touch first, in one statement: a second request at the same time finds it taken
    if set_lesson(session, key, Some(CLAIMED), true).await? == 0 {
        return refuse("A lesson was already made from this touch.");
    }
    let added = knowledge::add_lesson(
        session,
        project_id,
        &body,
        by,
        knowledge::LessonOpts {
            state: "proposed",
            source_ticket_id: touch.get("ticket_id").and_then(Value::as_str),
            source_run_id: touch.get("run_id").and_then(Value::as_str),
            proposed_by: Some(by),
        },
    )
    .await;
    // (Python's `finally`: the claim is released, or replaced by the lesson, whatever `add_lesson` did)
    let lesson = added.as_ref().ok().and_then(|lesson| lesson.as_ref());
    set_lesson(session, key, lesson.map(|l| l.id.as_str()), false).await?;
    let lesson = match added {
        Ok(lesson) => lesson,
        Err(knowledge::Error::Db(err)) => return Err(Error::Db(err)),
        Err(other) => return Err(Error::Other(other.to_string())),
    };
    let Some(lesson) = lesson else {
        return refuse("Memory already has a lesson with this text.");
    };
    let mut out = Map::new();
    out.insert("id".into(), json!(key));
    out.insert("lesson".into(), knowledge::lesson_dict(&lesson));
    out.insert("lesson_id".into(), json!(lesson.id));
    Ok(out)
}
