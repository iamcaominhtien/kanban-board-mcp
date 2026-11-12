//! Board health on the assistant engine (AI v2): "Run now" is one turn with the `board-health` skill; its findings
//! are kept as `ai_insight` rows (re-found ones are updated, not duplicated). Snooze, dismiss and restore are plain
//! code. Acting on an insight used to prepare a draft to apply; now the person asks the Board AI in the chat
//! (`services/assistant/health.py`, lines 1 to 272).

use std::collections::HashSet;

use chrono::{Duration, Utc};
use kb_ai::store::{loads, now_iso, parse_iso, py_int};
use kb_base::{events, pyjson, time};
use kb_db::Session;
use kb_db::database;
use kb_db::entities::{ai_digest, ai_insight};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, DbErr, EntityTrait, IntoActiveModel, QueryFilter, QueryOrder};
use serde_json::{Map, Value, json};
use sha1::{Digest, Sha1};

use super::engine::{self, TurnOpts};
use super::errors::{AssistError, Error};
use super::{sessions, settings as svc_settings};

/// The kinds of finding the board keeps; any other is kept as `at_risk`.
pub const KINDS: [&str; 6] = ["stuck", "wip", "chain", "unassigned", "at_risk", "priority"];

/// An insight as the API shows it.
pub fn insight_out(i: &ai_insight::Model) -> Value {
    json!({
        "id": i.id,
        "project_id": i.project_id,
        "kind": i.kind,
        "ticket_id": i.ticket_id,
        "title": i.title,
        "detail": i.detail,
        "data": loads(Some(&i.data), json!({})),
        "score": i.score,
        "state": i.state,
        "snoozed_until": i.snoozed_until,
        "seen": i.seen,
        "draft_id": null,
        "created_at": i.created_at,
        "updated_at": i.updated_at,
    })
}

/// `_when`: a stored time, or None when there is none or it cannot be read.
fn when(iso: Option<&str>) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    parse_iso(iso)
}

/// `_rows`: the project's insights; a snooze that is over wakes its insight (open, unseen) on the way.
async fn rows(session: &Session, project_id: &str) -> Result<Vec<ai_insight::Model>, DbErr> {
    let stored = ai_insight::Entity::find().filter(ai_insight::Column::ProjectId.eq(project_id)).all(session).await?;
    let now = Utc::now();
    let mut woke = false;
    let mut out = Vec::with_capacity(stored.len());
    for i in stored {
        // `(_when(i.snoozed_until) or now) <= now`: a time that cannot be read is over
        let over = when(i.snoozed_until.as_deref()).is_none_or(|until| until <= now);
        if i.state == "snoozed" && over {
            let mut row = i.into_active_model();
            row.state = Set("open".to_string());
            row.seen = Set(false);
            out.push(row.update(session).await?);
            woke = true;
        } else {
            out.push(i);
        }
    }
    if woke {
        session.commit().await?;
    }
    Ok(out)
}

/// `sorted(rows, key=lambda i: i.score, reverse=True)`: the strongest first, equal ones in the order they came.
fn strongest_first(mut rows: Vec<ai_insight::Model>) -> Vec<ai_insight::Model> {
    rows.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    rows
}

/// `items[:n]` for any integer `n` (a negative one counts from the end).
fn head<T>(mut items: Vec<T>, n: i128) -> Vec<T> {
    let len = items.len() as i128;
    let keep = if n < 0 { (len + n).max(0) } else { n.min(len) };
    items.truncate(keep as usize);
    items
}

/// The Board health panel: the latest digest, insights by state, the schedule, the unseen count.
pub async fn panel(session: &Session, project_id: &str) -> Result<Map<String, Value>, DbErr> {
    let row = svc_settings::get(session).await?;
    let cfg = svc_settings::health_config(&row);
    let member = svc_settings::first_team(session, project_id).await?.map(|(member, _profile)| member);
    let team_name = member.map_or_else(|| "Board AI".to_string(), |m| m.name);
    let rows = rows(session, project_id).await?;
    let max = cfg.get("max_insights").filter(|v| pyjson::truthy(v)).and_then(py_int).unwrap_or(8);
    let needs = head(strongest_first(rows.iter().filter(|i| i.state == "open").cloned().collect()), max);
    let dg = ai_digest::Entity::find()
        .filter(ai_digest::Column::ProjectId.eq(project_id))
        .order_by_desc(ai_digest::Column::CreatedAt)
        .one(session)
        .await?;
    let digest = match dg {
        Some(dg) => {
            let mut digest = Map::new();
            digest.insert("id".into(), json!(dg.id));
            digest.insert("day".into(), json!(dg.day));
            digest.insert("created_at".into(), json!(dg.created_at));
            digest.insert("cost".into(), json!(dg.cost));
            digest.insert("tokens".into(), json!(dg.tokens));
            if let Value::Object(summary) = loads(Some(&dg.summary), json!({})) {
                digest.extend(summary);
            }
            Value::Object(digest)
        }
        None => Value::Null,
    };
    let of_state = |state: &str| -> Vec<Value> { rows.iter().filter(|i| i.state == state).map(insight_out).collect() };
    let mut out = Map::new();
    out.insert("digest".into(), digest);
    out.insert("needs_action".into(), Value::Array(needs.iter().map(insight_out).collect()));
    out.insert("snoozed".into(), Value::Array(of_state("snoozed")));
    out.insert("dismissed".into(), Value::Array(of_state("dismissed")));
    out.insert("unseen".into(), json!(needs.iter().filter(|i| !i.seen).count()));
    out.insert("drafts".into(), json!([]));
    out.insert("schedule".into(), Value::Object(cfg));
    out.insert("board_ai".into(), json!(team_name));
    out.insert("enabled".into(), svc_settings::features(&row).get("health").cloned().unwrap_or(json!(true)));
    Ok(out)
}

