//! Append-only AI audit log. Each entry carries the hash of the one before it, so an edit or a removed row is
//! detectable (E of the deleted v1 board ai-safety-cost). Entries are redacted before they are written.

use std::collections::HashMap;

use chrono::{DateTime, Duration, Utc};
use kb_base::secrets::redact_obj;
use kb_base::{activity, pyjson, pytext, time};
use kb_db::Session;
use kb_db::database;
use kb_db::entities::{ai_audit, ai_project_settings, ai_run};
use kb_db::sea_orm::sea_query::{Expr, ExprTrait};
use kb_db::sea_orm::{
    ActiveModelTrait, ColumnTrait, DbErr, EntityTrait, ModelTrait, QueryFilter, QueryOrder, QuerySelect, Select,
};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

/// One lock for every writer: the next `seq` and the hash of the entry before it are read and written under it.
/// (Python keeps one lock per event loop, because a lock binds to the first loop that waits on it and a loop that
/// closed holding it would block the next one; one `tokio` mutex does the same job here.)
static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The hash of an entry over the hash before it (`audit._digest`): SHA-256 of `json.dumps([...], sort_keys=True)`.
pub fn digest(prev: &str, entry: &ai_audit::Model) -> String {
    // `json.dumps([...], sort_keys=True)`: a list of scalars
    let body = pyjson::dumps(&json!([
        prev,
        entry.id,
        entry.seq,
        entry.project_id,
        entry.member_id,
        entry.on_behalf_of,
        entry.run_id,
        entry.action,
        entry.target,
        entry.result,
        entry.detail,
        entry.created_at,
    ]));
    format!("{:x}", Sha256::digest(body.as_bytes()))
}

/// What `record` takes besides the project, the action and the result.
#[derive(Default, Clone)]
pub struct Entry {
    /// The AI member (team) it is about.
    pub member_id: Option<String>,
    /// The member's name as it was when the entry was written.
    pub member_name: String,
    /// The person the AI acted for.
    pub on_behalf_of: Option<String>,
    /// The run it belongs to.
    pub run_id: Option<String>,
    /// What the entry is about (a ticket id, a page).
    pub target: Option<String>,
    /// What the entry records, as a JSON object.
    pub detail: Map<String, Value>,
}

/// Append an entry in its own session, so it is kept even when the action itself fails.
pub async fn record(project_id: &str, action: &str, result: &str, entry: Entry) -> Result<ai_audit::Model, DbErr> {
    let mut detail = entry.detail;
    if let Some(via) = activity::current_origin().filter(|v| !v.is_empty()) {
        if !detail.contains_key("via") {
            detail.insert("via".into(), json!(via));
        }
    }
    let _guard = LOCK.lock().await;
    let session = database::session();
    let last = ai_audit::Entity::find().order_by_desc(ai_audit::Column::Seq).limit(1).one(&session).await?;
    let mut draft = ai_audit::Model {
        id: time::prefixed_id("aud_", 10),
        seq: last.as_ref().map_or(1, |l| l.seq + 1),
        project_id: project_id.to_string(),
        member_id: entry.member_id,
        member_name: entry.member_name,
        on_behalf_of: entry.on_behalf_of,
        run_id: entry.run_id,
        action: action.to_string(),
        target: entry.target,
        result: result.to_string(),
        detail: pyjson::dumps(&redact_obj(&Value::Object(detail))),
        created_at: time::now_iso(),
        reverted_at: None,
        reverted_by: None,
        prev_hash: last.as_ref().map_or(String::new(), |l| l.hash.clone()),
        hash: String::new(),
    };
    draft.hash = digest(&draft.prev_hash, &draft);
    let stored = ai_audit::ActiveModel::from(draft).reset_all().insert(&session).await?;
    session.commit().await?;
    Ok(stored)
}