/// `text.capitalize()`.
fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars.flat_map(char::to_lowercase)).collect(),
        None => String::new(),
    }
}

/// Insight chips for board cards: the strongest open insight of each ticket.
pub async fn chips(session: &Session, project_id: &str) -> Result<Vec<Value>, DbErr> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<Value> = Vec::new();
    for i in strongest_first(rows(session, project_id).await?) {
        let Some(ticket_id) = i.ticket_id.clone().filter(|t| !t.is_empty()) else { continue };
        if i.state != "open" || seen.contains(&ticket_id) {
            continue;
        }
        let chip = loads(Some(&i.data), json!({})).get("chip").filter(|c| pyjson::truthy(c)).cloned();
        out.push(json!({
            "ticket_id": ticket_id,
            "label": chip.unwrap_or_else(|| json!(capitalize(&i.kind.replace('_', " ")))),
            "why": i.title,
            "insight_id": i.id,
            "kind": i.kind,
        }));
        seen.insert(ticket_id);
    }
    Ok(out)
}

/// `str(value)`.
fn py_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => pyjson::py_str(other),
    }
}

/// `str(value or "")[:limit]`.
fn text_cut(value: Option<&Value>, limit: usize) -> String {
    value.filter(|v| pyjson::truthy(v)).map(py_text).unwrap_or_default().chars().take(limit).collect()
}

/// `float(value or 0)`: a number, or a text that reads as one.
fn py_float(value: Option<&Value>) -> Result<f64, Error> {
    match value.filter(|v| pyjson::truthy(v)) {
        None => Ok(0.0),
        Some(Value::Number(n)) => Ok(n.as_f64().unwrap_or(0.0)),
        Some(Value::Bool(b)) => Ok(f64::from(u8::from(*b))),
        Some(Value::String(text)) => kb_base::pytext::strip(text).parse::<f64>().map_err(|_| {
            Error::Other(format!("ValueError: could not convert string to float: {}", kb_base::pytext::repr(text)))
        }),
        Some(other) => Err(Error::Other(format!(
            "TypeError: float() argument must be a string or a real number, not {}",
            pyjson::py_repr(other)
        ))),
    }
}