/// Recompute the hash chain; report the first entry that does not match. After retention removed the oldest entries
/// the first remaining one anchors the chain.
pub async fn verify_chain(session: &Session) -> Result<Map<String, Value>, DbErr> {
    let rows = ai_audit::Entity::find().order_by_asc(ai_audit::Column::Seq).all(session).await?;
    let mut prev = rows.first().map_or(String::new(), |r| r.prev_hash.clone());
    let mut out = Map::new();
    for row in &rows {
        if row.prev_hash != prev || digest(&prev, row) != row.hash {
            out.insert("ok".into(), json!(false));
            out.insert("broken_at".into(), json!(row.id));
            out.insert("checked".into(), json!(rows.len()));
            return Ok(out);
        }
        prev = row.hash.clone();
    }
    out.insert("ok".into(), json!(true));
    out.insert("broken_at".into(), Value::Null);
    out.insert("checked".into(), json!(rows.len()));
    Ok(out)
}

/// An audit entry for the API.
pub fn to_dict(entry: &ai_audit::Model) -> Map<String, Value> {
    let detail = serde_json::from_str::<Value>(if entry.detail.is_empty() { "{}" } else { &entry.detail })
        .unwrap_or_else(|_| Value::Object(Map::new()));
    let mut out = Map::new();
    out.insert("id".into(), json!(entry.id));
    out.insert("seq".into(), json!(entry.seq));
    out.insert("project_id".into(), json!(entry.project_id));
    out.insert("member_id".into(), json!(entry.member_id));
    out.insert("member_name".into(), json!(entry.member_name));
    out.insert("on_behalf_of".into(), json!(entry.on_behalf_of));
    out.insert("run_id".into(), json!(entry.run_id));
    out.insert("action".into(), json!(entry.action));
    out.insert("target".into(), json!(entry.target));
    out.insert("result".into(), json!(entry.result));
    out.insert("detail".into(), detail);
    out.insert("created_at".into(), json!(entry.created_at));
    out.insert("reverted_at".into(), json!(entry.reverted_at));
    out.insert("reverted_by".into(), json!(entry.reverted_by));
    out
}

/// The filters of `list_entries` and `count_results`.
#[derive(Default, Clone)]
pub struct Filters {
    /// The AI member (team) it is about.
    pub member_id: Option<String>,
    /// How it ended (`allowed`, `blocked`, `denied`...).
    pub result: Option<String>,
    /// The run it belongs to.
    pub run_id: Option<String>,
    /// Text a target contains (upper-cased, no escaping of `%` and `_`).
    pub q: Option<String>,
    /// Only these actions.
    pub actions: Vec<String>,
    /// UTC ISO time
    pub since: Option<String>,
    /// UTC ISO time, exclusive
    pub until: Option<String>,
    /// The person the AI acted for.
    pub on_behalf_of: Option<String>,
}

fn filtered(mut stmt: Select<ai_audit::Entity>, f: &Filters) -> Select<ai_audit::Entity> {
    let some = |v: &Option<String>| v.clone().filter(|s| !s.is_empty());
    if let Some(v) = some(&f.member_id) {
        stmt = stmt.filter(ai_audit::Column::MemberId.eq(v));
    }
    if let Some(v) = some(&f.on_behalf_of) {
        stmt = stmt.filter(ai_audit::Column::OnBehalfOf.eq(v));
    }
    if let Some(v) = some(&f.result) {
        stmt = stmt.filter(ai_audit::Column::Result.eq(v));
    }
    if let Some(v) = some(&f.run_id) {
        stmt = stmt.filter(ai_audit::Column::RunId.eq(v));
    }
    if let Some(q) = some(&f.q) {
        // `contains` of SQLAlchemy: LIKE '%' || q || '%', with no escaping of % and _
        let pattern = format!("%{}%", pytext::strip(&q).to_uppercase());
        stmt = stmt.filter(Expr::col(ai_audit::Column::Target).like(pattern));
    }
    if !f.actions.is_empty() {
        stmt = stmt.filter(ai_audit::Column::Action.is_in(f.actions.clone()));
    }
    if let Some(v) = some(&f.since) {
        stmt = stmt.filter(ai_audit::Column::CreatedAt.gte(v));
    }
    if let Some(v) = some(&f.until) {
        stmt = stmt.filter(ai_audit::Column::CreatedAt.lt(v));
    }
    stmt
}

/// Newest first, with optional filters (`since` / `until` are UTC ISO times; `until` is exclusive).
pub async fn list_entries(
    session: &Session,
    project_id: &str,
    filters: &Filters,
    limit: i64,
    before_seq: Option<i64>,
) -> Result<Vec<ai_audit::Model>, DbErr> {
    let mut stmt = filtered(ai_audit::Entity::find().filter(ai_audit::Column::ProjectId.eq(project_id)), filters);
    if let Some(before) = before_seq.filter(|b| *b != 0) {
        stmt = stmt.filter(ai_audit::Column::Seq.lt(before));
    }
    stmt.order_by_desc(ai_audit::Column::Seq).limit(limit.clamp(1, 500) as u64).all(session).await
}

/// Entries per result under every filter but the result itself (the counters beside the filter chips).
pub async fn count_results(
    session: &Session,
    project_id: &str,
    filters: &Filters,
) -> Result<Map<String, Value>, DbErr> {
    let mut f = filters.clone();
    f.result = None;
    let stmt = filtered(ai_audit::Entity::find().filter(ai_audit::Column::ProjectId.eq(project_id)), &f);
    let rows: Vec<(String, i64)> = stmt
        .select_only()
        .column(ai_audit::Column::Result)
        .column_as(Expr::col(ai_audit::Column::Id).count(), "n")
        .group_by(ai_audit::Column::Result)
        .order_by_asc(ai_audit::Column::Result)
        .into_tuple()
        .all(session)
        .await?;
    Ok(rows.into_iter().map(|(r, n)| (r, json!(n))).collect())
}

/// How many secrets were masked in the entry before it was saved (the ••••• placeholders).
pub fn redaction_count(entry: &ai_audit::Model) -> usize {
    entry.detail.matches("••••").count()
}

/// `round(x, 4)` as Python rounds a float: the nearest value of the exact number, ties to even.
pub fn round4(x: f64) -> f64 {
    format!("{x:.4}").parse().unwrap_or(x)
}

/// Entries with the run number and cost columns (E1) and the chips the drawer needs.
pub async fn enrich(session: &Session, rows: &[ai_audit::Model]) -> Result<Vec<Map<String, Value>>, DbErr> {
    let mut ids: Vec<String> = Vec::new();
    for e in rows {
        if let Some(id) = e.run_id.as_ref().filter(|r| !r.is_empty()) {
            if !ids.contains(id) {
                ids.push(id.clone());
            }
        }
    }
    let runs: HashMap<String, ai_run::Model> = if ids.is_empty() {
        HashMap::new()
    } else {
        ai_run::Entity::find()
            .filter(ai_run::Column::Id.is_in(ids))
            .all(session)
            .await?
            .into_iter()
            .map(|r| (r.id.clone(), r))
            .collect()
    };
    let mut out = Vec::new();
    for e in rows {
        let mut d = to_dict(e);
        let run = runs.get(e.run_id.as_deref().unwrap_or(""));
        d.insert("run_number".into(), json!(run.map(|r| r.number)));
        d.insert("run_cost".into(), run.filter(|r| r.metered).map_or(Value::Null, |r| json!(round4(r.cost_usd.get()))));
        d.insert("redactions".into(), json!(redaction_count(e)));
        out.push(d);
    }
    Ok(out)
}

/// `_TRIGGER_TEXT`
pub fn trigger_text(trigger: &str) -> &'static str {
    match trigger {
        "assign" => "{by} assigned {ticket}",
        "run_button" => "{by} started a run on {ticket}",
        "message" => "{by} sent a message to the team on {ticket}",
        "docs_threads" => "{by} sent Docs comment threads to the team on {ticket}",
        "ai_message" => "{by} sent a note to the team on {ticket}",
        "ci_red" => "The board sent the red CI of {ticket} to its team",
        "review_comments" => "The board sent the review comments of {ticket} to its team",
        "ask" => "{by} asked a question on {ticket}",
        "retry" => "{by} retried the run on {ticket}",
        "request_changes" => "{by} requested changes on {ticket}",
        "answer" => "{by} answered the AI on {ticket}",
        "schedule" => "A schedule started a run on {ticket}",
        _ => "{by} started run #{n} on {ticket}",
    }
}