/// Run the check now: the assistant reads the board and says what needs attention.
pub async fn check(project_id: &str, by: &str) -> Result<Map<String, Value>, Error> {
    {
        let session = database::session();
        if !svc_settings::feature_on(&session, "health").await? {
            return Err(AssistError::new("feature_off", "Board health is off in Settings › AI.").into());
        }
    }
    let name = format!("{}:health", sessions::board_name(project_id));
    let mut inputs = Map::new();
    inputs.insert("project_id".into(), json!(project_id));
    let mut opts = TurnOpts::new(&name, "board-health", inputs, by);
    opts.feature = "health";
    let out = engine::turn(project_id, opts).await?;
    if out.state != "finished" {
        let why = out.error.filter(|e| !e.is_empty()).unwrap_or_else(|| "The check could not finish.".to_string());
        return Err(AssistError::new("unavailable", why).into());
    }
    let data = out.data();
    let mut found: Vec<String> = Vec::new();
    let session = database::session();
    // `{i.key: i for i in rows}`: by key, a later row in place of an earlier one
    let mut existing: Vec<(String, ai_insight::Model)> = Vec::new();
    for i in ai_insight::Entity::find().filter(ai_insight::Column::ProjectId.eq(project_id)).all(&session).await? {
        match existing.iter_mut().find(|(key, _)| *key == i.key) {
            Some(slot) => slot.1 = i,
            None => existing.push((i.key.clone(), i)),
        }
    }
    let items = data.get("insights").and_then(Value::as_array).cloned().unwrap_or_default();
    for item in &items {
        let Some(title) = item.get("title").filter(|t| pyjson::truthy(t)) else { continue };
        if !item.is_object() {
            continue;
        }
        let kind = item.get("kind").and_then(Value::as_str).filter(|k| KINDS.contains(k)).unwrap_or("at_risk");
        let ticket_id = item.get("ticket_id").filter(|t| pyjson::truthy(t)).map(py_text);
        let digest =
            Sha1::digest(format!("{kind}\0{}\0{}", ticket_id.as_deref().unwrap_or(""), py_text(title)).as_bytes());
        let key: String = digest.iter().map(|b| format!("{b:02x}")).collect::<String>()[..16].to_string();
        if !found.contains(&key) {
            found.push(key.clone());
        }
        let known = existing.iter_mut().find(|(k, _)| *k == key);
        let mut row = match &known {
            None => {
                let mut row = ai_insight::new();
                row.project_id = Set(project_id.to_string());
                row.kind = Set(kind.to_string());
                row.key = Set(key.clone());
                row.ticket_id = Set(ticket_id);
                row.title = Set(py_text(title).chars().take(200).collect());
                row
            }
            Some((_, stored)) => {
                let mut row = stored.clone().into_active_model();
                if stored.state == "resolved" {
                    row.state = Set("open".to_string());
                    row.seen = Set(false);
                }
                row
            }
        };
        row.detail = Set(text_cut(item.get("detail"), 1000));
        row.data = Set(pyjson::dumps(item.get("data").filter(|d| d.is_object()).unwrap_or(&json!({}))));
        row.score = Set(py_float(item.get("score"))?);
        row.updated_at = Set(now_iso());
        match known {
            None => {
                row.insert(&session).await?;
            }
            Some(slot) => slot.1 = row.update(&session).await?,
        }
    }
    for (key, stored) in &existing {
        if !found.contains(key) && stored.state == "open" {
            let mut row = stored.clone().into_active_model();
            row.state = Set("resolved".to_string());
            row.updated_at = Set(now_iso());
            row.update(&session).await?;
        }
    }
    if let Some(summary) = data.get("summary").filter(|s| pyjson::truthy(s)) {
        let mut row = ai_digest::new();
        row.project_id = Set(project_id.to_string());
        row.day = Set(now_iso().chars().take(10).collect());
        row.summary = Set(pyjson::dumps(&json!({
            "text": py_text(summary),
            "done": [],
            "in_progress": [],
            "blocked": [],
            "tickets": found.len(),
        })));
        row.cost = Set(out.cost);
        row.tokens = Set(i32::try_from(out.tokens_in + out.tokens_out).unwrap_or(i32::MAX));
        row.insert(&session).await?;
    }
    session.commit().await?;
    let result = panel(&session, project_id).await?;
    drop(session);
    events::publish(events::INVALIDATE, &[]).await;
    Ok(result)
}

/// Snooze, dismiss or restore an insight (`hours`: how long a snooze lasts; Python's default is 24).
pub async fn set_state(session: &Session, insight_id: &str, action: &str, hours: i64) -> Result<Value, Error> {
    let Some(i) = ai_insight::Entity::find_by_id(insight_id).one(session).await? else {
        return Err(AssistError::new("not_found", "Insight not found.").into());
    };
    let mut row = i.into_active_model();
    match action {
        "snooze" => {
            row.state = Set("snoozed".to_string());
            row.snoozed_until = Set(Some(time::iso(&(Utc::now() + Duration::hours(hours.max(1))))));
        }
        "dismiss" => row.state = Set("dismissed".to_string()),
        "restore" => {
            row.state = Set("open".to_string());
            row.snoozed_until = Set(None);
        }
        "act" => {
            return Err(
                AssistError::new("gone", "Drafts are gone in AI v2: ask the Board AI in the chat to do this.").into()
            );
        }
        _ => return Err(AssistError::new("invalid", "Unknown action.").into()),
    }
    row.updated_at = Set(now_iso());
    let i = row.update(session).await?;
    session.commit().await?;
    events::publish(events::INVALIDATE, &[]).await;
    Ok(insight_out(&i))
}

/// Snooze every open insight. Returns how many.
pub async fn snooze_all(session: &Session, project_id: &str, hours: i64) -> Result<usize, DbErr> {
    let rows = ai_insight::Entity::find()
        .filter(ai_insight::Column::ProjectId.eq(project_id))
        .filter(ai_insight::Column::State.eq("open"))
        .all(session)
        .await?;
    let until = time::iso(&(Utc::now() + Duration::hours(hours)));
    let count = rows.len();
    for i in rows {
        let mut row = i.into_active_model();
        row.state = Set("snoozed".to_string());
        row.snoozed_until = Set(Some(until.clone()));
        row.update(session).await?;
    }
    session.commit().await?;
    events::publish(events::INVALIDATE, &[]).await;
    Ok(count)
}

/// The panel was opened: nothing is unseen any more.
pub async fn mark_seen(session: &Session, project_id: &str) -> Result<(), DbErr> {
    let rows = ai_insight::Entity::find()
        .filter(ai_insight::Column::ProjectId.eq(project_id))
        .filter(ai_insight::Column::Seen.eq(false))
        .all(session)
        .await?;
    for i in rows {
        let mut row = i.into_active_model();
        row.seen = Set(true);
        row.update(session).await?;
    }
    session.commit().await
}