/// Why it did this: the prompt-source trace of an entry (E1). Each step has a trust label.
pub async fn trace(session: &Session, entry: &ai_audit::Model) -> Result<Vec<Value>, DbErr> {
    let detail = match loads_json(Some(&entry.detail), None) {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    let mut steps: Vec<Value> = Vec::new();
    let run = match entry.run_id.as_deref().filter(|r| !r.is_empty()) {
        Some(id) => ai_run::Entity::find_by_id(id).one(session).await?,
        None => None,
    };
    if let Some(run) = run {
        let ticket = run.ticket_id.clone().unwrap_or_else(|| "None".to_string());
        let text = trigger_text(&run.trigger)
            .replace("{by}", &run.started_by)
            .replace("{ticket}", &ticket)
            .replace("{n}", &run.number.to_string());
        steps.push(json!({"text": text, "trust": "trusted"}));
        steps.push(json!({"text": format!("Run #{} read the {} description", run.number, ticket), "trust": "trusted"}));
    }
    if let Some(Value::Object(source)) = detail.get("source") {
        if source.get("comment_id").is_some_and(pyjson::truthy) {
            let author =
                source.get("author").filter(|a| pyjson::truthy(a)).map_or("unknown author".to_string(), pyjson::py_str);
            steps.push(json!({"text": format!("It also read a flagged comment ({author})"), "trust": "untrusted"}));
        }
    }
    let tool = detail.get("tool").filter(|t| pyjson::truthy(t));
    let called = match tool {
        Some(tool) => {
            format!("Called {}.{}", pyjson::py_str(tool), detail.get("op").map_or("None".to_string(), pyjson::py_str))
        }
        None => entry.action.clone(),
    };
    let label = match entry.result.as_str() {
        "approved" | "needs_approval" => "Approval",
        "blocked" => "Blocked",
        "denied" => "Denied",
        _ => "Allowed",
    };
    steps.push(json!({"text": called, "trust": null, "chip": label}));
    Ok(steps)
}

/// `json.loads` that falls back to `default` (an empty dict unless given): text that is not JSON, empty text and
/// `null` all give the default.
pub fn loads_json(value: Option<&str>, default: Option<Value>) -> Value {
    let parsed = value.filter(|v| !v.is_empty()).and_then(|v| serde_json::from_str::<Value>(v).ok());
    match parsed {
        Some(v) if !Value::is_null(&v) => v,
        _ => default.unwrap_or_else(|| Value::Object(Map::new())),
    }
}

/// Blocked, denied and injection entries are kept at least this long.
pub const PROTECTED_DAYS: i64 = 365;
const PROTECTED_RESULTS: [&str; 2] = ["blocked", "denied"];

/// Retention: remove entries older than their project's retention from the start of the chain. Blocked, denied and
/// injection entries stay a year at least; removal stops at the first entry that has to stay, so the chain remains one
/// run of consecutive entries.
pub async fn prune() -> Result<u64, DbErr> {
    prune_at(Utc::now()).await
}

/// `prune` at a given moment.
pub async fn prune_at(now: DateTime<Utc>) -> Result<u64, DbErr> {
    let session = database::session();
    let settings: HashMap<String, ai_project_settings::Model> = ai_project_settings::Entity::find()
        .all(&session)
        .await?
        .into_iter()
        .map(|s| (s.project_id.clone(), s))
        .collect();
    if !settings.values().any(|s| s.audit_retention_days.is_some_and(|d| d != 0)) {
        return Ok(0);
    }
    let mut removed = 0;
    loop {
        let batch = ai_audit::Entity::find().order_by_asc(ai_audit::Column::Seq).limit(200).all(&session).await?;
        if batch.is_empty() {
            break;
        }
        let mut stop = false;
        for e in batch {
            let days = settings.get(&e.project_id).and_then(|s| s.audit_retention_days).filter(|d| *d != 0);
            let Some(days) = days else {
                stop = true;
                break;
            };
            let mut keep = i64::from(days);
            if PROTECTED_RESULTS.contains(&e.result.as_str()) || e.action == "injection_detected" {
                keep = std::cmp::max(keep, PROTECTED_DAYS);
            }
            if e.created_at >= time::iso(&(now - Duration::days(keep))) {
                stop = true;
                break;
            }
            e.delete(&session).await?;
            removed += 1;
        }
        session.commit().await?;
        if stop {
            break;
        }
    }
    Ok(removed)
}
